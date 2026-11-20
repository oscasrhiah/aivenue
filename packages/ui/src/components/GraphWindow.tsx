import { useEffect, useMemo, useRef, useState } from 'react';
import { CircleAlert, LoaderCircle, RefreshCw, Search, ZoomIn, ZoomOut } from 'lucide-react';
import type { GraphLink, GraphNode, GraphPayload } from '../../../core/src/types';
import { hub, useCodegraph, useExtensions, useGraphify } from '../api';
import { useT } from '../i18n';
import { Ico } from '../icons';
import { cx, fullTime, msgTime } from '../util';
import { Dialog, Seg, ShowAll, StateWord } from './Kit';
import { mainPart } from '../graphView';

type T = ReturnType<typeof useT>;
// vis-network is loaded only when the window opens (about 700 KB); its types come with the same file.
type Vis = typeof import('vis-network/standalone/esm/vis-network.min.js');
type Net = InstanceType<Vis['Network']>;
/** The part of a vis DataSet used here. */
type Updatable = { update(items: object[]): unknown };

/** Community colours: ten tokens in styles.css (--gv-c0…--gv-c9), mixed with the text colour so both themes read. */
const PALETTE = 10;

/** Each relation as it reads from the selected node: what it does (outgoing) and what is done to it (incoming). */
function relationLabel(t: T, relation: string, out: boolean): string {
  const r: Record<string, [string, string, string, string]> = {
    calls: ['呼叫', 'Calls', '被呼叫', 'Called by'],
    instantiates: ['建立實例', 'Instantiates', '被建立實例', 'Instantiated by'],
    extends: ['繼承', 'Extends', '被繼承', 'Extended by'],
    implements: ['實作介面', 'Implements', '介面被實作', 'Implemented by'],
    indirect_call: ['間接呼叫', 'Calls indirectly', '被間接呼叫', 'Called indirectly by'],
    contains: ['包含', 'Contains', '屬於', 'Contained in'],
    method: ['方法', 'Methods', '所屬類別', 'Method of'],
    imports: ['匯入', 'Imports', '被匯入', 'Imported by'],
    imports_from: ['匯入自', 'Imports from', '被匯入', 'Imported by'],
    re_exports: ['轉出', 'Re-exports', '被轉出', 'Re-exported by'],
    references: ['參照', 'References', '被參照', 'Referenced by'],
  };
  const x = r[relation];
  return x ? (out ? t(x[0], x[1]) : t(x[2], x[3])) : out ? relation : t(`${relation}（反向）`, `${relation} (incoming)`);
}

/** A colour token as the canvas needs it (#rrggbb): resolved by the page, then read back from a pixel. */
function resolveColors(host: HTMLElement, names: string[]): string[] {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  host.appendChild(probe);
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const out = names.map((n) => {
    probe.style.color = `var(${n})`;
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#808080';
    ctx.fillStyle = getComputedStyle(probe).color;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
  });
  probe.remove();
  return out;
}

interface Theme {
  pal: string[];
  text: string;
  halo: string;
  line: string;
  accent: string;
}

function readTheme(host: HTMLElement): Theme {
  const [text, halo, line, accent, ...pal] = resolveColors(host, ['--text', '--raised', '--line-strong', '--accent-text', ...Array.from({ length: PALETTE }, (_, i) => `--gv-c${i}`)]);
  return { pal, text, halo, line, accent };
}

function nodeStyle(n: GraphNode, th: Theme) {
  const c = th.pal[(n.community ?? 0) % PALETTE];
  return {
    id: n.id,
    label: n.label,
    value: n.degree + 1,
    shape: 'dot',
    color: { background: c, border: th.halo, highlight: { background: c, border: th.accent }, hover: { background: c, border: th.accent } },
    borderWidth: 1,
    borderWidthSelected: 3,
    font: { color: th.text, size: 12, strokeWidth: 3, strokeColor: th.halo },
  };
}

function edgeStyle(l: GraphLink, i: number, th: Theme) {
  return { id: i, from: l.source, to: l.target, color: { color: th.line, opacity: 0.35, highlight: th.accent, hover: th.accent }, width: 0.6, selectionWidth: 1.5 };
}

/** Where a node lives: "src/hub.ts:30" (graphify writes the line as "L30"). */
const placeOf = (n: GraphNode) => (n.source_file ? `${n.source_file}${n.source_location ? `:${n.source_location.replace(/^L/, '')}` : ''}` : '');

