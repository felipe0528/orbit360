// Independent, CPU-only calibrated geometric stitching. The projection equations
// are the standard Mei omnidirectional model plus Brown radial/tangential distortion.
// No Insta360 executable, lens table, neural model or SDK is loaded here.
import fs from 'node:fs/promises';
import path from 'node:path';
import { run } from './process.js';
import { readInsvMetadata } from './insv.js';

export const OPEN_STITCH_VERSION = 'mei-brown-1';
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const MIN_Z = Math.cos(98 * Math.PI / 180);
const FEATHER = Math.sin(4 * Math.PI / 180);

/** A normalized rig ray -> calibrated source pixel. Rotation is camera-to-rig. */
export function projectRay(lens, dx, dy, dz, width, height) {
  const r = lens.rotation;
  const x = r[0] * dx + r[3] * dy + r[6] * dz;
  const y = r[1] * dx + r[4] * dy + r[7] * dz;
  const z = r[2] * dx + r[5] * dy + r[8] * dz;
  if (z < MIN_Z) return null;
  const nx = x / (z + lens.xi), ny = y / (z + lens.xi);
  const r2 = nx * nx + ny * ny;
  const [k1, k2, k3, p1, p2] = lens.distortion;
  const radial = 1 + r2 * (k1 + r2 * (k2 + r2 * k3));
  let u = lens.fx * (nx * radial + 2 * p1 * nx * ny + p2 * (r2 + 2 * nx * nx)) + lens.cx;
  const v = lens.fy * (ny * radial + p1 * (r2 + 2 * ny * ny) + 2 * p2 * nx * ny) + lens.cy;
  if (lens.mirror) u = 2 * lens.cx - u;
  if (!Number.isFinite(u) || !Number.isFinite(v) || u < 0 || v < 0 || u > width - 1 || v > height - 1) return null;
  return { x: Math.round(u), y: Math.round(v), weight: Math.max(1e-6, clamp((z + FEATHER) / (2 * FEATHER), 0, 1)) };
}

export function stitchDimensions(width = 3840) {
  if (!Number.isInteger(width) || width < 1920 || width > 7680 || width % 4) {
    throw new Error('El ancho de preparación debe ser múltiplo de 4, entre 1920 y 7680.');
  }
  return { width, height: width / 2 };
}

/** Write maps in bounded strips, not full 8K JS arrays. PGM 16-bit samples are BE. */
export async function writeCalibrationMaps(metadata, directory, { width, height, signal, progress = () => {} }) {
  if (!Number.isInteger(width) || width < 128 || width > 7680 || width % 4 || height !== width / 2) throw new Error('Dimensiones de mapas no válidas.');
  if (metadata.calibration?.lenses?.length !== 2) throw new Error('Se requieren dos lentes calibradas.');
  const source = metadata.dimension, lenses = metadata.calibration.lenses;
  await fs.mkdir(directory, { recursive: true });
  const names = ['x0', 'y0', 'x1', 'y1', 'mask'];
  const files = names.map(name => path.join(directory, `${name}.pgm`));
  const handles = [];
  let uncovered = 0;
  try {
    for (let i = 0; i < files.length; i++) {
      const handle = await fs.open(files[i], 'wx'); handles.push(handle);
      await handle.write(`P5\n${width} ${height}\n${i === 4 ? 255 : 65535}\n`);
    }
    const sinLon = new Float64Array(width), cosLon = new Float64Array(width);
    for (let x = 0; x < width; x++) {
      const lon = ((x + 0.5) / width * 2 - 1) * Math.PI;
      sinLon[x] = Math.sin(lon); cosLon[x] = Math.cos(lon);
    }
    for (let row = 0; row < height; row += 16) {
      signal?.throwIfAborted();
      const rows = Math.min(16, height - row), buffers = names.map((_, i) => Buffer.alloc(width * rows * (i === 4 ? 1 : 2)));
      for (let y = row; y < row + rows; y++) {
        const latitude = Math.PI / 2 - (y + 0.5) / height * Math.PI;
        const c = Math.cos(latitude), dy = -Math.sin(latitude);
        for (let x = 0; x < width; x++) {
          const a = projectRay(lenses[0], c * sinLon[x], dy, c * cosLon[x], source.width, source.height);
          const b = projectRay(lenses[1], c * sinLon[x], dy, c * cosLon[x], source.width, source.height);
          const index = (y - row) * width + x;
          buffers[0].writeUInt16BE(a?.x ?? 65535, index * 2);
          buffers[1].writeUInt16BE(a?.y ?? 65535, index * 2);
          buffers[2].writeUInt16BE(b?.x ?? 65535, index * 2);
          buffers[3].writeUInt16BE(b?.y ?? 65535, index * 2);
          if (!a && !b) uncovered++;
          buffers[4][index] = !b ? 0 : !a ? 255 : Math.round(255 * b.weight / (a.weight + b.weight));
        }
      }
      await Promise.all(handles.map((handle, i) => handle.write(buffers[i])));
      progress((row + rows) / height * 15, 'Calculando la proyección de las dos lentes…');
    }
  } finally { await Promise.all(handles.map(handle => handle.close())); }
  const uncoveredRatio = uncovered / (width * height);
  if (uncoveredRatio > 0.001) throw new Error(`La calibración deja ${(uncoveredRatio * 100).toFixed(2)} % de la esfera sin cobertura. Este modo de cámara todavía no es compatible.`);
  return { files, uncoveredRatio };
}

