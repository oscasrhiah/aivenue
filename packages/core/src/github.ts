import { L } from './i18n';
import { capture, refreshPathCache } from './proc';
import type { ProviderRegistry } from './providers/registry';
import { installLine, posixInstallLine } from './providers/registry';
import type { GithubStatus } from './types';

/** Install commands for git + the GitHub CLI (gh), per OS. Linux picks the system package manager. */
function installCmd(needGit: boolean): string {
  if (process.platform === 'win32') {
    const w = (id: string) => `winget install --id ${id} -e --source winget --accept-source-agreements --accept-package-agreements`;
    return [needGit && w('Git.Git'), w('GitHub.cli')].filter(Boolean).join(' && ');
  }
  if (process.platform === 'darwin') return needGit ? 'brew install gh git' : 'brew install gh';
  // Official instructions from cli.github.com, one branch per package manager (sudo asks for the password in the terminal).
  const key = 'https://cli.github.com/packages/githubcli-archive-keyring.gpg';
  const apt = [
    'sudo mkdir -p -m 755 /etc/apt/keyrings',
    `(command -v wget >/dev/null 2>&1 && wget -nv -O- ${key} || curl -fsSL ${key}) | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null`,
    'sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg',
    'echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list >/dev/null',
    'sudo apt-get update',
    'sudo apt-get install -y gh git',
  ].join(' && ');
  return [
    `if command -v apt-get >/dev/null 2>&1; then ${apt}`,
    'elif command -v dnf >/dev/null 2>&1; then sudo dnf install -y gh git',
    'elif command -v pacman >/dev/null 2>&1; then sudo pacman -S --noconfirm github-cli git',
    'elif command -v zypper >/dev/null 2>&1; then sudo zypper install -y gh git',
    'elif command -v brew >/dev/null 2>&1; then brew install gh git',
    'else echo "No supported package manager found: see https://github.com/cli/cli#installation"; false; fi',
  ].join('; ');
}

