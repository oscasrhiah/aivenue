import { useState } from 'react';
import { ChevronDown, ChevronRight, CircleCheck, CircleHelp, CircleX, RefreshCw } from 'lucide-react';
import { Ico } from '../icons';
import type { ObservedCheck } from '../../../core/src/types';
import { useT } from '../i18n';
import { clock, cx } from '../util';
import { checkRow, type CheckRow } from '../timeline';

/**
 * A check's state, with the icon the result's verification gives the same state (Chat.tsx V_ICON): passed, failed, to
 * re-check after a change, too little evidence. The dashed circle stays "no check run" (which has no row).
 */
const CHECK_ICON = { passed: CircleCheck, failed: CircleX, recheck: RefreshCw, weak: CircleHelp } as const satisfies Record<CheckRow['kind'], unknown>;

/**
 * The checks Aivenue saw run, one row each: its state (icon and word, in its colour), the command, then what to know at a
 * glance (a rerun, why it is to be checked again). The row is a button (Tab, Enter, Space): behind it, every run of the
 * check with what it printed, a file change after it, who ran it.
 */
export function CheckRows({ checks }: { checks: ObservedCheck[] }) {
  const t = useT();
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const outcome = (o: ObservedCheck['outcome']) => (o === 'passed' ? t('通過', 'passed') : o === 'failed' ? t('失敗', 'failed') : o === 'output_failure' ? t('輸出回報失敗', 'output reports a failure') : o === 'may_not_run' ? t('不確定是否執行', 'not known whether it ran') : t('要看輸出', 'see the output'));
  return (
    <div className="check-rows">
      {checks.map((c) => {
        const key = `${c.agentId}|${c.command}|${c.ts}`;
        const r = checkRow(t, c);
        const shown = open.has(key);
        return (
          <div key={key} className={cx('check-row', r.cls, shown && 'open')}>
            {/* The chevron in a column of its own: a wrapped state, command or note stays beside it, under its first line. */}
            <button type="button" className="check-head" aria-expanded={shown} onClick={() => setOpen((s) => new Set(s.has(key) ? [...s].filter((x) => x !== key) : [...s, key]))}>
              <Ico i={shown ? ChevronDown : ChevronRight} size={14} className="check-caret" />
              <span className="row-main">
                <span className={cx('state-word', r.cls)}>
                  <Ico i={CHECK_ICON[r.kind]} size={14} /> {r.status}
                </span>
                <code className="check-cmd">{c.command}</code>
                {/* Notes on a line of their own when the row wraps: never a line that starts with a separator. */}
                {r.notes.length > 0 && <span className="check-note">{r.notes.join(t('、', ', '))}</span>}
              </span>
            </button>
            {shown && (
              <div className="check-body">
                {r.details.map((d) => (
                  <div key={d} className="muted small">
                    {d}
                  </div>
                ))}
                {r.runs.map((x, i) => (
                  <div key={i} className="check-run">
                    <div className="small">
                      {r.runs.length > 1 ? t(`第 ${i + 1} 次`, `Run ${i + 1}`) : t('這次執行', 'This run')} · {clock(x.ts)} · {outcome(x.outcome)}
                      {x.seq !== undefined && <span className="muted tiny"> · {t(`活動紀錄第 ${x.seq} 筆`, `activity log event ${x.seq}`)}</span>}
                    </div>
                    {x.output ? <pre className="check-out">{x.output}</pre> : <div className="muted tiny">{t('提交時沒有留下輸出，完整紀錄在這個 agent 的活動紀錄', "No output kept at submission: the full record is in this agent's activity log")}</div>}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
