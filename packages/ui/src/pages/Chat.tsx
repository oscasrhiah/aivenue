import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AdvisorConfig, AgentRunInfo, AssignmentResult, Attachment, HumanDecision, PermissionLevel, ProviderInfo, WorkflowConfig, WorkflowRun } from '../../../core/src/types';
import { fileUrl, hub, useHostInfo, useProviders, useWorkflow } from '../api';
import { readability, type Reason } from '../../../core/src/readability';
import { navigate } from '../App';
import { AgentMap } from '../components/AgentMap';
import { DeniedActions } from '../components/DeniedActions';
import { AgentTurn } from '../components/AgentTurn';
import { Outputs } from '../components/Outputs';
import { Approvals, FullAccessBanner, OutsideChanges, WorktreeCard } from '../components/Safety';
import { ContextAsk, ContextPie } from '../components/ContextPie';
import { ProgressPanel } from '../components/Progress';
import { defaultDraft, isAuto, RolePills, RoleSettings, useAssignPreview, type RoleDraft } from '../components/RoleSettings';
import { saveSettings, useAppSettings, useT } from '../i18n';
import { cx, elapsed, modelLabel, providerName, wfStatus } from '../util';
import { Markdown } from '../components/Markdown';

type Item = { ts: number; key: string } & ({ type: 'user'; text: string } | { type: 'agent'; agent: AgentRunInfo } | { type: 'divider'; text: string; level: string });

