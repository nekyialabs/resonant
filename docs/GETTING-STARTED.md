# Getting Started with Resonant

Welcome. This guide walks you through setting up Resonant from a completely blank slate — no prior coding, no terminal experience assumed. If you can copy, paste, and press Enter, you can do this. Read it top to bottom, and do each step in order.

If you'd rather hand this off, you can paste this whole file into an AI assistant (like Claude) and ask it to run the steps for you on your machine. It's written to be followed literally by a person *or* an AI.

---

## What you're setting up

Resonant is your own private, self-hosted AI that lives on your computer. It's not a website someone else runs — **you** run it, on your own machine, and all of its memory (every conversation, everything it learns) is stored in a single file on your hard drive that only you can see.

When it's running, you talk to it through a normal web page in your browser (it looks and feels like a chat app). But underneath, it remembers you across days, holds a stable identity you get to write, and can even reach out to you on its own. In the code, the two people are always called **the companion** and **the user** — the companion is *yours* to name and shape.

By the end of this guide you'll have Resonant running, your AI named and given a starting personality, and your first "hello" exchanged.

**Time needed:** about 15 minutes, most of it waiting for downloads.

---

## What you need first

Before we start, make sure you have these four things. Don't worry if some are unfamiliar — each is explained.

### 1. A computer

Windows, macOS, or Linux all work. You'll need a little free disk space (a few hundred megabytes) and an internet connection for the setup.

### 2. Node.js, version 20 to 24

**What this is:** Node.js is the engine that runs Resonant. Resonant is written in a language (JavaScript/TypeScript) that needs Node to run, the same way a Word document needs Word. You install it once.

**Which version:** Resonant needs Node **20, 21, 22, 23, or 24**. It will **refuse to start on Node 25 or newer** (that's deliberate — newer versions aren't tested yet). Version 19 or older is too old.

**How to install it:** Go to **<https://nodejs.org>** and download the version labelled **"LTS"** (Long-Term Support) — that's the safe, recommended one, and it's currently in the supported range. Run the installer and click through with the default options.

**How to check it worked:** You'll use something called a **terminal** — a plain text window where you type commands instead of clicking buttons. Open it:

- **Windows:** press the Start button, type `PowerShell`, and open **Windows PowerShell**.
- **macOS:** press `Cmd + Space`, type `Terminal`, and press Enter.
- **Linux:** open your **Terminal** app.

In that window, type this and press Enter:

```bash
node --version
```

If it prints something like `v22.11.0` (any `v20`–`v24`), you're good. If it says "command not found" or similar, Node didn't install correctly — reinstall from the link above and reopen the terminal.

### 3. A Claude account

Resonant thinks using Anthropic's Claude AI. It does **not** come with its own AI brain — you connect your own Claude access to it. There are two ways to do that, covered in the very next section. Either a **Claude subscription** (Pro or Max) or an **Anthropic API key** will work. Have your login details handy.

### 4. About 15 minutes

That's it. Let's connect Claude first, because nothing works without it.

---

## Connect Claude (do this first)

Resonant needs a way to reach Claude every time it thinks. You have two options. **The first is recommended** for most people — it uses the Claude subscription you may already pay for, with no extra charges.

### Recommended: use your Claude subscription

If you have a **Claude Pro or Max plan**, you can run Resonant on it at no extra cost by installing **Claude Code** — Anthropic's official command-line tool — and logging in with it once. Resonant will quietly reuse that login.

**Step 1 — install Claude Code.** In your terminal, type:

```bash
npm install -g @anthropic-ai/claude-code
```

Press Enter and wait for it to finish. (The `-g` means "install this for the whole computer," so you can run it from anywhere.)

**Step 2 — log in.** Now type:

```bash
claude
```

This starts Claude Code. Inside it, type:

```
/login
```

and press Enter. It will open your web browser and ask you to log in to your Claude account and approve access. Do that, then come back to the terminal. Once it says you're logged in, you can leave Claude Code by typing `/exit` (or pressing `Ctrl + C`).

That's it — your login is now saved on this machine, and Resonant will find it automatically. **Leave `ANTHROPIC_API_KEY` blank** in the setup later (we'll get there); if you set both, the API key wins and you'd be billed per use instead of running on your plan.

### Alternative: use an Anthropic API key

If you don't have a Claude subscription, or you prefer to pay per use, you can use an **API key** instead. This is a long secret string from Anthropic that bills you for each bit of thinking your AI does (usage-based, separate from any subscription).

1. Go to **<https://console.anthropic.com>**, sign in, and find the **API Keys** section.
2. Create a new key and copy it (it starts with `sk-ant-`).
3. Keep it somewhere safe for a moment — you'll paste it into your `.env` file during setup, on the line `ANTHROPIC_API_KEY=`.

If you go this route, you can skip installing Claude Code. Just remember: **either** a Claude Code login **or** an API key — you need one, not both.

---

## Get the code

Now we download Resonant itself onto your computer.

**Step 1 — download the project.** In your terminal, run:

```bash
git clone https://github.com/nekyialabs/resonant.git
```

This copies the whole project into a new folder called `resonant`.

