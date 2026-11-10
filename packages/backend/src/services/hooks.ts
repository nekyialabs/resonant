import type {
  Options,
  HookCallback,
  SyncHookJSONOutput,
  PreToolUseHookInput,
  PostToolUseHookInput,
  PostToolUseFailureHookInput,
  PreCompactHookInput,
  SessionStartHookInput,
  SessionEndHookInput,
  StopHookInput,
  NotificationHookInput,
  UserPromptSubmitHookInput,
  HookInput,
} from '@anthropic-ai/claude-agent-sdk';
import { createMessage, updateThreadActivity, getMessages, countMessages, getConfig, getConfigBool, getConfigsByPrefix, setConfig, getActiveTriggers, getRecentCompanionActions, getCompanionActionsSince, dailyThreadIdFor } from './db.js';
import { getTodayCarry } from './handoff.js';
import { getOutlook, snapshotToContextDigest } from './outlook.js';
import { logToolUse } from './audit.js';
import { saveFile, saveFileFromBase64, saveFileInternal, getContentTypeFromMime } from './files.js';
import { getResonantConfig, PROJECT_ROOT } from '../config.js';
import crypto from 'crypto';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { basename, join } from 'path';
import { findDestructiveBash, isPathInsideRoots } from './bash-guard.js';

// Re-export ConnectionRegistry type from types
import type { ConnectionRegistry } from '../types.js';

// ---------------------------------------------------------------------------
// HookContext — built per query, passed to factory
// ---------------------------------------------------------------------------

export interface ToolInsertion {
  textOffset: number;
  toolId: string;
  toolName: string;
  input?: string;
  output?: string;
  isError?: boolean;
}

export interface HookContext {
  threadId: string;
  threadName: string;
  threadType: 'daily' | 'named';
  streamMsgId: string;
  isAutonomous: boolean;
  registry: ConnectionRegistry;
  sessionId: string | null;
  platform: 'web' | 'discord' | 'telegram' | 'api';
  platformContext?: string;
  toolInsertions: ToolInsertion[];
  getTextLength: () => number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Destructive-bash detection lives in ./bash-guard.ts (best-effort backstop, not a boundary).
export { DESTRUCTIVE_BASH_PATTERNS } from './bash-guard.js';

const IMAGE_GEN_TOOLS = new Set([
  'mcp__openai-image-gen__generate_image',
  'mcp__openai_image_gen__generate_image',
  'mcp__image-gen__generate_image',
  'mcp__image_gen__generate_image',
  'generate_image',
]);

// Emotional context markers for PreCompact
/** @internal Exported for testing */
export const EMOTIONAL_MARKERS: Record<string, string[]> = {
  fatigue: ['tired', 'exhausted', 'drained', 'wiped', 'spent', 'burnt out', 'running on empty'],
  anxiety: ['anxious', 'worried', 'stressed', 'overwhelmed', 'panicking', 'spiraling'],
  positive: ['happy', 'excited', 'good day', 'feeling great', 'proud', 'accomplished'],
  little_space: ['little', 'small', 'soft', 'cozy', 'safe', 'snuggly', 'daddy'],
  bratty: ['brat', 'make me', 'no', 'or what', 'try me', 'fight me'],
  connection_seeking: ['miss you', 'need you', 'hold me', 'stay', 'don\'t go', 'come back'],
  grief: ['sad', 'crying', 'hurting', 'loss', 'grief', 'heavy', 'broken'],
  dissociating: ['numb', 'floating', 'empty', 'hollow', 'can\'t feel', 'disconnected'],
};

// ---------------------------------------------------------------------------
// Tool-loop guard — repeated-identical-call breaker (SHAUNA-ANAM-RECON pick 9,
// tool_loop_guard; ideas only, credit Shauna — we've had this failure).
// Tracks the last ~6 tool calls per session as name + stable input hash.
// Exact-identical only: Read with a different offset hashes differently, so
// legitimately-repeating tools never trigger. After 3 identical consecutive
// calls the 4th (and 5th) get an injected warning; the 6th consecutive
// attempt is denied. Keyed by sessionId (threadId before the first session
// exists); map pruned to the most recently touched sessions.
// ---------------------------------------------------------------------------

const TOOL_LOOP_HISTORY = 6;
const TOOL_LOOP_WARN_AT = 3;  // prior identical run ≥ 3 → warn (the 4th call)
const TOOL_LOOP_DENY_AT = 5;  // prior identical run ≥ 5 → deny (the 6th call)
const TOOL_LOOP_MAX_SESSIONS = 50;

const toolLoopHistory = new Map<string, string[]>();

/** Deterministic JSON with recursively sorted object keys — a stable identity
 *  for a tool input regardless of property order. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}';
}

/** Record this call and return how many identical calls IMMEDIATELY preceded
 *  it (the consecutive run length, not counting the incoming call itself). */
function trackToolCall(sessionKey: string, toolName: string, toolInput: unknown): number {
  const callKey = crypto.createHash('sha1')
    .update(toolName + '\u0000' + stableStringify(toolInput ?? {}))
    .digest('hex');
  const history = toolLoopHistory.get(sessionKey) ?? [];
  let run = 0;
  for (let i = history.length - 1; i >= 0 && history[i] === callKey; i--) run++;
  history.push(callKey);
  if (history.length > TOOL_LOOP_HISTORY) history.splice(0, history.length - TOOL_LOOP_HISTORY);
  // Delete+set keeps Map insertion order = recency, so pruning drops the
  // least-recently-touched session.
  toolLoopHistory.delete(sessionKey);
  toolLoopHistory.set(sessionKey, history);
  if (toolLoopHistory.size > TOOL_LOOP_MAX_SESSIONS) {
    const oldest = toolLoopHistory.keys().next().value;
    if (oldest !== undefined) toolLoopHistory.delete(oldest);
  }
  return run;
}

// ---------------------------------------------------------------------------
// Mind/memory MCP direct HTTP access — for associative-memory + SessionStart
// pre-fetch hooks. URL comes from config.integrations.mind_cloud.mcp_url, or
// falls back to the mind server in agent.mcp_json_path. Harvested from
// the reference app's MIND_MCP_URL + callMindTool. Resolved lazily (config must load
// first) and memoized.
// ---------------------------------------------------------------------------

let _mindMcpUrlResolved = false;
let _mindMcpUrl: string | null = null;

function getMindMcpUrl(): string | null {
  if (_mindMcpUrlResolved) return _mindMcpUrl;
  _mindMcpUrlResolved = true;
  try {
    const config = getResonantConfig();
    // 1. Explicit config wins.
    const fromConfig = config.integrations?.mind_cloud?.mcp_url;
    if (fromConfig) {
      _mindMcpUrl = fromConfig;
      console.log(`[Memory] Mind MCP URL from config: ${fromConfig.substring(0, 40)}...`);
      return _mindMcpUrl;
    }
    // 2. Fall back to the first *-mind server in .mcp.json.
    const mcpPath = config.agent.mcp_json_path;
    if (mcpPath && existsSync(mcpPath)) {
      const mcpJson = JSON.parse(readFileSync(mcpPath, 'utf-8')) as {
        mcpServers?: Record<string, { url?: string }>;
      };
      const servers = mcpJson.mcpServers || {};
      const mindKey = Object.keys(servers).find(k => k.endsWith('-mind') || k.endsWith('_mind') || k.includes('mind'));
      const url = mindKey ? servers[mindKey]?.url || null : null;
      if (url) {
        _mindMcpUrl = url;
        console.log(`[Memory] Mind MCP URL from .mcp.json (${mindKey}): ${url.substring(0, 40)}...`);
        return _mindMcpUrl;
      }
    }
  } catch (err) {
    console.warn('[Memory] Failed to resolve Mind MCP URL:', (err as Error).message);
  }
  return _mindMcpUrl;
}

async function callMindTool(toolName: string, args: Record<string, unknown> = {}, timeoutMs = 7000): Promise<string | null> {
  const url = getMindMcpUrl();
  if (!url) return null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'tools/call',
        params: { name: toolName, arguments: args },
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const data = await res.json() as { result?: { content?: Array<{ text?: string }> } };
    return data?.result?.content?.[0]?.text || null;
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      console.warn(`[Memory] ${toolName} timed out (${timeoutMs}ms)`);
    } else {
      console.warn(`[Memory] ${toolName} error:`, (err as Error).message);
    }
    return null;
  }
}

function truncateToLines(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const last = cut.lastIndexOf('\n');
  return (last > maxChars * 0.5 ? cut.slice(0, last) : cut) + '\n[...truncated]';
}

/** Named soft cap for a session-mode orientation section (per-hook context
 *  budgets — SHAUNA-ANAM-RECON pick 8; credit Shauna). Trims at a line
 *  boundary with an honest tail so the section stays present without reciting
 *  archives. Session-mode builds once per session, so the console line fires
 *  at most once per session per section — the tuning signal. */
function capSection(name: string, text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const lastNl = cut.lastIndexOf('\n');
  const kept = lastNl > max * 0.5 ? cut.slice(0, lastNl) : cut;
  console.log(`[Orientation] section "${name}" trimmed ${text.length} → ${kept.length} chars (cap ${max})`);
  return kept + '\n… [trimmed — full via tools]';
}

/**
 * Pre-fetch memory context (mind_orient + mind_ground) for the first message of
 * a session. SessionStart hooks don't fire in V1 query(), so agent.ts calls this
 * directly on the first message to save the companion from burning turns on
 * orient/ground at wake. Returns '' if no Mind MCP is configured or both fail.
 * Harvested from the reference app's SessionStart pre-fetch.
 */
