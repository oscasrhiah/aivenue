import { useState } from 'react';
import type { AgentRole, ProviderInfo, StageKey, Verification, WorkflowRun } from '../../../core/src/types';
import { useT } from '../i18n';
import { cx, modelLabel, providerName, subTitle } from '../util';
import { AgentWindow, GpuWindow, ProcessWindow } from './DetailWindows';

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
  // Goal verification: after the code review, until every metric is met.
  const vst = run.stages.verify;
  if (run.config.verify?.enabled && vst) {
    const last = vst.rounds[vst.rounds.length - 1];
    const runningV = agents.some((a) => a.role === 'verifier' && (a.status === 'running' || a.status === 'paused' || a.status === 'queued'));
    const v = last?.verification;
    items.push({
      key: 'verify',
      label: t('目標驗收', 'Goal verification'),
      meta: [
        run.config.verify.by === 'planner' ? t('由計畫者', 'by the planner') : t('獨立驗收', 'independent'),
        vst.rounds.length > 1 ? t(`第 ${vst.rounds.length} 次`, `check ${vst.rounds.length}`) : undefined,
        v && !runningV ? outcomeText(t, v) : undefined,
      ]
        .filter(Boolean)
        .join(' · '),
      state: runningV ? 'active' : vst.status === 'approved' ? 'done' : ended ? 'failed' : 'pending',
    });
  }
  return items;
}

export const outcomeText = (t: ReturnType<typeof useT>, v: Verification) =>
  ({ met: t('達標', 'met'), not_met: t('目標未達成 → 重新規劃', 'goal missed → re-plan'), invalid_evidence: t('證據無效 → 重新驗證', 'invalid evidence → re-test'), defect: t('有缺陷 → 退回修正', 'defects → back to fix') })[v.outcome];

/** Latest measurement of each acceptance metric (the gap to the goal). */
export function goalGap(run: WorkflowRun) {
  const metrics = run.plan?.goal?.metrics ?? [];
  const checks = (run.stages.verify?.rounds ?? []).flatMap((r) => (r.verification ? [r.verification] : []));
  const last = checks[checks.length - 1];
  // The planner's metrics, plus what the verifier measured besides them (the user's own criteria, "U1"…).
  const extra = (last?.metrics ?? []).filter((m) => !metrics.some((x) => x.id === m.id)).map((m) => ({ id: m.id, name: '', target: '', how: '' }));
  const rows = [...metrics, ...extra].map((m) => {
    const got = last?.metrics.find((x) => x.id === m.id);
    return { ...m, value: got?.value, met: got?.met, evidence: got?.evidence };
  });
  return { rows, met: rows.filter((r) => r.met).length, stale: !!last?.stale, last };
}

/** What holds the workflow up right now, in words (empty when nothing does). */
export function blockers(run: WorkflowRun, providers: ProviderInfo[], t: ReturnType<typeof useT>): string[] {
  const out: string[] = [];
  if (run.status === 'paused') out.push(t('已暫停', 'Paused'));
  if (run.pending) out.push(t(`等你決定：${run.pending.message}`, `Waiting for your decision: ${run.pending.message}`));
  if (run.approvals?.length) out.push(t(`等你核准 ${run.approvals.length} 個動作`, `${run.approvals.length} action(s) waiting for your approval`));
  for (const a of Object.values(run.agents)) {
    if (!['running', 'paused', 'queued'].includes(a.status)) continue;
    const who = `${providerName(providers, a.provider)}`;
    if (a.waiting) out.push(`${who}：${a.waiting}`);
    else if (a.failure && a.status === 'running') out.push(`${who}：${a.failure.action}`);
  }
  return out;
}

