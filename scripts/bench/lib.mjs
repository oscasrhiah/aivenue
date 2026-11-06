// Shared by the benchmark (run.mjs, free OpenCode models only) and the pilot with another CLI (pilot.mjs): processes
// under one deadline, checkouts of the fixture, the hidden acceptance tests and the connection to a hub.
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

export const here = path.dirname(fileURLToPath(import.meta.url));
export const root = path.resolve(here, '..', '..');
export const TASKS = JSON.parse(fs.readFileSync(path.join(here, 'tasks.json'), 'utf8')).tasks;

/**
 * The environment of a process that works in `dir`: PWD (and INIT_CWD) point there as well as the working folder.
 * OpenCode sessions were seen located in the folder the benchmark was started from (its PWD), not in the process's
 * own working folder.
 */
export function envFor(dir, extra = {}) {
  const env = { ...process.env, ...extra, PWD: dir, INIT_CWD: dir };
  delete env.OLDPWD;
  return env;
}

export const hubEntry = () => process.env.BENCH_HUB_ENTRY ?? path.join(root, 'packages', 'desktop', 'dist', 'standalone.cjs');

export function killTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}

export class Deadline extends Error {}

/**
 * One run under one deadline: everything it starts (`ctx.spawn`) is ended when it finishes, fails or runs out of
 * time, and every wait (`ctx.wait`) gives up at the deadline.
 */
/** After the deadline, cleanup (cancelling a workflow, closing sockets) gets at most this long in all; it is recorded. */
export const CLEANUP_GRACE_MS = 10000;

export async function withDeadline(ms, fn, report = {}) {
  const children = [];
  const cleanups = [];
  const until = Date.now() + ms;
  let timer;
  const expired = new Promise((_, reject) => (timer = setTimeout(() => reject(new Deadline('time limit')), ms)));
  expired.catch(() => undefined);
  const ctx = {
    until,
    left: () => Math.max(0, until - Date.now()),
    spawn: (cmd, args, o) => {
      const c = spawn(cmd, args, { windowsHide: true, ...o });
      children.push(c);
      return c;
    },
    onCleanup: (f) => cleanups.push(f),
    wait: (p) => Promise.race([p, expired]),
    /** What the run has seen so far (usage, sessions): kept when it runs out of time. */
    partial: {},
  };
  try {
    return await ctx.wait(fn(ctx));
  } catch (e) {
    if (e instanceof Deadline) e.partial = ctx.partial;
    throw e;
  } finally {
    clearTimeout(timer);
    const cleanupStart = Date.now();
    let grace;
    const graceOver = new Promise((r) => (grace = setTimeout(r, CLEANUP_GRACE_MS)));
    for (const f of cleanups) {
      try {
        await Promise.race([f(), graceOver]);
      } catch {
        // cleanup goes on
      }
    }
    clearTimeout(grace);
    for (const c of children) killTree(c);
    report.cleanupMs = Date.now() - cleanupStart;
  }
}

export function hashDir(dir, skip = new Set()) {
  const h = createHash('sha256');
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (skip.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, `${rel}${e.name}/`);
      else h.update(`${rel}${e.name}\0`).update(fs.readFileSync(p)).update('\0');
    }
  };
  walk(dir, '');
  return h.digest('hex');
}

export const fileHash = (f) => (fs.existsSync(f) ? createHash('sha256').update(fs.readFileSync(f)).digest('hex') : 'missing');

export function git(args, cwd = root) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return '';
  }
}

export function newCheckout(work, name, overlay = []) {
  const dir = path.join(work, name, 'repo');
  fs.cpSync(path.join(here, 'fixture'), dir, { recursive: true });
  const g = (...a) => execFileSync('git', ['-c', 'user.name=bench', '-c', 'user.email=bench@example.invalid', ...a], { cwd: dir, stdio: 'ignore' });
  g('init', '-q');
  g('add', '.');
  g('commit', '-q', '-m', 'start');
  for (const from of overlay) fs.cpSync(from, path.join(dir, 'src'), { recursive: true });
  return dir;
}

/** Hidden acceptance tests and the checkout's own (visible) tests. */
export function acceptance(task, checkout) {
  const file = path.join(here, 'acceptance', task.acceptance);
  // Not as a child of another test run: node --test would then report in its own format, not as text.
  const { NODE_TEST_CONTEXT: _ignored, ...base } = process.env;
  const r = spawnSync(process.execPath, ['--test', file], { env: { ...base, BENCH_CHECKOUT: checkout }, encoding: 'utf8', timeout: 120000 });
  const pass = Number(/ℹ pass (\d+)/.exec(r.stdout)?.[1] ?? 0);
  const fail = Number(/ℹ fail (\d+)/.exec(r.stdout)?.[1] ?? 0);
  const visible = spawnSync(process.execPath, ['--test'], { cwd: checkout, env: base, encoding: 'utf8', timeout: 120000 });
  const hiddenOk = r.status === 0 && fail === 0 && pass > 0;
  const visibleOk = visible.status === 0;
  return { ok: hiddenOk && visibleOk, hiddenOk, visibleOk, pass, fail };
}

export async function startHub(ctx, home, cwd) {
  const child = ctx.spawn(process.execPath, [hubEntry()], { cwd, env: envFor(cwd, { AIVENUE_HOME: home, PORT: '0', AIVENUE_CWD: cwd }), stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await ctx.wait(
    new Promise((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (d) => {
        out += d;
        const m = /Aivenue running: (http:\/\/[^\s]+)/.exec(out);
        if (m) resolve(m[1]);
      });
      child.stderr.on('data', (d) => (out += d));
      child.on('exit', (c) => reject(new Error(`the hub exited (${c}):\n${out.slice(-1500)}`)));
    }),
  );
  const u = new URL(url);
  const ws = new WebSocket(`ws://${u.host}/ws?token=${u.searchParams.get('token')}`);
  ctx.onCleanup(async () => ws.close());
  await ctx.wait(new Promise((res, rej) => (ws.once('open', res), ws.once('error', rej))));
  let seq = 0;
  const waiting = new Map();
  ws.on('message', (m) => {
    const msg = JSON.parse(String(m));
    const w = msg.id !== undefined && waiting.get(msg.id);
    if (!w) return;
    waiting.delete(msg.id);
    msg.error ? w.reject(new Error(msg.error.message ?? String(msg.error))) : w.resolve(msg.result);
  });
  // Every call gives up at the run's deadline (a hub that never answers cannot hold the benchmark).
  const call = (method, params = {}) =>
    ctx.wait(
      new Promise((resolve, reject) => {
        const id = ++seq;
        waiting.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      }),
    );
  return { call };
}
