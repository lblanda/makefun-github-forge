// Git smart HTTP: info/refs advertisement (v0 and protocol v2), ls-refs, fetch
// (v0 and v2, with shallow/deepen and incremental exclusion), and receive-pack
// with fast-forward checks. Packfiles are plain objects only; deltas are read
// (receive-pack) but never written.

import {
  decodePktLines,
  encodePktLine,
  encodePktLines,
  packetsToLines,
  pktLineDelim,
  pktLineFlush,
  splitAtFlush,
  type GitPacket,
} from './pktline.ts';
import {
  isOid,
  parseCommit,
  parseTag,
  readPack,
  writePack,
  ZERO_OID,
  type GitObject,
  type PackEntry,
} from './gitobj.ts';
import { DEFAULT_BRANCH, type Repo, type Store } from './store.ts';

export const AGENT = 'makefun-github-forge/1.0';

const UPLOAD_CAPS_V0 =
  `symref=HEAD:refs/heads/${DEFAULT_BRANCH} side-band-64k thin-pack ofs-delta shallow multi_ack agent=${AGENT}`;
const RECEIVE_CAPS_V0 =
  `report-status side-band-64k delete-refs symref=HEAD:refs/heads/${DEFAULT_BRANCH} agent=${AGENT}`;

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The commit an annotated tag points at, for `^{}` lines and peel args. */
function peeledTarget(repo: Repo, tagOid: string): string | null {
  const object = repo.objects.get(tagOid);
  if (!object || object.type !== 'tag') return null;
  const target = parseTag(object.data).object;
  const targetObject = repo.objects.get(target);
  if (!targetObject) return null;
  if (targetObject.type === 'commit') return target;
  if (targetObject.type === 'tag') return peeledTarget(repo, target);
  return null;
}

// ---------------------------------------------------------------------------
// Advertisement
// ---------------------------------------------------------------------------

function advertiseV0(repo: Repo, service: 'upload-pack' | 'receive-pack'): Buffer {
  const caps = service === 'upload-pack' ? UPLOAD_CAPS_V0 : RECEIVE_CAPS_V0;
  const refs = sortedRefs(repo);
  const items: Array<string | 'flush'> = [`# service=git-${service}\n`, 'flush'];
  if (refs.length === 0) {
    items.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
  } else {
    const mainTip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
    if (mainTip) items.push(`${mainTip} HEAD\0${caps}\n`);
    for (const { name, oid } of refs) {
      items.push(`${oid} ${name}\n`);
      const peeled = peeledTarget(repo, oid);
      if (peeled) items.push(`${peeled} ${name}^{}\n`);
    }
  }
  items.push('flush');
  return encodePktLines(items);
}

function advertiseV2UploadPack(): Buffer {
  return encodePktLines([
    '# service=git-upload-pack\n',
    'flush',
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow wait-for-done\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
    'flush',
  ]);
}

// ---------------------------------------------------------------------------
// Sideband
// ---------------------------------------------------------------------------

const SIDEBAND_CHUNK = 65515; // 65520 - 4 (pkt header) - 1 (band byte)

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += SIDEBAND_CHUNK) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + SIDEBAND_CHUNK));
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (pack.length === 0) {
    // An empty pack still needs a sideband stream; the client reads zero objects.
  }
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

/** Wrap inner pkt-lines as band-1 sideband data, then the outer flush. */
function sidebandText(lines: readonly string[]): Buffer {
  const parts: Buffer[] = [];
  for (const line of lines) {
    // Report-status lines are newline-terminated: the reader joins the inner
    // payloads and splits on '\n', so a missing newline merges two lines.
    parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), encodePktLine(`${line}\n`)])));
  }
  parts.push(encodePktLine(Buffer.concat([Buffer.from([1]), pktLineFlush()])));
  parts.push(pktLineFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// ls-refs (protocol v2)
// ---------------------------------------------------------------------------

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

function handleLsRefs(repo: Repo, packets: readonly GitPacket[]): Buffer {
  const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !afterDelim) continue;
    const line = packet.payload.toString('utf8').trimEnd();
    if (line === 'peel') args.peel = true;
    else if (line === 'symrefs') args.symrefs = true;
    else if (line === 'unborn') args.unborn = true;
    else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice('ref-prefix '.length));
    else if (line.startsWith('ref-prefix\t')) args.prefixes.push(line.slice('ref-prefix\t'.length));
  }
  const mainTip = repo.refs.get(`refs/heads/${DEFAULT_BRANCH}`);
  const out: string[] = [];
  const matches = (name: string): boolean =>
    args.prefixes.length === 0 || args.prefixes.some((prefix) => name.startsWith(prefix));
  // HEAD is a ref like any other for prefix filtering: it matches a 'HEAD' prefix
  // (which real git sends) but not a 'refs/...' prefix (which the suite sends).
  if (matches('HEAD')) {
    if (mainTip) {
      out.push(args.symrefs ? `${mainTip} HEAD symref-target:refs/heads/${DEFAULT_BRANCH}\n` : `${mainTip} HEAD\n`);
    } else if (args.unborn) {
      out.push(
        args.symrefs
          ? `unborn HEAD symref-target:refs/heads/${DEFAULT_BRANCH}\n`
          : `unborn HEAD\n`,
      );
    }
  }
  for (const { name, oid } of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (args.peel) {
      const peeled = peeledTarget(repo, oid);
      if (peeled) line += ` peeled:${peeled}`;
    }
    out.push(`${line}\n`);
  }
  out.push('flush');
  return encodePktLines(out as Array<string | 'flush'>);
}

