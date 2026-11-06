import { useEffect, useMemo, useState } from 'react';
import type { MemoryProjectInfo, MemoryView } from '../../../core/src/types';
import { hub } from '../api';
import { useT } from '../i18n';
import { cx } from '../util';
import { ask } from '../components/Ask';
import { KIND_LABEL, STATE_CLASS, STATE_LABEL } from '../components/Memory';

type Filter = 'candidate' | 'active' | 'recheck' | 'past';

/** The last two folders of a path (the full one is in the tooltip). */
const shortPath = (p: string) => {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : p;
};

const WHY = (t: ReturnType<typeof useT>, why?: string) =>
  why === 'changed'
    ? t('依據的檔案改過了', 'its files changed')
    : why === 'failed'
      ? t('上次檢查失敗', 'its last check failed')
      : why === 'edited'
        ? t('檢查後內容被編輯過', 'edited after it was checked')
        : why === 'incomplete'
          ? t('依據無法完整掃描，新鮮度未知', 'its basis could not be fully scanned')
          : '';

/** One memory: what it says, how far it holds in each checkout, where it came from, and what the user can do with it. */
function MemoryCard({ m, projectId, onChanged }: { m: MemoryView; projectId: string; onChanged: () => void }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({ text: m.text, conditions: m.conditions ?? '', environment: m.environment ?? '', check: m.check?.command ?? '' });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const update = (patch: Record<string, unknown>) => act(() => hub.call('memory.update', { projectId, id: m.id, patch, version: m.version }));
  const save = () =>
    act(async () => {
      // An emptied field is sent as null, which clears it (undefined would vanish on the way and change nothing).
      const check = draft.check.trim() ? { command: draft.check.trim(), expectExit: m.check?.expectExit ?? 0 } : null;
      await hub.call('memory.update', { projectId, id: m.id, version: m.version, patch: { text: draft.text, conditions: draft.conditions.trim() || null, environment: draft.environment.trim() || null, check } });
      setEditing(false);
    });
  const remove = async () => {
    const ok = await ask(
      t(
        '永久刪除這條記憶？之後的工作流不會再帶入它，原本的來源也不會再把同樣的內容擷取回來。\n\n注意：它出自的工作流紀錄（對話、筆記）不會被刪除，仍可在那個工作流裡看到；要一併刪除，請到那個工作流刪除整個工作流。',
        'Delete this memory for good? Later workflows no longer get it, and its sources will not bring the same content back.\n\nNote: the records of the workflows it came from (conversation, notes) are not deleted and can still be seen there; to remove those too, delete those workflows.',
      ),
      { ok: t('刪除', 'Delete'), danger: true },
    );
    if (ok) await act(() => hub.call('memory.delete', { projectId, id: m.id }));
  };
  const workflows = [...new Set(m.sources.map((s) => s.workflowId.replace(/^ui:/, '')))];
  return (
    <div className={cx('mem-card', m.lifecycle)}>
      <div className="mem-card-head">
        <span className="pill">{KIND_LABEL(t, m.kind)}</span>
        {m.lifecycle === 'candidate' && <span className="badge warn">{t('候選：核准後才帶入', 'Candidate: given to agents once approved')}</span>}
        {m.lifecycle === 'superseded' && <span className="badge">{t('已被取代', 'Superseded')}</span>}
        {m.lifecycle === 'archived' && <span className="badge">{t('已封存', 'Archived')}</span>}
        {m.locked && <span className="badge">🔒 {t('已鎖定', 'Locked')}</span>}
        {m.suspectSecret && <span className="badge warn">{t('可能含機密，請檢查', 'May contain a secret: check it')}</span>}
        {m.approvedBy === 'user' && <span className="badge muted">{t('你核准的', 'approved by you')}</span>}
      </div>
      {editing ? (
        <div className="mem-edit">
          <label className="small">{t('內容', 'Text')}</label>
          <textarea value={draft.text} rows={3} onChange={(e) => setDraft({ ...draft, text: e.target.value })} />
          <label className="small">{t('適用條件（什麼情況下）', 'When it applies')}</label>
          <input value={draft.conditions} onChange={(e) => setDraft({ ...draft, conditions: e.target.value })} />
          <label className="small">{t('環境（例如 Windows、Node 22）', 'Environment (e.g. Windows, Node 22)')}</label>
          <input value={draft.environment} onChange={(e) => setDraft({ ...draft, environment: e.target.value })} />
          <label className="small">{t('驗證指令（結束碼 0 代表仍成立；留空表示沒有）', 'Check command (exit 0 means it still holds; empty for none)')}</label>
          <input value={draft.check} onChange={(e) => setDraft({ ...draft, check: e.target.value })} className="mono" />
          <div className="row gap">
            <button className="btn" onClick={() => setEditing(false)}>
              {t('取消', 'Cancel')}
            </button>
            <button className="btn primary" disabled={busy || !draft.text.trim()} onClick={() => void save()}>
              {t('儲存', 'Save')}
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="mem-text">{m.text}</div>
          {(m.conditions || m.environment || m.check) && (
            <div className="muted small mem-meta">
              {m.conditions && <span>{t('條件', 'When')}：{m.conditions}</span>}
              {m.environment && <span>{t('環境', 'Environment')}：{m.environment}</span>}
              {m.check && (
                <span>
                  {t('驗證指令', 'Check')}：<code>{m.check.command}</code>
                </span>
              )}
            </div>
          )}
        </>
      )}
      {!!m.states.length && (
        <div className="mem-states">
          {m.states.map((s) => (
            <div key={s.checkoutId} className="small" title={s.root}>
              <span className={cx('badge', STATE_CLASS(s.state))}>{STATE_LABEL(t, s.state)}</span> <span className="muted mono">{shortPath(s.root)}</span>
              {s.why && <span className="muted"> · {WHY(t, s.why)}</span>}
              {s.lastVerifiedAt && <span className="muted"> · {t('最後通過', 'last passed')} {new Date(s.lastVerifiedAt).toLocaleString()}</span>}
            </div>
          ))}
        </div>
      )}
      <details className="mem-sources small">
        <summary className="muted">
          {t(`來源 ${m.sources.length} · 證據 ${m.evidence.length} · 帶入 ${m.injectedCount} 次`, `${m.sources.length} source(s) · ${m.evidence.length} evidence · given ${m.injectedCount} time(s)`)}
        </summary>
        <ul>
          {m.sources.map((s, i) => (
            <li key={i}>
              {new Date(s.ts).toLocaleString()} · {s.by ?? ''} · <a href={`#/run/${s.workflowId.replace(/^ui:/, '')}`}>{t('開啟工作流', 'Open workflow')}</a>
            </li>
          ))}
          {m.evidence.map((e) => (
            <li key={e.eventRef} className="muted">
              {e.kind}：{e.summary}
              {e.files?.length ? ` (${e.files.map((f) => f.path).join(', ')})` : ''}
            </li>
          ))}
        </ul>
      </details>
      {error && <div className="err-text small">{error}</div>}
      {!editing && (
        <div className="row gap wrap mem-actions">
          {m.lifecycle === 'candidate' && (
            <button className="btn primary small" disabled={busy} onClick={() => void update({ lifecycle: 'active', approvedBy: 'user' })}>
              {t('核准', 'Approve')}
            </button>
          )}
          <button className="btn small" disabled={busy} onClick={() => (setDraft({ text: m.text, conditions: m.conditions ?? '', environment: m.environment ?? '', check: m.check?.command ?? '' }), setEditing(true))}>
            {t('編輯', 'Edit')}
          </button>
          <button className="btn small" disabled={busy} onClick={() => void update({ locked: !m.locked })} title={t('鎖定後，自動操作不會改它，同內容的新候選也不會併進來', 'Locked: automatic changes leave it alone and new candidates with the same text wait')}>
            {m.locked ? t('解鎖', 'Unlock') : t('鎖定', 'Lock')}
          </button>
          {m.lifecycle === 'active' || m.lifecycle === 'candidate' ? (
            <button className="btn small" disabled={busy} onClick={() => void update({ lifecycle: 'archived' })} title={t('不再帶入，但保留可查', 'No longer given to agents, kept for reference')}>
              {t('封存', 'Archive')}
            </button>
          ) : (
            <button className="btn small" disabled={busy} onClick={() => void update({ lifecycle: 'active', approvedBy: 'user' })}>
              {t('恢復為有效', 'Make active again')}
            </button>
          )}
          <button className="btn small danger" disabled={busy} onClick={() => void remove()}>
            {t('刪除', 'Delete')}
          </button>
          {workflows.length > 0 && <span className="muted tiny">{t(`出自 ${workflows.length} 個工作流`, `from ${workflows.length} workflow(s)`)}</span>}
        </div>
      )}
    </div>
  );
}

