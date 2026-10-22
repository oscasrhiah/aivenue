import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ResolvedMcpServer } from './capabilities';
import { childEnv, resolveCommand } from './proc';

/** Connect to an MCP server once and list its tools, to check a shared server's configuration. */
export async function probeMcpServer(s: ResolvedMcpServer, timeoutMs = 30000): Promise<{ name: string; description?: string }[]> {
  const client = new Client({ name: 'aivenue-probe', version: '0.1.0' });
  let transport;
  if (s.transport === 'http') {
    transport = new StreamableHTTPClientTransport(new URL(s.url!), { requestInit: { headers: s.headers } });
  } else {
    const resolved = resolveCommand(s.command!);
    if (!resolved) throw new Error(`command not found: ${s.command}`);
    const env = Object.fromEntries(Object.entries(childEnv(s.env)).filter((e): e is [string, string] => typeof e[1] === 'string'));
    transport = new StdioClientTransport({ command: resolved.file, args: [...resolved.prefixArgs, ...(s.args ?? [])], env, stderr: 'pipe' });
  }
  const timer = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${timeoutMs / 1000}s`)), timeoutMs));
  try {
    await Promise.race([client.connect(transport), timer]);
    const res = await Promise.race([client.listTools(), timer]);
    return res.tools.map((t) => ({ name: t.name, description: t.description }));
  } finally {
    await client.close().catch(() => undefined);
  }
}
