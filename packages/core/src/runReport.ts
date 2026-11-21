import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentEvent, AgentRunInfo, WorkflowRun } from './types';
import { maskText, pruneExports } from './bundle';
import { captureScreenshot } from './screenshot';
import { L } from './i18n';

const ROLE: Record<AgentRunInfo['role'], [string, string]> = {
  planner: ['撰寫計畫', 'Planner'],
  plan_reviewer: ['審查計畫', 'Plan reviewer'],
  executor: ['實作', 'Implementer'],
  code_reviewer: ['審查程式碼', 'Code reviewer'],
  verifier: ['驗收目標', 'Goal verifier'],
  adjudicator: ['裁決', 'Adjudicator'],
  subagent: ['子 agent', 'Sub-agent'],
  advisor: ['顧問', 'Advisor'],
  compactor: ['整理對話', 'Compaction'],
  test: ['測試', 'Test'],
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cut = (s: string, n: number) => {
  const t = s.trim();
  return t.length > n ? `${t.slice(0, n)}\n… (${L(`另有 ${t.length - n} 字元`, `${t.length - n} more characters`)})` : t;
};
const when = (ts?: number) => (ts ? new Date(ts).toLocaleString() : '—');
const took = (a?: number, b?: number) => {
  if (!a) return '';
  const s = Math.round(((b ?? Date.now()) - a) / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

/**
 * The conversation as a page a person reads: your message, then every agent in the order it started with what it
 * said, the tools it ran (output shortened) and its errors, then the result. Thinking is left out.
 * Every piece of recorded text is masked as it is (keys, tokens, e-mail addresses), then shortened, then made HTML:
 * masking after escaping would miss a "password": "…" whose quotes had become &quot;.
 */
export function runReportHtml(run: WorkflowRun, eventsOf: (agentId: string) => AgentEvent[]): { html: string; masked: number } {
  let masked = 0;
  const text = (s: string | undefined, n?: number) => {
    const r = maskText(s ?? '');
    masked += r.count;
    return esc(n ? cut(r.text, n) : r.text.trim());
  };
  const agents = Object.values(run.agents).sort((a, b) => (a.startedAt ?? Infinity) - (b.startedAt ?? Infinity));
  const parts: string[] = [];
  const title = text(run.config.title || run.config.goal.split('\n')[0].slice(0, 80));
  parts.push(`<h1>${title}</h1>`);
  parts.push(
    `<dl class="meta"><dt>${L('開始', 'Started')}</dt><dd>${when(run.createdAt)}</dd><dt>${L('結束', 'Ended')}</dt><dd>${when(run.endedAt)}</dd><dt>${L('狀態', 'Status')}</dt><dd>${esc(run.status)}</dd><dt>${L('工作資料夾', 'Working folder')}</dt><dd>${text(run.config.cwd)}</dd><dt>${L('匯出', 'Exported')}</dt><dd>${when(Date.now())}</dd></dl>`,
  );
  parts.push(`<h2>${L('你的訊息', 'Your message')}</h2><div class="msg user">${text(run.config.goal)}</div>`);
  for (const a of agents) {
    const role = ROLE[a.role] ? L(ROLE[a.role][0], ROLE[a.role][1]) : a.role;
    const who = `${a.provider}${a.model ? ` · ${a.model}` : ''}`;
    parts.push(`<h2>${esc(role)}${a.round ? ` · ${L(`第 ${a.round} 輪`, `round ${a.round}`)}` : ''} <span class="who">${text(who)} · ${esc(a.status)}${took(a.startedAt, a.endedAt) ? ` · ${took(a.startedAt, a.endedAt)}` : ''}</span></h2>`);
    if (a.depth > 0 && a.task) parts.push(`<div class="task">${L('任務', 'Task')}：${text(a.task, 1500)}</div>`);
    const events = eventsOf(a.id);
    // A tool call is recorded when it starts and again when it ends: one line per call, with its last state.
    const last = new Map<string, number>();
    events.forEach((e, i) => e.tool && last.set(e.tool.id, i));
    events.forEach((e, i) => {
      if (e.kind === 'message' && e.text?.trim()) parts.push(`<div class="msg">${text(e.text)}</div>`);
      else if (e.kind === 'error' && e.text?.trim()) parts.push(`<div class="err">${text(e.text, 2000)}</div>`);
      else if (e.kind === 'tool' && e.tool && last.get(e.tool.id) === i) {
        const out = e.tool.output?.trim();
        parts.push(`<div class="tool"><b>${text(e.tool.title || e.tool.name)}</b> <span class="st ${esc(e.tool.status)}">${esc(e.tool.status)}</span>${out ? `<pre>${text(out, 600)}</pre>` : ''}</div>`);
      }
    });
    if (a.finalText?.trim()) parts.push(`<div class="final"><div class="lbl">${L('結果', 'Result')}</div>${text(a.finalText)}</div>`);
    if (a.error) parts.push(`<div class="err">${text(a.error, 2000)}</div>`);
  }
  const css = `body{font:11pt/1.55 "Segoe UI","Microsoft JhengHei","PingFang TC","Noto Sans CJK TC",system-ui,sans-serif;color:#1d1d1f;margin:0}
h1{font-size:18pt;margin:0 0 8px}h2{font-size:12.5pt;margin:22px 0 6px;border-bottom:1px solid #ddd;padding-bottom:3px;break-after:avoid}
.who{font-weight:400;color:#666;font-size:9.5pt}.meta{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;font-size:9.5pt;color:#444;margin:0 0 10px}
.meta dt{color:#888}.meta dd{margin:0}.msg,.final,.task{white-space:pre-wrap;word-break:break-word;margin:6px 0}.user{background:#f2f4f8;border-radius:6px;padding:8px 10px}
.task{color:#555;font-size:10pt}.final{border-left:3px solid #3b6fd8;padding-left:10px}.lbl{font-size:9pt;color:#3b6fd8;font-weight:600}
.tool{font-size:9pt;color:#444;margin:4px 0}.tool pre{white-space:pre-wrap;word-break:break-word;background:#f6f6f6;padding:5px 7px;border-radius:4px;margin:3px 0;font:8.5pt/1.4 Consolas,"Cascadia Mono",monospace}
.st.error,.err{color:#b3261e}.err{white-space:pre-wrap;font-size:10pt;margin:6px 0}`;
  return { html: `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${css}</style></head><body>${parts.join('\n')}</body></html>`, masked };
}

/** The conversation as a PDF in the exports folder (keys and e-mail addresses masked), printed by a headless browser. */
export async function exportRunPdf(dataDir: string, run: WorkflowRun, eventsOf: (agentId: string) => AgentEvent[]): Promise<{ path: string; bytes: number; masked: number }> {
  const dir = path.join(dataDir, 'exports');
  fs.mkdirSync(dir, { recursive: true });
  pruneExports(dir);
  const { html: page, masked } = runReportHtml(run, eventsOf);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
  const html = path.join(dir, `${run.id}-${stamp}.html`);
  const out = path.join(dir, `${run.id}-${stamp}.pdf`);
  fs.writeFileSync(html, page);
  try {
    await captureScreenshot({ target: html, cwd: dir, out, anywhere: true, pdf: true, waitMs: 0 });
  } finally {
    fs.rmSync(html, { force: true });
  }
  return { path: out, bytes: fs.statSync(out).size, masked };
}
