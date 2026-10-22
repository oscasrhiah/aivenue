import type { AgentRole, AgentStatus, ProviderInfo, StageRun, WorkflowStatus } from '../../core/src/types';
import type { T } from './i18n';

export const roleLabel = (t: T, r: AgentRole): string =>
  ({
    planner: t('撰寫計畫', 'Plan'),
    plan_reviewer: t('審查計畫', 'Plan review'),
    executor: t('實作', 'Implement'),
    code_reviewer: t('審查程式碼', 'Code review'),
    subagent: 'Sub agent',
    advisor: t('顧問', 'Advisor'),
    test: t('連線測試', 'Test'),
  })[r];

export const agentStatus = (t: T, s: AgentStatus) =>
  ({
    queued: { label: t('排隊中', 'Queued'), cls: 'muted' },
    running: { label: t('執行中', 'Running'), cls: 'run' },
    paused: { label: t('已暫停', 'Paused'), cls: 'warn' },
    completed: { label: t('完成', 'Done'), cls: 'ok' },
    failed: { label: t('失敗', 'Failed'), cls: 'err' },
    cancelled: { label: t('已取消', 'Cancelled'), cls: 'muted' },
  })[s];

export const wfStatus = (t: T, s: WorkflowStatus) =>
  ({
    running: { label: t('執行中', 'Running'), cls: 'run' },
    paused: { label: t('已暫停', 'Paused'), cls: 'warn' },
    waiting_human: { label: t('等待你的決定', 'Needs your input'), cls: 'warn' },
    completed: { label: t('已完成', 'Completed'), cls: 'ok' },
    failed: { label: t('失敗', 'Failed'), cls: 'err' },
    cancelled: { label: t('已取消', 'Cancelled'), cls: 'muted' },
    interrupted: { label: t('已中斷', 'Interrupted'), cls: 'muted' },
  })[s];

export const stageStatus = (t: T, s: StageRun['status']) =>
  ({
    pending: t('尚未開始', 'Pending'),
    running: t('進行中', 'In progress'),
    approved: t('已通過', 'Approved'),
    skipped: t('略過', 'Skipped'),
    failed: t('失敗', 'Failed'),
    cancelled: t('已取消', 'Cancelled'),
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
export function providerColor(id: string): string {
  if (FIXED[id]) return FIXED[id];
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 45% 50%)`;
}
