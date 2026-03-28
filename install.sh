#!/usr/bin/env bash
set -euo pipefail

APP_NAME="Slashbot"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# ── Pre-flight: check optional dependencies ──────────────────────────────
if ! command -v bd &>/dev/null; then
  echo ""
  echo "NOTE: 'bd' (beads-rust) CLI not found."
  echo "  Slashbot uses bd for task management. Install it with:"
  echo "    brew install beads-rust"
  echo "  or"
  echo "    cargo install beads-rust"
  echo "  (You can also skip this and install later.)"
  echo ""
  read -rp "Continue without bd? [Y/n] " ans
  if [[ "$ans" =~ ^[Nn] ]]; then
    echo "Install bd first, then re-run this script."
    exit 0
  fi
fi

echo "==> Installing dependencies..."
bun install

echo "==> Building & packaging for current system..."
case "$(uname -s)" in
  Darwin)
    bun run dist:mac
    # Pick the correct architecture build
    if [ "$(uname -m)" = "arm64" ]; then
      APP_PATH="dist-electron/mac-arm64/$APP_NAME.app"
    else
      APP_PATH="dist-electron/mac/$APP_NAME.app"
    fi
    if [ -z "$APP_PATH" ]; then
      echo "ERROR: .app bundle not found in dist-electron/" >&2
      exit 1
    fi
    DEST="/Applications/$APP_NAME.app"
    echo "==> Installing $APP_PATH → $DEST"
    rm -rf "$DEST"
    cp -R "$APP_PATH" "$DEST"

    echo "==> Ad-hoc signing $DEST (required for Electron helper apps)..."
    codesign --force --deep --sign - "$DEST"

    # Create CLI symlink so `slashbot` works from terminal
    LINK="/usr/local/bin/slashbot"
    echo "==> Creating CLI symlink at $LINK"
    sudo mkdir -p /usr/local/bin
    sudo ln -sf "$DEST/Contents/MacOS/$APP_NAME" "$LINK"
    echo "Done! Run 'slashbot' or open $APP_NAME from Applications."
    ;;

  Linux)
    bun run dist:linux
    APPIMAGE="$(find dist-electron -name '*.AppImage' -maxdepth 2 | head -1)"
    if [ -z "$APPIMAGE" ]; then
      echo "ERROR: AppImage not found in dist-electron/" >&2
      exit 1
    fi
    DEST="$HOME/.local/bin/slashbot"
    mkdir -p "$HOME/.local/bin"
    cp "$APPIMAGE" "$DEST"
    chmod +x "$DEST"
    echo "Done! Run 'slashbot' (make sure ~/.local/bin is in your PATH)."
    ;;

  *)
    echo "Unsupported OS: $(uname -s)" >&2
    exit 1
    ;;
esac
