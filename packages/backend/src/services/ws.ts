import { WebSocketServer, WebSocket } from 'ws';
import { IncomingMessage, Server as HTTPServer } from 'http';
import { parse as parseCookie } from 'cookie';
import crypto from 'crypto';
import type {
  ClientMessage,
  ServerMessage,
  Canvas,
  Thread,
  ThreadSummary,
} from '@resonant/shared';
import {
  getDb,
  getWebSession,
  createMessage,
  getMessages,
  markMessagesRead,
  listThreads,
  getThread,
  createThread,
  updateThreadActivity,
  getTodayThread,
  getCurrentDailyThread,
  createCanvas,
  getCanvas,
  listCanvases,
  updateCanvasContent,
  updateCanvasTitle,
  deleteCanvas,
  addReaction,
  removeReaction,
  pinThread,
  unpinThread,
  threadToSummary,
} from './db.js';
import { AgentService, getActiveMessageId } from './agent.js';
import { Orchestrator } from './orchestrator.js';
import type { VoiceService } from './voice.js';
import type { DiscordService } from './discord/index.js';
import type { TelegramService } from './telegram/index.js';
import { getResonantConfig } from '../config.js';
import { buildCommandRegistry, handleCommand } from './commands.js';

function getAllowedOrigins(): string[] {
  const config = getResonantConfig();
  const port = config.server.port;
  const origins = new Set<string>([
    'http://localhost:5173',
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
    'capacitor://localhost',
    'tauri://localhost',
  ]);
  for (const o of config.cors.origins) {
    origins.add(o);
  }
  return Array.from(origins);
}

const MAX_TEXT_MESSAGE_SIZE = 10 * 1024; // 10KB for text messages
const MAX_VOICE_MESSAGE_SIZE = 512 * 1024; // 512KB for voice audio chunks
const COOKIE_NAME = 'resonant_session';

interface ExtendedWebSocket extends WebSocket {
  isAlive: boolean;
  userId: string;
  voiceModeEnabled: boolean;
  audioChunks: Buffer[];
  isRecording: boolean;
  audioMimeType: string;
  deviceType: 'mobile' | 'desktop' | 'unknown';
  userAgent: string;
  tabVisible: boolean;
  messageCount: number;
  messageWindowStart: number;
  prosodyAbort: AbortController | null;
}

function parseDeviceType(ua: string): 'mobile' | 'desktop' | 'unknown' {
  if (!ua) return 'unknown';
  if (/iPhone|iPad|iPod|Android|Mobile|webOS|BlackBerry|Opera Mini|IEMobile/i.test(ua)) {
    return 'mobile';
  }
  if (/Mozilla|Chrome|Safari|Firefox|Edge|Opera/i.test(ua)) {
    return 'desktop';
  }
  return 'unknown';
}

class ConnectionRegistry {
  private connections = new Map<string, Set<ExtendedWebSocket>>();
  private _lastUserActivity: Date = new Date();
  private _lastUserWebActivity: Date = new Date(0);

  add(userId: string, ws: ExtendedWebSocket): void {
    if (!this.connections.has(userId)) {
      this.connections.set(userId, new Set());
    }
    this.connections.get(userId)!.add(ws);
    if (userId === 'user') {
      this._lastUserActivity = new Date();
      this._lastUserWebActivity = new Date();
    }
  }

  remove(userId: string, ws: ExtendedWebSocket): void {
    const userConnections = this.connections.get(userId);
    if (userConnections) {
      userConnections.delete(ws);
      if (userConnections.size === 0) {
        this.connections.delete(userId);
      }
    }
  }

  touchUserActivity(): void {
    this._lastUserActivity = new Date();
  }

  touchUserWebActivity(): void {
    this._lastUserWebActivity = new Date();
  }

  minutesSinceLastUserWebActivity(): number {
    return (Date.now() - this._lastUserWebActivity.getTime()) / 60000;
  }

