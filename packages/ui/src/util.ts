import type { AgentRole, AgentStatus, ProviderInfo, StageRun, WorkflowRun, WorkflowStatus, WorkflowSummary } from '../../core/src/types';
import type { T } from './i18n';
import { taskTitle } from '../../core/src/taskTitle';

export const roleLabel = (t: T, r: AgentRole): string =>
  ({
    planner: t('撰寫計畫', 'Plan'),
    plan_reviewer: t('審查計畫', 'Plan review'),
    executor: t('實作', 'Implement'),
    code_reviewer: t('審查程式碼', 'Code review'),
    verifier: t('目標驗收', 'Goal check'),
    adjudicator: t('裁定', 'Ruling'),
    subagent: t('子 agent', 'Sub-agent'),
    advisor: t('顧問', 'Advisor'),
    compactor: t('上下文壓縮', 'Compaction'),
    test: t('連線測試', 'Test'),
  })[r];

export const agentStatus = (t: T, s: AgentStatus) =>
  ({
    queued: { label: t('排隊中', 'Queued'), cls: 'muted' },
    running: { label: t('執行中', 'Running'), cls: 'run' },
    paused: { label: t('已暫停', 'Paused'), cls: 'warn' },
    completed: { label: t('完成', 'Done'), cls: 'ok' },
    failed: { label: t('失敗', 'Failed'), cls: 'err' },
    cancelled: { label: t('已停止', 'Stopped'), cls: 'muted' },
  })[s];

/**
 * A workflow's state in a word, and its colour: only running, waiting for you, short of its goal and failed take one; a
 * finished, paused or stopped one is muted (its icon tells them apart). Waiting for you is said by what it waits for
 * (waitWord, from the run or its summary); this word is only the fallback when that is not known.
 */
export const wfStatus = (t: T, s: WorkflowStatus) =>
  ({
    running: { label: t('執行中', 'Running'), cls: 'run' },
    paused: { label: t('已暫停', 'Paused'), cls: 'muted' },
    waiting_human: { label: t('等你處理', 'Waiting for you'), cls: 'warn' },
    completed: { label: t('已完成', 'Completed'), cls: 'muted' },
    incomplete: { label: t('未完成', 'Incomplete'), cls: 'warn' },
    failed: { label: t('失敗', 'Failed'), cls: 'err' },
    cancelled: { label: t('已停止', 'Stopped'), cls: 'muted' },
    interrupted: { label: t('已中斷', 'Interrupted'), cls: 'muted' },
  })[s];

/** What a workflow waits for from you: an agent's question, an approval, or another decision (e.g. rounds used up). */
export type WaitKind = 'question' | 'approval' | 'decision';

export function waitKind(run: Pick<WorkflowRun, 'status' | 'pending' | 'approvals'>): WaitKind | undefined {
  if (run.pending) return run.pending.question ? 'question' : 'decision';
  if (run.status === 'waiting_human') return 'decision';
  if (run.approvals?.length && run.status === 'running') return 'approval';
  return undefined;
}

/** One word per kind of waiting, the same in the header, the progress panel and an agent's turn. */
export const waitWord = (t: T, k: WaitKind): string =>
  ({ question: t('等你回答', 'Waiting for your answer'), approval: t('等你核准', 'Waiting for your approval'), decision: t('等你決定', 'Waiting for your decision') })[k];

/** Who asked the pending question: the "provider · role" its message starts with, else the main agent holding its turn. */
export function askerOf(t: T, run: Pick<WorkflowRun, 'pending' | 'agents'>, providers: ProviderInfo[]): string | undefined {
  const m = /^(.+?) (?:問你：|asks: )/.exec(run.pending?.message ?? '');
  if (m) return m[1];
  const a = Object.values(run.agents).find((x) => x.status === 'paused' && !x.parentId);
  return a ? `${providerName(providers, a.provider)} · ${roleLabel(t, a.role)}` : undefined;
}

/** What a conversation in the chat list waits for from you (its summary says it; a summary without it: a decision). */
export function summaryWait(w: Pick<WorkflowSummary, 'status' | 'waiting'>): WaitKind | undefined {
  return w.waiting ?? (w.status === 'waiting_human' ? 'decision' : undefined);
}

/** How long a failed conversation still counts on ☰: a day, so an old failure left in the list does not keep it lit. */
export const RECENT_FAILURE_MS = 24 * 60 * 60 * 1000;

/**
 * Conversations that need you (the ☰ badge in a narrow window): those waiting for your answer, approval or decision,
 * and those that failed within the last day (an older failure stays in its row, not on ☰).
 */
