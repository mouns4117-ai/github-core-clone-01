// Smart HTTP: git-upload-pack (protocol v2 + v0) and git-receive-pack (v0 only).
// The wire the kit's git client speaks, pkt-line for pkt-line.

import {
  ZERO_OID,
  decodePktLines,
  encodePktLines,
  isAncestor,
  parseCommit,
  parseTree,
  peelToCommit,
  readPack,
  sidebandWrap,
  splitAtFlush,
  verifyPackChecksum,
  writePack,
} from './git.ts';
import { type Repo, type Store } from './store.ts';

export const UPLOAD_PACK = 'git-upload-pack';
export const RECEIVE_PACK = 'git-receive-pack';

const AGENT = 'makefun-forge/1.0.0';

/** Capabilities the v2 upload-pack advertisement carries. */
function v2Capabilities(): string[] {
  return ['version 2', 'ls-refs=unborn', 'fetch=shallow filter', 'object-format=sha1', `agent=${AGENT}`];
}

/** Capabilities the v0 receive-pack advertisement carries. */
function receiveCapabilities(): string {
  return `report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main agent=${AGENT}`;
}

/** Capabilities the v0 upload-pack advertisement carries. */
function uploadV0Capabilities(): string {
  return `symref=HEAD:refs/heads/main side-band-64k ofs-delta agent=${AGENT}`;
}