  broadcast(message: ServerMessage): void {
    const messageStr = JSON.stringify(message);
    for (const connections of this.connections.values()) {
      for (const ws of connections) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(messageStr);
        }
      }
    }
  }

  broadcastExcept(excludeWs: WebSocket, message: ServerMessage): void {
    const messageStr = JSON.stringify(message);
    for (const connections of this.connections.values()) {
      for (const ws of connections) {
        if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
          ws.send(messageStr);
        }
      }
    }
  }

  getCount(): number {
    let count = 0;
    for (const connections of this.connections.values()) {
      count += connections.size;
    }
    return count;
  }

  hasConnections(): boolean {
    return this.getCount() > 0;
  }

  isUserConnected(): boolean {
    const userConns = this.connections.get('user');
    return !!userConns && userConns.size > 0;
  }

  getLastUserActivity(): Date {
    return this._lastUserActivity;
  }

  minutesSinceLastUserActivity(): number {
    return (Date.now() - this._lastUserActivity.getTime()) / 60000;
  }

  getConnectionsForUser(userId: string): ExtendedWebSocket[] {
    const conns = this.connections.get(userId);
    if (!conns) return [];
    return Array.from(conns).filter(ws => ws.readyState === WebSocket.OPEN);
  }

  getUserDeviceType(): 'mobile' | 'desktop' | 'unknown' {
    const conns = this.getConnectionsForUser('user');
    if (conns.length === 0) return 'unknown';
    // Return device type of most recent connection (last in set)
    return conns[conns.length - 1].deviceType;
  }

  isUserTabVisible(): boolean {
    const conns = this.getConnectionsForUser('user');
    return conns.some(c => c.tabVisible);
  }

  getUserPresenceState(): 'active' | 'idle' | 'offline' {
    if (!this.isUserConnected()) return 'offline';
    if (!this.isUserTabVisible()) return 'idle';
    if (this.minutesSinceLastUserActivity() < 5) return 'active';
    return 'idle';
  }
}

export const registry = new ConnectionRegistry();

function threadsToSummaries(threads: Thread[]): ThreadSummary[] {
  return threads.map(threadToSummary);
}

function sendError(ws: WebSocket, code: string, message: string): void {
  const msg: ServerMessage = { type: 'error', code, message };
  ws.send(JSON.stringify(msg));
}

let voiceServiceInstance: VoiceService | null = null;

export function setVoiceService(vs: VoiceService): void {
  voiceServiceInstance = vs;
}

export interface GatewayServices {
  discord?: DiscordService | null;
  telegram?: TelegramService | null;
}

let gatewayServices: GatewayServices = {};

export function setGatewayServices(services: GatewayServices): void {
  gatewayServices = services;
}

