import type { CatalogProvider } from './types';

/** "Claude-Opus-5.5-20260101" and "claude-opus-5-5" are the same model; a provider prefix ("openai/") is dropped. */
function norm(id: string): string {
  return id
    .toLowerCase()
    .replace(/^.*\//, '')
    .replace(/[._]/g, '-')
    .replace(/-\d{8}$/, '');
}

/** The same model without the suffixes some CLIs add: an effort level, "thinking", "latest", "preview". */
function variants(id: string): string[] {
  const out = [norm(id)];
  let cur = out[0];
  for (;;) {
    const next = cur.replace(/-(thinking|minimal|low|medium|high|xhigh|max|latest|preview|exp)$/, '');
    if (next === cur) break;
    out.push((cur = next));
  }
  return out;
}

/** Version numbers in an id ("claude-opus-5-5" → [5, 5]), to pick the newest model an alias points at. */
const version = (id: string) => (id.match(/\d+/g) ?? []).map(Number);
const newer = (a: number[], b: number[]) => {
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return false;
};

/**
 * A model's context size from the models.dev catalog. Looks in the given providers first (the CLI's own
 * vendor, e.g. "anthropic" for Claude Code), then — only when every other catalog that lists the model
 * agrees — anywhere. Aliases without a version ("opus") resolve to the newest model of that name.
 */
export function lookupContext(catalog: CatalogProvider[], providers: string[], model: string): number | undefined {
  return lookupModel(catalog, providers, model).context;
}

/**
 * What the catalog knows about a model: its context size and what it reads (image, pdf, audio, video). Looks in the given providers
 * first (the CLI's own vendor, e.g. "anthropic" for Claude Code), then — only when every other catalog that lists the
 * model agrees — anywhere. Aliases without a version ("opus") resolve to the newest model of that name.
 */
export function lookupModel(catalog: CatalogProvider[], providers: string[], model: string): { context?: number; inputs?: string[]; tools?: boolean; reasoning?: boolean } {
  const prefix = model.includes('/') ? model.split('/')[0] : undefined;
  const order = [...new Set([prefix, ...providers].filter((p): p is string => !!p))];
  const wanted = variants(model);
  for (const pid of order) {
    const cp = catalog.find((p) => p.id === pid);
    if (!cp) continue;
    for (const w of wanted) {
      const hit = cp.models.find((m) => norm(m.id) === w);
      if (hit) return { context: hit.context || undefined, inputs: hit.inputs, tools: true, reasoning: hit.reasoning };
      if (cp.noTools?.some((id) => norm(id) === w)) return { tools: false };
    }
    // "opus", "sonnet": the newest model whose name carries that word.
    if (!/\d/.test(wanted[0])) {
      let best: { v: number[]; m: CatalogProvider['models'][number] } | undefined;
      for (const m of cp.models) {
        if (!new RegExp(`(^|-)${wanted[0]}(-|$)`).test(norm(m.id)) || !/\d/.test(m.id)) continue;
        const v = version(norm(m.id).replace(/-\d{8}$/, ''));
        if (!best || newer(v, best.v)) best = { v, m };
      }
      if (best) return { context: best.m.context || undefined, inputs: best.m.inputs, tools: true, reasoning: best.m.reasoning };
    }
  }
  // Elsewhere only when it is unambiguous: hosts of the same open model often cap it differently.
  const contexts = new Set<number>();
  const inputs = new Set<string>();
  for (const cp of catalog)
    for (const m of cp.models)
      if (wanted.includes(norm(m.id))) {
        if (m.context) contexts.add(m.context);
        inputs.add(JSON.stringify([...(m.inputs ?? [])].sort()));
      }
  return { context: contexts.size === 1 ? [...contexts][0] : undefined, inputs: inputs.size === 1 && [...inputs][0] !== '[]' ? JSON.parse([...inputs][0]) : undefined };
}

/** 1000000 → "1M", 272000 → "272K", 1048576 → "1M". */
export function fmtContext(n: number): string {
  if (n >= 1_000_000) return `${+(n / 1_000_000).toFixed(n % 1_000_000 < 100_000 || n % 1_000_000 > 900_000 ? 0 : 1)}M`;
  return `${Math.round(n / 1000)}K`;
}
