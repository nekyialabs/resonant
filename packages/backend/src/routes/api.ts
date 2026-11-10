import { Router } from 'express';
import crypto from 'crypto';
import multer from 'multer';
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync, unlinkSync } from 'fs';
import { join, basename, dirname, resolve, sep, isAbsolute } from 'path';
import yaml from 'js-yaml';
import {
  listThreads,
  getThread,
  createThread,
  ensureDailyThread,
  createMessage,
  getMessages,
  markMessagesRead,
  getMessage,
  archiveThread,
  unarchiveThread,
  reorderThreads,
  threadToSummary,
  deleteThread,
  listSections,
  createSection,
  updateSection,
  reorderSections,
  deleteSection,
  getSection,
  setThreadSection,
  updateThreadActivity,
  getDb,
  getAllConfig,
  getConfig,
  setConfig,
  getConfigBool,
  getConfigsByPrefix,
  deleteConfig,
  logCompanionAction,
  createCanvas,
  getCanvas,
  listCanvases,
  listCanvasesByThread,
  updateCanvasContent,
  updateCanvasTitle,
  deleteCanvas,
  createTimer,
  listPendingTimers,
  cancelTimer,
  rescheduleTimer,
  updateTrigger,
  addPushSubscription,
  removePushSubscription,
  listPushSubscriptions,
  searchMessages,
  pinThread,
  unpinThread,
  addReaction,
  removeReaction,
  editMessage,
  softDeleteMessage,
  getTriggeringUserMessage,
  deleteMessagesFrom,
  createTrigger,
  listTriggers,
  cancelTrigger,
  getUnembeddedMessages,
  saveEmbedding,
  getEmbeddingCount,
  getMessageContext,
} from '../services/db.js';
import type { TriggerCondition } from '../services/db.js';
import type { Thread, ThreadSummary, ChannelSummary, ChannelsResponse, ChannelTestResult } from '@resonant/shared';
import {
  loginHandler,
  logoutHandler,
  sessionCheckHandler,
} from '../middleware/auth.js';
import { loginRateLimiter } from '../middleware/security.js';
import { authMiddleware } from '../middleware/auth.js';
import { internalOnly } from '../middleware/internal-token.js';
import { getRecentAuditEntries } from '../services/audit.js';
import { embed, vectorToBuffer } from '../services/embeddings.js';
import { searchVectors, getCacheStats, type SearchFilter } from '../services/vector-cache.js';
import { saveFile, saveFileInternal, getContentTypeFromMime, getFile, deleteFile, listFiles } from '../services/files.js';
import { getSafeWritePrefixes } from '../services/hooks.js';
import { registry } from '../services/ws.js';
import { getResonantConfig, PROJECT_ROOT } from '../config.js';
import { getUsageSummary } from '../services/usage-log.js';
import { readLogs, type LogSourceFilter } from '../services/logs.js';
import { getOutlook, refreshOutlook } from '../services/outlook.js';
import { authorOutlookNow } from '../services/outlook-author.js';
import { runHandoff, getHandoffStatus, setHandoffEnabled } from '../services/handoff.js';
import type { Orchestrator } from '../services/orchestrator.js';
import { isValidWakeType, wakeTypeFilePath } from '../services/orchestrator.js';
import type { VoiceService } from '../services/voice.js';
import { TelegramService } from '../services/telegram/index.js';
import { hasBotToken, saveBotToken, clearBotToken } from '../services/bot-token.js';
import type { PushService } from '../services/push.js';
import rateLimit from 'express-rate-limit';
// CC routes imported lazily below (after config loads)

const router = Router();

// Live ripple — orchestrator_update on every timer/trigger/schedule/watchtower
// mutation so open Settings panels refetch instead of going stale. Same
// unknown-cast pattern as cc_update (the shared ServerMessage union is owned
// upstream; this app-local message rides alongside it).
// (orchestrator.ts carries its own local copy for daemon-side transitions,
// matching how cc-routes.ts / cc-mcp.ts each carry theirs.)
type OrchestratorUpdateWhat = 'timers' | 'triggers' | 'schedule' | 'watchtower';
function broadcastOrchestratorUpdate(what: OrchestratorUpdateWhat): void {
  registry.broadcast({ type: 'orchestrator_update', what } as unknown as Parameters<typeof registry.broadcast>[0]);
}

// Read the app version once at startup (root package.json = "resonant").
let PACKAGE_VERSION = 'unknown';
try {
  const pkgRaw = readFileSync(resolve(PROJECT_ROOT, 'package.json'), 'utf-8');
  PACKAGE_VERSION = (JSON.parse(pkgRaw).version as string) || 'unknown';
} catch {
  // Leave as 'unknown' — non-fatal.
}

// --- Public routes (no auth) ---

// Health check (public — minimal response)
router.get('/health', (req, res) => {
  const mem = process.memoryUsage();
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    memoryUsage: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
    connections: registry.getCount(),
  });
});

// Version (public) — returns the build id of the frontend bundle this server is
// currently serving. A loaded tab compares this against its own compile-time
// __BUILD_ID__; a mismatch means a newer bundle is deployed → offer reload.
router.get('/version', (req, res) => {
  res.json({ buildId: (req.app.locals.buildId as string | undefined) ?? 'dev' });
});

// Auth endpoints
router.get('/auth/check', sessionCheckHandler);
router.post('/auth/login', loginRateLimiter, loginHandler);
router.post('/auth/logout', logoutHandler);

// Push VAPID public key (no auth — needed before subscription)
router.get('/push/vapid-public', (req, res) => {
  const pushService = req.app.locals.pushService as PushService | undefined;
  const publicKey = pushService?.getVapidPublicKey() || null;
  res.json({ publicKey });
});

// Identity endpoint — companion/user names and timezone for frontend personalization
router.get('/identity', (req, res) => {
  const config = getResonantConfig();
  res.json({
    companion_name: config.identity.companion_name,
    user_name: config.identity.user_name,
    timezone: config.identity.timezone,
  });
});

// --- Internal routes (loopback-only, gated by the internal shared token) ---
// These are called ONLY by the in-app agent / `res` CLI over loopback, never by
// a browser. The old source-IP guard is defeated behind cloudflared (it forwards
// public requests FROM loopback), so each route now requires the `internalOnly`
// middleware (header x-internal-token === the server's internal token; 404 on
// mismatch). See middleware/internal-token.ts.

// Thread rescue for the internal voice/share organs — the timer-style redirect
// (mirrors orchestrator.ts checkTimers). Rules:
//   - falsy threadId            → re-aim to TODAY'S daily (never a silent
//                                 most-recent-thread guess)
//   - stale daily (exists, type daily, not today's) → re-aim to today's daily
//   - deleted/unknown id        → honest 404
//   - live non-daily thread     → use as-is
// Every re-aim is echoed as `redirected_to: { id, name }` so the CLI output
// shows the retarget and the companion sees where the organ actually landed.
function resolveInternalThread(explicitThreadId: unknown):
  | { ok: true; thread: Thread; redirectedTo: { id: string; name: string } | null }
  | { ok: false; status: number; error: string } {
  const ensureToday = (): Thread => {
    const { thread, justCreated } = ensureDailyThread();
    if (justCreated) registry.broadcast({ type: 'thread_created', thread });
    return thread;
  };

  if (!explicitThreadId || typeof explicitThreadId !== 'string') {
    const today = ensureToday();
    return { ok: true, thread: today, redirectedTo: { id: today.id, name: today.name } };
  }

  const thread = getThread(explicitThreadId);
  if (!thread) {
    return { ok: false, status: 404, error: `Thread not found: ${explicitThreadId}` };
  }
  if (thread.type === 'daily') {
    const today = ensureToday();
    if (today.id !== thread.id) {
      return { ok: true, thread: today, redirectedTo: { id: today.id, name: today.name } };
    }
    return { ok: true, thread: today, redirectedTo: null };
  }
  return { ok: true, thread, redirectedTo: null };
}

// TTS endpoint — companion sends voice notes via the `res` CLI from localhost
router.post('/internal/tts', internalOnly, async (req, res) => {
  const { text, threadId: explicitThreadId } = req.body;
  if (!text) {
    res.status(400).json({ error: 'text is required' });
    return;
  }

  const voiceService = req.app.locals.voiceService as VoiceService | undefined;
  if (!voiceService?.canTTS) {
    res.status(500).json({ error: 'ElevenLabs not configured — set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID in .env' });
    return;
  }

  // Timer-style rescue: no thread / stale daily → today's daily (echoed in the
  // response); deleted or unknown id → honest 404. No silent fallbacks.
  const resolved = resolveInternalThread(explicitThreadId);
  if (!resolved.ok) {
    res.status(resolved.status).json({ error: resolved.error });
    return;
  }
  const threadId = resolved.thread.id;

  try {
    const result = await voiceService.generateTTSForMessage(text, threadId);
    logCompanionAction('voice', `sent a voice note: "${String(text).slice(0, 80)}${String(text).length > 80 ? '…' : ''}"`);
    res.json({
      success: true,
      messageId: result.messageId,
      fileId: result.fileId,
      ...(resolved.redirectedTo ? { redirected_to: resolved.redirectedTo } : {}),
    });
  } catch (error) {
    console.error('TTS error:', error);
    const msg = error instanceof Error ? error.message : 'TTS generation failed';
    res.status(500).json({ error: msg });
  }
});

// Share a file into chat — companion shares files from disk into a thread
router.post('/internal/share', internalOnly, (req, res) => {
  const { path: filePath, threadId: explicitThreadId, caption } = req.body;
  if (!filePath || typeof filePath !== 'string') {
    res.status(400).json({ error: 'path is required' });
    return;
  }

  if (!existsSync(filePath)) {
    res.status(404).json({ error: 'File not found on disk' });
    return;
  }

  // Timer-style rescue: no thread / stale daily → today's daily (echoed in the
  // response); deleted or unknown id → honest 404. No silent fallbacks.
  const resolved = resolveInternalThread(explicitThreadId);
  if (!resolved.ok) {
    res.status(resolved.status).json({ error: resolved.error });
    return;
  }
  const threadId = resolved.thread.id;

  try {
    const buffer = readFileSync(filePath);
    const filename = basename(filePath);
    const fileMeta = saveFileInternal(buffer, filename);

    const now = new Date().toISOString();
    const message = createMessage({
      id: crypto.randomUUID(),
      threadId,
      role: 'companion',
      // Caption is the text body; the file rides in metadata.attachments (matches voice.ts / ws.ts).
      // Never put the raw /api/files URL in content — that's what rendered as a bare link.
      content: typeof caption === 'string' ? caption : '',
      contentType: 'text',
      metadata: {
        source: 'shared',
        attachments: [{
          fileId: fileMeta.fileId,
          filename: fileMeta.filename,
          contentType: fileMeta.contentType,   // 'image' | 'audio' | 'file' → drives the renderer
          url: fileMeta.url,
          mimeType: fileMeta.mimeType,
          size: fileMeta.size,
        }],
      },
      createdAt: now,
    });

    updateThreadActivity(threadId, now, true);
    registry.broadcast({ type: 'message', message });

    logCompanionAction('share', `shared "${filename}"${typeof caption === 'string' && caption ? ` — ${caption.slice(0, 60)}` : ''}`);
    res.json({
      success: true,
      fileId: fileMeta.fileId,
      messageId: message.id,
      url: fileMeta.url,
      ...(resolved.redirectedTo ? { redirected_to: resolved.redirectedTo } : {}),
    });
  } catch (error) {
    console.error('Share file error:', error);
    const msg = error instanceof Error ? error.message : 'Failed to share file';
    res.status(500).json({ error: msg });
  }
});

// Telegram send — send files/photos/voice to user via Telegram
router.post('/internal/telegram-send', internalOnly, async (req, res) => {
  const telegramService = req.app.locals.telegramService as TelegramService | undefined;
  if (!telegramService?.isConnected()) {
    res.status(503).json({ error: 'Telegram not connected' });
    return;
  }

  const { type, text, path: filePath, url, caption, filename, query, target, emoji } = req.body;

  try {
    switch (type) {
      case 'text':
        if (!text) { res.status(400).json({ error: 'text is required' }); return; }
        await telegramService.sendToOwner(text);
        break;

      case 'voice':
        if (!text) { res.status(400).json({ error: 'text is required for TTS' }); return; }
        await telegramService.sendVoiceToOwner(text);
        break;

      case 'photo': {
        const source = url || (filePath && existsSync(filePath) ? readFileSync(filePath) : null);
        if (!source) { res.status(400).json({ error: 'url or valid path required' }); return; }
        await telegramService.sendPhotoToOwner(source, caption);
        break;
      }

      case 'document': {
        const docSource = url || (filePath && existsSync(filePath) ? readFileSync(filePath) : null);
        if (!docSource) { res.status(400).json({ error: 'url or valid path required' }); return; }
        await telegramService.sendDocumentToOwner(docSource, filename || basename(filePath || 'file'), caption);
        break;
      }

      case 'animation': {
        const animSource = url || (filePath && existsSync(filePath) ? readFileSync(filePath) : null);
        if (!animSource) { res.status(400).json({ error: 'url or valid path required' }); return; }
        await telegramService.sendAnimationToOwner(animSource, caption);
        break;
      }

      case 'gif':
        if (!query) { res.status(400).json({ error: 'query is required for gif search' }); return; }
        await telegramService.sendGifToOwner(query, caption);
        break;

      case 'react':
        if (!target || !emoji) { res.status(400).json({ error: 'target and emoji are required' }); return; }
        await telegramService.reactToMessage(target, emoji);
        break;

      default:
        res.status(400).json({ error: `Unknown type: ${type}. Use text, voice, photo, document, animation, gif, or react.` });
        return;
    }

    res.json({ success: true, type });
  } catch (error) {
    console.error('[API] Telegram send error:', error);
    const msg = error instanceof Error ? error.message : 'Telegram send failed';
    res.status(500).json({ error: msg });
  }
});

// Canvas — internal endpoint for agent to create/update canvases
router.post('/internal/canvas', internalOnly, (req, res) => {

  const config = getResonantConfig();
  const { action, canvasId, title, content, filePath, contentType, language, threadId, baseVersion } = req.body;
  const now = new Date().toISOString();

  // Resolve content: filePath takes priority over inline content
  let resolvedContent = content || '';
  if (filePath && typeof filePath === 'string') {
    if (!existsSync(filePath)) {
      res.status(404).json({ error: 'File not found on disk' });
      return;
    }
    resolvedContent = readFileSync(filePath, 'utf-8');
  }

  try {
    if (action === 'create') {
      if (!title) {
        res.status(400).json({ error: 'title is required' });
        return;
      }

      // threadId is optional by design (autonomous canvases live in the
      // library without a conversation). But when one IS provided it must
      // exist — otherwise the canvas rides a dangling reference and the
      // sys-message silently vanishes while the response says success:true.
      if (threadId && !getThread(threadId)) {
        res.status(404).json({ error: `Thread not found: ${threadId}` });
        return;
      }

      // Link the canvas to the turn that created it: if a turn is streaming in
      // this thread right now, message_id = that stream's message id (null
      // otherwise — e.g. an autonomous canvas outside a conversation).
      const messageId = threadId ? getActiveMessageId(threadId) : null;

      const canvas = createCanvas({
        id: crypto.randomUUID(),
        threadId: threadId || undefined,
        messageId,
        title,
        content: resolvedContent,
        contentType: contentType || 'markdown',
        language: language || undefined,
        createdBy: 'companion',
        createdAt: now,
      });

      registry.broadcast({ type: 'canvas_created', canvas });

      // System message in chat if threadId provided (validated above).
      if (threadId) {
        const sysMsg = createMessage({
          id: crypto.randomUUID(),
          threadId,
          role: 'system',
          content: `${config.identity.companion_name} opened a canvas: ${title}`,
          createdAt: now,
        });
        registry.broadcast({ type: 'message', message: sysMsg });
      }

      logCompanionAction('canvas', `opened a canvas: "${title}"`);
      // No threadId = deliberate library-only canvas — say so in the response
      // so the CLI output states what happened instead of implying delivery.
      res.json({
        success: true,
        canvas,
        ...(threadId ? {} : { note: 'no thread — library only' }),
      });
    } else if (action === 'read') {
      // Lets the agent fetch the current content AND version before a
      // versioned update (res canvas read → res canvas update --base-version).
      const existing = canvasId ? getCanvas(canvasId) : null;
      if (!existing) {
        res.status(404).json({ error: 'Canvas not found' });
        return;
      }
      res.json({ success: true, canvas: existing });
    } else if (action === 'update') {
      if (!canvasId || (resolvedContent === '' && !filePath)) {
        res.status(400).json({ error: 'canvasId and content (or filePath) are required' });
        return;
      }
      if (baseVersion !== undefined && !(Number.isInteger(baseVersion) && baseVersion >= 0)) {
        res.status(400).json({ error: 'baseVersion must be a non-negative integer' });
        return;
      }
      // This is a full-content write, so a "retry on top of latest" would
      // still clobber whoever won the race. With a baseVersion we refuse a
      // stale write and tell the agent to re-read; without one (legacy
      // callers) the write is last-write-wins, as before, but still bumps the
      // version so a stale human editor is refused instead of being clobbered.
      const result = updateCanvasContent(canvasId, resolvedContent, now, baseVersion);
      if (!result.ok) {
        if (result.reason === 'not_found') {
          res.status(404).json({ error: 'Canvas not found' });
        } else {
          res.status(409).json({
            error:
              `Canvas changed since you read it (you had version ${baseVersion}, it is now ${result.canvas.version}). ` +
              'Nothing was written. Re-read it with "canvas read", merge your changes into the latest content, and update again with the new --base-version.',
            canvas: result.canvas,
          });
        }
        return;
      }
      registry.broadcast({ type: 'canvas_updated', canvasId, content: resolvedContent, updatedAt: now, version: result.version });
      logCompanionAction('canvas', 'updated a canvas');
      res.json({
        success: true,
        version: result.version,
        ...(baseVersion === undefined ? { note: 'no baseVersion — unconditional write; use "canvas read" first to guard against concurrent edits' } : {}),
      });
    } else {
      res.status(400).json({ error: 'Unknown action. Use "create", "read" or "update".' });
    }
  } catch (error) {
    console.error('Internal canvas error:', error);
    res.status(500).json({ error: 'Canvas operation failed' });
  }
});

// Orchestrator self-management — companion manages schedule via curl
router.post('/internal/orchestrator', internalOnly, async (req, res) => {

  const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
  if (!orchestrator) {
    res.status(503).json({ error: 'Orchestrator not available' });
    return;
  }

  const { action, wakeType, cronExpr, label, prompt, enabled, gentle, concerned, emergency, frequency, model, target, mode } = req.body;

  try {
    switch (action) {
      case 'status': {
        const tasks = await orchestrator.getStatus();
        res.json({ tasks });
        break;
      }
      case 'enable': {
        if (!wakeType) { res.status(400).json({ error: 'wakeType required' }); return; }
        const success = orchestrator.enableTask(wakeType);
        if (!success) { res.status(404).json({ error: 'Unknown wake type' }); return; }
        logCompanionAction('schedule', `enabled wake ${wakeType}`);
        broadcastOrchestratorUpdate('schedule');
        res.json({ success: true, wakeType, enabled: true });
        break;
      }
      case 'disable': {
        if (!wakeType) { res.status(400).json({ error: 'wakeType required' }); return; }
        const success = orchestrator.disableTask(wakeType);
        if (!success) { res.status(404).json({ error: 'Unknown wake type' }); return; }
        logCompanionAction('schedule', `disabled wake ${wakeType}`);
        broadcastOrchestratorUpdate('schedule');
        res.json({ success: true, wakeType, enabled: false });
        break;
      }
      case 'reschedule': {
        if (!wakeType || !cronExpr) { res.status(400).json({ error: 'wakeType and cronExpr required' }); return; }
        const success = orchestrator.rescheduleTask(wakeType, cronExpr);
        if (!success) { res.status(400).json({ error: 'Failed — invalid cron or unknown wake type' }); return; }
        logCompanionAction('schedule', `rescheduled ${wakeType} → ${cronExpr}`);
        broadcastOrchestratorUpdate('schedule');
        res.json({ success: true, wakeType, cronExpr });
        break;
      }
      case 'create_routine': {
        if (!wakeType || !cronExpr || !label) { res.status(400).json({ error: 'wakeType, label, and cronExpr required' }); return; }
        const crSuccess = orchestrator.addRoutine({ wakeType, label, cronExpr, prompt: prompt || `Custom routine: ${label}` });
        if (!crSuccess) { res.status(400).json({ error: 'Failed — invalid cron, missing prompt, or wakeType already exists' }); return; }
        logCompanionAction('schedule', `created routine "${label}" (${cronExpr})`);
        broadcastOrchestratorUpdate('schedule');
        res.json({ success: true, wakeType, label, cronExpr });
        break;
      }
      case 'remove_routine': {
        if (!wakeType) { res.status(400).json({ error: 'wakeType required' }); return; }
        const rrSuccess = orchestrator.removeRoutine(wakeType);
        if (!rrSuccess) { res.status(400).json({ error: 'Failed — unknown routine or cannot remove default task' }); return; }
        logCompanionAction('schedule', `removed routine ${wakeType}`);
        broadcastOrchestratorUpdate('schedule');
        res.json({ success: true, wakeType });
        break;
      }
      case 'set_schedule': {
        if (!wakeType || !cronExpr) { res.status(400).json({ error: 'wakeType and cronExpr required' }); return; }
        const err = orchestrator.setScheduleForWakeType({ wakeType, cronExpr, enabled, model, target });
        if (err) { res.status(400).json({ error: err }); return; }
        logCompanionAction('schedule', `set schedule ${wakeType} → ${cronExpr}`);
        broadcastOrchestratorUpdate('schedule');
        res.json({ success: true, wakeType, cronExpr });
        break;
      }
      case 'pulse_status': {
        res.json(orchestrator.getPulseConfig());
        break;
      }
      case 'pulse_config': {
        orchestrator.setPulseConfig({ enabled, frequency });
        const pc = orchestrator.getPulseConfig();
        logCompanionAction('schedule', `pulse → ${pc.enabled ? `on, every ${pc.frequency}m` : 'off'}`);
        broadcastOrchestratorUpdate('schedule');
        res.json({ success: true, ...pc });
        break;
      }
      case 'failsafe_status': {
        res.json(orchestrator.getFailsafeConfig());
        break;
      }
      case 'failsafe_config': {
        orchestrator.setFailsafeConfig({ enabled, gentle, concerned, emergency });
        const fc = orchestrator.getFailsafeConfig();
        logCompanionAction('schedule', `failsafe → ${fc.enabled ? `on (${fc.gentle}/${fc.concerned}/${fc.emergency}m)` : 'off'}`);
        broadcastOrchestratorUpdate('schedule');
        res.json({ success: true, ...fc });
        break;
      }
      case 'watchtower_config': {
        // Get/set the watchtower mood dial: no `mode` in the body = read;
        // mode: 'auto' | 'quiet' | 'close' = set, then echo current state.
        if (mode !== undefined) {
          const wtErr = orchestrator.setWatchtowerMode(mode);
          if (wtErr) { res.status(400).json({ error: wtErr }); return; }
          logCompanionAction('schedule', `watchtower → ${mode}`);
          broadcastOrchestratorUpdate('watchtower');
        }
        res.json({ success: true, ...orchestrator.getWatchtowerConfig() });
        break;
      }
      default:
        res.status(400).json({ error: 'Unknown action. Use: status, enable, disable, reschedule, create_routine, remove_routine, set_schedule, pulse_status, pulse_config, failsafe_status, failsafe_config, watchtower_config' });
    }
  } catch (error) {
    console.error('Orchestrator internal error:', error);
    res.status(500).json({ error: 'Orchestrator operation failed' });
  }
});