type Kind = 'graphify' | 'codegraph';

/** What the window needs to know about one tool's graph of the folder, whichever tool it is. */
interface ViewStatus {
  /** The extension is on. */
  enabled: boolean;
  /** Its state was read (an extension that is off has nothing to read). */
  loaded: boolean;
  /** On and installed: it can build and be asked. */
  active: boolean;
  exists: boolean;
  state: 'idle' | 'building' | 'failed' | 'refused';
  builtAt?: number;
  nodes?: number;
  edges?: number;
  communities?: number;
  lastError?: string;
}

const METHODS: Record<Kind, { graph: string; rebuild: string }> = {
  graphify: { graph: 'graphify.graph', rebuild: 'graphify.rebuild' },
  codegraph: { graph: 'codegraph.graph', rebuild: 'codegraph.rebuild' },
};

/** The header button's and the window's view of both graphs of a folder. */
export function useGraphViews(cwd: string | undefined): Record<Kind, ViewStatus | null> {
  const ext = useExtensions();
  const on = (id: Kind) => ext.find((e) => e.id === id);
  const gx = on('graphify');
  const cx_ = on('codegraph');
  const g = useGraphify(gx?.enabled ? cwd : undefined);
  const c = useCodegraph(cx_?.enabled ? cwd : undefined);
  return {
    graphify: gx ? { enabled: gx.enabled, loaded: !gx.enabled || !!g, active: !!g?.active, exists: !!g?.exists, state: g?.state ?? 'idle', builtAt: g?.builtAt, nodes: g?.nodes, edges: g?.edges, communities: g?.communities, lastError: g?.lastError } : null,
    codegraph: cx_ ? { enabled: cx_.enabled, loaded: !cx_.enabled || !!c, active: !!c?.active, exists: !!c?.indexed, state: c?.state ?? 'idle', builtAt: c?.indexedAt, nodes: c?.symbols, edges: c?.edges, communities: c?.files, lastError: c?.lastError } : null,
  };
}

/**
 * 「圖譜」: the graphs of the folder a workflow works in, one tab each — Graphify's and CodeGraph's, never mixed — with
 * the same viewer (search, a node's neighbours, zoom, fit) and a rebuild. It opens on the tab that has a graph.
 */
export function GraphWindow({ cwd, onClose }: { cwd: string; onClose: () => void }) {
  const t = useT();
  const views = useGraphViews(cwd);
  const [tab, setTab] = useState<Kind | undefined>();
  // The tab that has a graph (Graphify first when both do), chosen once both states are known.
  const known = !!views.graphify?.loaded && !!views.codegraph?.loaded;
  const first: Kind = views.graphify?.exists || !views.codegraph?.exists ? 'graphify' : 'codegraph';
  useEffect(() => {
    if (known && !tab) setTab(first);
  }, [known]); // eslint-disable-line react-hooks/exhaustive-deps
  const shown: Kind = tab ?? first;
  return (
    <Dialog className="gv-modal" size="xl" onClose={onClose} title={t('圖譜', 'Graph')}>
      <div className="gv-tabs">
        <Seg
          label={t('圖譜來源', 'Graph source')}
          value={shown}
          onChange={setTab}
          choices={(['graphify', 'codegraph'] as Kind[]).map((k) => ({ value: k, label: k === 'graphify' ? 'Graphify' : 'CodeGraph', title: views[k]?.exists ? undefined : k === 'graphify' ? t('這個資料夾還沒有 Graphify 圖譜', 'No Graphify graph for this folder yet') : t('這個資料夾還沒有 CodeGraph 索引', 'No CodeGraph index for this folder yet') }))}
        />
      </div>
      {tab ? <GraphView key={tab} cwd={cwd} kind={tab} status={views[tab]} /> : <div className="gv-empty"><StateWord icon={LoaderCircle} spin>{t('載入中', 'Loading')}</StateWord></div>}
    </Dialog>
  );
}

