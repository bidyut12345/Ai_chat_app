/**
 * Minimal ZIP reader/writer built on node:zlib — no extra dependency.
 *
 * Supports what the built-in file tools need: stored (method 0) and deflated
 * (method 8) entries, folders, and UTF-8 names. ZIP64 and encrypted archives
 * are rejected with a clear message instead of producing garbage.
 *
 * The writer streams one entry at a time to disk (only the central directory
 * stays in memory), so sharing a large workspace does not hold the whole
 * archive in RAM.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';

/* ───────────────────────────── CRC-32 ───────────────────────────── */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(value) {
  const d = value instanceof Date ? value : new Date();
  const year = Math.max(1980, d.getFullYear());
  const time = ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1f);
  const date = (((year - 1980) & 0x7f) << 9) | (((d.getMonth() + 1) & 0x0f) << 5) | (d.getDate() & 0x1f);
  return { time: time & 0xffff, date: date & 0xffff };
}

/* ─────────────────────────── Collecting ─────────────────────────── */

const DEFAULT_IGNORED = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.cache',
  'venv', '.venv', '__pycache__', '.turbo', '.parcel-cache'
]);

/**
 * Walk `sources` and build the list of entries for `writeZipFile()`.
 * `flat` omits the top-level folder name (used by "share workspace").
 * Returns `{ entries, skipped, totalBytes }`.
 */
export async function collectEntries(sources, opts = {}) {
  const {
    exclude = new Set(),
    ignoreDirs = DEFAULT_IGNORED,
    maxEntries = 5000,
    maxTotalBytes = 512 * 1024 * 1024,
    flat = false
  } = opts;

  const entries = [];
  const skipped = { tooBig: 0, tooMany: 0, unreadable: 0 };
  const seen = new Set();
  let totalBytes = 0;

  const addFile = async (abs, name) => {
    const norm = path.resolve(abs);
    if (exclude.has(norm) || seen.has(norm)) return;
    seen.add(norm);
    if (entries.length >= maxEntries) {
      skipped.tooMany++;
      return;
    }
    let st;
    try {
      st = await fsp.stat(norm);
    } catch {
      skipped.unreadable++;
      return;
    }
    if (!st.isFile()) return;
    if (totalBytes + st.size > maxTotalBytes) {
      skipped.tooBig++;
      return;
    }
    totalBytes += st.size;
    entries.push({ name: name.split(path.sep).join('/'), source: norm, size: st.size, mtime: st.mtime });
  };

  const walk = async (dir, prefix) => {
    let dirents;
    try {
      dirents = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      skipped.unreadable++;
      return;
    }
    for (const d of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = path.join(dir, d.name);
      if (d.isDirectory()) {
        if (ignoreDirs.has(d.name)) continue;
        await walk(abs, prefix ? `${prefix}/${d.name}` : d.name);
      } else if (d.isFile()) {
        await addFile(abs, prefix ? `${prefix}/${d.name}` : d.name);
      }
    }
  };

  for (const raw of sources) {
    const src = path.resolve(raw);
    let st;
    try {
      st = await fsp.stat(src);
    } catch {
      skipped.unreadable++;
      continue;
    }
    if (st.isDirectory()) {
      const kids = await fsp.readdir(src, { withFileTypes: true }).catch(() => []);
      const prefix = flat ? '' : path.basename(src);
      if (!kids.length && prefix) {
        entries.push({ name: `${prefix}/`, dir: true, mtime: st.mtime });
        continue;
      }
      await walk(src, prefix);
    } else if (st.isFile()) {
      await addFile(src, path.basename(src));
    }
  }

  return { entries, skipped, totalBytes };
}

/* ─────────────────────────── Writing ─────────────────────────── */

/**
 * Write a ZIP archive. Each entry is `{ name, source }` or `{ name, data }`,
 * plus optional `{ dir: true, mtime }`.
 * Returns `{ entries, size }`.
 */
