// githttp.ts — git smart HTTP: upload-pack protocol v2 (and the v0 fallback the
// suite uses when it asks for it) and receive-pack v0. Packfiles are built and
// read here from scratch; no git binary is ever involved.
import {
  ObjectStore,
  ZERO_OID,
  decodePktLines,
  isOid,
  parseCommit,
  parseTree,
  pktDelim,
  pktFlush,
  pktLine,
  readPack,
  reachable,
  writePack,
  isAncestor,
  type GitObject,
} from './gitcore.ts';
import type { Repo } from './store.ts';

export const AGENT = 'github-core-forge/1.0.0';

export interface GitHttpResult {
  status: number;
  contentType: string;
  body: Buffer;
}

const ok = (contentType: string, body: Buffer): GitHttpResult => ({ status: 200, contentType, body });
const notFound = (): GitHttpResult => ({
  status: 404,
  contentType: 'application/json; charset=utf-8',
  body: Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8'),
});

interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

/** All refs of a repo, HEAD first, then heads, then tags. */
function listRefs(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const tip = repo.refs.get(defaultRef);
  if (tip) lines.push({ oid: tip, name: 'HEAD', symrefTarget: defaultRef });
  else lines.push({ oid: ZERO_OID, name: 'HEAD', symrefTarget: defaultRef, unborn: true });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const line: RefLine = { oid, name };
    const object = repo.objects.get(oid);
    if (object && object.type === 'tag') {
      const target = object.data
        .toString('utf8')
        .split('\n')
        .find((entry) => entry.startsWith('object '))
        ?.slice(7)
        .trim();
      if (target) line.peeled = target;
    }
    lines.push(line);
  }
  return lines;
}

function v0Capabilities(service: 'upload' | 'receive'): string {
  if (service === 'upload') {
    return `multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress include-tag multi_ack_detailed symref=HEAD:refs/heads/main agent=${AGENT}`;
  }
  return `report-status side-band-64k delete-refs ofs-delta quiet agent=${AGENT}`;
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function infoRefs(repo: Repo | undefined, service: 'git-upload-pack' | 'git-receive-pack', gitProtocolV2: boolean): GitHttpResult {
  if (!repo) return notFound();
  const refs = listRefs(repo);
  if (service === 'git-upload-pack' && gitProtocolV2) {
    const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), pktFlush()];
    parts.push(pktLine('version 2\n'));
    parts.push(pktLine('ls-refs=unborn\n'));
    parts.push(pktLine('fetch=shallow filter\n'));
    parts.push(pktLine('object-format=sha1\n'));
    parts.push(pktLine(`agent=${AGENT}\n`));
    parts.push(pktFlush());
    return ok('application/x-git-upload-pack-advertisement', Buffer.concat(parts));
  }
  const contentType = service === 'git-upload-pack'
    ? 'application/x-git-upload-pack-advertisement'
    : 'application/x-git-receive-pack-advertisement';
  const serviceLine = service === 'git-upload-pack' ? '# service=git-upload-pack\n' : '# service=git-receive-pack\n';
  const caps = v0Capabilities(service === 'git-upload-pack' ? 'upload' : 'receive');
  const parts: Buffer[] = [pktLine(serviceLine), pktFlush()];
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      let line = `${ref.oid} ${ref.name}`;
      if (index === 0) line += `\0${caps}`;
      line += '\n';
      parts.push(pktLine(line));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(pktFlush());
  return ok(contentType, Buffer.concat(parts));
}

// ------------------------------------------------------------------ upload-pack

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  filter: string | null;
}

function sidebandPack(pack: Buffer): Buffer {
  const chunks: Buffer[] = [];
  const MAX = 65500;
  for (let i = 0; i < pack.length; i += MAX) {
    const slice = pack.subarray(i, Math.min(pack.length, i + MAX));
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  if (pack.length === 0) {
    // An empty pack still travels as one band-1 packet so the client sees a packfile section.
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), writePack([])])));
  }
  return Buffer.concat(chunks);
}

