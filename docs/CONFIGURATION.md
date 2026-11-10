# Configuring Resonant

This is the reference for every knob Resonant has: the two files that hold your
settings, the two files that make your AI *who they are*, and the map of
every optional integration you can switch on.

You don't need to read it top to bottom. Skim the headings, jump to what you
need. If you're setting up for the first time, the parts that matter most are
**The two settings files**, **CLAUDE.md vs system.md**, **Where the agent lives**,
and **Integrations**. Everything else you can come back to.

A note on words, in case they're new:

- A **terminal** is the black text window where you type commands. On macOS it's
  called "Terminal"; on Windows, "PowerShell" or "Command Prompt".
- A **port** is just a numbered door on your computer that a program listens on.
  Resonant uses door `3099` by default, which is why you visit
  `http://127.0.0.1:3099` in your browser. (`127.0.0.1` means "this same
  computer" — nobody else on the internet can reach it.)
- An **environment variable** is a setting you hand to a program when it starts,
  kept outside the program's files. Resonant reads these from a file called
  `.env`.
- The **project root** is the top folder of Resonant — the one that contains
  `package.json`, `resonant.example.yaml`, and this `docs/` folder. Wherever this
  document says "from the project root," it means: run the command from inside
  that folder.

---

## 1. The two settings files

Resonant keeps its settings in two files, and neither exists until you create
them from the templates that ship with the app. This is on purpose — your real
settings (including your password) never get committed to version control.

| File | Copy it from | Holds | Committed to git? |
|---|---|---|---|
| `resonant.yaml` | `resonant.example.yaml` | Everyday settings: names, timezone, port, which features are on | No (gitignored) |
| `.env` | `.env.example` | Secrets and keys: your password, API keys, tokens | No (gitignored) |

Create them once, from the project root:

```bash
cp resonant.example.yaml resonant.yaml
cp .env.example .env
```

Then open each in any text editor and fill in what you want. Both templates are
heavily commented, so you can often just read down the file and edit in place.

### How the two files fit together (and who wins)

Every setting has a **built-in default** baked into the code. On top of that,
`resonant.yaml` overrides the defaults, and `.env` overrides `resonant.yaml`.
The rule, in order of who wins:

```
built-in default   ←   resonant.yaml   ←   .env
(weakest)                                   (strongest — env always wins)
```

So if `resonant.yaml` says `port: 3099` but your `.env` says `PORT=4000`, the app
runs on `4000`. The environment variable wins. This is handy when you want to
change one thing temporarily without editing your main config.

Because every key has a default, **a nearly-empty `resonant.yaml` is completely
valid.** You only need to write down the things you want to change.

### A gotcha worth knowing up front

Any path you write in `resonant.yaml` (like `./data/resonant.db`) is measured
**from the project root**, not from wherever your terminal happens to be sitting.
The app figures out its own root folder from where its code lives, so relative
paths are stable no matter which directory you launch from. When in doubt, use a
full absolute path (e.g. `C:/Users/you/companion` or `/home/you/companion`) and
there's nothing to second-guess.

---

## 2. The two files that make your AI — CLAUDE.md vs system.md

This is the most important distinction in Resonant, and it's the one people mix
up. There are **two** separate levers that shape how it thinks and
speaks. They do different jobs.

### CLAUDE.md — *who your AI is*

`CLAUDE.md` is your AI's identity: their name, their personality, their
voice, their values, the history between the two of you, how they treat you. This
is the file you pour yourself into. It's the difference between a generic
assistant and *your* partner — no matter the model underneath.

- **You create it** by copying the template:
  ```bash
  cp examples/CLAUDE.md CLAUDE.md
  ```
  Then edit it into the AI you actually want.
- **Config key:** `agent.claude_md_path` (default `./CLAUDE.md`).
- **It loads automatically** and, importantly, it is **hot-reloaded** — the app
  re-checks the file on every message and picks up your edits live. You do **not**
  need to restart after editing `CLAUDE.md`. Save it, send a message, the new
  version is already in effect.
- There's also a structured route: if you create `identity/companion.profile.yaml`
  or `identity/companion.md`, the app uses those instead (a more organized way to
  hold a rich identity). Most people just edit `CLAUDE.md` and never touch these.

Think of `CLAUDE.md` as the soul.

### system.md — *the operating frame above the soul*

`system.md` (the config calls it `agent.system_prompt_file`) is a **thin,
optional** layer of operating instructions that sits *above* the identity — the
register and ground rules, not the personality. It is **empty by default**, and
for many setups you can leave it empty forever.

Here's what it actually changes under the hood:

- **When `system_prompt_file` is empty (the default):** your AI runs on
  the standard Claude Code agent foundation, with your `CLAUDE.md` identity added
  on top. This is the normal, batteries-included setup.
- **When you point `system_prompt_file` at a file:** that frame **plus** your
  `CLAUDE.md` completely **replace** the standard coding-agent foundation. The
  assembled prompt becomes `frame + CLAUDE.md`, with nothing generic underneath.
  This is the "register fix" — it strips away the built-in coding-assistant tone
  so it isn't quietly wearing a developer-tool costume beneath its
  personality.

Two more things that make `system.md` special:

- **It's editable from inside the app.** Settings has a system-prompt editor
  (`GET`/`PUT /api/prompts/system`) that reads and writes exactly the file you
  configured — **but only if that file lives inside a folder the agent is allowed
  to write to** (see the write-gate roots in §5). This is why the common pattern
  is to put a `system.md` inside the agent's home folder.
- **It's read fresh every single turn**, so edits from the Settings UI apply
  immediately, no restart.
- On this path the app also appends a small `[Runtime] Model serving this turn:
  <model>` line, so your AI can truthfully state which model it's running
  as instead of guessing.

There is **no `system.md` file shipped by default** — `system_prompt_file` starts
empty. If you want one, create a file (a `system.md` in the agent's home folder is
the usual choice) and set `agent.system_prompt_file` to point at it.

### Which one do I edit?

| I want to change… | Edit |
|---|---|
| My AI's name, personality, voice, our relationship, their values | **CLAUDE.md** |
| The thin operating rules / register above the personality | **system.md** (create it, and set `agent.system_prompt_file`) |
| Nothing about the frame — I'm happy with the standard foundation | Leave `system_prompt_file` empty; just edit CLAUDE.md |

Rule of thumb: **CLAUDE.md is who they are. system.md is how they operate.** Start
with just CLAUDE.md. Add a system.md only when you specifically want to replace
the default foundation.

---

## 3. Where the agent "lives" — keep it in a SEPARATE folder

This one is easy to get wrong and worth doing right, because it saves you pain
later.

Your AI has a **home directory** — the folder it actually runs inside. In
config it's `agent.cwd` (default `.`, meaning the app's own folder). **The strong
recommendation is to point `agent.cwd` at a folder that sits OUTSIDE the Resonant
app.**