/** A terminal line with a short explanation before and a clear result after (cmd.exe or sh). */
function scriptLine(intro: string[], cmd: string, ok: string, fail: string): string {
  if (process.platform !== 'win32') return posixInstallLine(cmd, cmd, false, intro, ok, fail);
  const e = (s: string) => s.replace(/[&|<>^%!"()\r\n]/g, ' ');
  return `${intro.map((l) => `echo ${e(l)}`).join(' & ')} & echo. & ${cmd} && (echo. & echo ${e(ok)}) || (echo. & echo ${e(fail)})`;
}

/**
 * GitHub for agents: git + the GitHub CLI, signed in once through GitHub's own browser flow. git push uses
 * that sign-in (gh auth setup-git), agents use `gh`, and the GitHub MCP server gets the same token at run time.
 */
export class GithubService {
  private state: GithubStatus = { git: { installed: false }, gh: { installed: false }, auth: { loggedIn: false }, gitCredential: false, checkedAt: 0 };
  private token?: { value: string; at: number };
  private polling?: NodeJS.Timeout;

  constructor(
    private registry: ProviderRegistry,
    private onChange: (s: GithubStatus) => void,
  ) {}

  status(): GithubStatus {
    return this.state;
  }

  /** What agents are told: only when gh is installed and signed in. */
  promptInfo(mcp: boolean): { gh: boolean; user?: string; mcp: boolean } | undefined {
    return this.state.gh.installed && this.state.auth.loggedIn ? { gh: true, user: this.state.auth.user, mcp } : undefined;
  }

  async check(): Promise<GithubStatus> {
    const version = (out: string) => /(\d+\.\d+(?:\.\d+)?)/.exec(out)?.[1];
    const [git, gh] = await Promise.all([capture('git', ['--version'], { timeoutMs: 10000 }), capture('gh', ['--version'], { timeoutMs: 10000 })]);
    const next: GithubStatus = {
      git: { installed: git.code === 0, version: git.code === 0 ? version(git.stdout) : undefined },
      gh: { installed: gh.code === 0, version: gh.code === 0 ? version(gh.stdout) : undefined },
      auth: { loggedIn: false },
      gitCredential: false,
      checkedAt: Date.now(),
    };
    if (next.gh.installed) {
      const st = await capture('gh', ['auth', 'status', '--hostname', 'github.com'], { timeoutMs: 15000 });
      const out = `${st.stdout}\n${st.stderr}`;
      next.auth.loggedIn = st.code === 0 && /Logged in/i.test(out);
      next.auth.user = /account\s+([\w-]+)/i.exec(out)?.[1] ?? /Logged in to \S+ as ([\w-]+)/i.exec(out)?.[1];
      if (!next.auth.loggedIn && /token.*invalid|expired/i.test(out)) next.auth.error = L('登入已失效，請重新登入', 'The sign-in expired; sign in again');
    }
    if (next.git.installed) {
      const helper = await capture('git', ['config', '--global', '--get-all', 'credential.https://github.com.helper'], { timeoutMs: 10000 });
      next.gitCredential = /gh(\.exe)?["']?\s+auth\s+git-credential/.test(helper.stdout);
    }
    if (!next.auth.loggedIn) this.token = undefined;
    this.state = next;
    this.onChange(next);
    return next;
  }

  /** Install git (if missing) and the GitHub CLI in a visible terminal. */
  install(): void {
    const cmd = installCmd(!this.state.git.installed);
    const name = this.state.git.installed ? 'GitHub CLI' : 'Git + GitHub CLI';
    const raw = process.platform === 'win32' ? installLine(name, cmd) : scriptLine([L(`正在安裝 ${name}`, `Installing ${name}`), L('需要時會詢問你的系統密碼（sudo）。', 'You may be asked for your system password (sudo).')], cmd, L('✓ 安裝完成，可以關閉這個視窗，回到 Aivenue 按「登入 GitHub」。', '✓ Installed. Close this window and press Sign in to GitHub in Aivenue.'), L('✗ 安裝失敗，請看上面的錯誤訊息。', '✗ Install failed; see the error above.'));
    this.registry.terminal({ title: L(`安裝 ${name}`, `Install ${name}`), raw }, cmd);
    this.poll((s) => s.gh.installed && s.git.installed);
  }

  /** GitHub's browser sign-in (a one-time code), then let git use it for https://github.com. */
  login(): void {
    if (!this.state.gh.installed) throw new Error(L('請先安裝 GitHub CLI', 'Install the GitHub CLI first'));
    const cmd = 'gh auth login --hostname github.com --git-protocol https --web && gh auth setup-git --hostname github.com';
    const raw = scriptLine(
      [L('登入 GitHub：瀏覽器會開啟 GitHub 的登入頁，輸入這裡顯示的一次性代碼即可。', 'Sign in to GitHub: the browser opens GitHub; enter the one-time code shown here.'), L('若詢問是否用 GitHub 帳號驗證 Git，請選 Yes。', 'If asked whether to authenticate Git with your GitHub credentials, answer Yes.')],
      cmd,
      L('✓ 已登入，git 推送也會使用這個帳號。可以關閉這個視窗。', '✓ Signed in; git push uses this account too. You can close this window.'),
      L('✗ 登入沒有完成，請看上面的訊息。', '✗ Sign-in did not finish; see the messages above.'),
    );
    this.registry.terminal({ title: L('登入 GitHub', 'Sign in to GitHub'), raw }, cmd);
    this.poll((s) => s.auth.loggedIn && s.gitCredential);
  }

  logout(): void {
    const cmd = 'gh auth logout --hostname github.com';
    this.registry.terminal({ title: L('登出 GitHub', 'Sign out of GitHub'), raw: scriptLine([L('登出 GitHub', 'Signing out of GitHub')], cmd, L('✓ 已登出', '✓ Signed out'), L('✗ 登出失敗', '✗ Sign-out failed')) }, cmd);
    this.token = undefined;
    this.poll((s) => !s.auth.loggedIn);
  }

  /** The signed-in token for the GitHub MCP server (read at run time, never stored by Aivenue). */
  async getToken(): Promise<string | undefined> {
    if (this.token && Date.now() - this.token.at < 5 * 60 * 1000) return this.token.value;
    const r = await capture('gh', ['auth', 'token', '--hostname', 'github.com'], { timeoutMs: 10000 });
    const value = r.code === 0 ? r.stdout.trim() : '';
    this.token = value ? { value, at: Date.now() } : undefined;
    return value || undefined;
  }

  /** After install / sign-in, re-check every 3 s (up to 10 minutes) until `done`, so the page updates by itself. */
  private poll(done: (s: GithubStatus) => boolean) {
    clearInterval(this.polling);
    let n = 0;
    this.polling = setInterval(async () => {
      refreshPathCache();
      const s = await this.check().catch(() => this.state);
      if (++n > 200 || done(s)) clearInterval(this.polling);
    }, 3000);
    this.polling.unref?.();
  }
}
