import * as fs from 'node:fs';
import * as path from 'node:path';
import { defaultDataDir, HubBusyError, startHub, WindowRegistry, type Hub } from '@aivenue/core';
import { endpointFile, type Endpoint } from './sharedHub';

/**
 * The hub every VS Code window shares (dist/hub.cjs). A window starts it (VS Code's own runtime with
 * ELECTRON_RUN_AS_NODE, or the remote server's Node) and hands it, on stdin, the version and what the extension's
 * secret storage holds. It runs on its own, so closing one window stops nothing the others use. When no window has
 * been connected for a while (all closed; a reload comes back within it) it stops its agents, as VS Code closing did
 * before, so the workflows resume on the next start, and exits.
 */

/** Set by scripts/build.mjs (esbuild define). */
declare const __AIVENUE_BUILD__: string | undefined;
const BUILD = typeof __AIVENUE_BUILD__ === 'string' ? __AIVENUE_BUILD__ : 'dev';
/** How long the hub waits with no window connected before it stops (a window reload takes seconds). */
const GRACE_MS = Number(process.env.AIVENUE_HUB_GRACE_MS) || 30_000;

function readInit(): Promise<{ version?: string; secrets?: Record<string, string> }> {
  return new Promise((resolve) => {
    let raw = '';
    const done = () => {
      try {
        resolve(raw.trim() ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    };
    // Started by hand or without a window: nothing comes.
    const timer = setTimeout(done, 5000);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (raw += d));
    process.stdin.on('end', () => (clearTimeout(timer), done()));
    process.stdin.on('error', () => (clearTimeout(timer), done()));
  });
}

async function main() {
  const init = await readInit();
  const dataDir = defaultDataDir();
  const log = (line: string) => {
    try {
      fs.mkdirSync(path.join(dataDir, 'logs'), { recursive: true });
      fs.appendFileSync(path.join(dataDir, 'logs', 'vscode-hub.log'), `${new Date().toISOString()} [${process.pid}] ${line}\n`);
    } catch {
      // no log
    }
  };
  const windows = new WindowRegistry();
  let hub: Hub;
  try {
    hub = await startHub({
      uiDir: path.join(__dirname, 'ui'),
      bridgePath: path.join(__dirname, 'bridge.cjs'),
      version: init.version,
      secrets: windows.secretStore(init.secrets ?? {}),
      hooks: windows.hooks(),
      windows,
    });
  } catch (e) {
    // Another window started the hub first: that one serves every window.
    if (e instanceof HubBusyError) {
      log('another hub serves this data folder; exiting');
      process.exit(0);
    }
    log(`could not start: ${(e as Error).stack ?? e}`);
    process.exit(1);
  }
  const file = endpointFile(dataDir);
  const endpoint: Endpoint = { pid: process.pid, port: hub.port, token: hub.token, build: BUILD, version: init.version ?? '', startedAt: Date.now() };
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(endpoint), { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
  log(`serving on port ${hub.port} (build ${BUILD})`);

  let stopping = false;
  const stop = async (why: string) => {
    if (stopping) return;
    stopping = true;
    log(`stopping: ${why}`);
    try {
      if ((JSON.parse(fs.readFileSync(file, 'utf8')) as Endpoint).pid === process.pid) fs.rmSync(file, { force: true });
    } catch {
      // already gone
    }
    await hub.close();
    process.exit(0);
  };

  windows.control = (method) => {
    if (method === 'status') return { ...hub.status(), build: BUILD, pid: process.pid };
    if (method === 'shutdown') {
      // Asked by a window of a newer build, to be replaced: never while work is going.
      if (hub.status().active) throw new Error('workflows are still running');
      setTimeout(() => void stop('replaced by a newer build'), 50);
      return { ok: true };
    }
    throw new Error(`unknown control ${method}`);
  };

  let idle: NodeJS.Timeout | undefined;
  const watch = (count: number) => {
    clearTimeout(idle);
    if (count === 0) idle = setTimeout(() => void stop('no VS Code window connected'), GRACE_MS);
  };
  windows.onCount(watch);
  watch(windows.count);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => void stop(sig));
}

void main();
