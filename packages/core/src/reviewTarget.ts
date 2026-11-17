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
  const untracked = ((await git(cwd, ['ls-files', '--others', '--exclude-standard'])) ?? '').split('\n').filter(Boolean).length;
  const subject = commit ? await git(cwd, ['log', '-1', '--format=%s', commit]) : undefined;
  const names = commit
    ? base
      ? await git(cwd, ['diff', '--name-only', '--no-renames', base, commit])
      : await git(cwd, ['show', '--name-only', '--format=', commit])
    : [await git(cwd, ['diff', '--name-only', '--no-renames', base ?? 'HEAD']), await git(cwd, ['ls-files', '--others', '--exclude-standard'])].filter(Boolean).join('\n');
  const files = [...new Set((names ?? '').split('\n').map((x) => x.trim()).filter(Boolean))].slice(0, 500);
  return { ...(commit ? { commit } : {}), ...(subject ? { subject } : {}), ...(base ? { base } : {}), head, branch, dirty, untracked, files, scratch };
}

/**
 * Why the working folder is not the reviewed commit, when a commit is reviewed: another HEAD, uncommitted changes, or
 * untracked files. Then what is built or run there is not evidence about the commit.
 */
export function differsFromCommit(t: ReviewTarget): { zh: string; en: string } | undefined {
  if (!t.commit || !t.head) return undefined;
  const zh: string[] = [];
  const en: string[] = [];
  if (t.commit !== t.head) (zh.push(`HEAD 是 ${t.head.slice(0, 10)}`), en.push(`HEAD is ${t.head.slice(0, 10)}`));
  if (t.dirty) (zh.push('有未提交的修改'), en.push('it has uncommitted changes'));
  if (t.untracked) (zh.push(`有 ${t.untracked} 個未追蹤的檔案`), en.push(`it has ${t.untracked} untracked file(s)`));
  return zh.length ? { zh: zh.join('、'), en: en.join(', ') } : undefined;
}

/**
 * The working folder, to compare before and after a reviewer's turn. In a git repository: HEAD, branch, every changed
 * tracked file and every untracked (not ignored) file, each with a fingerprint of its content. Elsewhere: every file
 * of the folder (not node_modules or .git). `unknown`: why it could not be taken whole (too many files…), so a
 * comparison cannot say "nothing changed".
 */
export interface WorkspaceState {
  git: boolean;
  head: string;
  branch: string;
  tracked: Map<string, string>;
  untracked: Map<string, string>;
  unknown?: string;
}

/** At most this many files are fingerprinted (untracked ones in git, all of them elsewhere). */
const MAX_FILES = 20_000;
/** Larger files are fingerprinted by size and time of change, not content. */
const MAX_HASHED = 20 * 1024 * 1024;

function fingerprint(file: string): string {
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return 'not a file';
    if (st.size > MAX_HASHED) return `size ${st.size} changed ${st.mtimeMs}`;
    return createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return 'missing';
  }
}

export async function workspaceState(cwd: string): Promise<WorkspaceState> {
  const head = await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']);
  if (head === undefined) return folderState(cwd);
  const branch = (await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])) ?? '';
  const top = (await git(cwd, ['rev-parse', '--show-toplevel'])) ?? cwd;
  const r = await safeGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], { timeoutMs: 60000 });
  const tracked = new Map<string, string>();
  const untracked = new Map<string, string>();
  if (r.code !== 0 || r.error) return { git: true, head, branch, tracked, untracked, unknown: L('git status 失敗', 'git status failed') };
  let skipped = 0;
  for (const entry of r.stdout.split('\0')) {
    if (entry.length < 4) continue;
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    if (code === '??') {
      if (untracked.size >= MAX_FILES) skipped++;
      else untracked.set(file, fingerprint(path.join(top, file)));
      continue;
    }
    tracked.set(file, `${code}|${fingerprint(path.join(top, file))}`);
  }
  const unknown = skipped ? L(`未追蹤的檔案太多，有 ${skipped} 個沒有比對`, `too many untracked files: ${skipped} not compared`) : undefined;
  return { git: true, head, branch, tracked, untracked, ...(unknown ? { unknown } : {}) };
}

