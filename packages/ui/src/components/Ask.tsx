import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n';
import { cx } from '../util';

/**
 * Aivenue's own yes/no question. The browser's confirm() cannot be used: VS Code webviews block dialogs, so it
 * answers "cancel" at once and the action never happens.
 */
type Question = { message: string; detail?: string; ok?: string; cancel?: string; danger?: boolean; resolve: (yes: boolean) => void };

let show: ((q: Question | undefined) => void) | undefined;

/**
 * Ask before doing something: one short question (`message`, the dialog's name), and what to know about it in a quieter
 * line (`detail`). `ok` and `cancel` say what each button does (e.g. 「刪除對話」 / 「取消」). With `danger` the button
 * that does it is red and the focus starts on the other one, so Enter alone never deletes or stops anything.
 */
export function ask(message: string, opts: { detail?: string; ok?: string; cancel?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    if (!show) return resolve(false);
    show({ message, ...opts, resolve });
  });
}

/** Where the questions show; mounted once at the root. Closed, the focus goes back to what asked (when still there). */
export function AskHost() {
  const t = useT();
  const [q, setQ] = useState<Question>();
  const opener = useRef<HTMLElement | null>(null);
  const id = useId();
  useEffect(() => {
    show = (next) => {
      if (next) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setQ(next);
    };
    return () => {
      show = undefined;
    };
  }, []);
  const answer = (yes: boolean) => {
    q?.resolve(yes);
    setQ(undefined);
    const back = opener.current;
    opener.current = null;
    if (back?.isConnected) back.focus();
  };
  useEffect(() => {
    if (!q) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && answer(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  if (!q) return null;
  return (
    <div className="modal-back" onMouseDown={() => answer(false)}>
      <div className="modal ask" role="alertdialog" aria-modal="true" aria-labelledby={`${id}-q`} aria-describedby={q.detail ? `${id}-d` : undefined} onMouseDown={(e) => e.stopPropagation()}>
        <p className="ask-text" id={`${id}-q`}>
          {q.message}
        </p>
        {q.detail && (
          <p className="ask-detail" id={`${id}-d`}>
            {q.detail}
          </p>
        )}
        <div className="row gap end">
          <button className="btn" autoFocus={!!q.danger} onClick={() => answer(false)}>
            {q.cancel ?? t('取消', 'Cancel')}
          </button>
          <button className={cx('btn', q.danger ? 'danger' : 'primary')} autoFocus={!q.danger} onClick={() => answer(true)}>
            {q.ok ?? t('確定', 'OK')}
          </button>
        </div>
      </div>
    </div>
  );
}
