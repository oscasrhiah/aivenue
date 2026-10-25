import { useEffect, useState } from 'react';
import type { AgentEvent, ProviderInfo, ProviderSpec, TestResult } from '../../../core/src/types';
import { hub, mergeEvent, useHostInfo, useProviders } from '../api';
import { Transcript } from '../components/Transcript';
import { ModelPicker } from '../components/ModelPicker';
import { CatalogPicker } from '../components/CatalogPicker';
import { useT } from '../i18n';
import { cx, elapsed, providerColor } from '../util';

/** English copies of the built-in providers' notes (specs are user data and stay as written). */
const EN_NOTES: Record<string, { description?: string; login?: string; api?: string }> = {
  claude: { description: 'Anthropic Claude Code CLI (Claude Pro / Max)', login: 'Opens claude.ai in your browser to sign in', api: 'Anthropic API key; Base URL may point to any Anthropic-compatible endpoint' },
  codex: { description: 'OpenAI Codex CLI (ChatGPT Plus / Pro)', login: 'Opens ChatGPT sign-in in your browser (Google / Microsoft / Apple)', api: 'OpenAI API key' },
  antigravity: { description: 'Google Antigravity CLI (Google AI Pro / Ultra)', login: 'Sign in with your Google account in the terminal (a browser opens); type /quit when done' },
  qwen: { description: 'Alibaba Qwen Code CLI (QwenCloud Token Plan)', login: 'Type /auth in the terminal to choose a sign-in method (the free Qwen OAuth tier ended on 2026-04-15)', api: 'Any OpenAI-compatible API (DashScope, Kimi, DeepSeek, Grok, OpenRouter…): set key + Base URL and pick a model per role' },
};

function useAction() {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };
  return { busy, error, run, setError };
}

function TestPanel({ providerId, onClose }: { providerId: string; onClose: () => void }) {
  const t = useT();
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [result, setResult] = useState<TestResult>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let id: string | undefined;
    const early: { testId: string; event?: AgentEvent; result?: TestResult }[] = [];
    const apply = (d: { event?: AgentEvent; result?: TestResult }) => {
      if (d.event) setEvents((cur) => mergeEvent(cur, d.event!));
      if (d.result) setResult(d.result);
    };
    const off = hub.on('test', (d: { testId: string; event?: AgentEvent; result?: TestResult }) => {
      if (!id) return void early.push(d);
      if (d.testId === id) apply(d);
    });
    hub
      .call<string>('providers.test', { id: providerId })
      .then((tid) => {
        id = tid;
        early.filter((d) => d.testId === tid).forEach(apply);
      })
      .catch((e) => setError(e.message));
    return off;
  }, [providerId]);
  return (
    <div className="test">
      <div className="row between">
        <span className="small">
          {!result && !error && (
            <>
              <span className="spark">✻</span> {t('測試中…（第一次啟動可能需要 10–60 秒）', 'Testing… (first start may take 10–60s)')}
            </>
          )}
          {result && (
            <span className={result.ok ? 'ok-text' : 'err-text'}>
              {result.ok ? `✓ ${t('連線成功', 'Connected')}` : `✕ ${result.error ?? t('失敗', 'Failed')}`} · {elapsed(0, result.durationMs)} ·{' '}
              {result.mcpCalled ? t('Aivenue 工具可用', 'Aivenue tools available') : t('未呼叫到 Aivenue 工具（無法當 sub agent 協作）', 'Aivenue tools not called (cannot coordinate as sub-agent)')}
            </span>
          )}
          {error && <span className="err-text">{error}</span>}
        </span>
        <button className="icon-btn" onClick={onClose}>
          ✕
        </button>
      </div>
      <Transcript events={events} />
    </div>
  );
}

