import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { ConfigValue, ExtensionId, ExtensionStatus, InstructionRole, McpServerConfig, PackSkillId, PonytailLevel, ProjectSkillInfo, SkillInfo, SkillReview } from '../../../core/src/types';
import { hub, useCapabilities, useExtensions, useHostInfo, usePackSkills, useProviders } from '../api';
import { useT, type T } from '../i18n';
import { cx, providerColor } from '../util';
import { GithubCard } from '../components/GithubCard';
import { ExtensionGuide } from '../components/ExtensionGuide';
import { OmniProviders } from '../components/OmniProviders';
import { ask } from '../components/Ask';

const ROLES: InstructionRole[] = ['all', 'planner', 'plan_reviewer', 'executor', 'code_reviewer', 'subagent'];

const roleName = (t: T, r: InstructionRole) =>
  ({
    all: t('所有角色', 'All roles'),
    planner: t('撰寫計畫', 'Planner'),
    plan_reviewer: t('審查計畫', 'Plan reviewer'),
    executor: t('實作', 'Implementer'),
    code_reviewer: t('審查程式碼', 'Code reviewer'),
    subagent: 'Sub agent',
  })[r];

function useBusy() {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, run, setError };
}

// ---------------- role instructions ----------------

function Instructions() {
  const t = useT();
  const { config } = useCapabilities();
  const [draft, setDraft] = useState(config.instructions);
  const [role, setRole] = useState<InstructionRole>('all');
  const [saved, setSaved] = useState(false);
  const { error, busy, run } = useBusy();
  useEffect(() => setDraft(config.instructions), [config.instructions]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(config.instructions);
  return (
    <section className="cap">
      <div className="cap-head">
        <div>
          <h3>{t('角色指示', 'Role instructions')}</h3>
          <p className="muted small">
            {t(
              '加在每個 agent 的系統提示詞後面（Claude Code、Qwen 使用 --append-system-prompt，其他 CLI 會放在任務指示最前面）。「所有角色」會套用到每一個角色。',
              'Appended to each agent\'s system prompt (Claude Code and Qwen use --append-system-prompt; other CLIs get it at the top of the task). "All roles" applies to every role.',
            )}
          </p>
        </div>
      </div>
      <div className="tabs-mini">
        {ROLES.map((r) => (
          <button key={r} className={cx(role === r && 'on')} onClick={() => setRole(r)}>
            {roleName(t, r)}
            {draft[r]?.trim() ? <span className="has" /> : null}
          </button>
        ))}
      </div>
      <textarea
        rows={7}
        value={draft[role] ?? ''}
        onChange={(e) => {
          setSaved(false);
          setDraft({ ...draft, [role]: e.target.value });
        }}
        placeholder={
          role === 'code_reviewer'
            ? t('例如：一律要求新功能附上單元測試；檢查錯誤處理與邊界情況。', 'e.g. Always require unit tests for new features; check error handling and edge cases.')
            : role === 'all'
              ? t('例如：程式註解使用繁體中文；不要新增不必要的相依套件。', 'e.g. Write code comments in English; avoid adding unnecessary dependencies.')
              : t('這個角色的額外指示…', 'Extra instructions for this role…')
        }
      />
      <div className="row gap">
        <button className="btn primary" disabled={!dirty || busy} onClick={() => run(() => hub.call('capabilities.setInstructions', { instructions: draft })).then((ok) => ok && setSaved(true))}>
          {t('儲存', 'Save')}
        </button>
        {saved && !dirty && <span className="ok-text small">✓ {t('已儲存', 'Saved')}</span>}
        {error && <span className="err-text small">{error}</span>}
      </div>
    </section>
  );
}

// ---------------- MCP servers ----------------

type KV = { key: string; value: string; secret: boolean; stored: boolean; gh?: { prefix?: string } };

function toRows(map: Record<string, ConfigValue> | undefined): KV[] {
  return Object.entries(map ?? {}).map(([key, v]) =>
    typeof v === 'string' ? { key, value: v, secret: false, stored: false } : 'ghToken' in v ? { key, value: '', secret: false, stored: true, gh: { prefix: v.prefix } } : { key, value: '', secret: true, stored: true },
  );
}

function KVEditor({ rows, onChange, keyLabel }: { rows: KV[]; onChange: (r: KV[]) => void; keyLabel: string }) {
  const t = useT();
  const set = (i: number, patch: Partial<KV>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="kvlist">
      {rows.map((r, i) => (
        <div key={i} className="kvrow">
          <input className="mono" placeholder={keyLabel} value={r.key} onChange={(e) => set(i, { key: e.target.value })} />
          <input
            className="mono grow"
            type={r.secret ? 'password' : 'text'}
            disabled={!!r.gh}
            placeholder={r.gh ? t('使用 GitHub 登入（啟動 agent 時自動帶入）', 'GitHub sign-in (filled in when an agent starts)') : r.secret && r.stored ? t('已加密保存（輸入以取代）', 'Stored encrypted (type to replace)') : t('值', 'value')}
            value={r.value}
            onChange={(e) => set(i, { value: e.target.value })}
            autoComplete="off"
          />
          <button className={cx('icon-btn', r.secret && 'on')} title={t('以加密方式保存（金鑰、Token）', 'Store encrypted (keys, tokens)')} onClick={() => set(i, { secret: !r.secret, stored: false })}>
            {r.secret ? '🔒' : '🔓'}
          </button>
          <button className="icon-btn" onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            ✕
          </button>
        </div>
      ))}
      <button className="link" onClick={() => onChange([...rows, { key: '', value: '', secret: false, stored: false }])}>
        + {t('新增', 'Add')}
      </button>
    </div>
  );
}

function ServerEditor({ initial, isNew, onClose }: { initial: McpServerConfig; isNew: boolean; onClose: () => void }) {
  const t = useT();
  const providers = useProviders();
  const [s, setS] = useState(initial);
  const [args, setArgs] = useState((initial.args ?? []).join('\n'));
  const [env, setEnv] = useState(toRows(initial.env));
  const [headers, setHeaders] = useState(toRows(initial.headers));
  const { error, busy, run } = useBusy();
  const save = () =>
    run(async () => {
      const secrets: Record<string, string> = {};
      const pack = (rows: KV[], kind: 'env' | 'header') => {
        const out: Record<string, ConfigValue> = {};
        for (const r of rows) {
          if (!r.key.trim()) continue;
          if (r.gh) {
            out[r.key.trim()] = { ghToken: true, prefix: r.gh.prefix };
            continue;
          }
          if (r.secret) {
            if (!r.value && !r.stored) continue;
            out[r.key.trim()] = { secret: true };
            if (r.value) secrets[`${kind}:${r.key.trim()}`] = r.value;
          } else out[r.key.trim()] = r.value;
        }
        return out;
      };
      const server: McpServerConfig = {
        ...s,
        id: s.id.trim(),
        args: s.transport === 'stdio' ? args.split('\n').map((a) => a.trim()).filter(Boolean) : undefined,
        command: s.transport === 'stdio' ? s.command?.trim() : undefined,
        url: s.transport === 'http' ? s.url?.trim() : undefined,
        env: s.transport === 'stdio' ? pack(env, 'env') : undefined,
        headers: s.transport === 'http' ? pack(headers, 'header') : undefined,
      };
      await hub.call('capabilities.saveServer', { server, secrets });
      onClose();
    });
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3>{isNew ? t('新增 MCP 伺服器', 'Add MCP server') : s.id}</h3>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="kv">
          <label>{t('名稱', 'Name')}</label>
          <input className="mono" disabled={!isNew} value={s.id} onChange={(e) => setS({ ...s, id: e.target.value })} placeholder="github" />
        </div>
        <div className="kv">
          <label>{t('說明', 'Description')}</label>
          <input value={s.description ?? ''} onChange={(e) => setS({ ...s, description: e.target.value })} />
        </div>
        <div className="kv">
          <label>{t('類型', 'Type')}</label>
          <div className="seg">
            <button className={cx(s.transport === 'stdio' && 'on')} onClick={() => setS({ ...s, transport: 'stdio' })}>
              stdio（{t('本機指令', 'local command')}）
            </button>
            <button className={cx(s.transport === 'http' && 'on')} onClick={() => setS({ ...s, transport: 'http' })}>
              HTTP
            </button>
          </div>
        </div>
        {s.transport === 'stdio' ? (
          <>
            <div className="kv">
              <label>{t('指令', 'Command')}</label>
              <input className="mono" value={s.command ?? ''} onChange={(e) => setS({ ...s, command: e.target.value })} placeholder="npx" />
            </div>
            <div className="kv top">
              <label>{t('參數（每行一個）', 'Args (one per line)')}</label>
              <textarea className="code" rows={3} value={args} onChange={(e) => setArgs(e.target.value)} placeholder={'-y\n@modelcontextprotocol/server-github'} />
            </div>
            <div className="kv top">
              <label>{t('環境變數', 'Environment')}</label>
              <KVEditor rows={env} onChange={setEnv} keyLabel="GITHUB_TOKEN" />
            </div>
          </>
        ) : (
          <>
            <div className="kv">
              <label>URL</label>
              <input className="mono" value={s.url ?? ''} onChange={(e) => setS({ ...s, url: e.target.value })} placeholder="https://example.com/mcp" />
            </div>
            <div className="kv top">
              <label>Headers</label>
              <KVEditor rows={headers} onChange={setHeaders} keyLabel="Authorization" />
            </div>
          </>
        )}
        <div className="kv top">
          <label>{t('提供給', 'Available to')}</label>
          <div className="row gap wrap">
            {providers.map((p) => {
              const on = !s.providers?.length || s.providers.includes(p.spec.id);
              return (
                <label key={p.spec.id} className={cx('chip-check', on && 'on')}>
                  <input
                    type="checkbox"
                    checked={on}
                    onChange={(e) => {
                      const all = providers.map((x) => x.spec.id);
                      const cur = s.providers?.length ? s.providers : all;
                      const next = e.target.checked ? [...cur, p.spec.id] : cur.filter((x) => x !== p.spec.id);
                      setS({ ...s, providers: next.length === all.length ? [] : next });
                    }}
                  />
                  <span className="mark" style={{ background: providerColor(p.spec.id) }} />
                  {p.spec.name}
                </label>
              );
            })}
          </div>
        </div>
        {error && <div className="note err">{error}</div>}
        <div className="row end gap">
          <button className="btn" onClick={onClose}>
            {t('取消', 'Cancel')}
          </button>
          <button className="btn primary" disabled={busy} onClick={save}>
            {t('儲存', 'Save')}
          </button>
        </div>
      </div>
    </div>
  );
}