function objectsForFetch(repo: Repo, args: FetchArgs): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const wanted = args.wants.filter((oid) => oid !== ZERO_OID);
  const stopAt = new Set(args.shallow);
  const reach = reachable(repo.objects, wanted, { depth: args.depth ?? undefined, stopAt });
  const haveReach = args.haves.length > 0 ? reachable(repo.objects, args.haves).objects : new Set<string>();
  const send: GitObject[] = [];
  for (const sha of reach.objects) {
    if (haveReach.has(sha)) continue;
    const object = repo.objects.get(sha);
    if (object) send.push(object);
  }
  const unshallow = args.shallow.filter((sha) => reach.includedCommits.has(sha) && !reach.shallow.includes(sha));
  return { objects: send, shallow: reach.shallow, unshallow };
}

function fetchV2(repo: Repo, body: Buffer): GitHttpResult {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return ok('application/x-git-upload-pack-result', pktFlush());
  }
  const lines: string[] = [];
  let command = '';
  let inArgs = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      inArgs = true;
      continue;
    }
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8');
    if (!inArgs && text.startsWith('command=')) command = text.slice(8).trim();
    else if (inArgs) lines.push(text.trim());
  }

  if (command === 'ls-refs') {
    const refs = listRefs(repo);
    const peel = lines.includes('peel');
    const symrefs = lines.includes('symrefs');
    const unborn = lines.includes('unborn');
    const prefixes = lines.filter((line) => line.startsWith('ref-prefix ')).map((line) => line.slice('ref-prefix '.length));
    const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
    const parts: Buffer[] = [];
    for (const ref of refs) {
      if (!keep(ref.name)) continue;
      if (ref.unborn) {
        if (!unborn) continue;
        let line = `unborn ${ref.name}`;
        if (symrefs && ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
        parts.push(pktLine(`${line}\n`));
        continue;
      }
      let line = `${ref.oid} ${ref.name}`;
      if (symrefs && ref.symrefTarget) line += ` symref-target:${ref.symrefTarget}`;
      if (peel && ref.peeled) line += ` peeled:${ref.peeled}`;
      parts.push(pktLine(`${line}\n`));
    }
    parts.push(pktFlush());
    return ok('application/x-git-upload-pack-result', Buffer.concat(parts));
  }

  if (command === 'fetch') {
    const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, filter: null };
    for (const line of lines) {
      if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) args.depth = Number.parseInt(line.slice(7).trim(), 10);
      else if (line.startsWith('filter ')) args.filter = line.slice(7).trim();
    }
    const { objects, shallow, unshallow } = objectsForFetch(repo, args);
    const pack = writePack(objects);
    const parts: Buffer[] = [];
    // The acknowledgments section is only sent when the client offered haves:
    // a client that sent none (a fresh clone) expects the packfile section next.
    if (args.haves.length > 0) {
      parts.push(pktLine('acknowledgments\n'));
      const knownHave = args.haves.find((have) => repo.objects.has(have));
      if (knownHave) {
        parts.push(pktLine(`ACK ${knownHave}\n`));
        parts.push(pktLine('ready\n'));
      } else {
        parts.push(pktLine('NAK\n'));
      }
      parts.push(pktDelim());
    }
    if (shallow.length > 0 || unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const sha of shallow) parts.push(pktLine(`shallow ${sha}\n`));
      for (const sha of unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
      parts.push(pktDelim());
    }
    parts.push(pktLine('packfile\n'));
    parts.push(sidebandPack(pack));
    parts.push(pktFlush());
    return ok('application/x-git-upload-pack-result', Buffer.concat(parts));
  }

  return ok('application/x-git-upload-pack-result', pktFlush());
}