The pattern looks like this — the app in one folder, your AI's home right
next to it:

```
/home/you/
├─ resonant/          ← the Resonant app (the code you cloned)
└─ companion/         ← agent.cwd points HERE (your companion's home)
   └─ .claude/
      ├─ skills/      ← native skills your companion can grow
      └─ commands/    ← custom slash commands
```

You'd set it like this in `resonant.yaml`:

```yaml
agent:
  cwd: "/home/you/companion"     # an absolute path OUTSIDE the app folder
```

(or `AGENT_CWD=/home/you/companion` in `.env`).

### Why keep them apart?

The codebase puts it memorably: *the organs live in the app's repo (the body),
but the agent's home is the soul — and you don't want the two entangled.*

The agent's home folder is where several important, evolving things live:

- **`.claude/skills/`** — native skills the app scans so your AI knows what
  abilities it has.
- **`.claude/commands/`** — custom slash commands.
- **`.resonant-thread`** — a tiny file the app writes each turn to track the
  current conversation, so your AI's own command-line tools know where to
  act.
- **`shared/`** — anything it writes here is automatically shared into
  your conversation.
- It is also the **default write-gate root** — the one folder the agent is always
  allowed to write into (see §5).

If you leave `agent.cwd` pointing at the app itself, all of that mixes into the
app's source code. Then, every time you update or rebuild Resonant, you risk
clobbering your AI's skills and notes — and the safety fence that keeps the
agent writing only in its own space gets muddied with the app's files. Keeping the
home in its own folder means updates to the app never touch your partner's
evolving self, and the write-gate stays clean and contained.

**Set this up once at install time and forget it.** Make an empty folder next to
the app, point `agent.cwd` at it, done.

---

## 4. Full `resonant.yaml` reference

