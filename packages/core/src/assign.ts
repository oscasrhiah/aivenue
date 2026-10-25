import type { AssignmentResult, AutoAssignPrefs, ProviderInfo, ProviderUsage } from './types';
import { L } from './i18n';

type Kind = 'plan' | 'review' | 'code';

const WEIGHTS: Record<AutoAssignPrefs['priority'], { skill: number; speed: number; spread: number }> = {
  quality: { skill: 2, speed: 0.3, spread: 0.2 },
  balanced: { skill: 1.5, speed: 0.5, spread: 1.5 },
  economy: { skill: 1, speed: 1.6, spread: 0.6 },
};

const LIMIT_WINDOW = 5 * 3600 * 1000;

export interface AssignInput {
  providers: ProviderInfo[];
  usage: ProviderUsage[];
  prefs: AutoAssignPrefs;
  /** The task has image attachments. */
  needsVision: boolean;
  /** The task has audio / video attachments. */
  needsAudio?: boolean;
  needsVideo?: boolean;
}

/**
 * Pick a provider for every role from the ones that are ready to run, using each provider's
 * profile (plan / review / code / speed), the user's priority, recent limit hits and official quota.
 */
export function autoAssign(input: AssignInput): AssignmentResult {
  const { prefs } = input;
  const w = WEIGHTS[prefs.priority];
  const notes: string[] = [];
  const name = (id: string) => input.providers.find((p) => p.spec.id === id)?.spec.name ?? id;

  let ready = input.providers.filter((p) => p.installed && p.auth.state === 'logged_in');
  if (!ready.length) throw new Error(L('沒有可用的供應商：請先在「設定 → 供應商」登入至少一家', 'No provider is ready: sign in to at least one under Settings → Providers'));

  // Providers that just hit their usage limit are skipped while others are available.
  const limited = new Set(input.usage.filter((u) => u.limitHit && Date.now() - u.limitHit.at < LIMIT_WINDOW).map((u) => u.providerId));
  const notLimited = ready.filter((p) => !limited.has(p.spec.id));
  if (notLimited.length && notLimited.length < ready.length) {
    for (const id of limited) if (ready.some((p) => p.spec.id === id)) notes.push(L(`避開 ${name(id)}：最近撞到用量上限`, `Skipping ${name(id)}: it recently hit a usage limit`));
    ready = notLimited;
  }

  const needs: { on?: boolean; ok: (p: ProviderInfo) => boolean; zh: string; en: string }[] = [
    { on: input.needsVision, ok: (p) => p.spec.profile?.vision !== false, zh: '圖片', en: 'images' },
    { on: input.needsAudio, ok: (p) => !!p.spec.profile?.audio, zh: '音訊', en: 'audio' },
    { on: input.needsVideo, ok: (p) => !!p.spec.profile?.video, zh: '影片', en: 'video' },
  ];
  for (const n of needs) {
    if (!n.on) continue;
    const able = ready.filter(n.ok);
    if (able.length) {
      for (const p of ready) if (!able.includes(p)) notes.push(L(`${p.spec.name} 無法讀取${n.zh}，這次不指派`, `${p.spec.name} cannot read ${n.en}, not assigned this time`));
      ready = able;
    } else notes.push(L(`可用的供應商都無法讀取${n.zh}附件，agent 會在回覆中說明`, `No ready provider can read ${n.en} attachments; agents will say so in their replies`));
  }

  const quotaPenalty = (id: string): number => {
    const windows = input.usage.find((u) => u.providerId === id)?.official?.windows ?? [];
    // Time windows (5 hours, a week…) all apply at once; per-model quotas (minutes 0) only bite when every model is spent.
    const timed = windows.filter((x) => x.minutes > 0).map((x) => x.usedPercent);
    const perModel = windows.filter((x) => x.minutes === 0).map((x) => x.usedPercent);
    const used = Math.max(0, ...timed, perModel.length ? Math.min(...perModel) : 0);
    if (used >= 90) {
      notes.push(L(`${name(id)} 官方額度已用 ${used.toFixed(0)}%，降低優先順序`, `${name(id)} has used ${used.toFixed(0)}% of its plan quota; lowered priority`));
      return 3;
    }
    return used >= 70 ? 1 : 0;
  };
  const penalties = new Map(ready.map((p) => [p.spec.id, quotaPenalty(p.spec.id)]));
  // Free routers of unknown strength (OmniRoute) only help: sub-agents and compaction, not the main roles.
  const helpers = ready.filter((p) => p.spec.profile?.helperOnly);
  if (helpers.length && helpers.length < ready.length) {
    for (const p of helpers) notes.push(L(`${p.spec.name} 只用在 sub agent 與壓縮（免費模型能力不一定）`, `${p.spec.name} is only used for sub-agents and compaction (free models vary in strength)`));
    ready = ready.filter((p) => !p.spec.profile?.helperOnly);
  }
  const skill = (p: ProviderInfo, k: Kind) => p.spec.profile?.[k] ?? 3;
  const base = (p: ProviderInfo, k: Kind) => skill(p, k) * w.skill + (p.spec.profile?.speed ?? 3) * w.speed - (penalties.get(p.spec.id) ?? 0);

  const ranking = {} as AssignmentResult['ranking'];
  for (const k of ['plan', 'review', 'code'] as Kind[]) ranking[k] = [...ready].sort((a, b) => base(b, k) - base(a, k)).map((p) => p.spec.id);

  const load = new Map<string, number>();
  // Extra accounts of a tool are still the same vendor for "reviewer is a different vendor".
  const vendor = (id: string) => ready.find((p) => p.spec.id === id)?.spec.accountOf ?? id;
  const pick = (k: Kind, exclude?: string): string => {
    let candidates = ready;
    if (exclude && prefs.crossReview) {
      const others = ready.filter((p) => vendor(p.spec.id) !== vendor(exclude));
      if (others.length) candidates = others;
    }
    const best = [...candidates].sort((a, b) => base(b, k) - (load.get(b.spec.id) ?? 0) * w.spread - (base(a, k) - (load.get(a.spec.id) ?? 0) * w.spread))[0];
    load.set(best.spec.id, (load.get(best.spec.id) ?? 0) + 1);
    return best.spec.id;
  };

  const planAuthor = pick('plan');
  const codeAuthor = pick('code');
  const planReviewer = pick('review', planAuthor);
  const codeReviewer = pick('review', codeAuthor);

  const kindLabel = (k: Kind) => ({ plan: L('規劃', 'planning'), review: L('審查', 'review'), code: L('寫程式', 'coding') })[k];
  const why = (id: string, k: Kind) => {
    const p = ready.find((x) => x.spec.id === id)!;
    return `${kindLabel(k)} ${skill(p, k)}/5${L('，速度', ', speed')} ${p.spec.profile?.speed ?? 3}/5`;
  };
  notes.unshift(
    L(`撰寫計畫 → ${name(planAuthor)}（${why(planAuthor, 'plan')}）`, `Plan → ${name(planAuthor)} (${why(planAuthor, 'plan')})`),
    L(`審查計畫 → ${name(planReviewer)}（${why(planReviewer, 'review')}）`, `Plan review → ${name(planReviewer)} (${why(planReviewer, 'review')})`),
    L(`實作 → ${name(codeAuthor)}（${why(codeAuthor, 'code')}）`, `Implement → ${name(codeAuthor)} (${why(codeAuthor, 'code')})`),
    L(`審查程式碼 → ${name(codeReviewer)}（${why(codeReviewer, 'review')}）`, `Code review → ${name(codeReviewer)} (${why(codeReviewer, 'review')})`),
  );
  if (prefs.crossReview && ready.length === 1) notes.push(L('只有一家可用，審查者與撰寫者相同', 'Only one provider is ready, so the reviewer is the same as the author'));

  // Sub-agents: every ready provider, free helpers first, then fastest first in economy mode.
  const fastest = [...ready].sort((a, b) => (prefs.priority === 'economy' ? (b.spec.profile?.speed ?? 3) - (a.spec.profile?.speed ?? 3) : base(b, 'code') - base(a, 'code'))).map((p) => p.spec.id);
  const subagents = [...helpers.filter((p) => !ready.includes(p)).map((p) => p.spec.id), ...fastest];

  return { plan: { author: planAuthor, reviewer: planReviewer }, implement: { author: codeAuthor, reviewer: codeReviewer }, subagents, notes, ranking };
}

export const DEFAULT_AUTO: AutoAssignPrefs = { priority: 'balanced', crossReview: true, failover: true };