// ---------------------------------------------------------------------------
// fetch (protocol v2 and v0)
// ---------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  depth?: number;
  boundaries: string[];
}

function parseFetchV2Args(packets: readonly GitPacket[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], boundaries: [] };
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data' || !afterDelim) continue;
    const line = packet.payload.toString('utf8').trimEnd();
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.boundaries.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(n) && n > 0) args.depth = n;
    }
  }
  return args;
}

function fetchResponseV2(repo: Repo, args: FetchArgs, store: Store): Buffer {
  const { objects, oids, shallow, unshallow } = store.fetchObjects(
    repo,
    args.wants,
    args.haves,
    args.depth,
    args.boundaries,
  );
  const entries: PackEntry[] = oids.map((oid, index) => {
    const object = objects[index] as GitObject;
    return { type: object.type, oid, data: object.data };
  });
  const pack = writePack(entries);
  // Protocol v2 fetch responses are sections named by a header line, each ended
  // by a delim: acknowledgments (only when the client sent haves), shallow-info
  // (only when depth was requested), then the packfile. A bare NAK first is not
  // a section and makes real git fail with "expected 'packfile', received 'NAK'".
  const parts: Buffer[] = [];
  if (args.haves.length > 0) {
    // Acknowledgments: ACK every have the server holds (NAK when it holds none),
    // then `ready` so the client knows the packfile section follows. Without
    // `ready` real git errors "expected no other sections to be sent after no 'ready'".
    parts.push(encodePktLine('acknowledgments\n'));
    let acked = false;
    for (const have of args.haves) {
      if (repo.objects.has(have)) {
        parts.push(encodePktLine(`ACK ${have}\n`));
        acked = true;
      }
    }
    if (!acked) parts.push(encodePktLine('NAK\n'));
    parts.push(encodePktLine('ready\n'), pktLineDelim());
  }
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(encodePktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
    parts.push(pktLineDelim());
  }
  parts.push(encodePktLine('packfile\n'), sidebandPack(pack));
  return Buffer.concat(parts);
}

function parseFetchV0Args(packets: readonly GitPacket[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], boundaries: [] };
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section++;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trimEnd();
    if (section === 0) {
      const firstSpace = line.indexOf(' ');
      const first = firstSpace < 0 ? line : line.slice(0, firstSpace);
      if (isOid(first)) args.wants.push(first);
      else if (line.startsWith('shallow ')) args.boundaries.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) {
        const n = Number.parseInt(line.slice(7).trim(), 10);
        if (Number.isFinite(n) && n > 0) args.depth = n;
      }
    } else if (section === 1) {
      if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    }
  }
  return args;
}

function fetchResponseV0(repo: Repo, args: FetchArgs, store: Store): Buffer {
  const { objects, oids, shallow, unshallow } = store.fetchObjects(
    repo,
    args.wants,
    args.haves,
    args.depth,
    args.boundaries,
  );
  const entries: PackEntry[] = oids.map((oid, index) => {
    const object = objects[index] as GitObject;
    return { type: object.type, oid, data: object.data };
  });
  const pack = writePack(entries);
  const parts: Buffer[] = [];
  if (args.haves.length > 0) parts.push(encodePktLine('NAK\n'));
  for (const oid of shallow) parts.push(encodePktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(encodePktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(pack));
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function parsePushCommands(packets: readonly GitPacket[]): PushCommand[] {
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8');
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    const parts = line.trimEnd().split(' ');
    if (parts.length < 3) continue;
    const [oldOid, newOid, ref] = parts as [string, string, string];
    if (isOid(oldOid) && isOid(newOid)) commands.push({ oldOid, newOid, ref });
  }
  return commands;
}

function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const { packets, rest } = splitAtFlush(body);
  const commands = parsePushCommands(packets);
  let unpackError: string | null = null;
  if (rest.length > 0) {
    try {
      const entries = readPack(rest, repo.objects);
      for (const entry of entries) {
        if (!repo.objects.has(entry.oid)) repo.objects.set(entry.oid, { type: entry.type, data: entry.data });
      }
    } catch (error) {
      unpackError = error instanceof Error ? error.message : 'unpack failed';
    }
  }
  const report: string[] = [unpackError ? `unpack ${unpackError}` : 'unpack ok'];
  for (const command of commands) {
    const result = applyPush(repo, command, unpackError !== null);
    report.push(result);
  }
  return sidebandText(report);
}

