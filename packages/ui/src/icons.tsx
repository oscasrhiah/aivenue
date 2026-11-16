import type { LucideIcon } from 'lucide-react';
import { cx } from './util';

/**
 * Every icon looks the same way: a Lucide line icon in the colour of the text around it, sized to that text (16px by
 * default). Colour carries a state only where the surrounding class gives one (ok, warn, bad). Decorative unless given
 * a `label`: a button's own aria-label or title names it.
 */
export function Ico({ i: I, size = 16, className, label }: { i: LucideIcon; size?: number; className?: string; label?: string }) {
  return <I className={cx('ico', className)} size={size} strokeWidth={1.75} aria-hidden={label ? undefined : true} aria-label={label} role={label ? 'img' : undefined} focusable="false" />;
}