/** One tool's graph: the canvas and the panel beside it. */
function GraphView({ cwd, kind, status }: { cwd: string; kind: Kind; status: ViewStatus | null }) {
  const t = useT();
  const [graph, setGraph] = useState<GraphPayload>();
  const [loadError, setLoadError] = useState<string>();
  const [selected, setSelected] = useState<string>();
  const [query, setQuery] = useState('');
  const [layout, setLayout] = useState<number | 'done'>(0);
  const [visError, setVisError] = useState<string>();
  const [asking, setAsking] = useState(false);
  const canvas = useRef<HTMLDivElement>(null);
  const net = useRef<{ network: Net; nodes: Updatable; edges: Updatable }>(undefined);
  // Read again whenever a new one was written (a graph whose time is unknown is read once).
  const builtAt = status?.exists ? (status.builtAt ?? 1) : undefined;

  // The graph as it is now: read again whenever a new one was written.
  const active = !!status?.active;
  // Turned off (or not installed any more): the tab says so instead of showing the last graph.
  useEffect(() => {
    if (status?.loaded && !active) setGraph(undefined);
  }, [status?.loaded, active]);
  useEffect(() => {
    if (!builtAt || !active) return;
    let alive = true;
    setLoadError(undefined);
    hub
      .call<GraphPayload>(METHODS[kind].graph, { cwd })
      .then((g) => alive && setGraph(g))
      .catch((e) => alive && setLoadError((e as Error).message));
    return () => {
      alive = false;
    };
  }, [cwd, kind, builtAt, active]);

  const byId = useMemo(() => new Map((graph?.nodes ?? []).map((n) => [n.id, n])), [graph]);
  const neighbours = useMemo(() => {
    const m = new Map<string, { id: string; relation: string; out: boolean }[]>();
    for (const l of graph?.links ?? []) {
      (m.get(l.source) ?? m.set(l.source, []).get(l.source)!).push({ id: l.target, relation: l.relation, out: true });
      (m.get(l.target) ?? m.set(l.target, []).get(l.target)!).push({ id: l.source, relation: l.relation, out: false });
    }
    return m;
  }, [graph]);

  // Draw it (vis-network loaded now, not with the page).
  useEffect(() => {
    if (!graph || !canvas.current) return;
    let alive = true;
    let observer: MutationObserver | undefined;
    let media: MediaQueryList | undefined;
    // vis-network draws into an element of its own, which React never sees: React keeps only the outer box.
    const host = document.createElement('div');
    host.className = 'gv-host';
    canvas.current.appendChild(host);
    const recolor = () => {
      const n = net.current;
      if (!n || !canvas.current) return;
      const th = readTheme(canvas.current);
      n.nodes.update(graph.nodes.map((x) => nodeStyle(x, th)));
      n.edges.update(graph.links.map((l, i) => edgeStyle(l, i, th)));
    };
    setLayout(0);
    setVisError(undefined);
    import('vis-network/standalone/esm/vis-network.min.js')
      .then((vis) => {
        if (!alive || !canvas.current) return;
        const th = readTheme(canvas.current);
        const nodes = new vis.DataSet<any>(graph.nodes.map((n) => nodeStyle(n, th)));
        const edges = new vis.DataSet<any>(graph.links.map((l, i) => edgeStyle(l, i, th)));
        const network = new vis.Network(host, { nodes, edges } as never, {
          autoResize: true,
          nodes: { scaling: { min: 7, max: 34, label: { enabled: true, min: 10, max: 18, drawThreshold: 9, maxVisible: 22 } } },
          edges: { smooth: false, arrows: { to: { enabled: true, scaleFactor: 0.3 } } },
          layout: { improvedLayout: graph.nodes.length <= 150 },
          physics: { solver: 'barnesHut', barnesHut: { gravitationalConstant: -3000, centralGravity: 0.6, springLength: 100, springConstant: 0.04, avoidOverlap: 0.1 }, stabilization: { iterations: 250, updateInterval: 25 } },
          interaction: { hover: true, tooltipDelay: 300, hideEdgesOnDrag: true, hideEdgesOnZoom: graph.links.length > 3000, keyboard: false, navigationButtons: false },
        });
        net.current = { network, nodes, edges };
        network.on('stabilizationProgress', (p: { iterations: number; total: number }) => alive && setLayout(Math.round((p.iterations / p.total) * 100)));
        network.once('stabilizationIterationsDone', () => {
          // Still afterwards: the layout stays where it settled and costs no CPU.
          network.setOptions({ physics: false });
          // The main part fills the view: small groups linked to nothing else would shrink it to a speck.
          network.fit({ nodes: mainPart(graph), animation: false });
          if (alive) setLayout('done');
        });
        network.on('click', (p: { nodes: (string | number)[] }) => alive && setSelected(p.nodes.length ? String(p.nodes[0]) : undefined));
        observer = new MutationObserver(recolor);
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'class'] });
        media = matchMedia('(prefers-color-scheme: dark)');
        media.addEventListener('change', recolor);
      })
      .catch((e) => alive && setVisError((e as Error).message));
    return () => {
      alive = false;
      observer?.disconnect();
      media?.removeEventListener('change', recolor);
      net.current?.network.destroy();
      net.current = undefined;
      host.remove();
    };
  }, [graph]);

  // Zoom around the middle of the view (the wheel and a pinch still zoom where the pointer is).
  const zoom = (factor: number) => {
    const n = net.current?.network;
    if (!n) return;
    n.moveTo({ scale: Math.min(4, Math.max(0.03, n.getScale() * factor)), animation: { duration: 200, easingFunction: 'easeInOutQuad' } });
  };

  // The selection on the canvas follows the panel's.
  const focus = (id: string) => {
    setSelected(id);
    const n = net.current?.network;
    if (!n || !byId.has(id)) return;
    n.selectNodes([id]);
    n.focus(id, { scale: Math.max(1, n.getScale()), animation: { duration: 300, easingFunction: 'easeInOutQuad' } });
  };

  const q = query.trim().toLowerCase();
  const matches = useMemo(() => (q ? (graph?.nodes ?? []).filter((n) => n.label.toLowerCase().includes(q) || n.source_file?.toLowerCase().includes(q)).sort((a, b) => b.degree - a.degree) : []), [graph, q]);
  const current = selected ? byId.get(selected) : undefined;

  const rebuild = () => {
    setAsking(true);
    hub
      .call(METHODS[kind].rebuild, { cwd })
      .catch((e) => alert((e as Error).message))
      .finally(() => setAsking(false));
  };
  const building = status?.state === 'building';

  return (
      <div className="gv-layout">
        <div className="gv-stage">
          {graph && !visError ? (
            <>
              <div
                ref={canvas}
                className="gv-canvas"
                role="img"
                tabIndex={0}
                aria-label={t('專案圖譜：用旁邊的搜尋找節點，加號與減號鍵縮放', 'Project graph: find nodes with the search beside it; plus and minus keys zoom')}
                onKeyDown={(e) => {
                  if (e.altKey || e.ctrlKey || e.metaKey) return;
                  if (e.key === '+' || e.key === '=') zoom(1.25);
                  else if (e.key === '-' || e.key === '_') zoom(1 / 1.25);
                  else return;
                  e.preventDefault();
                }}
              />
              {layout === 'done' && (
                <div className="gv-fit" role="group" aria-label={t('縮放', 'Zoom')}>
                  <button type="button" className="icon-btn gv-zoom" onClick={() => zoom(1.25)} aria-label={t('放大', 'Zoom in')} title={t('放大', 'Zoom in')}>
                    <Ico i={ZoomIn} size={16} />
                  </button>
                  <button type="button" className="icon-btn gv-zoom" onClick={() => zoom(1 / 1.25)} aria-label={t('縮小', 'Zoom out')} title={t('縮小', 'Zoom out')}>
                    <Ico i={ZoomOut} size={16} />
                  </button>
                  <button type="button" className="btn small" onClick={() => net.current?.network.fit({ nodes: mainPart(graph), animation: { duration: 300, easingFunction: 'easeInOutQuad' } })} title={t('縮放到相連的主體，不含零散的小群組', 'Zoom to the connected main part, without the small detached groups')}>
                    {t('主體', 'Main part')}
                  </button>
                  <button type="button" className="btn small" onClick={() => net.current?.network.fit({ animation: { duration: 300, easingFunction: 'easeInOutQuad' } })} title={t('縮放到整張圖，包含零散的小群組', 'Zoom to the whole graph, small detached groups included')}>
                    {t('整張圖', 'Whole graph')}
                  </button>
                </div>
              )}
              {layout !== 'done' && (
                <div className="gv-overlay muted small">
                  <StateWord icon={LoaderCircle} spin>
                    {t(`排版中 ${layout}%`, `Laying out ${layout}%`)}
                  </StateWord>
                </div>
              )}
            </>
          ) : (
            <div className="gv-empty">
              <EmptyState t={t} kind={kind} status={status} loadError={loadError ?? visError} loading={!!builtAt && !graph && !loadError} />
            </div>
          )}
        </div>
        <aside className="gv-panel" aria-label={t('圖譜詳細資料', 'Graph details')}>
          <StatusLine t={t} status={status} graph={graph} />
          {status?.exists && (status.state === 'failed' || status.state === 'refused') && status.lastError && (
            <div className="small warn-text gv-note">
              <Ico i={CircleAlert} size={14} /> {status.lastError}
            </div>
          )}
          <div className="row gap">
            <button type="button" className="btn small" onClick={rebuild} disabled={building || asking || !status?.active} title={kind === 'graphify' ? t('用 graphify update 重新解析這個資料夾的程式碼', 'Parse this folder again with graphify update') : t('用 codegraph sync 更新這個資料夾的索引，沒有索引時用 codegraph init 建立', 'Update the index of this folder with codegraph sync, or build it with codegraph init')}>
              <Ico i={building ? LoaderCircle : RefreshCw} size={14} className={building ? 'spin' : undefined} /> {building ? t('建立中', 'Building') : t('重新建立', 'Rebuild')}
            </button>
          </div>
          {graph && (
            <>
              <label className="gv-search">
                <Ico i={Search} size={14} />
                <input
                  type="search"
                  value={query}
                  placeholder={t('搜尋名稱或檔案', 'Search names or files')}
                  aria-label={t('搜尋節點', 'Search nodes')}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && matches[0]) {
                      e.preventDefault();
                      focus(matches[0].id);
                    }
                  }}
                />
              </label>
              {q && (
                <div className="gv-section">
                  <div className="am-label">{t(`找到 ${matches.length} 個`, `${matches.length} found`)}</div>
                  <ShowAll list={matches} limit={8}>
                    {(shown) => (
                      <ul className="gv-list">
                        {shown.map((n) => (
                          <li key={n.id}>
                            <NodeButton n={n} on={n.id === selected} onClick={() => focus(n.id)} />
                          </li>
                        ))}
                      </ul>
                    )}
                  </ShowAll>
                </div>
              )}
              {current ? (
                <NodeDetail t={t} node={current} neighbours={neighbours.get(current.id) ?? []} byId={byId} selected={selected} onFocus={focus} />
              ) : (
                !q && <div className="muted small">{t('點一下節點，或搜尋名稱，看它和誰相連。', 'Click a node, or search a name, to see what it connects to.')}</div>
              )}
            </>
          )}
        </aside>
      </div>
  );
}

