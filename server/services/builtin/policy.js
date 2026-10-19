/**
 * Access policy for the built-in `files` and `shell` MCP servers.
 *
 * The policy is **per conversation**: every chat carries its own working folder
 * and its own switches, resolved from the conversation that is currently
 * generating a reply (see `runWithConversation`). Outside a chat turn — for
 * example a manual call from the MCP panel — the safe defaults apply: the user's
 * home folder, restricted access and approval required.
 *
 *   approval_mode  'ask'  -> mutating tools pause for user approval
 *                  'auto' -> everything runs straight away
 *
 *   file_access    'restricted' -> every path must live under the chat's workdir
 *                  'full'       -> the whole filesystem
 *
 *   shell_access   'restricted' -> commands may only start inside the workdir
 *                  'full'       -> any working directory
 *
 *   files_enabled / shell_enabled -> hide the whole tool set from this chat
 *
 * NOTE: restricting the shell only pins the *starting* directory. A shell can
 * still `cd` elsewhere; approval mode is the real guard for shell commands.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { getSetting, aitempRoot } from '../../db.js';

export const DEFAULT_ROOT = os.homedir();

const BASE_POLICY = {
  approval: 'ask',
  fileAccess: 'restricted',
  shellAccess: 'restricted',
  workdir: DEFAULT_ROOT,
  filesEnabled: true,
  shellEnabled: true
};

const store = new AsyncLocalStorage();

const bool = (v) => (v === undefined || v === null ? true : Number(v) !== 0);

/** Turn a conversation row (or partial override) into a normalised policy. */
export function normalizePolicy(row) {
  if (!row) return { ...BASE_POLICY };
  const workdir = String(row.workdir || '').trim();
  return {
    approval: row.approval_mode === 'auto' ? 'auto' : 'ask',
    fileAccess: row.file_access === 'full' ? 'full' : 'restricted',
    shellAccess: row.shell_access === 'full' ? 'full' : 'restricted',
    workdir: path.resolve(workdir || DEFAULT_ROOT),
    filesEnabled: bool(row.files_enabled),
    shellEnabled: bool(row.shell_enabled)
  };
}

/** Run `fn` with `conversation` as the active tool policy. */
export function runWithConversation(conversation, fn) {
  return store.run(normalizePolicy(conversation), fn);
}

/** Run `fn` with an explicit policy override (used by tests and manual calls). */
export function runWithPolicy(policy, fn) {
  return store.run(normalizePolicy(policy), fn);
}

function ctx() {
  return store.getStore() || BASE_POLICY;
}

export function approvalMode() {
  return ctx().approval;
}

export function fileAccessMode() {
  return ctx().fileAccess;
}

export function shellAccessMode() {
  return ctx().shellAccess;
}

export function filesEnabled() {
  return ctx().filesEnabled;
}

export function shellEnabled() {
  return ctx().shellEnabled;
}

/** The chat's working folder: file root and default shell directory. */
export function fileRoot() {
  return ctx().workdir;
}

export function shellCwd() {
  return ctx().workdir;
}

export function shellTimeoutMs() {
  const n = parseInt(getSetting('builtin_shell_timeout') || '', 10);
  const seconds = Number.isNaN(n) ? 120 : Math.min(Math.max(n, 1), 3600);
  return seconds * 1000;
}

function isWithin(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Resolve symlinks for the deepest existing ancestor so that a link inside the
 * root cannot be used to escape it. The leaf may not exist yet (write_file).
 */
function realish(p) {
  let cur = p;
  const missing = [];
  while (!fs.existsSync(cur)) {
    const parent = path.dirname(cur);
    if (parent === cur) break;
    missing.unshift(path.basename(cur));
    cur = parent;
  }
  try {
    cur = fs.realpathSync(cur);
  } catch {
    /* keep the unresolved path */
  }
  return missing.length ? path.join(cur, ...missing) : cur;
}

export class PolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PolicyError';
  }
}

/**
 * Turn a model-supplied path into an absolute path and enforce the file scope.
 * Relative paths are resolved against the file root.
 */
