/*
 * Every hub method that changes something is in exactly one of the groups below, by what it actually does (not by
 * how its name sounds); scripts/test-hub-share.mjs checks that no method of hub.ts is left out. A read-only method
 * (hub.ts READ_ONLY) is in none.
 */

/**
 * Calls whose effect is outside Aivenue's own records, or makes something new each time, and would happen again if
 * they ran twice: a second copy of an upload, a second account, an install, sign-in, test run or dialog started
 * again. For these, a call whose answer was lost (the connection dropped, or the hub stopped) has an unknown result:
 * the page does not send it again by itself (api.ts), and the hub writes in its operation log that it started before
 * it runs; if that cannot be written it does not run (opLog.ts). A resend after a hub restart is answered "result
 * unknown" instead of running again. The user checks and tries again.
 */
export const NOT_REPLAYED = new Set([
  // a new file, account or provider each time
  'attachments.upload',
  'providers.addAccount',
  'catalog.add',
  'workflows.export',
  'workflows.exportPdf',
  // a program, a sign-in, a network call or a test run started again
  'providers.install',
  'providers.uninstall',
  'providers.login',
  'providers.logout',
  'providers.test',
  'github.install',
  'github.login',
  'github.logout',
  'quota.antigravity.connect',
  'extensions.omniConnect',
  'extensions.omniOpenRouter',
  'extensions.omniTest',
  'extensions.omniCheckModels',
  'extensions.omniOnlyChecked',
  'extensions.retry',
  'capabilities.testServer',
  'capabilities.addPreset',
  'skills.import',
  // a dialog or a window opened again
  'host.pickFolder',
  'attachments.pick',
  'host.openPath',
  'host.openExternal',
  'files.open',
  'skills.openFolder',
]);

/**
 * Calls that change a workflow: the operation and its answer are written into that workflow's run.json with the change
 * (store.ts), so a resend after a hub stop gets the answer instead of running again. (workflows.delete removes the
 * run: a resend finds no workflow and changes nothing.)
 */
export const RECORDED_WITH_RUN = new Set([
  'workflows.start',
  'workflows.cancel',
  'workflows.pause',
  'workflows.resume',
  'workflows.resumeInterrupted',
  'workflows.say',
  'workflows.continueDenied',
  'workflows.edit',
  'workflows.updateConfig',
  'workflows.compactShared',
  'workflows.organizeShared',
  'workflows.compactAgent',
  'workflows.contextAsk',
  'workflows.compactFailed',
  'workflows.decide',
  'workflows.approve',
  'workflows.worktree',
  'workflows.delete',
  'workflows.rename',
  'workflows.setMemoryMode',
  'agents.stop',
  'agents.close',
  'agents.rerun',
]);

/**
 * Calls that give the same result when done twice: they set a value, save or remove something by its name or id, or
 * carry their own request id (workflows.remember). The operation log alone is enough for them.
 */
export const SAME_TWICE = new Set([
  'settings.set',
  // Sets the desktop window's icon to the light or the dark one.
  'host.appearance',
  'quota.antigravity.disconnect',
  'attachments.discard',
  'capabilities.saveServer',
  'capabilities.deleteServer',
  'capabilities.setInstructions',
  'extensions.setEnabled',
  // Removes the copy Aivenue installed and turns the extension off: twice leaves the same.
  'extensions.uninstall',
  'extensions.setOptions',
  'extensions.setPackSkill',
  'extensions.refresh',
  'extensions.omniPassword',
  'extensions.omniCandidates',
  'extensions.omniPin',
  'extensions.omniDisconnect',
  'github.enableMcp',
  'skills.save',
  'skills.delete',
  'skills.set',
  'skills.approve',
  'skills.approveProject',
  'skills.disableProject',
  'providers.refresh',
  'providers.save',
  'providers.delete',
  'providers.setOrder',
  'providers.setColor',
  'providers.setQuotaCap',
  'providers.removeAccount',
  'providers.reset',
  'providers.setAuthMode',
  'providers.setApiKey',
  'providers.setDefaults',
  'presets.save',
  'presets.delete',
  'workflows.distilSkill',
  'workflows.remember',
  'memory.update',
  'memory.delete',
  'memory.relink',
  'agents.switchTargets',
  // Builds the folder's graph again: twice gives the same graph (a build asked for during one is folded into one more).
  'graphify.rebuild',
  // The same for the CodeGraph index (init when missing, else sync).
  'codegraph.rebuild',
]);
