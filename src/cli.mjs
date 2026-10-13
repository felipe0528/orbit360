#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {runtimeEnvironment} from '../scripts/doctor.mjs';
import {defaultPlan, validatePlan} from './plan.js';

export const help = `Orbit360 · edición local para agentes

node src/cli.mjs inspect --input VIDEO [--input OTRO_VIDEO]
node src/cli.mjs render --input VIDEO --output CARPETA [--plan PLAN.json]
node src/cli.mjs render --input VIDEO --output CARPETA --format portrait --start 5 --end 7

Opciones de render:
  --format portrait|landscape|square|three-four|360 (predeterminado: landscape)
  --start SEGUNDOS --end SEGUNDOS   Un intervalo sobre un solo vídeo importado.
  --width ANCHO                    Preparación esférica: 1920..7680, múltiplo de 4;
                                  predeterminado: 3840. No cambia el tamaño final.
  --plan ARCHIVO.json              Plan completo; excluye format/start/end.

Las rutas pueden ser absolutas o relativas al directorio actual. Los INSV
emparejados se detectan y deduplican automáticamente. Los MP4/MOV/MKV de entrada
deben ser panoramas equirectangulares. El plan usa assetId o, en cada clip,
sourceIndex (desde 0, sobre la lista deduplicada de inspect) en lugar de assetId.
Sin --plan, el montaje usa los primeros cinco segundos de cada vídeo.
Cada exportación crea una subcarpeta única dentro de --output; no sobrescribe
originales ni exportaciones anteriores. El motor abierto no aplica FlowState.
Resultado JSON por stdout, progreso JSON por stderr. Ctrl+C cancela el trabajo.
`;

function argumentError(message) {
  const error = new Error(message);
  error.code = 'INVALID_ARGUMENTS';
  return error;
}

export function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.some(value => typeof value !== 'string')) throw argumentError('Argumentos no válidos.');
  if (!argv.length || (argv.length === 1 && ['--help', '-h', 'help'].includes(argv[0]))) return {command: 'help'};
  const [command, ...args] = argv;
  if (!['inspect', 'render'].includes(command)) throw argumentError(`Comando desconocido: ${command}. Usa --help.`);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) return {command: 'help'};
  const options = {command, inputs: []}, seen = new Set();
  const allowed = command === 'inspect' ? ['input'] : ['input', 'output', 'plan', 'format', 'width', 'start', 'end'];
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], key = flag.startsWith('--') ? flag.slice(2) : '';
    if (!allowed.includes(key)) throw argumentError(`Argumento desconocido para ${command}: ${flag}.`);
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw argumentError(`Falta el valor de ${flag}.`);
    if (key !== 'input' && seen.has(key)) throw argumentError(`Argumento repetido: ${flag}.`);
    seen.add(key);
    if (key === 'input') options.inputs.push(path.resolve(value));
    else if (['output', 'plan'].includes(key)) options[key] = path.resolve(value);
    else if (['width', 'start', 'end'].includes(key)) {
      if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || !Number.isFinite(Number(value))) throw argumentError(`${flag} debe ser un número no negativo.`);
      options[key] = Number(value);
    } else options[key] = value;
  }
  if (!options.inputs.length || options.inputs.length > 200) throw argumentError('Indica entre 1 y 200 argumentos --input.');
  if (command === 'render') {
    if (!options.output) throw argumentError('render necesita --output CARPETA.');
    if (options.width !== undefined && (!Number.isInteger(options.width) || options.width < 1920 || options.width > 7680 || options.width % 4)) throw argumentError('--width debe ser un múltiplo de 4 entre 1920 y 7680.');
    if (options.format && !Object.hasOwn(presets, options.format)) throw argumentError('--format debe ser portrait, landscape, square, three-four o 360.');
    if (options.plan && ['format', 'start', 'end'].some(key => options[key] !== undefined)) throw argumentError('--plan no se combina con --format, --start o --end.');
    if (options.start !== undefined && options.end !== undefined && options.end - options.start < 0.1 - 1e-9) throw argumentError('El intervalo debe durar al menos 0,1 segundos.');
  }
  return options;
}

const presets = {
  portrait: {width: 1080, height: 1920, projection: 'flat'},
  landscape: {width: 1920, height: 1080, projection: 'flat'},
  square: {width: 1080, height: 1080, projection: 'flat'},
  'three-four': {width: 1080, height: 1440, projection: 'flat'},
  '360': {width: 3840, height: 1920, projection: 'equirectangular'},
};

