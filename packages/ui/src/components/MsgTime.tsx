import { cx, fullTime, msgTime } from '../util';

/**
 * When a message was said, shown on it (not only in a tooltip, so touch and keyboard users see it too): "14:05"
 * today, with the date on other days. The full date and time are its tooltip and, as a <time> element, what a screen
 * reader and a copy keep.
 */
export function MsgTime({ ts, className }: { ts?: number; className?: string }) {
  if (!ts) return null;
  return (
    <time className={cx('msg-time', className)} dateTime={new Date(ts).toISOString()} title={fullTime(ts)}>
      {msgTime(ts)}
    </time>
  );
}
