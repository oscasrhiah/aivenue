#!/bin/bash
# Build and accept one Linux package on one Ubuntu machine, as a normal user (no sudo):
#   [BRANCH=release-0.3.1] [BASE_TAG=v0.3.0] bash ubuntu-verify.sh <bundle> <expected commit> <Aivenue-0.2.4-linux-x64.tar.gz> <out dir> [<previous package with a file list>]
# 1. Clones BRANCH from the bundle (to build) and BASE_TAG (the published version without the EPIPE fix, for comparison).
# 2. EPIPE: capture() reproduction on BASE_TAG and on the branch; the regression test; test-orchestrator 10 times.
# 3. npm ci, typecheck, the whole test suite (scripts/run-tests.mjs: every core, the slow files split), package:linux,
#    SHA-256 of the package.
# 4. scripts/linux-accept/accept.sh on that same package (needs an X display: a desktop session, or Xvfb); with the
#    5th argument (e.g. the published Aivenue-0.3.0-linux-x64.tar.gz) also case T, the upgrade from that version.
# Needs git, Node.js 24 and npm on PATH. Writes logs and a summary to <out dir>/results.
set -u
BUNDLE=$(readlink -f "$1"); WANT=$2; OLD=$(readlink -f "$3"); OUT=$(readlink -m "$4"); PREV=${5:+$(readlink -f "$5")}
BRANCH=${BRANCH:-release-0.3.1}; BASE_TAG=${BASE_TAG:-v0.3.0}
if [ -e "$OUT" ] && [ -n "$(ls -A "$OUT" 2>/dev/null)" ] && [ ! -f "$OUT/.aivenue-verify" ]; then
  echo "Refusing to use $OUT: it is not empty and was not made by ubuntu-verify.sh" >&2; exit 2
fi
rm -rf "$OUT"; mkdir -p "$OUT/results"; touch "$OUT/.aivenue-verify"
R=$OUT/results; SUM=$R/summary.txt
say() { echo "$*" | tee -a "$SUM"; }
step() { local name=$1; shift; echo; echo "=== $name"; if "$@" > "$R/$name.log" 2>&1; then say "PASS  $name"; else say "FAIL  $name (see results/$name.log)"; fi; }

say "Aivenue Linux package verification ($BRANCH) — $(date -u +%Y-%m-%dT%H:%MZ)"
say "System: $(lsb_release -ds 2>/dev/null || uname -o) / $(uname -srm); Node $(node -v); npm $(npm -v); git $(git --version | cut -d' ' -f3)"
say "User namespaces: $(unshare --user --map-root-user true 2>/dev/null && echo allowed || echo restricted); DISPLAY=${DISPLAY:-unset}"

git clone -q -b "$BRANCH" "$BUNDLE" "$OUT/src" || { say "FAIL  clone the bundle"; exit 1; }
HEAD=$(git -C "$OUT/src" rev-parse HEAD)
say "Branch head: $HEAD (expected $WANT): $([ "${HEAD:0:${#WANT}}" = "$WANT" ] && echo same || echo DIFFERENT)"
git -C "$OUT/src" fetch -q "$BUNDLE" "refs/tags/$BASE_TAG:refs/tags/$BASE_TAG"
git -C "$OUT/src" worktree add -q --detach "$OUT/base" "$BASE_TAG"
say "Baseline $BASE_TAG: $(git -C "$OUT/base" rev-parse HEAD)"
cd "$OUT/src" || exit 1

step npm-ci npm ci
step epipe-repro-base sh -c "node scripts/linux-accept/repro-epipe.mjs '$OUT/base' 300; echo \"exit \$?\"; true"
say "      $BASE_TAG: $(tail -n 2 "$R/epipe-repro-base.log" | head -n 1)"
step epipe-repro-branch node scripts/linux-accept/repro-epipe.mjs . 300
say "      branch:  $(tail -n 1 "$R/epipe-repro-branch.log")"
step epipe-regression-test node --test --test-name-pattern=EPIPE scripts/test-workflow.mjs
step orchestrator-10x sh -c 'f=0; for i in 1 2 3 4 5 6 7 8 9 10; do node scripts/run-tests.mjs scripts/test-orchestrator.mjs > orch-$i.log 2>&1 || f=$((f+1)); grep -E "^ℹ (pass|fail)" orch-$i.log | tr "\n" " "; echo "(run $i)"; done; mv orch-*.log '"$R"'/ ; echo "failed runs: $f"; [ $f = 0 ]'
say "      $(tail -n 1 "$R/orchestrator-10x.log")"
step typecheck npm run typecheck
step test-all node scripts/run-tests.mjs
say "      $(grep -E '^ℹ (tests|pass|fail|skipped)' "$R/test-all.log" | tr '\n' ' ')"
mkdir -p release
step package-linux npm run package:linux
V=$(node -p "require('./packages/desktop/package.json').version"); PKG=release/Aivenue-$V-linux-x64.tar.gz
if [ -f "$PKG" ]; then
  (cd release && sha256sum "Aivenue-$V-linux-x64.tar.gz" > SHA256SUMS.txt)
  SHA=$(cut -d' ' -f1 release/SHA256SUMS.txt)
  cp "$PKG" release/SHA256SUMS.txt "$R/"
  say "Package: $(basename "$PKG"), $(stat -c %s "$PKG") bytes, SHA-256 $SHA"
  [ -n "$PREV" ] && say "Previous version for case T: $(basename "$PREV"), SHA-256 $(sha256sum "$PREV" | cut -c1-64)"
  step accept env ${PREV:+"ACC_PREV=$PREV"} bash scripts/linux-accept/accept.sh "$PKG" "$SHA" "$HEAD" "$OLD" "$OUT/accept"
  say "      $(tail -n 1 "$R/accept.log")"
  cp -r "$OUT/accept/shots" "$R/accept-shots" 2>/dev/null
else
  say "FAIL  no package at $PKG"
fi
echo; echo "Summary: $SUM"; cat "$SUM"
! grep -q '^FAIL' "$SUM"
