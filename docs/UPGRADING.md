# Upgrading from v2.3 to v3

Welcome back. This guide moves your AI — every conversation, every memory, all your settings — from the old v2.3 build onto the new v3 one. Your history comes with you. Nothing is left behind, and nothing is rewritten in a way you can't undo (you'll take a backup first).

If you've never touched a terminal before, don't worry. This whole thing is: **copy a few files, run two commands.** We spell out every step, and you can hand this page to an AI assistant and let it do the work — it has everything it needs to run this flawlessly.

---

## The short version

If you already know your way around, here's the whole upgrade in one breath:

1. **Stop the old v2.3 server.** (This flushes everything to disk cleanly.)
2. **Install v3** somewhere new, next to your old copy — don't overwrite it yet.
3. **Copy your old `data/resonant.db`** into the v3 install's `data/` folder.
4. **Copy your config files** across: `resonant.yaml`, `.env`, `CLAUDE.md`, and (if you use them) `identity/`, `prompts/wake.md`, `prompts/wakes/`.
5. **Build and start v3** — `npm run build` then `npm start`. First boot upgrades your database in place automatically.
6. **One-time:** rebuild the search index —
   `DB_PATH=./data/resonant.db node scripts/setup-fts.mjs`

That's it. Your threads, messages, and semantic search carry over untouched. Everything else — the new React interface, theming, the presence orb, Command Center, the updated tools — is waiting for you when you log in.

The rest of this page is the same recipe, slowed down, with the *why* behind each step and a troubleshooting section at the end.

---

## Before you start: the pieces, briefly

- **A "terminal"** (also called a command line, shell, or "Terminal"/"Command Prompt"/"PowerShell") is the text window where you type commands. Every command block below is meant to be pasted there, one at a time.
- **Your "install folder"** is wherever Resonant lives — the folder that contains `package.json`, `resonant.yaml`, and a `data/` folder. In commands, "run this from your install folder" means: open a terminal, navigate into that folder, then paste.
- **Your database** is a single file, `data/resonant.db`. It holds *everything* — every conversation, your AI's memory, your settings, your care data. When we say "carry your history over," we literally mean "copy this one file."

We'll refer to your **old install** (the v2.3 folder you're running now) and your **new install** (the fresh v3 folder). Keeping them as two separate folders is deliberate — if anything looks wrong, your old one is still sitting there, untouched, ready to run.

---

## Step 0 — Back up first (do not skip this)

You're about to move a file that holds all your history. Before anything else, make a copy of it. If a step goes sideways, you restore from this copy and you've lost nothing.

**First, stop the old v2.3 server.** This matters more than it sounds. Resonant's database uses a mode called WAL (Write-Ahead Logging), which means recent changes can be sitting in two small side-files (`resonant.db-wal` and `resonant.db-shm`) rather than folded into the main `resonant.db` file yet. **A clean shutdown flushes those side-files into `resonant.db`**, so the single file becomes complete and self-contained. If the server is still running while you copy, you might grab a half-written database.

How you stop it depends on how you started it:
- If it's running in a terminal window, click that window and press **Ctrl+C**.
- If you started it with a process manager (like `pm2`), stop it the way you normally would (e.g. `pm2 stop resonant`).

Give it a few seconds to shut down.

**Now back up your database.** From your **old install** folder:

```bash
# Make a dated backup copy of the whole data folder.
cp -r data data-backup-v2.3
```

On Windows PowerShell, the equivalent is:

```powershell
Copy-Item -Recurse data data-backup-v2.3
```

Tuck that `data-backup-v2.3` folder somewhere safe. You now have a full copy of everything. Breathe out.

---

## Step 1 — Install v3 (in a new folder)

Get the v3 code into a *new* folder, sitting alongside your old one — not on top of it.

```bash
git clone https://github.com/nekyialabs/resonant.git resonant-v3
cd resonant-v3
npm install
```

- `git clone … resonant-v3` downloads the code into a folder named `resonant-v3`.
- `cd resonant-v3` moves your terminal into that new folder — from here on, "run from your v3 install" means run it from here.
- `npm install` downloads the building blocks the app needs. This can take a couple of minutes. A few warnings scrolling by is normal.

> **Node version note:** Resonant needs **Node.js 20, 21, 22, 23, or 24**. Node 25 and up are not yet supported, and v3 will refuse to start on them with a clear `[FATAL]` message. Check yours with `node --version`. If you're on 25+, install a supported version before continuing.