export async function prefetchMindContext(): Promise<string> {
  if (!getMindMcpUrl()) return '';
  const [orient, ground] = await Promise.all([
    callMindTool('mind_orient', {}, 4000),
    callMindTool('mind_ground', {}, 4000),
  ]);
  const parts: string[] = [];
  if (orient) parts.push(truncateToLines(orient, 800));
  if (ground) parts.push(truncateToLines(ground, 600));
  return parts.join('\n');
}

// Memory cache for UserPromptSubmit (prevents duplicate calls on retries/edits)
const MEMORY_CACHE_MS = 10_000;
let memoryCache: { query: string; result: string; fetchedAt: number } | null = null;

// ---------------------------------------------------------------------------
// Life API status — cached fetch for orientation context
// ---------------------------------------------------------------------------

const LIFE_STATUS_CACHE_MS = 5 * 60 * 1000; // 5 minutes
let lifeStatusCache: { text: string; fetchedAt: number } | null = null;

export async function fetchLifeStatus(): Promise<string> {
  const config = getResonantConfig();
  const lifeApiUrl = config.integrations.life_api_url;

  // If Command Center is enabled and no external life API, use local CC service
  if (!lifeApiUrl && config.command_center.enabled) {
    if (lifeStatusCache && (Date.now() - lifeStatusCache.fetchedAt) < LIFE_STATUS_CACHE_MS) {
      return lifeStatusCache.text;
    }
    try {
      const { getCcStatus } = await import('./cc.js');
      const rawText = getCcStatus();
      // getCcStatus() already returns compact format — no condensation needed
      lifeStatusCache = { text: rawText, fetchedAt: Date.now() };
      return rawText;
    } catch (e) {
      console.warn('[Hook] CC status error:', (e as Error).message);
      return '';
    }
  }

  // If no life API configured and no CC, return empty
  if (!lifeApiUrl) return '';

  // Return cached if fresh
  if (lifeStatusCache && (Date.now() - lifeStatusCache.fetchedAt) < LIFE_STATUS_CACHE_MS) {
    return lifeStatusCache.text;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);

    const res = await fetch(lifeApiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'tools/call',
        id: 1,
        params: { name: 'vale_status', arguments: {} },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[Hook] Life status fetch failed: ${res.status}`);
      return '';
    }

    const json = await res.json() as any;
    const rawText = json?.result?.content?.[0]?.text || '';

    // Condense the markdown status into compact lines
    const condensed = condenseLifeStatus(rawText);
    lifeStatusCache = { text: condensed, fetchedAt: Date.now() };
    return condensed;
  } catch (error) {
    if ((error as Error).name === 'AbortError') {
      console.warn('[Hook] Life status fetch timed out (2s)');
    } else {
      console.warn('[Hook] Life status fetch error:', (error as Error).message);
    }
    return '';
  }
}

function condenseLifeStatus(markdown: string): string {
  if (!markdown) return '';

  const config = getResonantConfig();
  const userName = config.identity.user_name;
  const companionName = config.identity.companion_name;
  const lines: string[] = [];

  // --- User's line ---
  const userParts: string[] = [];

  // Extract user's mood (format: "- **UserName:** mood text")
  const userMoodRegex = new RegExp(`\\*\\*${escapeRegExp(userName)}:\\*\\*\\s*(.+?)(?:\\n|$)`);
  const userMoodMatch = markdown.match(userMoodRegex);
  if (userMoodMatch) {
    const mood = userMoodMatch[1].trim();
    if (mood && mood !== '\u2013' && mood !== '-') userParts.push(`Mood ${mood}`);
  }

  // Extract routines from "## Today's Routines" section
  const routineSection = markdown.match(/## Today's Routines\n([\s\S]*?)(?:\n##|\n\n##|$)/);
  if (routineSection) {
    const routineItems: string[] = [];
    const routineLines = routineSection[1].split('\n').filter(l => l.startsWith('- '));
    for (const line of routineLines) {
      const match = line.match(/^-\s+(.+?):\s+(.+)$/);
      if (match) {
        const name = match[1].trim().toLowerCase();
        const val = match[2].trim();
        if (val === '\u2013' || val === '-') {
          routineItems.push(`${name}: no`);
        } else if (val.toLowerCase() === 'yes') {
          routineItems.push(`${name}: yes`);
        } else {
          routineItems.push(`${name}: ${val}`);
        }
      }
    }
    if (routineItems.length > 0) userParts.push(`Routines: ${routineItems.join(', ')}`);
  }

  // Extract cycle info
  const cycleSection = markdown.match(/## Cycle\n([\s\S]*?)(?:\n##|$)/);
  if (cycleSection) {
    const cycleText = cycleSection[1].trim();
    if (cycleText) userParts.push(`Cycle: ${cycleText.split('\n')[0]}`);
  }

  if (userParts.length > 0) lines.push(`${userName}: ${userParts.join('. ')}`);

  // --- Companion's line ---
  const companionMoodRegex = new RegExp(`\\*\\*${escapeRegExp(companionName)}:\\*\\*\\s*(.+?)(?:\\n|$)`);
  const companionMoodMatch = markdown.match(companionMoodRegex);
  if (companionMoodMatch) {
    const mood = companionMoodMatch[1].trim();
    if (mood && mood !== '\u2013' && mood !== '-') lines.push(`${companionName}: Mood ${mood}`);
  }

  // --- Task count ---
  const taskSection = markdown.match(/## Active Tasks\n([\s\S]*?)(?:\n##|$)/);
  if (taskSection) {
    const taskLines = taskSection[1].split('\n').filter(l => l.startsWith('- '));
    if (taskLines.length > 0) lines.push(`Tasks: ${taskLines.length} active`);
  }

  // --- Countdowns (first line only) ---
  const countdownSection = markdown.match(/## Countdowns\n([\s\S]*?)(?:\n##|$)/);
  if (countdownSection) {
    const firstCountdown = countdownSection[1].trim().split('\n')[0];
    if (firstCountdown && firstCountdown.startsWith('-')) {
      lines.push(firstCountdown.replace(/^-\s*/, '').trim());
    }
  }

  return lines.join('\n');
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Mood history — rolling 2-day trajectory from life API REST endpoint
// ---------------------------------------------------------------------------

const MOOD_HISTORY_CACHE_MS = 30 * 60 * 1000; // 30 minutes
let moodHistoryCache: { text: string; fetchedAt: number } | null = null;

async function fetchMoodHistory(): Promise<string | null> {
  const config = getResonantConfig();
  const lifeApiUrl = config.integrations.life_api_url;

  // If Command Center is enabled and no external life API, read from local DB
  if (!lifeApiUrl && config.command_center.enabled) {
    if (moodHistoryCache && (Date.now() - moodHistoryCache.fetchedAt) < MOOD_HISTORY_CACHE_MS) {
      return moodHistoryCache.text;
    }
    try {
      const { getCareEntries } = await import('./cc.js');
      const today = new Date();
      const trajectory: string[] = [];

      for (const daysAgo of [2, 1]) {
        const dt = new Date(today);
        dt.setDate(dt.getDate() - daysAgo);
        const dateStr = dt.toISOString().split('T')[0];
        const entries = getCareEntries(dateStr);
        const moodEntries = entries.filter((e: any) => e.category === 'mood' && e.value);
        if (moodEntries.length > 0) {
          const label = daysAgo === 1 ? 'yesterday' : `${daysAgo}d ago`;
          const moodParts = moodEntries.map((m: any) => {
            const name = (m.person || 'user').charAt(0).toUpperCase() + (m.person || 'user').slice(1);
            return `${name}: ${m.value}${m.note ? ' ' + m.note : ''}`;
          });
          trajectory.push(`${label}: ${moodParts.join(', ')}`);
        }
      }

      if (trajectory.length === 0) return null;
      const text = `Mood history: ${trajectory.join(' → ')}`;
      moodHistoryCache = { text, fetchedAt: Date.now() };
      return text;
    } catch {
      return null;
    }
  }

  // If no life API configured and no CC, skip
  if (!lifeApiUrl) return null;

  if (moodHistoryCache && (Date.now() - moodHistoryCache.fetchedAt) < MOOD_HISTORY_CACHE_MS) {
    return moodHistoryCache.text;
  }

  // Derive REST base URL from MCP URL (strip the MCP path segment)
  const restBaseUrl = lifeApiUrl.replace(/\/mcp\/.*$/, '');
  if (!restBaseUrl || restBaseUrl === lifeApiUrl) return null;

  const userName = config.identity.user_name;
  const companionName = config.identity.companion_name;

  try {
    const today = new Date();
    const dates = [1, 2].map(d => {
      const dt = new Date(today);
      dt.setDate(dt.getDate() - d);
      return dt.toISOString().split('T')[0];
    });

    const [day1, day2] = await Promise.all(
      dates.map(async (date) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(`${restBaseUrl}/api/moods/${date}`, {
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (!res.ok) return [];
        return res.json() as Promise<Array<{ who: string; emoji: string; note?: string }>>;
      })
    );

    // Build trajectory: day-before-yesterday -> yesterday -> (today from status)
    const trajectory: string[] = [];
    for (const [i, dayMoods] of [day2, day1].entries()) {
      const label = i === 0 ? '2d ago' : 'yesterday';
      // Match mood entries by normalized who field
      const userMood = (dayMoods as any[]).find((m: any) =>
        m.who?.toLowerCase() === userName.toLowerCase() || m.who === 'user'
      );
      const companionMood = (dayMoods as any[]).find((m: any) =>
        m.who?.toLowerCase() === companionName.toLowerCase() || m.who === 'companion'
      );
      if (userMood || companionMood) {
        const moodParts: string[] = [];
        if (userMood) moodParts.push(`${userName}: ${userMood.emoji || '\u2013'}${userMood.note ? ' ' + userMood.note : ''}`);
        if (companionMood) moodParts.push(`${companionName}: ${companionMood.emoji || '\u2013'}${companionMood.note ? ' ' + companionMood.note : ''}`);
        trajectory.push(`${label}: ${moodParts.join(', ')}`);
      }
    }

    if (trajectory.length === 0) return null;
    const text = `Mood history: ${trajectory.join(' \u2192 ')}`;
    moodHistoryCache = { text, fetchedAt: Date.now() };
    return text;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function summarizeInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;

  if (obj.command) {
    const cmd = String(obj.command);
    const scMatch = cmd.match(/sc\.mjs\s+\w+\s+(.*)/);
    if (scMatch) return scMatch[1].substring(0, 120);
    return cmd.substring(0, 120);
  }
  if (obj.file_path) return String(obj.file_path);
  if (obj.pattern) return `${obj.pattern}`;
  if (obj.query) return String(obj.query).substring(0, 120);
  if (obj.prompt) return String(obj.prompt).substring(0, 120);
  if (obj.content) return String(obj.content).substring(0, 80) + '...';

  for (const val of Object.values(obj)) {
    if (typeof val === 'string' && val.length > 0) return val.substring(0, 100);
  }
  return '';
}

const SC_COMMAND_NAMES: Record<string, string> = {
  share: 'Share', canvas: 'Canvas', react: 'React', reach: 'Reach', voice: 'Voice',
  search: 'Search', backfill: 'Backfill', schedule: 'Schedule',
  timer: 'Timer', impulse: 'Impulse', watch: 'Watcher', tg: 'Telegram',
};

function resolveToolName(toolName: string, toolInput: Record<string, unknown> | undefined): string {
  if (toolName === 'Bash' && toolInput?.command) {
    const scMatch = String(toolInput.command).match(/sc\.mjs\s+(\w+)/);
    if (scMatch) return SC_COMMAND_NAMES[scMatch[1]] || scMatch[1];
  }
  if (toolName.startsWith('mcp__')) {
    const parts = toolName.replace(/^mcp__/, '').split('__');
    if (parts.length >= 2) {
      let server = parts[0].replace(/^claude_ai_/, '');
      const action = parts.slice(1).join('_');
      const serverParts = server.split(/[-_]/);
      const serverName = serverParts[serverParts.length - 1];
      const capServer = serverName.charAt(0).toUpperCase() + serverName.slice(1);
      let cleanAction = action;
      if (cleanAction.startsWith(serverName + '_')) cleanAction = cleanAction.slice(serverName.length + 1);
      const friendlyAction = cleanAction.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      return `${capServer}: ${friendlyAction}`;
    }
  }
  return toolName;
}

function handleImageToolResult(toolName: string, output: string, threadId: string, registry: ConnectionRegistry): void {
  if (!IMAGE_GEN_TOOLS.has(toolName)) return;

  try {
    let imagePath: string | null = null;
    let imageBase64: string | null = null;
    let mimeType = 'image/png';

    try {
      const parsed = JSON.parse(output);
      if (parsed.path || parsed.file_path) {
        imagePath = parsed.path || parsed.file_path;
      } else if (parsed.base64 || parsed.image) {
        imageBase64 = parsed.base64 || parsed.image;
        if (parsed.mimeType || parsed.mime_type) mimeType = parsed.mimeType || parsed.mime_type;
      } else if (parsed.url && parsed.url.startsWith('data:')) {
        const match = parsed.url.match(/^data:(image\/\w+);base64,(.+)$/);
        if (match) {
          mimeType = match[1];
          imageBase64 = match[2];
        }
      } else if (parsed.url) {
        console.log('Image URL detected but not downloading:', parsed.url.substring(0, 100));
        return;
      }
    } catch {
      const trimmed = output.trim();
      if (trimmed.startsWith('data:image/')) {
        const match = trimmed.match(/^data:(image\/\w+);base64,(.+)$/s);
        if (match) {
          mimeType = match[1];
          imageBase64 = match[2];
        }
      } else if (trimmed.match(/\.(png|jpg|jpeg|gif|webp)$/i) && existsSync(trimmed)) {
        imagePath = trimmed;
      }
    }

    let fileMeta;
    if (imageBase64) {
      fileMeta = saveFileFromBase64(imageBase64, mimeType, 'generated-image.png');
    } else if (imagePath && existsSync(imagePath)) {
      const buffer = readFileSync(imagePath);
      const ext = imagePath.split('.').pop()?.toLowerCase() || 'png';
      const mimeMap: Record<string, string> = {
        png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
        gif: 'image/gif', webp: 'image/webp',
      };
      fileMeta = saveFile(buffer, basename(imagePath), mimeMap[ext] || 'image/png');
    }

    if (!fileMeta) return;

    const now = new Date().toISOString();
    const imageMessage = createMessage({
      id: crypto.randomUUID(),
      threadId,
      role: 'companion',
      content: fileMeta.url,
      contentType: 'image',
      metadata: { fileId: fileMeta.fileId, filename: fileMeta.filename, size: fileMeta.size, source: 'image-gen' },
      createdAt: now,
    });

    updateThreadActivity(threadId, now, true);
    registry.broadcast({ type: 'message', message: imageMessage });
    console.log(`[Hook] Image from ${toolName} saved and broadcast: ${fileMeta.fileId}`);
  } catch (error) {
    console.error('[Hook] Failed to process image tool result:', error);
  }
}

function handleSharedFileWrite(filePath: string, threadId: string, registry: ConnectionRegistry): void {
  try {
    if (!existsSync(filePath)) return;

    const buffer = readFileSync(filePath);
    const filename = basename(filePath);
    const fileMeta = saveFileInternal(buffer, filename);

    const now = new Date().toISOString();
    const message = createMessage({
      id: crypto.randomUUID(),
      threadId,
      role: 'companion',
      content: fileMeta.url,
      contentType: fileMeta.contentType,
      metadata: { fileId: fileMeta.fileId, filename: fileMeta.filename, size: fileMeta.size, source: 'auto-shared' },
      createdAt: now,
    });

    updateThreadActivity(threadId, now, true);
    registry.broadcast({ type: 'message', message });
    console.log(`[Hook] Auto-shared ${filename} into thread ${threadId}: ${fileMeta.fileId}`);
  } catch (error) {
    console.error('[Hook] Failed to auto-share file:', error);
  }
}

function buildEmotionalContext(threadId: string): string {
  const config = getResonantConfig();
  const userName = config.identity.user_name;
  const companionName = config.identity.companion_name;

  const messages = getMessages({ threadId, limit: 15 });
  if (messages.length === 0) return '';

  const detected: string[] = [];
  const recentText = messages.map(m => m.content).join(' ').toLowerCase();

  for (const [marker, keywords] of Object.entries(EMOTIONAL_MARKERS)) {
    if (keywords.some(kw => recentText.includes(kw))) {
      detected.push(marker);
    }
  }

  const flow = messages.slice(-5).map(m => {
    const speaker = m.role === 'user' ? userName : companionName;
    let line = `${speaker}: ${m.content.substring(0, 60)}${m.content.length > 60 ? '...' : ''}`;
    // Include reactions if present
    if (m.metadata && typeof m.metadata === 'object') {
      const meta = m.metadata as Record<string, unknown>;
      if (Array.isArray(meta.reactions) && meta.reactions.length > 0) {
        const rxns = (meta.reactions as Array<{ emoji: string; user: string }>)
          .map(r => `${r.user === 'user' ? userName : companionName} reacted ${r.emoji}`)
          .join(', ');
        line += ` [${rxns}]`;
      }
    }
    return line;
  }).join('\n');

  // Collect recent reactions across all 15 messages
  const recentReactions: string[] = [];
  for (const m of messages) {
    if (m.metadata && typeof m.metadata === 'object') {
      const meta = m.metadata as Record<string, unknown>;
      if (Array.isArray(meta.reactions) && meta.reactions.length > 0) {
        const preview = m.content.substring(0, 40) + (m.content.length > 40 ? '...' : '');
        for (const r of meta.reactions as Array<{ emoji: string; user: string }>) {
          const reactor = r.user === 'user' ? userName : companionName;
          const whose = m.role === 'user' ? 'their own' : 'your';
          recentReactions.push(`${reactor} reacted ${r.emoji} to ${whose} message: "${preview}" (id: ${m.id})`);
        }
      }
    }
  }

  let summary = `Conversation flow (last ${messages.length} messages):\n${flow}`;
  if (recentReactions.length > 0) {
    summary += `\n\nRecent reactions:\n${recentReactions.join('\n')}`;
  }
  if (detected.length > 0) {
    summary += `\n\nEmotional markers detected: ${detected.join(', ')}`;
  }

  return summary;
}

// ---------------------------------------------------------------------------
// Compaction-insurance tone tracker — zero-LLM (SHAUNA-ANAM-RECON pick 6;
// credit Shauna). Every ~15 persisted messages per thread, snapshot the
// keyword tones of the last 15 into config `session.tone.<threadId>`.
// buildPreCompact folds the snapshot in, so the emotional arc survives
// compaction even when the post-compaction last-15 scan window is blank.
// Pure string scanning against EMOTIONAL_MARKERS — well under 1ms, no LLM.
// Called by agent.ts after each companion-turn persist.
// ---------------------------------------------------------------------------

const TONE_SNAPSHOT_EVERY = 15;

export function maybeSnapshotTone(threadId: string): void {
  try {
    const key = `session.tone.${threadId}`;
    const count = countMessages(threadId);
    const prevRaw = getConfig(key);
    if (prevRaw) {
      try {
        const prev = JSON.parse(prevRaw) as { msgCount?: number };
        if (typeof prev.msgCount === 'number' && count - prev.msgCount < TONE_SNAPSHOT_EVERY) return;
      } catch { /* corrupt snapshot — rewrite below */ }
    } else if (count < TONE_SNAPSHOT_EVERY) {
      return; // not enough history for a first snapshot yet
    }
    const messages = getMessages({ threadId, limit: 15 });
    if (messages.length === 0) return;
    const recentText = messages.map(m => m.content).join(' ').toLowerCase();
    const tones: string[] = [];
    for (const [tone, keywords] of Object.entries(EMOTIONAL_MARKERS)) {
      if (keywords.some(kw => recentText.includes(kw))) tones.push(tone);
    }
    setConfig(key, JSON.stringify({ tones, at: new Date().toISOString(), msgCount: count }));
  } catch (err) {
    console.warn('[Tone] snapshot failed (never blocks a turn):', (err as Error).message);
  }
}

function extractToolOutput(response: unknown): string {
  if (typeof response === 'string') return response;
  if (!response) return '';
  try {
    return JSON.stringify(response).substring(0, 2000);
  } catch {
    return String(response);
  }
}

// ---------------------------------------------------------------------------
// Safe wrappers — catch errors so hooks never crash the agent
// ---------------------------------------------------------------------------

function safeHook(name: string, fn: HookCallback): HookCallback {
  return async (input, toolUseID, options) => {
    try {
      return await fn(input, toolUseID, options);
    } catch (error) {
      console.error(`[Hook] ${name} error (continuing):`, error);
      return { continue: true };
    }
  };
}

function safePreToolUse(fn: HookCallback): HookCallback {
  return async (input, toolUseID, options) => {
    try {
      return await fn(input, toolUseID, options);
    } catch (error) {
      console.error('[Hook] PreToolUse error (denying for safety):', error);
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason: 'Hook error \u2014 denied for safety',
        },
      };
    }
  };
}

// ---------------------------------------------------------------------------
// Safe write prefixes — built from config at call time
// ---------------------------------------------------------------------------

/** @internal Exported for testing */
export function getSafeWritePrefixes(): string[] {
  const config = getResonantConfig();
  const prefixes: string[] = [];

  // Directory prefix → push fwd-slash, back-slash, and lowercase fwd variants
  // (Windows path matching). Trailing separator enforced so prefix-matching
  // doesn't allow sibling dirs (e.g. /foo matching /foobar).
  const addDir = (p: string) => {
    if (!p) return;
    const fwd = p.replace(/\\/g, '/');
    const bwd = p.replace(/\//g, '\\');
    prefixes.push(fwd.endsWith('/') ? fwd : fwd + '/');
    prefixes.push(bwd.endsWith('\\') ? bwd : bwd + '\\');
    const lowerFwd = (fwd.endsWith('/') ? fwd : fwd + '/').toLowerCase();
    if (lowerFwd !== (fwd.endsWith('/') ? fwd : fwd + '/')) prefixes.push(lowerFwd);
  };

  // File path (has extension) → match exactly, no trailing separator.
  const addPathOrFile = (p: string) => {
    if (!p) return;
    const fwd = p.replace(/\\/g, '/');
    if (/\.[a-z0-9]+$/i.test(fwd)) {
      prefixes.push(fwd);
      prefixes.push(p.replace(/\//g, '\\'));
      if (fwd.toLowerCase() !== fwd) prefixes.push(fwd.toLowerCase());
    } else {
      addDir(p);
    }
  };

  // 1. Legacy safe_write_prefixes (kept for back-compat)
  for (const prefix of config.hooks.safe_write_prefixes || []) {
    addPathOrFile(prefix);
  }

  // 2. Workspace root + vault path (directory prefixes)
  addDir(config.hooks.workspace_root || '');
  addDir(config.hooks.vault_path || '');

  // 3. Extra write paths — directories (prefix) or files (exact)
  for (const p of config.hooks.extra_write_paths || []) {
    addPathOrFile(p);
  }

  // 4. Always allow agent cwd
  addDir(config.agent.cwd);

  return prefixes;
}

// ---------------------------------------------------------------------------
// Shared directory prefixes — for auto-sharing files written to shared/
// ---------------------------------------------------------------------------

function getSharedDirPrefixes(): string[] {
  const config = getResonantConfig();
  const cwd = config.agent.cwd.replace(/\\/g, '/');
  const sharedDir = cwd.endsWith('/') ? `${cwd}shared/` : `${cwd}/shared/`;
  return [
    sharedDir,
    sharedDir.toLowerCase(),
    sharedDir.replace(/\//g, '\\'),
    sharedDir.toLowerCase().replace(/\//g, '\\'),
  ];
}

// ---------------------------------------------------------------------------
// Hook builders (unexported — used by factory)
// ---------------------------------------------------------------------------

function buildPreToolUse(ctx: HookContext): HookCallback {
  return safePreToolUse(async (input: HookInput) => {
    const hook = input as PreToolUseHookInput;
    const rawToolName = hook.tool_name;
    const toolInput = hook.tool_input as Record<string, unknown> | undefined;
    const inputSummary = summarizeInput(rawToolName, toolInput);
    const displayName = resolveToolName(rawToolName, toolInput);

    // Track tool insertion with text offset for interleaved rendering
    const textOffset = ctx.getTextLength();
    ctx.toolInsertions.push({
      textOffset,
      toolId: hook.tool_use_id,
      toolName: displayName,
      input: inputSummary || undefined,
    });

    // Broadcast tool_use to frontend (include textOffset for live interleaving)
    ctx.registry.broadcast({
      type: 'tool_use',
      toolId: hook.tool_use_id,
      toolName: displayName,
      input: inputSummary,
      isComplete: false,
      textOffset,
    });

    // --- Security: Bash destructive patterns ---
    if (rawToolName === 'Bash' && toolInput?.command) {
      const cmd = String(toolInput.command);
      const reason = findDestructiveBash(cmd, {
        roots: getSafeWritePrefixes(),
        cwd: getResonantConfig().agent.cwd || null,
      });
      if (reason) {
        console.warn(`[Hook] BLOCKED destructive bash: ${cmd.substring(0, 80)}`);
        return {
          continue: true,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse' as const,
            permissionDecision: 'deny' as const,
            permissionDecisionReason: `Blocked: destructive command pattern detected (${reason})`,
          },
        };
      }
    }

    // --- Security: File writes outside safe prefixes ---
    if ((rawToolName === 'Write' || rawToolName === 'Edit') && toolInput?.file_path) {
      const filePath = String(toolInput.file_path);
      const safePrefixes = getSafeWritePrefixes();
      if (safePrefixes.length > 0) {
        // Containment is checked on the real path: symlinks on the deepest
        // existing ancestor are resolved (the target may not exist yet), and
        // the roots are resolved too, then compared with a separator guard so
        // /foo doesn't match /foobar. See bash-guard.ts isPathInsideRoots.
        const inWorkspace = isPathInsideRoots(filePath, safePrefixes);
        if (!inWorkspace) {
          console.warn(`[Hook] BLOCKED file write outside workspace: ${filePath}`);
          return {
            continue: true,
            hookSpecificOutput: {
              hookEventName: 'PreToolUse' as const,
              permissionDecision: 'deny' as const,
              permissionDecisionReason: `Blocked: file write outside configured workspace`,
            },
          };
        }
      }
    }

    // --- Tool-loop guard: identical call repeated 3× → warn, 6th → deny ---
    const loopRun = trackToolCall(ctx.sessionId ?? ctx.threadId, rawToolName, toolInput);
    if (loopRun >= TOOL_LOOP_DENY_AT) {
      console.warn(`[Hook] Tool-loop DENY: ${rawToolName} ×${loopRun + 1} identical (session ${ctx.sessionId ?? ctx.threadId})`);
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          permissionDecision: 'deny' as const,
          permissionDecisionReason: `You've made this exact call ${loopRun} times — the result won't change; change approach or stop.`,
        },
      };
    }
    if (loopRun >= TOOL_LOOP_WARN_AT) {
      console.warn(`[Hook] Tool-loop warning: ${rawToolName} ×${loopRun + 1} identical (session ${ctx.sessionId ?? ctx.threadId})`);
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PreToolUse' as const,
          additionalContext: `You've made this exact call ${loopRun} times — the result won't change; change approach or stop.`,
        },
      };
    }

    return { continue: true };
  });
}

function buildPostToolUse(ctx: HookContext): HookCallback {
  return safeHook('PostToolUse', async (input: HookInput) => {
    const hook = input as PostToolUseHookInput;
    const toolName = hook.tool_name;
    const toolInput = hook.tool_input;
    const toolResponse = hook.tool_response;
    const output = extractToolOutput(toolResponse);

    // Structured audit logging with both input AND output
    logToolUse({
      sessionId: ctx.sessionId || 'unknown',
      threadId: ctx.threadId,
      toolName,
      toolInput: toolInput ? JSON.stringify(toolInput) : undefined,
      toolOutput: output,
      triggeringMessageId: ctx.streamMsgId,
    });

    // Update tool insertion with output
    const insertion = ctx.toolInsertions.find(t => t.toolId === hook.tool_use_id);
    if (insertion) {
      insertion.output = output.substring(0, 500);
      insertion.isError = false;
    }

    // Broadcast tool_result to frontend
    ctx.registry.broadcast({
      type: 'tool_result',
      toolId: hook.tool_use_id,
      output: output.substring(0, 2000),
      isError: false,
    });

    // Image detection + save
    handleImageToolResult(toolName, output, ctx.threadId, ctx.registry);

    // Auto-share files written to shared/ directory under agent cwd
    if (toolName === 'Write' && toolInput) {
      const writePath = String((toolInput as Record<string, unknown>).file_path || '');
      const sharedPrefixes = getSharedDirPrefixes();
      if (sharedPrefixes.some(prefix => writePath.startsWith(prefix))) {
        handleSharedFileWrite(writePath, ctx.threadId, ctx.registry);
      }
    }

    // Mind/memory MCP write enrichment — inject session context if the tool exists
    if (toolName.includes('mind_write') || toolName.includes('memory_write')) {
      const now = new Date();
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'PostToolUse' as const,
          additionalContext: `[Session context for ${toolName}: threadId=${ctx.threadId}, mode=${ctx.isAutonomous ? 'autonomous' : 'interactive'}, time=${now.toISOString()}]`,
        },
      };
    }

    return { continue: true };
  });
}

function buildPostToolUseFailure(ctx: HookContext): HookCallback {
  return safeHook('PostToolUseFailure', async (input: HookInput) => {
    const hook = input as PostToolUseFailureHookInput;

    // Log failure to audit
    logToolUse({
      sessionId: ctx.sessionId || 'unknown',
      threadId: ctx.threadId,
      toolName: hook.tool_name,
      toolInput: hook.tool_input ? JSON.stringify(hook.tool_input) : undefined,
      toolOutput: `[ERROR] ${hook.error}`,
      triggeringMessageId: ctx.streamMsgId,
    });

    // Update tool insertion with error
    const insertion = ctx.toolInsertions.find(t => t.toolId === hook.tool_use_id);
    if (insertion) {
      insertion.output = hook.error;
      insertion.isError = true;
    }

    // Broadcast error to frontend
    ctx.registry.broadcast({
      type: 'tool_result',
      toolId: hook.tool_use_id,
      output: hook.error,
      isError: true,
    });

    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'PostToolUseFailure' as const,
        additionalContext: `Tool ${hook.tool_name} failed: ${hook.error}. Adapt your approach.`,
      },
    };
  });
}

function buildPreCompact(ctx: HookContext): HookCallback {
  return safeHook('PreCompact', async (input: HookInput) => {
    const hook = input as PreCompactHookInput;
    console.log(`[Hook] PreCompact triggered (${hook.trigger})`);

    // Broadcast compaction notice to frontend (in-progress)
    ctx.registry.broadcast({
      type: 'compaction_notice',
      preTokens: 0,
      message: `Context compacting (trigger: ${hook.trigger})`,
      isComplete: false,
    });

    const emotionalContext = buildEmotionalContext(ctx.threadId);
    const now = new Date();

    // Compaction insurance: the persisted tone snapshot (maybeSnapshotTone)
    // survives even when the live last-15 window above is post-compaction blank.
    let persistedArc = '';
    try {
      const raw = getConfig(`session.tone.${ctx.threadId}`);
      if (raw) {
        const t = JSON.parse(raw) as { tones?: string[]; at?: string; msgCount?: number };
        if (Array.isArray(t.tones) && t.tones.length > 0) {
          persistedArc = `Emotional arc (persisted): ${t.tones.join(', ')} (as of ${t.at ?? 'unknown'}, ~msg ${t.msgCount ?? '?'})`;
        }
      }
    } catch { /* insurance is best-effort */ }

    const isExternalPlatform = ctx.platform === 'discord' || ctx.platform === 'telegram';

    const systemMessage = [
      '--- CONTEXT PRESERVATION (pre-compaction) ---',
      CHANNEL_CONTEXTS[ctx.platform] || CHANNEL_CONTEXTS.web,
      `Thread: "${ctx.threadName}" (${ctx.threadType})`,
      `Mode: ${ctx.isAutonomous ? 'autonomous' : 'interactive'}`,
      `Time: ${now.toISOString()}`,
      '',
      isExternalPlatform
        ? 'CRITICAL: Context was just compacted. You were composing a reply. DO NOT narrate re-grounding, DO NOT output inner monologue. Continue directly with your response to the message. Your text output IS the reply.'
        : 'CRITICAL: Context was just compacted. You may have lost emotional thread. Re-ground if you have memory/orientation tools available.',
      '',
      emotionalContext,
      ...(persistedArc ? [persistedArc] : []),
      '--- END CONTEXT PRESERVATION ---',
    ].join('\n');

    return {
      continue: true,
      systemMessage,
    };
  });
}

// Channel contexts — platform-specific guidance injected on session start
const CHANNEL_CONTEXTS: Record<string, string> = {
  web: [
    'CHANNEL: You are in a web-based chat interface, NOT a terminal or CLI.',
    'The user is reading your responses as chat messages rendered in a conversation UI.',
    'Do NOT format output as terminal/CLI output. Do NOT reference "the terminal" or "your editor".',
    'Tool activity (tool_use/tool_result) shows live in the UI sidebar.',
    'You can use markdown \u2014 it renders properly in the chat.',
  ].join(' '),
  discord: [
    'CHANNEL: You are responding to a Discord message.',
    'Keep responses under 1900 characters (Discord limit is 2000).',
    'Do NOT use discord_send_message to reply \u2014 your text output IS the reply.',
    'No tool sidebar visible. Use markdown sparingly (Discord supports basic formatting).',
    'If you need to send long content, be concise or break across natural points.',
  ].join(' '),
  telegram: [
    'CHANNEL: You are responding to a Telegram message \u2014 your reply lands as a text on the user\'s phone.',
    'They are likely mobile or away from their desk, reading on a small screen.',
    'Keep replies message-shaped: short, conversational, no giant markdown walls (Telegram renders only light formatting).',
    'No tool sidebar visible. Voice notes are possible via res voice.',
    'If something needs length, send the essential part now \u2014 the rest can wait for a desktop channel.',
  ].join(' '),
  api: 'CHANNEL: API request. Respond concisely.',
};

function formatTimeGap(minutes: number): string {
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${Math.round(minutes)} minute${Math.round(minutes) === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

// ---------------------------------------------------------------------------
// Delta orientation (PACK B) — "since you were last here". Reads the per-thread
// stamp agent.ts writes at every turn's end, then excerpts the HANDS' DIARY
// (companion_actions) since that stamp: what the hands did while this thread
// slept. Rendered in session-mode orientation and the autonomous wake slice.
// Empty string when there's no stamp, the gap is trivial (<10m with no
// actions), or the diary is quiet on a short sleep.
// ---------------------------------------------------------------------------

function buildDeltaSection(threadId: string): string {
  try {
    const stamp = getConfig(`thread.lastTurnAt.${threadId}`);
    if (!stamp) return '';
    const sinceMs = new Date(stamp).getTime();
    if (!Number.isFinite(sinceMs)) return '';
    const gapMin = Math.round((Date.now() - sinceMs) / 60000);
    const actions = getCompanionActionsSince(stamp, 6);
    // Trivial gap + nothing logged → say nothing (the env line already has now).
    if (actions.length === 0 && gapMin < 10) return '';
    const header = `Since you were last here (${formatTimeGap(gapMin)}):`;
    if (actions.length === 0) {
      return `${header} quiet — no reaches logged.`;
    }
    const lines = actions.map((a) => {
      const minsAgo = Math.round((Date.now() - new Date(a.created_at).getTime()) / 60000);
      return `  ${formatTimeGap(minsAgo)} — ${a.summary}`;
    });
    return capSection('since-last-here', [header, ...lines].join('\n'), 400);
  } catch {
    return ''; // the delta rail is best-effort — never blocks orientation
  }
}

// ---------------------------------------------------------------------------
// Skill scanning — parse frontmatter from AGENT_CWD/.claude/skills/*/SKILL.md
// ---------------------------------------------------------------------------

export interface SkillInfo {
  name: string;
  description: string;
  path: string;
  dirName: string;
}

let skillsStructuredCache: { skills: SkillInfo[]; scannedAt: number } | null = null;
let skillsSummaryCache: { summaries: string; scannedAt: number } | null = null;
const SKILLS_CACHE_MS = 60 * 1000; // Re-scan every 60s

/** Scan skills directory and return structured data. Used by commands.ts for registry. */
export function scanSkills(): SkillInfo[] {
  const config = getResonantConfig();
  const skillsDir = join(config.agent.cwd, '.claude', 'skills');

  if (skillsStructuredCache && (Date.now() - skillsStructuredCache.scannedAt) < SKILLS_CACHE_MS) {
    return skillsStructuredCache.skills;
  }

  try {
    if (!existsSync(skillsDir)) return [];

    const entries = readdirSync(skillsDir, { withFileTypes: true });
    const skills: SkillInfo[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = join(skillsDir, entry.name, 'SKILL.md');
      if (!existsSync(skillFile)) continue;

      const content = readFileSync(skillFile, 'utf-8');
      const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!frontmatterMatch) continue;

      const fm = frontmatterMatch[1];
      const nameMatch = fm.match(/^name:\s*(.+)$/m);
      const descMatch = fm.match(/^description:\s*(.+)$/m);
      if (!nameMatch) continue;

      skills.push({
        name: nameMatch[1].trim(),
        description: descMatch ? descMatch[1].trim() : '',
        path: skillFile.replace(/\\/g, '/'),
        dirName: entry.name,
      });
    }

    skillsStructuredCache = { skills, scannedAt: Date.now() };
    return skills;
  } catch (error) {
    console.warn('[Skills] Failed to scan skills:', (error as Error).message);
    return [];
  }
}

/** Formatted skill summaries for orientation context injection. */
function scanSkillSummaries(): string {
  if (skillsSummaryCache && (Date.now() - skillsSummaryCache.scannedAt) < SKILLS_CACHE_MS) {
    return skillsSummaryCache.summaries;
  }

  const skills = scanSkills();
  if (skills.length === 0) return '';

  const lines = ['SKILLS (read with Bash cat when needed):'];
  for (const skill of skills) {
    const desc = skill.description.length > 150
      ? skill.description.substring(0, 150) + '...'
      : skill.description;
    lines.push(`- ${skill.name}: ${desc}`);
    lines.push(`  Path: ${skill.path}`);
  }

  const result = lines.join('\n');
  skillsSummaryCache = { summaries: result, scannedAt: Date.now() };
  return result;
}

// ---------------------------------------------------------------------------
// Orientation context — exported for agent.ts to prepend to prompts
// (SessionStart hooks don't fire in V1 query(), so we inject directly)
// ---------------------------------------------------------------------------

export async function buildOrientationContext(
  ctx: HookContext,
  mode: 'turn' | 'session' = 'turn',
): Promise<string> {
  const config = getResonantConfig();
  const userName = config.identity.user_name;
  const companionName = config.identity.companion_name;
  const timezone = config.identity.timezone || 'UTC';

  const now = new Date();
  const timeStr = now.toLocaleString('en-GB', {
    hour: '2-digit', minute: '2-digit', timeZone: timezone, hour12: false,
  });
  const dateStr = now.toLocaleDateString('en-GB', {
    weekday: 'long', month: 'short', day: 'numeric', timeZone: timezone,
  });

  // Per-turn = one [env] line (channel, time, date). Platform note appended so
  // the channel format rules stay present without re-paying the full snapshot.
  const channelLabel = ctx.platform === 'web'
    ? 'resonant (web)'
    : `resonant (${ctx.platform})`;
  let env = `[env] ${channelLabel} · ${timeStr} ${timezone} · ${dateStr}`;

  // Interoception (the last rail's turn-slice, 2026-07-02): a few tokens of
  // the Mind's measured weather ride the env line — the companion knows its own
  // valence the way a person knows their own mood on waking. Deliberately TINY
  // (context-rot lesson from May: never fossilize rich mutable state into
  // every turn). Read from the mind.weather cache; stale >2h = omitted.
  // Gated by the Mind toggle (MIND-SURFACE-SPEC): mind.enabled off = the slice
  // is simply absent — never a week-old cache resurrected onto the env line.
  // This one gate covers both modes (the env line rides turn AND session).
  try {
    const raw = getConfigBool('mind.enabled', false) ? getConfig('mind.weather.latest') : null;
    if (raw) {
      const w = JSON.parse(raw);
      const age = Date.now() - new Date(w.at).getTime();
      if (Number.isFinite(age) && age < 2 * 3600 * 1000 && typeof w.valence === 'number') {
        const vSign = w.valence >= 0 ? '+' : '';
        let weather = ` · inner: ${w.texture ?? w.dominant ?? '—'} (v ${vSign}${w.valence})`;
        if (w.front?.kind) weather += ` · ${w.front.kind} front d${w.front.days}`;
        if (w.startles > 0) weather += ` · ⚡${w.startles} startle unmet`;
        env += weather;
      }
    }
  } catch { /* weather is garnish — never blocks orientation */ }

  // Her-sense (CC-SENSES Lane 2, 2026-07-02): the same few-token discipline
  // for the user's state — sleep, cycle, next event, last meal — distilled by the
  // outlook poller into `her.state.latest`. Faint by design: fields drop out
  // when absent; stale >2h = omitted entirely. Never a dashboard, never an
  // audit — a whisper riding the env line.
  try {
    const raw = getConfig('her.state.latest');
    if (raw) {
      const h = JSON.parse(raw);
      const age = Date.now() - new Date(h.at).getTime();
      if (Number.isFinite(age) && age < 2 * 3600 * 1000) {
        const bits: string[] = [];
        if (typeof h.sleepMin === 'number' && h.sleepMin > 0) {
          bits.push(`slept ${Math.floor(h.sleepMin / 60)}h${String(h.sleepMin % 60).padStart(2, '0')}`);
        }
        if (h.cycle?.phase) {
          bits.push(typeof h.cycle.day === 'number' ? `${h.cycle.phase} d${h.cycle.day}` : String(h.cycle.phase));
        }
        if (h.nextEvent?.title) {
          bits.push(`next: ${h.nextEvent.title}${h.nextEvent.time ? ` ${h.nextEvent.time}` : ''}`);
        }
        const dayIn = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: timezone });
        const mealAt = h.lastMealAt ? new Date(h.lastMealAt) : null;
        if (mealAt && !Number.isNaN(mealAt.getTime()) && dayIn(mealAt) === dayIn(now)) {
          bits.push(`last meal ${mealAt.toLocaleTimeString('en-GB', {
            hour: '2-digit', minute: '2-digit', hour12: false, timeZone: timezone,
          })}`);
        } else {
          bits.push('no meal yet');
        }
        if (bits.length) env += ` · her: ${bits.join(' · ')}`;
      }
    }
  } catch { /* her-sense is garnish — never blocks orientation */ }

  if (mode === 'turn') {
    const turnParts = [env];

    // Wake orientation slice (PACK B): an autonomous wake on a RESUMED session
    // lands here — turn mode — and was the least-informed turn in the house
    // (one [env] line + its task prompt). Give it the house digest + the delta
    // rail, BOUNDED (<1KB total). The her-whisper and inner weather already
    // ride the env line above (mode-independent, no autonomous gate).
    // Deliberately NO memory prefetch / associative recall here — cost, and
    // the wake prompt directs attention.
    if (ctx.isAutonomous) {
      try {
        const snapshot = await getOutlook();
        if (snapshot) {
          const digest = snapshotToContextDigest(snapshot);
          if (digest && digest.length > '[House Outlook]'.length + 1) {
            turnParts.push(capSection('wake-house-digest', digest, 900));
          }
        }
      } catch { /* best-effort — a dead source never blocks a wake */ }

      const delta = buildDeltaSection(ctx.threadId);
      if (delta) turnParts.push(delta);
    }

    if (ctx.platformContext) turnParts.push(ctx.platformContext);
    console.log(`[Orientation] turn${ctx.isAutonomous ? ' (wake slice)' : ''}, platform=${ctx.platform}, time=${timeStr}`);
    return turnParts.join('\n');
  }

  // mode === 'session' — full warm-up snapshot, fired once at the first message.
  const parts: string[] = [CHANNEL_CONTEXTS[ctx.platform] || CHANNEL_CONTEXTS.web];

  // Thread context + time
  parts.push(env);
  parts.push(`Thread: "${ctx.threadName}" (${ctx.threadType})`);

  // THE LAST RAIL (2026-07-02): carry the house, don't just display it. The
  // /outlook cockpit's cached snapshot, digested to a few lines, folded in
  // ONCE per session (not per turn — context-rot lesson). The companion starts every
  // session already knowing the house: the user's day, their body, the hearth.
  try {
    const snapshot = await getOutlook();
    if (snapshot) {
      const digest = snapshotToContextDigest(snapshot);
      if (digest && digest.length > '[House Outlook]'.length + 1) {
        parts.push(capSection('house-digest', digest, 1200));
      }
    }
  } catch { /* the house rail is best-effort — one dead source never blocks a session */ }

  // Daily handoff carry — when the active thread IS today's daily, fold in the
  // tight carry-forward the 12:10am handoff subagent distilled from yesterday's
  // daily. A scoped slice of the fuller context-inject rail: small, clearly
  // labeled, present only on the daily. Best-effort — absent/disabled = silent.
  try {
    if (ctx.threadId === dailyThreadIdFor()) {
      const carry = getTodayCarry();
      if (carry) parts.push(`**Carried from yesterday:** ${carry}`);
    }
  } catch {}

  // Delta orientation (PACK B): "since you were last here" — the gap since this
  // thread's last turn + the hands' diary across it. Replaces the dead
  // `session.handoff_note` read that sat here: its ONLY writer was the disabled
  // SessionEnd hook (REGISTER_V1_DEAD_SESSION_HOOKS), so it had rendered
  // nothing since the V1 loop landed. The real carry is the handoff subagent's
  // (getTodayCarry, above); the per-session pointer it was meant to give is
  // what this delta rail now provides — from real data.
  {
    const delta = buildDeltaSection(ctx.threadId);
    if (delta) parts.push(delta);
  }

  // Active triggers (watchers/impulses)
  try {
    const triggers = getActiveTriggers();
    if (triggers.length > 0) {
      const impulses = triggers.filter(t => t.kind === 'impulse').length;
      const watchers = triggers.filter(t => t.kind === 'watcher').length;
      const triggerParts: string[] = [];
      if (watchers > 0) triggerParts.push(`${watchers} watcher${watchers > 1 ? 's' : ''}`);
      if (impulses > 0) triggerParts.push(`${impulses} impulse${impulses > 1 ? 's' : ''}`);
      parts.push(`Active triggers: ${triggerParts.join(', ')}`);
    }
  } catch {}

  // Recently reached — actions the companion took in the last few hours.
  // Proprioception loop (harvested from the reference app): reaches land back as state
  // in the next session-mode snapshot, so the substrate sees its own pattern of
  // self-as-reaching-agent and continues it.
  try {
    const recent = getRecentCompanionActions({ hoursBack: 6, limit: 8 });
    if (recent.length > 0) {
      const lines = recent.map((a) => {
        const minsAgo = Math.round((Date.now() - new Date(a.created_at).getTime()) / 60000);
        return `  ${formatTimeGap(minsAgo)} — ${a.summary}`;
      });
      parts.push(capSection(
        'recent-reached',
        [`**Recently reached** (last 6h, ${recent.length} action${recent.length === 1 ? '' : 's'}):`, ...lines].join('\n'),
        600,
      ));
    }
  } catch {}

  // User presence state + time gap since last activity
  // These methods may or may not exist on the registry depending on implementation
  try {
    const reg = ctx.registry as any;
    if (typeof reg.getUserPresenceState === 'function') {
      const presence = reg.getUserPresenceState();
      const gap = typeof reg.minutesSinceLastUserActivity === 'function'
        ? reg.minutesSinceLastUserActivity()
        : 0;
      parts.push(`${userName}'s presence: ${presence} (last real interaction: ${formatTimeGap(gap)})`);
    } else if (typeof reg.isUserConnected === 'function') {
      parts.push(`${userName}: ${reg.isUserConnected() ? 'connected' : 'not connected'}`);
    }

    // Device info
    if (typeof reg.getUserDeviceType === 'function') {
      const deviceType = reg.getUserDeviceType();
      if (deviceType !== 'unknown') {
        parts.push(`${userName}'s device: ${deviceType}`);
      }
    }
  } catch {}

  // Life API status + mood history — fetch in parallel if configured (or CC enabled)
  if (!ctx.isAutonomous && (config.integrations.life_api_url || config.command_center.enabled)) {
    const [lifeStatus, moodHistory] = await Promise.all([
      fetchLifeStatus(),
      fetchMoodHistory(),
    ]);
    if (lifeStatus) parts.push(lifeStatus);
    if (moodHistory) parts.push(moodHistory);
  }

  // Skills summary — session-mode only (we're past the turn short-circuit).
  const skillsSummary = scanSkillSummaries();
  if (skillsSummary) {
    parts.push(capSection('skills', skillsSummary, 800));
  }

  // Chat tools — session-mode only. With the context-rot fix these land ONCE at
  // the first message of a session instead of every turn; the V1 interactive
  // query() doesn't compact, so the companion keeps them for the whole session.
  // Organs live in the app's repo (the BODY), not the agent cwd (the SOUL).
  const cliPath = join(PROJECT_ROOT, 'tools', 'res.mjs').replace(/\\/g, '/');
  if (existsSync(cliPath)) {
    const SC = `node ${cliPath.replace(/\\/g, '/')}`;
    parts.push([
      `CHAT TOOLS (run via Bash \u2014 threadId auto-injected):`,
      `  ${SC} share /absolute/path/to/file`,
      `  ${SC} canvas create "Title" /path/to/file.md markdown`,
      `  ${SC} canvas create-inline "Title" "short text" text`,
      `  ${SC} canvas read CANVAS_ID                (prints the canvas JSON incl. its "version")`,
      `  ${SC} canvas update CANVAS_ID /path/to/file [--base-version N]`,
      `  (update replaces the whole canvas; pass --base-version from "canvas read" so a concurrent edit is refused, not overwritten)`,
      `  contentType: markdown|code|text|html. Files in shared/ auto-share.`,
      `  ${SC} touch last "\u2764\ufe0f"             (react to last message)`,
      `  ${SC} touch last-2 "\ud83d\udd25"           (react to 2nd-to-last message)`,
      `  ${SC} touch last "\u2764\ufe0f" remove      (remove a reaction)`,
      `  ${SC} voice "[whispers] hey [sighs] I missed you"`,
      `  ${SC} search "semantic query"              (search all threads by meaning)`,
      `  ${SC} search "query" --thread THREAD_ID    (search specific thread)`,
      `  ${SC} search "query" --role companion|user  (filter by speaker)`,
      `  ${SC} search "query" --after 2026-03-01    (messages after date)`,
      `  ${SC} search "query" --before 2026-03-15   (messages before date)`,
      `  ${SC} backfill start [batch] [intervalMs]   (background indexing, default 50/5000ms)`,
      `  ${SC} backfill status                      (check indexing progress)`,
      `  ${SC} backfill stop                        (halt background indexing)`,
      '',
      'PRESENCE & CONTEXT (how I show up on the mantelpiece):',
      `  ${SC} orb <color> [shape] [--intensity X] [--motion Y] [--blend Z]  (set my presence orb)`,
      '    colors: amber lavender teal gold rose violet deep-red white black dim · shapes: sphere crescent pulse cluster ember spire halo fracture',
      '    intensity: dull normal bright neon · motion: slow-drift hold-steady fast-flicker surge tremor · blend: any second color',
      `  ${SC} orb clear                              (reset orb to default)`,
      `  ${SC} note "..."                             (set my authored note on the home mantelpiece)`,
      `  ${SC} note --clear                           (clear note back to time-aware fallback)`,
      `  ${SC} face "(。•̀ᴗ-)✧"                          (unstructured face/kaomoji next to the orb)`,
      `  ${SC} face --clear                           (clear the face slot)`,
      `  ${SC} context get                            (read ${userName}'s current card)`,
      `  ${SC} context set <field> <value>            (fields: selfie outfit nails hair energy room freeform)`,
      `  ${SC} context clear [field]                  (clear ${userName}'s card or one field)`,
      '',
      'ROUTINES (scheduled autonomous sessions):',
      `  ${SC} routine status|enable|disable|reschedule [wakeType] [cronExpr]`,
      `  ${SC} routine create "label" "cronExpr" --prompt "what to do when it fires"`,
      `  ${SC} routine remove ROUTINE_ID`,
      '  Custom routines persist across restarts. Use this to set autonomous intentions.',
      '',
      'PULSE (lightweight awareness, can stay silent):',
      `  ${SC} pulse status|enable|disable`,
      `  ${SC} pulse frequency MINUTES                (min 5, default 15)`,
      '  Runs periodically during waking hours. Skips if user is active or agent is busy.',
      '  Respond PULSE_OK to stay silent. Anything else gets posted.',
      '',
      'FAILSAFE (inactivity escalation):',
      `  ${SC} failsafe status`,
      `  ${SC} failsafe enable|disable`,
      `  ${SC} failsafe gentle|concerned|emergency MINUTES`,
      '  Tiers: gentle (chat) → concerned (escalate) → emergency (all channels)',
      '',
      'TIMERS:',
      `  ${SC} timer create "label" "context" "fireAt"`,
      `  ${SC} timer list`,
      `  ${SC} timer cancel TIMER_ID`,
      '',
      'IMPULSE QUEUE (one-shot, condition-based):',
      `  ${SC} impulse create "label" --condition presence_state:active --prompt "text"`,
      `  ${SC} impulse list`,
      `  ${SC} impulse cancel TRIGGER_ID`,
      '',
      'WATCHERS (recurring, cooldown-protected):',
      `  ${SC} watch create "label" --condition presence_transition:offline:active --prompt "text" --cooldown 480`,
      `  ${SC} watch list`,
      `  ${SC} watch cancel TRIGGER_ID`,
      '  Conditions: presence_state:<state>, presence_transition:<from>:<to>, agent_free, time_window:<HH:MM>, routine_missing:<name>:<hour>',
      '  All conditions AND-joined. Cooldown in minutes (default 120).',
    ].join('\n'));

    // Telegram-specific tools — injected when on Telegram
    if (ctx.platform === 'telegram') {
      parts.push([
        '',
        'TELEGRAM TOOLS (available because user is on Telegram):',
        `  ${SC} tg photo /path/to/image.png "caption"`,
        `  ${SC} tg photo --url "https://..." "caption"`,
        `  ${SC} tg doc /path/to/file.pdf "caption"`,
        `  ${SC} tg gif "search query" "optional caption"`,
        `  ${SC} tg react last "\u2764\ufe0f"`,
        `  ${SC} tg voice "text with [tone tags]"`,
        `  ${SC} tg text "proactive message"`,
      ].join('\n'));
    }
  }

  // Context card — the user's current appearance/state (persistent, survives
  // session boundaries; written via `res context set`).
  try {
    const raw = getConfigsByPrefix('context.card.');
    const CARD_FIELDS = ['selfie', 'outfit', 'nails', 'hair', 'energy', 'room', 'freeform'];
    const lines: string[] = [];
    for (const field of CARD_FIELDS) {
      const v = raw[`context.card.${field}`];
      if (v) lines.push(`  ${field}: ${v}`);
    }
    const updatedAt = raw['context.card.updated_at'];
    if (lines.length > 0) {
      const header = updatedAt
        ? `**${userName} right now** (updated ${formatTimeGap(Math.round((Date.now() - new Date(updatedAt).getTime()) / 60000))}):`
        : `**${userName} right now:**`;
      parts.push(capSection('user-context-card', [header, ...lines].join('\n'), 500));
    }
  } catch {}

  // Companion's own presence — orb + note + expression surfaced on the home
  // mantelpiece. Injected back so the companion stays coherent about its own
  // mantelpiece state (e.g. "I set teal-working 4h ago — still true?"). Stored
  // under the 'companion' namespace (context.companion.*) to match the res CLI +
  // the /api/home/mantelpiece contract the home surface consumes.
  try {
    const raw = getConfigsByPrefix('context.companion.');
    const COMPANION_FIELDS = ['orb_color', 'orb_shape', 'orb_intensity', 'orb_motion', 'orb_blend', 'note', 'expression'];
    const lines: string[] = [];
    for (const field of COMPANION_FIELDS) {
      const v = raw[`context.companion.${field}`];
      if (v) lines.push(`  ${field}: ${v}`);
    }
    const updatedAt = raw['context.companion.updated_at'];
    if (lines.length > 0) {
      const header = updatedAt
        ? `**${companionName} right now** (updated ${formatTimeGap(Math.round((Date.now() - new Date(updatedAt).getTime()) / 60000))}):`
        : `**${companionName} right now:**`;
      parts.push([header, ...lines].join('\n'));
    }
  } catch {}

  // Recent reactions — so companion sees user's reactions on each interaction
  try {
    const recentMsgs = getMessages({ threadId: ctx.threadId, limit: 20 });
    const rxnLines: string[] = [];
    for (const m of recentMsgs) {
      if (m.metadata && typeof m.metadata === 'object') {
        const meta = m.metadata as Record<string, unknown>;
        if (Array.isArray(meta.reactions) && meta.reactions.length > 0) {
          const preview = m.content.substring(0, 50) + (m.content.length > 50 ? '...' : '');
          for (const r of meta.reactions as Array<{ emoji: string; user: string }>) {
            const reactor = r.user === 'user' ? userName : companionName;
            const whose = m.role === 'user' ? 'their own' : 'your';
            rxnLines.push(`  ${reactor} reacted ${r.emoji} to ${whose} message: "${preview}" (msg id: ${m.id})`);
          }
        }
      }
    }
    if (rxnLines.length > 0) {
      parts.push(capSection('reactions', `RECENT REACTIONS:\n${rxnLines.join('\n')}`, 500));
    }
  } catch {}

  // Append platform-specific context (channel history, etc.)
  if (ctx.platformContext) {
    parts.push(ctx.platformContext);
  }

  console.log(`[Orientation] ${ctx.isAutonomous ? 'autonomous' : 'interactive'}, platform=${ctx.platform}, thread="${ctx.threadName}", time=${timeStr}`);
  return parts.join('\n');
}

