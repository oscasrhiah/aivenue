#!/bin/sh
# Install Aivenue for the current user (no sudo needed):
#   app      → ~/.local/share/aivenue   (or $AIVENUE_INSTALL_DIR)
#   command  → ~/.local/bin/aivenue
#   menu     → ~/.local/share/applications/aivenue.desktop
# Only the files listed in .aivenue-files are written. A reinstall replaces or removes only files known to be
# Aivenue's; a path the new version needs that holds anything else (a user's file, a link, a folder) stops the install
# before anything is changed. Every other file in the install folder is left alone.
#
# What the install folder records:
#   .aivenue-install   this folder is Aivenue's, and the SHA-256 of the file list a finished install wrote
#   .aivenue-files     the files a finished install put here (it names itself)
#   .aivenue-pending   while an install runs: the files that were Aivenue's when it started and the files it puts in,
#                      each with its SHA-256; the SHA-256 of every file list it writes; its staging folder. It ends with
#                      `end <SHA-256 of everything before>`, and is only used when that matches and every line is a
#                      well-formed record: a plan cut short, or with a record missing its SHA-256, is never used. Each
#                      new plan is put together outside the folder, written in full to a new file, checked the way it
#                      will be read, and then renamed over the old one in one step, so the previous complete plan stays
#                      until the next one replaces it.
# A file counts as Aivenue's only when the records vouch for it: a file list only when its SHA-256 is recorded, a file
# named in .aivenue-pending only when it is there with exactly the recorded content. Anything else at those paths
# (a user's own .aivenue-files, a file put where Aivenue has not written yet) is kept and reported as a conflict.
# Every read, SHA-256 and write the records depend on is checked: if one fails (a read error, a full disk), the install
# stops before it replaces a program file, or, later on, stops and says the install is not finished. If an install is
# stopped at any point, the same install.sh run again finishes it, and uninstall.sh removes what it put in; nothing
# else is touched.
set -e
export LC_ALL=C
SRC="$(dirname "$(readlink -f "$0")")"
DEST="$(readlink -m "${AIVENUE_INSTALL_DIR:-$HOME/.local/share/aivenue}")"
case "$SRC" in /*) ;; *) echo "Could not find the folder this install.sh is in" >&2; exit 1 ;; esac
case "$DEST" in /?*) ;; *) echo "Could not resolve the install folder" >&2; exit 1 ;; esac
BIN="$HOME/.local/bin"
APPS="$HOME/.local/share/applications"
ICONS="$HOME/.local/share/icons/hicolor/512x512/apps"
MARK=".aivenue-install"
LIST=".aivenue-files"
LEGACY=".aivenue-legacy-files"
PENDING=".aivenue-pending"
PENDING_HEAD="aivenue-pending 2"
MARK_TEXT='Aivenue install folder. uninstall.sh removes the files listed in .aivenue-files; other files are kept.'

# An install from before the file list (0.2.4 and earlier): its app files, no marker.
is_legacy() { [ ! -f "$1/$MARK" ] && [ -f "$1/aivenue.sh" ] && [ -f "$1/aivenue" ] && [ -f "$1/resources/app.asar" ]; }
# A list of paths inside the folder (no absolute paths, no `..`, no empty lines); a list that cannot be read is not.
safe_list() { if grep -qE '^/|(^|/)\.\.(/|$)|^$' "$1"; then return 1; else [ $? -eq 1 ]; fi; }
# A package's list: safe, and names Aivenue's files.
valid_list() { [ -s "$1" ] && safe_list "$1" && grep -qx 'aivenue' "$1" && grep -qx 'resources/app.asar' "$1"; }
# The real location of $1/$2 is exactly that path: no link on the way (or at the end) leads anywhere else.
# A path that cannot be resolved is recorded in $IOERR, and the script stops on it (nothing is decided on a guess).
in_place() {
  ia_="$(readlink -m "$1/$2")" && ib_="$(readlink -m "$1")" || { echo "  $1/$2 (its location could not be resolved)" >> "$IOERR"; return 1; }
  [ "$ia_" = "$ib_/$2" ]
}
# $1/$2 is a regular file really inside $1.
is_file_here() { in_place "$1" "$2" && [ -f "$1/$2" ] && [ ! -L "$1/$2" ]; }
# The SHA-256 of file $1, or a failure when it cannot be read: never an empty or partial value.
hash_of() {
  h_="$(sha256sum < "$1")" || return 1
  h_="${h_%% *}"
  case "$h_" in *[!0-9a-f]*) return 1 ;; esac
  [ "${#h_}" -eq 64 ] || return 1
  printf '%s\n' "$h_"
}
is_sha() { case "$1" in *[!0-9a-f]*) return 1 ;; esac; [ "${#1}" -eq 64 ]; }
rand16() { od -An -N8 -tx1 /dev/urandom | tr -d ' \n'; }
# The files listed in $2 that are in folder $1 now.
present() { while IFS= read -r f; do if is_file_here "$1" "$f"; then printf '%s\n' "$f"; fi; done < "$2"; }
# File $1 is a complete plan of this installer: its header; then `stage NAME ID`; then only records `list SHA` and
# `old|new SHA  path` (a SHA-256, and a path inside the folder); and last `end <SHA-256 of all the lines before it>`.
# A plan cut short, changed, or with a record that is not of this form (an empty SHA-256) is not.
plan_complete() {
  n_="$(wc -l < "$1")" || return 1
  [ "$n_" -ge 3 ] || return 1
  [ "$(sed -n '1p' "$1")" = "$PENDING_HEAD" ] || return 1
  sed -n '2p' "$1" | grep -qE '^stage \.aivenue-staging\.[0-9a-f]{16} [0-9a-f]{16}$' || return 1
  e_="$(sed -n '$p' "$1")" || return 1
  case "$e_" in "end "*) ;; *) return 1 ;; esac
  is_sha "${e_#end }" || return 1
  r_="$(grep -cE '^(list [0-9a-f]{64}|(old|new) [0-9a-f]{64}  [^/].*)$' "$1")" || { [ $? -eq 1 ] || return 1; }
  case "$r_" in ''|*[!0-9]*) return 1 ;; esac
  [ "$r_" -eq $((n_ - 3)) ] || return 1
  if grep -qE '^(old|new) [0-9a-f]{64}  (.*/)?\.\.(/.*)?$' "$1"; then return 1; else [ $? -eq 1 ] || return 1; fi
  b_="$(sed '$d' "$1" | sha256sum)" || return 1
  [ "${b_%% *}" = "${e_#end }" ]
}
# Publish the plan whose lines are in file $2 for folder $1: written in full, with its end line, to a new file in $1,
# checked as the reader will check it, then renamed over .aivenue-pending in one step. Until then the previous plan,
# if any, stays as it was.
publish_plan() {
  p_="$(mktemp "$1/$PENDING.XXXXXX")" || return 1
  if eh_="$(hash_of "$2")" && cat "$2" > "$p_" && printf 'end %s\n' "$eh_" >> "$p_" && plan_complete "$p_" &&
    [ "$(sed -n '$p' "$p_")" = "end $eh_" ] && mv -f "$p_" "$1/$PENDING"; then return 0; fi
  rm -f "$p_"
  return 1
}
# The SHA-256 of every file list the installer wrote in DEST: in the marker (finished) and in the stopped install's
# plan (its checked copy, $PLAN). Fails if the marker cannot be read.
recorded_lists() {
  if is_file_here "$DEST" "$MARK"; then sed -n 's/^list \([0-9a-f]\{64\}\)$/\1/p' "$DEST/$MARK" || return 1; fi
  if [ -n "$PLAN" ]; then sed -n 's/^list \([0-9a-f]\{64\}\)$/\1/p' "$PLAN" || return 1; fi
}
# The files the stopped install's plan recorded (the old version's and the ones it put in) that are in DEST with
# exactly a recorded content. Fails, naming each one, if a file there cannot be read to check it.
pending_owned() {
  [ -n "$PLAN" ] || return 0
  e_="$(mktemp)" || return 1
  q_="$(mktemp)" || { rm -f "$e_"; return 1; }
  if ! { sed -n -e 's/^old //p' -e 's/^new //p' "$PLAN" > "$e_" && cut -c67- "$e_" > "$q_" && sort -u -o "$q_" "$q_"; }; then
    rm -f "$e_" "$q_"; return 1
  fi
  r_=0
  while IFS= read -r f; do
    case "/$f/" in */../*) continue ;; esac
    is_file_here "$DEST" "$f" || continue
    if ! x_="$(hash_of "$DEST/$f")"; then echo "  $DEST/$f (could not be read to check it against the install records)" >&2; r_=1; continue; fi
    if grep -qxF "$x_  $f" "$e_"; then printf '%s\n' "$f"; else [ $? -eq 1 ] || r_=1; fi
  done < "$q_"
  rm -f "$e_" "$q_"
  return $r_
}
# The staging folder a stopped install made: named in its plan (the second line, `stage NAME ID`), and holding the id
# recorded with it. Prints nothing when there is none; fails when it cannot be checked.
recorded_stage() {
  [ -n "$PLAN" ] || return 0
  { IFS= read -r l_ && IFS= read -r l_; } < "$PLAN" || return 1
  l_="${l_#stage }"; n_="${l_%% *}"; id_="${l_#* }"
  { [ -d "$DEST/$n_" ] && [ ! -L "$DEST/$n_" ] && in_place "$DEST" "$n_" && is_file_here "$DEST/$n_" .aivenue-stage-id; } || return 0
  s_=""
  IFS= read -r s_ < "$DEST/$n_/.aivenue-stage-id" || [ -n "$s_" ] || [ ! -s "$DEST/$n_/.aivenue-stage-id" ] || return 1
  if [ "$s_" = "$id_" ]; then echo "$n_"; fi
}
# Append `$1 <SHA-256>  path` to file $4 for each file in list $3 (in folder $2), except the file list itself. Fails,
# naming the file, if one cannot be read.
add_entries() {
  while IFS= read -r f; do
    [ "$f" != "$LIST" ] || continue
    if ! x_="$(hash_of "$2/$f")"; then echo "  $2/$f (could not be read to record its SHA-256)" >&2; return 1; fi
    printf '%s %s  %s\n' "$1" "$x_" "$f" >> "$4" || return 1
  done < "$3"
}
# Write folder $1's marker in one step, recording the given file-list SHA-256 values (each must be one).
write_marker() {
  d_="$1"; shift
  for x_; do is_sha "$x_" || return 1; done
  m_="$(mktemp "$d_/$MARK.XXXXXX")" || return 1
  if { printf '%s\n' "$MARK_TEXT" && { [ $# -eq 0 ] || printf 'list %s\n' "$@"; }; } > "$m_" && mv -f "$m_" "$d_/$MARK"; then return 0; fi
  rm -f "$m_"
  return 1
}
# Put a file list (the files in $2, and itself) in folder $1 in one step; the plan ($BODY, republished with the list's
# SHA-256 added) records it first. PUT_HASH is that SHA-256.
put_list() {
  t_="$(mktemp "$1/$LIST.XXXXXX")" || return 1
  if cat "$2" > "$t_" && printf '%s\n' "$LIST" >> "$t_" && sort -u -o "$t_" "$t_" && PUT_HASH="$(hash_of "$t_")" &&
    printf 'list %s\n' "$PUT_HASH" >> "$BODY" && publish_plan "$1" "$BODY" && mv -f "$t_" "$1/$LIST"; then return 0; fi
  rm -f "$t_"
  return 1
}
# Files a stopped install left while writing its records (each is written to a new file, then renamed): a complete
# plan, or a file list whose SHA-256 the records hold, is the installer's and goes. Anything else with such a name is
# kept and reported.
tidy_leftovers() {
  for t in "$1/$PENDING".?????? "$1/$LIST".?????? "$1/$MARK".??????; do
    { [ -f "$t" ] && [ ! -L "$t" ]; } || continue
    case "$t" in
      "$1/$PENDING".*) if plan_complete "$t"; then rm -f "$t"; continue; fi ;;
      "$1/$LIST".*) if x_="$(hash_of "$t")" && rl_="$(recorded_lists)" && printf '%s\n' "$rl_" | grep -qxF "$x_"; then rm -f "$t"; continue; fi ;;
    esac
    echo "Note: kept $t: it is not used (a record a stopped install had not finished writing, or not the installer's); delete it if you do not need it." >&2
  done
}
# Remove the files listed in $2 from folder $1 (only regular files really there); print each one that is still there.
remove_files() {
  while IFS= read -r f; do
    if is_file_here "$1" "$f"; then
      rm -f "$1/$f" 2>/dev/null || true
      if [ -e "$1/$f" ]; then printf '%s\n' "$f"; fi
    fi
  done < "$2"
}
# Remove the folders the files listed in $2 were in, when they are empty. Each one's whole real path is checked, so
# a link anywhere on the way never leads a removal outside $1.
remove_dirs() {
  rd_="$(mktemp)" || return 1
  if awk -F/ '{ p = ""; for (i = 1; i < NF; i++) { p = (i == 1 ? $1 : p "/" $i); print p } }' "$2" > "$rd_" && sort -ru -o "$rd_" "$rd_"; then
    while IFS= read -r d; do if in_place "$1" "$d" && [ -d "$1/$d" ]; then rmdir "$1/$d" 2>/dev/null || true; fi; done < "$rd_"
    rm -f "$rd_"
    return 0
  fi
  rm -f "$rd_"
  return 1
}
refuse() { echo "$1" >&2; exit 1; }
# A record or file the install needs could not be read: stop before anything is changed.
unreadable() { refuse "Refusing to install into $DEST: could not read $1 to check it against the install records; nothing was changed. Fix the cause (for example the permissions or a failing disk) and run install.sh again."; }

IOERR="$(mktemp)"
OWNED="$(mktemp)"
PROBLEMS="$(mktemp)"
SRCLIST="$(mktemp)"
SRCLEGACY="$(mktemp)"
PLAN=""
LISTCOPY=""
STAGE=""
BODY=""
trap 'rm -f "$IOERR" "$OWNED" "$PROBLEMS" "$SRCLIST" "$SRCLEGACY" ${PLAN:+"$PLAN"} ${LISTCOPY:+"$LISTCOPY"} ${BODY:+"$BODY"}; [ -n "$STAGE" ] && rm -rf "$STAGE"' EXIT
# The package's lists are read once, in full (a read error stops here), and only these copies are used.
if ! cat "$SRC/$LIST" > "$SRCLIST" 2>/dev/null || ! cat "$SRC/$LEGACY" > "$SRCLEGACY" 2>/dev/null || ! valid_list "$SRCLIST" || ! valid_list "$SRCLEGACY"; then
  refuse "This package is incomplete ($SRC/$LIST or $LEGACY is missing, unreadable or not valid); download it again"
fi
case "$DEST" in /|"$(readlink -m "$HOME")") refuse "Refusing to install into $DEST; choose a folder of its own, e.g. $HOME/.local/share/aivenue" ;; esac
[ "$DEST" != "$SRC" ] || refuse "Already installed in $DEST (run install.sh from the extracted package to reinstall)"

# Which files already in DEST are Aivenue's, and so may be replaced or removed (only those there now):
#   - a stopped install (its plan is there): only what the plan recorded and is there with a recorded content, and
#     the file list when its SHA-256 is recorded. Nothing else is claimed back, not by the list's content and not by
#     the legacy list: a file that appeared at such a path afterwards is not Aivenue's.
#   - otherwise: the file list, when its SHA-256 is recorded, and the files on it; in an install without a list
#     (0.2.4 and earlier), the legacy list's files.
# The plan and the file list are each read once into a copy that is checked, and only the copy is used.
LISTOK=""
LISTHASH=""
HADPLAN=""
DESTLS=""
if [ -e "$DEST" ] && ! DESTLS="$(ls -A "$DEST")"; then unreadable "$DEST"; fi
if [ ! -e "$DEST" ] || [ -z "$DESTLS" ]; then
  KIND=new
else
  if [ -f "$DEST/$MARK" ] && [ ! -L "$DEST/$MARK" ]; then
    KIND=aivenue
  elif is_legacy "$DEST"; then
    KIND=legacy
  elif [ -f "$DEST/$PENDING" ] && [ ! -L "$DEST/$PENDING" ]; then
    KIND=aivenue  # a stopped install's plan, and nothing else yet (it is checked below)
  else
    refuse "Refusing to install into $DEST: the folder is not empty and is not an Aivenue install"
  fi
  if [ -e "$DEST/$PENDING" ] || [ -L "$DEST/$PENDING" ]; then
    NOTPLAN="Refusing to install into $DEST: $DEST/$PENDING is not a complete record of this installer (cut short while it was written, a record in it not valid, or not the installer's), so it cannot tell which files are Aivenue's; nothing was changed and the file is kept. Move it out of the folder and run install.sh again."
    is_file_here "$DEST" "$PENDING" || refuse "$NOTPLAN"
    PLAN="$(mktemp)"
    cat "$DEST/$PENDING" > "$PLAN" || unreadable "$DEST/$PENDING"
    plan_complete "$PLAN" || refuse "$NOTPLAN"
    HADPLAN=1
  fi
  if [ -e "$DEST/$LIST" ] || [ -L "$DEST/$LIST" ]; then
    if is_file_here "$DEST" "$LIST"; then
      LISTCOPY="$(mktemp)"
      cat "$DEST/$LIST" > "$LISTCOPY" || unreadable "$DEST/$LIST"
      LISTHASH="$(hash_of "$LISTCOPY")" || unreadable "$DEST/$LIST"
      RL="$(recorded_lists)" || unreadable "$DEST/$MARK"
      if printf '%s\n' "$RL" | grep -qxF "$LISTHASH" && safe_list "$LISTCOPY"; then
        LISTOK=1
        echo "$LIST" >> "$OWNED"
        [ -n "$HADPLAN" ] || present "$DEST" "$LISTCOPY" >> "$OWNED"
      fi
    fi
  fi
  if [ -n "$HADPLAN" ]; then
    pending_owned >> "$OWNED" || refuse "Refusing to install into $DEST: the files above could not be read to check them against the install records; nothing was changed. Fix the cause (for example the permissions or a failing disk) and run install.sh again."
  elif [ "$KIND" = legacy ]; then
    present "$DEST" "$SRCLEGACY" >> "$OWNED"
  fi
fi
sort -u -o "$OWNED" "$OWNED"
# The stopped install's staging folder (it goes before the new one is made).
OLDSTAGE="$(recorded_stage)" || unreadable "the staging folder named in $DEST/$PENDING"

# Every path the new version writes: its file is in this package and readable; the path is free or an Aivenue file,
# and really inside DEST. The install's own records must be files (or not there).
for f in "$MARK" "$PENDING"; do
  if { [ -e "$DEST/$f" ] || [ -L "$DEST/$f" ]; } && ! is_file_here "$DEST" "$f"; then echo "  $f (already there and not an Aivenue file)" >> "$PROBLEMS"; fi
done
while IFS= read -r f; do
  p="$DEST/$f"
  if [ ! -f "$SRC/$f" ] || [ ! -r "$SRC/$f" ]; then
    echo "  $f (missing or unreadable in the package $SRC; extract it again)" >> "$PROBLEMS"
  elif ! in_place "$DEST" "$f"; then
    echo "  $f (a link leads it outside $DEST)" >> "$PROBLEMS"
  elif [ "$f" = "$LIST" ] && { [ -e "$p" ] || [ -L "$p" ]; } && [ -z "$LISTOK" ]; then
    echo "  $f (not written by this installer: its content does not match the install records; it is kept)" >> "$PROBLEMS"
  elif { [ -e "$p" ] || [ -L "$p" ]; } && ! grep -qxF -- "$f" "$OWNED"; then
    echo "  $f (already there and not an Aivenue file)" >> "$PROBLEMS"
  else
    d="$(dirname "$f")"
    while [ "$d" != "." ]; do
      if [ -e "$DEST/$d" ] && [ ! -d "$DEST/$d" ]; then echo "  $d (a file where Aivenue needs a folder)" >> "$PROBLEMS"; break; fi
      d="$(dirname "$d")"
    done
  fi
done < "$SRCLIST"
if [ -s "$IOERR" ]; then
  echo "Refusing to install into $DEST; nothing was changed. These paths could not be checked:" >&2
  head -n 20 "$IOERR" >&2
  echo "Fix the cause and run install.sh again." >&2
  exit 1
fi
if [ -s "$PROBLEMS" ]; then
  echo "Refusing to install into $DEST; nothing was changed. Problems:" >&2
  sort -u "$PROBLEMS" | head -n 20 >&2
  echo "Fix these (extract the package again, or move the files out of the way, or choose another AIVENUE_INSTALL_DIR) and run install.sh again." >&2
  exit 1
fi

# The plan: the files that are Aivenue's now and the files this install puts in, with their SHA-256, the trusted
# file list's SHA-256, and the staging folder. It is put together outside DEST before anything is changed: if any
# file cannot be read and hashed, the install stops here and the folder (and a stopped install's plan) is as it was.
SNAME=".aivenue-staging.$(rand16)"
SID="$(rand16)"
BODY="$(mktemp)"
if ! { printf '%s\nstage %s %s\n' "$PENDING_HEAD" "$SNAME" "$SID" > "$BODY" &&
  { [ -z "$LISTOK" ] || printf 'list %s\n' "$LISTHASH" >> "$BODY"; } &&
  add_entries old "$DEST" "$OWNED" "$BODY" && add_entries new "$SRC" "$SRCLIST" "$BODY"; }; then
  refuse "Refusing to install into $DEST: the file above could not be read to record it in the install plan; nothing was changed. Fix the cause (for example the permissions or a failing disk, or extract the package again) and run install.sh again."
fi

[ ! -d "$DEST" ] || tidy_leftovers "$DEST"
echo "Installing Aivenue to $DEST"
CREATED=""
[ -e "$DEST" ] || CREATED=1
mkdir -p "$DEST" || refuse "Could not create $DEST; nothing was changed"
# 1. A new folder is marked as Aivenue's first (no file list yet).
MARKED=""
if [ "$KIND" = new ]; then
  printf '%s\n' "$MARK_TEXT" > "$DEST/$MARK" || refuse "Could not write $DEST/$MARK; nothing was changed"
  MARKED=1
fi
[ -z "$OLDSTAGE" ] || rm -rf "${DEST:?}/$OLDSTAGE" || refuse "Could not remove the staging folder $DEST/$OLDSTAGE; no file was replaced. Fix the cause and run install.sh again."
# 2. The plan is published in one step (checked first; a stopped install's plan stays until then, and this one
#    vouches for everything that one did and is there). Then the whole new version is copied into the staging folder
#    (inside DEST, same file system), leaving the old version as it is, and each copy is checked against the SHA-256
#    the plan records for it. A failure here removes what this step made.
planned=""
if [ ! -e "$DEST/$SNAME" ] && publish_plan "$DEST" "$BODY" && mkdir "$DEST/$SNAME" && echo "$SID" > "$DEST/$SNAME/.aivenue-stage-id"; then
  planned=1
  STAGE="$DEST/$SNAME"
  while IFS= read -r f; do
    if ! mkdir -p "$STAGE/$(dirname "$f")" || ! cp -p "$SRC/$f" "$STAGE/$f"; then planned=""; break; fi
  done < "$SRCLIST"
  [ -z "$planned" ] || chmod 755 "$STAGE/aivenue" "$STAGE/aivenue.sh" "$STAGE/chrome_crashpad_handler" "$STAGE/install.sh" "$STAGE/uninstall.sh" || planned=""
  [ -z "$planned" ] || while IFS= read -r f; do
    [ "$f" != "$LIST" ] || continue
    if ! x_="$(hash_of "$STAGE/$f")" || ! grep -qxF "new $x_  $f" "$BODY"; then
      echo "  $STAGE/$f (the copy could not be read, or is not what the plan records)" >&2; planned=""; break
    fi
  done < "$SRCLIST"
fi
if [ -z "$planned" ]; then
  [ -z "$STAGE" ] || rm -rf "$STAGE"
  STAGE=""
  if [ -z "$HADPLAN" ]; then
    rm -f "$DEST/$PENDING"
    [ -z "$MARKED" ] || rm -f "$DEST/$MARK"
    [ -z "$CREATED" ] || rmdir "$DEST" 2>/dev/null || true
    refuse "Could not write the install plan or copy the new version; nothing was changed in $DEST. Fix the cause and run install.sh again."
  fi
  # The stopped install's plan, or this run's that replaced it and vouches for the same files there, stays the record.
  refuse "Could not write the install plan or copy the new version; no file was replaced in $DEST. Fix the cause and run install.sh again."
fi
# 3. Put each new file in place: a rename within the file system, replacing the old file of that name at once.
while IFS= read -r f; do
  [ "$f" != "$LIST" ] || continue
  if ! mkdir -p "$DEST/$(dirname "$f")" || ! mv -f "$STAGE/$f" "$DEST/$f"; then
    refuse "Could not put $DEST/$f in place. Fix the cause and run the same install.sh again to finish (your files in $DEST are kept)."
  fi
done < "$SRCLIST"
NOTDONE="The install is not finished. Fix the cause and run the same install.sh again to finish (your files in $DEST are kept)."
# 4. Remove the old version's files the new one no longer has. Any that cannot be removed stay on the list, so
#    uninstall.sh (or the next install) still knows them.
OLDONLY="$STAGE/.aivenue-old-only"
FINAL="$STAGE/.aivenue-final-list"
grep -vxF -f "$SRCLIST" "$OWNED" > "$OLDONLY" || [ $? -eq 1 ] || refuse "Could not work out which files of the old version to remove. $NOTDONE"
LEFT="$(remove_files "$DEST" "$OLDONLY")"
remove_dirs "$DEST" "$OLDONLY" || true
[ ! -s "$IOERR" ] || refuse "Could not check where some files of the old version are. $NOTDONE"
{ cp "$SRCLIST" "$FINAL" && { [ -z "$LEFT" ] || printf '%s\n' "$LEFT" >> "$FINAL"; }; } || refuse "Could not write the new file list. $NOTDONE"
# 5. The new file list (its SHA-256 recorded in the plan first), the marker recording it, then the staging folder and
#    the plan go.
if ! put_list "$DEST" "$FINAL" || ! write_marker "$DEST" "$PUT_HASH"; then
  refuse "Could not put $DEST/$LIST in place. $NOTDONE"
fi
rm -rf "$STAGE" || refuse "Could not remove $STAGE. $NOTDONE"
STAGE=""
rm -f "$DEST/$PENDING" || refuse "Could not remove $DEST/$PENDING. $NOTDONE"
if [ -n "$LEFT" ]; then
  echo "Could not remove these files of the old version (they are still listed; uninstall.sh removes them later):" >&2
  printf '%s\n' "$LEFT" | head -n 20 | sed 's/^/  /' >&2
fi
if ! { mkdir -p "$BIN" "$APPS" "$ICONS" && ln -sf "$DEST/aivenue.sh" "$BIN/aivenue" && cp "$DEST/aivenue.png" "$ICONS/aivenue.png" &&
  cat > "$APPS/aivenue.desktop" <<EOF
[Desktop Entry]
Name=Aivenue
Comment=Run AI coding CLIs together: plan, review, implement, verify
Exec=$DEST/aivenue.sh %U
Icon=aivenue
Terminal=false
Type=Application
Categories=Development;
StartupWMClass=Aivenue
EOF
}; then
  refuse "Aivenue is installed in $DEST, but the command ($BIN/aivenue) or the menu entry could not be set up. Fix the cause and run install.sh again (it keeps the install)."
fi
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" >/dev/null 2>&1 || true

echo
echo "Done. Start Aivenue from the application menu, or run: aivenue"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "(Add $BIN to your PATH to use the 'aivenue' command.)" ;; esac
echo "To remove it later: $DEST/uninstall.sh"
echo
echo "Optional: enable Chromium's sandbox (recommended on systems that restrict user namespaces, e.g. Ubuntu 24.04):"
echo "  sudo chown root:root \"$DEST/chrome-sandbox\" && sudo chmod 4755 \"$DEST/chrome-sandbox\""
