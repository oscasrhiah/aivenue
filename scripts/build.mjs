// Builds every package: UI (Vite), MCP bridge, desktop (Electron) and VS Code extension (esbuild).
//   node scripts/build.mjs            full build
//   node scripts/build.mjs --hub-only skip the UI (backend testing)
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = (p) => path.join(root, 'packages', p);
const hubOnly = process.argv.includes('--hub-only');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: 'linked',
  logLevel: 'warning',
  // optional native accelerators of `ws`
  external: ['bufferutil', 'utf-8-validate'],
};

const t0 = Date.now();

if (!hubOnly) {
  console.log('• UI (vite)');
  execSync('npx vite build', { cwd: pkg('ui'), stdio: 'inherit' });
}

console.log('• MCP bridge');
await build({ ...common, entryPoints: [path.join(pkg('bridge'), 'src/index.ts')], outfile: path.join(pkg('bridge'), 'dist/bridge.cjs'), sourcemap: false });

console.log('• desktop');
await build({ ...common, entryPoints: [path.join(pkg('desktop'), 'src/main.ts')], outfile: path.join(pkg('desktop'), 'dist/main.cjs'), external: [...common.external, 'electron'] });
await build({ ...common, entryPoints: [path.join(pkg('desktop'), 'src/standalone.ts')], outfile: path.join(pkg('desktop'), 'dist/standalone.cjs') });

console.log('• vscode extension');
await build({ ...common, entryPoints: [path.join(pkg('vscode'), 'src/extension.ts')], outfile: path.join(pkg('vscode'), 'dist/extension.js'), external: [...common.external, 'vscode'] });

// Copy shared artifacts next to each shell.
const copy = (from, to) => {
  if (!fs.existsSync(from)) return;
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true });
};
for (const shell of ['desktop', 'vscode']) {
  copy(path.join(pkg('bridge'), 'dist/bridge.cjs'), path.join(pkg(shell), 'dist/bridge.cjs'));
  copy(path.join(pkg('ui'), 'dist'), path.join(pkg(shell), 'dist/ui'));
}

console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