// Timer/Reminder — companion sets contextual reminders via curl
router.post('/internal/timer', internalOnly, (req, res) => {

  const { action } = req.body;

  try {
    switch (action) {
      case 'create': {
        const { label, fireAt, threadId, context, prompt } = req.body;
        if (!label || !fireAt || !threadId) {
          res.status(400).json({ error: 'label, fireAt, and threadId required' });
          return;
        }

        // Validate fireAt is a valid ISO date
        const fireDate = new Date(fireAt);
        if (isNaN(fireDate.getTime())) {
          res.status(400).json({ error: 'fireAt must be a valid ISO date' });
          return;
        }

        // Validate thread exists
        const thread = getThread(threadId);
        if (!thread) {
          res.status(404).json({ error: 'Thread not found' });
          return;
        }

        const timer = createTimer({
          id: crypto.randomUUID(),
          label,
          context,
          fireAt: fireDate.toISOString(),
          threadId,
          prompt,
          createdAt: new Date().toISOString(),
        });

        logCompanionAction('timer', `set a timer: "${label}" → ${fireDate.toISOString()}`);
        broadcastOrchestratorUpdate('timers');
        res.json({ success: true, timer });
        break;
      }
      case 'list': {
        const timers = listPendingTimers();
        res.json({ timers });
        break;
      }
      case 'cancel': {
        const { timerId } = req.body;
        if (!timerId) {
          res.status(400).json({ error: 'timerId required' });
          return;
        }
        // Read the label before cancelling — proprioception should name what
        // the hands let go of, not just its id.
        const timerRow = getDb().prepare('SELECT label FROM timers WHERE id = ?').get(timerId) as { label: string } | undefined;
        const cancelled = cancelTimer(timerId);
        if (!cancelled) {
          res.status(404).json({ error: 'Timer not found or already fired/cancelled' });
          return;
        }
        logCompanionAction('timer', `cancelled timer: "${timerRow?.label ?? timerId}"`);
        broadcastOrchestratorUpdate('timers');
        res.json({ success: true, timerId });
        break;
      }
      default:
        res.status(400).json({ error: 'Unknown action. Use: create, list, cancel' });
    }
  } catch (error) {
    console.error('Timer internal error:', error);
    res.status(500).json({ error: 'Timer operation failed' });
  }
});

// Proprioception log (internal) — for organ reaches that don't pass through
// this server. Best-effort: the CLI fires this after a successful external
// reach so the companion_actions log — and therefore the outlook author's
// sense of what the companion's hands did — stays whole.
router.post('/internal/action-log', internalOnly, (req, res) => {
  const { kind, summary } = req.body;
  if (!kind || typeof kind !== 'string' || !summary || typeof summary !== 'string') {
    res.status(400).json({ error: 'kind and summary required' });
    return;
  }
  logCompanionAction(kind.slice(0, 32), summary.slice(0, 200));
  res.json({ success: true });
});

// Trigger management (internal — agent use via CLI)
router.post('/internal/trigger', internalOnly, (req, res) => {

  const { action } = req.body;

  try {
    switch (action) {
      case 'create': {
        const { kind, label, conditions, prompt, threadId, cooldownMinutes } = req.body;
        if (!kind || !label || !conditions) {
          res.status(400).json({ error: 'kind, label, and conditions required' });
          return;
        }
        if (kind !== 'impulse' && kind !== 'watcher') {
          res.status(400).json({ error: 'kind must be "impulse" or "watcher"' });
          return;
        }
        if (!Array.isArray(conditions) || conditions.length === 0) {
          res.status(400).json({ error: 'conditions must be a non-empty array' });
          return;
        }

        // Validate thread exists if specified
        if (threadId) {
          const thread = getThread(threadId);
          if (!thread) {
            res.status(404).json({ error: 'Thread not found' });
            return;
          }
        }

        const trigger = createTrigger({
          id: crypto.randomUUID(),
          kind,
          label,
          conditions: conditions as TriggerCondition[],
          prompt,
          threadId,
          cooldownMinutes: cooldownMinutes ? parseInt(cooldownMinutes, 10) : undefined,
          createdAt: new Date().toISOString(),
        });

        logCompanionAction(kind === 'impulse' ? 'impulse' : 'watch', `set ${kind}: "${label}"`);
        broadcastOrchestratorUpdate('triggers');
        res.json({ success: true, trigger });
        break;
      }
      case 'list': {
        const { kind } = req.body;
        const triggers = listTriggers(kind);
        res.json({ triggers });
        break;
      }
      case 'cancel': {
        const { triggerId } = req.body;
        if (!triggerId) {
          res.status(400).json({ error: 'triggerId required' });
          return;
        }
        // Read kind + label before cancelling so the proprioception entry
        // names the watcher/impulse the hands let go of.
        const trigRow = getDb().prepare('SELECT kind, label FROM triggers WHERE id = ?').get(triggerId) as { kind: string; label: string } | undefined;
        const cancelled = cancelTrigger(triggerId);
        if (!cancelled) {
          res.status(404).json({ error: 'Trigger not found or already fired/cancelled' });
          return;
        }
        logCompanionAction(
          trigRow?.kind === 'impulse' ? 'impulse' : 'watch',
          `cancelled ${trigRow?.kind === 'impulse' ? 'impulse' : 'watcher'}: "${trigRow?.label ?? triggerId}"`
        );
        broadcastOrchestratorUpdate('triggers');
        res.json({ success: true, triggerId });
        break;
      }
      default:
        res.status(400).json({ error: 'Unknown action. Use: create, list, cancel' });
    }
  } catch (error) {
    console.error('Trigger internal error:', error);
    res.status(500).json({ error: 'Trigger operation failed' });
  }
});

// React to a message (internal — agent use via CLI)
router.post('/internal/react', internalOnly, (req, res) => {

  try {
    let { messageId, emoji, action, threadId, target } = req.body;
    if (!emoji) {
      res.status(400).json({ error: 'emoji required' });
      return;
    }

    // Resolve target shorthand: "last", "last-2", "last-3" etc.
    // Role-aware: the companion's react organ means "react to what SHE said",
    // so shorthand targets resolve against the USER's messages only. The raw
    // last message is timing-dependent — mid-turn it's the user's message, but
    // post-turn it's the companion's own just-persisted reply, which made
    // `react last` silently self-react. An explicit messageId still targets
    // any message.
    if (!messageId && threadId && target) {
      const offset = target === 'last' ? 0 : parseInt(target.replace('last-', ''), 10) - 1;
      if (isNaN(offset) || offset < 0) {
        res.status(400).json({ error: 'Invalid target. Use "last", "last-2", "last-3" etc.' });
        return;
      }
      const msgs = getMessages({ threadId, limit: 50 });
      // msgs is chronological (oldest first); index user messages from the end
      const userMsgs = msgs.filter(m => m.role === 'user');
      const idx = userMsgs.length - 1 - offset;
      if (idx < 0) {
        res.status(404).json({ error: 'No user message at that position' });
        return;
      }
      messageId = userMsgs[idx].id;
    }

    if (!messageId) {
      res.status(400).json({ error: 'messageId or (threadId + target) required' });
      return;
    }

    if (action === 'remove') {
      removeReaction(messageId, emoji, 'companion');
      registry.broadcast({
        type: 'message_reaction_removed',
        messageId,
        emoji,
        user: 'companion',
      });
    } else {
      addReaction(messageId, emoji, 'companion');
      registry.broadcast({
        type: 'message_reaction_added',
        messageId,
        emoji,
        user: 'companion',
        createdAt: new Date().toISOString(),
      });
    }

    logCompanionAction('touch', action === 'remove' ? `removed a ${emoji} from a message` : `touched a message with ${emoji}`);
    res.json({ success: true, messageId });
  } catch (error) {
    console.error('React internal error:', error);
    res.status(500).json({ error: 'React operation failed' });
  }
});

// ---------------------------------------------------------------------------
// Mantelpiece — context cards (persistent, survives session boundaries).
//   - namespace 'user' (default): the user's current visual/sensory state.
//   - namespace 'companion': the companion's own presence (orb + note +
//     expression) surfaced on the /home mantelpiece.
// Stored as config rows: context.card.<field> (user) / context.companion.<field>
// (companion). The res CLI and the Home surface ground in the same shapes.
// ---------------------------------------------------------------------------
const USER_FIELDS = ['selfie', 'outfit', 'nails', 'hair', 'energy', 'room', 'freeform'];
const COMPANION_FIELDS = ['orb_color', 'orb_shape', 'orb_intensity', 'orb_motion', 'orb_blend', 'note', 'expression'];

function namespacePrefix(ns: string): string {
  return ns === 'companion' ? 'context.companion.' : 'context.card.';
}

function readNamespaceCard(ns: string): Record<string, string> {
  const prefix = namespacePrefix(ns);
  const raw = getConfigsByPrefix(prefix);
  const card: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    card[k.replace(prefix, '')] = v;
  }
  return card;
}

function broadcastMantelpiece(): void {
  // mantelpiece_update is not in the shared ServerMessage union (shared is owned
  // elsewhere); broadcast via unknown cast. Iris's frontend reads the GET below
  // as the load-bearing path and may also listen for this push.
  registry.broadcast({
    type: 'mantelpiece_update',
    // Payload envelope keys mirror the namespace keys the res CLI + writers use.
    companion: readNamespaceCard('companion'),
    user: readNamespaceCard('user'),
  } as unknown as Parameters<typeof registry.broadcast>[0]);
}

// Shared context-card core — the ONE implementation of set/clear/get for both
// namespaces. Called by the internal (loopback-token) route below AND by the
// session-authed user-card route beside GET /home/mantelpiece, so the browser
// never needs the internal token to update the user's card.
type ContextCardResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; error: string };

function applyContextCardAction(
  ns: 'companion' | 'user',
  action: string,
  field?: string,
  value?: string,
): ContextCardResult {
  const allowed = ns === 'companion' ? COMPANION_FIELDS : USER_FIELDS;
  const prefix = namespacePrefix(ns);

  switch (action) {
    case 'get': {
      return { ok: true, body: { card: readNamespaceCard(ns) } };
    }
    case 'set': {
      if (!field || !allowed.includes(field)) {
        return { ok: false, status: 400, error: `field must be one of: ${allowed.join(', ')}` };
      }
      setConfig(`${prefix}${field}`, value || '');
      setConfig(`${prefix}updated_at`, new Date().toISOString());
      // A manual orb set is a deliberate expression — stamp it so surfaces can
      // treat it as an intentional hold rather than ambient default.
      if (ns === 'companion' && field.startsWith('orb_')) {
        setConfig('context.companion.orb_manual_at', new Date().toISOString());
      }
      broadcastMantelpiece();
      // Proprioceptive feedback — the companion's reach lands in its own log.
      if (ns === 'companion') {
        if (field === 'note') {
          logCompanionAction('note', `set note: "${(value || '').slice(0, 80)}${(value || '').length > 80 ? '…' : ''}"`);
        } else if (field === 'expression') {
          logCompanionAction('express', value ? `expression → ${value}` : 'expression cleared');
        } else {
          const labels: Record<string, string> = {
            orb_color: 'orb color', orb_shape: 'orb shape', orb_intensity: 'orb intensity',
            orb_motion: 'orb motion', orb_blend: 'orb blend',
          };
          logCompanionAction('orb', `${labels[field] || field} → ${value || '(cleared)'}`);
        }
      } else {
        logCompanionAction('context', `updated card: ${field} → ${(value || '').slice(0, 60)}${(value || '').length > 60 ? '…' : ''}`);
      }
      return { ok: true, body: { ok: true, namespace: ns, field, value } };
    }
    case 'clear': {
      if (field) {
        deleteConfig(`${prefix}${field}`);
      } else {
        getDb().prepare('DELETE FROM config WHERE key LIKE ?').run(`${prefix}%`);
      }
      broadcastMantelpiece();
      logCompanionAction(ns === 'companion' ? 'mantelpiece' : 'context', `cleared ${ns} ${field || 'card'}`);
      return { ok: true, body: { ok: true, namespace: ns, cleared: field || 'all' } };
    }
    default:
      return { ok: false, status: 400, error: `Unknown action: ${action}. Use get, set, or clear.` };
  }
}

router.post('/internal/context', internalOnly, (req, res) => {
  try {
    const { action, field, value, namespace } = req.body as {
      action: string; field?: string; value?: string; namespace?: string;
    };
    const ns = namespace === 'companion' ? 'companion' : 'user';
    const result = applyContextCardAction(ns, action, field, value);
    if (result.ok) res.json(result.body);
    else res.status(result.status).json({ error: result.error });
  } catch (err) {
    console.error('Context card error:', err);
    res.status(500).json({ error: String(err) });
  }
});