function NodeButton({ n, on, onClick }: { n: GraphNode; on: boolean; onClick: () => void }) {
  return (
    <button type="button" className={cx('gv-node', on && 'on')} aria-pressed={on} onClick={onClick} title={placeOf(n) || n.label}>
      <span className="gv-dot" style={{ background: `var(--gv-c${(n.community ?? 0) % PALETTE})` }} aria-hidden="true" />
      <span className="gv-node-label">{n.label}</span>
      {n.source_file && <span className="gv-node-file muted mono">{placeOf(n)}</span>}
    </button>
  );
}

function NodeDetail({ t, node, neighbours, byId, selected, onFocus }: { t: T; node: GraphNode; neighbours: { id: string; relation: string; out: boolean }[]; byId: Map<string, GraphNode>; selected?: string; onFocus: (id: string) => void }) {
  // Grouped by what the relation means from this node, the busiest group first.
  const groups = new Map<string, GraphNode[]>();
  for (const x of neighbours) {
    const n = byId.get(x.id);
    if (!n) continue;
    const key = relationLabel(t, x.relation, x.out);
    const list = groups.get(key) ?? [];
    if (!list.includes(n)) list.push(n);
    groups.set(key, list);
  }
  const sorted = [...groups].sort((a, b) => b[1].length - a[1].length);
  return (
    <div className="gv-section gv-detail">
      <h4 className="gv-title">{node.label}</h4>
      {/* Where it lives: on a line of its own, so a long path wraps instead of squeezing a label beside it. */}
      {node.source_file && <div className="mono small gv-wrap gv-place" title={t('檔案與行號', 'File and line')}>{placeOf(node)}</div>}
      <dl className="dw-stats am-stats">
        {(node.community_name || node.community !== undefined) && (
          <div>
            <dt>{t('群組', 'Community')}</dt>
            <dd className="gv-wrap">
              <span className="gv-dot" style={{ background: `var(--gv-c${(node.community ?? 0) % PALETTE})` }} aria-hidden="true" /> {node.community_name ?? node.community}
            </dd>
          </div>
        )}
        <div>
          <dt>{t('連結', 'Links')}</dt>
          <dd className="num">{node.degree}</dd>
        </div>
      </dl>
      {sorted.length === 0 && <div className="muted small">{t('目前顯示的圖裡，它沒有相連的節點。', 'It has no linked nodes in the graph shown.')}</div>}
      {sorted.map(([label, list]) => (
        <div key={label} className="gv-group">
          <div className="am-label">
            {label} · <span className="num">{list.length}</span>
          </div>
          <ShowAll list={list} limit={6}>
            {(shown) => (
              <ul className="gv-list">
                {shown.map((n) => (
                  <li key={n.id}>
                    <NodeButton n={n} on={n.id === selected} onClick={() => onFocus(n.id)} />
                  </li>
                ))}
              </ul>
            )}
          </ShowAll>
        </div>
      ))}
    </div>
  );
}

