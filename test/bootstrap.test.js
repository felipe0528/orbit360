import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {bundleAssets, downloadVerified, installRuntime, parseArgs} from '../scripts/bootstrap.mjs';
import {diagnose, runtimeEnvironment, runtimePaths} from '../scripts/doctor.mjs';

test('bootstrap downloads require an explicit flag and pinned HTTPS assets include licenses', () => {
  assert.equal(parseArgs([]).install, false);
  assert.equal(parseArgs(['--start']).install, false);
  assert.equal(parseArgs(['--install', '--start']).install, true);
  assert.throws(() => parseArgs(['--instal']), /desconocido/);
  assert.throws(() => parseArgs(['--runtime-dir']), /incompleto/);
  assert.throws(() => bundleAssets('win32', 'arm64'), /Sin descarga fijada/);
  for (const [platform, arch] of [['win32', 'x64'], ['linux', 'x64'], ['linux', 'arm64'], ['darwin', 'x64'], ['darwin', 'arm64']]) {
    const assets = bundleAssets(platform, arch);
    assert.equal(assets.length, 4);
    assert.ok(assets.some(asset => asset.name === 'FFmpeg.LICENSE'));
    assert.ok(assets.some(asset => asset.name === 'FFmpeg.README'));
    for (const asset of assets) {
      assert.match(asset.url, /^https:\/\/github\.com\/eugeneware\/ffmpeg-static\/releases\/download\/b6\.1\.1\//);
      assert.match(asset.sha256, /^[a-f0-9]{64}$/);
      if (asset.executable) assert.match(asset.compressedSha256, /^[a-f0-9]{64}$/);
    }
  }
});

test('download verification rejects tampering and oversized data without leaving an executable or overwriting files', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-bootstrap-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const payload = Buffer.from('verified fixture');
  const hash = createHash('sha256').update(payload).digest('hex');
  const destination = path.join(directory, 'runtime.bin');
  const fetchImpl = async () => new Response(payload);
  await downloadVerified('https://example.test/runtime', destination, hash, {fetchImpl});
  assert.deepEqual(await fs.readFile(destination), payload);
  await assert.rejects(() => downloadVerified('https://example.test/runtime', destination, hash, {fetchImpl}), {code: 'EEXIST'});
  assert.deepEqual(await fs.readFile(destination), payload);
  const corrupt = path.join(directory, 'corrupt.bin');
  await assert.rejects(() => downloadVerified('https://example.test/runtime', corrupt, '0'.repeat(64), {fetchImpl}), /SHA-256 incorrecto/);
  await assert.rejects(() => fs.access(corrupt), {code: 'ENOENT'});
  await assert.rejects(() => downloadVerified('https://example.test/runtime', corrupt, hash, {fetchImpl, maxBytes: 2}), /tamaño permitido/);
  await assert.rejects(() => fs.access(corrupt), {code: 'ENOENT'});
  await assert.rejects(() => downloadVerified('http://example.test/runtime', corrupt, hash, {fetchImpl}), /HTTPS/);
});

test('doctor checks required media capabilities while optional provider failures do not block editing', async () => {
  const calls = [];
  const executeTool = async (command, args) => {
    calls.push([command, ...args]);
    if (args.includes('-filters')) return {stdout: ' .S v360 V->V\n ... remap VVV->V\n TSC maskedmerge VVV->V'};
    if (args.includes('-encoders')) return {stdout: ' V....D libx264 encoder\n A..... aac encoder'};
    if (args.includes('-decoders')) return {stdout: ' VFS..D h264 decoder\n VFS..D hevc decoder'};
    if (command === 'ffmpeg') return {stdout: 'ffmpeg version 6.1.1'};
    if (command === 'ffprobe') return {stdout: 'ffprobe version 6.1.1'};
    throw Object.assign(new Error('not installed'), {code: 'ENOENT'});
  };
  const report = await diagnose({env: {}, platform: 'linux', arch: 'unsupported', nodeVersion: '22.0.0', executeTool});
  assert.equal(report.ok, true);
  assert.equal(report.checks.find(check => check.id === 'codex').ok, false);
  assert.ok(calls.every(call => !call.includes('login')));
  const oldNode = await diagnose({env: {}, platform: 'linux', arch: 'unsupported', nodeVersion: '20.0.0', executeTool});
  assert.equal(oldNode.ok, false);
  const missingFilter = await diagnose({env: {}, platform: 'linux', arch: 'unsupported', executeTool: async (command, args) => {
    const result = await executeTool(command, args);
    return {stdout: result.stdout.replace('v360 ', 'v360_fake ')};
  }});
  assert.equal(missingFilter.ok, false);
  assert.equal(missingFilter.checks.find(check => check.id === 'filter:v360').ok, false);
});

test('runtime discovery is portable and explicit executable overrides win', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'orbit-runtime-'));
  t.after(() => fs.rm(directory, {recursive: true, force: true}));
  const files = runtimePaths(directory, 'win32', 'x64');
  await fs.mkdir(files.root); await fs.writeFile(files.ffmpeg, 'fixture'); await fs.writeFile(files.ffprobe, 'fixture');
  assert.equal(runtimeEnvironment({env: {}, runtimeDir: directory, platform: 'win32', arch: 'x64'}).ORBIT_FFMPEG, files.ffmpeg);
  assert.equal(runtimeEnvironment({env: {ORBIT_FFMPEG: 'custom'}, runtimeDir: directory, platform: 'win32', arch: 'x64'}).ORBIT_FFMPEG, 'custom');
  assert.equal(runtimeEnvironment({env: {}, runtimeDir: directory, platform: 'linux', arch: 'x64'}).ORBIT_FFMPEG, 'ffmpeg');
  let downloaded = false;
  await assert.rejects(() => installRuntime({runtimeDir: directory, platform: 'win32', arch: 'x64',
    fetchImpl: async () => { downloaded = true; throw new Error('unexpected download'); }}), /Runtime existente incompleto o alterado/);
  assert.equal(downloaded, false);
  assert.equal(await fs.readFile(files.ffmpeg, 'utf8'), 'fixture');
});
