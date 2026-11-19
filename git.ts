// Git object model, pkt-line codec and packfile writing/reading — pure Node stdlib.
// Objects are stored loose in memory, keyed by their SHA-1. Packs are written plain
// (no deltas) and read with OFS/REF delta resolution, so any client pack round-trips.

import { createHash } from 'node:crypto';
import { inflateSync as zlibInflate, deflateSync as zlibDeflate } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

/** SHA-1 of a git object header + payload. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Store an object, returning its oid. */
export function storeObject(objects: Map<string, GitObject>, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------- commits

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's raw bytes. */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Build a commit object's raw bytes. */
export function buildCommit(opts: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${opts.tree}`];
  for (const parent of opts.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${opts.author}`);
  lines.push(`committer ${opts.committer}`);
  return Buffer.from(`${lines.join('\n')}\n\n${opts.message}`, 'utf8');
}

/** `Name <email> timestamp tz` identity line. */
export function identity(name: string, email: string, epochSec: number): string {
  return `${name} <${email}> ${epochSec} +0000`;
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's raw bytes into entries (sorted as stored). */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0, space + 1);
    if (nul < 0) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Build a tree object from entries (sorted git-style: dirs sort as if named with '/'). */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** The flat path -> blob oid map of a tree, recursively. */
export function flattenTree(
  objects: Map<string, GitObject>,
  treeOid: string,
  prefix = '',
  out: Map<string, { oid: string; mode: string }> = new Map(),
): Map<string, { oid: string; mode: string }> {
  const tree = objects.get(treeOid);
  if (!tree || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(objects, entry.oid, path, out);
    else out.set(path, { oid: entry.oid, mode: entry.mode });
  }
  return out;
}

/** Build the nested tree objects for a flat path map; returns the root tree oid. */
export function buildTreeFromPaths(
  objects: Map<string, GitObject>,
  files: Map<string, { oid: string; mode: string }>,
): string {
  interface DirNode {
    entries: Map<string, TreeEntry>;
  }
  const root: DirNode = { entries: new Map() };
  const dirs = new Map<string, DirNode>([['', root]]);
  const ensureDir = (path: string): DirNode => {
    const existing = dirs.get(path);
    if (existing) return existing;
    const node: DirNode = { entries: new Map() };
    dirs.set(path, node);
    const slash = path.lastIndexOf('/');
    const parent = slash === -1 ? '' : path.slice(0, slash);
    const name = slash === -1 ? path : path.slice(slash + 1);
    ensureDir(parent).entries.set(name, { mode: '40000', name, oid: '' });
    return node;
  };
  for (const [path, file] of files) {
    const slash = path.lastIndexOf('/');
    const dir = slash === -1 ? '' : path.slice(0, slash);
    const name = slash === -1 ? path : path.slice(slash + 1);
    ensureDir(dir).entries.set(name, { mode: file.mode, name, oid: file.oid });
  }
  const writeDir = (path: string): string => {
    const node = dirs.get(path) as DirNode;
    const entries: TreeEntry[] = [];
    for (const entry of node.entries.values()) {
      if (entry.mode === '40000') {
        const subPath = path === '' ? entry.name : `${path}/${entry.name}`;
        entries.push({ mode: '40000', name: entry.name, oid: writeDir(subPath) });
      } else {
        entries.push(entry);
      }
    }
    return storeObject(objects, 'tree', buildTree(entries));
  };
  return writeDir('');
}

// ---------------------------------------------------------------- tags

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildTag(opts: { object: string; type: string; tag: string; tagger: string; message: string }): Buffer {
  return Buffer.from(
    `object ${opts.object}\ntype ${opts.type}\ntag ${opts.tag}\ntagger ${opts.tagger}\n\n${opts.message}`,
    'utf8',
  );
}

// ---------------------------------------------------------------- ancestry helpers (on an object map)

/** Peel an oid to the commit it resolves to (through annotated tags), or null. */
export function peelToCommit(objects: Map<string, GitObject>, oid: string): string | null {
  const obj = objects.get(oid);
  if (!obj) return null;
  if (obj.type === 'commit') return oid;
  if (obj.type === 'tag') {
    const tag = parseTag(obj.data);
    return peelToCommit(objects, tag.object);
  }
  return null;
}

/** Is `ancestor` an ancestor of (or equal to) `descendant`? */
export function isAncestor(objects: Map<string, GitObject>, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue: string[] = [descendant];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const parent of parseCommit(obj.data).parents) queue.push(parent);
  }
  return false;
}

