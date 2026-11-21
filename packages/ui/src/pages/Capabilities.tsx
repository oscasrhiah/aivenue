import { useEffect, useState, type ReactNode } from 'react';
import { CircleCheck, CircleDashed, CircleX, ExternalLink, FolderOpen, Info, LoaderCircle, Lock, LockOpen, Pencil, PlugZap, Plus, Square, SquareCheck, Trash2, TriangleAlert, X } from 'lucide-react';
import { Ico } from '../icons';
import type { ConfigValue, ExtensionId, ExtensionStatus, InstructionRole, McpServerConfig, PackSkillId, PonytailLevel, ProjectSkillInfo, SkillInfo, SkillReview } from '../../../core/src/types';
import { hub, useCapabilities, useExtensions, useGithub, useHostInfo, usePackSkills, useProviders } from '../api';
import { useT, type T } from '../i18n';
import { cx, providerColor } from '../util';
import { GithubCard } from '../components/GithubCard';
import { ExtensionGuide } from '../components/ExtensionGuide';
import { OmniProviders, OpenRouterAuth } from '../components/OmniProviders';
import { ask } from '../components/Ask';
import { Dialog, Hint, Seg, ShowAll, StateWord, Switch } from '../components/Kit';
import { capabilityCounts, overviewParts } from '../settingsView';

const ROLES: InstructionRole[] = ['all', 'planner', 'plan_reviewer', 'executor', 'code_reviewer', 'subagent'];

