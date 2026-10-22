import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProviderSpec, ProviderUsage, TokenUsage, UsageTotals } from './types';
import { childEnv, resolveCommand, spawnResolved, specCommand } from './proc';
import { accountEnv } from './providers/registry';
import type { AntigravityQuota } from './antigravityQuota';
import { L } from './i18n';
import { readClaudeQuota } from './claudeQuota';
import { readCopilotQuota } from './copilotQuota';

interface Stored {
  /** providerId -> YYYY-MM-DD -> totals */
  days: Record<string, Record<string, UsageTotals>>;
  limits: Record<string, { at: number; message: string }>;
}

const empty = (): UsageTotals => ({ runs: 0, input: 0, output: 0, cached: 0, costUsd: 0, errors: 0 });

function add(a: UsageTotals, b: UsageTotals): UsageTotals {
  return { runs: a.runs + b.runs, input: a.input + b.input, output: a.output + b.output, cached: a.cached + b.cached, costUsd: a.costUsd + b.costUsd, errors: a.errors + b.errors };
}

function day(ts = Date.now()): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Messages CLIs print when a plan/rate limit is reached. */
export const LIMIT_PATTERN = /usage limit|rate[ _-]?limit|quota|429|resource[_ ]exhausted|too many requests|limit reached|exceeded your|額度|配額/i;

/** Tracks token usage of every agent run (per provider, per day) plus limit hits and official quotas. */
export class UsageTracker {
  private file: string;
  private data: Stored = { days: {}, limits: {} };
  private timer?: NodeJS.Timeout;
  private official = new Map<string, { value: ProviderUsage['official']; readAt: number; error?: string }>();
  /** Reads Antigravity's quota from Google once the user connected an account. */
  antigravity?: AntigravityQuota;
  /** The GitHub sign-in token (gh), for Copilot's quota. */
  githubToken?: () => Promise<string | undefined>;

  constructor(dataDir: string, private onChange: () => void) {
    this.file = path.join(dataDir, 'usage.json');
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { days: raw.days ?? {}, limits: raw.limits ?? {} };
    } catch {
      // first run
    }
  }

  private bucket(provider: string): UsageTotals {
    const p = (this.data.days[provider] ??= {});
    return (p[day()] ??= empty());
  }

  private changed() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data));
      this.onChange();
    }, 1000);
  }

  recordRun(provider: string) {
    this.bucket(provider).runs++;
    this.changed();
  }

  recordUsage(provider: string, u: TokenUsage) {
    const b = this.bucket(provider);
    b.input += u.input ?? 0;
    b.output += u.output ?? 0;
    b.cached += u.cached ?? 0;
    b.costUsd += u.costUsd ?? 0;
    this.changed();
  }

  recordError(provider: string, message: string) {
    this.bucket(provider).errors++;
    if (LIMIT_PATTERN.test(message)) this.data.limits[provider] = { at: Date.now(), message: message.slice(0, 400) };
    this.changed();
  }

  /** Usage per provider. `refresh` re-reads official quotas now instead of using the last reading (≤ 2 min old). */
  async summary(specs: ProviderSpec[], o: { refresh?: boolean } = {}): Promise<ProviderUsage[]> {
    const official = await Promise.all(specs.map((spec) => (spec.quota ? this.readOfficial(spec, o.refresh) : Promise.resolve(undefined))));
    return this.build(specs, official);
  }

  /** Same as summary(), with the last official quota reading (no CLI call) — for decisions that must be instant. */
  cachedSummary(specs: ProviderSpec[]): ProviderUsage[] {
    return this.build(
      specs,
      specs.map((s) => this.official.get(s.id)?.value),
    );
  }

  private build(specs: ProviderSpec[], official: ProviderUsage['official'][]): ProviderUsage[] {
    const today = day();
    const days: string[] = [];
    for (let i = 13; i >= 0; i--) days.push(day(Date.now() - i * 86400000));
    return specs.map((spec, i) => {
      const p = this.data.days[spec.id] ?? {};
      const daily = days.map((d) => ({ date: d, ...(p[d] ?? empty()) }));
      const last7 = daily.slice(-7).reduce((acc, d) => add(acc, d), empty());
      const limit = this.data.limits[spec.id];
      return {
        providerId: spec.id,
        today: p[today] ?? empty(),
        last7,
        daily,
        // A limit hit older than a week is no longer interesting.
        limitHit: limit && Date.now() - limit.at < 7 * 86400000 ? limit : undefined,
        official: official[i],
        officialError: this.official.get(spec.id)?.error,
        checkedAt: Date.now(),
      };
    });
  }

  private async readOfficial(spec: ProviderSpec, refresh?: boolean): Promise<ProviderUsage['official']> {
    const cached = this.official.get(spec.id);
    if (!refresh && cached && Date.now() - cached.readAt < 120000) return cached.value;
    let value: ProviderUsage['official'];
    let error: string | undefined;
    if (spec.quota?.reader === 'antigravity') {
      value = await (this.antigravity?.read() ?? Promise.resolve(undefined)).catch((e) => ((error = (e as Error).message), undefined));
    } else if (spec.quota?.reader === 'claude') {
      value = await readClaudeQuota(accountEnv(spec).CLAUDE_CONFIG_DIR).catch((e) => ((error = (e as Error).message), undefined));
    } else if (spec.quota?.reader === 'copilot') {
      // The gh sign-in belongs to the main account; extra Copilot accounts have no token Aivenue can read.
      if (spec.accountOf) error = L('額外加入的 Copilot 帳號查不到官方額度：額度是用「設定 → GitHub」登入的帳號查詢的，只對應主帳號', "Extra Copilot accounts can't show the plan quota: it is read with the GitHub account signed in under Settings → GitHub, which is the main account");
      else value = await readCopilotQuota(await this.githubToken?.()).catch((e) => ((error = (e as Error).message), undefined));
    } else if (spec.quota?.reader === 'codex-sessions') {
      // Ask Codex for the live numbers; its session logs only change when Codex runs.
      value = (await readCodexQuotaLive(spec).catch(() => undefined)) ?? safe(() => readCodexQuota(accountEnv(spec).CODEX_HOME));
    }
    this.official.set(spec.id, { value, readAt: Date.now(), error });
    return value;
  }
}