function ImportJson({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [text, setText] = useState('');
  const { error, busy, run } = useBusy();
  const doImport = () =>
    run(async () => {
      const json = JSON.parse(text);
      const servers = json.mcpServers ?? json.servers ?? json;
      if (!servers || typeof servers !== 'object') throw new Error(t('找不到 mcpServers', 'No mcpServers found'));
      for (const [id, v] of Object.entries<any>(servers)) {
        const http = !!(v.url || v.httpUrl);
        const server: McpServerConfig = {
          id: id.toLowerCase().replace(/[^a-z0-9_-]+/g, '-'),
          enabled: true,
          transport: http ? 'http' : 'stdio',
          command: v.command,
          args: v.args,
          env: v.env,
          url: v.url ?? v.httpUrl,
          headers: v.headers,
        };
        await hub.call('capabilities.saveServer', { server });
      }
      onClose();
    });
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3>{t('從 JSON 匯入', 'Import from JSON')}</h3>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="muted small">
          {t('貼上 Claude Code／Cursor／Gemini 常見的 mcpServers 設定。匯入後環境變數是明文保存，含金鑰的欄位建議再編輯改成 🔒。', 'Paste an mcpServers block as used by Claude Code / Cursor / Gemini. Imported env values are stored in plain text; edit and lock 🔒 any secrets afterwards.')}
        </p>
        <textarea className="code" rows={14} value={text} onChange={(e) => setText(e.target.value)} placeholder={'{\n  "mcpServers": {\n    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }\n  }\n}'} />
        {error && <div className="note err">{error}</div>}
        <div className="row end gap">
          <button className="btn" onClick={onClose}>
            {t('取消', 'Cancel')}
          </button>
          <button className="btn primary" disabled={busy || !text.trim()} onClick={doImport}>
            {t('匯入', 'Import')}
          </button>
        </div>
      </div>
    </div>
  );
}

function ServerRow({ s }: { s: McpServerConfig }) {
  const t = useT();
  const providers = useProviders();
  const [editing, setEditing] = useState(false);
  const [probe, setProbe] = useState<{ busy?: boolean; tools?: { name: string; description?: string }[]; error?: string }>();
  const test = async () => {
    setProbe({ busy: true });
    try {
      setProbe({ tools: await hub.call('capabilities.testServer', { id: s.id }) });
    } catch (e) {
      setProbe({ error: (e as Error).message });
    }
  };
  const target = s.transport === 'http' ? s.url : [s.command, ...(s.args ?? [])].join(' ');
  return (
    <div className="crow">
      <div className="crow-head">
        <label className="switch">
          <input type="checkbox" checked={s.enabled} onChange={(e) => hub.call('capabilities.saveServer', { server: { ...s, enabled: e.target.checked } })} />
          <span />
        </label>
        <div className="grow min0">
          <div className="crow-name">
            {s.id} <span className="tag">{s.transport}</span>
          </div>
          <div className="muted small mono ellipsis">{s.description || target}</div>
        </div>
        <div className="row gap">
          <span className="muted small">{s.providers?.length ? s.providers.map((id) => providers.find((p) => p.spec.id === id)?.spec.name ?? id).join(', ') : t('全部供應商', 'All providers')}</span>
          <button className="btn small" disabled={probe?.busy} onClick={test}>
            {probe?.busy ? t('測試中…', 'Testing…') : t('測試', 'Test')}
          </button>
          <button className="btn small ghost" onClick={() => setEditing(true)}>
            {t('編輯', 'Edit')}
          </button>
          <button className="icon-btn" title={t('刪除', 'Delete')} onClick={async () => (await ask(t(`刪除 ${s.id}？`, `Delete ${s.id}?`), { danger: true })) && hub.call('capabilities.deleteServer', { id: s.id })}>
            ✕
          </button>
        </div>
      </div>
      {probe?.error && <div className="note err">{probe.error}</div>}
      {probe?.tools && (
        <div className="note">
          ✓ {t(`連線成功，${probe.tools.length} 個工具：`, `Connected, ${probe.tools.length} tools: `)}
          <span className="mono small">{probe.tools.map((x) => x.name).join(', ')}</span>
        </div>
      )}
      {editing && <ServerEditor initial={s} isNew={false} onClose={() => setEditing(false)} />}
    </div>
  );
}