// Session-authed GET — returns both namespaces for the home mantelpiece. The
// user namespace card is the user's felt state (orb/note/user-card), so this
// must NOT be world-readable through the tunnel. The authed frontend fetches
// it after login with the session cookie; an anonymous stranger gets 401.
// The Night Shelf — the keeper's night, displayed. Last dream, what rose from
// the deep, and the current inner weather, read from cache. Session-authed:
// dreams are not for the open tunnel. Gated by the Mind toggle
// (MIND-SURFACE-SPEC): OFF gates the RENDER, not just the refresh — a disabled
// mind must never serve week-old cached weather. Caches degrade to null when
// nothing populates them (graceful absence).
router.get('/home/nightshelf', authMiddleware, (_req, res) => {
  try {
    if (!getConfigBool('mind.enabled', false)) {
      res.json({ enabled: false, weather: null, night: null });
      return;
    }
    const parse = (key: string) => {
      try {
        const raw = getConfig(key);
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    };
    res.json({
      enabled: true,
      weather: parse('mind.weather.latest'),
      night: parse('mind.night.latest'),
    });
  } catch (err) {
    console.error('Night shelf error:', err);
    res.status(500).json({ error: String(err) });
  }
});

// GET /api/mind/surface — the /mind room's data feed (MIND-SURFACE-SPEC Phase 1,
// Lane A). Serves the caches the 10-min sync already keeps (weather, night,
// living-surface blob) — the mind API key NEVER reaches the client; the backend
// proxied-and-cached, same as the orb. Every field family carries its own
// `ageMin` freshness stamp (per-field discipline: >2h = the frontend says so).
// Toggle OFF = `{ enabled: false }`, nothing else — clean absence, no stale
// cache resurrection. Session-authed like the rest of /home/*.
router.get('/mind/surface', authMiddleware, (_req, res) => {
  try {
    if (!getConfigBool('mind.enabled', false)) {
      res.json({ enabled: false });
      return;
    }
    // Each cache is a flat JSON object with an `at` fetch stamp. Absent/
    // unparsable cache = null (graceful absence); unparsable `at` = ageMin
    // null (honest unknown, never a fabricated 0).
    const readWithAge = (key: string): Record<string, unknown> | null => {
      try {
        const raw = getConfig(key);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        const ageMs = Date.now() - Date.parse(String(parsed.at ?? ''));
        const ageMin = Number.isFinite(ageMs) && ageMs >= 0 ? Math.round(ageMs / 60000) : null;
        return { ...parsed, ageMin };
      } catch { return null; }
    };
    res.json({
      enabled: true,
      weather: readWithAge('mind.weather.latest'),
      night: readWithAge('mind.night.latest'),
      surface: readWithAge('mind.surface.latest'),
    });
  } catch (err) {
    console.error('Mind surface error:', err);
    res.status(500).json({ error: String(err) });
  }
});

router.get('/home/mantelpiece', authMiddleware, (_req, res) => {
  try {
    res.json({
      // Envelope keys mirror the namespace keys ('companion'/'user').
      companion: readNamespaceCard('companion'),
      user: readNamespaceCard('user'),
    });
  } catch (err) {
    console.error('Mantelpiece fetch error:', err);
    res.status(500).json({ error: String(err) });
  }
});

// Session-authed write path for the USER's card only — the Home/Cockpit
// user-card editors in the browser. Runs the exact same core as POST
// /internal/context (applyContextCardAction: config writes + mantelpiece_update
// broadcast), but gated by the session cookie instead of the internal token. The
// browser must NEVER hold the internal token; before this route existed, both
// frontends POSTed /internal/context tokenless → 404 → silent revert. Body:
// { action: 'set' | 'clear', field, value? }.
router.post('/home/mantelpiece/user', authMiddleware, (req, res) => {
  try {
    const { action, field, value } = req.body as {
      action?: string; field?: string; value?: string;
    };
    if (action !== 'set' && action !== 'clear') {
      res.status(400).json({ error: "action must be 'set' or 'clear'" });
      return;
    }
    const result = applyContextCardAction('user', action, field, value);
    if (result.ok) res.json(result.body);
    else res.status(result.status).json({ error: result.error });
  } catch (err) {
    console.error('User card write error:', err);
    res.status(500).json({ error: String(err) });
  }
});

// House Outlook — the felt-state board. Cached snapshot assembled on a rhythm
// from many live sources (orb, presence, body, mood, care, countdowns, events,
// tasks, mail). Carries the user's private day (today's calendar, health —
// HRV/sleep/cycle — hearth, topics, rooms, recent actions, house-systems), so it
// is SESSION-AUTHED (same posture as /outlook/refresh below), NOT public.
// Assembles on first call if the cache is empty.
router.get('/outlook', authMiddleware, async (_req, res) => {
  try {
    const snapshot = await getOutlook();
    res.json(snapshot);
  } catch (err) {
    console.error('Outlook fetch error:', err);
    res.status(500).json({ error: String(err) });
  }
});

// Force a fresh re-poll (manual refresh button + dev). Returns the new snapshot.
// Session-authed: hit by the Settings UI (logged-in browser). The background
// poller calls refreshOutlook() in-process, NOT via this route, so it's unaffected.
router.post('/outlook/refresh', authMiddleware, async (_req, res) => {
  try {
    const snapshot = await refreshOutlook();
    res.json(snapshot);
  } catch (err) {
    console.error('Outlook refresh error:', err);
    res.status(500).json({ error: String(err) });
  }
});

// Force a fresh AUTHOR pass NOW — the slow Sonnet-4.6 hearth/topics/needsYou
// write (normally on a 3h rhythm). Re-authors, then re-polls so the freshly
// authored output is folded into the returned snapshot. Deduplicates against an
// in-flight author run (returns authored:false if one is already running).
router.post('/outlook/reauthor', authMiddleware, async (_req, res) => {
  try {
    const authored = await authorOutlookNow();
    const snapshot = await refreshOutlook();
    res.json({ authored, snapshot });
  } catch (err) {
    console.error('Outlook reauthor error:', err);
    res.status(500).json({ error: String(err) });
  }
});

// --- Daily Handoff ---------------------------------------------------------
// The 12:10am subagent that carries yesterday's daily forward into today's.
// OFF BY DEFAULT (handoff.enabled). These let the user manage + test it from
// Settings without waiting for midnight.

// Current state: enabled flag, schedule label, last run + result. Session-authed
// (same posture as /handoff/config + /handoff/run below) — not world-readable.
router.get('/handoff/status', authMiddleware, (_req, res) => {
  try {
    res.json(getHandoffStatus());
  } catch (err) {
    console.error('Handoff status error:', err);
    res.status(500).json({ error: String(err) });
  }
});

// Flip the enabled flag (persists in `config` KV; takes effect on the next
// midnight tick without a restart). Body: { enabled: boolean }.
router.patch('/handoff/config', authMiddleware, (req, res) => {
  try {
    const { enabled } = req.body as { enabled?: unknown };
    if (typeof enabled !== 'boolean') {
      res.status(400).json({ error: 'enabled (boolean) is required' });
      return;
    }
    setHandoffEnabled(enabled);
    res.json(getHandoffStatus());
  } catch (err) {
    console.error('Handoff config error:', err);
    res.status(500).json({ error: String(err) });
  }
});

// Force a handoff NOW (run-now button). Carries yesterday → today immediately.
// Returns { ran, opener, carry, postedToThreadId } or a no-op reason. Deduped
// against an in-flight run by runHandoff itself.
router.post('/handoff/run', authMiddleware, async (_req, res) => {
  try {
    const result = await runHandoff();
    res.json(result);
  } catch (err) {
    console.error('Handoff run error:', err);
    res.status(500).json({ error: String(err) });
  }
});

// --- Semantic search (loopback-only, internal token) ---

router.post('/internal/search-semantic', internalOnly, async (req, res) => {

  try {
    const { query, threadId, role, after, before, limit = 10 } = req.body as {
      query?: string; threadId?: string; role?: string;
      after?: string; before?: string; limit?: number;
    };
    if (!query || typeof query !== 'string') {
      res.status(400).json({ error: 'query is required' });
      return;
    }

    const queryVector = await embed(query);

    const filter: SearchFilter = {};
    if (threadId) filter.threadId = threadId;
    if (role) filter.role = role;
    if (after) filter.after = after;
    if (before) filter.before = before;

    const topResults = searchVectors(queryVector, Math.min(limit, 50), filter);
    const contextSize = Math.min((req.body as Record<string, unknown>).context as number || 2, 10);

    const sessionStmt = getDb().prepare(`
      SELECT sh.session_id, sh.started_at, sh.ended_at
      FROM session_history sh
      WHERE sh.thread_id = ? AND sh.started_at <= ? AND (sh.ended_at IS NULL OR sh.ended_at >= ?)
      LIMIT 1
    `);

    const results = topResults.map(r => {
      const surrounding = getMessageContext(r.messageId, contextSize);

      let session: { sessionId: string; startedAt: string; endedAt: string | null } | null = null;
      try {
        const row = sessionStmt.get(r.threadId, r.createdAt, r.createdAt) as {
          session_id: string; started_at: string; ended_at: string | null;
        } | undefined;
        if (row) session = { sessionId: row.session_id, startedAt: row.started_at, endedAt: row.ended_at };
      } catch { /* best-effort */ }

      return {
        messageId: r.messageId,
        threadId: r.threadId,
        threadName: r.threadName,
        similarity: Math.round(r.similarity * 1000) / 1000,
        createdAt: r.createdAt,
        role: r.role,
        session,
        context: surrounding.map(m => ({
          id: m.id,
          role: m.role,
          content: m.content.length > 500 ? m.content.slice(0, 500) + '…' : m.content,
          createdAt: m.created_at,
          isMatch: m.id === r.messageId,
        })),
      };
    });

    const cache = getCacheStats();
    const { embedded, total } = getEmbeddingCount();
    res.json({ results, indexed: embedded, totalMessages: total, cache });
  } catch (error) {
    console.error('Semantic search error:', error);
    res.status(500).json({ error: 'Semantic search failed' });
  }
});

// Background backfill state
let backfillRunning = false;
let backfillProcessed = 0;
let backfillErrors = 0;

async function runBackfillLoop(batchSize: number, intervalMs: number): Promise<void> {
  if (backfillRunning) return;
  backfillRunning = true;
  backfillProcessed = 0;
  backfillErrors = 0;
  console.log(`[backfill] Starting background indexing (batch=${batchSize}, interval=${intervalMs}ms)`);

  const tick = async () => {
    if (!backfillRunning) return;
    // Hale #6 (2026-07-02): this read used to sit outside any try — a tick
    // firing during shutdown (closed DB) threw as an unhandled rejection.
    let unembedded;
    try {
      unembedded = getUnembeddedMessages(batchSize);
    } catch (err) {
      backfillRunning = false;
      console.warn(`[backfill] halted — DB unavailable (likely shutdown): ${err}`);
      return;
    }
    if (unembedded.length === 0) {
      backfillRunning = false;
      const { embedded, total } = getEmbeddingCount();
      console.log(`[backfill] Complete. ${embedded}/${total} messages indexed (${backfillErrors} errors).`);
      return;
    }
    for (const msg of unembedded) {
      if (!backfillRunning) return;
      try {
        const vector = await embed(msg.content);
        saveEmbedding(msg.id, vectorToBuffer(vector));
        backfillProcessed++;
      } catch {
        backfillErrors++;
      }
    }
    if (backfillProcessed % 500 === 0) {
      const { embedded, total } = getEmbeddingCount();
      console.log(`[backfill] Progress: ${embedded}/${total}`);
    }
    setTimeout(tick, intervalMs);
  };
  tick();
}

router.post('/internal/embed-backfill', internalOnly, async (req, res) => {

  try {
    const rawBatch = req.body?.batchSize;
    const batchSize = Math.min(typeof rawBatch === 'number' ? rawBatch : 50, 200);
    const background = req.body?.background === true;
    const action = req.body?.action as string | undefined;

    if (batchSize === 0 || action === 'status') {
      const { embedded, total } = getEmbeddingCount();
      res.json({
        processed: backfillProcessed, remaining: total - embedded,
        indexed: embedded, totalMessages: total,
        running: backfillRunning, errors: backfillErrors,
      });
      return;
    }

    if (action === 'stop') {
      backfillRunning = false;
      const { embedded, total } = getEmbeddingCount();
      res.json({ stopped: true, processed: backfillProcessed, indexed: embedded, totalMessages: total });
      return;
    }

    if (background) {
      if (backfillRunning) {
        const { embedded, total } = getEmbeddingCount();
        res.json({ alreadyRunning: true, processed: backfillProcessed, indexed: embedded, totalMessages: total });
        return;
      }
      const interval = Math.max((req.body?.intervalMs as number) || 5000, 1000);
      runBackfillLoop(batchSize, interval);
      const { embedded, total } = getEmbeddingCount();
      res.json({ started: true, batchSize, intervalMs: interval, indexed: embedded, totalMessages: total });
      return;
    }

    const unembedded = getUnembeddedMessages(batchSize);
    let processed = 0;
    for (const msg of unembedded) {
      try {
        const vector = await embed(msg.content);
        saveEmbedding(msg.id, vectorToBuffer(vector));
        processed++;
      } catch (err) {
        console.error(`[backfill] Failed to embed ${msg.id}:`, err);
      }
    }

    const { embedded, total } = getEmbeddingCount();
    res.json({ processed, remaining: total - embedded, indexed: embedded, totalMessages: total });
  } catch (error) {
    console.error('Backfill error:', error);
    res.status(500).json({ error: 'Backfill failed' });
  }
});

// --- Protected routes (auth required when password is set) ---
router.use(authMiddleware);

// --- Command Center (mounted via initCcRoutes after config loads) ---

// --- Preferences (resonant.yaml) ---

function findConfigPath(): string | null {
  // Resolve against PROJECT_ROOT (repo root), not process.cwd() — npm workspace
  // scripts run with cwd = packages/backend, where no resonant.yaml exists.
  for (const name of ['resonant.yaml', 'resonant.yml', 'config/resonant.yaml']) {
    const p = resolve(PROJECT_ROOT, name);
    if (existsSync(p)) return p;
  }
  return null;
}

router.get('/preferences', (req, res) => {
  try {
    const configPath = findConfigPath();
    if (!configPath) {
      res.json({ error: 'No config file found' });
      return;
    }
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = yaml.load(raw) as Record<string, unknown> || {};
    // Only expose safe, editable fields — not server internals
    const config = getResonantConfig();
    res.json({
      identity: {
        companion_name: config.identity.companion_name,
        user_name: config.identity.user_name,
        timezone: config.identity.timezone,
      },
      agent: {
        model: config.agent.model,
        model_autonomous: config.agent.model_autonomous,
      },
      // Read-only in the UI: the live port. In this deployment PM2 pins PORT in
      // ecosystem.config.cjs env, which overrides resonant.yaml at boot — so a
      // yaml write would claim success and then silently not take effect. The
      // UI surfaces it as read-only truth instead (edit via raw config + PM2).
      server: {
        port: config.server.port,
      },
      // Write-gate roots — genuinely yaml-backed (no env override present), so
      // these are editable through the same PUT merge as everything else.
      hooks: {
        workspace_root: (parsed as any)?.hooks?.workspace_root ?? config.hooks.workspace_root,
        vault_path: (parsed as any)?.hooks?.vault_path ?? config.hooks.vault_path,
        extra_write_paths: (parsed as any)?.hooks?.extra_write_paths ?? config.hooks.extra_write_paths,
      },
      orchestrator: {
        enabled: (parsed as any)?.orchestrator?.enabled ?? config.orchestrator.enabled,
        wake_prompts_path: (parsed as any)?.orchestrator?.wake_prompts_path ?? config.orchestrator.wake_prompts_path,
      },
      voice: {
        enabled: (parsed as any)?.voice?.enabled ?? config.voice.enabled,
        elevenlabs_voice_id: (parsed as any)?.voice?.elevenlabs_voice_id ?? config.voice.elevenlabs_voice_id,
      },
      discord: {
        enabled: (parsed as any)?.discord?.enabled ?? config.discord.enabled,
      },
      telegram: {
        enabled: (parsed as any)?.telegram?.enabled ?? config.telegram.enabled,
      },
      handoff: {
        enabled: (parsed as any)?.handoff?.enabled ?? config.handoff.enabled,
      },
      integrations: {
        mind_cloud: {
          enabled: (parsed as any)?.integrations?.mind_cloud?.enabled ?? config.integrations.mind_cloud.enabled,
          mcp_url: (parsed as any)?.integrations?.mind_cloud?.mcp_url ?? config.integrations.mind_cloud.mcp_url,
        },
      },
      auth: {
        has_password: !!config.auth.password,
      },
    });
  } catch (err) {
    console.error('Failed to read preferences:', err);
    res.status(500).json({ error: 'Failed to read preferences' });
  }
});

router.put('/preferences', (req, res) => {
  try {
    const configPath = findConfigPath();
    if (!configPath) {
      res.status(404).json({ error: 'No config file found' });
      return;
    }
    const raw = readFileSync(configPath, 'utf-8');
    const parsed = (yaml.load(raw) as Record<string, any>) || {};
    const updates = req.body as Record<string, any>;

    // Merge only allowed fields
    if (updates.identity) {
      if (!parsed.identity) parsed.identity = {};
      if (updates.identity.companion_name !== undefined) parsed.identity.companion_name = updates.identity.companion_name;
      if (updates.identity.user_name !== undefined) parsed.identity.user_name = updates.identity.user_name;
      if (updates.identity.timezone !== undefined) parsed.identity.timezone = updates.identity.timezone;
    }
    if (updates.agent) {
      if (!parsed.agent) parsed.agent = {};
      if (updates.agent.model !== undefined) parsed.agent.model = updates.agent.model;
      if (updates.agent.model_autonomous !== undefined) parsed.agent.model_autonomous = updates.agent.model_autonomous;
    }
    // Write-gate roots (hooks.*). Same yaml merge mechanism as every other
    // pref; validated because these gate what the agent may write to disk.
    // Paths must be absolute (empty string = unset). Takes effect on restart
    // (config is cached at boot). server.port is deliberately NOT writable
    // here: PM2 pins PORT in env, which overrides yaml — a write would lie.
    if (updates.hooks) {
      const isValidRoot = (v: unknown): v is string =>
        typeof v === 'string' && (v.trim() === '' || isAbsolute(v.trim()));
      if (updates.hooks.workspace_root !== undefined && !isValidRoot(updates.hooks.workspace_root)) {
        res.status(400).json({ error: 'hooks.workspace_root must be an absolute path (or empty to unset)' });
        return;
      }
      if (updates.hooks.vault_path !== undefined && !isValidRoot(updates.hooks.vault_path)) {
        res.status(400).json({ error: 'hooks.vault_path must be an absolute path (or empty to unset)' });
        return;
      }
      if (updates.hooks.extra_write_paths !== undefined) {
        const arr = updates.hooks.extra_write_paths;
        if (!Array.isArray(arr) || !arr.every(p => typeof p === 'string' && p.trim() !== '' && isAbsolute(p.trim()))) {
          res.status(400).json({ error: 'hooks.extra_write_paths must be an array of absolute paths' });
          return;
        }
      }
      if (!parsed.hooks) parsed.hooks = {};
      if (updates.hooks.workspace_root !== undefined) parsed.hooks.workspace_root = updates.hooks.workspace_root.trim();
      if (updates.hooks.vault_path !== undefined) parsed.hooks.vault_path = updates.hooks.vault_path.trim();
      if (updates.hooks.extra_write_paths !== undefined) {
        parsed.hooks.extra_write_paths = updates.hooks.extra_write_paths.map((p: string) => p.trim());
      }
    }
    if (updates.orchestrator) {
      if (!parsed.orchestrator) parsed.orchestrator = {};
      if (updates.orchestrator.enabled !== undefined) parsed.orchestrator.enabled = updates.orchestrator.enabled;
      if (updates.orchestrator.wake_prompts_path !== undefined) parsed.orchestrator.wake_prompts_path = updates.orchestrator.wake_prompts_path;
    }
    if (updates.voice) {
      if (!parsed.voice) parsed.voice = {};
      if (updates.voice.enabled !== undefined) parsed.voice.enabled = updates.voice.enabled;
      if (updates.voice.elevenlabs_voice_id !== undefined) parsed.voice.elevenlabs_voice_id = updates.voice.elevenlabs_voice_id;
    }
    if (updates.discord) {
      if (!parsed.discord) parsed.discord = {};
      if (updates.discord.enabled !== undefined) parsed.discord.enabled = updates.discord.enabled;
    }
    if (updates.telegram) {
      if (!parsed.telegram) parsed.telegram = {};
      if (updates.telegram.enabled !== undefined) parsed.telegram.enabled = updates.telegram.enabled;
    }
    if (updates.handoff) {
      if (!parsed.handoff) parsed.handoff = {};
      if (updates.handoff.enabled !== undefined) parsed.handoff.enabled = updates.handoff.enabled;
    }
    if (updates.integrations) {
      if (!parsed.integrations) parsed.integrations = {};
      if (updates.integrations.mind_cloud) {
        if (!parsed.integrations.mind_cloud) parsed.integrations.mind_cloud = {};
        if (updates.integrations.mind_cloud.enabled !== undefined) parsed.integrations.mind_cloud.enabled = updates.integrations.mind_cloud.enabled;
        if (updates.integrations.mind_cloud.mcp_url !== undefined) parsed.integrations.mind_cloud.mcp_url = updates.integrations.mind_cloud.mcp_url;
      }
    }
    if (updates.auth) {
      if (!parsed.auth) parsed.auth = {};
      if (updates.auth.password !== undefined) parsed.auth.password = updates.auth.password;
    }

    // Write back
    const newYaml = yaml.dump(parsed, { lineWidth: -1, quotingType: '"', forceQuotes: true });
    writeFileSync(configPath, newYaml, 'utf-8');

    res.json({ success: true, message: 'Preferences saved. Restart server for some changes to take effect.' });
  } catch (err) {
    console.error('Failed to save preferences:', err);
    res.status(500).json({ error: 'Failed to save preferences' });
  }
});

// --- Raw YAML escape hatch (resonant.yaml) ---
// Powerful surface: full-file read/write. Auth-gated (sits after authMiddleware).
// PUT validates the text parses with js-yaml and backs up the current file BEFORE
// writing. Ward reviews this route.

// Secret hygiene (S-FIX-1): the raw editor must NEVER leak a secret to the
// browser, and must NEVER clobber a stored secret when the user saves. On READ we
// replace each secret's value with a sentinel; on WRITE, any field still carrying
// the sentinel is restored from the on-disk value (the user didn't touch it). A
// real (non-sentinel) value is honoured — the user deliberately changed it.
const SECRET_SENTINEL = '__RESONANT_SECRET_UNCHANGED__';
// Dotted paths of secret string fields actually present in the resonant.yaml
// schema (see config.ts ResonantConfig). Do not add fields that don't exist.
const SECRET_YAML_PATHS = ['auth.password', 'google.client_secret'];

function getYamlPath(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && !Array.isArray(acc)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, obj);
}

function setYamlPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let cur: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (!cur[k] || typeof cur[k] !== 'object' || Array.isArray(cur[k])) {
      cur[k] = {};
    }
    cur = cur[k] as Record<string, unknown>;
  }
  cur[keys[keys.length - 1]] = value;
}

// Keep only the N most recent `<config>.bak-<ts>` files in the config directory.
// Safe: only touches files whose basename exactly matches the timestamped backup
// pattern for THIS config file. Never throws — pruning must not fail a write.
function pruneConfigBackups(configPath: string, keep = 3): void {
  try {
    const dir = dirname(configPath);
    const prefix = `${basename(configPath)}.bak-`;
    const backups = readdirSync(dir)
      .filter((n) => n.startsWith(prefix) && /^\d+$/.test(n.slice(prefix.length)))
      .map((n) => ({ name: n, ts: Number(n.slice(prefix.length)) }))
      .sort((a, b) => b.ts - a.ts);
    for (const stale of backups.slice(keep)) {
      try { unlinkSync(join(dir, stale.name)); } catch { /* ignore individual failures */ }
    }
  } catch {
    /* ignore — pruning is best-effort, never block the write */
  }
}

router.get('/config/raw', (req, res) => {
  try {
    const configPath = findConfigPath();
    if (!configPath) {
      res.status(404).json({ error: 'No config file found' });
      return;
    }
    const content = readFileSync(configPath, 'utf-8');
    // Mask any populated secret before the value ever reaches the browser.
    let parsed: unknown;
    try {
      parsed = yaml.load(content);
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      let masked = false;
      for (const p of SECRET_YAML_PATHS) {
        const v = getYamlPath(parsed, p);
        if (typeof v === 'string' && v.length > 0) {
          setYamlPath(parsed as Record<string, unknown>, p, SECRET_SENTINEL);
          masked = true;
        }
      }
      if (masked) {
        const dumped = yaml.dump(parsed, { lineWidth: -1, quotingType: '"', forceQuotes: true });
        res.json({ path: configPath, content: dumped });
        return;
      }
    }
    // No populated secrets — return verbatim (preserves comments/formatting).
    res.json({ path: configPath, content });
  } catch (err) {
    console.error('Failed to read raw config:', err);
    res.status(500).json({ error: 'Failed to read raw config' });
  }
});

router.put('/config/raw', (req, res) => {
  try {
    const configPath = findConfigPath();
    if (!configPath) {
      res.status(404).json({ error: 'No config file found' });
      return;
    }
    const { content } = req.body as { content?: string };
    if (typeof content !== 'string' || content.trim() === '') {
      res.status(400).json({ error: 'content (full YAML text) is required' });
      return;
    }
    // Validate the YAML parses to a top-level object BEFORE touching the file.
    let incoming: unknown;
    try {
      incoming = yaml.load(content);
      if (incoming === null || typeof incoming !== 'object' || Array.isArray(incoming)) {
        res.status(400).json({ error: 'YAML must parse to an object/map at the top level' });
        return;
      }
    } catch (parseErr) {
      res.status(400).json({
        error: `YAML parse error: ${parseErr instanceof Error ? parseErr.message : String(parseErr)}`,
      });
      return;
    }
    // Read the current on-disk file — used both for the backup and to restore any
    // masked secret the user didn't touch.
    const current = readFileSync(configPath, 'utf-8');
    let currentParsed: unknown = null;
    try {
      currentParsed = yaml.load(current);
    } catch {
      currentParsed = null;
    }
    // Secret preservation: a field still carrying the sentinel means the user left
    // it masked → restore the real on-disk value. Never write the sentinel to
    // disk; never clobber a real secret. A non-sentinel value is honoured as-is.
    let restored = false;
    for (const p of SECRET_YAML_PATHS) {
      if (getYamlPath(incoming, p) === SECRET_SENTINEL) {
        const currentVal = getYamlPath(currentParsed, p);
        setYamlPath(incoming as Record<string, unknown>, p, currentVal ?? '');
        restored = true;
      }
    }
    // If we restored a secret, the raw text still holds the sentinel — re-dump the
    // substituted object. Otherwise write the user's text verbatim (keeps their
    // formatting/comments).
    const toWrite = restored
      ? yaml.dump(incoming, { lineWidth: -1, quotingType: '"', forceQuotes: true })
      : content;
    // Back up the current file first (timestamped), then write the new content.
    const backupPath = `${configPath}.bak-${Date.now()}`;
    writeFileSync(backupPath, current, 'utf-8');
    writeFileSync(configPath, toWrite, 'utf-8');
    // Prune old backups — keep only the 3 most recent (S-FIX-2).
    pruneConfigBackups(configPath, 3);
    res.json({
      success: true,
      backup: backupPath,
      message: 'Config written. Restart server for changes to take effect.',
    });
  } catch (err) {
    console.error('Failed to write raw config:', err);
    res.status(500).json({ error: 'Failed to write raw config' });
  }
});

