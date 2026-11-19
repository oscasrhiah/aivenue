import { useState } from 'react';
import { CircleCheck, Circle, Lock } from 'lucide-react';
import type { GithubStatus } from '../../../core/src/types';
import { hub, useCapabilities, useGithub } from '../api';
import { useT } from '../i18n';
import { cx } from '../util';
import { Ico } from '../icons';
import { Fold, Seg, StateWord } from './Kit';

/**
 * GitHub in three clicks: install git + the GitHub CLI, sign in through GitHub's browser page (git push uses the
 * same sign-in), then optionally give every agent GitHub's own MCP tools. Pushes, PRs and comments always ask first.
 * Once all three are done the steps fold into one line (signed in as who, the tools' access) with 管理 to open them.
 */
export function GithubCard() {
  const t = useT();
  const gh = useGithub();
  const { config } = useCapabilities();
  const mcp = config.mcpServers.find((s) => s.id === 'github');
  const [write, setWrite] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [manage, setManage] = useState(false);
  const act = (key: string, method: string, params?: unknown) => {
    setBusy(key);
    setError(undefined);
    hub
      .call(method, params)
      .catch((e) => setError((e as Error).message))
      .finally(() => setBusy(undefined));
  };
  const step = (done: boolean) => <Ico i={done ? CircleCheck : Circle} size={16} className={cx('gh-step', done && 'done')} label={done ? t('已完成', 'Done') : t('未完成', 'Not done')} />;
  const tools = gh.git.installed && gh.gh.installed;
  const readOnly = !!mcp && 'X-MCP-Readonly' in (mcp.headers ?? {});
  const allDone = tools && gh.auth.loggedIn && !!gh.gitCredential && !!mcp?.enabled;
  const showSteps = !allDone || manage;
  return (
    <section className="cap gh-card">
      <div className="cap-head">
        <div>
          <h3>GitHub</h3>
          <div className="cap-desc">{t('讓 agent 推送程式碼、開 Pull Request、看 issue 和 CI。只要登入一次，推送、gh 指令和 GitHub 工具都用同一個帳號。', 'Let agents push code, open pull requests, read issues and CI. Sign in once: git push, gh and the GitHub tools all use that account.')}</div>
        </div>
        <button className="link small" disabled={!!busy} onClick={() => act('refresh', 'github.status', { refresh: true })}>
          {busy === 'refresh' ? t('檢查中…', 'Checking…') : t('重新檢查', 'Re-check')}
        </button>
      </div>

      {allDone && (
        <div className="gh-summary">
          <StateWord icon={CircleCheck} tone="ok">
            {`${t('已登入', 'Signed in as')} ${gh.auth.user ?? ''}`}
          </StateWord>
          <span className="muted small">
            {t('GitHub 工具', 'GitHub tools')} · {readOnly ? t('唯讀', 'read-only') : t('可讀寫', 'read & write')}
          </span>
          <Fold open={manage} onToggle={() => setManage(!manage)}>
            {t('管理', 'Manage')}
          </Fold>
        </div>
      )}

      {showSteps && (
        <div className="gh-steps">
          <div className="gh-row">
            {step(tools)}
            <div className="grow">
              <b>{t('1. 安裝 Git 與 GitHub CLI', '1. Install Git and the GitHub CLI')}</b>
              <div className="muted small">
                {gh.checkedAt === 0
                  ? t('檢查中…', 'Checking…')
                  : `Git ${gh.git.installed ? (gh.git.version ?? t('已安裝', 'installed')) : t('未安裝', 'not installed')} · GitHub CLI ${gh.gh.installed ? (gh.gh.version ?? t('已安裝', 'installed')) : t('未安裝', 'not installed')}`}
              </div>
            </div>
            {!tools && gh.checkedAt > 0 && (
              <button className="btn primary" disabled={!!busy} onClick={() => act('install', 'github.install')}>
                {t('一鍵安裝', 'Install')}
              </button>
            )}
          </div>

          <div className={cx('gh-row', !tools && 'off')}>
            {step(gh.auth.loggedIn)}
            <div className="grow">
              <b>{t('2. 登入 GitHub', '2. Sign in to GitHub')}</b>
              <div className="muted small">
                {!tools && gh.checkedAt > 0
                  ? t('先完成第 1 步。會開啟 GitHub 官方的瀏覽器登入頁，輸入終端機顯示的一次性代碼即可；Aivenue 不經手你的密碼。', "Finish step 1 first. It opens GitHub's own sign-in page; enter the one-time code shown in the terminal. Aivenue never sees your password.")
                  : gh.auth.loggedIn
                    ? `${t('已登入', 'Signed in as')} ${gh.auth.user ?? ''}${gh.gitCredential ? t(' · git 推送使用這個帳號', ' · git push uses this account') : t('。git 推送尚未設定，重新登入即可。', '. git push is not set up yet; sign in again.')}`
                    : (gh.auth.error ?? t('會開啟 GitHub 官方的瀏覽器登入頁，輸入終端機顯示的一次性代碼即可；Aivenue 不經手你的密碼。', "Opens GitHub's own sign-in page; enter the one-time code shown in the terminal. Aivenue never sees your password."))}
              </div>
            </div>
            {tools &&
              (gh.auth.loggedIn ? (
                <button className="btn" disabled={!!busy} onClick={() => act('logout', 'github.logout')}>
                  {t('登出', 'Sign out')}
                </button>
              ) : (
                <button className="btn primary" disabled={!!busy} onClick={() => act('login', 'github.login')}>
                  {t('登入 GitHub', 'Sign in to GitHub')}
                </button>
              ))}
            {tools && gh.auth.loggedIn && !gh.gitCredential && (
              <button className="btn" disabled={!!busy} onClick={() => act('login', 'github.login')}>
                {t('重新登入', 'Sign in again')}
              </button>
            )}
          </div>

          <div className={cx('gh-row', !gh.auth.loggedIn && 'off')}>
            {step(!!mcp?.enabled)}
            <div className="grow">
              <b>{t('3. GitHub 工具，選用', '3. GitHub tools, optional')}</b>
              <div className="muted small">
                {!gh.auth.loggedIn && !mcp
                  ? t('先完成第 2 步。GitHub 官方的 MCP 工具：所有供應商的 agent 都能直接查 issue、PR、程式碼和 CI，沿用上面的登入，不用另外申請 token。', "Finish step 2 first. GitHub's official MCP tools: every provider's agents can look up issues, PRs, code and CI directly, with the sign-in above and no token to create.")
                  : mcp
                    ? mcp.enabled
                      ? `${t('已啟用', 'On')} · ${readOnly ? t('唯讀', 'read-only') : t('可讀寫', 'read & write')}${t('。在下方「共用 MCP 伺服器」清單可停用或移除。', '. Turn it off or remove it in the shared MCP servers list below.')}`
                      : t('已停用，在下方清單啟用。', 'Off; turn it on in the list below.')
                    : t('GitHub 官方的 MCP 工具，所有供應商的 agent 都能直接查 issue、PR、程式碼和 CI。不用另外申請 token，沿用上面的登入。', "GitHub's official MCP tools: every provider's agents can look up issues, PRs, code and CI directly. No token to create; it uses the sign-in above.")}
              </div>
              {mcp && gh.auth.loggedIn && (
                <div className="row gap wrap gh-mcp-mode">
                  <span className="muted tiny">{t('GitHub 工具權限', 'GitHub tools')}</span>
                  <Seg
                    manual
                    className="small"
                    label={t('GitHub 工具權限', 'GitHub tools access')}
                    value={readOnly ? 'read' : 'write'}
                    disabled={!!busy}
                    onChange={(v) => act('mcp', 'github.enableMcp', { write: v === 'write' })}
                    choices={[
                      { value: 'read', label: t('唯讀', 'Read-only') },
                      { value: 'write', label: t('可讀寫', 'Read & write') },
                    ]}
                  />
                  <span className="muted tiny">{t('可讀寫：agent 能透過工具開 PR、留言、建立 issue 等，對外動作仍會先問你。', 'Read & write: agents can open PRs, comment, create issues and so on through the tools; external actions still ask you first.')}</span>
                </div>
              )}
              {!mcp && gh.auth.loggedIn && (
                <label className="check small">
                  <input type="checkbox" checked={write} onChange={(e) => setWrite(e.target.checked)} />
                  {t('也允許透過工具修改 GitHub，例如開 PR、留言；不勾則只能讀取', 'Also allow changes through the tools, such as PRs and comments; unchecked is read-only')}
                </label>
              )}
            </div>
            {!mcp && gh.auth.loggedIn && (
              <button className="btn primary" disabled={!!busy} onClick={() => act('mcp', 'github.enableMcp', { write })}>
                {t('一鍵啟用', 'Enable')}
              </button>
            )}
          </div>
        </div>
      )}

      <div className="gh-note muted small">
        <Ico i={Lock} size={14} /> {t('推送、開 Pull Request、合併、留言、發布版本等「對外動作」，agent 一律會先在對話中請你核准，不論權限設定為何。', 'Pushing, opening or merging pull requests, commenting, publishing releases and other external actions always ask for your approval in the conversation first, whatever the permission level.')}
      </div>
      {error && <div className="note err">{error}</div>}
    </section>
  );
}

export type { GithubStatus };
