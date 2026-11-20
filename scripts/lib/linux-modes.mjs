// The Unix mode of a file in the Linux package (scripts/package-linux.mjs builds its tar on Windows, which has no execute
// bit, so every mode is decided here).
//   - the app's own programs and scripts at the top of the package (EXEC);
//   - a bundled skill's script that agents are told to run: under dist/bundled/, in a scripts/ folder, starting with #!
//     (impeccable's scripts/impeccable launcher, Agent Skills' audit-a11y.sh…). Data files there stay 0644.

export const EXEC = new Set(['aivenue', 'chrome_crashpad_handler', 'chrome-sandbox', 'aivenue.sh', 'install.sh', 'uninstall.sh']);

/**
 * @param {string} rel  the path inside the package folder, with forward slashes (e.g. "resources/app.asar.unpacked/dist/bundled/x/scripts/run")
 * @param {Buffer | Uint8Array} head  the file's first bytes (two are enough)
 */
export function fileMode(rel, head) {
  if (!rel.includes('/') && EXEC.has(rel)) return 0o755;
  const parts = rel.split('/');
  const b = parts.indexOf('bundled');
  if (b >= 0 && parts[b - 1] === 'dist' && parts.slice(b + 1, -1).includes('scripts') && head?.[0] === 0x23 && head?.[1] === 0x21) return 0o755;
  return 0o644;
}
