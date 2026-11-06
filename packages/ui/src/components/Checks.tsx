import { useState } from 'react';
import type { ObservedCheck } from '../../../core/src/types';
import { useT } from '../i18n';
import { clock, cx } from '../util';
import { checkRow } from '../timeline';

/**
 * The checks Aivenue saw run, one row each: its state, then what to know at a glance (a rerun). Behind a click: every
 * run of it with what it printed, a file change after it, who ran it.
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
        const icon = r.cls === 'ok' ? '✓' : r.cls === 'bad' ? '✗' : '◦';
        return (
          <div key={key} className={cx('check-row', r.cls, shown && 'open')}>
            <div className="check-head" onClick={() => setOpen((s) => new Set(s.has(key) ? [...s].filter((x) => x !== key) : [...s, key]))} title={t('點一下看每次執行的輸出', 'Click for the output of each run')}>
              <span className="check-caret">{shown ? '▾' : '▸'}</span>
              <span className={cx('ext-chip', r.cls)}>
                {icon} {r.status}
              </span>
              <code className="check-cmd">{c.command}</code>
              {r.notes.map((n) => (
                <span key={n} className="check-note">
                  · {n}
                </span>
              ))}
            </div>
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
                    {x.output ? <pre className="check-out">{x.output}</pre> : <div className="muted tiny">{t('（提交時沒有留下輸出；完整紀錄在這個 agent 的活動紀錄）', "(no output kept at submission; the full record is in this agent's activity log)")}</div>}
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
