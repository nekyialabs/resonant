import { create } from 'zustand';
import type {
  ServerMessage,
  ClientMessage,
  Message,
  ThreadSummary,
  PresenceStatus,
  CommandRegistryEntry,
  Section,
  Canvas,
} from '@resonant/shared';

// ─── Types ───────────────────────────────────────────────────────────────────

export type ConnectionState = 'connected' | 'disconnecting' | 'disconnected' | 'reconnecting';

export type CanvasSaveResult =
  | { status: 'saved'; version: number }
  | { status: 'conflict'; canvas: Canvas }
  | { status: 'failed' };

export interface ToolEvent {
  toolId: string;
  toolName: string;
  input?: string;
  output?: string;
  isError?: boolean;
  isComplete: boolean;
  timestamp: string;
  elapsed?: number;
}

export interface ThinkingEvent {
  /** Stable id from the WS event — used for update-in-place. */
  id: string;
  content: string;
  summary: string;
  textOffset: number;
  isComplete: boolean;
}

// ─── Live timeline entry (during streaming) ───────────────────────────────────
// Unified ordered list of thinking blocks and tool calls as they arrive,
// interleaved by textOffset so the accordion can render them chronologically.

export interface ThinkingEntry {
  kind: 'thinking';
  id: string;
  content: string;
  summary: string;
  textOffset: number;
  isComplete: boolean;
}

export interface ToolEntry {
  kind: 'tool';
  toolId: string;
  toolName: string;
  input?: string;
  output?: string;
  isError?: boolean;
  textOffset: number;
  isComplete: boolean;
  elapsed?: number;
}

export type TimelineEntry = ThinkingEntry | ToolEntry;

// ─── WebSocket URL ────────────────────────────────────────────────────────────