const safe = <T>(fn: () => T): T | undefined => {
  try {
    return fn();
  } catch {
    return undefined;
  }
};

/** Live rate limits from `codex app-server` (JSON-RPC over stdio: initialize → account/rateLimits/read). */
function readCodexQuotaLive(spec: ProviderSpec): Promise<ProviderUsage['official']> {
  const cmd = resolveCommand(specCommand(spec));
  if (!cmd) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    // An extra account reads its own quota (its own CODEX_HOME).
    const child = spawnResolved(cmd, ['app-server'], { env: childEnv(accountEnv(spec)), stdio: ['pipe', 'pipe', 'ignore'] });
    const done = (v: ProviderUsage['official']) => {
      clearTimeout(timer);
      child.kill();
      resolve(v);
    };
    const timer = setTimeout(() => done(undefined), 15000);
    const send = (m: unknown) => child.stdin?.write(JSON.stringify(m) + '\n');
    let buf = '';
    child.on('error', () => done(undefined));
    child.on('exit', () => done(undefined));
    child.stdout?.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id === 1) {
          send({ method: 'initialized' });
          send({ id: 2, method: 'account/rateLimits/read' });
        } else if (m.id === 2) {
          const rl = m.result?.rateLimits;
          if (!rl) return done(undefined);
          const windows: NonNullable<ProviderUsage['official']>['windows'] = [];
          for (const w of [rl.primary, rl.secondary]) {
            if (w && typeof w.usedPercent === 'number') windows.push({ minutes: Number(w.windowDurationMins) || 0, usedPercent: w.usedPercent, resetsAt: w.resetsAt ? Number(w.resetsAt) * 1000 : undefined });
          }
          const credits = (m.result?.rateLimitResetCredits?.credits ?? []).filter((c: any) => c.status === 'available').length;
          done({ plan: rl.planType ?? undefined, windows, updatedAt: Date.now(), source: 'codex-live', limitReached: !!rl.rateLimitReachedType, resetCredits: credits || undefined });
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'aivenue', title: 'Aivenue', version: '0.1.0' } } });
  });
}

/** Newest file under dir (walking only the newest subdirectory at each level, e.g. sessions/YYYY/MM/DD). */
function newestFile(dir: string, depth: number): string | undefined {
  if (!fs.existsSync(dir)) return undefined;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  if (depth === 0) {
    return entries
      .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
      .map((e) => path.join(dir, e.name))
      .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  }
  const subs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
  for (const s of subs) {
    const f = newestFile(path.join(dir, s), depth - 1);
    if (f) return f;
  }
  return undefined;
}

/** Codex writes the plan's rate-limit windows into its session logs (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl). */
function readCodexQuota(accountHome?: string): ProviderUsage['official'] {
  const home = accountHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const file = newestFile(path.join(home, 'sessions'), 3);
  if (!file) return undefined;
  const stat = fs.statSync(file);
  const size = Math.min(stat.size, 512 * 1024);
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(size);
  fs.readSync(fd, buf, 0, size, stat.size - size);
  fs.closeSync(fd);
  const lines = buf.toString('utf8').split('\n').reverse();
  for (const line of lines) {
    if (!line.includes('"rate_limits"')) continue;
    try {
      const ev = JSON.parse(line);
      const rl = ev.payload?.rate_limits ?? ev.rate_limits ?? ev.payload?.info?.rate_limits;
      if (!rl) continue;
      const windows: NonNullable<ProviderUsage['official']>['windows'] = [];
      for (const w of [rl.primary, rl.secondary]) {
        if (!w || typeof w.used_percent !== 'number') continue;
        windows.push({ minutes: Number(w.window_minutes) || 0, usedPercent: w.used_percent, resetsAt: w.resets_at ? Number(w.resets_at) * 1000 : undefined });
      }
      return { plan: rl.plan_type ?? undefined, windows, updatedAt: stat.mtimeMs, source: 'codex-sessions' };
    } catch {
      // partial first line of the tail buffer
    }
  }
  return undefined;
}
