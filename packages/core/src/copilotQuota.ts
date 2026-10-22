import { L } from './i18n';
import type { ProviderUsage } from './types';

type Official = NonNullable<ProviderUsage['official']>;
type Snapshot = { entitlement?: number; remaining?: number; percent_remaining?: number; unlimited?: boolean; overage_permitted?: boolean };

/**
 * GitHub Copilot's monthly quota (premium requests, plus chat / completions on the free plan), read with the
 * GitHub sign-in Aivenue already uses (gh) from the same endpoint the Copilot editor extensions call.
 */
export async function readCopilotQuota(token: string | undefined): Promise<Official | undefined> {
  if (!token) throw new Error(L('需要先在「設定 → GitHub」登入 GitHub 才能查詢 Copilot 額度', 'Sign in to GitHub under Settings → GitHub to read the Copilot quota'));
  const get = (path: string) =>
    fetch(`https://api.github.com${path}`, {
      headers: { authorization: `token ${token}`, accept: 'application/json', 'user-agent': 'Aivenue', 'x-github-api-version': '2025-04-01' },
      signal: AbortSignal.timeout(20000),
    });
  const res = await get('/copilot_internal/user');
  if (res.status === 401) throw new Error(L('GitHub 登入已失效，請重新登入', 'The GitHub sign-in expired; sign in again'));
  if (res.status === 404 || res.status === 403) throw new Error(L('這個 GitHub 帳號沒有 Copilot 訂閱', 'This GitHub account has no Copilot subscription'));
  if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
  const user = (await res.json()) as { login?: string; copilot_plan?: string; quota_reset_date_utc?: string; quota_reset_date?: string; quota_snapshots?: Record<string, Snapshot> };
  const reset = Date.parse(user.quota_reset_date_utc ?? user.quota_reset_date ?? '');
  const names: Record<string, [string, string]> = {
    premium_interactions: ['進階請求（每月）', 'Premium requests (monthly)'],
    chat: ['Chat（每月）', 'Chat (monthly)'],
    completions: ['程式碼補全（每月）', 'Code completions (monthly)'],
  };
  const windows: Official['windows'] = [];
  for (const [id, s] of Object.entries(user.quota_snapshots ?? {})) {
    if (s.unlimited || !s.entitlement) continue;
    const left = typeof s.percent_remaining === 'number' ? s.percent_remaining : ((s.remaining ?? 0) / s.entitlement) * 100;
    const [zh, en] = names[id] ?? [id, id];
    const count = typeof s.remaining === 'number' ? L(`剩 ${Math.max(0, Math.round(s.remaining))} / ${s.entitlement} 次`, `${Math.max(0, Math.round(s.remaining))} of ${s.entitlement} left`) : undefined;
    windows.push({ minutes: 43200, usedPercent: Math.max(0, Math.min(100, Math.round((100 - left) * 10) / 10)), resetsAt: Number.isFinite(reset) ? reset : undefined, label: L(zh, en), detail: count });
  }
  if (!windows.length) throw new Error(L('GitHub 沒有回傳 Copilot 額度（方案可能是無限制）', 'GitHub returned no Copilot quota (the plan may be unlimited)'));
  return {
    plan: user.copilot_plan ? `Copilot ${user.copilot_plan}` : 'Copilot',
    windows,
    updatedAt: Date.now(),
    source: 'copilot-live',
    limitReached: windows.some((w) => w.usedPercent >= 100),
    account: user.login,
  };
}
