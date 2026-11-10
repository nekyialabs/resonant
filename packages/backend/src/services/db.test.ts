import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock embeddings to avoid loading HuggingFace ML model
vi.mock('./embeddings.js', () => ({
  embed: vi.fn().mockResolvedValue(new Float32Array(384)),
  vectorToBuffer: vi.fn().mockReturnValue(Buffer.alloc(384 * 4)),
}));

// Mock vector cache
vi.mock('./vector-cache.js', () => ({
  cacheEmbedding: vi.fn(),
  removeEmbedding: vi.fn(),
}));

// Mock config
vi.mock('../config.js', () => ({
  getResonantConfig: vi.fn().mockReturnValue({
    identity: { companion_name: 'Test', user_name: 'User', timezone: 'UTC' },
    server: { port: 3002, host: 'localhost', db_path: ':memory:' },
    hooks: { context_injection: false, safe_write_prefixes: [] },
  }),
  PROJECT_ROOT: '/tmp/test',
}));

import {
  initDb,
  getDb,
  createThread,
  getThread,
  listThreads,
  archiveThread,
  deleteThread,
  createMessage,
  getMessage,
  getMessages,
  markMessagesRead,
  addReaction,
  removeReaction,
  saveEmbedding,
  createCanvas,
  getCanvas,
  listCanvases,
  deleteCanvas,
  updateCanvasContent,
  createTimer,
  listPendingTimers,
  cancelTimer,
  getConfig,
  setConfig,
  getConfigBool,
} from './db.js';

beforeEach(() => {
  initDb(':memory:');
});

function makeThread(overrides: Partial<{ id: string; name: string; type: 'daily' | 'named' }> = {}) {
  const id = overrides.id || `thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return createThread({
    id,
    name: overrides.name || 'Test Thread',
    type: overrides.type || 'daily',
    createdAt: new Date().toISOString(),
  });
}

function makeMessage(threadId: string, overrides: Partial<{ id: string; role: 'companion' | 'user' | 'system'; content: string }> = {}) {
  const id = overrides.id || `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return createMessage({
    id,
    threadId,
    role: overrides.role || 'user',
    content: overrides.content || 'short',  // Keep short to avoid triggering embeddings
    createdAt: new Date().toISOString(),
  });
}

describe('Thread operations', () => {
  it('creates and retrieves a thread', () => {
    const thread = makeThread({ id: 'th-1', name: 'My Thread' });
    expect(thread.id).toBe('th-1');
    expect(thread.name).toBe('My Thread');
    expect(thread.type).toBe('daily');
    expect(thread.archived_at).toBeNull();

    const fetched = getThread('th-1');
    expect(fetched).not.toBeNull();
    expect(fetched!.name).toBe('My Thread');
  });

  it('returns null for non-existent thread', () => {
    expect(getThread('nope')).toBeNull();
  });

  it('lists threads excluding archived', () => {
    makeThread({ id: 'th-a', name: 'Active' });
    makeThread({ id: 'th-b', name: 'Archived' });
    archiveThread('th-b', new Date().toISOString());

    const threads = listThreads({});
    expect(threads.length).toBe(1);
    expect(threads[0].id).toBe('th-a');
  });

  it('lists threads including archived', () => {
    makeThread({ id: 'th-a' });
    makeThread({ id: 'th-b' });
    archiveThread('th-b', new Date().toISOString());

    const threads = listThreads({ includeArchived: true });
    expect(threads.length).toBe(2);
  });

  it('archives a thread', () => {
    makeThread({ id: 'th-1' });
    archiveThread('th-1', '2026-01-01T00:00:00Z');

    const thread = getThread('th-1');
    expect(thread!.archived_at).toBe('2026-01-01T00:00:00Z');
  });

  it('deletes thread and all related data', () => {
    makeThread({ id: 'th-del' });
    makeMessage('th-del', { id: 'msg-1' });
    makeMessage('th-del', { id: 'msg-2' });
    createCanvas({
      id: 'canvas-1', threadId: 'th-del', title: 'Test',
      contentType: 'text', createdBy: 'user', createdAt: new Date().toISOString(),
    });

    const fileIds = deleteThread('th-del');
    expect(Array.isArray(fileIds)).toBe(true);
    expect(getThread('th-del')).toBeNull();
    expect(getMessage('msg-1')).toBeNull();
    expect(getMessage('msg-2')).toBeNull();
    expect(getCanvas('canvas-1')).toBeNull();
  });
});

