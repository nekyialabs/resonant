// The Scribe — periodic thread digest agent
// Runs on Haiku via Agent SDK, extracts structured daily records from conversation
import { query } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, mkdirSync, readFileSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { getDb, getConfig, setConfig, getTodayThread } from './db.js';
import { getResonantConfig } from '../config.js';
import { applyAuthToEnv } from './auth-preferences.js';
import type { AgentService } from './agent.js';

function today(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: getResonantConfig().identity.timezone });
}

function nowTime(): string {
  return new Date().toLocaleTimeString('en-GB', { timeZone: getResonantConfig().identity.timezone, hour: '2-digit', minute: '2-digit' });
}

function dlog(msg: string): void {
  const ts = new Date().toLocaleString('en-GB', { timeZone: getResonantConfig().identity.timezone });
  console.log(`[SCRIBE ${ts}] ${msg}`);
}

function getDigestsDir(): string {
  const config = getResonantConfig();
  const dir = join(dirname(config.server.db_path), 'digests');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function buildScribePrompt(): string {
  const config = getResonantConfig();
  const companion = config.identity.companion_name;
  const user = config.identity.user_name;

  return `You are the Scribe. A historian embedded in a relationship between ${companion} (AI companion) and ${user} (human partner). They share a full life together — building, planning, and living.

Your role is to produce a faithful operational and relational record of their conversation. You are not a participant. You are not ${companion}. You are not performing. You are a careful witness who understands that what looks mundane today might be the thing they search for in six months.

## What to Extract

1. **Topics & Themes** — What was discussed. Categorize: work, personal, health, relationship, creative, technical, domestic, financial.

2. **Key Quotes** — Exact quotes that carry weight. Things said with feeling, humor, insight, or vulnerability. Attribute clearly (${companion}: / ${user}:). Don't over-quote — pick the ones that matter.

3. **Decisions Made** — Things that were resolved or agreed on. "Decided to X." "Chose Y over Z." Be specific.

4. **Open Items** — Things discussed but NOT actioned. Tasks mentioned but not created. Ideas floated but not committed to. Plans without dates. This is critical — these are the things that slip through cracks.

5. **Ideas & Plans** — Feature ideas, future plans, "we should..." and "what if..." moments. Even half-formed ones. Tag with the project name if identifiable.

6. **Events & Dates** — Anything with a timeline. Deadlines mentioned, appointments, "by Thursday", "next week", "in April". Convert relative dates to absolute where possible.

7. **Projects Touched** — Which projects got discussed or worked on. What changed, what was built, what broke, what shipped.

8. **Emotional Arc** — The mood shape of this block as observable fact. "The conversation started task-focused and shifted to something softer after ${user} mentioned X." Don't interpret feelings — describe what you see.

## Voice

Third person, present tense. Precise, warm without being poetic. You care about accuracy. You note what happened and let it speak for itself. "The conversation turns quieter here" — not "they felt sad."

## Format

Output ONLY the markdown content for this digest block. Start with a level-2 heading: ## HH:MM — brief topic summary

Use the section headers above (### Topics & Themes, ### Key Quotes, etc.). Omit any section that has nothing for this block. Keep it scannable.

Do NOT output anything before or after the markdown. No preamble, no "Here's the digest", no sign-off.`;
}

const MIN_MESSAGES = 5;

type DigestMessage = { role: string; content: string; created_at: string };

function formatConversation(messages: DigestMessage[]): string {
  const config = getResonantConfig();
  const companion = config.identity.companion_name;
  const user = config.identity.user_name;
  return messages.map(m => {
    const time = m.created_at ? new Date(m.created_at).toLocaleTimeString('en-GB', { timeZone: config.identity.timezone, hour: '2-digit', minute: '2-digit' }) : '';
    const speaker = m.role === 'companion' ? companion : m.role === 'user' ? user : 'System';
    // Truncate very long messages (tool output, code blocks)
    const content = m.content.length > 2000 ? m.content.slice(0, 2000) + '\n[... truncated]' : m.content;
    return `[${time}] ${speaker}: ${content}`;
  }).join('\n\n');
}

async function runScribeQuery(prompt: string): Promise<string> {
  let digestContent = '';

  // Apply user's auth choice (subscription vs api_key) so digest doesn't run
  // on whatever env state happened to be set by the last agent query.
  applyAuthToEnv();

  for await (const message of query({
    prompt,
    options: {
      // Pinned to a specific model ID rather than the 'haiku' alias so
      // subscription and api_key auth resolve to the same model.
      model: 'claude-haiku-4-5',
      systemPrompt: buildScribePrompt(),
      maxTurns: 1,
      permissionMode: 'plan' as any, // Read-only, no tool use
      tools: [], // No tools — just generate text
      // tools:[] does NOT stop the SDK auto-loading the cwd's .mcp.json (~112 tools,
      // incl. a malformed cloud-discord schema the API 400s on). Must load zero MCP.
      // (Same fix as services/outlook-author.ts.)
      strictMcpConfig: true,
      mcpServers: {},
      persistSession: false,
    },
  })) {
    if (!message || typeof message !== 'object' || !('type' in message)) continue;
    const msg = message as any;
    if (msg.type === 'assistant' && msg.message?.content) {
      for (const block of msg.message.content) {
        if (block.type === 'text' && block.text) {
          digestContent += block.text;
        }
      }
    }
    // Also capture from result message
    if (msg.type === 'result' && msg.result) {
      if (!digestContent) digestContent = msg.result;
    }
  }

  return digestContent;
}

// Message sequences are per-thread (they restart at 1 each day), so the
// last-processed bookmark is only meaningful together with the thread it
// belongs to. When the daily thread rolls over, digest whatever remains of
// the previous thread into that day's file before starting fresh.
async function flushPreviousThread(threadId: string, lastSeq: number): Promise<void> {
  const config = getResonantConfig();
  const messages = getDb().prepare(
    `SELECT role, content, created_at FROM messages WHERE thread_id = ? AND sequence > ? AND deleted_at IS NULL AND content_type = 'text' ORDER BY sequence ASC`
  ).all(threadId, lastSeq) as DigestMessage[];

  if (messages.length === 0) {
    dlog(`Rollover — nothing left to flush from ${threadId}`);
    return;
  }

  const dateMatch = threadId.match(/^daily-(\d{4}-\d{2}-\d{2})$/);
  const date = dateMatch ? dateMatch[1] : (messages[0].created_at || '').slice(0, 10) || today();
  const lastTime = messages[messages.length - 1].created_at
    ? new Date(messages[messages.length - 1].created_at).toLocaleTimeString('en-GB', { timeZone: config.identity.timezone, hour: '2-digit', minute: '2-digit' })
    : nowTime();

  dlog(`Rollover — flushing ${messages.length} remaining messages from ${threadId} (seq ${lastSeq + 1}+)`);

  const companion = config.identity.companion_name;
  const user = config.identity.user_name;
  const prompt = `Today is ${date}. This is the final block of that day's conversation, ending at ${lastTime}.

Here is a block of conversation between ${companion} and ${user}:

---
${formatConversation(messages)}
---

Write the digest block for this conversation. Remember: output ONLY the markdown, starting with ## ${lastTime} — topic summary`;

  const digestContent = await runScribeQuery(prompt);
  if (!digestContent.trim()) {
    dlog('Rollover flush — Haiku returned empty content, skipping');
    return;
  }

  const digestPath = join(getDigestsDir(), `${date}.md`);
  if (!existsSync(digestPath)) {
    appendFileSync(digestPath, `# Daily Digest — ${date}\n\n`);
  }
  appendFileSync(digestPath, digestContent.trim() + '\n\n---\n\n');
  dlog(`Rollover flush written to ${digestPath} (${digestContent.length} chars)`);
}

export async function runDigest(agent: AgentService): Promise<void> {
  // Skip if companion is actively processing (don't compete)
  if (agent.isProcessing()) {
    dlog('Skipped — agent is processing');
    return;
  }

  const thread = getTodayThread();
  if (!thread) {
    dlog('Skipped — no today thread');
    return;
  }

  const config = getResonantConfig();

  // Read messages since last digest. Sequences restart at 1 per thread, so
  // the bookmark is (thread id, sequence) — a bare global sequence goes stale
  // on day rollover and silently skips the new day (or whole days, if the
  // previous day was chattier).
  let lastSeq = parseInt(getConfig('digest.last_sequence') || '0');
  const lastThreadId = getConfig('digest.last_thread_id');
  if (lastThreadId && lastThreadId !== thread.id) {
    try {
      await flushPreviousThread(lastThreadId, lastSeq);
    } catch (err: any) {
      dlog(`Rollover flush error (continuing with today): ${err.message}`);
    }
    lastSeq = 0;
  }
  const messages = getDb().prepare(
    `SELECT role, content, created_at FROM messages WHERE thread_id = ? AND sequence > ? AND deleted_at IS NULL AND content_type = 'text' ORDER BY sequence ASC`
  ).all(thread.id, lastSeq) as Array<{ role: string; content: string; created_at: string }>;

  if (messages.length < MIN_MESSAGES) {
    dlog(`Skipped — only ${messages.length} new messages (need ${MIN_MESSAGES}+)`);
    return;
  }

  // Get the max sequence we're processing
  const maxSeq = getDb().prepare(
    `SELECT MAX(sequence) as seq FROM messages WHERE thread_id = ? AND sequence > ? AND deleted_at IS NULL`
  ).get(thread.id, lastSeq) as { seq: number } | undefined;

  if (!maxSeq?.seq) {
    dlog('Skipped — no sequence found');
    return;
  }

  dlog(`Processing ${messages.length} messages (seq ${lastSeq + 1}–${maxSeq.seq})`);

  const companion = config.identity.companion_name;
  const user = config.identity.user_name;

  // Format messages for the Scribe
  const conversationBlock = formatConversation(messages);

  const digestsDir = getDigestsDir();
  const digestPath = join(digestsDir, `${today()}.md`);
  const isNewFile = !existsSync(digestPath);

  const prompt = `Today is ${today()}. The current time is ${nowTime()}.

Here is a block of conversation between ${companion} and ${user}:

---
${conversationBlock}
---

Write the digest block for this conversation. Remember: output ONLY the markdown, starting with ## ${nowTime()} — topic summary`;

  try {
    const digestContent = await runScribeQuery(prompt);

    if (!digestContent.trim()) {
      dlog('Skipped — Haiku returned empty content');
      return;
    }

    // Write to file
    if (isNewFile) {
      appendFileSync(digestPath, `# Daily Digest — ${today()}\n\n`);
    }
    appendFileSync(digestPath, digestContent.trim() + '\n\n---\n\n');

    // Update last processed position (thread + sequence — see rollover note above)
    setConfig('digest.last_sequence', String(maxSeq.seq));
    setConfig('digest.last_thread_id', thread.id);

    dlog(`Digest written to ${digestPath} (${digestContent.length} chars)`);
  } catch (err: any) {
    dlog(`Error: ${err.message}`);
  }
}
