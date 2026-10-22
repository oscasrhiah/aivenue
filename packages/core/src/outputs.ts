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
  return out.sort((a, b) => order[a.status] - order[b.status] || a.path.localeCompare(b.path));
}
