import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ProcessDetail, TrackedProcess } from './types';
import { pidAlive } from './resources';

/** "15.6GB", "800 MB", 1234 → bytes (undefined when it can't be read). */
export function parseSize(v: unknown): number | undefined {
  if (typeof v === 'number') return v > 0 ? v : undefined;
  const m = /^\s*([\d.]+)\s*([kmgt]?i?b?)?\s*$/i.exec(String(v ?? ''));
  if (!m) return undefined;
  const n = Number(m[1]);
  const unit = (m[2] ?? '').toLowerCase().replace(/i?b$/, '');
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[unit];
  return Number.isFinite(n) && n > 0 && mult ? Math.round(n * mult) : undefined;
}

/** Size of a file, or of every file in a folder (up to 20 000 files). */
function sizeOf(target: string): number | undefined {
  let left = 20000;
  const walk = (p: string): number => {
    if (left-- <= 0) return 0;
    let st: fs.Stats;
    try {
      st = fs.statSync(p);
    } catch {
      return 0;
    }
    if (!st.isDirectory()) return st.size;
    let sum = 0;
    for (const e of fs.readdirSync(p)) sum += walk(path.join(p, e));
    return sum;
  };
  return fs.existsSync(target) ? walk(target) : undefined;
}

/** The last lines of a log (progress bars rewrite one line with \r: each rewrite counts as a line). */
function tail(file: string, lines = 15): string[] | undefined {
  try {
    const st = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    const len = Math.min(st.size, 32 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    // eslint-disable-next-line no-control-regex
    const text = buf.toString('utf8').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
    return text
      .split(/\r\n|\r|\n/)
      .map((l) => l.trimEnd())
      .filter((l) => l.trim())
      .slice(-lines);
  } catch {
    return undefined;
  }
}

/** Memory the process uses (MB), from the OS. */
function memoryMB(pid: number): number | undefined {
  try {
    if (process.platform === 'linux') {
      const m = /VmRSS:\s+(\d+)\s*kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'));
      return m ? Math.round(Number(m[1]) / 1024) : undefined;
    }
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', timeout: 8000, windowsHide: true });
      const m = /"([\d,.\s]+)\s*K"\s*$/m.exec(out);
      return m ? Math.round(Number(m[1].replace(/[^\d]/g, '')) / 1024) : undefined;
    }
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8', timeout: 8000 });
    return Math.round(Number(out.trim()) / 1024) || undefined;
  } catch {
    return undefined;
  }
}

/** Last size seen per watched target, for the speed (and from it the time left). */
const samples = new Map<string, { bytes: number; at: number; speed?: number }>();

/**
 * Where a background process stands: alive, how long it runs, its memory, and its progress from (in this order) the
 * size of the file it writes against the expected size, a percentage in its log, or what the agent reported.
 */
export function inspectProcess(p: TrackedProcess, cwd: string): ProcessDetail {
  const now = Date.now();
  const alive = pidAlive(p.pid);
  const d: ProcessDetail = { pid: p.pid, purpose: p.purpose, cleanup: p.cleanup, agentId: p.agentId, alive, startedAt: p.startedAt, runtimeSec: Math.round(((alive ? now : (p.endedAt ?? p.checkedAt ?? now)) - p.startedAt) / 1000), memMB: alive ? memoryMB(p.pid) : undefined };
  if (p.watchFile) {
    const target = path.resolve(cwd, p.watchFile);
    d.watchFile = target;
    d.bytes = sizeOf(target);
    d.expectedBytes = p.expectedBytes;
    if (d.bytes !== undefined) {
      const key = `${p.pid}|${target}`;
      const last = samples.get(key);
      const dt = last ? (now - last.at) / 1000 : 0;
      // Smoothed so one quiet second does not show 0 B/s.
      const speed = last && dt >= 1 ? Math.max(0, (d.bytes - last.bytes) / dt) : last?.speed;
      const smooth = speed !== undefined && last?.speed !== undefined ? last.speed * 0.5 + speed * 0.5 : speed;
      if (!last || dt >= 1) samples.set(key, { bytes: d.bytes, at: now, speed: smooth });
      d.speed = smooth;
      if (p.expectedBytes) {
        d.percent = Math.min(100, (d.bytes / p.expectedBytes) * 100);
        d.source = 'file';
        if (smooth && smooth > 0 && d.bytes < p.expectedBytes) d.etaSec = Math.round((p.expectedBytes - d.bytes) / smooth);
      }
    }
  }
  if (p.log) {
    const file = path.resolve(cwd, p.log);
    d.log = file;
    d.logTail = tail(file);
    if (d.percent === undefined && d.logTail) {
      for (let i = d.logTail.length - 1; i >= 0; i--) {
        const all = [...d.logTail[i].matchAll(/(\d{1,3}(?:\.\d+)?)\s?%/g)];
        const v = all.length ? Number(all[all.length - 1][1]) : NaN;
        if (v >= 0 && v <= 100) {
          d.percent = v;
          d.source = 'log';
          break;
        }
      }
    }
  }
  if (p.progress) {
    d.note = p.progress.note;
    d.reportedAt = p.progress.at;
    if (d.percent === undefined && p.progress.percent !== undefined) {
      d.percent = p.progress.percent;
      d.source = 'agent';
    }
  }
  if (!alive && d.percent !== undefined && d.percent < 100) d.endedEarly = true;
  return d;
}
