import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import {createReadStream, createWriteStream} from 'node:fs';
import path from 'node:path';
import {Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {pathToFileURL} from 'node:url';
import {createGunzip} from 'node:zlib';
import {diagnose, printDiagnosis, projectRoot, runtimeEnvironment, runtimePaths, runtimeRelease} from './doctor.mjs';

// SHA-256 publicados por GitHub para el release fijo b6.1.1, verificados el 2026-10-13.
// No se ejecutan instaladores ni scripts remotos. Las licencias del runtime son independientes de Orbit360.
const releaseUrl = `https://github.com/eugeneware/ffmpeg-static/releases/download/${runtimeRelease}`;
const gpl = '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903';
export const bundles = {
  'win32-x64': {
    ffmpeg: ['8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77', '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00'],
    ffprobe: ['f309e6223ad89d2fe54bccd420a7709b66fd27540674e92309578ed491a43c8d', '3a7e2dc003dc2cd1472827e4c7c4f056ae1ae0ae7c5bbc580c99b49827351ba4'],
    LICENSE: gpl, README: 'a636a7183c58006351acbaf35303c0ed85c6e1320fd4e80de453ba6157de6311'},
  'linux-x64': {
    ffmpeg: ['bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa', 'e7e7fb30477f717e6f55f9180a70386c62677ef8a4d4d1a5d948f4098aa3eb99'],
    ffprobe: ['25d9b6ccb05e3d9de9e04e31e2506d8dd7f9f0418981965ac6df12e8d3afd067', '4f231a1960d83e403d08f7971e271707bec278a9ae18e21b8b5b03186668450d'],
    LICENSE: gpl, README: '72f4b1b06d419d22ace6e7cc75f06826f90737345aa0b1736158929f4aacc537'},
  'linux-arm64': {
    ffmpeg: ['754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0', '6bb182d0d75d23028db82e9e4f723ca69b853d055698486e6984ddb2c06fb8ce'],
    ffprobe: ['2ab6aba60ee84412dff9188720703376cb4e7aaf7e0b5e43aa8249f2acae5bf8', 'd17ae9b4c297d48e2521ba14e417bb0537c6ff77c584cdbcd6bb0d8d0307a2e8'],
    LICENSE: gpl, README: 'd6777d2fd276b23f0ac6666fa619e88ffe4826521881c7ff83836e30cb4acec2'},
  'darwin-x64': {
    ffmpeg: ['929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106', 'ebdddc936f61e14049a2d4b549a412b8a40deeff6540e58a9f2a2da9e6b18894'],
    ffprobe: ['d4da574d6e2e197bd259b47d69cf262df9e312af24ad960444f6d806d3d4c186', 'fa3add0ce901f7241abe0dfc0155d958fc834aca3f8ce61f87cc712ae669c1e0'],
    LICENSE: '2e1d16c72fd74e12063776371da757322f8b77589386532f4fd8634bde7de1af', README: 'e88a0325f8e5b75210355e37341824f074d3cd82def2125be54c914b62848a36'},
  'darwin-arm64': {
    ffmpeg: ['8923876afa8db5585022d7860ec7e589af192f441c56793971276d450ed3bbfa', 'a90e3db6a3fd35f6074b013f948b1aa45b31c6375489d39e572bea3f18336584'],
    ffprobe: ['d986a8ec7b030899fe66a8a288ed809a3543338705a3ce178cfb85869c5d80be', 'bb2db6f5d8cef919da12fbf592119a987202a8c060a886f3cab091f9cab90b64'],
    LICENSE: 'cb48bf09a11f5fb576cddb0431c8f5ed0a60157a9ec942adffc13907cbe083f2', README: '05ba4b92c96605434b1aaae3eedf5a2c280c9607bf78ffca9a5b536d9af2dc6a'}
};

export function parseArgs(args) {
  const result = {install: false, start: false, json: false, help: false};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (['--install', '--start', '--json', '--help'].includes(arg)) result[arg.slice(2)] = true;
    else if (arg === '--runtime-dir' && args[i + 1] && !args[i + 1].startsWith('--')) result.runtimeDir = path.resolve(args[++i]);
    else throw new Error(`Argumento desconocido o incompleto: ${arg}`);
  }
  if (result.json && result.start) throw new Error('--json no se combina con --start.');
  return result;
}

export async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

export async function downloadVerified(url, destination, sha256, {fetchImpl = fetch, signal, maxBytes = 128 * 1024 * 1024} = {}) {
  if (new URL(url).protocol !== 'https:') throw new Error('La descarga requiere HTTPS.');
  const response = await fetchImpl(url, {signal: signal || AbortSignal.timeout(10 * 60 * 1000), headers: {'User-Agent': 'Orbit360-bootstrap'}});
  if (!response.ok || !response.body) throw new Error(`No se pudo descargar ${url}: HTTP ${response.status}`);
  if (response.url && new URL(response.url).protocol !== 'https:') throw new Error('La redirección requiere HTTPS.');
  const hash = createHash('sha256'); let bytes = 0;
  const counter = new Transform({transform(chunk, encoding, callback) {
    bytes += chunk.length;
    if (bytes > maxBytes) return callback(new Error('La descarga excede el tamaño permitido.'));
    hash.update(chunk); callback(null, chunk);
  }});
  // El destino es exclusivo para no destruir un archivo anterior si falla la descarga.
  const handle = await fs.open(destination, 'wx');
  try {
    await pipeline(response.body, counter, handle.createWriteStream());
    if (hash.digest('hex') !== sha256) throw new Error(`SHA-256 incorrecto: ${path.basename(destination)}`);
    return bytes;
  } catch (error) {
    await handle.close().catch(() => {}); await fs.unlink(destination).catch(() => {}); throw error;
  }
}