/** The v0 ref advertisement body for a service. */
export function advertiseV0(repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === RECEIVE_PACK ? receiveCapabilities() : uploadV0Capabilities();
  const lines: Array<string | 'flush'> = [`# service=${service}\n`];
  const refs = repo.refs;
  const mainTip = refs.get('refs/heads/main');
  if (refs.size === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const headOid = mainTip ?? [...refs.values()][0] ?? ZERO_OID;
    lines.push(`${headOid} HEAD\0${caps}\n`);
    const sorted = [...refs.keys()].sort();
    for (const name of sorted) {
      const oid = refs.get(name) as string;
      lines.push(`${oid} ${name}\n`);
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') {
        const peeled = peelToCommit(repo.objects, oid);
        if (peeled) lines.push(`${peeled} ${name}^{}\n`);
      }
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

/** The v2 capability advertisement body for upload-pack. */
export function advertiseV2(): Buffer {
  const lines: Array<string | 'flush'> = ['# service=git-upload-pack\n', ...v2Capabilities().map((cap) => `${cap}\n`)];
  lines.push('flush');
  return encodePktLines(lines);
}

// ---------------------------------------------------------------- fetch computation

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
}

export interface FetchPlan {
  /** The exact object oids to send, sorted. */
  objects: string[];
  /** New shallow boundaries (commits at exactly the deepen depth). */
  shallow: string[];
  /** Client shallow boundaries deepened past. */
  unshallow: string[];
  /** ACK lines for haves that are ancestors of a want. */
  acks: string[];
  /** Whether any have was sent. */
  hadHaves: boolean;
}

/** All objects reachable from a commit's tree (trees + blobs), plus the commit itself. */
function reachableFromCommit(repo: Repo, commitOid: string, out: Set<string>): void {
  out.add(commitOid);
  const obj = repo.objects.get(commitOid);
  if (!obj || obj.type !== 'commit') return;
  const walkTree = (treeOid: string): void => {
    if (out.has(treeOid)) return;
    out.add(treeOid);
    const treeObj = repo.objects.get(treeOid);
    if (!treeObj || treeObj.type !== 'tree') return;
    for (const entry of parseTree(treeObj.data)) {
      if (entry.mode === '40000') walkTree(entry.oid);
      else out.add(entry.oid);
    }
  };
  walkTree(parseCommit(obj.data).tree);
}

/**
 * Plan a v2/v0 fetch: which commits, tags and objects to send, which shallow boundaries
 * move, and which haves to ACK. `repo` is the store's repo; `req` is the client's ask.
 */
export function planFetch(repo: Repo, req: FetchRequest): FetchPlan {
  const haves = new Set(req.haves);
  const clientShallow = new Set(req.shallow);
  const depth = req.depth;

  // Held commits: walk from each have, stopping descent at shallow boundaries.
  const heldCommits = new Set<string>();
  {
    const queue = [...haves];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      heldCommits.add(oid);
      if (clientShallow.has(oid)) continue; // a shallow boundary: its parents are not held
      for (const parent of parseCommit(obj.data).parents) queue.push(parent);
    }
  }

  // Held objects: every held commit plus its tree and blobs.
  const heldObjects = new Set<string>();
  for (const oid of heldCommits) reachableFromCommit(repo, oid, heldObjects);

  // Resolve wants: tags peel to commits (the tag object itself is sent), other objects direct.
  const wantCommits: string[] = [];
  const tags: string[] = [];
  const direct: string[] = [];
  for (const want of req.wants) {
    const obj = repo.objects.get(want);
    if (!obj) continue;
    if (obj.type === 'tag') {
      tags.push(want);
      const peeled = peelToCommit(repo.objects, want);
      if (peeled) wantCommits.push(peeled);
    } else if (obj.type === 'commit') {
      wantCommits.push(want);
    } else {
      direct.push(want);
    }
  }

  const included = new Set<string>();
  const boundary = new Set<string>();
  const unshallow = new Set<string>();
  {
    const queue: Array<{ oid: string; d: number }> = wantCommits.map((oid) => ({ oid, d: 1 }));
    const seen = new Set<string>();
    while (queue.length > 0) {
      const { oid, d } = queue.shift() as { oid: string; d: number };
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      if (heldCommits.has(oid)) {
        if (clientShallow.has(oid) && depth !== null && d < depth) {
          unshallow.add(oid);
          for (const parent of parseCommit(obj.data).parents) queue.push({ oid: parent, d: d + 1 });
        }
        continue;
      }
      if (depth !== null && d > depth) continue;
      included.add(oid);
      if (depth !== null && d === depth) {
        boundary.add(oid);
        continue;
      }
      for (const parent of parseCommit(obj.data).parents) queue.push({ oid: parent, d: d + 1 });
    }
  }

  // Objects to send: included commits + their trees/blobs, tags, direct wants — minus held.
  const toSend = new Set<string>();
  for (const oid of included) reachableFromCommit(repo, oid, toSend);
  for (const oid of tags) toSend.add(oid);
  for (const oid of direct) toSend.add(oid);
  for (const oid of heldObjects) toSend.delete(oid);

  // ACKs: a have is ACKed when it is an ancestor of (or equal to) a want.
  const acks: string[] = [];
  for (const have of haves) {
    if (repo.objects.get(have)?.type !== 'commit') continue;
    for (const want of wantCommits) {
      if (isAncestor(repo.objects, have, want)) {
        acks.push(have);
        break;
      }
    }
  }

  return {
    objects: [...toSend].sort(),
    shallow: [...boundary],
    unshallow: [...unshallow],
    acks,
    hadHaves: haves.size > 0,
  };
}

// ---------------------------------------------------------------- ls-refs

