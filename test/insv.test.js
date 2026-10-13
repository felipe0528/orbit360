import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readInsvMetadata, normalizeCalibration } from '../src/insv.js';

// Synthetic geometry, not calibration from a user's camera. The intentional X4-like
// rectangular sensor catches the incorrect "scale by sensor width" shortcut.
const sensor = { width: 8000, height: 6000 };
const dimension = { width: 3840, height: 3840 };
const crop = { sourceWidth: 8000, sourceHeight: 6000, width: 5600, height: 5600 };
const calibration = [2,
  2, 4600, 4620, 4014, 3028, 0, 0, 90, 0, 0, 0, 0.3, 1.2, -3, 0.001, 0.002, 16000, 6000, 71,
  2, 4600, 4620, 12014, 3028, 0, 0, 90, 0, 0, -0.03, 0.3, 1.2, -3, 0.001, 0.002, 16000, 6000, 71,
  3 * 65536 + 4 * 256].join('_');
const legacy = [2, 2900, 4000, 3000, 0, 0, 90, 2900, 12000, 3000, 0, 0, 90, 16000, 6000, 4 * 256 + 71].join('_');

function v(value) {
  let n = BigInt(value);
  const bytes = [];
  do { const byte = Number(n & 127n); n >>= 7n; bytes.push(byte | (n ? 128 : 0)); } while (n);
  return Buffer.from(bytes);
}
function n(id, value) { return Buffer.concat([v(id * 8), v(value)]); }
function bytes(id, value) { const data = Buffer.from(value); return Buffer.concat([v(id * 8 + 2), v(data.length), data]); }
function descriptor(id, size, format = 1) { const b = Buffer.alloc(6); b[0] = format; b[1] = id; b.writeUInt32LE(size, 2); return b; }
function payload({ offsetV3 = calibration, badDimension = false, extra = [] } = {}) {
  return Buffer.concat([
    bytes(1, 'SERIAL-PRIVATE-TEST'), bytes(2, 'Insta360 X4'), bytes(3, 'test-firmware'),
    bytes(5, legacy), bytes(11, 'GPS-PRIVATE-TEST'),
    bytes(19, Buffer.concat([n(1, badDimension ? 0 : dimension.width), n(2, dimension.height)])),
    n(20, 24), bytes(54, offsetV3),
    bytes(27, Buffer.concat([n(1, sensor.width), n(2, sensor.height), n(3, crop.width), n(4, crop.height)])),
    ...extra,
  ]);
}
function fixture(data, indexed = false) {
  const mp4Placeholder = Buffer.alloc(128, 0x55);
  let records;
  if (indexed) {
    // An indexed trailer can contain padding and no record descriptors at all.
    const gap = Buffer.alloc(1000);
    const directory = Buffer.alloc(10);
    directory[0] = 1; directory[1] = 1;
    directory.writeUInt32LE(data.length, 2);
    directory.writeUInt32LE(gap.length, 6);
    records = Buffer.concat([gap, data, directory, descriptor(0, directory.length, 0)]);
  } else {
    const unknown = Buffer.alloc(17);
    records = Buffer.concat([data, descriptor(1, data.length), unknown, descriptor(3, unknown.length, 0)]);
  }
  const footer = Buffer.alloc(72);
  footer.writeUInt32LE(records.length + 72, 32); footer.writeUInt32LE(3, 36);
  footer.write('8db42d694ccc418790edff439fe026bf', 40, 'ascii');
  return Buffer.concat([mp4Placeholder, records, footer]);
}

test('normalizes centered sensor crop and back-to-back lens rotations', () => {
  const result = normalizeCalibration({ offsetV3: calibration, offset: legacy, dimension, crop });
  const first = result.lenses[0], second = result.lenses[1];
  const close = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
  close(first.fx, 4600 * 3840 / 5600);
  close(first.cx, 1920 + 14 * 3840 / 5600);
  close(first.cy, 1920 + 28 * 3840 / 5600);
  close(second.cx, first.cx);
  close(first.circle.cx, 1920); close(first.circle.cy, 1920);
  close(first.rotation[8], 1); close(second.rotation[8], -1);
  close(first.rotation[0], 1); close(second.rotation[0], -1);
  assert.deepEqual(second.translation, [0, 0, -0.03]);
});

test('reads sequential and indexed trailers without exposing private fields or writing originals', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'orbit-insv-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const indexed of [false, true]) {
    const path = join(directory, `${indexed}.insv`);
    const original = fixture(payload(), indexed);
    await writeFile(path, original);
    const result = await readInsvMetadata(path);
    assert.equal(result.model, 'Insta360 X4');
    assert.equal(result.calibration.version, 3);
    assert.equal(result.calibration.lenses.length, 2);
    assert.equal(result.fps, 24);
    assert.doesNotMatch(JSON.stringify(result), /SERIAL|GPS|PRIVATE/);
    assert.deepEqual(await readFile(path), original);
  }
});

test('rejects forged trailer sizes, directory positions, malformed protobuf, and absent calibration', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'orbit-insv-invalid-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const badSize = fixture(payload()); badSize.writeUInt32LE(0xffffffff, badSize.length - 40);
  const badIndex = fixture(payload(), true); badIndex.writeUInt32LE(0xffffffff, badIndex.length - 82);
  const badMagic = fixture(payload()); badMagic[badMagic.length - 1] = 0;
  const cases = [badSize, badIndex, badMagic,
    fixture(Buffer.from([0x12, 0xff, 0xff, 0xff, 0xff, 0x0f])),
    fixture(Buffer.from([0x80])), fixture(payload({ offsetV3: '' })), fixture(payload({ badDimension: true }))];
  for (let i = 0; i < cases.length; i++) {
    const path = join(directory, `bad-${i}.insv`); await writeFile(path, cases[i]);
    await assert.rejects(readInsvMetadata(path), /INSV:/);
  }
});

test('refuses unsupported or non-finite calibration instead of inventing parameters', () => {
  const base = { offsetV3: calibration, offset: legacy, dimension, crop };
  const nan = calibration.split('_'); nan[1] = 'NaN';
  const wrongVersion = calibration.split('_'); wrongVersion[39] = '394240';
  for (const change of [
    { offsetV3: nan.join('_') }, { offsetV3: wrongVersion.join('_') },
    { crop: { ...crop, sourceWidth: 6000 } }, { dimension: { width: 3840, height: 2160 } },
    { crop: { ...crop, width: 9000 } },
  ]) assert.throws(() => normalizeCalibration({ ...base, ...change }), /INSV:/);
});

test('respects an aborted read before opening a source', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(readInsvMetadata('missing.insv', { signal: controller.signal }), { name: 'AbortError' });
});