export function createWebSocketServer(server: HTTPServer, agentService?: AgentService, orchestrator?: Orchestrator): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  const agent = agentService ?? new AgentService();

  // Handle upgrade
  server.on('upgrade', (request: IncomingMessage, socket, head) => {
    const origin = request.headers.origin;
    const allowedOrigins = getAllowedOrigins();

    // Origin check — every connection must carry an allowed origin. (No loopback
    // origin-exemption: behind cloudflared, public WS upgrades arrive FROM
    // loopback, so a source-IP exemption is a bypass. The browser sends a real
    // Origin; reject anything not on the allowlist regardless of source IP.)
    if (!origin || !allowedOrigins.includes(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    // Session check — required UNCONDITIONALLY (not gated on a password being
    // set). Mirrors the HTTP authMiddleware fail-closed posture: read the
    // password + AUTH_DEV_OPEN fresh each upgrade (config is loaded once, but
    // env is read live) so an un-configured app cannot be reached over WS.
    const appPassword = getResonantConfig().auth.password;
    const devOpen = process.env.AUTH_DEV_OPEN === 'true';

    if (!appPassword) {
      // FAIL CLOSED: no password → no valid session can exist → reject, unless
      // the explicit local-dev escape hatch is on.
      if (!devOpen) {
        socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
        socket.destroy();
        return;
      }
    } else {
      const cookieHeader = request.headers.cookie;
      if (!cookieHeader) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const cookies = parseCookie(cookieHeader);
      const sessionToken = cookies[COOKIE_NAME];

      if (!sessionToken) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      const session = getWebSession(sessionToken);
      if (!session || new Date(session.expires_at) < new Date()) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  // Connection handler
  wss.on('connection', (ws: WebSocket, request: IncomingMessage) => {
    const extWs = ws as ExtendedWebSocket;
    extWs.isAlive = true;
    extWs.userId = 'user';
    extWs.voiceModeEnabled = false;
    extWs.audioChunks = [];
    extWs.isRecording = false;
    extWs.audioMimeType = 'audio/webm';
    extWs.userAgent = request.headers['user-agent'] || '';
    extWs.deviceType = parseDeviceType(extWs.userAgent);
    extWs.tabVisible = true;
    extWs.messageCount = 0;
    extWs.messageWindowStart = Date.now();
    extWs.prosodyAbort = null;

    registry.add(extWs.userId, extWs);

    // Send connected message with thread list and status.
    // Ensure today's daily thread exists so the Daily tab always resolves.
    const today = getCurrentDailyThread();
    const threads = listThreads({ includeArchived: false });

    const connectedMsg: ServerMessage = {
      type: 'connected',
      sessionStatus: agent.getPresenceStatus(),
      threads: threadsToSummaries(threads),
      activeThreadId: today?.id ?? null,
      commands: buildCommandRegistry(),
    };
    extWs.send(JSON.stringify(connectedMsg));

    // Send canvas list
    const canvases = listCanvases();
    if (canvases.length > 0) {
      const canvasListMsg: ServerMessage = { type: 'canvas_list', canvases };
      extWs.send(JSON.stringify(canvasListMsg));
    }

    // Heartbeat
    extWs.on('pong', () => {
      extWs.isAlive = true;
    });

    // Message handler
    extWs.on('message', async (data: Buffer) => {
      try {
        // Peek at message type for size limit selection
        const rawMessage = data.toString();
        let msgType: string | undefined;
        try {
          const peek = JSON.parse(rawMessage);
          msgType = peek?.type;
        } catch {
          sendError(extWs, 'invalid_message', 'Invalid JSON');
          return;
        }

        // Rate limit (120 msgs/min, exempt system messages)
        if (msgType !== 'pong' && msgType !== 'visibility') {
          const now = Date.now();
          if (now - extWs.messageWindowStart > 60000) {
            extWs.messageCount = 0;
            extWs.messageWindowStart = now;
          }
          extWs.messageCount++;
          if (extWs.messageCount > 120) {
            sendError(extWs, 'rate_limited', 'Too many messages');
            return;
          }
        }

        const maxSize = msgType === 'voice_audio' ? MAX_VOICE_MESSAGE_SIZE : MAX_TEXT_MESSAGE_SIZE;
        if (data.length > maxSize) {
          sendError(extWs, 'message_too_large', `Message exceeds ${maxSize / 1024}KB limit`);
          return;
        }

        const clientMsg = JSON.parse(rawMessage) as ClientMessage;

        switch (clientMsg.type) {
          case 'ping':
            extWs.send(JSON.stringify({ type: 'pong' }));
            break;
          case 'message':
            registry.touchUserActivity();
            registry.touchUserWebActivity();
            await handleMessageSend(clientMsg, extWs, agent);
            break;
          case 'sync':
            handleSync(clientMsg, extWs);
            break;
          case 'read':
            registry.touchUserActivity();
            registry.touchUserWebActivity();
            handleRead(clientMsg);
            break;
          case 'switch_thread':
            registry.touchUserActivity();
            registry.touchUserWebActivity();
            handleSwitchThread(clientMsg, extWs);
            break;
          case 'create_thread':
            registry.touchUserActivity();
            registry.touchUserWebActivity();
            handleCreateThread(clientMsg);
            break;
          case 'request_status':
            handleRequestStatus(extWs, agent, orchestrator);
            break;
          case 'voice_start':
            registry.touchUserActivity();
            registry.touchUserWebActivity();
            handleVoiceStart(extWs, clientMsg);
            break;
          case 'voice_audio':
            handleVoiceAudio(extWs, clientMsg);
            break;
          case 'voice_stop':
            registry.touchUserActivity();
            registry.touchUserWebActivity();
            await handleVoiceStop(extWs, agent);
            break;
          case 'voice_mode':
            handleVoiceMode(extWs, clientMsg);
            break;
          case 'voice_interrupt':
            // Client wants to stop TTS playback — no server action needed
            break;
          case 'canvas_create':
            registry.touchUserActivity();
            registry.touchUserWebActivity();
            handleCanvasCreate(clientMsg, extWs);
            break;
          case 'canvas_update':
            registry.touchUserActivity();
            registry.touchUserWebActivity();
            handleCanvasUpdate(clientMsg, extWs);
            break;
          case 'canvas_update_title':
            registry.touchUserActivity();
            registry.touchUserWebActivity();
            handleCanvasUpdateTitle(clientMsg, extWs);
            break;
          case 'canvas_delete':
            registry.touchUserActivity();
            registry.touchUserWebActivity();
            handleCanvasDelete(clientMsg, extWs);
            break;
          case 'canvas_list':
            handleCanvasList(extWs);
            break;
          case 'add_reaction':
            registry.touchUserActivity();
            registry.touchUserWebActivity();
            handleAddReaction(clientMsg, extWs);
            break;
          case 'remove_reaction':
            registry.touchUserActivity();
            registry.touchUserWebActivity();
            handleRemoveReaction(clientMsg, extWs);
            break;
          case 'pin_thread':
            registry.touchUserActivity();
            registry.touchUserWebActivity();
            handlePinThread(clientMsg);
            break;
          case 'unpin_thread':
            registry.touchUserActivity();
            registry.touchUserWebActivity();
            handleUnpinThread(clientMsg);
            break;
          case 'visibility':
            extWs.tabVisible = clientMsg.visible;
            break;
          case 'stop_generation':
            agent.stopGeneration();
            break;
          case 'mcp_reconnect': {
            const result = await agent.reconnectMcpServer(clientMsg.serverName);
            if (result.success) {
              registry.broadcast({ type: 'mcp_status_updated', servers: agent.getMcpStatus() });
            } else {
              sendError(extWs, 'mcp_error', result.error || 'Reconnect failed');
            }
            break;
          }
          case 'mcp_toggle': {
            const result = await agent.toggleMcpServer(clientMsg.serverName, clientMsg.enabled);
            if (result.success) {
              registry.broadcast({ type: 'mcp_status_updated', servers: agent.getMcpStatus() });
            } else {
              sendError(extWs, 'mcp_error', result.error || 'Toggle failed');
            }
            break;
          }
          case 'rewind_files': {
            const result = await agent.rewindFiles(clientMsg.userMessageId, clientMsg.dryRun);
            const rewindMsg: import('@resonant/shared').ServerMessage = {
              type: 'rewind_result',
              canRewind: result.canRewind,
              filesChanged: result.filesChanged,
              insertions: result.insertions,
              deletions: result.deletions,
              error: result.error,
            };
            extWs.send(JSON.stringify(rewindMsg));
            break;
          }
          case 'command': {
            registry.touchUserActivity();
            registry.touchUserWebActivity();
            const cmdResult = await handleCommand(
              clientMsg.name,
              clientMsg.args,
              clientMsg.threadId,
              { agent, orchestrator, registry },
            );
            extWs.send(JSON.stringify(cmdResult));

            // If command created/renamed a thread, broadcast updated list
            if (clientMsg.name === 'new' || clientMsg.name === 'rename') {
              const updatedThreads = listThreads({ includeArchived: false });
              registry.broadcast({ type: 'thread_list', threads: threadsToSummaries(updatedThreads) });
            }
            break;
          }
          default:
            console.warn('Unhandled message type:', (clientMsg as any).type);
        }
      } catch (error) {
        console.error('Error processing WebSocket message:', error);
        sendError(extWs, 'invalid_message', 'Invalid message format');
      }
    });

    extWs.on('close', () => {
      if (extWs.prosodyAbort) {
        extWs.prosodyAbort.abort();
        extWs.prosodyAbort = null;
      }
      registry.remove(extWs.userId, extWs);
    });

    extWs.on('error', (error) => {
      console.error('WebSocket error:', error);
    });
  });

  // Heartbeat interval — terminate dead connections every 30s
  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
      const extWs = ws as ExtendedWebSocket;
      if (!extWs.isAlive) {
        return extWs.terminate();
      }
      extWs.isAlive = false;
      extWs.ping();
    });
  }, 30000);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });

  return wss;
}

