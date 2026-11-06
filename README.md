# Simplicity

**A free, private, Perplexity-style answer engine that runs entirely on your computer.** No account. No subscription. Your searches never leave your machine — a local search engine does the searching, and answers come from your own AI models: free local ones, your existing Claude subscription, or your own API keys.

## ⬇️ Download

| Platform | Download | Status |
|---|---|---|
| **macOS** (Apple Silicon, macOS 13+) | [Simplicity-mac-arm64.dmg](https://github.com/Blueturboguy07/Simplicity/releases/latest/download/Simplicity-mac-arm64.dmg) | Signed & notarized by Apple · opens clean · tested |
| **Windows** (10/11, 64-bit) | [Simplicity-Setup-Windows.exe](https://github.com/Blueturboguy07/Simplicity/releases/latest/download/Simplicity-Setup-Windows.exe) | **Beta** — built natively on Windows CI; install and uninstall are machine-tested on every build. If it misbehaves, [open an issue](https://github.com/Blueturboguy07/Simplicity/issues). |

### First-open notes

**macOS** — the app is signed with an Apple Developer ID and notarized by Apple. It opens like any other app, no warnings.

**Windows — SmartScreen warning (normal).** You'll see *"Windows protected your PC."* This appears for any new app that hasn't accumulated download reputation with Microsoft — it is not a malware verdict. Click **More info → Run anyway**. Two clicks, one time.

### First launch

The first run downloads the local search engine (~150 MB on macOS, ~1.4 GB on Windows — Windows' official Ollama package bundles CUDA and Vulkan support the macOS one doesn't need). If you want free local AI models, the setup screen installs [Ollama](https://ollama.com) for you with one click, on macOS or Windows — or plug in an API key (OpenAI, Anthropic, Google, Groq, xAI) or connect your existing Claude subscription for free frontier-model answers.

**Packaged builds (the DMG / EXE from Releases) also ship with publik API as the default provider.** On first run the setup screen shows a short disclosure — every request is priced per use at 50% of the model's published list price from your publik balance (most people spend under $2 a month), and your questions go through publik's servers to a shared model account — with **Continue with publik API** and **Use my own key instead** side by side. Nothing is sent until you continue. You can remove the publik connection from Settings → Models at any time and use any of the providers above instead; builds from source and Docker have no publik token and behave exactly as before.

### Usage counts

The packaged apps (the DMG / EXE from Releases) send two anonymous usage events to publik: `app_opened` at each start, and `active_session` every 30 minutes while the app runs. An event holds the app name (`simplicity`), the app version, the operating system, the CPU type and a random install ID. If you use publik API, the event also carries your publik key, so that publik counts you one time. Nothing else is sent: no searches, no chats, no files, no API keys of other providers.

To turn it off, set `DO_NOT_TRACK=1` (or `PUBLIK_TELEMETRY=0`) in the environment before you start Simplicity. Details: <https://publikhq.com/skills/telemetry.md>. Docker and `yarn dev` do not send these events.

### Uninstalling

See [UNINSTALL.md](UNINSTALL.md) for exactly what Simplicity writes to disk and how to remove all of it — on macOS, `./scripts/uninstall.sh` does it in one step.

---

## ⚠️ Starting point, not a finished product

This is an early beta — a starting point. The core loop (search → sources → cited answer) is solid and tested, but edges are rough: some surfaces are still being brought to parity, and things will change fast. Use it, break it, [tell us what broke](https://github.com/Blueturboguy07/Simplicity/issues).

## What it does

- **Search-first answers** — every factual question triggers real web retrieval through your own local [SearxNG](https://github.com/searxng/searxng) metasearch (7 engines, no single point of failure), then the model writes a cited answer. The model never gets to "answer from memory" on facts.
- **Behind-the-scenes transparency** — watch the exact search queries, every source found, and each research step as it happens.
- **Deep research** — a capped multi-round research loop that scrapes and reads pages, then writes a long-form sectioned report.
- **Model council** — up to 3 models from different vendors answer the same question in parallel from the same sources; a chair model compares them and calls out where they agree and disagree.
- **Price per query** — every answer shows exactly what it cost you ("$0.0042 · 12.4k tokens", per-model breakdown). Local models and Claude-subscription answers show **Free**.
- **Your models, your choice** — pick per message: local Ollama (free), your Claude plan (free), or GPT-5.1 / Gemini 2.5 Pro / Claude Opus 4.8 / Grok on your keys. Nothing is locked.
- **Incognito threads** — flip the lock and the thread is never written to disk.
- **Export** — Markdown, PDF, or CSV of any answer.
- **Private by construction** — searches run through your local metasearch, chats live in a local SQLite file, API keys stay on your device. The packaged apps send anonymous [usage counts](#usage-counts) and nothing else.

## Build from source

```bash
git clone https://github.com/Blueturboguy07/Simplicity.git
cd Simplicity
yarn install
yarn dist:mac   # or: yarn dist:win
```

Requires Node 24+. Development: `yarn dev`, tests: `yarn test`.

## Self-hosting the web build (Docker)

`docker compose up` serves the same app as a website on port 3000. Its API holds your keys, so it only answers requests addressed to a host it trusts — this stops a malicious page in your browser from reaching it through DNS rebinding.

- **Loopback names and IP addresses always work:** `http://localhost:3000`, `http://127.0.0.1:3000`, `http://192.168.1.20:3000`.
- **A domain name must be listed** in `SIMPLICITY_ALLOWED_HOSTS` (comma-separated; add `:port` to allow one port only):

  ```yaml
  services:
    vane:
      environment:
        - SIMPLICITY_ALLOWED_HOSTS=search.example.com,nas.lan:3000
  ```

  Without it, API calls under that name fail with `403` and a message that names this variable.

- **Behind a reverse proxy**, either pass the original `Host` through (Caddy and Traefik do by default; nginx: `proxy_set_header Host $host;`) or send `X-Forwarded-Host` and `X-Forwarded-Proto` (nginx: `proxy_set_header X-Forwarded-Host $host;` and `proxy_set_header X-Forwarded-Proto $scheme;`). The public name in either header must be in `SIMPLICITY_ALLOWED_HOSTS`. A proxy that rewrites `Host` and sends neither header (bare nginx `proxy_pass`) breaks saving settings and searching.

The desktop app ignores `SIMPLICITY_ALLOWED_HOSTS`: its local server only ever answers its own window on `127.0.0.1`.

## Credits & license

Simplicity is a fork of [Vane](https://github.com/ItzCrazyKns/Vane) by [ItzCrazyKns](https://github.com/ItzCrazyKns) (the successor to Perplexica) — an excellent foundation, rebuilt here as a desktop app with a search-first retrieval pipeline, model council, cost tracking, and the rest of the feature set above. [MIT licensed](LICENSE), same as upstream.