interface PresetInfo {
  id: string;
  name: string;
  zh: string;
  en: string;
  docsUrl: string;
}

/** One-click browser tools (Playwright / Chrome DevTools MCP). */
function BrowserPresets({ servers }: { servers: McpServerConfig[] }) {
  const t = useT();
  const [presets, setPresets] = useState<PresetInfo[]>([]);
  const [headed, setHeaded] = useState<Record<string, boolean>>({});
  const { error, busy, run } = useBusy();
  useEffect(() => {
    hub.call<PresetInfo[]>('capabilities.presets').then(setPresets).catch(() => undefined);
  }, []);
  if (!presets.length) return null;
  return (
    <div className="presets-grid">
      {presets.map((p) => {
        const existing = servers.find((s) => s.id === p.id);
        return (
          <div key={p.id} className={cx('preset-card', existing?.enabled && 'on')}>
            <div className="row gap">
              <b>🌐 {p.name}</b>
              {existing && <span className={cx('pill', existing.enabled ? 'ok' : 'muted')}>{existing.enabled ? t('已啟用', 'On') : t('已停用', 'Off')}</span>}
            </div>
            <div className="muted small">{t(p.zh, p.en)}</div>
            {!existing ? (
              <div className="row gap wrap">
                <button className="btn primary" disabled={busy} onClick={() => run(() => hub.call('capabilities.addPreset', { id: p.id, headed: !!headed[p.id] }))}>
                  {t('一鍵啟用', 'Enable')}
                </button>
                <label className="check small">
                  <input type="checkbox" checked={!!headed[p.id]} onChange={(e) => setHeaded({ ...headed, [p.id]: e.target.checked })} />
                  {t('顯示瀏覽器視窗（看 agent 操作）', 'Show the browser window (watch the agent)')}
                </label>
              </div>
            ) : (
              <div className="muted tiny">{t('在下方清單可停用、測試或移除。', 'Turn off, test or remove it in the list below.')}</div>
            )}
            <button className="link tiny" onClick={() => hub.call('host.openExternal', { url: p.docsUrl })}>
              {t('說明文件', 'Docs')}
            </button>
          </div>
        );
      })}
      <div className="muted tiny preset-note">
        {t(
          '使用獨立、用完即丟的瀏覽器設定檔，不會用到你平常登入帳號的瀏覽器。第一次使用時會自動下載工具（需要 Node.js）。',
          'Uses a separate throwaway browser profile, never your everyday browser with your logins. The tool downloads on first use (needs Node.js).',
        )}
      </div>
      {error && <div className="note err">{error}</div>}
    </div>
  );
}

function McpServers() {
  const t = useT();
  const { config } = useCapabilities();
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  return (
    <section className="cap">
      <div className="cap-head">
        <div>
          <h3>{t('共用 MCP 伺服器', 'Shared MCP servers')}</h3>
          <p className="muted small">
            {t(
              '設定一次，執行時自動提供給所選供應商的每一個 agent，不必在 Claude、Codex、Antigravity 各設定一次。各 CLI 自己原本設定的 MCP 仍然有效。',
              'Configure once; every agent of the selected providers gets these servers at run time, so you no longer configure Claude, Codex and Antigravity separately. Each CLI\'s own MCP settings still apply.',
            )}
          </p>
        </div>
        <div className="row gap">
          <button className="btn ghost" onClick={() => setImporting(true)}>
            {t('從 JSON 匯入', 'Import JSON')}
          </button>
          <button className="btn primary" onClick={() => setAdding(true)}>
            {t('新增', 'Add')}
          </button>
        </div>
      </div>
      <div className="block-label">{t('瀏覽器工具', 'Browser tools')}</div>
      <BrowserPresets servers={config.mcpServers} />
      <div className="block-label">{t('已設定的伺服器', 'Configured servers')}</div>
      <div className="clist">
        {config.mcpServers.length === 0 && <div className="empty-row muted small">{t('尚未設定共用 MCP 伺服器', 'No shared MCP servers yet')}</div>}
        {config.mcpServers.map((s) => (
          <ServerRow key={s.id} s={s} />
        ))}
      </div>
      {adding && <ServerEditor isNew initial={{ id: '', enabled: true, transport: 'stdio', args: [], env: {} }} onClose={() => setAdding(false)} />}
      {importing && <ImportJson onClose={() => setImporting(false)} />}
    </section>
  );
}

// ---------------- skills ----------------

const SKILL_TEMPLATE = `---
name: my-skill
description: 說明這個 skill 什麼時候該用（agent 依這行判斷是否讀取）
---

# My skill

在這裡寫下步驟、規範或範例。可以在同一個資料夾放其他檔案並在這裡引用。
`;

function SkillEditor({ name, onClose }: { name?: string; onClose: () => void }) {
  const t = useT();
  const [skillName, setSkillName] = useState(name ?? '');
  const [content, setContent] = useState(name ? '' : SKILL_TEMPLATE);
  const { error, busy, run } = useBusy();
  useEffect(() => {
    if (name) hub.call<string>('skills.read', { name }).then(setContent).catch(() => undefined);
  }, [name]);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3>{name ? name : t('新增 Skill', 'New skill')}</h3>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>
        {!name && (
          <div className="kv">
            <label>{t('資料夾名稱', 'Folder name')}</label>
            <input className="mono" value={skillName} onChange={(e) => setSkillName(e.target.value)} placeholder="code-style" />
          </div>
        )}
        <textarea className="code" rows={20} value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} />
        {error && <div className="note err">{error}</div>}
        <div className="row end gap">
          <button className="btn" onClick={onClose}>
            {t('取消', 'Cancel')}
          </button>
          <button className="btn primary" disabled={busy || !skillName.trim()} onClick={() => run(() => hub.call('skills.save', { name: skillName.trim(), content })).then((ok) => ok && onClose())}>
            {t('儲存', 'Save')}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Why a skill is or is not loaded, and what the local scan of its current files found. */
