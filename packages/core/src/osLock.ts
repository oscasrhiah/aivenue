import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

/**
 * A lock the operating system holds for us and frees when the process ends, however it ends (crash, kill): a named
 * pipe on Windows (libuv creates the first instance with FILE_FLAG_FIRST_PIPE_INSTANCE, so a second listener gets
 * EADDRINUSE) and an abstract Unix socket on Linux (no file, nothing left behind). A paused or blocked holder keeps
 * it; nobody "takes over" a lock that looks stale.
 */
export class LockBusyError extends Error {
  constructor(name: string) {
    super(`lock busy: ${name}`);
  }
}

/** Same data folder → same name, whatever junction, link or letter case reaches it. */
export function lockName(dataDir: string, key: string): string {
  let real = path.resolve(dataDir);
  try {
    real = fs.realpathSync.native(real);
  } catch {
    // not created yet: the resolved path is what every process will use
  }
  if (process.platform === 'win32') real = real.replace(/\//g, '\\').toLowerCase();
  const h = createHash('sha1').update(real).digest('hex').slice(0, 12);
  return `aivenue-mem-${h}-${key.replace(/[^\w.-]/g, '_')}`;
}

function address(name: string): string {
  if (process.platform === 'win32') return `\\\\.\\pipe\\${name}`;
  if (process.platform === 'linux') return `\0${name}`;
  throw new Error(`project memory locks are not supported on ${process.platform}`);
}

function listen(addr: string): Promise<net.Server> {
  return new Promise((resolve, reject) => {
    const server = net.createServer((sock) => sock.destroy());
    server.once('error', reject);
    server.listen(addr, () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

const close = (server: net.Server) => new Promise<void>((resolve) => server.close(() => resolve()));

/**
 * Hold a lock until `release()` (a lease: a running workflow holds one while it may still queue memory candidates).
 * Undefined when someone else holds it. It is freed by the OS if the process ends.
 */
export async function holdOsLock(name: string): Promise<{ release: () => Promise<void> } | undefined> {
  try {
    const server = await listen(address(name));
    // A lease lasts as long as the workflow, not as a reason to keep the process running.
    server.unref();
    return { release: () => close(server) };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EADDRINUSE') return undefined;
    throw e;
  }
}

/** Whether some process (this one included) holds the lock right now. */
export async function isOsLockHeld(name: string): Promise<boolean> {
  const lease = await holdOsLock(name);
  if (!lease) return true;
  await lease.release();
  return false;
}

/** In this process, one holder per name at a time (the OS lock covers the others). */
const local = new Map<string, Promise<unknown>>();

/** Run `fn` while holding the lock `name`. Only "name in use" is retried; other errors are reported as they are. */
export async function withOsLock<T>(name: string, fn: () => T | Promise<T>, o: { timeoutMs?: number } = {}): Promise<T> {
  const before = local.get(name) ?? Promise.resolve();
  let done!: () => void;
  const mine = new Promise<void>((r) => (done = r));
  const chain = before.then(() => mine);
  local.set(name, chain);
  await before.catch(() => undefined);
  try {
    const addr = address(name);
    const deadline = Date.now() + (o.timeoutMs ?? 10_000);
    let wait = 50;
    let server: net.Server | undefined;
    while (!server) {
      try {
        server = await listen(addr);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw e;
        if (Date.now() + wait > deadline) throw new LockBusyError(name);
        await new Promise((r) => setTimeout(r, wait + Math.floor(Math.random() * 25)));
        wait = Math.min(wait * 2, 1000);
      }
    }
    try {
      return await fn();
    } finally {
      await close(server);
    }
  } finally {
    done();
    if (local.get(name) === chain) local.delete(name);
  }
}