// ---------------------------------------------------------------- pkt-lines

/** Encode one pkt-line (payload without the length prefix). */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

/** Encode a list of lines / flush / delim markers into pkt-lines. */
export function encodePktLines(lines: readonly (string | Buffer | 'flush' | 'delim' | 'response-end')[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    if (line === 'flush') parts.push(PKT_FLUSH);
    else if (line === 'delim') parts.push(PKT_DELIM);
    else if (line === 'response-end') parts.push(PKT_RESPONSE_END);
    else parts.push(pktLine(line));
  }
  return Buffer.concat(parts);
}

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface PktPacket {
  kind: PktKind;
  payload: Buffer;
}

/**
 * Decode a whole buffer of pkt-lines. Stops at the first malformed length (returns what
 * decoded so far plus `malformed: true`); the caller decides the HTTP status.
 */
export function decodePktLines(buf: Buffer): { packets: PktPacket[]; malformed: boolean; consumed: number } {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const lenText = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) return { packets, malformed: true, consumed: offset };
    const len = parseInt(lenText, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) return { packets, malformed: true, consumed: offset };
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  return { packets, malformed: offset !== buf.length, consumed: offset };
}

/**
 * Split a receive-pack / upload-pack request body at the first flush pkt-line:
 * [pkt-lines up to and including the flush, the rest (the pack)]. Only the bytes
 * before the flush are parsed as pkt-lines; the pack after it is raw.
 */
export function splitAtFlush(buf: Buffer): { packets: PktPacket[]; rest: Buffer; malformed: boolean } {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const lenText = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(lenText)) return { packets, rest: Buffer.alloc(0), malformed: true };
    const len = parseInt(lenText, 16);
    if (len === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      return { packets, rest: buf.subarray(offset + 4), malformed: false };
    }
    if (len === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (len < 4 || offset + len > buf.length) return { packets, rest: Buffer.alloc(0), malformed: true };
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
    offset += len;
  }
  // No flush found: the whole body is pkt-lines.
  return { packets, rest: Buffer.alloc(0), malformed: offset !== buf.length };
}