function timeline(run: WorkflowRun): Item[] {
  // A follow-up's goal carries the earlier task as context; show only what the user wrote.
  const items: Item[] = [{ type: 'user', text: run.config.goal.replace(/\n\n\(Context: this continues[\s\S]*$/, ''), ts: run.createdAt, key: 'goal' }];
  for (const a of Object.values(run.agents)) if (!a.parentId) items.push({ type: 'agent', agent: a, ts: a.startedAt ?? run.updatedAt, key: a.id });
  run.log.forEach((l, i) => {
    if (l.chat) items.push({ type: 'divider', text: l.text, level: l.level, ts: l.ts, key: `log${i}` });
  });
  const order = new Map(items.map((it, i) => [it.key, i]));
  return items.sort((a, b) => a.ts - b.ts || (a.type === b.type ? order.get(a.key)! - order.get(b.key)! : a.type === 'divider' ? -1 : 1));
}

function Decision({ run, d }: { run: WorkflowRun; d: HumanDecision }) {
  const t = useT();
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const choose = (optionId: string) => hub.call('workflows.decide', { id: run.id, decisionId: d.id, optionId, text }).catch((e) => setError(e.message));
  return (
    <div className="decision">
      <div className="decision-q">{d.message}</div>
      {d.allowText && <textarea rows={2} placeholder={t('（選填）給 agent 的意見…', '(Optional) a note for the agent…')} value={text} onChange={(e) => setText(e.target.value)} />}
      <div className="row gap wrap">
        {d.options.map((o, i) => (
          <button key={o.id} className={cx('btn', i === 0 && 'primary', o.id === 'abort' && 'danger')} onClick={() => choose(o.id)}>
            {o.label}
          </button>
        ))}
      </div>
      {error && <div className="note err">{error}</div>}
    </div>
  );
}

function missingProviders(cfg: RoleDraft, providers: ProviderInfo[]): string[] {
  const used = new Set<string>();
  for (const s of [cfg.plan, cfg.implement]) {
    if (!s.enabled) continue;
    used.add(s.author.provider);
    if (s.reviewer) used.add(s.reviewer.provider);
  }
  return [...used].filter((id) => providers.find((p) => p.spec.id === id)?.auth.state !== 'logged_in').map((id) => providerName(providers, id));
}

type Pending = { key: string; name: string; size: number; status: 'uploading' | 'ready' | 'error'; att?: Attachment; preview?: string; error?: string };

const fmtSize = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const isImg = (name: string) => /\.(png|jpe?g|gif|webp|bmp)$/i.test(name);

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export function AttachmentChip({ name, size, src, status, error, onRemove, onOpen, icon }: { name: string; size: number; src?: string; status?: Pending['status']; error?: string; onRemove?: () => void; onOpen?: () => void; icon?: string }) {
  return (
    <div className={cx('att', status === 'error' && 'bad')} title={error ?? name}>
      {src && isImg(name) ? <img src={src} alt="" onClick={onOpen} /> : <span className="att-icon">{icon ?? '📄'}</span>}
      <span className="att-meta">
        <span className="att-name">{name}</span>
        <span className="att-size">{status === 'uploading' ? '…' : status === 'error' ? '✕' : fmtSize(size)}</span>
      </span>
      {onRemove && (
        <button className="att-x" onClick={onRemove} aria-label="remove">
          ✕
        </button>
      )}
    </div>
  );
}

const reasonText = (t: ReturnType<typeof useT>, r: Reason) =>
  ({
    'no-vision': t('不支援圖片', 'cannot view images'),
    'image-format': t('不支援此圖片格式，請轉成 PNG/JPG', 'image format not supported; use PNG/JPG'),
    'legacy-office': t('舊版 Office 格式，請另存為 docx/xlsx/pptx 或 PDF', 'old Office format; save as docx/xlsx/pptx or PDF'),
    'no-audio': t('不支援音訊', 'cannot process audio'),
    'no-video': t('不支援影片', 'cannot process video'),
    binary: t('二進位檔，沒有可讀內容', 'binary file, nothing readable'),
    'scanned-pdf': t('掃描版 PDF 且不支援圖片', 'scanned PDF and no image support'),
  })[r];

/** Which of the chosen agents cannot read which attachment. */
function compatWarnings(t: ReturnType<typeof useT>, files: Attachment[], providerIds: string[], providers: ProviderInfo[]): string[] {
  const out: string[] = [];
  for (const a of files) {
    for (const id of [...new Set(providerIds)]) {
      const p = providers.find((x) => x.spec.id === id);
      const r = readability(a, p?.spec.profile);
      if (!r.ok) out.push(t(`${p?.spec.name ?? id} 無法讀取 ${a.name}（${reasonText(t, r.reason!)}）`, `${p?.spec.name ?? id} cannot read ${a.name} (${reasonText(t, r.reason!)})`));
    }
  }
  return out;
}

const KIND_ICON: Record<string, string> = { image: '🖼', 'image-other': '🖼', pdf: '📕', office: '📊', 'legacy-office': '📄', notebook: '📓', archive: '🗜', audio: '🎵', video: '🎬', text: '📄', binary: '📦' };

function Composer({
  draft,
  providers,
  disabled,
  placeholder,
  onSend,
  onOpenRoles,
  busy,
  canPickFiles,
  preview,
  roleProviders,
  compact,
  onSafety,
  onAdvisor,
  runState,
  onPause,
  onResume,
  extra,
}: {
  draft: RoleDraft;
  providers: ProviderInfo[];
  disabled: boolean;
  placeholder: string;
  onSend: (text: string, attachments: Attachment[]) => Promise<boolean>;
  onOpenRoles: () => void;
  busy: boolean;
  canPickFiles: boolean;
  preview?: AssignmentResult;
  roleProviders: string[];
  compact?: boolean;
  onSafety?: (v: { permission?: PermissionLevel; isolation?: boolean }) => void;
  onAdvisor?: (v: AdvisorConfig) => void;
  /** The send button becomes pause while agents work, and resume while paused. */
  runState?: 'running' | 'paused';
  /** Shown after the role pills (the shared-context pie). */
  extra?: ReactNode;
  onPause?: () => void;
  /** Resume; what the user typed meanwhile is passed to the agents. */
  onResume?: (note: string) => void;
}) {
  const t = useT();
  const [text, setText] = useState('');
  const [files, setFiles] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const input = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 320) + 'px';
    el.classList.toggle('scroll', el.scrollHeight > 320);
  }, [text]);

  const update = (key: string, patch: Partial<Pending>) => setFiles((cur) => cur.map((f) => (f.key === key ? { ...f, ...patch } : f)));
  const addFiles = (list: FileList | File[]) => {
    for (const file of Array.from(list)) {
      const key = Math.random().toString(36).slice(2);
      const name = file.name || `pasted-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}.png`;
      const preview = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
      setFiles((cur) => [...cur, { key, name, size: file.size, status: 'uploading', preview }]);
      readBase64(file)
        .then((data) => hub.call<Attachment>('attachments.upload', { name, mime: file.type, data }))
        .then((att) => update(key, { status: 'ready', att, name: att.name }))
        .catch((e) => update(key, { status: 'error', error: e.message }));
    }
  };
  const pick = async () => {
    if (!canPickFiles) return input.current?.click();
    const atts = await hub.call<Attachment[]>('attachments.pick').catch(() => []);
    setFiles((cur) => [...cur, ...atts.map((att) => ({ key: Math.random().toString(36).slice(2), name: att.name, size: att.size, status: 'ready' as const, att }))]);
  };
  const remove = (f: Pending) => {
    if (f.att) void hub.call('attachments.discard', { attachment: f.att });
    if (f.preview) URL.revokeObjectURL(f.preview);
    setFiles((cur) => cur.filter((x) => x.key !== f.key));
  };

  const uploading = files.some((f) => f.status === 'uploading');
  const send = async () => {
    if (!text.trim() || disabled || busy || uploading) return;
    const ready = files.filter((f) => f.status === 'ready' && f.att).map((f) => f.att!);
    if (await onSend(text.trim(), ready)) {
      files.forEach((f) => f.preview && URL.revokeObjectURL(f.preview));
      setText('');
      setFiles([]);
    }
  };

  return (
    <div
      className={cx('composer', disabled && 'disabled', dragging && 'drop')}
      onDragOver={(e) => {
        if (disabled || !e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        if (!disabled && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
      }}
    >
      {dragging && <div className="drop-hint">{t('放開以附加檔案', 'Drop to attach')}</div>}
      {files.length > 0 && (
        <div className="atts">
          {files.map((f) => (
            <AttachmentChip key={f.key} name={f.name} size={f.size} status={f.status} error={f.error} icon={f.att?.kind && KIND_ICON[f.att.kind]} src={f.preview ?? (f.att ? fileUrl(f.att.path) : undefined)} onRemove={() => remove(f)} />
          ))}
        </div>
      )}
      {(() => {
        const warn = compatWarnings(t, files.filter((f) => f.att).map((f) => f.att!), roleProviders, providers);
        return warn.length ? (
          <div className="att-warn">
            {warn.map((w, i) => (
              <div key={i}>⚠ {w}</div>
            ))}
            <div className="muted">{t('這些 agent 會在回覆中說明讀不到哪些檔案，不會猜測內容。', 'These agents will say which files they could not read instead of guessing.')}</div>
          </div>
        ) : null;
      })()}
      <textarea
        ref={ref}
        rows={1}
        disabled={disabled}
        placeholder={placeholder}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onPaste={(e) => {
          if (e.clipboardData.files.length) {
            e.preventDefault();
            addFiles(e.clipboardData.files);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault();
            void send();
          }
        }}
      />
      <div className="composer-bar">
        <button className="clip" disabled={disabled} onClick={pick} title={t('附加圖片或檔案（也可以拖曳或貼上）', 'Attach images or files (or drag & drop / paste)')}>
          📎
        </button>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) addFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <RolePills draft={draft} providers={providers} onOpen={onOpenRoles} preview={preview} compact={compact} onSafety={onSafety} onAdvisor={onAdvisor} />
        {extra}
        {runState === 'running' ? (
          <button className="send pause" onClick={onPause} title={t('暫停：停下正在工作的 agent，之後可以繼續', 'Pause: stop the working agents; you can resume later')} aria-label={t('暫停', 'Pause')}>
            ❚❚
          </button>
        ) : runState === 'paused' ? (
          <button
            className="send resume"
            onClick={() => {
              onResume?.(text.trim());
              setText('');
            }}
            title={text.trim() ? t('繼續，並把輸入的內容交給 agent', 'Resume and pass what you typed to the agents') : t('繼續', 'Resume')}
            aria-label={t('繼續', 'Resume')}
          >
            ▶
          </button>
        ) : (
          <button className="send" disabled={disabled || busy || uploading || !text.trim()} onClick={send} aria-label={t('送出', 'Send')}>
            ↑
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The user's message, editable: saving stops this workflow if it still runs and re-sends the edited text
 * (same settings) as a new one; this one stays in history, linked to the new version.
 */
function UserMessage({ run, text, active, config }: { run: WorkflowRun; text: string; active: boolean; config: WorkflowConfig }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!editing)
    return (
      <div className="user-msg-wrap">
        <div className="user-msg">{text}</div>
        {!run.replacedBy && (
          <button
            className="link tiny user-edit"
            title={active ? t('編輯後會中止目前的工作流，用新內容重新執行', 'Editing stops the current workflow and runs the new text') : t('編輯並重新送出', 'Edit and re-send')}
            onClick={() => {
              setValue(text);
              setEditing(true);
            }}
          >
            ✏️ {t('編輯', 'Edit')}
          </button>
        )}
      </div>
    );
  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const id = await hub.call<string>('workflows.edit', { id: run.id, goal: value, config });
      navigate(`run/${id}`);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <div className="user-edit-box">
      <textarea
        value={value}
        autoFocus
        rows={Math.min(12, Math.max(3, value.split('\n').length + 1))}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setEditing(false);
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void submit();
        }}
      />
      {active && <div className="note warn small">{t('送出後會立刻中止目前正在執行的 agent，再用新內容重新開始。已經改動的檔案不會自動還原。', 'Sending stops the agents that are working now, then starts over with the new text. Files already changed are not rolled back.')}</div>}
      {error && <div className="note err small">{error}</div>}
      <div className="row gap">
        <span className="grow muted tiny">{t('Ctrl+Enter 送出，Esc 取消', 'Ctrl+Enter to send, Esc to cancel')}</span>
        <button className="btn" disabled={busy} onClick={() => setEditing(false)}>
          {t('取消', 'Cancel')}
        </button>
        <button className="btn primary" disabled={busy || !value.trim() || value.trim() === text.trim()} onClick={() => void submit()}>
          {busy ? t('處理中…', 'Working…') : active ? t('中止並重新執行', 'Stop and re-run') : t('重新送出', 'Re-send')}
        </button>
      </div>
    </div>
  );
}

