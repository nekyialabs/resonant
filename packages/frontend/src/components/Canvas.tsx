/**
 * Canvas — two-pane CanvasView: list (left) + editor (right).
 *
 * CanvasView  — top-level export; drop into a route.
 * CanvasEditor — internal; editor/preview pane for a single canvas.
 *
 * Backend contract (built in parallel):
 *   GET    /api/canvas          → CanvasMeta[]
 *   GET    /api/canvas/:id      → CanvasFull
 *   POST   /api/canvas          body {title, content, content_type, language?}
 *   PUT    /api/canvas/:id      body {title?, content?}
 *   DELETE /api/canvas/:id
 */
import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import { renderMarkdown } from '../utils/markdown';
import { CanvasList } from './CanvasList';
import type { CanvasMeta, ContentType } from './CanvasList';
import { useConfirm } from './ConfirmDialog';

// ─── Base URL (matches SettingsView pattern) ───────────────────────────────────

const BASE = import.meta.env.DEV ? 'http://127.0.0.1:3099' : '';

// ─── Types ─────────────────────────────────────────────────────────────────────

interface CanvasFull extends CanvasMeta {
  content: string;
  version?: number;
  language?: string;
}

// ─── API helpers ───────────────────────────────────────────────────────────────

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'Content-Type': 'application/json', ...init?.headers },
    ...init,
  });
  if (!res.ok) throw new HttpError(res.status, `${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// ─── SVGs ──────────────────────────────────────────────────────────────────────

function IconEye() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function IconEdit() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

function IconTrash() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2" />
    </svg>
  );
}

// ─── CanvasEditor ──────────────────────────────────────────────────────────────

interface CanvasEditorProps {
  canvas: CanvasFull;
  onSaved: (updated: Partial<CanvasMeta> & { id: string }) => void;
  onDeleted: (id: string) => void;
}

function CanvasEditor({ canvas, onSaved, onDeleted }: CanvasEditorProps) {
  const confirm = useConfirm();
  const [localTitle, setLocalTitle] = useState(canvas.title);
  const [localContent, setLocalContent] = useState(canvas.content);
  const [isDirty, setIsDirty] = useState(false);
  const [editMode, setEditMode] = useState(true);
  const [saving, setSaving] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Version this edit session is based on (sent with every save so a save made
  // after someone else changed the canvas is refused instead of overwriting).
  const baseVersionRef = useRef(canvas.version ?? 0);
  // Unsaved text kept after a refused save; autosave is paused while set.
  const [conflictMine, setConflictMine] = useState<string | null>(null);
  const conflictRef = useRef<string | null>(null);
  conflictRef.current = conflictMine;

  // When canvas id changes, sync from fresh fetch result
  useEffect(() => {
    setLocalTitle(canvas.title);
    setLocalContent(canvas.content);
    setIsDirty(false);
    setEditMode(true);
    baseVersionRef.current = canvas.version ?? 0;
    setConflictMine(null);
  }, [canvas.id]);

  // If parent refreshes the canvas record (not an id switch), pull non-dirty fields
  useEffect(() => {
    if (!isDirty) {
      setLocalTitle(canvas.title);
      setLocalContent(canvas.content);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvas.title, canvas.content]);

  const flushSave = useCallback(async (content: string) => {
    if (conflictRef.current !== null) return;
    setSaving(true);
    try {
      const res = await apiFetch<{ version?: number }>(`/api/canvases/${canvas.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ content, version: baseVersionRef.current }),
      });
      if (typeof res.version === 'number') baseVersionRef.current = res.version;
      setIsDirty(false);
      onSaved({ id: canvas.id });
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) {
        // Someone else saved first. Keep the user's text, stop autosaving.
        setConflictMine(content);
      }
      // Other errors are non-fatal — dirty flag stays, retried on next keystroke
    } finally {
      setSaving(false);
    }
  }, [canvas.id, onSaved]);

  async function fetchLatest(): Promise<CanvasFull | null> {
    try {
      return (await apiFetch<{ canvas: CanvasFull }>(`/api/canvases/${canvas.id}`)).canvas;
    } catch {
      return null;
    }
  }

  async function handleConflictCopy() {
    try { await navigator.clipboard.writeText(conflictMine ?? ''); } catch { /* clipboard denied */ }
  }

  async function handleConflictKeepMine() {
    const mine = conflictMine;
    const latest = await fetchLatest();
    if (mine === null || !latest) return;
    // Deliberate overwrite: rebase onto the latest version, then save our text.
    baseVersionRef.current = latest.version ?? 0;
    conflictRef.current = null;
    setConflictMine(null);
    await flushSave(mine);
  }

  async function handleConflictUseLatest() {
    const latest = await fetchLatest();
    if (!latest) return;
    baseVersionRef.current = latest.version ?? 0;
    setLocalContent(latest.content);
    setIsDirty(false);
    setConflictMine(null);
  }

  function handleContentChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const value = e.target.value;
    setLocalContent(value);
    setIsDirty(true);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      flushSave(value);
    }, 500);
  }

  async function handleTitleBlur() {
    const trimmed = localTitle.trim() || 'Untitled';
    if (trimmed === canvas.title) return;
    try {
      await apiFetch(`/api/canvases/${canvas.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ title: trimmed }),
      });
      onSaved({ id: canvas.id, title: trimmed });
    } catch { /* ignore */ }
  }

  function handleTitleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') e.currentTarget.blur();
  }

  function handleToggleMode() {
    // Flush pending save before entering preview
    if (editMode && saveTimer.current) {
      clearTimeout(saveTimer.current);
      flushSave(localContent);
    }
    setEditMode(m => !m);
  }

  async function handleDelete() {
    const ok = await confirm({
      title: `Delete "${canvas.title}"?`,
      body: 'This canvas will be permanently removed.',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      destructive: true,
    });
    if (!ok) return;
    try {
      await apiFetch(`/api/canvases/${canvas.id}`, { method: 'DELETE' });
      onDeleted(canvas.id);
    } catch { /* ignore */ }
  }

  const isMarkupType = canvas.content_type === 'markdown' || canvas.content_type === 'html';
  const isMono = canvas.content_type === 'code' || canvas.content_type === 'html';

  const badgeLabel =
    canvas.content_type === 'code'
      ? canvas.language ?? 'code'
      : canvas.content_type ?? 'markdown';

  const placeholder =
    canvas.content_type === 'code'
      ? 'Write code...'
      : canvas.content_type === 'html'
      ? 'Write HTML...'
      : 'Start writing...';

  return (
    <div className="cve-root">
      {/* Header */}
      <header className="cve-header">
        <div className="cve-header-left">
          <input
            className="cve-title"
            type="text"
            value={localTitle}
            onChange={e => setLocalTitle(e.target.value)}
            onBlur={handleTitleBlur}
            onKeyDown={handleTitleKeyDown}
            placeholder="Untitled"
            aria-label="Canvas title"
          />
          <span className="cve-badge">{badgeLabel}</span>
        </div>
        <div className="cve-actions">
          {isMarkupType && (
            <button
              className="cve-btn"
              onClick={handleToggleMode}
              title={editMode ? 'Preview' : 'Edit'}
              aria-label={editMode ? 'Switch to preview' : 'Switch to edit'}
            >
              {editMode ? <IconEye /> : <IconEdit />}
            </button>
          )}
          <button
            className="cve-btn cve-btn--danger"
            onClick={handleDelete}
            title="Delete canvas"
            aria-label="Delete canvas"
          >
            <IconTrash />
          </button>
        </div>
      </header>

      {conflictMine !== null && (
        <div className="cve-conflict" role="alert">
          <p>
            This canvas was changed somewhere else while you were editing, so your last edit was
            not saved. Your text is kept here until you decide.
          </p>
          <details>
            <summary>Your unsaved text</summary>
            <textarea readOnly value={conflictMine} aria-label="Your unsaved text" />
          </details>
          <div className="cve-conflict-actions">
            <button type="button" className="cve-btn" onClick={handleConflictCopy}>Copy my text</button>
            <button type="button" className="cve-btn" onClick={handleConflictKeepMine}>Replace latest with mine</button>
            <button type="button" className="cve-btn" onClick={handleConflictUseLatest}>Use latest, drop mine</button>
          </div>
        </div>
      )}

      {/* Body */}
      <div className="cve-body">
        {isMarkupType && !editMode ? (
          <div className="cve-preview">
            {canvas.content_type === 'html' ? (
              <iframe
                className="cve-iframe"
                srcDoc={localContent}
                sandbox="allow-same-origin"
                title={canvas.title}
              />
            ) : (
              <div
                className="cve-markdown"
                // renderMarkdown sanitizes via DOMPurify
                dangerouslySetInnerHTML={{ __html: renderMarkdown(localContent) }}
              />
            )}
          </div>
        ) : (
          <textarea
            className={`cve-editor${isMono ? ' cve-editor--mono' : ''}`}
            value={localContent}
            onChange={handleContentChange}
            placeholder={placeholder}
            spellCheck={!isMono}
            aria-label="Canvas content"
          />
        )}
      </div>

      {/* Save indicator */}
      {(isDirty || saving) && (
        <div className="cve-save-indicator" aria-live="polite">
          {saving ? 'Saving…' : 'Unsaved'}
        </div>
      )}

      <style>{`
        /* ── CanvasEditor shell ── */
        .cve-root {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          height: 100%;
          position: relative;
          background: transparent;
        }

        /* ── Header ── */
        .cve-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.75rem;
          padding: 0.875rem 1.125rem 0.8125rem;
          border-bottom: 1px solid rgba(255, 255, 255, 0.05);
          flex-shrink: 0;
          background: linear-gradient(180deg, rgba(255, 255, 255, 0.025), transparent);
          backdrop-filter: blur(12px);
        }

        .cve-header-left {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          flex: 1;
          min-width: 0;
        }

        /* ── Title input ── */
        .cve-title {
          background: transparent;
          border: none;
          border-bottom: 1px solid transparent;
          color: var(--text-primary, #e2dbd0);
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-weight: 500;
          font-size: 1.0625rem;
          letter-spacing: -0.005em;
          padding: 0.05rem 0;
          flex: 1;
          min-width: 0;
          outline: none;
          transition: border-color 200ms var(--hearth-curve, ease);
        }

        .cve-title:focus {
          border-bottom-color: rgba(201, 168, 124, 0.30);
        }

        /* ── Type badge ── */
        .cve-badge {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.625rem;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          padding: 0.2rem 0.5rem;
          border-radius: 1rem;
          background: rgba(201, 168, 124, 0.08);
          color: var(--amber, #c9a87c);
          white-space: nowrap;
          flex-shrink: 0;
        }

        /* ── Action buttons ── */
        .cve-actions {
          display: flex;
          align-items: center;
          gap: 0.1875rem;
          padding: 0.1875rem;
          border-radius: 999px;
          border: 1px solid rgba(255, 255, 255, 0.05);
          background: rgba(255, 255, 255, 0.02);
          flex-shrink: 0;
        }

        .cve-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 2.125rem;
          height: 2.125rem;
          border-radius: 0.75rem;
          color: var(--text-muted, #6a6258);
          border: 1px solid transparent;
          background: transparent;
          cursor: pointer;
          transition: color 200ms var(--hearth-curve, ease),
                      background 200ms var(--hearth-curve, ease),
                      border-color 200ms var(--hearth-curve, ease),
                      transform 100ms var(--hearth-curve, ease);
        }

        .cve-btn:hover {
          color: var(--text-secondary, #a09689);
          background: rgba(255, 255, 255, 0.045);
          border-color: rgba(255, 255, 255, 0.07);
        }

        .cve-btn:active {
          transform: scale(0.985) translateY(0.5px);
        }

        .cve-btn--danger:hover {
          color: rgba(210, 120, 110, 0.90);
        }

        /* ── Body ── */
        .cve-body {
          flex: 1;
          min-height: 0;
          display: flex;
          overflow: hidden;
        }

        /* ── Textarea editor ── */
        .cve-editor {
          flex: 1;
          background: transparent;
          color: var(--text-primary, #e2dbd0);
          border: none;
          outline: none;
          resize: none;
          padding: 1.125rem 1.25rem 1.5rem;
          font-family: var(--font-body, 'Inter', sans-serif);
          font-size: 0.9375rem;
          line-height: 1.65;
          overflow-y: auto;
        }

        .cve-editor::placeholder {
          color: var(--text-muted, #6a6258);
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
        }

        .cve-editor--mono {
          font-family: var(--font-mono, 'JetBrains Mono', 'Fira Code', monospace);
          font-size: 0.875rem;
          line-height: 1.55;
          tab-size: 2;
        }

        /* ── Preview pane ── */
        .cve-preview {
          flex: 1;
          overflow-y: auto;
          padding: 1.125rem 1.25rem 1.5rem;
          display: flex;
          flex-direction: column;
        }

        /* ── Markdown preview typography — matches Hearth warm-obsidian palette ── */
        .cve-markdown {
          flex: 1;
          color: var(--text-primary, #e2dbd0);
          font-size: 0.9375rem;
          line-height: 1.65;
        }

        .cve-markdown p { margin: 0.5rem 0; }
        .cve-markdown p:first-child { margin-top: 0; }
        .cve-markdown p:last-child { margin-bottom: 0; }

        .cve-markdown h1,
        .cve-markdown h2,
        .cve-markdown h3 {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          color: var(--amber-bright, #e3c49a);
          margin: 1.25rem 0 0.5rem;
          letter-spacing: -0.005em;
        }

        .cve-markdown h1 { font-size: 1.5rem; }
        .cve-markdown h2 { font-size: 1.25rem; }
        .cve-markdown h3 { font-size: 1.0625rem; }

        .cve-markdown h1:first-child,
        .cve-markdown h2:first-child,
        .cve-markdown h3:first-child { margin-top: 0; }

        .cve-markdown code {
          background: rgba(0, 0, 0, 0.28);
          padding: 0.125rem 0.3rem;
          border-radius: 0.3rem;
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.875em;
          color: var(--amber, #c9a87c);
        }

        .cve-markdown pre {
          background: rgba(0, 0, 0, 0.3);
          border: 1px solid rgba(255, 255, 255, 0.05);
          padding: 0.875rem 1rem;
          border-radius: 0.5rem;
          overflow-x: auto;
          margin: 0.75rem 0;
        }

        .cve-markdown pre code {
          background: none;
          padding: 0;
          font-size: 0.8125rem;
          color: var(--text-secondary, #a09689);
        }

        .cve-markdown blockquote {
          border-left: 2px solid rgba(201, 168, 124, 0.35);
          padding-left: 1rem;
          margin: 0.75rem 0;
          color: var(--text-secondary, #a09689);
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
        }

        .cve-markdown ul,
        .cve-markdown ol {
          margin: 0.5rem 0;
          padding-left: 1.5rem;
        }

        .cve-markdown li { margin: 0.2rem 0; }

        .cve-markdown a {
          color: var(--amber, #c9a87c);
          text-decoration: underline;
          text-decoration-color: rgba(201, 168, 124, 0.40);
          text-underline-offset: 2px;
        }

        .cve-markdown strong { font-weight: 600; color: var(--text-primary, #e2dbd0); }
        .cve-markdown em { font-style: italic; }

        .cve-markdown hr {
          border: none;
          border-top: 1px solid rgba(255, 255, 255, 0.07);
          margin: 1.25rem 0;
        }

        /* ── HTML iframe ── */
        .cve-iframe {
          flex: 1;
          width: 100%;
          height: 100%;
          border: none;
          background: #fff;
          border-radius: 0.25rem;
        }

        /* ── Save indicator ── */
        .cve-conflict {
          flex-shrink: 0;
          padding: 0.625rem 0.875rem;
          border-bottom: 1px solid rgba(201, 168, 124, 0.18);
          background: rgba(201, 140, 90, 0.10);
          font-size: 0.8125rem;
        }
        .cve-conflict p { margin: 0 0 0.5rem; }
        .cve-conflict textarea {
          width: 100%;
          min-height: 6rem;
          margin-top: 0.375rem;
          font-family: var(--font-mono, monospace);
          font-size: 0.75rem;
        }
        .cve-conflict-actions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.5rem; }
        .cve-conflict-actions .cve-btn { width: auto; height: auto; padding: 0.25rem 0.625rem; }

        .cve-save-indicator {
          position: absolute;
          bottom: 0.625rem;
          right: 0.875rem;
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.625rem;
          letter-spacing: 0.06em;
          color: var(--text-muted, #6a6258);
          opacity: 0.55;
          pointer-events: none;
          text-transform: uppercase;
        }
      `}</style>
    </div>
  );
}

// ─── Empty-state placeholder (no canvas selected) ──────────────────────────────

function EmptySlate() {
  return (
    <div className="cve-empty-slate">
      <p className="cve-empty-note">Select a canvas, or create one.</p>
      <style>{`
        .cve-empty-slate {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          min-width: 0;
        }
        .cve-empty-note {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 0.9375rem;
          color: var(--text-muted, #6a6258);
          margin: 0;
        }
      `}</style>
    </div>
  );
}

// ─── CanvasView (top-level export) ─────────────────────────────────────────────

export function CanvasView() {
  const [canvases, setCanvases] = useState<CanvasMeta[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeCanvas, setActiveCanvas] = useState<CanvasFull | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);

  // ── Fetch list ──────────────────────────────────────────────────────────────
  async function fetchList() {
    try {
      const res = await apiFetch<{ canvases: CanvasMeta[] }>('/api/canvases');
      setCanvases(res.canvases);
    } catch { /* graceful — backend may not be up yet */ }
  }

  useEffect(() => {
    fetchList();
  }, []);

  // ── Fetch full canvas when selection changes ────────────────────────────────
  useEffect(() => {
    if (!activeId) {
      setActiveCanvas(null);
      return;
    }
    let cancelled = false;
    setLoadingFull(true);
    apiFetch<{ canvas: CanvasFull }>(`/api/canvases/${activeId}`)
      .then(res => { if (!cancelled) setActiveCanvas(res.canvas); })
      .catch(() => { if (!cancelled) setActiveCanvas(null); })
      .finally(() => { if (!cancelled) setLoadingFull(false); });
    return () => { cancelled = true; };
  }, [activeId]);

  // ── Create ──────────────────────────────────────────────────────────────────
  async function handleCreate(
    title: string,
    contentType: ContentType,
    language?: string,
  ) {
    try {
      const { canvas: created } = await apiFetch<{ canvas: CanvasFull }>('/api/canvases', {
        method: 'POST',
        body: JSON.stringify({ title, contentType, language }),
      });
      setCanvases(prev => [created, ...prev]);
      setActiveId(created.id);
      setActiveCanvas(created);
    } catch { /* ignore */ }
  }

  // ── After autosave or title change ─────────────────────────────────────────
  function handleSaved(patch: Partial<CanvasMeta> & { id: string }) {
    setCanvases(prev =>
      prev.map(c =>
        c.id === patch.id
          ? { ...c, ...patch, updated_at: new Date().toISOString() }
          : c,
      ),
    );
    if (activeCanvas && activeCanvas.id === patch.id) {
      setActiveCanvas(prev => prev ? { ...prev, ...patch } : prev);
    }
  }

  // ── Delete ──────────────────────────────────────────────────────────────────
  function handleDeleted(id: string) {
    setCanvases(prev => prev.filter(c => c.id !== id));
    if (activeId === id) {
      setActiveId(null);
      setActiveCanvas(null);
    }
  }

  return (
    <div className="cvv-root">
      {/* Left: list */}
      <CanvasList
        canvases={canvases}
        activeId={activeId}
        onSelect={id => setActiveId(id)}
        onCreate={handleCreate}
      />

      {/* Right: editor or empty state */}
      {activeCanvas && !loadingFull ? (
        <CanvasEditor
          canvas={activeCanvas}
          onSaved={handleSaved}
          onDeleted={handleDeleted}
        />
      ) : loadingFull ? (
        <div className="cvv-loading">
          <p className="cvv-loading-text">Loading…</p>
        </div>
      ) : (
        <EmptySlate />
      )}

      <style>{`
        /* ── CanvasView two-pane shell ── */
        .cvv-root {
          display: flex;
          height: 100%;
          width: 100%;
          overflow: hidden;
          background: transparent;
        }

        /* Loading placeholder — same quiet style as EmptySlate */
        .cvv-loading {
          flex: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          min-width: 0;
        }

        .cvv-loading-text {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-size: 0.9375rem;
          color: var(--text-muted, #6a6258);
          margin: 0;
          opacity: 0.6;
          animation: cvv-pulse 2s ease-in-out infinite;
        }

        @keyframes cvv-pulse {
          0%, 100% { opacity: 0.4; }
          50%       { opacity: 0.75; }
        }
      `}</style>
    </div>
  );
}
