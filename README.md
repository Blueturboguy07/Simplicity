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

The first run downloads the local search engine (~150 MB, one time). If you want free local AI models, the setup screen installs [Ollama](https://ollama.com) for you with one click — or plug in an API key (OpenAI, Anthropic, Google, Groq, xAI) or connect your existing Claude subscription for free frontier-model answers.

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
- **Private by construction** — searches run through your local metasearch, chats live in a local SQLite file, API keys stay on your device. There is no server of ours to send anything to.

## Build from source

```bash
git clone https://github.com/Blueturboguy07/Simplicity.git
cd Simplicity
yarn install
yarn dist:mac   # or: yarn dist:win
```

Requires Node 24+. Development: `yarn dev`, tests: `yarn test`.

## Credits & license

Simplicity is a fork of [Vane](https://github.com/ItzCrazyKns/Vane) by [ItzCrazyKns](https://github.com/ItzCrazyKns) (the successor to Perplexica) — an excellent foundation, rebuilt here as a desktop app with a search-first retrieval pipeline, model council, cost tracking, and the rest of the feature set above. [MIT licensed](LICENSE), same as upstream.