export function bundleAssets(platform = process.platform, arch = process.arch) {
  const key = `${platform}-${arch}`, spec = bundles[key];
  if (!spec) throw new Error(`Sin descarga fijada para ${key}. Instala FFmpeg y FFprobe y configura ORBIT_FFMPEG/ORBIT_FFPROBE.`);
  return [
    ...['LICENSE', 'README'].map(name => ({name: `FFmpeg.${name}`, url: `${releaseUrl}/${key}.${name}`, sha256: spec[name], executable: false})),
    ...['ffmpeg', 'ffprobe'].map(name => ({name: `${name}${platform === 'win32' ? '.exe' : ''}`, url: `${releaseUrl}/${name}-${key}.gz`,
      compressedSha256: spec[name][0], sha256: spec[name][1], executable: true}))
  ];
}

export async function installRuntime({runtimeDir = path.join(projectRoot, '.local', 'runtime'), platform = process.platform,
  arch = process.arch, fetchImpl = fetch, log = console.log} = {}) {
  const assets = bundleAssets(platform, arch);
  const base = path.resolve(runtimeDir), files = runtimePaths(base, platform, arch);
  let existing = false;
  try { await fs.access(files.root); existing = true; } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (existing) {
    try {
      for (const asset of assets) {
        if (await fileHash(path.join(files.root, asset.name)) !== asset.sha256) throw new Error(`SHA-256 incorrecto: ${asset.name}`);
      }
    } catch (error) { throw new Error(`Runtime existente incompleto o alterado: ${error.message}. Usa otro --runtime-dir o revisa ${files.root}.`); }
    log(`Runtime verificado: ${files.root}`); return files;
  }
  await fs.mkdir(base, {recursive: true});
  const stage = await fs.mkdtemp(path.join(base, '.install-'));
  try {
    for (const asset of assets) {
      log(`Descargando ${asset.name} (${runtimeRelease})…`);
      const output = path.join(stage, asset.name);
      if (asset.compressedSha256) {
        const compressed = `${output}.gz`;
        await downloadVerified(asset.url, compressed, asset.compressedSha256, {fetchImpl});
        let bytes = 0;
        const bound = new Transform({transform(chunk, encoding, callback) {
          bytes += chunk.length; callback(bytes > 256 * 1024 * 1024 ? new Error('El binario descomprimido excede el tamaño permitido.') : null, chunk);
        }});
        await pipeline(createReadStream(compressed), createGunzip(), bound, createWriteStream(output, {flags: 'wx'}));
        if (await fileHash(output) !== asset.sha256) throw new Error(`SHA-256 incorrecto: ${asset.name}`);
        await fs.unlink(compressed); await fs.chmod(output, 0o755);
      } else await downloadVerified(asset.url, output, asset.sha256, {fetchImpl, maxBytes: 1024 * 1024});
    }
    await fs.writeFile(path.join(stage, 'manifest.json'), JSON.stringify({release: runtimeRelease, platform, arch,
      source: 'https://github.com/eugeneware/ffmpeg-static', upstream: 'https://ffmpeg.org',
      license: 'Consulta FFmpeg.LICENSE y FFmpeg.README: el runtime mantiene sus propias licencias; no es MIT por formar parte del entorno de Orbit360.',
      files: assets, installedAt: new Date().toISOString()}, null, 2) + '\n', {flag: 'wx'});
    await fs.rename(stage, files.root);
    return files;
  } finally {
    if (path.dirname(stage) === base && path.basename(stage).startsWith('.install-')) await fs.rm(stage, {recursive: true, force: true});
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Uso: node scripts/bootstrap.mjs [--install] [--start] [--json] [--runtime-dir RUTA]\nSin --install solo comprueba los requisitos. --install descarga FFmpeg/FFprobe y sus licencias en .local/runtime.\n--start inicia Orbit360 con ese runtime. Requiere Node.js ≥22; no instala SDK, proveedores ni credenciales.'); return;
  }
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Se requiere Node.js ≥22.');
  if (options.install) await installRuntime({...options, log: options.json ? () => {} : console.log});
  const report = await diagnose(options);
  printDiagnosis(report, options.json);
  if (!report.ok) { process.exitCode = 1; return; }
  if (options.start) {
    const child = spawn(process.execPath, [path.join(projectRoot, 'src', 'server.js')], {
      cwd: projectRoot, env: runtimeEnvironment(options), stdio: 'inherit', windowsHide: true});
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); resolve(); });
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
