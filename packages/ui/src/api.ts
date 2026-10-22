import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AgentEvent, AppSettings, CapabilitiesConfig, HostInfo, ModelInfo, ProviderInfo, ProviderUsage, PushMessage, SkillInfo, WorkflowRun, WorkflowSummary, GithubStatus } from '../../core/src/types';

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

class HubClient {
  private ws?: WebSocket;
  private seq = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private listeners = new Map<string, Set<Listener>>();
  private queue: string[] = [];
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

  private connect() {
    this.setStatus('connecting');
    const ws = new WebSocket(socketUrl());
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.setStatus('open');
      for (const m of this.queue.splice(0)) ws.send(m);
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
      if (msg.error) p.reject(new Error(msg.error));
      else p.resolve(msg.result);
    };
    ws.onclose = () => {
      this.setStatus('closed');
      for (const p of this.pending.values()) p.reject(new Error('與 Aivenue 的連線中斷'));
      this.pending.clear();
      setTimeout(() => this.connect(), Math.min(5000, 500 * 2 ** this.retry++));
    };
  }

  private emit(topic: string, data: unknown) {
    this.listeners.get(topic)?.forEach((l) => l(data));
  }

  call<T = any>(method: string, params?: unknown): Promise<T> {
    const id = ++this.seq;
    const msg = JSON.stringify({ id, method, params });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(msg);
      else this.queue.push(msg);
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

export function useCapabilities(): { config: CapabilitiesConfig; skills: SkillInfo[] } {
  return useSynced('capabilities.get', undefined, 'capabilities', { config: { mcpServers: [], instructions: {}, skills: {} }, skills: [] as SkillInfo[] })[0];
}

const NO_GITHUB: GithubStatus = { git: { installed: false }, gh: { installed: false }, auth: { loggedIn: false }, gitCredential: false, checkedAt: 0 };

export function useGithub(): GithubStatus {
  return useSynced<GithubStatus>('github.status', undefined, 'github', NO_GITHUB)[0];
}

export function useProviders(): ProviderInfo[] {
  return useSynced<ProviderInfo[]>('providers.list', undefined, 'providers', [])[0];
}

export function useWorkflows(): WorkflowSummary[] {
  return useSynced<WorkflowSummary[]>('workflows.list', undefined, 'workflows', [])[0];
}

export function useWorkflow(id: string | undefined): WorkflowRun | null {
  const [run] = useSynced<WorkflowRun | null>('workflows.get', { id }, 'workflow', null, (d: WorkflowRun) => d.id === id);
  return id ? run : null;
}

const modelCache = new Map<string, Promise<ModelInfo[]>>();

/** Models a provider offers (cached per session; `refresh` re-reads the CLI). */
export function useModels(providerId: string | undefined): { models: ModelInfo[]; refresh: () => void } {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!providerId) return setModels([]);
    let alive = true;
    const key = providerId;
    if (n > 0 || !modelCache.has(key)) modelCache.set(key, hub.call<ModelInfo[]>('providers.models', { id: key, refresh: n > 0 }).catch(() => []));
    modelCache.get(key)!.then((m) => alive && setModels(m));
    return () => {
      alive = false;
    };
  }, [providerId, n]);
  return { models, refresh: () => setN((x) => x + 1) };
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

export function useAgentEvents(workflowId: string | undefined, agentId: string | undefined): AgentEvent[] {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const buffer = useRef<AgentEvent[]>([]);
  useEffect(() => {
    setEvents([]);
    buffer.current = [];
    if (!workflowId || !agentId) return;
    let loaded = false;
    let alive = true;
    const off = hub.on('agentEvent', (d: { workflowId: string; agentId: string; event: AgentEvent }) => {
      if (d.workflowId !== workflowId || d.agentId !== agentId) return;
      if (!loaded) buffer.current.push(d.event);
      else setEvents((cur) => mergeEvent(cur, d.event));
    });
    hub
      .call<AgentEvent[]>('agents.events', { workflowId, agentId })
      .then((list) => {
        if (!alive) return;
        let merged = list ?? [];
        for (const e of buffer.current) merged = mergeEvent(merged, e);
        loaded = true;
        setEvents(merged);
      })
      .catch(() => (loaded = true));
    return () => {
      alive = false;
      off();
    };
  }, [workflowId, agentId]);
  return events;
}
