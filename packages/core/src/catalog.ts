import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CatalogModel, CatalogProvider } from './types';

const URL = 'https://models.dev/api.json';
const MAX_AGE = 24 * 3600 * 1000;

/** Providers shown first in each group (the rest follow alphabetically). */
const FEATURED = [
  'kimi-code-plan-global', 'kimi-code-plan-cn', 'alibaba-coding-plan', 'alibaba-coding-plan-cn', 'alibaba-token-plan', 'alibaba-token-plan-cn', 'zai-coding-plan', 'zhipuai-coding-plan', 'minimax-coding-plan', 'minimax-cn-coding-plan', 'volcengine-coding-plan', 'tencent-coding-plan', 'opencode-go', 'github-copilot',
  'openai', 'anthropic', 'google', 'deepseek', 'moonshotai', 'moonshotai-cn', 'alibaba', 'alibaba-cn', 'zai', 'zhipuai', 'xai', 'mistral', 'openrouter', 'groq', 'minimax', 'siliconflow', 'siliconflow-cn', 'volcengine', 'togetherai', 'fireworks-ai', 'deepinfra', 'cerebras', 'nvidia', 'huggingface', 'ollama-cloud', 'lmstudio',
];

function kindOf(id: string, name: string): CatalogProvider['kind'] {
  if (id === 'lmstudio') return 'local';
  if (/(coding|token|step)-plan|code-plan|^opencode-go$|^github-copilot$/i.test(id) || /\bplan\b|for coding/i.test(name)) return 'plan';
  return 'api';
}

function trimModels(models: Record<string, any>): CatalogModel[] {
  return Object.entries(models ?? {})
    .map(([id, m]) => ({
      id,
      name: m.name ?? id,
      tools: m.tool_call !== false,
      vision: Array.isArray(m.modalities?.input) ? m.modalities.input.includes('image') : !!m.attachment,
      inputs: Array.isArray(m.modalities?.input) ? m.modalities.input : undefined,
      reasoning: !!m.reasoning,
      context: m.limit?.context,
      free: m.cost ? m.cost.input === 0 && m.cost.output === 0 : undefined,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

let memo: { at: number; list: CatalogProvider[] } | undefined;

/** The models.dev provider catalog (what OpenCode can talk to), cached for a day in the data folder. */
export async function loadCatalog(dataDir: string, refresh = false): Promise<CatalogProvider[]> {
  if (memo && !refresh && Date.now() - memo.at < MAX_AGE) return memo.list;
  const file = path.join(dataDir, 'catalog.json');
  let raw: Record<string, any> | undefined;
  try {
    const st = fs.statSync(file);
    if (!refresh && Date.now() - st.mtimeMs < MAX_AGE) raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // no cache yet
  }
  if (!raw) {
    try {
      const res = await fetch(URL, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`models.dev ${res.status}`);
      raw = (await res.json()) as Record<string, any>;
      fs.writeFileSync(file, JSON.stringify(raw));
    } catch (e) {
      // Offline: fall back to a stale cache if there is one.
      if (fs.existsSync(file)) raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      else throw new Error(`Cannot load the provider catalog (${(e as Error).message})`);
    }
  }
  const rank = (id: string) => {
    const i = FEATURED.indexOf(id);
    return i < 0 ? 1000 : i;
  };
  const list: CatalogProvider[] = Object.entries(raw!)
    .map(([id, p]) => {
      const all = trimModels(p.models);
      // Coding agents need tool calling: the rest is only remembered, to tell a model list what they lack.
      return { id, name: String(p.name ?? id), env: Array.isArray(p.env) ? p.env : [], api: p.api, npm: p.npm, doc: p.doc, kind: kindOf(id, String(p.name ?? id)), models: all.filter((m) => m.tools), noTools: all.filter((m) => !m.tools).map((m) => m.id), featured: rank(id) < 1000 };
    })
    .filter((p) => p.models.length > 0)
    .sort((a, b) => rank(a.id) - rank(b.id) || a.name.localeCompare(b.name));
  memo = { at: Date.now(), list };
  return list;
}