export function ProgressPanel({ run, providers }: { run: WorkflowRun; providers: ProviderInfo[] }) {
  const t = useT();
  const [open, setOpen] = useState(run.status === 'running' || run.status === 'paused' || run.status === 'waiting_human');
  // A detail window opened from a tag: an agent, the GPUs or a background process.
  const [detail, setDetail] = useState<{ agent: string } | { gpu: true } | { pid: number }>();
  const items = buildItems(run, providers, t);
  if (!items.length) return null;
  const done = items.filter((i) => i.state === 'done' || i.state === 'skipped').length;
  const current = items.find((i) => i.state === 'active');
  const gap = goalGap(run);
  const live = run.status === 'running' || run.status === 'paused' || run.status === 'waiting_human';
  const block = live ? blockers(run, providers, t) : [];
  const working = live ? Object.values(run.agents).filter((a) => a.status === 'running' && a.role !== 'compactor') : [];
  const runningProcs = (run.processes ?? []).filter((p) => p.alive);
  return (
    <div className="progress-panel">
      <button className="pp-head" onClick={() => setOpen(!open)}>
        <span className="pp-title">{t('進度', 'Progress')}</span>
        <span className="muted small">
          {done}/{items.length}
          {gap.rows.length > 0 && ` · ${t('目標', 'goal')} ${gap.met}/${gap.rows.length}`}
          {!open && block.length ? ` · ⏸ ${block[0]}` : !open && current ? ` · ${current.label}` : ''}
        </span>
        <span className="pp-chev">{open ? '▾' : '▸'}</span>
      </button>
      {open && (gap.rows.length > 0 || working.length > 0 || block.length > 0 || !!run.gpuLocks?.length || runningProcs.length > 0) && (
        <div className="pp-status">
          {gap.rows.length > 0 && (
            <div className="pp-goal">
              <div className="pp-sub">
                {t('距離目標', 'Gap to the goal')} · {gap.met}/{gap.rows.length} {t('項達成', 'met')}
                {(run.cycles ?? 0) > 0 && <span className="muted"> · {t(`第 ${(run.cycles ?? 0) + 1} 輪循環`, `cycle ${(run.cycles ?? 0) + 1}`)}</span>}
                {gap.stale && <span className="badge warn" title={t('程式碼在量測之後改過，這份結果要重新驗證', 'The code changed after this was measured; it needs checking again')}>{t('過期', 'stale')}</span>}
              </div>
              {gap.rows.map((m) => (
                <div key={m.id} className={cx('pp-metric', m.met === true ? 'ok' : m.met === false ? 'no' : 'todo')} title={m.evidence || m.how}>
                  <span className="pp-icon">{m.met === true ? '✓' : m.met === false ? '✕' : '·'}</span>
                  <span className="pp-label">
                    {m.id} {m.name || (m.id.startsWith('U') ? t('你的驗收標準', 'your criterion') : '')}
                  </span>
                  <span className="pp-meta">
                    {m.value !== undefined ? `${m.value}` : t('尚未量測', 'not measured')}
                    {m.target ? ` / ${m.target}` : ''}
                  </span>
                </div>
              ))}
            </div>
          )}
          {working.length > 0 && (
            <div className="pp-now">
              <span className="pp-sub">{t('目前', 'Now')}</span>
              {working.map((a) => (
                <button key={a.id} className="pp-chip clickable" title={t('點一下查看它正在做什麼', 'Click to see what it is doing')} onClick={() => setDetail({ agent: a.id })}>
                  <span className={cx('am-dot', 'live')} /> {providerName(providers, a.provider)} · {a.role === 'subagent' ? subTitle(a) : a.task}
                </button>
              ))}
            </div>
          )}
          {block.length > 0 && (
            <div className="pp-block">
              <span className="pp-sub">{t('卡在', 'Blocked by')}</span>
              {block.map((b, i) => (
                <span key={i} className="pp-chip warn">
                  {b}
                </span>
              ))}
            </div>
          )}
          {!!run.gpuLocks?.length && (
            <div className="pp-now">
              <span className="pp-sub">GPU</span>
              {run.gpuLocks.map((l, i) => (
                <button key={i} className="pp-chip clickable" title={t('點一下查看 GPU 的使用狀態', 'Click to see the GPU status')} onClick={() => setDetail({ gpu: true })}>
                  🔒 GPU {l.gpus.join(', ')} · {providerName(providers, run.agents[l.agentId]?.provider ?? '')}
                </button>
              ))}
            </div>
          )}
          {!!run.processes?.some((p) => p.alive) && (
            <div className="pp-now">
              <span className="pp-sub">{t('背景程序', 'Background')}</span>
              {/* Ended ones move to the agent map, next to the round that started them. */}
              {run.processes.filter((p) => p.alive).map((p) => (
                <button key={p.pid} className={cx('pp-chip clickable', !p.alive && 'muted')} title={t('點一下查看進度、速度與日誌', 'Click to see its progress, speed and log')} onClick={() => setDetail({ pid: p.pid })}>
                  <span className={cx('am-dot', p.alive && 'live')} /> {p.pid} · {p.purpose} · {p.alive ? t('執行中', 'alive') : t('已結束', 'ended')}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
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
      {detail && 'agent' in detail && <AgentWindow run={run} agentId={detail.agent} providers={providers} onClose={() => setDetail(undefined)} />}
      {detail && 'gpu' in detail && <GpuWindow run={run} providers={providers} onClose={() => setDetail(undefined)} />}
      {detail && 'pid' in detail && <ProcessWindow run={run} pid={detail.pid} providers={providers} onClose={() => setDetail(undefined)} />}
    </div>
  );
}
