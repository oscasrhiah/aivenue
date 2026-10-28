import { useEffect, useState, type ReactNode } from 'react';
import type { GpuDetail, ProcessDetail, ProviderInfo, WorkflowRun } from '../../../core/src/types';
import { hub, useAgentEvents } from '../api';
import { useT } from '../i18n';
import { agentStatus, cx, elapsed, modelLabel, providerColor, providerName, roleLabel, subTitle } from '../util';
import { Transcript } from './Transcript';

/** A small window over the conversation (Esc or a click outside closes it). */
function Window({ title, onClose, children }: { title: ReactNode; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    // Esc closes only this window, not one it was opened from (e.g. the agent map).
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);
  return (
    <div
      className="modal-back detail-back"
      onClick={(e) => {
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="modal detail-window" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head wf-modal-head">
          <h3>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Re-read something every few seconds while the window is open. */
function usePolled<T>(load: () => Promise<T>, ms = 3000): { data?: T; error?: string } {
  const [state, setState] = useState<{ data?: T; error?: string }>({});
  useEffect(() => {
    let alive = true;
    const tick = () =>
      load()
        .then((data) => alive && setState({ data }))
        .catch((e) => alive && setState((s) => ({ ...s, error: (e as Error).message })));
    void tick();
    const timer = setInterval(tick, ms);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

const bytes = (n?: number) => {
  if (n === undefined) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) (v /= 1024), i++;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
};
const duration = (sec?: number) => {
  if (sec === undefined) return '—';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};

function Bar({ percent, tone }: { percent: number; tone?: 'ok' | 'warn' | 'err' }) {
  return (
    <div className="dw-bar">
      <div className={cx('dw-fill', tone)} style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} />
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="dw-row">
      <span className="dw-label">{label}</span>
      <span className="dw-value">{children}</span>
    </div>
  );
}

/** A working agent: what it is doing now and its latest steps. */
export function AgentWindow({ run, agentId, providers, onClose }: { run: WorkflowRun; agentId: string; providers: ProviderInfo[]; onClose: () => void }) {
  const t = useT();
  const a = run.agents[agentId];
  const events = useAgentEvents(a?.workflowId ?? run.id, agentId);
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  if (!a) return null;
  const st = agentStatus(t, a.status);
  return (
    <Window
      onClose={onClose}
      title={
        <>
          <span className="mark" style={{ background: providerColor(a.provider) }} /> {providerName(providers, a.provider)} · {a.role === 'subagent' ? subTitle(a) : roleLabel(t, a.role)}
        </>
      }
    >
      <Row label={t('狀態', 'Status')}>
        <span className={cx('status', st.cls)}>{st.label}</span> · {elapsed(a.startedAt, a.endedAt)}
      </Row>
      <Row label={t('模型', 'Model')}>
        {a.model ? modelLabel(a.model) : t('預設模型', 'default model')}
        {a.effort ? ` · ${t('推理', 'effort')} ${a.effort}` : ''}
      </Row>
      <Row label={t('任務', 'Task')}>{a.task}</Row>
      {(a.waiting || a.activity) && <Row label={t('現在', 'Now')}>{a.waiting ?? a.activity?.replace(/^\S+\s/, '')}</Row>}
      {a.failure && <Row label={t('狀況', 'Issue')}>{a.failure.action}</Row>}
      <Row label={t('統計', 'Stats')}>
        {a.stats.tools} {t('個動作', 'actions')} · {a.stats.commands} {t('個指令', 'commands')} · {a.stats.filesChanged.length} {t('個檔案', 'files')}
      </Row>
      <div className="dw-section">{t('最近的步驟', 'Latest steps')}</div>
      <div className="dw-steps">{events.length ? <Transcript events={events} limit={8} /> : <span className="muted small">{t('載入中…', 'Loading…')}</span>}</div>
      <div className="wf-modal-foot">
        <button
          className="btn"
          onClick={() => {
            onClose();
            setTimeout(() => document.querySelector(`[data-agent-id="${agentId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
          }}
        >
          {t('前往它的卡片', 'Go to its card')}
        </button>
      </div>
    </Window>
  );
}

/** The GPUs: memory, load, temperature, power, the lock and what runs on each card. */
export function GpuWindow({ run, providers, onClose }: { run: WorkflowRun; providers: ProviderInfo[]; onClose: () => void }) {
  const t = useT();
  const { data, error } = usePolled(() => hub.call<GpuDetail[]>('resources.gpuDetail'));
  return (
    <Window onClose={onClose} title={t('GPU 狀態', 'GPU status')}>
      {error && <div className="err-text small">{error}</div>}
      {!data && !error && <div className="muted small">{t('讀取中…', 'Reading…')}</div>}
      {data && !data.length && <div className="muted small">{t('沒有偵測到 NVIDIA GPU（nvidia-smi）', 'No NVIDIA GPU found (nvidia-smi)')}</div>}
      {data?.map((g) => {
        const mem = g.memTotalMB ? (g.memUsedMB / g.memTotalMB) * 100 : 0;
        const holder = g.lockedBy && g.lockedBy.workflowId === run.id ? run.agents[g.lockedBy.agentId] : undefined;
        return (
          <div key={g.index} className="dw-card">
            <div className="dw-card-head">
              GPU {g.index} · {g.name}
              {g.lockedBy && (
                <span className="badge">
                  🔒 {holder ? providerName(providers, holder.provider) : t('其他工作流', 'another workflow')} · {elapsed(g.lockedBy.since)}
                </span>
              )}
            </div>
            <Row label={t('記憶體', 'Memory')}>
              {bytes(g.memUsedMB * 1024 ** 2)} / {bytes(g.memTotalMB * 1024 ** 2)} ({Math.round(mem)}%)
            </Row>
            <Bar percent={mem} tone={mem > 90 ? 'err' : mem > 70 ? 'warn' : 'ok'} />
            <Row label={t('使用率', 'Load')}>{g.util}%</Row>
            <Bar percent={g.util} />
            <Row label={t('溫度／功耗', 'Temp / power')}>
              {g.tempC !== undefined ? `${g.tempC}°C` : '—'} · {g.powerW !== undefined ? `${Math.round(g.powerW)} W` : '—'}
            </Row>
            <Row label={t('執行中的程序', 'Running on it')}>{g.apps.length ? g.apps.map((p) => `${p.pid} ${p.name.split(/[\\/]/).pop()}${p.memMB ? ` (${bytes(p.memMB * 1024 ** 2)})` : ''}`).join('、') : t('沒有', 'none')}</Row>
          </div>
        );
      })}
      <div className="muted tiny">{t('每 3 秒更新', 'Updates every 3 seconds')}</div>
    </Window>
  );
}

/** A background process: progress (file size, log or what the agent reported), speed, time left, memory and its log. */
export function ProcessWindow({ run, pid, providers, onClose, workflowId }: { run: WorkflowRun; pid: number; providers: ProviderInfo[]; onClose: () => void; workflowId?: string }) {
  const t = useT();
  const { data: d, error } = usePolled(() => hub.call<ProcessDetail>('processes.inspect', { workflowId: workflowId ?? run.id, pid }));
  const owner = d ? run.agents[d.agentId] : undefined;
  const source = d?.source === 'file' ? t('依輸出檔大小', 'from the output size') : d?.source === 'log' ? t('依日誌中的百分比', 'from its log') : d?.source === 'agent' ? t('agent 回報', 'reported by the agent') : '';
  return (
    <Window onClose={onClose} title={`${pid} · ${d?.purpose ?? t('背景程序', 'Background process')}`}>
      {error && <div className="err-text small">{error}</div>}
      {!d && !error && <div className="muted small">{t('讀取中…', 'Reading…')}</div>}
      {d && (
        <>
          <Row label={t('狀態', 'Status')}>
            <span className={cx('status', d.alive ? 'live' : d.endedEarly ? 'err' : 'muted')}>{d.alive ? t('執行中', 'Running') : d.endedEarly ? t('已結束（未達 100%）', 'Ended (before 100%)') : t('已結束', 'Ended')}</span>
            {' · '}
            {t('已執行', 'running for')} {duration(d.runtimeSec)}
          </Row>
          {d.percent !== undefined ? (
            <>
              <Row label={t('進度', 'Progress')}>
                <b>{d.percent.toFixed(d.percent < 10 ? 1 : 0)}%</b> <span className="muted">· {source}</span>
              </Row>
              <Bar percent={d.percent} tone={d.endedEarly ? 'err' : d.percent >= 100 ? 'ok' : undefined} />
            </>
          ) : (
            <Row label={t('進度', 'Progress')}>
              <span className="muted">{t('沒有進度資訊：agent 登記時沒有給輸出檔或日誌。', 'No progress information: the agent registered no output file or log.')}</span>
            </Row>
          )}
          {d.watchFile && (
            <Row label={t('已寫入', 'Written')}>
              {bytes(d.bytes)}
              {d.expectedBytes ? ` / ${bytes(d.expectedBytes)}` : ''}
              {d.speed !== undefined && d.alive ? ` · ${bytes(d.speed)}/s` : ''}
              {d.etaSec !== undefined && d.alive ? ` · ${t('約剩', 'about')} ${duration(d.etaSec)}${t('', ' left')}` : ''}
            </Row>
          )}
          {d.memMB !== undefined && <Row label={t('記憶體', 'Memory')}>{bytes(d.memMB * 1024 ** 2)}</Row>}
          {d.note && (
            <Row label={t('agent 回報', 'Agent says')}>
              {d.note}
              {d.reportedAt ? <span className="muted"> · {elapsed(d.reportedAt)}{t('前', ' ago')}</span> : null}
            </Row>
          )}
          <Row label={t('負責', 'Owner')}>
            {owner ? `${providerName(providers, owner.provider)} · ${roleLabel(t, owner.role)}` : '—'} ·{' '}
            {{ aivenue: t('工作流結束時由 Aivenue 停止', 'Aivenue stops it when the workflow ends'), agent: t('由啟動它的 agent 停止', 'the agent that started it stops it'), keep: t('保留執行', 'keeps running') }[d.cleanup]}
          </Row>
          {d.watchFile && <Row label={t('輸出', 'Output')}><span className="mono small">{d.watchFile}</span></Row>}
          {d.log && (
            <>
              <div className="dw-section">
                {t('日誌（最後幾行）', 'Log (last lines)')} <span className="mono tiny muted">{d.log}</span>
              </div>
              <pre className="dw-log">{d.logTail?.length ? d.logTail.join('\n') : t('（還沒有內容）', '(nothing yet)')}</pre>
            </>
          )}
          <div className="muted tiny">{t('每 3 秒更新', 'Updates every 3 seconds')}</div>
        </>
      )}
    </Window>
  );
}