function StatusLine({ t, status, graph }: { t: T; status: ViewStatus | null; graph?: GraphPayload }) {
  if (!status) return null;
  const nodes = graph?.totalNodes ?? status.nodes;
  const edges = graph?.totalLinks ?? status.edges;
  return (
    <div className="gv-status small">
      {status.state === 'building' && (
        <StateWord icon={LoaderCircle} spin className="small">
          {t('建立中', 'Building')}
        </StateWord>
      )}
      {status.exists && status.builtAt && (
        <div className="muted" title={[fullTime(status.builtAt), edges !== undefined ? t(`${edges} 條連結`, `${edges} links`) : '', status.communities ? t(`${status.communities} 個群組`, `${status.communities} communities`) : ''].filter(Boolean).join('\n')}>
          {t(`建立於 ${msgTime(status.builtAt)}`, `Built ${msgTime(status.builtAt)}`)}
          {nodes !== undefined && <span className="num">{t(` · ${nodes} 個節點`, ` · ${nodes} nodes`)}</span>}
        </div>
      )}
      {graph?.capped && <div className="muted num">{t(`顯示 ${graph.nodes.length} 個，共 ${graph.totalNodes} 個`, `Showing ${graph.nodes.length} of ${graph.totalNodes}`)}</div>}
    </div>
  );
}

