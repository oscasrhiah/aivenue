/**
 * The batch a shared-memory compaction works from (memoryEntries.ts): what came after the last batch plus what it
 * left pending, each item with a ref and the strength of its evidence judged by where it really comes from.
 * - the user's own words in the records — the request that started the run ("g:<run id>") and messages sent during it
 *   ("u:<time>"): the user's word;
 * - checks Aivenue itself saw run ("k:<agent>@<time>"): strong;
 * - everything an agent wrote — notes of any kind it gave them, results ("n:<id>", "a:<id>"): weak. An agent calling
 *   its note a FACT, or writing "the user said", does not make it so.
 * A memory written before entries existed becomes entry M0, whole (it is shown within the budget like any entry, and
 * read in full with read_context).
 */
import type { AgentEvent, WorkflowRun } from './types';
import { agentLabel, agentResult } from './context';
import { collectActivity, observedChecks } from './ledger';
import { readPending, type MaterialItem, type MemoryEntry } from './memoryEntries';
import { ownUserWords } from './userWords';

export interface MemoryBatch {
  batch: MaterialItem[];
  /** The entries to update (M0 from a legacy summary when there are none yet). */
  entries: MemoryEntry[];
  legacy: boolean;
  /** Whether anything in it is newer than the last batch (pending items alone are not). */
  fresh: boolean;
  /** The latest file change known in the conversation, kept with the memory for the next message. */
  lastEdit: number;
}

export function memoryBatch(run: WorkflowRun, eventsOf: (agentId: string) => AgentEvent[], upto: number): MemoryBatch {
  const m = run.memory;
  const prev = m?.upto ?? 0;
  const legacy = !!m?.summary && !m.entries;
  const entries: MemoryEntry[] = m?.entries ?? (legacy ? [{ id: 'M0', section: 'done', text: m!.summary, sources: ['legacy'], version: 1, cycle: 0, at: m!.upto, status: 'active' }] : []);
  const act = collectActivity(run, eventsOf);
  // The latest file change Aivenue knows of in this conversation: this message's, the one kept with the memory, and
  // the one carried from earlier messages (also those that changed files without compacting).
  const lastEdit = Math.max(act.lastEdit, m?.lastEdit ?? 0, run.earlierEdit ?? 0);
  // Everything this message's records hold, as items.
  const here: MaterialItem[] = [];
  if (legacy) here.push({ ref: 'legacy', runId: run.id, strength: 'strong', ts: m!.upto, text: 'the shared memory written before entries (entry M0)' });
  // The request that started this run (a follow-up message continues one): the user's own words.
  // Its own words only (not the background Aivenue adds to a follow-up's goal), whole: the same source and id the
  // prompts use (userWords.ts).
  const goalRef = `g:${run.id}`;
  const request = ownUserWords(run).find((w) => w.id === goalRef);
  if (request) here.push({ ref: goalRef, runId: run.id, strength: request.note ? 'weak' : 'user', ts: run.createdAt, text: `the user's request for this run${request.note ? ` (${request.note})` : ''}: "${request.text}"` });
  for (const u of run.userMessages ?? []) here.push({ ref: `u:${u.ts}`, runId: run.id, strength: 'user', ts: u.ts, text: `the user's message: "${u.text.trim()}"` });
  for (const c of observedChecks(act)) here.push({ ref: `k:${c.agentId.slice(0, 8)}@${c.ts}`, runId: run.id, strength: 'strong', ts: c.ts, text: `Aivenue saw this check run: ${c.line}` });
  for (const n of run.notes ?? []) {
    const a = run.agents[n.agentId];
    here.push({ ref: `n:${n.id}`, runId: run.id, strength: 'weak', ts: n.ts, text: `note by ${a ? `${a.role} ${a.provider}` : n.by ?? 'an agent'}${n.kind ? ` (it called it ${n.kind})` : ''}: ${n.text}` });
  }
  for (const a of Object.values(run.agents)) {
    if (a.role === 'test' || a.role === 'compactor' || !a.endedAt) continue;
    here.push({ ref: `a:${a.id}`, runId: run.id, strength: 'weak', ts: a.endedAt, text: `${agentLabel(a)}: ${(agentResult(run, a) || a.finalText || '').trim().slice(0, 1500) || '—'}` });
  }
  const byRef = new Map(here.map((i) => [i.ref, i]));
  const items: MaterialItem[] = [];
  const have = new Set<string>();
  const add = (i: MaterialItem) => {
    if (have.has(i.ref)) return;
    have.add(i.ref);
    items.push(i);
  };
  // What an earlier compaction left pending, from the copy it saved — the same source, text and strength, whichever
  // message's records it came from. A check from before a later file change is marked to be re-verified.
  for (const p of m?.pending ?? []) {
    // One saved as unreadable is read again from this message's records if it is there after all.
    const { ref, copy } = readPending(p);
    const saved: MaterialItem | undefined = !copy ? byRef.get(ref) : copy.missing ? byRef.get(ref) ?? copy : copy;
    if (saved) {
      const stale = !saved.missing && saved.ref.startsWith('k:') && lastEdit > saved.ts && !/files changed since/.test(saved.text);
      add(stale ? { ...saved, text: `${saved.text} — files changed since (re-verify before relying on it)` } : saved);
    } else {
      // Left pending before items were saved whole, and not in this message's records: said, not dropped.
      add({ ref, runId: '?', strength: 'weak', ts: 0, text: `an item left pending by an earlier compaction whose content was not saved and is not in this message's records (${ref}): it cannot be read, is no evidence for any entry, and stays pending until its content is found`, missing: true });
    }
  }
  // Then what is new since the last batch.
  for (const i of here) if (i.ts > prev && i.ts <= upto) add(i);
  return { batch: items.sort((x, y) => x.ts - y.ts), entries, legacy, fresh: here.some((i) => i.ref !== 'legacy' && i.ts > prev && i.ts <= upto), lastEdit };
}
