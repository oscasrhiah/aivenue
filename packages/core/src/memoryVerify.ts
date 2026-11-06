import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { memoryContentDigest, type MemoryStore } from './memoryStore';
import { treeScan } from './records';

export { memoryContentDigest };
import type { CheckoutVerification, ProjectMemory } from './types';

/**
 * When a memory counts as verified in a checkout (docs/memory-phase1.md §2 "驗證事件"): only an event the system can
 * judge — the memory's own check command finishing with the expected exit code, or the goal metric it came from
 * passing an up-to-date verification. Any other successful command (git status…) is not a verification of it.
 */

export type ObservedEvent =
  | { kind: 'command'; ref: string; command: string; status: 'ok' | 'error'; exitCode?: number; at: number }
  | {
      kind: 'verification';
      ref: string;
      workflowId: string;
      goalVersion?: string;
      metricId: string;
      met: boolean;
      stale: boolean;
      value: string;
      target?: string;
      at: number;
      /** What the verified result rests on, hashed when the verification started (never re-taken later). */
      files: { path: string; hash: string }[];
    };

export type CheckoutState = CheckoutVerification['state'];


/** The files a memory rests on (relative to the checkout, as its evidence names them). */
export function memoryFiles(m: ProjectMemory): string[] {
  return [...new Set(m.evidence.flatMap((e) => (e.files ?? []).map((f) => f.path.replace(/\\/g, '/'))))].sort();
}

/** Each file's content hash right now ("missing" when it is not there). */
/**
 * Stands for the whole checkout when nothing narrower is known: any change to its code then means "check again"
 * (cautious, but never a freshness it cannot vouch for).
 */
export const WHOLE_CHECKOUT = '<whole checkout>';

/**
 * A hash that does not cover everything it stands for (a scan cut off at its limit, a file that could not be read):
 * it can never vouch that nothing changed.
 */
export const INCOMPLETE = 'incomplete:';

/** Whether a fingerprint has a part that was not fully scanned. */
export const basisIncomplete = (fp: { hash: string }[]) => fp.some((f) => f.hash.startsWith(INCOMPLETE));

/** Files a folder scan looks at before it stops (the scan then says it is incomplete). */
export const FOLDER_SCAN_LIMIT = 20000;

/** A folder's files by size and modification time, as the goal's data stamp does. */
function folderHash(dir: string): string {
  const h = createHash('sha256');
  let seen = 0;
  let complete = true;
  const walk = (abs: string, rel: string) => {
    if (!complete) return;
    let st: fs.Stats;
    try {
      st = fs.statSync(abs);
    } catch {
      complete = false;
      return;
    }
    if (!st.isDirectory()) {
      if (++seen > FOLDER_SCAN_LIMIT) return void (complete = false);
      return void h.update(`${rel}\0${st.size}\0${Math.round(st.mtimeMs)}\n`);
    }
    let names: string[];
    try {
      names = fs.readdirSync(abs).sort();
    } catch {
      complete = false;
      return;
    }
    for (const e of names) walk(path.join(abs, e), `${rel}/${e}`);
  };
  walk(dir, '');
  return `${complete ? '' : INCOMPLETE}dir:${h.digest('hex')}`;
}

/** The files a memory's verification rests on: its evidence's files, else the whole checkout. */
export const basisOf = (m: ProjectMemory) => {
  const files = memoryFiles(m);
  return files.length ? files : [WHOLE_CHECKOUT];
};

