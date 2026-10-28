import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentEvent, WorkflowRun } from './types';

/** Exports are kept this long, then deleted by Aivenue (they are its own files). */
export const EXPORT_RETENTION_DAYS = 30;

/** Secrets and personal data that must not leave the computer in an export. */
const MASKS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[private key]'],
  [/\b(sk|rk|pk)-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g, '[api key]'],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}|\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[github token]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[aws key]'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, '[google key]'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, '[slack token]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/g, '$1 [token]'],
  [/("?(?:password|passwd|secret|token|api[_-]?key|authorization)"?\s*[:=]\s*"?)[^"\s,}]{4,}/gi, '$1[masked]'],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
];

export function maskText(text: string): { text: string; count: number } {
  let count = 0;
  let out = text;
  for (const [re, by] of MASKS) out = out.replace(re, (...m) => (count++, by.replace('$1', String(m[1] ?? ''))));
  return { text: out, count };
}

/**
 * A run as one JSON file: settings, every agent's full records (messages, tool calls and output, file changes),
 * notes, reviews, verifications, routing and hand-offs. Masked by default; deleted after the retention period.
 */
export function exportBundle(dataDir: string, run: WorkflowRun, eventsOf: (agentId: string) => AgentEvent[], mask: boolean): { path: string; bytes: number; masked: number } {
  const dir = path.join(dataDir, 'exports');
  fs.mkdirSync(dir, { recursive: true });
  pruneExports(dir);
  const at = Date.now();
  const events: Record<string, AgentEvent[]> = {};
  for (const id of Object.keys(run.agents)) events[id] = eventsOf(id);
  const bundle = {
    format: 'aivenue-run/1',
    exportedAt: new Date(at).toISOString(),
    masked: mask,
    retention: {
      days: EXPORT_RETENTION_DAYS,
      deleteAfter: new Date(at + EXPORT_RETENTION_DAYS * 86400000).toISOString(),
      rule: 'Aivenue deletes this file after the retention period. Delete it earlier yourself when you no longer need it; deleting the conversation in Aivenue does not delete exports.',
    },
    run,
    events,
  };
  let text = JSON.stringify(bundle, null, 1);
  let masked = 0;
  if (mask) ({ text, count: masked } = maskText(text));
  const file = path.join(dir, `${run.id}-${new Date(at).toISOString().replace(/[-:]/g, '').slice(0, 15)}.json`);
  fs.writeFileSync(file, text);
  return { path: file, bytes: Buffer.byteLength(text), masked };
}

function pruneExports(dir: string) {
  const cutoff = Date.now() - EXPORT_RETENTION_DAYS * 86400000;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    try {
      if (f.endsWith('.json') && fs.statSync(p).mtimeMs < cutoff) fs.rmSync(p, { force: true });
    } catch {
      // in use or gone
    }
  }
}

// ---------- project Skill ----------

const SECTIONS = ['Facts (checked)', 'Decisions', 'Rulings', 'How the goal is verified', 'Skills applied and verified'] as const;

/** Where a project's own skills live; Aivenue offers them to every agent working in that folder. */
export const projectSkillsDir = (cwd: string) => path.join(cwd, '.aivenue', 'skills');

/**
 * Turn what a run verified into the project's Skill (`.aivenue/skills/project-rules/SKILL.md`): checked facts,
 * decisions, rulings, how the met goal was measured and skills that were applied and verified. Inferences are left
 * out. New rules are merged into the existing file without duplicates.
 */
export function distilProjectSkill(cwd: string, run: WorkflowRun): { path: string; added: number } {
  const fresh: Record<(typeof SECTIONS)[number], string[]> = { 'Facts (checked)': [], Decisions: [], Rulings: [], 'How the goal is verified': [], 'Skills applied and verified': [] };
  const line = (t: string) => t.replace(/\s+/g, ' ').trim().slice(0, 400);
  for (const n of run.notes ?? []) {
    if (n.agentId === 'user' || !n.kind || n.kind === 'inference') continue;
    if (n.text.startsWith('Ruling on ')) continue;
    (n.kind === 'fact' ? fresh['Facts (checked)'] : fresh.Decisions).push(line(n.text));
  }
  for (const r of run.rulings ?? []) fresh.Rulings.push(line(`${r.issueId}: ${r.ruling}`));
  const lastCheck = [...(run.stages.verify?.rounds ?? [])].reverse().find((r) => r.verification)?.verification;
  if (run.plan?.goal && lastCheck?.outcome === 'met' && !lastCheck.stale) for (const m of run.plan.goal.metrics) fresh['How the goal is verified'].push(line(`${m.name}: ${m.target} — ${m.how}`));
  for (const a of Object.values(run.agents)) for (const u of a.skillUses ?? []) if (u.verified) fresh['Skills applied and verified'].push(line(`${u.name}${u.version ? ` ${u.version}` : ''}: ${u.reason}${u.verification ? ` (checked: ${u.verification})` : ''}`));

  const dir = path.join(projectSkillsDir(cwd), 'project-rules');
  const file = path.join(dir, 'SKILL.md');
  const have: Record<string, string[]> = {};
  if (fs.existsSync(file)) {
    let cur = '';
    for (const l of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const h = /^## (.+)$/.exec(l);
      if (h) cur = h[1].trim();
      else if (cur && l.startsWith('- ')) (have[cur] ??= []).push(l.slice(2).trim());
    }
  }
  let added = 0;
  for (const sec of SECTIONS) {
    const list = (have[sec] ??= []);
    for (const item of fresh[sec]) if (item && !list.includes(item)) (list.push(item), added++);
  }
  const body = [
    '---',
    'name: project-rules',
    'description: Verified rules of this project, distilled by Aivenue from finished workflows (checked facts, decisions, rulings, how the goal is verified). Read it before changing this project; it outranks general skills.',
    '---',
    '',
    '# Project rules',
    '',
    'Only verified material is kept here (no guesses). Edit or delete lines that no longer hold.',
    ...SECTIONS.flatMap((sec) => (have[sec].length ? ['', `## ${sec}`, ...have[sec].map((x) => `- ${x}`)] : [])),
    '',
  ].join('\n');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file, body);
  return { path: file, added };
}
