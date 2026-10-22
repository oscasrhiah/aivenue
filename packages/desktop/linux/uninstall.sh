#!/bin/sh
# Remove Aivenue installed by install.sh. Conversations and settings in ~/.aivenue are kept.
DEST="${AIVENUE_INSTALL_DIR:-$HOME/.local/share/aivenue}"
rm -f "$HOME/.local/bin/aivenue" "$HOME/.local/share/applications/aivenue.desktop" "$HOME/.local/share/icons/hicolor/512x512/apps/aivenue.png"
case "$DEST" in
  */aivenue) rm -rf "$DEST" ;;
  *) echo "Not removing $DEST (unexpected folder name)"; exit 1 ;;
esac
echo "Aivenue removed. Your conversations and settings are still in ~/.aivenue (delete that folder to remove them too)."