describe('Message operations', () => {
  it('creates and retrieves a message', () => {
    const thread = makeThread({ id: 'th-msg' });
    const msg = makeMessage('th-msg', { id: 'msg-1', content: 'hello', role: 'user' });

    expect(msg.id).toBe('msg-1');
    expect(msg.content).toBe('hello');
    expect(msg.role).toBe('user');
    expect(msg.sequence).toBe(1);

    const fetched = getMessage('msg-1');
    expect(fetched).not.toBeNull();
    expect(fetched!.content).toBe('hello');
  });

  it('returns null for non-existent message', () => {
    expect(getMessage('nope')).toBeNull();
  });

  it('auto-increments sequence numbers', () => {
    makeThread({ id: 'th-seq' });
    const msg1 = makeMessage('th-seq', { id: 'msg-s1' });
    const msg2 = makeMessage('th-seq', { id: 'msg-s2' });
    const msg3 = makeMessage('th-seq', { id: 'msg-s3' });

    expect(msg1.sequence).toBe(1);
    expect(msg2.sequence).toBe(2);
    expect(msg3.sequence).toBe(3);
  });

  it('getMessages returns in chronological order', () => {
    makeThread({ id: 'th-order' });
    makeMessage('th-order', { id: 'msg-a', content: 'first' });
    makeMessage('th-order', { id: 'msg-b', content: 'second' });
    makeMessage('th-order', { id: 'msg-c', content: 'third' });

    const messages = getMessages({ threadId: 'th-order' });
    expect(messages.length).toBe(3);
    expect(messages[0].content).toBe('first');
    expect(messages[2].content).toBe('third');
  });

  it('getMessages respects limit', () => {
    makeThread({ id: 'th-lim' });
    for (let i = 0; i < 10; i++) {
      makeMessage('th-lim', { id: `msg-l${i}` });
    }

    const messages = getMessages({ threadId: 'th-lim', limit: 3 });
    expect(messages.length).toBe(3);
  });

  it('creates message with metadata', () => {
    makeThread({ id: 'th-meta' });
    const msg = createMessage({
      id: 'msg-meta',
      threadId: 'th-meta',
      role: 'companion',
      content: 'hi',
      metadata: { tool: 'test', count: 42 },
      createdAt: new Date().toISOString(),
    });

    const fetched = getMessage('msg-meta');
    expect(fetched!.metadata).toEqual({ tool: 'test', count: 42 });
  });
});

describe('markMessagesRead', () => {
  it('marks messages read and resets thread unread count', () => {
    makeThread({ id: 'th-read' });
    makeMessage('th-read', { id: 'msg-r1', role: 'companion' });
    makeMessage('th-read', { id: 'msg-r2', role: 'companion' });

    // Simulate unread count being incremented
    getDb().prepare('UPDATE threads SET unread_count = 2 WHERE id = ?').run('th-read');

    const readAt = new Date().toISOString();
    markMessagesRead('th-read', 'msg-r2', readAt);

    // Both messages should have read_at set
    const msg1 = getMessage('msg-r1');
    const msg2 = getMessage('msg-r2');
    expect(msg1!.read_at).toBe(readAt);
    expect(msg2!.read_at).toBe(readAt);

    // Thread unread count should be reset
    const thread = getThread('th-read');
    expect(thread!.unread_count).toBe(0);
  });
});

