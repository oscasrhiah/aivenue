import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { useT } from '../i18n';
import { cx } from '../util';

/** Long content folded to `height` px with a fade and a toggle; short content shows as it is. */
export function Clamp({ children, height = 120, more, less, className }: { children: ReactNode; height?: number; more?: string; less?: string; className?: string }) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [long, setLong] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setLong(el.scrollHeight > height + 24);
  });
  return (
    <div className={cx('clamp', className)}>
      <div ref={ref} className={cx('clamp-body', long && !open && 'folded')} style={long && !open ? { maxHeight: height } : undefined}>
        {children}
      </div>
      {long && (
        <button className="link small clamp-toggle" onClick={() => setOpen(!open)}>
          {open ? (less ?? t('收起', 'Show less')) : (more ?? t('展開全文', 'Show all'))}
        </button>
      )}
    </div>
  );
}