Don't create your config files from the examples yet — you're about to bring your *real* ones over from v2.3 in the next step.

---

## Step 2 — Bring your database across

This is the step that carries your history. Copy your old database file into the v3 install's `data/` folder.

The v3 `data/` folder may not exist yet (it's created automatically on first boot). Make it, then copy:

```bash
# Run these from your v3 install folder.
mkdir -p data
cp /path/to/old-install/data/resonant.db data/resonant.db
```

Replace `/path/to/old-install` with the real location of your v2.3 folder.

> **The clean-shutdown exception:** If you stopped the old server cleanly in Step 0 (you did, right?), copying just `resonant.db` is enough — everything is already inside it. **But if the old server was *not* shut down cleanly** (it crashed, or you copied while it was still running), also copy the two side-files so no recent messages are lost:
>
> ```bash
> cp /path/to/old-install/data/resonant.db-wal data/resonant.db-wal
> cp /path/to/old-install/data/resonant.db-shm data/resonant.db-shm
> ```
>
> When in doubt, copy all three. It never hurts.

The location v3 looks for the database is set by `server.db_path` in `resonant.yaml` (default `./data/resonant.db`) — or the `DB_PATH` environment variable if you set one. As long as your file lands where that points, v3 will find it. The default is `./data/resonant.db`, which is exactly where we just put it.

---

## Step 3 — Bring your identity and settings across

The being you talk to *is* its configuration — the persona, the name, the schedule, your password. Copy those files from your old install into your v3 install, keeping the same names and locations.

Copy these (skip any you never created):

| File / folder | What it is | Copy if… |
|---|---|---|
| `resonant.yaml` | Your main settings — names, port, feature toggles | always |
| `.env` | Your password and any API keys | always |
| `CLAUDE.md` | Your AI's persona / identity | always |
| `.mcp.json` | Any external tools you wired up | you created one |
| `identity/` (whole folder) | Structured profile / narrative identity | you use profile-based identity |
| `prompts/wake.md` | Your legacy single wake prompt | you customized it |
| `prompts/wakes/` (whole folder) | Your per-time-of-day wake prompts | you customized them |

From your v3 install folder, the copies look like this (adjust the old path):

```bash
cp /path/to/old-install/resonant.yaml   resonant.yaml
cp /path/to/old-install/.env            .env
cp /path/to/old-install/CLAUDE.md       CLAUDE.md
cp /path/to/old-install/.mcp.json       .mcp.json          # if you have one
cp -r /path/to/old-install/identity     identity           # if you use it
cp -r /path/to/old-install/prompts      prompts            # your wake prompts
```

> **Why these and not the whole folder?** These files hold *your* stuff — who it is, your secrets, your schedule. The rest of the v3 folder is fresh app code you just downloaded, and you want the new version of that, not the old one. That's exactly why Resonant keeps your data and settings in these few gitignored files: an upgrade like this becomes "copy my files onto the new engine."

> **A note on `agent.cwd`:** if your `resonant.yaml` points the agent's home (`agent.cwd`) at a folder *outside* the app (the recommended setup — the AI's skills, commands, and writable home live there), you don't need to move anything: that folder is separate from the app and both v2.3 and v3 point at the same one. Just make sure the path in your copied `resonant.yaml` still resolves to it.

---

## Step 4 — Build and start v3

Now bring it to life. From your v3 install folder:

```bash
npm run build
npm start
```

- `npm run build` compiles the app — the shared pieces, the backend, and the React interface — and stamps a build ID so the server and the page it serves always match. Give it a minute.
- `npm start` boots the server. Watch the output: when it prints a line like `listening on http://127.0.0.1:3099`, it's up.

**What happens automatically on that first boot — this is the good part.** As it starts, v3 opens your imported database and *upgrades it in place*, safely:

