import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { AgentEvent, AppSettings, CapabilitiesConfig, HostInfo, ModelInfo, ProviderInfo, ProviderUsage, PushMessage, ProjectSkillInfo, SkillInfo, WorkflowRun, WorkflowSummary, GithubStatus, ExtensionStatus, PackSkillStatus } from '../../core/src/types';
import { setPickedColors } from './util';
import { NOT_REPLAYED } from '../../core/src/replay';

type Listener = (data: any) => void;

declare global {
  interface Window {
    __AIVENUE__?: { wsUrl: string; host: string };
  }
}

function socketUrl(): string {
  if (window.__AIVENUE__?.wsUrl) return window.__AIVENUE__.wsUrl;
  const params = new URLSearchParams(location.search);
  let token = params.get('token');
  try {
    if (token) sessionStorage.setItem('aivenue.token', token);
    else token = sessionStorage.getItem('aivenue.token');
  } catch {
    // storage unavailable
  }
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?token=${token ?? ''}`;
}

/** How long a call waits for the hub (across reconnects) before it fails. */
const CALL_TIMEOUT_MS = 120_000;

class HubClient {
  private ws?: WebSocket;
  private seq = 0;
  /** This page's id: with a call's number, the operation id the hub runs once (OpLog). */
  private clientId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  /**
   * Calls not answered yet, in the order made: sent again after a reconnect (the hub still runs each once), except one
   * with an effect outside Aivenue's records (replay.ts) that was already sent: its result is unknown, so it fails
   * instead and the user checks. `sent`: it went out on a connection.
   */
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; msg: string; method: string; sent: boolean; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Map<string, Set<Listener>>();
  private statusListeners = new Set<() => void>();
  private retry = 0;
  status: 'connecting' | 'open' | 'closed' = 'connecting';

  constructor() {
    this.connect();
  }

  private setStatus(s: HubClient['status']) {
    this.status = s;
    this.statusListeners.forEach((l) => l());
  }

  /** The next try after a lost connection, so a move to another hub (moveTo) does not leave a second socket. */
  private again?: ReturnType<typeof setTimeout>;

  /**
   * The hub is now at `wsUrl` (VS Code's shared hub came back on another port): connect there at once, keeping the
   * page as it is. Calls still waiting go again there (with their operation ids), as after any reconnect.
   */
  moveTo(wsUrl: string) {
    if (window.__AIVENUE__) window.__AIVENUE__.wsUrl = wsUrl;
    else window.__AIVENUE__ = { wsUrl, host: 'vscode' };
    const old = this.ws;
    if (old) {
      old.onopen = old.onmessage = old.onclose = null;
      try {
        old.close();
      } catch {
        // already closed
      }
    }
    this.retry = 0;
    this.connect();
  }

  private connect() {
    clearTimeout(this.again);
    this.again = undefined;
    this.setStatus('connecting');
    const ws = new WebSocket(socketUrl());
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setStatus('open');
      // Unanswered calls go again with the same operation id: one that already ran answers without running twice. One
      // with an outside effect that already went out is not sent again: whether it happened is unknown.
      for (const [id, p] of this.pending) {
        if (p.sent && NOT_REPLAYED.has(p.method)) {
          this.pending.delete(id);
          clearTimeout(p.timer);
          p.reject(new Error('與 Aivenue 的連線中斷，無法確定這個操作有沒有完成；為了不重複執行，沒有自動重送。請確認目前的狀態後再試'));
          continue;
        }
        ws.send(p.msg);
        p.sent = true;
      }
      this.emit('reconnect', null);
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data));
      if (msg.push) {
        const p = msg.push as PushMessage;
        this.emit(p.topic, p.data);
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    };
    ws.onclose = () => {
      this.setStatus('closed');
      this.again = setTimeout(() => this.connect(), Math.min(5000, 500 * 2 ** this.retry++));
    };
  }

  private emit(topic: string, data: unknown) {
    this.listeners.get(topic)?.forEach((l) => l(data));
  }

  call<T = any>(method: string, params?: unknown): Promise<T> {
    const id = ++this.seq;
    const msg = JSON.stringify({ id, method, params, op: `${this.clientId}-${id}` });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('與 Aivenue 的連線中斷，這個操作沒有得到回應'));
      }, CALL_TIMEOUT_MS);
      const entry = { resolve, reject, msg, method, sent: false, timer };
      this.pending.set(id, entry);
      // Not connected now: sent when the connection opens.
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(msg);
        entry.sent = true;
      }
    });
  }

  on(topic: string, fn: Listener): () => void {
    let set = this.listeners.get(topic);
    if (!set) this.listeners.set(topic, (set = new Set()));
    set.add(fn);
    return () => set!.delete(fn);
  }

  subscribeStatus = (fn: () => void) => {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  };
}

export const hub = new HubClient();

/** VS Code's webview API: there only, and to be taken once per page. */
declare const acquireVsCodeApi: undefined | (() => { postMessage(message: unknown): void });
export const vscodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;

// VS Code: the extension says where the shared hub is after it came back (another port). The page connects there and
// answers, so the extension does not load it anew (which would lose what is being written and the chat shown). Only an
// address on the same host as now is taken.
if (vscodeApi)
  window.addEventListener('message', (e: MessageEvent) => {
    const m = e.data as { type?: string; wsUrl?: string } | undefined;
    if (m?.type !== 'aivenue.hub' || typeof m.wsUrl !== 'string') return;
    try {
      if (new URL(m.wsUrl).hostname !== new URL(socketUrl()).hostname) return;
    } catch {
      return;
    }
    hub.moveTo(m.wsUrl);
    vscodeApi.postMessage({ type: 'aivenue.hub.moved', wsUrl: m.wsUrl });
  });

/** URL that serves an attachment from the hub (same token as the socket). */
export function fileUrl(filePath: string): string {
  const u = new URL(socketUrl().replace(/^ws/, 'http'));
  return `${u.origin}/file?token=${u.searchParams.get('token') ?? ''}&path=${encodeURIComponent(filePath)}`;
}

export function useConnection() {
  return useSyncExternalStore(hub.subscribeStatus, () => hub.status);
}

/** Load with `method`, then keep in sync from pushes on `topic`. */
function useSynced<T>(method: string, params: unknown, topic: string, initial: T, accept?: (data: any) => boolean): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(initial);
  const key = JSON.stringify(params ?? null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      hub
        .call<T>(method, params)
        .then((v) => alive && setValue(v ?? initial))
        .catch(() => undefined);
    void load();
    const offPush = hub.on(topic, (data) => {
      if (!accept || accept(data)) setValue(data);
    });
    const offRe = hub.on('reconnect', load);
    return () => {
      alive = false;
      offPush();
      offRe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [method, key, topic]);
  return [value, setValue];
}

const DEFAULT_SETTINGS: AppSettings = { locale: 'zh-TW', theme: 'system', accent: '#c96442' };

export function useSettings(): AppSettings {
  return useSynced<AppSettings>('settings.get', undefined, 'settings', DEFAULT_SETTINGS)[0];
}

export function useUsage(): ProviderUsage[] {
  return useSynced<ProviderUsage[]>('usage.get', undefined, 'usage', [])[0];
}

export function useCapabilities(): { config: CapabilitiesConfig; skills: SkillInfo[]; projectSkills?: ProjectSkillInfo[] } {
  return useSynced('capabilities.get', undefined, 'capabilities', { config: { mcpServers: [], instructions: {}, skills: {} }, skills: [] as SkillInfo[], projectSkills: [] as ProjectSkillInfo[] })[0];
}

export function useExtensions(): ExtensionStatus[] {
  return useSynced<ExtensionStatus[]>('extensions.list', undefined, 'extensions', [])[0];
}

/** The bundled third-party skills the user turns on one by one. */
export function usePackSkills(): PackSkillStatus[] {
  return useSynced<PackSkillStatus[]>('extensions.packSkills', undefined, 'packSkills', [])[0];
}

const NO_GITHUB: GithubStatus = { git: { installed: false }, gh: { installed: false }, auth: { loggedIn: false }, gitCredential: false, checkedAt: 0 };

export function useGithub(): GithubStatus {
  return useSynced<GithubStatus>('github.status', undefined, 'github', NO_GITHUB)[0];
}

export function useProviders(): ProviderInfo[] {
  const list = useSynced<ProviderInfo[]>('providers.list', undefined, 'providers', [])[0];
  // The colours the user picked, for providerColor() everywhere.
  setPickedColors(list);
  return list;
}

export function useWorkflows(): WorkflowSummary[] {
  return useSynced<WorkflowSummary[]>('workflows.list', undefined, 'workflows', [])[0];
}

/** A conversation in the sidebar: its latest message, titled after its first one. */
export interface ThreadSummary extends WorkflowSummary {
  /** Every workflow in the conversation, oldest first (edited-away versions included). */
  ids: string[];
  /** Messages in it, not counting versions replaced by an edit. */
  messages: number;
}

export function groupThreads(all: WorkflowSummary[]): ThreadSummary[] {
  const groups = new Map<string, WorkflowSummary[]>();
  for (const w of all) {
    const key = w.threadId ?? w.id;
    groups.set(key, [...(groups.get(key) ?? []), w]);
  }
  return [...groups.values()]
    .map((list) => {
      const sorted = [...list].sort((a, b) => a.createdAt - b.createdAt);
      const live = sorted.filter((w) => !w.replacedBy);
      const latest = (live.length ? live : sorted)[(live.length ? live : sorted).length - 1];
      return { ...latest, title: sorted[0].title, ids: sorted.map((w) => w.id), messages: live.length || sorted.length };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** One entry per conversation, newest activity first. */
export function useThreads(): ThreadSummary[] {
  const all = useWorkflows();
  return useMemo(() => groupThreads(all), [all]);
}

export function useWorkflow(id: string | undefined): WorkflowRun | null {
  const [run, setRun] = useSynced<WorkflowRun | null>('workflows.get', { id }, 'workflow', null, (d: WorkflowRun) => d.id === id);
  // Deleted (here or in another window): no longer shown as if it were still there.
  useEffect(() => hub.on('deleted', (d: { id: string }) => d?.id === id && setRun(null)), [id]); // eslint-disable-line react-hooks/exhaustive-deps
  return id ? run : null;
}

/** Whether the workflow `id` was deleted while this page was open (here or in another window). */
export function useDeleted(id: string | undefined): boolean {
  const [gone, setGone] = useState(false);
  useEffect(() => {
    setGone(false);
    if (!id) return;
    return hub.on('deleted', (d: { id: string }) => d?.id === id && setGone(true));
  }, [id]);
  return gone;
}

const modelCache = new Map<string, Promise<ModelInfo[]>>();

/** Models a provider offers (cached per session; `refresh` re-reads the CLI). */
export function useModels(providerId: string | undefined): { models: ModelInfo[]; refresh: () => void; loading: boolean } {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [n, setN] = useState(0);
  // The hub bumps this when the list changed (e.g. after signing in to another plan).
  const version = useProviders().find((p) => p.spec.id === providerId)?.modelsVersion ?? 0;
  useEffect(() => {
    if (!providerId) return setModels([]);
    let alive = true;
    const key = `${providerId}@${version}`;
    if (n > 0 || !modelCache.has(key)) modelCache.set(key, hub.call<ModelInfo[]>('providers.models', { id: providerId, refresh: n > 0 }).catch(() => []));
    setLoading(true);
    modelCache.get(key)!.then((m) => alive && (setModels(m), setLoading(false)));
    return () => {
      alive = false;
    };
  }, [providerId, n, version]);
  return { models, loading, refresh: () => setN((x) => x + 1) };
}

export function useHostInfo(): HostInfo | null {
  const [info, setInfo] = useState<HostInfo | null>(null);
  useEffect(() => {
    hub.call<HostInfo>('host.info').then(setInfo).catch(() => undefined);
  }, []);
  return info;
}

export function mergeEvent(list: AgentEvent[], e: AgentEvent): AgentEvent[] {
  const last = list[list.length - 1];
  if (!last || e.seq > last.seq) return [...list, e];
  const i = list.findIndex((x) => x.seq === e.seq);
  if (i >= 0) {
    const copy = list.slice();
    copy[i] = e;
    return copy;
  }
  return [...list, e].sort((a, b) => a.seq - b.seq);
}

/** Every event once, by seq (a later copy of the same seq wins: a tool call that has finished since). */
export function mergeEvents(cur: AgentEvent[], more: AgentEvent[]): AgentEvent[] {
  if (!more.length) return cur;
  const bySeq = new Map<number, AgentEvent>();
  for (const e of cur) bySeq.set(e.seq, e);
  for (const e of more) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

export function useAgentEvents(workflowId: string | undefined, agentId: string | undefined): AgentEvent[] {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const buffer = useRef<AgentEvent[]>([]);
  useEffect(() => {
    setEvents([]);
    buffer.current = [];
    if (!workflowId || !agentId) return;
    let loading = true;
    let alive = true;
    const off = hub.on('agentEvent', (d: { workflowId: string; agentId: string; event: AgentEvent }) => {
      if (d.workflowId !== workflowId || d.agentId !== agentId) return;
      if (loading) buffer.current.push(d.event);
      else setEvents((cur) => mergeEvent(cur, d.event));
    });
    // The record first, then what arrived meanwhile; after a reconnect again (what was sent while away is in it).
    const load = () => {
      loading = true;
      hub
        .call<AgentEvent[]>('agents.events', { workflowId, agentId })
        .then((list) => {
          if (!alive) return;
          const arrived = buffer.current;
          buffer.current = [];
          loading = false;
          setEvents((cur) => mergeEvents(mergeEvents(cur, list ?? []), arrived));
        })
        .catch(() => (loading = false));
    };
    load();
    const offRe = hub.on('reconnect', load);
    return () => {
      alive = false;
      off();
      offRe();
    };
  }, [workflowId, agentId]);
  return events;
}
