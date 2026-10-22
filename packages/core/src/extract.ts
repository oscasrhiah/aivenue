import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import type { AttachmentKind } from './types';

// ---------- classification ----------

const EXT: Record<string, AttachmentKind> = {};
const add = (kind: AttachmentKind, exts: string) => exts.split(' ').forEach((e) => (EXT[e] = kind));
add('image', '.png .jpg .jpeg .gif .webp .bmp');
add('image-other', '.heic .heif .tif .tiff .avif .ico .psd .raw .cr2 .nef');
add('pdf', '.pdf');
add('office', '.docx .xlsx .pptx .odt .ods .odp .xlsm');
add('legacy-office', '.doc .xls .ppt .rtf .pages .numbers .key');
add('notebook', '.ipynb');
add('archive', '.zip');
add('audio', '.mp3 .wav .m4a .aac .ogg .flac .opus .wma');
add('video', '.mp4 .mov .webm .mkv .avi .m4v .wmv');
add(
  'text',
  '.txt .md .markdown .csv .tsv .json .jsonl .yaml .yml .toml .ini .cfg .conf .xml .html .htm .css .scss .less .svg .log .sql .graphql .env.example ' +
    '.js .jsx .ts .tsx .mjs .cjs .py .rb .go .rs .java .kt .kts .swift .c .h .cpp .hpp .cc .cs .php .lua .r .m .scala .dart .vue .svelte .sh .bash .zsh .ps1 .bat .cmd .gradle .tex .bib .rst .adoc .proto .tf .dockerfile .makefile',
);

export function classify(name: string, mime = ''): AttachmentKind {
  const ext = path.extname(name).toLowerCase();
  if (EXT[ext]) return EXT[ext];
  if (/^(dockerfile|makefile|readme|license|changelog)$/i.test(path.basename(name))) return 'text';
  if (mime.startsWith('image/')) return 'image-other';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('text/') || /json|xml|javascript|yaml/.test(mime)) return 'text';
  return 'binary';
}

/** Content sniffing for unknown extensions: treat as text when it decodes as UTF-8 without NULs. */
export function looksLikeText(file: string): boolean {
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(8192);
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  const chunk = buf.subarray(0, n);
  if (chunk.includes(0)) return false;
  try {
    // Drop the tail so a multi-byte character cut at the buffer edge is not mistaken for binary.
    new TextDecoder('utf-8', { fatal: true }).decode(chunk.subarray(0, Math.max(0, chunk.length - 4)));
    return true;
  } catch {
    return false;
  }
}

// ---------- minimal ZIP reader (central directory + deflate) ----------

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

const MAX_ENTRY_BYTES = 200 * 1024 * 1024;

export function readZip(buf: Buffer): { entries: ZipEntry[]; read: (e: ZipEntry) => Buffer } {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compressedSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, method, compressedSize, size, offset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  const read = (e: ZipEntry): Buffer => {
    const lh = e.offset;
    const start = lh + 30 + buf.readUInt16LE(lh + 26) + buf.readUInt16LE(lh + 28);
    const data = buf.subarray(start, start + e.compressedSize);
    // The declared size is the limit: a "zip bomb" that inflates far beyond it is cut off, not unpacked.
    if (e.size > MAX_ENTRY_BYTES) throw new Error(`zip entry too large: ${e.name}`);
    const out = e.method === 0 ? Buffer.from(data) : e.method === 8 ? zlib.inflateRawSync(data, { maxOutputLength: Math.max(e.size, 1) }) : undefined;
    if (!out) throw new Error(`unsupported zip compression ${e.method}`);
    if (out.length !== e.size) throw new Error(`zip entry size mismatch: ${e.name}`);
    return out;
  };
  return { entries, read };
}

// ---------- XML helpers ----------

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s: string) => s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => (e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e] ?? m));
const stripTags = (s: string) => decode(s.replace(/<[^>]+>/g, ''));

function docxText(xml: string): string {
  return stripTags(
    xml
      .replace(/<w:tab\/>/g, '\t')
      .replace(/<w:br\/>/g, '\n')
      .replace(/<\/w:p>/g, '\n'),
  ).replace(/\n{3,}/g, '\n\n');
}

