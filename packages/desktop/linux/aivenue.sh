#!/bin/sh
# Aivenue launcher: uses Chromium's sandbox when the system allows it, otherwise starts without it.
DIR="$(dirname "$(readlink -f "$0")")"
APP="$DIR/aivenue"
SANDBOX="$DIR/chrome-sandbox"

# 1. chrome-sandbox set up by install.sh (owned by root, setuid): full sandbox.
if [ "$(stat -c %u "$SANDBOX" 2>/dev/null)" = "0" ] && [ -u "$SANDBOX" ]; then
  exec "$APP" "$@"
fi
# 2. Unprivileged user namespaces allowed (most distributions): Chromium sandboxes itself.
if command -v unshare >/dev/null 2>&1 && unshare --user --map-root-user true 2>/dev/null; then
  exec "$APP" "$@"
fi
# 3. Neither (e.g. Ubuntu 24.04 restricts user namespaces): run without the sandbox.
#    Aivenue only shows its own local page, but install.sh explains how to enable the sandbox.
exec "$APP" --no-sandbox "$@"
