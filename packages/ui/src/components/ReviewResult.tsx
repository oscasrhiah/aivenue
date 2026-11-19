import { useState } from 'react';
import { ChevronRight, CircleCheck, CircleX, TriangleAlert, Undo2 } from 'lucide-react';
import type { ProviderInfo, ReviewIssue, WorkflowRun } from '../../../core/src/types';
import { Ico } from '../icons';
import { useT } from '../i18n';
import { cx, modelLabel, providerName } from '../util';
import { reviewMarkdown } from '../reviewText';
import { verdictWords } from '../timeline';
import { CopyButton } from './CopyButton';
import { InlineMarkdown, Markdown } from './Markdown';
import { MsgTime } from './MsgTime';
import { ProgressList, ProgressToggle, progressSettled } from './Progress';

/** Whether an independent review's report is the result shown (completed, or incomplete with its report). */
export function reviewShown(run: WorkflowRun): boolean {
  return !!run.config.review && (run.status === 'completed' || run.status === 'incomplete') && !!run.stages.implement.rounds.at(-1)?.review;
}

/** Who wrote a result, in its header after the title and the verdict: cut to the room left in a narrow column, whole in its tooltip. */
export function FinalWho({ text }: { text: string }) {
  return (
    <span className="final-who" title={text}>
      {text}
    </span>
  );
}

/** A verdict's icon: passed, sent back for changes, or no verdict at all (an incomplete report). */
export const VERDICT_ICON = { approve: CircleCheck, revise: Undo2, incomplete: CircleX } as const;
/** …and its colour. */
export const VERDICT_CLS = { approve: 'ok', revise: 'warn', incomplete: 'err' } as const;

/**
 * An independent review's result (flow mode "review"): the reviewer's report is the outcome of the workflow. It shows
 * what was reviewed, every issue with why it blocks or not, and what the report rests on: what was checked and not,
 * what the reviewer reproduced itself and what it took on trust. A change Aivenue saw in the working folder during the
 * review comes first, since the reviewed code may then not be what was reviewed. The one framed card of its chat: the
 * verdict is a coloured word in its header, the rest flat inside.
 */
