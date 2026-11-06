/**
 * A local static scan of a skill folder before it may be loaded (docs/next-task-skills-integration.md, skill-scanner):
 * no model, no network, no outside tool. It walks the folder without following links (symbolic links and Windows
 * junctions are reported, never read through), hashes everything it saw (the version a user approves) and lists lines
 * that need a look: injection wording, hidden characters, load-time commands and hooks, credential paths, network use,
 * dynamic execution, writes to agent configuration, files test runners or installers run on their own, links and
 * binaries. Findings are leads for the user, not verdicts: a skill about security will match some of them.
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SkillFinding, SkillFindingCategory as FindingCategory, SkillScan } from './types';

export const SCAN_RULES_VERSION = 'aivenue-static@1';

const MAX_FILES = 2000;
const MAX_BYTES = 50 * 1024 * 1024;
const MAX_TEXT = 1024 * 1024;
const MAX_FINDINGS = 200;

interface Entry {
  rel: string;
  kind: 'file' | 'link' | 'dir';
  data?: Buffer;
  target?: string;
}

/** Every entry under `root`, links not followed (a junction is a link here too). */
function walk(root: string): Entry[] {
  const out: Entry[] = [];
  let bytes = 0;
  const stack = [''];
  while (stack.length) {
    const rel = stack.pop()!;
    for (const name of fs.readdirSync(path.join(root, rel)).sort()) {
      const r = rel ? `${rel}/${name}` : name;
      const full = path.join(root, r);
      const st = fs.lstatSync(full);
      if (out.length >= MAX_FILES) throw new Error(`more than ${MAX_FILES} files: too large to scan`);
      if (st.isSymbolicLink()) {
        let target = '';
        try {
          target = fs.readlinkSync(full);
        } catch {
          target = '(unreadable link)';
        }
        out.push({ rel: r, kind: 'link', target });
      } else if (st.isDirectory()) {
        out.push({ rel: r, kind: 'dir' });
        stack.push(r);
      } else if (st.isFile()) {
        bytes += st.size;
        if (bytes > MAX_BYTES) throw new Error(`more than ${MAX_BYTES / 1024 / 1024} MB: too large to scan`);
        out.push({ rel: r, kind: 'file', data: fs.readFileSync(full) });
      } else out.push({ rel: r, kind: 'link', target: '(special file)' });
    }
  }
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}

/** The version of a folder: every path, its kind and content. */
export function skillHash(root: string): string {
  return hashOf(walk(root));
}

function hashOf(entries: Entry[]): string {
  const h = crypto.createHash('sha256');
  for (const e of entries) {
    h.update(`${e.rel}\0${e.kind}\0`);
    if (e.data) h.update(e.data);
    if (e.target) h.update(e.target);
    h.update('\0');
  }
  return h.digest('hex');
}

type Rule = { id: string; category: FindingCategory; re: RegExp; only?: (file: string) => boolean };

