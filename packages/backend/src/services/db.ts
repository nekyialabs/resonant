import Database from 'better-sqlite3';
import crypto from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type {
  Thread,
  ThreadSummary,
  Message,
  Canvas,
  SessionRecord,
  WebSession,
  Section,
} from '@resonant/shared';
import { getResonantConfig } from '../config.js';
import { embed, vectorToBuffer } from './embeddings.js';
import { cacheEmbedding, removeEmbedding } from './vector-cache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let db: Database.Database | null = null;

export function initDb(dbPath: string): Database.Database {
  db = new Database(dbPath);

  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');
  // Busy timeout prevents SQLITE_BUSY errors under concurrent async access
  db.pragma('busy_timeout = 5000');

  // Performance pragmas (optimization audit win #1, 2026-07-03). Safe with WAL:
  // NORMAL still syncs the WAL at checkpoint, so a crash can lose at most the
  // last transactions, never corrupt the DB.
  db.pragma('synchronous = NORMAL');
  // 64 MB page cache (negative = KB) — the semantic-search full scan and hot
  // message queries stay in memory instead of re-reading pages per statement.
  db.pragma('cache_size = -65536');
  // 256 MB mmap window — reads go through the OS page cache without syscalls.
  db.pragma('mmap_size = 268435456');
  // Temp b-trees (ORDER BY / GROUP BY spills) in memory, not temp files.
  db.pragma('temp_store = MEMORY');
  // NOTE deliberately absent: `foreign_keys = ON`. The audit excludes it —
  // latent orphan rows in the 29k-row history must be verified against real
  // data in a dedicated pass before FK enforcement flips on.

  // Run migrations
  const migrationPath = join(__dirname, '../../migrations/001_init.sql');
  const migrationSQL = readFileSync(migrationPath, 'utf-8');
  db.exec(migrationSQL);

  const ccMigrationPath = join(__dirname, '../../migrations/002_command_center.sql');
  if (existsSync(ccMigrationPath)) {
    const ccMigrationSQL = readFileSync(ccMigrationPath, 'utf-8');
    db.exec(ccMigrationSQL);

    // care_entries.source migration — 'ui' | 'mcp' provenance for care logging
    // ("logged · 14:32 · companion"). Fresh installs get the column from 002's
    // CREATE TABLE; existing DBs get it here (additive, idempotent).
    try {
      db.exec(`ALTER TABLE care_entries ADD COLUMN source TEXT NOT NULL DEFAULT 'ui'`);
    } catch {
      // Column already exists — fine
    }
  }

  // Insert default config if not exists
  const stmt = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
  stmt.run('dnd_start', '23:00');
  stmt.run('dnd_end', '07:00');

  // Timers table (created inline, no migration needed)
  db.exec(`
    CREATE TABLE IF NOT EXISTS timers (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      context TEXT,
      fire_at TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      prompt TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      fired_at TEXT,
      FOREIGN KEY (thread_id) REFERENCES threads(id)
    )
  `);

  // Triggers table (impulse queue + event watchers)
  db.exec(`
    CREATE TABLE IF NOT EXISTS triggers (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      conditions TEXT NOT NULL,
      prompt TEXT,
      thread_id TEXT,
      cooldown_minutes INTEGER DEFAULT 120,
      status TEXT NOT NULL DEFAULT 'pending',
      last_fired_at TEXT,
      fire_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      fired_at TEXT,
      FOREIGN KEY (thread_id) REFERENCES threads(id)
    )
  `);

  // Discord integration migration — platform column + pairing table
  // Safe to run multiple times (uses IF NOT EXISTS / catches already-exists)
  try {
    db.exec(`ALTER TABLE messages ADD COLUMN platform TEXT DEFAULT 'web'`);
  } catch {
    // Column already exists — fine
  }

  // Thread pinning migration
  try {
    db.exec(`ALTER TABLE threads ADD COLUMN pinned_at TEXT DEFAULT NULL`);
  } catch {
    // Column already exists — fine
  }

  // Per-thread model + effort migration. NULL = use config/SDK defaults.
  // model: an Anthropic model id applied to the next message in this thread.
  // effort: one of low|medium|high|xhigh|max (adaptive thinking always on).
  try {
    db.exec(`ALTER TABLE threads ADD COLUMN model TEXT DEFAULT NULL`);
  } catch {
    // Column already exists — fine
  }
  try {
    db.exec(`ALTER TABLE threads ADD COLUMN effort TEXT DEFAULT NULL`);
  } catch {
    // Column already exists — fine
  }

  // Per-thread thinking-visibility migration. 1 = ON (surface the summarized
  // reasoning timeline in the UI), 0 = OFF. Defaults ON for the reference install.
  try {
    db.exec(`ALTER TABLE threads ADD COLUMN show_thinking INTEGER NOT NULL DEFAULT 1`);
  } catch {
    // Column already exists — fine
  }

  // Manual sidebar sort position migration. Lower = higher in the list.
  // Authoritative over recency (recency is only the tiebreaker). Drag-and-drop
  // reorder writes this. Defaults 0; backfilled below from activity order so a
  // fresh migration doesn't collapse every thread to a tie at position 0.
  try {
    db.exec(`ALTER TABLE threads ADD COLUMN position INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists — fine
  }
  // One-time backfill: if every thread still sits at the default position (no
  // non-zero positions exist) and there's more than one thread, assign
  // sequential positions in the current display order (most-recent activity
  // first → position 0,1,2,…). Guard makes this genuinely one-shot: once any
  // thread carries a non-zero position (from this backfill or a later reorder),
  // the COUNT(... != 0) is > 0 and the block is skipped on every future boot.
  try {
    const nonZero = (
      db.prepare('SELECT COUNT(*) AS c FROM threads WHERE position != 0').get() as { c: number }
    ).c;
    const total = (
      db.prepare('SELECT COUNT(*) AS c FROM threads').get() as { c: number }
    ).c;
    if (nonZero === 0 && total > 1) {
      const ids = (
        db
          .prepare('SELECT id FROM threads ORDER BY last_activity_at DESC')
          .all() as Array<{ id: string }>
      ).map((r) => r.id);
      const setPos = db.prepare('UPDATE threads SET position = ? WHERE id = ?');
      const backfill = db.transaction((rows: string[]) => {
        rows.forEach((id, i) => setPos.run(i, id));
      });
      backfill(ids);
    }
  } catch {
    // Backfill is best-effort; a failure here must not block startup.
  }

  // Sidebar sections migration — user-created named, collapsible containers for
  // named threads. A named thread's section_id (added just below) points here or
  // is NULL (loose). Default null. Sections themselves default EXPANDED
  // (collapsed = 0), unlike the frontend's monthly daily-accordions which default
  // collapsed.
  db.exec(`
    CREATE TABLE IF NOT EXISTS sections (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      collapsed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);
  try {
    db.exec(`ALTER TABLE threads ADD COLUMN section_id TEXT`);
  } catch {
    // Column already exists — fine
  }

  // Canvas → message link migration. message_id points at the streaming message
  // whose turn created this canvas (claude.ai-style inline artifact card), or
  // NULL if the canvas was created outside a turn. Default null.
  try {
    db.exec(`ALTER TABLE canvases ADD COLUMN message_id TEXT`);
  } catch {
    // Column already exists — fine
  }

  // Canvas optimistic-concurrency migration. Every content write bumps version;
  // writers that send the version they loaded are refused if it is stale.
  // Existing rows get 0 via the column default.
  try {
    db.exec(`ALTER TABLE canvases ADD COLUMN version INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists — fine
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS discord_pairings (
      code TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      username TEXT,
      channel_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      approved_at TEXT,
      approved_by TEXT
    )
  `);

  // Semantic embeddings table
  db.exec(`
    CREATE TABLE IF NOT EXISTS message_embeddings (
      message_id TEXT PRIMARY KEY,
      vector BLOB NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (message_id) REFERENCES messages(id)
    )
  `);

  // Session history migration — add UNIQUE on session_id + 'resumed' end_reason
  const shCount = (db.prepare('SELECT COUNT(*) as c FROM session_history').get() as { c: number }).c;
  if (shCount === 0) {
    let needsRecreate = false;
    try {
      db.prepare("INSERT INTO session_history (id, thread_id, session_id, session_type, started_at, end_reason) VALUES ('__test', '__test', '__test', 'v1', '2026-01-01', 'resumed')").run();
      db.prepare("DELETE FROM session_history WHERE id = '__test'").run();
    } catch { needsRecreate = true; }
    if (needsRecreate) {
      db.exec('DROP TABLE session_history');
      db.exec(`
        CREATE TABLE session_history (
          id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL,
          session_id TEXT NOT NULL UNIQUE,
          session_type TEXT NOT NULL CHECK(session_type IN ('v1', 'v2')),
          started_at TEXT NOT NULL,
          ended_at TEXT,
          end_reason TEXT CHECK(end_reason IN ('compaction', 'reaper', 'daily_rotation', 'error', 'manual', 'resumed')),
          tokens_used INTEGER,
          cost_usd REAL,
          peak_memory_mb INTEGER,
          FOREIGN KEY (thread_id) REFERENCES threads(id)
        )
      `);
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_session_history_thread_id ON session_history(thread_id)');

  // Lineage migration — parent_session_id threads each session back to the one
  // it succeeded (e.g. after a compaction/resume). Data capture only.
  try {
    db.exec(`ALTER TABLE session_history ADD COLUMN parent_session_id TEXT`);
  } catch {
    // Column already exists — fine
  }

  // Auth preferences — single-row table for runtime-mutable auth/model overrides.
  // Separate from resonant.yaml because (a) holds a secret (API key) that doesn't
  // belong in install config, and (b) yaml writes don't invalidate the config cache.
  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_preferences (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      auth_mode TEXT NOT NULL DEFAULT 'subscription' CHECK(auth_mode IN ('subscription', 'api_key')),
      api_key TEXT,
      preferred_model TEXT,
      preferred_model_autonomous TEXT,
      usage_tracking_enabled INTEGER NOT NULL DEFAULT 1,
      updated_at TEXT NOT NULL
    )
  `);
  db.prepare(
    `INSERT OR IGNORE INTO auth_preferences (id, auth_mode, updated_at) VALUES (1, 'subscription', ?)`
  ).run(new Date().toISOString());

  // Per-turn token usage log (only written when auth_mode='api_key' and tracking on).
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      occurred_at TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      est_cost_usd REAL NOT NULL DEFAULT 0
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_usage_log_occurred_at ON usage_log(occurred_at)');

  // Companion action log — every reach (orb, note, express, context, voice, react,
  // canvas, share, timer, etc.) lands here. Surfaced in session-mode orientation as
  // **Recently reached:** so the companion sees its own pattern of agency next session.
  // Harvested from the reference app's action-log table.
  db.exec(`
    CREATE TABLE IF NOT EXISTS companion_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_companion_actions_created_at ON companion_actions(created_at DESC)');

  return db;
}

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

// Thread operations

/** Lowercase, non-alphanumerics → '-', trimmed of leading/trailing '-', capped
 *  at 48 chars. Used to derive a human-readable, URL-safe prefix for named
 *  thread ids. Falls back to 'thread' if the name has no usable characters. */
function slugify(input: string): string {
  const base = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || 'thread';
}

/** 8-char base36 random suffix. Keeps named-thread ids unique even when two
 *  threads share a label (duplicate names are allowed). */
function shortId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Derive a named-thread id from its label: `slug(name)-shortId()`. */
export function deriveNamedThreadId(name: string): string {
  return `${slugify(name)}-${shortId()}`;
}

export function createThread(params: {
  id?: string;
  name: string;
  type: 'daily' | 'named';
  createdAt: string;
  sessionType?: 'v1' | 'v2';
}): Thread {
  // Named threads get a derived, human-readable, unique id when none is given.
  // Daily threads must pass an explicit deterministic id (see ensureDailyThread).
  const id = params.id ?? deriveNamedThreadId(params.name);
  // Place new threads at the TOP of the sidebar: one below the current minimum
  // position. Empty table → 0. (MIN over no rows is NULL → COALESCE to 1 so the
  // first thread lands at 0.)
  const topPosition = (
    getDb()
      .prepare('SELECT COALESCE(MIN(position), 1) - 1 AS p FROM threads')
      .get() as { p: number }
  ).p;
  const stmt = getDb().prepare(`
    INSERT INTO threads (id, name, type, created_at, session_type, last_activity_at, position)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    params.name,
    params.type,
    params.createdAt,
    params.sessionType || 'v2',
    params.createdAt,
    topPosition
  );

  return getThread(id)!;
}

/** Map a raw `threads` row to a `Thread`, normalizing INTEGER-boolean columns
 *  (stored as 0/1 in SQLite) to real booleans. Mirrors how needs_reground and
 *  show_thinking are declared boolean in the shared type. */
function rowToThread(row: Record<string, unknown>): Thread {
  return {
    ...row,
    needs_reground: Boolean(row.needs_reground),
    show_thinking: Boolean(row.show_thinking),
    // Plain INTEGER column — coerce defensively so a NULL (shouldn't happen with
    // NOT NULL DEFAULT 0) never leaks through as a non-number.
    position: Number(row.position ?? 0),
    // User-created section this named thread is filed under, or null = loose.
    section_id: (row.section_id as string | null) ?? null,
  } as unknown as Thread;
}

/** Build the shared `ThreadSummary` wire shape from a `Thread` row. Single
 *  source of truth so every broadcast/REST site carries the full field set
 *  (position + archived_at included). `last_message_preview` is left null here;
 *  the REST list endpoint enriches it separately. */
export function threadToSummary(t: Thread): ThreadSummary {
  return {
    id: t.id,
    name: t.name,
    type: t.type,
    unread_count: t.unread_count,
    last_activity_at: t.last_activity_at,
    last_message_preview: null,
    pinned_at: t.pinned_at ?? null,
    model: t.model ?? null,
    effort: t.effort ?? null,
    show_thinking: t.show_thinking,
    position: t.position,
    archived_at: t.archived_at ?? null,
    section_id: t.section_id ?? null,
  };
}

export function getThread(id: string): Thread | null {
  const stmt = getDb().prepare('SELECT * FROM threads WHERE id = ?');
  const row = stmt.get(id) as Record<string, unknown> | undefined;
  return row ? rowToThread(row) : null;
}

// --- Daily thread (deterministic, idempotent, system-managed) ---
//
// The daily thread is the convergence point for a day. Its id is derived
// purely from the date in the configured timezone (`daily-YYYY-MM-DD`), so
// get-or-create can use INSERT OR IGNORE on the threads PK and NEVER produce a
// duplicate. There is no separate "today" pointer — the id IS the pointer.
//
// Timezone: config.identity.timezone, falling back to Europe/London (the
// config default of 'UTC' is treated as unset for daily-thread display).

function dailyTimezone(): string {
  const tz = getResonantConfig().identity.timezone;
  return tz && tz !== 'UTC' ? tz : 'Europe/London';
}

/** "2026-06-17" in the daily timezone. */
function localDateString(date: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: dailyTimezone(),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const d = parts.find((p) => p.type === 'day')?.value;
  return `${y}-${m}-${d}`;
}

/** Deterministic daily id: `daily-YYYY-MM-DD` in the daily timezone. */
export function dailyThreadIdFor(date: Date = new Date()): string {
  return `daily-${localDateString(date)}`;
}

/** Display name: "Wednesday Jun 17" (en-GB, weekday + short month + day). */
export function dailyThreadNameFor(date: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: dailyTimezone(),
    weekday: 'long',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

/** Get OR create the daily thread for `date`. Idempotent via INSERT OR IGNORE
 *  on the deterministic id — can never create a duplicate. `justCreated` is
 *  true only on the first ensure of a given day. */
export function ensureDailyThread(
  date: Date = new Date()
): { thread: Thread; justCreated: boolean } {
  const id = dailyThreadIdFor(date);
  const name = dailyThreadNameFor(date);
  const now = new Date().toISOString();
  // New daily thread sits at the top of the sidebar (one below current MIN).
  // INSERT OR IGNORE: if today's thread already exists, position is untouched.
  const topPosition = (
    getDb()
      .prepare('SELECT COALESCE(MIN(position), 1) - 1 AS p FROM threads')
      .get() as { p: number }
  ).p;
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO threads
         (id, name, type, created_at, session_type, last_activity_at, position)
       VALUES (?, ?, 'daily', ?, 'v2', ?, ?)`
    )
    .run(id, name, now, now, topPosition);
  const justCreated = result.changes === 1;
  const thread = getThread(id);
  if (!thread) throw new Error('daily_thread_ensure_failed');
  return { thread, justCreated };
}

/** Today's daily thread (in the daily timezone). Creates if missing. */
export function getCurrentDailyThread(): Thread {
  return ensureDailyThread().thread;
}

/** Today's daily thread, or null if it does not yet exist (read-only — does
 *  NOT create). Callers that should never spawn a thread (e.g. background
 *  pulses) use this; callers that own the day use getCurrentDailyThread(). */
export function getTodayThread(): Thread | null {
  return getThread(dailyThreadIdFor());
}

export function listThreads(params: {
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}): Thread[] {
  const { includeArchived = false, limit = 50, offset = 0 } = params;

  let sql = 'SELECT * FROM threads';
  if (!includeArchived) {
    sql += ' WHERE archived_at IS NULL';
  }
  // Manual sidebar order is authoritative; recency is only the tiebreaker.
  sql += ' ORDER BY position ASC, last_activity_at DESC LIMIT ? OFFSET ?';

  const stmt = getDb().prepare(sql);
  const rows = stmt.all(limit, offset) as Record<string, unknown>[];
  return rows.map(rowToThread);
}

export function getMostRecentActiveThread(): Thread | null {
  // Returns the most recently active non-archived thread with a session
  // Used to route user's messages into their active conversation
  const stmt = getDb().prepare(`
    SELECT * FROM threads
    WHERE archived_at IS NULL
    AND current_session_id IS NOT NULL
    ORDER BY last_activity_at DESC
    LIMIT 1
  `);
  const row = stmt.get() as Record<string, unknown> | undefined;
  return row ? rowToThread(row) : null;
}

export function updateThreadSession(threadId: string, sessionId: string | null): void {
  const stmt = getDb().prepare('UPDATE threads SET current_session_id = ? WHERE id = ?');
  stmt.run(sessionId, threadId);
}

/**
 * Null out current_session_id for every thread. Next message in each thread
 * starts a fresh SDK session. Useful after switching auth modes, because
 * Anthropic's prompt cache is account-scoped — a session built under one
 * credential gets no cache hit when resumed under another.
 *
 * Returns the number of threads affected.
 */
export function clearAllThreadSessions(): number {
  const result = getDb().prepare('UPDATE threads SET current_session_id = NULL WHERE current_session_id IS NOT NULL').run();
  return result.changes;
}

export function updateThreadActivity(threadId: string, timestamp: string, incrementUnread = false): void {
  let sql = 'UPDATE threads SET last_activity_at = ?';
  if (incrementUnread) {
    sql += ', unread_count = unread_count + 1';
  }
  sql += ' WHERE id = ?';

  const stmt = getDb().prepare(sql);
  stmt.run(timestamp, threadId);
}

export function archiveThread(threadId: string, archivedAt: string): void {
  const stmt = getDb().prepare('UPDATE threads SET archived_at = ? WHERE id = ?');
  stmt.run(archivedAt, threadId);
}

/** Clear archived_at — the thread returns to the live sidebar. Makes the
 *  archive-confirm promise ("you can recover it later") actually true. */
export function unarchiveThread(threadId: string): void {
  const stmt = getDb().prepare('UPDATE threads SET archived_at = NULL WHERE id = ?');
  stmt.run(threadId);
}

/** Apply a manual sidebar order: position = index for each id, in order, in a
 *  single transaction. Ids not present in `orderedIds` keep their current
 *  position (callers pass the full active list, so this is normally exhaustive).
 *  Unknown ids are simply no-ops (UPDATE affects 0 rows). */
export function reorderThreads(orderedIds: string[]): void {
  const db = getDb();
  const setPos = db.prepare('UPDATE threads SET position = ? WHERE id = ?');
  const apply = db.transaction((ids: string[]) => {
    ids.forEach((id, i) => setPos.run(i, id));
  });
  apply(orderedIds);
}

export function deleteThread(threadId: string): string[] {
  const db = getDb();

  // Collect fileIds from message metadata before deleting
  const fileIds: string[] = [];
  const msgs = db.prepare('SELECT metadata FROM messages WHERE thread_id = ? AND metadata IS NOT NULL').all(threadId) as Array<{ metadata: string }>;
  for (const row of msgs) {
    try {
      const meta = JSON.parse(row.metadata);
      if (meta.fileId) fileIds.push(meta.fileId);
    } catch { /* skip unparseable */ }
  }

  // Message ids for vector-cache eviction after the transaction commits.
  const msgIds = db.prepare('SELECT id FROM messages WHERE thread_id = ?')
    .all(threadId) as Array<{ id: string }>;

  // Cascading delete in a transaction. message_embeddings rows go too (audit
  // win #5, 2026-07-03) — the messages are hard-deleted, so leaving their
  // vectors behind would orphan them in the table permanently.
  const deleteAll = db.transaction(() => {
    db.prepare('DELETE FROM triggers WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM timers WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM canvases WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM outbound_queue WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM audit_log WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM session_history WHERE thread_id = ?').run(threadId);
    db.prepare(
      'DELETE FROM message_embeddings WHERE message_id IN (SELECT id FROM messages WHERE thread_id = ?)'
    ).run(threadId);
    db.prepare('DELETE FROM messages WHERE thread_id = ?').run(threadId);
    db.prepare('DELETE FROM threads WHERE id = ?').run(threadId);
  });
  deleteAll();

  // Evict AFTER the commit — if the transaction throws, the cache stays
  // consistent with the (unchanged) table.
  for (const m of msgIds) removeEmbedding(m.id);

  return fileIds;
}

// Section operations

/** Map a raw `sections` row to a `Section`, normalizing the INTEGER columns
 *  (collapsed stored 0/1, position stored as INTEGER) to their shared types. */
function rowToSection(row: Record<string, unknown>): Section {
  return {
    id: row.id as string,
    name: row.name as string,
    position: Number(row.position ?? 0),
    collapsed: Boolean(row.collapsed),
    created_at: row.created_at as string,
  };
}

/** All sections, ordered top-to-bottom (position ASC). */
export function listSections(): Section[] {
  const rows = getDb()
    .prepare('SELECT * FROM sections ORDER BY position ASC')
    .all() as Record<string, unknown>[];
  return rows.map(rowToSection);
}

export function getSection(id: string): Section | null {
  const row = getDb().prepare('SELECT * FROM sections WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToSection(row) : null;
}

/** Create a section at the TOP of the sections zone (one below current MIN
 *  position; empty table → 0). New sections default EXPANDED (collapsed 0). */
export function createSection(name: string): Section {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const topPosition = (
    getDb()
      .prepare('SELECT COALESCE(MIN(position), 1) - 1 AS p FROM sections')
      .get() as { p: number }
  ).p;
  getDb()
    .prepare(
      `INSERT INTO sections (id, name, position, collapsed, created_at)
       VALUES (?, ?, ?, 0, ?)`
    )
    .run(id, name, topPosition, now);
  return getSection(id)!;
}

/** Dynamic UPDATE of provided fields (collapsed persisted as 0/1). Returns the
 *  updated section, or null if the id doesn't exist. */
export function updateSection(
  id: string,
  fields: { name?: string; collapsed?: boolean }
): Section | null {
  const existing = getSection(id);
  if (!existing) return null;

  const sets: string[] = [];
  const vals: (string | number)[] = [];
  if (fields.name !== undefined) {
    sets.push('name = ?');
    vals.push(fields.name);
  }
  if (fields.collapsed !== undefined) {
    sets.push('collapsed = ?');
    vals.push(fields.collapsed ? 1 : 0);
  }
  if (sets.length > 0) {
    vals.push(id);
    getDb()
      .prepare(`UPDATE sections SET ${sets.join(', ')} WHERE id = ?`)
      .run(...vals);
  }
  return getSection(id);
}

/** Apply a manual section order: position = index for each id, in a single
 *  transaction. Unknown ids are no-ops (UPDATE affects 0 rows). */
export function reorderSections(orderedIds: string[]): void {
  const db = getDb();
  const setPos = db.prepare('UPDATE sections SET position = ? WHERE id = ?');
  const apply = db.transaction((ids: string[]) => {
    ids.forEach((id, i) => setPos.run(i, id));
  });
  apply(orderedIds);
}

/** Delete a section AND free its threads (their section_id → NULL so they
 *  survive as loose threads), both in one transaction. */
export function deleteSection(id: string): void {
  const db = getDb();
  const run = db.transaction(() => {
    db.prepare('UPDATE threads SET section_id = NULL WHERE section_id = ?').run(id);
    db.prepare('DELETE FROM sections WHERE id = ?').run(id);
  });
  run();
}

/** File a thread under a section (or null = loose). */
export function setThreadSection(threadId: string, sectionId: string | null): void {
  getDb()
    .prepare('UPDATE threads SET section_id = ? WHERE id = ?')
    .run(sectionId, threadId);
}

/**
 * Async embedding helper — fire-and-forget from createMessage.
 *
 * Intentionally eventual-consistent: the message is created synchronously and
 * returned immediately, while the embedding is computed asynchronously (50-200ms
 * ML inference). If embedding fails, the message exists without a vector — this
 * is acceptable because semantic search degrades gracefully with missing vectors,
 * and making embedding synchronous would block the response path.
 */
async function embedMessageAsync(messageId: string, content: string): Promise<void> {
  try {
    const vector = await embed(content);
    // saveEmbedding syncs the in-memory vector cache itself (win #5) — one
    // write path for live embeds and backfill alike.
    saveEmbedding(messageId, vectorToBuffer(vector));
  } catch (err) {
    console.error(`[embeddings] Failed to embed message ${messageId}:`, err);
  }
}

// Message operations
export function getNextSequence(threadId: string): number {
  const stmt = getDb().prepare('SELECT MAX(sequence) as max_seq FROM messages WHERE thread_id = ?');
  const row = stmt.get(threadId) as { max_seq: number | null };
  return (row.max_seq || 0) + 1;
}

export function createMessage(params: {
  id: string;
  threadId: string;
  role: 'companion' | 'user' | 'system';
  content: string;
  contentType?: 'text' | 'image' | 'audio' | 'file';
  platform?: 'web' | 'discord' | 'telegram' | 'api';
  metadata?: Record<string, unknown>;
  replyToId?: string;
  createdAt: string;
}): Message {
  const sequence = getNextSequence(params.threadId);

  const stmt = getDb().prepare(`
    INSERT INTO messages (
      id, thread_id, sequence, role, content, content_type, platform, metadata, reply_to_id, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    params.id,
    params.threadId,
    sequence,
    params.role,
    params.content,
    params.contentType || 'text',
    params.platform || 'web',
    params.metadata ? JSON.stringify(params.metadata) : null,
    params.replyToId || null,
    params.createdAt
  );

  // Fire-and-forget embedding for text messages (non-system)
  if (params.role !== 'system' && (!params.contentType || params.contentType === 'text') && params.content.length > 10) {
    embedMessageAsync(params.id, params.content).catch((err) => {
      // Hale #2 (2026-07-02): an empty catch here let the semantic index rot
      // in total silence — every failed embed was invisible. FTS5 keyword
      // search survives regardless, but the failure must be SEEN.
      embedFailures++;
      if (embedFailures === 1 || embedFailures % 25 === 0) {
        console.warn(`[embed] message embedding failed (${embedFailures} total since boot): ${err}`);
      }
    });
  }

  return getMessage(params.id)!;
}

let embedFailures = 0;

/** Tolerant metadata parse (Hale #3, 2026-07-02): one malformed row must never
 *  brick a whole thread load or a message action. Matches the skip-unparseable
 *  posture used elsewhere in this file. */
function parseMessageMetadata(msg: Message): Message {
  if (msg.metadata && typeof msg.metadata === 'string') {
    try {
      msg.metadata = JSON.parse(msg.metadata);
    } catch {
      console.warn(`[db] malformed metadata on message ${msg.id} — ignored`);
      msg.metadata = null;
    }
  }
  return msg;
}

export function getMessage(id: string): Message | null {
  const stmt = getDb().prepare('SELECT * FROM messages WHERE id = ?');
  const row = stmt.get(id);
  if (!row) return null;

  return parseMessageMetadata(row as unknown as Message);
}

export function getMessages(params: {
  threadId: string;
  before?: string;
  limit?: number;
}): Message[] {
  const { threadId, before, limit = 50 } = params;

  let sql = 'SELECT * FROM messages WHERE thread_id = ? AND deleted_at IS NULL';
  const sqlParams: unknown[] = [threadId];

  if (before) {
    sql += ' AND sequence < (SELECT sequence FROM messages WHERE id = ?)';
    sqlParams.push(before);
  }

  sql += ' ORDER BY sequence DESC LIMIT ?';
  sqlParams.push(limit);

  const stmt = getDb().prepare(sql);
  const rows = stmt.all(...sqlParams);

  const messages = (rows as unknown as Message[]).map(parseMessageMetadata);

  return messages.reverse(); // Return in chronological order
}

/** Live (non-deleted) message count for a thread — cheap COUNT(*), used by the
 *  tone-snapshot cadence in hooks.ts. */
export function countMessages(threadId: string): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM messages WHERE thread_id = ? AND deleted_at IS NULL')
    .get(threadId) as { n: number } | undefined;
  return row?.n ?? 0;
}

/** Get messages surrounding a specific message (N before + the message + N after). */
export function getMessageContext(messageId: string, windowSize: number = 2): Message[] {
  const target = getDb().prepare('SELECT thread_id, sequence FROM messages WHERE id = ?').get(messageId) as { thread_id: string; sequence: number } | undefined;
  if (!target) return [];

  const rows = getDb().prepare(`
    SELECT * FROM messages
    WHERE thread_id = ? AND deleted_at IS NULL
      AND sequence BETWEEN ? AND ?
    ORDER BY sequence ASC
  `).all(target.thread_id, target.sequence - windowSize, target.sequence + windowSize);

  return (rows as unknown as Message[]).map(parseMessageMetadata);
}

export function editMessage(id: string, newContent: string, editedAt: string): void {
  const stmt = getDb().prepare(`
    UPDATE messages
    SET content = ?, edited_at = ?, original_content = COALESCE(original_content, content)
    WHERE id = ?
  `);
  stmt.run(newContent, editedAt, id);
}

export function softDeleteMessage(id: string, deletedAt: string): void {
  const stmt = getDb().prepare('UPDATE messages SET deleted_at = ? WHERE id = ?');
  stmt.run(deletedAt, id);
  // Evict from the in-memory vector cache (audit win #5, 2026-07-03) so search
  // stops surfacing the tombstoned message immediately. The message_embeddings
  // ROW stays — loadVectorCache already filters on `deleted_at IS NULL`, so
  // this exactly mirrors what a restart would produce.
  removeEmbedding(id);
}

/**
 * The most recent `role='user'` message in `threadId` with a sequence strictly
 * lower than `sequence` — i.e. the user turn that triggered a given companion
 * message. Returns null if none (e.g. the companion message opened the thread).
 * Ignores soft-deleted messages.
 */
export function getTriggeringUserMessage(threadId: string, sequence: number): Message | null {
  const row = getDb().prepare(`
    SELECT * FROM messages
    WHERE thread_id = ? AND role = 'user' AND deleted_at IS NULL AND sequence < ?
    ORDER BY sequence DESC
    LIMIT 1
  `).get(threadId, sequence) as Record<string, unknown> | undefined;
  if (!row) return null;
  return parseMessageMetadata(row as unknown as Message);
}

/**
 * HARD-delete `id` and every message after it in the same thread (sequence >=
 * the target's). Used by regenerate: the stale companion turn (and any trailing
 * messages — normally none) are removed outright, not tombstoned, so the
 * re-run streams a clean replacement with no version/branch artifacts. Also
 * clears any message_embeddings rows for the deleted messages so semantic
 * search doesn't surface a vector whose message no longer exists. Runs in one
 * transaction. Returns the count of messages deleted.
 */
export function deleteMessagesFrom(threadId: string, id: string): number {
  const db = getDb();
  const target = db.prepare('SELECT sequence FROM messages WHERE id = ?').get(id) as
    | { sequence: number }
    | undefined;
  if (!target) return 0;

  let deletedIds: Array<{ id: string }> = [];
  const run = db.transaction(() => {
    const rows = db.prepare(
      'SELECT id FROM messages WHERE thread_id = ? AND sequence >= ?'
    ).all(threadId, target.sequence) as Array<{ id: string }>;
    deletedIds = rows;
    const delEmbedding = db.prepare('DELETE FROM message_embeddings WHERE message_id = ?');
    for (const r of rows) delEmbedding.run(r.id);
    const result = db.prepare(
      'DELETE FROM messages WHERE thread_id = ? AND sequence >= ?'
    ).run(threadId, target.sequence);
    return result.changes;
  });
  const changes = run();
  // Evict from the in-memory vector cache AFTER the commit (audit win #5,
  // 2026-07-03) — regenerate must not leave RAM-resident vectors whose
  // messages are gone, or search surfaces dead messageIds until restart.
  for (const r of deletedIds) removeEmbedding(r.id);
  return changes;
}

export function markMessagesRead(threadId: string, beforeId: string, readAt: string): void {
  const db = getDb();
  const run = db.transaction(() => {
    db.prepare(`
      UPDATE messages
      SET read_at = ?
      WHERE thread_id = ?
      AND sequence <= (SELECT sequence FROM messages WHERE id = ?)
      AND read_at IS NULL
    `).run(readAt, threadId, beforeId);

    db.prepare('UPDATE threads SET unread_count = 0 WHERE id = ?').run(threadId);
  });
  run();
}

// Reaction operations
export function addReaction(messageId: string, emoji: string, user: 'companion' | 'user'): void {
  const db = getDb();
  const run = db.transaction(() => {
    const msg = getMessage(messageId);
    if (!msg) return;

    const metadata = (msg.metadata && typeof msg.metadata === 'object') ? { ...msg.metadata } : {};
    const reactions: Array<{ emoji: string; user: string; created_at: string }> = Array.isArray(metadata.reactions) ? [...metadata.reactions] : [];

    if (reactions.some(r => r.emoji === emoji && r.user === user)) return;

    reactions.push({ emoji, user, created_at: new Date().toISOString() });
    metadata.reactions = reactions;

    db.prepare('UPDATE messages SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), messageId);
  });
  run();
}

export function removeReaction(messageId: string, emoji: string, user: 'companion' | 'user'): void {
  const db = getDb();
  const run = db.transaction(() => {
    const msg = getMessage(messageId);
    if (!msg) return;

    const metadata = (msg.metadata && typeof msg.metadata === 'object') ? { ...msg.metadata } : {};
    const reactions: Array<{ emoji: string; user: string; created_at: string }> = Array.isArray(metadata.reactions) ? [...metadata.reactions] : [];

    const filtered = reactions.filter(r => !(r.emoji === emoji && r.user === user));
    if (filtered.length === reactions.length) return;

    metadata.reactions = filtered;

    db.prepare('UPDATE messages SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), messageId);
  });
  run();
}

// Pin operations
export function pinThread(threadId: string): void {
  const stmt = getDb().prepare('UPDATE threads SET pinned_at = ? WHERE id = ?');
  stmt.run(new Date().toISOString(), threadId);
}

export function unpinThread(threadId: string): void {
  const stmt = getDb().prepare('UPDATE threads SET pinned_at = NULL WHERE id = ?');
  stmt.run(threadId);
}

// Search operations

type SearchRow = {
  id: string; thread_id: string; role: string; content: string;
  content_type: string; created_at: string; thread_name: string;
};

// Cache the FTS5-availability probe so we only run it once per process.
let ftsAvailable: boolean | null = null;
function isFtsAvailable(): boolean {
  if (ftsAvailable !== null) return ftsAvailable;
  try {
    const row = getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = 'messages_fts'")
      .get();
    ftsAvailable = !!row;
  } catch {
    ftsAvailable = false;
  }
  return ftsAvailable;
}

/**
 * Convert an arbitrary user string into a safe FTS5 MATCH expression.
 * We extract word-ish tokens (unicode letters/digits) and AND them together as
 * quoted phrases, so FTS5 special characters in user input can never produce a
 * syntax error. Returns null when no usable token remains (caller falls back).
 */
function buildFtsMatch(query: string): string | null {
  const tokens = query.match(/[\p{L}\p{N}]+/gu);
  if (!tokens || tokens.length === 0) return null;
  // Quote each token as a phrase ("" escapes any embedded quote — there are none
  // after the regex, but quoting also neutralises reserved bareword operators).
  return tokens.map(t => `"${t}"`).join(' AND ');
}

function searchMessagesLike(
  query: string,
  threadId: string | undefined,
  limit: number,
  offset: number
): { messages: SearchRow[]; total: number } {
  const escapedQuery = query.replace(/[%_]/g, '\\$&');
  const searchPattern = `%${escapedQuery}%`;

  let whereClause = "WHERE m.deleted_at IS NULL AND m.content LIKE ? ESCAPE '\\'";
  const countParams: unknown[] = [searchPattern];
  const selectParams: unknown[] = [searchPattern];

  if (threadId) {
    whereClause += ' AND m.thread_id = ?';
    countParams.push(threadId);
    selectParams.push(threadId);
  }

  const countStmt = getDb().prepare(`SELECT COUNT(*) as total FROM messages m ${whereClause}`);
  const { total } = countStmt.get(...countParams) as { total: number };

  const selectStmt = getDb().prepare(`
    SELECT m.id, m.thread_id, m.role, m.content, m.content_type, m.created_at, t.name as thread_name
    FROM messages m
    JOIN threads t ON t.id = m.thread_id
    ${whereClause}
    ORDER BY m.created_at DESC
    LIMIT ? OFFSET ?
  `);
  selectParams.push(limit, offset);

  const rows = selectStmt.all(...selectParams) as SearchRow[];
  return { messages: rows, total };
}

export function searchMessages(params: {
  query: string;
  threadId?: string;
  limit?: number;
  offset?: number;
}): { messages: SearchRow[]; total: number } {
  const { query, threadId, limit = 50, offset = 0 } = params;

  // Fast path: FTS5. Falls back to LIKE if unavailable, query empty, or error.
  if (isFtsAvailable()) {
    const matchExpr = buildFtsMatch(query);
    if (matchExpr) {
      try {
        let whereClause = 'WHERE m.deleted_at IS NULL AND f.messages_fts MATCH ?';
        const countParams: unknown[] = [matchExpr];
        const selectParams: unknown[] = [matchExpr];

        if (threadId) {
          whereClause += ' AND m.thread_id = ?';
          countParams.push(threadId);
          selectParams.push(threadId);
        }

        const countStmt = getDb().prepare(`
          SELECT COUNT(*) as total
          FROM messages_fts f
          JOIN messages m ON m.id = f.message_id
          ${whereClause}
        `);
        const { total } = countStmt.get(...countParams) as { total: number };

        const selectStmt = getDb().prepare(`
          SELECT m.id, m.thread_id, m.role, m.content, m.content_type, m.created_at, t.name as thread_name
          FROM messages_fts f
          JOIN messages m ON m.id = f.message_id
          JOIN threads t ON t.id = m.thread_id
          ${whereClause}
          ORDER BY m.created_at DESC
          LIMIT ? OFFSET ?
        `);
        selectParams.push(limit, offset);

        const rows = selectStmt.all(...selectParams) as SearchRow[];
        return { messages: rows, total };
      } catch (err) {
        // Any FTS error (e.g. malformed MATCH) — degrade gracefully to LIKE.
        console.error('searchMessages: FTS5 path failed, falling back to LIKE:', err);
      }
    }
  }

  return searchMessagesLike(query, threadId, limit, offset);
}

// Embedding operations

/** Persist an embedding AND sync the in-memory vector cache (audit win #5,
 *  2026-07-03). Every embedding write path — live embeds and both backfill
 *  loops in routes/api.ts — flows through here, so backfilled rows become
 *  searchable via `res search` without a restart. The cache entry's metadata
 *  comes from the message row itself; a missing or soft-deleted message gets
 *  the DB row only (mirrors loadVectorCache's `deleted_at IS NULL` filter —
 *  nothing unsearchable is fabricated into the cache). */
export function saveEmbedding(messageId: string, vector: Buffer): void {
  const stmt = getDb().prepare(`
    INSERT OR REPLACE INTO message_embeddings (message_id, vector, created_at)
    VALUES (?, ?, ?)
  `);
  stmt.run(messageId, vector, new Date().toISOString());

  const row = getDb().prepare(`
    SELECT m.thread_id, m.role, m.created_at, t.name AS thread_name
    FROM messages m
    JOIN threads t ON t.id = m.thread_id
    WHERE m.id = ? AND m.deleted_at IS NULL
  `).get(messageId) as
    | { thread_id: string; role: string; created_at: string; thread_name: string }
    | undefined;
  if (row) {
    const f32 = new Float32Array(
      vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength)
    );
    cacheEmbedding(messageId, f32, {
      threadId: row.thread_id,
      threadName: row.thread_name,
      role: row.role,
      createdAt: row.created_at,
    });
  }
}

export function getAllEmbeddings(threadId?: string): Array<{
  message_id: string; vector: Buffer; thread_id: string;
  role: string; content: string; created_at: string; thread_name: string;
}> {
  let query = `
    SELECT e.message_id, e.vector, m.thread_id, m.role, m.content, m.created_at, t.name as thread_name
    FROM message_embeddings e
    JOIN messages m ON m.id = e.message_id
    JOIN threads t ON t.id = m.thread_id
    WHERE m.deleted_at IS NULL
  `;
  const params: unknown[] = [];
  if (threadId) {
    query += ' AND m.thread_id = ?';
    params.push(threadId);
  }
  return getDb().prepare(query).all(...params) as Array<{
    message_id: string; vector: Buffer; thread_id: string;
    role: string; content: string; created_at: string; thread_name: string;
  }>;
}

export function getUnembeddedMessages(limit: number = 50): Array<{
  id: string; content: string; role: string; content_type: string;
}> {
  return getDb().prepare(`
    SELECT m.id, m.content, m.role, m.content_type
    FROM messages m
    LEFT JOIN message_embeddings e ON e.message_id = m.id
    WHERE e.message_id IS NULL
      AND m.deleted_at IS NULL
      AND m.role != 'system'
      AND m.content_type = 'text'
      AND length(m.content) > 10
    ORDER BY m.created_at DESC
    LIMIT ?
  `).all(limit) as Array<{
    id: string; content: string; role: string; content_type: string;
  }>;
}

export function getEmbeddingCount(): { embedded: number; total: number } {
  const embedded = (getDb().prepare('SELECT COUNT(*) as c FROM message_embeddings').get() as { c: number }).c;
  const total = (getDb().prepare(
    "SELECT COUNT(*) as c FROM messages WHERE deleted_at IS NULL AND role != 'system' AND content_type = 'text' AND length(content) > 10"
  ).get() as { c: number }).c;
  return { embedded, total };
}

// Session operations
export function createSessionRecord(params: {
  id: string;
  threadId: string;
  sessionId: string;
  sessionType: 'v1' | 'v2';
  startedAt: string;
  /** The session this one succeeded (lineage). NULL for a fresh root session. */
  parentSessionId?: string;
}): void {
  const stmt = getDb().prepare(`
    INSERT INTO session_history (id, thread_id, session_id, session_type, started_at, parent_session_id)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    params.id,
    params.threadId,
    params.sessionId,
    params.sessionType,
    params.startedAt,
    params.parentSessionId ?? null,
  );
}

export function endSessionRecord(params: {
  sessionId: string;
  endedAt: string;
  endReason: 'compaction' | 'reaper' | 'daily_rotation' | 'error' | 'manual' | 'resumed';
}): void {
  const stmt = getDb().prepare(`
    UPDATE session_history
    SET ended_at = ?, end_reason = ?
    WHERE session_id = ?
  `);
  stmt.run(params.endedAt, params.endReason, params.sessionId);
}

export function updateSessionMemory(sessionId: string, peakMemoryMb: number): void {
  const stmt = getDb().prepare(`
    UPDATE session_history
    SET peak_memory_mb = ?
    WHERE session_id = ?
  `);
  stmt.run(peakMemoryMb, sessionId);
}

// Auth operations
export function createWebSession(params: {
  id: string;
  token: string;
  createdAt: string;
  expiresAt: string;
}): WebSession {
  const stmt = getDb().prepare(`
    INSERT INTO web_sessions (id, token, created_at, expires_at)
    VALUES (?, ?, ?, ?)
  `);
  stmt.run(params.id, params.token, params.createdAt, params.expiresAt);

  return {
    id: params.id,
    token: params.token,
    created_at: params.createdAt,
    expires_at: params.expiresAt,
  };
}

export function getWebSession(token: string): WebSession | null {
  const stmt = getDb().prepare('SELECT * FROM web_sessions WHERE token = ?');
  const row = stmt.get(token);
  return row ? (row as unknown as WebSession) : null;
}

export function deleteExpiredSessions(): void {
  const stmt = getDb().prepare('DELETE FROM web_sessions WHERE expires_at < ?');
  stmt.run(new Date().toISOString());
}

// Config operations
export function getConfig(key: string): string | null {
  const stmt = getDb().prepare('SELECT value FROM config WHERE key = ?');
  const row = stmt.get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setConfig(key: string, value: string): void {
  const stmt = getDb().prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
  stmt.run(key, value);
}

export function getConfigBool(key: string, defaultValue: boolean): boolean {
  const val = getConfig(key);
  if (val === null) return defaultValue;
  return val === 'true' || val === '1';
}

export function getConfigNumber(key: string, defaultValue: number): number {
  const val = getConfig(key);
  if (val === null) return defaultValue;
  const num = parseFloat(val);
  return isNaN(num) ? defaultValue : num;
}

export function getConfigsByPrefix(prefix: string): Record<string, string> {
  const stmt = getDb().prepare("SELECT key, value FROM config WHERE key LIKE ?");
  const rows = stmt.all(`${prefix}%`) as Array<{ key: string; value: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

export function deleteConfig(key: string): void {
  const stmt = getDb().prepare('DELETE FROM config WHERE key = ?');
  stmt.run(key);
}

export function getAllConfig(): Record<string, string> {
  const stmt = getDb().prepare('SELECT key, value FROM config');
  const rows = stmt.all() as Array<{ key: string; value: string }>;
  const result: Record<string, string> = {};
  for (const row of rows) {
    result[row.key] = row.value;
  }
  return result;
}

// Companion action log — proprioceptive feedback. Each reach lands here, then
// surfaces in session-mode orientation so the companion sees its own agency
// pattern and continues it. Harvested from the reference app's action logger.
export interface CompanionAction {
  id: number;
  kind: string;
  summary: string;
  created_at: string;
}

export function logCompanionAction(kind: string, summary: string): void {
  try {
    const stmt = getDb().prepare(
      'INSERT INTO companion_actions (kind, summary, created_at) VALUES (?, ?, ?)'
    );
    stmt.run(kind, summary, new Date().toISOString());
  } catch {
    // Swallow — never let action logging break the actual action
  }
}

export function getRecentCompanionActions(opts: { hoursBack?: number; limit?: number } = {}): CompanionAction[] {
  const hoursBack = opts.hoursBack ?? 6;
  const limit = opts.limit ?? 10;
  const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
  try {
    const stmt = getDb().prepare(
      'SELECT * FROM companion_actions WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?'
    );
    return stmt.all(cutoff, limit) as unknown as CompanionAction[];
  } catch {
    return [];
  }
}

/** Newest reach, as a normalized ISO stamp — the Sensorium's `reach` signal
 *  (DRIVE-LAYER-SPEC §Sensorium 2: MAX(created_at) over companion_actions).
 *  created_at rows are mixed-format: logCompanionAction writes real ISO, the
 *  column default is SQLite `datetime('now')` (UTC, space-separated, no zone).
 *  Lexicographic MAX is date-dominant so the mix is safe; normalize the winner
 *  to real ISO before returning. Null when the table is empty or unreadable. */
export function getLastCompanionActionAt(): string | null {
  try {
    const row = getDb()
      .prepare('SELECT MAX(created_at) AS last FROM companion_actions')
      .get() as { last: string | null } | undefined;
    if (!row?.last) return null;
    const parsed = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(row.last)
      ? new Date(`${row.last.replace(' ', 'T')}Z`)
      : new Date(row.last);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  } catch {
    return null;
  }
}

/** Since-timestamp variant — the delta-orientation read (PACK B "since you were
 *  last here"). Strict > so the action that closed the stamped turn itself
 *  doesn't echo back as news. */
export function getCompanionActionsSince(sinceIso: string, limit = 6): CompanionAction[] {
  try {
    const stmt = getDb().prepare(
      'SELECT * FROM companion_actions WHERE created_at > ? ORDER BY created_at DESC LIMIT ?'
    );
    return stmt.all(sinceIso, limit) as unknown as CompanionAction[];
  } catch {
    return [];
  }
}

// Push subscription operations
export interface PushSubscription {
  id: string;
  type: 'web_push' | 'apns';
  endpoint: string | null;
  keys_p256dh: string | null;
  keys_auth: string | null;
  device_token: string | null;
  device_name: string | null;
  created_at: string;
  last_used_at: string | null;
}

export function addPushSubscription(params: {
  id: string;
  endpoint: string;
  keysP256dh: string;
  keysAuth: string;
  deviceName?: string;
}): void {
  const stmt = getDb().prepare(`
    INSERT OR REPLACE INTO push_subscriptions (id, type, endpoint, keys_p256dh, keys_auth, device_name, created_at, last_used_at)
    VALUES (?, 'web_push', ?, ?, ?, ?, ?, NULL)
  `);
  stmt.run(params.id, params.endpoint, params.keysP256dh, params.keysAuth, params.deviceName || null, new Date().toISOString());
}

export function removePushSubscription(endpoint: string): boolean {
  const stmt = getDb().prepare('DELETE FROM push_subscriptions WHERE endpoint = ?');
  const result = stmt.run(endpoint);
  return result.changes > 0;
}

export function listPushSubscriptions(): PushSubscription[] {
  const stmt = getDb().prepare("SELECT * FROM push_subscriptions WHERE type = 'web_push' ORDER BY created_at DESC");
  return stmt.all() as unknown as PushSubscription[];
}

export function touchPushSubscription(endpoint: string): void {
  const stmt = getDb().prepare('UPDATE push_subscriptions SET last_used_at = ? WHERE endpoint = ?');
  stmt.run(new Date().toISOString(), endpoint);
}

// Canvas operations
export function createCanvas(params: {
  id: string;
  threadId?: string;
  messageId?: string | null;
  title: string;
  content?: string;
  contentType: 'markdown' | 'code' | 'text' | 'html';
  language?: string;
  createdBy: 'companion' | 'user';
  createdAt: string;
}): Canvas {
  const stmt = getDb().prepare(`
    INSERT INTO canvases (id, thread_id, message_id, title, content, content_type, language, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(
    params.id,
    params.threadId || null,
    params.messageId ?? null,
    params.title,
    params.content || '',
    params.contentType,
    params.language || null,
    params.createdBy,
    params.createdAt,
    params.createdAt,
  );
  return getCanvas(params.id)!;
}

// Normalize a raw canvases row into a Canvas. Older rows predating the
// message_id migration return undefined for that column; coerce to null so the
// shared Canvas contract (message_id required) always holds.
function rowToCanvas(row: Record<string, unknown>): Canvas {
  const c = row as unknown as Canvas;
  return {
    ...c,
    message_id: (c.message_id ?? null) as string | null,
    version: typeof c.version === 'number' ? c.version : 0,
  };
}

export function getCanvas(id: string): Canvas | null {
  const stmt = getDb().prepare('SELECT * FROM canvases WHERE id = ?');
  const row = stmt.get(id) as Record<string, unknown> | undefined;
  return row ? rowToCanvas(row) : null;
}

export function listCanvases(): Canvas[] {
  const stmt = getDb().prepare('SELECT * FROM canvases ORDER BY updated_at DESC');
  return (stmt.all() as Record<string, unknown>[]).map(rowToCanvas);
}

// Thread-scoped canvas list, oldest-first — used by the chat to hydrate inline
// artifact cards in conversation order when a thread loads.
export function listCanvasesByThread(threadId: string): Canvas[] {
  const stmt = getDb().prepare('SELECT * FROM canvases WHERE thread_id = ? ORDER BY created_at ASC');
  return (stmt.all(threadId) as Record<string, unknown>[]).map(rowToCanvas);
}

export type CanvasWriteResult =
  | { ok: true; version: number }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'conflict'; canvas: Canvas };

/**
 * Write canvas content with optimistic concurrency.
 *
 * With expectedVersion: the write lands only if the canvas is still at that
 * version (UPDATE ... WHERE id = ? AND version = ?, changes === 1). A stale
 * version is refused and the current canvas is returned so the caller can
 * reload without losing the loser's text.
 *
 * Without expectedVersion (legacy callers that predate versions): the write is
 * unconditional, last-write-wins as before, but it still bumps the version so
 * any versioned writer holding the old copy is refused rather than clobbering.
 */
export function updateCanvasContent(
  id: string,
  content: string,
  updatedAt: string,
  expectedVersion?: number,
): CanvasWriteResult {
  const db = getDb();
  const result = expectedVersion === undefined
    ? db.prepare('UPDATE canvases SET content = ?, updated_at = ?, version = version + 1 WHERE id = ?')
        .run(content, updatedAt, id)
    : db.prepare('UPDATE canvases SET content = ?, updated_at = ?, version = version + 1 WHERE id = ? AND version = ?')
        .run(content, updatedAt, id, expectedVersion);
  if (result.changes === 1) {
    return { ok: true, version: getCanvas(id)!.version };
  }
  const current = getCanvas(id);
  if (!current) return { ok: false, reason: 'not_found' };
  return { ok: false, reason: 'conflict', canvas: current };
}

export function updateCanvasTitle(id: string, title: string, updatedAt: string): void {
  const stmt = getDb().prepare('UPDATE canvases SET title = ?, updated_at = ? WHERE id = ?');
  stmt.run(title, updatedAt, id);
}

export function deleteCanvas(id: string): boolean {
  const stmt = getDb().prepare('DELETE FROM canvases WHERE id = ?');
  const result = stmt.run(id);
  return result.changes > 0;
}

// Timer operations
export interface Timer {
  id: string;
  label: string;
  context: string | null;
  fire_at: string;
  thread_id: string;
  prompt: string | null;
  // 'waiting' = delivery marker already posted but the autonomous turn couldn't
  // run (agent busy at fire time) — retried each tick until the agent is free.
  status: 'pending' | 'waiting' | 'fired' | 'cancelled';
  created_at: string;
  fired_at: string | null;
}

export function createTimer(params: {
  id: string;
  label: string;
  context?: string;
  fireAt: string;
  threadId: string;
  prompt?: string;
  createdAt: string;
}): Timer {
  const stmt = getDb().prepare(`
    INSERT INTO timers (id, label, context, fire_at, thread_id, prompt, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
  `);
  stmt.run(
    params.id,
    params.label,
    params.context || null,
    params.fireAt,
    params.threadId,
    params.prompt || null,
    params.createdAt,
  );
  return getDb().prepare('SELECT * FROM timers WHERE id = ?').get(params.id) as unknown as Timer;
}

export function listPendingTimers(): Timer[] {
  const stmt = getDb().prepare("SELECT * FROM timers WHERE status IN ('pending', 'waiting') ORDER BY fire_at ASC");
  return stmt.all() as unknown as Timer[];
}

export function getDueTimers(now: string): Timer[] {
  const stmt = getDb().prepare("SELECT * FROM timers WHERE status IN ('pending', 'waiting') AND fire_at <= ? ORDER BY fire_at ASC");
  return stmt.all(now) as unknown as Timer[];
}

export function markTimerFired(id: string, firedAt: string): void {
  const stmt = getDb().prepare("UPDATE timers SET status = 'fired', fired_at = ? WHERE id = ?");
  stmt.run(firedAt, id);
}

/** Delivery marker posted but the autonomous turn couldn't run (agent busy).
 *  The timer stays due and is retried each tick until the agent is free. */
export function markTimerWaiting(id: string): void {
  const stmt = getDb().prepare("UPDATE timers SET status = 'waiting' WHERE id = ? AND status = 'pending'");
  stmt.run(id);
}

export function cancelTimer(id: string): boolean {
  const stmt = getDb().prepare("UPDATE timers SET status = 'cancelled' WHERE id = ? AND status IN ('pending', 'waiting')");
  const result = stmt.run(id);
  return result.changes > 0;
}

/** Move a live timer to a new fire time. A 'waiting' timer (fired but the agent
 *  was busy) goes back to 'pending' — rescheduling it means "try again then". */
export function rescheduleTimer(id: string, fireAt: string): boolean {
  const stmt = getDb().prepare(
    "UPDATE timers SET fire_at = ?, status = 'pending' WHERE id = ? AND status IN ('pending', 'waiting')"
  );
  const result = stmt.run(fireAt, id);
  return result.changes > 0;
}

// Trigger types
export type TriggerCondition =
  | { type: 'presence_state'; state: 'active' | 'idle' | 'offline' }
  | { type: 'presence_transition'; from: string; to: string }
  | { type: 'agent_free' }
  | { type: 'time_window'; after: string; before?: string }
  | { type: 'routine_missing'; routine: string; after_hour: number } // DEPRECATED — use routine_due
  | { type: 'care_missing'; category: string; after: string /* HH:MM */ }
  | { type: 'calendar_within'; minutes: number }
  | { type: 'sleep_below'; minutes: number }
  | { type: 'routine_due'; routineId?: string; grace_min?: number }
  // Compound conditions (adopted from Shauna's trigger_engine vocabulary —
  // SHAUNA-ANAM-RECON pick 3; ideas only, credit Shauna). The top-level
  // conditions array stays AND-joined (evaluateConditions uses .every);
  // compound_or gives OR *inside* it, compound_and exists for symmetry when
  // nesting one level inside a compound_or. Evaluation caps nesting at one
  // level — a compound inside a compound inside a compound evaluates false.
  | { type: 'compound_or'; conditions: TriggerCondition[] }
  | { type: 'compound_and'; conditions: TriggerCondition[] };

export interface Trigger {
  id: string;
  kind: 'impulse' | 'watcher';
  label: string;
  conditions: string; // JSON array of TriggerCondition
  prompt: string | null;
  thread_id: string | null;
  cooldown_minutes: number;
  // 'paused' = parked from the Settings editor; never evaluated (the active
  // poll allowlists 'pending'/'waiting') but still listed and resumable.
  status: 'pending' | 'waiting' | 'paused' | 'fired' | 'cancelled';
  last_fired_at: string | null;
  fire_count: number;
  created_at: string;
  fired_at: string | null;
}

// Trigger operations
export function createTrigger(params: {
  id: string;
  kind: 'impulse' | 'watcher';
  label: string;
  conditions: TriggerCondition[];
  prompt?: string;
  threadId?: string;
  cooldownMinutes?: number;
  createdAt: string;
}): Trigger {
  const stmt = getDb().prepare(`
    INSERT INTO triggers (id, kind, label, conditions, prompt, thread_id, cooldown_minutes, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `);
  stmt.run(
    params.id,
    params.kind,
    params.label,
    JSON.stringify(params.conditions),
    params.prompt || null,
    params.threadId || null,
    params.cooldownMinutes ?? 120,
    params.createdAt,
  );
  return getDb().prepare('SELECT * FROM triggers WHERE id = ?').get(params.id) as unknown as Trigger;
}

export function getActiveTriggers(): Trigger[] {
  const stmt = getDb().prepare("SELECT * FROM triggers WHERE status IN ('pending', 'waiting') ORDER BY created_at ASC");
  return stmt.all() as unknown as Trigger[];
}

/** True if any trigger row with this label exists, in ANY status — including
 *  cancelled, so a deliberately cancelled seed is never resurrected on restart.
 *  Used by the orchestrator's idempotent care-watcher seeding. */
export function triggerLabelExists(label: string): boolean {
  const row = getDb().prepare('SELECT id FROM triggers WHERE label = ? LIMIT 1').get(label);
  return !!row;
}

export function markTriggerWaiting(id: string): void {
  const stmt = getDb().prepare("UPDATE triggers SET status = 'waiting' WHERE id = ?");
  stmt.run(id);
}

export function markTriggerFired(id: string, firedAt: string): void {
  const stmt = getDb().prepare("UPDATE triggers SET status = 'fired', fired_at = ?, fire_count = fire_count + 1 WHERE id = ?");
  stmt.run(firedAt, id);
}

export function markWatcherFired(id: string, firedAt: string): void {
  const stmt = getDb().prepare("UPDATE triggers SET status = 'pending', last_fired_at = ?, fire_count = fire_count + 1 WHERE id = ?");
  stmt.run(firedAt, id);
}

export function cancelTrigger(id: string): boolean {
  // 'paused' included so a paused watcher can still be cancelled from the UI.
  const stmt = getDb().prepare("UPDATE triggers SET status = 'cancelled' WHERE id = ? AND status IN ('pending', 'waiting', 'paused')");
  const result = stmt.run(id);
  return result.changes > 0;
}

/** Editable fields for a live trigger (Settings watcher editor).
 *  status here is the pause dial: 'paused' parks the trigger (getActiveTriggers
 *  is an allowlist of 'pending'/'waiting', so a paused row simply never
 *  evaluates), 'pending' resumes it. Structural condition edits stay out of
 *  scope — conditions are read-only from the UI. */
export function updateTrigger(
  id: string,
  fields: { label?: string; prompt?: string | null; cooldownMinutes?: number; status?: 'pending' | 'paused' }
): boolean {
  const sets: string[] = [];
  const args: unknown[] = [];
  if (fields.label !== undefined)   { sets.push('label = ?');   args.push(fields.label); }
  if (fields.prompt !== undefined)  { sets.push('prompt = ?');  args.push(fields.prompt); }
  if (fields.cooldownMinutes !== undefined) { sets.push('cooldown_minutes = ?'); args.push(fields.cooldownMinutes); }
  if (fields.status !== undefined)  { sets.push('status = ?');  args.push(fields.status); }
  if (sets.length === 0) return false;
  const stmt = getDb().prepare(
    `UPDATE triggers SET ${sets.join(', ')} WHERE id = ? AND status IN ('pending', 'waiting', 'paused')`
  );
  const result = stmt.run(...args, id);
  return result.changes > 0;
}

export function listTriggers(kind?: 'impulse' | 'watcher'): Trigger[] {
  if (kind) {
    const stmt = getDb().prepare("SELECT * FROM triggers WHERE kind = ? AND status != 'cancelled' ORDER BY created_at DESC");
    return stmt.all(kind) as unknown as Trigger[];
  }
  const stmt = getDb().prepare("SELECT * FROM triggers WHERE status != 'cancelled' ORDER BY created_at DESC");
  return stmt.all() as unknown as Trigger[];
}