const roleName = (t: T, r: InstructionRole) =>
  ({
    all: t('所有角色', 'All roles'),
    planner: t('撰寫計畫', 'Planner'),
    plan_reviewer: t('審查計畫', 'Plan reviewer'),
    executor: t('實作', 'Implementer'),
    code_reviewer: t('審查程式碼', 'Code reviewer'),
    subagent: t('子 agent', 'Sub-agent'),
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
          <Hint
            className="cap-desc"
            text={t(
              '加在每個 agent 的系統提示詞後面，「所有角色」會套用到每一個角色。Claude Code、Qwen 使用 --append-system-prompt，其他 CLI 會放在任務指示最前面。',
              'Appended to each agent\'s system prompt; "All roles" applies to every role. Claude Code and Qwen use --append-system-prompt; other CLIs get it at the top of the task.',
            )}
          />
        </div>
      </div>
      {/* Which role's instructions the box below shows: a radio group (the arrows move between roles, as in segments). */}
      <Seg
        className="tabs-mini"
        label={t('看哪個角色的指示', "Which role's instructions")}
        value={role}
        onChange={setRole}
        choices={ROLES.map((r) => ({
          value: r,
          label: (
            <>
              {roleName(t, r)}
              {draft[r]?.trim() ? (
                <>
                  <span className="has" aria-hidden="true" />
                  <span className="sr-only">{t('，已填', ', filled in')}</span>
                </>
              ) : null}
            </>
          ),
        }))}
      />
      <textarea
        aria-label={t(`${roleName(t, role)}的指示`, `Instructions for ${roleName(t, role)}`)}
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
        {saved && !dirty && (
          <StateWord icon={CircleCheck} tone="ok" className="small">
            {t('已儲存', 'Saved')}
          </StateWord>
        )}
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
            placeholder={r.gh ? t('使用 GitHub 登入，啟動 agent 時自動帶入', 'GitHub sign-in, filled in when an agent starts') : r.secret && r.stored ? t('已加密保存，輸入即取代', 'Stored encrypted, type to replace') : t('值', 'value')}
            value={r.value}
            onChange={(e) => set(i, { value: e.target.value })}
            autoComplete="off"
          />
          <button
            type="button"
            className={cx('icon-btn', r.secret && 'on')}
            title={t('加密保存：用於金鑰、Token', 'Store encrypted: for keys and tokens')}
            aria-label={t(`加密保存 ${r.key || keyLabel}`, `Store ${r.key || keyLabel} encrypted`)}
            aria-pressed={r.secret}
            onClick={() => set(i, { secret: !r.secret, stored: false })}
          >
            <Ico i={r.secret ? Lock : LockOpen} size={16} />
          </button>
          <button type="button" className="icon-btn" aria-label={t(`移除 ${r.key || keyLabel} 這一列`, `Remove the ${r.key || keyLabel} row`)} title={t('移除這一列', 'Remove this row')} onClick={() => onChange(rows.filter((_, j) => j !== i))}>
            <Ico i={X} size={16} />
          </button>
        </div>
      ))}
      <button type="button" className="link link-icon" onClick={() => onChange([...rows, { key: '', value: '', secret: false, stored: false }])}>
        <Ico i={Plus} size={14} /> {t('新增', 'Add')}
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
    <Dialog
      title={isNew ? t('新增 MCP 伺服器', 'Add MCP server') : s.id}
      onClose={onClose}
      keepOpen
      foot={
        <>
          <button className="btn" onClick={onClose}>
            {t('取消', 'Cancel')}
          </button>
          <button className="btn primary" disabled={busy} onClick={save}>
            {t('儲存', 'Save')}
          </button>
        </>
      }
    >
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
          <Seg
            label={t('類型', 'Type')}
            value={s.transport}
            onChange={(transport) => setS({ ...s, transport })}
            choices={[
              { value: 'stdio', label: t('stdio 本機指令', 'stdio, local command') },
              { value: 'http', label: 'HTTP' },
            ]}
          />
        </div>
        {s.transport === 'stdio' ? (
          <>
            <div className="kv">
              <label>{t('指令', 'Command')}</label>
              <input className="mono" value={s.command ?? ''} onChange={(e) => setS({ ...s, command: e.target.value })} placeholder="npx" />
            </div>
            <div className="kv top">
              <label>{t('參數，每行一個', 'Args, one per line')}</label>
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
    </Dialog>
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
    <Dialog
      title={t('從 JSON 匯入', 'Import from JSON')}
      onClose={onClose}
      keepOpen
      foot={
        <>
          <button className="btn" onClick={onClose}>
            {t('取消', 'Cancel')}
          </button>
          <button className="btn primary" disabled={busy || !text.trim()} onClick={doImport}>
            {t('匯入', 'Import')}
          </button>
        </>
      }
    >
        <p className="muted small">
          {t('貼上 Claude Code／Cursor／Gemini 常見的 mcpServers 設定。匯入後環境變數是明文保存，含金鑰的欄位建議再編輯，改成「加密保存」。', 'Paste an mcpServers block as used by Claude Code / Cursor / Gemini. Imported env values are stored in plain text; edit them afterwards and set secrets to Store encrypted.')}
        </p>
        <textarea className="code" aria-label="JSON" rows={14} value={text} onChange={(e) => setText(e.target.value)} placeholder={'{\n  "mcpServers": {\n    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }\n  }\n}'} />
        {error && <div className="note err">{error}</div>}
    </Dialog>
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
        <div className="grow min0">
          <div className="crow-name">
            {s.id} <span className="tag">{s.transport}</span>
          </div>
          <div className="muted small mono ellipsis" title={target}>
            {s.description || target}
          </div>
          <div className="muted tiny">{s.providers?.length ? s.providers.map((id) => providers.find((p) => p.spec.id === id)?.spec.name ?? id).join(', ') : t('全部供應商', 'All providers')}</div>
        </div>
        <div className="row gap crow-actions">
          <button className="btn small ghost link-icon" disabled={probe?.busy} onClick={test}>
            <Ico i={PlugZap} size={14} /> {probe?.busy ? t('測試中…', 'Testing…') : t('測試', 'Test')}
          </button>
          <button className="btn small ghost link-icon" onClick={() => setEditing(true)}>
            <Ico i={Pencil} size={14} /> {t('編輯', 'Edit')}
          </button>
          <button className="icon-btn" title={t(`刪除 ${s.id}`, `Delete ${s.id}`)} aria-label={t(`刪除 ${s.id}`, `Delete ${s.id}`)} onClick={async () => (await ask(t(`刪除 ${s.id}？`, `Delete ${s.id}?`), { danger: true })) && hub.call('capabilities.deleteServer', { id: s.id })}>
            <Ico i={Trash2} size={16} />
          </button>
          <Switch label={s.id} checked={s.enabled} onChange={(on) => void hub.call('capabilities.saveServer', { server: { ...s, enabled: on } })} />
        </div>
      </div>
      {probe?.error && <div className="note err">{probe.error}</div>}
      {probe?.tools && (
        <div className="note">
          <StateWord icon={CircleCheck} tone="ok">
            {t(`連線成功，${probe.tools.length} 個工具：`, `Connected, ${probe.tools.length} tools: `)}
          </StateWord>{' '}
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
    <>
      <div className="muted tiny preset-note">
        {t(
          '使用獨立、用完即丟的瀏覽器設定檔，不會用到你平常登入帳號的瀏覽器。第一次使用時會自動下載工具，需要 Node.js。',
          'Uses a separate throwaway browser profile, never your everyday browser with your logins. The tool downloads on first use and needs Node.js.',
        )}
      </div>
      <div className="clist presets-list">
        {presets.map((p) => {
          const existing = servers.find((s) => s.id === p.id);
          return (
            <div key={p.id} className="crow preset-row">
              <div className="crow-head">
                <div className="grow min0">
                  <div className="crow-name">{p.name}</div>
                  <div className="muted small">{t(p.zh, p.en)}</div>
                  {existing ? (
                    <div className="muted tiny">{t('在下方清單可停用、測試或移除。', 'Turn off, test or remove it in the list below.')}</div>
                  ) : (
                    <label className="check small">
                      <input type="checkbox" checked={!!headed[p.id]} onChange={(e) => setHeaded({ ...headed, [p.id]: e.target.checked })} />
                      {t('顯示瀏覽器視窗，看 agent 操作', 'Show the browser window to watch the agent')}
                    </label>
                  )}
                </div>
                <div className="row gap crow-actions">
                  <button className="link link-icon tiny" onClick={() => hub.call('host.openExternal', { url: p.docsUrl })}>
                    <Ico i={ExternalLink} size={14} /> {t('文件', 'Docs')}
                  </button>
                  {existing ? (
                    <StateWord icon={existing.enabled ? CircleCheck : CircleDashed} tone={existing.enabled ? 'ok' : undefined}>
                      {existing.enabled ? t('已啟用', 'On') : t('已停用', 'Off')}
                    </StateWord>
                  ) : (
                    <button className="btn small" disabled={busy} onClick={() => run(() => hub.call('capabilities.addPreset', { id: p.id, headed: !!headed[p.id] }))}>
                      {t('一鍵啟用', 'Enable')}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      {error && <div className="note err">{error}</div>}
    </>
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
          <Hint
            className="cap-desc"
            text={t(
              '設定一次，執行時自動提供給所選供應商的每一個 agent，不必在 Claude、Codex、Antigravity 各設定一次。各 CLI 自己原本設定的 MCP 仍然有效。',
              "Configure once; every agent of the selected providers gets these servers at run time, so you no longer configure Claude, Codex and Antigravity separately. Each CLI's own MCP settings still apply.",
            )}
          />
        </div>
        <div className="row gap">
          <button className="btn ghost" onClick={() => setImporting(true)}>
            {t('從 JSON 匯入', 'Import JSON')}
          </button>
          <button className="btn" onClick={() => setAdding(true)}>
            {t('新增', 'Add')}
          </button>
        </div>
      </div>
      <div className="block-label">{t('瀏覽器工具', 'Browser tools')}</div>
      <BrowserPresets servers={config.mcpServers} />
      <div className="block-label">{t('已設定的伺服器', 'Configured servers')}</div>
      <div className="clist">
        {config.mcpServers.length === 0 && <div className="empty-row muted small">{t('尚未設定共用 MCP 伺服器', 'No shared MCP servers yet')}</div>}
        <ShowAll list={config.mcpServers}>
          {(shown) => shown.map((s) => <ServerRow key={s.id} s={s} />)}
        </ShowAll>
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
    <Dialog
      title={name ? name : t('新增 Skill', 'New skill')}
      onClose={onClose}
      size="lg"
      keepOpen
      foot={
        <>
          <button className="btn" onClick={onClose}>
            {t('取消', 'Cancel')}
          </button>
          <button className="btn primary" disabled={busy || !skillName.trim()} onClick={() => run(() => hub.call('skills.save', { name: skillName.trim(), content })).then((ok) => ok && onClose())}>
            {t('儲存', 'Save')}
          </button>
        </>
      }
    >
        {!name && (
          <div className="kv">
            <label>{t('資料夾名稱', 'Folder name')}</label>
            <input className="mono" value={skillName} onChange={(e) => setSkillName(e.target.value)} placeholder="code-style" />
          </div>
        )}
        <textarea className="code" aria-label="SKILL.md" rows={20} value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} />
        {error && <div className="note err">{error}</div>}
    </Dialog>
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
          ? t('靜態掃描：沒有發現需要注意的內容，但不保證安全', 'Static scan: nothing to look at found, which does not guarantee safety')
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
          : t('待確認：還沒確認過這一版，暫停載入。開啟開關，看過掃描結果後確認，才會提供給 agent', 'Waiting for approval: not loaded until you turn it on and approve this version after looking at the scan')
  return (
    <div className={cx('skill-review', r.state)}>
      <StateWord icon={r.state === 'approved' ? CircleCheck : r.state === 'failed' ? CircleX : TriangleAlert} tone={r.state === 'approved' ? 'ok' : r.state === 'failed' ? 'err' : 'warn'} className="small skill-state">
        {state}
      </StateWord>
      <div className="muted tiny">{scan}</div>
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
    <Dialog
      title={t(`啟用前確認：${title}`, `Before turning it on: ${title}`)}
      onClose={onClose}
      foot={
        <>
          <button className="btn ghost" onClick={onClose}>
            {t('取消', 'Cancel')}
          </button>
          <button className="btn primary" disabled={failed || (n > 0 && !seen)} onClick={approve}>
            {t('啟用這一版', 'Turn this version on')}
          </button>
        </>
      }
    >
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
    </Dialog>
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
        <div className="grow min0">
          <div className="crow-name">
            {s.name} {s.files > 1 && <span className="tag">{t(`${s.files} 個檔案`, `${s.files} files`)}</span>}
          </div>
          <div className="muted small">{s.description || t('沒有 description', 'No description')}</div>
          <ReviewState r={s.review} />
        </div>
        <div className="row gap crow-actions">
          <button className="btn small ghost link-icon" onClick={() => setEditing(true)}>
            <Ico i={Pencil} size={14} /> {t('編輯', 'Edit')}
          </button>
          <button className="btn small ghost link-icon" onClick={() => hub.call('skills.openFolder', { name: s.name })}>
            <Ico i={FolderOpen} size={14} /> {t('資料夾', 'Folder')}
          </button>
          <button className="icon-btn" title={t(`刪除 ${s.name}`, `Delete ${s.name}`)} aria-label={t(`刪除 ${s.name}`, `Delete ${s.name}`)} onClick={async () => (await ask(t(`刪除 skill「${s.name}」與其檔案？`, `Delete skill "${s.name}" and its files?`), { danger: true })) && hub.call('skills.delete', { name: s.name })}>
            <Ico i={Trash2} size={16} />
          </button>
          <Switch label={s.name} checked={loaded} onChange={(on) => void toggle(on)} />
        </div>
      </div>
      <div className="row gap wrap role-filter" role="group" aria-label={t(`${s.name} 提供給哪些角色`, `Roles ${s.name} is offered to`)}>
        <span className="muted tiny">{t('提供給：', 'For: ')}</span>
        {ROLES.filter((r) => r !== 'all').map((r) => {
          const on = roles.length === 0 || roles.includes(r);
          return (
            <button key={r} type="button" aria-pressed={on} className={cx('role-check', on && 'on')} onClick={() => toggleRole(r)}>
              <Ico i={on ? SquareCheck : Square} size={14} />
              {roleName(t, r)}
            </button>
          );
        })}
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
        <div className="grow min0">
          <div className="crow-name">{s.name}</div>
          <div className="muted small">{s.description || t('沒有 description', 'No description')}</div>
          <div className="muted tiny mono break">{s.dir}</div>
          <ReviewState r={s.review} />
        </div>
        <div className="row gap crow-actions">
          <Switch label={s.name} checked={loaded} onChange={(on) => void (on ? setApproving(true) : hub.call('skills.disableProject', { dir: s.dir }))} />
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
          <h3>{t('共用 Skill', 'Shared skills')}</h3>
          <Hint
            className="cap-desc"
            text={t(
              '每個 agent 都會收到 Skill 清單，需要時自己讀取 SKILL.md，任何能讀檔的 CLI 都能使用。格式是 Agent Skills：一個資料夾加一份 SKILL.md，清單裡是名稱與說明。匯入或手動放進資料夾的 Skill 會先暫停載入：Aivenue 在本機做靜態掃描，不連網、不呼叫模型，你看過結果、確認這一版後才會提供給 agent；確認後檔案有變動，會再暫停。用「新增」或「編輯」在這裡寫的 skill 不受影響。',
              'Every agent gets the list of skills and reads SKILL.md when relevant, so any CLI that can read files can use them. The format is Agent Skills: a folder with SKILL.md; the list holds names and descriptions. Skills you import or put into the folder yourself are not loaded at first: Aivenue scans them locally, with no network and no model, and offers one to agents only after you looked at the result and approved that version; a later change to its files stops it again. Skills written here with Add or Edit are not affected.',
            )}
          />
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
          <button className="btn" onClick={() => setAdding(true)}>
            {t('新增', 'Add')}
          </button>
        </div>
      </div>
      {error && <div className="note err">{error}</div>}
      <div className="clist">
        {skills.length === 0 && <div className="empty-row muted small">{t('尚未加入 Skill。可以從 Claude Code 的 ~/.claude/skills 匯入現有的 Skill 資料夾。', 'No skills yet. You can import existing skill folders, e.g. from ~/.claude/skills.')}</div>}
        <ShowAll list={skills}>{(shown) => shown.map((s) => <SkillRow key={s.name} s={s} />)}</ShowAll>
      </div>
      {projectSkills.length > 0 && (
        <>
          <h4 className="cap-sub">{t('工作資料夾裡的專案 Skill', 'Project skills in working folders')}</h4>
          <Hint
            className="cap-desc"
            text={t(
              'Aivenue 在工作資料夾的 .aivenue/skills 找到這些 Skill，確認這一版之前不會提供給 agent。檔案留在原處；Aivenue 自己整理出的專案規則不受影響。',
              'Aivenue found these in the .aivenue/skills of working folders; they are not offered to agents until you approve this version. Their files stay where they are; project rules Aivenue distilled itself are not affected.',
            )}
          />
          <div className="clist">
            <ShowAll list={projectSkills}>{(shown) => shown.map((s) => <ProjectSkillRow key={s.dir} s={s} />)}</ShowAll>
          </div>
        </>
      )}
      {adding && <SkillEditor onClose={() => setAdding(false)} />}
    </section>
  );
}

// ---------------- built-in extensions ----------------

/** The built-in extensions: no icon of their own (the name says it), a one-line tagline, where they come from. */
const EXT_INFO: Record<ExtensionId, { name: string; zh: string; en: string; url: string; license: string }> = {
  ponytail: {
    name: 'Ponytail',
    zh: '「最懶的資深工程師」：用最少、最直接的改動完整解決問題，不過度設計、不加沒人要的功能。',
    en: '"The laziest senior dev in the room": the smallest change that fully solves the task, no over-engineering, no features nobody asked for.',
    url: 'https://github.com/DietrichGebert/ponytail',
    license: 'MIT',
  },
  'agent-skills': {
    name: 'Agent Skills',
    zh: 'Addy Osmani 的 26 個工程 Skill：規格、計畫拆解、TDD、除錯、程式碼審查、無障礙、安全、效能等，依角色提供。',
    en: "Addy Osmani's 26 engineering skills: specs, task breakdown, TDD, debugging, code review, accessibility, security, performance and more, per role.",
    url: 'https://github.com/addyosmani/agent-skills',
    license: 'MIT',
  },
  graphify: {
    name: 'Graphify',
    zh: '把專案整理成知識圖譜，agent 先查圖再讀檔，少翻很多檔案。程式碼在本機解析，不呼叫 API。',
    en: 'Turns the project into a knowledge graph; agents query the graph before reading files. Code is parsed locally, no API calls.',
    url: 'https://github.com/Graphify-Labs/graphify',
    license: 'Apache-2.0',
  },
  codegraph: {
    name: 'CodeGraph',
    zh: '在專案裡建立程式碼索引：哪個函式呼叫誰、改一個地方會影響哪裡。agent 用它查精確的程式碼關係，不用整個專案 grep。在本機解析，不呼叫 API。',
    en: 'Builds a code index of the project: which function calls which, and what a change affects. Agents use it for exact code relations instead of grepping the whole project. Parsed locally, no API calls.',
    url: 'https://github.com/colbymchenry/codegraph',
    license: 'MIT',
  },
  impeccable: {
    name: 'impeccable',
    zh: '前端設計 Skill：版面、字體、色彩、互動、文案與無障礙的審查和修改，附一個掃描設計問題的引擎。交給實作者和程式碼審查者，只用在介面的工作。',
    en: 'A frontend design skill: reviewing and fixing layout, type, color, interaction, copy and accessibility, with an engine that scans for design problems. Offered to the implementer and the code reviewer, for interface work only.',
    url: 'https://github.com/pbakaus/impeccable',
    license: 'Apache-2.0',
  },
  omniroute: {
    name: 'OmniRoute',
    zh: '本機 AI 閘道，接上數百家供應商；auto/best-free 會自動挑選現在能用的免費模型，額度用完就換下一家。開啟後還沒接上 OpenRouter 的話，會在瀏覽器開啟它的授權頁。',
    en: 'A local AI gateway to hundreds of providers; auto/best-free picks a free model that works right now and moves on when one runs out. Once on, it opens OpenRouter’s authorization page in your browser if OpenRouter is not connected yet.',
    url: 'https://github.com/diegosouzapw/OmniRoute',
    license: 'MIT',
  },
};

const ROLE_SHORT = (t: T, r: InstructionRole) => roleName(t, r);

/**
 * A window for an extension's longer controls (Agent Skills' skill list, OmniRoute's providers), so its row stays
 * short. The keyboard is the dialog's: the focus moves in, Tab stays inside, Esc closes it and the focus goes back.
 */
function ExtWindow({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <Dialog title={title} onClose={onClose} size="lg" className="ext-window" focus="first">
      {children}
    </Dialog>
  );
}

/**
 * One built-in extension as a row: its name, version and state (an icon and a word), the switch at the end, 說明 for
 * what it is; under it the tagline, and once it is on, its own options. Where it comes from and its license close it.
 */
function ExtensionCard({ s }: { s: ExtensionStatus }) {
  const t = useT();
  const info = EXT_INFO[s.id];
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [guide, setGuide] = useState(false);
  const [providers, setProviders] = useState(false);
  const { error, busy, run } = useBusy();
  const state =
    s.state === 'ready' ? (
      <StateWord icon={CircleCheck} tone="ok" className="small">
        {t('可以使用', 'Ready')}
      </StateWord>
    ) : s.state === 'working' ? (
      <StateWord icon={LoaderCircle} tone="run" spin className="small">
        {t('處理中…', 'Working…')}
      </StateWord>
    ) : s.state === 'error' ? (
      <StateWord icon={TriangleAlert} tone="warn" className="small">
        {t('需要處理', 'Needs attention')}
      </StateWord>
    ) : null;
  const skills = s.skills ?? [];
  const on = skills.filter((k) => k.enabled).length;
  return (
    <div className={cx('crow ext-card', s.enabled && s.state === 'ready' && 'on')}>
      <div className="ext-head">
        <b>{info.name}</b>
        {s.version && <span className="tag">v{s.version}</span>}
        {state}
        <span className="grow" />
        <button className="btn small ghost ext-guide-btn link-icon" onClick={() => setGuide(true)} title={t('這是什麼、包含哪些 Skill', 'What it is and what it includes')} aria-label={t(`${info.name} 說明`, `About ${info.name}`)}>
          <Ico i={Info} size={14} /> {t('說明', 'About')}
        </button>
        <Switch label={info.name} checked={s.enabled} disabled={busy} onChange={(v) => void run(() => hub.call('extensions.setEnabled', { id: s.id, enabled: v }))} />
      </div>
      <div className="muted small">{t(info.zh, info.en)}</div>
      {s.enabled && s.message && <div className={cx('note', s.state === 'error' && 'err')}>{s.message}</div>}
      {s.enabled && s.state === 'working' && s.progress && <InstallProgress p={s.progress} />}

      {s.id === 'ponytail' && s.enabled && (
        <>
          <div className="row gap wrap">
            <span className="muted tiny">{t('強度', 'Level')}</span>
            <Seg
              manual
              className="small"
              label={t('Ponytail 強度', 'Ponytail level')}
              value={s.level}
              onChange={(l) => void run(() => hub.call('extensions.setOptions', { id: 'ponytail', level: l }))}
              choices={(['lite', 'full', 'ultra'] as PonytailLevel[]).map((l) => ({ value: l, label: l }))}
            />
          </div>
          <div className="muted tiny">
            {s.level === 'lite'
              ? t('lite：照要求做，只用一句話提出更小的做法。', 'lite: build what was asked; name the smaller option in one line.')
              : s.level === 'ultra'
                ? t('ultra：動手前先質疑需求裡沒必要的部分。', 'ultra: also pushes back on parts of the request the need does not justify.')
                : t('full 是預設：最小但完整的改動。', 'full, the default: the smallest complete change.')}{' '}
            {t('撰寫計畫、審查計畫、實作與子 agent 一直套用主 Skill，審查程式碼套用 ponytail-review。', 'Planner, plan reviewer, implementer and sub-agents always follow the main skill; the code reviewer follows ponytail-review.')}
          </div>
        </>
      )}

      {s.id === 'agent-skills' && s.enabled && (
        <>
          <div className="row gap wrap">
            <span className="small">{t(`已開啟 ${on} / ${skills.length} 個 Skill`, `${on} of ${skills.length} skills on`)}</span>
            <button className="btn small ghost" onClick={() => setOpen(true)}>
              {t('選擇 Skill…', 'Choose skills…')}
            </button>
          </div>
          {open && (
            <ExtWindow title={t(`${info.name}：選擇 Skill，已開啟 ${on} / ${skills.length}`, `${info.name}: choose skills, ${on} of ${skills.length} on`)} onClose={() => setOpen(false)}>
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
          <div className="muted tiny">{t('agent 只會看到 Skill 名稱與一句說明，用到才讀全文，幾乎不增加 token。', "Agents only see each skill's name and one-line description and read the rest when needed, so it costs almost no tokens.")}</div>
          <div className="muted tiny">{t('accessibility-engineering 會叫 agent 用 npx 執行 axe 和 pa11y 檢查網頁：用到時會從 npm 下載這兩個工具，和 agent 執行的其他指令一樣，受這次工作流的權限限制，Aivenue 不會先安裝。', 'accessibility-engineering has agents run axe and pa11y with npx to check a page: when used, those tools are downloaded from npm, like any other command an agent runs and under the run’s permission; Aivenue installs nothing beforehand.')}</div>
        </>
      )}

      {s.id === 'graphify' && s.enabled && (
        <Hint
          className="muted tiny"
          text={t(
            '第一次開啟會自動安裝 uv 與 graphify，uv 會自己帶 Python，不需要另外安裝。每個工作流開始前，Aivenue 會在工作資料夾執行 graphify update 更新圖譜，寫到 graphify-out/，agent 改檔後也會在背景更新；agent 先查圖再讀檔。對話標題列的「圖譜」按鈕可以看整張圖。',
            "The first time it installs uv and graphify; uv brings its own Python. Before each workflow Aivenue runs graphify update in the working folder, writing graphify-out/, and updates it in the background after agents change files; agents query the graph before reading files. The Graph button in a chat's header shows the whole graph.",
          )}
        />
      )}

      {s.id === 'codegraph' && s.enabled && (
        <Hint
          className="muted tiny"
          text={t(
            '第一次開啟會用 npm 把 CodeGraph 裝進 Aivenue 自己的工具資料夾（約 270 MB，需要 Node.js），不改 PATH，也不改你的 agent 設定。每個工作流開始前，Aivenue 會在工作資料夾建立或更新 .codegraph/ 索引，agent 改檔後也會在背景更新，agent 拿到 CodeGraph 的查詢工具。Aivenue 啟動的 CodeGraph 一律關閉使用統計。',
            "The first time it installs CodeGraph with npm into Aivenue's own tools folder (about 270 MB, needs Node.js); your PATH and agent settings are not changed. Before each workflow Aivenue builds or updates the .codegraph/ index in the working folder, and again in the background after agents change files; agents get CodeGraph's lookup tools. Usage statistics are always off for the CodeGraph Aivenue runs.",
          )}
        />
      )}

      {s.id === 'impeccable' && s.enabled && (
        <Hint
          className="muted tiny"
          text={t(
            '為新介面挑設計方向時（專案要先有 PRODUCT.md），impeccable 會連到 impeccable.style，這個連線關不掉，只會告訴它不要記錄。第一次開啟會用 npm 把 impeccable 與它的引擎裝進 Aivenue 自己的工具資料夾（約 20 MB，需要 Node.js），不改 PATH，也不把 Skill 寫進你的專案或 agent 設定。Aivenue 執行的 impeccable 一律關閉使用統計與更新檢查；掃描網址時會用你電腦上的 Chrome 或 Edge。',
            "To pick a design direction for a new interface (once the project has a PRODUCT.md), impeccable connects to impeccable.style; that request cannot be turned off, it only tells the server not to record it. The first time it installs impeccable and its engine with npm into Aivenue's own tools folder (about 20 MB, needs Node.js); your PATH is not changed and the skill is not written into your project or agent settings. Usage statistics and update checks are always off for the impeccable Aivenue runs; scanning a URL uses the Chrome or Edge installed on your computer.",
          )}
        />
      )}

      {s.id === 'omniroute' && s.enabled && (
        <>
          {s.omniroute && (
            <dl className="ext-stats small">
              <div>
                <dt>{t('網址', 'URL')}</dt>
                <dd className="mono">{s.omniroute.url}</dd>
              </div>
              <div>
                <dt>{t('已連接供應商', 'Providers connected')}</dt>
                <dd className="num">{s.omniroute.connections}</dd>
              </div>
              <div>
                <dt>{t('agent 可用模型', 'Models for agents')}</dt>
                <dd className="num">{t(`${s.omniroute.models}，免費 ${s.omniroute.free}`, `${s.omniroute.models}, ${s.omniroute.free} free`)}</dd>
              </div>
            </dl>
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
                {copied ? t('已複製', 'Copied') : t('複製管理密碼', 'Copy dashboard password')}
              </button>
              <button className="btn small ghost" disabled={busy} onClick={() => run(() => hub.call('extensions.refresh'))}>
                {t('重新讀取', 'Reload')}
              </button>
              <button className={cx('btn small', !s.omniroute.connections ? 'primary' : 'ghost')} onClick={() => setProviders(true)}>
                {t(`連接免費供應商…`, `Connect free providers…`)}
              </button>
            </div>
          )}
          <Hint
            className="muted tiny"
            text={
              (s.omniroute && !s.omniroute.connections
                ? t('下一步：按「連接免費供應商」接上至少一家，OmniRoute 內建的免登入模型太短，跑不動 agent。', 'Next: press "Connect free providers" and connect at least one; OmniRoute’s built-in no-sign-in models are too short to run an agent.')
                : t('在「供應商」頁和角色設定可以選 OmniRoute 的模型，自動指派只會把它用在子 agent 與壓縮。', 'Pick OmniRoute models on the Providers page and in role settings; automatic assignment only uses it for sub-agents and compaction.')) +
              ' ' +
              t('它只在這台電腦上執行，位址是 127.0.0.1，管理密碼是自動產生的亂數。', 'It runs on this computer only, at 127.0.0.1, with a generated dashboard password.')
            }
          />
          {s.omniroute?.openrouter && <OpenRouterAuth oauth={s.omniroute.openrouter} />}
          {s.omniroute?.refresh && (
            <div className="muted tiny" role="status">
              {t('這次沒有讀到 OmniRoute 的最新清單，沿用上次讀到的：', 'OmniRoute’s lists could not be read this time; the last ones read stay: ')}
              {s.omniroute.refresh.message}
            </div>
          )}
          {s.omniroute && providers && (
            <ExtWindow title={t(`${info.name}：連接免費供應商`, `${info.name}: connect free providers`)} onClose={() => setProviders(false)}>
              <OmniProviders s={s} />
            </ExtWindow>
          )}
        </>
      )}

      {s.enabled && s.state === 'error' && (s.id === 'graphify' || s.id === 'codegraph' || s.id === 'impeccable' || s.id === 'omniroute') && (
        <button className="btn small" disabled={busy} onClick={() => run(() => hub.call('extensions.retry', { id: s.id }))}>
          {t('重試', 'Retry')}
        </button>
      )}
      {(s.id === 'codegraph' || s.id === 'impeccable') && s.installed && s.state !== 'working' && (
        <div className="row gap wrap">
          <button
            className="btn small ghost danger"
            disabled={busy}
            title={
              s.id === 'codegraph'
                ? t('刪除 Aivenue 裝的 CodeGraph 並關閉它；專案裡的 .codegraph/ 索引不會刪除', "Removes the CodeGraph Aivenue installed and turns it off; the projects' .codegraph/ indexes stay")
                : t('刪除 Aivenue 裝的 impeccable 與它的 Skill 副本並關閉它；專案裡的檔案不會動', "Removes the impeccable Aivenue installed and its copy of the skill, and turns it off; your projects' files are not touched")
            }
            onClick={() => void run(() => hub.call('extensions.uninstall', { id: s.id }))}
          >
            {t('解除安裝', 'Uninstall')}
          </button>
        </div>
      )}
      {error && <div className="note err">{error}</div>}
      {guide && <ExtensionGuide id={s.id} onClose={() => setGuide(false)} />}
      <div className="row gap ext-foot">
        <button className="link link-icon tiny" onClick={() => hub.call('host.openExternal', { url: info.url })}>
          <Ico i={ExternalLink} size={14} /> {t('來源', 'Source')}
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
          <Hint className="cap-desc" text={t('隨 Aivenue 附上，預設全部關閉，開啟就能用。Graphify、CodeGraph、impeccable 與 OmniRoute 第一次開啟時會自動下載需要的工具，CodeGraph 約 270 MB、impeccable 約 20 MB、OmniRoute 約 500 MB。', 'Shipped with Aivenue and off by default; turn one on and it works. Graphify, CodeGraph, impeccable and OmniRoute download the tools they need the first time: CodeGraph about 270 MB, impeccable about 20 MB, OmniRoute about 500 MB.')} />
        </div>
      </div>
      <div className="clist ext-list">
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
  'obsidian-skills': {
    title: 'obsidian-markdown + json-canvas + obsidian-bases',
    use: ['Obsidian 筆記庫的檔案格式：雙鏈、嵌入、callout、屬性等 Obsidian 語法，白板（.canvas）和資料庫檢視（.base）。', 'Obsidian vault formats: wikilinks, embeds, callouts, properties and other Obsidian syntax, canvases (.canvas) and Bases views (.base).'],
    when: ['適用於在 Obsidian 筆記庫裡新增或修改筆記、白板、Base 的任務。直接寫檔，不需要開著 Obsidian；需要 Obsidian 程式的 obsidian-cli 沒有附上。', 'For tasks that add or change notes, canvases or Bases in an Obsidian vault. Files are written directly, Obsidian does not need to be open; obsidian-cli, which needs the Obsidian app, is not shipped.'],
    url: 'https://github.com/obsidianmd/obsidian-skills',
    license: 'MIT',
  },
  egm: {
    title: 'Elephant-Goldfish Model',
    use: ['設計文件與多輪審查。撰寫計畫的 agent（大象）把計畫寫成設計文件，審查計畫的 agent 和它派出的唯讀子 agent（金魚）從全新的上下文、依不同角色挑毛病，結果回到計畫者修改。', 'Design docs and fresh-eyed reviews. The plan author (the Elephant) writes the plan as a design document; the plan reviewer and the read-only sub-agents it sends (the Goldfish) review it from fresh contexts through different personas, and the findings go back to the author.'],
    when: ['適用於要先設計再動手的工作，需要在工作流裡開啟撰寫計畫。允許子 agent 時，每個審查角色各用一個子 agent；不允許時由審查者自己逐一套用。', 'For work worth designing before building; turn on planning in the workflow. With sub-agents allowed, each review persona runs as its own sub-agent; without them the reviewer applies them one by one.'],
    url: 'https://github.com/google/elephant-goldfish-model',
    license: 'Apache-2.0',
  },
};

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
          <Hint
            className="cap-desc"
            text={t(
              '隨 Aivenue 提供，預設全部關閉，開啟後就提供給列出的角色。每次都出現在它們的 Skill 清單，由 agent 依任務決定要不要讀；Aivenue 不會先檢查變更的檔案才提供，也不會自己安裝工具或連網。',
              'Shipped with Aivenue and off by default; when one is on it is offered to the roles listed. It is in their skills index every time and the agent decides from the task whether to read it; Aivenue does not check the changed files first, and none installs tools or goes online.',
            )}
          />
        </div>
      </div>
      <div className="clist builtin-skills">
        {list.map((s) => {
          const info = PACK_INFO[s.id];
          return (
            <div key={s.id} className="crow">
              <div className="crow-head">
                <div className="grow min0">
                  <div className="crow-name mono">{info.title}</div>
                  <div className="small">{t(...info.use)}</div>
                  <div className="muted small">
                    {t('適用情境：', 'Best for: ')}
                    {t(...info.when)}
                  </div>
                </div>
                <div className="row gap crow-actions">
                  <label className="switch" title={info.title}>
                    <input type="checkbox" role="switch" checked={s.enabled} disabled={busy || !s.available} aria-label={info.title} onChange={(e) => run(() => hub.call('extensions.setPackSkill', { id: s.id, on: e.target.checked }))} />
                    <span aria-hidden="true" />
                  </label>
                </div>
              </div>
              <div className="row gap wrap crow-meta">
                <span className="muted tiny">{t('開啟後提供給：', 'Offered to: ')}</span>
                {s.roles.map((r) => (
                  <span key={r} className="tag">
                    {roleName(t, r)}
                  </span>
                ))}
                <button className="link link-icon tiny" onClick={() => hub.call('host.openExternal', { url: info.url })}>
                  <Ico i={ExternalLink} size={14} /> {t('來源', 'Source')}
                </button>
                <span className="muted tiny">{info.license}</span>
                {!s.available && <span className="muted tiny">{t('這個版本沒有附上', 'Not shipped in this build')}</span>}
              </div>
            </div>
          );
        })}
      </div>
      {error && <div className="note err">{error}</div>}
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
          <div className="cap-desc">{t('這些 Skill 隨 Aivenue 提供，會依任務或該次工作流的設定使用。', "These skills ship with Aivenue and are used according to the task or that workflow's settings.")}</div>
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

/** What is on, in one line at the top of the page: the extensions, the built-in skills, the skills, MCP, GitHub. */
function Overview() {
  const t = useT();
  const ext = useExtensions();
  const pack = usePackSkills();
  const { config, skills, projectSkills = [] } = useCapabilities();
  const gh = useGithub();
  const c = capabilityCounts({
    extensions: ext,
    packSkills: pack,
    skills: skills.map((s) => ({ enabled: s.enabled, approved: s.review.state === 'approved' })),
    projectSkills: projectSkills.map((s) => ({ approved: s.review.state === 'approved' })),
    mcp: config.mcpServers,
    github: { installed: gh.git.installed && gh.gh.installed, signedIn: gh.auth.loggedIn },
  });
  // Each kind under the name of its section below; what is on first, the kinds with nothing on after it.
  const name = {
    extensions: t('內建擴充', 'built-in extensions'),
    builtinSkills: t('可開關的內建 Skill', 'built-in skills you can turn on'),
    skills: t('共用 Skill', 'shared skills'),
    mcp: t('MCP 伺服器', 'MCP servers'),
  };
  const { on, off } = overviewParts(c);
  const github = gh.checkedAt === 0 ? t('GitHub 檢查中', 'GitHub: checking') : c.github === 'signedIn' ? t('GitHub 已登入', 'GitHub signed in') : c.github === 'signedOut' ? t('GitHub 未登入', 'GitHub signed out') : t('GitHub 未安裝', 'GitHub not installed');
  return (
    <div className="cap-overview">
      <div>{[on.length > 0 && t(`已開啟：${on.map((p) => `${name[p.kind]} ${p.n} 個`).join('、')}`, `On: ${on.map((p) => `${p.n} ${name[p.kind]}`).join(', ')}`), github].filter(Boolean).join(' · ')}</div>
      {off.length > 0 && <div className="muted">{t(`未開啟：${off.map((k) => name[k]).join('、')}`, `Nothing on yet: ${off.map((k) => name[k]).join(', ')}`)}</div>}
    </div>
  );
}

export function CapabilitiesPane() {
  const t = useT();
  return (
    <div className="pane">
      <div className="pane-head">
        <div>
          <h2>{t('能力', 'Capabilities')}</h2>
          <div className="pane-desc">{t('所有供應商、所有角色共用的工具、Skill 與指示。', 'Tools, skills and instructions shared by every provider and role.')}</div>
          <Overview />
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