const isSkillMd = (f: string) => f === 'SKILL.md';
const RULES: Rule[] = [
  { id: 'ignore-instructions', category: 'injection', re: /\b(ignore|disregard|forget|override)\b[^\n]{0,40}\b(previous|prior|above|earlier|all|any)\b[^\n]{0,30}\b(instructions?|rules|prompts?|guidelines)\b/i },
  { id: 'role-takeover', category: 'injection', re: /\byou are now\b|\bnew instructions?:|\bfrom now on,? you (must|will|are)\b/i },
  { id: 'hide-from-user', category: 'injection', re: /\b(do not|don't|never)\b[^\n]{0,20}\b(tell|inform|mention|show|reveal)\b[^\n]{0,30}\b(the )?user\b|\bwithout (telling|asking|informing) the user\b|\bsilently\b/i },
  { id: 'fake-system-tag', category: 'injection', re: /<\s*\/?\s*(system|system-reminder|important|admin|instructions?)\s*>/i },
  { id: 'auto-approve', category: 'injection', re: /\b(auto[- ]?approve|bypass (the )?(permission|approval|sandbox)|dangerously|--yolo|skip[- ]permissions)\b/i },
  { id: 'zero-width-or-bidi', category: 'hidden', re: /[​-‏‪-‮⁠-⁤]|(?!^)﻿/ },
  { id: 'html-comment-instruction', category: 'hidden', re: /<!--[^\n]*\b(ignore|must|always|never|run|execute|send|upload|instructions?)\b/i },
  { id: 'load-time-command', category: 'frontmatter', re: /!`[^`\n]+`/, only: isSkillMd },
  { id: 'hooks', category: 'frontmatter', re: /^\s*(hooks|PreToolUse|PostToolUse|UserPromptSubmit|SessionStart|Stop)\s*:/ },
  { id: 'broad-tools', category: 'frontmatter', re: /^\s*allowed-tools\s*:.*(\*|\bBash\b|\bWrite\b|\bWebFetch\b)/i, only: isSkillMd },
  { id: 'model-override', category: 'frontmatter', re: /^\s*model\s*:/i, only: isSkillMd },
  { id: 'credential-path', category: 'credentials', re: /(^|[\s"'`(=/\\~])\.(ssh|aws|gnupg|kube|docker|azure|netrc|npmrc|git-credentials|pypirc)\b|\bid_(rsa|dsa|ecdsa|ed25519)\b|\bcredentials?\.json\b|(^|[\s"'`(=/\\])\.env\b/i },
  { id: 'secret-variable', category: 'credentials', re: /\b[A-Z][A-Z0-9_]*(TOKEN|SECRET|API_KEY|PASSWORD|PASSWD|PRIVATE_KEY)\b/ },
  { id: 'network-tool', category: 'network', re: /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|ncat|netcat|nc\s+-[a-z]*e)\b|\b(requests\.(get|post|put)|urllib\.request|http\.client|socket\.socket|XMLHttpRequest|axios)\b|\bfetch\s*\(/ },
  { id: 'pipe-to-shell', category: 'execution', re: /\|\s*(sudo\s+)?(sh|bash|zsh|pwsh|powershell|iex|python3?|node)\b/i },
  { id: 'dynamic-execution', category: 'execution', re: /\b(eval|exec)\s*\(|shell\s*=\s*True|\bos\.system\s*\(|\bInvoke-Expression\b|\bchild_process\b|\bexecSync\s*\(|new Function\s*\(/ },
  { id: 'decode-and-run', category: 'execution', re: /\bbase64\s+(-d|--decode)\b|\bb64decode\b|FromBase64String|\batob\s*\(/i },
  { id: 'agent-config', category: 'config', re: /(CLAUDE|AGENTS|MEMORY|GEMINI)\.md\b|settings(\.local)?\.json\b|\.mcp\.json\b|[~/\\]\.(claude|codex|gemini|aivenue|cursor)([/\\]|\b)|\.(bashrc|zshrc|bash_profile|profile)\b|PowerShell_profile|\.git[/\\]hooks/ },
  { id: 'install-hook', category: 'autorun', re: /"(pre|post)?install"\s*:/, only: (f) => path.basename(f) === 'package.json' },
];

const TRUSTED_HOSTS = /(^|\.)(github\.com|githubusercontent\.com|pypi\.org|npmjs\.com|nodejs\.org|python\.org|mozilla\.org|microsoft\.com|anthropic\.com|openai\.com|astral\.sh|readthedocs\.io)$/i;
const AUTORUN_NAMES = /(^|\/)(conftest\.py|test_[^/]*\.py|[^/]*_test\.(py|go)|[^/]*\.(test|spec)\.(js|mjs|cjs|ts|tsx|jsx))$/i;
const IMAGE = /\.(png|jpe?g|gif|webp|ico|bmp)$/i;
const EXECUTABLE = /\.(exe|dll|so|dylib|bin|com|scr|msi|jar|node)$/i;

const clipAround = (line: string, at: number) => {
  const s = Math.max(0, at - 60);
  const t = line.slice(s, s + 160).trim();
  return `${s > 0 ? '…' : ''}${t}${s + 160 < line.length ? '…' : ''}`;
};

/** Scan a skill folder. Throws only when the folder cannot be read whole (the caller records "failed"). */
export function scanSkill(root: string, now = Date.now()): SkillScan {
  const entries = walk(root);
  const findings: SkillFinding[] = [];
  let more = 0;
  const add = (f: SkillFinding) => (findings.length < MAX_FINDINGS ? findings.push(f) : more++);
  for (const e of entries) {
    if (e.kind === 'link') {
      add({ file: e.rel, line: 0, category: 'structure', rule: 'link-not-followed', excerpt: `link to ${e.target} (not followed; an agent reading it would read the target)` });
      continue;
    }
    if (e.kind !== 'file' || !e.data) continue;
    if (AUTORUN_NAMES.test(e.rel)) add({ file: e.rel, line: 0, category: 'autorun', rule: 'test-runner-file', excerpt: 'a test runner finds and runs this file on its own' });
    if (EXECUTABLE.test(e.rel)) add({ file: e.rel, line: 0, category: 'structure', rule: 'executable', excerpt: `executable or library file (${e.data.length} bytes)` });
    if (IMAGE.test(e.rel)) continue;
    const head = e.data.subarray(0, 8192);
    if (head.includes(0)) {
      if (!EXECUTABLE.test(e.rel)) add({ file: e.rel, line: 0, category: 'structure', rule: 'binary', excerpt: `binary file (${e.data.length} bytes), not read` });
      continue;
    }
    if (e.data.length > MAX_TEXT) {
      add({ file: e.rel, line: 0, category: 'structure', rule: 'large-text', excerpt: `text file of ${e.data.length} bytes: only the first ${MAX_TEXT} bytes were scanned` });
    }
    const text = e.data.subarray(0, MAX_TEXT).toString('utf8');
    const lines = text.split(/\r?\n/);
    // The frontmatter of SKILL.md: where hooks and tool grants live.
    const fmEnd = isSkillMd(e.rel) && lines[0]?.trim() === '---' ? lines.findIndex((l, i) => i > 0 && l.trim() === '---') : -1;
    lines.forEach((line, i) => {
      for (const r of RULES) {
        if (r.only && !r.only(e.rel)) continue;
        if (r.category === 'frontmatter' && r.id !== 'load-time-command' && !(i > 0 && i < fmEnd)) continue;
        const m = r.re.exec(line);
        if (m) add({ file: e.rel, line: i + 1, category: r.category, rule: r.id, excerpt: clipAround(line, m.index) });
      }
      for (const m of line.matchAll(/https?:\/\/([^\s/)'"`>\]]+)[^\s)'"`>\]]*/g)) {
        const host = m[1].replace(/:\d+$/, '');
        if (!TRUSTED_HOSTS.test(host)) add({ file: e.rel, line: i + 1, category: 'network', rule: 'url', excerpt: clipAround(line, m.index ?? 0) });
      }
    });
  }
  return { status: findings.length || more ? 'findings' : 'clean', rules: SCAN_RULES_VERSION, at: now, hash: hashOf(entries), files: entries.filter((e) => e.kind !== 'dir').length, findings, ...(more ? { more } : {}) };
}
