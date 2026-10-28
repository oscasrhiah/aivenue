import { useState } from 'react';
import type { AgentEvent, Attachment } from '../../../core/src/types';
import { useT, type T } from '../i18n';
import { clock, cx, fmtTokens } from '../util';
import { Markdown } from './Markdown';
import { Clamp } from './Clamp';
import { extensionUse } from '../extensionUse';

function toolVerb(t: T, e: AgentEvent): string {
  const tool = e.tool!;
  switch (tool.category) {
    case 'read':
      return 'Read';
    case 'edit':
      return tool.name === 'apply_patch' ? 'Patch' : /write|create/i.test(tool.name) ? 'Write' : 'Edit';
    case 'command':
      return 'Bash';
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

function ToolLine({ e }: { e: AgentEvent }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const tool = e.tool!;
  const pv = tool.status === 'error' ? preview(tool.output, 3) : preview(tool.output, tool.category === 'command' ? 2 : 1);
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
            <span className="tl-verb">{toolVerb(t, e)}</span>
            <span className="tl-arg">{tool.title}</span>
          </>
        )}
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
          {tool.input && <pre>{tool.input}</pre>}
          {tool.output && <pre>{tool.output}</pre>}
        </div>
      )}
    </div>
  );
}

function Line({ e, raw }: { e: AgentEvent; raw: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  switch (e.kind) {
    case 'tool':
      return <ToolLine e={e} />;
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
}

export function Transcript({ events, raw = false, limit, said = [] }: { events: AgentEvent[]; raw?: boolean; limit?: number; said?: SaidMessage[] }) {
  const t = useT();
  const shown: ({ said: SaidMessage; ts: number } | { e: AgentEvent; ts: number })[] = [...visible(events, raw).map((e) => ({ e, ts: e.ts })), ...said.map((m) => ({ said: m, ts: m.ts }))].sort((a, b) => a.ts - b.ts);
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
          </div>
        ) : (
          <div key={it.e.seq} title={clock(it.e.ts)}>
            <Line e={it.e} raw={raw} />
          </div>
        ),
      )}
    </div>
  );
}