export function attention(list: Pick<WorkflowSummary, 'status' | 'waiting' | 'updatedAt'>[], now = Date.now()): { waiting: number; failed: number } {
  return {
    waiting: list.filter((w) => !!summaryWait(w)).length,
    failed: list.filter((w) => w.status === 'failed' && now - (w.updatedAt ?? 0) < RECENT_FAILURE_MS).length,
  };
}

/** The ☰ button's name: the chat list, and how many conversations wait for you or failed lately. */
export function attentionLabel(t: T, a: { waiting: number; failed: number }): string {
  return [
    t('對話紀錄', 'Chat history'),
    a.waiting ? t(`${a.waiting} 段等你處理`, `${a.waiting} waiting for you`) : '',
    a.failed ? t(`${a.failed} 段最近失敗`, `${a.failed} failed lately`) : '',
  ]
    .filter(Boolean)
    .join(t('，', ', '));
}

export const stageStatus = (t: T, s: StageRun['status']) =>
  ({
    pending: t('尚未開始', 'Pending'),
    running: t('進行中', 'In progress'),
    approved: t('已通過', 'Approved'),
    skipped: t('略過', 'Skipped'),
    failed: t('失敗', 'Failed'),
    cancelled: t('已停止', 'Stopped'),
  })[s];

export const STEP_ICON = { pending: '○', in_progress: '◐', done: '●', blocked: '✕', skipped: '–' } as const;

/**
 * Readable model name: "claude-opus-5-5" → "Opus 5.5", "gpt-6-astra" → "GPT-6 Astra",
 * "gemini-3.8-flash-high" → "Gemini 3.8 Flash High", "opencode/big-pickle" → "Big Pickle".
 */
export function modelLabel(id?: string): string {
  if (!id) return '';
  let s = id.split('/').pop()!.replace(/^claude-/i, '');
  // Version parts written with dashes ("5-5", "4-6") become dotted ("5.5").
  s = s.replace(/(^|-)(\d+)-(\d)(?=-|$)/g, '$1$2.$3');
  const words = s.split(/[-_]/).filter(Boolean);
  const out: string[] = [];
  for (const w of words) {
    if (/^gpt$/i.test(w)) out.push('GPT');
    else if (/^\d/.test(w) && out[out.length - 1] === 'GPT') out[out.length - 1] = `GPT-${w}`;
    else if (/^\d{8}$/.test(w)) continue; // dated snapshots
    else out.push(/^[a-z]/.test(w) ? w[0].toUpperCase() + w.slice(1) : w);
  }
  return out.join(' ') || id;
}

export function providerName(providers: ProviderInfo[], id: string): string {
  return providers.find((p) => p.spec.id === id)?.spec.name ?? id;
}

/**
 * How long something took, as a person says it: "45 秒", "4 分 58 秒", "1 小時 5 分" ("45s", "4m 58s", "1h 5m"). Empty
 * under `min` seconds (10 by default: a turn that short needs no time on it), never "0s" or "4:58".
 */
export function duration(t: T, from?: number, to?: number, min = 10): string {
  if (!from) return '';
  const s = Math.max(0, Math.round(((to ?? Date.now()) - from) / 1000));
  if (s < Math.max(1, min)) return '';
  if (s < 60) return t(`${s} 秒`, `${s}s`);
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? t(`${m} 分 ${s % 60} 秒`, `${m}m ${s % 60}s`) : t(`${m} 分`, `${m}m`);
  const h = Math.floor(m / 60);
  return m % 60 ? t(`${h} 小時 ${m % 60} 分`, `${h}h ${m % 60}m`) : t(`${h} 小時`, `${h}h`);
}

