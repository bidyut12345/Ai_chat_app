/**
 * Built-in MCP server: `files` (file management).
 *
 * Every path goes through policy.resolvePath(), so the restricted/full access
 * switch is enforced here. Read-only tools are annotated so that approval mode
 * 'ask' lets them run without interrupting the user.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { resolvePath, PolicyError } from './policy.js';
import { trackFile } from '../fileChanges.js';
import {
  collectEntries,
  writeZipFile,
  readZipEntries,
  readZipEntryData,
  safeEntryName
} from './zip.js';

const READ_CAP_BYTES = 200000;
const LIST_CAP = 2000;

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if ('\\^$.|+()[]{}'.includes(c)) out += `\\${c}`;
    else if (c === path.sep || c === '/') out += '/';
    else out += c;
  }
  return new RegExp(`^${out}$`, 'i');
}

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.cache',
  'venv', '.venv', '__pycache__', '.turbo', '.parcel-cache'
]);

async function* walk(dir, recursive) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    yield { entry: e, full };
    if (recursive && e.isDirectory() && !IGNORED_DIRS.has(e.name)) {
      yield* walk(full, true);
    }
  }
}

const str = (v) => (typeof v === 'string' ? v : '');

export const fileTools = [
  {
    name: 'list_directory',
    readOnly: true,
    description: 'List the entries of a directory. Returns one line per entry with type, size and name. Relative paths resolve against the allowed root folder.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory to list. Defaults to the root folder.' },
        recursive: { type: 'boolean', description: 'Recurse into subdirectories (skips node_modules and .git). Default false.' },
        pattern: { type: 'string', description: 'Optional glob filter matched against the file name, e.g. "*.js".' }
      }
    },
    async handler(args) {
      const dir = resolvePath(str(args.path) || '.', { mustExist: true });
      const st = await fsp.stat(dir);
      if (!st.isDirectory()) throw new PolicyError(`Not a directory: ${dir}`);
      const re = args.pattern ? globToRegExp(String(args.pattern)) : null;
      const lines = [];
      let skipped = 0;
      for await (const { entry, full } of walk(dir, !!args.recursive)) {
        const rel = path.relative(dir, full);
        if (re && !re.test(entry.name)) continue;
        if (lines.length >= LIST_CAP) {
          skipped++;
          continue;
        }
        let size = '';
        try {
          if (entry.isFile()) size = ` ${fmtBytes((await fsp.stat(full)).size)}`;
        } catch {
          /* ignore unreadable size */
        }
        const kind = entry.isDirectory() ? 'dir ' : entry.isSymbolicLink() ? 'link' : 'file';
        lines.push(`${kind} ${rel}${size}`);
      }
      if (!lines.length) return `No entries in ${dir}`;
      const head = `${dir}\n${lines.length}${skipped ? '+' : ''} entries:\n`;
      return head + lines.join('\n') + (skipped ? `\n...[over ${LIST_CAP} entries, ${skipped} more not shown]` : '');
    }
  },

  {
    name: 'read_file',
    readOnly: true,
    description: 'Read a text file. Returns the content with line numbers. Large files are truncated; use offset/limit to page through them.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File to read.' },
        offset: { type: 'number', description: '1-based line to start from. Default 1.' },
        limit: { type: 'number', description: 'Maximum number of lines to return. Default 400.' }
      },
      required: ['path']
    },
    async handler(args) {
      const file = resolvePath(str(args.path), { mustExist: true });
      const st = await fsp.stat(file);
      if (st.isDirectory()) throw new PolicyError(`${file} is a directory - use list_directory.`);
      if (st.size > 8 * 1024 * 1024) throw new PolicyError(`File is too large to read (${fmtBytes(st.size)}).`);
      const buf = await fsp.readFile(file);
      if (buf.includes(0)) throw new PolicyError(`"${path.basename(file)}" looks like a binary file (${fmtBytes(st.size)}); it cannot be shown as text.`);
      const all = buf.toString('utf8').split(/\r?\n/);
      const from = Math.max(1, Number(args.offset) || 1);
      const count = Math.min(Math.max(1, Number(args.limit) || 400), 5000);
      const slice = all.slice(from - 1, from - 1 + count);
      const body = slice.map((line, i) => `${from + i}: ${line}`).join('\n');
      const tail = from - 1 + slice.length < all.length ? `\n...[showing lines ${from}-${from + slice.length - 1} of ${all.length}]` : '';
      return `${file} (${all.length} lines, ${fmtBytes(st.size)})\n${body}${tail}`;
    }
  },

  {
    name: 'write_file',
    destructive: true,
    description: 'Create or overwrite a text file (or append to it). Parent folders are created when missing.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File to write.' },
        content: { type: 'string', description: 'Full text content.' },
        append: { type: 'boolean', description: 'Append instead of overwriting. Default false.' }
      },
      required: ['path', 'content']
    },
    async handler(args) {
      const file = resolvePath(str(args.path));
      const content = typeof args.content === 'string' ? args.content : '';
      return trackFile(file, async () => {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.appendFile(file, args.append ? content : '', 'utf8');
        if (args.append) return `Appended ${fmtBytes(Buffer.byteLength(content))} to ${file}`;
        await fsp.writeFile(file, content, 'utf8');
        return `Wrote ${fmtBytes(Buffer.byteLength(content))} to ${file}`;
      });
    }
  },

  {
    name: 'edit_file',
    destructive: true,
    description: 'Replace an exact target snippet in an existing text file with replacement text. Ideal for surgical updates without rewriting the whole file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File to edit.' },
        target: { type: 'string', description: 'Exact text snippet to be replaced.' },
        replacement: { type: 'string', description: 'New text to replace the target snippet with.' },
        allow_multiple: { type: 'boolean', description: 'If true, replaces all occurrences. Default false (must match uniquely).' }
      },
      required: ['path', 'target', 'replacement']
    },
    async handler(args) {
      const file = resolvePath(str(args.path), { mustExist: true });
      const target = typeof args.target === 'string' ? args.target : '';
      if (!target) throw new PolicyError('target snippet cannot be empty');
      const replacement = typeof args.replacement === 'string' ? args.replacement : '';
      const text = await fsp.readFile(file, 'utf8');
      if (!text.includes(target)) {
        throw new PolicyError(`Target snippet not found in ${file}. Make sure the target text matches the file content exactly.`);
      }
      const count = text.split(target).length - 1;
      if (!args.allow_multiple && count > 1) {
        throw new PolicyError(`Target snippet occurs ${count} times in ${file}. Provide more surrounding context to match uniquely, or set allow_multiple: true.`);
      }
      const updated = args.allow_multiple ? text.replaceAll(target, replacement) : text.replace(target, replacement);
      return trackFile(file, async () => {
        await fsp.writeFile(file, updated, 'utf8');
        return `Successfully replaced ${count} occurrence(s) in ${file}`;
      });
    }
  },

  {
    name: 'create_directory',
    destructive: true,
    description: 'Create a directory, including any missing parent directories.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Directory to create.' } },
      required: ['path']
    },
    async handler(args) {
      const dir = resolvePath(str(args.path));
      await fsp.mkdir(dir, { recursive: true });
      return `Created directory ${dir}`;
    }
  },

  {
    name: 'delete_path',
    destructive: true,
    description: 'Delete a file, or a directory and everything inside it when recursive is true.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to delete.' },
        recursive: { type: 'boolean', description: 'Delete a directory tree. Default false.' }
      },
      required: ['path']
    },
    async handler(args) {
      const target = resolvePath(str(args.path), { mustExist: true });
      const st = await fsp.stat(target);
      return trackFile(target, async () => {
        if (st.isDirectory()) {
          if (!args.recursive) throw new PolicyError(`${target} is a directory. Pass recursive: true to delete it and its contents.`);
          await fsp.rm(target, { recursive: true, force: true });
          return `Deleted directory tree ${target}`;
        }
        await fsp.rm(target, { force: true });
        return `Deleted ${target}`;
      });
    }
  },

  {
    name: 'move_path',
    destructive: true,
    description: 'Move or rename a file or directory.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Existing path.' },
        to: { type: 'string', description: 'New path.' }
      },
      required: ['from', 'to']
    },
    async handler(args) {
      const src = resolvePath(str(args.from), { mustExist: true });
      const dest = resolvePath(str(args.to));
      return trackFile([src, dest], async () => {
        await fsp.mkdir(path.dirname(dest), { recursive: true });
        await fsp.rename(src, dest);
        return `Moved ${src} -> ${dest}`;
      });
    }
  },

  {
    name: 'copy_path',
    destructive: true,
    description: 'Copy a file, or a directory tree when recursive is true.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Source path.' },
        to: { type: 'string', description: 'Destination path.' },
        recursive: { type: 'boolean', description: 'Copy a directory tree. Default false.' }
      },
      required: ['from', 'to']
    },
    async handler(args) {
      const src = resolvePath(str(args.from), { mustExist: true });
      const dest = resolvePath(str(args.to));
      return trackFile(dest, async () => {
        await fsp.cp(src, dest, { recursive: !!args.recursive });
        return `Copied ${src} -> ${dest}`;
      });
    }
  },

  {
    name: 'file_info',
    readOnly: true,
    description: 'Show metadata for a path: type, size, modified time and whether it is readable.',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to inspect.' } },
      required: ['path']
    },
    async handler(args) {
      const target = resolvePath(str(args.path), { mustExist: true });
      const st = await fsp.stat(target);
      let readable = true;
      try {
        await fsp.access(target, fs.constants.R_OK);
      } catch {
        readable = false;
      }
      return [
        `path:     ${target}`,
        `type:     ${st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other'}`,
        `size:     ${fmtBytes(st.size)}`,
        `modified: ${st.mtime.toISOString()}`,
        `readable: ${readable}`
      ].join('\n');
    }
  },

  {
    name: 'search_files',
    readOnly: true,
    description: 'Find files by name glob, optionally returning their full text matches. Use this before reading files you do not know exist.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob matched against file names, e.g. "**/*.ts" or "config".' },
        path: { type: 'string', description: 'Directory to search. Defaults to the root folder.' },
        max_results: { type: 'number', description: 'Maximum matches to return. Default 100.' }
      },
      required: ['pattern']
    },
    async handler(args) {
      const root = resolvePath(str(args.path) || '.', { mustExist: true });
      const re = globToRegExp(String(args.pattern).includes('*') || String(args.pattern).includes('?') ? args.pattern : `*${args.pattern}*`);
      const cap = Math.min(Math.max(1, Number(args.max_results) || 100), 1000);
      const hits = [];
      for await (const { entry, full } of walk(root, true)) {
        if (!re.test(entry.name)) continue;
        hits.push(`${entry.isDirectory() ? 'dir ' : 'file'} ${path.relative(root, full)}`);
        if (hits.length >= cap) break;
      }
      return hits.length ? `${hits.length} match(es) under ${root}:\n${hits.join('\n')}` : `No files matching "${args.pattern}" under ${root}`;
    }
  },

  {
    name: 'search_text',
    readOnly: true,
    description: 'Search file contents for a regular expression or literal string. Returns file, line number and the matching line.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text or regular expression to find.' },
        path: { type: 'string', description: 'Directory to search. Defaults to the root folder.' },
        glob: { type: 'string', description: 'Only search files matching this glob, e.g. "*.js". Default "*".' },
        regex: { type: 'boolean', description: 'Treat query as a regular expression. Default false.' },
        ignore_case: { type: 'boolean', description: 'Case-insensitive match. Default true.' },
        max_results: { type: 'number', description: 'Maximum matches to return. Default 100.' }
      },
      required: ['query']
    },
    async handler(args) {
      const root = resolvePath(str(args.path) || '.', { mustExist: true });
      const q = String(args.query ?? '');
      if (!q) throw new PolicyError('query is required');
      const ci = args.ignore_case !== false;
      let matcher;
      if (args.regex) {
        try {
          matcher = new RegExp(q, ci ? 'i' : '');
        } catch (e) {
          throw new PolicyError(`Invalid regular expression: ${e.message}`);
        }
      } else {
        matcher = null;
      }
      const globRe = globToRegExp(str(args.glob) || '*');
      const cap = Math.min(Math.max(1, Number(args.max_results) || 100), 500);
      const hits = [];
      let filesScanned = 0;
      for await (const { entry, full } of walk(root, true)) {
        if (!entry.isFile() || !globRe.test(entry.name)) continue;
        let st;
        try {
          st = await fsp.stat(full);
        } catch {
          continue;
        }
        if (st.size > READ_CAP_BYTES) continue;
        let text;
        try {
          text = await fsp.readFile(full, 'utf8');
        } catch {
          continue;
        }
        if (text.includes('\u0000')) continue;
        filesScanned++;
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const ok = matcher ? matcher.test(line) : ci ? line.toLowerCase().includes(q.toLowerCase()) : line.includes(q);
          if (!ok) continue;
          hits.push(`${path.relative(root, full)}:${i + 1}: ${line.trim().slice(0, 300)}`);
          if (hits.length >= cap) break;
        }
        if (hits.length >= cap) break;
      }
      if (!hits.length) return `No matches for "${q}" (scanned ${filesScanned} file(s) under ${root})`;
      return `${hits.length} match(es)${hits.length >= cap ? ' (capped)' : ''}:\n${hits.join('\n')}`;
    }
  },

  {
    name: 'zip',
    destructive: true,
    description: 'Compress files or folders into a .zip archive. Returns the archive path and size. Folders keep their name as the top-level entry; node_modules, .git and build output are skipped.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Destination .zip file. ".zip" is added when the name has no extension.' },
        sources: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files or folders to include. Defaults to the whole working folder.'
        },
        overwrite: { type: 'boolean', description: 'Replace an existing archive. Default false.' }
      },
      required: ['path']
    },
    async handler(args) {
      let dest = resolvePath(str(args.path));
      if (!/\.zip$/i.test(dest)) dest += '.zip';
      if (fs.existsSync(dest) && !args.overwrite) {
        throw new PolicyError(`${dest} already exists. Pass overwrite: true to replace it.`);
      }
      const rawSources = Array.isArray(args.sources) ? args.sources : args.sources ? [args.sources] : ['.'];
      const sources = rawSources.map((s) => resolvePath(str(s), { mustExist: true }));
      const { entries, skipped } = await collectEntries(sources, { exclude: new Set([path.resolve(dest)]) });
      if (!entries.length) throw new PolicyError('Nothing to compress.');
      const result = await writeZipFile(dest, entries);
      const notes = [];
      if (skipped.tooBig) notes.push(`${skipped.tooBig} file(s) skipped (archive size cap)`);
      if (skipped.tooMany) notes.push(`${skipped.tooMany} file(s) skipped (entry cap)`);
      if (skipped.unreadable) notes.push(`${skipped.unreadable} unreadable item(s) skipped`);
      return `Created ${dest} (${result.entries} entries, ${fmtBytes(result.size)})${notes.length ? `\n${notes.join('\n')}` : ''}`;
    }
  },

  {
    name: 'unzip',
    destructive: true,
    description: 'Extract a .zip archive into a folder. Entry paths that would escape the destination are refused. Existing files are skipped unless overwrite is true.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'The .zip file to extract.' },
        to: { type: 'string', description: 'Destination folder. Defaults to a folder named after the archive next to it.' },
        overwrite: { type: 'boolean', description: 'Overwrite existing files. Default false.' }
      },
      required: ['path']
    },
    async handler(args) {
      const zipPath = resolvePath(str(args.path), { mustExist: true });
      const st = await fsp.stat(zipPath);
      if (!st.isFile()) throw new PolicyError(`${zipPath} is not a file.`);
      if (st.size > 512 * 1024 * 1024) throw new PolicyError('Archive is too large to extract (512 MB max).');
      const buf = await fsp.readFile(zipPath);
      const entries = readZipEntries(buf);
      const dest = args.to
        ? resolvePath(str(args.to))
        : path.join(path.dirname(zipPath), path.basename(zipPath).replace(/\.zip$/i, ''));
      // Validate the destination itself against the chat's policy (it may not
      // exist yet, which resolvePath allows).
      resolvePath(dest);

      const dirs = [];
      const files = [];
      const skipped = [];
      for (const entry of entries) {
        const safe = safeEntryName(entry.name);
        if (!safe) {
          skipped.push(`${entry.name} (unsafe path)`);
          continue;
        }
        const abs = path.resolve(dest, safe);
        const rel = path.relative(dest, abs);
        if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
          skipped.push(`${entry.name} (outside target)`);
          continue;
        }
        if (entry.name.endsWith('/')) dirs.push(abs);
        else files.push({ entry, abs });
      }

      let written = 0;
      await trackFile(files.map((f) => f.abs), async () => {
        for (const dir of dirs) await fsp.mkdir(dir, { recursive: true });
        for (const { entry, abs } of files) {
          if (!args.overwrite && fs.existsSync(abs)) {
            skipped.push(`${entry.name} (exists)`);
            continue;
          }
          const data = readZipEntryData(buf, entry);
          await fsp.mkdir(path.dirname(abs), { recursive: true });
          await fsp.writeFile(abs, data);
          written++;
        }
      });
      if (!written && !skipped.length) throw new PolicyError('The archive has no files.');
      const notes = skipped.length ? `\nSkipped ${skipped.length}:\n${skipped.slice(0, 20).join('\n')}${skipped.length > 20 ? '\n…' : ''}` : '';
      return `Extracted ${written} file(s) to ${dest}${notes}`;
    }
  },

  {
    name: 'share_workspace',
    destructive: true,
    description: 'Compress the whole chat working folder into a downloadable .zip archive. Use this when the user asks to share, export or download the workspace. The archive is returned as a produced file the user can download.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional archive path. Default "workspace.zip" in the working folder.' },
        overwrite: { type: 'boolean', description: 'Replace an existing archive. Default true.' }
      }
    },
    async handler(args) {
      const root = resolvePath('.', { mustExist: true });
      let dest = resolvePath(str(args.path) || 'workspace.zip');
      if (!/\.zip$/i.test(dest)) dest += '.zip';
      if (fs.existsSync(dest) && args.overwrite === false) {
        throw new PolicyError(`${dest} already exists. Pass overwrite: true to replace it.`);
      }
      const { entries, skipped } = await collectEntries([root], {
        flat: true,
        exclude: new Set([path.resolve(dest)])
      });
      if (!entries.length) throw new PolicyError('The workspace is empty — nothing to share.');
      const result = await writeZipFile(dest, entries);
      const notes = [];
      if (skipped.tooBig) notes.push(`${skipped.tooBig} file(s) skipped (archive size cap)`);
      if (skipped.tooMany) notes.push(`${skipped.tooMany} file(s) skipped (entry cap)`);
      return `Shared the workspace as ${dest} (${result.entries} entries, ${fmtBytes(result.size)}). The archive is ready to download.${notes.length ? `\n${notes.join('\n')}` : ''}`;
    }
  }
];