// --- Handlers ---

async function handleMessageSend(
  msg: Extract<ClientMessage, { type: 'message' }>,
  ws: ExtendedWebSocket,
  agentService: AgentService
): Promise<void> {
  const now = new Date().toISOString();
  const config = getResonantConfig();

  // Resolve thread
  let thread: Thread | null = null;
  if (msg.threadId) {
    thread = getThread(msg.threadId);
  } else {
    // No explicit thread → today's deterministic daily thread (get-or-create).
    thread = getCurrentDailyThread();
  }

  if (!thread) {
    sendError(ws, 'thread_not_found', 'Thread not found');
    return;
  }

  // Normalize any attachments into a stable on-message shape BEFORE persisting.
  // The frontend bubble reads `message.metadata.attachments` to render
  // thumbnails / audio players / file chips, so the persisted user message must
  // carry the attachment array in a predictable form that survives reload (it is
  // stored in the message's metadata JSON column and replayed by
  // GET /api/threads/:id/messages). We keep all other metadata (e.g. prosody) intact.
  const rawAttachments = (msg.metadata as any)?.attachments as Array<{
    fileId: string; filename?: string; mimeType?: string; size?: number;
    url?: string; contentType?: string;
  }> | undefined;

  let persistMetadata: Record<string, unknown> | undefined = msg.metadata;
  if (rawAttachments && rawAttachments.length > 0) {
    const normalizedAttachments = rawAttachments.map(a => ({
      fileId: a.fileId,
      filename: a.filename ?? '',
      // contentType is the render kind the bubble switches on: image | audio | file
      contentType: (a.contentType as 'image' | 'audio' | 'file') ?? 'file',
      url: a.url ?? `/api/files/${a.fileId}`,
      ...(a.mimeType ? { mimeType: a.mimeType } : {}),
      ...(typeof a.size === 'number' ? { size: a.size } : {}),
    }));
    persistMetadata = { ...(msg.metadata as Record<string, unknown>), attachments: normalizedAttachments };
  }

  // Store user's message
  const userMessage = createMessage({
    id: crypto.randomUUID(),
    threadId: thread.id,
    role: 'user',
    content: msg.content,
    contentType: msg.contentType || 'text',
    metadata: persistMetadata,
    replyToId: msg.replyToId,
    createdAt: now,
  });

  // Mark as delivered + read (companion's system received it and will process it)
  getDb().prepare('UPDATE messages SET delivered_at = ?, read_at = ? WHERE id = ?').run(now, now, userMessage.id);
  userMessage.delivered_at = now;
  userMessage.read_at = now;

  updateThreadActivity(thread.id, now, false);

  // Broadcast user's message to all devices (with delivery/read status)
  registry.broadcast({ type: 'message', message: userMessage });

  // Build agent prompt
  let agentPrompt = msg.content;

  // Attachments to surface to the model via a filepath note (+ Read tool),
  // resolved from uploaded fileIds inside the agent. Populated in the attachment
  // branches below; passed to processMessage which folds the path note into the
  // agent prompt. contentType rides along so the note labels image/audio/file.
  const agentImages: Array<{ fileId: string; filename?: string; contentType?: 'image' | 'audio' | 'file' }> = [];

  // Check for batched attachments (multiple files sent together)
  const batchAttachments = (msg.metadata as any)?.attachments as Array<{
    fileId: string; filename: string; mimeType: string; size: number;
    url: string; contentType: 'image' | 'audio' | 'file';
  }> | undefined;

  // Voice messages carry their recorded audio as an attachment for inline
  // playback, but the agent prompt must stay the spoken transcript (+prosody) —
  // NOT be rewritten into "X sent an audio file" framing. Detect and skip the
  // file-prompt rebuild for voice; the attachment is still persisted above.
  const isVoiceMessage = (msg.metadata as any)?.source === 'voice';

  if (batchAttachments && batchAttachments.length > 0 && !isVoiceMessage) {
    // NOTE: attachments are persisted on the parent user message's
    // metadata.attachments (normalized above) — the bubble renders them inline
    // from there. We deliberately do NOT create separate per-file messages
    // (that would double-render once the bubble reads metadata.attachments).

    // ALL attachment kinds (image / audio / file) are surfaced to the model the
    // same way: a filepath note injected into the agent prompt by
    // buildAttachmentNote (see agent.ts), pointing at each file's absolute
    // on-disk path with an instruction to Read it. We just collect the fileIds +
    // their kind here; the agent resolves the real paths and builds the note.
    for (const a of batchAttachments) {
      agentImages.push({ fileId: a.fileId, filename: a.filename, contentType: a.contentType });
    }

    // The agent prompt itself is just the user's typed message (or empty). The path
    // note is appended downstream — keeping it out of agentPrompt means it never
    // leaks into the persisted/displayed user message.
    agentPrompt = msg.content?.trim() ?? '';
  } else {
    // Single message (no batch) — handle non-text content types. Like the batch
    // path, image / audio / file all flow through the same filepath note: we push
    // the fileId + kind into agentImages and let buildAttachmentNote (agent.ts)
    // resolve the absolute path and tell the agent to Read it. agentPrompt stays
    // the user's typed message (or empty) so the path note never leaks into their bubble.
    const ct = msg.contentType || 'text';
    if (ct !== 'text' && msg.metadata) {
      const meta = msg.metadata as Record<string, unknown>;
      const fileId = meta.fileId as string | undefined;
      const filename = meta.filename as string | undefined;

      if (fileId && (ct === 'image' || ct === 'audio' || ct === 'file')) {
        agentImages.push({ fileId, filename, contentType: ct });
        agentPrompt = msg.content?.trim() ?? '';
      }
    }
  }

  // Prepend prosody tone context if present
  if (msg.metadata && typeof msg.metadata === 'object') {
    const prosody = (msg.metadata as Record<string, unknown>).prosody as Record<string, number> | undefined;
    if (prosody && Object.keys(prosody).length > 0) {
      const toneEntries = Object.entries(prosody)
        .map(([emotion, score]) => `${emotion}: ${score}`)
        .join(', ');
      agentPrompt = `[Voice tone — ${toneEntries}]\n${agentPrompt}`;
    }
  }

  // Process through agent — agent service handles streaming, DB storage, and broadcasting
  try {
    const agentResponse = await agentService.processMessage(
      thread.id,
      agentPrompt,
      { name: thread.name, type: thread.type },
      agentImages.length > 0 ? { images: agentImages } : undefined,
    );
    updateThreadActivity(thread.id, new Date().toISOString(), true);

    // Auto-TTS: stream voice to any user connection with voice mode enabled
    const hasVoice = voiceServiceInstance?.canTTS;
    const responseLen = agentResponse?.length ?? 0;
    console.log(`[Voice] Auto-TTS check: hasVoice=${hasVoice}, responseLen=${responseLen}`);

    if (hasVoice && agentResponse) {
      const voiceConnections = registry.getConnectionsForUser('user')
        .filter(c => (c as ExtendedWebSocket).voiceModeEnabled);

      console.log(`[Voice] Voice mode connections: ${voiceConnections.length}`);

      if (voiceConnections.length > 0) {
        // Extract text for TTS from the agent response
        const ttsText = typeof agentResponse === 'string' ? agentResponse : String(agentResponse);
        if (ttsText.trim()) {
          console.log(`[Voice] Generating TTS for ${ttsText.length} chars`);
          const messageId = crypto.randomUUID();
          generateAndStreamTTS(ttsText, messageId, voiceConnections as ExtendedWebSocket[]).catch(err => {
            console.error('[Voice] Auto-TTS error:', err);
          });
        }
      }
    }
  } catch (error) {
    console.error('Agent processing error:', error);
    sendError(ws, 'agent_error', `${config.identity.companion_name} encountered an error processing your message`);
  }
}