async function streams(file, ffprobe, signal) {
  const { stdout } = await run(ffprobe, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { signal });
  const data = JSON.parse(stdout);
  return { video: data.streams.filter(s => s.codec_type === 'video' && !s.disposition?.attached_pic),
    audio: data.streams.some(s => s.codec_type === 'audio'), duration: Number(data.format?.duration) };
}

/** Stitch to an intermediate sphere; the export pipeline adds final 360 metadata. */
export async function stitchOpen(asset, output, { width = 3840, ffmpeg = 'ffmpeg', ffprobe = 'ffprobe', signal, progress = () => {} } = {}) {
  output = path.resolve(output);
  try { await fs.lstat(output); throw new Error('La salida de preparación ya existe. Usa una ruta nueva.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!Array.isArray(asset.paths) || asset.paths.length < 1 || asset.paths.length > 2) throw new Error('Se requiere un INSV de dos pistas o su pareja de archivos.');
  const metadata = await readInsvMetadata(asset.paths[0], { signal });
  const info = await Promise.all(asset.paths.map(file => streams(file, ffprobe, signal)));
  let inputs;
  if (info.length === 2 && info.every(i => i.video.length === 1)) inputs = [[0, 0], [1, 0]];
  else if (info.length === 1 && info[0].video.length === 2) {
    inputs = metadata.calibration.layout === 'reversed-tracks' ? [[0, 1], [0, 0]] : [[0, 0], [0, 1]];
  } else throw new Error('No se encontraron las dos lentes. Conserva ambos archivos _00_ y _10_ de la grabación original.');
  const videos = inputs.map(([file, track]) => info[file].video[track]);
  for (const video of videos) {
    if (video.width !== metadata.dimension.width || video.height !== metadata.dimension.height) throw new Error('La resolución de las pistas no coincide con la calibración INSV.');
  }
  const rates = videos.map(video => { const [a, b] = String(video.avg_frame_rate).split('/').map(Number); return a / b; });
  if (rates.some(rate => !Number.isFinite(rate) || rate < 1 || rate > 240) || Math.abs(rates[0] - rates[1]) > 0.001) throw new Error('Las lentes no tienen una frecuencia de cuadros compatible.');
  const duration = Math.min(...inputs.map(([file, track]) => Number(info[file].video[track].duration || info[file].duration)));
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('Duración de las lentes no válida.');
  const dimensions = stitchDimensions(width);
  await fs.mkdir(path.dirname(output), { recursive: true });
  const directory = await fs.mkdtemp(path.join(path.dirname(output), '.maps-'));
  try {
    const maps = await writeCalibrationMaps(metadata, directory, { ...dimensions, signal, progress });
    const args = ['-hide_banner', '-nostdin', '-n', '-filter_complex_threads', '1'];
    for (const input of asset.paths) args.push('-threads', '2', '-i', input);
    const mapOffset = asset.paths.length;
    for (const file of maps.files) args.push('-threads', '1', '-loop', '1', '-framerate', String(rates[0]), '-i', file);
    const graph = inputs.map(([file, track], i) => `[${file}:v:${track}]setpts=PTS-STARTPTS,format=gbrp[lens${i}];[lens${i}][${mapOffset + i * 2}:v][${mapOffset + i * 2 + 1}:v]remap=fill=black[warp${i}]`).join(';')
      + `;[${mapOffset + 4}:v]format=gbrp[mask];[warp0][warp1][mask]maskedmerge=planes=7,format=yuv420p,setsar=1[out]`;
    args.push('-filter_complex', graph, '-map', '[out]');
    const audioIndex = info.findIndex(i => i.audio);
    if (audioIndex >= 0) args.push('-map', `${audioIndex}:a:0`, '-af', 'asetpts=PTS-STARTPTS,aresample=48000,apad', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-ac', '2');
    args.push('-t', String(duration), '-r', String(rates[0]), '-c:v', 'libx264', '-crf', '17', '-preset', 'fast', '-threads', '4', '-map_metadata', '-1', '-movflags', '+faststart', '-progress', 'pipe:1', '-loglevel', 'error', output);
    await run(ffmpeg, args, { signal, timeout: 6 * 3600000, onLine: line => {
      const match = /^out_time_us=(\d+)$/.exec(line);
      if (match) progress(Math.min(99, 15 + Number(match[1]) / 1e6 / duration * 84), 'Uniendo las lentes con el motor abierto…');
    } });
    return { backend: 'open', engine: OPEN_STITCH_VERSION, model: metadata.model, calibrationVersion: 3,
      width: dimensions.width, height: dimensions.height, duration, uncoveredRatio: maps.uncoveredRatio,
      stabilized: false, warnings: metadata.limits };
  } finally {
    // mkdtemp is always an immediate child of the already resolved output directory.
    if (path.dirname(directory) === path.dirname(output) && path.basename(directory).startsWith('.maps-')) await fs.rm(directory, { recursive: true, force: true });
  }
}