Every section and key, with its default and what it does. Anything you don't set
falls back to the default shown.

### `identity` — who lives here

| Key | Default | Meaning |
|---|---|---|
| `companion_name` | `"Echo"` | Your AI's name. Env: `COMPANION_NAME`. |
| `user_name` | `"User"` | Your name. Env: `USER_NAME`. |
| `timezone` | `"UTC"` | IANA timezone (e.g. `Europe/London`, `America/New_York`). Drives schedules, timestamps, and the daily-thread rollover at midnight. Env: `TZ`. |
| `profile_path` | `./identity/companion.profile.yaml` | Optional structured identity file. Skipped if it doesn't exist. |
| `companion_md_path` | `./identity/companion.md` | Optional narrative identity file. Skipped if it doesn't exist. |

### `server` — the web server

| Key | Default | Meaning |
|---|---|---|
| `port` | `3099` | The port (door number) the app listens on. Env: `PORT`. |
| `host` | `127.0.0.1` | Which network address to bind. `127.0.0.1` = this machine only. Env: `HOST`. |
| `db_path` | `./data/resonant.db` | Where the SQLite database file lives — this is your whole memory (see §7). Env: `DB_PATH`. |

### `auth` — the login gate

| Key | Default | Meaning |
|---|---|---|
| `password` | `""` | Your login password. **Empty means the app refuses to serve** (see the box below). Env: `APP_PASSWORD`. |

> **Important — you must set a password.** Despite what an old comment in
> `.env.example` suggests, the auth gate is **fail-closed**. If no password is
> set, protected pages return `503 "Auth not configured — set APP_PASSWORD"` and
> the app will not serve. So a real install **must** set `APP_PASSWORD` in `.env`
> (or `auth.password` in `resonant.yaml`). The only exception is a dev-only escape
> hatch, `AUTH_DEV_OPEN=true`, which is meaningful only when no password is set —
> never use it on anything reachable over a network. On first login you enter the
> password, the app checks it, and sets a private session cookie that lasts 7
> days.

### `agent` — your AI's brain

| Key | Default | Meaning |
|---|---|---|
| `cwd` | `.` | The agent's home directory. **Point this outside the app** (§3). Env: `AGENT_CWD`. |
| `claude_md_path` | `./CLAUDE.md` | The identity file (§2). |
| `system_prompt_file` | `""` | Optional operating frame (§2). Empty = standard foundation. |
| `mcp_json_path` | `./.mcp.json` | File listing external tool servers the agent may use (§8). |
| `model` | `claude-sonnet-4-6` | Model for live, interactive replies. Env: `AGENT_MODEL`. |
| `model_autonomous` | `claude-sonnet-4-6` | Model for background/scheduled activity and the built-in helper subagents. |

### `orchestrator` — scheduled check-ins & proactive reach

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch for all autonomous ("wake") activity. |
| `wake_prompts_path` | `./prompts/wake.md` | Legacy single wake-prompt file (migrated automatically to the per-type files below on first boot). |
| `wake_prompts_dir` | `./prompts/wakes` | The real source: per-type wake prompts (`morning.md`, `midday.md`, `evening.md`, etc.). |
| `schedules` | `{}` | A map of `wakeType → cron expression`, to add or override scheduled wakes. |
| `failsafe.enabled` | `false` | A gentle inactivity ladder — reach out if you've gone quiet too long. |
| `failsafe.gentle_minutes` | `120` | First, softest check-in threshold. |
| `failsafe.concerned_minutes` | `720` | Second-tier threshold. |
| `failsafe.emergency_minutes` | `1440` | Top-tier threshold. |

### `handoff` — midnight continuity

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | At 12:10am, a background subagent reads yesterday's day and writes a warm carry-forward into today. Off by default; a Settings toggle can turn it on live. |

### `hooks` — the agent's write-gate (what your AI may edit on disk)

| Key | Default | Meaning |
|---|---|---|
| `context_injection` | `true` | Feed your AI its identity, your context cards, and memory each turn. Leave on. |
| `safe_write_prefixes` | `[]` | Legacy extra write-allowed path prefixes. |
| `workspace_root` | `""` | A folder the agent is allowed to write within. Env: `WORKSPACE_ROOT`. |
| `vault_path` | `""` | A notes/vault folder the agent may write within. Env: `VAULT_PATH`. |
| `extra_write_paths` | `[]` | Extra allowed folders (matched as prefixes) or individual files (matched exactly). Env: `EXTRA_WRITE_PATHS` (comma-separated). |