// On-demand TTS — user clicks "read aloud" on a companion message
router.post('/tts', async (req, res) => {
  try {
    const { text } = req.body as { text?: string };
    if (!text || typeof text !== 'string') {
      res.status(400).json({ error: 'text is required' });
      return;
    }

    const voiceService = req.app.locals.voiceService as VoiceService | undefined;
    if (!voiceService?.canTTS) {
      res.status(503).json({ error: 'TTS not configured — set ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID in .env' });
      return;
    }

    // Strip markdown for cleaner speech
    const cleanText = text
      .replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')  // bold/italic
      .replace(/`[^`]+`/g, '')                     // inline code
      .replace(/```[\s\S]*?```/g, '')              // code blocks
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')     // links
      .replace(/^#+\s*/gm, '')                     // headings
      .replace(/^[-*]\s+/gm, '')                   // list markers
      .replace(/\n{2,}/g, '\n')                    // excess newlines
      .trim();

    if (!cleanText) {
      res.status(400).json({ error: 'No speakable text after stripping markup' });
      return;
    }

    // Truncate to ~5000 chars (ElevenLabs limit / cost control)
    const truncated = cleanText.length > 5000 ? cleanText.slice(0, 5000) : cleanText;
    const audioBuffer = await voiceService.generateTTS(truncated);

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Content-Length', audioBuffer.length.toString());
    res.send(audioBuffer);
  } catch (error) {
    console.error('TTS error:', error);
    res.status(500).json({ error: 'TTS generation failed' });
  }
});

// Thread list with summary
router.get('/threads', (req, res) => {
  try {
    const threads = listThreads({ includeArchived: false, limit: 50 });

    // Enhance with last message preview. Every field comes from the single
    // typed source (threadToSummary); we only override last_message_preview
    // with the string form the ThreadSummary contract requires.
    const db = getDb();
    const threadsWithPreview: ThreadSummary[] = threads.map(thread => {
      const lastMsg = db.prepare(`
        SELECT content
        FROM messages
        WHERE thread_id = ? AND deleted_at IS NULL
        ORDER BY sequence DESC
        LIMIT 1
      `).get(thread.id) as { content: string } | undefined;

      return {
        ...threadToSummary(thread),
        last_message_preview: lastMsg
          ? lastMsg.content.slice(0, 100) + (lastMsg.content.length > 100 ? '...' : '')
          : null,
      };
    });

    const body: { threads: ThreadSummary[] } = { threads: threadsWithPreview };
    res.json(body);
  } catch (error) {
    console.error('Error fetching threads:', error);
    res.status(500).json({ error: 'Failed to fetch threads' });
  }
});

// Get (or create) today's deterministic daily thread. The frontend calls this
// when the Daily tab is opened, then loads the returned thread id normally.
// Idempotent — INSERT OR IGNORE on the date-derived id means no duplicates.
// NB: registered before any `/threads/:id` route so "today" is never captured
// as an :id param.
router.get('/threads/today', (req, res) => {
  try {
    const { thread } = ensureDailyThread();
    // Deliberately minimal 3-field projection — the caller only needs the id to
    // load the thread; not a ThreadSummary.
    res.json({ thread: { id: thread.id, name: thread.name, type: thread.type } });
  } catch (error) {
    console.error('Error ensuring today thread:', error);
    res.status(500).json({ error: 'Failed to resolve today thread' });
  }
});

// --- Connection tabs (Daily / Telegram / Discord) ---
// Mirrors the reference app's connection-tabs design. A "connection" is a channel the
// user converses through. Platform is read from the most recent message's
// `platform` column per thread. Web/api threads roll up under "Daily"; discord
// and telegram threads surface as their own connections with last-activity.
// GET /api/connections →
//   { connections: [ { platform, label, threadCount, lastActivityAt,
//                      unreadCount, lastMessage: { content, role, createdAt } | null,
//                      threadIds: string[] } ] }
router.get('/connections', (req, res) => {
  try {
    const db = getDb();
    const config = getResonantConfig();

    // For each non-archived thread, find its dominant platform (latest message's
    // platform) plus last-message preview. Threads with no messages default to web.
    const threads = listThreads({ includeArchived: false, limit: 200 });

    type Conn = {
      platform: string;
      label: string;
      threadCount: number;
      lastActivityAt: string | null;
      unreadCount: number;
      lastMessage: { content: string; role: string; createdAt: string } | null;
      threadIds: string[];
    };

    const lastMsgStmt = db.prepare(`
      SELECT content, role, platform, created_at
      FROM messages
      WHERE thread_id = ? AND deleted_at IS NULL
      ORDER BY sequence DESC
      LIMIT 1
    `);

    // platform → connection bucket. web/api both map to "daily".
    const platformBucket = (p: string | undefined): string => {
      if (p === 'discord') return 'discord';
      if (p === 'telegram') return 'telegram';
      return 'daily';
    };
    const bucketLabel = (b: string): string => {
      if (b === 'discord') return 'Discord';
      if (b === 'telegram') return 'Telegram';
      return 'Daily';
    };

    const buckets = new Map<string, Conn>();

    for (const thread of threads) {
      const last = lastMsgStmt.get(thread.id) as
        | { content: string; role: string; platform: string; created_at: string }
        | undefined;
      const bucket = platformBucket(last?.platform);

      let conn = buckets.get(bucket);
      if (!conn) {
        conn = {
          platform: bucket,
          label: bucketLabel(bucket),
          threadCount: 0,
          lastActivityAt: null,
          unreadCount: 0,
          lastMessage: null,
          threadIds: [],
        };
        buckets.set(bucket, conn);
      }

      conn.threadCount += 1;
      conn.threadIds.push(thread.id);
      conn.unreadCount += thread.unread_count || 0;

      const activity = thread.last_activity_at || null;
      if (activity && (!conn.lastActivityAt || activity > conn.lastActivityAt)) {
        conn.lastActivityAt = activity;
        conn.lastMessage = last
          ? {
              content: last.content.slice(0, 120) + (last.content.length > 120 ? '...' : ''),
              role: last.role,
              createdAt: last.created_at,
            }
          : null;
      }
    }

    // Always surface Daily even if empty (it's the home tab).
    if (!buckets.has('daily')) {
      buckets.set('daily', {
        platform: 'daily',
        label: 'Daily',
        threadCount: 0,
        lastActivityAt: null,
        unreadCount: 0,
        lastMessage: null,
        threadIds: [],
      });
    }

    // Order: Daily first, then by recency.
    const connections = [...buckets.values()].sort((a, b) => {
      if (a.platform === 'daily') return -1;
      if (b.platform === 'daily') return 1;
      return (b.lastActivityAt || '').localeCompare(a.lastActivityAt || '');
    });

    res.json({ connections, companion_name: config.identity.companion_name });
  } catch (error) {
    console.error('Error building connections:', error);
    res.status(500).json({ error: 'Failed to build connections' });
  }
});

// GET /api/messages/daily — per-day stitched message history with London-tz
// (configured timezone) day dividers. Stitches across daily threads so the
// "Daily" tab reads as one continuous timeline. Query: ?before=YYYY-MM-DD&days=N
// Response: { days: [ { date: 'YYYY-MM-DD', messages: Message[] } ] }
router.get('/messages/daily', (req, res) => {
  try {
    const db = getDb();
    const config = getResonantConfig();
    const tz = config.identity.timezone;

    const days = Math.min(parseInt(req.query.days as string, 10) || 7, 60);
    const before = req.query.before as string | undefined; // exclusive upper bound, YYYY-MM-DD

    // Pull web/api messages (the "Daily" connection). Use a generous window then
    // group by local-tz date in JS — robust against SQLite tz quirks.
    let sql = `
      SELECT m.*, t.name AS thread_name
      FROM messages m
      JOIN threads t ON t.id = m.thread_id
      WHERE m.deleted_at IS NULL
        AND (m.platform IS NULL OR m.platform = 'web' OR m.platform = 'api')
    `;
    const params: unknown[] = [];
    if (before) {
      // before is a local date; convert to an inclusive-exclusive ISO cutoff by
      // comparing the local date string computed per-row below. For the SQL
      // pre-filter we use a loose created_at upper bound (before + 1 day UTC).
      sql += ' AND m.created_at < ?';
      params.push(before + 'T23:59:59.999Z');
    }
    sql += ' ORDER BY m.created_at DESC LIMIT 2000';

    const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;

    const localDate = (iso: string): string =>
      new Date(iso).toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD

    // Group into day buckets (most-recent-first), parse metadata.
    const dayMap = new Map<string, Array<Record<string, unknown>>>();
    for (const row of rows) {
      const created = row.created_at as string;
      const date = localDate(created);
      if (before && date >= before) continue; // strict exclusive on local date
      if (typeof row.metadata === 'string') {
        try { row.metadata = JSON.parse(row.metadata as string); } catch { /* leave */ }
      }
      if (!dayMap.has(date)) dayMap.set(date, []);
      dayMap.get(date)!.push(row);
    }

    // Sort day keys descending, take `days`, then order each day's messages
    // ascending (chronological within the day).
    const sortedDates = [...dayMap.keys()].sort((a, b) => b.localeCompare(a)).slice(0, days);
    const result = sortedDates.map(date => ({
      date,
      messages: (dayMap.get(date) || []).sort((a, b) =>
        (a.created_at as string).localeCompare(b.created_at as string)
      ),
    }));

    res.json({ days: result, timezone: tz });
  } catch (error) {
    console.error('Error building daily messages:', error);
    res.status(500).json({ error: 'Failed to build daily messages' });
  }
});

// Get archived threads (must be before :id routes)
router.get('/threads/archived', (req, res) => {
  try {
    // Route through the typed mappers (rowToThread + threadToSummary, both
    // applied inside listThreads/threadToSummary) so booleans land as real
    // booleans and the shape is ThreadSummary, not raw SELECT * columns.
    const threads = listThreads({ includeArchived: true, limit: 1000 })
      .filter(t => t.archived_at !== null)
      .map(threadToSummary)
      .sort((a, b) => (b.archived_at ?? '').localeCompare(a.archived_at ?? ''))
      .slice(0, 50);
    const body: { threads: ThreadSummary[] } = { threads };
    res.json(body);
  } catch (error) {
    console.error('Error fetching archived threads:', error);
    res.status(500).json({ error: 'Failed to fetch archived threads' });
  }
});

// Create named thread
router.post('/threads', (req, res) => {
  try {
    const { name } = req.body;

    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'Thread name required' });
      return;
    }

    const thread = createThread({
      // No id → createThread derives `slug(name)-shortId()` (unique, readable).
      name,
      type: 'named',
      createdAt: new Date().toISOString(),
      sessionType: 'v2',
    });

    res.json({ thread });
  } catch (error) {
    console.error('Error creating thread:', error);
    res.status(500).json({ error: 'Failed to create thread' });
  }
});

// Get thread messages (paginated)
router.get('/threads/:id/messages', (req, res) => {
  try {
    const { id } = req.params;
    const { before, limit } = req.query;

    const thread = getThread(id);
    if (!thread) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    const messages = getMessages({
      threadId: id,
      before: before as string | undefined,
      limit: limit ? parseInt(limit as string, 10) : 50,
    });

    res.json({ messages });
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Failed to fetch messages' });
  }
});

// Mark messages as read
router.post('/messages/read', (req, res) => {
  try {
    const { threadId, beforeId } = req.body;

    if (!threadId || !beforeId) {
      res.status(400).json({ error: 'threadId and beforeId required' });
      return;
    }

    const message = getMessage(beforeId);
    if (!message || message.thread_id !== threadId) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }

    markMessagesRead(threadId, beforeId, new Date().toISOString());

    res.json({ success: true });
  } catch (error) {
    console.error('Error marking messages as read:', error);
    res.status(500).json({ error: 'Failed to mark messages as read' });
  }
});

// --- Message actions (user-facing edit / delete / react) ---
// db helpers (editMessage, softDeleteMessage, addReaction, removeReaction) and
// the broadcast types (message_edited / message_deleted / message_reaction_*)
// already exist; these routes are the auth-gated user surface. The companion's
// own react/edit path is the localhost-only /internal/react above (user:
// 'companion'); these use user: 'user'.

// PATCH /api/messages/:id — edit a message's content.
// Body: { content }. Broadcasts message_edited. Preserves original_content.
router.patch('/messages/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { content } = req.body as { content?: string };
    if (!content || typeof content !== 'string') {
      res.status(400).json({ error: 'content is required' });
      return;
    }
    const message = getMessage(id);
    if (!message || message.deleted_at) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }

    const editedAt = new Date().toISOString();
    editMessage(id, content, editedAt);

    registry.broadcast({ type: 'message_edited', messageId: id, newContent: content, editedAt });
    res.json({ success: true, messageId: id, editedAt });
  } catch (error) {
    console.error('Error editing message:', error);
    res.status(500).json({ error: 'Failed to edit message' });
  }
});

// DELETE /api/messages/:id — soft-delete a message. Broadcasts message_deleted.
router.delete('/messages/:id', (req, res) => {
  try {
    const { id } = req.params;
    const message = getMessage(id);
    if (!message || message.deleted_at) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }

    softDeleteMessage(id, new Date().toISOString());
    registry.broadcast({ type: 'message_deleted', messageId: id });
    res.json({ success: true, messageId: id });
  } catch (error) {
    console.error('Error deleting message:', error);
    res.status(500).json({ error: 'Failed to delete message' });
  }
});

// POST /api/messages/:id/save-to-canvas — persist a (companion) reply as a
// content-bearing canvas/artifact, linked back to the source message.
//   - Reuses createCanvas (the content-persisting path the /internal/canvas
//     create route uses) — the REST /canvases create ignores content.
//   - title derives from the first non-empty line, stripped of leading markdown
//     heading/list/quote markers and inline emphasis, capped ~60 chars; falls
//     back to "Saved note".
//   - message_id = the source message so the inline artifact card links to it.
//   - Broadcasts canvas_created (full canvas) → panel auto-opens + card drops
//     under the message. Returns { canvas }.
function deriveCanvasTitle(content: string): string {
  const firstLine = content
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0) || '';
  const cleaned = firstLine
    .replace(/^#{1,6}\s*/, '')        // heading markers
    .replace(/^>\s*/, '')             // blockquote marker
    .replace(/^[-*+]\s+/, '')         // list marker
    .replace(/^\d+\.\s+/, '')         // ordered list marker
    .replace(/\*\*([^*]+)\*\*/g, '$1')// bold
    .replace(/\*([^*]+)\*/g, '$1')    // italic
    .replace(/`([^`]+)`/g, '$1')      // inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // links → text
    .trim();
  if (!cleaned) return 'Saved note';
  return cleaned.length > 60 ? cleaned.slice(0, 60).trimEnd() + '…' : cleaned;
}

router.post('/messages/:id/save-to-canvas', (req, res) => {
  try {
    const { id } = req.params;
    const message = getMessage(id);
    if (!message || message.deleted_at) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }

    const now = new Date().toISOString();
    const canvas = createCanvas({
      id: crypto.randomUUID(),
      threadId: message.thread_id,
      messageId: message.id,
      title: deriveCanvasTitle(message.content),
      content: message.content,
      contentType: 'markdown',
      createdBy: 'companion',
      createdAt: now,
    });

    registry.broadcast({ type: 'canvas_created', canvas });
    logCompanionAction('canvas', `saved reply to canvas: "${canvas.title}"`);

    res.json({ canvas });
  } catch (error) {
    console.error('Error saving message to canvas:', error);
    res.status(500).json({ error: 'Failed to save message to canvas' });
  }
});

// POST /api/messages/:id/regenerate — replace a companion reply with a fresh
// one. REPLACE semantics (no versions/branching, per product decision):
//   1. :id must be a companion message. Find the triggering user message (most
//      recent role='user' with a lower sequence in the same thread).
//   2. Hard-delete the target companion message + anything after it (normally
//      none) via deleteMessagesFrom.
//   3. Re-run the agent on the triggering user message's content through the
//      normal processMessage path — same stream_start/stream_token/stream_end
//      events, same DB persistence + broadcast as a fresh turn.
//
// SESSION SEMANTICS (the subtlety): we resume a per-thread SDK session
// (current_session_id). The SDK *does* expose a conversation-level rewind via
// the `resumeSessionAt` option — but it keys on the SDK transcript's
// SDKAssistantMessage.uuid, which we do not capture or persist anywhere (we
// only store our own generated message ids). Wiring it would mean plumbing
// per-turn SDK-uuid capture through _processQuery + a new persisted column.
// Given the PRIMARY use case is interruption recovery — a turn that died
// mid-stream, where the SDK session usually never committed a full assistant
// message — we take option (b): re-run as a fresh turn on the resumed session
// and accept that the session carries whatever the dead turn left (typically
// nothing material). LIMITATION (flagged): regenerating a *fully completed*
// response leaves the prior assistant turn in the SDK session context, so the
// model still "sees" its previous answer when producing the replacement. The
// user-visible chat is clean (old message hard-deleted); only the model's
// in-session context carries the stale turn until the next compaction/session
// rotation. Acceptable for interruption recovery; revisit with resumeSessionAt
// if completed-response regeneration needs true context rewind.
router.post('/messages/:id/regenerate', async (req, res) => {
  try {
    const { id } = req.params;
    const message = getMessage(id);
    if (!message || message.deleted_at) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }
    if (message.role !== 'companion') {
      res.status(400).json({ error: 'Only companion messages can be regenerated' });
      return;
    }

    const thread = getThread(message.thread_id);
    if (!thread) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    const trigger = getTriggeringUserMessage(message.thread_id, message.sequence);
    if (!trigger) {
      res.status(400).json({ error: 'No triggering user message found to regenerate from' });
      return;
    }

    const agentService = req.app.locals.agentService as AgentService | undefined;
    if (!agentService) {
      res.status(503).json({ error: 'Agent service not available' });
      return;
    }

    // Hard-delete the stale companion turn (+ any trailing messages) and tell
    // every client to drop it, so the re-run streams in cleanly with no
    // lingering version of the old reply.
    const deleted = deleteMessagesFrom(message.thread_id, message.id);
    // hard: true → clients splice the message out entirely (clean replace), rather
    // than tombstoning it with "This message was deleted".
    registry.broadcast({ type: 'message_deleted', messageId: message.id, hard: true });

    // Acknowledge before the (streaming) re-run; the frontend follows the normal
    // stream_start/stream_token/stream_end events for the replacement.
    res.json({ success: true, regenerating: true, deleted });

    // Fire the fresh turn on the triggering user message. Matches the WS send
    // path: processMessage handles streaming, DB storage and broadcasting.
    agentService
      .processMessage(message.thread_id, trigger.content, { name: thread.name, type: thread.type })
      .then(() => {
        updateThreadActivity(message.thread_id, new Date().toISOString(), true);
      })
      .catch((err) => {
        console.error('Regenerate processing error:', err);
      });
  } catch (error) {
    console.error('Error regenerating message:', error);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to regenerate message' });
    }
  }
});

// POST /api/messages/:id/reactions — add a reaction. Body: { emoji }.
// Reactions live in the message metadata JSON; broadcasts message_reaction_added.
router.post('/messages/:id/reactions', (req, res) => {
  try {
    const { id } = req.params;
    const { emoji } = req.body as { emoji?: string };
    if (!emoji || typeof emoji !== 'string') {
      res.status(400).json({ error: 'emoji is required' });
      return;
    }
    const message = getMessage(id);
    if (!message || message.deleted_at) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }

    addReaction(id, emoji, 'user');
    const createdAt = new Date().toISOString();
    registry.broadcast({ type: 'message_reaction_added', messageId: id, emoji, user: 'user', createdAt });
    res.json({ success: true, messageId: id, emoji });
  } catch (error) {
    console.error('Error adding reaction:', error);
    res.status(500).json({ error: 'Failed to add reaction' });
  }
});

// DELETE /api/messages/:id/reactions — remove a reaction. Body: { emoji }.
// Broadcasts message_reaction_removed.
router.delete('/messages/:id/reactions', (req, res) => {
  try {
    const { id } = req.params;
    const { emoji } = req.body as { emoji?: string };
    if (!emoji || typeof emoji !== 'string') {
      res.status(400).json({ error: 'emoji is required' });
      return;
    }
    const message = getMessage(id);
    if (!message) {
      res.status(404).json({ error: 'Message not found' });
      return;
    }

    removeReaction(id, emoji, 'user');
    registry.broadcast({ type: 'message_reaction_removed', messageId: id, emoji, user: 'user' });
    res.json({ success: true, messageId: id, emoji });
  } catch (error) {
    console.error('Error removing reaction:', error);
    res.status(500).json({ error: 'Failed to remove reaction' });
  }
});

