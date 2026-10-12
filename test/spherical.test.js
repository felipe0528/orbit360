import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {injectSphericalMetadata, inspectSphericalMetadata, stripSphericalMetadata} from '../src/spherical.js';
import {run} from '../src/process.js';

const ffmpeg = process.env.ORBIT_FFMPEG || 'ffmpeg';
const ffprobe = process.env.ORBIT_FFPROBE || 'ffprobe';

async function workspace(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-spherical-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  return directory;
}

function atom(type, ...parts) {
  const payload = Buffer.concat(parts), header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8);
  header.write(type, 4);
  return Buffer.concat([header, payload]);
}

// Small structural fixtures exercise 64-bit chunk tables and malformed inputs
// without checking multi-gigabyte media into the project.
function fixture({co64 = false, fragmented = false, width = 640, height = 320, invalidOffset = false} = {}) {
  const entry = Buffer.alloc(78);
  entry.writeUInt16BE(1, 6);
  entry.writeUInt16BE(width, 24);
  entry.writeUInt16BE(height, 26);
  const description = Buffer.alloc(8); description.writeUInt32BE(1, 4);
  const handler = Buffer.alloc(12); handler.write('vide', 8);
  const offset = Buffer.alloc(co64 ? 16 : 12); offset.writeUInt32BE(1, 4);
  const makeMovie = () => atom('moov', atom('trak', atom('mdia', atom('hdlr', handler), atom('minf', atom('stbl',
    atom('stsd', description, atom('avc1', entry, atom('avcC', Buffer.from([1, 2, 3, 4])))),
    atom(co64 ? 'co64' : 'stco', offset),
  )))), ...(fragmented ? [atom('mvex')] : []));
  const ftyp = atom('ftyp', Buffer.from('isom'), Buffer.alloc(4), Buffer.from('isom'));
  const position = invalidOffset ? 2 : ftyp.length + makeMovie().length + 8;
  if (co64) offset.writeBigUInt64BE(BigInt(position), 8); else offset.writeUInt32BE(position, 8);
  return Buffer.concat([ftyp, makeMovie(), atom('mdat', Buffer.from('the media bytes must remain unchanged'))]);
}

function boxBytes(buffer, type) {
  const offset = buffer.indexOf(Buffer.from(type));
  assert.ok(offset >= 4, `missing ${type}`);
  const length = buffer.readUInt32BE(offset - 4);
  return buffer.subarray(offset - 4, offset - 4 + length);
}

test('spherical writer updates stco and co64 without changing media, then removes all signalling', async t => {
  const directory = await workspace(t);
  for (const co64 of [false, true]) {
    const original = path.join(directory, `source-${co64}.mp4`);
    const output = path.join(directory, `sphere-${co64}.mp4`);
    const flat = path.join(directory, `flat-${co64}.mp4`);
    const sourceBytes = fixture({co64});
    await fs.writeFile(original, sourceBytes);
    const before = await inspectSphericalMetadata(original);
    assert.equal(before.spherical, false);
    const result = await injectSphericalMetadata(original, output, {width: 640, height: 320});
    assert.deepEqual(result.metadataVersions, [1, 2]);
    assert.equal(result.fastStart, true);
    assert.equal(result.projection, 'equirectangular');
    assert.equal(result.stereoMode, 'mono');
    assert.equal(result.v1Count, 1); assert.equal(result.v2Count, 1); assert.equal(result.stereoBoxCount, 1);
    const outputBytes = await fs.readFile(output);
    assert.deepEqual(boxBytes(outputBytes, 'mdat'), boxBytes(sourceBytes, 'mdat'));
    const offsets = boxBytes(outputBytes, co64 ? 'co64' : 'stco');
    const offset = co64 ? Number(offsets.readBigUInt64BE(16)) : offsets.readUInt32BE(16);
    assert.equal(offset, outputBytes.indexOf(Buffer.from('mdat')) + 4);
    const removed = await stripSphericalMetadata(output, flat);
    assert.equal(removed.spherical, false);
    assert.deepEqual(removed.metadataVersions, []);
    assert.deepEqual(await fs.readFile(flat), sourceBytes);
    assert.deepEqual(await fs.readFile(original), sourceBytes);
  }
});

