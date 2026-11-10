/**
 * CanvasPanel — the in-chat right-side artifact panel.
 *
 * Slides in when a canvas is open (openCanvasId is set). Shows the canvas
 * rendered in read-view by default; an edit toggle flips to the editable
 * textarea. A draggable seam lets the user resize the panel width.
 *
 * The renderer reuses the same logic from Canvas.tsx / utils/markdown:
 *   - markdown  → renderMarkdown (DOMPurify-sanitized)
 *   - code      → <pre> mono block
 *   - html      → <iframe sandbox="allow-same-origin">
 *   - text      → pre-wrap prose
 *
 * On mobile (≤768px) the panel overlays full-width.
 */
import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';
import type { Canvas } from '@resonant/shared';
import { renderMarkdown } from '../utils/markdown';
import { useChatStore } from '../store/chat';
import type { CanvasSaveResult } from '../store/chat';

// ─── Resize persistence ────────────────────────────────────────────────────────

const PANEL_WIDTH_KEY = 'resonant.canvasPanel.width';
const DEFAULT_WIDTH = 400;
const MIN_WIDTH = 280;
const MAX_WIDTH = 720;

function readStoredWidth(): number {
  try {
    const v = localStorage.getItem(PANEL_WIDTH_KEY);
    if (v) {
      const n = parseInt(v, 10);
      if (!isNaN(n) && n >= MIN_WIDTH && n <= MAX_WIDTH) return n;
    }
  } catch { /* ignore */ }
  return DEFAULT_WIDTH;
}

function storeWidth(w: number) {
  try { localStorage.setItem(PANEL_WIDTH_KEY, String(w)); } catch { /* ignore */ }
}

// ─── Icons ────────────────────────────────────────────────────────────────────

function IconClose() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M18 6L6 18M6 6l12 12" />
    </svg>
  );
}

function IconEdit() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M11 4H4a2 2 0 00-2 2v14a2 2 0 002 2h14a2 2 0 002-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 013 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}

function IconEye() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function IconCopy() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
    </svg>
  );
}

// ─── Canvas body renderer (read mode) ─────────────────────────────────────────

function CanvasReadBody({ canvas }: { canvas: Canvas }) {
  if (canvas.content_type === 'html') {
    return (
      <iframe
        className="cpanel-iframe"
        srcDoc={canvas.content}
        sandbox="allow-same-origin"
        title={canvas.title}
      />
    );
  }

  if (canvas.content_type === 'code') {
    const label = canvas.language ?? 'code';
    return (
      <div className="cpanel-code-wrap">
        <span className="cpanel-code-lang">{label}</span>
        <pre className="cpanel-pre"><code>{canvas.content}</code></pre>
      </div>
    );
  }

  if (canvas.content_type === 'markdown') {
    return (
      <div
        className="cpanel-markdown"
        dangerouslySetInnerHTML={{ __html: renderMarkdown(canvas.content) }}
      />
    );
  }

  // text / fallback
  return <pre className="cpanel-text">{canvas.content}</pre>;
}

// ─── CanvasPanel ──────────────────────────────────────────────────────────────

interface CanvasPanelProps {
  canvas: Canvas;
  onClose: () => void;
  onUpdate: (
    id: string,
    patch: Partial<Pick<Canvas, 'title' | 'content'>>,
    baseVersion?: number | (() => number | undefined),
  ) => Promise<CanvasSaveResult>;
}

