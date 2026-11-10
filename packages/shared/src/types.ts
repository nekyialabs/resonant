// --- Channels config (Settings slice 1) ---
export type ChannelId = 'discord' | 'telegram';

export interface ChannelStats {
  messagesReceived: number;
  messagesProcessed: number;
  errors: number;
}

export interface ChannelSummary {
  id: ChannelId;
  hasToken: boolean;        // token present in env (DISCORD_BOT_TOKEN / TELEGRAM_BOT_TOKEN)
  enabled: boolean;         // service instance live this session (app.locals.<x>Service != null)
  configEnabled: boolean;   // persisted config flag (config table)
  connected: boolean;       // service.isConnected()
  tokenEnvVar: string;      // 'DISCORD_BOT_TOKEN' | 'TELEGRAM_BOT_TOKEN'
  ownerId: string | null;   // discord: ownerUserId; telegram: ownerChatId
  username: string | null;  // bot username when known (discord getStats().username; telegram null)
  stats: ChannelStats | null;
}

export interface ChannelsResponse {
  channels: ChannelSummary[]; // always length 2, order [discord, telegram]
}

export interface ChannelTestResult {
  ok: boolean;
  message: string;            // short, <=40 chars; frontend truncates to 20 for the flash
}

// Database types — mirror the SQLite schema

export interface Thread {
  id: string;
  name: string;
  type: 'daily' | 'named';
  created_at: string;
  archived_at: string | null;
  current_session_id: string | null;
  session_type: 'v1' | 'v2';
  needs_reground: boolean;
  last_activity_at: string | null;
  unread_count: number;
  pinned_at: string | null;
  /** Per-thread Anthropic model id applied to the next message in this thread,
   *  or null to fall back to the config/YAML default. */
  model: string | null;
  /** Per-thread reasoning effort (low|medium|high|xhigh|max), or null to fall
   *  back to the SDK default (high). Adaptive thinking is always on. */
  effort: EffortLevel | null;
  /** Whether to surface the thinking timeline (summarized reasoning) in this
   *  thread's UI. When on, the agent runs thinking with display:'summarized' so
   *  reasoning blocks are non-empty and stream into the collapsible pill.
   *  Defaults ON for the reference install; the OSS build defaults OFF. */
  show_thinking: boolean;
  /** Manual sort position for the sidebar (lower = higher in the list). Set by
   *  drag-and-drop reorder; authoritative over recency so a manual arrangement
   *  sticks. Backfilled from activity order on migration. */
  position: number;
  /** User-created section this named thread is filed under, or null = loose.
   *  Daily threads ignore this (they group into monthly accordions). */
  section_id: string | null;
}

/** Reasoning effort level — mirrors the Agent SDK's EffortLevel. Adaptive
 *  thinking guides depth from this. 'high' is the SDK default. */
export type EffortLevel = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type Platform = 'web' | 'discord' | 'telegram' | 'api';

export interface Message {
  id: string;
  thread_id: string;
  sequence: number;
  role: 'companion' | 'user' | 'system';
  content: string;
  content_type: 'text' | 'image' | 'audio' | 'file';
  platform: Platform;
  metadata: Record<string, unknown> | null;
  reply_to_id: string | null;
  reply_to_preview: string | null;
  edited_at: string | null;
  deleted_at: string | null;
  original_content: string | null;
  created_at: string;
  delivered_at: string | null;
  read_at: string | null;
}

export interface OutboundMessage {
  id: string;
  thread_id: string;
  message_id: string;
  status: 'pending' | 'delivered' | 'failed';
  push_sent: boolean;
  created_at: string;
}

export interface SessionRecord {
  id: string;
  thread_id: string;
  session_id: string;
  session_type: 'v1' | 'v2';
  started_at: string;
  ended_at: string | null;
  end_reason: 'compaction' | 'reaper' | 'daily_rotation' | 'error' | 'manual' | null;
  tokens_used: number | null;
  cost_usd: number | null;
  peak_memory_mb: number | null;
}

export interface AuditEntry {
  id: string;
  session_id: string;
  thread_id: string;
  tool_name: string;
  tool_input: string | null;
  tool_output: string | null;
  triggering_message_id: string | null;
  created_at: string;
}