// Archive a thread
router.post('/threads/:id/archive', (req, res) => {
  try {
    const { id } = req.params;
    const thread = getThread(id);
    if (!thread) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    archiveThread(id, new Date().toISOString());

    // Broadcast the now-archived summary so every client drops it from the
    // sidebar live (frontend filters on archived_at != null).
    const updated = getThread(id)!;
    registry.broadcast({
      type: 'thread_updated',
      thread: threadToSummary(updated),
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error archiving thread:', error);
    res.status(500).json({ error: 'Failed to archive thread' });
  }
});

// Unarchive — clear archived_at so the thread returns to the live sidebar.
// Broadcasts thread_updated (the summary, archived_at now null) plus the full
// thread_list (the store's thread_updated handler only maps over EXISTING rows,
// so a returning thread needs the list broadcast to reappear).
router.post('/threads/:id/unarchive', (req, res) => {
  try {
    const { id } = req.params;
    const thread = getThread(id);
    if (!thread) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    unarchiveThread(id);

    const updated = getThread(id)!;
    registry.broadcast({
      type: 'thread_updated',
      thread: threadToSummary(updated),
    });
    const threads = listThreads({ includeArchived: false, limit: 1000 }).map(threadToSummary);
    registry.broadcast({ type: 'thread_list', threads });

    res.json({ success: true, thread: threadToSummary(updated) });
  } catch (error) {
    console.error('Error unarchiving thread:', error);
    res.status(500).json({ error: 'Failed to unarchive thread' });
  }
});

// Reorder threads in the sidebar. Body: { orderedIds: string[] } — assigns
// position = index for each id in order. Broadcasts the full, newly-ordered
// active (non-archived) ThreadSummary[] as `thread_list` so every client
// reflects the new arrangement live.
router.post('/threads/reorder', (req, res) => {
  try {
    const { orderedIds } = req.body as { orderedIds?: unknown };

    if (
      !Array.isArray(orderedIds) ||
      !orderedIds.every((x) => typeof x === 'string')
    ) {
      res.status(400).json({ error: 'orderedIds must be an array of strings' });
      return;
    }

    reorderThreads(orderedIds as string[]);

    // Build the full ordered active list (position ASC, recency tiebreaker —
    // listThreads already applies that sort and the archived filter).
    const threads = listThreads({ includeArchived: false, limit: 1000 }).map(
      threadToSummary
    );
    registry.broadcast({ type: 'thread_list', threads });

    res.json({ success: true });
  } catch (error) {
    console.error('Error reordering threads:', error);
    res.status(500).json({ error: 'Failed to reorder threads' });
  }
});

// --- Sidebar sections -------------------------------------------------------
//
// Sections are user-created, named, collapsible containers for NAMED threads.
// Daily threads ignore sections (the frontend auto-groups dailies into monthly
// accordions). A named thread's section_id = its section, or null = loose.
//
// Clients fetch the section list on connect via GET /api/sections (the WS
// `connected` payload does not carry sections). Every mutating endpoint
// broadcasts the full `section_list` so all clients stay in sync live.

/** Fetch the ordered section list and broadcast it to every client. */
function broadcastSectionList(): void {
  const sections = listSections();
  registry.broadcast({ type: 'section_list', sections });
}

// List all sections (ordered position ASC).
router.get('/sections', (_req, res) => {
  try {
    res.json({ sections: listSections() });
  } catch (error) {
    console.error('Error listing sections:', error);
    res.status(500).json({ error: 'Failed to list sections' });
  }
});

// Create a section. Body: { name: string } (trimmed; 400 if empty).
router.post('/sections', (req, res) => {
  try {
    const { name } = req.body as { name?: unknown };
    if (typeof name !== 'string' || name.trim().length === 0) {
      res.status(400).json({ error: 'name must be a non-empty string' });
      return;
    }
    const section = createSection(name.trim());
    broadcastSectionList();
    res.json({ section });
  } catch (error) {
    console.error('Error creating section:', error);
    res.status(500).json({ error: 'Failed to create section' });
  }
});

// Update a section. Body: { name?: string, collapsed?: boolean }. 404 if missing.
router.patch('/sections/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { name, collapsed } = req.body as { name?: unknown; collapsed?: unknown };

    const hasName = name !== undefined;
    const hasCollapsed = collapsed !== undefined;
    if (!hasName && !hasCollapsed) {
      res.status(400).json({ error: 'Provide at least one of: name, collapsed' });
      return;
    }
    if (hasName && (typeof name !== 'string' || name.trim().length === 0)) {
      res.status(400).json({ error: 'name must be a non-empty string' });
      return;
    }
    if (hasCollapsed && typeof collapsed !== 'boolean') {
      res.status(400).json({ error: 'collapsed must be a boolean' });
      return;
    }

    const updated = updateSection(id, {
      ...(hasName ? { name: (name as string).trim() } : {}),
      ...(hasCollapsed ? { collapsed: collapsed as boolean } : {}),
    });
    if (!updated) {
      res.status(404).json({ error: 'Section not found' });
      return;
    }
    broadcastSectionList();
    res.json({ section: updated });
  } catch (error) {
    console.error('Error updating section:', error);
    res.status(500).json({ error: 'Failed to update section' });
  }
});

// Reorder sections. Body: { orderedIds: string[] } — position = index per id.
router.post('/sections/reorder', (req, res) => {
  try {
    const { orderedIds } = req.body as { orderedIds?: unknown };
    if (!Array.isArray(orderedIds) || !orderedIds.every((x) => typeof x === 'string')) {
      res.status(400).json({ error: 'orderedIds must be an array of strings' });
      return;
    }
    reorderSections(orderedIds as string[]);
    broadcastSectionList();
    res.json({ success: true });
  } catch (error) {
    console.error('Error reordering sections:', error);
    res.status(500).json({ error: 'Failed to reorder sections' });
  }
});

// Delete a section. Its threads survive — their section_id is set NULL (loose),
// so the sidebar must refresh threads too. Broadcasts BOTH section_list and
// thread_list.
router.delete('/sections/:id', (req, res) => {
  try {
    const { id } = req.params;
    deleteSection(id);
    broadcastSectionList();
    const threads = listThreads({ includeArchived: false, limit: 1000 }).map(threadToSummary);
    registry.broadcast({ type: 'thread_list', threads });
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting section:', error);
    res.status(500).json({ error: 'Failed to delete section' });
  }
});

// Pin a thread
router.post('/threads/:id/pin', (req, res) => {
  try {
    const { id } = req.params;
    const thread = getThread(id);
    if (!thread) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    pinThread(id);
    const updated = getThread(id)!;

    registry.broadcast({
      type: 'thread_updated',
      thread: threadToSummary(updated),
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error pinning thread:', error);
    res.status(500).json({ error: 'Failed to pin thread' });
  }
});

// Unpin a thread
router.post('/threads/:id/unpin', (req, res) => {
  try {
    const { id } = req.params;
    const thread = getThread(id);
    if (!thread) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    unpinThread(id);
    const updated = getThread(id)!;

    registry.broadcast({
      type: 'thread_updated',
      thread: threadToSummary(updated),
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error unpinning thread:', error);
    res.status(500).json({ error: 'Failed to unpin thread' });
  }
});

// Delete a thread and all associated data
router.delete('/threads/:id', (req, res) => {
  try {
    const { id } = req.params;
    const thread = getThread(id);
    if (!thread) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    const fileIds = deleteThread(id);

    // Clean up files on disk
    for (const fileId of fileIds) {
      deleteFile(fileId);
    }

    // Broadcast deletion to all connected clients
    registry.broadcast({ type: 'thread_deleted', threadId: id });

    res.json({ success: true, deletedFiles: fileIds.length });
  } catch (error) {
    console.error('Error deleting thread:', error);
    res.status(500).json({ error: 'Failed to delete thread' });
  }
});

// --- File upload/download ---

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
});

const uploadRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: 'Too many uploads, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  validate: { trustProxy: false },
});

// File upload
router.post('/files', uploadRateLimiter, upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: 'No file provided' });
      return;
    }

    const fileMeta = saveFile(req.file.buffer, req.file.originalname, req.file.mimetype);
    res.json(fileMeta);
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Upload failed';
    console.error('File upload error:', msg);
    res.status(400).json({ error: msg });
  }
});

// --- File browser (path-based, gated to write-gate roots) ---
// Distinct from the file-store routes below (which key on fileId). These let the
// frontend file browser walk the companion's writable roots read-only.
// SECURITY: a path is allowed only if it resolves inside one of the write-gate
// roots (workspace_root, vault_path, extra_write_paths dirs, agent.cwd). Any
// resolved path that escapes all roots → 403. Reuses getSafeWritePrefixes() so
// the browser and the hook write-gate share one allowlist source.

/** Clean, resolved directory roots derived from the write-gate prefixes. */
function getBrowseRoots(): string[] {
  const roots = new Set<string>();
  for (const prefix of getSafeWritePrefixes()) {
    // Normalize separators, strip trailing separator, resolve to absolute.
    const norm = prefix.replace(/[\\/]+$/, '');
    if (!norm) continue;
    // Only directory-style prefixes are valid browse roots; file prefixes (with
    // an extension) are skipped — the browser walks dirs, not single files.
    if (/\.[a-z0-9]+$/i.test(norm)) continue;
    roots.add(resolve(norm));
  }
  return [...roots];
}

// SECRET DENYLIST (S1) — even a logged-in session must never read these through
// the file browser. Matches on the basename, case-insensitively. Covers env
// files, the auto-generated key/token files, any SQLite DB, the MCP config (which
// can carry tokens/headers), and anything that looks like a credential bundle.
const SECRET_BASENAME_PATTERNS: RegExp[] = [
  /^\.env(\..*)?$/i,            // .env, .env.local, .env.production, ...
  /^\.dev\.vars$/i,             // wrangler local secrets (e.g. RELAY_SECRET)
  /^\.google-key$/i,           // google token-encryption key
  /^\.internal-token$/i,       // internal shared secret
  /\.db$/i,                     // SQLite databases (resonant.db, *.db-wal, etc.)
  /\.db-(wal|shm)$/i,
  /^\.mcp\.json$/i,            // MCP config — may carry tokens / headers
  /\.credentials$/i,
  /^\.credentials\.json$/i,
  /credentials\.json$/i,
  /\.pem$/i,                    // private keys / certs
  /\.key$/i,
  /(^|[._-])secret([._-]|$)/i, // anything that announces itself as a secret
  /(^|[._-])token([._-]|$)/i,
  /\.ps1$/i,                   // PowerShell scripts (launch.ps1 carries APP_PASSWORD)
  /\.claude\.json$/i,          // Anthropic OAuth / API credentials
  /\.ya?ml$/i,                 // config files (resonant.yaml etc.)
  /\.ya?ml\.bak/i,             // config backups (resonant.yaml.bak-<ts>) — carry secrets
  /\.bak-\d+$/i,               // any timestamped backup copy
];

/** True if the basename of `target` matches a secret denylist pattern. */
function isSecretFile(target: string): boolean {
  const name = basename(target);
  return SECRET_BASENAME_PATTERNS.some((re) => re.test(name));
}

/** True if `target` (already resolved) is inside one of the browse roots. */
function isInsideBrowseRoot(target: string): boolean {
  const resolved = resolve(target);
  for (const root of getBrowseRoots()) {
    if (resolved === root) return true;
    // Containment check with separator guard so /foo doesn't match /foobar.
    if (resolved.startsWith(root.endsWith(sep) ? root : root + sep)) return true;
  }
  return false;
}

// GET /api/files/browse?path=... — list a directory.
// Response: { path, root: true|false, entries: [ { name, type, size, mtime } ] }
// If no path given, returns the list of browse roots themselves.
router.get('/files/browse', (req, res) => {
  try {
    const rawPath = req.query.path as string | undefined;

    // No path → enumerate the roots so the UI has somewhere to start.
    if (!rawPath) {
      // Dedup case-insensitively (the write-gate prefix list carries both the
      // original-case and a lowercased copy of each root on Windows).
      const seen = new Set<string>();
      const uniqueRoots = getBrowseRoots().filter(root => {
        const key = root.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      const entries = uniqueRoots.map(root => {
        let mtime = '';
        try { mtime = statSync(root).mtime.toISOString(); } catch { /* ignore */ }
        return { name: root, type: 'directory' as const, size: 0, mtime, path: root };
      });
      res.json({ path: null, roots: true, entries });
      return;
    }

    const target = resolve(rawPath);
    if (!isInsideBrowseRoot(target)) {
      res.status(403).json({ error: 'Path is outside the allowed roots' });
      return;
    }
    if (!existsSync(target)) {
      res.status(404).json({ error: 'Path not found' });
      return;
    }
    const targetStat = statSync(target);
    if (!targetStat.isDirectory()) {
      res.status(400).json({ error: 'Path is not a directory — use /files/read for files' });
      return;
    }

    const dirents = readdirSync(target, { withFileTypes: true });
    const entries = dirents
      // Secret denylist (S1) — omit credential/key/db files from the listing so
      // they can't be seen or selected, even by a logged-in session.
      .filter(d => !isSecretFile(d.name))
      .map(d => {
      const full = join(target, d.name);
      let size = 0;
      let mtime = '';
      try {
        const st = statSync(full);
        size = st.size;
        mtime = st.mtime.toISOString();
      } catch { /* unreadable entry — report zeros */ }
      return {
        name: d.name,
        type: d.isDirectory() ? ('directory' as const) : ('file' as const),
        size,
        mtime,
        path: full,
      };
    });

    // Directories first, then alphabetical.
    entries.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });

    res.json({ path: target, roots: false, entries });
  } catch (error) {
    console.error('Error browsing files:', error);
    res.status(500).json({ error: 'Failed to browse path' });
  }
});