function ReviewState({ r }: { r: SkillReview }) {
  const t = useT();
  const n = (r.scan?.findings.length ?? 0) + (r.scan?.more ?? 0);
  const scan =
    r.scan?.status === 'failed'
      ? t(`無法掃描：${r.scan.error ?? ''}`, `Could not be scanned: ${r.scan.error ?? ''}`)
      : r.scan?.status === 'findings'
        ? t(`靜態掃描：${n} 處需要注意`, `Static scan: ${n} finding(s) to look at`)
        : r.scan?.status === 'clean'
          ? t('靜態掃描：沒有發現需要注意的內容（不代表一定安全）', 'Static scan: nothing to look at found (not a guarantee of safety)')
          : t('還沒掃描', 'Not scanned yet');
  const state =
    r.state === 'approved'
      ? r.by === 'editor'
        ? t('用內建編輯器寫的', 'Written in the built-in editor')
        : r.by === 'aivenue'
          ? t('Aivenue 自己寫的', 'Written by Aivenue')
          : t('已確認這一版', 'This version was approved')
      : r.state === 'changed'
        ? t('確認後檔案又變了：暫停載入，要重新確認這一版才會提供給 agent', 'The files changed after approval: not loaded until you approve this version')
        : r.state === 'failed'
          ? t('無法掃描，維持停用', 'Could not be scanned, so it stays off')
          : t('待確認：還沒確認過這一版，暫停載入。打開開關，看過掃描結果後確認，才會提供給 agent', 'Waiting for approval: not loaded until you turn it on and approve this version after looking at the scan')
  return (
    <div className={cx('skill-review', r.state)}>
      <span className={cx('ext-chip', r.state === 'approved' ? 'ok' : r.state === 'failed' ? 'bad' : 'warn')}>{state}</span>
      <span className="muted tiny"> · {scan}</span>
    </div>
  );
}

/**
 * Turning a third-party skill on: the user sees the version (hash, files) and every finding, and approves exactly
 * that content; with findings, a second confirmation. A failed scan cannot be approved.
 */
function ApproveSkill({ title, r, onApprove, onClose }: { title: string; r: SkillReview; onApprove: (acceptFindings: boolean) => Promise<unknown>; onClose: () => void }) {
  const t = useT();
  const [seen, setSeen] = useState(false);
  const [error, setError] = useState<string>();
  const findings = r.scan?.findings ?? [];
  const n = findings.length + (r.scan?.more ?? 0);
  const failed = r.state === 'failed' || r.scan?.status === 'failed';
  const approve = () =>
    onApprove(n > 0)
      .then(onClose)
      .catch((e) => setError((e as Error).message));
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3>{t(`啟用前確認：${title}`, `Before turning it on: ${title}`)}</h3>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>
        <p className="small">
          {t(
            `Aivenue 只會載入你確認的這一版（版本 ${r.hash?.slice(0, 12) ?? '?'}，${r.scan?.files ?? '?'} 個檔案）。之後任何檔案有變動，都會暫停載入，等你重新確認。`,
            `Aivenue loads only the version you approve here (version ${r.hash?.slice(0, 12) ?? '?'}, ${r.scan?.files ?? '?'} ${r.scan?.files === 1 ? 'file' : 'files'}). Any later change to its files stops it from loading until you approve again.`,
          )}
        </p>
        {failed ? (
          <div className="note err">{t(`無法掃描，不能啟用：${r.scan?.error ?? ''}`, `It could not be scanned and cannot be turned on: ${r.scan?.error ?? ''}`)}</div>
        ) : n === 0 ? (
          <div className="note">{t('本機靜態掃描沒有發現需要注意的內容。這只是規則比對，不代表一定安全。', 'The local static scan found nothing to look at. It only matches rules; it is not a guarantee of safety.')}</div>
        ) : (
          <>
            <div className="note warn">
              {t(`本機靜態掃描找到 ${n} 處需要注意。這些是線索，不是判定：討論安全問題的 skill 也會命中。`, `The local static scan found ${n} place(s) to look at. They are leads, not verdicts: a skill that discusses security matches some too.`)}
            </div>
            <div className="findings">
              {findings.map((f, i) => (
                <div key={i} className="finding">
                  <code>
                    {f.file}
                    {f.line ? `:${f.line}` : ''}
                  </code>{' '}
                  <span className="tag">{f.category}</span> <span className="muted tiny">{f.rule}</span>
                  <div className="mono small break">{f.excerpt}</div>
                </div>
              ))}
              {r.scan?.more ? <div className="muted small">{t(`還有 ${r.scan.more} 處沒有列出`, `${r.scan.more} more not listed`)}</div> : null}
            </div>
            <label className="row gap small">
              <input type="checkbox" checked={seen} onChange={(e) => setSeen(e.target.checked)} />
              {t(`我看過以上 ${n} 處，仍要啟用這一版`, `I looked at these ${n} finding(s) and still want to turn this version on`)}
            </label>
          </>
        )}
        {error && <div className="note err">{error}</div>}
        <div className="row gap end">
          <button className="btn ghost" onClick={onClose}>
            {t('取消', 'Cancel')}
          </button>
          <button className="btn primary" disabled={failed || (n > 0 && !seen)} onClick={approve}>
            {t('啟用這一版', 'Turn this version on')}
          </button>
        </div>
      </div>
    </div>
  );
}

function SkillRow({ s }: { s: SkillInfo }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [approving, setApproving] = useState(false);
  const roles = s.roles ?? [];
  const toggleRole = (r: InstructionRole) => {
    const next = roles.includes(r) ? roles.filter((x) => x !== r) : [...roles, r];
    void hub.call('skills.set', { name: s.name, roles: next });
  };
  const loaded = s.enabled && s.review.state === 'approved';
  // Turning on a version nobody approved goes through the approval.
  const toggle = (on: boolean) => (!on || s.review.state === 'approved' ? hub.call('skills.set', { name: s.name, enabled: on }) : setApproving(true));
  return (
    <div className="crow">
      <div className="crow-head">
        <label className="switch">
          <input type="checkbox" checked={loaded} onChange={(e) => toggle(e.target.checked)} />
          <span />
        </label>
        <div className="grow min0">
          <div className="crow-name">
            {s.name} {s.files > 1 && <span className="tag">{t(`${s.files} 個檔案`, `${s.files} files`)}</span>}
          </div>
          <div className="muted small">{s.description || t('（沒有 description）', '(no description)')}</div>
          <ReviewState r={s.review} />
        </div>
        <div className="row gap">
          <button className="btn small ghost" onClick={() => setEditing(true)}>
            {t('編輯', 'Edit')}
          </button>
          <button className="btn small ghost" onClick={() => hub.call('skills.openFolder', { name: s.name })}>
            {t('資料夾', 'Folder')}
          </button>
          <button className="icon-btn" title={t('刪除', 'Delete')} onClick={async () => (await ask(t(`刪除 skill「${s.name}」與其檔案？`, `Delete skill "${s.name}" and its files?`), { danger: true })) && hub.call('skills.delete', { name: s.name })}>
            ✕
          </button>
        </div>
      </div>
      <div className="row gap wrap role-filter">
        <span className="muted tiny">{t('提供給：', 'For: ')}</span>
        {ROLES.filter((r) => r !== 'all').map((r) => (
          <button key={r} className={cx('mini-chip', (roles.length === 0 || roles.includes(r)) && 'on')} onClick={() => toggleRole(r)}>
            {roleName(t, r)}
          </button>
        ))}
        {roles.length > 0 && (
          <button className="link" onClick={() => hub.call('skills.set', { name: s.name, roles: [] })}>
            {t('全部角色', 'All roles')}
          </button>
        )}
      </div>
      {editing && <SkillEditor name={s.name} onClose={() => setEditing(false)} />}
      {approving && <ApproveSkill title={s.name} r={s.review} onApprove={(acceptFindings) => hub.call('skills.approve', { name: s.name, hash: s.review.hash, acceptFindings })} onClose={() => setApproving(false)} />}
    </div>
  );
}