test('injecting twice is idempotent and replaces existing metadata rather than duplicating it', async t => {
  const directory = await workspace(t);
  const source = path.join(directory, 'source.mp4'), once = path.join(directory, 'once.mp4'), twice = path.join(directory, 'twice.mp4');
  await fs.writeFile(source, fixture());
  await injectSphericalMetadata(source, once, {width: 640, height: 320});
  await injectSphericalMetadata(once, twice, {width: 640, height: 320});
  assert.deepEqual(await fs.readFile(once), await fs.readFile(twice));
});

test('preserves extended 64-bit box headers and accepts a final zero-sized mdat', async t => {
  const directory = await workspace(t);
  for (const extended of [true, false]) {
    const initial = fixture({co64: true});
    const originalMoov = boxBytes(initial, 'moov'), originalMdat = boxBytes(initial, 'mdat');
    const extendedBox = bytes => {
      const header = Buffer.alloc(16);
      header.writeUInt32BE(1); bytes.copy(header, 4, 4, 8); header.writeBigUInt64BE(BigInt(bytes.length + 8), 8);
      return Buffer.concat([header, bytes.subarray(8)]);
    };
    let bytes;
    if (extended) {
      bytes = Buffer.concat([boxBytes(initial, 'ftyp'), extendedBox(originalMoov), extendedBox(originalMdat)]);
      const chunkPosition = bytes.indexOf(Buffer.from('co64')) + 12;
      bytes.writeBigUInt64BE(BigInt(bytes.indexOf(Buffer.from('mdat')) + 12), chunkPosition);
    } else {
      bytes = Buffer.from(initial);
      bytes.writeUInt32BE(0, bytes.indexOf(Buffer.from('mdat')) - 4);
    }
    const source = path.join(directory, `source-${extended}.mp4`), output = path.join(directory, `sphere-${extended}.mp4`), flat = path.join(directory, `flat-${extended}.mp4`);
    await fs.writeFile(source, bytes);
    const result = await injectSphericalMetadata(source, output, {width: 640, height: 320});
    assert.deepEqual(result.metadataVersions, [1, 2]);
    await stripSphericalMetadata(output, flat);
    assert.deepEqual(await fs.readFile(flat), bytes);
  }
});