/**
 * The answer, repeated at the bottom once the workflow is done, so nobody has to scroll back up past
 * the reviews: the last implementer's reply (or the plan when only planning ran) plus the final verdict.
 */
function FinalResult({ run, providers }: { run: WorkflowRun; providers: ProviderInfo[] }) {
  const t = useT();
  if (run.status !== 'completed') return null;
  const main = Object.values(run.agents).filter((a) => a.depth === 0 && a.status === 'completed');
  const last = (role: AgentRunInfo['role']) => main.filter((a) => a.role === role).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0];
  const exec = last('executor');
  const implRound = run.stages.implement.rounds[run.stages.implement.rounds.length - 1];
  const planRound = run.stages.plan.rounds[run.stages.plan.rounds.length - 1];
  const text = exec ? exec.finalText?.trim() || implRound?.submission?.summary : run.plan ? run.plan.markdown?.trim() || run.plan.summary : undefined;
  if (!text) return null;
  const author = exec ?? last('planner');
  const review = (exec ? implRound : planRound)?.review;
  return (
    <div className="final-result">
      <div className="final-head">
        <span className="final-title">{exec ? t('最終結果', 'Final result') : t('最終計畫', 'Final plan')}</span>
        {author && (
          <span className="muted small">
            {providerName(providers, author.provider)}
            {author.model ? ` · ${modelLabel(author.model)}` : ''}
          </span>
        )}
        {review && <span className={cx('pill', review.verdict === 'approve' ? 'ok' : 'warn')}>{review.verdict === 'approve' ? t('審查通過', 'Approved') : t('未通過即結束', 'Ended without approval')}</span>}
      </div>
      <Markdown className="prose" text={text} />
    </div>
  );
}

