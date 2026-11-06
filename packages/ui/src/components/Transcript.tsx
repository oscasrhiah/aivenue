import { useState } from 'react';
import type { AgentEvent, Attachment } from '../../../core/src/types';
import { useT, type T } from '../i18n';
import { clock, cx, elapsed, fmtTokens } from '../util';
import { actKind, errorPreview, feed, groupLabel, groupNames, isInternal, isSubmissionText, preview as feedPreview, shortTitle, type FeedItem } from '../timeline';
import { Markdown } from './Markdown';
import { Clamp } from './Clamp';
import { Replies, type Reply } from './Replies';
import { extensionUse } from '../extensionUse';

function toolVerb(t: T, e: AgentEvent): string {
  const tool = e.tool!;
  switch (tool.category) {
    case 'read':
      return 'Read';
    case 'edit':
      return tool.name === 'apply_patch' ? 'Patch' : /write|create/i.test(tool.name) ? 'Write' : 'Edit';
    case 'command':
      // Which shell ran it is not in the event (Codex reports PowerShell commands the same way): a terminal command.
      return t('終端', 'Terminal');
    case 'search':
      return 'Search';
    case 'web':
      return 'Web';
    case 'hub':
      return 'Aivenue';
    case 'agent':
      return 'Task';
    case 'todo':
      return t('待辦', 'Todo');
    default:
      return tool.name;
  }
}

/** First lines of a tool result, like Claude Code's "⎿" preview. */
function preview(out: string | undefined, lines = 2): string | undefined {
  if (!out) return undefined;
  const all = out.replace(/\r/g, '').split('\n').filter((l) => l.trim());
  if (!all.length) return undefined;
  const head = all.slice(0, lines).map((l) => (l.length > 160 ? l.slice(0, 157) + '…' : l));
  return all.length > lines ? `${head.join('\n')}\n… +${all.length - lines} lines` : head.join('\n');
}

/** Which lines the reader opened, kept above the lines themselves so new events coming in do not close them. */
export interface Opened {
  has: (key: string) => boolean;
  toggle: (key: string) => void;
}
export function useOpened(): Opened {
  const [set, setSet] = useState<Set<string>>(() => new Set());
  return { has: (k) => set.has(k), toggle: (k) => setSet((s) => (s.has(k) ? new Set([...s].filter((x) => x !== k)) : new Set([...s, k]))) };
}

function ToolLine({ e, opened }: { e: AgentEvent; opened?: Opened }) {
  const t = useT();
  const [own, setOwn] = useState(false);
  const key = `t${e.seq}`;
  const open = opened ? opened.has(key) : own;
  const setOpen = (v: boolean) => (opened ? opened.toggle(key) : setOwn(v));
  const tool = e.tool!;
  // A plain shell command is a terminal command: reading or searching is said only when the event says so.
  const kind = actKind(e);
  // A failure shows its message (and actual / expected) first; the stack is behind the click.
  const err = tool.status === 'error' ? errorPreview(tool.output, 3) : [];
  const total = (tool.output ?? '').replace(/\r/g, '').split('\n').filter((l) => l.trim()).length;
  const pv = tool.status === 'error' ? (err.length ? `${err.join('\n')}${total > err.length ? `\n… ${t(`共 ${total} 行，點一下看全部`, `${total} lines in all: click for all`)}` : ''}` : undefined) : preview(tool.output, tool.category === 'command' ? 2 : 1);
  const use = extensionUse(e);
  const action = (a: string) => ({ update: t('建立／更新圖譜', 'build / update the graph'), query: t('查詢', 'query'), path: t('找關聯', 'path'), explain: t('解釋', 'explain') })[a] ?? a;
  return (
    <div className={cx('tl', tool.status, use && 'tl-ext')}>
      <div className="tl-head" onClick={() => setOpen(!open)}>
        <span className={cx('tl-dot', tool.status)}>⏺</span>
        {use?.kind === 'skill' ? (
          <>
            <span className="tl-verb">🧰 {t('使用技能', 'Skill')}</span>
            <span className="tl-arg">{use.name}</span>
          </>
        ) : use?.kind === 'graphify' ? (
          <>
            <span className="tl-verb">🕸️ Graphify</span>
            <span className="tl-arg">
              {action(use.action)}
              {use.arg && use.action !== 'update' ? ` "${use.arg}"` : ''}
            </span>
          </>
        ) : (
          <>
            <span className="tl-verb" title={kind === 'command' ? t('終端指令', 'Terminal command') : undefined}>
              {toolVerb(t, e)}
            </span>
            <span className="tl-arg">{shortTitle(tool.title)}</span>
          </>
        )}
        {/* The call that runs now, in place: it turns into ok / failed here when it ends. */}
        {tool.status === 'running' && <span className="tl-running">{t('執行中', 'running')} · {elapsed(e.ts)}</span>}
      </div>
      {/* Only the first line by default (the command or file); output on click, except an error's first lines. */}
      {!open && pv && tool.status === 'error' && (
        <div className="tl-out">
          <span className="tl-elbow">⎿</span>
          <pre>{pv}</pre>
        </div>
      )}
      {open && (
        <div className="tl-detail">
          {/* The command exactly as it ran, then everything it printed. */}
          {(tool.title.length > 160 || tool.title.includes('\n')) && tool.title !== tool.input && <pre>{tool.title}</pre>}
          {tool.input && <pre>{tool.input}</pre>}
          {tool.output ? <pre>{tool.output}</pre> : <div className="muted tiny">{t('（沒有輸出）', '(no output)')}</div>}
        </div>
      )}
    </div>
  );
}