function handleSync(
  msg: Extract<ClientMessage, { type: 'sync' }>,
  ws: ExtendedWebSocket
): void {
  // Fetch messages after the last seen sequence
  const messages = getMessages({
    threadId: msg.threadId,
    limit: 200,
  });

  // Filter to only messages after lastSeenSequence
  const missed = messages.filter(m => m.sequence > msg.lastSeenSequence);

  const response: ServerMessage = {
    type: 'sync_response',
    messages: missed,
  };
  ws.send(JSON.stringify(response));
}

function handleRead(
  msg: Extract<ClientMessage, { type: 'read' }>
): void {
  markMessagesRead(msg.threadId, msg.beforeId, new Date().toISOString());

  registry.broadcast({
    type: 'unread_update',
    threadId: msg.threadId,
    count: 0,
  });
}

function handleSwitchThread(
  msg: Extract<ClientMessage, { type: 'switch_thread' }>,
  ws: ExtendedWebSocket
): void {
  const messages = getMessages({ threadId: msg.threadId, limit: 50 });

  // Send messages as sync_response (same shape — batch of messages)
  const response: ServerMessage = {
    type: 'sync_response',
    messages,
  };
  ws.send(JSON.stringify(response));
}

function handleCreateThread(
  msg: Extract<ClientMessage, { type: 'create_thread' }>
): void {
  const thread = createThread({
    // No id → createThread derives `slug(name)-shortId()` (unique, readable).
    name: msg.name,
    type: 'named',
    createdAt: new Date().toISOString(),
    sessionType: 'v2',
  });

  registry.broadcast({ type: 'thread_created', thread });
}

