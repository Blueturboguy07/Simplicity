# Uninstalling Simplicity

Deleting the app from Applications (macOS) or using "Add or Remove Programs"
(Windows) removes the *program*, but Simplicity — like most desktop apps —
keeps its own data (chat history, provider settings, the local search engine,
and the downloaded Ollama binary if you installed it through the app) in a
separate per-user folder that the OS does not clean up for you. This page
lists every path Simplicity writes to, so you can remove exactly what you
want and nothing you don't.

If you're on a Mac, the fastest way to do all of this at once is
[`scripts/uninstall.sh`](scripts/uninstall.sh) (see below). There is no
equivalent script for Windows yet — follow the manual steps.

## What Simplicity writes to disk

Everything except the app bundle itself lives under one folder, so removing
that one folder removes all of Simplicity's data in one step:

| OS | App data folder |
|---|---|
| macOS | `~/Library/Application Support/Simplicity` |
| Windows | `%APPDATA%\Simplicity` (usually `C:\Users\<you>\AppData\Roaming\Simplicity`) |

Inside it:

- `data/config.json` — your provider connections (API keys, if you added any), preferences
- `data/db.sqlite` — chat history (unless you used Incognito threads, which are never written here)
- `drizzle/` — database migration files, refreshed on every launch
- `bin/` — the Ollama binary, **only if** you installed it through Simplicity's "Install" button rather than already having it on your machine
- `searxng/` — the local search engine: a self-contained Python runtime plus the SearXNG source, downloaded once on first launch (~150 MB)
- `logs/` — `simplicity.log` and `searxng.log`, plain text, useful for bug reports

Nothing here is a login item, background service, or system daemon —
Simplicity doesn't register anything to run at startup, so there's nothing to
disable before removing files, on either OS.

### The app itself

| OS | Location |
|---|---|
| macOS | `/Applications/Simplicity.app` |
| Windows | Wherever you chose during install (the installer lets you pick a folder; the default is under `%LOCALAPPDATA%\Programs\Simplicity`) |

### macOS cache/state Electron may also create

These are written by Electron/Chromium itself (window state, GPU shader
cache), not by Simplicity's own code — they're small, and normal to skip, but
`scripts/uninstall.sh` removes them for a fully clean slate:

- `~/Library/Caches/Simplicity`
- `~/Library/Saved Application State/com.simplicity.desktop.savedState`
- `~/Library/HTTPStorages/com.simplicity.desktop` (and `.binarycookies` next to it, if present)

## macOS: uninstall

**Option A — the script (recommended):**

```bash
curl -fsSL https://raw.githubusercontent.com/Blueturboguy07/Simplicity/desktop/scripts/uninstall.sh | bash
```

or, from a clone of this repo:

```bash
./scripts/uninstall.sh
```

It prints exactly what it's about to delete and asks for confirmation before
touching anything (`--dry-run` to preview with nothing removed, `--yes` to
skip the prompt).

**Option B — by hand:**

1. Quit Simplicity.
2. Drag `/Applications/Simplicity.app` to the Trash (or `rm -rf` it).
3. Remove its data: `rm -rf ~/Library/Application\ Support/Simplicity`
4. Optional, cosmetic: `rm -rf ~/Library/Caches/Simplicity ~/Library/Saved\ Application\ State/com.simplicity.desktop.savedState`

## Windows: uninstall

1. Quit Simplicity.
2. Settings → Apps → Installed apps → **Simplicity** → Uninstall (or run
   `Uninstall Simplicity.exe` from the folder you installed it into). This
   removes the program files but — same as almost every Windows app —
   **does not** touch your data folder.
3. To also remove your data: delete `%APPDATA%\Simplicity` (paste that
   into File Explorer's address bar, or `Remove-Item -Recurse -Force
   "$env:APPDATA\Simplicity"` in PowerShell).

## I just want to reset Simplicity, not remove it

Quit the app and delete only the `data/` subfolder (`~/Library/Application
Support/Simplicity/data` on macOS, `%APPDATA%\Simplicity\data` on Windows) —
this clears chat history and provider connections but leaves the downloaded
search engine and Ollama binary in place, so the next launch skips the ~150 MB
first-run download.
