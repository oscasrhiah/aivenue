import * as fs from 'node:fs';
import * as path from 'node:path';
import type { OutputFile } from './types';

const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', '.gradle', '.idea', '.next', '.nuxt', '.turbo', '.cache', '.aivenue', '.playwright-mcp']);
const MAX_FILES = 50000;

export interface Snapshot {
  files: Map<string, { size: number; mtimeMs: number }>;
  truncated: boolean;
}

/** File listing of a folder (relative path → size/mtime), skipping dependency and VCS folders. */
export function snapshot(root: string): Snapshot {
  const files = new Map<string, { size: number; mtimeMs: number }>();
  let truncated = false;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (files.size >= MAX_FILES) {
        truncated = true;
        return;
      }
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) walk(abs);
      } else if (e.isFile()) {
        try {
          const st = fs.statSync(abs);
          files.set(path.relative(root, abs), { size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          // vanished while scanning
        }
      }
    }
  };
  walk(root);
  return { files, truncated };
}

/** What changed between two snapshots of the same folder. */
export function diffSnapshots(root: string, before: Snapshot, after: Snapshot): OutputFile[] {
  const out: OutputFile[] = [];
  for (const [rel, f] of after.files) {
    const old = before.files.get(rel);
    if (!old) out.push({ path: rel, abs: path.join(root, rel), status: 'added', size: f.size });
    else if (old.size !== f.size || old.mtimeMs !== f.mtimeMs) out.push({ path: rel, abs: path.join(root, rel), status: 'modified', size: f.size });
  }
  for (const [rel, f] of before.files) if (!after.files.has(rel)) out.push({ path: rel, abs: path.join(root, rel), status: 'deleted', size: f.size });
  const order = { added: 0, modified: 1, deleted: 2 };
  return groupFolders(root, out).sort((a, b) => order[a.status] - order[b.status] || a.path.localeCompare(b.path));
}

/** Files changed the same way in one folder from this many on are one row for the folder (a dataset, a cache, a build). */
export const FOLDER_ROW_FROM = 200;

/**
 * A folder where many files changed the same way (99,988 generated .npy and .wav files) becomes one row with the
 * count and total size, instead of a row each: the deepest folder that has at least FOLDER_ROW_FROM of them.
 */
export function groupFolders(root: string, files: OutputFile[]): OutputFile[] {
  const dirsOf = (p: string) => {
    const parts = p.split(/[\\/]/).slice(0, -1);
    return parts.map((_, i) => parts.slice(0, i + 1).join('/'));
  };
  const counts = new Map<string, number>();
  for (const f of files) for (const d of dirsOf(f.path)) counts.set(`${f.status}|${d}`, (counts.get(`${f.status}|${d}`) ?? 0) + 1);
  const groups = new Map<string, OutputFile>();
  const out: OutputFile[] = [];
  for (const f of files) {
    const dir = dirsOf(f.path).reverse().find((d) => (counts.get(`${f.status}|${d}`) ?? 0) >= FOLDER_ROW_FROM);
    if (!dir) {
      out.push(f);
      continue;
    }
    const key = `${f.status}|${dir}`;
    const g = groups.get(key);
    if (g) {
      g.count! += 1;
      g.size += f.size;
    } else groups.set(key, { path: `${dir}/`, abs: path.join(root, dir), status: f.status, size: f.size, count: 1 });
  }
  return [...out, ...groups.values()];
}