export function ReviewResult({ run, providers }: { run: WorkflowRun; providers: ProviderInfo[] }) {
  const t = useT();
  const [progress, setProgress] = useState(false);
  // An incomplete report is shown too (the workflow then ended as incomplete), never as a verdict.
  if (!reviewShown(run)) return null;
  const round = run.stages.implement.rounds.at(-1);
  const review = round!.review!;
  const who = round?.reviewerAgentId ? run.agents[round.reviewerAgentId] : undefined;
  const target = run.reviewTarget;
  const short = (s?: string) => (s ?? '').slice(0, 10);
  const report = review.report;
  const verdict = verdictWords(t, review, true);
  const settled = progressSettled(run, providers, t);
  const lists: [string, string, string[] | undefined][] = [
    ['checked', t('查過', 'Checked'), report?.checked],
    ['not-checked', t('沒查過', 'Not checked'), report?.notChecked],
    ['reproduced', t('自己重現', 'Reproduced'), report?.reproduced],
    ['trusted', t('採信（未重跑）', 'Taken on trust'), report?.trusted],
  ];
  return (
    <div className="final-result review-result">
      {/* Title and verdict first (with its counts), who reviewed after it (cut in a narrow column), then the tools. */}
      <div className="final-head">
        <h2 className="final-title">{t('審查報告', 'Review report')}</h2>
        <span className={cx('state-word', VERDICT_CLS[verdict.kind])}>
          <Ico i={VERDICT_ICON[verdict.kind]} size={14} /> {[verdict.label, verdict.count].filter(Boolean).join(' · ')}
        </span>
        {verdict.before && <span className="final-more">{verdict.before}</span>}
        {who && <FinalWho text={`${providerName(providers, who.provider)}${who.model ? ` · ${modelLabel(who.model)}` : ''}`} />}
        <span className="final-tools">
          {settled && <ProgressToggle run={run} providers={providers} open={progress} onToggle={() => setProgress(!progress)} />}
          <MsgTime ts={run.endedAt} className="final-time" />
          {/* The whole report: verdict, what was reviewed, issues with why they block, the decisions left to the reviewer
              with their reasons, and what it rests on. */}
          <CopyButton text={() => reviewMarkdown(t, review, target)} label={t('複製審查報告', 'Copy review report')} className="final-copy" />
        </span>
      </div>
      {settled && progress && <ProgressList run={run} providers={providers} />}
      {target && (
        <div className="final-row">
          <span className="final-label">{t('受審', 'Reviewed')}</span>
          <span className="final-value">
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
      {!!review.incomplete?.length && (
        <div className="review-changed">
          <Ico i={TriangleAlert} size={14} /> {t('審查者退回兩次後，報告仍然：', 'After two refusals the report still has these problems:')}
          <ul>
            {review.incomplete.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      {review.workspaceUnchecked && (
        <div className="review-unchecked small">
          <Ico i={TriangleAlert} size={14} /> {t('無法確認審查期間工作資料夾是否變動：', 'Could not tell whether the working folder changed during the review: ')}
          {review.workspaceUnchecked}
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
      {!!review.decisions?.length && (
        <div className="review-decisions">
          {review.decisions.map((d) => (
            <div key={d.id} className="review-decision">
              <div className="muted small">
                {t('你交給審查者決定', 'You left to the reviewer')} · <b>{d.id}</b> <InlineMarkdown text={d.question} />
              </div>
              <div className="review-choice">
                <InlineMarkdown text={d.choice} />
              </div>
              {d.reasons && (
                <div>
                  <span className="final-label">{t('理由', 'Why')}</span> <InlineMarkdown text={d.reasons} />
                </div>
              )}
              {d.assumptions.length > 0 && (
                <div>
                  <span className="final-label">{t('前提（不成立時結論可能改變）', 'Assumes (the choice may change if not)')}</span>
                  <ul>
                    {d.assumptions.map((a, n) => (
                      <li key={n}>
                        <InlineMarkdown text={a} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ))}
          <div className="muted tiny">{t('這是審查者的建議；要不要照做、是否合併，仍由你決定。', "This is the reviewer's recommendation; whether to act on it, or merge, is still yours to decide.")}</div>
        </div>
      )}
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
          <summary className="small">
            <Ico i={ChevronRight} size={14} className="fold-chev" /> {t(`待驗證 ${review.needsValidation.length} 項（不是缺陷）`, `${review.needsValidation.length} to validate (not defects)`)}
          </summary>
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

/** One issue: severity word (its colour), id, title, outside the change or not, where; why it blocks behind its line. */
function IssueRow({ issue }: { issue: ReviewIssue }) {
  const t = useT();
  const sev = { blocker: t('嚴重', 'Blocker'), major: t('重要', 'Major'), minor: t('次要', 'Minor') }[issue.severity];
  return (
    <details className={cx('review-issue', issue.severity, issue.preExisting && 'pre-existing')} open={issue.severity !== 'minor' && !issue.preExisting}>
      <summary>
        <Ico i={ChevronRight} size={14} className="fold-chev" />
        <span className={cx('sev', issue.severity)}>{sev}</span> <b>{issue.id}</b> {issue.title}
        {issue.preExisting && <span className="pre-tag">{t('既有問題，不在這次的變更裡', 'Pre-existing, outside this change')}</span>}
        {issue.location && <span className="muted mono small"> {issue.location}</span>}
      </summary>
      <div className="review-issue-body">
        {issue.detail && <Markdown className="prose small" text={issue.detail} />}
        {issue.blocking && (
          <div className="small">
            <span className="final-label">{t('為何阻擋或不阻擋', 'Why it blocks or not')}</span> <InlineMarkdown text={issue.blocking} />
          </div>
        )}
      </div>
    </details>
  );
}
