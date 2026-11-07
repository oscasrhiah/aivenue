#!/bin/bash
# Acceptance of ONE Linux package (the file to be published), on Ubuntu with an X server (Xvfb) at $DISPLAY.
#   bash scripts/linux-accept/accept.sh <Aivenue-<v>-linux-x64.tar.gz> <expected sha256> <expected commit (7+)> <old tar.gz> <work dir>
# ACC_PORT: the debugging port for the app (default 9222). Run it as a normal user; it never uses sudo.
# <old tar.gz> is a published package from before the file list (0.2.4), for the upgrade and uninstall cases.
# Every case runs in a clean `env -i` shell with its own HOME; faults are injected with mv / rm wrappers put first on
# PATH (kill -9 of install.sh at the Nth mv or sha256sum or right after it put a given file in place, a failing mv, a failing rm,
# a file whose SHA-256 cannot be read, and in case S each outside command failing once at sampled calls). Prints one line per check and a summary;
# exits 1 when any check fails.
set -u
PKG=$(readlink -f "$1"); WANT_SHA=$2; WANT_COMMIT=${3:0:7}; OLD=$(readlink -f "$4"); W=$(readlink -m "$5")
HERE=$(dirname "$(readlink -f "$0")")
# The work folder is emptied first: only a new folder, an empty one, or one this script made before.
if [ -e "$W" ] && [ -n "$(ls -A "$W" 2>/dev/null)" ] && [ ! -f "$W/.aivenue-accept" ]; then
  echo "Refusing to use $W: it is not empty and was not made by accept.sh" >&2; exit 2
fi
rm -rf "$W"; mkdir -p "$W"/{new,old,faults,shots,out}; touch "$W/.aivenue-accept"
PORT=${ACC_PORT:-9222}
FAILS=0; PASSES=0
ok() { PASSES=$((PASSES + 1)); echo "  PASS  $1"; }
bad() { FAILS=$((FAILS + 1)); echo "  FAIL  $1"; }
chk() { if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got '$2', want '$3'"; fi; }

cat > "$W/faults/mv" <<'EOF'
#!/bin/sh
if [ -n "$MV_KILL$MV_FAIL" ]; then n=$(($(cat "$MV_COUNT" 2>/dev/null || echo 0) + 1)); echo $n > "$MV_COUNT"
  [ "$n" = "$MV_KILL" ] && kill -9 $PPID && sleep 1
  [ "$n" = "$MV_FAIL" ] && { echo "mv: Input/output error (injected)" >&2; exit 1; }; fi
# MV_KILL_AFTER=name: do the rename, then kill install.sh when it put a file named that in place.
# MV_KILL_BEFORE=name: kill install.sh (KILL_TARGET, subshells included) just before it would put a file named that in place.
if [ -n "$MV_KILL_BEFORE" ]; then for a; do last="$a"; done
  case "$last" in */"$MV_KILL_BEFORE") pkill -KILL -f -- "$KILL_TARGET"; sleep 1; exit 1 ;; esac; fi
if [ -n "$MV_KILL_AFTER" ]; then for a; do last="$a"; done; /bin/mv "$@"; s=$?
  case "$last" in */"$MV_KILL_AFTER") kill -9 $PPID; sleep 1 ;; esac; exit $s; fi
exec /bin/mv "$@"
EOF
cat > "$W/faults/rm" <<'EOF'
#!/bin/sh
if [ -n "$RM_FAIL" ]; then for a; do case "$a" in */"$RM_FAIL") echo "rm: cannot remove '$a': Operation not permitted (injected)" >&2; exit 1 ;; esac; done; fi
exec /bin/rm "$@"
EOF
# SHA_KILL=n: the nth sha256sum kills install.sh (KILL_TARGET), subshells included: while it writes its plan.
REAL_SHA=$(command -v sha256sum)
cat > "$W/faults/sha256sum" <<SHA
#!/bin/sh
if [ -n "\$SHA_KILL" ]; then n=\$((\$(cat "\$SHA_COUNT" 2>/dev/null || echo 0) + 1)); echo \$n > "\$SHA_COUNT"
  [ "\$n" = "\$SHA_KILL" ] && pkill -KILL -f -- "\$KILL_TARGET" && sleep 1; fi
exec $REAL_SHA "\$@"
SHA
chmod +x "$W/faults/mv" "$W/faults/rm" "$W/faults/sha256sum"
BASEPATH=/usr/local/bin:/usr/bin:/bin
FPATH=$W/faults:$BASEPATH

# A clean shell for case $CASE_HOME: run [VAR=val ...] cmd args
# On a desktop session the X authority and session bus are passed on (the app's window needs them); nothing else is.
DESKTOP_ENV=()
for v in XAUTHORITY DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR; do [ -n "${!v:-}" ] && DESKTOP_ENV+=("$v=${!v}"); done
run() { env -i DISPLAY="${DISPLAY:-:99}" "${DESKTOP_ENV[@]}" LANG=C.UTF-8 HOME="$CASE_HOME" USER=tester LOGNAME=tester SHELL=/bin/bash PATH="$CASE_HOME/.local/bin:$BASEPATH" "$@"; }
newhome() { CASE_HOME=$W/home-$1; rm -rf "$CASE_HOME"; mkdir -p "$CASE_HOME"; }
# LOG: where a run's output goes (default $W/last.log; each parallel trial in case S has its own).
inst() { run "$@" sh "${PN}install.sh" > "${LOG:-$W/last.log}" 2>&1; echo $?; }
uninst() { run "$@" > "${LOG:-$W/last.log}" 2>&1; echo $?; }
oldinst() { run AIVENUE_INSTALL_DIR="$1" sh "${PO}install.sh" > "${LOG:-$W/last.log}.old" 2>&1 || { echo "    (0.2.4 install failed)"; cat "${LOG:-$W/last.log}.old"; }; }
# Final state of install folder $1.
state() {
  local d=$1 diff=-
  [ -f "$d/.aivenue-files" ] && diff=$(cd "$d" && while read -r f; do cmp -s "$f" "${PN}$f" || echo x; done < "${PN}.aivenue-files" | wc -l)
  echo "marker=$([ -f "$d/.aivenue-install" ] && echo yes || echo no) list=$([ -f "$d/.aivenue-files" ] && echo "$(wc -l < "$d/.aivenue-files")" || echo no) pending=$([ -f "$d/.aivenue-pending" ] && echo yes || echo no) staging=$(ls -A "$d" 2>/dev/null | grep -cE '^\.aivenue-staging\.[0-9a-f]{16}$') differing=$diff"
}