describe('Reaction operations', () => {
  it('adds a reaction to a message', () => {
    makeThread({ id: 'th-react' });
    makeMessage('th-react', { id: 'msg-react' });

    addReaction('msg-react', '👍', 'user');

    const msg = getMessage('msg-react');
    const reactions = (msg!.metadata as Record<string, unknown>)?.reactions as Array<{ emoji: string; user: string }>;
    expect(reactions).toHaveLength(1);
    expect(reactions[0].emoji).toBe('👍');
    expect(reactions[0].user).toBe('user');
  });

  it('deduplicates same user + emoji', () => {
    makeThread({ id: 'th-dedup' });
    makeMessage('th-dedup', { id: 'msg-dedup' });

    addReaction('msg-dedup', '👍', 'user');
    addReaction('msg-dedup', '👍', 'user');

    const msg = getMessage('msg-dedup');
    const reactions = (msg!.metadata as Record<string, unknown>)?.reactions as Array<{ emoji: string; user: string }>;
    expect(reactions).toHaveLength(1);
  });

  it('allows different users same emoji', () => {
    makeThread({ id: 'th-diff' });
    makeMessage('th-diff', { id: 'msg-diff' });

    addReaction('msg-diff', '👍', 'user');
    addReaction('msg-diff', '👍', 'companion');

    const msg = getMessage('msg-diff');
    const reactions = (msg!.metadata as Record<string, unknown>)?.reactions as Array<{ emoji: string; user: string }>;
    expect(reactions).toHaveLength(2);
  });

  it('removes a reaction', () => {
    makeThread({ id: 'th-rm' });
    makeMessage('th-rm', { id: 'msg-rm' });

    addReaction('msg-rm', '👍', 'user');
    addReaction('msg-rm', '❤️', 'companion');
    removeReaction('msg-rm', '👍', 'user');

    const msg = getMessage('msg-rm');
    const reactions = (msg!.metadata as Record<string, unknown>)?.reactions as Array<{ emoji: string; user: string }>;
    expect(reactions).toHaveLength(1);
    expect(reactions[0].emoji).toBe('❤️');
  });

  it('no-ops when removing non-existent reaction', () => {
    makeThread({ id: 'th-noop' });
    makeMessage('th-noop', { id: 'msg-noop' });

    addReaction('msg-noop', '👍', 'user');
    removeReaction('msg-noop', '❤️', 'user');

    const msg = getMessage('msg-noop');
    const reactions = (msg!.metadata as Record<string, unknown>)?.reactions as Array<{ emoji: string; user: string }>;
    expect(reactions).toHaveLength(1);
  });

  it('no-ops for non-existent message', () => {
    addReaction('nope', '👍', 'user');
    removeReaction('nope', '👍', 'user');
    // Should not throw
  });
});

describe('Canvas operations', () => {
  it('creates and retrieves a canvas', () => {
    const canvas = createCanvas({
      id: 'cv-1', title: 'Test Canvas', content: '# Hello',
      contentType: 'markdown', createdBy: 'companion', createdAt: new Date().toISOString(),
    });

    expect(canvas.id).toBe('cv-1');
    expect(canvas.title).toBe('Test Canvas');

    const fetched = getCanvas('cv-1');
    expect(fetched).not.toBeNull();
    expect(fetched!.content).toBe('# Hello');
  });

  it('lists canvases', () => {
    createCanvas({ id: 'cv-a', title: 'A', contentType: 'text', createdBy: 'user', createdAt: new Date().toISOString() });
    createCanvas({ id: 'cv-b', title: 'B', contentType: 'text', createdBy: 'user', createdAt: new Date().toISOString() });

    const canvases = listCanvases();
    expect(canvases.length).toBe(2);
  });

  it('deletes a canvas', () => {
    createCanvas({ id: 'cv-del', title: 'Del', contentType: 'text', createdBy: 'user', createdAt: new Date().toISOString() });
    const deleted = deleteCanvas('cv-del');
    expect(deleted).toBe(true);
    expect(getCanvas('cv-del')).toBeNull();
  });

  it('returns false deleting non-existent canvas', () => {
    expect(deleteCanvas('nope')).toBe(false);
  });
});