function CanvasPanelInner({ canvas, onClose, onUpdate }: CanvasPanelProps) {
  const [editMode, setEditMode] = useState(false);
  const [editContent, setEditContent] = useState(canvas.content);
  const [editTitle, setEditTitle] = useState(canvas.title);
  const [copyFlash, setCopyFlash] = useState(false);
  const [saving, setSaving] = useState(false);
  // The canvas version this edit session is based on. Not simply canvas.version:
  // if the companion saves while we are typing, canvas.version moves on but our
  // text is still based on the older one — that is exactly the conflict to catch.
  const baseVersionRef = useRef(canvas.version ?? 0);
  // Set when a save was refused because someone else saved first. Holds the
  // user's unsaved text so it can be copied or re-applied; autosave is paused
  // until they choose.
  const [conflictMine, setConflictMine] = useState<string | null>(null);
  const conflictRef = useRef<string | null>(null);
  conflictRef.current = conflictMine;
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync from canvas prop when it changes (WS update or canvas switch)
  useEffect(() => {
    if (!editMode) {
      setEditContent(canvas.content);
      setEditTitle(canvas.title);
      baseVersionRef.current = canvas.version ?? 0;
    }
  }, [canvas.id, canvas.content, canvas.title, canvas.version, editMode]);

  // Reset edit state when canvas id changes
  useEffect(() => {
    setEditMode(false);
    setEditContent(canvas.content);
    setEditTitle(canvas.title);
    baseVersionRef.current = canvas.version ?? 0;
    setConflictMine(null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvas.id]);

  // Save content against the version this edit was based on; on a conflict keep
  // the user's text and stop autosaving until they decide what to do.
  // A pending debounced save must never outlive this canvas: the component is
  // keyed on canvas.id, so unmount covers a canvas switch too.
  useEffect(() => () => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    if (copyTimer.current) clearTimeout(copyTimer.current);
  }, []);

  const commit = useCallback(async (patch: Partial<Pick<Canvas, 'title' | 'content'>>) => {
    if (conflictRef.current !== null) return;
    const res = await onUpdate(canvas.id, patch, () => baseVersionRef.current);
    if (res.status === 'saved') {
      baseVersionRef.current = res.version;
    } else if (res.status === 'conflict' && patch.content !== undefined) {
      setConflictMine(patch.content);
    }
  }, [canvas.id, onUpdate]);

  const handleConflictCopy = useCallback(async () => {
    try { await navigator.clipboard.writeText(conflictRef.current ?? ''); } catch { /* clipboard denied */ }
  }, []);

  const handleConflictKeepMine = useCallback(async () => {
    const mine = conflictRef.current;
    if (mine === null) return;
    // Deliberate overwrite: rebase onto the latest version, then save our text.
    baseVersionRef.current = canvas.version ?? 0;
    setConflictMine(null);
    conflictRef.current = null;
    setEditContent(mine);
    await commit({ content: mine });
  }, [canvas.version, commit]);

  const handleConflictUseLatest = useCallback(() => {
    baseVersionRef.current = canvas.version ?? 0;
    setEditContent(canvas.content);
    setConflictMine(null);
  }, [canvas.version, canvas.content]);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(canvas.content);
      setCopyFlash(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopyFlash(false), 1600);
    } catch { /* clipboard denied */ }
  }, [canvas.content]);

  const handleEditToggle = useCallback(() => {
    if (editMode) {
      // Leaving edit — flush any pending save
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        void commit({ content: editContent });
      }
      // Title travels on its own request: it is not version-guarded, so a stale
      // content save can never drop it.
      const title = editTitle.trim() || canvas.title;
      if (title !== canvas.title) void onUpdate(canvas.id, { title });
    }
    setEditMode(m => !m);
  }, [editMode, editContent, editTitle, canvas.id, canvas.title, commit, onUpdate]);

  const handleContentChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setEditContent(value);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      saveTimer.current = null;
      setSaving(true);
      try { await commit({ content: value }); }
      finally { setSaving(false); }
    }, 600);
  }, [commit]);

  const handleTitleBlur = useCallback(async () => {
    const trimmed = editTitle.trim() || canvas.title;
    if (trimmed !== canvas.title) {
      await onUpdate(canvas.id, { title: trimmed });
    }
  }, [canvas.id, canvas.title, editTitle, onUpdate]);

  const badgeLabel =
    canvas.content_type === 'code'
      ? (canvas.language ?? 'code')
      : canvas.content_type ?? 'markdown';

  const canPreview = canvas.content_type === 'markdown' || canvas.content_type === 'html';

  return (
    <div className="cpanel-root">
      {/* Header */}
      <div className="cpanel-header">
        <div className="cpanel-header-left">
          {editMode ? (
            <input
              className="cpanel-title-input"
              value={editTitle}
              onChange={e => setEditTitle(e.target.value)}
              onBlur={handleTitleBlur}
              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
              placeholder="Untitled"
              aria-label="Canvas title"
            />
          ) : (
            <span className="cpanel-title">{canvas.title}</span>
          )}
          <span className="cpanel-badge">{badgeLabel}</span>
        </div>
        <div className="cpanel-header-actions">
          <button
            className={`cpanel-btn${copyFlash ? ' cpanel-btn--flash' : ''}`}
            onClick={handleCopy}
            title="Copy content"
            aria-label="Copy content"
            type="button"
          >
            {copyFlash ? (
              <span className="cpanel-copy-ok" aria-hidden="true">✓</span>
            ) : (
              <IconCopy />
            )}
          </button>
          {canPreview && (
            <button
              className={`cpanel-btn${editMode ? ' cpanel-btn--active' : ''}`}
              onClick={handleEditToggle}
              title={editMode ? 'Preview' : 'Edit'}
              aria-label={editMode ? 'Switch to preview' : 'Switch to edit'}
              type="button"
            >
              {editMode ? <IconEye /> : <IconEdit />}
            </button>
          )}
          {!canPreview && (
            <button
              className={`cpanel-btn${editMode ? ' cpanel-btn--active' : ''}`}
              onClick={handleEditToggle}
              title={editMode ? 'Read' : 'Edit'}
              aria-label={editMode ? 'Switch to read' : 'Switch to edit'}
              type="button"
            >
              {editMode ? <IconEye /> : <IconEdit />}
            </button>
          )}
          <button
            className="cpanel-btn cpanel-btn--close"
            onClick={onClose}
            title="Close panel"
            aria-label="Close canvas panel"
            type="button"
          >
            <IconClose />
          </button>
        </div>
      </div>

      {conflictMine !== null && (
        <div className="cpanel-conflict" role="alert">
          <p className="cpanel-conflict-msg">
            This canvas was changed somewhere else while you were editing, so your last edit was
            not saved. Your text is kept here until you decide.
          </p>
          <details className="cpanel-conflict-mine">
            <summary>Your unsaved text</summary>
            <textarea readOnly value={conflictMine} aria-label="Your unsaved text" />
          </details>
          <div className="cpanel-conflict-actions">
            <button type="button" className="cpanel-btn" onClick={handleConflictCopy}>Copy my text</button>
            <button type="button" className="cpanel-btn" onClick={handleConflictKeepMine}>Replace latest with mine</button>
            <button type="button" className="cpanel-btn" onClick={handleConflictUseLatest}>Use latest, drop mine</button>
          </div>
        </div>
      )}

      {/* Body */}
      <div className="cpanel-body">
        {editMode ? (
          <textarea
            className={`cpanel-editor${canvas.content_type === 'code' ? ' cpanel-editor--mono' : ''}`}
            value={editContent}
            onChange={handleContentChange}
            placeholder="Start writing..."
            spellCheck={canvas.content_type !== 'code'}
            aria-label="Canvas content"
          />
        ) : (
          <div className="cpanel-read">
            <CanvasReadBody canvas={canvas} />
          </div>
        )}
      </div>

      {/* Save indicator */}
      {saving && (
        <div className="cpanel-save-indicator" aria-live="polite">saving…</div>
      )}

      <style>{`
        .cpanel-root {
          display: flex;
          flex-direction: column;
          height: 100%;
          background: var(--bg-secondary, #131210);
          border-left: 1px solid rgba(201, 168, 124, 0.10);
          position: relative;
          overflow: hidden;
        }

        /* ── Header ── */
        .cpanel-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.625rem;
          padding: 0.75rem 0.875rem 0.6875rem;
          border-bottom: 1px solid rgba(201, 168, 124, 0.07);
          flex-shrink: 0;
          background: rgba(255, 255, 255, 0.015);
        }

        /* On mobile the panel takes over the full screen (see cpanel-wrapper's
           own mobile rule) — it sits above the shell's top bar, so it owns the
           notch/Dynamic-Island clearance itself. Without this, the whole action
           row (copy / edit-toggle / close) renders under the status bar and is
           unreachable — the trap that forces a PWA reload. Same idiom as
           .drawer-panel in App.tsx. */
        @media (max-width: 768px) {
          .cpanel-header {
            padding-top: calc(0.75rem + env(safe-area-inset-top, 0px));
          }
        }

        .cpanel-header-left {
          display: flex;
          align-items: center;
          gap: 0.4375rem;
          flex: 1;
          min-width: 0;
        }

        .cpanel-title {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-weight: 500;
          font-size: 0.9375rem;
          color: var(--text-primary, #e2dbd0);
          letter-spacing: -0.005em;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          flex: 1;
          min-width: 0;
        }

        .cpanel-title-input {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          font-weight: 500;
          font-size: 0.9375rem;
          color: var(--text-primary, #e2dbd0);
          background: transparent;
          border: none;
          border-bottom: 1px solid rgba(201, 168, 124, 0.28);
          outline: none;
          flex: 1;
          min-width: 0;
          padding: 0.05rem 0;
          transition: border-color 180ms var(--hearth-curve, ease);
        }

        .cpanel-title-input:focus {
          border-bottom-color: rgba(201, 168, 124, 0.55);
        }

        .cpanel-badge {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.5625rem;
          letter-spacing: 0.07em;
          text-transform: uppercase;
          padding: 0.175rem 0.4rem;
          border-radius: 99px;
          background: rgba(201, 168, 124, 0.08);
          color: var(--amber, #c9a87c);
          white-space: nowrap;
          flex-shrink: 0;
        }

        /* ── Header action buttons ── */
        .cpanel-header-actions {
          display: flex;
          align-items: center;
          gap: 0.125rem;
          flex-shrink: 0;
        }

        .cpanel-btn {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 1.875rem;
          height: 1.875rem;
          border-radius: 0.5rem;
          color: var(--text-muted, #6a6258);
          border: 1px solid transparent;
          background: transparent;
          cursor: pointer;
          transition:
            color 160ms var(--hearth-curve, ease),
            background 160ms var(--hearth-curve, ease),
            border-color 160ms var(--hearth-curve, ease),
            transform 100ms var(--hearth-curve, ease);
        }

        .cpanel-btn:hover {
          color: var(--text-secondary, #a09689);
          background: rgba(255, 255, 255, 0.04);
          border-color: rgba(255, 255, 255, 0.06);
        }

        .cpanel-btn:active {
          transform: scale(0.985) translateY(0.5px);
        }

        .cpanel-btn--active {
          color: var(--amber, #c9a87c);
          border-color: rgba(201, 168, 124, 0.20);
          background: rgba(201, 168, 124, 0.06);
        }

        .cpanel-btn--flash {
          color: var(--amber, #c9a87c);
        }

        .cpanel-copy-ok {
          font-size: 0.6875rem;
          font-family: var(--font-mono, monospace);
          color: var(--amber, #c9a87c);
        }

        .cpanel-btn--close:hover {
          color: rgba(220, 140, 120, 0.85);
          background: rgba(220, 140, 120, 0.07);
          border-color: rgba(220, 140, 120, 0.12);
        }

        /* ── Body ── */
        .cpanel-body {
          flex: 1;
          min-height: 0;
          overflow: hidden;
          display: flex;
        }

        /* ── Read pane ── */
        .cpanel-read {
          flex: 1;
          overflow-y: auto;
          padding: 1rem 1.125rem 1.5rem;
          /* Mobile touch scroll — without this the panel can render a
             non-scrolling scroll container in iOS PWA standalone mode. */
          -webkit-overflow-scrolling: touch;
          overscroll-behavior: contain;
          touch-action: pan-y;
        }

        /* ── Markdown typography (matches cve-markdown in Canvas.tsx) ── */
        .cpanel-markdown {
          color: var(--text-primary, #e2dbd0);
          font-size: 0.9375rem;
          line-height: 1.65;
        }
        .cpanel-markdown p { margin: 0.5rem 0; }
        .cpanel-markdown p:first-child { margin-top: 0; }
        .cpanel-markdown p:last-child { margin-bottom: 0; }
        .cpanel-markdown h1,
        .cpanel-markdown h2,
        .cpanel-markdown h3 {
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
          color: var(--amber-bright, #e3c49a);
          margin: 1.25rem 0 0.5rem;
          letter-spacing: -0.005em;
        }
        .cpanel-markdown h1 { font-size: 1.4375rem; }
        .cpanel-markdown h2 { font-size: 1.1875rem; }
        .cpanel-markdown h3 { font-size: 1.0rem; }
        .cpanel-markdown h1:first-child,
        .cpanel-markdown h2:first-child,
        .cpanel-markdown h3:first-child { margin-top: 0; }
        .cpanel-markdown code {
          background: rgba(0, 0, 0, 0.28);
          padding: 0.1rem 0.28rem;
          border-radius: 0.28rem;
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.875em;
          color: var(--amber, #c9a87c);
        }
        .cpanel-markdown pre {
          background: rgba(0, 0, 0, 0.3);
          border: 1px solid rgba(255, 255, 255, 0.05);
          padding: 0.75rem 0.875rem;
          border-radius: 0.5rem;
          overflow-x: auto;
          margin: 0.75rem 0;
          -webkit-overflow-scrolling: touch;
          touch-action: pan-x;
        }
        .cpanel-markdown pre code {
          background: none;
          padding: 0;
          font-size: 0.8125rem;
          color: var(--text-secondary, #a09689);
        }
        .cpanel-markdown blockquote {
          border-left: 2px solid rgba(201, 168, 124, 0.32);
          padding-left: 0.875rem;
          margin: 0.75rem 0;
          color: var(--text-secondary, #a09689);
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
        }
        .cpanel-markdown ul,
        .cpanel-markdown ol { margin: 0.5rem 0; padding-left: 1.375rem; }
        .cpanel-markdown li { margin: 0.2rem 0; }
        .cpanel-markdown a {
          color: var(--amber, #c9a87c);
          text-decoration: underline;
          text-decoration-color: rgba(201, 168, 124, 0.38);
          text-underline-offset: 2px;
        }
        .cpanel-markdown strong { font-weight: 600; color: var(--text-primary, #e2dbd0); }
        .cpanel-markdown em { font-style: italic; }
        .cpanel-markdown hr {
          border: none;
          border-top: 1px solid rgba(255, 255, 255, 0.06);
          margin: 1.25rem 0;
        }

        /* ── Code block (read mode) ── */
        .cpanel-code-wrap {
          display: flex;
          flex-direction: column;
          gap: 0;
        }
        .cpanel-code-lang {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.5625rem;
          letter-spacing: 0.07em;
          text-transform: uppercase;
          color: var(--amber-dim, #a08960);
          padding: 0 0 0.375rem;
          opacity: 0.7;
        }
        .cpanel-pre {
          margin: 0;
          flex: 1;
          overflow: auto;
          background: rgba(0, 0, 0, 0.22);
          border: 1px solid rgba(255, 255, 255, 0.05);
          border-radius: 0.5rem;
          padding: 0.875rem 1rem;
          -webkit-overflow-scrolling: touch;
          overscroll-behavior: contain;
          touch-action: pan-y pan-x;
        }
        .cpanel-pre code {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.8125rem;
          line-height: 1.55;
          color: var(--text-secondary, #a09689);
          white-space: pre;
          word-break: normal;
        }

        /* ── Plain text ── */
        .cpanel-text {
          margin: 0;
          font-family: var(--font-body, 'Inter', sans-serif);
          font-size: 0.9375rem;
          line-height: 1.65;
          color: var(--text-primary, #e2dbd0);
          white-space: pre-wrap;
          word-break: break-word;
        }

        /* ── HTML iframe ── */
        .cpanel-iframe {
          width: 100%;
          height: 100%;
          border: none;
          background: #fff;
          border-radius: 0.25rem;
          flex: 1;
        }

        /* ── Edit pane ── */
        .cpanel-editor {
          flex: 1;
          width: 100%;
          background: transparent;
          color: var(--text-primary, #e2dbd0);
          border: none;
          outline: none;
          resize: none;
          padding: 1rem 1.125rem 1.5rem;
          font-family: var(--font-body, 'Inter', sans-serif);
          font-size: 0.9375rem;
          line-height: 1.65;
          overflow-y: auto;
          box-sizing: border-box;
          -webkit-overflow-scrolling: touch;
          overscroll-behavior: contain;
        }
        .cpanel-editor::placeholder {
          color: var(--text-muted, #6a6258);
          font-family: var(--font-serif, 'Lora', serif);
          font-style: italic;
        }
        .cpanel-editor--mono {
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.875rem;
          line-height: 1.5;
          tab-size: 2;
        }

        /* ── Save indicator ── */
        .cpanel-conflict {
          flex-shrink: 0;
          padding: 0.625rem 0.875rem;
          border-bottom: 1px solid rgba(201, 168, 124, 0.18);
          background: rgba(201, 140, 90, 0.10);
          font-size: 0.8125rem;
          color: var(--text-primary, #e8e0d4);
        }
        .cpanel-conflict-msg { margin: 0 0 0.5rem; }
        .cpanel-conflict-mine textarea {
          width: 100%;
          min-height: 6rem;
          margin-top: 0.375rem;
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.75rem;
          background: rgba(0, 0, 0, 0.2);
          color: inherit;
          border: 1px solid rgba(201, 168, 124, 0.15);
          border-radius: 4px;
        }
        .cpanel-conflict-actions .cpanel-btn { width: auto; height: auto; padding: 0.25rem 0.625rem; }
        .cpanel-conflict-actions {
          display: flex;
          flex-wrap: wrap;
          gap: 0.5rem;
          margin-top: 0.5rem;
        }

        .cpanel-save-indicator {
          position: absolute;
          bottom: 0.5rem;
          right: 0.75rem;
          font-family: var(--font-mono, 'JetBrains Mono', monospace);
          font-size: 0.5625rem;
          letter-spacing: 0.06em;
          color: var(--text-muted, #6a6258);
          opacity: 0.5;
          pointer-events: none;
          text-transform: uppercase;
        }
      `}</style>
    </div>
  );
}

