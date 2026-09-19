/**
 * @file project plugin — the placeholder app icon, built deterministically in code.
 */
import { Buffer } from "node:buffer";
import { crc32, deflateSync } from "node:zlib";

/** The 8-byte PNG signature every decoder reads before anything else. */
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Edge length of the source image — `tauri icon` expects a 1024x1024 square. */
const SIZE = 1024;

/**
 * The Moku brand pink (`#ff2d78`) as one fully opaque RGBA pixel. RGBA, not a palette:
 * Tauri's icon pipeline decodes the source into RGBA and chokes on indexed colour.
 */
const BRAND_PINK_RGBA = [0xff, 0x2d, 0x78, 0xff];

/** Bytes per scanline: the filter byte, then one RGBA quad per pixel. */
const STRIDE = 1 + SIZE * 4;

/**
 * Wraps chunk data in the PNG chunk envelope: length, type, data, CRC32 over type+data.
 *
 * @param type - The four-character chunk type, e.g. `IHDR`.
 * @param data - The chunk payload, empty for `IEND`.
 * @returns The framed chunk, ready to concatenate into the file.
 * @example
 * ```ts
 * const end = pngChunk("IEND", Buffer.alloc(0));
 * ```
 */
function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);

  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const checksum = Buffer.alloc(4);
  // node:zlib.crc32 landed in Node 22.2; this package requires Node >= 24.
  checksum.writeUInt32BE(crc32(body));

  return Buffer.concat([length, body, checksum]);
}

/**
 * Builds the 13-byte IHDR payload: 1024x1024, bit depth 8, colour type 6 (RGBA),
 * deflate compression, adaptive filtering, no interlacing.
 *
 * @returns The IHDR chunk data.
 * @example
 * ```ts
 * const header = pngChunk("IHDR", ihdrData());
 * ```
 */
function ihdrData(): Buffer {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(SIZE, 0);
  data.writeUInt32BE(SIZE, 4);
  data.writeUInt8(8, 8);
  data.writeUInt8(6, 9);
  // Bytes 10-12 stay zero: compression 0, filter method 0, interlace 0.
  return data;
}

/**
 * Lays out the raw image data — 1024 scanlines, each a `0x00` ("None") filter byte
 * followed by 1024 solid brand-pink RGBA pixels.
 *
 * @returns The unfiltered scanline bytes, `1024 * (1 + 4096)` long.
 * @example
 * ```ts
 * const idat = pngChunk("IDAT", deflateSync(solidScanlines()));
 * ```
 */
function solidScanlines(): Buffer {
  const pixels = Buffer.alloc(SIZE * 4);
  for (let x = 0; x < SIZE; x += 1) {
    pixels.set(BRAND_PINK_RGBA, x * 4);
  }

  const raw = Buffer.alloc(SIZE * STRIDE);
  for (let y = 0; y < SIZE; y += 1) {
    // raw[y * STRIDE] is the filter byte and stays 0.
    pixels.copy(raw, y * STRIDE + 1);
  }

  return raw;
}

/**
 * Assembles the whole file: signature, IHDR, one deflated IDAT, IEND.
 *
 * @returns The placeholder icon's PNG bytes.
 * @example
 * ```ts
 * const png = buildPlaceholderIconPng();
 * ```
 */
function buildPlaceholderIconPng(): Uint8Array {
  return Buffer.concat([
    SIGNATURE,
    pngChunk("IHDR", ihdrData()),
    pngChunk("IDAT", deflateSync(solidScanlines(), { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0))
  ]);
}

/** Built on first use, then reused — the image never varies. */
let memoized: Uint8Array | undefined;

/**
 * The placeholder icon `ensureIconSource` writes to `<projectDir>/placeholder-icon.png`.
 *
 * `tauri build` refuses to bundle without an icon set, so an app that has not drawn one
 * yet still needs SOME valid square PNG to feed `tauri icon` — this is it.
 *
 * @returns The PNG bytes: the same memoized, read-only buffer on every call.
 * @example
 * ```ts
 * await writeIfChanged(iconPath, placeholderIconPng(), projectDir);
 * ```
 */
export function placeholderIconPng(): Uint8Array {
  memoized ??= buildPlaceholderIconPng();
  return memoized;
}