/** Resolve portable source references, then use the same validation as the UI. */
export function buildPlan(options, assets, jsonPlan) {
  let plan;
  if (jsonPlan !== undefined) {
    if (!jsonPlan || typeof jsonPlan !== 'object' || Array.isArray(jsonPlan)) throw argumentError('El plan JSON debe ser un objeto.');
    plan = structuredClone(jsonPlan);
    if (!Array.isArray(plan.clips)) throw argumentError('El plan JSON necesita clips.');
    plan.clips = plan.clips.map(clip => {
      if (!clip || typeof clip !== 'object' || Array.isArray(clip)) throw argumentError('Cada clip debe ser un objeto.');
      if (!Object.hasOwn(clip, 'sourceIndex')) return clip;
      if (Object.hasOwn(clip, 'assetId')) throw argumentError('Cada clip debe usar sourceIndex o assetId, no ambos.');
      if (!Number.isInteger(clip.sourceIndex) || clip.sourceIndex < 0 || clip.sourceIndex >= assets.length) throw argumentError('sourceIndex no corresponde a un vídeo importado.');
      const {sourceIndex, ...rest} = clip;
      return {...rest, assetId: assets[sourceIndex].id};
    });
  } else {
    plan = defaultPlan(assets);
    plan.output = {...plan.output, ...presets[options.format || 'landscape']};
    if (options.start !== undefined || options.end !== undefined) {
      if (assets.length !== 1) throw argumentError('--start y --end requieren un solo vídeo importado; usa --plan para varios segmentos.');
      const start = options.start ?? 0;
      plan.clips[0] = {...plan.clips[0], start, end: options.end ?? assets[0].duration};
    }
  }
  return validatePlan(plan, assets);
}

function safeMetadata(metadata) {
  const {model, firmware, dimension, fps, calibration, imu, limits} = metadata;
  return {model, firmware, dimension, fps, calibration, imu, limits};
}

export async function runCli(argv, {signal, stderr = text => process.stderr.write(text)} = {}) {
  const options = parseArguments(argv);
  if (options.command === 'help') return {ok: true, command: 'help', help};
  signal?.throwIfAborted();
  const environment = runtimeEnvironment();
  process.env.ORBIT_FFMPEG = environment.ORBIT_FFMPEG;
  process.env.ORBIT_FFPROBE = environment.ORBIT_FFPROBE;
  // Resolve the local multimedia runtime before media.js captures executable paths.
  const {importAssets, prepare, exportVideo} = await import('./media.js');
  const assets = await importAssets(options.inputs, 'equirectangular', []);
  signal?.throwIfAborted();
  if (options.command === 'inspect') {
    const {readInsvMetadata} = await import('./insv.js');
    const summaries = [];
    for (const [sourceIndex, asset] of assets.entries()) {
      signal?.throwIfAborted();
      let metadata, metadataError;
      if (asset.projection === 'insv') {
        try { metadata = safeMetadata(await readInsvMetadata(asset.paths[0], {signal})); }
        catch (error) { signal?.throwIfAborted(); metadataError = error.message; }
      }
      summaries.push({sourceIndex, assetId: asset.id, name: asset.name, paths: asset.paths, projection: asset.projection,
        duration: asset.duration, width: asset.width, height: asset.height, fps: asset.fps, codec: asset.codec,
        hasAudio: asset.hasAudio, sphericalProjection: asset.sphericalProjection,
        ...(metadata ? {metadata} : {}), ...(metadataError ? {metadataError} : {})});
    }
    return {ok: true, command: 'inspect', assets: summaries};
  }
  let jsonPlan;
  if (options.plan) {
    const file = await fs.open(options.plan, 'r');
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 1024 * 1024) throw argumentError('El plan debe ser un archivo JSON de hasta 1 MiB.');
      jsonPlan = JSON.parse(await file.readFile('utf8'));
    } finally { await file.close(); }
  }
  const plan = buildPlan(options, assets, jsonPlan);
  signal?.throwIfAborted();
  await fs.mkdir(options.output, {recursive: true});
  const directory = path.join(options.output, `orbit360-${randomUUID()}`);
  await fs.mkdir(directory); // Exclusive fresh directory isolates intermediates and prior exports.
  const progress = (percent, message) => stderr(`${JSON.stringify({event: 'progress', percent, message})}\n`);
  const prepared = [];
  for (const asset of assets) {
    signal?.throwIfAborted();
    if (plan.clips.some(clip => clip.assetId === asset.id)) prepared.push(await prepare(asset,
      {stitchBackend: 'open', stitchWidth: options.width ?? 3840}, path.join(directory, '.cache'), {signal, progress}));
    else prepared.push(asset);
  }
  signal?.throwIfAborted();
  const result = await exportVideo(plan, prepared, directory, {signal, progress});
  return {ok: true, command: 'render', directory, plan, result};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Trabajo cancelado.'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const result = await runCli(process.argv.slice(2), {signal: controller.signal});
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const cancelled = controller.signal.aborted;
    process.stdout.write(`${JSON.stringify({ok: false, error: {code: cancelled ? 'CANCELLED' : error.code || 'FAILED', message: error.message}})}\n`);
    process.exitCode = cancelled ? 130 : error.code === 'INVALID_ARGUMENTS' ? 2 : 1;
  } finally {
    process.removeListener('SIGINT', cancel);
    process.removeListener('SIGTERM', cancel);
  }
}
