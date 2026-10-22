import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Attachment, AttachmentKind, ProviderProfile } from './types';
import { L } from './i18n';
import { classify, extractCompanion, looksLikeText } from './extract';
import { readability, REASON_EN } from './readability';

function kindOf(file: string, mime: string): AttachmentKind {
  const k = classify(file, mime);
  return k === 'binary' && looksLikeText(file) ? 'text' : k;
}

const MAX_BYTES = 25 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
};

export const isImage = (a: Pick<Attachment, 'mime'>) => /^image\/(png|jpe?g|gif|webp|bmp)$/.test(a.mime);

function safeName(name: string): string {
  // Also no characters a Windows shell acts on: file names end up as CLI arguments.
  const base = path.basename(name).replace(/[<>:"/\\|?*&^%!\x00-\x1f]/g, '_').trim();
  return base.slice(-120) || 'file';
}

/**
 * Files attached in the chat. Uploads land in <dataDir>/uploads/<id>/; when a workflow starts
 * they are moved into <dataDir>/runs/<runId>/attachments/ so each run keeps its own copy.
 */
export class AttachmentStore {
  readonly uploadsDir: string;

  constructor(private dataDir: string) {
    this.uploadsDir = path.join(dataDir, 'uploads');
    fs.mkdirSync(this.uploadsDir, { recursive: true });
    this.cleanup();
  }

  /** Remove uploads that were never sent (older than a day). */
  private cleanup() {
    const cutoff = Date.now() - 86400000;
    for (const d of fs.readdirSync(this.uploadsDir)) {
      const p = path.join(this.uploadsDir, d);
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { recursive: true, force: true });
      } catch {
        // already gone
      }
    }
  }

  saveUpload(name: string, mime: string, base64: string): Attachment {
    const data = Buffer.from(base64, 'base64');
    if (data.length > MAX_BYTES) throw new Error(L('檔案超過 25 MB 上限', 'File exceeds the 25 MB limit'));
    const dir = path.join(this.uploadsDir, randomUUID());
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, safeName(name));
    fs.writeFileSync(file, data);
    const type = mime || MIME_BY_EXT[path.extname(file).toLowerCase()] || 'application/octet-stream';
    return { name: path.basename(file), path: file, size: data.length, mime: type, kind: kindOf(file, type) };
  }

  /** Copy local files (picked with the native dialog) into uploads. */
  importFiles(files: string[]): Attachment[] {
    return files.map((f) => {
      const st = fs.statSync(f);
      if (st.size > MAX_BYTES) throw new Error(L(`${path.basename(f)} 超過 25 MB 上限`, `${path.basename(f)} exceeds the 25 MB limit`));
      const dir = path.join(this.uploadsDir, randomUUID());
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, safeName(f));
      fs.copyFileSync(f, dest);
      const type = MIME_BY_EXT[path.extname(dest).toLowerCase()] || 'application/octet-stream';
      return { name: path.basename(dest), path: dest, size: st.size, mime: type, kind: kindOf(dest, type) };
    });
  }

  /** Make agent-readable companions (extracted text / unpacked archives) next to the run's files. */
  async prepare(list: Attachment[]): Promise<{ attachments: Attachment[]; warnings: string[] }> {
    const warnings: string[] = [];
    const out: Attachment[] = [];
    for (const a of list) {
      const kind = a.kind ?? kindOf(a.path, a.mime);
      try {
        // A companion made earlier is reused only if it is one of Aivenue's own files.
        const companion = a.companion && this.servable(a.companion.path) ? a.companion : await extractCompanion(a.path, kind);
        out.push({ ...a, kind, companion });
        if (companion?.note) warnings.push(`${a.name}: ${companion.note}`);
      } catch (e) {
        warnings.push(L(`${a.name} 轉換失敗：${(e as Error).message}`, `${a.name}: conversion failed: ${(e as Error).message}`));
        out.push({ ...a, kind });
      }
    }
    return { attachments: out, warnings };
  }

  discard(a: Attachment) {
    if (this.isUpload(a.path)) fs.rmSync(path.dirname(a.path), { recursive: true, force: true });
  }

  /** Exactly uploads/<folder>/<file>: deleting an upload removes its own folder, never uploads/ itself. */
  private isUpload(p: string) {
    const rel = path.relative(this.uploadsDir, path.resolve(p));
    const parts = rel.split(path.sep);
    return !!rel && !path.isAbsolute(rel) && parts.length === 2 && !parts.includes('..') && !parts.includes('');
  }

  /** Move a run's attachments into its folder; attachments of earlier runs (follow-ups) are copied. */
  adopt(runId: string, list: Attachment[] | undefined): Attachment[] {
    if (!list?.length) return [];
    const dir = this.runDir(runId);
    fs.mkdirSync(dir, { recursive: true });
    const used = new Set<string>();
    return list.map((a) => {
      if (!this.servable(a.path) || !fs.existsSync(a.path)) throw new Error(L(`找不到附件：${a.name}`, `Attachment not found: ${a.name}`));
      let name = safeName(a.name);
      const safe = name;
      for (let i = 2; used.has(name.toLowerCase()); i++) name = `${path.parse(safe).name} (${i})${path.extname(safe)}`;
      used.add(name.toLowerCase());
      const dest = path.join(dir, name);
      if (this.isUpload(a.path)) {
        fs.renameSync(a.path, dest);
        fs.rmSync(path.dirname(a.path), { recursive: true, force: true });
      } else fs.copyFileSync(a.path, dest);
      return { ...a, name, path: dest };
    });
  }

  runDir(runId: string) {
    return path.join(this.dataDir, 'runs', runId, 'attachments');
  }

  /** Only files inside uploads/ or runs/<id>/attachments/ may be served or attached. */
  servable(p: string): boolean {
    const abs = path.resolve(p);
    if (this.isUpload(abs)) return true;
    const relRaw = path.relative(path.join(this.dataDir, 'runs'), abs);
    // On Windows a file on another drive gives an absolute "relative" path.
    if (!relRaw || path.isAbsolute(relRaw)) return false;
    const rel = relRaw.split(path.sep);
    return rel.length >= 3 && !rel.includes('..') && rel[0] !== '' && rel[1] === 'attachments';
  }
}