export function fingerprint(root: string, paths: string[]): { path: string; hash: string }[] {
  return paths.map((p) => {
    if (p === WHOLE_CHECKOUT) {
      const t = treeScan(root);
      return { path: p, hash: `${t.complete ? '' : INCOMPLETE}tree:${t.hash}` };
    }
    const file = path.resolve(root, p);
    // Only files inside the checkout: a path that climbs out is not evidence about it.
    if (path.relative(root, file).startsWith('..')) return { path: p, hash: 'outside' };
    try {
      if (fs.statSync(file).isDirectory()) return { path: p, hash: folderHash(file) };
      return { path: p, hash: createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
    } catch (e) {
      // Not there is a state of its own; there but unreadable says nothing about whether it changed.
      return { path: p, hash: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : `${INCOMPLETE}unreadable` };
    }
  });
}

const same = (a: { path: string; hash: string }[], b: { path: string; hash: string }[]) => {
  const m = new Map(b.map((x) => [x.path, x.hash]));
  return a.length === b.length && a.every((x) => m.get(x.path) === x.hash);
};

/** Whether this event verifies (or fails) this memory: undefined when it says nothing about it. */
export function judgeEvent(m: ProjectMemory, e: ObservedEvent): { expected: string; actual: string; passed: boolean } | undefined {
  if (e.kind === 'command') {
    if (!m.check || e.command.trim() !== m.check.command.trim()) return undefined;
    // An exit code we did not see can only be taken as 0 from a success.
    const exit = e.exitCode ?? (e.status === 'ok' ? 0 : undefined);
    if (exit === undefined) return undefined;
    return { expected: `exit ${m.check.expectExit}`, actual: `exit ${exit}`, passed: e.status === 'ok' && exit === m.check.expectExit };
  }
  // The same metric of the same goal of the same workflow: "M1" alone means something else in every workflow.
  const mine = (s: ProjectMemory['sources'][number]) => s.workflowId === e.workflowId && s.metricId === e.metricId && (s.goalVersion ?? '') === (e.goalVersion ?? '');
  if (m.kind !== 'practice' || !m.sources.some(mine)) return undefined;
  return { expected: e.target ?? 'met', actual: `${e.value}${e.stale ? ' (stale)' : ''}`, passed: e.met && !e.stale };
}

/** What to record for the memory in this checkout after the event (undefined: the event is not about it). */
export function verificationFrom(m: ProjectMemory, e: ObservedEvent, checkoutRoot: string, prev?: CheckoutVerification): CheckoutVerification | undefined {
  const j = judgeEvent(m, e);
  if (!j) return undefined;
  // The files as they were when it was checked (a verification brings its own, taken when it started): later
  // changes to them mean "check again". A basis that was not fully scanned cannot back a "verified".
  const fp = e.kind === 'verification' ? (e.files?.length ? e.files : [{ path: WHOLE_CHECKOUT, hash: `${INCOMPLETE}no basis recorded` }]) : fingerprint(checkoutRoot, basisOf(m));
  return {
    state: j.passed && !basisIncomplete(fp) ? 'verified' : 'needs_recheck',
    evidenceRef: e.ref,
    expected: j.expected,
    actual: j.actual,
    fingerprint: fp,
    lastVerifiedAt: j.passed ? e.at : prev?.lastVerifiedAt,
    at: e.at,
    contentDigest: memoryContentDigest(m),
  };
}

export type RecheckReason = 'changed' | 'failed' | 'edited' | 'incomplete';

/** How a memory stands in this checkout now, and why it needs re-checking. A file change only says "check again", never "wrong". */
export function stateDetail(m: ProjectMemory, checkoutId: string, checkoutRoot: string, stored?: CheckoutVerification): { state: CheckoutState; why?: RecheckReason } {
  if (stored) {
    // What was checked is not what the memory says now (the user changed its text or check).
    if (stored.contentDigest !== memoryContentDigest(m)) return { state: 'needs_recheck', why: 'edited' };
    if (basisIncomplete(stored.fingerprint)) return { state: 'needs_recheck', why: 'incomplete' };
    if (stored.state !== 'verified') return { state: stored.state, why: stored.state === 'needs_recheck' ? 'failed' : undefined };
    const now = fingerprint(checkoutRoot, stored.fingerprint.map((f) => f.path));
    if (basisIncomplete(now)) return { state: 'needs_recheck', why: 'incomplete' };
    return same(stored.fingerprint, now) ? { state: 'verified' } : { state: 'needs_recheck', why: 'changed' };
  }
  // Never verified here: evidence from this checkout whose files have changed since is a lead to re-check.
  const mine = m.evidence.filter((e) => e.checkoutId === checkoutId && e.files?.length);
  for (const e of mine) {
    const now = fingerprint(checkoutRoot, e.files!.map((f) => f.path));
    if (basisIncomplete(e.files!) || basisIncomplete(now)) return { state: 'needs_recheck', why: 'incomplete' };
    if (!same(e.files!, now)) return { state: 'needs_recheck', why: 'changed' };
  }
  return { state: 'unverified' };
}

export function stateIn(m: ProjectMemory, checkoutId: string, checkoutRoot: string, stored?: CheckoutVerification): CheckoutState {
  return stateDetail(m, checkoutId, checkoutRoot, stored).state;
}

/** Apply an observed event to every memory it verifies or fails, in this checkout only. Returns the ids it touched. */
export async function recordEvent(store: MemoryStore, checkoutId: string, checkoutRoot: string, e: ObservedEvent): Promise<string[]> {
  const states = store.checkoutStates(checkoutId);
  const touched: string[] = [];
  for (const m of store.list()) {
    if (m.lifecycle === 'superseded' || m.lifecycle === 'archived') continue;
    const v = verificationFrom(m, e, checkoutRoot, states[m.id]);
    if (!v) continue;
    if (await store.setCheckoutState(checkoutId, m.id, v)) touched.push(m.id);
  }
  return touched;
}
