// Launched by each agent CLI as an MCP server (stdio). It forwards Aivenue tool calls to the
// Aivenue process over localhost, identified by the per-agent session secret.
// For CLIs that only support a static MCP config (Antigravity, Gemini), it also proxies the
// user's shared MCP servers, exposing their tools as "<server>__<tool>".
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { childEnv, resolveCommand } from '../../core/src/proc';
import type { ResolvedMcpServer } from '../../core/src/capabilities';

// A static registration may pass unexpanded "$VAR" strings; treat them as unset.
const env = (k: string) => {
  const v = process.env[k];
  return v && !v.startsWith('$') ? v : undefined;
};
const HUB = env('AIVENUE_URL');
const SESSION = env('AIVENUE_SESSION') ?? '';
const PROXY = env('AIVENUE_PROXY') === '1';

async function hub(pathname: string, body?: unknown): Promise<any> {
  if (!HUB) throw new Error('AIVENUE_URL is not set');
  const res = await fetch(HUB + pathname, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json', 'x-aivenue-session': SESSION },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.json();
}

interface Proxied {
  name: string;
  client: Client;
  tools: Tool[];
}

let proxied: Promise<Proxied[]> | undefined;

/** Connect to the shared servers once (lazily) and remember their tools. */
function proxiedServers(): Promise<Proxied[]> {
  proxied ??= (async () => {
    if (!PROXY || !HUB) return [];
    const { servers } = (await hub('/bridge/servers').catch(() => ({ servers: [] }))) as { servers: ResolvedMcpServer[] };
    const out: Proxied[] = [];
    await Promise.all(
      (servers ?? []).map(async (s) => {
        try {
          const client = new Client({ name: 'aivenue-proxy', version: '0.1.0' });
          if (s.transport === 'http') {
            await client.connect(new StreamableHTTPClientTransport(new URL(s.url!), { requestInit: { headers: s.headers } }));
          } else {
            const r = resolveCommand(s.command!);
            if (!r) throw new Error(`command not found: ${s.command}`);
            const e = Object.fromEntries(Object.entries(childEnv(s.env)).filter((x): x is [string, string] => typeof x[1] === 'string'));
            await client.connect(new StdioClientTransport({ command: r.file, args: [...r.prefixArgs, ...(s.args ?? [])], env: e, stderr: 'ignore' }));
          }
          const { tools } = await client.listTools();
          out.push({ name: s.name, client, tools });
        } catch (e) {
          process.stderr.write(`aivenue proxy: ${s.name} failed: ${(e as Error).message}\n`);
        }
      }),
    );
    return out;
  })();
  return proxied;
}

async function main() {
  const server = new Server({ name: 'aivenue', version: '0.1.0' }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const own = HUB ? await hub('/bridge/tools').then((r) => r.tools ?? []).catch(() => []) : [];
    const extra = (await proxiedServers()).flatMap((p) => p.tools.map((t) => ({ ...t, name: `${p.name}__${t.name}`, description: `[${p.name}] ${t.description ?? ''}` })));
    return { tools: [...own, ...extra] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = req.params.name;
    const sep = name.indexOf('__');
    if (sep > 0) {
      const target = (await proxiedServers()).find((p) => p.name === name.slice(0, sep));
      if (target) return target.client.callTool({ name: name.slice(sep + 2), arguments: req.params.arguments ?? {} });
    }
    try {
      const r = await hub('/bridge/call', { name, arguments: req.params.arguments ?? {} });
      if (r.error) return { content: [{ type: 'text', text: `Error: ${r.error}` }], isError: true };
      return { content: [{ type: 'text', text: String(r.text ?? '') }] };
    } catch (e) {
      return { content: [{ type: 'text', text: `Aivenue is unreachable: ${(e as Error).message}` }], isError: true };
    }
  });

  await server.connect(new StdioServerTransport());
  const shutdown = async () => {
    for (const p of await (proxied ?? Promise.resolve([]))) await p.client.close().catch(() => undefined);
    process.exit(0);
  };
  process.stdin.on('close', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  process.stderr.write(`aivenue bridge failed: ${e?.stack ?? e}\n`);
  process.exit(1);
});
