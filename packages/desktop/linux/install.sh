#!/bin/sh
# Install Aivenue for the current user (no sudo needed):
#   app      → ~/.local/share/aivenue
#   command  → ~/.local/bin/aivenue
#   menu     → ~/.local/share/applications/aivenue.desktop
set -e
SRC="$(dirname "$(readlink -f "$0")")"
DEST="${AIVENUE_INSTALL_DIR:-$HOME/.local/share/aivenue}"
BIN="$HOME/.local/bin"
APPS="$HOME/.local/share/applications"
ICONS="$HOME/.local/share/icons/hicolor/512x512/apps"

echo "Installing Aivenue to $DEST"
rm -rf "$DEST"
mkdir -p "$DEST" "$BIN" "$APPS" "$ICONS"
cp -a "$SRC/." "$DEST/"
chmod 755 "$DEST/aivenue" "$DEST/aivenue.sh" "$DEST/chrome_crashpad_handler" "$DEST/install.sh" "$DEST/uninstall.sh"
ln -sf "$DEST/aivenue.sh" "$BIN/aivenue"
cp "$DEST/aivenue.png" "$ICONS/aivenue.png"

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
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$APPS" >/dev/null 2>&1 || true

echo
echo "Done. Start Aivenue from the application menu, or run: aivenue"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "(Add $BIN to your PATH to use the 'aivenue' command.)" ;; esac
echo
echo "Optional: enable Chromium's sandbox (recommended on systems that restrict user namespaces, e.g. Ubuntu 24.04):"
echo "  sudo chown root:root \"$DEST/chrome-sandbox\" && sudo chmod 4755 \"$DEST/chrome-sandbox\""