export async function writeZipFile(destAbs, entries) {
  await fsp.mkdir(path.dirname(destAbs), { recursive: true });
  const fd = fs.openSync(destAbs, 'w');
  const central = [];
  let offset = 0;

  const write = (buf) => {
    if (!buf.length) return;
    fs.writeSync(fd, buf);
    offset += buf.length;
  };

  try {
    for (const e of entries) {
      const nameBuf = Buffer.from(String(e.name), 'utf8');
      const isDir = !!e.dir || String(e.name).endsWith('/');
      const data = isDir ? Buffer.alloc(0) : e.data != null ? Buffer.from(e.data) : await fsp.readFile(e.source);
      const crc = isDir ? 0 : crc32(data);
      let method = 0;
      let payload = data;
      if (!isDir && data.length) {
        const compressed = zlib.deflateRawSync(data);
        if (compressed.length < data.length) {
          method = 8;
          payload = compressed;
        }
      }
      const { time, date } = dosDateTime(e.mtime);
      const localOffset = offset;

      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4); // version needed
      header.writeUInt16LE(0x0800, 6); // UTF-8 names
      header.writeUInt16LE(method, 8);
      header.writeUInt16LE(time, 10);
      header.writeUInt16LE(date, 12);
      header.writeUInt32LE(crc >>> 0, 14);
      header.writeUInt32LE(payload.length, 18);
      header.writeUInt32LE(isDir ? 0 : data.length, 22);
      header.writeUInt16LE(nameBuf.length, 26);
      header.writeUInt16LE(0, 28);
      write(header);
      write(nameBuf);
      write(payload);

      central.push({
        nameBuf,
        crc,
        compSize: payload.length,
        uncompSize: isDir ? 0 : data.length,
        method,
        time,
        date,
        localOffset,
        dir: isDir
      });
    }

    const cdStart = offset;
    for (const e of central) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(20, 4); // version made by
      h.writeUInt16LE(20, 6); // version needed
      h.writeUInt16LE(0x0800, 8); // UTF-8 names
      h.writeUInt16LE(e.method, 10);
      h.writeUInt16LE(e.time, 12);
      h.writeUInt16LE(e.date, 14);
      h.writeUInt32LE(e.crc >>> 0, 16);
      h.writeUInt32LE(e.compSize, 20);
      h.writeUInt32LE(e.uncompSize, 24);
      h.writeUInt16LE(e.nameBuf.length, 28);
      h.writeUInt16LE(0, 30); // extra
      h.writeUInt16LE(0, 32); // comment
      h.writeUInt16LE(0, 34); // disk
      h.writeUInt16LE(0, 36); // internal attrs
      h.writeUInt32LE(e.dir ? 0x10 : 0, 38); // external attrs
      h.writeUInt32LE(e.localOffset, 42);
      write(h);
      write(e.nameBuf);
    }

    const cdSize = offset - cdStart;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(central.length & 0xffff, 8);
    eocd.writeUInt16LE(central.length & 0xffff, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdStart, 16);
    eocd.writeUInt16LE(0, 20);
    write(eocd);
  } finally {
    fs.closeSync(fd);
  }

  return { entries: central.length, size: offset };
}

/* ─────────────────────────── Reading ─────────────────────────── */

function findEocd(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/** Parse the central directory. Returns entry descriptors (no data yet). */
export function readZipEntries(buf) {
  const eocd = findEocd(buf);
  if (eocd < 0) throw new Error('Not a valid ZIP file (end of central directory not found).');
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || cdSize === 0xffffffff || count === 0xffff) {
    throw new Error('ZIP64 archives are not supported.');
  }
  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
      throw new Error('Corrupt ZIP central directory.');
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    if (compSize === 0xffffffff || uncompSize === 0xffffffff || localOffset === 0xffffffff) {
      throw new Error('ZIP64 archives are not supported.');
    }
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    entries.push({ name, flags, method, crc, compSize, uncompSize, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Inflate/copy one entry's data and verify its CRC. */
export function readZipEntryData(buf, entry) {
  if (entry.flags & 0x1) throw new Error(`"${entry.name}" is encrypted; encrypted ZIPs are not supported.`);
  const p = entry.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) {
    throw new Error('Corrupt ZIP local header.');
  }
  const nameLen = buf.readUInt16LE(p + 26);
  const extraLen = buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const raw = buf.subarray(start, start + entry.compSize);
  let data;
  if (entry.method === 0) data = Buffer.from(raw);
  else if (entry.method === 8) data = zlib.inflateRawSync(raw);
  else throw new Error(`Unsupported compression method ${entry.method} for "${entry.name}".`);
  if (entry.crc && crc32(data) !== (entry.crc >>> 0)) {
    throw new Error(`CRC mismatch for "${entry.name}".`);
  }
  return data;
}

/** Normalise a ZIP entry name; returns null when it would escape the target. */
export function safeEntryName(name) {
  const cleaned = String(name).replace(/\\/g, '/').replace(/^[a-zA-Z]:/, '');
  if (!cleaned || cleaned.startsWith('/')) return null;
  const parts = cleaned.split('/').filter((p) => p && p !== '.');
  if (parts.some((p) => p === '..')) return null;
  return parts.join('/');
}
