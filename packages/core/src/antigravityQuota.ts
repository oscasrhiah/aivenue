import { randomBytes } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { L } from './i18n';
import type { SecretStore } from './secrets';
import type { ProviderUsage } from './types';

/**
 * Antigravity's plan quota (per-model remaining share and reset time), read from Google's Cloud Code API the way
 * the Antigravity apps do. The Antigravity CLI keeps its own sign-in in the OS keyring, which Aivenue does not
 * touch, so the user connects once through Google's official sign-in page (installed-app OAuth with a loopback
 * redirect). The client id/secret are Antigravity's public installed-app identifiers, which Google does not treat
 * as secret for this client type.
 */
const OAUTH = {
  clientId: '1071006060591-tmhssin2h21lcre235vtolojh4g403ep.apps.googleusercontent.com',
  clientSecret: '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',
  authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
  tokenUrl: 'https://oauth2.googleapis.com/token',
  scopes: ['https://www.googleapis.com/auth/cloud-platform', 'https://www.googleapis.com/auth/userinfo.email'],
};
const API = 'https://cloudcode-pa.googleapis.com';
const METADATA = { ideType: 'ANTIGRAVITY', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI' };
const KEY_REFRESH = 'quota:antigravity:refresh';
const KEY_EMAIL = 'quota:antigravity:email';

type Official = NonNullable<ProviderUsage['official']>;

export class AntigravityQuota {
  private access?: { token: string; expiresAt: number };
  private pending?: { server: http.Server; authUrl: string };
  /** Why the last reading failed (sign-in revoked, API changed…), for the usage page. */
  lastError?: string;

  constructor(
    private secrets: SecretStore,
    private onConnected: () => void,
  ) {}

  async status(): Promise<{ connected: boolean; email?: string; waiting: boolean; error?: string }> {
    return { connected: !!(await this.secrets.get(KEY_REFRESH)), email: await this.secrets.get(KEY_EMAIL), waiting: !!this.pending, error: this.lastError };
  }

  /**
   * Start the Google sign-in: a one-off local callback server plus the consent URL to open. Resolves right away
   * with the URL; the sign-in finishes in the background (10 minutes at most).
   */
  async connect(open?: (url: string) => unknown): Promise<{ authUrl: string; opened: boolean }> {
    if (this.pending) return { authUrl: this.pending.authUrl, opened: false };
    const state = randomBytes(16).toString('hex');
    const server = http.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (server.address() as AddressInfo).port;
    const redirectUri = `http://127.0.0.1:${port}/callback`;
    const authUrl = `${OAUTH.authUrl}?${new URLSearchParams({ client_id: OAUTH.clientId, redirect_uri: redirectUri, response_type: 'code', scope: OAUTH.scopes.join(' '), access_type: 'offline', prompt: 'consent', state })}`;
    const close = () => {
      clearTimeout(timer);
      server.close();
      if (this.pending?.server === server) this.pending = undefined;
    };
    const timer = setTimeout(close, 10 * 60 * 1000);
    timer.unref?.();
    const page = (title: string, text: string) => `<!doctype html><meta charset="utf-8"><title>Aivenue</title><body style="font-family:system-ui,sans-serif;padding:48px;text-align:center"><h2>${title}</h2><p>${text}</p></body>`;
    server.on('request', async (req, res) => {
      const url = new URL(req.url ?? '/', redirectUri);
      if (url.pathname !== '/callback') return void (res.writeHead(404), res.end());
      const reply = (status: number, html: string) => (res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' }), res.end(html));
      if (url.searchParams.get('state') !== state) return reply(400, page(L('無效的回呼', 'Invalid callback'), L('請回到 Aivenue 重新連接。', 'Go back to Aivenue and connect again.')));
      const code = url.searchParams.get('code');
      if (!code) {
        close();
        return reply(400, page(L('沒有完成授權', 'Not authorized'), L('可以關閉這個分頁，回到 Aivenue 再試一次。', 'You can close this tab and try again in Aivenue.')));
      }
      try {
        const tok = await this.token({ code, redirect_uri: redirectUri, grant_type: 'authorization_code' });
        if (!tok.refresh_token) throw new Error(L('Google 沒有給 refresh token：請到 myaccount.google.com/permissions 移除舊的授權後再連接一次', 'Google returned no refresh token: remove the old grant at myaccount.google.com/permissions and connect again'));
        await this.secrets.set(KEY_REFRESH, tok.refresh_token);
        this.access = { token: tok.access_token, expiresAt: Date.now() + tok.expires_in * 1000 - 60000 };
        const email = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', { headers: { authorization: `Bearer ${tok.access_token}` } })
          .then((r) => (r.ok ? (r.json() as Promise<{ email?: string }>) : {}))
          .then((u) => (u as { email?: string }).email)
          .catch(() => undefined);
        if (email) await this.secrets.set(KEY_EMAIL, email);
        this.lastError = undefined;
        reply(200, page(L('已連接 Antigravity 額度', 'Antigravity quota connected'), L('可以關閉這個分頁，回到 Aivenue 的「用量」頁。', 'You can close this tab and go back to Usage in Aivenue.')));
        this.onConnected();
      } catch (e) {
        this.lastError = (e as Error).message;
        reply(500, page(L('連接失敗', 'Could not connect'), this.lastError));
      } finally {
        close();
      }
    });
    this.pending = { server, authUrl };
    let opened = false;
    try {
      if (open) {
        await open(authUrl);
        opened = true;
      }
    } catch {
      // the page opens it instead
    }
    return { authUrl, opened };
  }

  async disconnect(): Promise<void> {
    const refresh = await this.secrets.get(KEY_REFRESH);
    await this.secrets.delete(KEY_REFRESH);
    await this.secrets.delete(KEY_EMAIL);
    this.access = undefined;
    this.lastError = undefined;
    // Also revoke it at Google, so the grant disappears from the account's permissions.
    if (refresh) await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(refresh)}`, { method: 'POST' }).catch(() => undefined);
  }

  /** The quota windows, or undefined when not connected. Throws (and remembers why) when the reading fails. */
  async read(): Promise<Official | undefined> {
    const refresh = await this.secrets.get(KEY_REFRESH);
    if (!refresh) return undefined;
    try {
      if (!this.access || Date.now() > this.access.expiresAt) {
        const tok = await this.token({ refresh_token: refresh, grant_type: 'refresh_token' });
        this.access = { token: tok.access_token, expiresAt: Date.now() + tok.expires_in * 1000 - 60000 };
      }
      const assist = await this.call<{ planInfo?: { monthlyPromptCredits?: number; planType?: string }; availablePromptCredits?: number; cloudaicompanionProject?: string | { id?: string }; currentTier?: { name?: string } }>('/v1internal:loadCodeAssist', { metadata: METADATA });
      const project = typeof assist.cloudaicompanionProject === 'string' ? assist.cloudaicompanionProject : assist.cloudaicompanionProject?.id;
      type Models = { models?: Record<string, { displayName?: string; quotaInfo?: { remainingFraction?: number; resetTime?: string } }> };
      // Some accounts may not list models; the monthly credits still show then.
      const models = await this.call<Models>('/v1internal:fetchAvailableModels', project ? { project } : {}).catch((): Models => ({ models: {} }));
      const windows: Official['windows'] = [];
      const monthly = assist.planInfo?.monthlyPromptCredits;
      const available = assist.availablePromptCredits;
      if (typeof monthly === 'number' && monthly > 0 && typeof available === 'number') {
        windows.push({ minutes: 43200, usedPercent: round((1 - available / monthly) * 100), label: L(`每月額度（${available} / ${monthly} credits）`, `Monthly credits (${available} / ${monthly})`) });
      }
      // The quota buckets are the source of truth: Google leaves remainingFraction out when it is 0 (an exhausted
      // model), so a model listed with only a reset time is spent, not unknown.
      type Buckets = { buckets?: { modelId?: string; remainingFraction?: number; resetTime?: string }[] };
      const quota = await this.call<Buckets>('/v1internal:retrieveUserQuota', project ? { project } : {}).catch((): Buckets => ({}));
      const entries = quota.buckets?.length
        ? quota.buckets.map((b) => ({ id: b.modelId ?? '', frac: b.remainingFraction ?? 0, resetTime: b.resetTime }))
        : Object.entries(models.models ?? {})
            .filter(([, m]) => m.quotaInfo && (typeof m.quotaInfo.remainingFraction === 'number' || m.quotaInfo.resetTime))
            .map(([id, m]) => ({ id, frac: m.quotaInfo!.remainingFraction ?? 0, resetTime: m.quotaInfo!.resetTime }));
      // Models without a display name are Antigravity's internal ones (autocomplete, tab jump…), not pickable models.
      // Models that share a pool report the same share and reset time, so they show as one meter per family; Gemini
      // Pro and Gemini Flash are separate quotas in Antigravity and always get their own meter, even when equal.
      const family = (id: string, name: string) => (/gemini/i.test(id) ? (/pro/i.test(id) ? 'Gemini Pro' : 'Gemini Flash') : /claude/i.test(id) ? 'Claude' : /gpt/i.test(id) ? 'GPT-OSS' : name);
      const groups = new Map<string, { frac: number; reset?: number; families: string[]; names: string[] }>();
      for (const e of entries) {
        const name = models.models?.[e.id]?.displayName;
        if (!name) continue;
        const fam = family(e.id, name);
        const reset = e.resetTime ? Date.parse(e.resetTime) : NaN;
        const key = `${fam.startsWith('Gemini') ? fam : ''}|${e.frac}|${e.resetTime ?? ''}`;
        const g = groups.get(key) ?? { frac: e.frac, reset: Number.isFinite(reset) ? reset : undefined, families: [], names: [] };
        if (!g.families.includes(fam)) g.families.push(fam);
        if (!g.names.includes(name)) g.names.push(name);
        groups.set(key, g);
      }
      const order = (g: { families: string[] }) => (g.families[0] === 'Gemini Pro' ? 1 : g.families[0] === 'Gemini Flash' ? 2 : 0);
      for (const g of [...groups.values()].sort((a, b) => order(a) - order(b) || b.frac - a.frac)) {
        windows.push({
          minutes: 0,
          usedPercent: round((1 - g.frac) * 100),
          resetsAt: g.reset,
          label: g.names.length > 1 ? `${g.families.join(' / ')}${L(` 共用額度（${g.names.length} 個模型）`, ` shared quota (${g.names.length} models)`)}` : g.names[0],
          detail: g.names.length > 1 ? g.names.join('、') : undefined,
        });
      }
      if (!windows.length) throw new Error(L('Google 沒有回傳額度資訊（可能是帳號沒有方案，或 API 改版）', 'Google returned no quota information (no plan on the account, or the API changed)'));
      this.lastError = undefined;
      return {
        plan: assist.currentTier?.name ?? assist.planInfo?.planType,
        windows,
        updatedAt: Date.now(),
        source: 'antigravity-live',
        // Spent only when every pool is: an exhausted Gemini pool still leaves Claude / GPT usable.
        limitReached: windows.every((w) => w.usedPercent >= 100),
        account: await this.secrets.get(KEY_EMAIL),
      };
    } catch (e) {
      this.lastError = (e as Error).message;
      throw e;
    }
  }

  private async token(params: Record<string, string>): Promise<{ access_token: string; refresh_token?: string; expires_in: number }> {
    const res = await fetch(OAUTH.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...params, client_id: OAUTH.clientId, client_secret: OAUTH.clientSecret }).toString(),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) {
      const revoked = res.status === 400 || res.status === 401;
      throw new Error(revoked && params.grant_type === 'refresh_token' ? L('Google 授權已失效，請重新連接', 'The Google sign-in expired; connect again') : `Google token HTTP ${res.status}`);
    }
    return (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  }

  private async call<T>(endpoint: string, body: unknown): Promise<T> {
    const res = await fetch(API + endpoint, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.access!.token}`, 'content-type': 'application/json', 'user-agent': 'antigravity' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 401 || res.status === 403) {
      this.access = undefined;
      throw new Error(L('Google 拒絕查詢額度（授權失效或帳號沒有 Antigravity），請重新連接', 'Google refused the quota request (sign-in expired or no Antigravity on this account); connect again'));
    }
    if (!res.ok) throw new Error(`Antigravity API HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 160)}`);
    return (await res.json()) as T;
  }
}

const round = (n: number) => Math.max(0, Math.min(100, Math.round(n * 10) / 10));
