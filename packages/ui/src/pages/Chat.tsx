import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Activity, ArrowDown, ArrowUp, ChevronDown, ChevronRight, ChevronUp, Circle, CircleCheck, CircleDashed, CircleHelp, CircleSlash, CircleStop, CircleX, GitBranch, Hand, LoaderCircle, LogIn, MessageCircleQuestionMark, Network, RefreshCw, Signpost, Target, Undo2, File, FileArchive, FileAudio, FileSpreadsheet, FileText, FileVideo, Folder, Image as ImageIcon, NotebookPen, Paperclip, Pause, Pencil, Play, Shuffle, Square, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import { Ico } from '../icons';
import type { AdvisorConfig, AgentRunInfo, AssignmentResult, Attachment, HumanDecision, ModelInfo, PermissionLevel, PreflightItem, ProviderInfo, WorkflowConfig, WorkflowRun, WorkflowStatus } from '../../../core/src/types';
import { fileUrl, hub, useAgentEvents, useDeleted, useHostInfo, useProviders, useThreads, useUsage, useWorkflow, useWorkflows } from '../api';
import { SwitchChoices } from '../components/AccountSwitch';
import { profileForInputs, readability, type Reason } from '../../../core/src/readability';
import { decideProblemText, decideProblems } from '../../../core/src/reviewDecide';
import { navigate } from '../App';
import { AgentMap } from '../components/AgentMap';
import { DeniedActions } from '../components/DeniedActions';
import { AgentTurn } from '../components/AgentTurn';
import { deleteConversation, PreflightList, RunMenu, useMenuKeys } from '../components/RunTools';
import { Replies, type Reply } from '../components/Replies';
import { Outputs } from '../components/Outputs';
import { Approvals, FullAccessBanner, OutsideChanges, WorktreeCard } from '../components/Safety';
import { CompactFailedAsk, ContextAsk, ContextPie } from '../components/ContextPie';
import { ProgressList, ProgressPanel, ProgressToggle, progressSettled } from '../components/Progress';
import { RenameInput } from '../components/Rename';
import { defaultDraft, isAuto, RolePills, RoleSettings, useAssignPreview, type RoleDraft } from '../components/RoleSettings';
import { saveSettings, useAppSettings, useT, type T } from '../i18n';
import { draftInit, forNewConversations, type DraftInit } from '../draftInit';
import { followUpGoal } from '../followUp';
import { chatLines, deliverableRows, resultText, verificationStates, type ChatLine, type VerificationState } from '../timeline';
import { CheckRows } from '../components/Checks';
import { FinalWho, ReviewResult, reviewShown } from '../components/ReviewResult';
import { cx, duration, folderName, fullTime, modelLabel, providerName, recentFolders, roleLabel, saidOwner, waitKind, waitWord, wfStatus, type WaitKind } from '../util';
import { Markdown } from '../components/Markdown';
import { CopyButton } from '../components/CopyButton';
import { ask } from '../components/Ask';
import { RememberButton } from '../components/Memory';
import { MsgTime } from '../components/MsgTime';

type Item = { ts: number; key: string } & ({ type: 'user'; text: string; midRun?: boolean; files?: Attachment[]; delivered?: number; replies?: Reply[]; planUpdated?: boolean } | { type: 'agent'; agent: AgentRunInfo } | { type: 'divider'; line: ChatLine });

/** Whether a result card closes this message's thread: the final result (or plan), or an independent review's report. */
const resultShown = (run: WorkflowRun) => !!finalText(run) || reviewShown(run);

/**
 * The thread of a message. `endNote`: the latest message, whose end gives the failure's or the unmet goal's reason in a
 * note of its own (an earlier message has none there: its record line keeps the reason).
 */
function timeline(run: WorkflowRun, t: T, endNote: boolean): Item[] {
  // A follow-up's goal carries the earlier task as context; show only what the user wrote.
  const items: Item[] = [{ type: 'user', text: run.config.goal.replace(/\n\n\(Context: this continues[\s\S]*$/, ''), ts: run.createdAt, key: 'goal' }];
  for (const a of Object.values(run.agents)) if (!a.parentId) items.push({ type: 'agent', agent: a, ts: a.startedAt ?? run.updatedAt, key: a.id });
  // The record's lines, each said once: a heading where a stage starts, the events nothing else on the page says.
  for (const line of chatLines(t, run, resultShown(run), endNote)) items.push({ type: 'divider', line, ts: line.ts, key: line.key });
  // A message sent while an agent worked shows among that agent's steps; one sent between agents stands alone.
  (run.userMessages ?? []).forEach((m, i) => {
    if (!saidOwner(run, m.ts)) items.push({ type: 'user', text: m.text, ts: m.ts, key: `say${i}`, midRun: true, files: m.attachments, delivered: m.deliveredTo?.length, replies: m.replies, planUpdated: m.planUpdated });
  });
  const order = new Map(items.map((it, i) => [it.key, i]));
  return items.sort((a, b) => a.ts - b.ts || (a.type === b.type ? order.get(a.key)! - order.get(b.key)! : a.type === 'divider' ? -1 : 1));
}

/**
 * The chat's working folder under its header, quiet but always in view: the folders above it muted, its own name in the
 * text colour. A long path keeps its end in one line; then a click, Enter, Space or a tap shows it whole (wrapped), for
 * keyboard and touch too, not only in the mouse's tooltip. The whole path is the button's text either way, so a screen
 * reader reads it all. The folder button at the end opens it in the file manager (the folder the agents work in: the
 * isolated copy while there is one, its path in the tooltip).
 */
function CwdBar({ run }: { run: WorkflowRun }) {
  const t = useT();
  const dir = run.worktree?.origCwd ?? run.config.cwd;
  const end = Math.max(dir.replace(/[\\/]+$/, '').lastIndexOf('\\'), dir.replace(/[\\/]+$/, '').lastIndexOf('/'));
  const parent = end > 0 ? dir.slice(0, end + 1) : '';
  const leaf = end > 0 ? dir.slice(end + 1) : dir;
  const isolated = run.worktree?.state === 'active';
  const [whole, setWhole] = useState(false);
  const [cut, setCut] = useState(false);
  const path = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = path.current;
    if (!el) return;
    const measure = () => setCut(el.scrollWidth > el.clientWidth + 1);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [dir, whole]);
  return (
    <div className={cx('run-cwd', whole && 'whole')}>
      <span className="run-cwd-label">{t('工作資料夾', 'Folder')}</span>
      <button
        type="button"
        className="run-cwd-btn"
        title={dir}
        aria-expanded={cut || whole ? whole : undefined}
        onClick={() => (cut || whole) && setWhole(!whole)}
      >
        <span className="run-cwd-path" ref={path}>
          <bdi dir="ltr">
            <span className="run-cwd-parent">{parent}</span>
            <span className="run-cwd-leaf">{leaf}</span>
          </bdi>
        </span>
        {(cut || whole) && <Ico i={whole ? ChevronUp : ChevronDown} size={14} label={whole ? t('收起路徑', 'Shorten the path') : t('顯示完整路徑', 'Show the whole path')} />}
      </button>
      {isolated && (
        <span className="run-cwd-note" title={t('在隔離副本中工作', 'Works in an isolated copy')}>
          <Ico i={GitBranch} size={14} />
          <span className="run-cwd-note-long">{t('在隔離副本中工作', 'Works in an isolated copy')}</span>
          <span className="run-cwd-note-short" aria-hidden="true">
            {t('隔離副本', 'Isolated')}
          </span>
        </span>
      )}
      <button
        type="button"
        className="icon-btn run-cwd-open"
        title={isolated ? `${t('開啟資料夾', 'Open folder')}：${run.config.cwd}` : t('開啟資料夾', 'Open folder')}
        aria-label={t('開啟資料夾', 'Open folder')}
        onClick={() => void hub.call('host.openPath', { path: run.config.cwd }).catch(() => undefined)}
      >
        <Ico i={Folder} size={16} />
      </button>
    </div>
  );
}