function fetchV0(repo: Repo, body: Buffer): GitHttpResult {
  let packets;
  try {
    packets = decodePktLines(body);
  } catch {
    return ok('application/x-git-upload-pack-result', pktFlush());
  }
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, filter: null };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').trim();
    if (text.startsWith('want ')) {
      const rest = text.slice(5).trim();
      args.wants.push(rest.split(' ')[0]);
    } else if (text.startsWith('have ')) args.haves.push(text.slice(5).trim());
    else if (text.startsWith('shallow ')) args.shallow.push(text.slice(8).trim());
    else if (text.startsWith('deepen ')) args.depth = Number.parseInt(text.slice(7).trim(), 10);
  }
  void section;
  const { objects, shallow, unshallow } = objectsForFetch(repo, args);
  const pack = writePack(objects);
  const parts: Buffer[] = [];
  const knownHave = args.haves.find((have) => repo.objects.has(have));
  if (args.haves.length > 0 && knownHave) {
    parts.push(pktLine(`ACK ${knownHave}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const sha of shallow) parts.push(pktLine(`shallow ${sha}\n`));
  for (const sha of unshallow) parts.push(pktLine(`unshallow ${sha}\n`));
  parts.push(sidebandPack(pack));
  parts.push(pktFlush());
  return ok('application/x-git-upload-pack-result', Buffer.concat(parts));
}

/** POST /{owner}/{repo}.git/git-upload-pack */
export function uploadPack(repo: Repo | undefined, gitProtocolV2: boolean, body: Buffer): GitHttpResult {
  if (!repo) return notFound();
  try {
    return gitProtocolV2 ? fetchV2(repo, body) : fetchV0(repo, body);
  } catch {
    return ok('application/x-git-upload-pack-result', pktFlush());
  }
}

// ------------------------------------------------------------------ receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export function receivePack(repo: Repo | undefined, body: Buffer): GitHttpResult {
  if (!repo) return notFound();
  const report = (unpackOk: boolean, unpackDetail: string, refs: Array<{ ref: string; ok: boolean; reason: string }>): GitHttpResult => {
    const inner: Buffer[] = [pktLine(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`)];
    for (const entry of refs) {
      inner.push(pktLine(entry.ok ? `ok ${entry.ref}\n` : `ng ${entry.ref} ${entry.reason}\n`));
    }
    inner.push(pktFlush());
    const innerBytes = Buffer.concat(inner);
    const outer: Buffer[] = [];
    const MAX = 65500;
    for (let i = 0; i < innerBytes.length; i += MAX) {
      outer.push(pktLine(Buffer.concat([Buffer.from([1]), innerBytes.subarray(i, Math.min(innerBytes.length, i + MAX))])));
    }
    outer.push(pktFlush());
    return ok('application/x-git-receive-pack-result', Buffer.concat(outer));
  };

  // Parse pkt-lines incrementally until the flush packet; everything after it is the packfile.
  let commands: PushCommand[] = [];
  let packStart = 0;
  try {
    let offset = 0;
    let sawFlush = false;
    while (offset + 4 <= body.length) {
      const len = parseInt(body.subarray(offset, offset + 4).toString('ascii'), 16);
      if (Number.isNaN(len)) throw new Error('malformed pkt-line length');
      if (len === 0) {
        sawFlush = true;
        offset += 4;
        break;
      }
      if (len < 4 || offset + len > body.length) throw new Error('truncated pkt-line');
      const payload = body.subarray(offset + 4, offset + len);
      const text = payload.toString('utf8');
      const nul = text.indexOf('\0');
      const main = (nul >= 0 ? text.slice(0, nul) : text).trim();
      const parts = main.split(' ');
      if (parts.length >= 3 && isOid(parts[0]) && isOid(parts[1])) {
        commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts[2] });
      }
      offset += len;
    }
    if (!sawFlush) return report(false, 'error: malformed command list', []);
    packStart = offset;
  } catch {
    return report(false, 'error: malformed command list', []);
  }

  const packBytes = body.subarray(packStart);
  const needsPack = commands.some((command) => command.newOid !== ZERO_OID);
  if (needsPack && packBytes.length > 0) {
    try {
      const parsed = readPack(packBytes);
      for (const [sha, object] of parsed.objects) {
        if (!repo.objects.has(sha)) repo.objects.objects.set(sha, object);
      }
    } catch (error) {
      return report(false, `error: ${error instanceof Error ? error.message : 'unpack failed'}`, commands.map((command) => ({ ref: command.ref, ok: false, reason: 'unpacker error' })));
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (command.oldOid !== ZERO_OID && current !== command.oldOid) {
        results.push({ ref: command.ref, ok: false, reason: 'old ref value does not match' });
        continue;
      }
      if (current === undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'remote ref does not exist' });
        continue;
      }
      repo.refs.delete(command.ref);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    const newObject = repo.objects.get(command.newOid);
    if (!newObject) {
      results.push({ ref: command.ref, ok: false, reason: 'unpacker error: object not found' });
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      // Create.
      if (current !== undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'already exists' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (current !== command.oldOid) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (!isAncestor(repo.objects, command.oldOid, command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }
  return report(true, 'ok', results);
}

export { ObjectStore };
export type { GitObject };
export { parseTree };
