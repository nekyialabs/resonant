// ---------------------------------------------------------------------------
// Bash guard + path containment.
//
// IMPORTANT: this is a best-effort backstop against accidents and runaway
// loops in the agent's own Bash tool. It is NOT a security boundary: free-form
// shell can always be written in a way a matcher doesn't recognise (variable
// indirection, heredocs, scripts written then run, ...). The write-gate
// (isPathInsideRoots, used for Write/Edit) is the real boundary for file writes.
// ---------------------------------------------------------------------------

import { realpathSync, lstatSync, readlinkSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';

export interface GuardContext {
  /** Directories the agent may write inside (the write-gate roots). May be empty. */
  roots: string[];
  /** The Bash tool's working directory. null = unknown. */
  cwd: string | null;
}

// ---------------------------------------------------------------------------
// Path containment (shared with the write-gate)
// ---------------------------------------------------------------------------

/**
 * Resolve symlinks on the deepest existing ancestor of `p` (the target itself
 * may not exist yet), then re-append the non-existent tail. Dangling symlinks
 * are followed manually so a write through them can't escape.
 */
export function realpathDeepest(p: string): string {
  let cur = resolve(p);
  const tail: string[] = [];
  for (let hops = 0; hops < 64; hops++) {
    try {
      return join(realpathSync(cur), ...tail);
    } catch {
      // fall through: doesn't exist, or can't be resolved
    }
    try {
      if (lstatSync(cur).isSymbolicLink()) {
        // dangling link: follow by hand
        const next = resolve(dirname(cur), readlinkSync(cur));
        if (next === cur) break;
        cur = next;
        continue;
      }
    } catch {
      // lstat failed: nothing at this path
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    tail.unshift(basename(cur));
    cur = parent;
  }
  return join(cur, ...tail);
}

// Case-fold only where the filesystem is case-insensitive (Windows, macOS).
const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';
const norm = (p: string) => {
  const n = realpathDeepest(p).replace(/\\/g, '/').replace(/\/+$/, '');
  return CASE_INSENSITIVE_FS ? n.toLowerCase() : n;
};

/**
 * True if `target` is (after resolving symlinks) inside one of `roots`.
 * Separator-guarded, so /foo does not contain /foobar. A root equal to the
 * target counts as inside unless `strict` is set.
 */
export function isPathInsideRoots(target: string, roots: string[], strict = false): boolean {
  const real = norm(target);
  return roots.some(root => {
    if (!root) return false;
    const r = norm(root);
    if (real === r) return !strict;
    return real.startsWith(r + '/');
  });
}

// ---------------------------------------------------------------------------
// Tokeniser
// ---------------------------------------------------------------------------

/**
 * Split a command line into segments (on ; && || | & newline ( ) $( and
 * backticks, outside single quotes) of words (quotes removed).
 */
const SUBST = '$(…)';

export function splitCommand(cmd: string): string[][] {
  const segs: string[][] = [];
  let words: string[] = [];
  let cur = '';
  let has = false;
  let q: '"' | "'" | null = null;
  const endWord = () => {
    if (has && !/^\d*[<>]/.test(cur)) words.push(cur);
    cur = '';
    has = false;
  };
  const endSeg = () => {
    endWord();
    if (words.length) segs.push(words);
    words = [];
  };
  // A command substitution ends the segment it sits in, leaving an unknown word
  // behind (SUBST) so `rm -rf $(…)` can't look like a rm with no targets.
  // The body is analysed as its own segment. A closing backtick adds no marker.
  let btOpen = false;
  const subst = (backtick: boolean) => {
    endWord();
    if (backtick && btOpen) btOpen = false;
    else {
      if (backtick) btOpen = true;
      words.push(SUBST);
    }
    endSeg();
  };
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    const n = cmd[i + 1];
    if (q === "'") {
      if (c === "'") q = null;
      else { cur += c; has = true; }
      continue;
    }
    if (q === '"') {
      if (c === '"') { q = null; continue; }
      if (c === '`' || (c === '$' && n === '(')) { subst(c === '`'); if (c === '$') i++; continue; }
      cur += c; has = true;
      continue;
    }
    if (c === '"' || c === "'") { q = c; has = true; continue; }
    if (c === '$' && n === '(') { subst(false); i++; continue; }
    if (c === '`') { subst(true); continue; }
    if (c === '(' || c === ')' || c === ';' || c === '\n' || c === '\r' || c === '|' || c === '&') {
      endSeg();
      continue;
    }
    if (c === ' ' || c === '\t') { endWord(); continue; }
    if (c === '#' && !has) { // comment to end of line
      while (i < cmd.length && cmd[i] !== '\n') i++;
      continue;
    }
    cur += c; has = true;
  }
  endSeg();
  return segs;
}

// ---------------------------------------------------------------------------
// Targets
// ---------------------------------------------------------------------------

const ABS_LIKE = /^([\/\\~$%]|[a-zA-Z]:([\\/]|$))/;
const DOT_LIKE = /^(\.[\\/]+)*(\.|\*+|\.\*)?[\\/]*$/;

interface TargetOpts {
  /** Any absolute path counts as dangerous (even inside the workspace). */
  strictAbs?: boolean;
  /** `.`, `*` and the workspace root itself are acceptable (a filter or a non-destructive verb narrows them). */
  allowDot?: boolean;
}

function isDangerousTarget(raw: string, ctx: GuardContext, o: TargetOpts = {}): boolean {
  const t = raw.trim();
  if (!t) return false;
  const hasRoots = ctx.roots.length > 0;
  const inside = (p: string) => isPathInsideRoots(p, ctx.roots, !o.allowDot);

  if (ABS_LIKE.test(t)) {
    if (/^[~$%]/.test(t)) return true; // home / unknown expansion
    if (o.strictAbs) return true;
    return hasRoots ? !inside(t) : true;
  }

  // Relative. A variable or substitution in the path is unknown: fail closed.
  if (/[$`]/.test(t)) return true;
  if (/^\.\.([\\/]|$)/.test(t)) {
    if (!hasRoots || ctx.cwd === null) return true;
    return !inside(resolve(ctx.cwd, t));
  }
  if (DOT_LIKE.test(t)) {
    if (!o.allowDot) return true;
    if (!hasRoots) return false;
    return ctx.cwd === null ? true : !inside(ctx.cwd);
  }
  if (!hasRoots) return false;
  if (ctx.cwd === null) return true; // cwd unknown (e.g. `cd $X`): can't vouch for it
  return !inside(resolve(ctx.cwd, t));
}

// ---------------------------------------------------------------------------
// Per-command checks. Each returns a reason string or null.
// ---------------------------------------------------------------------------

// Options (per wrapper) that consume the next word as their argument.
const WRAPPER_ARG_OPTS: Record<string, string[]> = {
  sudo: ['-u', '-g', '-h', '-p', '-C', '-r', '-t', '-U', '--user', '--group', '--host', '--prompt'],
  doas: ['-u', '-C'],
  xargs: ['-I', '-n', '-P', '-d', '-L', '-s', '-E', '-a', '-J', '--max-args', '--max-procs', '--delimiter', '--max-lines',
    '--max-chars', '--eof', '--arg-file', '--process-slot-var'],
  timeout: ['-s', '-k', '--signal', '--kill-after'],
  nice: ['-n', '--adjustment'],
  ionice: ['-c', '-n', '-p', '--class', '--classdata'],
  stdbuf: ['-i', '-o', '-e'],
};
const PASSTHROUGH = new Set(['command', 'builtin', 'nohup', 'time', 'exec', 'nice', 'ionice', 'setsid', 'stdbuf', 'timeout', 'xargs', 'unbuffer']);
// Shell keywords / grouping that can sit in front of a command word.
const KEYWORDS = new Set(['do', 'then', 'else', 'elif', '{', '!', 'time', 'if', 'while', 'until']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
const WIN_SHELLS = new Set(['cmd', 'powershell', 'pwsh']);
const INTERPRETERS = /^(python[\d.]*|py|pypy\d*|node|nodejs|deno|bun|perl|ruby|php)$/;
const DELETE_API = /(rmtree|rmSync|rmdirSync|rm_rf|rm_r\b|remove_tree|rimraf|unlink|os\.remove|os\.rmdir|rmdir|File\.delete|FileUtils\.(rm|remove)|fs\.(promises\.)?rm\b)/;
const SHELL_OUT = /(system|exec|popen|spawn|subprocess|child_process|Runtime)/;
const HOME_REF = /(expanduser|Path\.home|os\.homedir|process\.env\.HOME|environ\[\s*['"]HOME|\$HOME|ENV\[\s*['"]HOME)/;

const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;

function stripPrefixes(words: string[]): string[] {
  const w = words.slice();
  const replStrings: string[] = []; // xargs replace-strings: filled from stdin, so unknown
  for (let guard = 0; guard < 30 && w.length; guard++) {
    if (ASSIGN.test(w[0])) { w.shift(); continue; }
    if (KEYWORDS.has(w[0])) { w.shift(); continue; }
    const base = basename(w[0].replace(/^\\/, '')).toLowerCase().replace(/\.exe$/, '');
    if (base === 'env') {
      w.shift();
      while (w.length && (w[0].startsWith('-') || ASSIGN.test(w[0]))) w.shift();
      continue;
    }
    if (base in WRAPPER_ARG_OPTS && !PASSTHROUGH.has(base)) { // sudo, doas
      w.shift();
      while (w.length && w[0].startsWith('-')) {
        const opt = w.shift()!;
        if (WRAPPER_ARG_OPTS[base].includes(opt)) w.shift();
      }
      continue;
    }
    if (PASSTHROUGH.has(base)) {
      w.shift();
      while (w.length && w[0].startsWith('-')) {
        const opt = w.shift()!;
        if (opt === '--') break;
        if (base === 'xargs') {
          if (opt === '-I') replStrings.push(w[0] ?? '');
          else if (opt.startsWith('-I') && opt.length > 2) replStrings.push(opt.slice(2));
          else if (opt === '-i' || opt === '--replace') replStrings.push('{}');
          else if (opt.startsWith('-i') && opt.length > 2) replStrings.push(opt.slice(2));
          else if (opt.startsWith('--replace=')) replStrings.push(opt.slice(10));
        }
        if (WRAPPER_ARG_OPTS[base]?.includes(opt)) w.shift();
      }
      while (w.length && /^\d+(\.\d+)?[smhd]?$/.test(w[0])) w.shift(); // timeout DURATION
      continue;
    }
    break;
  }
  if (replStrings.length) return w.map(x => (replStrings.includes(x) ? SUBST : x));
  return w;
}

function checkRm(args: string[], ctx: GuardContext, execSafe = false): string | null {
  let recursive = false;
  let endOpts = false;
  const targets: string[] = [];
  for (const a of args) {
    if (!endOpts && a === '--') { endOpts = true; continue; }
    if (!endOpts && a.startsWith('--')) {
      if (a === '--no-preserve-root') return 'rm --no-preserve-root';
      if (a === '--recursive') recursive = true;
      continue;
    }
    if (!endOpts && /^-[^-]/.test(a)) {
      if (/[rR]/.test(a)) recursive = true;
      continue;
    }
    targets.push(a);
  }
  if (!recursive) return null;
  // Targets we can't see (stdin via xargs, or all hidden behind a substitution): fail closed.
  if (targets.length === 0) return 'recursive rm with no visible target';
  // `{}` is filled from stdin (xargs) or find's results. Under find -exec the
  // find-root check decides; anywhere else it is an unknown target.
  if (!execSafe && targets.includes('{}')) return 'recursive rm of {} (filled from stdin)';
  for (const t of targets) {
    if (isDangerousTarget(t, ctx, { strictAbs: true })) return `recursive rm of ${t}`;
  }
  return null;
}

const FIND_FILTER = /^-(i?name|i?path|i?wholename|i?regex|[mac]time|[mac]min|newer\w*|user|group|empty|size|perm|samefile|links|inum)$/;

function checkFind(args: string[], ctx: GuardContext, depth: number): string | null {
  const execIdx = args.findIndex(a => /^-(exec|execdir|ok|okdir)$/.test(a));
  const execCmd = execIdx >= 0 ? basename(args[execIdx + 1] ?? '').toLowerCase() : '';
  if (execIdx >= 0) {
    const inner = analyseSegment(args.slice(execIdx + 1).filter(a => a !== '\\'), ctx, depth + 1, true);
    if (inner) return `find -exec: ${inner}`;
  }
  const deletes = args.includes('-delete') || ['rm', 'unlink', 'shred', 'rmdir'].includes(execCmd);
  if (!deletes) return null;
  const roots: string[] = [];
  let i = 0;
  while (i < args.length && /^-[HLPO]\d?$/.test(args[i])) i++;
  for (; i < args.length && !/^(-|\(|!|,)/.test(args[i]); i++) roots.push(args[i]);
  if (!roots.length) roots.push('.');
  const filtered = args.some(a => FIND_FILTER.test(a));
  for (const r of roots) {
    if (isDangerousTarget(r, ctx, { allowDot: filtered })) {
      return `find ${r} with ${args.includes('-delete') ? '-delete' : '-exec ' + execCmd}`;
    }
  }
  return null;
}

// rd/rmdir /s, del /s, Remove-Item -Recurse (cmd.exe and PowerShell spellings).
function checkWinDelete(cmd: string, args: string[], ctx: GuardContext): string | null {
  const recursive = args.some(a => /^\/s$/i.test(a) || /^-r(ecurse)?$/i.test(a));
  if (!recursive) return null;
  const targets = args.filter(a => !/^\/[a-z]$/i.test(a) && !a.startsWith('-'));
  if (targets.length === 0) return `recursive ${cmd} with no visible target`;
  for (const t of targets) {
    if (isDangerousTarget(t, ctx)) return `recursive ${cmd} of ${t}`;
  }
  return null;
}

function checkTruncate(args: string[]): string | null {
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-s0' || a === '--size=0' || a === '--size=+0') return 'truncate to size 0';
    if ((a === '-s' || a === '--size') && args[i + 1] === '0') return 'truncate to size 0';
  }
  return null;
}

function checkOwnership(cmd: string, args: string[], ctx: GuardContext): string | null {
  let recursive = false;
  const pos: string[] = [];
  let reference = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--reference') { reference = true; i++; continue; } // separate-argument form
    if (a.startsWith('--reference=')) { reference = true; continue; }
    if (a === '--recursive') recursive = true;
    else if (/^-[^-]*R/.test(a)) recursive = true;
    else if (!a.startsWith('-')) pos.push(a);
  }
  if (!recursive) return null;
  for (const t of reference ? pos : pos.slice(1)) { // otherwise the first positional is the mode / owner
    if (isDangerousTarget(t, ctx, { allowDot: true })) return `recursive ${cmd} of ${t}`;
  }
  return null;
}

function checkInterpreter(args: string[], ctx: GuardContext, depth: number): string | null {
  const flag = args.findIndex(a => /^(-c|-e|-E|-p|-r|--eval|eval)$/.test(a) || /^-[a-zA-Z]*[ce]$/.test(a));
  if (flag < 0) return null;
  const body = args.slice(flag + 1).join(' ');
  const deletes = DELETE_API.test(body);
  const shells = SHELL_OUT.test(body);
  if (!deletes && !shells) return null;
  if (deletes && HOME_REF.test(body)) return 'interpreter deleting a tree under the home directory';
  for (const m of body.matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)) {
    const lit = m[2];
    if (/\s/.test(lit)) {
      if (!shells) continue;
      const inner = findDestructiveInner(lit, ctx, depth + 1);
      if (inner) return `interpreter running: ${inner}`;
    } else if (deletes && lit && isDangerousTarget(lit, ctx)) {
      return `interpreter deleting ${lit}`;
    }
  }
  return null;
}

function analyseSegment(words: string[], ctx: GuardContext, depth: number, execSafe = false): string | null {
  const w = stripPrefixes(words);
  if (!w.length) return null;
  const cmd = basename(w[0].replace(/^\\/, '')).toLowerCase().replace(/\.exe$/, '');
  const args = w.slice(1);
  if (SHELLS.has(cmd)) {
    const i = args.findIndex(a => /^-[a-zA-Z]*c$/.test(a));
    return i >= 0 && args[i + 1] ? findDestructiveInner(args[i + 1], ctx, depth + 1) : null;
  }
  if (WIN_SHELLS.has(cmd)) {
    const i = args.findIndex(a => (cmd === 'cmd' ? /^\/[ck]$/i : /^-c(ommand)?$/i).test(a));
    return i >= 0 && args[i + 1] ? findDestructiveInner(args.slice(i + 1).join(' '), ctx, depth + 1) : null;
  }
  if (cmd === 'rd' || cmd === 'rmdir' || cmd === 'del' || cmd === 'erase' || cmd === 'remove-item' || cmd === 'ri') {
    return checkWinDelete(cmd, args, ctx);
  }
  if (cmd === 'eval') return findDestructiveInner(args.join(' '), ctx, depth + 1);
  if (cmd === 'rm') return checkRm(args, ctx, execSafe);
  if (cmd === 'find') return checkFind(args, ctx, depth);
  if (cmd === 'truncate') return checkTruncate(args);
  if (cmd === 'shred') return 'shred';
  if (/^mkfs(\.|$)/.test(cmd) || cmd === 'wipefs' || cmd === 'blkdiscard') return cmd;
  if (cmd === 'dd') {
    const of = args.find(a => a.startsWith('of=/dev/'));
    if (of && !/^of=\/dev\/(null|zero|stdout|stderr|tty|fd\/)/.test(of)) return `dd to ${of.slice(3)}`;
    return null;
  }
  if (cmd === 'chmod' || cmd === 'chown' || cmd === 'chgrp') return checkOwnership(cmd, args, ctx);
  if (INTERPRETERS.test(cmd)) return checkInterpreter(args, ctx, depth);
  return null;
}

function findDestructiveInner(cmd: string, ctx: GuardContext, depth: number): string | null {
  if (depth > 3) return null;
  let cwd = ctx.cwd;
  for (const seg of splitCommand(cmd)) {
    const w = stripPrefixes(seg);
    const head = (w[0] ?? '').toLowerCase();
    if (head === 'cd' || head === 'pushd') {
      const dir = w[1];
      cwd = dir && !/^[~$%-]/.test(dir) && cwd !== null ? resolve(cwd, dir) : null;
      continue;
    }
    const hit = analyseSegment(seg, { roots: ctx.roots, cwd }, depth);
    if (hit) return hit;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Simple regex patterns (single-shot, order-independent)
// ---------------------------------------------------------------------------

/** @internal Exported for testing. Patterns that need no tokenising. */
export const DESTRUCTIVE_BASH_PATTERNS = [
  /format\s+[a-z]:/i,
  /DROP\s+TABLE/i,
  /DROP\s+DATABASE/i,
  /:\(\)\s*\{\s*:\|:\s*&\s*\}\s*;/,        // fork bomb
  /git\s+push\s+.*--force.*\s+main/i,
  /git\s+push\s+.*--force.*\s+master/i,
  /curl\s+.*\|\s*(?:ba|z|da)?sh\b/i,   // word-anchored: `| sha256sum` / `| shasum` are fine
  /wget\s+.*\|\s*(?:ba|z|da)?sh\b/i,
  /mkfs\./i,
  /dd\s+.*of=\/dev\/(?!null|zero|stdout|stderr|tty)/i,
  />\s*\/dev\/(sd|hd|vd|xvd|nvme|mmcblk|disk)/i,   // redirect onto a block device
];

/**
 * Returns a short reason if `command` looks destructive, else null.
 * Best-effort only; see the note at the top of this file.
 */
export function findDestructiveBash(command: string, ctx: GuardContext): string | null {
  for (const p of DESTRUCTIVE_BASH_PATTERNS) {
    if (p.test(command)) return p.source;
  }
  return findDestructiveInner(command, ctx, 0);
}