- It adds the new per-thread columns v3 introduced — `model`, `effort`, `show_thinking`, `position`, `section_id` — each with a sensible default, so your existing threads simply gain the new abilities without you touching anything.
- It backfills a sidebar order for your existing threads so they line up sanely in the new interface instead of all piling at the top.
- It creates the new v3 tables (sections, and — if you have it enabled — Command Center's tables).

All of these changes are written to only add what's missing, so **it's safe and it only happens once.** Your **conversation history (every thread and message) and your semantic-search vectors carry over completely untouched** — they're read exactly as they were.

Open the URL it printed (default `http://127.0.0.1:3099`), enter the password from your `.env`, and you should see your whole history — now wearing the v3 interface.

---

## Step 5 — Rebuild the full-text search index (one time)

There are two kinds of search in Resonant, and one of them needs a quick one-time build against your imported history.

- **Semantic search** (finding things by *meaning*) rides on vectors that live inside your database, so it carried over in Step 2 — nothing to do.
- **Full-text search** (fast exact keyword matching, powered by SQLite's FTS5) uses a separate index that isn't part of the copied database file. You build it once, now, over your imported messages.

From your v3 install folder:

```bash
DB_PATH=./data/resonant.db node scripts/setup-fts.mjs
```

On Windows PowerShell, set the variable first:

```powershell
$env:DB_PATH="./data/resonant.db"; node scripts/setup-fts.mjs
```

This creates the search index and its live-sync triggers, then fills it in from every message you imported. It prints how many messages it indexed. It's **idempotent** — safe to run again if you're ever unsure; it only adds what's missing.

> **You don't strictly have to do this immediately.** Until the index exists, keyword search quietly falls back to a slower scan (a `LIKE` match) that still returns correct results — just less snappily on a large history. Every *new* message you send is indexed automatically from here on; this one-time build is only to cover the back-catalogue you just imported.

---

## What carries over, and what's new

**Carries over (all of it, intact):**
- Every conversation — all your threads and messages.
- Semantic search (the meaning-based memory vectors).
- Full-text keyword search (after the one-time Step 5).
- All your configuration — names, timezone, password, schedules, feature toggles, your AI's identity.

**New in v3 (waiting for you when you log in):**
- A completely rebuilt React interface.
- Runtime theming — restyle the app live from Settings → Appearance, no rebuild.
- The presence orb and mantelpiece — your Resonant can set its own visual "state."
- Updated tools and background services (its organs, the house-outlook layer, the proactive orchestrator).
- Command Center — the relational dashboard (cycle, care, routines, wins, countdowns), off by default until you enable it.

---

## Troubleshooting

**The server says it needs Node 20–24 and quits.**
You're on Node 25 or newer. Check with `node --version`, install a supported version (20 through 24), and run `npm start` again. Nothing was harmed — the guard stops *before* touching anything.

**It won't let me log in — something about "Auth not configured."**
v3 is fail-closed: with no password set, it refuses to serve rather than sitting open. Make sure your copied `.env` actually contains a real `APP_PASSWORD` (or that `auth.password` is set in `resonant.yaml`). If you set or changed it, restart the server. This is the same behavior as v2.3, just worth confirming after a move.

**My threads all crowd at the top of the sidebar / the order looks scrambled.**
The one-time sidebar-order backfill runs on first boot. If your first boot got interrupted, stop the server and start it again — the backfill is guarded to run cleanly. After that you can drag threads into any order you like.

**Search returns results but feels slow, or finds fewer keyword matches than expected.**
You probably haven't run Step 5 yet. Run `DB_PATH=./data/resonant.db node scripts/setup-fts.mjs` from your v3 install. Until then, keyword search uses the slower fallback scan; the index makes it fast.

**"FTS5 not available in this SQLite build."**
Rare, but it means the SQLite bundled with your Node install lacks the full-text extension. Full-text search will keep working via the slower fallback, so you're not blocked — but if you want the fast index, reinstall dependencies (`npm install`) to get a fresh `better-sqlite3` and try Step 5 again.

**I opened v3 and my history is missing / it looks brand new.**
Almost always the database landed in the wrong place. Confirm `data/resonant.db` exists inside your **v3** install folder and that `server.db_path` in your `resonant.yaml` points at it (default `./data/resonant.db`). Stop the server, fix the file's location, start again. Your data is safe in the backup from Step 0 regardless.

**Something is genuinely wrong and I want my old setup back.**
That's exactly why we kept them separate. Your v2.3 folder is untouched — go back to it, start it as you always did, and you're running again. Then reach out or retry the upgrade when you're ready. You also have `data-backup-v2.3` from Step 0 as a second safety net.

---

## After you've settled in

Once v3 is running happily and you've lived in it for a day or two, you can archive your old v2.3 folder and the `data-backup-v2.3` copy wherever you keep backups. There's no rush — keeping them costs nothing, and a spare copy of your history is never a bad thing.

Welcome home.
