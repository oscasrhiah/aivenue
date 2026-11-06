import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AdvisorConfig, AgentRunInfo, AssignmentResult, Attachment, HumanDecision, ModelInfo, PermissionLevel, PreflightItem, ProviderInfo, WorkflowConfig, WorkflowRun } from '../../../core/src/types';
import { fileUrl, hub, useAgentEvents, useHostInfo, useProviders, useThreads, useUsage, useWorkflow, useWorkflows } from '../api';
import { SwitchChoices } from '../components/AccountSwitch';
import { profileForInputs, readability, type Reason } from '../../../core/src/readability';
import { navigate } from '../App';
import { AgentMap } from '../components/AgentMap';
import { DeniedActions } from '../components/DeniedActions';
import { AgentTurn } from '../components/AgentTurn';
import { PreflightList, RunMenu } from '../components/RunTools';
import { Replies, type Reply } from '../components/Replies';
import { Outputs } from '../components/Outputs';
import { Approvals, FullAccessBanner, OutsideChanges, WorktreeCard } from '../components/Safety';
import { CompactFailedAsk, ContextAsk, ContextPie } from '../components/ContextPie';
import { ProgressPanel } from '../components/Progress';
import { defaultDraft, isAuto, RolePills, RoleSettings, useAssignPreview, type RoleDraft } from '../components/RoleSettings';
import { saveSettings, useAppSettings, useT } from '../i18n';
import { draftInit, forNewConversations, type DraftInit } from '../draftInit';
import { followUpGoal } from '../followUp';
import { deliverableRows, verificationScope } from '../timeline';
import { CheckRows } from '../components/Checks';
import { cx, elapsed, modelLabel, providerName, roleLabel, saidOwner, wfStatus } from '../util';
import { Markdown } from '../components/Markdown';
import { ask } from '../components/Ask';
import { RememberButton } from '../components/Memory';

type Item = { ts: number; key: string } & ({ type: 'user'; text: string; midRun?: boolean; files?: Attachment[]; delivered?: number; replies?: Reply[]; planUpdated?: boolean } | { type: 'agent'; agent: AgentRunInfo } | { type: 'divider'; text: string; level: string });