function Line({ e, raw, opened }: { e: AgentEvent; raw: boolean; opened?: Opened }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  switch (e.kind) {
    case 'tool':
      return <ToolLine e={e} opened={opened} />;
    case 'message':
      // Long narration folds: the card's result block carries what counts.
      return !raw && (e.text?.length ?? 0) > 600 ? (
        <Clamp height={150} more={t('展開這段說明', 'Show the rest')}>
          <Markdown className="tx-text" text={e.text ?? ''} />
        </Clamp>
      ) : (
        <Markdown className="tx-text" text={e.text ?? ''} />
      );
    case 'thinking':
      return (
        <div className="tx-think" onClick={() => setOpen(!open)}>
          <span>∴ {t('思考', 'Thinking')}</span>
          {open && <div className="tx-think-body">{e.text}</div>}
        </div>
      );
    case 'error':
      return <div className="tx-err">✕ {e.text}</div>;
    case 'prompt':
      return raw ? (
        <div className="tx-raw" onClick={() => setOpen(!open)}>
          › {t('指示（提示詞）', 'Instructions (prompt)')} {open ? '' : '…'}
          {open && <pre>{e.text}</pre>}
        </div>
      ) : null;
    case 'session':
      return raw ? <div className="tx-raw">› session {e.sessionId ?? ''} {e.text ? `· ${e.text}` : ''}</div> : null;
    case 'info':
      if (e.usage) return raw ? <div className="tx-raw">› tokens in {fmtTokens(e.usage.input ?? 0)} · cached {fmtTokens(e.usage.cached ?? 0)} · out {fmtTokens(e.usage.output ?? 0)}</div> : null;
      return raw ? <div className="tx-raw">› {e.text}</div> : null;
    case 'stderr':
      return raw ? <div className="tx-raw mono">{e.text}</div> : null;
    case 'result':
      return null;
  }
  return null;
}

/** Visible items of a transcript (raw lines only when requested). */
export function visible(events: AgentEvent[], raw: boolean): AgentEvent[] {
  return events.filter((e) => raw || e.kind === 'tool' || e.kind === 'message' || e.kind === 'thinking' || e.kind === 'error');
}

/** A message the user sent while this agent worked, shown where it arrived among the agent's steps. */
export interface SaidMessage {
  ts: number;
  text: string;
  attachments?: Attachment[];
  replies?: Reply[];
  planUpdated?: boolean;
}