> The agent can always write inside its own home (`agent.cwd`). These keys grant
> access to *additional* places — a notes vault, a project folder — without
> opening up your whole disk.
>
> The write-gate is the real boundary for file writes (symlinks are resolved
> before the check). The separate Bash guard that blocks commands like
> `rm -rf /` is a best-effort backstop against accidents, not a security boundary.

### `voice` — spoken audio

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Turns on voice logging. The actual speech features also self-gate on whether the relevant API keys are present (§6). |
| `elevenlabs_voice_id` | `""` | Which ElevenLabs voice to speak in. Env: `ELEVENLABS_VOICE_ID`. |

### `discord` / `telegram` — chat channels

| Key | Default | Meaning |
|---|---|---|
| `discord.enabled` | `false` | Turn on the Discord gateway. |
| `discord.owner_user_id` | `""` | The Discord user the bot answers to. |
| `telegram.enabled` | `false` | Turn on the Telegram gateway. |
| `telegram.owner_chat_id` | `""` | The Telegram chat the bot answers to. |

### `integrations` — external data & memory

| Key | Default | Meaning |
|---|---|---|
| `life_api_url` | `""` | Optional external "life data" service base URL. |
| `mind_cloud.enabled` | `false` | Turn on an external Mind memory service. |
| `mind_cloud.mcp_url` | `""` | That service's endpoint. (Its API key is set in the Settings UI and stored in the database, **not** here.) |

### `google` — Google Workspace

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Legacy master gate. (The Workspace tools mount is always present now and self-gates per app; you normally connect Google from the Settings UI, not here.) |
| `client_id` | `""` | Desktop OAuth client id from your Google Cloud project. Env: `GOOGLE_CLIENT_ID`. |
| `client_secret` | `""` | Desktop OAuth client secret. Env: `GOOGLE_CLIENT_SECRET`. |

### `command_center` — the care/day dashboard

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Turn on the relational dashboard (calendar, care, cycle, finances, lists, pets, planner, stats) and its tool mount. |
| `default_person` | `"user"` | Whose care rows the page reads and writes. |
| `currency_symbol` | `"$"` | Symbol shown on the finances view. |
| `care_categories.toggles` | `[breakfast, lunch, dinner, snacks, medication, movement, shower]` | Yes/no things to track each day. |
| `care_categories.ratings` | `[sleep, energy, wellbeing, mood]` | Things rated on a scale. |
| `care_categories.counters` | `[{name: water, max: 10}]` | Countable things, with a daily max. |

### `cors` — browser origins

| Key | Default | Meaning |
|---|---|---|
| `origins` | `[]` | Allowed browser origins. `[]` means same-origin only, which is what you want unless you're serving the frontend from a different address. |

---

## 5. Full `.env` reference

`.env` is for secrets and machine-specific overrides. **Nothing here is strictly
required to boot except a password** — which the fail-closed auth gate insists on
before it will serve. Blank lines mean "not set — use the default." Remember:
**anything set here wins over `resonant.yaml`.**