export interface WebSession {
  id: string;
  token: string;
  created_at: string;
  expires_at: string;
}

export interface ConfigEntry {
  key: string;
  value: string;
}

export type PresenceStatus = 'active' | 'dormant' | 'waking' | 'offline';

export interface McpServerInfo {
  name: string;
  status: 'connected' | 'failed' | 'needs-auth' | 'pending' | 'disabled';
  error?: string;
  toolCount: number;
  tools?: { name: string; description?: string }[];
  scope?: string;
}

export interface OrchestratorTaskStatus {
  wakeType: string;
  label: string;
  cronExpr: string;
  enabled: boolean;
  status: 'scheduled' | 'stopped' | 'running';
  nextRun: string | null;
  category: 'wake' | 'checkin' | 'handoff' | 'failsafe' | 'routine';
  /** Per-task model override for scheduled wakes, or null when none is set
   *  (falls back to model_autonomous at fire time). */
  model: string | null;
  /** Target thread for the wake, resolved at fire time. `'@daily'` (the
   *  default) routes to today's rotating daily thread; any other value is a
   *  specific thread id (falls back to the daily thread if it's gone). */
  target: string;
}

export interface SystemStatus {
  uptime: number;
  memoryUsage: { rss: number; heapUsed: number; heapTotal: number };
  connections: number;
  userConnected: boolean;
  minutesSinceActivity: number;
  presence: PresenceStatus;
  agentProcessing: boolean;
  orchestratorTasks: OrchestratorTaskStatus[];
  mcpServers: McpServerInfo[];
  discord?: { connected: boolean; guilds: number; messagesProcessed: number; errors: number; deferredPending: number; username: string | null };
  telegram?: { connected: boolean; messagesProcessed: number; errors: number; restarts: number };
  queryQueue?: { processing: boolean; depth: number };
}

export interface Canvas {
  id: string;
  thread_id: string | null;
  /** The message whose turn created this canvas, or null. Lets the chat drop an
   *  inline "artifact card" at the point in the conversation where it was made
   *  (claude.ai-style). Null = created outside a turn → shows in panel/library only. */
  message_id: string | null;
  title: string;
  content: string;
  content_type: 'markdown' | 'code' | 'text' | 'html';
  language: string | null;
  created_by: 'companion' | 'user';
  created_at: string;
  updated_at: string;
  /** Optimistic-concurrency counter. Starts at 0, +1 on every content write.
   *  Clients send the version they loaded; a stale one is refused (409). */
  version: number;
}

export type MessageSegment =
  | { type: 'text'; content: string }
  | { type: 'tool'; toolId: string; toolName: string; input?: string; output?: string; isError?: boolean }
  | { type: 'thinking'; content: string; summary: string };

export interface ThreadSummary {
  id: string;
  name: string;
  type: 'daily' | 'named';
  unread_count: number;
  last_activity_at: string | null;
  last_message_preview: string | null;
  pinned_at: string | null;
  /** Per-thread model + effort, surfaced so the header picker can show the
   *  active thread's current values. null = using defaults. */
  model: string | null;
  effort: EffortLevel | null;
  /** Per-thread thinking-visibility toggle, surfaced so the header switch can
   *  show the active thread's state. Defaults ON for the reference install. */
  show_thinking: boolean;
  /** Manual sidebar sort position (lower = higher). Drag-and-drop reorder. */
  position: number;
  /** When set, the thread is archived — hidden from the main sidebar. Surfaced
   *  so the client can drop it from the list live on archive. */
  archived_at: string | null;
  /** The user-created section this (named) thread is filed under, or null = loose.
   *  Daily threads ignore this — they auto-group into monthly accordions by date. */
  section_id: string | null;
}

/** A user-created sidebar section — a named, collapsible container for named
 *  threads. Distinct from the auto monthly accordions (those are derived from
 *  daily threads' dates and are not rows). */
export interface Section {
  id: string;
  name: string;
  /** Manual sort position among sections (lower = higher). */
  position: number;
  /** Collapsed (hidden contents) state, persisted. Sections default expanded. */
  collapsed: boolean;
  created_at: string;
}

export interface SearchResult {
  message: Message;
  threadId: string;
  threadName: string;
  highlight: string;
}