# The user's files inside install folder $1, and their hash.
put_user() {
  mkdir -p "$1/data"; printf 'conversation\000\377' > "$1/data/history.bin"; printf 'my notes\n' > "$1/my-notes.txt"
  printf '\000\001\002\377\376\n\r\344\275\240' > "$1/blob.bin"
  mkdir -p "$1/.aivenue-staging.personal-backup"; printf 'history\000\377 kept?' > "$1/.aivenue-staging.personal-backup/history"
}
usum() { (cd "$1" && for f in data my-notes.txt blob.bin .aivenue-staging.personal-backup; do [ -e "$f" ] && find "$f" -type f -print0 | sort -z | xargs -0 sha256sum; done) | sha256sum | cut -c1-16; }
# The Aivenue data folder (AIVENUE_HOME): the fixture's files and their hash.
mkdata() { node "$HERE/make-data.mjs" "$1" > "${IDS:-$W/data-ids.txt}"; }
dsum() { (cd "$1" && find runs my-own -type f -print0 | sort -z | xargs -0 sha256sum) | sha256sum | cut -c1-16; }
# Start the installed app ($1 install folder, $2 AIVENUE_HOME), check version, build and listed workflows, close it.
launch() {
  local d=$1 data=$2 name=$3
  (run AIVENUE_HOME="$data" setsid "$d/aivenue.sh" --remote-debugging-port="$PORT" > "$W/out/$name-app.log" 2>&1 &)
  if node "$HERE/app-check.mjs" "$PORT" "$W/out/$name.json" "$W/shots/$name.png" > /dev/null 2>&1; then
    local v b runs
    v=$(node -p "require('$W/out/$name.json').version"); b=$(node -p "require('$W/out/$name.json').build")
    runs=$(node -p "const ids=require('fs').readFileSync('$W/data-ids.txt','utf8').trim().split(' '); const got=require('$W/out/$name.json').runs; ids.filter(i=>got.includes(i)).length")
    local n=0 ns=0; for p in $(pgrep -f "^$d/aivenue"); do n=$((n + 1)); tr '\0' ' ' < /proc/$p/cmdline | grep -q -- --no-sandbox && ns=$((ns + 1)); done
    chk "$name: app starts, version" "$v" "$VERSION"
    chk "$name: build commit" "${b%%-*}" "$WANT_COMMIT"
    chk "$name: workflows read back from AIVENUE_HOME" "$runs" "3"
    echo "        build $b, $n processes ($ns with --no-sandbox), screenshot shots/$name.png"
  else
    bad "$name: app did not start or answer"; cat "$W/out/$name.json" 2>/dev/null; tail -n 30 "$W/out/$name-app.log"
  fi
  pkill -TERM -f "^$d/aivenue" 2>/dev/null; for _ in 1 2 3 4 5 6 7 8 9 10; do pgrep -f "^$d/aivenue" > /dev/null || break; sleep 1; done
  pkill -KILL -f "^$d/aivenue" 2>/dev/null; sleep 1
  chk "$name: app closed" "$(pgrep -fc "^$d/aivenue")" "0"
}
links_to() { [ "$(readlink -f "$CASE_HOME/.local/bin/aivenue" 2>/dev/null)" = "$(readlink -f "$1/aivenue.sh")" ] && grep -q "Exec=$1/aivenue.sh" "$CASE_HOME/.local/share/applications/aivenue.desktop" 2>/dev/null && echo yes || echo no; }
shortcuts_gone() { [ ! -e "$CASE_HOME/.local/bin/aivenue" ] && [ ! -L "$CASE_HOME/.local/bin/aivenue" ] && [ ! -e "$CASE_HOME/.local/share/applications/aivenue.desktop" ] && echo yes || echo no; }
left() { ls -A "$1" 2>/dev/null | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//'; }

echo "=== Package"
GOT_SHA=$(sha256sum "$PKG" | cut -d' ' -f1)
chk "SHA-256 of the file under test" "$GOT_SHA" "$WANT_SHA"
echo "        $(basename "$PKG"), $(stat -c %s "$PKG") bytes"
tar -xzf "$PKG" -C "$W/new"; tar -xzf "$OLD" -C "$W/old"
PN=$(ls -d "$W"/new/*/); PO=$(ls -d "$W"/old/*/)
VERSION=$(basename "$PKG" | sed -E 's/^Aivenue-(.*)-linux-x64\.tar\.gz$/\1/')
CLEAN="marker=yes list=$(wc -l < "${PN}.aivenue-files") pending=no staging=0 differing=0"
echo "        $(tar -tzf "$PKG" | wc -l) entries; .aivenue-files $(wc -l < "${PN}.aivenue-files") lines; .aivenue-legacy-files $(wc -l < "${PN}.aivenue-legacy-files") lines"
REPO=$(cd "$HERE/../.." && pwd)
chk "install.sh / uninstall.sh in the package = the repository's" "$(cmp -s "${PN}install.sh" "$REPO/packages/desktop/linux/install.sh" && cmp -s "${PN}uninstall.sh" "$REPO/packages/desktop/linux/uninstall.sh" && echo yes || echo no)" "yes"
chk "build id in app.asar" "$(grep -aoE "\"$WANT_COMMIT-[0-9]{12}\"" "${PN}resources/app.asar" | sort -u | wc -l)" "1"
MISSING=$(cd "$PO" && find . -type f | sed 's#^\./##' | grep -vxF -f "${PN}.aivenue-legacy-files" | grep -vx '' || true)
chk "every file of the 0.2.4 package is on the legacy list" "${MISSING:-none}" "none"

echo; echo "=== A. first install (default folder), then start"
newhome A; D=$CASE_HOME/.local/share/aivenue; mkdata "$CASE_HOME/.aivenue"
chk "A: install exit" "$(inst)" "0"
chk "A: state" "$(state "$D")" "$CLEAN"
chk "A: command and menu entry point to the install" "$(links_to "$D")" "yes"
launch "$D" "$CASE_HOME/.aivenue" A

