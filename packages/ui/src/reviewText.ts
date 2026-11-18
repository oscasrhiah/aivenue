/**
 * A review as Markdown, for copying: the verdict, what was reviewed, the summary, every issue with why it blocks or
 * not, the decisions the user left to the reviewer with their reasons and assumptions, and what the report rests on.
 * Text the agent wrote is kept as written (its line breaks, lists and tables); lines after the first inside a list item
 * are indented so they stay in it. Kept free of React so it can be tested (scripts/test-workflow.mjs).
 */
import type { Review, ReviewTarget } from '../../core/src/types';

type T = (zh: string, en: string) => string;

/** Every line after the first moved in by `n` spaces (the text stays inside its list item). */
const inItem = (s: string, n = 2) => s.trim().replace(/\n/g, `\n${' '.repeat(n)}`);

export function reviewMarkdown(t: T, r: Review, target?: ReviewTarget): string {
  const colon = t('：', ': ');
  const short = (s?: string) => (s ?? '').slice(0, 10);
  const verdict = r.incomplete?.length ? t('報告不完整，不算審查結果', 'Incomplete report, not a result') : r.verdict === 'approve' ? t('建議通過', 'Approve') : t('要求修改', 'Changes requested');
  const out: string[] = [`## ${t('審查報告', 'Review report')}${colon}${verdict}`];
  if (target)
    out.push(
      '',
      target.commit
        ? `${t('受審', 'Reviewed')}${colon}\`${short(target.commit)}\`${target.subject ? ` ${target.subject}` : ''}${target.base ? ` · ${t('差異', 'change')} \`${short(target.base)}..${short(target.commit)}\`` : ''}`
        : `${t('受審', 'Reviewed')}${colon}${t('工作資料夾目前的內容', 'The working folder as it is')}${target.base ? ` · ${t('比較起點', 'base')} \`${short(target.base)}\`` : ''}`,
    );
  const list = (title: string, items: string[]) => {
    if (items.length) out.push('', `### ${title}`, ...items.map((x) => `- ${inItem(x)}`));
  };
  list(t('報告不完整（退回兩次後仍然如此）', 'Incomplete (still so after two refusals)'), r.incomplete ?? []);
  list(t('審查期間工作資料夾有變動', 'The working folder changed during the review'), r.workspaceChanged ?? []);
  if (r.workspaceUnchecked) list(t('無法確認工作資料夾是否變動', 'Could not tell whether the working folder changed'), [r.workspaceUnchecked]);
  if (r.summary.trim()) out.push('', r.summary.trim());
  if (r.issues.length) {
    const sev = { blocker: t('嚴重', 'Blocker'), major: t('重要', 'Major'), minor: t('次要', 'Minor') };
    out.push('', `### ${t('問題', 'Issues')}`);
    for (const i of r.issues) {
      out.push(`- **${i.id}** [${sev[i.severity]}] ${i.title}${i.location ? ` (${i.location})` : ''}${i.preExisting ? ` — ${t('既有問題，不在這次的變更裡', 'pre-existing, outside this change')}` : ''}`);
      if (i.detail?.trim()) out.push(`  ${inItem(i.detail)}`);
      if (i.blocking?.trim()) out.push(`  ${t('為何阻擋或不阻擋', 'Why it blocks or not')}${colon}${inItem(i.blocking)}`);
    }
  }
  if (r.decisions?.length) {
    out.push('', `### ${t('你交給審查者決定的事', 'Decisions you left to the reviewer')}`);
    for (const d of r.decisions) {
      out.push(`- **${d.id}** ${inItem(d.question)}`, `  ${t('選擇', 'Choice')}${colon}${inItem(d.choice)}`);
      if (d.reasons) out.push(`  ${t('理由', 'Why')}${colon}${inItem(d.reasons)}`);
      if (d.assumptions.length) out.push(`  ${t('前提（不成立時結論可能改變）', 'Assumes (the choice may change if not)')}${colon}`, ...d.assumptions.map((a) => `  - ${inItem(a, 4)}`));
    }
    out.push('', t('這是審查者的建議；要不要照做、是否合併，仍由你決定。', "This is the reviewer's recommendation; whether to act on it, or merge, is still yours to decide."));
  }
  list(t('查過', 'Checked'), r.report?.checked ?? []);
  list(t('沒查過', 'Not checked'), r.report?.notChecked ?? []);
  list(t('自己重現', 'Reproduced'), r.report?.reproduced ?? []);
  list(t('採信（未重跑）', 'Taken on trust'), r.report?.trusted ?? []);
  list(
    t('待驗證（不是缺陷）', 'To validate (not defects)'),
    (r.needsValidation ?? []).map((v) => `**${v.id}** ${v.title}${v.location ? ` (${v.location})` : ''}${v.missing ? `${colon}${v.missing}` : ''}`),
  );
  return `${out.join('\n')}\n`;
}
