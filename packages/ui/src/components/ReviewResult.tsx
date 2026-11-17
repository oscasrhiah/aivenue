import { TriangleAlert } from 'lucide-react';
import type { ProviderInfo, ReviewIssue, WorkflowRun } from '../../../core/src/types';
import { Ico } from '../icons';
import { useT } from '../i18n';
import { cx, modelLabel, providerName } from '../util';
import { InlineMarkdown, Markdown } from './Markdown';
import { MsgTime } from './MsgTime';

/**
 * An independent review's result (flow mode "review"): the reviewer's report is the outcome of the workflow. It shows
 * what was reviewed, every issue with why it blocks or not, and what the report rests on: what was checked and not,
 * what the reviewer reproduced itself and what it took on trust. A change Aivenue saw in the working folder during the
 * review comes first, since the reviewed code may then not be what was reviewed.
 */
export function ReviewResult({ run, providers }: { run: WorkflowRun; providers: ProviderInfo[] }) {
  const t = useT();
  if (!run.config.review || run.status !== 'completed') return null;
  const round = run.stages.implement.rounds.at(-1);
  const review = round?.review;
  if (!review) return null;
  const who = round?.reviewerAgentId ? run.agents[round.reviewerAgentId] : undefined;
  const target = run.reviewTarget;
  const short = (s?: string) => (s ?? '').slice(0, 10);
  const report = review.report;
  const lists: [string, string, string[] | undefined][] = [
    ['checked', t('查過', 'Checked'), report?.checked],
    ['not-checked', t('沒查過', 'Not checked'), report?.notChecked],
    ['reproduced', t('自己重現', 'Reproduced'), report?.reproduced],
    ['trusted', t('採信（未重跑）', 'Taken on trust'), report?.trusted],
  ];
  return (
    <div className={cx('final-result', 'review-result', review.verdict !== 'approve' && 'revise')}>
      <div className="final-head">
        <span className="final-title">{t('審查報告', 'Review report')}</span>
        {who && (
          <span className="muted small">
            {providerName(providers, who.provider)}
            {who.model ? ` · ${modelLabel(who.model)}` : ''}
          </span>
        )}
        <span className={cx('pill', review.verdict === 'approve' ? 'ok' : 'warn')}>{review.verdict === 'approve' ? t('建議通過', 'Approve') : t('要求修改', 'Changes requested')}</span>
        <MsgTime ts={run.endedAt} className="final-time" />
      </div>
      {target && (
        <div className="final-row">
          <span className="final-label">{t('受審', 'Reviewed')}</span>
          <span className="small">
            {target.commit ? (
              <>
                <code>{short(target.commit)}</code> {target.subject}
                {target.base && (
                  <span className="muted">
                    {' '}
                    · {t('差異', 'change')} <code>{short(target.base)}..{short(target.commit)}</code>
                  </span>
                )}
              </>
            ) : (
              <>
                {t('工作資料夾目前的內容', 'The working folder as it is')}
                {target.base && (
                  <span className="muted">
                    {' '}
                    · {t('比較起點', 'base')} <code>{short(target.base)}</code>
                  </span>
                )}
              </>
            )}
            {target.files.length > 0 && <span className="muted"> · {t(`${target.files.length} 個檔案`, `${target.files.length} file(s)`)}</span>}
            {target.commit && target.head && target.commit !== target.head && <span className="muted"> · {t(`工作資料夾在 ${short(target.head)}`, `working folder at ${short(target.head)}`)}</span>}
          </span>
        </div>
      )}
      {!!review.workspaceChanged?.length && (
        <div className="review-changed">
          <Ico i={TriangleAlert} size={14} /> {t('審查期間工作資料夾有變動，受審的程式碼可能已經不是審查時看到的：', 'The working folder changed during the review, so the code may not be what was reviewed:')}
          <ul>
            {review.workspaceChanged.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="final-text">
        <Markdown className="prose" text={review.summary} />
      </div>
      {review.issues.length > 0 && (
        <div className="review-issues">
          {review.issues.map((i) => (
            <IssueRow key={i.id} issue={i} />
          ))}
        </div>
      )}
      <div className="review-basis">
        {lists.map(([key, label, items]) => (
          <div key={key} className={cx('review-basis-row', key)}>
            <span className="final-label">{label}</span>
            {items?.length ? (
              <ul>
                {items.map((x, n) => (
                  <li key={n}>
                    <InlineMarkdown text={x} />
                  </li>
                ))}
              </ul>
            ) : (
              <span className="muted small">{t('（報告沒有列出）', '(not listed in the report)')}</span>
            )}
          </div>
        ))}
      </div>
      {!!review.needsValidation?.length && (
        <details className="final-evidence">
          <summary className="small">{t(`待驗證 ${review.needsValidation.length} 項（不是缺陷）`, `${review.needsValidation.length} to validate (not defects)`)}</summary>
          {review.needsValidation.map((v) => (
            <div key={v.id} className="small">
              <b>{v.id}</b> {v.title}
              {v.location && <span className="muted mono"> {v.location}</span>}
              <div className="muted tiny">{v.missing}</div>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

function IssueRow({ issue }: { issue: ReviewIssue }) {
  const t = useT();
  const sev = { blocker: t('嚴重', 'Blocker'), major: t('重要', 'Major'), minor: t('次要', 'Minor') }[issue.severity];
  return (
    <details className={cx('review-issue', issue.severity)} open={issue.severity !== 'minor'}>
      <summary>
        <span className={cx('sev', issue.severity)}>{sev}</span> <b>{issue.id}</b> {issue.title}
        {issue.location && <span className="muted mono small"> {issue.location}</span>}
      </summary>
      {issue.detail && <Markdown className="prose small" text={issue.detail} />}
      {issue.blocking && (
        <div className="small">
          <span className="final-label">{t('為何阻擋或不阻擋', 'Why it blocks or not')}</span> <InlineMarkdown text={issue.blocking} />
        </div>
      )}
    </details>
  );
}
