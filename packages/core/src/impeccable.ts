import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/*
 * impeccable (https://github.com/pbakaus/impeccable, Apache-2.0): a design skill for frontend work plus its engine (a
 * self-contained binary the skill's launcher runs: `context`, `detect`, `concept-seed`…). Aivenue ships the skill files
 * (packages/core/bundled/impeccable, from the release tag skill-v4.8.0) and installs the matching engine with npm into its
 * own tools folder: the `impeccable` package pulls the platform binary (@impeccable/cli-<os>-<arch>) as an optional
 * dependency, integrity-checked by npm. `npx impeccable install` (which copies the skill into the project's or the
 * user's agent folders and can add hooks) is never run: Aivenue offers the skill per run from its own skills folder.
 */

/** The npm package and version Aivenue installs (released 2026-10-26; 4.8.1 was too new to pin). Its engine is 0.1.18. */
export const IMPECCABLE_PACKAGE = 'impeccable';
export const IMPECCABLE_VERSION = '4.8.0';

export const impeccableDir = (toolsDir: string) => path.join(toolsDir, 'impeccable');

/** The engine binary npm put in Aivenue's copy for this platform, e.g. node_modules/@impeccable/cli-windows-x64/bin/impeccable.exe. */
export function impeccableEngine(toolsDir: string): string {
  const os = process.platform === 'win32' ? 'windows' : process.platform;
  return path.join(impeccableDir(toolsDir), 'node_modules', '@impeccable', `cli-${os}-${process.arch}`, 'bin', process.platform === 'win32' ? 'impeccable.exe' : 'impeccable');
}

/** Aivenue's own record of impeccable's settings (telemetry off; the salt of its seed references), in its tools folder. */
const settingsFile = (toolsDir: string) => path.join(impeccableDir(toolsDir), 'aivenue-settings.json');

function settings(toolsDir: string): { telemetry: false; seedSalt: string } {
  try {
    const s = JSON.parse(fs.readFileSync(settingsFile(toolsDir), 'utf8'));
    if (typeof s.seedSalt === 'string' && s.seedSalt) return { telemetry: false, seedSalt: s.seedSalt };
  } catch {
    // written below
  }
  const next = { telemetry: false as const, seedSalt: crypto.randomBytes(16).toString('hex') };
  try {
    fs.mkdirSync(impeccableDir(toolsDir), { recursive: true });
    fs.writeFileSync(settingsFile(toolsDir), JSON.stringify(next, null, 2) + '\n');
  } catch {
    // still returned for this run
  }
  return next;
}

/**
 * The environment of the commands agents run while impeccable is on (the skill's launcher reads it): Aivenue's engine,
 * no usage statistics, no update or staleness check, and every file impeccable keeps for itself under Aivenue's tools
 * folder instead of ~/.impeccable. What it cannot turn off: a new design direction (`concept-seed`, only after
 * PRODUCT.md exists) asks https://impeccable.style/api for one, with the telemetry header set to off.
 */
export function impeccableEnv(toolsDir: string): Record<string, string> {
  const dir = impeccableDir(toolsDir);
  return {
    IMPECCABLE_BIN: impeccableEngine(toolsDir),
    // Where the launcher would download an engine if IMPECCABLE_BIN were missing (it never is when installed).
    IMPECCABLE_HOME: path.join(dir, 'home'),
    DO_NOT_TRACK: '1',
    IMPECCABLE_NO_TELEMETRY: '1',
    IMPECCABLE_NO_UPDATE_CHECK: '1',
    IMPECCABLE_UPDATE_CACHE: path.join(dir, 'state', 'update-check.json'),
    IMPECCABLE_NO_STALENESS_CHECK: '1',
    IMPECCABLE_STALENESS_CACHE: path.join(dir, 'state', 'staleness-check.json'),
    // Else the engine creates ~/.impeccable/seed-salt on the first design direction.
    IMPECCABLE_SEED_SALT: settings(toolsDir).seedSalt,
  };
}
