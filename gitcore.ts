// gitcore.ts — git object model, packfiles and pkt-lines, implemented from scratch
// on the Node standard library only (node:crypto, node:zlib). No git binary, no network.
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

/** SHA-1 of a git object header + body, exactly as git computes it. */
export function objectId(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function isOid(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** In-memory object store: raw bytes are kept verbatim so pushed objects round-trip byte-exactly. */
export class ObjectStore {
  readonly objects = new Map<string, GitObject>();

  put(type: ObjectType, data: Buffer): string {
    const sha = objectId(type, data);
    this.objects.set(sha, { type, data });
    return sha;
  }

  putRaw(type: ObjectType, data: Buffer): string {
    const sha = objectId(type, data);
    if (!this.objects.has(sha)) this.objects.set(sha, { type, data });
    return sha;
  }

  get(sha: string): GitObject | undefined {
    return this.objects.get(sha);
  }

  has(sha: string): boolean {
    return this.objects.has(sha);
  }
}

// ---------------------------------------------------------------------------------- pkt-line

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
export const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');

/** Split a buffer into pkt-line packets: {kind:'data', payload} | {kind:'flush'|'delim'|'response-end'}. */
export type Pkt =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

export function decodePktLines(buf: Buffer): Pkt[] {
  const out: Pkt[] = [];
  let i = 0;
  while (i < buf.length) {
    if (i + 4 > buf.length) throw new Error('truncated pkt-line length');
    const len = parseInt(buf.subarray(i, i + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error('malformed pkt-line length');
    if (len === 0) {
      out.push({ kind: 'flush' });
      i += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim' });
      i += 4;
    } else if (len === 2) {
      out.push({ kind: 'response-end' });
      i += 4;
    } else {
      if (i + len > buf.length) throw new Error('truncated pkt-line payload');
      out.push({ kind: 'data', payload: buf.subarray(i + 4, i + len) });
      i += len;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------- packfile

const TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function packObjectHeader(type: ObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let remaining = size;
  let first = (TYPE_CODE[type] << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a pack v2 with whole objects only (no deltas): simple, always valid. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    parts.push(packObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

function readVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let value = buf[offset] & 0x7f;
  let shift = 7;
  let i = offset + 1;
  while (buf[offset] & 0x80) {
    value |= (buf[i] & 0x7f) << shift;
    shift += 7;
    i += 1;
  }
  return { value, next: i };
}

/** Apply a git delta to a base object, per the delta instruction format. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const readDeltaSize = (): number => {
    let size = 0;
    let shift = 0;
    while (true) {
      const byte = delta[pos++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return size;
  };
  const sourceSize = readDeltaSize();
  const targetSize = readDeltaSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const op = delta[pos++];
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset = delta[pos++];
      if (op & 0x02) offset |= delta[pos++] << 8;
      if (op & 0x04) offset |= delta[pos++] << 16;
      if (op & 0x08) offset |= delta[pos++] << 24;
      if (op & 0x10) size = delta[pos++];
      if (op & 0x20) size |= delta[pos++] << 8;
      if (op & 0x40) size |= delta[pos++] << 16;
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op !== 0) {
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

export interface ParsedPack {
  objects: Map<string, GitObject>;
}

/** Parse a pack v2/v3, resolving OFS_DELTA and REF_DELTA entries. */
export function readPack(buf: Buffer): ParsedPack {
  if (buf.length < 32 || buf.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const version = buf.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = buf.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, string>();
  let pos = 12;
  const pending: Array<{ offset: number; type: ObjectType; data: Buffer }> = [];
  for (let n = 0; n < count; n += 1) {
    const start = pos;
    const first = buf[pos++];
    const typeCode = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    let cont = first & 0x80;
    while (cont !== 0) {
      const byte = buf[pos++];
      size |= (byte & 0x7f) << shift;
      shift += 7;
      cont = byte & 0x80;
    }
    if (typeCode === 6) {
      // OFS_DELTA: negative offset varint.
      let byte = buf[pos++];
      let offset = byte & 0x7f;
      while (byte & 0x80) {
        byte = buf[pos++];
        offset = ((offset + 1) << 7) | (byte & 0x7f);
      }
      const baseOffset = start - offset;
      const baseSha = byOffset.get(baseOffset);
      if (baseSha === undefined) throw new Error('ofs-delta base offset unknown');
      const base = objects.get(baseSha);
      if (!base) throw new Error('ofs-delta base object missing');
      const inflated = inflateSync(buf.subarray(pos));
      pos += inflatedConsumed(buf, pos);
      const data = applyDelta(base.data, inflated);
      const sha = objectId(base.type, data);
      objects.set(sha, { type: base.type, data });
      byOffset.set(start, sha);
      pending.push({ offset: start, type: base.type, data });
    } else if (typeCode === 7) {
      // REF_DELTA: 20-byte base sha.
      const baseSha = buf.subarray(pos, pos + 20).toString('hex');
      pos += 20;
      const base = objects.get(baseSha);
      if (!base) throw new Error('ref-delta base object missing');
      const inflated = inflateSync(buf.subarray(pos));
      pos += inflatedConsumed(buf, pos);
      const data = applyDelta(base.data, inflated);
      const sha = objectId(base.type, data);
      objects.set(sha, { type: base.type, data });
      byOffset.set(start, sha);
      pending.push({ offset: start, type: base.type, data });
    } else {
      const type = CODE_TYPE[typeCode];
      if (!type) throw new Error(`unknown pack object type ${typeCode}`);
      const inflated = inflateSync(buf.subarray(pos));
      pos += inflatedConsumed(buf, pos);
      if (inflated.length !== size) throw new Error('pack object size mismatch');
      const sha = objectId(type, inflated);
      objects.set(sha, { type, data: inflated });
      byOffset.set(start, sha);
    }
  }
  void pending;
  return { objects };
}

/** How many bytes a zlib stream starting at `pos` consumes (inflateSync needs the exact slice). */
function inflatedConsumed(buf: Buffer, pos: number): number {
  // Walk the zlib stream with a streaming inflater would be ideal; instead binary-search the
  // smallest prefix that inflates cleanly. Pack entries are small, so this is cheap enough.
  let lo = 1;
  let hi = buf.length - pos;
  // Fast path: most streams end well before the buffer end; probe exponentially.
  let probe = 16;
  while (probe < hi) {
    try {
      inflateSync(buf.subarray(pos, pos + probe));
      hi = probe;
      break;
    } catch {
      probe *= 2;
    }
  }
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    try {
      inflateSync(buf.subarray(pos, pos + mid));
      hi = mid;
    } catch {
      lo = mid + 1;
    }
  }
  return lo;
}

// ---------------------------------------------------------------------------------- commits & trees

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2).replace(/\n+$/, '');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const space = data.indexOf(0x20, i);
    const nul = data.indexOf(0x00, space);
    const mode = data.subarray(i, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const sha = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, sha });
    i = nul + 21;
  }
  return entries;
}

/** git's tree sort: directories compare as if their name had a trailing slash. */
export function treeCompare(a: TreeEntry, b: TreeEntry): number {
  const an = a.mode === '40000' ? `${a.name}/` : a.name;
  const bn = b.mode === '40000' ? `${b.name}/` : b.name;
  return an < bn ? -1 : an > bn ? 1 : 0;
}

export function buildTree(store: ObjectStore, entries: TreeEntry[]): string {
  const sorted = [...entries].sort(treeCompare);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.sha, 'hex'));
  }
  return store.put('tree', Buffer.concat(parts));
}

/** Flatten a tree into path -> {mode, sha} (files only). */
export function flattenTree(store: ObjectStore, treeSha: string, prefix = '', out = new Map<string, { mode: string; sha: string }>()): Map<string, { mode: string; sha: string }> {
  const tree = store.get(treeSha);
  if (!tree || tree.type !== 'tree') return out;
  for (const entry of parseTree(tree.data)) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.mode === '40000') flattenTree(store, entry.sha, path, out);
    else out.set(path, { mode: entry.mode, sha: entry.sha });
  }
  return out;
}

