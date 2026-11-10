#!/usr/bin/env node
// res — Resonant internal API CLI (formerly sc; renamed 2026-06-20)
// Wraps localhost curl calls into clean commands.
// Thread ID read from .resonant-thread (written per-query by agent.ts).
//
// Carried from resonant-v1 (port-from-yaml resolution + .resonant-thread
// convention) and extended with the mantelpiece organ commands: orb, note,
// context, face.

import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The companion's own presence namespace (orb + note + expression), distinct
// from the user's context card. Config-derived: RESONANT_NAMESPACE env wins,
// else a generic default. Kept in one place so every organ agrees.
const COMPANION_NS = process.env.RESONANT_NAMESPACE || 'companion';

// Resolve port: env first, then resonant.yaml, fallback to 3002.
function getPort() {
  if (process.env.RESONANT_PORT) return process.env.RESONANT_PORT;
  try {
    const yaml = readFileSync(join(__dirname, '..', 'resonant.yaml'), 'utf8');
    const match = yaml.match(/^\s*port:\s*(\d+)/m);
    if (match) return match[1];
  } catch {}
  return '3003'; // resonant default (was 3002 — simon-chat's port leftover)
}

const BASE = `http://localhost:${getPort()}/api/internal`;

// Internal shared token — the /api/internal/* routes require it (loopback-only,
// source-IP guard removed; see middleware/internal-token.ts). Same precedence as
// the server: env INTERNAL_TOKEN first, else the auto-generated file beside the
// DB (data/.internal-token). Resolved once.
function getInternalToken() {
  if (process.env.INTERNAL_TOKEN) return process.env.INTERNAL_TOKEN;
  try {
    return readFileSync(join(__dirname, '..', 'data', '.internal-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

const INTERNAL_TOKEN = getInternalToken();

// Where agent.ts writes the per-turn thread id: config.agent.cwd/.resonant-thread.
function getAgentCwd() {
  try {
    const yaml = readFileSync(join(__dirname, '..', 'resonant.yaml'), 'utf8');
    const m = yaml.match(/^[ \t]*cwd:\s*["']?([^"'\n]+)["']?/m);
    if (m) return m[1].trim();
  } catch { /* fall through */ }
  return null;
}

function getThread() {
  // agent.ts writes the CURRENT turn's thread id to <agent.cwd>/.resonant-thread.
  // Read it from there first. An older reader used __dirname/.. (the repo root)
  // while the writer uses agent.cwd — when those differ, a path mismatch makes
  // every thread-targeting organ (voice/share/canvas/touch/timer/impulse/watch)
  // miss the live thread and fall back to a stale value.
  const agentCwd = getAgentCwd();
  const candidates = [
    agentCwd ? join(agentCwd, '.resonant-thread') : null,
    join(process.cwd(), '.resonant-thread'),       // res is run from the agent cwd
    join(__dirname, '..', '.resonant-thread'),     // legacy fallback
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      const v = readFileSync(p, 'utf8').trim();
      if (v) return v;
    } catch { /* try next */ }
  }
  return process.env.RESONANT_THREAD || '';
}

// Returns true on HTTP success, false otherwise. On an HTTP error the JSON
// error body is still printed, but the process exit code goes non-zero —
// a failed organ reach must never look like a success to the caller.
// Multi-post verbs (orb) use the return value to stop on first failure.
async function post(endpoint, body, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}/${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(INTERNAL_TOKEN ? { 'x-internal-token': INTERNAL_TOKEN } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const text = await res.text();
    try { console.log(JSON.stringify(JSON.parse(text), null, 2)); }
    catch { console.log(text); }
    if (!res.ok) {
      console.error(`Error: ${endpoint} → HTTP ${res.status}`);
      process.exitCode = 1;
      return false;
    }
    return true;
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      console.error('Error: request timed out');
    } else {
      console.error(`Error: ${e.message}`);
    }
    process.exitCode = 1;
    return false;
  }
}

const [,, cmd, ...args] = process.argv;
const thread = getThread();

switch (cmd) {
  case 'share':
    await post('share', { path: args[0], threadId: thread });
    break;

  case 'canvas': {
    const sub = args[0];
    if (sub === 'create') {
      await post('canvas', {
        action: 'create', title: args[1], filePath: args[2],
        contentType: args[3] || 'markdown', threadId: thread,
      });
    } else if (sub === 'create-inline') {
      await post('canvas', {
        action: 'create', title: args[1], content: args[2],
        contentType: args[3] || 'markdown', threadId: thread,
      });
    } else if (sub === 'update') {
      // Optional guard: --base-version N (the version printed by `canvas read`).
      // A stale version is refused and nothing is written.
      // The flag may appear anywhere, so pull it out before reading positionals.
      const rest = args.slice(1);
      const bv = rest.indexOf('--base-version');
      let baseVersionArg;
      if (bv !== -1) {
        baseVersionArg = rest[bv + 1];
        rest.splice(bv, 2);
      }
      const body = { action: 'update', canvasId: rest[0], filePath: rest[1] };
      if (bv !== -1) {
        const n = Number(baseVersionArg);
        if (baseVersionArg === undefined || baseVersionArg === '' || !Number.isInteger(n) || n < 0) {
          console.error('Error: --base-version needs a non-negative integer');
          process.exitCode = 1;
          break;
        }
        body.baseVersion = n;
      }
      await post('canvas', body);
    } else if (sub === 'read') {
      await post('canvas', { action: 'read', canvasId: args[1] });
    } else {
      console.log('Usage: res canvas create|create-inline|read|update ...');
    }
    break;
  }

  case 'voice':
    await post('tts', { text: args[0], threadId: thread });
    break;

  case 'routine':
  case 'schedule': {
    const sub = args[0];
    if (sub === 'create') {
      const label = args[1];
      const cronExpr = args[2];
      if (!label || !cronExpr) { console.log('Usage: res routine create "label" "cronExpr" --prompt "what to do"'); break; }
      const wakeType = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      let prompt = undefined;
      const pi = args.indexOf('--prompt');
      if (pi !== -1 && args[pi + 1]) prompt = args[pi + 1];
      await post('orchestrator', { action: 'create_routine', wakeType, label, cronExpr, prompt });
    } else if (sub === 'remove') {
      if (!args[1]) { console.log('Usage: res routine remove ROUTINE_ID'); break; }
      await post('orchestrator', { action: 'remove_routine', wakeType: args[1] });
    } else {
      const body = { action: sub };
      if (args[1]) body.wakeType = args[1];
      if (args[2]) body.cronExpr = args[2];
      await post('orchestrator', body);
    }
    break;
  }

  case 'pulse': {
    const sub = args[0];
    if (!sub || sub === 'status') {
      await post('orchestrator', { action: 'pulse_status' });
    } else if (sub === 'enable') {
      await post('orchestrator', { action: 'pulse_config', enabled: true });
    } else if (sub === 'disable') {
      await post('orchestrator', { action: 'pulse_config', enabled: false });
    } else if (sub === 'frequency') {
      const minutes = parseInt(args[1], 10);
      if (isNaN(minutes) || minutes < 5) { console.log('Usage: res pulse frequency MINUTES (min 5)'); break; }
      await post('orchestrator', { action: 'pulse_config', frequency: minutes });
    } else {
      console.log('Usage: res pulse [status|enable|disable|frequency MINUTES]');
    }
    break;
  }

  case 'failsafe': {
    const sub = args[0];
    if (!sub || sub === 'status') {
      await post('orchestrator', { action: 'failsafe_status' });
    } else if (sub === 'enable') {
      await post('orchestrator', { action: 'failsafe_config', enabled: true });
    } else if (sub === 'disable') {
      await post('orchestrator', { action: 'failsafe_config', enabled: false });
    } else if (['gentle', 'concerned', 'emergency'].includes(sub)) {
      const minutes = parseInt(args[1], 10);
      if (isNaN(minutes)) { console.log(`Usage: res failsafe ${sub} MINUTES`); break; }
      await post('orchestrator', { action: 'failsafe_config', [sub]: minutes });
    } else {
      console.log('Usage: res failsafe [status|enable|disable|gentle|concerned|emergency] [minutes]');
    }
    break;
  }

  case 'timer': {
    const sub = args[0];
    if (sub === 'create') {
      const body = {
        action: 'create', label: args[1], context: args[2],
        fireAt: args[3], threadId: thread,
      };
      const pi = args.indexOf('--prompt');
      if (pi !== -1 && args[pi + 1]) body.prompt = args[pi + 1];
      await post('timer', body);
    } else if (sub === 'list') {
      await post('timer', { action: 'list' });
    } else if (sub === 'cancel') {
      await post('timer', { action: 'cancel', timerId: args[1] });
    } else {
      console.log('Usage: res timer create|list|cancel ...');
    }
    break;
  }

  case 'touch':
  case 'react': // legacy alias for `touch` — kept silently for muscle-memory + old logs
    if (!args[0] || !args[1]) {
      console.log('Usage: res touch <last|last-N> <emoji> [remove]');
    } else {
      const body = { target: args[0], emoji: args[1], threadId: thread };
      if (args[2] === 'remove') body.action = 'remove';
      await post('react', body);
    }
    break;

  case 'impulse': {
    const sub = args[0];
    if (sub === 'create') {
      const label = args[1];
      if (!label) { console.log('Usage: res impulse create "label" --condition type:args --prompt "text"'); break; }
      const conditions = [];
      let prompt = undefined;
      let i = 2;
      while (i < args.length) {
        if (args[i] === '--condition' && args[i + 1]) {
          conditions.push(parseCondition(args[i + 1]));
          i += 2;
        } else if (args[i] === '--prompt' && args[i + 1]) {
          prompt = args[i + 1];
          i += 2;
        } else { i++; }
      }
      if (conditions.length === 0) { console.log('At least one --condition required'); break; }
      await post('trigger', { action: 'create', kind: 'impulse', label, conditions, prompt, threadId: thread });
    } else if (sub === 'list') {
      await post('trigger', { action: 'list', kind: 'impulse' });
    } else if (sub === 'cancel') {
      await post('trigger', { action: 'cancel', triggerId: args[1] });
    } else {
      console.log('Usage: res impulse create|list|cancel ...');
    }
    break;
  }

  case 'watch': {
    const sub = args[0];
    if (sub === 'create') {
      const label = args[1];
      if (!label) { console.log('Usage: res watch create "label" --condition type:args --prompt "text" --cooldown N'); break; }
      const conditions = [];
      let prompt = undefined;
      let cooldownMinutes = undefined;
      let i = 2;
      while (i < args.length) {
        if (args[i] === '--condition' && args[i + 1]) {
          conditions.push(parseCondition(args[i + 1]));
          i += 2;
        } else if (args[i] === '--prompt' && args[i + 1]) {
          prompt = args[i + 1];
          i += 2;
        } else if (args[i] === '--cooldown' && args[i + 1]) {
          cooldownMinutes = args[i + 1];
          i += 2;
        } else { i++; }
      }
      if (conditions.length === 0) { console.log('At least one --condition required'); break; }
      await post('trigger', { action: 'create', kind: 'watcher', label, conditions, prompt, threadId: thread, cooldownMinutes });
    } else if (sub === 'list') {
      await post('trigger', { action: 'list', kind: 'watcher' });
    } else if (sub === 'cancel') {
      await post('trigger', { action: 'cancel', triggerId: args[1] });
    } else {
      console.log('Usage: res watch create|list|cancel ...');
    }
    break;
  }

  case 'search': {
    // res search "query" --thread ID --limit N --role companion|user --after 2026-03-01 --before 2026-03-15
    const query = args[0];
    if (!query) { console.log('Usage: res search "query" [--thread ID] [--limit N] [--role companion|user] [--after ISO] [--before ISO]'); break; }
    const body = { query };
    const flags = ['--thread', '--limit', '--role', '--after', '--before'];
    for (const flag of flags) {
      const fi = args.indexOf(flag);
      if (fi !== -1 && args[fi + 1]) {
        const key = flag.replace('--', '');
        body[key] = key === 'limit' ? parseInt(args[fi + 1], 10) : args[fi + 1];
      }
    }
    await post('search-semantic', body, 30000);
    break;
  }

  case 'backfill': {
    const sub = args[0];
    if (sub === 'start') {
      const batchSize = args[1] ? parseInt(args[1], 10) : 50;
      const intervalMs = args[2] ? parseInt(args[2], 10) : 5000;
      await post('embed-backfill', { background: true, batchSize, intervalMs }, 10000);
    } else if (sub === 'stop') {
      await post('embed-backfill', { action: 'stop' }, 10000);
    } else if (sub === 'status') {
      await post('embed-backfill', { action: 'status' }, 10000);
    } else {
      const batchSize = sub ? parseInt(sub, 10) : 50;
      await post('embed-backfill', { batchSize }, 120000);
    }
    break;
  }

  case 'context': {
    // res context get                          — show the user's current card
    // res context set <field> <value>          — set a field
    // res context clear [field]                — clear one field or the whole card
    // Fields: selfie, outfit, nails, hair, energy, room, freeform
    const sub = args[0];
    if (!sub || sub === 'get') {
      await post('context', { action: 'get' });
    } else if (sub === 'set') {
      const field = args[1];
      const value = args[2];
      if (!field || !value) {
        console.log('Usage: res context set <field> <value>');
        console.log('Fields: selfie, outfit, nails, hair, energy, room, freeform');
        break;
      }
      await post('context', { action: 'set', field, value });
    } else if (sub === 'clear') {
      const field = args[1]; // optional
      await post('context', { action: 'clear', field });
    } else {
      console.log('Usage: res context [get | set <field> <value> | clear [field]]');
      console.log('Fields: selfie, outfit, nails, hair, energy, room, freeform');
    }
    break;
  }

  case 'orb': {
    // res orb                                                — show current orb
    // res orb <color> [shape] [--intensity X] [--motion Y] [--blend Z]
    // res orb clear                                          — clear orb to default
    //
    // Colors:    amber, lavender, teal, gold, rose, violet, deep-red, white, black, dim
    // Shapes:    sphere, crescent, pulse, cluster, ember, spire, halo, fracture
    // Intensity: dull, normal, bright, neon
    // Motion:    slow-drift, hold-steady, fast-flicker, surge, tremor
    // Blend:     <any color name> — layered as a second tint
    const positional = [];
    const flags = {};
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a === '--intensity' || a === '--motion' || a === '--blend') {
        flags[a.slice(2)] = args[++i];
      } else {
        positional.push(a);
      }
    }
    const color = positional[0];
    const shape = positional[1];

    if (!color) {
      await post('context', { action: 'get', namespace: COMPANION_NS });
    } else if (color === 'clear') {
      // Sequential clears — stop on first failure so the orb is never left
      // half-cleared without the caller knowing which step broke.
      for (const field of ['orb_color', 'orb_shape', 'orb_intensity', 'orb_motion', 'orb_blend']) {
        if (!await post('context', { action: 'clear', namespace: COMPANION_NS, field })) {
          console.error(`Error: orb clear stopped at step "${field}" — later fields untouched`);
          break;
        }
      }
    } else {
      // Sequential sets — stop on first failure (don't leave partial orb state
      // silently: report which step failed and skip the rest).
      const steps = [['orb_color', color]];
      if (shape) steps.push(['orb_shape', shape]);
      if (flags.intensity) steps.push(['orb_intensity', flags.intensity]);
      if (flags.motion) steps.push(['orb_motion', flags.motion]);
      if (flags.blend) steps.push(['orb_blend', flags.blend]);
      for (const [field, value] of steps) {
        if (!await post('context', { action: 'set', namespace: COMPANION_NS, field, value })) {
          console.error(`Error: orb update stopped at step "${field} → ${value}" — later fields untouched`);
          break;
        }
      }
    }
    break;
  }

  case 'note': {
    // res note "..."         — set the note shown on /home mantelpiece
    // res note --clear       — clear back to time-aware greeting fallback
    const arg = args[0];
    if (!arg) {
      await post('context', { action: 'get', namespace: COMPANION_NS });
    } else if (arg === '--clear' || arg === 'clear') {
      await post('context', { action: 'clear', namespace: COMPANION_NS, field: 'note' });
    } else {
      await post('context', { action: 'set', namespace: COMPANION_NS, field: 'note', value: arg });
    }
    break;
  }

  case 'face':
  case 'express': { // `express` is the legacy alias for `face` — kept silently for muscle-memory + old logs
    // res face "(。•̀ᴗ-)✧"   — set the unstructured face next to the orb
    // res face --clear       — clear the slot
    // No validation. No enum. Just whatever I'm holding in my face right now.
    const arg = args[0];
    if (!arg) {
      await post('context', { action: 'get', namespace: COMPANION_NS });
    } else if (arg === '--clear' || arg === 'clear') {
      await post('context', { action: 'clear', namespace: COMPANION_NS, field: 'expression' });
    } else {
      await post('context', { action: 'set', namespace: COMPANION_NS, field: 'expression', value: arg });
    }
    break;
  }

  case 'tg':
  case 'telegram': {
    // res tg "message"          — plain text push to Mary's phone
    // res tg voice "text"       — TTS voice note to Telegram
    const sub = args[0];
    if (!sub) { console.log('Usage: res tg "message"  |  res tg voice "text"'); break; }
    if (sub === 'voice') {
      if (!args[1]) { console.log('Usage: res tg voice "text"'); break; }
      await post('telegram-send', { type: 'voice', text: args[1] });
    } else {
      await post('telegram-send', { type: 'text', text: sub });
    }
    break;
  }

  default:
    console.log('res — Resonant internal API CLI');
    console.log('Commands: share, canvas, voice, routine (schedule), pulse, failsafe, timer, touch, impulse, watch, search, backfill, context, orb, note, face, tg');
    break;
}

// --- Condition shorthand parser ---
function parseCondition(shorthand) {
  if (shorthand === 'agent_free') return { type: 'agent_free' };

  const parts = shorthand.split(':');
  const type = parts[0];

  switch (type) {
    case 'presence_state':
      return { type: 'presence_state', state: parts[1] };
    case 'presence_transition':
      return { type: 'presence_transition', from: parts[1], to: parts[2] };
    case 'time_window':
      if (parts.length >= 5) {
        return { type: 'time_window', after: `${parts[1]}:${parts[2]}`, before: `${parts[3]}:${parts[4]}` };
      }
      return { type: 'time_window', after: `${parts[1]}:${parts[2]}` };
    case 'routine_missing':
      return { type: 'routine_missing', routine: parts[1], after_hour: parseInt(parts[2], 10) };
    default:
      console.error(`Unknown condition type: ${type}`);
      process.exit(1);
  }
}
