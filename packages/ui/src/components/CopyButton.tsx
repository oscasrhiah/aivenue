import { Check, CircleX, Copy } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { copyText } from '../clipboard';
import { Ico } from '../icons';
import { useT } from '../i18n';
import { cx } from '../util';

/**
 * A copy button: a real button (its name is `label`; Tab, Enter and Space work), that says "Copied" only once the text
 * is on the clipboard and "Copy failed" with why otherwise; both are also announced to screen readers. `text` may be a
 * function, read when pressed. `icon`: the icon alone shows, the label stays its name and tooltip.
 */
export function CopyButton({ text, label, className, icon }: { text: string | (() => string); label: string; className?: string; icon?: boolean }) {
  const t = useT();
  const [state, setState] = useState<'idle' | 'copying' | 'copied' | 'failed'>('idle');
  const [why, setWhy] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const press = async () => {
    clearTimeout(timer.current);
    setState('copying');
    let ok = false;
    try {
      await copyText(typeof text === 'function' ? text() : text);
      ok = true;
      setState('copied');
    } catch (e) {
      setWhy((e as Error).message);
      setState('failed');
    }
    timer.current = setTimeout(() => setState('idle'), ok ? 2000 : 6000);
  };
  const shown = state === 'copied' ? t('已複製', 'Copied') : state === 'failed' ? t('複製失敗', 'Copy failed') : label;
  return (
    <button
      type="button"
      className={cx('copy-btn', icon && 'icon-only', state, className)}
      onClick={press}
      disabled={state === 'copying'}
      aria-label={label}
      title={state === 'failed' ? t(`複製失敗：${why}`, `Copy failed: ${why}`) : label}
    >
      <Ico i={state === 'copied' ? Check : state === 'failed' ? CircleX : Copy} size={13} />
      {(!icon || state !== 'idle') && <span className="copy-label">{shown}</span>}
      <span className="sr-only" role="status" aria-live="polite">
        {state === 'copied' ? t('已複製到剪貼簿', 'Copied to the clipboard') : state === 'failed' ? t(`複製失敗：${why}`, `Copy failed: ${why}`) : ''}
      </span>
    </button>
  );
}
