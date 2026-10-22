import { useState } from 'react';
import type { DeniedAction, ProviderInfo, WorkflowRun } from '../../../core/src/types';
import { hub } from '../api';
import { navigate } from '../App';
import { useT } from '../i18n';
import { providerName } from '../util';

const KIND: Record<string, [string, string]> = {
  push: ['推送', 'Push'],
  pull_request: ['開 Pull Request', 'Open a pull request'],
  merge: ['合併', 'Merge'],
  comment: ['留言', 'Comment'],
  issue: ['Issue', 'Issue'],
  release: ['發布版本', 'Publish a release'],
  deploy: ['部署', 'Deploy'],
};

/**
 * External actions the user denied in this run. Once it has finished, each can be allowed after all: a follow-up
 * in the same folder does it (that one action goes through without asking again) and whatever was skipped.
 */
export function DeniedActions({ run, providers }: { run: WorkflowRun; providers: ProviderInfo[] }) {
  const t = useT();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const list = run.deniedActions ?? [];
  if (!list.length) return null;
  const ended = !['running', 'paused', 'waiting_human'].includes(run.status);
  const go = (d: DeniedAction) => {
    setBusy(d.id);
    setError(undefined);
    hub
      .call<string>('workflows.continueDenied', { id: run.id, deniedId: d.id })
      .then((newId) => navigate(`run/${newId}`))
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(undefined));
  };
  return (
    <div className="denied-card">
      <div className="denied-head">
        <span className="denied-title">🚫 {t(`被你拒絕的對外動作（${list.length}）`, `External actions you denied (${list.length})`)}</span>
        <span className="muted small">{t('agent 沒有執行這些動作，也沒有改用其他方式繞過。', 'The agents did not do these, nor work around them.')}</span>
      </div>
      {list.map((d) => {
        const agent = run.agents[d.agentId];
        const kind = KIND[d.kind] ?? (/push/i.test(d.kind) ? KIND.push : /tag|release/i.test(d.kind) ? KIND.release : /pull|\bpr\b/i.test(d.kind) ? KIND.pull_request : ['對外動作', 'External action']);
        return (
          <div key={d.id} className="denied-item">
            <div className="denied-main">
              <div>
                <b>{t(kind[0], kind[1])}</b> → <span className="mono">{d.target}</span>
              </div>
              <div className="muted small">
                {agent ? providerName(providers, agent.provider) : ''}
                {d.note ? ` · ${t('你的說明', 'Your note')}：${d.note}` : ''}
              </div>
              <details className="denied-details">
                <summary className="small">{t('要執行的內容', 'What it would do')}</summary>
                <pre>{d.details}</pre>
              </details>
            </div>
            {d.continuedIn ? (
              <a className="btn small" href={`#/run/${d.continuedIn}`}>
                {t('已改成允許 → 查看', 'Allowed → view')}
              </a>
            ) : (
              <button
                className="btn primary small"
                disabled={!ended || !!busy}
                title={ended ? t('開一個接續的對話：執行這個動作和因此略過的步驟，這個動作不會再問你一次', 'Start a follow-up that does this action (without asking again) and the steps skipped because of it') : t('等這段對話結束後才能繼續', 'Available once this conversation has finished')}
                onClick={() => go(d)}
              >
                {busy === d.id ? t('開始中…', 'Starting…') : t('改成允許並繼續', 'Allow and continue')}
              </button>
            )}
          </div>
        );
      })}
      {error && <div className="note err">{error}</div>}
    </div>
  );
}
