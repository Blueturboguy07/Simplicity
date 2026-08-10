#!/usr/bin/env bash
#
# Uninstalls Simplicity from macOS: the app bundle, everything it wrote to
# ~/Library/Application Support, and the small Electron/Chromium cache and
# state folders that come with any Electron app. See ../UNINSTALL.md for the
# full breakdown of what each path is and why it exists — this script is
# just that document made executable.
#
# Nothing here runs at startup (no login item, no daemon), so there's
# nothing to disable first — quitting the app and removing these paths is
# the entire uninstall.
#
# Usage:
#   ./scripts/uninstall.sh            interactive (asks before deleting)
#   ./scripts/uninstall.sh --yes      skip the confirmation prompt
#   ./scripts/uninstall.sh --dry-run  print what would be removed, remove nothing

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This script only knows how to uninstall the macOS build." >&2
  echo "On Windows, use Settings > Apps to uninstall, then see UNINSTALL.md" >&2
  echo "for how to remove leftover data by hand." >&2
  exit 1
fi

assume_yes=false
dry_run=false
for arg in "$@"; do
  case "$arg" in
    --yes|-y) assume_yes=true ;;
    --dry-run) dry_run=true ;;
    --help|-h)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (try --help)" >&2
      exit 1
      ;;
  esac
done

# Every path Simplicity's own code writes to, plus the Electron/Chromium
# cache and window-state folders the OS creates alongside any app with this
# bundle ID. Missing entries are expected and fine — most people never touch
# the Ollama binary path, for instance, unless they installed it through the
# app's onboarding "Install" button.
APP_BUNDLE="/Applications/Simplicity.app"
DATA_DIR="$HOME/Library/Application Support/Simplicity"
CACHE_DIR="$HOME/Library/Caches/Simplicity"
SAVED_STATE_DIR="$HOME/Library/Saved Application State/com.simplicity.desktop.savedState"
HTTP_STORAGE_DIR="$HOME/Library/HTTPStorages/com.simplicity.desktop"
HTTP_STORAGE_COOKIES="$HOME/Library/HTTPStorages/com.simplicity.desktop.binarycookies"

targets=(
  "$APP_BUNDLE"
  "$DATA_DIR"
  "$CACHE_DIR"
  "$SAVED_STATE_DIR"
  "$HTTP_STORAGE_DIR"
  "$HTTP_STORAGE_COOKIES"
)

echo "Simplicity uninstaller"
echo "======================"
echo
found_any=false
for t in "${targets[@]}"; do
  if [[ -e "$t" ]]; then
    found_any=true
    size=$(du -sh "$t" 2>/dev/null | cut -f1)
    echo "  will remove: $t  (${size:-unknown size})"
  fi
done

if [[ "$found_any" == false ]]; then
  echo "Nothing found — Simplicity doesn't appear to be installed for this user."
  exit 0
fi

echo
if [[ "$dry_run" == true ]]; then
  echo "Dry run — nothing was deleted."
  exit 0
fi

if [[ "$assume_yes" != true ]]; then
  read -r -p "Delete everything listed above? This cannot be undone. [y/N] " reply
  case "$reply" in
    [yY]|[yY][eE][sS]) ;;
    *) echo "Cancelled — nothing was deleted."; exit 0 ;;
  esac
fi

# Quit the app first so nothing holds the SQLite file or a log fd open mid-delete.
osascript -e 'quit app "Simplicity"' >/dev/null 2>&1 || true

removed=0
for t in "${targets[@]}"; do
  if [[ -e "$t" ]]; then
    rm -rf "$t"
    removed=$((removed + 1))
  fi
done

echo "Removed $removed item(s). Simplicity has been uninstalled."