test('promotes overflowing stco to co64 and streams a virtual 4 GiB MP4 in bounded reads', async t => {
  // Virtual file handles avoid allocating/writing a 4 GiB fixture in CI. The
  // normal parser, offset convergence, copier and final inspection all run.
  const directory = await workspace(t), source = path.join(directory, 'large.mp4'), output = path.join(directory, 'large-sphere.mp4');
  const sourceHead = fixture();
  const mediaStart = sourceHead.indexOf(Buffer.from('mdat')) - 4;
  sourceHead.writeUInt32BE(0xffffffff, mediaStart);
  const originalOffset = 0xfffffffen;
  sourceHead.writeUInt32BE(Number(originalOffset), sourceHead.indexOf(Buffer.from('stco')) + 12);
  const sourceSize = mediaStart + 0xffffffff, outputHead = Buffer.alloc(16384);
  let outputSize = 0, maximumRead = 0;
  const readHandle = (head, size) => ({
    stat: async () => ({isFile: () => true, size, mtimeMs: 1}), close: async () => {},
    read: async (buffer, offset, length, position) => {
      maximumRead = Math.max(maximumRead, length);
      const amount = Math.min(length, size - position);
      buffer.fill(0, offset, offset + amount);
      if (position < head.length) head.copy(buffer, offset, position, Math.min(head.length, position + amount));
      return {bytesRead: amount};
    },
  });
  const open = fs.open.bind(fs);
  const mocked = t.mock.method(fs, 'open', async (file, flags) => {
    if (file === source) return readHandle(sourceHead, sourceSize);
    if (file !== output) return open(file, flags);
    if (flags === 'r') return readHandle(outputHead, outputSize);
    return {close: async () => {}, write: async (buffer, offset, length) => {
      if (outputSize < outputHead.length) buffer.copy(outputHead, outputSize, offset, offset + Math.min(length, outputHead.length - outputSize));
      outputSize += length;
      return {bytesWritten: length};
    }};
  });
  try {
    const result = await injectSphericalMetadata(source, output, {width: 640, height: 320});
    assert.deepEqual(result.metadataVersions, [1, 2]);
    assert.equal(result.fastStart, true);
    assert.ok(maximumRead <= 1024 * 1024);
    assert.equal(outputHead.indexOf(Buffer.from('stco')), -1);
    const table = boxBytes(outputHead, 'co64');
    assert.equal(table.readBigUInt64BE(16), originalOffset + BigInt(outputSize - sourceSize));
    assert.ok(table.readBigUInt64BE(16) > 0xffffffffn);
  } finally { mocked.mock.restore(); }
});

test('rejects invalid dimensions, fragmented/truncated MP4, bad offsets, overwrites and aborted writes', async t => {
  const directory = await workspace(t);
  const source = path.join(directory, 'source.mp4'), output = path.join(directory, 'output.mp4');
  await fs.writeFile(source, fixture());
  for (const options of [{width: 640, height: 480}, {width: 1280, height: 640}, {width: 640.5, height: 320.25}, {width: 0, height: 0}, {}]) {
    await assert.rejects(injectSphericalMetadata(source, output, options), /dimensiones/);
    await assert.rejects(fs.access(output));
  }
  await assert.rejects(injectSphericalMetadata(source, source, {width: 640, height: 320}), /distinta/);
  await fs.writeFile(output, 'existing output');
  await assert.rejects(injectSphericalMetadata(source, output, {width: 640, height: 320}), {code: 'EEXIST'});
  assert.equal(await fs.readFile(output, 'utf8'), 'existing output');
  const aborted = path.join(directory, 'aborted.mp4');
  await assert.rejects(injectSphericalMetadata(source, aborted, {width: 640, height: 320, signal: AbortSignal.abort()}), {name: 'AbortError'});
  await assert.rejects(fs.access(aborted));
  for (const [name, bytes, pattern] of [
    ['fragmented', fixture({fragmented: true}), /mvex/],
    ['offset', fixture({invalidOffset: true}), /offset/],
    ['truncated', fixture().subarray(0, -1), /tamaño inválido/],
    ['empty', Buffer.alloc(0), /moov/],
  ]) {
    const input = path.join(directory, `${name}.mp4`), target = path.join(directory, `${name}-output.mp4`);
    await fs.writeFile(input, bytes);
    await assert.rejects(injectSphericalMetadata(input, target, {width: 640, height: 320}), pattern);
    await assert.rejects(fs.access(target));
  }
});

test('rejects oversized movie indices before reading them into memory', async t => {
  const directory = await workspace(t), source = path.join(directory, 'oversized.mp4'), output = path.join(directory, 'output.mp4');
  const movieLength = 64 * 1024 * 1024 + 1;
  const movieHeader = Buffer.alloc(16);
  movieHeader.writeUInt32BE(1); movieHeader.write('moov', 4); movieHeader.writeBigUInt64BE(BigInt(movieLength), 8);
  const handle = await fs.open(source, 'w');
  try {
    await handle.write(movieHeader, 0, movieHeader.length, 0);
    const media = atom('mdat', Buffer.from('data'));
    await handle.write(media, 0, media.length, movieLength);
  } finally { await handle.close(); }
  await assert.rejects(injectSphericalMetadata(source, output, {width: 640, height: 320}), /64 MiB/);
  await assert.rejects(fs.access(output));
});

