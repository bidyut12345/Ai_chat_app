/**
 * Registry of the built-in MCP servers that ship with the app.
 *
 * They are ordinary MCP servers living in this process, so they appear in the
 * MCP settings list, can be switched off per chat, and their tools are
 * namespaced like any other server (`files__read_file`, `shell__run_command`,
 * `chrome__navigate`, `windows__list_windows`, ...).
 */
import { createBuiltinServer } from './factory.js';
import { fileTools } from './filesServer.js';
import { shellTools, stopAllJobs } from './shellServer.js';
import { windowsTools } from './windowsServer.js';
import { browserTools } from './browserServer.js';
import { stopBrowsers } from './cdp.js';

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
  },
  windows: {
    label: 'Built-in Windows automation',
    version: '1.0.0',
    description: 'Windows desktop automation: list and arrange windows, launch apps, type, click, read the clipboard and take screenshots.',
    tools: windowsTools
  },
  chrome: {
    label: 'Built-in Chrome automation',
    version: '1.0.0',
    description: 'Drive Google Chrome with its own profile: open pages, read text, click, fill forms, run JS and take screenshots.',
    tools: browserTools('chrome')
  },
  edge: {
    label: 'Built-in Edge automation',
    version: '1.0.0',
    description: 'Drive Microsoft Edge with its own profile: open pages, read text, click, fill forms, run JS and take screenshots.',
    tools: browserTools('edge')
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
  stopBrowsers();
}
