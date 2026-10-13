import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, appendFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { projectRay, stitchDimensions, writeCalibrationMaps, stitchOpen } from '../src/stitch.js';
import { run } from '../src/process.js';
const ffmpeg = process.env.ORBIT_FFMPEG || 'ffmpeg';
const ffprobe = process.env.ORBIT_FFPROBE || 'ffprobe';

const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const backward = [-1, 0, 0, 0, 1, 0, 0, 0, -1];
function lens(size = 1024, rotation = identity) {
  return { xi: 2, fx: size * 0.7, fy: size * 0.7, cx: size / 2, cy: size / 2,
    rotation, distortion: [0, 0, 0, 0, 0], mirror: false };
}
function metadata(size = 1024) {
  return { dimension: { width: size, height: size }, calibration: { lenses: [lens(size), lens(size, backward)] } };
}
async function directory(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'orbit-stitch-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
function pgm(buffer) {
  let p = 0;
  for (let i = 0; i < 3; i++) { p = buffer.indexOf(10, p); assert.ok(p >= 0); p++; }
  const [magic, dimensions, max] = buffer.subarray(0, p).toString('ascii').trim().split('\n');
  const [width, height] = dimensions.split(' ').map(Number);
  assert.equal(magic, 'P5');
  return { width, height, max: Number(max), data: buffer.subarray(p) };
}

test('Mei projection maps optical center, distinct hemispheres, and tangential distortion', () => {
  const front = lens(), back = lens(1024, backward);
  assert.deepEqual(projectRay(front, 0, 0, 1, 1024, 1024), { x: 512, y: 512, weight: 1 });
  assert.equal(projectRay(front, 0, 0, -1, 1024, 1024), null);
  assert.deepEqual(projectRay(back, 0, 0, -1, 1024, 1024), { x: 512, y: 512, weight: 1 });
  const horizontal = projectRay(front, 1, 0, 0, 1024, 1024);
  assert.equal(horizontal.x, Math.round(512 + 1024 * 0.7 / 2));
  assert.equal(horizontal.y, 512);
  assert.ok(Math.abs(horizontal.weight - 0.5) < 1e-12);
  const distorted = { ...front, distortion: [0, 0, 0, 0.02, -0.01] };
  const result = projectRay(distorted, 1, 0, 0, 1024, 1024);
  assert.equal(result.x, Math.round(512 + front.fx * (0.5 - 0.01 * 0.75)));
  assert.equal(result.y, Math.round(512 + front.fy * (0.02 * 0.25)));
  const offCenter = { ...front, cx: 480, mirror: true };
  assert.equal(projectRay(offCenter, 1, 0, 0, 1024, 1024).x, Math.round(480 - front.fx / 2),
    'a mirrored lens reflects about its optical center, not the image center');
});

test('PGM maps cover the panorama and poles, preserve 16-bit BE coordinates, and feather the seam', async t => {
  const dir = await directory(t);
  const result = await writeCalibrationMaps(metadata(), dir, { width: 256, height: 128 });
  assert.equal(result.uncoveredRatio, 0);
  const maps = await Promise.all(result.files.map(async file => pgm(await readFile(file))));
  for (const [index, map] of maps.entries()) {
    assert.equal(map.width, 256); assert.equal(map.height, 128);
    assert.equal(map.max, index === 4 ? 255 : 65535);
    assert.equal(map.data.length, 256 * 128 * (index === 4 ? 1 : 2));
  }
  const pixel = (x, y) => y * 256 + x;
  const coord = (map, x, y) => maps[map].data.readUInt16BE(pixel(x, y) * 2);
  const mask = (x, y) => maps[4].data[pixel(x, y)];
  const x = 128, y = 64;
  const lon = ((x + 0.5) / 256 * 2 - 1) * Math.PI;
  const lat = Math.PI / 2 - (y + 0.5) / 128 * Math.PI;
  const expected = projectRay(lens(), Math.cos(lat) * Math.sin(lon), -Math.sin(lat), Math.cos(lat) * Math.cos(lon), 1024, 1024);
  assert.equal(coord(0, x, y), expected.x);
  assert.equal(coord(1, x, y), expected.y);
  assert.ok(expected.x > 255, 'the fixture must actually exercise both coordinate bytes');
  assert.notEqual(maps[0].data.readUInt16LE(pixel(x, y) * 2), expected.x);
  assert.equal(mask(128, 64), 0); // The front lens owns the center.
  assert.equal(mask(0, 64), 255); // The rear lens owns the wraparound.
  assert.equal(coord(2, 128, 64), 65535); // No accidental rear sample through the lens's back.
  assert.ok(mask(63, 64) > 80 && mask(63, 64) < 180);
  for (const row of [0, 127]) {
    for (let column = 0; column < 256; column++) {
      assert.ok(coord(0, column, row) !== 65535 || coord(2, column, row) !== 65535,
        `uncovered pole at ${column},${row}`);
    }
  }
});

test('rejects unsupported dimensions, missing calibration, and large holes', async t => {
  assert.deepEqual(stitchDimensions(7680), { width: 7680, height: 3840 });
  for (const width of [0, 128, 1916, 1921, 7684, NaN, Infinity]) assert.throws(() => stitchDimensions(width));
  const dir = await directory(t);
  await assert.rejects(writeCalibrationMaps({}, path.join(dir, 'missing'), { width: 256, height: 128 }), /calibradas/);
  await assert.rejects(writeCalibrationMaps(metadata(), path.join(dir, 'shape'), { width: 256, height: 256 }), /Dimensiones/);
  const wrong = metadata(); wrong.calibration.lenses[1] = lens();
  await assert.rejects(writeCalibrationMaps(wrong, path.join(dir, 'holes'), { width: 256, height: 128 }), /sin cobertura/);
  await assert.rejects(stitchOpen({ paths: [] }, path.join(dir, 'no.mp4')), /INSV/);
});

function varint(value) {
  let n = BigInt(value); const bytes = [];
  do { const byte = Number(n & 127n); n >>= 7n; bytes.push(byte | (n ? 128 : 0)); } while (n);
  return Buffer.from(bytes);
}
function int(id, n) { return Buffer.concat([varint(id * 8), varint(n)]); }
function data(id, value) { const b = Buffer.from(value); return Buffer.concat([varint(id * 8 + 2), varint(b.length), b]); }
function syntheticTrailer() {
  const block = index => [2, 89.6, 89.6, 64 + index * 128, 64, 0, 0, 90, 0, 0, 0, 0, 0, 0, 0, 0, 256, 128, 71];
  const calibration = [2, ...block(0), ...block(1), 3 * 65536 + 4 * 256].join('_');
  const payload = Buffer.concat([
    data(2, 'Synthetic calibrated camera'), data(19, Buffer.concat([int(1, 128), int(2, 128)])),
    int(20, 24), data(27, Buffer.concat([int(1, 128), int(2, 128), int(3, 128), int(4, 128)])), data(54, calibration),
  ]);
  const descriptor = Buffer.alloc(6); descriptor[0] = 1; descriptor[1] = 1; descriptor.writeUInt32LE(payload.length, 2);
  const footer = Buffer.alloc(72); footer.writeUInt32LE(payload.length + 78, 32); footer.writeUInt32LE(3, 36);
  footer.write('8db42d694ccc418790edff439fe026bf', 40, 'ascii');
  return Buffer.concat([payload, descriptor, footer]);
}

test('exports two real video tracks through calibrated maps without an SDK and preserves audio', async t => {
  const dir = await directory(t);
  const source = path.join(dir, 'original.mp4'), output = path.join(dir, 'sphere.mp4');
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin',
    '-f', 'lavfi', '-i', 'color=red:s=128x128:r=24:d=0.25',
    '-f', 'lavfi', '-i', 'color=blue:s=128x128:r=24:d=0.25',
    '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=48000:duration=0.25',
    '-map', '0:v:0', '-map', '1:v:0', '-map', '2:a:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-t', '0.25', source]);
  await appendFile(source, syntheticTrailer());
  const hash = bytes => createHash('sha256').update(bytes).digest('hex');
  const originalHash = hash(await readFile(source));
  const result = await stitchOpen({ paths: [source] }, output, { width: 1920, ffmpeg, ffprobe });
  assert.equal(result.backend, 'open'); assert.equal(result.stabilized, false); assert.equal(result.uncoveredRatio, 0);
  assert.equal(hash(await readFile(source)), originalHash);
  const { stdout } = await run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output]);
  const probe = JSON.parse(stdout), video = probe.streams.find(stream => stream.codec_type === 'video');
  assert.equal(video.width, 1920); assert.equal(video.height, 960);
  assert.equal(Number(video.nb_frames), 6);
  assert.ok(probe.streams.some(stream => stream.codec_type === 'audio'));
  assert.ok(Math.abs(Number(probe.format.duration) - 0.25) < 0.06);
  const pixels = path.join(dir, 'frame.rgb');
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', output, '-frames:v', '1',
    '-vf', 'scale=256:128', '-pix_fmt', 'rgb24', '-f', 'rawvideo', pixels]);
  const rgb = await readFile(pixels);
  const pixel = (x, y) => Array.from(rgb.subarray((y * 256 + x) * 3, (y * 256 + x) * 3 + 3));
  const front = pixel(128, 64), back = pixel(0, 64), seam = pixel(63, 64);
  assert.ok(front[0] > 230 && front[2] < 15, `front ${front}`);
  assert.ok(back[2] > 230 && back[0] < 15, `back ${back}`);
  assert.ok(seam[0] > 60 && seam[2] > 60, `the seam should blend both tracks: ${seam}`);
  await assert.rejects(stitchOpen({paths:[source]},source,{width:1920,ffmpeg,ffprobe}),/salida.*ya existe/);
  assert.equal(hash(await readFile(source)), originalHash);
});