function odfText(xml: string): string {
  return stripTags(
    xml
      .replace(/<text:tab\/>/g, '\t')
      .replace(/<text:line-break\/>/g, '\n')
      .replace(/<\/text:(p|h)>/g, '\n')
      .replace(/<\/table:table-cell>/g, '\t')
      .replace(/<\/table:table-row>/g, '\n'),
  ).replace(/\n{3,}/g, '\n\n');
}

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  return [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

function xlsxText(zip: ReturnType<typeof readZip>): string {
  const get = (n: string) => {
    const e = zip.entries.find((x) => x.name === n);
    return e ? zip.read(e).toString('utf8') : '';
  };
  const shared = [...get('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => stripTags(m[1]));
  const wb = get('xl/workbook.xml');
  const rels = get('xl/_rels/workbook.xml.rels');
  const sheets = [...wb.matchAll(/<sheet [^>]*name="([^"]*)"[^>]*r:id="([^"]*)"/g)].map((m) => {
    const target = new RegExp(`Id="${m[2]}"[^>]*Target="([^"]*)"`).exec(rels)?.[1] ?? '';
    return { name: decode(m[1]), file: 'xl/' + target.replace(/^\/?xl\//, '') };
  });
  const out: string[] = [];
  for (const s of sheets) {
    const xml = get(s.file);
    const rows: string[] = [];
    for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const c of row[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1];
        const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? '';
        const type = /t="(\w+)"/.exec(attrs)?.[1];
        const inner = c[2] ?? '';
        let v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '';
        if (type === 's') v = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') v = stripTags(inner);
        else v = decode(v);
        cells[colIndex(ref)] = csvCell(v);
      }
      rows.push(Array.from(cells, (x) => x ?? '').join(','));
      if (rows.length >= 5000) {
        rows.push('… (truncated at 5000 rows)');
        break;
      }
    }
    out.push(`## Sheet: ${s.name}\n${rows.join('\n')}`);
  }
  return out.join('\n\n');
}

function pptxText(zip: ReturnType<typeof readZip>): string {
  const slides = zip.entries
    .filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e.name))
    .sort((a, b) => Number(/\d+/.exec(path.basename(a.name))![0]) - Number(/\d+/.exec(path.basename(b.name))![0]));
  return slides
    .map((e, i) => {
      const xml = zip.read(e).toString('utf8');
      const paras = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)].map((p) => [...p[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => decode(t[1])).join('')).filter(Boolean);
      return `## Slide ${i + 1}\n${paras.join('\n')}`;
    })
    .join('\n\n');
}

function notebookText(json: any): string {
  const lang = json.metadata?.kernelspec?.language ?? 'python';
  return (json.cells ?? [])
    .map((c: any, i: number) => {
      const src = Array.isArray(c.source) ? c.source.join('') : String(c.source ?? '');
      if (c.cell_type === 'markdown') return src;
      const outs = (c.outputs ?? [])
        .map((o: any) => (Array.isArray(o.text) ? o.text.join('') : o.data?.['text/plain'] ? [].concat(o.data['text/plain']).join('') : ''))
        .filter(Boolean)
        .join('\n');
      return `### Cell ${i + 1}\n\`\`\`${lang}\n${src}\n\`\`\`${outs ? `\nOutput:\n\`\`\`\n${outs.slice(0, 4000)}\n\`\`\`` : ''}`;
    })
    .join('\n\n');
}

async function pdfText(file: string): Promise<string> {
  // The lib entry avoids pdf-parse's index.js, which reads a bundled test file when loaded.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const parse = require('pdf-parse/lib/pdf-parse.js') as (b: Buffer) => Promise<{ text: string; numpages: number }>;
  // The bundled pdf.js uses the deprecated Buffer() constructor; keep that warning out of the logs.
  const quiet = process.noDeprecation;
  process.noDeprecation = true;
  try {
    const r = await parse(fs.readFileSync(file));
    return `(${r.numpages} pages)\n\n${r.text}`;
  } finally {
    process.noDeprecation = quiet;
  }
}

const MAX_ZIP_FILES = 2000;
const MAX_ZIP_BYTES = 200 * 1024 * 1024;

/**
 * Produce an agent-readable companion for a file: extracted text (<file>.txt) or, for .zip,
 * an extracted folder. Returns undefined when the file is already readable or cannot be converted.
 */
export async function extractCompanion(file: string, kind: AttachmentKind): Promise<{ path: string; type: 'text' | 'folder'; note?: string } | undefined> {
  const out = file + '.txt';
  const ext = path.extname(file).toLowerCase();
  if (kind === 'pdf') {
    const text = await pdfText(file);
    if (text.replace(/\(\d+ pages\)/, '').trim().length < 20) return { path: out, type: 'text', note: 'scanned PDF: little or no extractable text' };
    fs.writeFileSync(out, text);
    return { path: out, type: 'text' };
  }
  if (kind === 'notebook') {
    fs.writeFileSync(out, notebookText(JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, ''))));
    return { path: out, type: 'text' };
  }
  if (kind === 'office') {
    const zip = readZip(fs.readFileSync(file));
    const get = (n: string) => {
      const e = zip.entries.find((x) => x.name === n);
      return e ? zip.read(e).toString('utf8') : '';
    };
    let text = '';
    if (ext === '.docx') text = docxText(get('word/document.xml'));
    else if (ext === '.xlsx' || ext === '.xlsm') text = xlsxText(zip);
    else if (ext === '.pptx') text = pptxText(zip);
    else text = odfText(get('content.xml'));
    fs.writeFileSync(out, text);
    return { path: out, type: 'text' };
  }
  if (kind === 'archive') {
    const dir = file + '.extracted';
    const zip = readZip(fs.readFileSync(file));
    let total = 0;
    let n = 0;
    for (const e of zip.entries) {
      if (e.name.endsWith('/')) continue;
      // Zip-slip guard: entries must stay inside the target folder.
      const dest = path.resolve(dir, e.name);
      if (!dest.startsWith(path.resolve(dir) + path.sep)) continue;
      if (++n > MAX_ZIP_FILES || (total += e.size) > MAX_ZIP_BYTES) return { path: dir, type: 'folder', note: `partially extracted (limit ${MAX_ZIP_FILES} files / 200 MB)` };
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      let data: Buffer;
      try {
        data = zip.read(e);
      } catch {
        continue; // damaged or oversized entry
      }
      fs.writeFileSync(dest, data);
    }
    return { path: dir, type: 'folder' };
  }
  return undefined;
}