/** A skill in a working folder's .aivenue/skills: its files stay there; it loads only once this version is approved. */
function ProjectSkillRow({ s }: { s: ProjectSkillInfo }) {
  const t = useT();
  const [approving, setApproving] = useState(false);
  const loaded = s.review.state === 'approved';
  return (
    <div className="crow">
      <div className="crow-head">
        <label className="switch">
          <input type="checkbox" checked={loaded} onChange={(e) => (e.target.checked ? setApproving(true) : hub.call('skills.disableProject', { dir: s.dir }))} />
          <span />
        </label>
        <div className="grow min0">
          <div className="crow-name">{s.name}</div>
          <div className="muted small">{s.description || t('（沒有 description）', '(no description)')}</div>
          <div className="muted tiny mono break">{s.dir}</div>
          <ReviewState r={s.review} />
        </div>
      </div>
      {approving && <ApproveSkill title={s.name} r={s.review} onApprove={(acceptFindings) => hub.call('skills.approveProject', { dir: s.dir, hash: s.review.hash, acceptFindings })} onClose={() => setApproving(false)} />}
    </div>
  );
}

function Skills() {
  const t = useT();
  const host = useHostInfo();
  const { skills, projectSkills = [] } = useCapabilities();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <section className="cap">
      <div className="cap-head">
        <div>
          <h3>{t('共用 Skills', 'Shared skills')}</h3>
          <p className="muted small">
            {t(
              '採用 Agent Skills 格式（資料夾 + SKILL.md）。每個 agent 都會收到 skill 清單（名稱與說明），需要時自己讀取 SKILL.md，因此任何能讀檔的 CLI 都能使用。',
              'Agent Skills format (a folder with SKILL.md). Every agent gets the list of skills (name and description) and reads SKILL.md when relevant, so any CLI that can read files can use them.',
            )}
          </p>
          <p className="muted small">
            {t(
              '匯入或手動放進資料夾的 skill 會先暫停載入：Aivenue 在本機做靜態掃描（不連網、不呼叫模型），你看過結果、確認這一版後才會提供給 agent；確認後檔案有變動，會再暫停。用「新增」或「編輯」在這裡寫的 skill 不受影響。',
              'Skills you import or put into the folder yourself are not loaded at first: Aivenue scans them locally (no network, no model), and offers one to agents only after you looked at the result and approved that version; a later change to its files stops it again. Skills written here with Add or Edit are not affected.',
            )}
          </p>
        </div>
        <div className="row gap">
          <button className="btn ghost" onClick={() => hub.call('skills.openFolder', {})}>
            {t('開啟資料夾', 'Open folder')}
          </button>
          {host?.canPickFolder && (
            <button className="btn ghost" onClick={() => hub.call('skills.import').catch((e) => setError(e.message))}>
              {t('匯入資料夾…', 'Import folder…')}
            </button>
          )}
          <button className="btn primary" onClick={() => setAdding(true)}>
            {t('新增', 'Add')}
          </button>
        </div>
      </div>
      {error && <div className="note err">{error}</div>}
      <div className="clist">
        {skills.length === 0 && <div className="empty-row muted small">{t('尚未加入 skill。可以從 Claude Code 的 ~/.claude/skills 匯入現有的 skill 資料夾。', 'No skills yet. You can import existing skill folders, e.g. from ~/.claude/skills.')}</div>}
        {skills.map((s) => (
          <SkillRow key={s.name} s={s} />
        ))}
      </div>
      {projectSkills.length > 0 && (
        <>
          <h4>{t('工作資料夾裡的專案 skills', 'Project skills in working folders')}</h4>
          <p className="muted small">
            {t(
              'Aivenue 在工作資料夾的 .aivenue/skills 找到這些 skill。檔案留在原處；確認這一版之前不會提供給 agent。Aivenue 自己整理出的專案規則不受影響。',
              'Aivenue found these in working folders (.aivenue/skills). Their files stay where they are; they are not offered to agents until you approve this version. Project rules Aivenue distilled itself are not affected.',
            )}
          </p>
          <div className="clist">
            {projectSkills.map((s) => (
              <ProjectSkillRow key={s.dir} s={s} />
            ))}
          </div>
        </>
      )}
      {adding && <SkillEditor onClose={() => setAdding(false)} />}
    </section>
  );
}

// ---------------- built-in extensions ----------------

const EXT_INFO: Record<ExtensionId, { icon: string; name: string; zh: string; en: string; url: string; license: string }> = {
  ponytail: {
    icon: '🎀',
    name: 'Ponytail',
    zh: '「最懶的資深工程師」：用最少、最直接的改動完整解決問題，不過度設計、不加沒人要的功能。',
    en: '"The laziest senior dev in the room": the smallest change that fully solves the task, no over-engineering, no features nobody asked for.',
    url: 'https://github.com/DietrichGebert/ponytail',
    license: 'MIT',
  },
  'agent-skills': {
    icon: '🧰',
    name: 'Agent Skills',
    zh: 'Addy Osmani 的 25 個工程技能：規格、計畫拆解、TDD、除錯、程式碼審查、安全、效能等，依角色提供。',
    en: "Addy Osmani's 25 engineering skills: specs, task breakdown, TDD, debugging, code review, security, performance and more, per role.",
    url: 'https://github.com/addyosmani/agent-skills',
    license: 'MIT',
  },
  graphify: {
    icon: '🕸️',
    name: 'Graphify',
    zh: '把專案整理成知識圖譜，agent 先查圖再讀檔，少翻很多檔案。程式碼在本機解析，不呼叫 API。',
    en: 'Turns the project into a knowledge graph; agents query the graph before reading files. Code is parsed locally, no API calls.',
    url: 'https://github.com/Graphify-Labs/graphify',
    license: 'Apache-2.0',
  },
  omniroute: {
    icon: '🔀',
    name: 'OmniRoute',
    zh: '本機 AI 閘道，接上數百家供應商；auto/best-free 會自動挑選現在能用的免費模型，額度用完就換下一家。',
    en: 'A local AI gateway to hundreds of providers; auto/best-free picks a free model that works right now and moves on when one runs out.',
    url: 'https://github.com/diegosouzapw/OmniRoute',
    license: 'MIT',
  },
};