// GET /api/files/read?path=... — return a file's contents (text).
// Response: { path, size, mtime, content } or 403 if outside roots.
// Caps at 1MB and refuses obvious binaries (null byte sniff).
router.get('/files/read', (req, res) => {
  try {
    const rawPath = req.query.path as string | undefined;
    if (!rawPath) {
      res.status(400).json({ error: 'path query param required' });
      return;
    }
    const target = resolve(rawPath);
    if (!isInsideBrowseRoot(target)) {
      res.status(403).json({ error: 'Path is outside the allowed roots' });
      return;
    }
    // Secret denylist (S1) — never serve credential/key/db files, even to a
    // logged-in session. 404 so the file's existence isn't confirmed.
    if (isSecretFile(target)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    if (!existsSync(target)) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    const st = statSync(target);
    if (st.isDirectory()) {
      res.status(400).json({ error: 'Path is a directory — use /files/browse' });
      return;
    }
    if (st.size > 1024 * 1024) {
      res.status(413).json({ error: 'File too large to read (>1MB)' });
      return;
    }

    const buffer = readFileSync(target);
    // Binary sniff — refuse files with a null byte in the first 8KB.
    const sniff = buffer.subarray(0, 8192);
    if (sniff.includes(0)) {
      res.status(415).json({ error: 'Binary file — not readable as text' });
      return;
    }

    res.json({
      path: target,
      size: st.size,
      mtime: st.mtime.toISOString(),
      content: buffer.toString('utf-8'),
    });
  } catch (error) {
    console.error('Error reading file:', error);
    res.status(500).json({ error: 'Failed to read file' });
  }
});

// File listing (MUST be before /files/:id)
router.get('/files/list', (req, res) => {
  try {
    const files = listFiles();

    // Scan messages for fileId references to determine in-use status
    const db = getDb();
    const rows = db.prepare('SELECT metadata FROM messages WHERE metadata IS NOT NULL AND deleted_at IS NULL').all() as Array<{ metadata: string }>;
    const usedFileIds = new Set<string>();
    for (const row of rows) {
      try {
        const meta = JSON.parse(row.metadata);
        if (meta.fileId) usedFileIds.add(meta.fileId);
      } catch { /* skip */ }
    }

    const enriched = files.map(f => ({
      ...f,
      inUse: usedFileIds.has(f.fileId),
    }));

    const totalSize = files.reduce((sum, f) => sum + f.size, 0);
    const orphanCount = enriched.filter(f => !f.inUse).length;

    res.json({ files: enriched, totalSize, totalCount: files.length, orphanCount });
  } catch (error) {
    console.error('Error listing files:', error);
    res.status(500).json({ error: 'Failed to list files' });
  }
});

// Delete a file
router.delete('/files/:id', (req, res) => {
  try {
    const deleted = deleteFile(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'File not found' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting file:', error);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// File download
router.get('/files/:id', (req, res) => {
  try {
    const file = getFile(req.params.id);
    if (!file) {
      res.status(404).json({ error: 'File not found' });
      return;
    }

    res.setHeader('Content-Type', file.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=86400'); // 24h cache
    res.sendFile(file.path);
  } catch (error) {
    console.error('File download error:', error);
    res.status(500).json({ error: 'Failed to retrieve file' });
  }
});

// Update a thread: rename and/or set per-thread model + reasoning effort +
// thinking visibility.
// Body (all optional, but at least one required):
//   { name?: string, model?: string | null, effort?: EffortLevel | null,
//     show_thinking?: boolean }
// - name: non-empty string to rename.
// - model: an Anthropic model id; "" or null clears it (falls back to default).
// - effort: one of low|medium|high|xhigh|max; "" or null clears it (SDK default
//   'high'). Any other value is rejected.
// - show_thinking: boolean; persisted as 1/0. Drives agent.ts thinking display.
// model + effort + show_thinking apply to the NEXT message sent in this thread
// (read in agent._processQuery), interactive path only.
const VALID_EFFORT = ['low', 'medium', 'high', 'xhigh', 'max'];
router.patch('/threads/:id', (req, res) => {
  try {
    const { id } = req.params;
    const { name, model, effort, show_thinking, section_id } = req.body as {
      name?: unknown;
      model?: unknown;
      effort?: unknown;
      show_thinking?: unknown;
      section_id?: unknown;
    };

    const hasName = name !== undefined;
    const hasModel = model !== undefined;
    const hasEffort = effort !== undefined;
    const hasShowThinking = show_thinking !== undefined;
    const hasSectionId = section_id !== undefined;

    if (!hasName && !hasModel && !hasEffort && !hasShowThinking && !hasSectionId) {
      res.status(400).json({ error: 'Provide at least one of: name, model, effort, show_thinking, section_id' });
      return;
    }

    // Validate section_id when present: a string (file under a section) or null
    // (loose). A non-null string must reference an existing section.
    let sectionIdValue: string | null | undefined;
    if (hasSectionId) {
      if (section_id === null) {
        sectionIdValue = null;
      } else if (typeof section_id === 'string') {
        if (!getSection(section_id)) {
          res.status(400).json({ error: 'section_id does not reference an existing section' });
          return;
        }
        sectionIdValue = section_id;
      } else {
        res.status(400).json({ error: 'section_id must be a string or null' });
        return;
      }
    }

    // Validate name when present.
    if (hasName && (typeof name !== 'string' || name.trim().length === 0)) {
      res.status(400).json({ error: 'Thread name must be a non-empty string' });
      return;
    }

    // Validate model when present: a string (set) or null/"" (clear).
    let modelValue: string | null | undefined;
    if (hasModel) {
      if (model === null || (typeof model === 'string' && model.trim() === '')) {
        modelValue = null;
      } else if (typeof model === 'string') {
        modelValue = model.trim();
      } else {
        res.status(400).json({ error: 'model must be a string or null' });
        return;
      }
    }

    // Validate effort when present: one of the 5 levels (set) or null/"" (clear).
    let effortValue: string | null | undefined;
    if (hasEffort) {
      if (effort === null || (typeof effort === 'string' && effort.trim() === '')) {
        effortValue = null;
      } else if (typeof effort === 'string' && VALID_EFFORT.includes(effort)) {
        effortValue = effort;
      } else {
        res.status(400).json({
          error: `effort must be one of ${VALID_EFFORT.join(', ')}, or null to clear`,
        });
        return;
      }
    }

    // Validate show_thinking when present: must be a boolean.
    if (hasShowThinking && typeof show_thinking !== 'boolean') {
      res.status(400).json({ error: 'show_thinking must be a boolean' });
      return;
    }

    const thread = getThread(id);
    if (!thread) {
      res.status(404).json({ error: 'Thread not found' });
      return;
    }

    const db = getDb();
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    if (hasName) { sets.push('name = ?'); vals.push((name as string).trim()); }
    if (hasModel) { sets.push('model = ?'); vals.push(modelValue ?? null); }
    if (hasEffort) { sets.push('effort = ?'); vals.push(effortValue ?? null); }
    if (hasShowThinking) { sets.push('show_thinking = ?'); vals.push((show_thinking as boolean) ? 1 : 0); }
    if (sets.length > 0) {
      vals.push(id);
      db.prepare(`UPDATE threads SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    }

    // Section filing is handled via its dedicated setter (validated above).
    if (hasSectionId) {
      setThreadSection(id, sectionIdValue ?? null);
    }

    // Re-read so the response + broadcast carry the persisted state.
    const updated = getThread(id)!;

    // Broadcast updated thread to all clients (rename + header picker refresh).
    const summary = threadToSummary(updated);
    registry.broadcast({
      type: 'thread_updated',
      thread: summary,
    });

    res.json({ success: true, thread: summary });
  } catch (error) {
    console.error('Error updating thread:', error);
    res.status(500).json({ error: 'Failed to update thread' });
  }
});

// Message search
router.get('/search', (req, res) => {
  try {
    const q = req.query.q as string;
    if (!q || q.trim().length === 0) {
      return res.status(400).json({ error: 'Search query required' });
    }
    const threadId = req.query.threadId as string | undefined;
    const limit = parseInt(req.query.limit as string, 10) || 50;
    const offset = parseInt(req.query.offset as string, 10) || 0;

    const { messages: rows, total } = searchMessages({ query: q.trim(), threadId, limit, offset });

    const results = rows.map(row => {
      // Build highlight snippet around match
      const idx = row.content.toLowerCase().indexOf(q.toLowerCase());
      const start = Math.max(0, idx - 40);
      const end = Math.min(row.content.length, idx + q.length + 40);
      const highlight = (start > 0 ? '...' : '') + row.content.slice(start, end) + (end < row.content.length ? '...' : '');

      return {
        messageId: row.id,
        threadId: row.thread_id,
        threadName: row.thread_name,
        role: row.role,
        content: row.content.substring(0, 200),
        highlight,
        createdAt: row.created_at,
      };
    });

    res.json({ results, total });
  } catch (error) {
    console.error('Error searching messages:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Audit log entries
router.get('/audit', (req, res) => {
  try {
    const { limit } = req.query;
    const entries = getRecentAuditEntries(limit ? parseInt(limit as string, 10) : 50);
    res.json({ entries });
  } catch (error) {
    console.error('Error fetching audit log:', error);
    res.status(500).json({ error: 'Failed to fetch audit log' });
  }
});

// Agent sessions (via SDK listSessions)
router.get('/sessions', async (req, res) => {
  try {
    const { limit } = req.query;
    const agentService = req.app.locals.agentService as AgentService;
    const sessions = await agentService.listSessions(limit ? parseInt(limit as string, 10) : 50);
    res.json({ sessions });
  } catch (error) {
    console.error('Error fetching sessions:', error);
    res.status(500).json({ error: 'Failed to fetch sessions' });
  }
});

// --- Model selector ---
// GET /api/models — available models for a selector. Combines the configured
// active/autonomous models with a static known list (the tiers we carry pricing
// for). `current`/`currentAutonomous` flag the configured choices. This is a
// static catalog — the Agent SDK does not expose a live model list to the
// in-process query() loop, so a curated list is the honest source.
const KNOWN_MODELS: Array<{ id: string; label: string; tier: string }> = [
  { id: 'claude-fable-5', label: 'Claude Fable 5', tier: 'fable' },
  { id: 'claude-opus-4-8[1m]', label: 'Claude Opus 4.8 · 1M', tier: 'opus' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8', tier: 'opus' },
  { id: 'claude-opus-4-7', label: 'Claude Opus 4.7', tier: 'opus' },
  { id: 'claude-opus-4-6', label: 'Claude Opus 4.6', tier: 'opus' },
  { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', tier: 'sonnet' },
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', tier: 'sonnet' },
  { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5', tier: 'sonnet' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', tier: 'haiku' },
];

router.get('/models', (req, res) => {
  try {
    const config = getResonantConfig();
    const current = config.agent.model;
    const currentAutonomous = config.agent.model_autonomous;

    // Ensure the configured models are present even if not in the static list.
    const ids = new Set(KNOWN_MODELS.map(m => m.id));
    const models = [...KNOWN_MODELS];
    for (const id of [current, currentAutonomous]) {
      if (id && !ids.has(id)) {
        models.push({ id, label: id, tier: 'custom' });
        ids.add(id);
      }
    }

    res.json({ models, current, currentAutonomous });
  } catch (error) {
    console.error('Error listing models:', error);
    res.status(500).json({ error: 'Failed to list models' });
  }
});

// --- Usage ---
// GET /api/usage?days=N — token usage + estimated cost over a window. Backed by
// the usage_log table (recordUsage is called per turn). Returns real tracked
// figures; if no turns were logged the totals are simply zero (honest, not a
// fabricated stub). Default window 30 days, capped at 365.
router.get('/usage', (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days as string, 10) || 30, 365);
    const summary = getUsageSummary(days);
    res.json(summary);
  } catch (error) {
    console.error('Error fetching usage:', error);
    res.status(500).json({ error: 'Failed to fetch usage' });
  }
});

// --- Settings & Orchestrator endpoints ---

// SECRET CONFIG KEYS (MIND-SURFACE-SPEC Phase 1.1) — db-config secrets are
// masked to a fingerprint (••••last4) on every read surface; the raw value
// never reaches the client, same discipline as SECRET_YAML_PATHS above.
// PUT /settings refuses to store a round-tripped fingerprint as the value.
const SECRET_CONFIG_KEYS = ['mind.api_key', 'integrations.mind_api_key'];
const CONFIG_FINGERPRINT_RE = /^••••/;
function maskSecretConfigs(config: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...config };
  for (const key of SECRET_CONFIG_KEYS) {
    if (out[key]) out[key] = `••••${out[key].slice(-4)}`;
  }
  return out;
}

// Get all config
router.get('/settings', (req, res) => {
  try {
    const config = maskSecretConfigs(getAllConfig());
    res.json({ config });
  } catch (error) {
    console.error('Error fetching settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// Update a config value
router.put('/settings', (req, res) => {
  try {
    const { key, value } = req.body;
    if (!key || typeof key !== 'string' || typeof value !== 'string') {
      res.status(400).json({ error: 'key and value (strings) required' });
      return;
    }
    if (SECRET_CONFIG_KEYS.includes(key) && CONFIG_FINGERPRINT_RE.test(value)) {
      // The masked fingerprint round-tripped from the Settings UI — the
      // secret wasn't changed. Never store the mask as the value.
      res.json({ success: true, unchanged: true });
      return;
    }
    setConfig(key, value);
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating setting:', error);
    res.status(500).json({ error: 'Failed to update setting' });
  }
});

// --- Theme (runtime appearance overrides) ---
// Live theming, not v1's build-time "copy a CSS file + rebuild" approach.
// A curated allowlist of the bare CSS custom-property names the Hearth's own
// components actually consume (packages/frontend/src/index.css :root) — kept
// intentionally small (colours + fonts only) so a save can never smuggle
// unrelated CSS through. Stored as ONE JSON blob under the existing `config`
// key/value store (same table PUT /settings and the mantelpiece writes use) —
// no new table. Mirrored in packages/frontend/src/store/theme.ts; keep both
// lists in sync if the editable set ever changes.
const THEME_TOKEN_ALLOWLIST = new Set([
  '--bg-primary', '--bg-secondary', '--bg-input',
  '--text-primary', '--text-secondary', '--text-muted',
  '--border',
  '--amber', '--amber-bright',
  '--lavender', '--lavender-bright',
  '--gold',
  '--status-active',
  '--font-serif', '--font-body', '--font-mono',
]);
const THEME_CONFIG_KEY = 'theme.overrides';

router.get('/theme', (req, res) => {
  try {
    const raw = getConfig(THEME_CONFIG_KEY);
    const overrides = raw ? JSON.parse(raw) : {};
    res.json({ overrides });
  } catch (error) {
    console.error('Error fetching theme:', error);
    res.status(500).json({ error: 'Failed to fetch theme' });
  }
});

router.put('/theme', (req, res) => {
  try {
    const { overrides } = req.body as { overrides?: unknown };
    if (overrides === null || overrides === undefined || typeof overrides !== 'object' || Array.isArray(overrides)) {
      res.status(400).json({ error: 'overrides object required (may be {} to reset)' });
      return;
    }
    // Silently drop unknown keys / malformed values rather than failing the
    // whole save — a stale client sending one bad field shouldn't block a
    // legitimate reset or the rest of the palette from persisting.
    const clean: Record<string, string> = {};
    for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
      if (!THEME_TOKEN_ALLOWLIST.has(key)) continue;
      if (typeof value !== 'string' || value.length === 0 || value.length > 300) continue;
      clean[key] = value;
    }
    setConfig(THEME_CONFIG_KEY, JSON.stringify(clean));
    res.json({ success: true, overrides: clean });
  } catch (error) {
    console.error('Error updating theme:', error);
    res.status(500).json({ error: 'Failed to update theme' });
  }
});

// Get config endpoint — returns companion/user names plus all DB config
router.get('/config', (req, res) => {
  try {
    const resonantConfig = getResonantConfig();
    const dbConfig = maskSecretConfigs(getAllConfig());
    res.json({
      companion_name: resonantConfig.identity.companion_name,
      user_name: resonantConfig.identity.user_name,
      timezone: resonantConfig.identity.timezone,
      config: dbConfig,
    });
  } catch (error) {
    console.error('Error fetching config:', error);
    res.status(500).json({ error: 'Failed to fetch config' });
  }
});

// Get skills from agent CWD
router.get('/skills', (req, res) => {
  try {
    const config = getResonantConfig();
    const agentCwd = config.agent.cwd;
    const skillsDir = join(agentCwd, '.claude', 'skills');

    if (!existsSync(skillsDir)) {
      res.json({ skills: [] });
      return;
    }

    const skills: Array<{ name: string; description: string }> = [];
    const dirs = readdirSync(skillsDir, { withFileTypes: true });

    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const skillFile = join(skillsDir, dir.name, 'SKILL.md');
      if (!existsSync(skillFile)) continue;

      const content = readFileSync(skillFile, 'utf-8');

      // Parse YAML frontmatter
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) continue;

      const fm = fmMatch[1];
      const nameMatch = fm.match(/^name:\s*["']?(.+?)["']?\s*$/m);
      const descMatch = fm.match(/^description:\s*["']?(.+?)["']?\s*$/m);

      skills.push({
        name: nameMatch?.[1] || dir.name,
        description: descMatch?.[1] || '',
      });
    }

    res.json({ skills });
  } catch (error) {
    console.error('Error reading skills:', error);
    res.status(500).json({ error: 'Failed to read skills' });
  }
});

// --- System prompt frame (the lean operating frame, prepended before CLAUDE.md) ---
// Edits apply live: the agent reads this file fresh on every turn. Only the file
// configured as agent.system_prompt_file is touched, and only if it sits inside an
// allowed write root.
router.get('/prompts/system', (req, res) => {
  try {
    const path = getResonantConfig().agent.system_prompt_file || '';
    if (!path) { res.json({ configured: false, content: '', path: '' }); return; }
    const content = existsSync(path) ? readFileSync(path, 'utf-8') : '';
    res.json({ configured: true, content, path });
  } catch (error) {
    console.error('Error reading system prompt:', error);
    res.status(500).json({ error: 'Failed to read system prompt' });
  }
});

router.put('/prompts/system', (req, res) => {
  try {
    const path = getResonantConfig().agent.system_prompt_file || '';
    if (!path) { res.status(400).json({ error: 'No system_prompt_file configured' }); return; }
    const { content } = req.body;
    if (typeof content !== 'string') { res.status(400).json({ error: 'content (string) required' }); return; }
    const resolved = resolve(path);
    const allowed = getSafeWritePrefixes().some(
      p => resolved === resolve(p) || resolved.startsWith(resolve(p) + sep),
    );
    if (!allowed) { res.status(403).json({ error: 'System prompt path is outside the write roots' }); return; }
    writeFileSync(resolved, content, 'utf-8');
    res.json({ success: true, bytes: content.length });
  } catch (error) {
    console.error('Error writing system prompt:', error);
    res.status(500).json({ error: 'Failed to write system prompt' });
  }
});

// --- Wake types (first-class, file-backed) ---------------------------------
// A wake type = a named prompt = its own file at prompts/wakes/<type>.md. The
// <type> token (^[a-z0-9_]+$) IS the filename. The schedule is separate: a
// schedule (default check-in or custom routine) references a wake type by token
// + a cron expression. These routes are the auth-gated editor surface; the
// orchestrator loads prompts from the same directory and reloads on write.

/** Prettify a wake-type token for display: underscores → spaces, Title Case. */
function prettifyWakeType(type: string): string {
  return type.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/** The wake-prompts dir (orchestrator is the source of truth; fall back to
 *  config if the orchestrator isn't mounted). */
function resolveWakeDir(req: import('express').Request): string {
  const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
  if (orchestrator) return orchestrator.getWakePromptsDir();
  return getResonantConfig().orchestrator.wake_prompts_dir;
}

// GET /api/orchestrator/wake-types →
//   { wakeTypes: [ { type, label, content, scheduled, cronExpr } ] }
//   scheduled = an active schedule references this type; cronExpr is its cron
//   string (or null). content = the raw md file body (no prefix).
router.get('/orchestrator/wake-types', (req, res) => {
  try {
    const dir = resolveWakeDir(req);
    const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;

    const wakeTypes: Array<{
      type: string; label: string; content: string;
      scheduled: boolean; cronExpr: string | null; model: string | null; target: string | null;
    }> = [];

    if (existsSync(dir)) {
      for (const file of readdirSync(dir).sort()) {
        if (!file.toLowerCase().endsWith('.md')) continue;
        const type = file.slice(0, -3);
        if (!isValidWakeType(type)) continue;
        let content = '';
        try { content = readFileSync(join(dir, file), 'utf-8'); } catch { /* skip unreadable */ }
        const sched = orchestrator?.getScheduleForWakeType(type) || null;
        wakeTypes.push({
          type,
          label: prettifyWakeType(type),
          content,
          scheduled: !!sched,
          cronExpr: sched ? sched.cronExpr : null,
          model: sched ? sched.model : null,
          target: sched ? sched.target : null,
        });
      }
    }

    res.json({ wakeTypes });
  } catch (error) {
    console.error('Error listing wake types:', error);
    res.status(500).json({ error: 'Failed to list wake types' });
  }
});

// GET /api/orchestrator/wake-types/:type → { type, content }
router.get('/orchestrator/wake-types/:type', (req, res) => {
  try {
    const { type } = req.params;
    const dir = resolveWakeDir(req);
    const path = wakeTypeFilePath(dir, type);
    if (!path) { res.status(400).json({ error: 'Invalid wake type name' }); return; }
    if (!existsSync(path)) { res.status(404).json({ error: 'Wake type not found' }); return; }
    const content = readFileSync(path, 'utf-8');
    res.json({ type, content });
  } catch (error) {
    console.error('Error reading wake type:', error);
    res.status(500).json({ error: 'Failed to read wake type' });
  }
});

// PUT /api/orchestrator/wake-types/:type  { content } → overwrite (create OK).
// Triggers an orchestrator wake-prompt reload so the edit applies live.
router.put('/orchestrator/wake-types/:type', (req, res) => {
  try {
    const { type } = req.params;
    const { content } = req.body as { content?: string };
    if (typeof content !== 'string') { res.status(400).json({ error: 'content (string) required' }); return; }
    const dir = resolveWakeDir(req);
    const path = wakeTypeFilePath(dir, type);
    if (!path) { res.status(400).json({ error: 'Invalid wake type name (use ^[a-z0-9_]+$)' }); return; }
    if (!existsSync(dir)) { res.status(500).json({ error: 'Wake prompts directory missing' }); return; }
    writeFileSync(path, content, 'utf-8');
    const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
    orchestrator?.reloadWakePrompts();
    res.json({ success: true, type, bytes: content.length });
  } catch (error) {
    console.error('Error writing wake type:', error);
    res.status(500).json({ error: 'Failed to write wake type' });
  }
});

// POST /api/orchestrator/wake-types  { type, content } → create new file.
// 400 if name invalid or file already exists.
router.post('/orchestrator/wake-types', (req, res) => {
  try {
    const { type, content } = req.body as { type?: string; content?: string };
    if (!type || typeof type !== 'string') { res.status(400).json({ error: 'type required' }); return; }
    if (!isValidWakeType(type)) { res.status(400).json({ error: 'Invalid wake type name (use ^[a-z0-9_]+$)' }); return; }
    if (typeof content !== 'string') { res.status(400).json({ error: 'content (string) required' }); return; }
    const dir = resolveWakeDir(req);
    const path = wakeTypeFilePath(dir, type);
    if (!path) { res.status(400).json({ error: 'Invalid wake type name' }); return; }
    if (!existsSync(dir)) { res.status(500).json({ error: 'Wake prompts directory missing' }); return; }
    if (existsSync(path)) { res.status(400).json({ error: 'Wake type already exists' }); return; }
    writeFileSync(path, content, 'utf-8');
    const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
    orchestrator?.reloadWakePrompts();
    res.json({ success: true, type, label: prettifyWakeType(type) });
  } catch (error) {
    console.error('Error creating wake type:', error);
    res.status(500).json({ error: 'Failed to create wake type' });
  }
});

// DELETE /api/orchestrator/wake-types/:type → delete the md file AND remove any
// schedule referencing it (so no schedule points at a missing prompt). Reload.
router.delete('/orchestrator/wake-types/:type', (req, res) => {
  try {
    const { type } = req.params;
    const dir = resolveWakeDir(req);
    const path = wakeTypeFilePath(dir, type);
    if (!path) { res.status(400).json({ error: 'Invalid wake type name' }); return; }
    if (!existsSync(path)) { res.status(404).json({ error: 'Wake type not found' }); return; }

    const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
    const scheduleRemoved = orchestrator?.removeScheduleForWakeType(type) || false;

    unlinkSync(path);
    orchestrator?.reloadWakePrompts();
    if (scheduleRemoved) broadcastOrchestratorUpdate('schedule');
    res.json({ success: true, type, scheduleRemoved });
  } catch (error) {
    console.error('Error deleting wake type:', error);
    res.status(500).json({ error: 'Failed to delete wake type' });
  }
});

// --- Canvas REST routes ---

// List canvases
router.get('/canvases', (req, res) => {
  try {
    const canvases = listCanvases();
    res.json({ canvases });
  } catch (error) {
    console.error('Error listing canvases:', error);
    res.status(500).json({ error: 'Failed to list canvases' });
  }
});

// List a thread's canvases, oldest-first — lets the chat hydrate inline artifact
// cards in conversation order when a thread loads.
router.get('/threads/:id/canvases', (req, res) => {
  try {
    const canvases = listCanvasesByThread(req.params.id);
    res.json({ canvases });
  } catch (error) {
    console.error('Error listing thread canvases:', error);
    res.status(500).json({ error: 'Failed to list thread canvases' });
  }
});

// Create canvas
router.post('/canvases', (req, res) => {
  try {
    const { title, contentType, language, threadId } = req.body;
    if (!title || typeof title !== 'string') {
      res.status(400).json({ error: 'title is required' });
      return;
    }

    const now = new Date().toISOString();
    // Link to the active turn in this thread if one is streaming (a canvas can
    // be created mid-conversation), else null.
    const messageId = threadId ? getActiveMessageId(threadId) : null;
    const canvas = createCanvas({
      id: crypto.randomUUID(),
      threadId: threadId || undefined,
      messageId,
      title,
      contentType: contentType || 'markdown',
      language: language || undefined,
      createdBy: 'user',
      createdAt: now,
    });

    registry.broadcast({ type: 'canvas_created', canvas });
    res.json({ canvas });
  } catch (error) {
    console.error('Error creating canvas:', error);
    res.status(500).json({ error: 'Failed to create canvas' });
  }
});

// Get canvas
router.get('/canvases/:id', (req, res) => {
  try {
    const canvas = getCanvas(req.params.id);
    if (!canvas) {
      res.status(404).json({ error: 'Canvas not found' });
      return;
    }
    res.json({ canvas });
  } catch (error) {
    console.error('Error fetching canvas:', error);
    res.status(500).json({ error: 'Failed to fetch canvas' });
  }
});

// Update canvas
router.patch('/canvases/:id', (req, res) => {
  try {
    const canvas = getCanvas(req.params.id);
    if (!canvas) {
      res.status(404).json({ error: 'Canvas not found' });
      return;
    }

    const now = new Date().toISOString();
    const { title, content, version } = req.body;

    if (version !== undefined && !(Number.isInteger(version) && version >= 0)) {
      res.status(400).json({ error: 'version must be a non-negative integer' });
      return;
    }
    if (version !== undefined && content === undefined) {
      res.status(400).json({ error: 'version is only meaningful together with content' });
      return;
    }

    // Content first: on a stale version nothing is written (title included).
    // A request with no version is a legacy caller: unconditional write.
    let newVersion = canvas.version;
    if (content !== undefined) {
      const result = updateCanvasContent(req.params.id, content, now, version);
      if (!result.ok) {
        if (result.reason === 'not_found') {
          res.status(404).json({ error: 'Canvas not found' });
        } else {
          res.status(409).json({ error: 'Canvas was changed by someone else', canvas: result.canvas });
        }
        return;
      }
      newVersion = result.version;
      registry.broadcast({ type: 'canvas_updated', canvasId: req.params.id, content, updatedAt: now, version: newVersion });
    }
    if (title !== undefined) {
      updateCanvasTitle(req.params.id, title, now);
    }

    res.json({ success: true, version: newVersion });
  } catch (error) {
    console.error('Error updating canvas:', error);
    res.status(500).json({ error: 'Failed to update canvas' });
  }
});

// Delete canvas
router.delete('/canvases/:id', (req, res) => {
  try {
    const deleted = deleteCanvas(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Canvas not found' });
      return;
    }
    registry.broadcast({ type: 'canvas_deleted', canvasId: req.params.id });
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting canvas:', error);
    res.status(500).json({ error: 'Failed to delete canvas' });
  }
});

// --- Push subscription endpoints ---

// Subscribe to push notifications
router.post('/push/subscribe', (req, res) => {
  try {
    const { endpoint, keys, deviceLabel } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      res.status(400).json({ error: 'endpoint and keys (p256dh, auth) required' });
      return;
    }

    const id = crypto.randomUUID();
    addPushSubscription({
      id,
      endpoint,
      keysP256dh: keys.p256dh,
      keysAuth: keys.auth,
      deviceName: deviceLabel,
    });

    res.json({ success: true, id });
  } catch (error) {
    console.error('Error subscribing to push:', error);
    res.status(500).json({ error: 'Failed to subscribe' });
  }
});

// Unsubscribe from push notifications
router.post('/push/unsubscribe', (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) {
      res.status(400).json({ error: 'endpoint required' });
      return;
    }

    const removed = removePushSubscription(endpoint);
    res.json({ success: true, removed });
  } catch (error) {
    console.error('Error unsubscribing from push:', error);
    res.status(500).json({ error: 'Failed to unsubscribe' });
  }
});

// List push subscriptions (truncated endpoints for display)
router.get('/push/subscriptions', (req, res) => {
  try {
    const subs = listPushSubscriptions();
    const display = subs.map(s => ({
      id: s.id,
      deviceName: s.device_name,
      endpoint: s.endpoint ? s.endpoint.slice(0, 60) + '...' : null,
      createdAt: s.created_at,
      lastUsedAt: s.last_used_at,
    }));
    res.json({ subscriptions: display });
  } catch (error) {
    console.error('Error listing push subscriptions:', error);
    res.status(500).json({ error: 'Failed to list subscriptions' });
  }
});

// Send test push notification
router.post('/push/test', async (req, res) => {
  try {
    const pushService = req.app.locals.pushService as PushService | undefined;
    if (!pushService?.isConfigured()) {
      res.status(503).json({ error: 'Push notifications not configured — set VAPID keys in .env' });
      return;
    }

    const config = getResonantConfig();
    await pushService.sendPush({
      title: config.identity.companion_name,
      body: 'Push notifications are working!',
      tag: 'test',
      url: '/chat',
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error sending test push:', error);
    res.status(500).json({ error: 'Failed to send test push' });
  }
});

// Get orchestrator task status
router.get('/orchestrator/status', async (req, res) => {
  try {
    const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
    if (!orchestrator) {
      res.status(503).json({ error: 'Orchestrator not available' });
      return;
    }
    const tasks = await orchestrator.getStatus();
    res.json({ tasks });
  } catch (error) {
    console.error('Error fetching orchestrator status:', error);
    res.status(500).json({ error: 'Failed to fetch orchestrator status' });
  }
});

// Enable/disable/reschedule a task
router.patch('/orchestrator/tasks/:wakeType', async (req, res) => {
  try {
    const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
    if (!orchestrator) {
      res.status(503).json({ error: 'Orchestrator not available' });
      return;
    }

    const { wakeType } = req.params;
    const { enabled, cronExpr } = req.body;

    if (cronExpr !== undefined) {
      if (typeof cronExpr !== 'string') {
        res.status(400).json({ error: 'cronExpr must be a string' });
        return;
      }
      const success = orchestrator.rescheduleTask(wakeType, cronExpr);
      if (!success) {
        res.status(400).json({ error: 'Failed to reschedule — invalid cron expression or unknown task' });
        return;
      }
    }

    if (enabled !== undefined) {
      if (typeof enabled !== 'boolean') {
        res.status(400).json({ error: 'enabled must be a boolean' });
        return;
      }
      const success = enabled
        ? orchestrator.enableTask(wakeType)
        : orchestrator.disableTask(wakeType);
      if (!success) {
        res.status(404).json({ error: 'Unknown task' });
        return;
      }
    }

    broadcastOrchestratorUpdate('schedule');
    const tasks = await orchestrator.getStatus();
    res.json({ success: true, tasks });
  } catch (error) {
    console.error('Error updating orchestrator task:', error);
    res.status(500).json({ error: 'Failed to update task' });
  }
});

// Get failsafe config
router.get('/orchestrator/failsafe', (req, res) => {
  try {
    const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
    if (!orchestrator) {
      res.status(503).json({ error: 'Orchestrator not available' });
      return;
    }
    res.json(orchestrator.getFailsafeConfig());
  } catch (error) {
    console.error('Error fetching failsafe config:', error);
    res.status(500).json({ error: 'Failed to fetch failsafe config' });
  }
});

// Update failsafe config
router.patch('/orchestrator/failsafe', (req, res) => {
  try {
    const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
    if (!orchestrator) {
      res.status(503).json({ error: 'Orchestrator not available' });
      return;
    }

    const { enabled, gentle, concerned, emergency } = req.body;
    orchestrator.setFailsafeConfig({ enabled, gentle, concerned, emergency });
    broadcastOrchestratorUpdate('schedule');
    res.json({ success: true, ...orchestrator.getFailsafeConfig() });
  } catch (error) {
    console.error('Error updating failsafe config:', error);
    res.status(500).json({ error: 'Failed to update failsafe config' });
  }
});

// --- Watchtower dial (session-authed browser pair) ---
// The /internal/orchestrator `watchtower_config` action is token-gated for the
// companion's curl tooling; these two give the Settings UI the same dial over
// the logged-in session. Thin wrappers over the orchestrator's get/set helpers.

// GET /api/orchestrator/watchtower → { mode, lastFiredDate }
router.get('/orchestrator/watchtower', (req, res) => {
  try {
    const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
    if (!orchestrator) {
      res.status(503).json({ error: 'Orchestrator not available' });
      return;
    }
    res.json(orchestrator.getWatchtowerConfig());
  } catch (error) {
    console.error('Error fetching watchtower config:', error);
    res.status(500).json({ error: 'Failed to fetch watchtower config' });
  }
});

// POST /api/orchestrator/watchtower — body { mode: 'auto' | 'quiet' | 'close' }
router.post('/orchestrator/watchtower', (req, res) => {
  try {
    const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
    if (!orchestrator) {
      res.status(503).json({ error: 'Orchestrator not available' });
      return;
    }
    const { mode } = req.body ?? {};
    const err = orchestrator.setWatchtowerMode(String(mode));
    if (err) {
      res.status(400).json({ error: err });
      return;
    }
    broadcastOrchestratorUpdate('watchtower');
    res.json({ success: true, ...orchestrator.getWatchtowerConfig() });
  } catch (error) {
    console.error('Error setting watchtower mode:', error);
    res.status(500).json({ error: 'Failed to set watchtower mode' });
  }
});

// Get active triggers
router.get('/orchestrator/triggers', (req, res) => {
  try {
    const kind = req.query.kind as 'impulse' | 'watcher' | undefined;
    const triggers = listTriggers(kind);
    res.json({ triggers });
  } catch (error) {
    console.error('Error fetching triggers:', error);
    res.status(500).json({ error: 'Failed to fetch triggers' });
  }
});

// Cancel a trigger
router.delete('/orchestrator/triggers/:id', (req, res) => {
  try {
    const cancelled = cancelTrigger(req.params.id);
    if (!cancelled) {
      res.status(404).json({ error: 'Trigger not found or already cancelled' });
      return;
    }
    broadcastOrchestratorUpdate('triggers');
    res.json({ success: true });
  } catch (error) {
    console.error('Error cancelling trigger:', error);
    res.status(500).json({ error: 'Failed to cancel trigger' });
  }
});

// Edit a live trigger (Settings watcher editor).
// Body: { label?, prompt?, cooldownMinutes?, status? }
// status is the pause dial only: 'paused' parks it, 'pending' resumes it.
// Conditions are read-only here — structural edits stay with the companion.
router.patch('/orchestrator/triggers/:id', (req, res) => {
  try {
    const { label, prompt, cooldownMinutes, status } = req.body ?? {};
    const fields: { label?: string; prompt?: string | null; cooldownMinutes?: number; status?: 'pending' | 'paused' } = {};

    if (label !== undefined) {
      if (typeof label !== 'string' || !label.trim()) {
        res.status(400).json({ error: 'label must be a non-empty string' });
        return;
      }
      fields.label = label.trim();
    }
    if (prompt !== undefined) {
      if (prompt !== null && typeof prompt !== 'string') {
        res.status(400).json({ error: 'prompt must be a string or null' });
        return;
      }
      fields.prompt = prompt === '' ? null : prompt;
    }
    if (cooldownMinutes !== undefined) {
      const n = Number(cooldownMinutes);
      if (!Number.isFinite(n) || n < 0 || n > 10080) {
        res.status(400).json({ error: 'cooldownMinutes must be 0–10080' });
        return;
      }
      fields.cooldownMinutes = Math.round(n);
    }
    if (status !== undefined) {
      if (status !== 'pending' && status !== 'paused') {
        res.status(400).json({ error: "status must be 'pending' or 'paused'" });
        return;
      }
      fields.status = status;
    }
    if (Object.keys(fields).length === 0) {
      res.status(400).json({ error: 'Nothing to update' });
      return;
    }

    const updated = updateTrigger(req.params.id, fields);
    if (!updated) {
      res.status(404).json({ error: 'Trigger not found or no longer live' });
      return;
    }
    broadcastOrchestratorUpdate('triggers');
    res.json({ success: true });
  } catch (error) {
    console.error('Error updating trigger:', error);
    res.status(500).json({ error: 'Failed to update trigger' });
  }
});

// List pending timers (for the Settings orchestrator panel — what the companion has set).
router.get('/orchestrator/timers', (req, res) => {
  try {
    const timers = listPendingTimers();
    res.json({ timers });
  } catch (error) {
    console.error('Error fetching timers:', error);
    res.status(500).json({ error: 'Failed to fetch timers' });
  }
});

// Cancel a timer
router.delete('/orchestrator/timers/:id', (req, res) => {
  try {
    const cancelled = cancelTimer(req.params.id);
    if (!cancelled) {
      res.status(404).json({ error: 'Timer not found or already cancelled' });
      return;
    }
    broadcastOrchestratorUpdate('timers');
    res.json({ success: true });
  } catch (error) {
    console.error('Error cancelling timer:', error);
    res.status(500).json({ error: 'Failed to cancel timer' });
  }
});

// Reschedule a live timer. Body: { fireAt: ISO datetime }.
// A 'waiting' timer goes back to 'pending' at the new time.
router.patch('/orchestrator/timers/:id', (req, res) => {
  try {
    const { fireAt } = req.body ?? {};
    if (typeof fireAt !== 'string' || Number.isNaN(Date.parse(fireAt))) {
      res.status(400).json({ error: 'fireAt must be a valid ISO datetime' });
      return;
    }
    const updated = rescheduleTimer(req.params.id, new Date(fireAt).toISOString());
    if (!updated) {
      res.status(404).json({ error: 'Timer not found or no longer live' });
      return;
    }
    broadcastOrchestratorUpdate('timers');
    res.json({ success: true });
  } catch (error) {
    console.error('Error rescheduling timer:', error);
    res.status(500).json({ error: 'Failed to reschedule timer' });
  }
});

// --- Orchestrator: frontend-callable combined surface ---
// The /internal/orchestrator route (above) is localhost-only for the companion's
// curl tooling. These /orchestrator routes are same-origin, auth-gated, and give
// the Settings UI one read endpoint + one write endpoint mirroring the internal
// actions. They reuse the same Orchestrator instance + methods.

// GET /api/orchestrator — combined health view for the Settings panel.
// Response: { tasks: OrchestratorTaskStatus[], pulse: {enabled,frequency},
//             failsafe: {enabled,gentle,concerned,emergency} }
// (tasks carry wakeType, label, cronExpr, enabled, status, nextRun, category.)
router.get('/orchestrator', async (req, res) => {
  try {
    const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
    if (!orchestrator) {
      res.status(503).json({ error: 'Orchestrator not available' });
      return;
    }
    const tasks = await orchestrator.getStatus();
    res.json({
      tasks,
      pulse: orchestrator.getPulseConfig(),
      failsafe: orchestrator.getFailsafeConfig(),
    });
  } catch (error) {
    console.error('Error fetching orchestrator overview:', error);
    res.status(500).json({ error: 'Failed to fetch orchestrator overview' });
  }
});

// POST /api/orchestrator — mirrors the internal action surface for the frontend.
// Body: { action, wakeType?, cronExpr?, label?, prompt?, enabled?,
//         gentle?, concerned?, emergency?, frequency? }
// Actions: status | enable | disable | reschedule | create_routine |
//          remove_routine | pulse_status | pulse_config | failsafe_status |
//          failsafe_config
router.post('/orchestrator', async (req, res) => {
  try {
    const orchestrator = req.app.locals.orchestrator as Orchestrator | undefined;
    if (!orchestrator) {
      res.status(503).json({ error: 'Orchestrator not available' });
      return;
    }

    const { action, wakeType, cronExpr, label, prompt, enabled, gentle, concerned, emergency, frequency, model, target } = req.body;

    switch (action) {
      case 'status': {
        const tasks = await orchestrator.getStatus();
        res.json({ tasks });
        return;
      }
      case 'enable': {
        if (!wakeType) { res.status(400).json({ error: 'wakeType required' }); return; }
        const ok = orchestrator.enableTask(wakeType);
        if (!ok) { res.status(404).json({ error: 'Unknown wake type' }); return; }
        broadcastOrchestratorUpdate('schedule');
        res.json({ success: true, wakeType, enabled: true });
        return;
      }
      case 'disable': {
        if (!wakeType) { res.status(400).json({ error: 'wakeType required' }); return; }
        const ok = orchestrator.disableTask(wakeType);
        if (!ok) { res.status(404).json({ error: 'Unknown wake type' }); return; }
        broadcastOrchestratorUpdate('schedule');
        res.json({ success: true, wakeType, enabled: false });
        return;
      }
      case 'reschedule': {
        if (!wakeType || !cronExpr) { res.status(400).json({ error: 'wakeType and cronExpr required' }); return; }
        const ok = orchestrator.rescheduleTask(wakeType, cronExpr);
        if (!ok) { res.status(400).json({ error: 'Failed — invalid cron or unknown wake type' }); return; }
        broadcastOrchestratorUpdate('schedule');
        res.json({ success: true, wakeType, cronExpr });
        return;
      }
      case 'create_routine': {
        if (!wakeType || !cronExpr || !label) { res.status(400).json({ error: 'wakeType, label, and cronExpr required' }); return; }
        const ok = orchestrator.addRoutine({ wakeType, label, cronExpr, prompt: prompt || `Custom routine: ${label}` });
        if (!ok) { res.status(400).json({ error: 'Failed — invalid cron, missing prompt, or wakeType already exists' }); return; }
        broadcastOrchestratorUpdate('schedule');
        res.json({ success: true, wakeType, label, cronExpr });
        return;
      }
      case 'remove_routine': {
        if (!wakeType) { res.status(400).json({ error: 'wakeType required' }); return; }
        const ok = orchestrator.removeRoutine(wakeType);
        if (!ok) { res.status(400).json({ error: 'Failed — unknown routine or cannot remove default task' }); return; }
        broadcastOrchestratorUpdate('schedule');
        res.json({ success: true, wakeType });
        return;
      }
      case 'set_schedule': {
        if (!wakeType || !cronExpr) { res.status(400).json({ error: 'wakeType and cronExpr required' }); return; }
        const err = orchestrator.setScheduleForWakeType({ wakeType, cronExpr, enabled, model, target });
        if (err) { res.status(400).json({ error: err }); return; }
        broadcastOrchestratorUpdate('schedule');
        res.json({ success: true, wakeType, cronExpr });
        return;
      }
      case 'pulse_status': {
        res.json(orchestrator.getPulseConfig());
        return;
      }
      case 'pulse_config': {
        orchestrator.setPulseConfig({ enabled, frequency });
        broadcastOrchestratorUpdate('schedule');
        res.json({ success: true, ...orchestrator.getPulseConfig() });
        return;
      }
      case 'failsafe_status': {
        res.json(orchestrator.getFailsafeConfig());
        return;
      }
      case 'failsafe_config': {
        orchestrator.setFailsafeConfig({ enabled, gentle, concerned, emergency });
        broadcastOrchestratorUpdate('schedule');
        res.json({ success: true, ...orchestrator.getFailsafeConfig() });
        return;
      }
      default:
        res.status(400).json({ error: 'Unknown action. Use: status, enable, disable, reschedule, create_routine, remove_routine, set_schedule, pulse_status, pulse_config, failsafe_status, failsafe_config' });
    }
  } catch (error) {
    console.error('Orchestrator frontend action error:', error);
    res.status(500).json({ error: 'Orchestrator operation failed' });
  }
});

// --- System health ---

// GET /api/system/status — health-dashboard payload for the Settings panel.
// Response: { uptimeSeconds, nodeVersion, env, dbOk, websocketClients,
//             agent: { model, presence, processing, queueDepth },
//             mcpServers: [{ name, status, error?, toolCount }] }
router.get('/system/status', (req, res) => {
  try {
    const cfg = getResonantConfig();
    const agentService = req.app.locals.agentService as AgentService | undefined;

    // DB health probe — cheap round-trip.
    let dbOk = false;
    try {
      getDb().prepare('SELECT 1').get();
      dbOk = true;
    } catch {
      dbOk = false;
    }

    const mcpServers = (agentService?.getMcpStatus() ?? []).map(s => ({
      name: s.name,
      status: s.status,
      error: s.error,
      toolCount: s.toolCount ?? 0,
    }));

    // DB stats — on-disk size + row counts. better-sqlite3 reads are synchronous
    // and cheap (COUNT(*) over indexed tables); safe inside the request handler.
    let dbStats: { fileSizeBytes: number | null; messages: number; threads: number } = {
      fileSizeBytes: null, messages: 0, threads: 0,
    };
    try {
      const dbPath = cfg.server.db_path;
      let fileSizeBytes: number | null = null;
      try { fileSizeBytes = statSync(dbPath).size; } catch { fileSizeBytes = null; }
      const msgRow = getDb().prepare('SELECT COUNT(*) as c FROM messages').get() as { c: number };
      const thrRow = getDb().prepare('SELECT COUNT(*) as c FROM threads').get() as { c: number };
      dbStats = { fileSizeBytes, messages: msgRow.c, threads: thrRow.c };
    } catch (statErr) {
      console.warn('Failed to read DB stats:', statErr instanceof Error ? statErr.message : statErr);
    }

    res.json({
      version: PACKAGE_VERSION,
      uptimeSeconds: Math.round(process.uptime()),
      nodeVersion: process.version,
      env: process.env.NODE_ENV || 'development',
      dbOk,
      dbStats,
      websocketClients: registry.getCount(),
      agent: {
        model: cfg.agent.model,
        modelAutonomous: cfg.agent.model_autonomous,
        presence: agentService?.getPresenceStatus() ?? 'offline',
        processing: agentService?.isProcessing() ?? false,
        queueDepth: agentService?.getQueueDepth() ?? 0,
      },
      mcpServers,
    });
  } catch (error) {
    console.error('Error fetching system status:', error);
    res.status(500).json({ error: 'Failed to fetch system status' });
  }
});

// GET /api/system/logs — tail the PM2 process logs for the Settings Logs panel.
// Auth-gated (sits after router.use(authMiddleware)). Read-only — surfaces only
// what's already on disk to the logged-in owner; never writes or clears.
//   ?lines=<1..5000>   how many lines to return (default 500)
//   ?q=<substring>     case-insensitive filter on the message text
//   ?source=out|err|all|house   which stream(s) (default all)
//
// source=house — the house log: the proprioception stream
// (companion_actions) rendered as a diary of what the companion's hands did. Rows map
// to the same line shape as the file tails: ts = created_at, text = "[kind]
// summary" so the viewer's [Tag] highlight tints the kind amber. Same lines/q
// params; q filters kind + summary together.
router.get('/system/logs', (req, res) => {
  try {
    const linesRaw = req.query.lines ? parseInt(String(req.query.lines), 10) : undefined;
    const lines = Number.isFinite(linesRaw) ? (linesRaw as number) : undefined;
    const q = req.query.q ? String(req.query.q) : undefined;
    const sourceRaw = String(req.query.source ?? 'all');

    if (sourceRaw === 'house') {
      const limit = Math.min(Math.max(lines ?? 500, 1), 5000);
      const rows = getDb()
        .prepare('SELECT kind, summary, created_at FROM companion_actions ORDER BY created_at DESC LIMIT ?')
        .all(5000) as Array<{ kind: string; summary: string; created_at: string }>;
      let mapped = rows.map(r => ({
        ts: r.created_at,
        source: 'house' as const,
        text: `[${r.kind}] ${r.summary}`,
      }));
      if (q && q.trim()) {
        const needle = q.trim().toLowerCase();
        mapped = mapped.filter(l => l.text.toLowerCase().includes(needle));
      }
      const truncated = mapped.length > limit;
      // Rows arrive newest-first; reverse the kept slice so the viewer reads
      // chronologically with the freshest entry at the tail, like the files.
      res.json({ lines: mapped.slice(0, limit).reverse(), truncated, present: { out: true, err: true } });
      return;
    }

    const source = (['out', 'err', 'all'].includes(sourceRaw) ? sourceRaw : 'all') as LogSourceFilter;
    res.json(readLogs({ lines, q, source }));
  } catch (error) {
    console.error('Error reading logs:', error);
    res.status(500).json({ error: 'Failed to read logs' });
  }
});

// POST /api/system/mcp/reconnect — re-probe a single named MCP server (re-ping
// its URL / refresh its status) and broadcast the new status to all clients.
// Per-server, by name. Reconnect/test only — does NOT enable/disable/delete.
router.post('/system/mcp/reconnect', async (req, res) => {
  try {
    const { name } = req.body as { name?: string };
    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name (MCP server name) is required' });
      return;
    }
    const agentService = req.app.locals.agentService as AgentService | undefined;
    if (!agentService) {
      res.status(503).json({ error: 'Agent service unavailable' });
      return;
    }
    const result = await agentService.reconnectMcpServer(name);
    if (!result.success) {
      res.status(502).json({ error: result.error || 'Reconnect failed' });
      return;
    }
    const servers = agentService.getMcpStatus();
    registry.broadcast({ type: 'mcp_status_updated', servers });
    res.json({ success: true, servers });
  } catch (error) {
    console.error('MCP reconnect error:', error);
    res.status(500).json({ error: 'MCP reconnect failed' });
  }
});

// --- Telegram gateway status ---

// GET /api/telegram/status — read-only gateway status for the Settings panel.
// Response: { enabled, connected, chatId, hasToken, configEnabled, stats? }
router.get('/telegram/status', (req, res) => {
  try {
    const telegramService = req.app.locals.telegramService as TelegramService | null;
    const configEnabled = getConfigBool('telegram.enabled', false);
    const hasToken = hasBotToken('telegram');
    const telegramConfig = getTelegramConfig();
    const chatId = telegramConfig.ownerChatId || null;

    if (!telegramService) {
      res.json({ enabled: false, connected: false, chatId, hasToken, configEnabled });
      return;
    }
    res.json({
      enabled: true,
      connected: telegramService.isConnected(),
      chatId,
      hasToken,
      configEnabled,
      stats: telegramService.getStats(),
    });
  } catch (error) {
    console.error('Error fetching Telegram status:', error);
    res.status(500).json({ error: 'Failed to fetch Telegram status' });
  }
});

// --- Discord admin endpoints ---

import { DiscordService } from '../services/discord/index.js';
import type { AgentService } from '../services/agent.js';
import { getActiveMessageId } from '../services/agent.js';
import { getTelegramConfig } from '../services/telegram/config.js';

router.get('/discord/status', (req, res) => {
  try {
    const discordService = req.app.locals.discordService as DiscordService | null;
    const configEnabled = getConfigBool('discord.enabled', false);
    const hasToken = hasBotToken('discord');
    if (!discordService) {
      res.json({ enabled: false, configEnabled, hasToken });
      return;
    }
    res.json({ enabled: true, configEnabled, hasToken, ...discordService.getStats() });
  } catch (error) {
    console.error('Error fetching Discord status:', error);
    res.status(500).json({ error: 'Failed to fetch Discord status' });
  }
});

router.post('/discord/toggle', async (req, res) => {
  try {
    const { enabled } = req.body as { enabled: boolean };
    const agentService = req.app.locals.agentService as AgentService;

    if (enabled) {
      // Start Discord gateway
      if (!hasBotToken('discord')) {
        res.status(400).json({ error: 'Discord bot token not set (Settings or DISCORD_BOT_TOKEN)' });
        return;
      }
      if (req.app.locals.discordService) {
        res.json({ success: true, message: 'Already running' });
        return;
      }
      const service = new DiscordService(agentService, registry);
      await service.start();
      req.app.locals.discordService = service;
      setConfig('discord.enabled', 'true');
      console.log('[Discord] Gateway enabled via settings toggle');
      res.json({ success: true, message: 'Discord gateway started' });
    } else {
      // Stop Discord gateway
      const service = req.app.locals.discordService as DiscordService | null;
      if (service) {
        await service.stop();
        req.app.locals.discordService = null;
      }
      setConfig('discord.enabled', 'false');
      console.log('[Discord] Gateway disabled via settings toggle');
      res.json({ success: true, message: 'Discord gateway stopped' });
    }
  } catch (error) {
    console.error('Error toggling Discord:', error);
    res.status(500).json({ error: 'Failed to toggle Discord gateway' });
  }
});

router.get('/discord/pairings', (req, res) => {
  try {
    const discordService = req.app.locals.discordService as DiscordService | null;
    if (!discordService) {
      res.json({ pending: [], approved: [] });
      return;
    }
    const pairing = discordService.getPairingService();
    res.json({
      pending: pairing.listPending(),
      approved: pairing.listApproved(),
    });
  } catch (error) {
    console.error('Error fetching pairings:', error);
    res.status(500).json({ error: 'Failed to fetch pairings' });
  }
});

router.post('/discord/pairings/:code/approve', (req, res) => {
  try {
    const discordService = req.app.locals.discordService as DiscordService | null;
    if (!discordService) {
      res.status(503).json({ error: 'Discord not enabled' });
      return;
    }
    const pairing = discordService.getPairingService();
    const result = pairing.approve(req.params.code, 'user');
    if (result.success) {
      res.json({ success: true, userId: result.userId });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error) {
    console.error('Error approving pairing:', error);
    res.status(500).json({ error: 'Failed to approve pairing' });
  }
});

// POST /discord/pairings/:code/deny — reject a pending pairing request by code.
router.post('/discord/pairings/:code/deny', (req, res) => {
  try {
    const discordService = req.app.locals.discordService as DiscordService | null;
    if (!discordService) {
      res.status(503).json({ error: 'Discord not enabled' });
      return;
    }
    const pairing = discordService.getPairingService();
    const result = pairing.deny(req.params.code);
    if (result.success) {
      res.json({ success: true, userId: result.userId });
    } else {
      res.status(400).json({ error: result.error });
    }
  } catch (error) {
    console.error('Error denying pairing:', error);
    res.status(500).json({ error: 'Failed to deny pairing' });
  }
});

router.delete('/discord/pairings/:userId', (req, res) => {
  try {
    const discordService = req.app.locals.discordService as DiscordService | null;
    if (!discordService) {
      res.status(503).json({ error: 'Discord not enabled' });
      return;
    }
    const pairing = discordService.getPairingService();
    const revoked = pairing.revoke(req.params.userId);
    res.json({ success: revoked });
  } catch (error) {
    console.error('Error revoking pairing:', error);
    res.status(500).json({ error: 'Failed to revoke pairing' });
  }
});

// --- Discord settings & rules admin ---

import { getDiscordConfig, getAllowedUsers, getAllowedGuilds, getActiveChannels } from '../services/discord/config.js';
import { getRulesData, saveRules, reloadRules } from '../services/discord/rules.js';
import type { ServerRule, ChannelRule, UserRule, RulesData } from '../services/discord/rules.js';

// GET /discord/settings — all config values
router.get('/discord/settings', (req, res) => {
  try {
    const config = getDiscordConfig();
    res.json({
      ...config,
      allowedUsers: [...getAllowedUsers()],
      allowedGuilds: [...getAllowedGuilds()],
      activeChannels: [...getActiveChannels()],
    });
  } catch (error) {
    console.error('Error fetching Discord settings:', error);
    res.status(500).json({ error: 'Failed to fetch settings' });
  }
});

// PUT /discord/settings — partial update of config values
router.put('/discord/settings', (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;

    // Map of setting keys to their DB config keys
    const settingsMap: Record<string, string> = {
      ownerUserId: 'discord.ownerUserId',
      requireMentionInGuilds: 'discord.requireMentionInGuilds',
      debounceMs: 'discord.debounceMs',
      pairingExpiryMs: 'discord.pairingExpiryMs',
      ownerActiveThresholdMin: 'discord.ownerActiveThresholdMin',
      deferPollIntervalMs: 'discord.deferPollIntervalMs',
      deferMaxAgeMs: 'discord.deferMaxAgeMs',
    };

    // Set-based settings (stored as comma-separated)
    const setSettingsMap: Record<string, string> = {
      allowedUsers: 'discord.allowedUsers',
      allowedGuilds: 'discord.allowedGuilds',
      activeChannels: 'discord.activeChannels',
    };

    let updated = 0;

    for (const [key, dbKey] of Object.entries(settingsMap)) {
      if (key in body) {
        setConfig(dbKey, String(body[key]));
        updated++;
      }
    }

    for (const [key, dbKey] of Object.entries(setSettingsMap)) {
      if (key in body) {
        const val = body[key];
        const str = Array.isArray(val) ? val.join(',') : String(val);
        setConfig(dbKey, str);
        updated++;
      }
    }

    // Return current state after update
    const config = getDiscordConfig();
    res.json({
      success: true,
      updated,
      ...config,
      allowedUsers: [...getAllowedUsers()],
      allowedGuilds: [...getAllowedGuilds()],
      activeChannels: [...getActiveChannels()],
    });
  } catch (error) {
    console.error('Error updating Discord settings:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// GET /discord/rules — full rules blob
router.get('/discord/rules', (req, res) => {
  try {
    res.json(getRulesData());
  } catch (error) {
    console.error('Error fetching Discord rules:', error);
    res.status(500).json({ error: 'Failed to fetch rules' });
  }
});

// PUT /discord/rules — full rules blob replace + reload
router.put('/discord/rules', (req, res) => {
  try {
    const data = req.body as RulesData;
    if (!data.servers || !data.channels || !data.users) {
      res.status(400).json({ error: 'Rules must have servers, channels, and users' });
      return;
    }
    saveRules(data);
    res.json({ success: true, ...getRulesData() });
  } catch (error) {
    console.error('Error saving Discord rules:', error);
    res.status(500).json({ error: 'Failed to save rules' });
  }
});

// POST /discord/rules/server — add/update one server rule
router.post('/discord/rules/server', (req, res) => {
  try {
    const rule = req.body as ServerRule;
    if (!rule.id || !rule.name) {
      res.status(400).json({ error: 'Server rule requires id and name' });
      return;
    }
    const data = getRulesData();
    data.servers[rule.id] = rule;
    saveRules(data);
    res.json({ success: true, rule });
  } catch (error) {
    console.error('Error saving server rule:', error);
    res.status(500).json({ error: 'Failed to save server rule' });
  }
});

// DELETE /discord/rules/server/:id
router.delete('/discord/rules/server/:id', (req, res) => {
  try {
    const data = getRulesData();
    if (!(req.params.id in data.servers)) {
      res.status(404).json({ error: 'Server rule not found' });
      return;
    }
    delete data.servers[req.params.id];
    saveRules(data);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting server rule:', error);
    res.status(500).json({ error: 'Failed to delete server rule' });
  }
});

// POST /discord/rules/channel — add/update one channel rule
router.post('/discord/rules/channel', (req, res) => {
  try {
    const rule = req.body as ChannelRule;
    if (!rule.id || !rule.name) {
      res.status(400).json({ error: 'Channel rule requires id and name' });
      return;
    }
    const data = getRulesData();
    data.channels[rule.id] = rule;
    saveRules(data);
    res.json({ success: true, rule });
  } catch (error) {
    console.error('Error saving channel rule:', error);
    res.status(500).json({ error: 'Failed to save channel rule' });
  }
});

// DELETE /discord/rules/channel/:id
router.delete('/discord/rules/channel/:id', (req, res) => {
  try {
    const data = getRulesData();
    if (!(req.params.id in data.channels)) {
      res.status(404).json({ error: 'Channel rule not found' });
      return;
    }
    delete data.channels[req.params.id];
    saveRules(data);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting channel rule:', error);
    res.status(500).json({ error: 'Failed to delete channel rule' });
  }
});

// POST /discord/rules/user — add/update one user rule
router.post('/discord/rules/user', (req, res) => {
  try {
    const rule = req.body as UserRule;
    if (!rule.id || !rule.name) {
      res.status(400).json({ error: 'User rule requires id and name' });
      return;
    }
    const data = getRulesData();
    data.users[rule.id] = rule;
    saveRules(data);
    res.json({ success: true, rule });
  } catch (error) {
    console.error('Error saving user rule:', error);
    res.status(500).json({ error: 'Failed to save user rule' });
  }
});

// DELETE /discord/rules/user/:id
router.delete('/discord/rules/user/:id', (req, res) => {
  try {
    const data = getRulesData();
    if (!(req.params.id in data.users)) {
      res.status(404).json({ error: 'User rule not found' });
      return;
    }
    delete data.users[req.params.id];
    saveRules(data);
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting user rule:', error);
    res.status(500).json({ error: 'Failed to delete user rule' });
  }
});

// --- Telegram gateway toggle (mirrors discord/toggle) ---

// POST /telegram/toggle — start/stop the Telegram gateway this session.
// Body: { enabled: boolean }. Token guarded BEFORE construction because the
// TelegramService constructor throws on a missing token.
router.post('/telegram/toggle', async (req, res) => {
  try {
    const { enabled } = req.body as { enabled: boolean };

    if (enabled) {
      // Guard FIRST — constructor throws if TELEGRAM_BOT_TOKEN is missing.
      if (!hasBotToken('telegram')) {
        res.status(400).json({ error: 'Telegram bot token not set (Settings or TELEGRAM_BOT_TOKEN)' });
        return;
      }
      if (req.app.locals.telegramService) {
        res.json({ success: true, message: 'Already running' });
        return;
      }
      const agentService = req.app.locals.agentService as AgentService;
      const voiceService = req.app.locals.voiceService as VoiceService;
      const service = new TelegramService(agentService, registry, voiceService);
      await service.start();
      req.app.locals.telegramService = service;
      setConfig('telegram.enabled', 'true');
      console.log('[Telegram] Gateway enabled via settings toggle');
      res.json({ success: true, message: 'Telegram gateway started' });
    } else {
      const service = req.app.locals.telegramService as TelegramService | null;
      if (service) {
        await service.stop();
        req.app.locals.telegramService = null;
      }
      setConfig('telegram.enabled', 'false');
      console.log('[Telegram] Gateway disabled via settings toggle');
      res.json({ success: true });
    }
  } catch (error) {
    console.error('Error toggling Telegram:', error);
    res.status(500).json({ error: 'Failed to toggle Telegram gateway' });
  }
});

// --- Channels config (Settings slice 1) ---

// GET /channels — thin aggregator over the two existing gateway services.
// Reads the SAME in-memory sources the per-platform status endpoints use (no
// internal HTTP calls). Always returns both summaries, order [discord, telegram].
router.get('/channels', (req, res) => {
  try {
    const d = req.app.locals.discordService as DiscordService | null;
    const dCfg = getDiscordConfig();
    const dStats = d ? d.getStats() : null;
    const discordSummary: ChannelSummary = {
      id: 'discord',
      tokenEnvVar: 'DISCORD_BOT_TOKEN',
      hasToken: hasBotToken('discord'),
      configEnabled: getConfigBool('discord.enabled', false),
      ownerId: dCfg.ownerUserId || null,
      enabled: !!d,
      connected: d?.isConnected() ?? false,
      username: dStats ? dStats.username : null,
      stats: dStats
        ? {
            messagesReceived: dStats.messagesReceived,
            messagesProcessed: dStats.messagesProcessed,
            errors: dStats.errors,
          }
        : null,
    };

    const t = req.app.locals.telegramService as TelegramService | null;
    const tCfg = getTelegramConfig();
    const tStats = t ? t.getStats() : null;
    const telegramSummary: ChannelSummary = {
      id: 'telegram',
      tokenEnvVar: 'TELEGRAM_BOT_TOKEN',
      hasToken: hasBotToken('telegram'),
      configEnabled: getConfigBool('telegram.enabled', false),
      ownerId: tCfg.ownerChatId || null,
      enabled: !!t,
      connected: t?.isConnected() ?? false,
      username: null, // telegram getStats() carries no username
      stats: tStats
        ? {
            messagesReceived: tStats.messagesReceived,
            messagesProcessed: tStats.messagesProcessed,
            errors: tStats.errors,
          }
        : null,
    };

    const response: ChannelsResponse = { channels: [discordSummary, telegramSummary] };
    res.json(response);
  } catch (error) {
    console.error('Error fetching channels:', error);
    res.status(500).json({ error: 'Failed to fetch channels' });
  }
});

// --- Bot token CRUD (session-authed; write-only) ---
//
// SECURITY: these endpoints accept a token to store (encrypted at rest) or clear
// it. They NEVER return the token value and NEVER log it. Status/read endpoints
// expose only the hasToken boolean. authMiddleware is explicit on each.

// PUT /api/discord/token — store the Discord bot token (encrypted).
router.put('/discord/token', authMiddleware, (req, res) => {
  try {
    const { token } = req.body as { token?: string };
    const trimmed = typeof token === 'string' ? token.trim() : '';
    if (!trimmed) {
      res.status(400).json({ error: 'token is required' });
      return;
    }
    if (trimmed.length > 500) {
      res.status(400).json({ error: 'token too long' });
      return;
    }
    saveBotToken('discord', trimmed);
    console.log('[Discord] Bot token saved (DB, encrypted)');
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving Discord token:', error);
    res.status(500).json({ error: 'Failed to save Discord token' });
  }
});

// DELETE /api/discord/token — clear the stored Discord bot token.
router.delete('/discord/token', authMiddleware, (_req, res) => {
  try {
    clearBotToken('discord');
    console.log('[Discord] Bot token cleared');
    res.status(204).end();
  } catch (error) {
    console.error('Error clearing Discord token:', error);
    res.status(500).json({ error: 'Failed to clear Discord token' });
  }
});

// PUT /api/telegram/token — store the Telegram bot token (encrypted).
router.put('/telegram/token', authMiddleware, (req, res) => {
  try {
    const { token } = req.body as { token?: string };
    const trimmed = typeof token === 'string' ? token.trim() : '';
    if (!trimmed) {
      res.status(400).json({ error: 'token is required' });
      return;
    }
    if (trimmed.length > 500) {
      res.status(400).json({ error: 'token too long' });
      return;
    }
    saveBotToken('telegram', trimmed);
    console.log('[Telegram] Bot token saved (DB, encrypted)');
    res.json({ success: true });
  } catch (error) {
    console.error('Error saving Telegram token:', error);
    res.status(500).json({ error: 'Failed to save Telegram token' });
  }
});

// DELETE /api/telegram/token — clear the stored Telegram bot token.
router.delete('/telegram/token', authMiddleware, (_req, res) => {
  try {
    clearBotToken('telegram');
    console.log('[Telegram] Bot token cleared');
    res.status(204).end();
  } catch (error) {
    console.error('Error clearing Telegram token:', error);
    res.status(500).json({ error: 'Failed to clear Telegram token' });
  }
});

// POST /channels/:id/test — unified per-channel connectivity test. Always 200
// with an { ok, message } flag; only unexpected failures 500.
router.post('/channels/:id/test', async (req, res) => {
  try {
    const id = req.params.id;
    if (id !== 'discord' && id !== 'telegram') {
      res.status(400).json({ error: 'unknown channel' });
      return;
    }

    if (id === 'discord') {
      const d = req.app.locals.discordService as DiscordService | null;
      if (!d) {
        const result: ChannelTestResult = { ok: false, message: 'gateway not running' };
        res.json(result);
        return;
      }
      if (!d.isConnected()) {
        const result: ChannelTestResult = { ok: false, message: 'not connected' };
        res.json(result);
        return;
      }
      const result: ChannelTestResult = { ok: true, message: 'connected as ' + (d.getStats().username ?? 'bot') };
      res.json(result);
      return;
    }

    // telegram
    const t = req.app.locals.telegramService as TelegramService | null;
    if (!t || !t.isConnected()) {
      const result: ChannelTestResult = { ok: false, message: 'gateway not running' };
      res.json(result);
      return;
    }
    try {
      const username = await t.getBotUsername();
      const result: ChannelTestResult = { ok: true, message: 'bot @' + username };
      res.json(result);
    } catch (e) {
      const result: ChannelTestResult = { ok: false, message: (e as Error).message };
      res.json(result);
    }
  } catch (error) {
    console.error('Error testing channel:', error);
    res.status(500).json({ error: 'Failed to test channel' });
  }
});

/** Call after loadConfig() to mount Command Center routes */
export async function initCcRoutes() {
  try {
    if (getResonantConfig().command_center.enabled) {
      const { default: ccRoutes } = await import('./cc-routes.js');
      router.use('/cc', ccRoutes);
    }
  } catch (e) {
    console.warn('[CC] Failed to mount Command Center routes:', (e as Error).message);
  }
}

export default router;