export interface LsRefsRequest {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

/** The v2 ls-refs response body. */
export function lsRefsBody(repo: Repo, req: LsRefsRequest): Buffer {
  const lines: Array<string | 'flush'> = [];
  const keep = (name: string): boolean => req.prefixes.length === 0 || req.prefixes.some((prefix) => name.startsWith(prefix));
  const refs = repo.refs;
  if (refs.size === 0) {
    if (req.unborn && keep('HEAD')) {
      lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    }
  } else {
    const mainTip = refs.get('refs/heads/main');
    if (keep('HEAD') && mainTip) {
      lines.push(`${mainTip} HEAD${req.symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`);
    }
    for (const name of [...refs.keys()].sort()) {
      if (!keep(name)) continue;
      const oid = refs.get(name) as string;
      let line = `${oid} ${name}`;
      if (req.peel) {
        const obj = repo.objects.get(oid);
        if (obj && obj.type === 'tag') {
          const peeled = peelToCommit(repo.objects, oid);
          if (peeled) line += ` peeled:${peeled}`;
        }
      }
      lines.push(`${line}\n`);
    }
  }
  lines.push('flush');
  return encodePktLines(lines);
}

// ---------------------------------------------------------------- v2 fetch response

/** The v2 fetch response: acknowledgments, shallow-info, packfile sections. */
export function fetchV2Body(repo: Repo, req: FetchRequest): Buffer {
  const plan = planFetch(repo, req);
  const parts: Buffer[] = [];
  if (req.haves.length > 0) {
    const lines: Array<string | 'delim'> = ['acknowledgments\n'];
    if (plan.acks.length > 0) {
      for (const ack of plan.acks) lines.push(`ACK ${ack}\n`);
      lines.push('ready\n');
    } else {
      lines.push('NAK\n');
    }
    lines.push('delim');
    parts.push(encodePktLines(lines));
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0 || req.depth !== null) {
    const lines: Array<string | 'delim'> = ['shallow-info\n'];
    for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
    lines.push('delim');
    parts.push(encodePktLines(lines));
  }
  const objects = plan.objects;
  const pack = writePack(repo.objects, objects);
  const packLines: Array<string | Buffer | 'flush'> = ['packfile\n'];
  parts.push(encodePktLines(packLines));
  // The pack as sideband band-1 packets, chunked to stay well under the 65520-byte
  // pkt-line limit.
  const chunks: Buffer[] = [];
  const CHUNK = 60_000;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    chunks.push(pack.subarray(offset, Math.min(pack.length, offset + CHUNK)));
  }
  if (chunks.length === 0) chunks.push(Buffer.alloc(0));
  parts.push(sidebandWrap(1, chunks));
  parts.push(PKT_FLUSH_BUFFER);
  return Buffer.concat(parts);
}

const PKT_FLUSH_BUFFER = Buffer.from('0000', 'ascii');

// ---------------------------------------------------------------- v0 fetch response

/** The v0 fetch response: NAK/ACK lines, then the pack in sideband framing. */
export function fetchV0Body(repo: Repo, req: FetchRequest): Buffer {
  const plan = planFetch(repo, req);
  const parts: Buffer[] = [];
  const lines: Array<string> = [];
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) lines.push(`ACK ${ack}\n`);
  } else {
    lines.push('NAK\n');
  }
  parts.push(encodePktLines(lines));
  const objects = plan.objects;
  const pack = writePack(repo.objects, objects);
  const chunks: Buffer[] = [];
  const CHUNK = 60_000;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    chunks.push(pack.subarray(offset, Math.min(pack.length, offset + CHUNK)));
  }
  if (chunks.length === 0) chunks.push(Buffer.alloc(0));
  parts.push(sidebandWrap(1, chunks));
  parts.push(PKT_FLUSH_BUFFER);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushResult {
  unpackOk: boolean;
  unpackDetail: string;
  results: Array<{ ref: string; ok: boolean; reason: string }>;
}

/**
 * Apply a receive-pack exchange: store the pack's objects, then apply each ref command.
 * A refused ref never moves; the unpack still succeeds.
 */