export interface TriggerStatus {
  id: string;
  kind: 'impulse' | 'watcher';
  label: string;
  conditions: string;
  prompt: string | null;
  cooldown_minutes: number;
  status: 'pending' | 'waiting' | 'fired' | 'cancelled';
  last_fired_at: string | null;
  fire_count: number;
  created_at: string;
  fired_at: string | null;
}

// ===========================================================================
// House Outlook — "walking into the house and feeling the current state"
// ---------------------------------------------------------------------------
// ONE snapshot object, assembled on a rhythm from many live sources, cached,
// and served at GET /api/outlook. The hearth (companion's authored presence)
// sits at the top of the board; three "weathers" (you / us / the day) sit
// below the felt state. Each source carries its own freshness in `sources`
// so the UI can show stale/error without ever blanking the board.
//
// This is the LOCKED contract the frontend (Iris) mirrors. Sub-types are all
// exported so the client can import them piecewise.
// ===========================================================================

/** The companion's presence orb as the mantelpiece renders it (color + motion +
 *  expression). Null when no orb has been set. */
export interface OutlookOrb {
  color: string;
  motion?: string;
  expression?: string;
  /** Full weather dimensions (mind-weather sync, 2026-07-02) — the cockpit
   *  must not hide a fracture the mantelpiece shows. */
  shape?: string;
  intensity?: string;
  blend?: string;
}

/** The companion's AUTHORED presence — what the companion chooses to show on the board.
 *  Phase 2 fills the WRITE path; for now this is READ-only (null if unset). */
export interface OutlookPresence {
  mood: string | null;
  thoughts: string | null;
  /** Things the companion is making/holding, with a short "why" each. */
  artifacts: { title: string; why: string }[];
  /** A standing ask of the user, if any. */
  needsUser: string | null;
  /** ISO timestamp of when the presence was last authored, or null if never. */
  updatedAt: string | null;
}

/** THE HEARTH — the companion's presence, top of the board, the main thing. */
export interface OutlookHearth {
  orb: OutlookOrb | null;
  presence: OutlookPresence | null;
}

/** A single care toggle/rating summarized for the day. */
export interface OutlookCareItem {
  label: string;
  done: boolean;
}

/** The user's body signals, read from the Google Health layer. All fields optional
 *  because the Health API may have insufficient history (a normal result). */
export interface OutlookBody {
  sleepSummary?: string;
  hrvMs?: number;
  cyclePhase?: string;
}

/** FIRST WEATHER — you (the user): mood, body, today's care. */
export interface OutlookYou {
  mood: string | null;
  body: OutlookBody | null;
  care: OutlookCareItem[] | null;
}

/** A relational theme surfaced across the recent window (the authored "what
 *  we've been circling" topics). `room`/`threadId`/`lastActivityAt` are optional
 *  so a topic can render its room + time + an open-thread link, mirroring the
 *  cloud platform's `conversationSummaries`. */
export interface OutlookTheme {
  topic: string;
  note: string;
  /** The room/section name this topic lives in, if the author tied it to one. */
  room?: string;
  /** The thread this topic opens into, if any (drives an open-link in the UI). */
  threadId?: string;
  /** Epoch ms of the topic's last activity, if known. */
  lastActivityAt?: number;
}

/** A thing asking for the user — a decision they need to make or a notice they should
 *  see. Authored by the companion into the "things asking for you" panel. */
export interface OutlookNeedsYouItem {
  kind: 'decision' | 'notice';
  text: string;
}

/** A room in the House panel — a section, the daily stream, or the
 *  uncategorized/loose bucket — with its thread count + last activity. */
export interface OutlookRoom {
  id: string;
  name: string;
  kind: 'section' | 'daily' | 'uncategorized';
  threadCount: number;
  lastActivityAt: number | null;
}

/** A recent thread for the House panel's "recent threads" rail. */
export interface OutlookRecentThread {
  id: string;
  name: string;
  roomName: string;
  lastActivityAt: number | null;
}

/** A recent companion action from the proprioceptive `companion_actions` log. */
export interface OutlookRecentAction {
  kind: string;
  summary: string;
  success: boolean;
  createdAt: number;
  threadName?: string | null;
}

/** An MCP server vital for the houseSystems panel (name + status + tool count). */
export interface OutlookMcpVital {
  name: string;
  status: string;
  toolCount: number;
}

