// WebSocket message protocol — the contract between frontend and backend

import type { Message, Thread, Canvas, PresenceStatus, ThreadSummary, SystemStatus, Section } from './types.js';

// --- Command system ---

export interface CommandRegistryEntry {
  name: string;
  description: string;
  category: 'builtin' | 'skill' | 'custom';
  args?: string;        // placeholder hint, e.g. "[name]"
  clientOnly?: boolean;  // true = handled in frontend, no server round-trip
}

// --- Client -> Server ---

export type ClientMessage =
  | { type: 'message'; threadId: string; content: string; contentType: 'text' | 'image' | 'audio' | 'file'; replyToId?: string; metadata?: Record<string, unknown> }
  | { type: 'edit_message'; messageId: string; newContent: string }
  | { type: 'delete_message'; messageId: string }
  | { type: 'typing' }
  | { type: 'read'; threadId: string; beforeId: string }
  | { type: 'switch_thread'; threadId: string }
  | { type: 'create_thread'; name: string; threadType: 'named' }
  | { type: 'voice_start' }
  | { type: 'voice_audio'; data: string }
  | { type: 'voice_stop' }
  | { type: 'voice_interrupt' }
  | { type: 'voice_mode'; enabled: boolean }
  | { type: 'sync'; lastSeenSequence: number; threadId: string }
  | { type: 'ping' }
  | { type: 'request_status' }
  | { type: 'canvas_create'; title: string; contentType: 'markdown' | 'code' | 'text' | 'html'; language?: string; threadId?: string }
  | { type: 'canvas_update'; canvasId: string; content: string; baseVersion?: number }
  | { type: 'canvas_update_title'; canvasId: string; title: string }
  | { type: 'canvas_delete'; canvasId: string }
  | { type: 'canvas_list' }
  | { type: 'add_reaction'; messageId: string; emoji: string }
  | { type: 'remove_reaction'; messageId: string; emoji: string }
  | { type: 'pin_thread'; threadId: string }
  | { type: 'unpin_thread'; threadId: string }
  | { type: 'visibility'; visible: boolean }
  | { type: 'stop_generation' }
  | { type: 'mcp_reconnect'; serverName: string }
  | { type: 'mcp_toggle'; serverName: string; enabled: boolean }
  | { type: 'rewind_files'; userMessageId: string; dryRun?: boolean }
  | { type: 'command'; name: string; args?: string; threadId?: string };

// --- Server -> Client ---

export type ServerMessage =
  | { type: 'message'; message: Message }
  | { type: 'message_edited'; messageId: string; newContent: string; editedAt: string }
  | { type: 'message_deleted'; messageId: string; hard?: boolean }
  | { type: 'stream_start'; messageId: string; threadId: string }
  | { type: 'stream_token'; messageId: string; token: string }
  | { type: 'stream_end'; messageId: string; final: Message }
  | { type: 'presence'; status: PresenceStatus }
  | { type: 'unread_update'; threadId: string; count: number }
  | { type: 'thread_created'; thread: Thread }
  | { type: 'thread_list'; threads: ThreadSummary[] }
  | { type: 'section_list'; sections: Section[] }
  | { type: 'tool_use'; toolId: string; toolName: string; input?: string; isComplete: boolean; textOffset?: number }
  | { type: 'tool_result'; toolId: string; output?: string; isError?: boolean }
  | { type: 'voice_audio'; data: string }
  | { type: 'voice_transcript'; text: string }
  | { type: 'voice_mode_ack'; enabled: boolean }
  | { type: 'transcription_status'; status: 'processing' | 'complete' | 'error'; text?: string; error?: string; prosody?: Record<string, number> }
  | { type: 'tts_start'; messageId: string }
  | { type: 'tts_audio'; messageId: string; data: string; final: boolean }
  | { type: 'tts_end'; messageId: string }
  | { type: 'sync_response'; messages: Message[] }
  | { type: 'error'; code: string; message: string }
  | { type: 'connected'; sessionStatus: PresenceStatus; threads: ThreadSummary[]; activeThreadId: string | null; commands?: CommandRegistryEntry[] }
  | { type: 'pong' }
  | { type: 'system_status'; status: SystemStatus }
  | { type: 'thread_deleted'; threadId: string }
  | { type: 'thread_updated'; thread: ThreadSummary }
  | { type: 'context_usage'; percentage: number; tokensUsed: number; contextWindow: number }
  | { type: 'compaction_notice'; preTokens: number; message: string; isComplete: boolean }
  | { type: 'canvas_created'; canvas: Canvas }
  | { type: 'canvas_updated'; canvasId: string; content: string; updatedAt: string; version?: number; title?: string }
  | { type: 'canvas_saved'; canvasId: string; version: number }
  | { type: 'canvas_conflict'; canvasId: string; canvas: Canvas }
  | { type: 'canvas_deleted'; canvasId: string }
  | { type: 'canvas_list'; canvases: Canvas[] }
  | { type: 'thinking'; id: string; content: string; summary: string; textOffset: number; isComplete: boolean }
  | { type: 'message_reaction_added'; messageId: string; emoji: string; user: string; createdAt: string }
  | { type: 'message_reaction_removed'; messageId: string; emoji: string; user: string }
  | { type: 'generation_stopped' }
  | { type: 'rate_limit'; status: string; resetsAt?: number; rateLimitType?: string; utilization?: number }
  | { type: 'tool_progress'; toolId: string; toolName: string; elapsed: number }
  | { type: 'mcp_status_updated'; servers: import('./types.js').McpServerInfo[] }
  | { type: 'rewind_result'; canRewind: boolean; filesChanged?: string[]; insertions?: number; deletions?: number; error?: string }
  | { type: 'command_result'; name: string; success: boolean; data?: Record<string, unknown>; error?: string; display?: 'toast' | 'panel' | 'silent' };

// --- Message type guards ---

export function isClientMessage(data: unknown): data is ClientMessage {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as Record<string, unknown>;
  if (typeof msg.type !== 'string') return false;

  const validTypes = [
    'message', 'edit_message', 'delete_message', 'typing', 'read',
    'switch_thread', 'create_thread', 'voice_start', 'voice_audio',
    'voice_stop', 'voice_interrupt', 'voice_mode', 'sync', 'ping', 'request_status',
    'canvas_create', 'canvas_update', 'canvas_update_title', 'canvas_delete', 'canvas_list',
    'add_reaction', 'remove_reaction', 'pin_thread', 'unpin_thread', 'visibility',
    'stop_generation', 'mcp_reconnect', 'mcp_toggle', 'rewind_files', 'command',
  ];

  return validTypes.includes(msg.type);
}