echo; echo "=== B. upgrade from the published 0.2.4 (no file list), with the user's files in the install folder"
newhome B; D=$CASE_HOME/apps; mkdata "$CASE_HOME/.aivenue"; oldinst "$D"; put_user "$D"; U=$(usum "$D"); DS=$(dsum "$CASE_HOME/.aivenue")
chk "B: upgrade exit" "$(inst AIVENUE_INSTALL_DIR="$D")" "0"
chk "B: state" "$(state "$D")" "$CLEAN"
chk "B: user files in the install folder" "$(usum "$D")" "$U"
chk "B: AIVENUE_HOME" "$(dsum "$CASE_HOME/.aivenue")" "$DS"
chk "B: command and menu entry point to the install" "$(links_to "$D")" "yes"
launch "$D" "$CASE_HOME/.aivenue" B

echo; echo "=== B2. reinstall the same package over itself (an install with a file list), with the user's files"
newhome B2; D=$CASE_HOME/apps; mkdata "$CASE_HOME/.aivenue"; inst AIVENUE_INSTALL_DIR="$D" > /dev/null; put_user "$D"; U=$(usum "$D")
chk "B2: reinstall exit" "$(inst AIVENUE_INSTALL_DIR="$D")" "0"
chk "B2: state" "$(state "$D")" "$CLEAN"
chk "B2: user files" "$(usum "$D")" "$U"
launch "$D" "$CASE_HOME/.aivenue" B2

echo; echo "=== C. first install killed (kill -9) at mv #70, then the same command again"
newhome C; D=$CASE_HOME/apps; mkdata "$CASE_HOME/.aivenue"
chk "C: run 1 exit (killed)" "$(inst PATH="$FPATH" MV_COUNT="$W/cnt-C" MV_KILL=70 AIVENUE_INSTALL_DIR="$D")" "137"
echo "        after the kill: $(state "$D")"
chk "C: run 2 exit" "$(inst AIVENUE_INSTALL_DIR="$D")" "0"
chk "C: state" "$(state "$D")" "$CLEAN"
launch "$D" "$CASE_HOME/.aivenue" C

echo; echo "=== D. upgrade from 0.2.4 killed at mv #70, then the same command again"
newhome D; D=$CASE_HOME/apps; mkdata "$CASE_HOME/.aivenue"; oldinst "$D"; put_user "$D"; U=$(usum "$D"); DS=$(dsum "$CASE_HOME/.aivenue")
chk "D: run 1 exit (killed)" "$(inst PATH="$FPATH" MV_COUNT="$W/cnt-D" MV_KILL=70 AIVENUE_INSTALL_DIR="$D")" "137"
echo "        after the kill: $(state "$D")"
chk "D: run 2 exit" "$(inst AIVENUE_INSTALL_DIR="$D")" "0"
chk "D: state" "$(state "$D")" "$CLEAN"
chk "D: user files" "$(usum "$D")" "$U"
chk "D: AIVENUE_HOME (history)" "$(dsum "$CASE_HOME/.aivenue")" "$DS"
launch "$D" "$CASE_HOME/.aivenue" D

echo; echo "=== D2. reinstall killed at mv #70, then the same command again"
newhome D2; D=$CASE_HOME/apps; inst AIVENUE_INSTALL_DIR="$D" > /dev/null; put_user "$D"; U=$(usum "$D")
chk "D2: run 1 exit (killed)" "$(inst PATH="$FPATH" MV_COUNT="$W/cnt-D2" MV_KILL=70 AIVENUE_INSTALL_DIR="$D")" "137"
chk "D2: run 2 exit" "$(inst AIVENUE_INSTALL_DIR="$D")" "0"
chk "D2: state" "$(state "$D")" "$CLEAN"
chk "D2: user files" "$(usum "$D")" "$U"

echo; echo "=== K. first install stopped while putting files in place (mv #70), the retry stopped right after it wrote the file list, then the same command a third time"
newhome K; D=$CASE_HOME/apps; mkdata "$CASE_HOME/.aivenue"
newfiles() { (cd "$1" && while read -r f; do cmp -s "$f" "${PN}$f" && echo x; done < "${PN}.aivenue-files" | wc -l); }
TOTAL=$(wc -l < "${PN}.aivenue-files")
chk "K: run 1 exit (killed)" "$(inst PATH="$FPATH" MV_COUNT="$W/cnt-K" MV_KILL=70 AIVENUE_INSTALL_DIR="$D")" "137"
N1=$(newfiles "$D")
chk "K: run 1 stopped while putting files in place (plan there, no file list, some files in place)" "$([ -f "$D/.aivenue-pending" ] && [ ! -e "$D/.aivenue-files" ] && [ "$N1" -gt 0 ] && [ "$N1" -lt "$TOTAL" ] && echo yes)" "yes"
echo "        after run 1: $N1 of $TOTAL package files in place; $(state "$D")"
chk "K: run 2 exit (killed after writing the file list)" "$(inst PATH="$FPATH" MV_KILL_AFTER=.aivenue-files AIVENUE_INSTALL_DIR="$D")" "137"
chk "K: run 2 stopped right after the file list was written (list there, plan still there)" "$([ -f "$D/.aivenue-files" ] && [ -f "$D/.aivenue-pending" ] && echo yes)" "yes"
echo "        after run 2: $(state "$D")"
chk "K: run 3 exit" "$(inst AIVENUE_INSTALL_DIR="$D")" "0"
chk "K: state" "$(state "$D")" "$CLEAN"
launch "$D" "$CASE_HOME/.aivenue" K

