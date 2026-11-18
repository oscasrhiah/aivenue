import { Fragment, useMemo, type ReactNode } from 'react';
import { useT } from '../i18n';
import { inline, parseMarkdown, type Block, type Inline } from '../markdown';
import { CopyButton } from './CopyButton';

/** A code block's copy button: the block's text only, as written (no fence, no language line). */
function CodeCopy({ code }: { code: string }) {
  const t = useT();
  return <CopyButton text={code} label={t('複製程式碼', 'Copy code')} icon className="code-copy" />;
}

/** Inline content as React elements (never innerHTML: an agent's text cannot inject markup). */
function renderInline(c: Inline[], key: string): ReactNode[] {
  return c.map((n, i) => {
    const k = `${key}.${i}`;
    switch (n.t) {
      case 'text':
        return <Fragment key={k}>{n.v}</Fragment>;
      case 'code':
        return <code key={k}>{n.v}</code>;
      case 'strong':
        return <strong key={k}>{renderInline(n.c, k)}</strong>;
      case 'em':
        return <em key={k}>{renderInline(n.c, k)}</em>;
      case 'del':
        return <del key={k}>{renderInline(n.c, k)}</del>;
      case 'br':
        return <br key={k} />;
      case 'link':
        return n.local ? (
          // A file or other local target: its text, the target on hover (not a link the page could follow).
          <span key={k} className="md-ref" title={n.href}>
            {renderInline(n.c, k)}
          </span>
        ) : (
          <a key={k} href={n.href} target="_blank" rel="noreferrer">
            {renderInline(n.c, k)}
          </a>
        );
    }
  });
}

function renderBlocks(blocks: Block[], key: string, tight = false): ReactNode[] {
  return blocks.map((b, i) => {
    const k = `${key}-${i}`;
    switch (b.t) {
      case 'p':
        // A list item's single paragraph is its text, without a paragraph's spacing.
        return tight ? <Fragment key={k}>{renderInline(b.c, k)}</Fragment> : <p key={k}>{renderInline(b.c, k)}</p>;
      case 'h':
        return (
          <div key={k} className={`md-h md-h${Math.min(b.level, 4)}`} role="heading" aria-level={b.level}>
            {renderInline(b.c, k)}
          </div>
        );
      case 'code':
        return (
          <div key={k} className="md-code">
            <pre data-lang={b.lang}>
              <code>{b.v}</code>
            </pre>
            <CodeCopy code={b.v} />
          </div>
        );
      case 'hr':
        return <hr key={k} />;
      case 'quote':
        return <blockquote key={k}>{renderBlocks(b.c, k)}</blockquote>;
      case 'list': {
        const items = b.items.map((it, j) => {
          const only = it.c.length === 1 && it.c[0].t === 'p';
          return (
            <li key={`${k}.${j}`} className={it.task ? 'md-task' : undefined}>
              {it.task && <input type="checkbox" checked={!!it.checked} disabled readOnly aria-label={it.checked ? 'done' : 'not done'} />}
              {renderBlocks(it.c, `${k}.${j}`, only)}
            </li>
          );
        });
        return b.ordered ? (
          <ol key={k} start={b.start}>
            {items}
          </ol>
        ) : (
          <ul key={k} className={b.items.some((it) => it.task) ? 'md-tasks' : undefined}>
            {items}
          </ul>
        );
      }
      case 'table':
        // Wider than its place: it scrolls sideways inside its own box, the page does not.
        return (
          <div key={k} className="md-table" role="region" tabIndex={0} aria-label="table">
            <table>
              <thead>
                <tr>
                  {b.head.map((c, j) => (
                    <th key={j} style={b.align[j] ? { textAlign: b.align[j] } : undefined}>
                      <div className="md-cell">{renderInline(c, `${k}.h${j}`)}</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {b.rows.map((r, ri) => (
                  <tr key={ri}>
                    {r.map((c, j) => (
                      <td key={j} style={b.align[j] ? { textAlign: b.align[j] } : undefined}>
                        <div className="md-cell">{renderInline(c, `${k}.${ri}.${j}`)}</div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

/**
 * Markdown as agents write it: paragraphs (every line break kept), headings, lists (nested, numbered from where they
 * start, task lists), code blocks (also inside list items), quotes, rules, tables, emphasis, strikethrough, links.
 * Parsed by ../markdown.ts; drawn as React elements only.
 */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div className={`md ${className ?? ''}`}>{renderBlocks(blocks, 'b')}</div>;
}

/** One line of an agent's text with its inline formatting (code, bold, links), no paragraphs around it. */
export function InlineMarkdown({ text }: { text: string }) {
  return <>{renderInline(inline(text), 'i')}</>;
}
