/**
 * What a historical snapshot replay looks like in Aivenue's CI and review data (ghReplay.ts reads the snapshot): the
 * replay marks on gh answers, collected per read, and the lines that tell the agent. No file access here.
 */
import type { GhRun } from './ciDiagnose';

export interface GhReplayRead {
  /** The first words of the gh call (e.g. "pr checks", "api graphql"). */
  what: string;
  /** When the answer was obtained from GitHub; undefined when the snapshot does not say. */
  readAt?: string;
  source?: string;
}

export interface GhReplayInfo {
  kind: 'historical-replay';
  /** The snapshot file's name. */
  snapshot: string;
  /** When the snapshot was recorded; undefined when it does not say. */
  recordedAt?: string;
  /** When Aivenue read the snapshot (this replay). */
  replayedAt: number;
  reads: GhReplayRead[];
}

/** The replay facts a gh answer carries when it came from a snapshot. */
export interface GhReplayMark {
  snapshot: string;
  recordedAt?: string;
  readAt?: string;
  source?: string;
}

/** A gh wrapper that notes every replayed answer, so the result can say what came from the snapshot and when. */
export function noteReplay(gh: GhRun): { gh: GhRun; info: (replayedAt: number) => GhReplayInfo | undefined } {
  const marks: (GhReplayMark & { what: string })[] = [];
  return {
    gh: async (args) => {
      const r = await gh(args);
      if (r.replay) marks.push({ ...r.replay, what: args.slice(0, 2).join(' ') });
      return r;
    },
    info: (replayedAt) => {
      if (!marks.length) return undefined;
      const reads: GhReplayRead[] = [];
      for (const m of marks)
        if (m.what !== 'auth status' && !reads.some((x) => x.what === m.what && x.readAt === m.readAt && x.source === m.source)) reads.push({ what: m.what, readAt: m.readAt, source: m.source });
      return { kind: 'historical-replay', snapshot: marks[0].snapshot, recordedAt: marks[0].recordedAt, replayedAt, reads };
    },
  };
}

const iso = (t: number) => `${new Date(t).toISOString().slice(0, 16)}Z`;
const shown = (t?: string) => (t ? `${t.slice(0, 16)}Z`.replace(/ZZ$/, 'Z') : 'unknown');

/** The lines that say the data is a replay, with its three kinds of time kept apart. */
export function replayLines(r: GhReplayInfo): string[] {
  return [
    `- HISTORICAL SNAPSHOT REPLAY (${r.snapshot}): not live GitHub data. Snapshot recorded: ${shown(r.recordedAt)}; replayed by Aivenue: ${iso(r.replayedAt)} (the replay time is not when the data was obtained).`,
    ...r.reads.map((x) => `  - ${x.what}: obtained from GitHub ${shown(x.readAt)}${x.source ? ` — ${x.source.slice(0, 300)}` : ''}`),
    '  Treat the PR head, checks and comments as of when they were obtained; GitHub may have changed since.',
  ];
}