const ROLE_SHORT = (t: T, r: InstructionRole) => roleName(t, r);

/**
 * A window for an extension's longer controls (Agent Skills' skill list, OmniRoute's providers), so the cards stay
 * short and the same height in their grid instead of one card stretching its row.
 */
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Keyboard: focus moves into the window when it opens (its first control), Tab and Shift+Tab stay inside it, Escape
 * closes it, and focus goes back to the button that opened it.
 */
function ExtWindow({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const t = useT();
  const box = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const titleId = useId();
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const items = () => [...(box.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])].filter((el) => el.offsetParent !== null);
    // The first control after the close button (the window's content), else the close button.
    const list = items();
    (list[1] ?? list[0] ?? box.current)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const all = items();
      if (!all.length) return e.preventDefault();
      const first = all[0];
      const last = all[all.length - 1];
      const inside = box.current?.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (opener?.isConnected) opener.focus();
    };
  }, []);
  return (
    <div className="modal-back" onClick={onClose}>
      <div ref={box} className="modal ext-window" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3 id={titleId}>{title}</h3>
          <button className="icon-btn" onClick={onClose} aria-label={t('關閉', 'Close')}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ExtensionCard({ s }: { s: ExtensionStatus }) {
  const t = useT();
  const info = EXT_INFO[s.id];
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [guide, setGuide] = useState(false);
  const [providers, setProviders] = useState(false);
  const { error, busy, run } = useBusy();
  const pill =
    s.state === 'ready' ? (
      <span className="pill ok">{t('可以使用', 'Ready')}</span>
    ) : s.state === 'working' ? (
      <span className="pill">{t('處理中…', 'Working…')}</span>
    ) : s.state === 'error' ? (
      <span className="pill warn">{t('需要處理', 'Needs attention')}</span>
    ) : null;
  const skills = s.skills ?? [];
  const on = skills.filter((k) => k.enabled).length;
  return (
    <div className={cx('preset-card ext-card', s.enabled && s.state === 'ready' && 'on')}>
      <div className="ext-head">
        <label className="switch">
          <input type="checkbox" checked={s.enabled} disabled={busy} onChange={(e) => run(() => hub.call('extensions.setEnabled', { id: s.id, enabled: e.target.checked }))} />
          <span />
        </label>
        <b>
          {info.icon} {info.name}
        </b>
        {s.version && <span className="tag">v{s.version}</span>}
        {pill}
        <button className="btn small ghost ext-guide-btn" onClick={() => setGuide(true)} title={t('這是什麼、包含哪些技能', 'What it is and what it includes')}>
          ⓘ {t('說明', 'About')}
        </button>
      </div>
      <div className="muted small">{t(info.zh, info.en)}</div>
      {s.enabled && s.message && <div className={cx('note', s.state === 'error' && 'err')}>{s.message}</div>}
      {s.enabled && s.state === 'working' && s.progress && <InstallProgress p={s.progress} />}

      {s.id === 'ponytail' && s.enabled && (
        <>
          <div className="row gap wrap">
            <span className="muted tiny">{t('強度', 'Level')}</span>
            <div className="seg small">
              {(['lite', 'full', 'ultra'] as PonytailLevel[]).map((l) => (
                <button key={l} className={cx(s.level === l && 'on')} onClick={() => run(() => hub.call('extensions.setOptions', { id: 'ponytail', level: l }))}>
                  {l}
                </button>
              ))}
            </div>
          </div>
          <div className="muted tiny">
            {s.level === 'lite'
              ? t('lite：照要求做，只用一句話提出更小的做法。', 'lite: build what was asked; name the smaller option in one line.')
              : s.level === 'ultra'
                ? t('ultra：動手前先質疑需求裡沒必要的部分。', 'ultra: also pushes back on parts of the request the need does not justify.')
                : t('full（預設）：最小但完整的改動。', 'full (default): the smallest complete change.')}{' '}
            {t('撰寫計畫、審查計畫、實作與 sub agent 一直套用主技能；審查程式碼套用 ponytail-review。', 'Planner, plan reviewer, implementer and sub-agents always follow the main skill; the code reviewer follows ponytail-review.')}
          </div>
        </>
      )}

      {s.id === 'agent-skills' && s.enabled && (
        <>
          <div className="row gap wrap">
            <span className="small">{t(`已開啟 ${on} / ${skills.length} 個技能`, `${on} of ${skills.length} skills on`)}</span>
            <button className="btn small ghost" onClick={() => setOpen(true)}>
              {t('選擇技能…', 'Choose skills…')}
            </button>
          </div>
          {open && (
            <ExtWindow title={t(`${info.name}：選擇技能（已開啟 ${on} / ${skills.length}）`, `${info.name}: choose skills (${on} of ${skills.length} on)`)} onClose={() => setOpen(false)}>
              <div className="ext-skills in-window">
                {skills.map((k) => (
                  <label key={k.name} className="ext-skill" title={k.description}>
                    <input type="checkbox" checked={k.enabled} onChange={(e) => run(() => hub.call('extensions.setOptions', { id: 'agent-skills', skill: k.name, on: e.target.checked }))} />
                    <span className="mono small">{k.name}</span>
                    {k.interactive && <span className="tag">{t('需要問答', 'asks questions')}</span>}
                    <span className="muted tiny ext-skill-roles">{k.roles.map((r) => ROLE_SHORT(t, r)).join('、')}</span>
                  </label>
                ))}
              </div>
              {error && <div className="note err">{error}</div>}
            </ExtWindow>
          )}
          <div className="muted tiny">{t('agent 只會看到技能名稱與一句說明，用到才讀全文，幾乎不增加 token。', 'Agents only see each skill\'s name and one-line description and read the rest when needed, so it costs almost no tokens.')}</div>
        </>
      )}

      {s.id === 'graphify' && s.enabled && (
        <div className="muted tiny">
          {t(
            '第一次打開會自動安裝 uv 與 graphify（uv 會自己帶 Python，不需要另外安裝）。agent 需要了解大型專案時會用 graphify update . 建圖（寫到 graphify-out/），之後先查圖再讀檔。',
            'The first time it installs uv and graphify (uv brings its own Python). When agents need to understand a large project they build the graph with graphify update . (into graphify-out/) and query it before reading files.',
          )}
        </div>
      )}

      {s.id === 'omniroute' && s.enabled && (
        <>
          {s.omniroute && (
            <div className="ext-stats small">
              <span>
                {t('網址', 'URL')} <span className="mono">{s.omniroute.url}</span>
              </span>
              <span>{t(`已連接 ${s.omniroute.connections} 個供應商`, `${s.omniroute.connections} providers connected`)}</span>
              <span>{t(`agent 可用 ${s.omniroute.models} 個模型（免費 ${s.omniroute.free}）`, `${s.omniroute.models} models for agents (${s.omniroute.free} free)`)}</span>
            </div>
          )}
          {s.omniroute && (
            <div className="row gap wrap">
              <button className="btn small primary" onClick={() => hub.call('host.openExternal', { url: s.omniroute!.dashboardUrl })}>
                {t('開啟 OmniRoute 管理頁', 'Open the OmniRoute dashboard')}
              </button>
              <button
                className="btn small ghost"
                onClick={() =>
                  run(async () => {
                    await navigator.clipboard.writeText(await hub.call<string>('extensions.omniPassword'));
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  })
                }
              >
                {copied ? `✓ ${t('已複製', 'Copied')}` : t('複製管理密碼', 'Copy dashboard password')}
              </button>
              <button className="btn small ghost" disabled={busy} onClick={() => run(() => hub.call('extensions.refresh'))}>
                {t('重新讀取', 'Reload')}
              </button>
            </div>
          )}
          <div className="muted tiny">
            {s.omniroute && !s.omniroute.connections
              ? t('下一步：按「連接免費供應商」接上至少一家。OmniRoute 內建的免登入模型太短，跑不動 agent。', 'Next: press "Connect free providers" and connect at least one. OmniRoute’s built-in no-sign-in models are too short to run an agent.')
              : t('在「供應商」頁和角色設定可以選 OmniRoute 的模型；自動指派只會把它用在 sub agent 與壓縮。', 'Pick OmniRoute models on the Providers page and in role settings; automatic assignment only uses it for sub-agents and compaction.')}{' '}
            {t('只在這台電腦上執行（127.0.0.1），管理密碼是自動產生的亂數。', 'Runs on this computer only (127.0.0.1) with a generated dashboard password.')}
          </div>
          {s.omniroute && (
            <button className={cx('btn small', !s.omniroute.connections ? 'primary' : 'ghost')} onClick={() => setProviders(true)}>
              {t(`連接免費供應商…（已連接 ${s.omniroute.connections} 家）`, `Connect free providers… (${s.omniroute.connections} connected)`)}
            </button>
          )}
          {s.omniroute && providers && (
            <ExtWindow title={t(`${info.name}：連接免費供應商`, `${info.name}: connect free providers`)} onClose={() => setProviders(false)}>
              <OmniProviders s={s} />
            </ExtWindow>
          )}
        </>
      )}

      {s.enabled && s.state === 'error' && (s.id === 'graphify' || s.id === 'omniroute') && (
        <button className="btn small" disabled={busy} onClick={() => run(() => hub.call('extensions.retry', { id: s.id }))}>
          {t('重試', 'Retry')}
        </button>
      )}
      {error && <div className="note err">{error}</div>}
      {guide && <ExtensionGuide id={s.id} onClose={() => setGuide(false)} />}
      <div className="row gap">
        <button className="link tiny" onClick={() => hub.call('host.openExternal', { url: info.url })}>
          {t('來源', 'Source')}
        </button>
        <span className="muted tiny">{info.license}</span>
      </div>
    </div>
  );
}

/** An install in progress: a moving bar, how long it has run, and the last line the installer printed. */
function InstallProgress({ p }: { p: NonNullable<ExtensionStatus['progress']> }) {
  const t = useT();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const secs = p.since ? Math.max(0, Math.round((now - p.since) / 1000)) : 0;
  return (
    <div className="install-progress">
      <div className={cx('install-bar', p.percent !== undefined && 'known')}>
        <span style={p.percent !== undefined ? { width: `${p.percent}%` } : undefined} />
      </div>
      <div className="muted tiny">
        {p.percent !== undefined && <b className="install-pct">{t(`約 ${p.percent}%`, `about ${p.percent}%`)} · </b>}
        {t(`已進行 ${Math.floor(secs / 60)} 分 ${secs % 60} 秒`, `${Math.floor(secs / 60)}m ${secs % 60}s so far`)}
        {p.line ? ` · ${p.line}` : ''}
      </div>
    </div>
  );
}

function Extensions() {
  const t = useT();
  const list = useExtensions();
  if (!list.length) return null;
  return (
    <section className="cap">
      <div className="cap-head">
        <div>
          <h3>{t('內建擴充', 'Built-in extensions')}</h3>
          <p className="muted small">{t('隨 Aivenue 附上，預設全部關閉，打開就能用。Graphify 與 OmniRoute 第一次打開時會自動下載需要的工具。', 'Shipped with Aivenue and off by default; turn one on and it works. Graphify and OmniRoute download the tools they need the first time.')}</p>
        </div>
      </div>
      <div className="presets-grid ext-grid">
        {list.map((s) => (
          <ExtensionCard key={s.id} s={s} />
        ))}
      </div>
    </section>
  );
}

/**
 * The skills Aivenue ships and uses on its own when a task or the workflow's settings call for them. A description
 * only: no switch and no "enabled" state here (security-audit is turned on per workflow, in role settings).
 */
const BUILTIN_SKILLS: { name: string; use: [string, string]; when: [string, string] }[] = [
  {
    name: 'gh-fix-ci',
    use: ['診斷 GitHub CI 失敗。', 'Diagnoses failing GitHub CI.'],
    when: ['在工作流提供 GitHub PR 連結，並請 Aivenue 診斷失敗的檢查。', 'Give the workflow a GitHub PR link and ask Aivenue to diagnose the failing checks.'],
  },
  {
    name: 'gh-address-comments',
    use: ['整理 GitHub PR 審查留言。', 'Sorts out GitHub PR review comments.'],
    when: ['在工作流提供 GitHub PR 連結，並請 Aivenue 整理或處理審查意見。', 'Give the workflow a GitHub PR link and ask Aivenue to sort out or address the review comments.'],
  },
  {
    name: 'security-audit',
    use: ['檢查程式碼變更的安全風險。', 'Checks code changes for security risks.'],
    when: ['在該次工作流的角色設定開啟「安全檢查」，由程式碼審查者使用。', 'Turn on "Security check" in that workflow\'s role settings; the code reviewer uses it.'],
  },
];

/** Bundled third-party skills the user turns on one by one (PACK_SKILLS in packages/core/src/extensions.ts). */
const PACK_INFO: Record<PackSkillId, { title: string; use: [string, string]; when: [string, string]; url: string; license: string }> = {
  'architecture-review': {
    title: 'improve-codebase-architecture + codebase-design',
    use: ['架構檢視。由撰寫計畫的角色唯讀找出難改、難測的模組，提出重構方向和取捨。', 'Architecture review. The planner finds hard-to-change, hard-to-test modules read-only and proposes refactoring directions and trade-offs.'],
    when: ['適用於檢視架構的任務。只在回覆裡給報告，不改程式、不開瀏覽器。', 'For tasks that ask for an architecture review. The report comes in the reply; no code changes, no browser.'],
    url: 'https://github.com/mattpocock/skills',
    license: 'MIT',
  },
  'diagnosing-bugs': {
    title: 'diagnosing-bugs',
    use: ['深入除錯。先建立能重現的驗證，再逐一排除假設，適合偶發或跨平台問題。', 'Deep debugging. Builds a check that reproduces the bug first, then rules out hypotheses one by one; for intermittent or cross-platform problems.'],
    when: ['適用於除錯、偶發失敗或回歸問題。需要人協助時用 Aivenue 的提問，不執行等待終端機輸入的腳本。', 'For bugs, intermittent failures and regressions. When a person is needed it asks through Aivenue instead of a script that waits for terminal input.'],
    url: 'https://github.com/mattpocock/skills',
    license: 'MIT',
  },
  'gha-security-review': {
    title: 'gha-security-review',
    use: ['GitHub Actions 安全審查。專查 PR 輸入、憑證、權限，以及發布流程的信任邊界。', 'GitHub Actions security review: untrusted PR input, credentials, permissions and the trust boundaries of release workflows.'],
    when: ['適用於 GitHub Actions 的變更（.github/workflows、action.yml）。只做靜態審查，不執行參考資料或專案裡的任何指令。', 'For GitHub Actions changes (.github/workflows, action.yml). Static only: nothing quoted in its references or in the project is run.'],
    url: 'https://github.com/getsentry/skills',
    license: 'Apache-2.0',
  },
  'web-design-guidelines': {
    title: 'web-design-guidelines',
    use: ['網頁介面審查。找出表單、導覽、響應式版面和互動細節的具體問題，以 file:line 回報。', 'Web UI review: concrete problems in forms, navigation, responsive layout and interaction details, reported as file:line.'],
    when: ['適用於網頁介面的變更。規則固定在 web-interface-guidelines 的 434b7f9，不連網抓取最新版。', 'For web UI changes. The rules are pinned to web-interface-guidelines 434b7f9 and never fetched from the network.'],
    url: 'https://github.com/vercel-labs/web-interface-guidelines',
    license: 'MIT',
  },
};

/** Evaluated and not loaded: what Aivenue took from them, and why they are not skills you can turn on. */
const DESIGN_REFS: { name: string; text: [string, string] }[] = [
  {
    name: 'impeccable',
    text: [
      'App 介面設計參考。工作流時間線的評估採用它 critique 的評分方法；它需要自己的 CLI、偵測器、瀏覽器與專案設計檔，Aivenue 不載入也不執行。',
      'App UI design reference. The workflow timeline review uses its critique scoring method; it needs its own CLI, detector, browser and project design files, which Aivenue neither loads nor runs.',
    ],
  },
  {
    name: 'frontend-testing-debugging',
    text: [
      '介面實測參考。它依賴 Codex 的 Browser 外掛，上游也沒有授權檔；請改用 Agent Skills 的 browser-testing-with-devtools，搭配上方的 Playwright 或 Chrome DevTools。',
      "UI testing reference. It relies on Codex's Browser plugin and its repository has no LICENSE file; use Agent Skills' browser-testing-with-devtools with Playwright or Chrome DevTools above instead.",
    ],
  },
  {
    name: 'accessibility-inspect',
    text: [
      '無障礙檢查參考。它缺少依賴的檔案與 MCP 伺服器、會要求安裝工具，上游也沒有授權檔；目前由 web-design-guidelines 的無障礙規則做靜態檢查。',
      'Accessibility reference. It is missing files and an MCP server it depends on, asks to install tools, and its repository has no LICENSE file; web-design-guidelines covers the static accessibility rules for now.',
    ],
  },
];

function PackSkills() {
  const t = useT();
  const list = usePackSkills();
  const { error, busy, run } = useBusy();
  if (!list.length) return null;
  return (
    <section className="cap">
      <div className="cap-head">
        <div>
          <h3>{t('可開關的內建 Skill', 'Built-in skills you can turn on')}</h3>
          <p className="muted small">
            {t(
              '隨 Aivenue 提供，預設全部關閉。開啟後就提供給列出的角色：每次都出現在它們的技能清單，由 agent 依任務決定要不要讀；Aivenue 不會先檢查變更的檔案才提供。不會自己安裝工具或連網。',
              'Shipped with Aivenue and off by default. When one is on it is offered to the roles listed: it is in their skills index every time and the agent decides from the task whether to read it; Aivenue does not check the changed files first. None installs tools or goes online.',
            )}
          </p>
        </div>
      </div>
      <div className="clist builtin-skills">
        {list.map((s) => {
          const info = PACK_INFO[s.id];
          return (
            <div key={s.id} className="crow">
              <div className="crow-head">
                <label className="switch">
                  <input type="checkbox" checked={s.enabled} disabled={busy || !s.available} aria-label={info.title} onChange={(e) => run(() => hub.call('extensions.setPackSkill', { id: s.id, on: e.target.checked }))} />
                  <span />
                </label>
                <div className="grow min0">
                  <div className="crow-name mono">{info.title}</div>
                </div>
              </div>
              <div className="small">{t(...info.use)}</div>
              <div className="muted small">
                {t('適用情境：', 'Best for: ')}
                {t(...info.when)}
              </div>
              <div className="row gap wrap">
                <span className="muted tiny">{t('開啟後提供給：', 'Offered to: ')}</span>
                {s.roles.map((r) => (
                  <span key={r} className="tag">
                    {roleName(t, r)}
                  </span>
                ))}
                <button className="link tiny" onClick={() => hub.call('host.openExternal', { url: info.url })}>
                  {t('來源', 'Source')}
                </button>
                <span className="muted tiny">{info.license}</span>
                {!s.available && <span className="muted tiny">{t('這個版本沒有附上', 'Not shipped in this build')}</span>}
              </div>
            </div>
          );
        })}
      </div>
      {error && <div className="note err">{error}</div>}
      <div className="block-label">{t('設計參考（不會載入）', 'Design references (not loaded)')}</div>
      <div className="clist builtin-skills">
        {DESIGN_REFS.map((d) => (
          <div key={d.name} className="crow">
            <div className="crow-name mono">{d.name}</div>
            <div className="muted small">{t(...d.text)}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

function BuiltinSkills() {
  const t = useT();
  return (
    <section className="cap">
      <div className="cap-head">
        <div>
          <h3>{t('按需使用的內建 Skill', 'Built-in skills used on demand')}</h3>
          <p className="muted small">{t('這些 Skill 隨 Aivenue 提供，會依任務或該次工作流的設定使用。', 'These skills ship with Aivenue and are used according to the task or that workflow\'s settings.')}</p>
        </div>
      </div>
      <div className="clist builtin-skills">
        {BUILTIN_SKILLS.map((s) => (
          <div key={s.name} className="crow">
            <div className="crow-name mono">{s.name}</div>
            <div className="small">{t(...s.use)}</div>
            <div className="muted small">
              {t('觸發方式：', 'How it is used: ')}
              {t(...s.when)}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export function CapabilitiesPane() {
  const t = useT();
  return (
    <div className="pane">
      <div className="pane-head">
        <div>
          <h2>{t('能力', 'Capabilities')}</h2>
          <p className="muted">{t('所有供應商、所有角色共用的工具、技能與指示。', 'Tools, skills and instructions shared by every provider and role.')}</p>
        </div>
      </div>
      <GithubCard />
      <Extensions />
      <BuiltinSkills />
      <PackSkills />
      <Instructions />
      <McpServers />
      <Skills />
    </div>
  );
}
