import type { FailureKind } from './types';

/**
 * Why an agent turn failed, from the CLI's error text: the model service (rate limit, quota, outage, network, sign-in)
 * or the agent's own work (logic). Each kind recovers differently, so retrying a quota error does not burn time and a
 * logic error is not retried as if the network had dropped.
 */
export function classifyFailure(text: string | undefined): FailureKind {
  const t = (text ?? '').toLowerCase();
  if (!t.trim()) return 'unknown';
  if (/quota|insufficient[_ ]?(balance|credit|funds)|billing|credit balance|exceeded your (current )?plan|usage limit|out of credits|payment required|\b402\b/.test(t)) return 'quota';
  if (/rate[ _-]?limit|too many requests|\b429\b|throttl|slow down|requests per (minute|min|hour)|tpm|rpm limit|try again in \d/.test(t)) return 'rate_limit';
  if (/unauthori[sz]ed|\b401\b|\b403\b|forbidden|not logged in|log ?in required|please (log|sign) ?in|invalid api key|api key.*(invalid|missing)|authentication|expired token|token expired/.test(t)) return 'auth';
  if (/econnreset|econnrefused|enotfound|etimedout|eai_again|socket hang up|network|fetch failed|connection (reset|refused|closed|error)|getaddrinfo|tls|certificate|proxy|disconnected|offline/.test(t)) return 'network';
  if (/overloaded|\b5\d\d\b|internal server error|service unavailable|bad gateway|gateway timeout|server error|model.*(not available|unavailable|busy)|capacity|upstream|temporarily/.test(t)) return 'model_service';
  return 'logic';
}

export interface Recovery {
  /** Try the same provider again. */
  retry: boolean;
  /** Wait this long first (ms). */
  delayMs: number;
  /** Hand the role to another provider when retrying is pointless or used up. */
  failover: boolean;
  /** Shown to the user. */
  action: string;
}

/** What to do about failure number `attempt` (1-based) of this kind. */
export function recoveryFor(kind: FailureKind, attempt: number, L: (zh: string, en: string) => string): Recovery {
  switch (kind) {
    case 'rate_limit': {
      // 30 s, 60 s, 120 s, then hand it over.
      const delayMs = Math.min(120000, 30000 * 2 ** (attempt - 1));
      return attempt <= 3 ? { retry: true, delayMs, failover: false, action: L(`請求太頻繁：等 ${delayMs / 1000} 秒後重試（第 ${attempt}/3 次）`, `Rate limited: retrying in ${delayMs / 1000}s (attempt ${attempt}/3)`) } : { retry: false, delayMs: 0, failover: true, action: L('仍然受限：改用其他供應商', 'Still rate limited: switching provider') };
    }
    case 'quota':
      return { retry: false, delayMs: 0, failover: true, action: L('額度用完：不重試，改用其他供應商', 'Out of quota: not retrying, switching provider') };
    case 'network': {
      const delayMs = [5000, 15000, 45000][attempt - 1] ?? 0;
      return attempt <= 3 ? { retry: true, delayMs, failover: false, action: L(`網路中斷：${delayMs / 1000} 秒後重試（第 ${attempt}/3 次）`, `Network error: retrying in ${delayMs / 1000}s (attempt ${attempt}/3)`) } : { retry: false, delayMs: 0, failover: true, action: L('網路仍不通：改用其他供應商', 'Network still failing: switching provider') };
    }
    case 'model_service': {
      const delayMs = [20000, 60000][attempt - 1] ?? 0;
      return attempt <= 2 ? { retry: true, delayMs, failover: false, action: L(`模型服務暫時故障：${delayMs / 1000} 秒後重試（第 ${attempt}/2 次）`, `Model service error: retrying in ${delayMs / 1000}s (attempt ${attempt}/2)`) } : { retry: false, delayMs: 0, failover: true, action: L('模型服務持續故障：改用其他供應商', 'Model service still failing: switching provider') };
    }
    case 'auth':
      return { retry: false, delayMs: 0, failover: true, action: L('登入失效：請到「供應商」重新登入', 'Signed out: sign in again under Providers') };
    case 'logic':
    case 'unknown':
      return { retry: false, delayMs: 0, failover: false, action: L('不是服務問題：由你決定重試或換人', 'Not a service problem: you decide to retry or switch') };
  }
}