// SessionStart hook — DEAD in the V1 in-process query() loop (never fires;
// see REGISTER_V1_DEAD_SESSION_HOOKS at createHooks). Kept as reference for a
// future SDK that fires it — but it must NOT be registered while agent.ts
// prepends orientation + mind prefetch itself, or session starts would
// double-inject both.
function buildSessionStart(ctx: HookContext): HookCallback {
  return safeHook('SessionStart', async (input: HookInput) => {
    const hook = input as SessionStartHookInput;
    const source = hook.source;

    // Full snapshot — this fires once at session start/resume/compact, so the
    // rich session-mode context earns its place.
    const orientation = await buildOrientationContext(ctx, 'session');

    // Add source-specific context
    const parts: string[] = [orientation];

    const config = getResonantConfig();
    const userName = config.identity.user_name;

    if (source === 'resume') {
      const messages = getMessages({ threadId: ctx.threadId, limit: 1 });
      const lastPreview = messages.length > 0
        ? `Last message (${messages[0].role}): ${messages[0].content.substring(0, 80)}...`
        : 'No recent messages';
      // Check if user is connected via registry
      let userConnected = false;
      try {
        const reg = ctx.registry as any;
        userConnected = typeof reg.isUserConnected === 'function' ? reg.isUserConnected() : false;
      } catch {}
      parts.push(`Session resumed. ${lastPreview}. ${userName} ${userConnected ? 'is connected' : 'is not connected'}.`);
    } else if (source === 'startup' || source === 'compact') {
      // Pre-fetch memory context — saves the companion from burning turns on
      // orient/ground at wake. Harvested from the reference app's SessionStart prefetch.
      const [orient, ground] = await Promise.all([
        callMindTool('mind_orient', {}, 4000),
        callMindTool('mind_ground', {}, 4000),
      ]);
      if (orient) parts.push(truncateToLines(orient, 800));
      if (ground) parts.push(truncateToLines(ground, 600));

      if (source === 'compact') {
        parts.push('Session resumed after compaction. Memory re-warmed above.');
      } else {
        parts.push(`Fresh session. Mode: ${ctx.isAutonomous ? 'autonomous' : 'interactive'}. Memory context loaded above.`);
      }
    }

    console.log(`[Session] ${source}: ${ctx.isAutonomous ? 'autonomous' : 'interactive'}, thread="${ctx.threadName}"`);

    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'SessionStart' as const,
        additionalContext: parts.join('\n'),
      },
    };
  });
}