function applyPush(repo: Repo, command: PushCommand, unpackFailed: boolean): string {
  const { oldOid, newOid, ref } = command;
  if (unpackFailed) return `ng ${ref} unpack failed`;
  if (!/^refs\/(heads|tags)\/[A-Za-z0-9._\-/]+$/.test(ref)) return `ng ${ref} invalid ref`;
  const current = repo.refs.get(ref);
  if (newOid === ZERO_OID) {
    // Delete.
    if (!current) return `ng ${ref} remote ref does not exist`;
    if (oldOid !== ZERO_OID && oldOid !== current) return `ng ${ref} non-fast-forward`;
    repo.refs.delete(ref);
    return `ok ${ref}`;
  }
  const object = repo.objects.get(newOid);
  if (!object) return `ng ${ref} object not found`;
  const isBranch = ref.startsWith('refs/heads/');
  if (isBranch && object.type !== 'commit') return `ng ${ref} not a commit`;
  if (!isBranch && object.type !== 'commit' && object.type !== 'tag') return `ng ${ref} invalid object type`;
  if (!current) {
    if (oldOid !== ZERO_OID) return `ng ${ref} non-fast-forward`;
    repo.refs.set(ref, newOid);
    return `ok ${ref}`;
  }
  if (oldOid !== current) return `ng ${ref} non-fast-forward`;
  if (isBranch) {
    // Fast-forward: the new tip must have the old tip as an ancestor.
    if (newOid === current) return `ok ${ref}`;
    const ancestors = new Set<string>();
    const stack = [newOid];
    let found = false;
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (oid === current) {
        found = true;
        break;
      }
      if (ancestors.has(oid)) continue;
      ancestors.add(oid);
      const candidate = repo.objects.get(oid);
      if (!candidate || candidate.type !== 'commit') continue;
      for (const parent of parseCommit(candidate.data).parents) stack.push(parent);
    }
    if (!found) return `ng ${ref} non-fast-forward`;
  } else if (newOid !== current) {
    return `ng ${ref} already exists`;
  }
  repo.refs.set(ref, newOid);
  return `ok ${ref}`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export type GitResult =
  | { status: 200; contentType: string; body: Buffer }
  | { status: 404; contentType: string; body: Buffer };

export function handleGit(
  method: string,
  pathname: string,
  searchParams: URLSearchParams,
  headers: Record<string, string | string[] | undefined>,
  body: Buffer,
  store: Store,
): GitResult {
  const match = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(pathname);
  if (!match) return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' })) };
  const owner = decodeURIComponent(match[1] as string);
  const repoName = decodeURIComponent(match[2] as string);
  const rest = match[3] ?? '';
  const repo = store.getRepo(owner, repoName);
  if (!repo || owner !== 'adaiversen') {
    return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' })) };
  }
  if (method === 'GET' && rest === '/info/refs') {
    const service = searchParams.get('service');
    const protocol = typeof headers['git-protocol'] === 'string' ? headers['git-protocol'] : '';
    if (service === 'git-upload-pack') {
      if (protocol === 'version=2') {
        return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertiseV2UploadPack() };
      }
      return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertiseV0(repo, 'upload-pack') };
    }
    if (service === 'git-receive-pack') {
      return { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: advertiseV0(repo, 'receive-pack') };
    }
    return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'service parameter is required' })) };
  }
  if (method === 'POST' && rest === '/git-upload-pack') {
    try {
      const packets = decodePktLines(body);
      const lines = packetsToLines(packets);
      const command = lines[0]?.trimEnd() ?? '';
      if (command === 'command=ls-refs') {
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: handleLsRefs(repo, packets) };
      }
      if (command === 'command=fetch') {
        const args = parseFetchV2Args(packets);
        return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchResponseV2(repo, args, store) };
      }
      // No command line: protocol v0 fetch.
      const args = parseFetchV0Args(packets);
      return { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchResponseV0(repo, args, store) };
    } catch {
      return { status: 400, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'malformed request' })) };
    }
  }
  if (method === 'POST' && rest === '/git-receive-pack') {
    try {
      return { status: 200, contentType: 'application/x-git-receive-pack-result', body: handleReceivePack(repo, body) };
    } catch {
      return { status: 200, contentType: 'application/x-git-receive-pack-result', body: sidebandText(['unpack malformed request']) };
    }
  }
  return { status: 404, contentType: 'application/json', body: Buffer.from(JSON.stringify({ message: 'Not Found' })) };
}
