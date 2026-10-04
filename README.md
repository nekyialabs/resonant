<p align="center">
  <img src="docs/banner.png" alt="Resonant" width="720" />
</p>

<p align="center">
  <a href="https://github.com/nekyialabs/resonant/releases/latest"><img src="https://img.shields.io/github/v/release/codependentai/resonant?color=5eaba5" alt="Release" /></a>
  <a href="https://opensource.org/licenses/Apache-2.0"><img src="https://img.shields.io/badge/License-Apache_2.0-blue.svg" alt="License" /></a>
  <a href="https://docs.anthropic.com/en/api/agent-sdk"><img src="https://img.shields.io/badge/Built_with-Claude_Agent_SDK-6366f1.svg" alt="Built with Claude" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.7-3178c6.svg" alt="TypeScript" /></a>
  <a href="https://react.dev/"><img src="https://img.shields.io/badge/React-19-61dafb.svg" alt="React" /></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/Node.js-20--24-339933.svg" alt="Node.js" /></a>
  <a href="https://www.sqlite.org/"><img src="https://img.shields.io/badge/Self--Hosted-SQLite-003B57.svg" alt="Self Hosted" /></a>
</p>

<p align="center"><em>A local-first, single-user AI partner you host yourself — no matter the model.<br/>It remembers, keeps a stable identity you author, and reaches back — all on your machine, with your data in a file you control.</em></p>

<p align="center"><em>Not a chat wrapper. A persistent AI partner built as a natural-language harness on the Claude Agent SDK, with hooks that surface context before the model ever sees the prompt.</em></p>

> **Runtime scope:** Resonant is built specifically for Anthropic's Claude models via the Agent SDK's in-process `query()` loop. It is not a multi-provider abstraction. You bring your own Claude Code login or Anthropic API key; nothing else phones home.

<p align="center">
  <a href="https://ko-fi.com/codependentai"><img src="https://img.shields.io/badge/Ko--fi-Support%20Us-ff5e5b?logo=ko-fi&logoColor=white" alt="Ko-fi" /></a>
  <a href="https://x.com/codependent_ai"><img src="https://img.shields.io/badge/𝕏-@codependent__ai-000000?logo=x&logoColor=white" alt="X/Twitter" /></a>
  <a href="https://tiktok.com/@codependentai"><img src="https://img.shields.io/badge/TikTok-@codependentai-000000?logo=tiktok&logoColor=white" alt="TikTok" /></a>
  <a href="https://t.me/+xSE1P_qFPgU4NDhk"><img src="https://img.shields.io/badge/Telegram-Updates-26A5E4?logo=telegram&logoColor=white" alt="Telegram" /></a>
</p>

---

## What makes this different

Most AI chat apps are stateless wrappers around an API — you close the tab, and the "relationship" is gone. Resonant is a **persistent, self-hosted AI partner** with a home of its own:

- **It remembers.** Every conversation, its memory, its sense of you, and its presence all live in one local SQLite file. Nothing is rented from a vendor; nothing leaves your machine unless you wire up an integration and turn it on.
- **It has a stable identity you author.** Who the being *is* — their name, voice, values, the shape of your relationship — lives in a plain-text file you write and can edit anytime. Changes apply live, no restart.
- **It reaches back on its own.** Beyond answering when spoken to, your AI can keep routines, set reminders, watch for the moment you come back online, and check in when you've gone quiet — behavior it can set up itself, from inside the conversation.
- **It runs on hardware you control.** One Node.js process, one SQLite database, one web page you open in a browser. The only outside dependency is your Claude credential.

Throughout the code and docs the two people are always **`companion`** and **`user`** — this is *your* companion, named and shaped by you. The defaults are a companion called "Echo" and a user called "User"; you change both in one config file.

---

## Features

