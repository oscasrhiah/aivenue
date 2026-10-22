import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { L } from './i18n';
import type { ProviderUsage } from './types';

type Official = NonNullable<ProviderUsage['official']>;
type Limit = { utilization?: number | null; resets_at?: string | null } | null | undefined;

/**
 * Claude Code's plan limits (5-hour session, weekly…), the numbers its /usage shows, read with the sign-in Claude Code
 * keeps in <config dir>/.credentials.json. Aivenue only reads that file and never refreshes the token itself: a
 * refresh rotates the refresh token and would sign Claude Code out. An expired token renews on Claude Code's next run.
 */
export async function readClaudeQuota(configDir?: string): Promise<Official | undefined> {
  const dir = configDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  let oauth: { accessToken?: string; expiresAt?: number; subscriptionType?: string; rateLimitTier?: string } | undefined;
  try {
    oauth = JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8')).claudeAiOauth;
  } catch {
    // macOS keeps the sign-in in the Keychain; API-key users have no plan limits.
    throw new Error(process.platform === 'darwin' ? L('macOS 的 Claude Code 登入存在鑰匙圈，Aivenue 讀不到額度', "On macOS Claude Code keeps its sign-in in the Keychain, so Aivenue can't read the quota") : L('找不到 Claude Code 的訂閱登入（用 API key 登入時沒有方案額度）', 'No Claude Code subscription sign-in found (API-key sign-ins have no plan quota)'));
  }
  if (!oauth?.accessToken) throw new Error(L('Claude Code 不是用訂閱帳號登入，沒有方案額度', 'Claude Code is not signed in with a subscription, so there is no plan quota'));
  if (oauth.expiresAt && Date.now() > oauth.expiresAt) throw new Error(L('Claude Code 的登入憑證暫時過期，下次執行 Claude Code 後會自動更新', "Claude Code's sign-in token has lapsed; it renews the next time Claude Code runs"));
  const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
    headers: { authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20', 'content-type': 'application/json', 'user-agent': 'Aivenue' },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 401 || res.status === 403) throw new Error(L('Claude 拒絕查詢額度（登入可能已失效），請在「供應商」重新登入 Claude Code', 'Claude refused the quota request (the sign-in may have expired); sign in to Claude Code again under Providers'));
  if (!res.ok) throw new Error(`Claude API HTTP ${res.status}`);
  const data = (await res.json()) as Record<string, Limit>;
  const known: [string, number, string?, string?][] = [
    ['five_hour', 300],
    ['seven_day', 10080],
    ['seven_day_opus', 10080, '每週額度（Opus）', 'Weekly limit (Opus)'],
    ['seven_day_sonnet', 10080, '每週額度（Sonnet）', 'Weekly limit (Sonnet)'],
  ];
  const windows: Official['windows'] = [];
  for (const [key, minutes, zh, en] of known) {
    const w = data[key];
    if (!w || typeof w.utilization !== 'number') continue;
    const reset = w.resets_at ? Date.parse(w.resets_at) : NaN;
    windows.push({ minutes, usedPercent: Math.max(0, Math.min(100, w.utilization)), resetsAt: Number.isFinite(reset) ? reset : undefined, label: zh && en ? L(zh, en) : undefined });
  }
  if (!windows.length) throw new Error(L('Claude 沒有回傳額度資訊（可能是 API 改版）', 'Claude returned no quota information (the API may have changed)'));
  const tier = /(\d+x)/i.exec(oauth.rateLimitTier ?? '')?.[1];
  const sub = oauth.subscriptionType ? oauth.subscriptionType[0].toUpperCase() + oauth.subscriptionType.slice(1) : undefined;
  return {
    plan: sub ? `${sub}${tier ? ` ${tier}` : ''}` : undefined,
    windows,
    updatedAt: Date.now(),
    source: 'claude-live',
    limitReached: windows.some((w) => w.usedPercent >= 100),
  };
}