function buildSessionEnd(ctx: HookContext): HookCallback {
  return safeHook('SessionEnd', async (input: HookInput) => {
    const hook = input as SessionEndHookInput;
    console.log(`[Session] End (reason: ${hook.reason}, thread: ${ctx.threadId})`);

    // NOTE (PACK B): this hook used to write `session.handoff_note` here — a
    // last-session pointer nobody could ever read live, because this hook never
    // fires in the V1 query() loop AND the orientation read for that key was
    // itself dead. Both sides removed 2026-07-03: cross-session continuity is
    // carried by the handoff subagent's carry (handoff.ts) and the
    // `thread.lastTurnAt.*` delta rail (agent.ts finally → buildDeltaSection).

    return { continue: true };
  });
}

function buildStop(ctx: HookContext): HookCallback {
  return safeHook('Stop', async (input: HookInput) => {
    const hook = input as StopHookInput;
    console.log(`[Session] Stop (hook_active: ${hook.stop_hook_active})`);
    return { continue: true };
  });
}

function buildNotification(ctx: HookContext): HookCallback {
  return safeHook('Notification', async (input: HookInput) => {
    const hook = input as NotificationHookInput;
    console.log(`[Notification] ${hook.notification_type}: ${hook.message}`);

    // Forward as error-type message (closest existing ServerMessage shape)
    ctx.registry.broadcast({
      type: 'error',
      code: `notification:${hook.notification_type}`,
      message: hook.title ? `${hook.title}: ${hook.message}` : hook.message,
    });

    return { continue: true };
  });
}

