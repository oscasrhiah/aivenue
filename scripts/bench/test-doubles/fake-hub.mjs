// Stand-in for the hub entry (scripts/test-bench.mjs).
//   FAKE_HUB_MODE: silent (default: accepts, never answers) | running (a workflow that runs forever and has seen no usage)
//   FAKE_PIDS: a file to append this process's pid to
//   FAKE_HUB_CONFIG: a file to write the config of workflows.start to
import * as fs from 'node:fs';
import * as http from 'node:http';
import { WebSocketServer } from 'ws';

if (process.env.FAKE_PIDS) fs.appendFileSync(process.env.FAKE_PIDS, `${process.pid}\n`);
const mode = process.env.FAKE_HUB_MODE ?? 'silent';
const started = Date.now();
const server = http.createServer((_, res) => res.end('fake'));
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => {
  if (mode === 'silent') return;
  ws.on('message', (m) => {
    const { id, method, params } = JSON.parse(String(m));
    if (method === 'workflows.start' && process.env.FAKE_HUB_CONFIG) fs.writeFileSync(process.env.FAKE_HUB_CONFIG, JSON.stringify(params.config));
    const result =
      method === 'workflows.start'
        ? 'wf1'
        : method === 'workflows.get'
          ? { id: 'wf1', status: 'running', agents: {}, stages: { implement: { rounds: [] } } }
          : method === 'workflows.cost'
            ? { wallMs: Date.now() - started, agentMs: 0, waitingMs: 0, rows: [], total: { uncachedInput: 0, cachedInput: 0, output: 0, events: 0 }, blocks: [], cut: [], turns: 0 }
            : true;
    ws.send(JSON.stringify({ id, result }));
  });
});
server.listen(0, '127.0.0.1', () => console.log(`Aivenue running: http://127.0.0.1:${server.address().port}/?token=fake`));
