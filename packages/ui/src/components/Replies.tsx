import type { WorkflowRun } from '../../../core/src/types';
import { useT } from '../i18n';
import { cx } from '../util';

export type Reply = NonNullable<NonNullable<WorkflowRun['userMessages']>[number]['replies']>[number];

/** What the agents answered to a message sent while they worked, and whether the plan was updated for it. */
export function Replies({ replies, planUpdated, pending }: { replies?: Reply[]; planUpdated?: boolean; pending?: boolean }) {
  const t = useT();
  if (!replies?.length && !planUpdated && !pending) return null;
  return (
    <div className="replies">
      {replies?.map((r, i) => (
        <div key={i} className="reply" title={r.auto ? t('這個 agent 沒有用 reply_user 回覆：這是它讀到訊息後說的第一段話', 'This agent did not answer with reply_user: these are its first words after reading the message') : undefined}>
          <span className="reply-who">↳ {r.who}</span>
          <span className="reply-text">{r.text}</span>
          {r.changesPlan && <span className="pill warn">{t('會更新計畫', 'changes the plan')}</span>}
        </div>
      ))}
      {planUpdated && <div className="reply plan-updated">✓ {t('計畫已依這則訊息更新', 'The plan was updated for this message')}</div>}
      {pending && !replies?.length && <div className={cx('reply', 'muted')}>{t('等待 agent 回覆…', 'Waiting for an answer…')}</div>}
    </div>
  );
}