// ─── Draggable seam ───────────────────────────────────────────────────────────

interface CanvasPanelWrapperProps {
  isOpen: boolean;
  onClose: () => void;
  children: React.ReactNode;
  width: number;
  onWidthChange: (w: number) => void;
}

function CanvasPanelWrapper({ isOpen, onClose: _onClose, children, width, onWidthChange }: CanvasPanelWrapperProps) {
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startWidth: width };

    function onMove(ev: MouseEvent) {
      if (!dragRef.current) return;
      const delta = dragRef.current.startX - ev.clientX;
      const next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, dragRef.current.startWidth + delta));
      onWidthChange(next);
    }

    function onUp() {
      dragRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [width, onWidthChange]);

  return (
    <div
      className={`cpanel-wrapper${isOpen ? ' cpanel-wrapper--open' : ''}`}
      style={isOpen ? { '--cpanel-w': `${width}px` } as React.CSSProperties : undefined}
      aria-hidden={!isOpen}
    >
      {/* Draggable seam — left edge of the panel */}
      {isOpen && (
        <button
          className="cpanel-seam"
          onMouseDown={onMouseDown}
          aria-label="Resize canvas panel"
          title="Drag to resize"
          type="button"
          tabIndex={-1}
        />
      )}

      <div className="cpanel-inner">
        {children}
      </div>

      <style>{`
        .cpanel-wrapper {
          /* Hidden by default — takes zero width, out of flow */
          width: 0;
          flex-shrink: 0;
          overflow: hidden;
          position: relative;
          /* Smooth width transition on open/close; skip during drag (inline style overrides) */
          transition: width 220ms cubic-bezier(0.25, 0.46, 0.45, 0.94);
        }

        .cpanel-wrapper--open {
          width: var(--cpanel-w, 400px);
        }

        .cpanel-seam {
          position: absolute;
          left: 0;
          top: 0;
          bottom: 0;
          width: 4px;
          z-index: 10;
          background: transparent;
          cursor: col-resize;
          border: none;
          padding: 0;
          /* Expand the hit zone without visual change */
        }
        .cpanel-seam::after {
          content: '';
          position: absolute;
          left: 0;
          top: 0;
          bottom: 0;
          width: 4px;
          background: rgba(201, 168, 124, 0.10);
          transition: background 160ms ease;
        }
        .cpanel-seam:hover::after,
        .cpanel-seam:active::after {
          background: rgba(201, 168, 124, 0.30);
        }

        .cpanel-inner {
          height: 100%;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          /* Offset for the seam */
          margin-left: 4px;
          /* Animate the inner content sliding in from the right */
          transform: translateX(0);
        }

        /* Mobile overlay — full-width */
        @media (max-width: 768px) {
          .cpanel-wrapper {
            position: fixed;
            top: 0;
            right: 0;
            bottom: 0;
            left: 0;
            width: 0 !important;
            z-index: 200;
            background: var(--bg-secondary, #131210);
            transition: opacity 200ms ease;
            opacity: 0;
            pointer-events: none;
          }
          .cpanel-wrapper--open {
            width: 100% !important;
            opacity: 1;
            pointer-events: auto;
          }
          .cpanel-seam { display: none; }
          .cpanel-inner { margin-left: 0; }
        }
      `}</style>
    </div>
  );
}