/** Compact elapsed time like 1:05 or 12s. */
export function elapsed(from?: number, to?: number): string {
  if (!from) return '';
  const s = Math.max(0, Math.round(((to ?? Date.now()) - from) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}:${String(s % 60).padStart(2, '0')}`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** A message's time as shown on it: "14:05" today, "11/16 14:05" earlier this year, "2025/11/16 14:05" before. */
export function msgTime(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const n = new Date(now);
  const hm = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  if (d.toDateString() === n.toDateString()) return hm;
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  return d.getFullYear() === n.getFullYear() ? `${md} ${hm}` : `${d.getFullYear()}/${md} ${hm}`;
}

/** A folder's own name, the last part of its path ("C:\\work\\csv-import\\" → "csv-import"). */
export function folderName(dir: string): string {
  return dir.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || dir;
}

/**
 * The working folders of the latest conversations, newest activity first, each once (the same folder written with
 * another case or a trailing slash on Windows counts once), without `current`; at most `max`.
 */
export function recentFolders(list: Pick<WorkflowSummary, 'cwd' | 'updatedAt'>[], current = '', max = 5): string[] {
  const key = (d: string) => d.replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
  const seen = new Set<string>(current ? [key(current)] : []);
  const out: string[] = [];
  for (const w of [...list].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (!w.cwd || seen.has(key(w.cwd))) continue;
    seen.add(key(w.cwd));
    out.push(w.cwd);
    if (out.length >= max) break;
  }
  return out;
}

/** The full date and time, to the second (a message time's tooltip). */
export function fullTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
}

export function relativeDay(t: T, ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date(Date.now() - 86400000);
  if (d.toDateString() === today.toDateString()) return t('今天', 'Today');
  if (d.toDateString() === yest.toDateString()) return t('昨天', 'Yesterday');
  if (Date.now() - ts < 7 * 86400000) return t('過去 7 天', 'Previous 7 days');
  return t('更早', 'Older');
}

export function fmtTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(n);
}

export function cx(...parts: (string | false | undefined | null)[]): string {
  return parts.filter(Boolean).join(' ');
}

const FIXED: Record<string, string> = { claude: '#d97757', codex: '#6b6b6b', gemini: '#4285f4', qwen: '#615ced', kimi: '#1f1f1f', copilot: '#8250df' };
/** Colours the user picked (Settings → Providers), kept up to date by useProviders. */
const picked = new Map<string, string>();
export function setPickedColors(list: { spec: { id: string }; color?: string }[]) {
  picked.clear();
  for (const p of list) if (p.color) picked.set(p.spec.id, p.color);
}
/** The usual colour, before any the user picked. */
export function defaultProviderColor(id: string): string {
  if (FIXED[id]) return FIXED[id];
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 45% 50%)`;
}
export function providerColor(id: string): string {
  return picked.get(id) ?? defaultProviderColor(id);
}

/** The top-level agent that was working when the user sent a mid-run message (its message is shown among its steps). */
export function saidOwner(run: WorkflowRun, ts: number): string | undefined {
  const working = Object.values(run.agents).filter((a) => !a.parentId && a.startedAt && a.startedAt <= ts && (!a.endedAt || a.endedAt >= ts));
  return working.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))[0]?.id;
}

/** The colour group of a role (its node on the agent map): plan, build, verify, or helpers. A reviewer shares its author's group. */
export function roleTone(r: AgentRole): string {
  if (r === 'planner' || r === 'plan_reviewer') return 'rc-plan';
  if (r === 'executor' || r === 'code_reviewer') return 'rc-build';
  if (r === 'verifier' || r === 'adjudicator') return 'rc-verify';
  return 'rc-help';
}

/** A sub-agent's short name: what its parent called it, else taken from its task. */
export function subTitle(a: { title?: string; brief?: string; task: string }): string {
  return a.title || taskTitle(a.brief ?? a.task) || a.task;
}

/** The first meaningful line of an answer (skips headings and "Done."-style openers), for one-line summaries. */
export function firstLine(text: string | undefined, max = 90): string {
  const lines = (text ?? '')
    .split(/\r?\n/)
    // Headings and lead-ins ("## Result", "建立的檔案：") say nothing on their own.
    .filter((l) => !/^\s*#/.test(l) && !/[:：]\s*$/.test(l))
    .map((l) => l.replace(/^[>*\-\s]+|[*`]+/g, '').trim())
    .filter((l) => l.length >= 6 && !/^(已完成|完成|done|finished)[。.!！]?$/i.test(l));
  const l = lines[0] ?? '';
  return l.length > max ? `${l.slice(0, max - 1)}…` : l;
}

/**
 * Whether two texts say much the same (character-pair overlap), e.g. a note that repeats the verdict right below it.
 * Works for Chinese and English alike.
 */
export function similar(a: string, b: string, threshold = 0.5): boolean {
  const pairs = (s: string) => {
    const t = s.replace(/\s+/g, '').toLowerCase();
    const out = new Set<string>();
    for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
    return out;
  };
  const x = pairs(a);
  const y = pairs(b);
  if (x.size < 8 || y.size < 8) return false;
  let both = 0;
  for (const p of x) if (y.has(p)) both++;
  return both / Math.min(x.size, y.size) >= threshold;
}