async function handleRequestStatus(
  ws: ExtendedWebSocket,
  agent: AgentService,
  orchestrator?: Orchestrator
): Promise<void> {
  const mem = process.memoryUsage();
  const orchestratorTasks = orchestrator ? await orchestrator.getStatus() : [];
  const status: import('@resonant/shared').SystemStatus = {
    uptime: process.uptime(),
    memoryUsage: { rss: mem.rss, heapUsed: mem.heapUsed, heapTotal: mem.heapTotal },
    connections: registry.getCount(),
    userConnected: registry.isUserConnected(),
    minutesSinceActivity: registry.minutesSinceLastUserActivity(),
    presence: agent.getPresenceStatus(),
    agentProcessing: agent.isProcessing(),
    orchestratorTasks,
    mcpServers: agent.getMcpStatus(),
    queryQueue: { processing: agent.isProcessing(), depth: agent.getQueueDepth() },
  };

  // Append gateway stats if available
  if (gatewayServices.discord) {
    const ds = gatewayServices.discord.getStats();
    status.discord = {
      connected: ds.connected,
      guilds: ds.guilds,
      messagesProcessed: ds.messagesProcessed,
      errors: ds.errors,
      deferredPending: ds.deferredPending,
      username: ds.username,
    };
  }
  if (gatewayServices.telegram) {
    const ts = gatewayServices.telegram.getStats();
    status.telegram = {
      connected: ts.connected,
      messagesProcessed: ts.messagesProcessed,
      errors: ts.errors,
      restarts: ts.restarts,
    };
  }

  const msg: import('@resonant/shared').ServerMessage = { type: 'system_status', status };
  ws.send(JSON.stringify(msg));
}

// --- Voice handlers ---

function handleVoiceStart(
  ws: ExtendedWebSocket,
  _msg: Extract<ClientMessage, { type: 'voice_start' }>
): void {
  ws.audioChunks = [];
  ws.isRecording = true;
  // The mimeType will be inferred from the first audio chunk or set by client
}

function handleVoiceAudio(
  ws: ExtendedWebSocket,
  msg: Extract<ClientMessage, { type: 'voice_audio' }>
): void {
  if (!ws.isRecording) return;
  const chunk = Buffer.from(msg.data, 'base64');
  ws.audioChunks.push(chunk);
}