/** Wrap payloads in sideband-64k framing (band 1 = data). Each chunk is one pkt-line. */
export function sidebandWrap(band: 1 | 2 | 3, payloads: readonly Buffer[]): Buffer {
  const parts: Buffer[] = [];
  for (const payload of payloads) {
    const framed = Buffer.concat([Buffer.from([band]), payload]);
    parts.push(pktLine(framed));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- packs

const PACK_OBJECT_TYPE: Record<number, GitObjectType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
  6: 'ofs-delta',
  7: 'ref-delta',
};
const PACK_TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Write a pack (version 2, plain objects, SHA-1 trailer) from object oids. */
export function writePack(objects: Map<string, GitObject>, oids: readonly string[]): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(oids.length, 8);
  const parts: Buffer[] = [header];
  for (const oid of oids) {
    const obj = objects.get(oid);
    if (!obj) continue;
    const typeCode = PACK_TYPE_CODE[obj.type];
    const size = obj.data.length;
    // Type/size varint: first byte holds 4 size bits, continuation bytes 7 bits each.
    const bytes: number[] = [];
    let remaining = size;
    let first = (typeCode << 4) | (remaining & 0x0f);
    remaining >>= 4;
    if (remaining > 0) first |= 0x80;
    bytes.push(first);
    while (remaining > 0) {
      let next = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) next |= 0x80;
      bytes.push(next);
    }
    parts.push(Buffer.from(bytes));
    parts.push(zlibDeflate(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** A valid empty pack (PACK v2, 0 objects, SHA-1 trailer). */
export function emptyPack(): Buffer {
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(0, 8);
  const trailer = createHash('sha1').update(header).digest();
  return Buffer.concat([header, trailer]);
}

/** Verify a pack's SHA-1 trailer. */
export function verifyPackChecksum(pack: Buffer): { ok: boolean; expected: string; actual: string } {
  if (pack.length < 32) return { ok: false, expected: '', actual: '' };
  const body = pack.subarray(0, pack.length - 20);
  const expected = createHash('sha1').update(body).digest('hex');
  const actual = pack.subarray(pack.length - 20).toString('hex');
  return { ok: expected === actual, expected, actual };
}

interface PackEntry {
  type: GitObjectType | 'ofs-delta' | 'ref-delta';
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

/**
 * Read a pack into objects, resolving OFS/REF deltas. The client packs this forge receives
 * are plain objects (no deltas); delta support is defensive. Returns oid -> object.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') return out;
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) return out;
  const count = pack.readUInt32BE(8);
  let offset = 12;
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, number>();
  for (let i = 0; i < count; i += 1) {
    const start = offset;
    const first = pack[offset] as number;
    const typeCode = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    offset += 1;
    while ((pack[offset - 1] as number) & 0x80) {
      size |= (pack[offset] as number & 0x7f) << shift;
      shift += 7;
      offset += 1;
    }
    const typeName = PACK_OBJECT_TYPE[typeCode] as PackEntry['type'] | undefined;
    if (typeName === undefined) return out;
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (typeName === 'ofs-delta') {
      let byte = pack[offset] as number;
      offset += 1;
      let value = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset] as number;
        offset += 1;
        value = ((value + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = start - value;
    } else if (typeName === 'ref-delta') {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const consumed = inflatedConsumed(pack, offset);
    const inflated = zlibInflate(pack.subarray(offset, offset + consumed));
    offset += consumed;
    const entry: PackEntry = { type: typeName, data: Buffer.from(inflated) };
    if (baseOffset !== undefined) entry.baseOffset = baseOffset;
    if (baseOid !== undefined) entry.baseOid = baseOid;
    entries.push(entry);
    byOffset.set(start, entries.length - 1);
    void size;
  }
  // Resolve non-delta entries first, then deltas iteratively (a delta's base may itself
  // be a delta, or an object the client already holds — a thin pack).
  const resolved = new Map<number, GitObject>();
  const byOid = new Map<string, GitObject>();
  const resolveOne = (index: number, seen: Set<number>): GitObject | null => {
    const cached = resolved.get(index);
    if (cached) return cached;
    if (seen.has(index)) return null;
    seen.add(index);
    const entry = entries[index] as PackEntry;
    if (entry.type !== 'ofs-delta' && entry.type !== 'ref-delta') {
      const obj: GitObject = { type: entry.type, data: entry.data };
      resolved.set(index, obj);
      byOid.set(hashObject(obj.type, obj.data), obj);
      return obj;
    }
    let base: GitObject | undefined;
    if (entry.type === 'ofs-delta' && entry.baseOffset !== undefined) {
      const baseIndex = byOffset.get(entry.baseOffset);
      if (baseIndex !== undefined) base = resolveOne(baseIndex, seen) ?? undefined;
    } else if (entry.type === 'ref-delta' && entry.baseOid !== undefined) {
      base = byOid.get(entry.baseOid) ?? (resolveBase ? resolveBase(entry.baseOid) : undefined);
    }
    if (!base) return null;
    const data = applyDelta(base.data, entry.data);
    const obj: GitObject = { type: base.type, data };
    resolved.set(index, obj);
    byOid.set(hashObject(obj.type, obj.data), obj);
    return obj;
  };
  for (let i = 0; i < entries.length; i += 1) resolveOne(i, new Set());
  // A second pass catches ref-deltas whose base was a delta resolved later.
  for (let i = 0; i < entries.length; i += 1) resolveOne(i, new Set());
  for (const obj of resolved.values()) out.set(hashObject(obj.type, obj.data), obj);
  return out;
}

/**
 * Bytes the zlib stream starting at `offset` consumes. inflateSync ignores trailing bytes,
 * so the exact end is the smallest slice that inflates — found by binary search.
 */
function inflatedConsumed(pack: Buffer, offset: number): number {
  let low = 1;
  let high = pack.length - offset;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    try {
      zlibInflate(pack.subarray(offset, offset + mid));
      high = mid;
    } catch {
      low = mid + 1;
    }
  }
  return low;
}

/** Apply a git delta to a base buffer. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset] as number;
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  const targetSize = readVarint();
  void sourceSize;
  const parts: Buffer[] = [];
  while (offset < delta.length) {
    const op = delta[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (op & (1 << i)) {
          copyOffset |= (delta[offset] as number) << (i * 8);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (op & (0x10 << i)) {
          copySize |= (delta[offset] as number) << (i * 8);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      parts.push(base.subarray(copyOffset, copyOffset + copySize));
    } else if (op !== 0) {
      parts.push(delta.subarray(offset, offset + op));
      offset += op;
    } else {
      throw new Error('invalid delta opcode 0');
    }
  }
  const out = Buffer.concat(parts);
  if (out.length !== targetSize) throw new Error('delta result size mismatch');
  return out;
}