function SpecEditor({ initial, isNew, onClose }: { initial: ProviderSpec; isNew: boolean; onClose: () => void }) {
  const t = useT();
  const [text, setText] = useState(JSON.stringify(initial, null, 2));
  const [templates, setTemplates] = useState<{ id: string; label: string; spec: ProviderSpec }[]>([]);
  const { busy, error, run, setError } = useAction();
  useEffect(() => {
    if (isNew) hub.call('providers.templates').then((r) => setTemplates(r.templates)).catch(() => undefined);
  }, [isNew]);
  const save = () =>
    run('save', async () => {
      let spec: ProviderSpec;
      try {
        spec = JSON.parse(text);
      } catch (e) {
        throw new Error(`JSON: ${(e as Error).message}`);
      }
      await hub.call('providers.save', { spec });
      onClose();
    });
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3>{isNew ? t('新增供應商', 'Add provider') : t(`編輯 ${initial.name}`, `Edit ${initial.name}`)}</h3>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>
        {isNew && (
          <select
            defaultValue=""
            onChange={(e) => {
              const tpl = templates.find((x) => x.id === e.target.value);
              if (tpl) setText(JSON.stringify(tpl.spec, null, 2));
              setError(null);
            }}
          >
            <option value="" disabled>
              {t('從範本開始（選擇輸出格式相近的 CLI）…', 'Start from a template (closest output format)…')}
            </option>
            {templates.map((tpl) => (
              <option key={tpl.id} value={tpl.id}>
                {tpl.label}
              </option>
            ))}
          </select>
        )}
        <div className="muted small">
          {t('參數以群組表示，群組中任何變數沒有值時整組省略。可用變數：', 'Args are groups; a group is dropped when any of its variables is empty. Variables: ')}
          <code>{'{model} {sessionId} {newSessionId} {mcpConfigFile} {mcpCommandToml} {mcpArgsToml} {mcpEnvToml} {cwd} {prompt}'}</code>
          {t('。output：', '. output: ')}
          <code>claude-stream · gemini-stream · codex-jsonl · text</code>
          {t('。API 模式加入 ', '. For API mode add ')}
          <code>{'"apiKey": {"env": "X_API_KEY", "baseUrlEnv": "X_BASE_URL"}'}</code>
        </div>
        <textarea className="code" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} rows={22} />
        {error && <div className="note err">{error}</div>}
        <div className="row end gap">
          <button className="btn" onClick={onClose}>
            {t('取消', 'Cancel')}
          </button>
          <button className="btn primary" disabled={busy === 'save'} onClick={save}>
            {t('儲存', 'Save')}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProviderRow({ p, secure }: { p: ProviderInfo; secure: boolean }) {
  const t = useT();
  const { busy, error, run } = useAction();
  const [open, setOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [key, setKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(p.baseUrl ?? '');
  useEffect(() => setBaseUrl(p.baseUrl ?? ''), [p.baseUrl]);
  const s = p.spec;
  const en = EN_NOTES[s.id];
  const call = (name: string, method: string, params: unknown) => run(name, () => hub.call(method, params));
  // Run by a built-in extension (OmniRoute): turned on, off and signed in from Capabilities → Built-in extensions.
  const managed = s.modelSource?.type === 'extension';
  const stateText = !p.installed
    ? t('未安裝', 'Not installed')
    : managed
      ? p.auth.state === 'logged_in'
        ? t('可以使用', 'Ready')
        : t('未就緒', 'Not ready')
    : p.auth.state === 'logged_in'
      ? p.authMode === 'api'
        ? t('API 金鑰', 'API key')
        : t('已登入', 'Signed in')
      : p.auth.state === 'checking'
        ? t('檢查中…', 'Checking…')
        : p.auth.state === 'unknown'
          ? t('狀態不明', 'Unknown')
          : t('未登入', 'Signed out');
  const ready = p.installed && p.auth.state === 'logged_in';

  return (
    <div className={cx('prow', open && 'open')}>
      <div className="prow-head" onClick={() => setOpen(!open)}>
        <span className="mark lg" style={{ background: providerColor(s.id) }} />
        <div className="grow">
          <div className="prow-name">
            {s.name}
            {s.accountOf && <span className="tag">{t('其他帳號', 'Extra account')}</span>}
            {managed ? <span className="tag">{t('內建擴充', 'Built-in extension')}</span> : !p.builtin && !s.accountOf && <span className="tag">{t('自訂', 'Custom')}</span>}
            {p.customized && <span className="tag">{t('已修改', 'Modified')}</span>}
          </div>
          <div className="muted small">{t(s.description ?? '', en?.description ?? s.description ?? '')}</div>
          {(p.defaultModel || p.defaultEffort) && <div className="muted tiny mono">{[p.defaultModel, p.defaultEffort && `effort ${p.defaultEffort}`].filter(Boolean).join(' · ')}</div>}
        </div>
        <span className={cx('state', ready ? 'ok' : p.installed ? 'warn' : 'err')}>{stateText}</span>
        <span className="chev">{open ? '▾' : '▸'}</span>
      </div>

      {open && (
        <div className="prow-body">
          <div className="muted small mono">{p.installed ? p.resolvedPath : t(`找不到指令「${s.command}」`, `Command "${s.command}" not found`)}</div>
          {p.auth.detail && p.installed && <div className="muted small">{p.auth.detail}</div>}

          {!p.installed && p.installCommand && (
            <div className="row gap wrap">
              <button className="btn primary" onClick={() => call('install', 'providers.install', { id: s.id })}>
                {t('安裝', 'Install')}
              </button>
              <code className="muted">{p.installCommand}</code>
            </div>
          )}

          {managed ? (
            <div className="row gap wrap">
              <span className="muted small">{t('由「能力 → 內建擴充」管理：在那裡開關、開啟管理頁與連接供應商。', 'Managed under Capabilities → Built-in extensions: turn it on or off, open its dashboard and connect providers there.')}</span>
              <a className="btn small ghost" href="#/settings/capabilities">
                {t('前往', 'Open')}
              </a>
            </div>
          ) : (
          <>
          <div className="seg">
            <button className={cx(p.authMode === 'subscription' && 'on')} onClick={() => call('mode', 'providers.setAuthMode', { id: s.id, mode: 'subscription' })}>
              {t('訂閱帳號', 'Subscription')}
            </button>
            <button className={cx(p.authMode === 'api' && 'on')} disabled={!s.apiKey} onClick={() => call('mode', 'providers.setAuthMode', { id: s.id, mode: 'api', baseUrl: p.baseUrl })}>
              API
            </button>
          </div>

          {p.authMode === 'subscription' ? (
            <>
              {s.login?.note && <div className="muted small">{t(s.login.note, en?.login ?? s.login.note)}</div>}
              <div className="row gap wrap">
                <button className="btn primary" disabled={!p.installed} onClick={() => call('login', 'providers.login', { id: s.id })}>
                  {p.auth.state === 'logged_in' ? t('重新登入', 'Sign in again') : t('登入', 'Sign in')}
                </button>
                {s.logout && (
                  <button className="btn" disabled={!p.installed} onClick={() => call('logout', 'providers.logout', { id: s.id })}>
                    {t('登出', 'Sign out')}
                  </button>
                )}
                <button className="btn ghost" disabled={busy === 'refresh'} onClick={() => call('refresh', 'providers.refresh', { id: s.id })}>
                  {t('重新檢查', 'Re-check')}
                </button>
              </div>
            </>
          ) : (
            <>
              {s.apiKey?.note && <div className="muted small">{t(s.apiKey.note, en?.api ?? s.apiKey.note)}</div>}
              {!secure && <div className="note warn">{t('瀏覽器模式下金鑰未加密保存，建議使用桌面版或 VS Code 插件。', 'In browser mode keys are not encrypted; prefer the desktop app or the VS Code extension.')}</div>}
              <div className="row gap">
                <input type="password" className="grow" autoComplete="off" placeholder={p.hasApiKey ? t('已儲存（輸入新值以取代）', 'Saved (type to replace)') : s.apiKey?.env} value={key} onChange={(e) => setKey(e.target.value)} />
                <button className="btn primary" disabled={!key.trim()} onClick={() => run('key', async () => (await hub.call('providers.setApiKey', { id: s.id, key }), setKey('')))}>
                  {t('儲存', 'Save')}
                </button>
                {p.hasApiKey && (
                  <button className="btn" onClick={() => call('key', 'providers.setApiKey', { id: s.id, key: '' })}>
                    {t('清除', 'Clear')}
                  </button>
                )}
              </div>
              {s.apiKey?.baseUrlEnv && (
                <div className="row gap">
                  <input className="grow" placeholder={t('Base URL（選填）', 'Base URL (optional)')} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
                  <button className="btn" disabled={baseUrl === (p.baseUrl ?? '')} onClick={() => call('base', 'providers.setAuthMode', { id: s.id, mode: 'api', baseUrl })}>
                    {t('儲存', 'Save')}
                  </button>
                </div>
              )}
            </>
          )}
          </>
          )}

          <div className="kv sep">
            <label>{t('預設模型', 'Default model')}</label>
            <ModelPicker
              provider={p}
              model={p.defaultModel}
              effort={p.defaultEffort}
              disabled={!p.installed}
              inheritLabel={t('CLI 預設', 'CLI default')}
              onChange={(v) => call('defaults', 'providers.setDefaults', { id: s.id, model: v.model, effort: v.effort })}
            />
          </div>
          <div className="muted tiny">{t('沒有指定模型的角色（包含自動指派與 sub agent）會使用這組預設。', 'Used by roles that do not pick a model, including auto assignment and sub-agents.')}</div>

          {s.accounts && !s.accountOf && <AddAccount providerId={s.id} name={s.name} />}
          {s.accountHome && <div className="muted tiny mono">{t(`這個帳號的登入資料：${s.accountHome}`, `This account's sign-in data: ${s.accountHome}`)}</div>}

          {s.accountOf && s.accountHome ? (
            <div className="row gap wrap sep">
              <button className="btn" disabled={!p.installed || testing} onClick={() => setTesting(true)}>
                {t('測試連線', 'Test')}
              </button>
              <span className="grow" />
              <button
                className="btn ghost danger"
                onClick={() => {
                  if (!confirm(t(`移除帳號「${s.accountName}」？`, `Remove the account "${s.accountName}"?`))) return;
                  const deleteData = confirm(t('也要刪除這個帳號在這台電腦上的登入資料嗎？（按「取消」會保留，之後重新加入同名帳號不用再登入）', 'Also delete this account\'s sign-in data on this computer? (Cancel keeps it, so re-adding the account later needs no new sign-in)'));
                  void call('delete', 'providers.removeAccount', { id: s.id, deleteData });
                }}
              >
                {t('移除這個帳號', 'Remove this account')}
              </button>
            </div>
          ) : (
          <div className="row gap wrap sep">
            <button className="btn" disabled={!p.installed || testing} onClick={() => setTesting(true)}>
              {t('測試連線', 'Test')}
            </button>
            <button className="btn ghost" onClick={() => setEditing(true)}>
              {t('進階設定', 'Advanced')}
            </button>
            {s.docsUrl && (
              <button className="btn ghost" onClick={() => hub.call('host.openExternal', { url: s.docsUrl })}>
                {t('文件', 'Docs')} ↗
              </button>
            )}
            <span className="grow" />
            {p.customized && (
              <button className="btn ghost" onClick={() => call('reset', 'providers.reset', { id: s.id })}>
                {t('還原預設', 'Reset')}
              </button>
            )}
            {!managed && (
              <button className="btn ghost danger" onClick={() => confirm(t(`移除 ${s.name}？`, `Remove ${s.name}?`)) && call('delete', 'providers.delete', { id: s.id })}>
                {t('移除', 'Remove')}
              </button>
            )}
          </div>
          )}
          {error && <div className="note err">{error}</div>}
          {testing && <TestPanel providerId={s.id} onClose={() => setTesting(false)} />}
          {editing && <SpecEditor initial={s} isNew={false} onClose={() => setEditing(false)} />}
        </div>
      )}
    </div>
  );
}

/** Add another account of the same tool (its own sign-in; usable at the same time). */
function AddAccount({ providerId, name }: { providerId: string; name: string }) {
  const t = useT();
  const [value, setValue] = useState('');
  const { busy, error, run } = useAction();
  return (
    <div className="account-add sep">
      <div className="small">{t(`再加一個 ${name} 帳號`, `Add another ${name} account`)}</div>
      <div className="muted tiny">
        {t('每個帳號有自己的登入資料，會變成獨立的供應商，可以同時指派到不同角色或當 sub agent；額度用完時自動指派也會換到另一個帳號。加入後在新的那一列按「登入」。', 'Each account keeps its own sign-in and becomes a provider of its own, so several can work at the same time; auto assignment also switches to another account when one runs out. Sign in on the new row after adding it.')}
      </div>
      <div className="row gap">
        <input className="grow" placeholder={t('帳號名稱，例如「公司」或「第二個」', 'Account name, e.g. "Work" or "Second"')} value={value} onChange={(e) => setValue(e.target.value)} />
        <button className="btn" disabled={!value.trim() || busy === 'add'} onClick={() => run('add', async () => (await hub.call('providers.addAccount', { id: providerId, name: value }), setValue('')))}>
          {t('新增帳號', 'Add account')}
        </button>
      </div>
      {error && <div className="note err">{error}</div>}
    </div>
  );
}

function AddProvider({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [mode, setMode] = useState<'catalog' | 'cli'>('catalog');
  if (mode === 'cli') return <SpecEditor isNew initial={{ id: 'my-agent', name: 'My Agent', command: 'my-agent', run: { common: [], prompt: 'stdin' }, output: 'text' }} onClose={onClose} />;
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3>{t('新增供應商', 'Add a provider')}</h3>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="row gap wrap">
          <span className="muted small">{t('訂閱方案、API 與本機模型（透過 OpenCode 執行）。要接其他 coding agent CLI 請改用', 'Subscription plans, APIs and local models (run through OpenCode). For another coding-agent CLI use')}</span>
          <button className="link" onClick={() => setMode('cli')}>
            {t('自訂 CLI（進階）', 'Custom CLI (advanced)')}
          </button>
        </div>
        <CatalogPicker onDone={onClose} />
      </div>
    </div>
  );
}

export function ProvidersPane() {
  const t = useT();
  const providers = useProviders();
  const host = useHostInfo();
  const [adding, setAdding] = useState(false);
  const [builtins, setBuiltins] = useState<ProviderSpec[]>([]);
  useEffect(() => {
    hub.call('providers.templates').then((r) => setBuiltins(r.builtins)).catch(() => undefined);
  }, []);
  const missing = builtins.filter((b) => !providers.some((p) => p.spec.id === b.id));
  return (
    <div className="pane">
      <div className="pane-head">
        <div>
          <h2>{t('供應商與帳號', 'Providers & accounts')}</h2>
          <p className="muted">
            {t(
              '「訂閱帳號」會開啟該 CLI 官方的登入流程，你在瀏覽器中自行選擇 Google、Email 等方式；「API」的金鑰由 Aivenue 加密保存，只在執行時交給該 CLI。',
              '"Subscription" runs the CLI\'s own sign-in so you pick Google, email, etc. in your browser. "API" keys are encrypted by Aivenue and only handed to the CLI when it runs.',
            )}
          </p>
        </div>
        <div className="row gap">
          <button className="btn ghost" onClick={() => hub.call('providers.refresh', {})}>
            {t('重新檢查', 'Re-check all')}
          </button>
          <button className="btn primary" onClick={() => setAdding(true)}>
            {t('新增', 'Add')}
          </button>
        </div>
      </div>
      <div className="plist">
        {providers.map((p) => (
          <ProviderRow key={p.spec.id} p={p} secure={host?.secureSecrets ?? true} />
        ))}
      </div>
      {missing.length > 0 && (
        <div className="muted small">
          {t('已移除的內建供應商：', 'Removed built-ins: ')}
          {missing.map((b) => (
            <button key={b.id} className="link" onClick={() => hub.call('providers.reset', { id: b.id })}>
              {t(`恢復 ${b.name}`, `Restore ${b.name}`)}
            </button>
          ))}
        </div>
      )}
      {adding && <AddProvider onClose={() => setAdding(false)} />}
    </div>
  );
}