/** Build nested tree objects from a flat path map; returns the root tree sha. */
export function buildTreeFromFlat(store: ObjectStore, flat: Map<string, { mode: string; sha: string }>): string {
  interface Node {
    files: Map<string, { mode: string; sha: string }>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, value] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = node.dirs.get(parts[i]);
      if (!next) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1], value);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, value] of node.files) entries.push({ mode: value.mode, name, sha: value.sha });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, sha: build(child) });
    return buildTree(store, entries);
  };
  return build(root);
}

/** All objects reachable from `tips` (commits, tags, trees, blobs), optionally depth-limited. */
export function reachable(
  store: ObjectStore,
  tips: readonly string[],
  options: { depth?: number; stopAt?: ReadonlySet<string> } = {},
): { objects: Set<string>; shallow: string[]; includedCommits: Set<string> } {
  const objects = new Set<string>();
  const includedCommits = new Set<string>();
  const visitObject = (sha: string): void => {
    if (objects.has(sha)) return;
    const object = store.get(sha);
    if (!object) return;
    objects.add(sha);
    if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) visitObject(entry.sha);
    } else if (object.type === 'tag') {
      const target = object.data.toString('utf8').split('\n').find((line) => line.startsWith('object '))?.slice(7).trim();
      if (target) visitObject(target);
    }
  };
  // BFS over commits by generation. A depth limit includes generations 0..depth-1; the
  // generation at depth is the shallow boundary (listed, not sent). Without a depth, an
  // existing shallow boundary stops traversal (its parents stay with the client).
  const queue: Array<{ sha: string; gen: number }> = [];
  const seenCommit = new Set<string>();
  for (const tip of tips) {
    const object = store.get(tip);
    if (!object) continue;
    if (object.type === 'commit') queue.push({ sha: tip, gen: 0 });
    else visitObject(tip);
  }
  while (queue.length > 0) {
    const { sha, gen } = queue.shift()!;
    if (seenCommit.has(sha)) continue;
    seenCommit.add(sha);
    if (options.depth !== undefined && gen >= options.depth) continue;
    const object = store.get(sha);
    if (!object || object.type !== 'commit') continue;
    const info = parseCommit(object.data);
    includedCommits.add(sha);
    objects.add(sha);
    visitObject(info.tree);
    const stopped = options.depth === undefined && (options.stopAt?.has(sha) ?? false);
    if (stopped) continue;
    for (const parent of info.parents) {
      if (!seenCommit.has(parent)) queue.push({ sha: parent, gen: gen + 1 });
    }
  }
  // The shallow boundary: included commits with a parent that was not included.
  const shallow: string[] = [];
  for (const sha of includedCommits) {
    const object = store.get(sha);
    if (!object || object.type !== 'commit') continue;
    const parents = parseCommit(object.data).parents;
    if (parents.some((parent) => !includedCommits.has(parent) && store.has(parent))) shallow.push(sha);
  }
  return { objects, shallow, includedCommits };
}