export function applyPush(repo: Repo, commands: readonly PushCommand[], pack: Buffer | null): PushResult {
  if (pack !== null && pack.length > 0) {
    const checksum = verifyPackChecksum(pack);
    if (!checksum.ok) {
      return {
        unpackOk: false,
        unpackDetail: 'pack checksum mismatch',
        results: commands.map((command) => ({ ref: command.ref, ok: false, reason: 'unpack failed' })),
      };
    }
    const objects = readPack(pack, (oid) => repo.objects.get(oid));
    for (const [oid, obj] of objects) {
      if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
    }
  }
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'no such ref' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    const target = repo.objects.get(command.newOid);
    if (!target || (target.type !== 'commit' && target.type !== 'tag')) {
      results.push({ ref: command.ref, ok: false, reason: 'missing object' });
      continue;
    }
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) {
        results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (command.oldOid !== current) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (command.newOid === current) {
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const newCommit = peelToCommit(repo.objects, command.newOid);
    const oldCommit = peelToCommit(repo.objects, current);
    if (newCommit === null || oldCommit === null || !isAncestor(repo.objects, oldCommit, newCommit)) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  return { unpackOk: true, unpackDetail: 'ok', results };
}

/** The push report: `unpack ok` + per-ref ok/ng lines, in sideband band 1. */
export function pushReportBody(result: PushResult): Buffer {
  const lines: string[] = [`unpack ${result.unpackOk ? 'ok' : result.unpackDetail}\n`];
  for (const entry of result.results) {
    lines.push(entry.ok ? `ok ${entry.ref}\n` : `ng ${entry.ref} ${entry.reason}\n`);
  }
  const report = encodePktLines(lines);
  const parts: Buffer[] = [sidebandWrap(1, [report]), PKT_FLUSH_BUFFER];
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- request parsing

/** Parse a v2 request body (ls-refs / fetch): [command, args...] after the delim. */
export function parseV2Request(
  body: Buffer,
): { command: string; args: string[]; malformed: boolean } {
  const { packets, malformed } = decodePktLines(body);
  if (malformed) return { command: '', args: [], malformed: true };
  const args: string[] = [];
  let command = '';
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    if (!afterDelim) {
      const line = text.replace(/\n$/, '');
      if (line.startsWith('command=')) command = line.slice('command='.length);
      // agent= / object-format= lines before the delim are ignored.
    } else {
      args.push(text.replace(/\n$/, ''));
    }
  }
  return { command, args, malformed: false };
}

/** Parse an ls-refs argument list. */
export function parseLsRefsArgs(args: readonly string[]): LsRefsRequest {
  const req: LsRefsRequest = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  for (const arg of args) {
    if (arg === 'peel') req.peel = true;
    else if (arg === 'symrefs') req.symrefs = true;
    else if (arg === 'unborn') req.unborn = true;
    else if (arg.startsWith('ref-prefix ')) req.prefixes.push(arg.slice('ref-prefix '.length));
  }
  return req;
}

/** Parse a fetch argument list. */
export function parseFetchArgs(args: readonly string[]): FetchRequest {
  const req: FetchRequest = { wants: [], haves: [], shallow: [], depth: null };
  for (const arg of args) {
    if (arg.startsWith('want ')) req.wants.push(arg.slice(5).trim());
    else if (arg.startsWith('have ')) req.haves.push(arg.slice(5).trim());
    else if (arg.startsWith('shallow ')) req.shallow.push(arg.slice(8).trim());
    else if (arg.startsWith('deepen ')) {
      const n = Number(arg.slice(7).trim());
      if (Number.isFinite(n)) req.depth = Math.trunc(n);
    }
    // thin-pack, no-progress, ofs-delta, filter, done, deepen-since, deepen-not:
    // accepted and (where they change nothing here) ignored.
  }
  return req;
}

/** Parse a v0 fetch body: want/have/done/deepen lines, then the pack is not present. */
export function parseV0FetchArgs(body: Buffer): { req: FetchRequest; malformed: boolean } {
  const { packets, malformed } = decodePktLines(body);
  if (malformed) return { req: { wants: [], haves: [], shallow: [], depth: null }, malformed: true };
  const args: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'data') args.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return { req: parseFetchArgs(args), malformed: false };
}

/** Parse a receive-pack body: command lines (first may carry capabilities) + pack. */
export function parsePushBody(body: Buffer): {
  commands: PushCommand[];
  pack: Buffer | null;
  malformed: boolean;
} {
  const { packets, rest, malformed } = splitAtFlush(body);
  if (malformed) return { commands: [], pack: null, malformed: true };
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) text = text.slice(0, nul); // capabilities after NUL on the first line
    const parts = text.split(' ');
    if (parts.length < 3) return { commands: [], pack: null, malformed: true };
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (!/^[0-9a-f]{40}$/.test(oldOid) || !/^[0-9a-f]{40}$/.test(newOid) || !ref.startsWith('refs/')) {
      return { commands: [], pack: null, malformed: true };
    }
    commands.push({ oldOid, newOid, ref });
  }
  const hasUpdate = commands.some((command) => command.newOid !== ZERO_OID);
  return { commands, pack: hasUpdate ? rest : null, malformed: false };
}
