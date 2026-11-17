import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { L } from './i18n';
import type { ReviewTarget, ReviewTask } from './types';
import { safeGit } from './worktree';

/*
 * Independent review (flow mode "review"): what is reviewed, and whether the working folder stayed as it was while the
 * reviewer worked. Aivenue runs git itself here (hardened, see safeGit), before and after the reviewer's turn.
 */

const MATERIAL_MAX = 100_000;

/** A revision the user typed: one git revision, never something git could read as an option. */
function checkRev(v: unknown, what: string): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) return undefined;
  if (s.length > 200 || s.startsWith('-') || !/^[\w./~^@{}:+-]+$/.test(s)) throw new Error(L(`${what}不是有效的 git 版本：${s}`, `${what} is not a valid git revision: ${s}`));
  return s;
}

/** The review task as the user set it, checked: revisions git can only read as revisions, the material kept in size. */
export function normalizeReview(r: ReviewTask | undefined): ReviewTask | undefined {
  if (!r || typeof r !== 'object') return undefined;
  const commit = checkRev(r.commit, L('受審提交', 'The reviewed commit'));
  const base = checkRev(r.base, L('比較起點', 'The base'));
  const material = typeof r.material === 'string' && r.material.trim() ? r.material.trim().slice(0, MATERIAL_MAX) : undefined;
  return { ...(commit ? { commit } : {}), ...(base ? { base } : {}), ...(material ? { material } : {}) };
}

async function git(cwd: string, args: string[]): Promise<string | undefined> {
  const r = await safeGit(cwd, args, { timeoutMs: 60000 });
  return r.code === 0 && !r.error ? r.stdout.replace(/\s+$/, '') : undefined;
}

/**
 * What the review looks at, resolved in the working folder: the commit and base as full hashes (an unknown one stops the
 * review before any agent runs), the folder's HEAD, branch and uncommitted changes, and the files of the change.
 */
export async function resolveReviewTarget(cwd: string, task: ReviewTask, scratch: string): Promise<ReviewTarget> {
  fs.mkdirSync(scratch, { recursive: true });
  const head = await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (!head) {
    if (task.commit || task.base) throw new Error(L(`工作資料夾不是 git 專案（或還沒有任何提交），不能指定受審提交或比較起點：${cwd}`, `The working folder is not a git repository (or has no commit yet), so no commit or base can be reviewed: ${cwd}`));
    return { head: '', branch: '', dirty: false, files: [], scratch, note: L('工作資料夾不是 git 專案：審查的是資料夾裡目前的檔案', 'The working folder is not a git repository: its files as they are now are reviewed') };
  }
  const rev = async (r: string, what: string) => {
    const sha = await git(cwd, ['rev-parse', '--verify', '--quiet', `${r}^{commit}`]);
    if (!sha) throw new Error(L(`找不到${what}「${r}」：它不在 ${cwd} 的 git 專案裡`, `${what} "${r}" was not found in the git repository of ${cwd}`));
    return sha;
  };
  const commit = task.commit ? await rev(task.commit, L('受審提交', 'the reviewed commit')) : undefined;
  let base = task.base ? await rev(task.base, L('比較起點', 'the base')) : undefined;
  if (commit && !base) base = (await git(cwd, ['rev-parse', '--verify', '--quiet', `${commit}^`])) || undefined;
  const branch = (await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])) ?? '';
  const dirty = !!(await git(cwd, ['status', '--porcelain', '--untracked-files=no']));
  const subject = commit ? await git(cwd, ['log', '-1', '--format=%s', commit]) : undefined;
  const names = commit
    ? base
      ? await git(cwd, ['diff', '--name-only', '--no-renames', base, commit])
      : await git(cwd, ['show', '--name-only', '--format=', commit])
    : [await git(cwd, ['diff', '--name-only', '--no-renames', base ?? 'HEAD']), await git(cwd, ['ls-files', '--others', '--exclude-standard'])].filter(Boolean).join('\n');
  const files = [...new Set((names ?? '').split('\n').map((x) => x.trim()).filter(Boolean))].slice(0, 500);
  return { ...(commit ? { commit } : {}), ...(subject ? { subject } : {}), ...(base ? { base } : {}), head, branch, dirty, files, scratch };
}

/** The working folder as git sees it: HEAD, branch, every changed tracked file with a hash of its content, new files. */
export interface WorkspaceState {
  head: string;
  branch: string;
  tracked: Map<string, string>;
  untracked: Set<string>;
}

export async function workspaceState(cwd: string): Promise<WorkspaceState | undefined> {
  const head = await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (head === undefined) return undefined;
  const branch = (await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])) ?? '';
  const top = (await git(cwd, ['rev-parse', '--show-toplevel'])) ?? cwd;
  const out = (await safeGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], { timeoutMs: 60000 })).stdout;
  const tracked = new Map<string, string>();
  const untracked = new Set<string>();
  for (const entry of out.split('\0')) {
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    if (code === '??') {
      untracked.add(file);
      continue;
    }
    let content = 'missing';
    try {
      content = createHash('sha1').update(fs.readFileSync(path.join(top, file))).digest('hex');
    } catch {
      // deleted or unreadable: the status code says which
    }
    tracked.set(file, `${code}|${content}`);
  }
  return { head, branch, tracked, untracked };
}

/**
 * What changed between two states, in words for the user and the review result. Tracked files (changed, restored or
 * newly changed), HEAD and branch mean the reviewed code may not be what was reviewed; new untracked files are what was
 * left in the project folder.
 */
export function workspaceChanges(before: WorkspaceState | undefined, after: WorkspaceState | undefined): string[] {
  if (!before || !after) return [];
  const out: string[] = [];
  if (before.branch !== after.branch) out.push(L(`分支從 ${before.branch || '（分離的 HEAD）'} 變成 ${after.branch || '（分離的 HEAD）'}`, `the branch went from ${before.branch || '(detached HEAD)'} to ${after.branch || '(detached HEAD)'}`));
  if (before.head !== after.head) out.push(L(`HEAD 從 ${before.head.slice(0, 10)} 變成 ${after.head.slice(0, 10)}`, `HEAD went from ${before.head.slice(0, 10)} to ${after.head.slice(0, 10)}`));
  const files = [...new Set([...before.tracked.keys(), ...after.tracked.keys()])].filter((f) => before.tracked.get(f) !== after.tracked.get(f)).sort();
  if (files.length) out.push(L(`追蹤中的檔案有變動：${list(files)}`, `tracked files changed: ${list(files)}`));
  const added = [...after.untracked].filter((f) => !before.untracked.has(f)).sort();
  if (added.length) out.push(L(`專案資料夾多了未追蹤的檔案：${list(added)}`, `new untracked files in the project folder: ${list(added)}`));
  return out;
}

function list(files: string[]): string {
  return files.length > 12 ? `${files.slice(0, 12).join(', ')} … (+${files.length - 12})` : files.join(', ');
}
