/**
 * A historical snapshot replay of `gh` answers, for checking a workflow against PR data pinned at one moment
 * (docs/next-task-skills-integration.md, combined CI + review check). Set AIVENUE_GH_REPLAY to a snapshot file:
 * Aivenue then reads CI and review data from it instead of GitHub, and says so — with each answer's own time — in
 * what the agent gets and in the run's records. Only answers recorded in the snapshot exist; nothing reaches GitHub.
 *
 * Snapshot: { recordedAt?, scenario?: { kind? }, entries: [{ args, result: { code, stdout, stderr }, readAt?, source? }] }
 * A time the snapshot does not hold stays unknown: it is never filled in with the time of the replay.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GhRun } from './ciDiagnose';
import type { GhReplayMark } from './ghReplayInfo';

const time = (v: unknown) => (typeof v === 'string' && !Number.isNaN(Date.parse(v)) ? v : undefined);

/** A gh that answers only from the snapshot file; every answer marked with where and when it came from. */
export function replayGh(file: string): GhRun {
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  const name = path.basename(file);
  const recordedAt = time(snap.recordedAt);
  const entries: any[] = Array.isArray(snap.entries) ? snap.entries : [];
  return async (args) => {
    const key = JSON.stringify(args);
    const hit = entries.find((e) => JSON.stringify(e.args) === key);
    const mark: GhReplayMark = { snapshot: name, recordedAt, readAt: hit ? time(hit.readAt) : undefined, source: hit && typeof hit.source === 'string' ? hit.source : undefined };
    if (!hit) return { code: 1, stdout: '', stderr: `not in the snapshot ${name}: this call was not recorded`, replay: mark };
    return { code: hit.result?.code ?? 0, stdout: hit.result?.stdout ?? '', stderr: hit.result?.stderr ?? '', replay: mark };
  };
}