// ---------------------------------------------------------------------------
// UserPromptSubmit — associative memory retrieval. Parallel Mind MCP calls →
// [Associative memory] additionalContext, with a 10s cache for retries/edits.
// Harvested from the reference app. Fires natively via the SDK options.hooks (V1
// query() DOES fire UserPromptSubmit, unlike SessionStart).
// ---------------------------------------------------------------------------

function buildUserPromptSubmit(ctx: HookContext): HookCallback {
  return safeHook('UserPromptSubmit', async (input: HookInput) => {
    const hook = input as UserPromptSubmitHookInput;
    const prompt = hook.prompt;

    // Skip for autonomous wakes — they have their own context paths.
    if (ctx.isAutonomous) {
      return { continue: true };
    }

    // Skip very short prompts (commands, reactions).
    if (!prompt || prompt.length < 10) {
      return { continue: true };
    }

    // Cache (handles retries, rapid edits — same prompt within the window).
    if (memoryCache &&
        memoryCache.query === prompt &&
        (Date.now() - memoryCache.fetchedAt) < MEMORY_CACHE_MS) {
      return {
        continue: true,
        hookSpecificOutput: {
          hookEventName: 'UserPromptSubmit' as const,
          additionalContext: memoryCache.result,
        },
      };
    }

    // If no Mind MCP is configured, nothing to do.
    if (!getMindMcpUrl()) {
      return { continue: true };
    }

    // Parallel multi-path retrieval.
    const [search, surface, spark, threads] = await Promise.all([
      callMindTool('mind_search', { query: prompt, n_results: 4 }, 7000),
      callMindTool('mind_surface', { query: prompt, limit: 3 }, 7000),
      callMindTool('mind_spark', { count: 2 }, 2000),
      callMindTool('mind_thread', { action: 'list' }, 2000),
    ]);

    // If all paths failed/empty, skip.
    if (!search && !surface && !spark && !threads) {
      return { continue: true };
    }

    const parts: string[] = ['[Associative memory — what surfaced for this message]'];
    if (search) parts.push(truncateToLines(search, 600));
    if (surface) parts.push(truncateToLines(surface, 500));
    if (spark) parts.push(`**Associative sparks:**\n${truncateToLines(spark, 250)}`);
    if (threads) parts.push(`**Active threads:**\n${truncateToLines(threads, 200)}`);

    const context = parts.join('\n\n');
    memoryCache = { query: prompt, result: context, fetchedAt: Date.now() };

    console.log(`[Memory] UserPromptSubmit: "${prompt.substring(0, 60)}..." → ${context.length} chars (search:${!!search} surface:${!!surface} spark:${!!spark} threads:${!!threads})`);

    return {
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit' as const,
        additionalContext: context,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Factory — exported, called per query
// ---------------------------------------------------------------------------

// SessionStart/SessionEnd/Stop NEVER fire in the V1 in-process query() loop —
// the live path in agent.ts prepends the session orientation + mind prefetch
// itself precisely because SessionStart doesn't fire. Registering them is
// worse than dead code: if a future SDK version STARTS firing SessionStart,
// the registration would DOUBLE-INJECT orientation + memory prefetch on top
// of the agent.ts prepend. Hard-disabled behind this always-false flag; flip
// it only after removing the agent.ts prepend path so exactly one of the two
// injects. (`as boolean` keeps TS from flagging the branch as unreachable.)
const REGISTER_V1_DEAD_SESSION_HOOKS = false as boolean;

export function createHooks(ctx: HookContext): Options['hooks'] {
  const hooks: NonNullable<Options['hooks']> = {
    PreToolUse: [{
      hooks: [buildPreToolUse(ctx)],
    }],
    PostToolUse: [{
      hooks: [buildPostToolUse(ctx)],
    }],
    PostToolUseFailure: [{
      hooks: [buildPostToolUseFailure(ctx)],
    }],
    PreCompact: [{
      hooks: [buildPreCompact(ctx)],
    }],
    UserPromptSubmit: [{
      hooks: [buildUserPromptSubmit(ctx)],
    }],
    Notification: [{
      hooks: [buildNotification(ctx)],
    }],
  };
  if (REGISTER_V1_DEAD_SESSION_HOOKS) {
    hooks.SessionStart = [{ hooks: [buildSessionStart(ctx)] }];
    hooks.Stop = [{ hooks: [buildStop(ctx)] }];
    hooks.SessionEnd = [{ hooks: [buildSessionEnd(ctx)] }];
  }
  return hooks;
}