/** No graph to draw: why, in one sentence, with what to do. */
function EmptyState({ t, kind, status, loadError, loading }: { t: T; kind: Kind; status: ViewStatus | null; loadError?: string; loading: boolean }) {
  const name = kind === 'graphify' ? 'Graphify' : 'CodeGraph';
  const noun = kind === 'graphify' ? t('圖譜', 'graph') : t('CodeGraph 索引', 'CodeGraph index');
  if (!status || !status.loaded || loading) return <StateWord icon={LoaderCircle} spin>{t('載入中', 'Loading')}</StateWord>;
  if (loadError) return <p>{t(`讀不到${noun}：${loadError}。按「重新建立」再試一次。`, `Could not read the ${noun}: ${loadError}. Press Rebuild to try again.`)}</p>;
  if (!status.enabled) return <p>{t(`${name} 沒有開啟：到設定的能力頁開啟 ${name}。`, `${name} is off: turn it on under Settings, Capabilities.`)}</p>;
  if (!status.active) return <p>{t(`${name} 還沒安裝好：到設定的能力頁看它的狀態，需要時按「重試」。`, `${name} is not installed yet: see its state under Settings, Capabilities, and press Retry if needed.`)}</p>;
  if (status.state === 'building') return <p>{t(`正在建立這個資料夾的${noun}，完成後會出現在這裡。`, `Building the ${noun} of this folder; it shows here when done.`)}</p>;
  if (status.state === 'failed' || status.state === 'refused') return <p>{t(`${noun}沒有建立成功：${status.lastError ?? ''} 修正後按「重新建立」。`, `The ${noun} was not built: ${status.lastError ?? ''} Fix that, then press Rebuild.`)}</p>;
  return <p>{t(`這個資料夾還沒有${noun}：按「重新建立」建立，或開始一個工作流時自動建立。`, `This folder has no ${noun} yet: press Rebuild, or start a workflow and it is built.`)}</p>;
}