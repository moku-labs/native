import { Buffer } from "node:buffer";
import { crc32, inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

import { placeholderIconPng } from "../../icon";

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const SIZE = 1024;
const BYTES_PER_PIXEL = 4;
const STRIDE = 1 + SIZE * BYTES_PER_PIXEL;
const BRAND_PINK_RGBA = [0xff, 0x2d, 0x78, 0xff];

/** One parsed PNG chunk plus the verdict of its own CRC32. */
interface ParsedChunk {
  type: string;
  data: Buffer;
  crcValid: boolean;
}

/**
 * Walks a PNG byte-for-byte, splitting it into chunks and checking each stored CRC32
 * against a freshly computed one over `type + data`.
 *
 * @param png - The full PNG file, signature included.
 * @returns Every chunk after the signature, in file order.
 * @example
 * ```ts
 * const chunks = parseChunks(Buffer.from(placeholderIconPng()));
 * ```
 */
function parseChunks(png: Buffer): ParsedChunk[] {
  const chunks: ParsedChunk[] = [];
  let offset = SIGNATURE.length;

  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);
    const body = png.subarray(offset + 4, offset + 8 + length);
    chunks.push({
      type,
      data: png.subarray(offset + 8, offset + 8 + length),
      crcValid: crc32(body) === png.readUInt32BE(offset + 8 + length)
    });
    offset += 12 + length;
  }

  return chunks;
}

/**
 * Concatenates and inflates every IDAT chunk into the raw filtered scanlines.
 *
 * @param chunks - Parsed chunks of the PNG.
 * @returns The inflated scanline bytes.
 * @example
 * ```ts
 * const raw = inflateImageData(parseChunks(png));
 * ```
 */
function inflateImageData(chunks: ParsedChunk[]): Buffer {
  return inflateSync(Buffer.concat(chunks.filter(chunk => chunk.type === "IDAT").map(c => c.data)));
}

describe("placeholderIconPng", () => {
  it("starts with the PNG signature", () => {
    expect([...Buffer.from(placeholderIconPng()).subarray(0, 8)]).toEqual(SIGNATURE);
  });

  it("is a chunk stream that ends on IEND, every CRC32 valid", () => {
    const chunks = parseChunks(Buffer.from(placeholderIconPng()));

    expect(chunks.map(chunk => chunk.type)).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(chunks.filter(chunk => !chunk.crcValid)).toEqual([]);
  });

  it("declares a 1024x1024 8-bit RGBA image in IHDR", () => {
    const ihdr = parseChunks(Buffer.from(placeholderIconPng())).find(c => c.type === "IHDR");

    expect(ihdr?.data.length).toBe(13);
    expect(ihdr?.data.readUInt32BE(0)).toBe(SIZE);
    expect(ihdr?.data.readUInt32BE(4)).toBe(SIZE);
    expect(ihdr?.data.readUInt8(8)).toBe(8);
    expect(ihdr?.data.readUInt8(9)).toBe(6);
    expect([...(ihdr?.data.subarray(10, 13) ?? [])]).toEqual([0, 0, 0]);
  });

  it("inflates to 1024 unfiltered scanlines of 1024 RGBA pixels", () => {
    const raw = inflateImageData(parseChunks(Buffer.from(placeholderIconPng())));

    expect(raw.length).toBe(SIZE * STRIDE);
    const filterBytes = new Set(
      Array.from({ length: SIZE }, (_unused, y) => raw.readUInt8(y * STRIDE))
    );
    expect([...filterBytes]).toEqual([0]);
  });

  it("paints every pixel the opaque brand pink", () => {
    const raw = inflateImageData(parseChunks(Buffer.from(placeholderIconPng())));

    expect([...raw.subarray(1, 5)]).toEqual(BRAND_PINK_RGBA);
    expect([...raw.subarray(STRIDE + 1, STRIDE + 5)]).toEqual(BRAND_PINK_RGBA);
    expect([...raw.subarray(raw.length - BYTES_PER_PIXEL)]).toEqual(BRAND_PINK_RGBA);
  });

  it("builds the bytes once and memoizes them", () => {
    expect(placeholderIconPng()).toBe(placeholderIconPng());
  });
});
