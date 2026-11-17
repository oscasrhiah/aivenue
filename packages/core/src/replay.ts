/**
 * Calls whose effect is outside Aivenue's own records and would happen again if they ran twice: a second copy of an
 * upload, an install or sign-in started again, a dialog or a window opened again. For these, a call whose answer was
 * lost (the connection dropped, or the hub stopped) has an unknown result: the page does not send it again by itself
 * (api.ts), and the hub writes in its operation log that it started before it runs, so a resend after a hub restart is
 * answered "result unknown" instead of running again (opLog.ts). The user checks and tries again.
 *
 * Not here: calls that change a workflow (their operation is recorded with the workflow, store.ts), and settings or
 * saves by name or id, which give the same result when done twice.
 */
export const NOT_REPLAYED = new Set([
  'attachments.upload',
  'attachments.pick',
  'providers.install',
  'providers.uninstall',
  'providers.login',
  'providers.logout',
  'github.install',
  'github.login',
  'github.logout',
  'quota.antigravity.connect',
  'extensions.omniConnect',
  'skills.import',
  'capabilities.addPreset',
  'host.pickFolder',
  'host.openPath',
  'host.openExternal',
  'files.open',
]);
