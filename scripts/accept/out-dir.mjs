// The output folder of an acceptance script: emptied only when it is safe to (the same rule as ubuntu-verify.sh).
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** The file that marks a folder as an acceptance script's output: the next run may empty it. */
export const OUT_MARK = '.aivenue-acceptance-output';

/** Whether `child` is `parent` or inside it (paths resolved; Windows ignores case). */
function within(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Make `dirArg` an empty output folder and mark it. A folder is emptied only when it is new, empty, or an earlier
 * output folder of an acceptance script (it holds OUT_MARK). Anything else is refused with a message and exit code 2,
 * so a mistyped path never deletes someone's files: a non-empty folder without the mark, a drive root, the home
 * folder or a folder above it, and a folder that holds `keep` (this repository).
 */
export function prepareOutDir(dirArg, keep) {
  const dir = path.resolve(dirArg);
  const refuse = (why) => {
    console.error(`Refusing to use ${dir} as the output folder: ${why}. Choose a new or empty folder.`);
    process.exit(2);
  };
  if (path.parse(dir).root === dir) refuse('it is a drive root');
  if (within(path.resolve(os.homedir()), dir)) refuse('it is the home folder or holds it');
  if (keep && within(path.resolve(keep), dir)) refuse('it holds this repository');
  if (fs.existsSync(dir)) {
    if (!fs.statSync(dir).isDirectory()) refuse('it is a file');
    const entries = fs.readdirSync(dir);
    if (entries.length && !entries.includes(OUT_MARK)) refuse(`it is not empty and was not made by an acceptance script (no ${OUT_MARK} in it)`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, OUT_MARK), 'Output of an Aivenue acceptance script: the next run of one empties this folder.\n');
  return dir;
}