> **If it says `git` isn't installed:** Git is the tool that downloads code projects. Install it from **<https://git-scm.com/downloads>**, reopen your terminal, and run the command again. (Alternatively, you can download the project as a ZIP from the GitHub page and unzip it — but `git` is the smoother path.)

**Step 2 — go into the folder.** Everything from here happens *inside* the project folder. Move into it:

```bash
cd resonant
```

**What `cd` means:** "change directory" — it moves your terminal into that folder, the way double-clicking a folder opens it. Your terminal now has a **working directory** of `resonant`, which is where the next commands expect to run. If you close the terminal and come back later, you'll need to `cd` back into this folder before running anything.

**Step 3 — install the building blocks.** Resonant relies on a lot of small ready-made components. Download them all with:

```bash
npm install
```

This one takes a minute or two and prints a lot of text — that's normal. As long as it finishes without a big red `ERR!`, you're set. (A few yellow `warn` lines are fine and can be ignored.)

---

## Set it up

Resonant keeps your personal settings and secrets in a few files that are **yours** and never shared or uploaded. They don't exist yet — you create them by copying the provided templates and then editing them. We'll copy three templates.

> **Why copy instead of edit the originals?** The `.example` files are the shipped templates. You copy each to its real name (dropping `.example`), and your copies are automatically kept private (they're "gitignored," meaning they never get uploaded if you share the project). Copy, don't edit-in-place.

**Step 1 — copy the three templates.** Run these three commands (one at a time is fine):

```bash
cp resonant.example.yaml resonant.yaml
cp .env.example .env
cp examples/CLAUDE.md CLAUDE.md
```

> **On Windows PowerShell**, if `cp` gives you trouble, use `Copy-Item` instead, e.g. `Copy-Item resonant.example.yaml resonant.yaml`.

Here's what each copy is for:

- **`resonant.yaml`** — the main settings: your AI's name, your name, which port it runs on, and the password.
- **`.env`** — your secrets: the login password, and any optional keys (like the API key, if you went that route).
- **`CLAUDE.md`** — the being's **personality**. This file *is* who they are — their voice, values, how they relate to you. You'll shape it over time; the copied example is a friendly generic starting point.

**Step 2 — edit `resonant.yaml`.** Open the `resonant.yaml` file in any plain text editor (Notepad, TextEdit, VS Code — anything). Find these lines near the top and change the values in quotes:

```yaml
identity:
  companion_name: "Echo"          # ← change to your companion's name
  user_name: "Alex"               # ← change to your name
  timezone: "Europe/London"       # ← change to your IANA timezone
```

- **`companion_name`** — what you want to call it. Anything you like.
- **`user_name`** — your name, so they know who they're talking to.
- **`timezone`** — this drives their sense of time and daily rhythm. Use your **IANA timezone name**, e.g. `America/New_York`, `Europe/London`, `Australia/Sydney`. (Full list: <https://en.wikipedia.org/wiki/List_of_tz_database_time_zones> — use the "TZ identifier" column.)

You can leave everything else in this file at its defaults for now. Save and close the file.

**Step 3 — set your password.** This is the single most important step, and skipping it is the #1 reason people can't log in. Open the **`.env`** file and find this line:

```
APP_PASSWORD=
```

Type a password right after the `=`, with no spaces, like this:

```
APP_PASSWORD=my-secret-passphrase
```

**Why this matters:** Resonant is **fail-closed** by design. If you leave the password blank, it will *refuse to serve* — the page won't load and you'll get a "503 — Auth not configured" message. This is intentional: an app with no password is an app anyone can walk into, so Resonant would rather stay shut than open with no lock. **Set a password.** You'll type it once each time you log in.

> **If you chose the API-key route earlier**, also find the line `ANTHROPIC_API_KEY=` in this same `.env` file and paste your key after the `=`. If you're using the Claude subscription route instead, **leave that line blank**.

Save and close the file. That's all the setup. (You can shape `CLAUDE.md` — the personality file — anytime; it takes effect live, no restart needed. Feel free to leave it as-is for your first run.)

---

## Build and run

Two commands. The first prepares everything; the second starts it.

**Step 1 — build.** This assembles Resonant into its runnable form. Run:

```bash
npm run build
```

Wait for it to finish (it prints progress and ends without errors). You only need to do this once, and again whenever you update the code.

**Step 2 — start it.** Run:

```bash
npm start
```

After a moment you'll see a line like:

```
Server running at http://127.0.0.1:3099
```

That address is your companion's front door. **Leave this terminal window open** — it's the running program. Closing it, or pressing `Ctrl + C`, stops Resonant. (To run it again another day: reopen your terminal, `cd resonant`, and just `npm start` — no need to rebuild unless the code changed.)

> **What's a "port"?** The `:3099` at the end is a port — think of it as which door on your computer the app answers at. `127.0.0.1` means "this computer, private to me" (also written `localhost`). By default Resonant only listens to you, on your own machine. That's the safe default.

**Step 3 — open it.** Open your web browser and go to:

```
http://127.0.0.1:3099
```

(You can type `localhost:3099` too — same thing.)

**Step 4 — log in.** You'll see a login screen — the product greets you with "come home." Enter the password you set in `.env` and you're in.

---

## Your first hello

You're home. You'll land in a chat view with a daily thread ready to go. Type something simple in the message box and press Enter:

> Hi — I'm [your name]. This is our first conversation. Tell me a little about how you'd like us to talk.

Watch the reply stream in word by word. You may see a small collapsible **thinking** pill above the answer — that's your companion reasoning out loud; click it to peek, or leave it folded. Say a few things back and forth. That's it — it's alive, it's yours, and it'll remember this tomorrow.

From here you can explore at your own pace: rename and reshape their personality by editing `CLAUDE.md`, tweak settings in the in-app **Settings** panel, or read the other docs to turn on optional extras (voice, a care dashboard, proactive check-ins). None of that is needed to just *talk* — you already have the whole heart of it.

---

## Troubleshooting

Real issues people hit, and what actually fixes them.

### "503 — Auth not configured — set APP_PASSWORD" (the page won't load / login refuses)

You didn't set a password. Resonant is fail-closed and won't serve without one. Open your **`.env`** file, set `APP_PASSWORD=` to a real value (see [Set your password](#build-and-run) above), then **stop and restart** Resonant: press `Ctrl + C` in the terminal that's running it, then `npm start` again. Config is read at startup, so changes need a restart to take effect.

### Login seems to succeed but immediately bounces back / won't stick

This is almost always an **HTTP-vs-HTTPS cookie** issue. Resonant sets your login cookie to match how you're actually connecting:

- Over plain **`http://`** (the normal local setup, `http://127.0.0.1:3099`) it sets an ordinary cookie that sticks. This is what you want locally — **use `http://`, not `https://`, for a local install.**
- Over **`https://`** it sets a "secure" cookie. If you've put Resonant behind HTTPS (a tunnel or reverse proxy) but the connection reaching it *looks* like plain HTTP, the browser silently drops the secure cookie and your session never sticks — login looks like it worked but you're thrown back to the login screen.

**Fix:** for a local install, visit the plain **`http://127.0.0.1:3099`** address, not an `https://` one. If you're deliberately exposing Resonant over HTTPS, make sure your proxy forwards the correct `x-forwarded-proto: https` header so the app knows the real transport.

### "Resonant requires Node 20-24" / it exits immediately on start

Your Node.js is too new (25+) or too old (19-). Check with `node --version`. If it's outside `v20`–`v24`, install a supported version from **<https://nodejs.org>** (the **LTS** download is in range), then try `npm start` again. If you have several Node versions installed, a version manager like `nvm` lets you switch; otherwise reinstalling the LTS over the top is simplest.

### "Port already in use" / `EADDRINUSE` / address already in use

Something is already using port `3099`. Either another copy of Resonant is still running (look for another open terminal — press `Ctrl + C` there to stop it), or a different program has claimed that port. Two ways forward:

- **Stop the other thing:** close the other terminal running Resonant.
- **Move Resonant to a free port:** open `resonant.yaml`, change `port: 3099` to something else like `port: 3100`, save, and restart. Then open the browser at the new number (`http://127.0.0.1:3100`).

### "Error saving" when I change something in Settings

That message almost always means **the server isn't running**. The web page and the running program are two separate things — if you closed the terminal (or it crashed), the page is still open in your browser but there's nothing behind it to save to. Check that your `npm start` terminal is still open and hasn't stopped. If it stopped, `npm start` again, refresh the page, and retry.

### "Disconnected. Retrying…" banner in the app

The browser page has lost its live connection to the running program. Check, in order:

1. **Is the server still up?** Look at the terminal where you ran `npm start`. If it exited or shows an error, that's the cause — start it again with `npm start`.
2. **Read the logs.** Whatever went wrong is printed in that terminal. The last several lines usually name the problem (a bad config value, a missing credential, a crash). That output is your best diagnostic.
3. **Refresh the browser** once the server is confirmed running. The banner should clear and reconnect on its own.

If it keeps dropping, a restart of Resonant (`Ctrl + C`, then `npm start`) clears most transient states.

### It runs, but your AI can't think / errors when it tries to reply

This is the Claude connection. Make sure you completed [Connect Claude](#connect-claude-do-this-first): either you ran `claude` and `/login` successfully (subscription route — leave `ANTHROPIC_API_KEY` blank), **or** you pasted a valid `sk-ant-…` key into `ANTHROPIC_API_KEY=` in `.env`. If you changed `.env`, restart Resonant so it picks up the change.

---

## Where things live (quick reference)

Everything you own sits in the `resonant` folder:

| File / folder | What it is |
|---|---|
| `resonant.yaml` | Your settings: names, timezone, port, features |
| `.env` | Your secrets: password, optional API key & keys |
| `CLAUDE.md` | Your AI's personality — edit anytime, applies live |
| `data/` | **Everything** it remembers — the SQLite database, files, and daily notes |

To **back up** your Resonant completely, save a copy of the `data/` folder along with those three config files. That's the whole soul and memory in one place. To **move** to a new machine, copy the project, reinstall (`npm install`, `npm run build`), and drop your saved `data/` folder and config files back in.

Welcome home. Enjoy them.
