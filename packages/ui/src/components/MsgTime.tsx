import { useT } from '../i18n';
import { cx, fullTime, msgTime } from '../util';

/**
 * When a message was said, shown on it (not only in a tooltip, so touch and keyboard users see it too): "14:05"
 * today, with the date on other days. The full date and time are its tooltip and, as a <time> element, what a screen
 * reader and a copy keep. `end`: when it ended (an agent's turn), added to the tooltip.
 */
export function MsgTime({ ts, end, className }: { ts?: number; end?: number; className?: string }) {
  const t = useT();
  if (!ts) return null;
  const title = end ? t(`開始 ${fullTime(ts)}，結束 ${fullTime(end)}`, `Started ${fullTime(ts)}, ended ${fullTime(end)}`) : fullTime(ts);
  return (
    <time className={cx('msg-time', className)} dateTime={new Date(ts).toISOString()} title={title}>
      {msgTime(ts)}
    </time>
  );
}