function getWsUrl(): string {
  if (typeof window === 'undefined') return '';
  // In dev: connect straight to the backend — browser Origin localhost:5173
  // is in the backend's CORS allow list for dev mode.
  // In prod: served from the same origin as the backend.
  if (import.meta.env.DEV) {
    return 'ws://127.0.0.1:3099';
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}`;
}

function getReconnectDelay(attempt: number): number {
  const delays = [500, 1000, 2000, 4000, 8000, 15000, 30000];
  return delays[Math.min(attempt, delays.length - 1)];
}

// ─── Voice / transcription types ─────────────────────────────────────────────

export type TranscriptionStatus = 'idle' | 'processing' | 'complete' | 'error';

export interface TranscriptionState {
  status: TranscriptionStatus;
  text: string | null;
  error: string | null;
}

// ─── Store shape ──────────────────────────────────────────────────────────────

interface ChatStore {
  // Connection
  ws: WebSocket | null;
  connectionState: ConnectionState;
  reconnectAttempt: number;
  lastError: { code: string; message: string } | null;
  pendingMessages: Array<{ threadId: string; content: string; contentType: string; replyToId?: string; metadata?: Record<string, unknown> }>;

  // Data
  messages: Message[];
  threads: ThreadSummary[];
  sections: Section[];
  activeThreadId: string | null;
  presence: PresenceStatus;
  commands: CommandRegistryEntry[];

  // Streaming
  streamingMessageId: string | null;
  streamingTokens: string;
  /** Smoothed display text — drip-fed at CHARS_PER_FRAME per animation frame.
   *  Components that render the in-flight bubble read this, not streamingTokens. */
  displayedTokens: string;
  toolEvents: Record<string, ToolEvent[]>;
  toolOffsets: Record<string, Array<{ toolId: string; textOffset: number }>>;
  thinkingEvents: Record<string, ThinkingEvent[]>;
  /** Unified interleaved timeline for the current streaming message.
   *  Ordered by textOffset. Updated-in-place by id/toolId.
   *  Reset on stream_start, frozen (dropped) on stream_end. */
  timelineEntries: TimelineEntry[];

  // Sequence tracking for sync
  lastSeenSequence: number;

  // Voice / transcription
  transcription: TranscriptionState;

  // Canvas panel
  threadCanvases: Canvas[];
  /** Unsaved text whose save was refused as stale after its editor had already
   *  closed. Reopening that canvas shows it in the conflict notice. */
  canvasDrafts: Record<string, string>;
  setCanvasDraft: (id: string, text: string | null) => void;
  openCanvasId: string | null;

  // Context usage (from context_usage server events)
  contextUsage: { percentage: number; tokensUsed: number; contextWindow: number } | null;

  // Actions
  connect: () => void;
  disconnect: () => void;
  send: (msg: ClientMessage) => void;
  loadThread: (threadId: string) => Promise<void>;
  clearError: () => void;
  setActiveThreadId: (id: string | null) => void;
  clearTranscription: () => void;
  openCanvas: (id: string) => void;
  closeCanvas: () => void;
  /** baseVersion = the canvas version the edit was based on (a number, or a
   *  getter evaluated when the save actually runs; defaults to the
   *  store's current copy). Resolves 'conflict' when someone else saved first;
   *  the store then holds the latest server copy and the caller still has the
   *  user's text, so nothing is lost. */
  updateCanvas: (id: string, patch: Partial<Pick<Canvas, 'title' | 'content'>>, baseVersion?: number | (() => number | undefined)) => Promise<CanvasSaveResult>;
  // Thread management
  renameThread: (id: string, name: string) => Promise<void>;
  archiveThread: (id: string) => Promise<void>;
  deleteThread: (id: string) => Promise<void>;
  reorderThreads: (orderedIds: string[]) => Promise<void>;
  moveThreadToSection: (threadId: string, sectionId: string | null) => Promise<void>;
  // Section management
  fetchSections: () => Promise<void>;
  createSection: (name: string) => Promise<void>;
  renameSection: (id: string, name: string) => Promise<void>;
  deleteSection: (id: string) => Promise<void>;
  toggleSectionCollapse: (id: string, collapsed: boolean) => Promise<void>;
  reorderSections: (orderedIds: string[]) => Promise<void>;
}

// ─── Internal timer refs (outside store to avoid Zustand serialization issues) ─

let _ws: WebSocket | null = null;
let _reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
let _heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let _heartbeatTimeout: ReturnType<typeof setTimeout> | null = null;

// ─── RAF coalescing for timeline updates ──────────────────────────────────────
// During streaming, thinking deltas arrive at high frequency. We coalesce
// store → render updates into a single RAF frame so the list doesn't
// thrash on every token. _pendingTimeline holds the next snapshot; the RAF
// callback flushes it into Zustand in one set() call.
let _rafId: number | null = null;
let _pendingTimeline: TimelineEntry[] | null = null;
// Late-bound setState injected after store creation — avoids forward reference issue.
let _setTimelineState: ((entries: TimelineEntry[]) => void) | null = null;

function scheduleTimelineFlush(entries: TimelineEntry[]) {
  _pendingTimeline = entries;
  if (_rafId !== null) return; // already scheduled — the next frame will pick up latest
  _rafId = requestAnimationFrame(() => {
    _rafId = null;
    if (_pendingTimeline !== null && _setTimelineState) {
      _setTimelineState(_pendingTimeline);
      _pendingTimeline = null;
    }
  });
}

// ─── Token rate-smoothing buffer ─────────────────────────────────────────────
// WS delivers token deltas at irregular network-burst cadence. We smooth the
// reveal by drip-feeding characters at a capped rate per animation frame,
// so the user sees an even ~240 chars/s flow rather than network-shaped bursts.
//
// _tokenBuffer  = latest cumulative text from the WS (truth)
// _tokenRafId   = running rAF for the drip loop (null = not scheduled)
// displayedTokens is kept in the Zustand store so React renders it.
let _tokenBuffer: string = '';
let _tokenRafId: number | null = null;
// Late-bound setter — injected after store creation.
let _setDisplayedTokens: ((t: string) => void) | null = null;

const CHARS_PER_FRAME_NORMAL = 4;   // ~240 chars/s at 60fps
const CHARS_PER_FRAME_CATCHUP = 8;  // adaptive: used when falling behind by >120 chars

function scheduleTokenFlush() {
  if (_tokenRafId !== null) return; // already running
  _tokenRafId = requestAnimationFrame(function drip() {
    _tokenRafId = null;
    if (!_setDisplayedTokens) return;
    // Read the current displayedTokens directly from the store
    const current = useChatStore.getState().displayedTokens;
    const delta = _tokenBuffer.slice(current.length);
    if (delta.length === 0) return; // caught up — stop

    const release = delta.length > 120 ? CHARS_PER_FRAME_CATCHUP : CHARS_PER_FRAME_NORMAL;
    const next = current + delta.slice(0, release);
    _setDisplayedTokens(next);

    // If still behind, schedule next frame
    if (next.length < _tokenBuffer.length) {
      _tokenRafId = requestAnimationFrame(drip);
    }
  });
}

function cancelTokenFlush() {
  if (_tokenRafId !== null) {
    cancelAnimationFrame(_tokenRafId);
    _tokenRafId = null;
  }
}

function clearTimers() {
  if (_reconnectTimeout) { clearTimeout(_reconnectTimeout); _reconnectTimeout = null; }
  if (_heartbeatInterval) { clearInterval(_heartbeatInterval); _heartbeatInterval = null; }
  if (_heartbeatTimeout) { clearTimeout(_heartbeatTimeout); _heartbeatTimeout = null; }
}

function startHeartbeat(sendFn: (msg: ClientMessage) => void) {
  _heartbeatInterval = setInterval(() => {
    if (_ws?.readyState === WebSocket.OPEN) {
      sendFn({ type: 'ping' });
      _heartbeatTimeout = setTimeout(() => {
        console.warn('[resonant] Heartbeat timeout — closing socket');
        _ws?.close();
      }, 5000);
    }
  }, 30000);
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useChatStore = create<ChatStore>((set, get) => {

  function sendRaw(msg: ClientMessage) {
    if (_ws?.readyState === WebSocket.OPEN) {
      _ws.send(JSON.stringify(msg));
    } else if (msg.type === 'message') {
      set(s => ({
        pendingMessages: [...s.pendingMessages, {
          threadId: msg.threadId,
          content: msg.content,
          contentType: msg.contentType,
          // Preserve attachments + reply context. A send queued during a
          // reconnect (routine on mobile, and right after a server restart)
          // must NOT be silently downgraded to plain text — that was the
          // image-send bug: metadata.attachments got dropped here.
          ...(msg.replyToId ? { replyToId: msg.replyToId } : {}),
          ...(msg.metadata ? { metadata: msg.metadata } : {}),
        }],
      }));
      console.warn('[resonant] Message queued — will send on reconnect');
    }
  }

  function handleMessage(event: MessageEvent) {
    let m: ServerMessage;
    try { m = JSON.parse(event.data as string); }
    catch { return; }

    const state = get();

    switch (m.type) {
      case 'pong':
        if (_heartbeatTimeout) { clearTimeout(_heartbeatTimeout); _heartbeatTimeout = null; }
        break;

      case 'connected': {
        const threads = m.threads ?? [];
        // If no active thread yet, create one automatically
        const activeThreadId = m.activeThreadId
          ?? (threads.length > 0 ? threads[0].id : null);

        set({
          threads,
          presence: m.sessionStatus,
          commands: m.commands ?? [],
          // Only set if we don't already have one (reconnect protection)
          ...(state.activeThreadId ? {} : { activeThreadId }),
        });

        // Load messages for whatever thread is ACTUALLY active now (after the
        // reconnect-protected set above) — prefer the preserved activeThreadId
        // over the payload's, so a reconnect while a (possibly empty) NEW named
        // thread is open never clobbers it back to the daily/first thread.
        const reconnectTarget = get().activeThreadId;
        if (reconnectTarget && !state.messages.length) {
          get().loadThread(reconnectTarget);
        } else if (reconnectTarget) {
          // Reconnect with messages already in state: the `sync` round-trip
          // only backfills NEW messages (sequence > lastSeenSequence), but
          // broadcasts that mutate already-seen messages — reactions, edits,
          // deletes — carry no sequence and were silently lost while the
          // socket was down (a phone PWA's socket dies seconds after
          // backgrounding, which is exactly when companion reactions land).
          // Re-fetch the active page and merge those fields in place.
          void refreshMessageState(reconnectTarget);
        }
        // Fetch sections independently — not bundled in the connected payload
        void get().fetchSections();
        break;
      }

      case 'thread_created': {
        const t = m.thread;
        const summary: ThreadSummary = {
          id: t.id,
          name: t.name,
          type: t.type,
          unread_count: 0,
          last_activity_at: t.created_at,
          last_message_preview: null,
          pinned_at: null,
          archived_at: null,
          // position: new threads go to the front (position 0, will be reconciled by backend)
          position: 0,
          // model/effort/show_thinking added to Thread by parallel backend agent;
          // may be absent on older protocol messages — default to null/true.
          model: (t as unknown as { model?: string | null }).model ?? null,
          effort: (t as unknown as { effort?: string | null }).effort as ThreadSummary['effort'] ?? null,
          show_thinking: (t as unknown as { show_thinking?: boolean }).show_thinking ?? true,
          section_id: (t as unknown as { section_id?: string | null }).section_id ?? null,
        };
        set(s => ({
          threads: [summary, ...s.threads],
          activeThreadId: s.activeThreadId ?? t.id,
        }));
        // Load messages for this thread
        get().loadThread(t.id);
        break;
      }

      case 'message': {
        const msg = m.message;
        if (msg.thread_id === state.activeThreadId) {
          set(s => ({ messages: [...s.messages, msg] }));
        }
        if (msg.sequence > state.lastSeenSequence) {
          set({ lastSeenSequence: msg.sequence });
        }
        // Update thread preview
        set(s => ({
          threads: s.threads.map(t =>
            t.id === msg.thread_id
              ? { ...t, last_message_preview: msg.content.substring(0, 100), last_activity_at: msg.created_at }
              : t
          ),
        }));
        break;
      }

      case 'stream_start':
        // Multi-client guard: only adopt a stream that belongs to the thread THIS
        // client is viewing. Streams broadcast to every connection, but the streaming
        // slot (streamingMessageId) + RAF/token buffers are single & global. Without
        // this gate, another device sending on a different thread hijacks the slot and
        // its reply renders live in this view, then vanishes at stream_end (which IS
        // thread-gated). Ignoring foreign stream_start leaves the slot null so its
        // tokens/thinking/tool events (keyed on streamingMessageId) are silently dropped.
        if (m.threadId !== state.activeThreadId) break;
        // Cancel any pending RAF flush from a previous stream
        if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
        _pendingTimeline = null;
        // Reset token smoothing buffer
        cancelTokenFlush();
        _tokenBuffer = '';
        set({
          streamingMessageId: m.messageId,
          streamingTokens: '',
          displayedTokens: '',
          timelineEntries: [],
        });
        break;

      case 'stream_token':
        // CRITICAL: token is CUMULATIVE — assign, not append
        if (get().streamingMessageId === m.messageId) {
          set({ streamingTokens: m.token });
          // Update the buffer and kick off the drip loop (idempotent if already running)
          _tokenBuffer = m.token;
          scheduleTokenFlush();
        }
        break;

      case 'stream_end': {
        const { streamingMessageId, thinkingEvents, toolOffsets } = get();
        if (m.final && m.final.thread_id === state.activeThreadId) {
          set(s => ({ messages: [...s.messages, m.final as Message] }));
        }
        // Cancel any pending RAF flush
        if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
        _pendingTimeline = null;
        // Cancel token drip and flush remaining buffer so final text is complete
        cancelTokenFlush();
        // Clean up streaming state
        const newThinking = { ...thinkingEvents };
        const newOffsets = { ...toolOffsets };
        if (streamingMessageId) {
          delete newThinking[streamingMessageId];
          delete newOffsets[streamingMessageId];
        }
        set({
          streamingMessageId: null,
          streamingTokens: '',
          displayedTokens: '',
          thinkingEvents: newThinking,
          toolOffsets: newOffsets,
          timelineEntries: [],
        });
        _tokenBuffer = '';
        break;
      }

      case 'presence':
        set({ presence: m.status });
        break;

      case 'thinking': {
        const mid = get().streamingMessageId;
        if (mid) {
          // 1. Update the legacy thinkingEvents map (kept for compat with
          //    MessageBubble's existing ThinkingBlock rendering path)
          //    — upsert by id (deltas share the same id)
          set(s => {
            const existing = s.thinkingEvents[mid] ?? [];
            const idx = existing.findIndex(e => e.id === m.id);
            let updated: ThinkingEvent[];
            if (idx >= 0) {
              updated = existing.map((e, i) =>
                i === idx ? { ...e, content: m.content, summary: m.summary, isComplete: m.isComplete } : e
              );
            } else {
              updated = [...existing, {
                id: m.id,
                content: m.content,
                summary: m.summary,
                textOffset: m.textOffset,
                isComplete: m.isComplete,
              }];
            }
            return { thinkingEvents: { ...s.thinkingEvents, [mid]: updated } };
          });

          // 2. Upsert into the unified timeline — RAF-coalesced
          const currentEntries = get().timelineEntries;
          const tidx = currentEntries.findIndex(e => e.kind === 'thinking' && e.id === m.id);
          let nextEntries: TimelineEntry[];
          if (tidx >= 0) {
            nextEntries = currentEntries.map((e, i) =>
              i === tidx
                ? { ...(e as ThinkingEntry), content: m.content, summary: m.summary, isComplete: m.isComplete }
                : e
            );
          } else {
            // Insert in textOffset order
            const entry: ThinkingEntry = {
              kind: 'thinking',
              id: m.id,
              content: m.content,
              summary: m.summary,
              textOffset: m.textOffset,
              isComplete: m.isComplete,
            };
            nextEntries = [...currentEntries, entry].sort((a, b) => a.textOffset - b.textOffset);
          }
          scheduleTimelineFlush(nextEntries);
        }
        break;
      }

      case 'tool_use': {
        const mid = get().streamingMessageId;
        if (mid) {
          set(s => ({
            toolEvents: {
              ...s.toolEvents,
              [mid]: [...(s.toolEvents[mid] ?? []), {
                toolId: m.toolId,
                toolName: m.toolName,
                input: m.input,
                isComplete: m.isComplete,
                timestamp: new Date().toISOString(),
              }],
            },
            ...(m.textOffset !== undefined ? {
              toolOffsets: {
                ...s.toolOffsets,
                [mid]: [...(s.toolOffsets[mid] ?? []), { toolId: m.toolId, textOffset: m.textOffset }],
              },
            } : {}),
          }));

          // Also upsert into unified timeline
          const textOffset = m.textOffset ?? get().streamingTokens.length;
          const currentEntries = get().timelineEntries;
          const tidx = currentEntries.findIndex(e => e.kind === 'tool' && e.toolId === m.toolId);
          let nextEntries: TimelineEntry[];
          if (tidx >= 0) {
            nextEntries = currentEntries.map((e, i) =>
              i === tidx ? { ...(e as ToolEntry), input: m.input, isComplete: m.isComplete } : e
            );
          } else {
            const entry: ToolEntry = {
              kind: 'tool',
              toolId: m.toolId,
              toolName: m.toolName,
              input: m.input,
              textOffset,
              isComplete: m.isComplete,
            };
            nextEntries = [...currentEntries, entry].sort((a, b) => a.textOffset - b.textOffset);
          }
          scheduleTimelineFlush(nextEntries);
        }
        break;
      }

      case 'tool_result': {
        const mid = get().streamingMessageId;
        if (mid) {
          set(s => ({
            toolEvents: {
              ...s.toolEvents,
              [mid]: (s.toolEvents[mid] ?? []).map(e =>
                e.toolId === m.toolId
                  ? { ...e, output: m.output, isError: m.isError, isComplete: true }
                  : e
              ),
            },
          }));

          // Mirror into timeline
          const currentEntries = get().timelineEntries;
          const tidx = currentEntries.findIndex(e => e.kind === 'tool' && e.toolId === m.toolId);
          if (tidx >= 0) {
            const nextEntries = currentEntries.map((e, i) =>
              i === tidx ? { ...(e as ToolEntry), output: m.output, isError: m.isError, isComplete: true } : e
            );
            scheduleTimelineFlush(nextEntries);
          }
        }
        break;
      }

      case 'tool_progress': {
        const mid = get().streamingMessageId;
        if (mid) {
          set(s => ({
            toolEvents: {
              ...s.toolEvents,
              [mid]: (s.toolEvents[mid] ?? []).map(e =>
                e.toolId === m.toolId ? { ...e, elapsed: m.elapsed } : e
              ),
            },
          }));

          // Mirror elapsed into timeline
          const currentEntries = get().timelineEntries;
          const tidx = currentEntries.findIndex(e => e.kind === 'tool' && e.toolId === m.toolId);
          if (tidx >= 0) {
            const nextEntries = currentEntries.map((e, i) =>
              i === tidx ? { ...(e as ToolEntry), elapsed: m.elapsed } : e
            );
            scheduleTimelineFlush(nextEntries);
          }
        }
        break;
      }

      case 'transcription_status': {
        if (m.status === 'processing') {
          set({ transcription: { status: 'processing', text: null, error: null } });
        } else if (m.status === 'complete') {
          set({ transcription: { status: 'complete', text: m.text ?? null, error: null } });
        } else if (m.status === 'error') {
          set({ transcription: { status: 'error', text: null, error: m.error ?? 'Transcription failed' } });
        }
        break;
      }

      // voice_audio (server TTS streaming) and tts_* are handled by the
      // per-message playback layer in MessageBubble via the window listener bus.
      // The store doesn't need to buffer audio blobs.
      case 'voice_audio':
      case 'tts_start':
      case 'tts_audio':
      case 'tts_end':
        // routed to window listeners below
        break;

      case 'generation_stopped':
        if (_rafId !== null) { cancelAnimationFrame(_rafId); _rafId = null; }
        _pendingTimeline = null;
        cancelTokenFlush();
        _tokenBuffer = '';
        set({ streamingMessageId: null, streamingTokens: '', displayedTokens: '', timelineEntries: [] });
        break;

      case 'thread_list':
        // Sort by position (lower = higher), recency as tiebreaker
        set({
          threads: [...m.threads].sort((a, b) => {
            if (a.position !== b.position) return a.position - b.position;
            const ta = a.last_activity_at ?? '';
            const tb = b.last_activity_at ?? '';
            return tb.localeCompare(ta);
          }),
        });
        break;

      case 'section_list':
        set({
          sections: [...m.sections].sort((a, b) => a.position - b.position),
        });
        break;

      case 'thread_updated': {
        const incoming = m.thread as ThreadSummary;
        // If the thread is now archived, remove it from the sidebar list
        if (incoming.archived_at) {
          set(s => {
            const threads = s.threads.filter(t => t.id !== incoming.id);
            const newActive = s.activeThreadId === incoming.id
              ? (threads.find(t => t.type === 'daily')?.id ?? threads[0]?.id ?? null)
              : s.activeThreadId;
            return {
              threads,
              activeThreadId: newActive,
              messages: s.activeThreadId === incoming.id ? [] : s.messages,
            };
          });
        } else {
          set(s => ({
            threads: s.threads.map(t => {
              if (t.id !== incoming.id) return t;
              return {
                ...t,
                name: incoming.name,
                pinned_at: incoming.pinned_at,
                position: incoming.position !== undefined ? incoming.position : t.position,
                section_id: incoming.section_id !== undefined ? incoming.section_id : t.section_id,
                model: incoming.model !== undefined ? incoming.model : t.model,
                effort: incoming.effort !== undefined ? incoming.effort : t.effort,
                show_thinking: incoming.show_thinking !== undefined ? incoming.show_thinking : t.show_thinking,
              };
            }),
          }));
        }
        break;
      }

      case 'thread_deleted':
        set(s => {
          const threads = s.threads.filter(t => t.id !== m.threadId);
          const newActive = s.activeThreadId === m.threadId
            ? (threads.find(t => t.type === 'daily')?.id ?? threads[0]?.id ?? null)
            : s.activeThreadId;
          return { threads, activeThreadId: newActive, messages: s.activeThreadId === m.threadId ? [] : s.messages };
        });
        break;

      case 'sync_response':
        if (m.messages.length > 0) {
          set(s => {
            const existingIds = new Set(s.messages.map(msg => msg.id));
            const newMsgs = m.messages.filter(msg => !existingIds.has(msg.id));
            if (!newMsgs.length) return s;
            const merged = [...s.messages, ...newMsgs].sort((a, b) => a.sequence - b.sequence);
            const last = merged[merged.length - 1];
            return { messages: merged, lastSeenSequence: Math.max(s.lastSeenSequence, last.sequence) };
          });
        }
        break;

      case 'error':
        console.error(`[resonant] Server error [${m.code}]: ${m.message}`);
        set({ lastError: { code: m.code, message: m.message } });
        setTimeout(() => set({ lastError: null }), 10000);
        break;

      case 'message_edited':
        set(s => ({
          messages: s.messages.map(msg =>
            msg.id === m.messageId ? { ...msg, content: m.newContent, edited_at: m.editedAt } : msg
          ),
        }));
        break;

      case 'message_deleted':
        // Hard delete (e.g. regenerate replacing a response) → splice the message
        // out entirely for a clean replace. Soft delete (user delete) → tombstone
        // it in place ("This message was deleted").
        set(s => (
          m.hard
            ? { messages: s.messages.filter(msg => msg.id !== m.messageId) }
            : {
                messages: s.messages.map(msg =>
                  msg.id === m.messageId ? { ...msg, deleted_at: new Date().toISOString() } : msg
                ),
              }
        ));
        break;

      case 'message_reaction_added': {
        // Reactions live in metadata.reactions: Array<{ emoji, user, created_at }>
        set(s => ({
          messages: s.messages.map(msg => {
            if (msg.id !== m.messageId) return msg;
            const existing = (msg.metadata ?? {}) as Record<string, unknown>;
            const reactions = Array.isArray(existing.reactions)
              ? [...existing.reactions]
              : [];
            // Deduplicate — same emoji+user combo
            const already = reactions.some(
              (r: Record<string, unknown>) => r.emoji === m.emoji && r.user === m.user
            );
            if (already) return msg;
            return {
              ...msg,
              metadata: {
                ...existing,
                reactions: [...reactions, { emoji: m.emoji, user: m.user, created_at: m.createdAt }],
              },
            };
          }),
        }));
        break;
      }

      case 'message_reaction_removed': {
        set(s => ({
          messages: s.messages.map(msg => {
            if (msg.id !== m.messageId) return msg;
            const existing = (msg.metadata ?? {}) as Record<string, unknown>;
            if (!Array.isArray(existing.reactions)) return msg;
            return {
              ...msg,
              metadata: {
                ...existing,
                reactions: (existing.reactions as Array<Record<string, unknown>>).filter(
                  r => !(r.emoji === m.emoji && r.user === m.user)
                ),
              },
            };
          }),
        }));
        break;
      }

      case 'context_usage':
        set({
          contextUsage: {
            percentage: m.percentage,
            tokensUsed: m.tokensUsed,
            contextWindow: m.contextWindow,
          },
        });
        break;

      case 'compaction_notice':
        // Not displayed in first-light; ignore
        break;

      case 'canvas_created': {
        const canvas = m.canvas;
        const activeThreadId = get().activeThreadId;
        // Only add to threadCanvases if this canvas belongs to the active thread.
        // thread_id === null means it was created outside a thread (e.g. from /canvas
        // library route) — don't auto-open in the chat panel.
        if (canvas.thread_id !== null && canvas.thread_id === activeThreadId) {
          set(s => {
            // Dedupe — broadcast may race with the REST fetch on loadThread
            const alreadyHave = s.threadCanvases.some(c => c.id === canvas.id);
            const next = alreadyHave
              ? s.threadCanvases.map(c => c.id === canvas.id ? canvas : c)
              : [...s.threadCanvases, canvas];
            return { threadCanvases: next, openCanvasId: canvas.id };
          });
        }
        break;
      }

      case 'canvas_updated': {
        // Protocol sends canvasId + content + updatedAt + optional title (not full Canvas)
        set(s => {
          const next = s.threadCanvases.map(c => {
            if (c.id !== m.canvasId) return c;
            return {
              ...c,
              content: m.content,
              updated_at: m.updatedAt,
              // max(): our own save's broadcast can arrive after a newer response
              version: Math.max(c.version ?? 0, m.version ?? 0),
              ...(m.title !== undefined ? { title: m.title } : {}),
            };
          });
          return { threadCanvases: next };
        });
        break;
      }

      case 'canvas_saved': {
        set(s => ({
          threadCanvases: s.threadCanvases.map(c =>
            c.id === m.canvasId ? { ...c, version: Math.max(c.version ?? 0, m.version) } : c
          ),
        }));
        break;
      }

      case 'canvas_conflict': {
        // A WS save was refused as stale: adopt the server's latest copy.
        set(s => ({
          threadCanvases: s.threadCanvases.map(c => (c.id === m.canvasId ? m.canvas : c)),
        }));
        break;
      }

      case 'canvas_deleted': {
        set(s => {
          const next = s.threadCanvases.filter(c => c.id !== m.canvasId);
          const stillOpen = s.openCanvasId === m.canvasId ? null : s.openCanvasId;
          return { threadCanvases: next, openCanvasId: stillOpen };
        });
        break;
      }

      case 'canvas_list': {
        // Full list refresh — replace threadCanvases for the active thread
        const activeId = get().activeThreadId;
        const relevant = m.canvases.filter(
          c => c.thread_id === activeId || c.thread_id === null
        );
        set({ threadCanvases: relevant });
        break;
      }

      default:
        // Silently ignore other server messages (voice, etc.)
        break;
    }

    // Forward every WS message to window-level listeners
    // (HomeView / SettingsView use this for mcp_status_updated, mantelpiece_update, etc.)
    const listeners = (window as any).__resonantWsListeners as Array<(msg: ServerMessage) => void> | undefined;
    if (listeners && listeners.length > 0) {
      for (const fn of listeners) {
        try { fn(m); } catch { /* isolated per-listener */ }
      }
    }
  }

  function connect() {
    // Idempotent: never open a second socket while one is live or still connecting.
    if (_ws && (_ws.readyState === WebSocket.OPEN || _ws.readyState === WebSocket.CONNECTING)) return;
    clearTimers();

    const { reconnectAttempt, lastSeenSequence, activeThreadId, pendingMessages } = get();
    set({ connectionState: reconnectAttempt > 0 ? 'reconnecting' : 'disconnected' });

    let socket: WebSocket;
    try {
      socket = new WebSocket(getWsUrl());
    } catch (err) {
      console.error('[resonant] Failed to create WebSocket:', err);
      set({ connectionState: 'disconnected' });
      return;
    }
    _ws = socket;

    // All handlers guard on socket identity — a superseded/closed socket is inert.
    socket.onopen = () => {
      if (_ws !== socket) return;
      console.log('[resonant] WebSocket connected');
      const attempt = get().reconnectAttempt;
      set({ connectionState: 'connected', reconnectAttempt: 0, lastError: null });
      startHeartbeat(sendRaw);
      sendRaw({ type: 'visibility', visible: !document.hidden });
      if (attempt > 0 && lastSeenSequence > 0 && activeThreadId) {
        sendRaw({ type: 'sync', lastSeenSequence, threadId: activeThreadId });
      }
      if (pendingMessages.length > 0) {
        const queued = [...pendingMessages];
        set({ pendingMessages: [] });
        for (const msg of queued) {
          sendRaw({
            type: 'message',
            threadId: msg.threadId,
            content: msg.content,
            contentType: 'text',
            // Restore the attachments + reply context preserved on enqueue.
            ...(msg.replyToId ? { replyToId: msg.replyToId } : {}),
            ...(msg.metadata ? { metadata: msg.metadata } : {}),
          });
        }
      }
    };

    socket.onmessage = (event) => {
      if (_ws !== socket) return;
      handleMessage(event);
    };

    socket.onclose = () => {
      if (_ws !== socket) return; // superseded or intentionally closed → do not reconnect
      set({ connectionState: 'disconnected' });
      clearTimers();
      _ws = null;
      const attempt = get().reconnectAttempt + 1;
      const delay = getReconnectDelay(attempt);
      console.log(`[resonant] Reconnecting in ${delay}ms (attempt ${attempt})`);
      set({ reconnectAttempt: attempt });
      _reconnectTimeout = setTimeout(() => {
        set({ connectionState: 'reconnecting' });
        connect();
      }, delay);
    };

    socket.onerror = () => {
      if (_ws !== socket) return;
      console.warn('[resonant] WebSocket error');
    };
  }

  function disconnect() {
    clearTimers();
    const socket = _ws;
    _ws = null; // detach identity first so the socket's onclose becomes a no-op (no reconnect)
    if (socket) {
      set({ connectionState: 'disconnecting' });
      try { socket.close(); } catch { /* ignore */ }
    }
    set({ connectionState: 'disconnected', reconnectAttempt: 0 });
  }

  const BASE_STORE = typeof import.meta !== 'undefined' && (import.meta as { env?: { DEV?: boolean } }).env?.DEV
    ? 'http://127.0.0.1:3099'
    : '';

  async function loadThread(threadId: string) {
    set({ activeThreadId: threadId });
    try {
      const response = await fetch(`${BASE_STORE}/api/threads/${threadId}/messages`);
      if (!response.ok) throw new Error('Failed to load messages');
      const data = await response.json() as { messages: Message[] };
      const messages = data.messages ?? [];
      set({ messages });
      if (messages.length > 0) {
        const last = messages[messages.length - 1];
        if (last.sequence > get().lastSeenSequence) {
          set({ lastSeenSequence: last.sequence });
        }
        // Mark as read
        try { sendRaw({ type: 'read', threadId, beforeId: last.id }); } catch {}
      }
    } catch (err) {
      console.error('[resonant] Failed to load thread:', err);
      set({ messages: [] });
    }
    // Load canvases for this thread; clear any open panel for the old thread
    set({ threadCanvases: [], openCanvasId: null });
    try {
      const cRes = await fetch(`${BASE_STORE}/api/threads/${threadId}/canvases`);
      if (cRes.ok) {
        const cData = await cRes.json() as { canvases: Canvas[] };
        set({ threadCanvases: cData.canvases ?? [] });
      }
    } catch {
      // Non-fatal — canvases just won't be pre-loaded (WS events will populate)
    }
  }

  // Merge server-truth mutable fields (metadata/content/edited/deleted) into
  // messages already in the store — used after reconnect to heal updates whose
  // broadcasts were missed while the socket was down. Leaves list membership
  // and scroll position untouched (new messages arrive via the sync round-trip).
  async function refreshMessageState(threadId: string) {
    try {
      const response = await fetch(`${BASE_STORE}/api/threads/${threadId}/messages`);
      if (!response.ok) return;
      const data = await response.json() as { messages: Message[] };
      const fresh = new Map((data.messages ?? []).map(m => [m.id, m]));
      set(s => {
        if (s.activeThreadId !== threadId) return s;
        return {
          messages: s.messages.map(msg => {
            const f = fresh.get(msg.id);
            if (!f) return msg;
            return { ...msg, content: f.content, metadata: f.metadata, edited_at: f.edited_at, deleted_at: f.deleted_at };
          }),
        };
      });
    } catch {
      // Best-effort heal — the next full thread load reconciles anyway
    }
  }

  // ─── Optimistic-mutation plumbing ────────────────────────────────────────────
  //
  // Every optimistic mutation below goes through okFetch + failMutation:
  //   okFetch    — fetch that treats a non-2xx response as a failure (throws
  //                with the status), so silent 404s can never masquerade as
  //                success again.
  //   failMutation — truth over silence: console.error, revert the optimistic
  //                state via the provided snapshot-restorer, and surface the
  //                failure through the existing lastError banner
  //                (ConnectionStatus renders it).

  async function okFetch(url: string, init?: RequestInit): Promise<Response> {
    const res = await fetch(url, init);
    if (!res.ok) {
      throw new Error(`${init?.method ?? 'GET'} ${url} → HTTP ${res.status}`);
    }
    return res;
  }

  function failMutation(label: string, err: unknown, revert?: () => void) {
    console.error(`[resonant] ${label} failed:`, err);
    revert?.();
    set({ lastError: { code: 'mutation_failed', message: `${label} failed${revert ? ' — change reverted' : ''}` } });
    setTimeout(() => {
      const cur = get().lastError;
      if (cur?.code === 'mutation_failed') set({ lastError: null });
    }, 8000);
  }

  // ─── Thread management actions ───────────────────────────────────────────────

  async function renameThread(id: string, name: string) {
    const prevThreads = get().threads;
    // Optimistic update
    set(s => ({
      threads: s.threads.map(t => t.id === id ? { ...t, name } : t),
    }));
    try {
      await okFetch(`${BASE_STORE}/api/threads/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      // WS thread_updated broadcast will reconcile
    } catch (err) {
      failMutation('Rename thread', err, () => set({ threads: prevThreads }));
    }
  }

  async function archiveThread(id: string) {
    const { threads: prevThreads, activeThreadId: prevActive, messages: prevMessages } = get();
    // Optimistic: remove from list immediately
    set(s => {
      const threads = s.threads.filter(t => t.id !== id);
      const newActive = s.activeThreadId === id
        ? (threads.find(t => t.type === 'daily')?.id ?? threads[0]?.id ?? null)
        : s.activeThreadId;
      return {
        threads,
        activeThreadId: newActive,
        messages: s.activeThreadId === id ? [] : s.messages,
      };
    });
    try {
      await okFetch(`${BASE_STORE}/api/threads/${id}/archive`, { method: 'POST' });
    } catch (err) {
      failMutation('Archive thread', err, () =>
        set({ threads: prevThreads, activeThreadId: prevActive, messages: prevMessages }));
    }
  }

  async function deleteThread(id: string) {
    const { threads: prevThreads, activeThreadId: prevActive, messages: prevMessages } = get();
    // Optimistic: remove from list immediately
    set(s => {
      const threads = s.threads.filter(t => t.id !== id);
      const newActive = s.activeThreadId === id
        ? (threads.find(t => t.type === 'daily')?.id ?? threads[0]?.id ?? null)
        : s.activeThreadId;
      return {
        threads,
        activeThreadId: newActive,
        messages: s.activeThreadId === id ? [] : s.messages,
      };
    });
    try {
      await okFetch(`${BASE_STORE}/api/threads/${id}`, { method: 'DELETE' });
    } catch (err) {
      failMutation('Delete thread', err, () =>
        set({ threads: prevThreads, activeThreadId: prevActive, messages: prevMessages }));
    }
  }

  async function reorderThreads(orderedIds: string[]) {
    const prevThreads = get().threads;
    // Optimistic: reorder the local list to match
    set(s => {
      const byId = new Map(s.threads.map(t => [t.id, t]));
      const reordered = orderedIds
        .map((id, idx) => {
          const t = byId.get(id);
          if (!t) return null;
          return { ...t, position: idx };
        })
        .filter(Boolean) as typeof s.threads;
      // Append any threads not in orderedIds (shouldn't happen but defensive)
      const inOrder = new Set(orderedIds);
      const rest = s.threads.filter(t => !inOrder.has(t.id));
      return { threads: [...reordered, ...rest] };
    });
    try {
      await okFetch(`${BASE_STORE}/api/threads/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedIds }),
      });
      // Backend broadcasts thread_list to reconcile positions
    } catch (err) {
      failMutation('Reorder threads', err, () => set({ threads: prevThreads }));
    }
  }

  async function moveThreadToSection(threadId: string, sectionId: string | null) {
    const prevThreads = get().threads;
    // Optimistic update
    set(s => ({
      threads: s.threads.map(t => t.id === threadId ? { ...t, section_id: sectionId } : t),
    }));
    try {
      await okFetch(`${BASE_STORE}/api/threads/${threadId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ section_id: sectionId }),
      });
      // WS thread_updated broadcast reconciles
    } catch (err) {
      failMutation('Move thread', err, () => set({ threads: prevThreads }));
    }
  }

  // ─── Section management actions ──────────────────────────────────────────────

  async function fetchSections() {
    try {
      const res = await fetch(`${BASE_STORE}/api/sections`);
      if (!res.ok) return;
      const data = await res.json() as { sections: Section[] };
      if (Array.isArray(data?.sections)) {
        set({
          sections: [...data.sections].sort((a, b) => a.position - b.position),
        });
      }
    } catch (err) {
      console.warn('[resonant] fetchSections failed:', err);
    }
  }

  async function createSection(name: string) {
    try {
      const res = await okFetch(`${BASE_STORE}/api/sections`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const data = await res.json() as { section: Section };
      if (data.section) {
        // Dedupe-safe insert. The backend broadcasts `section_list` (authoritative
        // full list) on create, and on localhost that broadcast can land BEFORE
        // this POST response resolves — so a blind prepend would stack a second
        // copy on top of the already-reconciled list. Only add if absent; either
        // race ordering converges to exactly one.
        set(s => (
          s.sections.some(x => x.id === data.section.id)
            ? s
            : { sections: [data.section, ...s.sections].sort((a, b) => a.position - b.position) }
        ));
      }
    } catch (err) {
      // No optimistic state to revert — creation happens on response
      failMutation('Create section', err);
    }
  }

  async function renameSection(id: string, name: string) {
    const prevSections = get().sections;
    // Optimistic
    set(s => ({
      sections: s.sections.map(sec => sec.id === id ? { ...sec, name } : sec),
    }));
    try {
      await okFetch(`${BASE_STORE}/api/sections/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
    } catch (err) {
      failMutation('Rename section', err, () => set({ sections: prevSections }));
    }
  }

  async function deleteSection(id: string) {
    const { sections: prevSections, threads: prevThreads } = get();
    // Optimistic: remove section, un-file its threads
    set(s => ({
      sections: s.sections.filter(sec => sec.id !== id),
      threads: s.threads.map(t => t.section_id === id ? { ...t, section_id: null } : t),
    }));
    try {
      await okFetch(`${BASE_STORE}/api/sections/${id}`, { method: 'DELETE' });
      // Backend broadcasts section_list + thread_list to reconcile
    } catch (err) {
      failMutation('Delete section', err, () =>
        set({ sections: prevSections, threads: prevThreads }));
    }
  }

  async function toggleSectionCollapse(id: string, collapsed: boolean) {
    const prevSections = get().sections;
    // Optimistic
    set(s => ({
      sections: s.sections.map(sec => sec.id === id ? { ...sec, collapsed } : sec),
    }));
    try {
      await okFetch(`${BASE_STORE}/api/sections/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collapsed }),
      });
    } catch (err) {
      failMutation('Collapse section', err, () => set({ sections: prevSections }));
    }
  }

  // ─── Canvas panel actions ────────────────────────────────────────────────────

  // Saves for one canvas run strictly one after another, so a debounced save
  // never goes out with a version that the previous (still in flight) save is
  // about to make stale — that would conflict with ourselves.
  const canvasSaveQueue = new Map<string, Promise<unknown>>();

  function updateCanvas(
    id: string,
    patch: Partial<Pick<Canvas, 'title' | 'content'>>,
    baseVersion?: number | (() => number | undefined),
  ): Promise<CanvasSaveResult> {
    const prev = canvasSaveQueue.get(id) ?? Promise.resolve();
    const run = prev.then(() => doUpdateCanvas(id, patch, baseVersion));
    canvasSaveQueue.set(id, run.catch(() => undefined));
    return run;
  }

  async function doUpdateCanvas(
    id: string,
    patch: Partial<Pick<Canvas, 'title' | 'content'>>,
    baseVersion?: number | (() => number | undefined),
  ): Promise<CanvasSaveResult> {
    const prevCanvases = get().threadCanvases;
    // A title-only change carries no version: the guard is on content.
    const version = patch.content !== undefined
      ? (typeof baseVersion === 'function' ? baseVersion() : baseVersion) ?? prevCanvases.find(c => c.id === id)?.version
      : undefined;
    // Optimistic
    set(s => ({
      threadCanvases: s.threadCanvases.map(c =>
        c.id === id ? { ...c, ...patch, updated_at: new Date().toISOString() } : c
      ),
    }));
    try {
      const res = await fetch(`${BASE_STORE}/api/canvases/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(version !== undefined ? { ...patch, version } : patch),
      });
      if (res.status === 409) {
        const body = await res.json() as { canvas: Canvas };
        set(s => ({
          threadCanvases: s.threadCanvases.map(c => (c.id === id ? body.canvas : c)),
        }));
        return { status: 'conflict', canvas: body.canvas };
      }
      if (!res.ok) throw new Error(`PATCH /api/canvases/${id} → HTTP ${res.status}`);
      const body = await res.json() as { version?: number };
      const newVersion = body.version ?? version ?? 0;
      set(s => ({
        threadCanvases: s.threadCanvases.map(c =>
          c.id === id ? { ...c, version: Math.max(c.version ?? 0, newVersion) } : c
        ),
      }));
      return { status: 'saved', version: newVersion };
    } catch (err) {
      failMutation('Update canvas', err, () => set({ threadCanvases: prevCanvases }));
      return { status: 'failed' };
    }
  }

  async function reorderSections(orderedIds: string[]) {
    const prevSections = get().sections;
    set(s => {
      const byId = new Map(s.sections.map(sec => [sec.id, sec]));
      const reordered = orderedIds
        .map((id, idx) => {
          const sec = byId.get(id);
          if (!sec) return null;
          return { ...sec, position: idx };
        })
        .filter(Boolean) as Section[];
      const inOrder = new Set(orderedIds);
      const rest = s.sections.filter(sec => !inOrder.has(sec.id));
      return { sections: [...reordered, ...rest] };
    });
    try {
      await okFetch(`${BASE_STORE}/api/sections/reorder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderedIds }),
      });
    } catch (err) {
      failMutation('Reorder sections', err, () => set({ sections: prevSections }));
    }
  }

  return {
    ws: null,
    connectionState: 'disconnected',
    reconnectAttempt: 0,
    lastError: null,
    pendingMessages: [],
    messages: [],
    threads: [],
    sections: [],
    activeThreadId: null,
    presence: 'offline',
    commands: [],
    streamingMessageId: null,
    streamingTokens: '',
    displayedTokens: '',
    toolEvents: {},
    toolOffsets: {},
    thinkingEvents: {},
    timelineEntries: [],
    lastSeenSequence: 0,
    transcription: { status: 'idle', text: null, error: null },

    threadCanvases: [],
    canvasDrafts: {},
    setCanvasDraft: (id, text) => set(s => {
      const next = { ...s.canvasDrafts };
      if (text === null) delete next[id]; else next[id] = text;
      return { canvasDrafts: next };
    }),
    openCanvasId: null,

    contextUsage: null,

    connect,
    disconnect,
    send: sendRaw,
    loadThread,
    clearError: () => set({ lastError: null }),
    setActiveThreadId: (id) => set({ activeThreadId: id }),
    clearTranscription: () => set({ transcription: { status: 'idle', text: null, error: null } }),
    openCanvas: (id: string) => set({ openCanvasId: id }),
    closeCanvas: () => set({ openCanvasId: null }),
    updateCanvas,
    renameThread,
    archiveThread,
    deleteThread,
    reorderThreads,
    moveThreadToSection,
    fetchSections,
    createSection,
    renameSection,
    deleteSection,
    toggleSectionCollapse,
    reorderSections,
  };
});

