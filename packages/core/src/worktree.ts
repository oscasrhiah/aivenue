import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { capture, type CaptureResult } from './proc';
import { L } from './i18n';

/** A folder that never exists, so git finds no hooks. */
const NO_HOOKS = path.join(os.tmpdir(), `aivenue-no-hooks-${randomBytes(8).toString('hex')}`);

/**
 * Git run by Aivenue itself (outside any agent sandbox). Agents may be able to write `.git/config`;
 * these overrides keep git from running programs named there (fsmonitor, hooks, external diff, textconv).
 * Filter drivers can't be switched off this way, so callers also check gitStamp() is unchanged.
 */
export function safeGit(cwd: string, args: string[], opts: { timeoutMs?: number; input?: string } = {}): Promise<CaptureResult> {
  const harden = ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${NO_HOOKS}`, '-c', 'diff.external=', '-c', 'core.pager=cat', '--no-pager'];
  return capture('git', [...harden, ...args], { cwd, timeoutMs: opts.timeoutMs ?? 120000, input: opts.input, env: { GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' } });
}

/**
 * Fingerprint of the git configuration that applies in `cwd` ('' when it is not in a repository):
 * the `.git` link file if any, plus the repository and worktree config files.
 */
export function gitStamp(cwd: string): string {
  const read = (p: string) => {
    try {
      return fs.readFileSync(p, 'utf8');
    } catch {
      return '';
    }
  };
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, '.git');
    let st: fs.Stats | undefined;
    try {
      st = fs.lstatSync(dotGit);
    } catch {
      // keep looking upwards
    }
    if (st?.isDirectory()) return ['dir', dotGit, read(path.join(dotGit, 'config')), read(path.join(dotGit, 'config.worktree'))].join('\0');
    if (st?.isFile()) {
      const link = read(dotGit);
      const gitdir = path.resolve(dir, /gitdir:\s*(.+)/.exec(link)?.[1]?.trim() ?? '');
      const common = path.resolve(gitdir, read(path.join(gitdir, 'commondir')).trim() || '.');
      return ['file', link, read(path.join(common, 'config')), read(path.join(gitdir, 'config.worktree'))].join('\0');
    }
    if (st) return 'other';
    if (path.dirname(dir) === dir) return '';
  }
}

async function git(cwd: string, args: string[], input?: string) {
  const r = await safeGit(cwd, args, { input });
  if (r.error) throw new Error(r.error);
  if (r.code !== 0) throw new Error(`git ${args[0]}: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' / ')}`);
  return r.stdout.trim();
}

export interface Worktree {
  /** Folder the agents work in (same relative position as the original cwd). */
  cwd: string;
  path: string;
  branch: string;
  baseCommit: string;
  repo: string;
}

/**
 * Create an isolated git worktree for a run. It starts from the current working state:
 * uncommitted changes (via `git stash create`, which leaves the user's files untouched)
 * and untracked, non-ignored files are copied in.
 */
export async function createWorktree(cwd: string, dataDir: string, runId: string): Promise<Worktree> {
  let repo: string;
  try {
    repo = await git(cwd, ['rev-parse', '--show-toplevel']);
  } catch {
    throw new Error(L('工作資料夾不是 git 專案，無法使用隔離模式（可在角色設定關閉「隔離」）', 'The working folder is not a git repository, so isolation is unavailable (turn it off in the role settings)'));
  }
  repo = path.resolve(repo);
  const head = await git(repo, ['rev-parse', 'HEAD']).catch(() => {
    throw new Error(L('這個 git 專案還沒有任何 commit，請先 commit 一次再使用隔離模式', 'This repository has no commits yet; commit once before using isolation'));
  });
  const stash = await git(repo, ['stash', 'create']).catch(() => '');
  const base = stash || head;
  const wtPath = path.join(dataDir, 'worktrees', runId);
  const branch = `aivenue/${runId}`;
  await git(repo, ['worktree', 'add', '-b', branch, wtPath, base]);
  // Untracked (but not ignored) files are part of the user's working state too.
  const untracked = (await git(repo, ['ls-files', '--others', '--exclude-standard', '-z'])).split('\0').filter(Boolean);
  for (const rel of untracked) {
    const src = path.join(repo, rel);
    const dest = path.join(wtPath, rel);
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
    } catch {
      // unreadable file; skip
    }
  }
  // Commit the starting point so the final diff contains only the agents' changes.
  await git(wtPath, ['add', '-A']);
  await git(wtPath, ['-c', 'user.name=Aivenue', '-c', 'user.email=aivenue@localhost', 'commit', '--no-verify', '--allow-empty', '-q', '-m', 'Aivenue: starting point']);
  const baseCommit = await git(wtPath, ['rev-parse', 'HEAD']);
  const rel = path.relative(repo, path.resolve(cwd));
  return { cwd: path.join(wtPath, rel), path: wtPath, branch, baseCommit, repo };
}

/**
 * The worktree's `.git` link must still point into the user's repository; an agent could otherwise
 * redirect it to a planted git folder whose config runs programs when Aivenue calls git there.
 */
function assertIntact(wt: Pick<Worktree, 'path' | 'repo'>): void {
  let link = '';
  try {
    if (fs.lstatSync(path.join(wt.path, '.git')).isFile()) link = fs.readFileSync(path.join(wt.path, '.git'), 'utf8');
  } catch {
    // missing
  }
  const gitdir = /gitdir:\s*(.+)/.exec(link)?.[1]?.trim();
  const rel = gitdir ? path.relative(path.join(wt.repo, '.git', 'worktrees'), path.resolve(wt.path, gitdir)) : '';
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(L('隔離副本的 .git 連結被改動了，為了安全不在裡面執行 git。請檢查資料夾內容後手動處理：', 'The isolated copy\'s .git link was changed, so Aivenue will not run git in it. Inspect the folder and handle it manually: ') + wt.path);
  }
}

/** The agents' changes as a binary-safe patch against the starting point. */
async function patchOf(wt: Pick<Worktree, 'path' | 'baseCommit' | 'repo'>): Promise<string> {
  assertIntact(wt);
  await git(wt.path, ['add', '-A']);
  return (await safeGit(wt.path, ['diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', wt.baseCommit])).stdout;
}

/** Apply the agents' changes to the user's working tree as uncommitted changes. */
export async function applyWorktree(wt: Worktree): Promise<string> {
  const patch = await patchOf(wt);
  if (!patch.trim()) return L('沒有需要套用的變更', 'Nothing to apply');
  try {
    await git(wt.repo, ['apply', '--whitespace=nowarn', '-'], patch);
  } catch {
    // The user's files moved on meanwhile: let git merge hunk by hunk.
    await git(wt.repo, ['apply', '--3way', '--whitespace=nowarn', '-'], patch);
  }
  // The changes are in the user's project now; a copy that can't be removed yet must not make this look failed.
  await removeWorktree(wt).catch(() => undefined);
  return L('已套用到你的專案（尚未 commit，可在 git 中檢視差異）', 'Applied to your project (uncommitted; review the diff in git)');
}

/** Keep the result on its branch (committed) and remove the worktree folder. */
export async function keepWorktree(wt: Worktree): Promise<string> {
  assertIntact(wt);
  await git(wt.path, ['add', '-A']);
  await git(wt.path, ['-c', 'user.name=Aivenue', '-c', 'user.email=aivenue@localhost', 'commit', '--no-verify', '--allow-empty', '-q', '-m', 'Aivenue: result']);
  await git(wt.repo, ['worktree', 'remove', '--force', wt.path]);
  return L(`已保留在分支 ${wt.branch}，可以用 git merge 或 cherry-pick 取用`, `Kept on branch ${wt.branch}; merge or cherry-pick it with git`);
}

/** Remove the worktree folder and its branch. */
export async function removeWorktree(wt: Pick<Worktree, 'repo' | 'path' | 'branch'>): Promise<void> {
  await git(wt.repo, ['worktree', 'remove', '--force', wt.path]).catch(() => {
    // Only ever delete Aivenue's own worktree folders (dataDir/worktrees/<runId>).
    if (path.basename(path.dirname(path.resolve(wt.path))) === 'worktrees') fs.rmSync(wt.path, { recursive: true, force: true });
  });
  await git(wt.repo, ['worktree', 'prune']).catch(() => undefined);
  await git(wt.repo, ['branch', '-D', wt.branch]).catch(() => undefined);
}