// ─── Public export ────────────────────────────────────────────────────────────

export function CanvasPanel() {
  const openCanvasId = useChatStore(s => s.openCanvasId);
  const threadCanvases = useChatStore(s => s.threadCanvases);
  const closeCanvas = useChatStore(s => s.closeCanvas);
  const updateCanvas = useChatStore(s => s.updateCanvas);

  const [panelWidth, setPanelWidth] = useState<number>(readStoredWidth);

  const handleWidthChange = useCallback((w: number) => {
    setPanelWidth(w);
    storeWidth(w);
  }, []);

  const canvas = openCanvasId
    ? threadCanvases.find(c => c.id === openCanvasId) ?? null
    : null;

  const isOpen = openCanvasId !== null;

  return (
    <CanvasPanelWrapper
      isOpen={isOpen}
      onClose={closeCanvas}
      width={panelWidth}
      onWidthChange={handleWidthChange}
    >
      {canvas ? (
        <CanvasPanelInner
          key={canvas.id}
          canvas={canvas}
          onClose={closeCanvas}
          onUpdate={updateCanvas}
        />
      ) : (
        <div className="cpanel-empty-state">
          <p className="cpanel-empty-note">No canvas selected</p>
          <style>{`
            .cpanel-empty-state {
              flex: 1;
              display: flex;
              align-items: center;
              justify-content: center;
              height: 100%;
              background: var(--bg-secondary, #131210);
              border-left: 1px solid rgba(201, 168, 124, 0.10);
            }
            .cpanel-empty-note {
              font-family: var(--font-serif, 'Lora', serif);
              font-style: italic;
              font-size: 0.875rem;
              color: var(--text-muted, #6a6258);
              margin: 0;
              opacity: 0.6;
            }
          `}</style>
        </div>
      )}
    </CanvasPanelWrapper>
  );
}