/** A single organ's vital (routines/timers/watches/pulse/failsafe). All fields
 *  optional so a system that isn't wired simply omits its detail. */
export interface OutlookOrganVital {
  /** Whether the organ is currently enabled/running. */
  enabled?: boolean;
  /** Count of active/scheduled items for this organ (e.g. scheduled routines,
   *  pending timers, active watches). */
  count?: number;
  /** A short human label (e.g. "every 15m", "next 14:00"), if meaningful. */
  detail?: string;
}

/** OUR house vitals (NOT Cloudflare D1/KV/R2): the MCP servers the agent has
 *  connected, the organ subsystems (routines/timers/watches/pulse/failsafe), and
 *  whether the outlook poller itself is healthy. */
export interface OutlookHouseSystems {
  mcp: OutlookMcpVital[];
  organs: {
    routines?: OutlookOrganVital;
    timers?: OutlookOrganVital;
    watches?: OutlookOrganVital;
    pulse?: OutlookOrganVital;
    failsafe?: OutlookOrganVital;
  };
  /** The outlook poller's own health — true when the last assembly succeeded. */
  pollerOk: boolean;
}

/** A countdown to a dated thing, with optional pre-computed days-away. */
export interface OutlookCountdown {
  label: string;
  when: string;
  daysAway?: number;
}

/** SECOND WEATHER — us: shared themes (Phase 4) and countdowns. */
export interface OutlookUs {
  themes: OutlookTheme[];
  countdowns: OutlookCountdown[];
}

/** A calendar event for the day. */
export interface OutlookEvent {
  time: string;
  title: string;
  allDay?: boolean;
}

/** An open task surfaced for the day. */
export interface OutlookTask {
  title: string;
  due?: string;
}

/** A mail item that looks like it wants a reply. */
export interface OutlookMail {
  from: string;
  subject: string;
}

/** THE DAY — logistics (present, below the felt state). */
export interface OutlookDay {
  events: OutlookEvent[];
  tasks: OutlookTask[];
  mailNeedsReply: OutlookMail[];
}

/** Per-source freshness so the UI can show stale/error without blanking the
 *  board. `updatedAt` is the ISO time of the last SUCCESSFUL read for that
 *  source (carried forward even while status is stale/error). */
export interface OutlookSourceStatus {
  status: 'ok' | 'stale' | 'error';
  updatedAt: string;
  error?: string;
  /** Epoch ms before which the poller will not retry this source (backoff). */
  retryAfter?: number;
}

/** A single scratchpad note as it appears on the House snapshot. */
export interface OutlookScratchpadNote {
  id: string;
  text: string;
  createdBy: string;
  createdAt: string;
}

/** THE locked House Outlook snapshot. Assembled on a rhythm, cached, served. */
export interface HouseSnapshot {
  /** ISO timestamp of when this snapshot was assembled. */
  generatedAt: string;
  hearth: OutlookHearth;
  you: OutlookYou;
  us: OutlookUs;
  day: OutlookDay;
  /** The "things asking for you" panel — decisions + notices the companion
   *  authored. Empty array when nothing is pending. */
  needsYou: OutlookNeedsYouItem[];
  /** The House panel — rooms (sections + the daily stream + uncategorized),
   *  each with a thread count + last activity. */
  rooms: OutlookRoom[];
  /** The recent-threads rail for the House panel. */
  recentThreads: OutlookRecentThread[];
  /** Recent companion actions from the proprioceptive log. */
  recentActions: OutlookRecentAction[];
  /** OUR house vitals — MCP servers, organ subsystems, poller health. */
  houseSystems: OutlookHouseSystems;
  /** Scratchpad notes left by the companion or the user — newest first. Empty array when
   *  none exist; the panel hides entirely when empty. */
  scratchpad: OutlookScratchpadNote[];
  /** Keyed by source name (e.g. 'orb', 'presence', 'body', 'mood', 'care',
   *  'countdowns', 'events', 'tasks', 'mail', 'themes', 'needsYou', 'rooms',
   *  'recentThreads', 'recentActions', 'houseSystems', 'scratchpad'). */
  sources: Record<string, OutlookSourceStatus>;
}
