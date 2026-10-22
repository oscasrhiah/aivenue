import { useState } from 'react';
import type { AgentRole, ProviderInfo, StageKey, WorkflowRun } from '../../../core/src/types';
import { useT } from '../i18n';
import { cx, modelLabel, providerName } from '../util';

type ItemState = 'done' | 'active' | 'pending' | 'failed' | 'skipped';
interface Item {
  key: string;
  label: string;
  meta?: string;
  state: ItemState;
  sub?: boolean;
}

const STAGE_ROLES: Record<StageKey, [AgentRole, AgentRole]> = { plan: ['planner', 'plan_reviewer'], implement: ['executor', 'code_reviewer'] };

/** Checklist of where the workflow is: stages, review loops and the plan's steps. */
function buildItems(run: WorkflowRun, providers: ProviderInfo[], t: ReturnType<typeof useT>): Item[] {
  const agents = Object.values(run.agents);
  const ended = run.status !== 'running' && run.status !== 'paused' && run.status !== 'waiting_human';
  const items: Item[] = [];
  for (const key of ['plan', 'implement'] as StageKey[]) {
    const cfg = run.config[key];
    const st = run.stages[key];
    if (!cfg.enabled || st.status === 'skipped') continue;
    const [authorRole, reviewerRole] = STAGE_ROLES[key];
    const round = st.rounds[st.rounds.length - 1];
    const roundMeta = st.rounds.length > 1 ? t(`第 ${st.rounds.length} 輪`, `round ${st.rounds.length}`) : undefined;
    const running = (role: AgentRole) => agents.some((a) => a.stage === key && a.role === role && (a.status === 'running' || a.status === 'paused' || a.status === 'queued'));
    const who = (role: AgentRole, fallback?: string) => {
      const a = agents.filter((x) => x.stage === key && x.role === role).sort((x, y) => (y.startedAt ?? 0) - (x.startedAt ?? 0))[0];
      const id = a?.provider ?? fallback;
      return id ? `${providerName(providers, id)}${a?.model ? ` · ${modelLabel(a.model)}` : ''}` : undefined;
    };
    const failed = st.status === 'failed' || st.status === 'cancelled';
    const stateOf = (isRunning: boolean, isDone: boolean): ItemState => (isRunning ? 'active' : isDone ? 'done' : failed || (ended && st.status !== 'approved') ? 'failed' : 'pending');

    const authorDone = st.status === 'approved' || (!!round?.submission && !running(authorRole));
    items.push({
      key: `${key}-author`,
      label: key === 'plan' ? t('撰寫計畫', 'Write the plan') : t('實作', 'Implement'),
      meta: [who(authorRole, cfg.author.provider), roundMeta].filter(Boolean).join(' · '),
      state: stateOf(running(authorRole), authorDone),
    });
    if (key === 'implement')
      for (const s of run.steps)
        items.push({
          key: `step-${s.id}`,
          // Steps reported without a plan use free-form ids and often repeat the note as the title.
          label: /^\d/.test(s.id) ? `${s.id}. ${s.title}` : s.title,
          meta: s.note && !s.title.includes(s.note.slice(0, 20)) ? s.note : undefined,
          sub: true,
          // Agents don't always mark their last steps done; once the stage is approved they are.
          state: s.status === 'done' || (s.status === 'in_progress' && st.status === 'approved') ? 'done' : s.status === 'in_progress' ? 'active' : s.status === 'blocked' ? 'failed' : s.status === 'skipped' ? 'skipped' : 'pending',
        });
    if (cfg.reviewer)
      items.push({
        key: `${key}-review`,
        label: key === 'plan' ? t('審查計畫', 'Review the plan') : t('審查程式碼', 'Review the code'),
        meta: [who(reviewerRole, cfg.reviewer.provider), round?.review?.verdict === 'revise' && !running(reviewerRole) && st.status === 'running' ? t('要求修改，退回重做', 'changes requested, back to the author') : undefined].filter(Boolean).join(' · '),
        state: stateOf(running(reviewerRole), st.status === 'approved'),
      });
  }
  return items;
}

export function ProgressPanel({ run, providers }: { run: WorkflowRun; providers: ProviderInfo[] }) {
  const t = useT();
  const [open, setOpen] = useState(run.status === 'running' || run.status === 'paused' || run.status === 'waiting_human');
  const items = buildItems(run, providers, t);
  if (!items.length) return null;
  const done = items.filter((i) => i.state === 'done' || i.state === 'skipped').length;
  const current = items.find((i) => i.state === 'active');
  return (
    <div className="progress-panel">
      <button className="pp-head" onClick={() => setOpen(!open)}>
        <span className="pp-title">{t('進度', 'Progress')}</span>
        <span className="muted small">
          {done}/{items.length}
          {!open && current ? ` · ${current.label}` : ''}
        </span>
        <span className="pp-chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="pp-list">
          {items.map((i) => (
            <div key={i.key} className={cx('pp-item', i.state, i.sub && 'sub')}>
              <span className={cx('pp-icon', i.state)}>{i.state === 'done' ? '✓' : i.state === 'failed' ? '✕' : i.state === 'skipped' ? '–' : ''}</span>
              <span className="pp-label">{i.label}</span>
              {i.meta && <span className="pp-meta">{i.meta}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
