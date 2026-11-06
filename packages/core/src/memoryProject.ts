import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { lockName, withOsLock } from './osLock';

/**
 * Which project and checkout a folder belongs to (docs/memory-phase1.md §1). Worktrees of one repository share a
 * project (by the git common directory); clones are not merged by their remote; a non-git folder is its own project;
 * the same path on another machine, WSL distribution or SSH host is another project.
 */

export interface ProjectRecord {
  id: string;
  /** The git common directory, or the folder itself when it is not in a git repository. */
  key: string;
  kind: 'git' | 'folder';
  hostId: string;
  createdAt: number;
  /** A name to show (the repository's or the folder's). */
  label: string;
  /** Its checkouts seen so far (main working tree, worktrees), to show each one's verification state. */
  checkouts?: { id: string; root: string }[];
}

export interface ProjectIdentity {
  projectId: string;
  /** The checkout (main working tree or a worktree) the folder is in. */
  checkoutId: string;
  checkoutRoot: string;
  kind: 'git' | 'folder';
  hostId: string;
}

let cachedHost: string | undefined;

/** This machine (its machine id), and the WSL distribution or SSH login the hub runs in. */
export function hostId(): string {
  if (cachedHost) return cachedHost;
  let machine = '';
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      machine = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(out)?.[1] ?? '';
    } else {
      machine = ['/etc/machine-id', '/var/lib/dbus/machine-id'].map((f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : '')).find(Boolean) ?? '';
    }
  } catch {
    // fall back to the host name below
  }
  machine ||= `name:${os.hostname()}`;
  const wsl = process.env.WSL_DISTRO_NAME;
  const ssh = process.env.SSH_CONNECTION ? `${os.userInfo().username}@${os.hostname()}` : '';
  cachedHost = wsl ? `wsl:${wsl}:${machine}` : ssh ? `ssh:${ssh}:${machine}` : `local:${machine}`;
  return cachedHost;
}

/** The real path (no junction or link aliases), with Windows' case and separators made uniform. */
export function normalizePath(p: string): string {
  let real = path.resolve(p);
  try {
    real = fs.realpathSync.native(real);
  } catch {
    // keep the resolved path when it does not exist
  }
  return process.platform === 'win32' ? real.replace(/\//g, '\\').toLowerCase() : real;
}

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The repository (common directory) and checkout a folder is in, or the folder itself. */
export function locate(cwd: string): { key: string; kind: 'git' | 'folder'; checkoutRoot: string; label: string } {
  const common = git(cwd, ['rev-parse', '--git-common-dir']);
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (common && top) {
    const key = normalizePath(path.resolve(cwd, common));
    // The main checkout's .git folder sits in it: name the project after that folder.
    const label = path.basename(path.basename(key) === '.git' ? path.dirname(key) : key.replace(/\.git$/i, ''));
    return { key, kind: 'git', checkoutRoot: normalizePath(top), label };
  }
  const key = normalizePath(cwd);
  return { key, kind: 'folder', checkoutRoot: key, label: path.basename(key) };
}

export const checkoutIdOf = (host: string, root: string) => `c_${createHash('sha1').update(`${host}\0${root}`).digest('hex').slice(0, 16)}`;

const projectsFile = (dataDir: string) => path.join(dataDir, 'memory', 'projects.json');

function readProjects(dataDir: string): ProjectRecord[] {
  const f = projectsFile(dataDir);
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')).projects as ProjectRecord[]) : [];
}

function writeProjects(dataDir: string, projects: ProjectRecord[]) {
  const f = projectsFile(dataDir);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify({ projects }, null, 1));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, f);
}

/** Look up or create a folder's project, in one hold of the global lock (two hubs opening it at once get one id). */
export async function resolveProject(dataDir: string, cwd: string, o: { host?: string } = {}): Promise<ProjectIdentity> {
  const host = o.host ?? hostId();
  const where = locate(cwd);
  const id = await withOsLock(lockName(dataDir, 'projects'), () => {
    const projects = readProjects(dataDir);
    const checkout = { id: checkoutIdOf(host, where.checkoutRoot), root: where.checkoutRoot };
    const found = projects.find((p) => p.key === where.key && p.hostId === host);
    if (found) {
      if (!found.checkouts?.some((c) => c.id === checkout.id)) {
        (found.checkouts ??= []).push(checkout);
        writeProjects(dataDir, projects);
      }
      return found.id;
    }
    const rec: ProjectRecord = { id: `p_${randomUUID().replace(/-/g, '').slice(0, 16)}`, key: where.key, kind: where.kind, hostId: host, createdAt: Date.now(), label: where.label, checkouts: [checkout] };
    writeProjects(dataDir, [...projects, rec]);
    return rec.id;
  });
  return { projectId: id, checkoutId: checkoutIdOf(host, where.checkoutRoot), checkoutRoot: where.checkoutRoot, kind: where.kind, hostId: host };
}

/** Look a folder's project up without creating anything (read-only use): undefined when it has none yet. */
export function findProject(dataDir: string, cwd: string, o: { host?: string } = {}): ProjectIdentity | undefined {
  const host = o.host ?? hostId();
  const where = locate(cwd);
  const found = readProjects(dataDir).find((p) => p.key === where.key && p.hostId === host);
  return found && { projectId: found.id, checkoutId: checkoutIdOf(host, where.checkoutRoot), checkoutRoot: where.checkoutRoot, kind: where.kind, hostId: host };
}

export function listProjects(dataDir: string): ProjectRecord[] {
  return readProjects(dataDir);
}

/** A project that moved: point it at its new folder, keeping its memory. Refused when that folder already has one. */
export async function relinkProject(dataDir: string, projectId: string, cwd: string, o: { host?: string } = {}): Promise<ProjectRecord> {
  const host = o.host ?? hostId();
  const where = locate(cwd);
  return withOsLock(lockName(dataDir, 'projects'), () => {
    const projects = readProjects(dataDir);
    const rec = projects.find((p) => p.id === projectId);
    if (!rec) throw new Error('project not found');
    const other = projects.find((p) => p.id !== projectId && p.key === where.key && p.hostId === host);
    if (other) throw new Error(`that folder already belongs to project ${other.label}`);
    // Its old checkouts are elsewhere now: the new ones register as workflows run there.
    Object.assign(rec, { key: where.key, kind: where.kind, hostId: host, label: where.label, checkouts: [] });
    writeProjects(dataDir, projects);
    return rec;
  });
}