/** A workflow's state by its icon (the word beside it says it too); waiting for you, by what it waits for. */
const STATUS_ICON: Record<WorkflowStatus, LucideIcon> = { running: LoaderCircle, paused: Pause, waiting_human: MessageCircleQuestionMark, completed: CircleCheck, incomplete: TriangleAlert, failed: CircleX, cancelled: CircleStop, interrupted: CircleSlash };
const WAIT_ICON: Record<WaitKind, LucideIcon> = { question: MessageCircleQuestionMark, approval: Hand, decision: Signpost };

/** Stopping a workflow asks once, in one wording, from the header's 停止 and from the send button's right-click alike. */
const confirmStop = (t: T) =>
  ask(t('停止這個工作流？', 'Stop this workflow?'), {
    detail: t('已改動的檔案和紀錄都會保留。送出新訊息之前，可以按「接續原工作流」繼續。', 'Files changed and records are kept. Until you send a new message, "Resume this workflow" carries on.'),
    danger: true,
    ok: t('停止工作流', 'Stop the workflow'),
    cancel: t('取消', 'Cancel'),
  });

/**
 * The providers on a new chat, in one line: how many can work and how many are signed out, with a link to manage them;
 * the line opens to each provider and its state (also in its tooltip).
 */
function ProviderLine({ providers }: { providers: ProviderInfo[] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  if (!providers.length) return null;
  const state = (p: ProviderInfo) =>
    p.auth.state === 'checking' ? 'checking' : p.installed && p.auth.state === 'logged_in' ? 'ready' : p.installed && p.auth.state === 'unknown' ? 'unknown' : p.installed ? 'out' : 'missing';
  const word = { ready: t('已登入', 'signed in'), checking: t('檢查中', 'checking'), unknown: t('狀態不明', 'state unknown'), out: t('未登入', 'signed out'), missing: t('未安裝', 'not installed') };
  const icon = { ready: CircleCheck, checking: LoaderCircle, unknown: CircleHelp, out: Circle, missing: CircleDashed };
  const ready = providers.filter((p) => state(p) === 'ready').length;
  const out = providers.filter((p) => state(p) === 'out').length;
  const checking = providers.filter((p) => state(p) === 'checking').length;
  return (
    <div className="home-providers">
      <button type="button" className="home-prov-btn" aria-expanded={open} aria-controls="home-prov-list" title={providers.map((p) => `${p.spec.name}：${word[state(p)]}`).join('\n')} onClick={() => setOpen(!open)}>
        <Ico i={open ? ChevronDown : ChevronRight} size={14} />
        {[t(`可用 ${ready} 家`, `${ready} available`), out ? t(`${out} 家未登入`, `${out} signed out`) : '', checking ? t('檢查登入狀態中…', 'Checking sign-ins…') : ''].filter(Boolean).join(t('，', ', '))}
      </button>
      <span className="home-sep" aria-hidden="true">
        ·
      </span>
      <a href="#/settings/providers">{t('管理供應商', 'Manage providers')}</a>
      {open && (
        <ul id="home-prov-list" className="home-prov-list">
          {providers.map((p) => (
            <li key={p.spec.id} className={state(p)}>
              <Ico i={icon[state(p)]} size={14} className={state(p) === 'checking' ? 'spin' : undefined} /> {p.spec.name} <span className="muted">{word[state(p)]}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A log line as shown: the records' ✅ (in old chats too) drawn as the same check icon as everywhere else. */
function logText(text: string): ReactNode {
  if (!text.includes('✅')) return text;
  return text.split('✅').flatMap((part, i) => (i ? [<Ico key={i} i={CircleCheck} size={14} className="ok" />, part] : [part]));
}

/** An event's icon: what it is about (a question to you, a stop, work sent back, a failure), else a warning's or an error's. */
const lineIcon = (line: ChatLine): LucideIcon | undefined =>
  line.tone === 'question' ? MessageCircleQuestionMark : line.tone === 'stopped' ? CircleStop : line.tone === 'revise' ? Undo2 : line.tone === 'failed' || line.level === 'error' ? CircleX : line.level === 'warn' ? TriangleAlert : undefined;

/**
 * A line of the workflow's record in the thread: a stage's heading (「計畫」「實作」「驗收」, another round with why it
 * came back) at the left with its time and a rule, or an event in a sentence, quiet unless it is a warning or an error;
 * the icon says what it is about.
 */
function ChatLineView({ line }: { line: ChatLine }) {
  const icon = lineIcon(line);
  return line.kind === 'stage' ? (
    <h2 className="divider stage">
      <span className="stage-name">{line.text}</span>
      {line.detail && <span className="stage-detail">{line.detail}</span>}
      <MsgTime ts={line.ts} />
    </h2>
  ) : (
    <div className={cx('divider', 'event', line.level)}>
      {icon && <Ico i={icon} size={14} />}
      <span>
        {logText(line.text)} <MsgTime ts={line.ts} />
      </span>
    </div>
  );
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
        <MsgTime ts={ts} /> ·{' '}
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
  const t = useT();
  const items = useMemo(() => timeline(run, t, false), [run, t]);
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
              <div className="user-actions">
                <MsgTime ts={it.ts} />
              </div>
            </div>
          </div>
        ) : it.type === 'divider' ? (
          <ChatLineView key={it.key} line={it.line} />
        ) : (
          <AgentTurn key={it.key} run={run} agent={it.agent} providers={providers} />
        ),
      )}
      <FinalResult run={run} providers={providers} />
      <ReviewResult run={run} providers={providers} />
      <Outputs run={run} onImage={onImage} />
      <DeniedActions run={run} providers={providers} />
      <OutsideChanges run={run} />
    </div>
  );
}

/**
 * An agent's question (ask_user): pick one of its answers, or "Other" to write your own; either way the box takes what
 * to add (a condition, a detail). Nothing is sent until "Send the answer" (or Ctrl+Enter in the box).
 */
function Question({ run, d }: { run: WorkflowRun; d: HumanDecision }) {
  const t = useT();
  const answers = d.options.filter((o) => o.id === 'answer' || o.id.startsWith('answer:'));
  const actions = d.options.filter((o) => !answers.includes(o));
  // The agent gave no answers to pick from: only the box.
  const freeOnly = answers.length === 1 && answers[0].id === 'answer';
  const [picked, setPicked] = useState<string | undefined>(freeOnly ? 'answer' : undefined);
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const [sending, setSending] = useState(false);
  const own = picked === 'answer';
  const ready = !!picked && (!own || !!text.trim()) && !sending;
  const send = (optionId: string, value: string) => {
    setSending(true);
    setError(undefined);
    hub.call('workflows.decide', { id: run.id, decisionId: d.id, optionId, text: value }).catch((e) => {
      setError(e.message);
      setSending(false);
    });
  };
  const submit = () => {
    if (ready) send(picked!, text);
  };
  const qid = `question-${d.id}`;
  return (
    <div className="decision question">
      <div className="decision-q" id={qid}>
        {d.message}
      </div>
      {!freeOnly && (
        <div className="answer-choices" role="radiogroup" aria-labelledby={qid}>
          {answers.map((o) => (
            <label key={o.id} className={cx('answer-choice', picked === o.id && 'on', o.id === 'answer' && 'own')}>
              <input type="radio" name={qid} value={o.id} aria-label={o.label} checked={picked === o.id} onChange={() => setPicked(o.id)} />
              <span>{o.label}</span>
            </label>
          ))}
        </div>
      )}
      <textarea
        rows={2}
        aria-label={own ? t('你的回答', 'Your answer') : t('補充說明', 'Anything to add')}
        placeholder={own ? t('寫下你的回答，必填', 'Write your answer, required') : t('補充說明或額外條件，選填', 'Anything to add, such as a condition, optional')}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          // Writing before picking anything: an answer of your own.
          if (!picked && e.target.value.trim()) setPicked('answer');
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="row gap wrap">
        <button className="btn primary" disabled={!ready} onClick={submit}>
          {t('送出回答', 'Send the answer')}
        </button>
        {actions.map((o) => (
          <button key={o.id} className={cx('btn', o.id === 'abort' && 'danger')} disabled={sending} onClick={() => send(o.id, text)}>
            {o.label}
          </button>
        ))}
        {!ready && !sending && (
          <span className="muted small">
            {freeOnly
              ? t('請寫下你的回答', 'Write your answer')
              : !picked
                ? t('選一個答案，或選「其他」自己寫', 'Pick an answer, or "Other" to write your own')
                : t('選了「其他」：請寫下你的回答', 'You chose "Other": write your answer')}
          </span>
        )}
      </div>
      {error && <div className="note err">{error}</div>}
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
      {d.allowText && <textarea rows={2} placeholder={t('給 agent 的意見，選填', 'A note for the agent, optional')} value={text} onChange={(e) => setText(e.target.value)} />}
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

export function AttachmentChip({ name, size, src, status, error, onRemove, onOpen, icon }: { name: string; size: number; src?: string; status?: Pending['status']; error?: string; onRemove?: () => void; onOpen?: () => void; icon?: LucideIcon }) {
  const t = useT();
  return (
    <div className={cx('att', status === 'error' && 'bad')} title={error ?? name}>
      {/* A picture sent with a message: a button that enlarges it (Tab, Enter, Space). */}
      {src && isImg(name) ? (
        onOpen ? (
          <button type="button" className="att-open" onClick={onOpen} aria-label={t(`放大 ${name}`, `Enlarge ${name}`)}>
            <img src={src} alt="" />
          </button>
        ) : (
          <img src={src} alt="" />
        )
      ) : (
        <span className="att-icon"><Ico i={icon ?? FileText} size={18} /></span>
      )}
      <span className="att-meta">
        <span className="att-name">{name}</span>
        <span className="att-size">{status === 'uploading' ? '…' : status === 'error' ? <Ico i={CircleX} size={12} /> : fmtSize(size)}</span>
      </span>
      {onRemove && (
        <button type="button" className="att-x" onClick={onRemove} aria-label={t(`移除 ${name}`, `Remove ${name}`)}>
          <Ico i={X} size={12} />
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
      const who = `${p?.spec.name ?? r0.provider}${id ? ` ${modelLabel(id)}` : ''}`;
      if (!r.ok) out.push(t(`${who} 無法讀取 ${a.name}：${reasonText(t, r.reason!)}`, `${who} cannot read ${a.name}: ${reasonText(t, r.reason!)}`));
    }
  }
  return out;
}

const KIND_ICON: Record<string, LucideIcon> = { image: ImageIcon, 'image-other': ImageIcon, pdf: FileText, office: FileSpreadsheet, 'legacy-office': FileText, notebook: NotebookPen, archive: FileArchive, audio: FileAudio, video: FileVideo, text: FileText, binary: File };

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
  unassigned,
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
  /** End the workflow for good (from the send button's right-click menu while it runs or is paused; it asks first). */
  onStop?: () => void;
  /** Nothing can be assigned (no provider signed in): the roles summary says so instead of naming providers. */
  unassigned?: boolean;
  /** Resume; what the user typed meanwhile is passed to the agents. */
  onResume?: (note: string) => void;
  /** While agents work: hand a message (and files) to them right away. */
  onSay?: (text: string, attachments: Attachment[]) => Promise<boolean>;
}) {
  const t = useT();
  const [text, setText] = useState('');
  const [files, setFiles] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  // The send button's right-click menu (a shortcut to stopping the workflow), above the button: a menu by the keyboard
  // too (Esc or Tab closes it and the focus goes back to the button); a click outside closes it.
  const [stopMenu, setStopMenu] = useState(false);
  const sendWrap = useRef<HTMLSpanElement>(null);
  const stopList = useRef<HTMLSpanElement>(null);
  const sendBtn = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!stopMenu) return;
    const close = (e: MouseEvent) => !sendWrap.current?.contains(e.target as Node) && setStopMenu(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [stopMenu]);
  useMenuKeys(stopMenu, stopList, sendBtn, () => setStopMenu(false));
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
    // Paused: Enter does what the ▶ button does (resume, with what was typed), not start a second message on this chat.
    if (runState === 'paused' && onResume) {
      if (!text.trim()) return;
      onResume(text.trim());
      setText('');
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
              <div key={i}><Ico i={TriangleAlert} size={14} /> {w}</div>
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
      {/* One row, in the order it is read and tabbed through: attach, the settings of the next message (one summary on a
          narrow composer), the context ring, send. */}
      <div className="composer-bar">
        <button className="clip" disabled={disabled} onClick={pick} title={t('附加圖片或檔案，也可以拖曳或貼上', 'Attach images or files, or drag & drop or paste them')} aria-label={t('附加檔案', 'Attach files')}>
          <Ico i={Paperclip} size={16} />
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
        <RolePills draft={draft} providers={providers} onOpen={onOpenRoles} preview={preview} compact={compact} onSafety={onSafety} onAdvisor={onAdvisor} unassigned={unassigned} />
        {extra}
        {/* Right-click while it runs or is paused: a shortcut to stopping it (the header's 停止 is the way in view; both
            ask the same question). */}
        <span
          className="send-wrap"
          ref={sendWrap}
          onContextMenu={(e) => {
            if (!runState || !onStop) return;
            e.preventDefault();
            sendBtn.current = sendWrap.current?.querySelector<HTMLElement>('button.send') ?? null;
            setStopMenu(true);
          }}
        >
        {runState === 'running' && (text.trim() || files.some((f) => f.status === 'ready')) ? (
          <button className="send" onClick={send} title={t('交給正在工作的 agent：它們會停下來看這則訊息，再接著做', 'Hand it to the working agents: they stop, read it and carry on')} aria-label={t('送出', 'Send')}>
            <Ico i={ArrowUp} size={16} />
          </button>
        ) : runState === 'running' ? (
          <button className="send pause" onClick={onPause} title={t('暫停：停下正在工作的 agent，之後可以繼續', 'Pause: stop the working agents; you can resume later')} aria-label={t('暫停', 'Pause')}>
            <Ico i={Pause} size={16} />
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
            <Ico i={Play} size={16} />
          </button>
        ) : (
          <button className="send" disabled={disabled || busy || uploading || !text.trim()} onClick={send} aria-label={t('送出', 'Send')}>
            <Ico i={ArrowUp} size={16} />
          </button>
        )}
        {stopMenu && (
          <span className="ctx-menu" role="menu" aria-label={t('工作流', 'Workflow')} ref={stopList}>
            <button
              role="menuitem"
              tabIndex={-1}
              className="danger"
              onClick={() => {
                setStopMenu(false);
                // Back on the send button first: the confirmation gives the focus back there.
                sendBtn.current?.focus();
                onStop?.();
              }}
            >
              <Ico i={Square} size={14} /> {t('停止工作流…', 'Stop the workflow…')}
            </button>
          </span>
        )}
        </span>
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
        {/* Always in view (quiet): touch and keyboard users find them without hovering. */}
        <div className="user-actions">
          <MsgTime ts={run.createdAt} />
          <RememberButton runId={run.id} text={text} ts={run.createdAt} className="user-remember" />
          {!run.replacedBy && (
            <button
              className="link tiny user-edit"
              title={active ? t('編輯後會停止目前的工作流，用新內容重新執行', 'Editing stops the current workflow and runs the new text') : t('編輯並重新送出', 'Edit and re-send')}
              onClick={() => {
                setValue(text);
                setEditing(true);
              }}
            >
              <Ico i={Pencil} size={13} /> {t('編輯', 'Edit')}
            </button>
          )}
        </div>
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
      {active && <div className="note warn small">{t('送出後會立刻停止目前正在執行的 agent，再用新內容重新開始。已經改動的檔案不會自動還原。', 'Sending stops the agents that are working now, then starts over with the new text. Files already changed are not rolled back.')}</div>}
      {error && <div className="note err small">{error}</div>}
      <div className="row gap">
        <span className="grow muted tiny">{t('Ctrl+Enter 送出，Esc 取消', 'Ctrl+Enter to send, Esc to cancel')}</span>
        <button className="btn" disabled={busy} onClick={() => setEditing(false)}>
          {t('取消', 'Cancel')}
        </button>
        <button className="btn primary" disabled={busy || !value.trim() || value.trim() === text.trim()} onClick={() => void submit()}>
          {busy ? t('處理中…', 'Working…') : active ? t('停止並重新執行', 'Stop and re-run') : t('重新送出', 'Re-send')}
        </button>
      </div>
    </div>
  );
}

/** The last main agent of a role that completed (the one whose words the result repeats). */
function lastMain(run: WorkflowRun, role: AgentRunInfo['role']): AgentRunInfo | undefined {
  return Object.values(run.agents)
    .filter((a) => a.depth === 0 && a.status === 'completed' && a.role === role)
    .sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0))[0];
}

/** What a completed workflow's result card repeats: the last implementer's account, or the plan when only planning ran. */
function finalText(run: WorkflowRun): string | undefined {
  if (run.status !== 'completed') return undefined;
  const exec = lastMain(run, 'executor');
  const implRound = run.stages.implement.rounds.at(-1);
  return exec ? resultText(exec.finalText, implRound?.submission?.summary) : run.plan ? run.plan.markdown?.trim() || run.plan.summary : undefined;
}

/**
 * The answer, repeated at the bottom once the workflow is done, so nobody has to scroll back up past the reviews: the
 * last implementer's reply (or the plan when only planning ran) plus the final verdict. The one framed card of a finished
 * conversation, its frame neutral: colour only on the states (the review in the header, each verification state).
 */
function FinalResult({ run, providers }: { run: WorkflowRun; providers: ProviderInfo[] }) {
  const t = useT();
  const [progress, setProgress] = useState(false);
  const text = finalText(run);
  if (!text) return null;
  const exec = lastMain(run, 'executor');
  const implRound = run.stages.implement.rounds.at(-1);
  const planRound = run.stages.plan.rounds.at(-1);
  const author = exec ?? lastMain(run, 'planner');
  const review = (exec ? implRound : planRound)?.review;
  const rows = deliverableRows(run);
  const states = verificationStates(t, run);
  const checks = exec ? implRound?.submission?.checks : undefined;
  const lastVerification = [...(run.stages.verify?.rounds ?? [])].reverse().find((r) => r.verification)?.verification;
  // Its steps all done: the progress panel above the input gives way, its list opens here.
  const settled = progressSettled(run, providers, t);
  return (
    <div className="final-result">
      {/* Title and the review first (who did it gives way in a narrow column, whole in its tooltip and its turn above);
          the progress, time and copy button after, on a line of their own when they do not fit. */}
      <div className="final-head">
        <h2 className="final-title">{exec ? t('最終結果', 'Final result') : t('最終計畫', 'Final plan')}</h2>
        {review && (
          <span className={cx('state-word', review.verdict === 'approve' ? 'ok' : 'warn')}>
            <Ico i={review.verdict === 'approve' ? CircleCheck : TriangleAlert} size={14} /> {review.verdict === 'approve' ? t('審查通過', 'Approved') : t('未通過即結束', 'Ended without approval')}
          </span>
        )}
        {author && <FinalWho text={`${providerName(providers, author.provider)}${author.model ? ` · ${modelLabel(author.model)}` : ''}`} />}
        <span className="final-tools">
          {settled && <ProgressToggle run={run} providers={providers} open={progress} onToggle={() => setProgress(!progress)} />}
          <MsgTime ts={run.endedAt} className="final-time" />
          {/* The result as written (Markdown), as shown below. */}
          <CopyButton text={text} label={exec ? t('複製結果', 'Copy result') : t('複製計畫', 'Copy plan')} className="final-copy" />
        </span>
      </div>
      {settled && progress && <ProgressList run={run} providers={providers} />}
      {/* What was delivered, from the workflow's file list (not an agent's account): each file with where it came from. */}
      {rows.length > 0 && (
        <div className="final-row">
          <span className="final-label">{t('交付', 'Delivered')}</span>
          <div className="final-files">
            {rows.slice(0, 8).map((r) => (
              <DeliverableRow key={r.path} run={run} row={r} />
            ))}
            {rows.length > 8 && <span className="muted small">{t(`共 ${rows.length} 個，完整清單在下方「檔案」`, `${rows.length} in all, the full list under Files below`)}</span>}
          </div>
        </div>
      )}
      {/* How far it was checked, each state apart and with its reason in view: a failed check, no check run, a
          re-check after a change and too little evidence are different things to the reader. Each its own icon and
          colour, as text (no box). */}
      {states.length > 0 && (
        <div className="final-row">
          <span className="final-label">{t('驗證範圍', 'Checked')}</span>
          <div className="vstates">
            {states.map((v) => (
              <div key={v.kind + v.label} className="vstate-row">
                <span className={cx('vstate', 'state-word', v.cls)}>
                  <Ico i={V_ICON[v.kind]} size={14} /> {v.label}
                </span>
                {v.detail && <span className="vstate-detail">{v.detail}</span>}
              </div>
            ))}
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
      {/* The author's own account, in full, once: the card above keeps one line, its details keep the same text. */}
      <div className="final-text">
        <div className="final-text-label">
          {exec ? (
            <>
              {t('實作者的說明', "The implementer's account")}{' '}
              <span className="self-tag">{t('agent 自述', 'its own words')}</span>
            </>
          ) : (
            t('計畫', 'Plan')
          )}
        </div>
        <Markdown className="prose" text={text} />
      </div>
      {/* The goal verification's own evidence, kept even when it is out of date (what was measured, on what). */}
      {lastVerification && (
        <details className="final-evidence">
          <summary className="small">
            <Ico i={ChevronRight} size={14} className="fold-chev" /> {lastVerification.stale ? t('上次驗收的證據 · 之後有改動', 'Evidence of the last verification · changed since') : t('驗收證據', 'Verification evidence')}
          </summary>
          {lastVerification.evidence && (
            <div className="muted tiny">
              {t('量測於版本', 'Measured on version')} {(lastVerification.evidence.commit ?? lastVerification.evidence.treeHash).slice(0, 8)}
              {t('，', ', ')}
              {lastVerification.evidence.commit ? `commit ${lastVerification.evidence.commit}${t('，', ', ')}` : ''}git tree {lastVerification.evidence.treeHash.slice(0, 8)}
              {t('，', ', ')}
              {new Date(lastVerification.evidence.at).toLocaleString()}
            </div>
          )}
          {lastVerification.metrics.map((m) => (
            <div key={m.id} className="small">
              <Ico i={m.met ? CircleCheck : CircleX} size={14} className={m.met ? 'ok' : 'bad'} /> <b>{m.id}</b> {run.plan?.goal?.metrics.find((x) => x.id === m.id)?.name ?? ''} — {m.value}
              {m.evidence && <div className="muted tiny mono">{m.evidence}</div>}
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

const V_ICON: Record<VerificationState['kind'], LucideIcon> = { failed: CircleX, not_run: CircleDashed, recheck: RefreshCw, weak: CircleHelp, passed: CircleCheck, goal: Target };

/**
 * A delivered file: added or modified (a quiet word), its path, and — behind the row, a button — whether an agent's edit
 * tool changed it, or only the folder's comparison found it (then the commands that name it).
 */
function DeliverableRow({ run, row }: { run: WorkflowRun; row: ReturnType<typeof deliverableRows>[number] }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div className={cx('deliverable', open && 'open')}>
      {/* The chevron in a column of its own: a wrapped path stays beside it, under its first line. */}
      <button type="button" className="deliverable-head" aria-expanded={open} onClick={() => setOpen(!open)} title={t('這個檔案的來源', 'Where this file came from')}>
        <Ico i={open ? ChevronDown : ChevronRight} size={14} className="check-caret" />
        <span className="row-main">
          <span className="deliverable-kind">{row.status === 'added' ? t('新增', 'added') : t('修改', 'modified')}</span>
          <code>{row.path.replace(/\\/g, '/')}</code>
          {row.count ? <span className="muted small">{t(`${row.count} 個檔案`, `${row.count} files`)}</span> : null}
        </span>
      </button>
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
        <div title={t('agent 用編輯工具改的', 'Changed with an edit tool')}>{t(`改動者：${row.editedBy.map((id) => roleLabel(t, run.agents[id]?.role ?? 'executor')).join('、')}`, `Changed by: ${row.editedBy.map((id) => roleLabel(t, run.agents[id]?.role ?? 'executor')).join(', ')}`)}</div>
      ) : (
        <div className="muted">{t('由資料夾比對發現：工作流結束時比對工作資料夾得知這個改動，紀錄裡沒有哪個 agent 用編輯工具改了這個檔案。', 'Found by comparing the folder: the working folder changed here when the workflow ended; no agent edited this file with the edit tool in the records.')}</div>
      )}
      {named.map((e) => (
        <div key={e.seq} className="deliverable-cmd">
          <div className="muted tiny">{t(`指令文字提到這個檔名，活動紀錄第 ${e.seq} 筆。只是文字比對，不一定是它寫的。`, `A command whose text has this file name, activity log event ${e.seq}. A text match only, not proof that it wrote the file.`)}</div>
          <pre>{e.tool!.title}</pre>
        </div>
      ))}
    </div>
  );
}

/** The file name an image's address (fileUrl) points at, for its text alternative. */
function imageName(src: string): string {
  try {
    return (new URL(src).searchParams.get('path') ?? '').split(/[\\/]/).pop() ?? '';
  } catch {
    return '';
  }
}

/**
 * An image enlarged over the page: a click, Enter, Space or Esc closes it. It takes the focus when it opens and keeps it
 * while open (Tab does not move behind it); closed, the focus goes back to what opened it (the thumbnail or attachment).
 */
function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  const t = useT();
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const close = () => {
    onClose();
    opener?.focus();
  };
  const name = imageName(src) || t('圖片', 'image');
  return (
    <button
      type="button"
      className="lightbox"
      autoFocus
      onClick={close}
      onKeyDown={(e) => {
        if (e.key === 'Escape') close();
        else if (e.key === 'Tab') e.preventDefault();
      }}
      aria-label={t(`關閉放大的圖片：${name}`, `Close the enlarged image: ${name}`)}
    >
      <img src={src} alt={name} />
    </button>
  );
}

export function Chat({ id }: { id?: string }) {
  const t = useT();
  const settings = useAppSettings();
  const providers = useProviders();
  const host = useHostInfo();
  const run = useWorkflow(id);
  const deleted = useDeleted(id);
  // The conversation this message belongs to, and its earlier messages (shown above it, oldest first).
  const summaries = useWorkflows();
  const threads = useThreads();
  const thread = threads.find((th) => !!run && th.ids.includes(run.id));
  // Renaming the conversation: from ⋯, a double click on the title or F2 on it (its row in the chat list does it too).
  // Done, the focus goes back to the title.
  const [renaming, setRenaming] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const wasRenaming = useRef(false);
  useEffect(() => {
    if (renaming) {
      wasRenaming.current = true;
      return;
    }
    if (!wasRenaming.current) return;
    wasRenaming.current = false;
    if (!document.activeElement || document.activeElement === document.body) titleRef.current?.focus();
  }, [renaming]);
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
    if (run?.status !== 'running' && run?.status !== 'waiting_human' && run?.status !== 'paused') return;
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, [run?.status]);

  const items = useMemo(() => (run ? timeline(run, t, true) : []), [run, t]);
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
  const runShown: RoleDraft | null = run ? (runDraft ?? run.config) : draft;
  // An isolated run's config points at its temporary copy; follow-ups start from the user's project (see send), so
  // the composer and the settings show that folder too, unless another one was picked.
  const origCwd = run?.worktree?.origCwd;
  const shown: RoleDraft | null = useMemo(
    () => (run && runShown && origCwd && runShown.cwd === run.config.cwd ? { ...runShown, cwd: origCwd } : runShown),
    [run, runShown, origCwd],
  );
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
    // Decisions over their limits: not sent (the hub would refuse them; nothing is cut). The settings open on the field,
    // which names the lines.
    const decideOver = config.review ? decideProblems(config.review.decide) : [];
    if (decideOver.length) {
      setRolesOpen(true);
      setError(decideProblemText(t, decideOver));
      // The field itself, in view and focused, once the settings are drawn, with the first line over a limit selected.
      setTimeout(() => {
        const field = document.getElementById('review-decide') as HTMLTextAreaElement | null;
        if (!field) return;
        field.scrollIntoView({ block: 'center' });
        field.focus();
        const lines = field.value.split('\n');
        const n = decideOver[0].line - 1;
        const start = lines.slice(0, n).reduce((sum, l) => sum + l.length + 1, 0);
        field.setSelectionRange(start, start + (lines[n]?.length ?? 0));
        // Selecting does not always scroll a textarea: the line brought to its middle.
        const lineHeight = parseFloat(getComputedStyle(field).lineHeight) || 20;
        field.scrollTop = Math.max(0, n * lineHeight - field.clientHeight / 2);
      }, 50);
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
        <div className="err-text small">{t(`讀不到已存的工作流設定：${draftError}。為了不覆蓋它，先不建立新的設定，連線恢復後會自動重試。`, `Could not read the saved workflow settings: ${draftError}. So as not to overwrite them, no new settings are made yet; this retries when the connection is back.`)}</div>
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
  // No provider signed in at all (a new chat): one empty state says so and leads to signing in; the notes that would say
  // the same give way, and the roles summary says nothing can be assigned instead of naming providers.
  // Not while sign-ins are still being checked (each start checks them again) or one could not be read: that would flash
  // the empty state, or keep it for a provider that may well be signed in.
  const checkingProviders = providers.some((p) => p.auth.state === 'checking' || (p.installed && p.auth.state === 'unknown'));
  const noProvider = !run && providers.length > 0 && !checkingProviders && !providers.some((p) => p.installed && p.auth.state === 'logged_in');
  const unassigned = !run && !checkingProviders && (noProvider || (isAuto(shown) && !!preview.error));
  // A new chat offers the folders of the latest conversations, one click each (from the chat list: nothing new is kept).
  const recent = run ? [] : recentFolders(threads, shown.cwd);
  const missing = !run && !noProvider && !isAuto(shown) ? missingProviders(shown, providers) : [];
  // The header's state: what the workflow waits for from you when it does (an answer, an approval, a decision), else its
  // state; an icon and a short word, coloured only while it runs, waits for you, missed its goal or failed.
  const head = run
    ? (() => {
        const k = waitKind(run);
        if (k) return { word: waitWord(t, k), cls: 'warn', icon: WAIT_ICON[k], spin: false };
        const st = wfStatus(t, run.status);
        return { word: st.label, cls: st.cls, icon: STATUS_ICON[run.status], spin: run.status === 'running' };
      })()
    : null;
  // How long it ran (to its end, or so far), in words; when it started and ended in the tooltip. An interrupted one (the
  // app closed while it ran) counts to when it was interrupted, never on to now.
  const end = run ? (run.endedAt ?? (run.status === 'interrupted' ? (run.interruptedAt ?? run.updatedAt) : undefined)) : undefined;
  const took = run ? duration(t, run.createdAt, end, 1) : '';
  const tookS = run ? Math.max(0, Math.round(((end ?? Date.now()) - run.createdAt) / 1000)) : 0;
  const when = run
    ? end
      ? run.endedAt
        ? t(`開始 ${fullTime(run.createdAt)}，結束 ${fullTime(end)}`, `Started ${fullTime(run.createdAt)}, ended ${fullTime(end)}`)
        : t(`開始 ${fullTime(run.createdAt)}，中斷 ${fullTime(end)}`, `Started ${fullTime(run.createdAt)}, interrupted ${fullTime(end)}`)
      : t(`開始 ${fullTime(run.createdAt)}`, `Started ${fullTime(run.createdAt)}`)
    : '';
  const title = run ? (thread?.title ?? run.config.title) : '';
  const stopRun = async () => {
    if (run && (await confirmStop(t))) hub.call('workflows.cancel', { id: run.id }).catch((e) => setError((e as Error).message));
  };
  const deleteRun = async () => {
    if (run && (await deleteConversation(t, thread?.ids ?? [run.id]))) navigate('new');
  };
  // A failure is said once: when a turn's error line already gives it whole, the end of the chat does not repeat it (the
  // record line 「工作流失敗」 says the state there; without that line, a note with the word does).
  const failure = run?.status === 'failed' ? run.error?.trim() : undefined;
  const failureInTurn = !!run && !!failure && Object.values(run.agents).some((a) => !a.parentId && a.status === 'failed' && !!a.error && a.error.includes(failure));
  const failureLine = items.some((it) => it.type === 'divider' && it.line.tone === 'failed');

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
      {!run && !noProvider && preview.error && <div className="note warn">{preview.error}</div>}
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
        onStop={() => void stopRun()}
        unassigned={unassigned}
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
                ? t('已暫停，可以補充說明後按繼續', 'Paused: add a note if you like, then resume')
                : t('agent 正在工作，訊息會立刻交給它們', 'Agents are working; a message goes to them right away')
            : run
              ? t('接著要做什麼？', 'What next?')
              : t('描述要完成的任務…', 'Describe the task…')
        }
      />
    </>
  );

  // Deleted while open (here or in another window): said so, with nothing left to act on, and a way out.
  if (id && deleted && !run)
    return (
      <div className="chat">
        <div className="chat-deleted">
          <div className="note warn" role="status">
            {t('這段對話已刪除，可能是在另一個視窗刪的，不能再接續或操作。', 'This chat was deleted, perhaps in another window: it cannot be continued or changed.')}
          </div>
          <button className="btn primary" onClick={() => navigate('new')}>
            {t('開新對話', 'Start a new chat')}
          </button>
        </div>
      </div>
    );

  return (
    <div className="chat">
      {run && (
        <>
        {/* One row: the title (cut first, two lines at most in a narrow column; F2 or a double click renames it), its
            state in an icon and a word, how long it ran (the first to go when room runs out, still in the title's
            tooltip and read out); then the agent map, ⋯ (rename, the records, delete) and 停止 while it runs. */}
        <header className="topbar">
          <div className="topbar-title">
            {renaming ? (
              <RenameInput id={run.id} title={title} onDone={() => setRenaming(false)} className="title-rename" />
            ) : (
              <h1
                ref={titleRef}
                className="title-text"
                tabIndex={0}
                title={[title, [head!.word, took].filter(Boolean).join(' · '), t('按 F2 或連按兩下重新命名', 'F2 or a double click renames it')].join('\n')}
                onDoubleClick={() => setRenaming(true)}
                onKeyDown={(e) => {
                  if (e.key === 'F2') {
                    e.preventDefault();
                    setRenaming(true);
                  }
                }}
              >
                {title}
              </h1>
            )}
            <span className={cx('status', head!.cls)} aria-live="polite">
              <Ico i={head!.icon} size={14} className={head!.spin ? 'spin' : undefined} /> {head!.word}
            </span>
            {took && (
              <time className="run-time" dateTime={`PT${tookS}S`} title={when}>
                {took}
              </time>
            )}
          </div>
          <div className="topbar-actions">
            <AgentMapButton run={run} thread={earlier.length > 0} onOpen={() => setAgentMap(true)} />
            <RunMenu run={run} providers={providers} onRename={() => setRenaming(true)} onDelete={active ? undefined : () => void deleteRun()} />
            {active && (
              <button className="btn small danger" onClick={() => void stopRun()}>
                {t('停止', 'Stop')}
              </button>
            )}
          </div>
        </header>
        {/* The folder this chat works in, whole: it never follows the window it is viewed from. */}
        <CwdBar run={run} />
        </>
      )}

      {!run ? (
        // A new chat: a working header at the column's left, not a greeting. Its title, then (with no provider signed in)
        // the one thing to do first, the composer, and the providers in one line.
        <div className="home">
          <div className="home-col">
            <h1 className="home-title">{t('新對話', 'New chat')}</h1>
            {noProvider && (
              <div className="home-empty">
                <span className="home-empty-text">
                  <Ico i={LogIn} size={16} /> {t('還沒有登入任何供應商', 'No provider is signed in yet')}
                </span>
                <a className="btn primary" href="#/settings/providers">
                  {t('前往登入', 'Sign in')}
                </a>
              </div>
            )}
            <div className="home-composer">{composer}</div>
            {recent.length > 0 && (
              <div className="home-recent" role="group" aria-labelledby="home-recent-label">
                <span className="home-recent-label" id="home-recent-label">
                  {t('最近的資料夾', 'Recent folders')}
                </span>
                {recent.map((dir) => (
                  <button key={dir} type="button" className="home-recent-btn" title={dir} onClick={() => updateDraft({ ...shown, cwd: dir })}>
                    <Ico i={Folder} size={14} />
                    <bdi className="home-recent-name">{folderName(dir)}</bdi>
                  </button>
                ))}
              </div>
            )}
            {!noProvider && <ProviderLine providers={providers} />}
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
                          <Ico i={Pencil} size={12} /> {t('這是編輯後重新送出的版本', 'This is the edited, re-sent version')} ·{' '}
                          <a href={`#/run/${run.config.replaces}`}>{t('查看原版本', 'See the original')}</a>
                        </div>
                      )}
                      <UserMessage run={run} text={it.text} active={active} config={runDraft ? { ...run.config, ...runDraft } : run.config} />
                      {run.replacedBy && (
                        <div className="note small edit-link">
                          {t('這則訊息已編輯並重新送出。', 'This message was edited and re-sent.')} <a href={`#/run/${run.replacedBy}`}>{t('前往新版本', 'Go to the new version')}</a>
                        </div>
                      )}
                      {run.assignment && (
                        <details className="assign-card">
                          <summary><Ico i={Shuffle} size={14} /> {t('自動指派', 'Auto assignment')}</summary>
                          {run.assignment.notes.map((n, i) => (
                            <div key={i}>{n}</div>
                          ))}
                        </details>
                      )}
                    </div>
                  );
                if (it.type === 'divider') return <ChatLineView key={it.key} line={it.line} />;
                return <AgentTurn key={it.key} run={run} agent={it.agent} providers={providers} />;
              })}
              <FinalResult run={run} providers={providers} />
              <ReviewResult run={run} providers={providers} />
              {/* The files, one quiet row right under the result. */}
              <Outputs run={run} onImage={setLightbox} />
              <DeniedActions run={run} providers={providers} />
              <OutsideChanges run={run} />
              <Approvals run={run} providers={providers} unclaimed />
              <WorktreeCard run={run} />
              <ContextAsk run={run} providers={providers} />
              <CompactFailedAsk run={run} providers={providers} />
              {run.pending && (run.pending.question ? <Question key={run.pending.id} run={run} d={run.pending} /> : <Decision key={run.pending.id} run={run} d={run.pending} />)}
              {failure && !failureInTurn && <div className="note err">{run.error}</div>}
              {failure && failureInTurn && !failureLine && (
                <div className="note err">
                  <Ico i={CircleX} size={14} /> {t('工作流失敗', 'Workflow failed')}
                </div>
              )}
              {run.status === 'incomplete' && (
                <div className="note warn">
                  {t(`未完成：${run.incompleteReason ?? '目標沒有達成'}。可以在下方輸入訊息，用相同設定接續。`, `Incomplete: ${run.incompleteReason ?? 'the goal was not met'}. Send a message below to continue with the same setup.`)}
                </div>
              )}
              {run.dryRun && run.preflight && <PreflightList items={run.preflight} showOk />}
              {run.status === 'cancelled' &&
                Object.values(run.stages).some((s) => s?.status === 'cancelled') &&
                !summaries.some((s) => (s.threadId ?? s.id) === threadKey && s.createdAt > run.createdAt) && (
                  <div className="note">
                    {t('這個工作流已停止。按「接續原工作流」會從停下的階段與輪次繼續，計畫、步驟進度、審查與共用上下文都保留。在下方送出新訊息會用相同設定開始下一段工作流，之後就不能再接續這一個。', 'This workflow was stopped. "Resume this workflow" continues it from the stage and round it stopped in, keeping the plan, step progress, reviews and shared context. A new message below starts the next workflow with the same setup, after which this one can no longer be resumed.')}
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
                    ? t('這個工作流在 Aivenue 重新啟動前已暫停，例如更新時。按「繼續」會從暫停的地方接著做，計畫、步驟進度、審查與共用上下文都保留。', 'This workflow was paused before Aivenue restarted, for example for an update. Continue picks up where it was paused; the plan, step progress, reviews and shared context are kept.')
                    : run.interruptedFrom
                      ? t('Aivenue 重新啟動時這個工作流仍在執行，已中斷，例如更新時。按「接續」會從中斷的階段與輪次接著做，計畫、步驟進度、審查與共用上下文都保留。', 'Aivenue restarted, for example for an update, while this workflow ran, so it was interrupted. Resume picks up from the stage and round it stopped in; the plan, step progress, reviews and shared context are kept.')
                      : t('Aivenue 關閉時這個工作流仍在執行，已中斷。可以在下方輸入訊息，用相同設定接續。', 'Aivenue was closed while this workflow ran, so it was interrupted. Send a message below to continue with the same setup.')}
                  {(run.waits ?? []).some((w) => w.state === 'waiting' && w.timeoutAt > Date.now()) &&
                    t(
                      ` 中斷時有 ${(run.waits ?? []).filter((w) => w.state === 'waiting').length} 個條件在等待：${(run.waits ?? []).filter((w) => w.state === 'waiting').map((w) => w.check.slice(0, 40)).join('、')}。接續時會交給 agent 用同一個 wait_id 繼續等，原本的逾時時間不變。`,
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
          </div>
          <div className="dock">
            <div className="column">
              {/* Back to the newest entries: a small button at the thread's right edge, above the input, never over the
                  text (it takes a line of its own while the reader is away from the end). */}
              {away && (
                <div className="to-latest-row">
                  <button type="button" className="to-latest" onClick={toLatest}>
                    <Ico i={ArrowDown} size={14} /> {t('回到最新', 'Back to latest')}
                  </button>
                </div>
              )}
              <ProgressPanel key={run.id} run={run} providers={providers} resultShown={resultShown(run)} />
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
                  '這段對話正在執行，改動在下一個開始的 agent 回合生效，按「立即重新派發」可馬上生效。模型、推理強度、權限、驗收與限制在下一個開始的 agent 回合生效，正在工作的 agent 不受影響。Skill 與角色指示要新開的對話才生效，接續中的對話不重送。按「立即重新派發」時，受影響的 agent 會停下並用新設定重新派發。你中途送出的訊息會立即送到正在工作的 agent。',
                  'This conversation is running: changes apply from the next agent turn that starts, or now with "Re-dispatch now". Model, effort, permission, verification and limits apply from the next agent turn that starts; working agents keep theirs. Skills and role instructions apply to new conversations; a continued one is not sent them again. "Re-dispatch now" has affected agents stop and re-dispatch with the new settings. Messages you send mid-run reach the working agents right away.',
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
    t('查看所有 agent 與子 agent：誰、用什麼模型、正在做什麼', 'See every agent and sub-agent: who, which model, what it is doing'),
    helpers.length ? t(`這則訊息的子 agent 與顧問：${running} 個執行中，共 ${helpers.length} 個`, `Sub-agents and advisors in this message: ${running} running of ${helpers.length}`) : '',
    procs.length ? t(`背景程序：${alive} 個執行中，共 ${procs.length} 個`, `Background processes: ${alive} running of ${procs.length}`) : '',
  ]
    .filter(Boolean)
    .join('\n');
  // A narrow header keeps its icon (under 400px not the numbers either); the name and the numbers stay in the tooltip
  // and for screen readers.
  return (
    <button className="btn small am-open" onClick={onOpen} title={title}>
      <Ico i={Network} size={14} />
      {running > 0 && <span className="am-dot live" aria-hidden="true" />}
      <span className="am-open-label">{t('分工圖', 'Agent map')}</span>
      {running > 0 && <span className="am-open-count muted">· {running}</span>}
      {alive > 0 && (
        <span className="am-open-count muted">
          <Ico i={Activity} size={14} /> {alive}
        </span>
      )}
    </button>
  );
}
