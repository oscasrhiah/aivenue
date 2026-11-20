import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AgentRole, CostBreakdown, CostModelRow, ObservedTotals, WorkflowRun } from '../../../core/src/types';
import { hub } from '../api';
import { useT, type T } from '../i18n';
import { fmtTokens, roleLabel } from '../util';
import { Dialog, Hint } from './Kit';

const BLOCK_LABEL = (t: T, key: string) =>
  ({
    'role.goal': t('任務文字：你的訊息', 'Task text: your message'),
    'role.plan': t('計畫', 'Plan'),
    'role.goalSpec': t('驗收目標與指標', 'Goal and metrics'),
    'role.priorReview': t('前次審查與回覆', 'Earlier review and replies'),
    'role.workSummary': t('實作摘要', 'Work summary'),
    'role.changedFiles': t('變更清單', 'Changed files'),
    'role.earlierVerifications': t('先前的驗收', 'Earlier verifications'),
    'role.userFeedback': t('你的回饋', 'Your feedback'),
    'role.instructions': t('角色指示', 'Role instructions'),
    'role.other': t('角色 prompt 其他', 'Role prompt, other'),
    'shared.progress': t('共用：進度與步驟', 'Shared: progress and steps'),
    'shared.status': t('共用：目標、問題、等待', 'Shared: goal, issues, waits'),
    'shared.handoffs': t('共用：各階段交接', 'Shared: stage hand-offs'),
    'shared.handover': t('共用：前一個 agent 的交接', 'Shared: hand-off from the agent before'),
    'shared.recap': t('共用：壓縮後的回顧', 'Shared: recap after compaction'),
    'shared.log': t('共用：最近的對話紀錄', 'Shared: recent conversation log'),
    'shared.knowledgeDoc': t('共用：整理後的知識', 'Shared: organized knowledge'),
    'shared.index': t('共用：主題索引', 'Shared: topic index'),
    'shared.agents': t('共用：agent 清單', 'Shared: agent list'),
    'shared.sharedMemory': t('共用：濃縮的筆記與結果', 'Shared: condensed notes and results'),
    'shared.notes': t('共用：筆記', 'Shared: notes'),
    'shared.knowledgeBase': t('共用：專案結構', 'Shared: project structure'),
    'shared.activity': t('共用：其他 agent 的活動', "Shared: other agents' activity"),
    'shared.instructions': t('共用：使用說明', 'Shared: how to use it'),
    'shared.other': t('共用：標題與分隔', 'Shared: headings and separators'),
    shared: t('共用上下文', 'Shared context'),
    rules: t('規則：資料夾、權限、背景工作…', 'Rules: folders, access, background jobs…'),
    projectMemory: t('專案記憶', 'Project memory'),
    advisor: t('顧問提示', 'Advisor hint'),
    attachments: t('附件', 'Attachments'),
    skills: t('Skill', 'Skills'),
    systemPrompt: t('角色系統提示：設定的角色指示', 'System prompt: role instructions you set'),
  })[key] ?? key;

const ms = (n: number) => {
  const s = Math.round(n / 1000);
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
};

function Cost({ o }: { o: ObservedTotals }) {
  const t = useT();
  if (!o.events) return <span className="muted">—</span>;
  if (o.costUnknown || o.costUsd === undefined) return <span className="muted">{t('未知', 'unknown')}</span>;
  // A price of 0 is the provider's price, not "no quota used" (that is on the usage page).
  return <span>{o.costUsd === 0 ? t('$0，價格為 0', '$0, priced at 0') : `$${o.costUsd.toFixed(4)}`}</span>;
}

