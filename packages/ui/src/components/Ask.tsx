import { useEffect, useState } from 'react';
import { useT } from '../i18n';
import { cx } from '../util';

/**
 * Aivenue's own yes/no question. The browser's confirm() cannot be used: VS Code webviews block dialogs, so it
 * answers "cancel" at once and the action never happens.
 */
type Question = { message: string; ok?: string; cancel?: string; danger?: boolean; resolve: (yes: boolean) => void };

let show: ((q: Question | undefined) => void) | undefined;

export function ask(message: string, opts: { ok?: string; cancel?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    if (!show) return resolve(false);
    show({ message, ...opts, resolve });
  });
}

/** Where the questions show; mounted once at the root. */
export function AskHost() {
  const t = useT();
  const [q, setQ] = useState<Question>();
  useEffect(() => {
    show = setQ;
    return () => {
      show = undefined;
    };
  }, []);
  const answer = (yes: boolean) => {
    q?.resolve(yes);
    setQ(undefined);
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
      <div className="modal ask" role="alertdialog" aria-modal="true" onMouseDown={(e) => e.stopPropagation()}>
        <p className="ask-text">{q.message}</p>
        <div className="row gap end">
          <button className="btn" onClick={() => answer(false)}>
            {q.cancel ?? t('取消', 'Cancel')}
          </button>
          <button className={cx('btn', q.danger ? 'danger' : 'primary')} autoFocus onClick={() => answer(true)}>
            {q.ok ?? t('確定', 'OK')}
          </button>
        </div>
      </div>
    </div>
  );
}
