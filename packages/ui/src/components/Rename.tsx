import { useEffect, useRef, useState } from 'react';
import { hub } from '../api';
import { useT } from '../i18n';
import { cx } from '../util';

/**
 * A text box over a conversation's title, to rename it: Enter or leaving it saves, Esc cancels. An unchanged or empty
 * name changes nothing. While an IME composes (Chinese, Japanese…), Enter picks the characters and does not save.
 */
export function RenameInput({ id, title, onDone, className }: { id: string; title: string; onDone: () => void; className?: string }) {
  const t = useT();
  const [value, setValue] = useState(title);
  const [error, setError] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  // Enter saves and then the box loses focus: save once.
  const settled = useRef(false);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  const finish = () => {
    settled.current = true;
    onDone();
  };
  const save = async () => {
    if (settled.current) return;
    const name = value.replace(/\s+/g, ' ').trim();
    if (!name || name === title) return finish();
    settled.current = true;
    try {
      await hub.call('workflows.rename', { id, title: name });
      onDone();
    } catch (e) {
      settled.current = false;
      setError((e as Error).message);
      ref.current?.focus();
    }
  };
  return (
    <input
      ref={ref}
      className={cx('rename-input', error && 'error', className)}
      value={value}
      maxLength={200}
      aria-label={t('對話名稱', 'Chat name')}
      title={error || t('Enter 儲存，Esc 取消', 'Enter saves, Esc cancels')}
      onChange={(e) => {
        setValue(e.target.value);
        setError('');
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
          e.preventDefault();
          void save();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          finish();
        }
      }}
      onBlur={() => void save()}
    />
  );
}
