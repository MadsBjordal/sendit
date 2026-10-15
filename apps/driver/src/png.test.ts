import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';
import { signaturePng, toBase64 } from './png.ts';

test('produces a valid PNG whose pixels contain the stroke', () => {
  const png = Buffer.from(
    signaturePng(
      [
        [
          { x: 0, y: 50 },
          { x: 100, y: 50 },
        ],
      ],
      100,
      100,
      50,
      20,
    ),
  );
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const idatAt = png.indexOf('IDAT');
  const len = png.readUInt32BE(idatAt - 4);
  const raw = inflateSync(png.subarray(idatAt + 4, idatAt + 4 + len));
  assert.equal(raw.length, (50 + 1) * 20);
  const row10 = raw.subarray(10 * 51 + 1, 11 * 51);
  assert.ok(
    row10.some((v) => v < 128),
    'the line is drawn in the middle row',
  );
  assert.ok(
    raw.subarray(1, 51).every((v) => v === 255),
    'the top row stays white',
  );
});

test('base64 matches Node', () => {
  const b = new Uint8Array([1, 2, 3, 250, 251]);
  assert.equal(toBase64(b), Buffer.from(b).toString('base64'));
});