/** A folded run of routine calls ("Read 3 files"): each call behind it on click. */
function GroupLine({ item, opened }: { item: Extract<FeedItem, { type: 'group' }>; opened?: Opened }) {
  const t = useT();
  const [own, setOwn] = useState(false);
  const key = `g${item.events[0].seq}`;
  const open = opened ? opened.has(key) : own;
  const names = groupNames(item.kind, item.events.map((e) => e.tool!.title));
  return (
    <div className="tl ok tl-group">
      <div className="tl-head" onClick={() => (opened ? opened.toggle(key) : setOwn(!own))}>
        <span className="tl-dot ok">⏺</span>
        <span className="tl-verb">{groupLabel(t, item.kind, item.events.length)}</span>
        {!open && <span className="tl-arg">{names.slice(0, 3).join(', ')}{names.length > 3 ? ' …' : ''}</span>}
      </div>
      {open && (
        <div className="tl-group-list">
          {item.events.map((e) => (
            <ToolLine key={e.seq} e={e} opened={opened} />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * A working agent's recent activity, the default view: routine calls of one kind folded into a line, what it said,
 * and failures and running calls one by one — a failure stays here however much comes after it.
 */
export function LiveFeed({ events, said = [], limit = 6, hideMessages = false }: { events: AgentEvent[]; said?: SaidMessage[]; limit?: number; hideMessages?: boolean }) {
  const t = useT();
  // What the reader opened stays open, and stays in the list, however many events come after it. From the moment they
  // open one, nothing above it is folded away either (the list only grows below), so the line does not move.
  const own = useOpened();
  const [since, setSince] = useState<number>();
  // Aivenue's own calls (records, progress, the submission) are in the activity log, not here.
  const items = feed(events.filter((e) => !isInternal(e))).filter((it) => !(hideMessages && it.type === 'event' && it.e.kind === 'message'));
  const seqOf = (it: FeedItem) => (it.type === 'group' ? it.events[0].seq : it.e.seq);
  const shown = feedPreview(items, limit, (it) => (since !== undefined && seqOf(it) >= since) || (it.type === 'group' ? own.has(`g${it.events[0].seq}`) || it.events.some((e) => own.has(`t${e.seq}`)) : own.has(`t${it.e.seq}`)));
  const opened: Opened = {
    has: own.has,
    toggle: (k) => {
      if (since === undefined && shown.length) setSince(seqOf(shown[0].item));
      own.toggle(k);
    },
  };
  const ts = (it: FeedItem) => (it.type === 'group' ? it.events[0].ts : it.e.ts);
  const rows: ({ said: SaidMessage; ts: number } | { item: FeedItem; skipped: number; ts: number })[] = [
    ...shown.map((s) => ({ ...s, ts: ts(s.item) })),
    // What the user sent while it worked stays where it arrived.
    ...said.map((m) => ({ said: m, ts: m.ts })),
  ].sort((a, b) => a.ts - b.ts);
  return (
    <div className="tx">
      {rows.map((r, i) =>
        'said' in r ? (
          <div key={`said${r.ts}${i}`} className="tx-said" title={clock(r.ts)}>
            <span className="tx-said-who">👤 {t('你（執行中追加）', 'You (sent while working)')}</span>
            {r.said.text && <div className="tx-said-text">{r.said.text}</div>}
            <Replies replies={r.said.replies} planUpdated={r.said.planUpdated} />
          </div>
        ) : (
          <div key={r.item.type === 'group' ? `g${r.item.events[0].seq}` : r.item.e.seq} title={clock(r.ts)}>
            {r.skipped > 0 && <div className="tx-gap muted tiny">… {t(`另外 ${r.skipped} 項`, `${r.skipped} more`)}</div>}
            {r.item.type === 'group' ? (
              <GroupLine item={r.item} opened={opened} />
            ) : r.item.e.kind === 'message' && isSubmissionText(r.item.e.text) ? (
              <div className="tx-text muted small">{t('（送出了結果，內容見下方）', '(handed in its result: see below)')}</div>
            ) : (
              <Line e={r.item.e} raw={false} opened={opened} />
            )}
          </div>
        ),
      )}
    </div>
  );
}

/**
 * An agent's whole log, in the order things happened: what it read, changed and ran (each command with its output
 * behind a click) and what it said. Aivenue's own calls (records, progress, the submission) are left out unless
 * `internal` or `raw`: the activity log lists them apart.
 */
export function Transcript({ events, raw = false, limit, said = [], internal = false }: { events: AgentEvent[]; raw?: boolean; limit?: number; said?: SaidMessage[]; internal?: boolean }) {
  const t = useT();
  const opened = useOpened();
  const shown: ({ said: SaidMessage; ts: number } | { e: AgentEvent; ts: number })[] = [...visible(events, raw).filter((e) => raw || internal === isInternal(e)).map((e) => ({ e, ts: e.ts })), ...(internal ? [] : said.map((m) => ({ said: m, ts: m.ts })))].sort((a, b) => a.ts - b.ts);
  // The last steps only, but never hide what the user sent in between.
  const items = limit ? shown.filter((it, i) => i >= shown.length - limit || 'said' in it) : shown;
  return (
    <div className="tx">
      {items.map((it, i) =>
        'said' in it ? (
          <div key={`said${it.ts}${i}`} className="tx-said" title={clock(it.ts)}>
            <span className="tx-said-who">👤 {t('你（執行中追加）', 'You (sent while working)')}</span>
            {it.said.text && <div className="tx-said-text">{it.said.text}</div>}
            {!!it.said.attachments?.length && <div className="muted tiny">📎 {it.said.attachments.map((a) => a.name).join('、')}</div>}
            <Replies replies={it.said.replies} planUpdated={it.said.planUpdated} />
          </div>
        ) : (
          <div key={it.e.seq} title={clock(it.e.ts)}>
            <Line e={it.e} raw={raw} opened={opened} />
          </div>
        ),
      )}
    </div>
  );
}