/** A folder that is not a git repository: every file with its fingerprint. */
function folderState(cwd: string): WorkspaceState {
  const files = new Map<string, string>();
  let unknown: string | undefined;
  const walk = (dir: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      unknown ??= L(`讀不到資料夾 ${rel || '.'}`, `could not read the folder ${rel || '.'}`);
      return;
    }
    for (const e of entries) {
      if (unknown) return;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && e.name !== '.git') walk(path.join(dir, e.name), r);
      } else if (e.isFile()) {
        if (files.size >= MAX_FILES) unknown = L(`資料夾的檔案超過 ${MAX_FILES} 個，無法全部比對`, `more than ${MAX_FILES} files in the folder: not all compared`);
        else files.set(r, fingerprint(path.join(dir, e.name)));
      }
    }
  };
  walk(cwd, '');
  return { git: false, head: '', branch: '', tracked: new Map(), untracked: files, ...(unknown ? { unknown } : {}) };
}

/** Why the comparison of two states cannot rule out a change (a state was not taken whole). */
export function workspaceUnknown(before: WorkspaceState, after: WorkspaceState): string | undefined {
  return before.unknown ?? after.unknown;
}

/**
 * What changed between two states, in words for the user and the review result. Tracked files (changed, restored or
 * newly changed), HEAD and branch mean the reviewed code may not be what was reviewed; untracked files that were there
 * and were changed or removed are the user's work touched; new ones are what was left in the project folder. In a
 * folder outside git every file counts the same.
 */
export function workspaceChanges(before: WorkspaceState, after: WorkspaceState): string[] {
  const out: string[] = [];
  if (before.git !== after.git) return [L('資料夾在審查期間變成或不再是 git 專案', 'the folder became or stopped being a git repository during the review')];
  if (before.branch !== after.branch) out.push(L(`分支從 ${before.branch || '（分離的 HEAD）'} 變成 ${after.branch || '（分離的 HEAD）'}`, `the branch went from ${before.branch || '(detached HEAD)'} to ${after.branch || '(detached HEAD)'}`));
  if (before.head !== after.head) out.push(L(`HEAD 從 ${before.head.slice(0, 10)} 變成 ${after.head.slice(0, 10)}`, `HEAD went from ${before.head.slice(0, 10)} to ${after.head.slice(0, 10)}`));
  const files = [...new Set([...before.tracked.keys(), ...after.tracked.keys()])].filter((f) => before.tracked.get(f) !== after.tracked.get(f)).sort();
  if (files.length) out.push(L(`追蹤中的檔案有變動：${list(files)}`, `tracked files changed: ${list(files)}`));
  const was = [...before.untracked.keys()];
  const changed = was.filter((f) => after.untracked.has(f) && after.untracked.get(f) !== before.untracked.get(f)).sort();
  const removed = was.filter((f) => !after.untracked.has(f) && !after.tracked.has(f)).sort();
  const added = [...after.untracked.keys()].filter((f) => !before.untracked.has(f)).sort();
  if (before.git) {
    if (changed.length) out.push(L(`原有的未追蹤檔案被修改：${list(changed)}`, `untracked files that were there were changed: ${list(changed)}`));
    if (removed.length) out.push(L(`原有的未追蹤檔案被刪除：${list(removed)}`, `untracked files that were there were removed: ${list(removed)}`));
    if (added.length) out.push(L(`專案資料夾多了未追蹤的檔案：${list(added)}`, `new untracked files in the project folder: ${list(added)}`));
  } else {
    if (changed.length) out.push(L(`檔案被修改：${list(changed)}`, `files changed: ${list(changed)}`));
    if (removed.length) out.push(L(`檔案被刪除：${list(removed)}`, `files removed: ${list(removed)}`));
    if (added.length) out.push(L(`資料夾多了檔案：${list(added)}`, `new files in the folder: ${list(added)}`));
  }
  return out;
}

function list(files: string[]): string {
  return files.length > 12 ? `${files.slice(0, 12).join(', ')} … (+${files.length - 12})` : files.join(', ');
}