export function resolvePath(rawPath, { mustExist = false } = {}) {
  if (typeof rawPath !== 'string' || !rawPath.trim()) {
    throw new PolicyError('A non-empty "path" is required.');
  }
  const root = fileRoot();
  const abs = path.resolve(root, rawPath.trim());

  if (fileAccessMode() === 'restricted') {
    const check = realish(abs);
    if (!isWithin(root, check)) {
      throw new PolicyError(
        `Access denied: "${abs}" is outside this chat's folder (${root}). ` +
          'Ask the user to switch file access to "Full access" or to change the working folder.'
      );
    }
  }

  if (mustExist && !fs.existsSync(abs)) {
    throw new PolicyError(`Path does not exist: ${abs}`);
  }
  return abs;
}

/** Validate a requested working directory for a shell command. */
export function resolveCwd(rawCwd) {
  const fallback = shellCwd();
  if (!rawCwd || !String(rawCwd).trim()) {
    if (!fs.existsSync(fallback)) {
      throw new PolicyError(`Default working directory does not exist: ${fallback}`);
    }
    return fallback;
  }
  const abs = path.resolve(fallback, String(rawCwd).trim());
  if (shellAccessMode() === 'restricted') {
    const root = realish(fallback);
    if (!isWithin(root, realish(abs))) {
      throw new PolicyError(
        `Access denied: working directory "${abs}" is outside ${root}. ` +
          'Ask the user to switch shell access to "Full access" for this chat.'
      );
    }
  }
  if (!fs.existsSync(abs)) throw new PolicyError(`Working directory does not exist: ${abs}`);
  if (!fs.statSync(abs).isDirectory()) throw new PolicyError(`Not a directory: ${abs}`);
  return abs;
}

/**
 * Does this tool need the user to approve it before it runs?
 *
 * The chat's approval switch is the master control: 'auto' allows everything.
 * Within 'ask' mode each server decides via its `approval` policy:
 *   'always' -> always prompt
 *   'never'  -> never prompt
 *   'auto'   -> built-in servers guard anything not annotated read-only;
 *               user-added servers are used exactly as the user configured
 *               them, so adding one does not start interrupting every call.
 */
export function toolNeedsApproval(tool) {
  if (!tool) return true;
  if (approvalMode() === 'auto') return false;
  const policy = tool.approval || 'auto';
  if (policy === 'never') return false;
  if (policy === 'always') return true;
  if (!tool.builtin) return false;
  return tool.annotations?.readOnlyHint !== true;
}

/** Human-readable summary shown in the approval prompt. */
export function describeCall(qualifiedName, args) {
  const a = args || {};
  const str = (v) => (typeof v === 'string' ? v : v == null ? '' : JSON.stringify(v));
  switch (qualifiedName) {
    case 'shell__run_command':
      return { kind: 'command', title: 'Run a shell command', detail: str(a.command), extra: a.cwd ? 'in ' + a.cwd : '' };
    case 'shell__start_command':
      return { kind: 'command', title: 'Start a background command', detail: str(a.command), extra: a.cwd ? 'in ' + a.cwd : '' };
    case 'shell__kill_process':
      return { kind: 'command', title: 'Kill a background process', detail: str(a.job_id ?? a.id) };
    case 'files__write_file':
      return {
        kind: 'file',
        title: a.append ? 'Append to a file' : 'Write a file',
        detail: str(a.path),
        body: str(a.content).slice(0, 4000)
      };
    case 'files__delete_path':
      return { kind: 'file', title: 'Delete from disk', detail: str(a.path) };
    case 'files__move_path':
      return { kind: 'file', title: 'Move / rename', detail: `${str(a.from)}  ->  ${str(a.to)}` };
    case 'files__copy_path':
      return { kind: 'file', title: 'Copy', detail: `${str(a.from)}  ->  ${str(a.to)}` };
    case 'files__create_directory':
      return { kind: 'file', title: 'Create a folder', detail: str(a.path) };
    default:
      return { kind: 'tool', title: `Run ${qualifiedName}`, detail: JSON.stringify(a, null, 2).slice(0, 2000) };
  }
}

/**
 * Effective policy for one conversation (or the defaults when no chat is
 * given). Used by the API so the UI can show what a chat will really do.
 */
export function policySnapshot(conversation) {
  return runWithPolicy(conversation, () => ({
    approval_mode: approvalMode(),
    file_access: fileAccessMode(),
    shell_access: shellAccessMode(),
    workdir: fileRoot(),
    files_enabled: filesEnabled(),
    shell_enabled: shellEnabled(),
    shell_timeout_seconds: Math.round(shellTimeoutMs() / 1000),
    default_workdir: aitempRoot()
  }));
}