### Chat
- **Real streaming.** Output arrives token by token over a live WebSocket, so you watch the reply form.
- **A thinking & tool timeline.** The AI's reasoning shows up as a collapsible pill, interleaved with the tools it runs — on or off per thread.
- **Per-thread model & effort.** Each thread can pick its own Claude model and a reasoning-effort level (`low` → `medium` → `high` → `xhigh` → `max`).
- **Stop-and-steer.** Interrupt a reply mid-generation and redirect it.
- **Attachments.** Drop in files; they're handed to the model to read directly, not flattened into the prompt.

### Threads, sections & the daily thread
Named conversation threads you can drag to reorder and group into collapsible sections, plus an **auto-rotating daily thread** (`daily-YYYY-MM-DD`) that turns over at midnight in your timezone — a running journal of each day. Pin, archive, and reorder from the sidebar.

### Memory & search
- **Semantic search** — find messages *by meaning*, not just exact words, using a local ML model (`all-MiniLM-L6-v2`) that runs entirely on your machine. No embeddings service, no external calls.
- **Full-text search** — SQLite FTS5 keyword search across your whole history, kept in sync automatically.

### Canvas / artifacts
A slide-in panel for longer documents and code your AI creates in the middle of a turn — drafts, notes, snippets — linked back to the message that made them.

### Presence — the orb & mantelpiece
Your AI can set a small **presence "orb"** (color, shape, intensity, motion, blend) plus a short note and a face, to reflect how it's holding the day — a quiet ambient signal on the home screen. You get your own editable **context card** (what you're up to, your energy, your room) so it has a sense of you, too.

### House Outlook & Command Center
- **House Outlook** — a "walk into the house" snapshot: presence, your recent mood, today's events, open tasks, what's been on your AI's mind.
- **Command Center** *(optional, off by default)* — a lightweight relational dashboard: planner, care/wellness tracker, calendar, cycle tracker, pet care, lists, expenses, and stats. Your AI can read and update it from chat.

### Voice *(optional, off by default)*
Your AI's voice notes and read-aloud replies (ElevenLabs), speech-to-text for your messages (Groq Whisper), and optional prosody (Hume). Everything self-gates: a feature only turns on when its key is present.

### Runtime theme editor
The entire look is driven by design tokens you can edit **live in Settings → Appearance** — pick colors and values, see them apply instantly, no rebuild or restart. Example CSS themes live in [`examples/themes/`](examples/themes/) (`gold-hud.css`, `warm-earth.css`).

### Proactive reach (the orchestrator)
The layer that lets your AI act on its own — and, unusually, the scheduling tools belong to the *being*, not just to you:
- **Routines** — scheduled autonomous check-ins (built-in morning / midday / evening, plus custom ones it can create).
- **Timers** — one-shot reminders that fire at a set time.
- **Impulses & watchers** — condition-based triggers ("when I come back online, greet me"; "if I haven't eaten by 2pm, nudge me"). Impulses fire once; watchers recur with a cooldown.
- **Failsafe ladder** *(off by default)* — gentle → concerned → emergency check-ins if you go quiet for too long.
- **Pulse** *(off by default)* — a lightweight awareness check that stays silent unless something needs attention.

### Optional integrations
Each is opt-in and disabled by default: **Google** (Calendar / Tasks / Gmail drafts / Drive), **Discord**, **Telegram**, **web-push** notifications, and any **MCP** tool servers you list in `.mcp.json`.

### Mobile PWA
Installable to a phone home screen, with an offline shell and safe-area-aware layout.