test('abort during output writing removes partial output and preserves the original', async t => {
  const directory = await workspace(t), source = path.join(directory, 'source.mp4'), output = path.join(directory, 'aborted.mp4');
  const bytes = fixture(); await fs.writeFile(source, bytes);
  const abort = new AbortController(), open = fs.open.bind(fs);
  const mocked = t.mock.method(fs, 'open', async (file, flags) => {
    const handle = await open(file, flags);
    if (file !== output || flags !== 'wx') return handle;
    return {close: () => handle.close(), write: async (...args) => {
      const result = await handle.write(...args); abort.abort(); return result;
    }};
  });
  try { await assert.rejects(injectSphericalMetadata(source, output, {width: 640, height: 320, signal: abort.signal}), {name: 'AbortError'}); }
  finally { mocked.mock.restore(); }
  await assert.rejects(fs.access(output));
  assert.deepEqual(await fs.readFile(source), bytes);
});

test('flat 9:16 output can have inherited spherical boxes removed without adding 360 metadata', async t => {
  const directory = await workspace(t), source = path.join(directory, 'portrait.mp4'), output = path.join(directory, 'clean.mp4');
  await fs.writeFile(source, fixture({width: 360, height: 640}));
  const result = await stripSphericalMetadata(source, output);
  assert.equal(result.spherical, false);
  assert.equal(result.width, 360); assert.equal(result.height, 640);
  assert.deepEqual(await fs.readFile(source), await fs.readFile(output));
});

test('real FFmpeg: V1/V2 recognition, unchanged decoded frames and packet hashes, moov before and after mdat', {timeout: 120000}, async t => {
  try { await run(ffmpeg, ['-version']); await run(ffprobe, ['-version']); }
  catch { t.skip('FFmpeg y FFprobe no instalados'); return; }
  const directory = await workspace(t);
  for (const fastStart of [false, true]) {
    await t.test(fastStart ? 'faststart with video and audio offsets' : 'trailing moov with video and audio offsets', async () => {
      const source = path.join(directory, `source-${fastStart}.mp4`), output = path.join(directory, `sphere-${fastStart}.mp4`), flat = path.join(directory, `flat-${fastStart}.mp4`);
      await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x320:rate=12', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', '-c:a', 'aac', ...(fastStart ? ['-movflags', '+faststart'] : []), source]);
      const result = await injectSphericalMetadata(source, output, {width: 640, height: 320});
      assert.equal(result.fastStart, fastStart);
      assert.deepEqual(result.metadataVersions, [1, 2]);
      const probe = JSON.parse((await run(ffprobe, ['-v', 'error', '-show_streams', '-of', 'json', output])).stdout);
      const video = probe.streams.find(stream => stream.codec_type === 'video');
      assert.equal(video.side_data_list.find(item => item.side_data_type === 'Spherical Mapping')?.projection, 'equirectangular');
      assert.equal(video.side_data_list.find(item => item.side_data_type === 'Stereo 3D')?.type, '2D');
      const hashes = async file => JSON.parse((await run(ffprobe, ['-v', 'error', '-show_packets', '-show_data_hash', 'sha256', '-show_entries', 'packet=stream_index,pts,dts,duration,size,flags,data_hash', '-of', 'json', file])).stdout).packets;
      assert.deepEqual(await hashes(output), await hashes(source));
      const decoded = async file => (await run(ffmpeg, ['-v', 'error', '-i', file, '-map', '0', '-f', 'framemd5', '-'])).stdout;
      assert.equal(await decoded(output), await decoded(source));
      await stripSphericalMetadata(output, flat);
      assert.deepEqual(await fs.readFile(flat), await fs.readFile(source));
    });
  }
});
