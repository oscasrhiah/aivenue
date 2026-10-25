import { useEffect, useState } from 'react';
import type { ConfigValue, ExtensionId, ExtensionStatus, InstructionRole, McpServerConfig, PonytailLevel, SkillInfo } from '../../../core/src/types';
import { hub, useCapabilities, useExtensions, useHostInfo, useProviders } from '../api';
import { useT, type T } from '../i18n';
import { cx, providerColor } from '../util';
import { GithubCard } from '../components/GithubCard';
import { ExtensionGuide } from '../components/ExtensionGuide';

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
          <button className="icon-btn" title={t('刪除', 'Delete')} onClick={() => confirm(t(`刪除 ${s.id}？`, `Delete ${s.id}?`)) && hub.call('capabilities.deleteServer', { id: s.id })}>
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

function SkillRow({ s }: { s: SkillInfo }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const roles = s.roles ?? [];
  const toggleRole = (r: InstructionRole) => {
    const next = roles.includes(r) ? roles.filter((x) => x !== r) : [...roles, r];
    void hub.call('skills.set', { name: s.name, roles: next });
  };
  return (
    <div className="crow">
      <div className="crow-head">
        <label className="switch">
          <input type="checkbox" checked={s.enabled} onChange={(e) => hub.call('skills.set', { name: s.name, enabled: e.target.checked })} />
          <span />
        </label>
        <div className="grow min0">
          <div className="crow-name">
            {s.name} {s.files > 1 && <span className="tag">{t(`${s.files} 個檔案`, `${s.files} files`)}</span>}
          </div>
          <div className="muted small">{s.description || t('（沒有 description）', '(no description)')}</div>
        </div>
        <div className="row gap">
          <button className="btn small ghost" onClick={() => setEditing(true)}>
            {t('編輯', 'Edit')}
          </button>
          <button className="btn small ghost" onClick={() => hub.call('skills.openFolder', { name: s.name })}>
            {t('資料夾', 'Folder')}
          </button>
          <button className="icon-btn" title={t('刪除', 'Delete')} onClick={() => confirm(t(`刪除 skill「${s.name}」與其檔案？`, `Delete skill "${s.name}" and its files?`)) && hub.call('skills.delete', { name: s.name })}>
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
    </div>
  );
}

function Skills() {
  const t = useT();
  const host = useHostInfo();
  const { skills } = useCapabilities();
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
      {adding && <SkillEditor onClose={() => setAdding(false)} />}
    </section>
  );
}

// ---------------- built-in extensions ----------------

const EXT_INFO: Record<ExtensionId, { icon: string; name: string; zh: string; en: string; url: string; license: string }> = {
  ponytail: {
    icon: '🪮',
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

function ExtensionCard({ s }: { s: ExtensionStatus }) {
  const t = useT();
  const info = EXT_INFO[s.id];
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [guide, setGuide] = useState(false);
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
          <button className="link tiny" onClick={() => setOpen(!open)}>
            {t(`已開啟 ${on} / ${skills.length} 個技能`, `${on} of ${skills.length} skills on`)} {open ? '▴' : '▾'}
          </button>
          {open && (
            <div className="ext-skills">
              {skills.map((k) => (
                <label key={k.name} className="ext-skill" title={k.description}>
                  <input type="checkbox" checked={k.enabled} onChange={(e) => run(() => hub.call('extensions.setOptions', { id: 'agent-skills', skill: k.name, on: e.target.checked }))} />
                  <span className="mono small">{k.name}</span>
                  {k.interactive && <span className="tag">{t('需要問答', 'asks questions')}</span>}
                  <span className="muted tiny ext-skill-roles">{k.roles.map((r) => ROLE_SHORT(t, r)).join('、')}</span>
                </label>
              ))}
            </div>
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
              ? t('下一步：在管理頁用你自己的帳號連接免費供應商（例如 Gemini、Groq、OpenRouter）。連好後按「重新讀取」，供應商清單就會出現 OmniRoute。', 'Next: connect free providers (e.g. Gemini, Groq, OpenRouter) with your own accounts in the dashboard, then press Reload; OmniRoute then shows up as a provider.')
              : t('在「供應商」頁和角色設定可以選 OmniRoute 的模型；自動指派只會把它用在 sub agent 與壓縮。', 'Pick OmniRoute models on the Providers page and in role settings; automatic assignment only uses it for sub-agents and compaction.')}{' '}
            {t('只在這台電腦上執行（127.0.0.1），管理密碼是自動產生的亂數。注意：部分免費供應商會記錄你送出的內容，私人或公司的程式碼請小心。', 'Runs on this computer only (127.0.0.1) with a generated dashboard password. Some free providers log what you send: be careful with private or company code.')}
          </div>
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
      <Instructions />
      <McpServers />
      <Skills />
    </div>
  );
}