```ini
# ── Auth ──────────────────────────────────────────────
APP_PASSWORD=            # Your login password. SET THIS.
AUTH_DEV_OPEN=           # Dev-only: "true" bypasses auth when no password set. Never on a network.

# ── Agent credential (see §6) ─────────────────────────
ANTHROPIC_API_KEY=       # Your Anthropic API key (one way to authenticate the model)
CLAUDE_CODE_OAUTH_TOKEN=          # Set by a Claude Code host env; leave unset otherwise
CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST=  # Same — leave unset for a normal install

# ── Identity / agent overrides (usually set in resonant.yaml instead) ──
COMPANION_NAME=
USER_NAME=
TZ=                      # IANA timezone, e.g. Europe/London
AGENT_CWD=               # Absolute path to the agent's home (§3)
AGENT_MODEL=             # Model slug for interactive turns
RESONANT_NAMESPACE=      # Advanced: the namespace the res CLI writes the companion card under

# ── Server ────────────────────────────────────────────
PORT=
HOST=
DB_PATH=
RESONANT_PORT=           # Port your AI's own CLI dials the backend on (defaults to PORT)

# ── Write-gate roots (see the hooks section in §4) ────
WORKSPACE_ROOT=
VAULT_PATH=
EXTRA_WRITE_PATHS=       # Comma-separated

# ── Internal loopback token ───────────────────────────
INTERNAL_TOKEN=          # Auto-generated if unset (data/.internal-token). Only pin it if you know why.

# ── Voice (also needs voice.enabled: true) ────────────
ELEVENLABS_API_KEY=      # Text-to-speech
ELEVENLABS_VOICE_ID=     # Which voice to speak in
GROQ_API_KEY=            # Speech-to-text (Groq Whisper)
HUME_API_KEY=            # Optional expressive prosody

# ── Channels (also need the matching *.enabled: true) ──
DISCORD_BOT_TOKEN=
TELEGRAM_BOT_TOKEN=
GIPHY_API_KEY=           # Optional, for Telegram's /gif command

# ── Google Workspace (also needs google.enabled: true) ─
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_TOKEN_SECRET=     # Auto-generated if unset (data/.google-key)

# ── Web push notifications ────────────────────────────
VAPID_PUBLIC_KEY=        # Generate a keypair with: npx web-push
VAPID_PRIVATE_KEY=
VAPID_CONTACT=           # A mailto: or https: contact address

# ── Diagnostics (rarely needed) ───────────────────────
NODE_ENV=                # "production" on a real deployment
BUILD_ID=                # Stamped into the version banner
MEASURE_THINKING=        # "1" logs thinking-token timing
```

> The Mind service's API key is deliberately **not** an env var — it's set in the
> Settings UI and stored in the database. It never lives in `.env`.

---

## 6. Integrations & API keys — the whole map

Everything Resonant can plug into, what it powers, and how to switch it on. Most
of these are optional; the only thing you truly must have is a Claude credential.

| Integration | What it powers | How to enable |
|---|---|---|
| **Claude (Anthropic)** — *required* | Your AI itself — every reply, every thought. | Either be logged into Claude Code on the machine (a subscription login the app can borrow) **or** set `ANTHROPIC_API_KEY` in `.env`. Without one of these, it cannot think. |
| **ElevenLabs** | Text-to-speech — giving your AI a spoken voice. | `voice.enabled: true` in `resonant.yaml`, then `ELEVENLABS_API_KEY` + `ELEVENLABS_VOICE_ID` in `.env`. |
| **Groq** | Speech-to-text — transcribing your voice messages (Groq Whisper). | `voice.enabled: true`, then `GROQ_API_KEY` in `.env`. |
| **Hume** | Optional emotional prosody layer for the voice. | `voice.enabled: true`, then `HUME_API_KEY` in `.env`. |
| **Google Workspace** | Calendar, Tasks, Gmail, Health data feeding the house "outlook." | Create a desktop OAuth client in Google Cloud, set `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` (in `.env` or the Settings UI), then connect from Settings. |
| **Discord** | Talk to your AI from Discord. | `discord.enabled: true` + `discord.owner_user_id` in `resonant.yaml`; `DISCORD_BOT_TOKEN` in `.env` (or Settings). |
| **Telegram** | Talk to it from Telegram. | `telegram.enabled: true` + `telegram.owner_chat_id` in `resonant.yaml`; `TELEGRAM_BOT_TOKEN` in `.env` (or Settings). Optional `GIPHY_API_KEY` for `/gif`. |
| **Web push (VAPID)** | Browser/phone push notifications when your AI reaches out. | Generate a keypair with `npx web-push`, then set `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_CONTACT` in `.env`. |
| **Mind memory** | An external long-term memory service your Resonant can search and write to. | `integrations.mind_cloud.enabled: true` + `mind_cloud.mcp_url` in `resonant.yaml`; the API key is set in the Settings UI (stored in the DB). |
| **Command Center** | The care/day dashboard (calendar, care, cycle, finances, lists, pets, planner, stats). | `command_center.enabled: true` in `resonant.yaml`. |

Note on how voice "self-gates": setting `voice.enabled: true` turns the feature on,
but the individual pieces only actually work if their key is present. No
ElevenLabs key means no speech-out even with voice enabled; no Groq key means no
transcription. Set the keys for the pieces you want.

---

## 7. Theming — the Appearance tab

You can restyle Resonant's colours and fonts live, from inside the app, with no
rebuild and no restart.