echo; echo "=== M. upgrade from 0.2.4 stopped (mv #70); the user puts their own .aivenue-files at the list path"
for then in retry uninstall; do
  newhome "M-$then"; D=$CASE_HOME/apps; mkdata "$CASE_HOME/.aivenue"; oldinst "$D"; put_user "$D"
  chk "M-$then: install stopped (killed)" "$(inst PATH="$FPATH" MV_COUNT="$W/cnt-M-$then" MV_KILL=70 AIVENUE_INSTALL_DIR="$D")" "137"
  # It even names the user's files: taking it for the installer's would remove them.
  printf 'my-notes.txt\ndata/history.bin\nblob.bin\n' > "$D/.aivenue-files"
  LS=$(sha256sum < "$D/.aivenue-files"); U=$(usum "$D"); DS=$(dsum "$CASE_HOME/.aivenue")
  if [ $then = retry ]; then
    chk "M-retry: retry exit (refused)" "$(inst AIVENUE_INSTALL_DIR="$D")" "1"
    chk "M-retry: the conflict is listed" "$(grep -c '^  \.aivenue-files (not written by this installer' "$W/last.log")" "1"
    sed 's/^/        /' "$W/last.log" | grep -v '^ *$' | head -n 6
  else
    chk "M-uninstall: uninstall exit" "$(uninst AIVENUE_INSTALL_DIR="$D" sh "${PN}uninstall.sh")" "0"
    chk "M-uninstall: the kept list is reported" "$(grep -c 'not written by the installer' "$W/last.log")" "1"
    chk "M-uninstall: Aivenue's files removed" "$([ ! -e "$D/aivenue" ] && [ ! -e "$D/resources/app.asar" ] && [ ! -e "$D/aivenue.sh" ] && echo yes)" "yes"
  fi
  chk "M-$then: the user's .aivenue-files" "$(sha256sum < "$D/.aivenue-files")" "$LS"
  chk "M-$then: other user files" "$(usum "$D")" "$U"
  chk "M-$then: AIVENUE_HOME (history)" "$(dsum "$CASE_HOME/.aivenue")" "$DS"
  if [ $then = retry ]; then
    mv "$D/.aivenue-files" "$W/M-moved-away"
    chk "M-retry: moved away, retry exit" "$(inst AIVENUE_INSTALL_DIR="$D")" "0"
    chk "M-retry: state" "$(state "$D")" "$CLEAN"
    chk "M-retry: user files" "$(usum "$D")" "$U"
  fi
done

echo; echo "=== N. upgrade from 0.2.4 stopped (mv #70); the user puts their own files at paths the legacy list names"
# locales/af.pak: in 0.2.4, the legacy list and the new version. The gh-fix-ci license: in the legacy list and the new
# version, not in 0.2.4. The plan records both paths, but neither of these contents: they are the user's.
NA=locales/af.pak; NB=resources/app.asar.unpacked/dist/bundled/gh-fix-ci/LICENSE.txt
for then in retry uninstall; do
  newhome "N-$then"; D=$CASE_HOME/apps; mkdata "$CASE_HOME/.aivenue"; oldinst "$D"; put_user "$D"
  chk "N-$then: install stopped (killed)" "$(inst PATH="$FPATH" MV_COUNT="$W/cnt-N-$then" MV_KILL=70 AIVENUE_INSTALL_DIR="$D")" "137"
  chk "N-$then: a plan, no marker yet" "$([ -f "$D/.aivenue-pending" ] && [ ! -e "$D/.aivenue-install" ] && echo yes)" "yes"
  for p in "$NA" "$NB"; do mkdir -p "$(dirname "$D/$p")"; printf 'MY OWN %s \000\377\n' "$p" > "$D/$p"; done
  HA=$(sha256sum < "$D/$NA"); HB=$(sha256sum < "$D/$NB"); U=$(usum "$D"); DS=$(dsum "$CASE_HOME/.aivenue")
  if [ $then = retry ]; then
    chk "N-retry: retry exit (refused)" "$(inst AIVENUE_INSTALL_DIR="$D")" "1"
    chk "N-retry: both paths listed as conflicts" "$(grep -cE "^  ($NA|$NB) \(already there and not an Aivenue file\)" "$W/last.log")" "2"
    sed 's/^/        /' "$W/last.log" | grep -v '^ *$' | head -n 5
  else
    chk "N-uninstall: uninstall exit" "$(uninst AIVENUE_INSTALL_DIR="$D" sh "${PN}uninstall.sh")" "0"
    chk "N-uninstall: Aivenue's files removed" "$([ ! -e "$D/aivenue" ] && [ ! -e "$D/resources/app.asar" ] && [ ! -e "$D/locales/en-US.pak" ] && echo yes)" "yes"
  fi
  chk "N-$then: the user's $NA" "$(sha256sum < "$D/$NA" 2>/dev/null)" "$HA"
  chk "N-$then: the user's gh-fix-ci/LICENSE.txt" "$(sha256sum < "$D/$NB" 2>/dev/null)" "$HB"
  chk "N-$then: other user files" "$(usum "$D")" "$U"
  chk "N-$then: AIVENUE_HOME (history)" "$(dsum "$CASE_HOME/.aivenue")" "$DS"
  if [ $then = retry ]; then
    mv "$D/$NA" "$W/N-moved-a"; mv "$D/$NB" "$W/N-moved-b"
    chk "N-retry: moved away, retry exit" "$(inst AIVENUE_INSTALL_DIR="$D")" "0"
    chk "N-retry: state" "$(state "$D")" "$CLEAN"
    chk "N-retry: user files" "$(usum "$D")" "$U"
    launch "$D" "$CASE_HOME/.aivenue" N
  fi
done

echo; echo "=== P. upgrade from 0.2.4 killed (kill -9) while writing the plan (sha256sum #60), before any program file is replaced"
oldprog() { (cd "$PO" && find . -type f | sed 's#^\./##') | while read -r f; do cmp -s "$1/$f" "$PO$f" || echo x; done | wc -l; }
oldleft() { (cd "$PO" && find . -type f | sed 's#^\./##') | while read -r f; do [ -e "$1/$f" ] && echo x; done | wc -l; }
for then in retry uninstall; do
  newhome "P-$then"; D=$CASE_HOME/apps; mkdata "$CASE_HOME/.aivenue"; oldinst "$D"; put_user "$D"; U=$(usum "$D"); DS=$(dsum "$CASE_HOME/.aivenue")
  chk "P-$then: run 1 exit (killed)" "$(inst PATH="$FPATH" SHA_COUNT="$W/sha-P-$then" SHA_KILL=60 KILL_TARGET="${PN}install.sh" AIVENUE_INSTALL_DIR="$D")" "137"
  chk "P-$then: the 0.2.4 program files untouched (differing)" "$(oldprog "$D")" "0"
  chk "P-$then: no plan published" "$([ -e "$D/.aivenue-pending" ] && echo there || echo none)" "none"
  if [ $then = retry ]; then
    chk "P-retry: retry exit" "$(inst AIVENUE_INSTALL_DIR="$D")" "0"
    chk "P-retry: state" "$(state "$D")" "$CLEAN"
  else
    chk "P-uninstall: uninstall exit" "$(uninst AIVENUE_INSTALL_DIR="$D" sh "${PN}uninstall.sh")" "0"
    chk "P-uninstall: 0.2.4 files left" "$(oldleft "$D")" "0"
  fi
  chk "P-$then: user files" "$(usum "$D")" "$U"
  chk "P-$then: AIVENUE_HOME (history)" "$(dsum "$CASE_HOME/.aivenue")" "$DS"
  [ $then = uninstall ] || launch "$D" "$CASE_HOME/.aivenue" P