// Wire the late-bound RAF setter now that the store exists.
_setTimelineState = (entries: TimelineEntry[]) => {
  useChatStore.setState({ timelineEntries: entries });
};

// Wire the late-bound token-drip setter now that the store exists.
_setDisplayedTokens = (t: string) => {
  useChatStore.setState({ displayedTokens: t });
};

// ─── Derived selectors (memoized outside component to avoid re-creation) ─────

export function isStreaming(state: ChatStore) {
  return state.streamingMessageId !== null;
}

// Stable empty references — returning a fresh [] from a selector makes Zustand's
// getSnapshot uncacheable and triggers an infinite render loop (React 19 + Zustand v5).
const EMPTY_TOOLS: ToolEvent[] = [];
const EMPTY_THINKING: ThinkingEvent[] = [];

export function getToolEventsForMessage(state: ChatStore, messageId: string): ToolEvent[] {
  return state.toolEvents[messageId] ?? EMPTY_TOOLS;
}

export function getThinkingEventsForMessage(state: ChatStore, messageId: string): ThinkingEvent[] {
  return state.thinkingEvents[messageId] ?? EMPTY_THINKING;
}

const EMPTY_TIMELINE: TimelineEntry[] = [];

// Compute live streaming presence for a given messageId.
// NOTE: returns a new object — consume with useShallow() so the inner stable refs
// (EMPTY_TOOLS/EMPTY_THINKING or the stored arrays) let shallow-equality short-circuit.
export function getStreamingInfo(state: ChatStore) {
  const mid = state.streamingMessageId;
  return {
    messageId: mid,
    tokens: state.streamingTokens,
    /** Smoothed display text — read this for the in-flight bubble render. */
    displayedTokens: state.displayedTokens,
    toolEvents: mid ? (state.toolEvents[mid] ?? EMPTY_TOOLS) : EMPTY_TOOLS,
    thinkingEvents: mid ? (state.thinkingEvents[mid] ?? EMPTY_THINKING) : EMPTY_THINKING,
    timelineEntries: mid ? state.timelineEntries : EMPTY_TIMELINE,
  };
}
