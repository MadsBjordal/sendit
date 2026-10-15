/**
 * Turns the strokes of a finger-drawn signature into a PNG image, in plain TypeScript (no native
 * module), so it works the same on Android, iOS and web. Grayscale, uncompressed deflate blocks.
 */
export type Stroke = Array<{ x: number; y: number }>;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]!) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function u32(n: number): number[] {
  return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
}

function chunk(type: string, data: Uint8Array): number[] {
  const typeBytes = Array.from(type, (c) => c.charCodeAt(0));
  const body = new Uint8Array([...typeBytes, ...data]);
  return [...u32(data.length), ...body, ...u32(crc32(body))];
}

/** zlib stream with "stored" (uncompressed) blocks */
function zlibStored(raw: Uint8Array): Uint8Array {
  const out: number[] = [0x78, 0x01];
  for (let i = 0; i < raw.length; i += 65535) {
    const block = raw.subarray(i, Math.min(raw.length, i + 65535));
    const last = i + 65535 >= raw.length ? 1 : 0;
    out.push(
      last,
      block.length & 255,
      block.length >>> 8,
      ~block.length & 255,
      (~block.length >>> 8) & 255,
    );
    for (const b of block) out.push(b);
  }
  out.push(...u32(adler32(raw)));
  return new Uint8Array(out);
}

export function encodeGrayPng(width: number, height: number, pixels: Uint8Array): Uint8Array {
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0; // filter: none
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  const header = new Uint8Array([...u32(width), ...u32(height), 8, 0, 0, 0, 0]); // 8-bit grayscale
  return new Uint8Array([
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
    ...chunk('IHDR', header),
    ...chunk('IDAT', zlibStored(raw)),
    ...chunk('IEND', new Uint8Array()),
  ]);
}

/** Draws the strokes (coordinates in the given box) as dark lines on white. */
export function signaturePng(
  strokes: Stroke[],
  boxWidth: number,
  boxHeight: number,
  width = 480,
  height = 180,
): Uint8Array {
  const px = new Uint8Array(width * height).fill(255);
  const sx = width / boxWidth;
  const sy = height / boxHeight;
  const dot = (x: number, y: number) => {
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const X = Math.round(x) + dx;
        const Y = Math.round(y) + dy;
        if (X >= 0 && Y >= 0 && X < width && Y < height) px[Y * width + X] = 20;
      }
  };
  for (const s of strokes) {
    for (let i = 0; i < s.length; i++) {
      const a = s[i]!;
      const b = s[i + 1] ?? a;
      const steps = Math.max(1, Math.ceil(Math.hypot((b.x - a.x) * sx, (b.y - a.y) * sy)));
      for (let k = 0; k <= steps; k++)
        dot((a.x + ((b.x - a.x) * k) / steps) * sx, (a.y + ((b.y - a.y) * k) / steps) * sy);
    }
  }
  return encodeGrayPng(width, height, px);
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
export function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out +=
      B64[(n >> 18) & 63]! +
      B64[(n >> 12) & 63]! +
      (i + 1 < bytes.length ? B64[(n >> 6) & 63]! : '=') +
      (i + 2 < bytes.length ? B64[n & 63]! : '=');
  }
  return out;
}