done

echo; echo "=== Q. upgrade from 0.2.4 stopped (mv #70); the retry killed while writing its new plan (sha256sum #250); then a third run, or uninstall"
for then in retry uninstall; do
  newhome "Q-$then"; D=$CASE_HOME/apps; mkdata "$CASE_HOME/.aivenue"; oldinst "$D"; put_user "$D"; U=$(usum "$D"); DS=$(dsum "$CASE_HOME/.aivenue")
  chk "Q-$then: run 1 exit (killed)" "$(inst PATH="$FPATH" MV_COUNT="$W/cnt-Q-$then" MV_KILL=70 AIVENUE_INSTALL_DIR="$D")" "137"
  P1=$(sha256sum < "$D/.aivenue-pending")
  chk "Q-$then: run 2 exit (killed while writing its plan)" "$(inst PATH="$FPATH" SHA_COUNT="$W/sha-Q-$then" SHA_KILL=250 KILL_TARGET="${PN}install.sh" AIVENUE_INSTALL_DIR="$D")" "137"
  chk "Q-$then: the previous complete plan untouched" "$(sha256sum < "$D/.aivenue-pending")" "$P1"
  if [ $then = retry ]; then
    chk "Q-retry: run 3 exit" "$(inst AIVENUE_INSTALL_DIR="$D")" "0"
    chk "Q-retry: state" "$(state "$D")" "$CLEAN"
  else
    chk "Q-uninstall: uninstall exit" "$(uninst AIVENUE_INSTALL_DIR="$D" sh "${PN}uninstall.sh")" "0"
    chk "Q-uninstall: Aivenue's files left (0.2.4 or new)" "$(( $(oldleft "$D") + $([ -e "$D/aivenue" ] && echo 1 || echo 0) ))" "0"
  fi
  chk "Q-$then: user files" "$(usum "$D")" "$U"
  chk "Q-$then: AIVENUE_HOME (history)" "$(dsum "$CASE_HOME/.aivenue")" "$DS"
  [ $then = uninstall ] || launch "$D" "$CASE_HOME/.aivenue" Q
done

echo; echo "=== R. a file's SHA-256 cannot be read (read error) while the plan is written; then the fault is gone: retry, or uninstall"
# SHA_FAIL=file: hashing that file fails (read error, nothing printed). MV_FAIL_ONCE=name: the first rename to that name fails.
mkdir -p "$W/faults2"
cat > "$W/faults2/sha256sum" <<SHA
#!/bin/sh
if [ -n "\$SHA_FAIL" ] && [ "\$(readlink -f /proc/self/fd/0)" = "\$SHA_FAIL" ]; then echo "sha256sum: -: Input/output error (injected)" >&2; exit 1; fi
exec $REAL_SHA "\$@"
SHA
cat > "$W/faults2/mv" <<'EOF'
#!/bin/sh
if [ -n "$MV_FAIL_ONCE" ] && [ ! -e "$MV_FAILED" ]; then for a; do last="$a"; done
  case "$last" in */"$MV_FAIL_ONCE") : > "$MV_FAILED"; echo "mv: Input/output error (injected)" >&2; exit 1 ;; esac; fi
exec /bin/mv "$@"
EOF
chmod +x "$W/faults2/sha256sum" "$W/faults2/mv"
F2PATH=$W/faults2:$BASEPATH
# After a kill -9 from the mv wrapper, the wrapper itself still finishes its rename a moment later: wait for it.
settle() { sleep 0.2; while pgrep -f -- "$W/faults/" > /dev/null; do sleep 0.2; done; }
allsum() { (cd "$1" && find . -type f -print0 | sort -z | xargs -0 sha256sum) | sha256sum | cut -c1-16; }
newleft() { [ -e "$1/aivenue" ] || [ -e "$1/.aivenue-files" ] || [ -e "$1/.aivenue-pending" ] || ls -A "$1" 2>/dev/null | grep -qE '^\.aivenue-staging\.[0-9a-f]{16}$' && echo yes || echo no; }
# R1: upgrade from 0.2.4; the 0.2.4 resources/app.asar (or the package's) cannot be hashed, and the first rename fails.
for side in old new; do for then in retry uninstall; do
  n="R1-$side-$then"; newhome "$n"; D=$CASE_HOME/apps; mkdata "$CASE_HOME/.aivenue"; oldinst "$D"; put_user "$D"; U=$(usum "$D"); DS=$(dsum "$CASE_HOME/.aivenue")
  [ $side = old ] && FF=$(readlink -f "$D/resources/app.asar") || FF=$(readlink -f "${PN}resources/app.asar")
  A0=$(allsum "$D")
  chk "$n: run 1 exit (reported)" "$(inst PATH="$F2PATH" SHA_FAIL="$FF" MV_FAIL_ONCE=aivenue MV_FAILED="$W/mvf-$n" AIVENUE_INSTALL_DIR="$D")" "1"
  chk "$n: says why" "$(grep -c 'could not be read to record its SHA-256' "$W/last.log")" "1"
  chk "$n: the install folder unchanged (every file)" "$(allsum "$D")" "$A0"
  chk "$n: no plan published" "$([ -e "$D/.aivenue-pending" ] && echo there || echo none)" "none"
  if [ $then = retry ]; then
    chk "$n: retry exit" "$(inst AIVENUE_INSTALL_DIR="$D")" "0"
    chk "$n: state" "$(state "$D")" "$CLEAN"
  else
    chk "$n: uninstall exit" "$(uninst AIVENUE_INSTALL_DIR="$D" sh "${PN}uninstall.sh")" "0"
    chk "$n: 0.2.4 files left" "$(oldleft "$D")" "0"
  fi
  chk "$n: user files" "$(usum "$D")" "$U"
  chk "$n: AIVENUE_HOME (history)" "$(dsum "$CASE_HOME/.aivenue")" "$DS"
  [ "$n" != R1-old-retry ] || launch "$D" "$CASE_HOME/.aivenue" R1