async function handleVoiceStop(ws: ExtendedWebSocket, agentService: AgentService): Promise<void> {
  ws.isRecording = false;

  if (ws.audioChunks.length === 0) {
    const statusMsg: ServerMessage = {
      type: 'transcription_status',
      status: 'error',
      error: 'No audio data received',
    };
    ws.send(JSON.stringify(statusMsg));
    return;
  }

  // Notify client that transcription is processing
  const processingMsg: ServerMessage = {
    type: 'transcription_status',
    status: 'processing',
  };
  ws.send(JSON.stringify(processingMsg));

  // Concatenate all chunks
  const audioBuffer = Buffer.concat(ws.audioChunks);
  ws.audioChunks = []; // Free memory

  if (!voiceServiceInstance?.canTranscribe) {
    const errorMsg: ServerMessage = {
      type: 'transcription_status',
      status: 'error',
      error: 'Transcription not configured — set GROQ_API_KEY in .env',
    };
    ws.send(JSON.stringify(errorMsg));
    return;
  }

  try {
    // Abort any previous prosody analysis and create new controller
    if (ws.prosodyAbort) ws.prosodyAbort.abort();
    const prosodyAbort = new AbortController();
    ws.prosodyAbort = prosodyAbort;

    // Fire Whisper + Hume in parallel — prosody is enrichment, not critical path
    const [transcript, prosody] = await Promise.all([
      voiceServiceInstance.transcribe(audioBuffer, ws.audioMimeType),
      voiceServiceInstance.canAnalyzeProsody
        ? voiceServiceInstance.analyzeProsody(audioBuffer, ws.audioMimeType, prosodyAbort.signal).catch(err => {
            if (err?.name === 'AbortError') return null;
            console.warn('[Voice] Prosody analysis failed (continuing):', err);
            return null;
          })
        : Promise.resolve(null),
    ]);

    ws.prosodyAbort = null;

    if (!transcript.trim()) {
      const emptyMsg: ServerMessage = {
        type: 'transcription_status',
        status: 'error',
        error: 'No speech detected',
      };
      ws.send(JSON.stringify(emptyMsg));
      return;
    }

    if (prosody) {
      console.log(`[Voice] Prosody detected: ${JSON.stringify(prosody)}`);
    }

    const completeMsg: ServerMessage = {
      type: 'transcription_status',
      status: 'complete',
      text: transcript,
      ...(prosody && { prosody }),
    };
    ws.send(JSON.stringify(completeMsg));

    // Route the transcript into the agent as a normal user message.
    // Reuses handleMessageSend so the transcript is stored, broadcast, and
    // (in voice mode) auto-TTS'd back — identical to a typed message.
    // Prosody rides in metadata so the voice-tone prepend in handleMessageSend fires.
    // the user's voice is STT-only by design — the recording is NOT embedded as audio.
    const voiceMetadata: Record<string, unknown> = { source: 'voice' };
    if (prosody) voiceMetadata.prosody = prosody;

    const voiceMessage: Extract<ClientMessage, { type: 'message' }> = {
      type: 'message',
      threadId: '', // empty → handleMessageSend resolves today's thread
      content: transcript,
      contentType: 'text',
      metadata: voiceMetadata,
    };
    await handleMessageSend(voiceMessage, ws, agentService);
  } catch (error) {
    console.error('[Voice] Transcription error:', error);
    const errorMsg: ServerMessage = {
      type: 'transcription_status',
      status: 'error',
      error: error instanceof Error ? error.message : 'Transcription failed',
    };
    ws.send(JSON.stringify(errorMsg));
  }
}

function handleVoiceMode(
  ws: ExtendedWebSocket,
  msg: Extract<ClientMessage, { type: 'voice_mode' }>
): void {
  ws.voiceModeEnabled = msg.enabled;
  console.log(`[Voice] Voice mode ${msg.enabled ? 'enabled' : 'disabled'} for connection`);

  const ackMsg: ServerMessage = {
    type: 'voice_mode_ack',
    enabled: msg.enabled,
  };
  ws.send(JSON.stringify(ackMsg));
}

// --- Canvas handlers ---

function handleCanvasCreate(
  msg: Extract<ClientMessage, { type: 'canvas_create' }>,
  ws: ExtendedWebSocket
): void {
  const now = new Date().toISOString();
  const messageId = msg.threadId ? getActiveMessageId(msg.threadId) : null;
  const canvas = createCanvas({
    id: crypto.randomUUID(),
    threadId: msg.threadId || undefined,
    messageId,
    title: msg.title,
    contentType: msg.contentType || 'markdown',
    language: msg.language || undefined,
    createdBy: 'user',
    createdAt: now,
  });

  registry.broadcast({ type: 'canvas_created', canvas });
}

function handleCanvasUpdate(
  msg: Extract<ClientMessage, { type: 'canvas_update' }>,
  ws: ExtendedWebSocket
): void {
  const canvas = getCanvas(msg.canvasId);
  if (!canvas) {
    sendError(ws, 'canvas_not_found', 'Canvas not found');
    return;
  }

  const now = new Date().toISOString();
  // baseVersion is the version the client loaded. Absent = legacy client,
  // unconditional write (still bumps the version).
  const result = updateCanvasContent(msg.canvasId, msg.content, now, msg.baseVersion);
  if (!result.ok) {
    if (result.reason === 'not_found') {
      sendError(ws, 'canvas_not_found', 'Canvas not found');
    } else {
      // Stale write refused. Hand the sender the current canvas so it can
      // reload without losing the text it tried to save.
      const conflict: ServerMessage = { type: 'canvas_conflict', canvasId: msg.canvasId, canvas: result.canvas };
      ws.send(JSON.stringify(conflict));
    }
    return;
  }

  // Broadcast to everyone except the sender (avoids cursor jump)
  registry.broadcastExcept(ws, {
    type: 'canvas_updated',
    canvasId: msg.canvasId,
    content: msg.content,
    updatedAt: now,
    version: result.version,
  });
  // The sender learns its new version so its next save is not seen as stale.
  const saved: ServerMessage = { type: 'canvas_saved', canvasId: msg.canvasId, version: result.version };
  ws.send(JSON.stringify(saved));
}

