import { Fragment, type ReactNode } from 'react';

/** Inline: `code`, **bold**, *italic*, [text](url) — rendered as React elements (never innerHTML). */
function inline(text: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\s][^*\n]*\*)|(\[[^\]\n]+\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${i++}`;
    if (m[1]) out.push(<code key={k}>{m[1].slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={k}>{m[2].slice(2, -2)}</strong>);
    else if (m[3]) out.push(<em key={k}>{m[3].slice(1, -1)}</em>);
    else if (m[4])
      out.push(
        <a key={k} href={m[5]} target="_blank" rel="noreferrer">
          {m[4].slice(1, m[4].indexOf(']'))}
        </a>,
      );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

type Block = { kind: 'p' | 'h' | 'ul' | 'ol' | 'code' | 'quote'; lines: string[]; level?: number };

function blocks(src: string): Block[] {
  const out: Block[] = [];
  const lines = src.replace(/\r/g, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) body.push(lines[i]);
      out.push({ kind: 'code', lines: body });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push({ kind: 'h', level: Math.min(h[1].length, 4), lines: [h[2]] });
      continue;
    }
    const prev = out[out.length - 1];
    if (/^\s*[-*•]\s+/.test(line)) {
      const item = line.replace(/^\s*[-*•]\s+/, '');
      if (prev?.kind === 'ul') prev.lines.push(item);
      else out.push({ kind: 'ul', lines: [item] });
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      const item = line.replace(/^\s*\d+[.)]\s+/, '');
      if (prev?.kind === 'ol') prev.lines.push(item);
      else out.push({ kind: 'ol', lines: [item] });
      continue;
    }
    if (/^>\s?/.test(line)) {
      if (prev?.kind === 'quote') prev.lines.push(line.replace(/^>\s?/, ''));
      else out.push({ kind: 'quote', lines: [line.replace(/^>\s?/, '')] });
      continue;
    }
    if (!line.trim()) {
      out.push({ kind: 'p', lines: [] });
      continue;
    }
    if (prev?.kind === 'p' && prev.lines.length) prev.lines.push(line);
    else out.push({ kind: 'p', lines: [line] });
  }
  return out.filter((b) => b.kind !== 'p' || b.lines.length);
}

/** Small, safe Markdown renderer for agent messages and plans. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={`md ${className ?? ''}`}>
      {blocks(text).map((b, i) => {
        switch (b.kind) {
          case 'code':
            return <pre key={i}>{b.lines.join('\n')}</pre>;
          case 'h':
            return (
              <div key={i} className={`md-h md-h${b.level}`}>
                {inline(b.lines[0], i)}
              </div>
            );
          case 'ul':
            return (
              <ul key={i}>
                {b.lines.map((l, j) => (
                  <li key={j}>{inline(l, i * 100 + j)}</li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={i}>
                {b.lines.map((l, j) => (
                  <li key={j}>{inline(l, i * 100 + j)}</li>
                ))}
              </ol>
            );
          case 'quote':
            return <blockquote key={i}>{inline(b.lines.join('\n'), i)}</blockquote>;
          default:
            return (
              <p key={i}>
                {b.lines.map((l, j) => (
                  <Fragment key={j}>
                    {j > 0 && <br />}
                    {inline(l, i * 100 + j)}
                  </Fragment>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}