done; done
# R2: upgrade from 0.2.4 stopped (mv #70) with a complete plan; the retry cannot hash a recorded file in the folder
# (the 0.2.4 resources/app.asar, still there) or the package's; then the fault is gone.
for side in dest pkg; do for then in retry uninstall; do
  n="R2-$side-$then"; newhome "$n"; D=$CASE_HOME/apps; mkdata "$CASE_HOME/.aivenue"; oldinst "$D"; put_user "$D"; U=$(usum "$D"); DS=$(dsum "$CASE_HOME/.aivenue")
  chk "$n: run 1 exit (killed)" "$(inst PATH="$FPATH" MV_COUNT="$W/cnt-$n" MV_KILL=70 AIVENUE_INSTALL_DIR="$D")" "137"
  settle
  P1=$(sha256sum < "$D/.aivenue-pending"); A1=$(allsum "$D")
  [ $side = dest ] && FF=$(readlink -f "$D/resources/app.asar") || FF=$(readlink -f "${PN}resources/app.asar")
  chk "$n: run 2 exit (reported)" "$(inst PATH="$F2PATH" SHA_FAIL="$FF" AIVENUE_INSTALL_DIR="$D")" "1"
  chk "$n: says nothing was changed" "$(grep -c 'nothing was changed' "$W/last.log")" "1"
  chk "$n: the previous complete plan untouched" "$(sha256sum < "$D/.aivenue-pending")" "$P1"
  chk "$n: the install folder unchanged (every file)" "$(allsum "$D")" "$A1"
  if [ $then = retry ]; then
    chk "$n: run 3 exit" "$(inst AIVENUE_INSTALL_DIR="$D")" "0"
    chk "$n: state" "$(state "$D")" "$CLEAN"
  else
    chk "$n: uninstall exit" "$(uninst AIVENUE_INSTALL_DIR="$D" sh "${PN}uninstall.sh")" "0"
    chk "$n: Aivenue's files left (0.2.4 or new)" "$(oldleft "$D") $(newleft "$D")" "0 no"
  fi
  chk "$n: user files" "$(usum "$D")" "$U"
  chk "$n: AIVENUE_HOME (history)" "$(dsum "$CASE_HOME/.aivenue")" "$DS"
done; done
# R3: uninstall following a stopped upgrade's plan; a recorded file cannot be hashed: nothing removed; then again.
n=R3; newhome "$n"; D=$CASE_HOME/apps; mkdata "$CASE_HOME/.aivenue"; oldinst "$D"; put_user "$D"; U=$(usum "$D"); DS=$(dsum "$CASE_HOME/.aivenue")
chk "$n: run 1 exit (killed)" "$(inst PATH="$FPATH" MV_COUNT="$W/cnt-$n" MV_KILL=70 AIVENUE_INSTALL_DIR="$D")" "137"
  settle
A1=$(allsum "$D")
chk "$n: uninstall exit (reported)" "$(uninst PATH="$F2PATH" SHA_FAIL="$(readlink -f "$D/resources/app.asar")" AIVENUE_INSTALL_DIR="$D" sh "${PN}uninstall.sh")" "1"
chk "$n: says nothing was removed" "$(grep -c 'nothing was removed' "$W/last.log")" "1"
chk "$n: the install folder unchanged (every file)" "$(allsum "$D")" "$A1"
chk "$n: uninstall again exit" "$(uninst AIVENUE_INSTALL_DIR="$D" sh "${PN}uninstall.sh")" "0"
chk "$n: Aivenue's files left (0.2.4 or new)" "$(oldleft "$D") $(newleft "$D")" "0 no"
chk "$n: user files" "$(usum "$D")" "$U"
chk "$n: AIVENUE_HOME (history)" "$(dsum "$CASE_HOME/.aivenue")" "$DS"
# R4: a plan whose end checksum matches but with a record missing its SHA-256 (as 4094b88 could write it): not used.
for then in retry uninstall; do
  n="R4-$then"; newhome "$n"; D=$CASE_HOME/apps; mkdata "$CASE_HOME/.aivenue"; oldinst "$D"; put_user "$D"
  chk "$n: run 1 exit (killed)" "$(inst PATH="$FPATH" MV_COUNT="$W/cnt-$n" MV_KILL=70 AIVENUE_INSTALL_DIR="$D")" "137"
  settle
  B=$(sed '$d' "$D/.aivenue-pending" | sed -E 's#^old [0-9a-f]{64}  resources/app\.asar$#old   resources/app.asar#')
  printf '%s\nend %s\n' "$B" "$(printf '%s\n' "$B" | sha256sum | cut -c1-64)" > "$D/.aivenue-pending"
  chk "$n: the plan has the empty record" "$(grep -c '^old   resources/app.asar$' "$D/.aivenue-pending")" "1"
  A1=$(allsum "$D")
  if [ $then = retry ]; then chk "$n: retry exit (refused)" "$(inst AIVENUE_INSTALL_DIR="$D")" "1"
  else chk "$n: uninstall exit (refused)" "$(uninst AIVENUE_INSTALL_DIR="$D" sh "${PN}uninstall.sh")" "1"; fi
  chk "$n: says the plan is not complete" "$(grep -c 'not a complete record' "$W/last.log")" "1"
  chk "$n: the install folder unchanged (every file)" "$(allsum "$D")" "$A1"
done

echo; echo "=== S. fault sweep on this package: each outside command fails once, at sampled calls (first, a third, two thirds, last)"
# For each failure: the user's files keep their SHA-256; a run that exits 0 really finished; with the fault gone, the
# same install.sh finishes (in this folder) and uninstall.sh removes every Aivenue file (in a copy of it).
SW=$W/sweep; mkdir -p "$SW"
STOOLS="sha256sum cat cp mv sort grep sed mktemp readlink rm"
for t in $STOOLS; do
  real=$(command -v $t); code=1; [ $t = grep ] && code=2
  cat > "$SW/$t" <<EOF
#!/bin/sh
c="\$FAULT_DIR/n.$t"; n=0; [ -f "\$c" ] && read -r n < "\$c"; case "\$n" in ''|*[!0-9]*) n=0 ;; esac; n=\$((n + 1)); echo "\$n" > "\$c"
if [ "\$FAULT_TOOL" = $t ] && [ "\$n" = "\$FAULT_AT" ]; then echo "$t: injected failure (call \$n)" >&2; exit $code; fi
exec $real "\$@"
EOF
  chmod +x "$SW/$t"