export function MemoryPane() {
  const t = useT();
  const [projects, setProjects] = useState<MemoryProjectInfo[]>();
  const [projectId, setProjectId] = useState<string>();
  const [items, setItems] = useState<MemoryView[]>();
  const [filter, setFilter] = useState<Filter>('candidate');
  const [error, setError] = useState<string>();
  const loadProjects = () =>
    hub
      .call<MemoryProjectInfo[]>('memory.projects')
      .then((list) => {
        setProjects(list);
        setProjectId((cur) => (cur && list.some((p) => p.id === cur) ? cur : list[0]?.id));
      })
      .catch((e) => setError((e as Error).message));
  const loadItems = (id = projectId) =>
    id
      ? hub
          .call<MemoryView[]>('memory.list', { projectId: id })
          .then(setItems)
          .catch((e) => setError((e as Error).message))
      : Promise.resolve(setItems([]));
  useEffect(() => {
    void loadProjects();
  }, []);
  useEffect(() => {
    void loadItems();
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  const recheck = (m: MemoryView) => m.lifecycle === 'active' && m.states.some((s) => s.state === 'needs_recheck');
  const groups = useMemo(() => {
    const list = items ?? [];
    return {
      candidate: list.filter((m) => m.lifecycle === 'candidate'),
      active: list.filter((m) => m.lifecycle === 'active'),
      recheck: list.filter(recheck),
      past: list.filter((m) => m.lifecycle === 'superseded' || m.lifecycle === 'archived'),
    };
  }, [items]);
  const shown = [...groups[filter]].sort((a, b) => b.updatedAt - a.updatedAt);
  const project = projects?.find((p) => p.id === projectId);
  const relink = async () => {
    const folder = await hub.call<string | null>('host.pickFolder').catch(() => null);
    if (!folder || !projectId) return;
    try {
      await hub.call('memory.relink', { projectId, cwd: folder });
      await loadProjects();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const tabs: { id: Filter; label: string }[] = [
    { id: 'candidate', label: t(`候選（${groups.candidate.length}）`, `Candidates (${groups.candidate.length})`) },
    { id: 'active', label: t(`有效（${groups.active.length}）`, `Active (${groups.active.length})`) },
    { id: 'recheck', label: t(`需要重驗（${groups.recheck.length}）`, `Re-check (${groups.recheck.length})`) },
    { id: 'past', label: t(`已取代／封存（${groups.past.length}）`, `Superseded / archived (${groups.past.length})`) },
  ];
  return (
    <div className="pane">
      <div className="pane-head">
        <div>
          <h2>{t('記憶', 'Memory')}</h2>
          <p className="muted">
            {t(
              '過去的工作流為每個專案留下的記憶。「有效」的會依角色帶給之後的 agent，當作參考資料；「候選」要你核准才會帶入。遮蔽只能辨識已知格式的金鑰，請檢查候選是否含機密。',
              "What earlier workflows left for each project. Active memories go to later agents by role, as reference material; candidates go only once you approve them. Masking only catches known key formats: check candidates for secrets.",
            )}
          </p>
        </div>
      </div>
      {error && <div className="err-text small">{error}</div>}
      {projects && !projects.length && <p className="muted">{t('還沒有任何專案的記憶。在工作流的訊息裡寫「記住：…」，或按訊息旁的「記住」，就會開始累積。', 'No project has memories yet. Write "remember: …" in a message, or use Remember next to a message, to start.')}</p>}
      {!!projects?.length && (
        <section className="cap">
          <div className="mem-row">
            <label className="small">{t('專案', 'Project')}</label>
            <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label} — {t(`有效 ${p.counts.active}、候選 ${p.counts.candidate}`, `${p.counts.active} active, ${p.counts.candidate} candidates`)}
                </option>
              ))}
            </select>
            <button className="btn small" onClick={() => void relink()} title={t('專案搬到別的資料夾後，選新位置，保留原本的記憶', 'The project moved: pick its new folder to keep its memory')}>
              {t('重新連結資料夾…', 'Relink folder…')}
            </button>
          </div>
          {project && (
            <div className="muted tiny mono" title={project.key}>
              {project.kind === 'git' ? t('Git 儲存庫', 'Git repository') : t('資料夾', 'Folder')}：{shortPath(project.key)}
            </div>
          )}
          <div className="seg">
            {tabs.map((x) => (
              <button key={x.id} className={cx(filter === x.id && 'on')} onClick={() => setFilter(x.id)}>
                {x.label}
              </button>
            ))}
          </div>
          {!shown.length && <p className="muted small">{t('這一類目前沒有記憶。', 'Nothing here right now.')}</p>}
          <div className="mem-cards">
            {shown.map((m) => (
              <MemoryCard key={m.id} m={m} projectId={projectId!} onChanged={() => void Promise.all([loadItems(), loadProjects()])} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
