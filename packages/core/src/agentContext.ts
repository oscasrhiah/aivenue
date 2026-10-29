import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProviderSpec } from './types';
import { childEnv, resolveCommand, spawnResolved, specCommand } from './proc';
import { accountEnv } from './providers/registry';

/**
 * How full an agent's own conversation is, and compacting it from outside, for the CLIs that allow it.
 * Claude Code and OpenCode report the size in their output (see the parsers); Codex keeps it in its rollout file
 * and compacts through `codex app-server`.
 */

/** Rough token count: about 4 characters per token for Latin text, about 1 per character for CJK. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const cjk = (text.match(/[　-鿿가-힯＀-￯]/g) ?? []).length;
  return Math.ceil(cjk + (text.length - cjk) / 4);
}

const codexHome = (spec: ProviderSpec) => accountEnv(spec).CODEX_HOME ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');

/** The rollout file of a Codex thread: sessions/YYYY/MM/DD/rollout-…-<threadId>.jsonl, newest days first. */
function codexRollout(home: string, threadId: string): string | undefined {
  const root = path.join(home, 'sessions');
  const dirs = (p: string) => {
    try {
      return fs.readdirSync(p).filter((n) => /^\d+$/.test(n)).sort().reverse();
    } catch {
      return [];
    }
  };
  let checked = 0;
  for (const y of dirs(root))
    for (const m of dirs(path.join(root, y)))
      for (const d of dirs(path.join(root, y, m))) {
        if (++checked > 120) return undefined;
        const dir = path.join(root, y, m, d);
        const hit = fs.readdirSync(dir).find((f) => f.endsWith(`${threadId}.jsonl`));
        if (hit) return path.join(dir, hit);
      }
  return undefined;
}

/** Codex's latest context reading for a thread: tokens of the last model call and the model's window. */
export function codexContext(spec: ProviderSpec, threadId: string): { used?: number; window?: number } | undefined {
  const file = codexRollout(codexHome(spec), threadId);
  if (!file) return undefined;
  // The reading is near the end; the file can be large, so read only its tail.
  const size = fs.statSync(file).size;
  const fd = fs.openSync(file, 'r');
  try {
    const len = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    const lines = buf.toString('utf8').split('\n').filter((l) => l.includes('"token_count"'));
    for (const line of lines.reverse()) {
      try {
        const info = JSON.parse(line).payload?.info;
        if (info) return { used: info.last_token_usage?.input_tokens, window: info.model_context_window };
      } catch {
        // a line cut by the tail read
      }
    }
    return undefined;
  } finally {
    fs.closeSync(fd);
  }
}

/** Compact a Codex thread with app-server's thread/compact/start; resolves when the compaction turn completes. */
export function compactCodexThread(spec: ProviderSpec, threadId: string, timeoutMs = 300000): Promise<void> {
  const cmd = resolveCommand(specCommand(spec));
  if (!cmd) return Promise.reject(new Error('codex not found'));
  return new Promise((resolve, reject) => {
    const child = spawnResolved(cmd, ['app-server'], { env: childEnv(accountEnv(spec)), stdio: ['pipe', 'pipe', 'ignore'] });
    let settled = false;
    const done = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => done(new Error('Codex compaction timed out')), timeoutMs);
    const send = (m: unknown) => child.stdin?.write(JSON.stringify(m) + '\n');
    let started = false;
    let buf = '';
    child.on('error', (e) => done(e));
    child.on('exit', () => done(started ? undefined : new Error('codex app-server exited')));
    child.stdout?.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.id === 1) {
          send({ method: 'initialized' });
          send({ id: 2, method: 'thread/resume', params: { threadId } });
        } else if (m.id === 2) {
          if (m.error) return done(new Error(m.error.message ?? 'thread/resume failed'));
          send({ id: 3, method: 'thread/compact/start', params: { threadId } });
        } else if (m.id === 3) {
          if (m.error) return done(new Error(m.error.message ?? 'thread/compact/start failed'));
          started = true;
        } else if (started && (m.method === 'turn/completed' || m.method === 'thread/compacted')) {
          done();
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'aivenue', title: 'Aivenue', version: '0.2.3' } } });
  });
}