function handleCanvasUpdateTitle(
  msg: Extract<ClientMessage, { type: 'canvas_update_title' }>,
  ws: ExtendedWebSocket
): void {
  const canvas = getCanvas(msg.canvasId);
  if (!canvas) {
    sendError(ws, 'canvas_not_found', 'Canvas not found');
    return;
  }

  const now = new Date().toISOString();
  updateCanvasTitle(msg.canvasId, msg.title, now);

  // Broadcast full canvas_created-like update isn't needed; clients can track title locally
  // But we need to notify other clients
  registry.broadcastExcept(ws, {
    type: 'canvas_updated',
    canvasId: msg.canvasId,
    content: canvas.content, // keep content unchanged
    updatedAt: now,
  });
}

function handleCanvasDelete(
  msg: Extract<ClientMessage, { type: 'canvas_delete' }>,
  ws: ExtendedWebSocket
): void {
  const deleted = deleteCanvas(msg.canvasId);
  if (!deleted) {
    sendError(ws, 'canvas_not_found', 'Canvas not found');
    return;
  }

  registry.broadcast({ type: 'canvas_deleted', canvasId: msg.canvasId });
}

function handleCanvasList(ws: ExtendedWebSocket): void {
  const canvases = listCanvases();
  const msg: ServerMessage = { type: 'canvas_list', canvases };
  ws.send(JSON.stringify(msg));
}

// --- Reaction handlers ---

function handleAddReaction(
  msg: Extract<ClientMessage, { type: 'add_reaction' }>,
  ws: ExtendedWebSocket
): void {
  addReaction(msg.messageId, msg.emoji, 'user');
  const now = new Date().toISOString();
  registry.broadcast({
    type: 'message_reaction_added',
    messageId: msg.messageId,
    emoji: msg.emoji,
    user: 'user',
    createdAt: now,
  });
}

function handleRemoveReaction(
  msg: Extract<ClientMessage, { type: 'remove_reaction' }>,
  ws: ExtendedWebSocket
): void {
  removeReaction(msg.messageId, msg.emoji, 'user');
  registry.broadcast({
    type: 'message_reaction_removed',
    messageId: msg.messageId,
    emoji: msg.emoji,
    user: 'user',
  });
}

// --- Pin/Unpin handlers ---

function handlePinThread(
  msg: Extract<ClientMessage, { type: 'pin_thread' }>
): void {
  pinThread(msg.threadId);
  const thread = getThread(msg.threadId);
  if (thread) {
    registry.broadcast({
      type: 'thread_updated',
      thread: threadToSummary(thread),
    });
  }
}

function handleUnpinThread(
  msg: Extract<ClientMessage, { type: 'unpin_thread' }>
): void {
  unpinThread(msg.threadId);
  const thread = getThread(msg.threadId);
  if (thread) {
    registry.broadcast({
      type: 'thread_updated',
      thread: threadToSummary(thread),
    });
  }
}

async function generateAndStreamTTS(
  text: string,
  messageId: string,
  connections: ExtendedWebSocket[]
): Promise<void> {
  if (!voiceServiceInstance) return;

  // Notify clients TTS is starting
  const startMsg = JSON.stringify({ type: 'tts_start', messageId } satisfies ServerMessage);
  for (const ws of connections) {
    if (ws.readyState === WebSocket.OPEN) ws.send(startMsg);
  }

  try {
    const audioBuffer = await voiceServiceInstance.generateTTS(text);
    const base64 = audioBuffer.toString('base64');

    // Send audio data — single chunk for now (streaming can be added later)
    const audioMsg = JSON.stringify({
      type: 'tts_audio',
      messageId,
      data: base64,
      final: true,
    } satisfies ServerMessage);

    for (const ws of connections) {
      if (ws.readyState === WebSocket.OPEN) ws.send(audioMsg);
    }
  } catch (error) {
    console.error('[Voice] TTS generation error:', error);
  }

  // Notify clients TTS is done
  const endMsg = JSON.stringify({ type: 'tts_end', messageId } satisfies ServerMessage);
  for (const ws of connections) {
    if (ws.readyState === WebSocket.OPEN) ws.send(endMsg);
  }
}