function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  return (
    <div className="lightbox" onClick={onClose}>
      <img src={src} alt="" />
    </div>
  );
}

export function Chat({ id }: { id?: string }) {
  const t = useT();
  const settings = useAppSettings();
  const providers = useProviders();
  const host = useHostInfo();
  const run = useWorkflow(id);
  const [draft, setDraft] = useState<RoleDraft | null>(null);
  const [rolesOpen, setRolesOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const [lightbox, setLightbox] = useState<string>();
  const [agentMap, setAgentMap] = useState(false);
  const [, tick] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);

  useEffect(() => {
    if (draft || !host || !providers.length) return;
    const d = settings.draft ?? defaultDraft(providers, host.defaultCwd ?? '');
    setDraft(!d.cwd && host.defaultCwd ? { ...d, cwd: host.defaultCwd } : d);
  }, [settings.draft, host, providers.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (run?.status !== 'running' && run?.status !== 'waiting_human') return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [run?.status]);

  const items = useMemo(() => (run ? timeline(run) : []), [run]);
  const preview = useAssignPreview(run ? null : draft, providers);

  useLayoutEffect(() => {
    if (follow.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  });

  const updateDraft = (d: RoleDraft) => {
    setDraft(d);
    // Whole-computer access is for one conversation: the saved default for new ones stays at Full auto.
    void saveSettings({ draft: d.permission === 'full' ? { ...d, permission: 'auto' } : d });
  };

  const active = !!run && (run.status === 'running' || run.status === 'paused' || run.status === 'waiting_human');
  const paused = run?.status === 'paused';
  // In a conversation the settings stay editable: a running workflow takes them from the next agent on,
  // a finished one uses them for the follow-up message.
  const [runDraft, setRunDraft] = useState<RoleDraft | null>(null);
  useEffect(() => setRunDraft(null), [id]);
  const shown: RoleDraft | null = run ? (runDraft ?? run.config) : draft;
  const changeSettings = (d: RoleDraft) => {
    if (!run) return updateDraft(d);
    setRunDraft(d);
    if (active) {
      const { plan, implement, subagents, permission, contextSharing, context, assignment, advisor, extraDirs } = d;
      hub.call('workflows.updateConfig', { id: run.id, patch: { plan, implement, subagents, permission, contextSharing, context, assignment, advisor, extraDirs: extraDirs ?? [] } }).catch((e) => setError((e as Error).message));
    }
  };

  const send = async (goal: string, attachments: Attachment[]): Promise<boolean> => {
    if (!draft) return false;
    setError(undefined);
    let config: WorkflowConfig;
    if (run) {
      const prev = Object.values(run.agents)
        .filter((a) => (a.role === 'executor' || a.role === 'planner') && a.finalText)
        .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0]?.finalText;
      const base = runDraft ?? run.config;
      config = {
        ...base,
        // An isolated run worked in a temporary copy; follow-ups start from the user's project (unless a new folder was picked).
        cwd: runDraft && runDraft.cwd !== run.config.cwd ? runDraft.cwd : (run.worktree?.origCwd ?? run.config.cwd),
        title: goal.split('\n')[0].slice(0, 60),
        goal: `${goal}\n\n(Context: this continues an earlier task in the same folder: "${run.config.goal.slice(0, 800)}". Its outcome: ${(prev ?? run.status).slice(0, 1500)})`,
      };
    } else {
      config = { ...draft, title: goal.split('\n')[0].slice(0, 60), goal };
    }
    // Follow-ups keep the earlier files available (they are copied into the new run).
    config.attachments = [...(run?.config.attachments ?? []), ...attachments];
    if (!config.cwd) {
      setRolesOpen(true);
      setError(t('請先選擇工作資料夾', 'Choose a working folder first'));
      return false;
    }
    setSending(true);
    try {
      const newId = await hub.call<string>('workflows.start', { config });
      follow.current = true;
      // The next new conversation starts at Full auto again; this one keeps whole-computer access in its own config.
      if (draft?.permission === 'full') setDraft({ ...draft, permission: 'auto' });
      navigate(`run/${newId}`);
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setSending(false);
    }
  };

  if (!shown) return <div className="center-fill muted">{t('載入中…', 'Loading…')}</div>;
  // Providers that will see the attachments: auto picks (before the run) or the configured roles.
  const roleProviders = (() => {
    const a = !run && isAuto(shown) ? preview.result : undefined;
    const ids: (string | undefined)[] = [];
    if (shown.plan.enabled) ids.push(a?.plan.author ?? shown.plan.author.provider, shown.plan.reviewer ? a?.plan.reviewer ?? shown.plan.reviewer.provider : undefined);
    if (shown.implement.enabled) ids.push(a?.implement.author ?? shown.implement.author.provider, shown.implement.reviewer ? a?.implement.reviewer ?? shown.implement.reviewer.provider : undefined);
    return ids.filter((x): x is string => !!x);
  })();
  const missing = !run && !isAuto(shown) ? missingProviders(shown, providers) : [];
  const st = run ? wfStatus(t, run.status) : null;

  const composer = (
    <>
      {missing.length > 0 && (
        <div className="note warn">
          {t(`${missing.join('、')} 尚未登入。`, `${missing.join(', ')} not signed in. `)}
          <a href="#/settings/providers">{t('前往登入', 'Sign in')}</a>
        </div>
      )}
      {error && <div className="note err">{error}</div>}
      {!run && preview.error && <div className="note warn">{preview.error}</div>}
      <Composer
        draft={shown}
        providers={providers}
        preview={run ? undefined : preview.result}
        roleProviders={roleProviders}
        canPickFiles={!!host?.canPickFiles}
        busy={sending}
        disabled={active && !paused}
        onSend={send}
        runState={run?.status === 'running' ? 'running' : paused ? 'paused' : undefined}
        onPause={() => run && hub.call('workflows.pause', { id: run.id }).catch((e) => setError((e as Error).message))}
        onResume={(note) => run && hub.call('workflows.resume', { id: run.id, note }).catch((e) => setError((e as Error).message))}
        onOpenRoles={() => setRolesOpen(true)}
        // VS Code keeps the composer minimal: attach, permission, roles.
        compact={host?.host === 'vscode'}
        onAdvisor={(advisor) => changeSettings({ ...shown, advisor })}
        extra={run ? <ContextPie run={run} providers={providers} /> : undefined}
        onSafety={(v) => changeSettings({ ...shown, ...(v.permission ? { permission: v.permission } : {}), ...(v.isolation !== undefined && !active ? { isolation: v.isolation ? 'worktree' : 'none' } : {}) })}
        placeholder={
          active
            ? run!.status === 'waiting_human'
              ? t('請先回應上方的問題', 'Answer the question above first')
              : paused
                ? t('已暫停：可以輸入補充說明，按 ▶ 繼續', 'Paused: type extra guidance if you like, then press ▶ to resume')
                : t('agent 正在工作…（可按 ❚❚ 暫停）', 'Agents are working… (press ❚❚ to pause)')
            : run
              ? t('接著要做什麼？（沿用相同角色與資料夾）', 'What next? (same roles and folder)')
              : t('描述要完成的任務…', 'Describe the task…')
        }
      />
    </>
  );

  return (
    <div className="chat">
      {run && (
        <header className="topbar">
          <div className="topbar-title">
            <span className="title-text">{run.config.title}</span>
            <span className={cx('status', st!.cls)}>
              {(run.status === 'running' || run.status === 'waiting_human') && <span className="pulse" />}
              {st!.label}
            </span>
            <span className="muted small">{elapsed(run.createdAt, run.endedAt)}</span>
          </div>
          <div className="row gap">
            <AgentMapButton run={run} onOpen={() => setAgentMap(true)} />
            <button className="icon-btn" title={t('開啟資料夾', 'Open folder')} onClick={() => hub.call('host.openPath', { path: run.config.cwd })}>
              📁
            </button>
            {active ? (
              <button className="btn small danger" onClick={() => confirm(t('停止這個工作流？正在執行的 agent 會被中止。', 'Stop this workflow? Running agents will be terminated.')) && hub.call('workflows.cancel', { id: run.id })}>
                {t('停止', 'Stop')}
              </button>
            ) : (
              <button className="icon-btn" title={t('刪除對話', 'Delete chat')} onClick={() => confirm(t('刪除這段對話與紀錄？（不會動到專案檔案）', 'Delete this chat and its logs? (project files are not touched)')) && hub.call('workflows.delete', { id: run.id }).then(() => navigate('new'))}>
                🗑
              </button>
            )}
          </div>
        </header>
      )}

      {!run ? (
        <div className="home">
          <h1 className="greet">{t('今天要讓哪些 agent 一起工作？', 'What should your agents work on?')}</h1>
          <div className="home-composer">{composer}</div>
          <div className="home-providers">
            {providers.map((p) => (
              <span key={p.spec.id} className={cx('prov', p.auth.state === 'logged_in' && 'ready')}>
                <span className="mark" style={{ background: p.auth.state === 'logged_in' ? undefined : 'transparent' }} />
                {p.spec.name}
              </span>
            ))}
            <a href="#/settings/providers" className="muted small">
              {t('管理供應商', 'Manage providers')}
            </a>
          </div>
        </div>
      ) : (
        <>
          <div
            className="thread"
            ref={scroller}
            onScroll={() => {
              const el = scroller.current!;
              follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
            }}
          >
            <div className="column">
              <FullAccessBanner run={run} />
              {items.map((it) => {
                if (it.type === 'user')
                  return (
                    <div key={it.key} className="user-block">
                      {!!run.config.attachments?.length && (
                        <div className="atts right">
                          {run.config.attachments.map((a) => (
                            <AttachmentChip key={a.path} name={a.name} size={a.size} src={fileUrl(a.path)} onOpen={() => setLightbox(fileUrl(a.path))} />
                          ))}
                        </div>
                      )}
                      {run.config.replaces && (
                        <div className="muted tiny edit-link">
                          ✏️ {t('這是編輯後重新送出的版本', 'This is the edited, re-sent version')} ·{' '}
                          <a href={`#/run/${run.config.replaces}`}>{t('查看原版本', 'See the original')}</a>
                        </div>
                      )}
                      <UserMessage run={run} text={it.text} active={active} config={runDraft ? { ...run.config, ...runDraft } : run.config} />
                      {run.replacedBy && (
                        <div className="note small edit-link">
                          {t('這則訊息已編輯並重新送出。', 'This message was edited and re-sent.')} <a href={`#/run/${run.replacedBy}`}>{t('前往新版本 →', 'Go to the new version →')}</a>
                        </div>
                      )}
                      {run.assignment && (
                        <details className="assign-card">
                          <summary>✦ {t('自動指派', 'Auto assignment')}</summary>
                          {run.assignment.notes.map((n, i) => (
                            <div key={i}>{n}</div>
                          ))}
                        </details>
                      )}
                    </div>
                  );
                if (it.type === 'divider')
                  return (
                    <div key={it.key} className={cx('divider', it.level)}>
                      <span>{it.text}</span>
                    </div>
                  );
                return <AgentTurn key={it.key} run={run} agent={it.agent} providers={providers} />;
              })}
              <FinalResult run={run} providers={providers} />
              <DeniedActions run={run} providers={providers} />
              <OutsideChanges run={run} />
              <Outputs run={run} onImage={setLightbox} />
              <Approvals run={run} providers={providers} />
              <WorktreeCard run={run} />
              <ContextAsk run={run} providers={providers} />
              {run.pending && <Decision run={run} d={run.pending} />}
              {run.status === 'failed' && run.error && <div className="note err">{run.error}</div>}
              {run.status === 'interrupted' && <div className="note warn">{t('Aivenue 關閉時這個工作流仍在執行，已中斷。可以在下方輸入訊息，用相同設定接續。', 'Aivenue was closed while this workflow ran, so it was interrupted. Send a message below to continue with the same setup.')}</div>}
            </div>
          </div>
          <div className="dock">
            <div className="column">
              <ProgressPanel key={run.id} run={run} providers={providers} />
              {composer}
            </div>
          </div>
        </>
      )}

      {lightbox && <Lightbox src={lightbox} onClose={() => setLightbox(undefined)} />}
      {agentMap && run && <AgentMap run={run} providers={providers} onClose={() => setAgentMap(false)} />}
      {rolesOpen && (
        <RoleSettings
          draft={shown}
          providers={providers}
          lockFolder={active}
          notice={
            active
              ? t('這段對話正在執行：變更會套用到接下來才開始的 agent，正在工作的 agent 不受影響。', 'This conversation is running: changes apply to agents started from now on; agents already working keep theirs.')
              : run
                ? t('變更會套用到你在這段對話接著送出的訊息。', 'Changes apply to the next message you send in this conversation.')
                : undefined
          }
          canPickFolder={!!host?.canPickFolder}
          onChange={changeSettings}
          onClose={() => setRolesOpen(false)}
          onReuse={() => {
            if (run) updateDraft({ ...shown, cwd: run.worktree?.origCwd ?? run.config.cwd });
            setRolesOpen(false);
            navigate('new');
          }}
        />
      )}
    </div>
  );
}

/** Opens the agent map; shown when sub-agents are on or anyone was spawned. Counts helpers and shows a pulse while some run. */
function AgentMapButton({ run, onOpen }: { run: WorkflowRun; onOpen: () => void }) {
  const t = useT();
  const all = Object.values(run.agents);
  const helpers = all.filter((a) => a.role === 'subagent' || a.role === 'advisor');
  if (!run.config.subagents?.enabled && helpers.length === 0) return null;
  const running = helpers.filter((a) => a.status === 'running' || a.status === 'queued').length;
  return (
    <button className="btn small am-open" onClick={onOpen} title={t('查看所有 agent 與 sub agent：誰、用什麼模型、正在做什麼', 'See every agent and sub-agent: who, which model, what it is doing')}>
      {running > 0 && <span className="am-dot live" />}
      Agent map
      {helpers.length > 0 && <span className="muted">· {helpers.length}</span>}
    </button>
  );
}