/**
 * Prompt section listing the attached files for one provider: where each file is, which
 * agent-readable version to use, and an explicit instruction when this agent cannot read it.
 */
export function attachmentsBlock(list: Attachment[] | undefined, profile?: ProviderProfile): string {
  if (!list?.length) return '';
  const fmt = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
  const lines: string[] = [];
  let blocked = false;
  for (const a of list) {
    const type = a.mime && a.mime !== 'application/octet-stream' ? a.mime : a.kind ?? 'file';
    lines.push(`- ${a.name} (${type}, ${fmt(a.size)}): ${a.path}`);
    const r = readability(a, profile);
    if (!r.ok) {
      blocked = true;
      lines.push(`  ⚠ You cannot read this file: ${REASON_EN[r.reason!]}.`);
      continue;
    }
    if (r.via === 'extracted-text' && a.companion?.type === 'text') lines.push(`  Read its text version extracted by Aivenue: ${a.companion.path}`);
    else if (a.companion?.type === 'text' && a.kind === 'pdf') lines.push(`  A text version extracted by Aivenue is also available: ${a.companion.path}`);
    if (a.companion?.type === 'folder') lines.push(`  Unpacked by Aivenue into: ${a.companion.path}${a.companion.note ? ` (${a.companion.note})` : ''}`);
    if (a.kind === 'pdf' && a.companion?.note) lines.push(`  Note: ${a.companion.note}.`);
  }
  return [
    '',
    'ATTACHED FILES (provided by the user with this task; open them with your file-reading tools):',
    ...lines,
    blocked ? 'For any file marked ⚠: do NOT guess its contents. If the task depends on it, state clearly in your reply (and in any submission summary) which file you could not read and why, and continue with what you can do.' : '',
  ]
    .filter(Boolean)
    .join('\n');
}