function timeline(run: WorkflowRun): Item[] {
  // A follow-up's goal carries the earlier task as context; show only what the user wrote.
  const items: Item[] = [{ type: 'user', text: run.config.goal.replace(/\n\n\(Context: this continues[\s\S]*$/, ''), ts: run.createdAt, key: 'goal' }];
  for (const a of Object.values(run.agents)) if (!a.parentId) items.push({ type: 'agent', agent: a, ts: a.startedAt ?? run.updatedAt, key: a.id });
  run.log.forEach((l, i) => {
    if (l.chat) items.push({ type: 'divider', text: l.text, level: l.level, ts: l.ts, key: `log${i}` });
  });
  // A message sent while an agent worked shows among that agent's steps; one sent between agents stands alone.
  (run.userMessages ?? []).forEach((m, i) => {
    if (!saidOwner(run, m.ts)) items.push({ type: 'user', text: m.text, ts: m.ts, key: `say${i}`, midRun: true, files: m.attachments, delivered: m.deliveredTo?.length, replies: m.replies, planUpdated: m.planUpdated });
  });
  const order = new Map(items.map((it, i) => [it.key, i]));
  return items.sort((a, b) => a.ts - b.ts || (a.type === b.type ? order.get(a.key)! - order.get(b.key)! : a.type === 'divider' ? -1 : 1));
}

/** A message sent while the agents were working: handed to them right away. */
function MidRunMessage({ runId, ts, text, files, onImage, delivered, replies, planUpdated }: { runId: string; ts: number; text: string; files?: Attachment[]; onImage: (src: string) => void; delivered?: number; replies?: Reply[]; planUpdated?: boolean }) {
  const t = useT();
  return (
    <div className="user-msg-wrap">
      {!!files?.length && (
        <div className="atts right">
          {files.map((a) => (
            <AttachmentChip key={a.path} name={a.name} size={a.size} src={fileUrl(a.path)} onOpen={() => onImage(fileUrl(a.path))} />
          ))}
        </div>
      )}
      {text && <div className="user-msg">{text}</div>}
      {text && <RememberButton runId={runId} text={text} ts={ts} className="user-remember" />}
      <Replies replies={replies} planUpdated={planUpdated} />
      <div className="muted tiny mid-run-tag">
        {delivered
          ? t(`執行中追加 · 已送達 ${delivered} 個 agent`, `Sent while working · reached ${delivered} agent(s)`)
          : t('執行中追加 · 會交給下一個開始工作的 agent', 'Sent while working · goes to the next agent that starts')}
      </div>
    </div>
  );
}

const attKey = (a: Attachment) => `${a.name}|${a.size}`;

/**
 * The files this message itself added. Follow-ups carry the earlier files along (marked "earlier"); messages
 * saved before that mark existed are matched by name and size against the conversation's earlier messages.
 */
function ownAttachments(run: WorkflowRun, before: WorkflowRun[]): Attachment[] {
  // Files sent with a mid-run message belong to that message.
  const midRun = new Set((run.userMessages ?? []).flatMap((m) => m.attachments ?? []).map((x) => x.path));
  const list = (run.config.attachments ?? []).filter((x) => !midRun.has(x.path));
  if (list.some((a) => a.earlier !== undefined)) return list.filter((a) => !a.earlier);
  const seen = new Set(before.flatMap((r) => r.config.attachments ?? []).map(attKey));
  return list.filter((a) => !seen.has(attKey(a)));
}

/** An earlier message of the same conversation, read-only above the latest one. */
function EarlierMessage({ run, before, providers, onImage }: { run: WorkflowRun; before: WorkflowRun[]; providers: ProviderInfo[]; onImage: (src: string) => void }) {
  const items = useMemo(() => timeline(run), [run]);
  const own = ownAttachments(run, before);
  return (
    <div className="earlier-msg">
      {items.map((it) =>
        it.type === 'user' && it.midRun ? (
          <MidRunMessage key={it.key} runId={run.id} ts={it.ts} text={it.text} files={it.files} onImage={onImage} delivered={it.delivered} replies={it.replies} planUpdated={it.planUpdated} />
        ) : it.type === 'user' ? (
          <div key={it.key} className="user-block">
            {own.length > 0 && (
              <div className="atts right">
                {own.map((a) => (
                  <AttachmentChip key={a.path} name={a.name} size={a.size} src={fileUrl(a.path)} onOpen={() => onImage(fileUrl(a.path))} />
                ))}
              </div>
            )}
            <div className="user-msg-wrap">
              <div className="user-msg">{it.text}</div>
            </div>
          </div>
        ) : it.type === 'divider' ? (
          <div key={it.key} className={cx('divider', it.level)}>
            <span>{it.text}</span>
          </div>
        ) : (
          <AgentTurn key={it.key} run={run} agent={it.agent} providers={providers} />
        ),
      )}
      <FinalResult run={run} providers={providers} />
      <DeniedActions run={run} providers={providers} />
      <OutsideChanges run={run} />
      <Outputs run={run} onImage={onImage} />
    </div>
  );
}

function Decision({ run, d }: { run: WorkflowRun; d: HumanDecision }) {
  const t = useT();
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const providers = useProviders();
  const usage = useUsage();
  const choose = (optionId: string, value = text) => hub.call('workflows.decide', { id: run.id, decisionId: d.id, optionId, text: value }).catch((e) => setError(e.message));
  // An option that takes a number (e.g. a new usage cap): its box opens beside the button.
  const [entering, setEntering] = useState<string>();
  const [num, setNum] = useState('');
  // "Use … instead": one button per tool, its accounts in a menu with the quota each has left.
  const switches = d.options.filter((o) => o.id.startsWith('switch:'));
  const at = d.options.findIndex((o) => o.id.startsWith('switch:'));
  return (
    <div className="decision">
      <div className="decision-q">{d.message}</div>
      {d.allowText && <textarea rows={2} placeholder={t('（選填）給 agent 的意見…', '(Optional) a note for the agent…')} value={text} onChange={(e) => setText(e.target.value)} />}
      <div className="row gap wrap">
        {d.options.map((o, i) =>
          o.id.startsWith('switch:') ? (
            i === at && <SwitchChoices key="switch" options={switches} providers={providers} usage={usage} onChoose={choose} first={at === 0} />
          ) : o.input ? (
            <span key={o.id} className={cx('choice-input', entering === o.id && 'open')}>
              <button
                className={cx('btn', i === 0 && 'primary', entering === o.id && 'active')}
                onClick={() => {
                  setEntering(entering === o.id ? undefined : o.id);
                  setNum(String(o.input!.value ?? ''));
                }}
              >
                {o.label}
              </button>
              {entering === o.id && (
                <form
                  className="row gap"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const n = Number(num);
                    if (!(n >= o.input!.min && n <= o.input!.max)) return setError(t(`請輸入 ${o.input!.min} 到 ${o.input!.max}`, `Enter ${o.input!.min} to ${o.input!.max}`));
                    setError(undefined);
                    choose(o.id, [num, text.trim()].filter(Boolean).join('\n'));
                  }}
                >
                  <input type="number" className="choice-num" autoFocus min={o.input.min} max={o.input.max} value={num} onChange={(e) => setNum(e.target.value)} aria-label={o.label} />
                  {o.input.suffix && <span className="muted">{o.input.suffix}</span>}
                  <button type="submit" className="btn primary">
                    {t('確定', 'OK')}
                  </button>
                </form>
              )}
            </span>
          ) : (
            <button key={o.id} className={cx('btn', i === 0 && 'primary', o.id === 'abort' && 'danger')} onClick={() => choose(o.id)}>
              {o.label}
            </button>
          ),
        )}
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
/** A role that will see the attachments: its provider and the model it runs (none = the provider default). */
type RoleTarget = { provider: string; model?: string };

/** What each role's model cannot read, judged by the model's own input types when its list says (else the provider's). */
function compatWarnings(t: ReturnType<typeof useT>, files: Attachment[], targets: RoleTarget[], providers: ProviderInfo[], models: Record<string, ModelInfo[]>): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of files) {
    for (const r0 of targets) {
      const p = providers.find((x) => x.spec.id === r0.provider);
      const id = r0.model ?? p?.defaultModel ?? p?.spec.defaultModel;
      const key = `${r0.provider}|${id ?? ''}|${a.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const r = readability(a, profileForInputs(p?.spec.profile, models[r0.provider]?.find((m) => m.id === id)?.inputs));
      const who = `${p?.spec.name ?? r0.provider}${id ? `（${modelLabel(id)}）` : ''}`;
      if (!r.ok) out.push(t(`${who} 無法讀取 ${a.name}（${reasonText(t, r.reason!)}）`, `${who} cannot read ${a.name} (${reasonText(t, r.reason!)})`));
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
  onSay,
  onStop,
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
  roleProviders: RoleTarget[];
  compact?: boolean;
  onSafety?: (v: { permission?: PermissionLevel; isolation?: boolean }) => void;
  onAdvisor?: (v: AdvisorConfig) => void;
  /** The send button becomes pause while agents work, and resume while paused. */
  runState?: 'running' | 'paused';
  /** Shown after the role pills (the shared-context pie). */
  extra?: ReactNode;
  onPause?: () => void;
  /** End the workflow for good (from the send button's right-click menu while it runs or is paused). */
  onStop?: () => void;
  /** Resume; what the user typed meanwhile is passed to the agents. */
  onResume?: (note: string) => void;
  /** While agents work: hand a message (and files) to them right away. */
  onSay?: (text: string, attachments: Attachment[]) => Promise<boolean>;
}) {
  const t = useT();
  const [text, setText] = useState('');
  const [files, setFiles] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const [stopMenu, setStopMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirmStop, setConfirmStop] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // The box fits its text — again when the window or the hint changes (a size taken while the window was tiny
  // would otherwise stay and squeeze the conversation).
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 320) + 'px';
    el.classList.toggle('scroll', el.scrollHeight > 320);
  };
  useLayoutEffect(fit, [text, placeholder]);
  useEffect(() => {
    // Measured before it had its width (every character on a line of its own): fit again once the width is known.
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    let width = el.clientWidth;
    const ro = new ResizeObserver(() => {
      if (el.clientWidth !== width) {
        width = el.clientWidth;
        fit();
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

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

  // Model lists of the roles' providers, for what each model can read (only while files are attached).
  const [roleModels, setRoleModels] = useState<Record<string, ModelInfo[]>>({});
  const roleIds = [...new Set(roleProviders.map((r) => r.provider))].sort().join(',');
  useEffect(() => {
    if (!files.length || !roleIds) return;
    let live = true;
    Promise.all(roleIds.split(',').map((id) => hub.call<ModelInfo[]>('providers.models', { id }).then((m) => [id, m] as const).catch(() => [id, []] as const))).then((list) => live && setRoleModels(Object.fromEntries(list)));
    return () => {
      live = false;
    };
  }, [roleIds, files.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  const uploading = files.some((f) => f.status === 'uploading');
  const send = async () => {
    const ready = files.filter((f) => f.status === 'ready' && f.att).map((f) => f.att!);
    if (runState === 'running' && onSay) {
      if (uploading || (!text.trim() && !ready.length)) return;
      if (await onSay(text.trim(), ready)) {
        files.forEach((f) => f.preview && URL.revokeObjectURL(f.preview));
        setText('');
        setFiles([]);
      }
      return;
    }
    if (!text.trim() || disabled || busy || uploading) return;
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
        const warn = compatWarnings(t, files.filter((f) => f.att).map((f) => f.att!), roleProviders, providers, roleModels);
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
        {/* Right-click while it runs or is paused: end the workflow (asks for confirmation). */}
        <span
          className="send-wrap"
          onContextMenu={(e) => {
            if (!runState || !onStop) return;
            e.preventDefault();
            setStopMenu({ x: e.clientX, y: e.clientY });
          }}
        >
        {runState === 'running' && (text.trim() || files.some((f) => f.status === 'ready')) ? (
          <button className="send" onClick={send} title={t('交給正在工作的 agent：它們會停下來看這則訊息，再接著做', 'Hand it to the working agents: they stop, read it and carry on')} aria-label={t('送出', 'Send')}>
            ↑
          </button>
        ) : runState === 'running' ? (
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
        </span>
      </div>
      {stopMenu && (
        <>
          <div className="ctx-scrim" onClick={() => setStopMenu(null)} onContextMenu={(e) => (e.preventDefault(), setStopMenu(null))} />
          <div className="ctx-menu" style={{ left: Math.min(stopMenu.x, window.innerWidth - 220), top: Math.max(8, stopMenu.y - 56) }}>
            <button
              className="danger"
              onClick={() => {
                setStopMenu(null);
                setConfirmStop(true);
              }}
            >
              ■ {t('終止此工作流…', 'End this workflow…')}
            </button>
          </div>
        </>
      )}
      {confirmStop && (
        <div className="modal-back" onClick={() => setConfirmStop(false)}>
          <div className="modal stop-confirm" onClick={(e) => e.stopPropagation()}>
            <h3>{t('確定要終止這個工作流嗎？', 'End this workflow?')}</h3>
            <p className="small">
              {t(
                '正在工作的 agent 會立刻停止，已改動的檔案與紀錄都保留。之後有兩種接著做的方式：在這段對話送出新訊息之前，可以按「接續原工作流」，從停下的階段與輪次繼續同一個工作流（計畫、步驟進度、審查與共用上下文都保留）；或送出新訊息，用相同設定開始下一段工作流。',
                'Working agents stop right away; files changed and records so far are kept. You can then go on in two ways: until you send a new message in this chat, "Resume this workflow" continues the same workflow from the stage and round it stopped in (plan, step progress, reviews and shared context kept); or send a new message to start the next workflow with the same setup.',
              )}
            </p>
            <div className="row end gap">
              <button className="btn" onClick={() => setConfirmStop(false)}>
                {t('不確認', 'Cancel')}
              </button>
              <button
                className="btn stop-yes"
                onClick={() => {
                  setConfirmStop(false);
                  onStop?.();
                }}
              >
                {t('確認終止', 'End it')}
              </button>
            </div>
          </div>
        </div>
      )}
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
        <RememberButton runId={run.id} text={text} ts={run.createdAt} className="user-remember" />
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
  const rows = deliverableRows(run);
  const scope = verificationScope(t, run);
  const checks = exec ? implRound?.submission?.checks : undefined;
  const lastVerification = [...(run.stages.verify?.rounds ?? [])].reverse().find((r) => r.verification)?.verification;
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
      {/* What was delivered, from the workflow's file list (not an agent's account): each file with where it came from. */}
      {rows.length > 0 && (
        <div className="final-row">
          <span className="final-label">{t('交付', 'Delivered')}</span>
          <div className="final-files">
            {rows.slice(0, 8).map((r) => (
              <DeliverableRow key={r.path} run={run} row={r} />
            ))}
            {rows.length > 8 && <span className="muted small">{t(`等 ${rows.length} 個（見下方檔案清單）`, `${rows.length} in all (file list below)`)}</span>}
          </div>
        </div>
      )}
      {/* Every check once, with its state: a rerun, the user's scope, a later file change are on its own row. */}
      {!!checks?.length && (
        <div className="final-row">
          <span className="final-label">{t('檢查', 'Checks')}</span>
          <CheckRows checks={checks} />
        </div>
      )}
      {scope.length > 0 && (
        <div className="final-row">
          <span className="final-label">{t('驗證範圍', 'Checked')}</span>
          <span className="small">{scope.join(' · ')}</span>
        </div>
      )}
      {/* The author's own account, in full, once: the card above keeps one line, its details keep the same text. */}
      <div className="final-text">
        <div className="muted tiny">{exec ? t('實作者的說明（agent 自述）', "The implementer's account (its own words)") : t('計畫', 'Plan')}</div>
        <Markdown className="prose" text={text} />
      </div>
      {/* The goal verification's own evidence, kept even when it is out of date (what was measured, on what). */}
      {lastVerification && (
        <details className="final-evidence">
          <summary className="small">{lastVerification.stale ? t('上次驗收的證據（之後有改動）', 'Evidence of the last verification (changed since)') : t('驗收證據', 'Verification evidence')}</summary>
          {lastVerification.evidence && (
            <div className="muted tiny">
              {t('量測於', 'Measured on')} {lastVerification.evidence.commit ? `commit ${lastVerification.evidence.commit} · ` : ''}tree {lastVerification.evidence.treeHash.slice(0, 8)} · {new Date(lastVerification.evidence.at).toLocaleString()}
            </div>
          )}
          {lastVerification.metrics.map((m) => (
            <div key={m.id} className="small">
              {m.met ? '✓' : '✕'} <b>{m.id}</b> {run.plan?.goal?.metrics.find((x) => x.id === m.id)?.name ?? ''} — {m.value}
              {m.evidence && <div className="muted tiny mono">{m.evidence}</div>}
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

/** A delivered file: added or modified, and — on click — whether an agent's edit tool changed it, or only the folder's comparison found it (then the commands that name it). */
function DeliverableRow({ run, row }: { run: WorkflowRun; row: ReturnType<typeof deliverableRows>[number] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className={cx('deliverable', open && 'open')}>
      <span className="deliverable-head" onClick={() => setOpen(!open)} title={t('點一下看這個檔案的來源', 'Click to see where this file came from')}>
        <span className="check-caret">{open ? '▾' : '▸'}</span>
        <span className={cx('pill', row.status === 'added' ? 'ok' : '')}>{row.status === 'added' ? t('新增', 'added') : t('修改', 'modified')}</span> <code>{row.path}</code>
        {row.count ? <span className="muted small"> · {t(`${row.count} 個檔案`, `${row.count} files`)}</span> : null}
      </span>
      {open && <DeliverableSource run={run} row={row} />}
    </div>
  );
}

function DeliverableSource({ run, row }: { run: WorkflowRun; row: ReturnType<typeof deliverableRows>[number] }) {
  const t = useT();
  const exec = Object.values(run.agents).filter((a) => a.role === 'executor').sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0];
  const events = useAgentEvents(run.id, exec?.id ?? '');
  const name = row.path.split(/[\\/]/).pop() ?? row.path;
  // A file no edit tool changed: the implementer's commands whose text names it (latest state of each call), to look at.
  const named = row.editedBy.length ? [] : [...new Map(events.filter((e) => e.kind === 'tool' && e.tool?.category === 'command').map((e) => [e.seq, e])).values()].filter((e) => e.tool!.title.includes(name));
  return (
    <div className="deliverable-body small">
      {row.editedBy.length ? (
        <div>{t(`以編輯工具改動：${row.editedBy.map((id) => roleLabel(t, run.agents[id]?.role ?? 'executor')).join('、')}`, `Changed with the edit tool by: ${row.editedBy.map((id) => roleLabel(t, run.agents[id]?.role ?? 'executor')).join(', ')}`)}</div>
      ) : (
        <div className="muted">{t('由資料夾比對發現：工作流結束時比對工作資料夾得知這個改動，紀錄裡沒有哪個 agent 用編輯工具改了這個檔案。', 'Found by comparing the folder: the working folder changed here when the workflow ended; no agent edited this file with the edit tool in the records.')}</div>
      )}
      {named.map((e) => (
        <div key={e.seq} className="deliverable-cmd">
          <div className="muted tiny">{t(`指令文字提到這個檔名（活動紀錄第 ${e.seq} 筆；只是文字比對，不代表就是它寫的）`, `A command whose text has this file name (activity log event ${e.seq}; a text match, not proof that it wrote the file)`)}</div>
          <pre>{e.tool!.title}</pre>
        </div>
      ))}
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
  // The conversation this message belongs to, and its earlier messages (shown above it, oldest first).
  const summaries = useWorkflows();
  const thread = useThreads().find((th) => !!run && th.ids.includes(run.id));
  const threadKey = run ? run.config.threadId ?? run.id : '';
  const earlierIds = run
    ? summaries
        .filter((s) => (s.threadId ?? s.id) === threadKey && s.createdAt < run.createdAt && !s.replacedBy)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((s) => s.id)
    : [];
  const [earlier, setEarlier] = useState<WorkflowRun[]>([]);
  useEffect(() => {
    let live = true;
    Promise.all(earlierIds.map((eid) => hub.call<WorkflowRun>('workflows.get', { id: eid }).catch(() => null))).then((list) => live && setEarlier(list.filter((r): r is WorkflowRun => !!r)));
    return () => {
      live = false;
    };
  }, [earlierIds.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const [draft, setDraft] = useState<RoleDraft | null>(null);
  const [rolesOpen, setRolesOpen] = useState(false);
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const [lightbox, setLightbox] = useState<string>();
  const [agentMap, setAgentMap] = useState(false);
  const [, tick] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  // Following the newest entries while the user is at the bottom; reading older ones (scrolled up, or opened something
  // above) keeps the place, with a way back to the newest.
  const follow = useRef(true);
  const [away, setAway] = useState(false);
  const toLatest = () => {
    follow.current = true;
    setAway(false);
    if (scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  };

  // The saved draft, or the default only when the saved settings were read and hold none (draftInit.ts). Until then
  // the page shows "loading" (or the read error with a retry), so nothing can save over the saved draft.
  const [draftError, setDraftError] = useState<string | null>(null);
  const latest = useRef({ providers, host });
  latest.current = { providers, host };
  const init = useRef<DraftInit<RoleDraft> | undefined>(undefined);
  init.current ??= draftInit<RoleDraft>({
    read: () => hub.call('settings.get'),
    makeDefault: () => defaultDraft(latest.current.providers, latest.current.host?.defaultCwd ?? ''),
    set: (d) => {
      const cwd = latest.current.host?.defaultCwd;
      setDraft((cur) => cur ?? (!d.cwd && cwd ? { ...d, cwd } : d));
    },
    fail: setDraftError,
  });
  useEffect(() => {
    if (host && providers.length) void init.current!.start();
  }, [!!host, providers.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => init.current!.saved(settings.draft), [settings.draft]);
  useEffect(() => hub.on('reconnect', () => void init.current!.retry()), []);

  useEffect(() => {
    if (run?.status !== 'running' && run?.status !== 'waiting_human') return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [run?.status]);

  const items = useMemo(() => (run ? timeline(run) : []), [run]);
  const preview = useAssignPreview(run ? null : draft, providers);

  // Content that grows on its own (a card's records arriving, a live step) keeps a following view at the bottom.
  const lastInput = useRef(0);
  const column = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = column.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      if (follow.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [!!run]); // eslint-disable-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    if (follow.current && scroller.current) scroller.current.scrollTop = scroller.current.scrollHeight;
  });

  const updateDraft = (d: RoleDraft) => {
    setDraft(d);
    // What is for one conversation only (whole-computer access, the security check) is not kept for new ones.
    void saveSettings({ draft: forNewConversations(d) });
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
      hub.call('workflows.updateConfig', { id: run.id, patch: runPatch(d) }).catch((e) => setError((e as Error).message));
    }
  };
  const runPatch = (d: RoleDraft) => {
    const { plan, implement, subagents, permission, contextSharing, context, assignment, advisor, extraDirs, verify, limits } = d;
    return { plan, implement, subagents, permission, contextSharing, context, assignment, advisor, extraDirs: extraDirs ?? [], verify, limits };
  };
  const applyNow = () => {
    if (!run) return;
    hub
      .call('workflows.updateConfig', { id: run.id, patch: runPatch(runDraft ?? run.config), restart: true })
      .then(() => setRolesOpen(false))
      .catch((e) => setError((e as Error).message));
  };
  // Errors found before sending: the user decides to send anyway or fix them first.
  const [pre, setPre] = useState<{ items: PreflightItem[]; decide: (go: boolean) => void }>();
  const dryRun = async () => {
    if (!draft?.cwd) return;
    setRolesOpen(false);
    try {
      const newId = await hub.call<string>('workflows.start', { config: { ...draft, dryRun: true, title: t('試跑', 'Dry run'), goal: t('試跑：只檢查環境、路徑、資源與恢復，不執行 agent', 'Dry run: check environment, paths, resources and recovery; no agent runs') } });
      navigate(`run/${newId}`);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const send = async (goal: string, attachments: Attachment[]): Promise<boolean> => {
    if (!draft) return false;
    setError(undefined);
    let config: WorkflowConfig;
    if (run) {
      const base = runDraft ?? run.config;
      config = {
        ...base,
        // An isolated run worked in a temporary copy; follow-ups start from the user's project (unless a new folder was picked).
        cwd: runDraft && runDraft.cwd !== run.config.cwd ? runDraft.cwd : (run.worktree?.origCwd ?? run.config.cwd),
        title: goal.split('\n')[0].slice(0, 60),
        goal: followUpGoal(goal, run),
        // What the user wrote, kept apart from the context added above: Aivenue carries it verbatim to later messages.
        userText: goal,
        userTextNote: undefined,
        continueFrom: run.id,
      };
    } else {
      config = { ...draft, title: goal.split('\n')[0].slice(0, 60), goal, userText: goal, userTextNote: undefined };
    }
    // Follow-ups keep the earlier files available to agents (copied into the new run), marked so this message does not show them.
    config.attachments = [...(run?.config.attachments ?? []).map((a) => ({ ...a, earlier: true })), ...attachments.map((a) => ({ ...a, earlier: false }))];
    if (!config.cwd) {
      setRolesOpen(true);
      setError(t('請先選擇工作資料夾', 'Choose a working folder first'));
      return false;
    }
    setSending(true);
    try {
      const checks = await hub.call<PreflightItem[]>('workflows.preflight', { config }).catch(() => [] as PreflightItem[]);
      if (checks.some((c) => c.level === 'error')) {
        const go = await new Promise<boolean>((resolve) => setPre({ items: checks, decide: resolve }));
        setPre(undefined);
        if (!go) return false;
      }
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

  if (!shown)
    return draftError ? (
      <div className="center-fill">
        <div className="err-text small">{t(`讀不到已存的工作流設定（${draftError}）。為了不覆蓋它，先不建立新的設定；連線恢復後會自動重試。`, `Could not read the saved workflow settings (${draftError}). So as not to overwrite them, no new settings are made yet; this retries when the connection is back.`)}</div>
        <button className="btn" onClick={() => void init.current!.retry()}>
          {t('重試', 'Retry')}
        </button>
      </div>
    ) : (
      <div className="center-fill muted">{t('載入中…', 'Loading…')}</div>
    );
  // Providers that will see the attachments: auto picks (before the run) or the configured roles.
  const roleProviders = ((): RoleTarget[] => {
    const a = !run && isAuto(shown) ? preview.result : undefined;
    // Auto picks run each provider's default model; configured roles may name their own.
    const of = (picked: string | undefined, role: { provider?: string; model?: string } | null | undefined): RoleTarget | undefined =>
      picked ? { provider: picked } : role?.provider ? { provider: role.provider, model: role.model } : undefined;
    const list: (RoleTarget | undefined)[] = [];
    if (shown.plan.enabled) list.push(of(a?.plan.author, shown.plan.author), shown.plan.reviewer ? of(a?.plan.reviewer, shown.plan.reviewer) : undefined);
    if (shown.implement.enabled) list.push(of(a?.implement.author, shown.implement.author), shown.implement.reviewer ? of(a?.implement.reviewer, shown.implement.reviewer) : undefined);
    return list.filter((x): x is RoleTarget => !!x);
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
      {pre && (
        <div className="note err">
          <div>{t('送出前的預檢發現問題：', 'The check before sending found problems:')}</div>
          <PreflightList items={pre.items} />
          <div className="row gap">
            <button className="btn small" onClick={() => pre.decide(false)}>
              {t('先不送，我去處理', 'Not yet, I will fix it')}
            </button>
            <button className="btn small danger" onClick={() => pre.decide(true)}>
              {t('仍然送出', 'Send anyway')}
            </button>
          </div>
        </div>
      )}
      {!run && preview.error && <div className="note warn">{preview.error}</div>}
      <Composer
        draft={shown}
        providers={providers}
        preview={run ? undefined : preview.result}
        roleProviders={roleProviders}
        canPickFiles={!!host?.canPickFiles}
        busy={sending}
        disabled={active && !paused && run?.status !== 'running'}
        onSend={send}
        runState={run?.status === 'running' ? 'running' : paused ? 'paused' : undefined}
        onPause={() => run && hub.call('workflows.pause', { id: run.id }).catch((e) => setError((e as Error).message))}
        onStop={() => run && hub.call('workflows.cancel', { id: run.id }).catch((e) => setError((e as Error).message))}
        onResume={(note) => run && hub.call('workflows.resume', { id: run.id, note }).catch((e) => setError((e as Error).message))}
        onSay={(text, attachments) =>
          run
            ? hub.call('workflows.say', { id: run.id, text, attachments }).then(
                () => true,
                (e) => (setError((e as Error).message), false),
              )
            : Promise.resolve(false)
        }
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
                : t('agent 正在工作…輸入訊息會立刻交給它們（或按 ❚❚ 暫停）', 'Agents are working… a message goes to them right away (or press ❚❚ to pause)')
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
            <span className="title-text">{thread?.title ?? run.config.title}</span>
            <span className={cx('status', st!.cls)}>
              {(run.status === 'running' || run.status === 'waiting_human') && <span className="pulse" />}
              {st!.label}
            </span>
            <span className="muted small">{elapsed(run.createdAt, run.endedAt)}</span>
          </div>
          <div className="row gap">
            <AgentMapButton run={run} thread={earlier.length > 0} onOpen={() => setAgentMap(true)} />
            <RunMenu run={run} providers={providers} />
            <button className="icon-btn" title={t('開啟資料夾', 'Open folder')} onClick={() => hub.call('host.openPath', { path: run.config.cwd })}>
              📁
            </button>
            {active ? (
              <button className="btn small danger" onClick={async () => (await ask(t('停止這個工作流？正在執行的 agent 會被中止。之後可以「接續原工作流」（在送出新訊息之前），或送出新訊息開始下一段。', 'Stop this workflow? Running agents are terminated. Afterwards you can resume this workflow (until you send a new message) or send a new message to start the next one.'), { danger: true })) && hub.call('workflows.cancel', { id: run.id })}>
                {t('停止', 'Stop')}
              </button>
            ) : (
              <button className="icon-btn" title={t('刪除對話', 'Delete chat')} onClick={async () => {
                  const ids = thread?.ids ?? [run.id];
                  if (!(await ask(ids.length > 1 ? t(`刪除這段對話的 ${ids.length} 則訊息與紀錄？（不會動到專案檔案）`, `Delete this chat's ${ids.length} messages and logs? (project files are not touched)`) : t('刪除這段對話與紀錄？（不會動到專案檔案）', 'Delete this chat and its logs? (project files are not touched)'), { danger: true }))) return;
                  void ids.reduce((p, rid) => p.then(() => hub.call('workflows.delete', { id: rid })), Promise.resolve<unknown>(undefined)).then(() => navigate('new'));
                }}>
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
              const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
              // Only the user leaves the newest entries (wheel, touch, keys, the scroll bar): a scroll the page made
              // itself while content grew is put back at the bottom.
              if (atEnd) follow.current = true;
              else if (Date.now() - lastInput.current < 1000) follow.current = false;
              else if (follow.current) el.scrollTop = el.scrollHeight;
              setAway(!follow.current);
            }}
            onWheel={() => (lastInput.current = Date.now())}
            onTouchMove={() => (lastInput.current = Date.now())}
            onKeyDown={() => (lastInput.current = Date.now())}
            onMouseDown={() => (lastInput.current = Date.now())}
            onClickCapture={(e) => {
              // Opening something that is not at the bottom (an output, a log) keeps it where it is.
              const el = scroller.current!;
              const box = (e.target as HTMLElement).getBoundingClientRect();
              if (box.bottom < el.getBoundingClientRect().bottom - 160) {
                follow.current = false;
                setAway(true);
              }
            }}
          >
            <div className="column" ref={column}>
              <FullAccessBanner run={run} />
              {earlier.map((r, i) => (
                <EarlierMessage key={r.id} run={r} before={earlier.slice(0, i)} providers={providers} onImage={setLightbox} />
              ))}
              {items.map((it) => {
                if (it.type === 'user' && it.midRun) return <MidRunMessage key={it.key} runId={run.id} ts={it.ts} text={it.text} files={it.files} onImage={setLightbox} delivered={it.delivered} replies={it.replies} planUpdated={it.planUpdated} />;
                if (it.type === 'user')
                  return (
                    <div key={it.key} className="user-block">
                      {ownAttachments(run, earlier).length > 0 && (
                        <div className="atts right">
                          {ownAttachments(run, earlier).map((a) => (
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
              <Approvals run={run} providers={providers} unclaimed />
              <WorktreeCard run={run} />
              <ContextAsk run={run} providers={providers} />
              <CompactFailedAsk run={run} providers={providers} />
              {run.pending && <Decision key={run.pending.id} run={run} d={run.pending} />}
              {run.status === 'failed' && run.error && <div className="note err">{run.error}</div>}
              {run.status === 'incomplete' && (
                <div className="note warn">
                  {t(`未完成：${run.incompleteReason ?? '目標沒有達成'}。這不是成功；可以在下方輸入訊息，用相同設定接續。`, `Incomplete: ${run.incompleteReason ?? 'the goal was not met'}. This is not a success; send a message below to continue with the same setup.`)}
                </div>
              )}
              {run.dryRun && run.preflight && <PreflightList items={run.preflight} showOk />}
              {run.status === 'cancelled' &&
                Object.values(run.stages).some((s) => s?.status === 'cancelled') &&
                !summaries.some((s) => (s.threadId ?? s.id) === threadKey && s.createdAt > run.createdAt) && (
                  <div className="note">
                    {t('這個工作流已停止。「接續原工作流」會從停下的階段與輪次繼續同一個工作流，計畫、步驟進度、審查與共用上下文都保留；在下方送出新訊息則會用相同設定開始下一段工作流（之後就不能再接續這一個）。', 'This workflow was stopped. "Resume this workflow" continues the same workflow from the stage and round it stopped in, keeping the plan, step progress, reviews and shared context; a new message below starts the next workflow with the same setup (after which this one can no longer be resumed).')}
                    <div className="row gap" style={{ marginTop: 8 }}>
                      <button className="btn small" onClick={() => hub.call('workflows.resumeInterrupted', { id: run.id }).catch((e) => setError((e as Error).message))}>
                        {t('接續原工作流', 'Resume this workflow')}
                      </button>
                    </div>
                  </div>
                )}
              {run.status === 'interrupted' && (
                <div className="note warn">
                  {run.interruptedFrom === 'paused'
                    ? t('這個工作流在 Aivenue 重新啟動（例如更新）前已暫停。按「繼續」會從暫停的地方接著做，計畫、步驟進度、審查與共用上下文都保留。', 'This workflow was paused before Aivenue restarted (e.g. an update). Continue picks up where it was paused; the plan, step progress, reviews and shared context are kept.')
                    : run.interruptedFrom
                      ? t('Aivenue 重新啟動（例如更新）時這個工作流仍在執行，已中斷。按「接續」會從中斷的階段與輪次接著做，計畫、步驟進度、審查與共用上下文都保留。', 'Aivenue restarted (e.g. an update) while this workflow ran, so it was interrupted. Resume picks up from the stage and round it stopped in; the plan, step progress, reviews and shared context are kept.')
                      : t('Aivenue 關閉時這個工作流仍在執行，已中斷。可以在下方輸入訊息，用相同設定接續。', 'Aivenue was closed while this workflow ran, so it was interrupted. Send a message below to continue with the same setup.')}
                  {(run.waits ?? []).some((w) => w.state === 'waiting' && w.timeoutAt > Date.now()) &&
                    t(
                      ` 中斷時有 ${(run.waits ?? []).filter((w) => w.state === 'waiting').length} 個條件等待（${(run.waits ?? []).filter((w) => w.state === 'waiting').map((w) => w.check.slice(0, 40)).join('、')}）：接續時會交給 agent 用同一個 wait_id 繼續等，原本的逾時時間不變。`,
                      ` ${(run.waits ?? []).filter((w) => w.state === 'waiting').length} condition wait(s) were open; continuing hands them to the agents to keep waiting with the same wait_id and deadline.`,
                    )}
                  {!!run.sideEffects?.length && t(` 已做過的 ${run.sideEffects.length} 個對外動作不會重做。`, ` The ${run.sideEffects.length} external action(s) already done will not be repeated.`)}
                  {!!run.interruptedFrom && (
                    <div className="row gap" style={{ marginTop: 8 }}>
                      <button className="btn primary small" onClick={() => hub.call('workflows.resumeInterrupted', { id: run.id }).catch((e) => setError((e as Error).message))}>
                        {run.interruptedFrom === 'paused' ? t('繼續', 'Continue') : t('接續', 'Resume')}
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
            {away && (
              <button className="to-latest" onClick={toLatest}>
                ↓ {t('回到最新', 'Back to latest')}
              </button>
            )}
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
      {agentMap && run && <AgentMap run={{ ...run, agents: earlier.length ? Object.assign({}, ...earlier.map((r) => r.agents), run.agents) : run.agents, processes: [...earlier, run].flatMap((r) => (r.processes ?? []).map((p) => ({ ...p, workflowId: r.id }))) }} providers={providers} onClose={() => setAgentMap(false)} />}
      {rolesOpen && (
        <RoleSettings
          draft={shown}
          providers={providers}
          lockFolder={active}
          lockSecurity={active}
          onApplyNow={active ? applyNow : undefined}
          onDryRun={!run ? dryRun : undefined}
          notice={
            active
              ? t(
                  '這段對話正在執行。生效時機：模型、思考程度、權限、驗收與限制 → 下一個開始的 agent 回合；技能與角色指示 → 新開的對話（接續中的對話不重送）；正在工作的 agent 不受影響。要立刻生效請按「立即套用」，受影響的 agent 會停下並用新設定重新派發。你中途送出的訊息則會立即送到正在工作的 agent。',
                  'This conversation is running. When changes take effect: model, effort, permission, verification and limits → the next agent turn that starts; skills and role instructions → new conversations (a continued one is not sent them again); working agents keep theirs. Press "Apply now" to have affected agents stop and re-dispatch with the new settings. Messages you send mid-run reach the working agents right away.',
                )
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

/**
 * Opens the agent map; shown when sub-agents are on or anyone was spawned. The numbers are what works right now
 * (sub-agents and advisors, background processes still alive), so a lone main agent never shows one.
 */
function AgentMapButton({ run, onOpen, thread }: { run: WorkflowRun; onOpen: () => void; thread?: boolean }) {
  const t = useT();
  const all = Object.values(run.agents);
  const helpers = all.filter((a) => a.role === 'subagent' || a.role === 'advisor');
  // Also for a conversation of several messages: the map shows every message's agents.
  // Also for background processes: once ended they are listed there, next to the round that started them.
  const procs = run.processes ?? [];
  if (!thread && !run.config.subagents?.enabled && helpers.length === 0 && !procs.length) return null;
  const running = helpers.filter((a) => a.status === 'running' || a.status === 'queued').length;
  const alive = procs.filter((p) => p.alive !== false && !p.endedAt).length;
  const title = [
    t('查看所有 agent 與 sub agent：誰、用什麼模型、正在做什麼', 'See every agent and sub-agent: who, which model, what it is doing'),
    helpers.length ? t(`這則訊息的 sub agent／顧問：${running} 個執行中，共 ${helpers.length} 個`, `Sub-agents and advisors in this message: ${running} running of ${helpers.length}`) : '',
    procs.length ? t(`背景程序：${alive} 個執行中，共 ${procs.length} 個`, `Background processes: ${alive} running of ${procs.length}`) : '',
  ]
    .filter(Boolean)
    .join('\n');
  return (
    <button className="btn small am-open" onClick={onOpen} title={title}>
      {running > 0 && <span className="am-dot live" />}
      Agent map
      {running > 0 && <span className="muted">· {running}</span>}
      {alive > 0 && <span className="muted">· ⚙ {alive}</span>}
    </button>
  );
}
