#!/bin/sh
# Remove Aivenue installed by install.sh. Conversations and settings (~/.aivenue, or $AIVENUE_HOME) are kept.
# Only files the install records vouch for are removed. After a stopped install (its .aivenue-pending is there): the
# files it recorded that are there with exactly a recorded content, the file list when its SHA-256 is recorded, and
# the staging folder it recorded; nothing is claimed back by a list's content or the legacy list. Otherwise: the file
# list when its SHA-256 is recorded in the marker, and the files on it; for an install from before the list (0.2.4
# and earlier), the legacy list's files, which a newer extracted package carries.
# Anything else in the install folder (data, notes, a backup folder, a .aivenue-files the installer did not write)
# stays, and so does the folder itself then.
# Every record is read once into a copy that is checked (a plan only when it is complete and every record in it is
# well formed), and every SHA-256 is checked: if a record or a recorded file cannot be read, nothing is removed and
# uninstall.sh says why. If a file cannot be removed, nothing is forgotten: the records keep what is left, uninstall.sh
# reports the failure, and running it again finishes the job.
# Which install: $AIVENUE_INSTALL_DIR if set; else the folder this script is in, when it is an install;
# else the one the `aivenue` command points to; else ~/.local/share/aivenue.
export LC_ALL=C
SELF="$(dirname "$(readlink -f "$0")")"
case "$SELF" in /*) ;; *) echo "Could not find the folder this uninstall.sh is in" >&2; exit 1 ;; esac
BIN_LINK="$HOME/.local/bin/aivenue"
DESKTOP="$HOME/.local/share/applications/aivenue.desktop"
ICON="$HOME/.local/share/icons/hicolor/512x512/apps/aivenue.png"
MARK=".aivenue-install"
LIST=".aivenue-files"
LEGACY=".aivenue-legacy-files"
PENDING=".aivenue-pending"
PENDING_HEAD="aivenue-pending 2"
MARK_TEXT='Aivenue install folder. uninstall.sh removes the files listed in .aivenue-files; other files are kept.'
REMOVED_TEXT='Aivenue was removed from this folder; the other files here were kept.'
DATA="$(readlink -m "${AIVENUE_HOME:-$HOME/.aivenue}")"

is_install() {
  [ -f "$1/$MARK" ] || { [ -f "$1/$PENDING" ] && [ ! -L "$1/$PENDING" ]; } || { [ -f "$1/aivenue.sh" ] && [ -f "$1/aivenue" ] && [ -f "$1/resources/app.asar" ]; }
}
is_legacy() { [ ! -f "$1/$MARK" ] && [ -f "$1/aivenue.sh" ] && [ -f "$1/aivenue" ] && [ -f "$1/resources/app.asar" ]; }
safe_list() { if grep -qE '^/|(^|/)\.\.(/|$)|^$' "$1"; then return 1; else [ $? -eq 1 ]; fi; }
valid_list() { [ -s "$1" ] && safe_list "$1" && grep -qx 'aivenue' "$1" && grep -qx 'resources/app.asar' "$1"; }
# A path that cannot be resolved is recorded in $IOERR, and the script stops on it (nothing is decided on a guess).
in_place() {
  ia_="$(readlink -m "$1/$2")" && ib_="$(readlink -m "$1")" || { echo "  $1/$2 (its location could not be resolved)" >> "$IOERR"; return 1; }
  [ "$ia_" = "$ib_/$2" ]
}
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
present() { while IFS= read -r f; do if is_file_here "$1" "$f"; then printf '%s\n' "$f"; fi; done < "$2"; }
# A complete plan: the installer's header; `stage NAME ID`; only records `list SHA` and `old|new SHA  path`; and last
# `end <SHA-256 of all the lines before it>`. A plan cut short, changed, or with a record not of this form (an empty
# SHA-256) is never used.
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
# The file-list SHA-256 values in the marker and in the stopped install's plan (its checked copy, $PLAN). Fails if the
# marker cannot be read.
recorded_lists() {
  if is_file_here "$DEST" "$MARK"; then sed -n 's/^list \([0-9a-f]\{64\}\)$/\1/p' "$DEST/$MARK" || return 1; fi
  if [ -n "$PLAN" ]; then sed -n 's/^list \([0-9a-f]\{64\}\)$/\1/p' "$PLAN" || return 1; fi
}
# The files the plan records that are in DEST with exactly a recorded content. Fails, naming each one, if a file
# there cannot be read to check it.
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
# Write folder $1's marker in one step: text $2, then the given file-list SHA-256 values (each must be one).
write_marker() {
  d_="$1"; text_="$2"; shift 2
  for x_; do is_sha "$x_" || return 1; done
  m_="$(mktemp "$d_/$MARK.XXXXXX")" || return 1
  if { printf '%s\n' "$text_" && { [ $# -eq 0 ] || printf 'list %s\n' "$@"; }; } > "$m_" && mv -f "$m_" "$d_/$MARK"; then return 0; fi
  rm -f "$m_"
  return 1
}
# Put a file list (the files in $2, and itself) in folder $1. The marker records its SHA-256 before it is put in place
# (next to the ones already recorded) and alone after, so the list on disk is always one the records vouch for.
put_list() {
  t_="$(mktemp "$1/$LIST.XXXXXX")" || return 1
  if cat "$2" > "$t_" && printf '%s\n' "$LIST" >> "$t_" && sort -u -o "$t_" "$t_" && nh_="$(hash_of "$t_")" && rl_="$(recorded_lists)"; then
    # shellcheck disable=SC2086
    if write_marker "$1" "$MARK_TEXT" $rl_ "$nh_" && mv -f "$t_" "$1/$LIST" && write_marker "$1" "$MARK_TEXT" "$nh_"; then return 0; fi
  fi
  rm -f "$t_"
  return 1
}
# Records a stopped install had written to a new file but not renamed yet: a complete plan, or a file list whose
# SHA-256 the records hold, is the installer's and goes; anything else with such a name is kept and reported.
tidy_leftovers() {
  for t in "$1/$PENDING".?????? "$1/$LIST".?????? "$1/$MARK".??????; do
    { [ -f "$t" ] && [ ! -L "$t" ]; } || continue
    case "$t" in
      "$1/$PENDING".*) if plan_complete "$t"; then rm -f "$t"; continue; fi ;;
      "$1/$LIST".*) if x_="$(hash_of "$t")" && rl_="$(recorded_lists)" && printf '%s\n' "$rl_" | grep -qxF "$x_"; then rm -f "$t"; continue; fi ;;
    esac
    echo "Note: kept $t: it is not used (a record a stopped install had not finished writing, or not the installer's); delete it if you do not need it."
  done
}
remove_files() {
  while IFS= read -r f; do
    if is_file_here "$1" "$f"; then
      rm -f "$1/$f" 2>/dev/null || true
      if [ -e "$1/$f" ]; then printf '%s\n' "$f"; fi
    fi
  done < "$2"
}
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
remove_shortcuts() {
  if [ -L "$BIN_LINK" ] && [ "$(readlink -m "$BIN_LINK")" = "$DEST/aivenue.sh" ]; then rm -f "$BIN_LINK"; fi
  if [ -f "$DESKTOP" ] && grep -qxF "Exec=$DEST/aivenue.sh %U" "$DESKTOP"; then
    rm -f "$DESKTOP" "$ICON"
    command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$HOME/.local/share/applications" >/dev/null 2>&1 || true
  elif [ -f "$DESKTOP" ]; then
    echo "Kept $DESKTOP: it starts a different Aivenue install"
  fi
}

if [ -n "$AIVENUE_INSTALL_DIR" ]; then
  DEST="$(readlink -m "$AIVENUE_INSTALL_DIR")"
elif [ -f "$SELF/$MARK" ]; then
  # Only the marker counts here: the extracted package has the same files but is not an install.
  DEST="$SELF"
elif [ -L "$BIN_LINK" ] && is_install "$(dirname "$(readlink -m "$BIN_LINK")")"; then
  DEST="$(dirname "$(readlink -m "$BIN_LINK")")"
else
  DEST="$(readlink -m "$HOME/.local/share/aivenue")"
fi

case "$DEST" in /?*) ;; *) echo "Could not resolve the install folder" >&2; exit 1 ;; esac
# Check everything before removing anything, so a refusal never leaves a half-removed install.
if [ ! -e "$DEST" ]; then
  echo "No Aivenue install at $DEST (set AIVENUE_INSTALL_DIR to the folder you installed to)" >&2
  exit 1
fi
case "$DEST" in /|"$(readlink -m "$HOME")") echo "Not removing $DEST" >&2; exit 1 ;; esac
if ! is_install "$DEST"; then
  echo "Not removing $DEST: it does not look like an Aivenue install" >&2
  exit 1
fi
IOERR="$(mktemp)" || exit 1
PLAN=""
LISTCOPY=""
LEGCOPY=""
ALL=""
REST=""
trap 'rm -f "$IOERR" ${PLAN:+"$PLAN"} ${LISTCOPY:+"$LISTCOPY"} ${LEGCOPY:+"$LEGCOPY"} ${ALL:+"$ALL"} ${REST:+"$REST"}' EXIT
# A record or recorded file could not be read: stop before anything is removed.
unreadable() {
  echo "Not removing $DEST: could not read $1 to check it against the install records; nothing was removed. Fix the cause (for example the permissions or a failing disk) and run uninstall.sh again." >&2
  exit 1
}
ALL="$(mktemp)" || exit 1
REST="$(mktemp)" || exit 1
# The plan and the file list are each read once into a copy that is checked; only the copies are used.
if [ -e "$DEST/$PENDING" ] || [ -L "$DEST/$PENDING" ]; then
  NOTPLAN="Not removing $DEST: $DEST/$PENDING is not a complete record of the installer (cut short while it was written, a record in it not valid, or not the installer's), so it cannot tell which files are Aivenue's; nothing was removed and the file is kept. Move it out of the folder and run uninstall.sh again."
  if ! is_file_here "$DEST" "$PENDING"; then echo "$NOTPLAN" >&2; exit 1; fi
  PLAN="$(mktemp)" || exit 1
  cat "$DEST/$PENDING" > "$PLAN" || unreadable "$DEST/$PENDING"
  if ! plan_complete "$PLAN"; then echo "$NOTPLAN" >&2; exit 1; fi
fi
LISTOK=""
CONFLICT=""
if [ -e "$DEST/$LIST" ] || [ -L "$DEST/$LIST" ]; then
  CONFLICT=1
  if is_file_here "$DEST" "$LIST"; then
    LISTCOPY="$(mktemp)" || exit 1
    cat "$DEST/$LIST" > "$LISTCOPY" || unreadable "$DEST/$LIST"
    LH="$(hash_of "$LISTCOPY")" || unreadable "$DEST/$LIST"
    RL="$(recorded_lists)" || unreadable "$DEST/$MARK"
    if printf '%s\n' "$RL" | grep -qxF "$LH" && safe_list "$LISTCOPY"; then
      LISTOK=1
      CONFLICT=""
      echo "$LIST" >> "$ALL"
      [ -n "$PLAN" ] || present "$DEST" "$LISTCOPY" >> "$ALL"
    fi
  fi
fi
if [ -n "$PLAN" ]; then
  # A stopped install: its plan decides, by path and recorded content.
  if ! pending_owned >> "$ALL"; then
    echo "Not removing $DEST: the files above could not be read to check them against the install records; nothing was removed. Fix the cause (for example the permissions or a failing disk) and run uninstall.sh again." >&2
    exit 1
  fi
elif is_legacy "$DEST"; then
  LEGCOPY="$(mktemp)" || exit 1
  if [ "$SELF" != "$DEST" ] && [ -f "$SELF/$LEGACY" ] && cat "$SELF/$LEGACY" > "$LEGCOPY" && valid_list "$LEGCOPY"; then
    present "$DEST" "$LEGCOPY" >> "$ALL"
  else
    echo "Not removing $DEST: it has no list of Aivenue's files ($LIST), or the one in this package could not be read. Run uninstall.sh from a newer extracted package, or remove the folder yourself after moving out anything you keep there." >&2
    exit 1
  fi
fi
sort -u -o "$ALL" "$ALL" || exit 1
STAGE="$(recorded_stage)" || unreadable "the staging folder named in $DEST/$PENDING"
if [ -s "$IOERR" ]; then
  echo "Not removing $DEST: these paths could not be checked; nothing was removed:" >&2
  head -n 20 "$IOERR" >&2
  echo "Fix the cause and run uninstall.sh again." >&2
  exit 1
fi
CONFLICT_NOTE="$DEST/$LIST was not written by the installer (its content does not match the install records), so it is kept."
if [ ! -s "$ALL" ] && [ -z "$STAGE" ] && [ -z "$PLAN" ]; then
  if [ -n "$CONFLICT" ]; then
    echo "Not removing $DEST: $CONFLICT_NOTE Without a file list the installer wrote, Aivenue's files cannot be told apart; nothing was removed. Move that file out of the folder and run uninstall.sh from the extracted package (AIVENUE_INSTALL_DIR=\"$DEST\")." >&2
    exit 1
  fi
  if [ -e "$DEST/aivenue" ] || [ -e "$DEST/resources/app.asar" ]; then
    echo "Not removing $DEST: it has no list of Aivenue's files ($LIST). Remove the folder yourself after moving out anything you keep there." >&2
    exit 1
  fi
  tidy_leftovers "$DEST"
  if [ "$(ls -A "$DEST")" = "$MARK" ]; then
    # Only the marker is left (an install stopped before it put anything in): the folder goes.
    rm -f "${DEST:?}/$MARK"
    rmdir "$DEST" 2>/dev/null || true
    echo "Removed $DEST (Aivenue had not put any file there yet)."
  else
    echo "Aivenue was already removed from $DEST; the files left there are kept."
  fi
  remove_shortcuts
  exit 0
fi

tidy_leftovers "$DEST"
echo "Removing Aivenue from $DEST"
# The stopped install's staging folder first (it is only a copy, and the plan that names it stays until the end).
if [ -n "$STAGE" ] && { ! rm -rf "${DEST:?}/$STAGE" || [ -e "$DEST/$STAGE" ]; }; then
  echo "Could not remove the staging folder $DEST/$STAGE; nothing else was removed. Fix the cause and run uninstall.sh again." >&2
  exit 1
fi
# The file list and this script go last, one at a time, and only when everything else is gone: if something cannot
# be removed, the records and uninstall.sh are still there to run again.
RETRY="AIVENUE_INSTALL_DIR=\"$DEST\" sh \"$SELF/uninstall.sh\""
LAST=""
[ -z "$LISTOK" ] || LAST="$LIST"
[ "$SELF" != "$DEST" ] || LAST="$(printf '%s\nuninstall.sh' "$LAST")"
if printf '%s\n' "$LAST" | grep -vxF -f - "$ALL" > "$REST"; then :; else [ $? -eq 1 ] || { echo "Not removing $DEST: could not work out the files to remove; nothing was removed." >&2; exit 1; }; fi
FAILED="$(remove_files "$DEST" "$REST")"
DIRFAIL=""
remove_dirs "$DEST" "$ALL" || DIRFAIL=1
for f in $LAST; do
  [ -z "$FAILED" ] || break
  printf '%s\n' "$f" > "$REST"
  FAILED="$(remove_files "$DEST" "$REST")"
done
# Whatever the records vouch for and is still there was not removed, whatever the reason; so is a path that could
# not be checked.
[ -n "$FAILED" ] || FAILED="$(present "$DEST" "$ALL")"
[ ! -s "$IOERR" ] || FAILED="${FAILED:+$FAILED
}(files whose location could not be checked)"
if [ -n "$FAILED" ]; then
  # Keep the record of every Aivenue file still here. A list the installer did not write is never replaced: then the
  # stopped install's plan stays the record.
  if [ -z "$CONFLICT" ]; then
    if { present "$DEST" "$ALL" | grep -vxF "$LIST" > "$REST" || [ $? -eq 1 ]; } && put_list "$DEST" "$REST"; then
      rm -f "$DEST/$PENDING"
    fi
  fi
  echo "Could not remove these Aivenue files from $DEST:" >&2
  printf '%s\n' "$FAILED" | head -n 20 | sed 's/^/  /' >&2
  [ -z "$CONFLICT" ] || echo "$CONFLICT_NOTE" >&2
  echo "Aivenue is not fully removed; the install records still name the files it has there. Fix the cause (for example the permissions) and run again:" >&2
  echo "  $RETRY" >&2
  exit 1
fi
if { [ -e "$DEST/$PENDING" ] || [ -L "$DEST/$PENDING" ]; } && ! rm -f "${DEST:?}/$PENDING"; then
  echo "Aivenue's files are removed from $DEST, but its install plan could not be removed. Fix the cause and run again:" >&2
  echo "  $RETRY" >&2
  exit 1
fi
# The marker goes with the folder when nothing else is there; otherwise it is replaced (in one step) by one saying
# Aivenue was removed, so the folder is still known as Aivenue's whatever fails.
if LEFTNAMES="$(ls -A "$DEST")" && { [ -z "$LEFTNAMES" ] || [ "$LEFTNAMES" = "$MARK" ]; }; then
  rm -f "${DEST:?}/$MARK" && rmdir "$DEST" 2>/dev/null
fi
if [ -d "$DEST" ]; then
  # Still Aivenue's folder, so a later install.sh may go back into it (it keeps these files).
  if ! write_marker "$DEST" "$REMOVED_TEXT" && ! printf '%s\n' "$REMOVED_TEXT" > "$DEST/$MARK"; then
    echo "Aivenue's files are removed from $DEST, but its marker could not be written. Fix the cause and run again:" >&2
    echo "  $RETRY" >&2
    exit 1
  fi
  [ -z "$CONFLICT" ] || echo "Kept $CONFLICT_NOTE"
  echo "Kept $DEST: it also holds files that are not part of Aivenue, for example:"
  (cd "$DEST" && find . -mindepth 1 -maxdepth 2 ! -name "$MARK" | head -n 10 | sed 's#^\./#  #')
fi

# The command and menu entry, only if they belong to this install (another install keeps its own).
remove_shortcuts
if [ -n "$DIRFAIL" ]; then
  echo "Aivenue's files are removed from $DEST, but the empty folders they were in could not be checked and may be left there; remove them yourself if you do not need them." >&2
  exit 1
fi
echo "Aivenue removed. Your conversations and settings are still in $DATA (delete that folder to remove them too)."