/** Is `ancestor` an ancestor of (or equal to) `descendant`? */
export function isAncestor(store: ObjectStore, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue = [descendant];
  while (queue.length > 0) {
    const sha = queue.shift()!;
    if (seen.has(sha)) continue;
    seen.add(sha);
    const object = store.get(sha);
    if (!object || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      queue.push(parent);
    }
  }
  return false;
}

/** First common ancestor of a and b (BFS from both sides), or null. */
export function mergeBase(store: ObjectStore, a: string, b: string): string | null {
  const ancestorsA = new Set<string>();
  const queueA = [a];
  while (queueA.length > 0) {
    const sha = queueA.shift()!;
    if (ancestorsA.has(sha)) continue;
    ancestorsA.add(sha);
    const object = store.get(sha);
    if (!object || object.type !== 'commit') continue;
    queueA.push(...parseCommit(object.data).parents);
  }
  const queueB = [b];
  const seenB = new Set<string>();
  while (queueB.length > 0) {
    const sha = queueB.shift()!;
    if (seenB.has(sha)) continue;
    seenB.add(sha);
    if (ancestorsA.has(sha)) return sha;
    const object = store.get(sha);
    if (!object || object.type !== 'commit') continue;
    queueB.push(...parseCommit(object.data).parents);
  }
  return null;
}

/** A fresh request id (a deterministic counter; never random, never a clock). */
let requestCounter = 0;
export function nextRequestId(): string {
  requestCounter += 1;
  return `forge-req-${requestCounter}`;
}