/** The token and cost cells of one row: the same columns in the role table and the model table. */
function TokenCells({ o }: { o: ObservedTotals }) {
  const t = useT();
  return (
    <>
      <td>{fmtTokens(o.uncachedInput)}</td>
      <td>{fmtTokens(o.cachedInput)}</td>
      <td>
        {o.unsplit ? (
          <>
            {fmtTokens(o.unsplit.input)}
            <span className="muted">{t('（', '(')}{fmtTokens(o.unsplit.cached)}{t('）', ')')}</span>
          </>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td>
        {fmtTokens(o.output)}
        {o.reasoning !== undefined && <span className="muted">{t('（', '(')}{fmtTokens(o.reasoning)}{t('）', ')')}</span>}
      </td>
      <td>
        <Cost o={o} />
      </td>
    </>
  );
}

/** One model row's first cell: provider / model, 「預設」 for the provider's default, a mark when a model changed mid-run. */
function ModelName({ m }: { m: CostModelRow }) {
  const t = useT();
  return (
    <>
      <span className="mono">
        {m.provider}
        {m.model ? ` / ${m.model}` : ''}
      </span>
      {m.modelDefault && <span className="muted">{t('，預設', ', default')}</span>}
      {m.changed && (
        <span className="badge muted" title={t('有 agent 在執行中換過模型：它的 token 全部算在最後的模型，無法依模型拆開', 'An agent changed model during its run: all its tokens count under its last model and cannot be split by model')}>
          {t('中途換過模型', 'Model changed mid-run')}
        </span>
      )}
    </>
  );
}

/** Where a workflow's tokens and time went (docs/workflow-efficiency-plan.md A2). */
export function CostWindow({ run, onClose }: { run: WorkflowRun; onClose: () => void }) {
  const t = useT();
  const [data, setData] = useState<CostBreakdown>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    hub
      .call<CostBreakdown>('workflows.cost', { id: run.id })
      .then(setData)
      .catch((e) => setError((e as Error).message));
  }, [run.id, run.updatedAt]);
  const label = (key: string, role: string, stage?: string) =>
    key === 'librarian' ? t('整理共用筆記 · Aivenue 自動', 'Organizing notes · Aivenue') : key === 'compaction' ? t('壓縮對話 · Aivenue 自動', 'Compaction · Aivenue') : `${roleLabel(t, role as AgentRole)}${stage ? ` · ${stage}` : ''}`;
  const promptTotal = data?.blocks.reduce((n, b) => n + b.tokens, 0) ?? 0;
  return createPortal(
    <Dialog title={t('成本分解', 'Cost breakdown')} onClose={onClose} size="xl" className="mem-window cost-window" back="detail-back">
        <div className="mem-body">
          {/* The window is one workflow's; the Settings usage page counts every workflow. */}
          <div className="muted tiny">{t('只計算這個工作流', 'This workflow only')}</div>
          {error && <div className="err-text small">{error}</div>}
          {data && (
            <>
              <section className="mem-section">
                <dl className="dw-stats">
                  <div>
                    <dt>{t('工作流實際耗時', 'Wall-clock time')}</dt>
                    <dd className="num">{ms(data.wallMs)}</dd>
                  </div>
                  <div>
                    <dt>{t('各 agent 耗時總和', 'Sum of agent time')}</dt>
                    <dd className="num">{ms(data.agentMs)}</dd>
                  </div>
                  <div>
                    <dt>{t('等待你的時間', 'Waiting on you')}</dt>
                    <dd className="num">{ms(data.waitingMs)}</dd>
                  </div>
                </dl>
                <p className="muted tiny">{t('agent 平行工作時耗時會重疊，所以總和可能大於實際耗時。', 'Agents working in parallel overlap, so the sum can exceed the wall-clock time.')}</p>
              </section>
              <section className="mem-section">
                <h4 className="dw-heading">{t('依角色與階段', 'By role and stage')}</h4>
                <div className="cost-table-wrap">
                  <table className="cost-table small">
                    <thead>
                      <tr>
                        <th>{t('角色', 'Role')}</th>
                        <th>{t('次數', 'Runs')}</th>
                        <th>{t('耗時', 'Time')}</th>
                        <th>{t('未快取輸入', 'Uncached in')}</th>
                        <th>{t('快取輸入', 'Cached in')}</th>
                        <th title={t('這些供應商的數字看不出輸入是否已包含快取：只列它們回報的輸入（括號內是回報的快取），不放進前兩欄', 'For these providers it is not known whether input includes the cache: their reported input (reported cache in brackets), kept out of the two columns before')}>{t('拆分未知的輸入', 'Input, split unknown')}</th>
                        <th>{t('輸出含推理', 'Output with reasoning')}</th>
                        <th>{t('花費', 'Cost')}</th>
                        <th title={t('Aivenue 自己組出的 prompt 大小估算，不是供應商計費的輸入', "Aivenue's own estimate of the prompts it assembled, not what the provider billed")}>{t('組裝 prompt 估算', 'Assembled prompt (est.)')}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...data.rows, { key: '__total', role: 'total', agents: data.rows.reduce((n, r) => n + r.agents, 0), agentMs: data.agentMs, observed: data.total, promptTokens: data.rows.reduce((n, r) => n + r.promptTokens, 0), turns: data.rows.reduce((n, r) => n + r.turns, 0) }].map((r) => (
                        <tr key={r.key} className={r.key === '__total' ? 'cost-total' : undefined}>
                          <td>{r.key === '__total' ? t('合計', 'Total') : label(r.key, r.role, 'stage' in r ? (r.stage as string | undefined) : undefined)}</td>
                          <td>{r.agents}</td>
                          <td>{ms(r.agentMs)}</td>
                          <TokenCells o={r.observed} />
                          <td>
                            {fmtTokens(r.promptTokens)}
                            <span className="muted"> / {r.turns}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <Hint
                  className="muted tiny"
                  text={t(
                    '拆分已知的供應商：未快取輸入、快取輸入與輸出加起來等於它回報的總量；推理是輸出的一部分，不另外相加。「拆分未知的輸入」來自看不出輸入是否已含快取的供應商（例如 Gemini、Antigravity），只列它們回報的數字，不能和前兩欄相加，括號內的快取也可能已包含在內。花費「未知」是供應商沒有回報價格，不是 0；價格為 0 也不代表沒有耗用額度，請看設定的用量頁。',
                    'Providers with a known split: uncached input, cached input and output add up to what they reported; reasoning is part of output, not added again. "Input, split unknown" comes from providers whose numbers do not say whether input includes the cache (e.g. Gemini, Antigravity): their reported numbers only, not to be added to the two columns before, and the cache in brackets may already be inside. "Unknown" cost means no price was reported, not zero; a price of 0 does not mean no quota was used; see the Usage page in Settings.',
                  )}
                />
              </section>
              {!!data.models.length && (
                <section className="mem-section">
                  <h4 className="dw-heading">{t('依模型', 'By model')}</h4>
                  <div className="cost-table-wrap">
                    <table className="cost-table small">
                      <thead>
                        <tr>
                          <th>{t('模型', 'Model')}</th>
                          <th>{t('擔任的角色', 'Roles')}</th>
                          <th>{t('agent 數', 'Agents')}</th>
                          <th>{t('耗時', 'Time')}</th>
                          <th>{t('未快取輸入', 'Uncached in')}</th>
                          <th>{t('快取輸入', 'Cached in')}</th>
                          <th>{t('拆分未知的輸入', 'Input, split unknown')}</th>
                          <th>{t('輸出含推理', 'Output with reasoning')}</th>
                          <th>{t('花費', 'Cost')}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.models.map((m) => (
                          <tr key={m.key}>
                            <td>
                              <ModelName m={m} />
                            </td>
                            <td>{m.roles.map((r) => `${label(r.key, r.role)} ×${r.count}`).join(t('、', ', '))}</td>
                            <td>{m.agents}</td>
                            <td>{ms(m.agentMs)}</td>
                            <TokenCells o={m.observed} />
                          </tr>
                        ))}
                        <tr className="cost-total">
                          <td>{t('合計', 'Total')}</td>
                          <td />
                          <td>{data.models.reduce((n, m) => n + m.agents, 0)}</td>
                          <td>{ms(data.agentMs)}</td>
                          <TokenCells o={data.total} />
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </section>
              )}
              {!!data.blocks.length && (
                <section className="mem-section">
                  <h4 className="dw-heading">{t('prompt 中佔最多的部分', 'What took the most of the prompts')}</h4>
                  <div className="muted tiny">{t('Aivenue 組裝的估算', 'Aivenue’s estimate of what it assembled')}</div>
                  <ul className="mem-list cost-blocks">
                    {data.blocks.slice(0, 12).map((b) => (
                      <li key={b.key}>
                        {/* The bars in a column of their own, so every label starts at the same place. */}
                        <span className="cost-track" aria-hidden="true">
                          <span className="cost-bar" style={{ width: `${Math.max(2, Math.round((b.tokens / Math.max(1, promptTotal)) * 100))}%` }} />
                        </span>
                        <span>{BLOCK_LABEL(t, b.key)}</span>
                        <span className="muted small num">
                          {fmtTokens(b.tokens)} tokens{t('，', ', ')}{t(`佔 ${Math.round((b.tokens / Math.max(1, promptTotal)) * 100)}%，${b.turns} 次`, `${Math.round((b.tokens / Math.max(1, promptTotal)) * 100)}%, ${b.turns} turn(s)`)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {!!data.cut.length && (
                    <p className="muted small">
                      {t('為了放進模型而截掉、沒有送出的部分：', 'Cut to fit the model, not sent: ')}
                      {data.cut.map((c) => `${BLOCK_LABEL(t, c.key)} ${c.chars.toLocaleString()} ${t('字元', 'chars')}`).join('；')}
                    </p>
                  )}
                  <Hint
                    className="muted tiny"
                    text={t(
                      `這是 Aivenue 每次實際送出的 prompt 各部分的大小（每部分各自估算 token，全程 ${data.turns} 輪；每個 agent 只保留最近 40 輪的逐輪明細，但這裡的統計涵蓋全程）。它不等於供應商實際計費的輸入：對話歷史、工具輸出、快取都不在這裡。`,
                      `The sizes of the parts of each prompt Aivenue actually sent (tokens estimated per part, ${data.turns} turns over the whole run; each agent keeps per-turn detail for its latest 40 turns only, but these totals cover the whole run). Not what the provider billed: conversation history, tool output and caching are not here.`,
                    )}
                  />
                </section>
              )}
            </>
          )}
        </div>
    </Dialog>,
    document.body,
  );
}
