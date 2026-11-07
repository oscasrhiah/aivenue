// Writes a small Aivenue data folder (AIVENUE_HOME) for the Linux package acceptance: three finished workflows that
// the app should list after an install, upgrade or reinstall, and a file of the user's own.
//   node scripts/linux-accept/make-data.mjs <AIVENUE_HOME>
import * as fs from 'node:fs';
import * as path from 'node:path';

const home = process.argv[2];
if (!home) throw new Error('usage: make-data.mjs <dir>');
const stage = (provider) => ({ enabled: true, author: { provider }, reviewer: null, maxRounds: 1, humanGate: false });
const t0 = Date.UTC(2026, 10, 1, 8, 0, 0);
const ids = [];
for (let i = 0; i < 3; i++) {
  const id = `2026110108000${i}-acc${i}00`;
  ids.push(id);
  const run = {
    id,
    config: {
      cwd: '/tmp/aivenue-acceptance-project',
      title: `Linux acceptance history ${i + 1}`,
      goal: `Kept across install, upgrade and uninstall (${i + 1})`,
      plan: { ...stage('codex'), enabled: false },
      implement: stage('codex'),
      subagents: { enabled: false, allowed: [], maxDepth: 1, maxConcurrent: 1 },
    },
    status: 'completed',
    createdAt: t0 + i * 60_000,
    updatedAt: t0 + i * 60_000 + 30_000,
    endedAt: t0 + i * 60_000 + 30_000,
    stages: [],
    steps: [],
    agents: {},
    log: [],
    notes: [],
    outputs: [],
  };
  fs.mkdirSync(path.join(home, 'runs', id, 'events'), { recursive: true });
  fs.writeFileSync(path.join(home, 'runs', id, 'run.json'), JSON.stringify(run, null, 2));
}
fs.mkdirSync(path.join(home, 'my-own'), { recursive: true });
fs.writeFileSync(path.join(home, 'my-own', 'notes.bin'), Buffer.from([0, 1, 2, 255, 254, 10, 13, 0xe4, 0xbd, 0xa0]));
console.log(ids.join(' '));
