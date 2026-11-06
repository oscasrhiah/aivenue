import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { MemoryKind, MemoryMode, RunMemoryView, WorkflowRun } from '../../../core/src/types';
import { hub } from '../api';
import { useT, type T } from '../i18n';
import { cx } from '../util';

export const KIND_LABEL = (t: T, k?: MemoryKind) =>
  k
    ? {
        instruction: t('指示', 'Instruction'),
        fact: t('事實', 'Fact'),
        decision: t('決定', 'Decision'),
        practice: t('做法', 'Practice'),
        pitfall: t('地雷', 'Pitfall'),
      }[k]
    : '';

export const STATE_LABEL = (t: T, s?: string) =>
  s === 'verified' ? t('已驗證', 'Verified') : s === 'needs_recheck' ? t('待重驗', 'Re-check') : s === 'unverified' ? t('未自動驗證', 'Unchecked') : '';

export const STATE_CLASS = (s?: string) => (s === 'verified' ? 'ok' : s === 'needs_recheck' ? 'warn' : undefined);

/** "Remember this": the user's own choice, so it is in force at once (it can be edited or deleted on the memory page). */
export function RememberButton({ runId, text, noteId, ts, className }: { runId: string; text: string; noteId?: string; ts?: number; className?: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(text);
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();
  // One request per save: pressing Save again after an error retries the same text as the same request; editing
  // the text makes it a new one.
  const [request, setRequest] = useState<{ id: string; at: number; text: string }>();
  const save = async () => {
    setState('busy');
    setError(undefined);
    const req = request && request.text === value ? request : { id: crypto.randomUUID(), at: Date.now(), text: value };
    setRequest(req);
    try {
      const r = await hub.call<{ status: 'added' | 'merged' | 'held' | 'rejected'; message: string }>('workflows.remember', { id: runId, text: value, noteId, ts, request: { id: req.id, at: req.at } });
      setRequest(undefined);
      // Only what really went in counts as remembered; otherwise say why and keep the box open.
      if (r.status === 'held' || r.status === 'rejected') {
        setError(r.message);
        setState('idle');
        return;
      }
      setNote(r.status === 'merged' ? r.message : undefined);
      setState('done');
      setTimeout(() => setOpen(false), r.status === 'merged' ? 2500 : 900);
    } catch (e) {
      setError((e as Error).message);
      setState('idle');
    }
  };
  return (
    <>
      <button
        className={cx('link tiny remember-btn', className)}
        title={t('把這段存成專案記憶：之後在這個專案的工作流都會帶入', 'Save this as project memory: later workflows in this project get it')}
        onClick={(e) => {
          e.stopPropagation();
          setValue(text);
          setState('idle');
          setNote(undefined);
          setError(undefined);
          setOpen(true);
        }}
      >
        🧠 {t('記住', 'Remember')}
      </button>
      {open &&
        createPortal(
        <div className="modal-back" onClick={() => setOpen(false)}>
          <div className="modal small-modal" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h3>{t('記住這件事', 'Remember this')}</h3>
            <p className="muted small">
              {t(
                '存成這個專案的「指示」記憶，立刻生效：之後的工作流會把它當參考資料帶給 agent（不是命令，當次的指示優先）。可以先修改文字，存好後也能在「設定 → 記憶」編輯或刪除。',
                "Saved as an instruction in this project's memory, in force at once: later workflows give it to agents as reference material (not a command; that run's own instructions come first). Edit the text first if you like; you can edit or delete it later in Settings → Memory.",
              )}
            </p>
            <textarea value={value} rows={Math.min(10, Math.max(3, value.split('\n').length + 1))} onChange={(e) => setValue(e.target.value)} autoFocus />
            {error && <div className="err-text small">{error}</div>}
            {note && <div className="muted small">{note}</div>}
            <div className="wf-modal-foot">
              <button className="btn" onClick={() => setOpen(false)}>
                {t('取消', 'Cancel')}
              </button>
              <button className="btn primary" disabled={!value.trim() || state !== 'idle'} onClick={() => void save()}>
                {state === 'done' ? t('已記住 ✓', 'Remembered ✓') : state === 'busy' ? t('儲存中…', 'Saving…') : t('記住', 'Remember')}
              </button>
            </div>
          </div>
        </div>,
          document.body,
        )}
    </>
  );
}

const MODES: { id: MemoryMode; zh: string; en: string; tipZh: string; tipEn: string }[] = [
  { id: 'full', zh: '完整', en: 'Full', tipZh: '帶入記憶，並把這次的候選寫進記憶', tipEn: 'Gives agents the memory and writes this run’s candidates' },
  { id: 'readonly', zh: '只讀', en: 'Read only', tipZh: '只帶入記憶，不寫入任何東西', tipEn: 'Gives agents the memory, writes nothing' },
  { id: 'off', zh: '完全不用', en: 'Off', tipZh: '不帶入也不寫入記憶（專案 Skill 照常載入）', tipEn: 'Neither reads nor writes the memory (project Skills still load)' },
];

/** A workflow's use of the project memory: its mode, what it picked, what each agent got, what was left out. */
export function RunMemoryWindow({ run, onClose }: { run: WorkflowRun; onClose: () => void }) {
  const t = useT();
  const [view, setView] = useState<RunMemoryView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const load = () =>
    hub
      .call<RunMemoryView>('workflows.memory', { id: run.id })
      .then(setView)
      .catch((e) => setError((e as Error).message));
  useEffect(() => {
    void load();
  }, [run.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const setMode = async (mode: MemoryMode) => {
    setBusy(true);
    setError(undefined);
    try {
      await hub.call('workflows.setMemoryMode', { id: run.id, mode });
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const running = ['running', 'paused', 'waiting_human'].includes(run.status);
  const textOf = (id: string) => view?.picks.find((p) => p.memoryId === id)?.text ?? id;
  // On the body: an ancestor of the ⋯ menu would otherwise confine a fixed overlay to the header.
  return createPortal(
    <div className="modal-back" onClick={onClose}>
      <div className="modal wf-modal mem-window" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head wf-modal-head">
          <h3>{t('專案記憶', 'Project memory')}</h3>
          <button className="icon-btn" onClick={onClose} aria-label="close">
            ✕
          </button>
        </div>
        <div className="mem-body">
          <section className="mem-section">
            <div className="mem-row">
              <b>{t('記憶模式', 'Memory mode')}</b>
              <div className="seg" role="radiogroup">
                {MODES.map((m) => (
                  <button key={m.id} className={cx(view?.mode === m.id && 'on')} disabled={busy || !running} title={t(m.tipZh, m.tipEn)} onClick={() => void setMode(m.id)}>
                    {t(m.zh, m.en)}
                  </button>
                ))}
              </div>
            </div>
            <p className="muted small">
              {view && t(MODES.find((m) => m.id === view.mode)!.tipZh, MODES.find((m) => m.id === view.mode)!.tipEn)}
              {running
                ? t('。切換只影響之後開始的對話；已經給 agent 的記憶收不回來。', '. Switching affects only conversations that start later; what agents were already given stays given.')
                : t('。工作流已結束，模式不能再改。', '. The workflow has ended; the mode can no longer change.')}
            </p>
            {(error || view?.error) && <div className="err-text small">{error ?? view?.error}</div>}
          </section>

          <section className="mem-section">
            <b>{t(`這次選用的記憶（${view?.picks.length ?? 0}）`, `Memories picked for this run (${view?.picks.length ?? 0})`)}</b>
            {!view?.picks.length && <p className="muted small">{view?.projectId ? t('這個專案還沒有可用的記憶。', 'This project has no usable memories yet.') : t('這個工作流沒有使用專案記憶。', 'This workflow does not use the project memory.')}</p>}
            <ul className="mem-list">
              {view?.picks.map((p) => (
                <li key={p.memoryId} className={cx(p.gone && 'gone')}>
                  {p.gone ? (
                    <span className="muted">{t('（開始後已被刪除、封存或取代）', '(deleted, archived or superseded since the run started)')}</span>
                  ) : (
                    <>
                      <span className="pill">{KIND_LABEL(t, p.kind)}</span>
                      <span className={cx('badge', STATE_CLASS(p.state))}>{STATE_LABEL(t, p.state)}</span>
                      {p.updated && <span className="badge warn">{t('使用者已更新', 'updated by you')}</span>}
                      <span className="mem-text">{p.text}</span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </section>

          {!!view?.given.length && (
            <section className="mem-section">
              <b>{t('各 agent 收到的記憶', 'What each agent got')}</b>
              <ul className="mem-list">
                {view.given.map((g) => (
                  <li key={g.agentId}>
                    <span className="mem-agent">{g.label}</span>
                    <span className="muted small"> · {t(`${g.memoryIds.length} 條`, `${g.memoryIds.length}`)}：</span>
                    <span className="small">{g.memoryIds.map(textOf).map((x) => (x.length > 40 ? `${x.slice(0, 40)}…` : x)).join('；')}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {!!view?.leftOut.length && (
            <section className="mem-section">
              <b>{t('最近一次沒有帶入的', 'Left out last time')}</b>
              <ul className="mem-list">
                {view.leftOut.map((x) => (
                  <li key={x.memoryId}>
                    <span className="badge warn">{x.reason === 'over the budget' ? t('超過預算', 'over the budget') : x.reason === 'for another environment' ? t('其他環境', 'other environment') : t('已撤回', 'withdrawn')}</span>
                    <span className="mem-text">{x.text ?? x.memoryId}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="mem-section">
            <div className="mem-row small">
              <span>
                {t('累計注入 token 估算', 'Injected tokens (estimate)')}：<b>{view?.injectedTokens ?? 0}</b>
              </span>
              <span>
                {t('這次排入的候選', 'Candidates queued')}：<b>{view?.queued ?? 0}</b>
              </span>
            </div>
            <p className="muted tiny">
              {t(
                '估算值：只加總每次放進 prompt 的記憶文字。記憶進入對話後，後續回合可能再次計入輸入，也可能命中快取，實際用量以供應商回報為準。',
                "An estimate: the memory text put into each prompt, added up. Once in a conversation it may count again in later turns, or hit the cache; the provider's own figures are what was actually used.",
              )}
            </p>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  );
}
