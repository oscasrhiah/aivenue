// Linux package that works when built on Windows: a tar.gz of electron-builder's linux-unpacked folder
// with real Unix permissions (Windows has no execute bit, so electron-builder's own tar.gz lacks them),
// plus the launcher and install / uninstall scripts from packages/desktop/linux.
//   node scripts/package-linux.mjs        (after `npm run package:linux` produced linux-unpacked)
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const root = path.resolve(import.meta.dirname, '..');
const desktop = path.join(root, 'packages', 'desktop');
const unpacked = path.join(desktop, 'release', 'linux-unpacked');
const version = JSON.parse(fs.readFileSync(path.join(desktop, 'package.json'), 'utf8')).version;
const name = `Aivenue-${version}-linux-x64`;
const out = path.join(root, 'release', `${name}.tar.gz`);
if (!fs.existsSync(unpacked)) throw new Error(`missing ${unpacked}: run npm run package:linux first`);

const EXEC = new Set(['aivenue', 'chrome_crashpad_handler', 'chrome-sandbox', 'aivenue.sh', 'install.sh', 'uninstall.sh']);

/** [path inside the archive, source file or null for a folder, extra content] */
const entries = [];
const walk = (dir, rel) => {
  for (const d of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const r = `${rel}/${d.name}`;
    if (d.isDirectory()) {
      entries.push({ path: r + '/', dir: true });
      walk(path.join(dir, d.name), r);
    } else entries.push({ path: r, file: path.join(dir, d.name), exec: EXEC.has(d.name) && rel === name });
  }
};
entries.push({ path: name + '/', dir: true });
walk(unpacked, name);
// Shell scripts with Unix line endings, and the icon for the menu entry.
for (const f of ['aivenue.sh', 'install.sh', 'uninstall.sh']) entries.push({ path: `${name}/${f}`, data: Buffer.from(fs.readFileSync(path.join(desktop, 'linux', f), 'utf8').replace(/\r\n/g, '\n')), exec: true });
entries.push({ path: `${name}/aivenue.png`, file: path.join(desktop, 'build', 'icon.png') });

const octal = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
function header(p, size, mode, type) {
  const h = Buffer.alloc(512);
  let nm = p;
  let prefix = '';
  if (Buffer.byteLength(nm) > 100) {
    // ustar: split the path into prefix (≤155) / name (≤100) at a slash.
    const cut = p.lastIndexOf('/', Math.min(155, p.length - 2));
    if (cut <= 0 || Buffer.byteLength(p.slice(cut + 1)) > 100) throw new Error(`path too long for tar: ${p}`);
    prefix = p.slice(0, cut);
    nm = p.slice(cut + 1);
  }
  h.write(nm, 0, 100, 'utf8');
  h.write(octal(mode, 8), 100);
  h.write(octal(0, 8), 108);
  h.write(octal(0, 8), 116);
  h.write(octal(size, 12), 124);
  h.write(octal(Math.floor(Date.now() / 1000), 12), 136);
  h.write('        ', 148);
  h.write(type, 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  h.write('root', 265);
  h.write('root', 297);
  h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(octal(sum, 7) + ' ', 148);
  return h;
}

async function* chunks() {
  for (const e of entries) {
    if (e.dir) {
      yield header(e.path, 0, 0o755, '5');
      continue;
    }
    const data = e.data ?? fs.readFileSync(e.file);
    yield header(e.path, data.length, e.exec ? 0o755 : 0o644, '0');
    yield data;
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) yield Buffer.alloc(pad);
  }
  yield Buffer.alloc(1024);
}

fs.mkdirSync(path.dirname(out), { recursive: true });
await pipeline(Readable.from(chunks()), zlib.createGzip({ level: 9 }), fs.createWriteStream(out));
console.log(`${out} (${(fs.statSync(out).size / 1048576).toFixed(1)} MB, ${entries.length} entries)`);