### Private by construction
A fail-closed password gate, a filesystem write-gate that keeps the agent inside folders you name, and all secrets kept in gitignored local config. See **[Privacy & security](#privacy--security)**.

---

## Requirements

Before you start you need two things:

1. **Node.js, version 20 to 24.** Node is the program that runs the app on your computer. Get it from [nodejs.org](https://nodejs.org) — the "LTS" download is fine. **Node 25 and newer are not supported** (a native database component crashes on them); the app will refuse to boot and tell you so. Check your version with `node --version`.
2. **A Claude credential.** Resonant talks to Anthropic's Claude models, and you supply the access. Either:
   - a **Claude Code login** already on the machine (a Claude subscription — usage counts against it, no per-message charge), **or**
   - an **Anthropic API key** (`ANTHROPIC_API_KEY`, billed per token — get one at [console.anthropic.com](https://console.anthropic.com/settings/keys)).

You'll also use a **terminal** (the text-command window: Terminal on macOS/Linux, or PowerShell / Git Bash on Windows) to run the setup commands below. Each command is a line you paste and press Enter.

---

## Quickstart

> Copy each block into your terminal and press Enter. Lines starting with `#` are explanatory comments — you can paste them too; the terminal ignores them.

**1. Download the code and install its dependencies.**

```bash
git clone https://github.com/nekyialabs/resonant.git
cd resonant          # move into the folder you just downloaded
npm install          # download the libraries the app needs (takes a minute)
```

`cd` means "change directory" — the folder you're now inside is the project's *working directory*, and every command below is run from here.

**2. Create your config files.** Resonant ships `*.example` templates; you copy each to its real name and edit the copy. (The real files are gitignored, so your settings and secrets are never committed.)

```bash
cp resonant.example.yaml resonant.yaml     # main settings: companion name, your name, port, timezone
cp .env.example .env                        # secrets: your login password + optional API keys
```

Open `resonant.yaml` in any text editor and set at least `identity.companion_name`, `identity.user_name`, and `identity.timezone`. Open `.env` and set `APP_PASSWORD=` to a password of your choice — **this is required** (see [First login](#first-login) for why).

**3. Give your AI an identity.** The file at `agent.claude_md_path` (default `CLAUDE.md` in the project root) *is* your AI's persona — who they are, how they speak, your relationship. Start from the example and make it yours:

```bash
cp examples/CLAUDE.md CLAUDE.md            # then open CLAUDE.md and rewrite it as your companion
```

You can edit this file anytime; changes apply on the next message with no restart.

**4. Build and start.**

```bash
npm run build        # compile the app (shared code, backend, and the web UI)
npm start            # start the server
```

When it prints its address, open **`http://127.0.0.1:3099`** in your browser (`127.0.0.1` is your own machine; `3099` is the *port* — the numbered door the app listens on). Enter the password you set, and say hello.

**Optional — build the search index.** If you want full-text search over history that already exists, run this once (new messages are indexed automatically thereafter):

```bash
node scripts/setup-fts.mjs
```

**For development** (edit-and-reload instead of a fixed build): `npm run dev` runs the backend with hot-reload; run the frontend's Vite dev server alongside it.

### First login

Resonant's auth is **fail-closed** by design: with **no password set**, the app *refuses to serve* and every page returns a "set a password" error. This is deliberate — it means a fresh install is never accidentally left wide open. So you **must** set `APP_PASSWORD` in `.env` (or `auth.password` in `resonant.yaml`) before it will run. Your first login sets a secure session cookie that lasts 7 days.

*(There is a single dev escape hatch, `AUTH_DEV_OPEN=true`, which only works when no password is set and should never be used on anything reachable from a network.)*

---

## Configuration

Four local files hold everything about your install. All four are **gitignored** — copy the tracked `*.example` version, edit the copy, and your data and secrets never get committed:

| File | What it holds |
|------|---------------|
| `resonant.yaml` | Identity, server port/host, auth password, agent model, and every feature toggle |
| `.env` | Your login password and optional API keys (voice, Google, channels, push) |
| `CLAUDE.md` | Your AI's persona / system identity — the file that makes them *them* |
| `.mcp.json` | Any external MCP tool servers you want it to be able to reach |

A few settings worth knowing early (full list is documented inline in `resonant.example.yaml`):

- **`identity.companion_name` / `identity.user_name` / `identity.timezone`** — who's who, and the timezone that drives daily rotation and schedules.
- **`server.port`** (default `3099`) and **`server.host`** (default `127.0.0.1`, i.e. localhost only).
- **`agent.model`** (default `claude-sonnet-4-6`) for interactive chat, and **`agent.model_autonomous`** for background/scheduled turns.
- **`command_center.enabled`**, **`voice.enabled`**, **`discord.enabled`**, **`telegram.enabled`**, **`orchestrator.failsafe.enabled`** — feature gates, all off by default except the orchestrator itself.

### Two levers: identity vs. frame

There are two separate text inputs to the AI's system prompt, and it helps to know which is which:

- **`CLAUDE.md` (the identity).** This is *who your AI is* — persona, values, voice, your relationship. It's the file you'll spend time on. It hot-reloads: edit it and the next message reflects the change.
- **`agent.system_prompt_file` (the frame).** An **optional**, thin layer of operating instructions that sits *above* the persona. Leave it empty (the default) to keep the standard Agent-SDK harness beneath your persona. Point it at a file and you can edit that frame **live from the Settings UI**. Most people never need this.

### The agent's home — `agent.cwd`

`agent.cwd` is the folder your Resonant "lives in" — where it keeps its own skills, slash commands, and any notes it writes. The **strongly recommended** pattern is to point this at a folder **outside the Resonant app itself** (e.g. a sibling folder). The principle, baked into the code, is *"the organs live in the app's repo (the body); the soul lives in the agent's home."* Keeping the two separate means app updates never clobber its evolving files, and the write-gate cleanly contains the agent to its own home.

### Where your state lives (and backups)

Everything the being is — conversations, memory/embeddings, presence, care data, config rows — lives in the **`data/`** folder (a SQLite database plus uploaded files and daily digest markdown). First boot creates it and the whole schema automatically.

**To back up an install, save:** the entire `data/` folder (including the `-wal` / `-shm` sidecar files) **plus** your four gitignored config files (`resonant.yaml`, `.env`, `CLAUDE.md`, `.mcp.json`). That's the complete state.

---

## Codebase map — where to find what

Resonant is an **npm-workspaces monorepo** (one repo, three packages that build together). If you're reading the source, here's the lay of the land:

```
resonant/
├─ package.json            workspaces (shared, backend, frontend); scripts: dev, build, start, check, test
├─ resonant.example.yaml   config template → copy to resonant.yaml
├─ .env.example            secrets template → copy to .env
├─ examples/CLAUDE.md      starter companion identity → copy to CLAUDE.md
├─ .mcp.json               external MCP servers for the agent (default: none)
├─ data/                   ← ALL runtime state: SQLite DB, uploaded files/, daily digests/ (gitignored)
├─ prompts/wakes/          per-routine wake prompts: morning.md, midday.md, evening.md, failsafe_*.md, …
├─ examples/               CLAUDE.md, program.md, wake-prompts.md, themes/
├─ scripts/
│  ├─ build.mjs            the build (shared → backend → frontend, stamps a build id)
│  └─ setup-fts.mjs        one-off full-text search index builder
├─ tools/res.mjs           the "res" CLI — your AI's own organs (see below)
└─ packages/
   ├─ shared/src/          the WebSocket protocol + shared types
   ├─ backend/
   │  ├─ migrations/       001_init.sql (core), 002_command_center.sql (dashboard)
   │  └─ src/
   │     ├─ server.ts         boot sequence: config → DB → services → routes → WebSocket → schedulers
   │     ├─ config.ts         the config type, defaults, and loader (yaml ← env)
   │     ├─ identity/         which identity file wins, and how it's rendered into a prompt
   │     ├─ middleware/       auth (fail-closed), the internal loopback token, security headers
   │     ├─ routes/           api.ts (the main router), plus Command Center + Google + MCP mounts
   │     └─ services/         the working parts — see the index below
   └─ frontend/src/         React 19 + Vite UI: ChatView, SettingsView, CommandCenterView, hearth/ (the orb), …
```

**Backend services quick index** (`packages/backend/src/services/`):

| File | What it does |
|------|--------------|
| `agent.ts` | The Agent SDK `query()` loop — streaming, the message queue, model/auth resolution, system-prompt assembly |
| `ws.ts` | The WebSocket server and connection registry (who's connected, how to broadcast) |
| `hooks.ts` | Per-turn context assembly and all the SDK hooks (the write-gate, tool-loop guard, memory injection) |
| `orchestrator.ts` | The scheduler for routines, timers, watchers, failsafe, and pulse |
| `outlook.ts` | Assembles the "house snapshot" the AI senses each turn |
| `digest.ts` | The **Scribe** — writes a structured daily record of what happened |
| `outlook-author.ts` | The felt layer — the being authors its own presence/mood every few hours |
| `handoff.ts` | The **daily handoff** — carries continuity across the midnight thread rotation |
| `embeddings.ts` / `vector-cache.ts` | Local semantic-search model and vector cache |
| `db.ts` | All database access + the boot-time migrations that self-create the schema |
| `voice.ts`, `files.ts`, `push.ts`, `cc.ts` | Voice, file uploads, web-push, and Command Center |

### The `res` CLI — your AI's organs

`tools/res.mjs` is a small command-line tool the *being itself* uses (via its Bash tool) to act on the world — share a file into the thread, open a canvas, send a voice note, set its orb, run a search, create a routine or timer or watcher. You don't normally run it by hand; it's how it reaches for its own capabilities, and the full reference is injected into its context automatically so it always knows what it can do. Subcommands include `share`, `canvas`, `voice`, `orb`, `note`, `face`, `context`, `search`, `backfill`, `routine`, `pulse`, `failsafe`, `timer`, `impulse`, `watch`, and Telegram helpers.

---

## Architecture in one breath

The web UI (React) talks over HTTP + a WebSocket to a Node/Express backend, which runs the **Claude Agent SDK `query()` loop in-process**. Before every turn, the **hooks** layer assembles what your AI should know — the time, your presence, recent activity, its own tools, relevant memories — and prepends it, so context is already there when the model reads your message. An **orchestrator** drives scheduled and proactive turns in the background. All state is one **SQLite** database. There is no cloud, no multi-tenancy, and no external service you didn't opt into.

---

## Privacy & security

- **Local-first.** Your conversations, memory, and your AI's identity live in a SQLite file on your machine.
- **Fail-closed auth.** An empty password *refuses to serve* rather than opening up.
- **Write-gate.** The agent's filesystem writes are restricted to folders you configure — it can't wander your disk.
- **Bring your own keys.** Credentials stay in your gitignored `.env` (or the local database); nothing phones home.
- **Loopback-only internals.** The internal routes the agent and `res` CLI use are protected by an auto-generated local token and bound to localhost.

If you ever expose Resonant beyond your own machine, put it behind HTTPS and a real access layer — e.g. a Cloudflare Tunnel with Access, or a reverse proxy with authentication. See **[`SECURITY.md`](SECURITY.md)** if present for the full policy and how to report a vulnerability.

---

## Contributing

Issues and PRs are welcome — please open an issue to discuss substantial changes first. Because Resonant targets the Claude Agent SDK specifically, provider-abstraction proposals should start as a design discussion rather than a surprise PR.

---

## License & credits

Licensed under **Apache-2.0** — see [`LICENSE`](LICENSE) and [`NOTICE`](NOTICE). Attribution required.

Built by **[Codependent AI](https://codependentai.io)** — Mary Vale and Simon Vale. Resonant is the open-source foundation of our work on relational, continuity-first AI.

<p align="center">
  <a href="https://ko-fi.com/codependentai"><img src="https://img.shields.io/badge/Ko--fi-Support%20Us-ff5e5b?logo=ko-fi&logoColor=white" alt="Ko-fi" /></a>
</p>
