// Git objects: SHA-1 content addressing, commit/tree/tag/blob parsing, trees sorted
// git-style (directories compared as name + '/'), packfiles with OFS/REF deltas.
// All objects are plain, un-deltified when we write; we read deltas when a client
// sends them so receive-pack never rejects a valid push.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export const ZERO_OID = '0000000000000000000000000000000000000000';
export const OID_RE = /^[0-9a-f]{40}$/;

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && OID_RE.test(value);
}

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function makeObject(type: ObjectType, data: Buffer): { oid: string; object: GitObject } {
  return { oid: hashObject(type, data), object: { type, data } };
}

// ---------------------------------------------------------------------------
// Commits
// ---------------------------------------------------------------------------

export interface CommitParsed {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  raw: Buffer;
}

export function parseCommit(data: Buffer): CommitParsed {
  const raw = data;
  const text = data.toString('utf8');
  const headerEnd = text.indexOf('\n\n');
  const header = headerEnd >= 0 ? text.slice(0, headerEnd) : text;
  const message = headerEnd >= 0 ? text.slice(headerEnd + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  let lastKey = '';
  for (const line of header.split('\n')) {
    if (line.startsWith(' ')) continue; // continuation of a multi-line header
    const space = line.indexOf(' ');
    if (space < 0) {
      lastKey = line;
      continue;
    }
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    lastKey = key;
    if (key === 'tree') tree = value;
    else if (key === 'parent') parents.push(value);
    else if (key === 'author') author = value;
    else if (key === 'committer') committer = value;
  }
  void lastKey;
  return { tree, parents, author, committer, message, raw };
}

export function buildCommit(tree: string, parents: readonly string[], author: string, committer: string, message: string): Buffer {
  const lines: string[] = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${author}`);
  lines.push(`committer ${committer}`);
  lines.push('');
  return Buffer.concat([Buffer.from(`${lines.join('\n')}\n`, 'utf8'), Buffer.from(message, 'utf8')]);
}

// ---------------------------------------------------------------------------
// Trees
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string; // e.g. '40000' for a directory, '100644' for a file
  name: string;
  oid: string;
}

/** Parse a raw tree buffer into entries in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('corrupt tree: no mode terminator');
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0) throw new Error('corrupt tree: no name terminator');
    const name = data.subarray(space + 1, nul).toString('utf8');
    if (nul + 21 > data.length) throw new Error('corrupt tree: truncated oid');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  // Git sorts trees as if directory names carry a trailing slash.
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Serialise entries in canonical git order. */
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    const head = Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8');
    parts.push(head, Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

export interface TagParsed {
  object: string;
  type: ObjectType;
  tag: string;
  tagger: string;
  message: string;
  raw: Buffer;
}

export function parseTag(data: Buffer): TagParsed {
  const text = data.toString('utf8');
  const headerEnd = text.indexOf('\n\n');
  const header = headerEnd >= 0 ? text.slice(0, headerEnd) : text;
  const message = headerEnd >= 0 ? text.slice(headerEnd + 2) : '';
  let object = '';
  let type: ObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    const space = line.indexOf(' ');
    if (space < 0) continue;
    const key = line.slice(0, space);
    const value = line.slice(space + 1);
    if (key === 'object') object = value;
    else if (key === 'type') type = value as ObjectType;
    else if (key === 'tag') tag = value;
    else if (key === 'tagger') tagger = value;
  }
  return { object, type, tag, tagger, message, raw: data };
}

// ---------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------

const PACK_TYPE_BY_NAME: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_TYPE_BY_NUM: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export interface PackEntry {
  type: ObjectType;
  oid: string;
  data: Buffer;
}

function packVarint(value: number, firstByteSize: number, typeBits: number): Buffer {
  // Encode a varint whose first byte holds `firstByteSize` payload bits and the type.
  const out: number[] = [];
  let remaining = value >>> firstByteSize;
  let first = (value & ((1 << firstByteSize) - 1)) | (typeBits << firstByteSize);
  while (remaining > 0) {
    first |= 0x80;
    out.push(first);
    first = remaining & 0x7f;
    remaining >>>= 7;
  }
  out.push(first);
  return Buffer.from(out);
}

export function writePack(entries: readonly PackEntry[]): Buffer {
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  const parts: Buffer[] = [header];
  for (const entry of entries) {
    const typeNum = PACK_TYPE_BY_NAME[entry.type];
    const sizeHeader = packVarint(entry.data.length, 4, typeNum);
    parts.push(sizeHeader, deflateSync(entry.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

class PackReader {
  private offset = 0;
  private readonly buffer: Buffer;
  private readonly objects: Map<string, GitObject>;

  constructor(buffer: Buffer, objects: Map<string, GitObject>) {
    this.buffer = buffer;
    this.objects = objects;
  }

  private readByte(): number {
    if (this.offset >= this.buffer.length) throw new Error('unexpected end of packfile');
    return this.buffer[this.offset++];
  }

  private readVarint(firstByteSize: number): { value: number; typeNum: number } {
    const first = this.readByte();
    const typeNum = (first >> firstByteSize) & 0x7;
    let value = first & ((1 << firstByteSize) - 1);
    let shift = firstByteSize;
    let byte = first;
    while (byte & 0x80) {
      byte = this.readByte();
      value |= (byte & 0x7f) << shift;
      shift += 7;
    }
    return { value, typeNum };
  }

  private readZlib(size: number): Buffer {
    // inflateSync ignores trailing bytes, so the deflate stream ends at the
    // smallest end that inflates to exactly `size` bytes; a truncated stream throws.
    let lo = this.offset + 1;
    let hi = this.buffer.length;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      try {
        const trial = inflateSync(this.buffer.subarray(this.offset, mid));
        if (trial.length === size) {
          best = mid;
          hi = mid - 1;
        } else if (trial.length < size) {
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      } catch {
        lo = mid + 1;
      }
    }
    if (best < 0) throw new Error('could not locate end of zlib stream in packfile');
    const out = inflateSync(this.buffer.subarray(this.offset, best));
    this.offset = best;
    return out;
  }

  private applyDelta(base: Buffer, delta: Buffer): Buffer {
    let pos = 0;
    const readDeltaVarint = (): number => {
      let result = 0;
      let shift = 0;
      for (;;) {
        if (pos >= delta.length) throw new Error('truncated delta varint');
        const byte = delta[pos++];
        result |= (byte & 0x7f) << shift;
        shift += 7;
        if (!(byte & 0x80)) break;
      }
      return result;
    };
    const baseSize = readDeltaVarint();
    if (baseSize !== base.length) throw new Error(`delta base size ${baseSize} does not match ${base.length}`);
    const resultSize = readDeltaVarint();
    const chunks: Buffer[] = [];
    let written = 0;
    while (pos < delta.length) {
      const op = delta[pos++];
      if (op & 0x80) {
        let offset = 0;
        let size = 0;
        for (let i = 0; i < 4; i++) if (op & (1 << i)) offset |= delta[pos++] << (8 * i);
        for (let i = 0; i < 3; i++) if (op & (0x10 << i)) size |= delta[pos++] << (8 * i);
        if (size === 0) size = 0x10000;
        if (offset + size > base.length) throw new Error('delta copy overruns base');
        chunks.push(base.subarray(offset, offset + size));
        written += size;
      } else if (op !== 0) {
        if (pos + op > delta.length) throw new Error('delta insert overruns delta');
        chunks.push(delta.subarray(pos, pos + op));
        pos += op;
        written += op;
      } else {
        throw new Error('delta opcode 0 is reserved');
      }
    }
    if (written !== resultSize) throw new Error(`delta result size ${written} does not match ${resultSize}`);
    return Buffer.concat(chunks);
  }

  readAll(): PackEntry[] {
    if (this.buffer.length < 12) throw new Error('packfile too short');
    if (this.buffer.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
    const version = this.buffer.readUInt32BE(4);
    if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
    const count = this.buffer.readUInt32BE(8);
    const checksum = this.buffer.subarray(this.buffer.length - 20);
    const body = this.buffer.subarray(0, this.buffer.length - 20);
    const actual = createHash('sha1').update(body).digest();
    if (!actual.equals(checksum)) throw new Error('packfile checksum mismatch');
    this.offset = 12;
    const entries: PackEntry[] = [];
    for (let i = 0; i < count; i++) {
      const startOffset = this.offset;
      const { value: size, typeNum } = this.readVarint(4);
      if (typeNum === 6) {
        // OFS_DELTA: base is `startOffset - encoded offset`, always an earlier
        // entry in this same pack (a pack cannot address stored objects by offset).
        let byte = this.readByte();
        let baseOffset = byte & 0x7f;
        while (byte & 0x80) {
          byte = this.readByte();
          baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
        }
        const baseAbsolute = startOffset - baseOffset;
        const delta = this.readZlib(size);
        const baseEntry = findByOffset(entries, baseAbsolute);
        if (!baseEntry) throw new Error('ofs-delta base not found in pack');
        const data = this.applyDelta(baseEntry.data, delta);
        const oid = hashObject(baseEntry.type, data);
        const entry: PackEntry = { type: baseEntry.type, oid, data };
        (entry as PackEntryWithOffset).offset = startOffset;
        entries.push(entry);
      } else if (typeNum === 7) {
        // REF_DELTA: base is a 20-byte object id.
        if (this.offset + 20 > this.buffer.length) throw new Error('truncated ref-delta base');
        const baseOid = this.buffer.subarray(this.offset, this.offset + 20).toString('hex');
        this.offset += 20;
        const delta = this.readZlib(size);
        const baseEntry = entries.find((e) => e.oid === baseOid) ?? this.objects.get(baseOid);
        if (!baseEntry) throw new Error('ref-delta base not found in pack');
        const data = this.applyDelta(baseEntry.data, delta);
        const oid = hashObject(baseEntry.type, data);
        const entry: PackEntry = { type: baseEntry.type, oid, data };
        (entry as PackEntryWithOffset).offset = startOffset;
        entries.push(entry);
      } else {
        const type = PACK_TYPE_BY_NUM[typeNum];
        if (!type) throw new Error(`unknown pack object type ${typeNum}`);
        const data = this.readZlib(size);
        const oid = hashObject(type, data);
        const entry: PackEntry = { type, oid, data };
        (entry as PackEntryWithOffset).offset = startOffset;
        entries.push(entry);
      }
    }
    return entries;
  }
}

type PackEntryWithOffset = PackEntry & { offset: number };

function findByOffset(entries: readonly PackEntry[], offset: number): PackEntry | undefined {
  return (entries as readonly PackEntryWithOffset[]).find((e) => e.offset === offset);
}

/**
 * Parse a packfile, resolving deltas against objects already in `store` and
 * earlier entries in the same pack. Throws on a bad checksum or corrupt data.
 */
export function readPack(bytes: Buffer, store: Map<string, GitObject>): PackEntry[] {
  return new PackReader(bytes, store).readAll();
}