describe('Canvas optimistic concurrency', () => {
  const mk = (id = 'cv-v') =>
    createCanvas({ id, title: 'V', content: 'v0 text', contentType: 'text', createdBy: 'user', createdAt: new Date().toISOString() });

  it('starts at version 0', () => {
    expect(mk().version).toBe(0);
  });

  it('accepts a write at the current version and increments it', () => {
    mk();
    const r1 = updateCanvasContent('cv-v', 'one', new Date().toISOString(), 0);
    expect(r1).toEqual({ ok: true, version: 1 });
    const r2 = updateCanvasContent('cv-v', 'two', new Date().toISOString(), 1);
    expect(r2).toEqual({ ok: true, version: 2 });
    expect(getCanvas('cv-v')).toMatchObject({ content: 'two', version: 2 });
  });

  it('refuses a stale version, writes nothing, and returns the current canvas', () => {
    mk();
    updateCanvasContent('cv-v', 'agent edit', new Date().toISOString(), 0); // wins the race
    const stale = updateCanvasContent('cv-v', 'human edit', new Date().toISOString(), 0);
    expect(stale.ok).toBe(false);
    if (!stale.ok && stale.reason === 'conflict') {
      expect(stale.canvas.content).toBe('agent edit');
      expect(stale.canvas.version).toBe(1);
    } else {
      throw new Error('expected a conflict');
    }
    expect(getCanvas('cv-v')).toMatchObject({ content: 'agent edit', version: 1 });
  });

  it('refuses a version from the future too', () => {
    mk();
    expect(updateCanvasContent('cv-v', 'x', new Date().toISOString(), 5).ok).toBe(false);
    expect(getCanvas('cv-v')!.content).toBe('v0 text');
  });

  it('legacy write without a version is unconditional but still bumps the version', () => {
    mk();
    const r = updateCanvasContent('cv-v', 'legacy', new Date().toISOString());
    expect(r).toEqual({ ok: true, version: 1 });
    // a versioned writer that loaded version 0 is now refused
    expect(updateCanvasContent('cv-v', 'stale', new Date().toISOString(), 0).ok).toBe(false);
    expect(getCanvas('cv-v')!.content).toBe('legacy');
  });

  it('reports not_found for a missing canvas', () => {
    expect(updateCanvasContent('nope', 'x', new Date().toISOString(), 0)).toEqual({ ok: false, reason: 'not_found' });
    expect(updateCanvasContent('nope', 'x', new Date().toISOString())).toEqual({ ok: false, reason: 'not_found' });
  });

  it('title updates do not change the content version', () => {
    mk();
    getDb().prepare('UPDATE canvases SET title = ? WHERE id = ?').run('renamed', 'cv-v');
    expect(getCanvas('cv-v')!.version).toBe(0);
  });

  it('migrates an existing database that has no version column', () => {
    const dir = mkdtempSync(join(tmpdir(), 'resonant-canvas-mig-'));
    const file = join(dir, 'old.db');
    try {
      initDb(file);
      createCanvas({ id: 'old-1', title: 'Old', content: 'kept', contentType: 'text', createdBy: 'user', createdAt: new Date().toISOString() });
      // Simulate a pre-version database.
      getDb().exec('ALTER TABLE canvases DROP COLUMN version');
      getDb().close();

      initDb(file); // migration runs on the existing data
      const migrated = getCanvas('old-1')!;
      expect(migrated.content).toBe('kept');
      expect(migrated.version).toBe(0);
      expect(updateCanvasContent('old-1', 'new', new Date().toISOString(), 0)).toEqual({ ok: true, version: 1 });

      getDb().close();
      initDb(file); // idempotent on a DB that already has the column
      expect(getCanvas('old-1')!.version).toBe(1);
    } finally {
      try { getDb().close(); } catch { /* already closed */ }
      initDb(':memory:');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Timer operations', () => {
  it('creates and lists pending timers', () => {
    makeThread({ id: 'th-timer' });
    createTimer({
      id: 'timer-1', label: 'Test Timer', fireAt: '2026-12-01T00:00:00Z',
      threadId: 'th-timer', createdAt: new Date().toISOString(),
    });

    const pending = listPendingTimers();
    expect(pending.length).toBe(1);
    expect(pending[0].label).toBe('Test Timer');
  });

  it('cancels a timer', () => {
    makeThread({ id: 'th-cancel' });
    createTimer({
      id: 'timer-c', label: 'Cancel Me', fireAt: '2026-12-01T00:00:00Z',
      threadId: 'th-cancel', createdAt: new Date().toISOString(),
    });

    const cancelled = cancelTimer('timer-c');
    expect(cancelled).toBe(true);

    const pending = listPendingTimers();
    expect(pending.length).toBe(0);
  });
});

describe('Config operations', () => {
  it('gets default config values', () => {
    // initDb sets dnd_start and dnd_end defaults
    expect(getConfig('dnd_start')).toBe('23:00');
    expect(getConfig('dnd_end')).toBe('07:00');
  });

  it('sets and gets config', () => {
    setConfig('test_key', 'test_value');
    expect(getConfig('test_key')).toBe('test_value');
  });

  it('returns null for missing config', () => {
    expect(getConfig('nonexistent')).toBeNull();
  });

  it('getConfigBool returns boolean', () => {
    setConfig('flag_true', 'true');
    setConfig('flag_one', '1');
    setConfig('flag_false', 'false');

    expect(getConfigBool('flag_true', false)).toBe(true);
    expect(getConfigBool('flag_one', false)).toBe(true);
    expect(getConfigBool('flag_false', true)).toBe(false);
    expect(getConfigBool('nonexistent', true)).toBe(true);
  });
});

describe('Embedding operations', () => {
  it('saves and replaces embedding', () => {
    makeThread({ id: 'th-emb' });
    makeMessage('th-emb', { id: 'msg-emb' });

    const vector1 = Buffer.alloc(384 * 4);
    saveEmbedding('msg-emb', vector1);

    // Save again — INSERT OR REPLACE should work
    const vector2 = Buffer.alloc(384 * 4, 1);
    saveEmbedding('msg-emb', vector2);

    // Should not throw — if it does, the OR REPLACE is broken
  });
});
