// Run the hub without Electron and open the UI in any browser (handy for development).
import * as path from 'node:path';
import { startHub } from '@aivenue/core';

async function main() {
  const hub = await startHub({
    uiDir: path.join(__dirname, 'ui'),
    bridgePath: path.join(__dirname, 'bridge.cjs'),
    port: Number(process.env.PORT) || 0,
    // AIVENUE_HOST=vscode previews the VS Code layout in a browser (development only).
    hooks: { host: (process.env.AIVENUE_HOST === 'vscode' ? 'vscode' : 'browser') as 'browser', defaultCwd: () => process.env.AIVENUE_CWD || process.cwd() },
  });
  console.log(`Aivenue running: ${hub.uiUrl}`);
  const stop = async () => {
    await hub.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
