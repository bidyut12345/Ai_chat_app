/**
 * Registry of the built-in MCP servers that ship with the app.
 *
 * They are ordinary MCP servers living in this process, so they appear in the
 * MCP settings list, can be switched off, and their tools are namespaced like
 * any other server (`files__read_file`, `shell__run_command`).
 */
import { createBuiltinServer } from './factory.js';
import { fileTools } from './filesServer.js';
import { shellTools, stopAllJobs } from './shellServer.js';

export const BUILTIN_SERVERS = {
  files: {
    label: 'Built-in file tools',
    version: '1.0.0',
    description: 'Read, write, search and organise files. Honours the working folder and file access set for the chat.',
    tools: fileTools
  },
  shell: {
    label: 'Built-in shell tools',
    version: '1.0.0',
    description: 'Run shell commands in the foreground or background. Honours the working folder and shell access set for the chat.',
    tools: shellTools
  }
};

export const BUILTIN_KEYS = Object.keys(BUILTIN_SERVERS);

export function isBuiltinKey(key) {
  return Object.prototype.hasOwnProperty.call(BUILTIN_SERVERS, key);
}

/** Create a linked MCP server for a built-in key; returns { transport, ready }. */
export function createBuiltinTransport(key) {
  const def = BUILTIN_SERVERS[key];
  if (!def) throw new Error(`Unknown built-in MCP server "${key}"`);
  return createBuiltinServer(`builtin-${key}`, def.version, def.tools);
}

export function stopAllBuiltin() {
  stopAllJobs();
}
