// Block maps for the shell's differential update (DESIGN.md 2e), after electron-builder's
// `.blockmap` (app-builder-lib targets/blockmap) and electron-updater's differential download.
//
// A block map cuts a file into content-defined blocks (a block ends where the last 32 bytes hash to
// a boundary value, so inserting or changing bytes moves only the blocks around the change, and
// the cut points of the same bytes line up again afterwards) and lists each block's size and
// SHA-256. The build writes one per update file; the app cuts the file it already has with the
// same function and fetches only the blocks it lacks. Blocks of 8 to 32 KiB, 16 KiB on average,
// are electron-builder's sizes.
//
// File format (big endian): "MBM1", u32 block count, then per block u32 size and the 32 byte
// SHA-256. 36 bytes per block (about 0.2% of the file).
import crypto from "node:crypto";
import fs from "node:fs";

export const BLOCK_MIN = 8192;
export const BLOCK_AVG = 16384;
export const BLOCK_MAX = 32768;
/** A boundary is where these bits of the rolling hash are all zero (14 bits, average block 16 KiB past the minimum). */
const BOUNDARY_MASK = BLOCK_AVG - 1;
/** The rolling hash covers the last 32 bytes (one bit of shift per byte in a 32 bit word). */
const HASH_SPAN = 32;
const MAGIC = Buffer.from("MBM1");

/** 256 fixed 32 bit values, one per byte value (xorshift32 from a constant seed, so build and app agree). */
const GEAR: Uint32Array = (() => {
  const t = new Uint32Array(256);
  let x = 0x6d617275; // "maru"
  for (let i = 0; i < 256; i++) {
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    t[i] = x;
  }
  return t;
})();

export interface BlockMap {
  /** Size of each block; they add up to the file's size. */
  sizes: number[];
  /** Hex SHA-256 of each block. */
  hashes: string[];
}

export class BlockMapError extends Error {}

/** Cuts a stream of bytes into blocks; `onBlock` gets each block's bytes (valid only during the call). */
export class Chunker {
  private buf = Buffer.allocUnsafe(BLOCK_MAX);
  private n = 0;
  private h = 0;
  private onBlock: (block: Buffer) => void;

  constructor(onBlock: (block: Buffer) => void) {
    this.onBlock = onBlock;
  }

  push(data: Uint8Array): void {
    let { n, h } = this;
    const buf = this.buf;
    for (let i = 0; i < data.length; i++) {
      const b = data[i]!;
      buf[n++] = b;
      // The hash is a function of the last 32 bytes, so the bytes before the last 32 of the
      // minimum size need no hashing.
      if (n > BLOCK_MIN - HASH_SPAN) {
        h = (((h << 1) >>> 0) + GEAR[b]!) >>> 0;
        if (n >= BLOCK_MIN && ((h & BOUNDARY_MASK) === 0 || n === BLOCK_MAX)) {
          this.onBlock(buf.subarray(0, n));
          n = 0;
          h = 0;
        }
      }
    }
    this.n = n;
    this.h = h;
  }

  /** The last, shorter block, if any bytes are left. */
  end(): void {
    if (this.n > 0) this.onBlock(this.buf.subarray(0, this.n));
    this.n = 0;
    this.h = 0;
  }
}

const sha256 = (b: Uint8Array) => crypto.createHash("sha256").update(b).digest("hex");

/** Cuts a file and hashes its blocks, reading it in 1 MiB steps. */
export async function blockMapOfFile(file: string): Promise<BlockMap> {
  const map: BlockMap = { sizes: [], hashes: [] };
  const chunker = new Chunker((block) => {
    map.sizes.push(block.length);
    map.hashes.push(sha256(block));
  });
  const fd = await fs.promises.open(file, "r");
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const { bytesRead } = await fd.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      chunker.push(buf.subarray(0, bytesRead));
    }
  } finally {
    await fd.close();
  }
  chunker.end();
  return map;
}

export function encodeBlockMap(map: BlockMap): Buffer {
  const out = Buffer.alloc(8 + map.sizes.length * 36);
  MAGIC.copy(out, 0);
  out.writeUInt32BE(map.sizes.length, 4);
  for (let i = 0; i < map.sizes.length; i++) {
    out.writeUInt32BE(map.sizes[i]!, 8 + i * 36);
    out.write(map.hashes[i]!, 12 + i * 36, 32, "hex");
  }
  return out;
}

/** Reads a block map and checks its shape: the magic, the length, block sizes in range, sizes adding up to `fileSize`. */
export function decodeBlockMap(data: Uint8Array, fileSize: number): BlockMap {
  const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (buf.length < 8 || !buf.subarray(0, 4).equals(MAGIC)) throw new BlockMapError("Not a block map");
  const count = buf.readUInt32BE(4);
  if (buf.length !== 8 + count * 36) throw new BlockMapError("The block map length does not match");
  const map: BlockMap = { sizes: [], hashes: [] };
  let total = 0;
  for (let i = 0; i < count; i++) {
    const size = buf.readUInt32BE(8 + i * 36);
    // Only the last block may be shorter than the minimum.
    if (size === 0 || size > BLOCK_MAX || (size < BLOCK_MIN && i !== count - 1)) throw new BlockMapError(`Block ${i} has an invalid size (${size})`);
    total += size;
    map.sizes.push(size);
    map.hashes.push(buf.subarray(12 + i * 36, 44 + i * 36).toString("hex"));
  }
  if (total !== fileSize) throw new BlockMapError(`The block map sizes add up to ${total}, which differs from the file size (${fileSize})`);
  return map;
}

/** Start offset of each block, and the file's size at the end. */
export function blockOffsets(sizes: number[]): number[] {
  const out = new Array<number>(sizes.length + 1);
  let at = 0;
  for (let i = 0; i < sizes.length; i++) {
    out[i] = at;
    at += sizes[i]!;
  }
  out[sizes.length] = at;
  return out;
}