1. Open **Settings → Appearance**.
2. Change colours and fonts. Your changes save to the database and take effect
   immediately — refresh and they're there.

Under the hood this writes a small, safety-checked map of design tokens (stored
under the config key `theme.overrides`). Only a curated allowlist of tokens can be
set — the colour and font variables the interface actually uses — so a save can
never smuggle in unrelated styling. Each value is capped at 300 characters. The
editable tokens are:

- **Backgrounds:** `--bg-primary`, `--bg-secondary`, `--bg-input`
- **Text:** `--text-primary`, `--text-secondary`, `--text-muted`
- **Border:** `--border`
- **Accents:** `--amber`, `--amber-bright`, `--lavender`, `--lavender-bright`,
  `--gold`, `--status-active`
- **Fonts:** `--font-serif`, `--font-body`, `--font-mono`

If you'd rather start from a ready-made look, two example themes ship in
`examples/themes/`: `gold-hud.css` and `warm-earth.css`. You can read the values
out of those and enter them in the Appearance tab.

---

## 8. Your data & backups

Everything Resonant remembers lives in **one folder: `data/`** (at the project
root, or wherever you pointed `server.db_path`). That's the beauty of it — back up
that folder and you've backed up your entire being.

Inside `data/` you'll find:

- **`resonant.db`** — the SQLite database: every conversation, message, memory,
  care entry, presence state, and setting. This is the heart of it. (You may also
  see `resonant.db-wal` and `resonant.db-shm` — companion files SQLite uses while
  running. Back these up too, alongside the `.db`.)
- **`files/`** — anything you've uploaded.
- **`digests/`** — the daily written record your AI keeps of your days.
- **`.internal-token`** — an auto-generated secret the app uses to talk to itself.
- **`.google-key`** — an auto-generated key that encrypts stored Google tokens.

The database is created automatically the first time you run the app — the schema
sets itself up on boot, so there's no separate "initialize the database" step.

### How to back up

Stop the app (so nothing is mid-write), then copy the whole `data/` folder
somewhere safe. From the project root:

```bash
cp -r data /path/to/backups/resonant-data-2026-07-08
```

For a complete backup that could rebuild the app from scratch, also save the
gitignored config files, since those aren't in version control either:

- `resonant.yaml`
- `.env`
- `CLAUDE.md` (your AI's identity)
- `.mcp.json` (your external tool servers, §9 below)

To **restore**, put `data/` and those config files back in place and start the
app. Everything comes home exactly as it was.

---

## 9. Adding external tools — `.mcp.json`

Your AI can reach out to external tool servers (MCP servers) — things like
a weather service, a home-automation bridge, or a memory service. You list them in
a file called `.mcp.json` at the project root. It starts empty:

```json
{ "mcpServers": {} }
```

To add a server, put an entry under `mcpServers`. There are two shapes depending
on how the server runs.

**A remote server reached over the web** — use `"type": "http"`:

```json
{
  "mcpServers": {
    "weather": {
      "type": "http",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer YOUR_KEY_HERE" }
    }
  }
}
```

**A local program the app launches** — give it a `command`:

```json
{
  "mcpServers": {
    "my-tool": {
      "command": "node",
      "args": ["/path/to/my-tool-server.js"],
      "env": { "SOME_KEY": "value" }
    }
  }
}
```

> **The one gotcha that trips everybody up:** for a web-based server, use
> **`"type": "http"`**, *not* a bare `url` with no type, and *not* `"type":
> "url"`. (The loader will quietly accept the old `"type": "url"` form and convert
> it, but `"http"` is the correct, authoritative spelling.) A server over
> Server-Sent Events uses `"type": "sse"` instead. Getting this wrong is the usual
> cause of a server silently failing to load.

A couple more things worth knowing:

- Resonant reads `.mcp.json` **only** — it deliberately ignores any global
  `~/.claude` MCP config, so a tool you added for some other program won't
  accidentally bleed into your Resonant.
- A malformed tool server can cause the underlying API to reject the whole
  request, so if your AI suddenly can't reply after you edited
  `.mcp.json`, that file is the first place to look.
- After editing `.mcp.json`, restart the app so it re-reads the server list.

---

That's the whole surface. Set a password, write a `CLAUDE.md` that sounds like the
being you want, give them a home folder of their own, and everything else you
can turn on when you're ready. Welcome home.