done
SPATH=$SW:$BASEPATH
# Set up case folder $1 for scenario $2 (up: a 0.2.4 install; stopped: a 0.2.4 upgrade stopped at mv #70).
sw_setup() {
  newhome "$1"; D=$CASE_HOME/apps; mkdata "$CASE_HOME/.aivenue"; oldinst "$D"; put_user "$D"; U=$(usum "$D"); DS=$(dsum "$CASE_HOME/.aivenue")
  [ "$2" = up ] || { inst PATH="$FPATH" MV_COUNT="$W/cnt-$1" MV_KILL=70 AIVENUE_INSTALL_DIR="$D" > /dev/null; settle_in "$D"; }
}
# Like settle, for one case folder only (other trials run at the same time).
settle_in() { sleep 0.2; while pgrep -f -- "$W/faults/mv .*$1/" > /dev/null; do sleep 0.2; done; }
# The step under test: install or uninstall, with $1 = tool and $2 = call (empty tool: count only).
sw_step() {
  if [ "$STEP" = install ]; then inst PATH="$SPATH" FAULT_DIR="$FD" FAULT_TOOL="$1" FAULT_AT="$2" AIVENUE_INSTALL_DIR="$D"
  else uninst PATH="$SPATH" FAULT_DIR="$FD" FAULT_TOOL="$1" FAULT_AT="$2" AIVENUE_INSTALL_DIR="$D" sh "${PN}uninstall.sh"; fi
}
# One trial, run in its own subshell (its own case folder, log and data ids); it writes "label<TAB>problems" to $3.
sw_trial() {
  local t=$1 at=$2 out=$3 p="" e
  LOG=$W/sweep-log-$SCEN-$STEP-$t-$at; IDS=$LOG.ids
  sw_setup "S-$SCEN-$STEP-$t-$at" "$SCEN"; FD=$W/sweep-n-$SCEN-$STEP-$t-$at; rm -rf "$FD"; mkdir -p "$FD"
  e=$(sw_step "$t" "$at")
  [ "$(usum "$D")" = "$U" ] || p="$p user files changed;"
  [ "$(dsum "$CASE_HOME/.aivenue")" = "$DS" ] || p="$p AIVENUE_HOME changed;"
  if [ "$e" = 0 ]; then
    if [ "$STEP" = install ]; then [ "$(state "$D")" = "$CLEAN" ] || p="$p exit 0 but $(state "$D");"
    else [ "$(oldleft "$D") $(newleft "$D")" = "0 no" ] || p="$p exit 0 but Aivenue files left;"; fi
  fi
  rm -rf "$CASE_HOME/copy"; cp -a "$D" "$CASE_HOME/copy"
  [ "$(inst AIVENUE_INSTALL_DIR="$D")" = 0 ] || p="$p install again failed: $(head -n 2 "$LOG" | tr '\n' ' ');"
  [ "$(state "$D")" = "$CLEAN" ] || p="$p after install again: $(state "$D");"
  [ "$(usum "$D")" = "$U" ] || p="$p user files changed after install again;"
  [ "$(uninst AIVENUE_INSTALL_DIR="$CASE_HOME/copy" sh "${PN}uninstall.sh")" = 0 ] || p="$p uninstall failed: $(head -n 2 "$LOG" | tr '\n' ' ');"
  [ "$(oldleft "$CASE_HOME/copy") $(newleft "$CASE_HOME/copy")" = "0 no" ] || p="$p uninstall left Aivenue files;"
  [ "$(usum "$CASE_HOME/copy")" = "$U" ] || p="$p user files changed after uninstall;"
  printf 'S %s %s: %s call %s (exit %s)\t%s\n' "$SCEN" "$STEP" "$t" "$at" "$e" "${p:-none}" > "$out"
  rm -rf "$CASE_HOME"
}
# Trials run in parallel: one per CPU, but no more than the free space allows (each needs about 3 GB at most).
SJOBS=$(( $(df -Pk "$W" | awk 'NR == 2 { print $4 }') / (3 * 1024 * 1024) )); NP=$(nproc)
[ "$SJOBS" -le "$NP" ] || SJOBS=$NP; [ "$SJOBS" -ge 1 ] || SJOBS=1
echo "        $SJOBS trials at a time ($NP CPUs, $(df -Ph "$W" | awk 'NR == 2 { print $4 }') free)"
RES=$W/sweep-res; rm -rf "$RES"; mkdir -p "$RES"; k=0
for sc in up:install stopped:install stopped:uninstall; do
  SCEN=${sc%%:*}; STEP=${sc#*:}
  sw_setup "S-$SCEN-$STEP-count" "$SCEN"; FD=$W/sweep-n-$SCEN-$STEP-count; rm -rf "$FD"; mkdir -p "$FD"
  chk "S $SCEN $STEP: with no fault, exit" "$(sw_step "" "")" "0"
  rm -rf "$CASE_HOME"
  counts=""; for t in $STOOLS; do counts="$counts $t=$(cat "$FD/n.$t" 2>/dev/null || echo 0)"; done
  echo "        calls:$counts"
  for t in $STOOLS; do
    n=$(cat "$FD/n.$t" 2>/dev/null || echo 0); [ "$n" -gt 0 ] || continue
    for at in $(printf '%s\n' 1 $(( (n + 2) / 3 )) $(( (2 * n + 2) / 3 )) "$n" | sort -un); do
      while [ "$(jobs -rp | wc -l)" -ge "$SJOBS" ]; do wait -n; done
      k=$((k + 1)); ( sw_trial "$t" "$at" "$RES/$(printf '%04d' $k)" ) &
    done
  done
done
wait
for f in "$RES"/*; do
  IFS=$'\t' read -r label probs < "$f"
  chk "$label" "$probs" "none"
done
chk "S: every trial reported" "$(ls "$RES" | wc -l)" "$k"

echo; echo "=== E. interrupted, then uninstall directly (no retry)"
newhome E1; D=$CASE_HOME/apps; inst PATH="$FPATH" MV_COUNT="$W/cnt-E1" MV_KILL=70 AIVENUE_INSTALL_DIR="$D" > /dev/null
chk "E1 (first install): uninstall exit" "$(uninst AIVENUE_INSTALL_DIR="$D" sh "${PN}uninstall.sh")" "0"
chk "E1: folder" "$([ -e "$D" ] && left "$D" || echo removed)" "removed"
newhome E2; D=$CASE_HOME/apps; inst AIVENUE_INSTALL_DIR="$D" > /dev/null; put_user "$D"; U=$(usum "$D")
inst PATH="$FPATH" MV_COUNT="$W/cnt-E2" MV_KILL=70 AIVENUE_INSTALL_DIR="$D" > /dev/null
chk "E2 (reinstall): uninstall exit" "$(uninst AIVENUE_INSTALL_DIR="$D" sh "${PN}uninstall.sh")" "0"
chk "E2: left" "$(left "$D")" ".aivenue-install .aivenue-staging.personal-backup blob.bin data my-notes.txt"
chk "E2: user files" "$(usum "$D")" "$U"
newhome E3; D=$CASE_HOME/apps; oldinst "$D"; put_user "$D"; U=$(usum "$D")
inst PATH="$FPATH" MV_COUNT="$W/cnt-E3" MV_KILL=70 AIVENUE_INSTALL_DIR="$D" > /dev/null
chk "E3 (upgrade from 0.2.4): uninstall exit" "$(uninst AIVENUE_INSTALL_DIR="$D" sh "${PN}uninstall.sh")" "0"
chk "E3: left" "$(left "$D")" ".aivenue-install .aivenue-staging.personal-backup blob.bin data my-notes.txt"
chk "E3: user files" "$(usum "$D")" "$U"

echo; echo "=== F. stopped after the first file (mv #2 fails); the user puts a file where Aivenue has not written yet"
LASTF=$(grep -vxF .aivenue-files "${PN}.aivenue-files" | tail -n 1); echo "        path: $LASTF"
for then in retry uninstall; do
  newhome "F-$then"; D=$CASE_HOME/apps; inst PATH="$FPATH" MV_COUNT="$W/cnt-F-$then" MV_FAIL=2 AIVENUE_INSTALL_DIR="$D" > /dev/null
  mkdir -p "$(dirname "$D/$LASTF")"; printf 'MY OWN FILE \000\377' > "$D/$LASTF"; H=$(sha256sum < "$D/$LASTF")
  if [ $then = retry ]; then
    chk "F-retry: retry exit (refused)" "$(inst AIVENUE_INSTALL_DIR="$D")" "1"
    chk "F-retry: the path is listed" "$(grep -cF "$LASTF" "$W/last.log")" "1"
    chk "F-retry: user file" "$(sha256sum < "$D/$LASTF")" "$H"
    mv "$D/$LASTF" "$W/F-moved-away"
    chk "F-retry: moved away, retry exit" "$(inst AIVENUE_INSTALL_DIR="$D")" "0"
    chk "F-retry: state" "$(state "$D")" "$CLEAN"
  else
    chk "F-uninstall: uninstall exit" "$(uninst AIVENUE_INSTALL_DIR="$D" sh "${PN}uninstall.sh")" "0"
    chk "F-uninstall: user file" "$(sha256sum < "$D/$LASTF" 2>/dev/null)" "$H"
  fi
done

echo; echo "=== G. a user folder named .aivenue-staging.*: reinstall, then uninstall"
newhome G; D=$CASE_HOME/apps; inst AIVENUE_INSTALL_DIR="$D" > /dev/null; put_user "$D"; U=$(usum "$D")
chk "G: reinstall exit" "$(inst AIVENUE_INSTALL_DIR="$D")" "0"
chk "G: user files" "$(usum "$D")" "$U"
chk "G: uninstall exit" "$(uninst sh "$D/uninstall.sh")" "0"
chk "G: user files" "$(usum "$D")" "$U"
chk "G: left" "$(left "$D")" ".aivenue-install .aivenue-staging.personal-backup blob.bin data my-notes.txt"

echo; echo "=== H. uninstall where resources/app.asar cannot be removed, then the same command again"
newhome H; D=$CASE_HOME/apps; inst AIVENUE_INSTALL_DIR="$D" > /dev/null; put_user "$D"; U=$(usum "$D")
chk "H: uninstall 1 exit (failed)" "$(uninst PATH="$FPATH" RM_FAIL=resources/app.asar sh "$D/uninstall.sh")" "1"
sed 's/^/        /' "$W/last.log" | grep -v '^ *$'
chk "H: app.asar still listed, uninstall.sh still there" "$(grep -cx resources/app.asar "$D/.aivenue-files")/$([ -f "$D/uninstall.sh" ] && echo there)" "1/there"
chk "H: uninstall 2 exit" "$(uninst sh "$D/uninstall.sh")" "0"
chk "H: left" "$(left "$D")" ".aivenue-install .aivenue-staging.personal-backup blob.bin data my-notes.txt"
chk "H: user files" "$(usum "$D")" "$U"
chk "H: command and menu entry removed" "$(shortcuts_gone)" "yes"

echo; echo "=== I. normal uninstall of the default install (from the install folder); the data folder stays"
newhome I; D=$CASE_HOME/.local/share/aivenue; mkdata "$CASE_HOME/.aivenue"; inst > /dev/null; put_user "$D"; U=$(usum "$D"); DS=$(dsum "$CASE_HOME/.aivenue")
chk "I: uninstall exit" "$(uninst sh "$D/uninstall.sh")" "0"
chk "I: left" "$(left "$D")" ".aivenue-install .aivenue-staging.personal-backup blob.bin data my-notes.txt"
chk "I: user files" "$(usum "$D")" "$U"
chk "I: AIVENUE_HOME" "$(dsum "$CASE_HOME/.aivenue")" "$DS"
chk "I: command and menu entry removed" "$(shortcuts_gone)" "yes"

echo; echo "=== J. uninstall a 0.2.4 install (default folder) with the new package's uninstall.sh, from the extracted folder"
newhome J; D=$CASE_HOME/.local/share/aivenue; mkdata "$CASE_HOME/.aivenue"; oldinst "$D"; put_user "$D"; U=$(usum "$D"); DS=$(dsum "$CASE_HOME/.aivenue")
chk "J: uninstall exit" "$(uninst sh "${PN}uninstall.sh")" "0"
chk "J: left" "$(left "$D")" ".aivenue-install .aivenue-staging.personal-backup blob.bin data my-notes.txt"
chk "J: user files" "$(usum "$D")" "$U"
chk "J: AIVENUE_HOME" "$(dsum "$CASE_HOME/.aivenue")" "$DS"
chk "J: command and menu entry removed" "$(shortcuts_gone)" "yes"

echo; echo "=== Summary: $PASSES passed, $FAILS failed"
[ "$FAILS" = 0 ]
