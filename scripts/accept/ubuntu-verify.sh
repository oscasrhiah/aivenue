#!/bin/bash
# Build and accept the Linux package on one Ubuntu machine, as a normal user (no sudo):
#   bash ubuntu-verify.sh <bundle> <expected full commit> <expected version> <out dir>
# 1. Clones the branch release-<expected version> (BRANCH to change) from the bundle and checks its head is the expected
#    commit and its version is the expected one.
# 2. npm ci, typecheck.
# 3. The whole test suite twice from the same checkout: `npm test` (the parallel runner) and a direct
#    `node --test scripts/test-*.mjs`; compare-runs.mjs compares totals and every test's name, status and count.
# 4. npm run package:linux, SHA-256 of the package.
# 5. Starts that package (unpacked, its own aivenue.sh) with an empty AIVENUE_HOME and a debugging port, and
#    capabilities-check.mjs reads back version, build and data folder, and checks Settings → Capabilities.
# 6. wake-check.mjs, on this checkout's own hub (not the package): OpenCode (a free model) ends its turn to wait for a
#    background job, Aivenue wakes it once when the job ends, in the same session, and it reads the job's output and
#    submits it; also writes a timeline (results/wake/wake-timeline-*.md). SKIP_WAKE=1 skips it.
# Needs git, Node.js 24, npm, OpenCode on PATH (its free model needs no sign-in, only the network), and a desktop session
# (DISPLAY). Writes logs and a summary to <out dir>/results.
set -u
HERE=$(dirname "$(readlink -f "$0")")
if [ $# -ne 4 ]; then echo "usage: bash ubuntu-verify.sh <bundle> <expected full commit> <expected version> <out dir>" >&2; exit 2; fi
BUNDLE=$(readlink -f "$1"); WANT=$2; WANTV=$3; OUT=$(readlink -m "$4")
BRANCH=${BRANCH:-release-$WANTV}; PORT=${ACC_PORT:-9232}
if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ] && [ ! -f "$OUT/.aivenue-verify" ]; then
  echo "Refusing to use $OUT: it is not empty and was not made by this script" >&2; exit 2
fi
rm -rf "$OUT"; mkdir -p "$OUT/results"; touch "$OUT/.aivenue-verify"
R=$OUT/results; SUM=$R/summary.txt
say() { echo "$*" | tee -a "$SUM"; }
step() { local name=$1; shift; echo; echo "=== $name"; if "$@" > "$R/$name.log" 2>&1; then say "PASS  $name"; else say "FAIL  $name (see results/$name.log)"; fi; }

say "Aivenue $WANTV Linux verification ($WANT) — $(date -u +%Y-%m-%dT%H:%MZ)"
say "System: $(lsb_release -ds 2>/dev/null || uname -o) / $(uname -srm); $(nproc) cores; Node $(node -v); npm $(npm -v); git $(git --version | cut -d' ' -f3)"
say "User namespaces: $(unshare --user --map-root-user true 2>/dev/null && echo allowed || echo restricted); DISPLAY=${DISPLAY:-unset}"

git clone -q -b "$BRANCH" "$BUNDLE" "$OUT/src" || { say "FAIL  clone the bundle"; exit 1; }
HEAD=$(git -C "$OUT/src" rev-parse HEAD)
if [ "$HEAD" = "$WANT" ]; then say "PASS  branch head is the expected commit $HEAD"; else say "FAIL  branch head $HEAD, expected $WANT"; fi
cd "$OUT/src" || exit 1
V=$(node -p "require('./packages/desktop/package.json').version")
if [ "$V" = "$WANTV" ]; then say "PASS  version is the expected $V"; else say "FAIL  version $V, expected $WANTV"; fi

step npm-ci npm ci
step typecheck npm run typecheck
# Both test entry points, one after the other on the same checkout (each uses the whole machine).
step test-npm env AIVENUE_TEST_VERBOSE=1 npm test
say "      npm test: $(grep -E '^ℹ (tests|pass|fail|skipped|todo) ' "$R/test-npm.log" | tail -n 5 | tr '\n' ' ')"
step test-direct sh -c 'node --test --test-reporter=spec scripts/test-*.mjs'
say "      direct:   $(grep -E '^ℹ (tests|pass|fail|skipped|todo) ' "$R/test-direct.log" | tail -n 5 | tr '\n' ' ')"
step test-compare node "$HERE/compare-runs.mjs" "$R/test-direct.log" "$R/test-npm.log"
say "      $(grep -E '^test lines' "$R/test-compare.log")"

mkdir -p release
step package-linux npm run package:linux
PKG=release/Aivenue-$WANTV-linux-x64.tar.gz
if [ ! -f "$PKG" ]; then say "FAIL  no package at $PKG"; else
  (cd release && sha256sum "Aivenue-$WANTV-linux-x64.tar.gz" > SHA256SUMS.txt)
  SHA=$(cut -d' ' -f1 release/SHA256SUMS.txt)
  cp "$PKG" release/SHA256SUMS.txt "$R/"
  say "Package: $(basename "$PKG"), $(stat -c %s "$PKG") bytes, SHA-256 $SHA"
  # Start it from the unpacked package, as a user would after unpacking (install.sh is unchanged since 0.3.1).
  mkdir -p "$OUT/app" "$OUT/home"; tar -xzf "$PKG" -C "$OUT/app"; D=$(ls -d "$OUT"/app/*/ | head -n 1); D=${D%/}
  (AIVENUE_HOME="$OUT/home" setsid "$D/aivenue.sh" --remote-debugging-port="$PORT" > "$R/app.log" 2>&1 &)
  step capabilities env WANT_DATA_DIR="$OUT/home" WANT_VERSION="$WANTV" node "$HERE/capabilities-check.mjs" "$PORT" "$WANT" "$R" linux
  grep -E '^  (PASS|FAIL)' "$R/capabilities.log" | sed 's/^/      /' | tee -a "$SUM" > /dev/null
  # Close the main process only (the one without --type=); it ends its own helper processes. Killing the helpers at the
  # same time makes the main process log "GPU process isn't usable" and abort.
  MAIN=$(pgrep -af "^$D/aivenue" | grep -v -- ' --type=' | cut -d' ' -f1)
  [ -n "$MAIN" ] && kill -TERM $MAIN 2>/dev/null; for _ in $(seq 1 15); do pgrep -f "^$D/aivenue" > /dev/null || break; sleep 1; done
  pkill -KILL -f "^$D/aivenue" 2>/dev/null; sleep 1
  if [ "$(pgrep -fc "^$D/aivenue")" = 0 ]; then say "PASS  app closed"; else say "FAIL  app processes left"; fi
  if grep -q FATAL "$R/app.log"; then say "FAIL  app.log has a FATAL line"; else say "PASS  app.log has no FATAL line"; fi
fi
# 6. A real CLI (OpenCode only, a free model) waits for a small background job by ending its turn: Aivenue must wake it
#    when the job ends, and it must read the job's output and submit it. Uses this checkout's own hub (built above).
if [ "${SKIP_WAKE:-}" = 1 ]; then say "SKIP  wake check (SKIP_WAKE=1)"; else
  step wake node "$HERE/wake-check.mjs" "$OUT/src" "$R/wake"
  grep -E '^  (PASS|FAIL)' "$R/wake.log" | sed 's/^/      /' | tee -a "$SUM" > /dev/null
fi
echo; echo "Summary: $SUM"; cat "$SUM"
! grep -q '^FAIL' "$SUM"
