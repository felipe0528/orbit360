import fs from 'node:fs/promises';
import path from 'node:path';

// Independent implementation of the public Google Spatial Media specifications:
// https://github.com/google/spatial-media/blob/master/docs/spherical-video-rfc.md
// https://github.com/google/spatial-media/blob/master/docs/spherical-video-v2-rfc.md
// Only the bounded movie index is held in memory; media bytes are copied unchanged.
const SPHERICAL_UUID = Buffer.from('ffcc8263f8554a938814587a02521fdd', 'hex');
const MAX_MOOV = 64 * 1024 * 1024;
const MAX_BOXES = 100000;
const UINT32_MAX = 0xffffffffn;
const VIDEO_ENTRIES = new Set(['avc1', 'avc3', 'hvc1', 'hev1', 'av01', 'vp09', 'mp4v']);
const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts', 'dinf', 'udta']);

function fail(message) { throw new Error(`Metadatos 360°: ${message}`); }
function checkAbort(signal) { signal?.throwIfAborted(); }

async function readExact(handle, size, position, signal) {
  const result = Buffer.allocUnsafe(size);
  for (let done = 0; done < size;) {
    checkAbort(signal);
    const {bytesRead} = await handle.read(result, done, size - done, position + done);
    if (!bytesRead) fail('el archivo MP4 está truncado.');
    done += bytesRead;
  }
  return result;
}

function decodeHeader(buffer, offset, end) {
  if (end - offset < 8) fail('cabecera de caja MP4 incompleta.');
  const shortSize = buffer.readUInt32BE(offset);
  const type = buffer.toString('latin1', offset + 4, offset + 8);
  const headerSize = shortSize === 1 ? 16 : 8;
  if (end - offset < headerSize) fail('cabecera extendida incompleta.');
  const longSize = shortSize === 1 ? buffer.readBigUInt64BE(offset + 8) : BigInt(shortSize || end - offset);
  if (longSize > BigInt(Number.MAX_SAFE_INTEGER)) fail('tamaño fuera del rango seguro.');
  const size = Number(longSize);
  if (size < headerSize || size > end - offset) fail(`tamaño inválido en la caja ${type}.`);
  return {type, size, headerSize};
}

async function topLevel(handle, size, signal) {
  const boxes = [];
  for (let offset = 0; offset < size;) {
    if (boxes.length >= MAX_BOXES) fail('demasiadas cajas MP4.');
    if (size - offset < 8) fail('cabecera final incompleta.');
    const bytes = await readExact(handle, Math.min(16, size - offset), offset, signal);
    // The header decoder needs the file boundary, but reads only header bytes.
    const header = decodeHeader(bytes, 0, size - offset);
    boxes.push({...header, offset, end: offset + header.size});
    offset += header.size;
  }
  return boxes;
}

function parseBoxes(buffer, start = 0, end = buffer.length, state = {count: 0}, depth = 0) {
  if (depth > 12) fail('jerarquía MP4 demasiado profunda.');
  const nodes = [];
  for (let offset = start; offset < end;) {
    if (++state.count > MAX_BOXES) fail('demasiadas cajas en el índice MP4.');
    const header = decodeHeader(buffer, offset, end);
    const node = {type: header.type, extended: header.headerSize === 16};
    const bodyStart = offset + header.headerSize, bodyEnd = offset + header.size;
    let prefixLength;
    if (CONTAINERS.has(node.type)) prefixLength = 0;
    else if (node.type === 'stsd' || node.type === 'dref') prefixLength = 8;
    else if (node.type === 'meta') prefixLength = 4;
    else if (VIDEO_ENTRIES.has(node.type)) prefixLength = 78;
    if (prefixLength !== undefined) {
      if (bodyEnd - bodyStart < prefixLength) fail(`caja ${node.type} incompleta.`);
      node.prefix = buffer.subarray(bodyStart, bodyStart + prefixLength);
      node.children = parseBoxes(buffer, bodyStart + prefixLength, bodyEnd, state, depth + 1);
      if ((node.type === 'stsd' || node.type === 'dref') && node.prefix.readUInt32BE(4) !== node.children.length) fail(`cantidad de entradas inválida en ${node.type}.`);
    } else node.payload = buffer.subarray(bodyStart, bodyEnd);
    nodes.push(node);
    offset = bodyEnd;
  }
  return nodes;
}

function oneChild(node, type) {
  const items = node?.children?.filter(child => child.type === type) || [];
  if (items.length !== 1) fail(`se esperaba una caja ${type}.`);
  return items[0];
}

function visit(node, callback) {
  callback(node);
  for (const child of node.children || []) visit(child, callback);
}

function isSphericalUuid(node) {
  return node.type === 'uuid' && node.payload?.length >= 16 && node.payload.subarray(0, 16).equals(SPHERICAL_UUID);
}

function videoTracks(moov) {
  const tracks = [];
  for (const track of moov.children.filter(child => child.type === 'trak')) {
    const media = oneChild(track, 'mdia');
    const handler = oneChild(media, 'hdlr');
    if (handler.payload.length < 12) fail('identificador de pista incompleto.');
    if (handler.payload.toString('ascii', 8, 12) !== 'vide') continue;
    const descriptions = oneChild(oneChild(oneChild(media, 'minf'), 'stbl'), 'stsd');
    tracks.push({track, entries: descriptions.children});
  }
  return tracks;
}

async function loadMovie(handle, signal) {
  const stat = await handle.stat();
  if (!stat.isFile() || !Number.isSafeInteger(stat.size)) fail('se requiere un archivo MP4 local de tamaño válido.');
  const boxes = await topLevel(handle, stat.size, signal);
  if (boxes.some(box => ['moof', 'mfra', 'sidx'].includes(box.type))) fail('los MP4 fragmentados o con índices de segmentos no son compatibles.');
  const movies = boxes.filter(box => box.type === 'moov');
  const media = boxes.filter(box => box.type === 'mdat');
  if (movies.length !== 1 || !media.length) fail('se requiere un MP4 con un índice moov y datos mdat.');
  const movie = movies[0];
  if (movie.size > MAX_MOOV) fail('el índice moov supera el límite de 64 MiB.');
  const [moov] = parseBoxes(await readExact(handle, movie.size, movie.offset, signal));
  visit(moov, node => {
    if (['mvex', 'cmov', 'saio', 'iloc'].includes(node.type)) fail(`la estructura ${node.type} no es compatible.`);
  });
  return {boxes, movie, media, moov, stat};
}

function box(type, payload) { return {type, payload, extended: false}; }
function container(type, children) { return {type, prefix: Buffer.alloc(0), children, extended: false}; }

function sphericalV1(width, height) {
  const fields = {
    Spherical: 'true', Stitched: 'true', StitchingSoftware: 'Orbit360',
    ProjectionType: 'equirectangular', StereoMode: 'mono',
    FullPanoWidthPixels: width, FullPanoHeightPixels: height,
    CroppedAreaImageWidthPixels: width, CroppedAreaImageHeightPixels: height,
    CroppedAreaLeftPixels: 0, CroppedAreaTopPixels: 0,
  };
  const xml = '<rdf:SphericalVideo xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:GSpherical="http://ns.google.com/videos/1.0/spherical/">' +
    Object.entries(fields).map(([key, value]) => `<GSpherical:${key}>${value}</GSpherical:${key}>`).join('') + '</rdf:SphericalVideo>';
  return box('uuid', Buffer.concat([SPHERICAL_UUID, Buffer.from(xml, 'utf8')]));
}

function sphericalV2() {
  return [
    box('st3d', Buffer.alloc(5)), // FullBox v0, flags 0, monoscopic (0).
    container('sv3d', [
      box('svhd', Buffer.concat([Buffer.alloc(4), Buffer.from('Orbit360\0')])),
      container('proj', [box('prhd', Buffer.alloc(16)), box('equi', Buffer.alloc(20))]),
    ]),
  ];
}

function serialize(node) {
  const body = node.children ? Buffer.concat([node.prefix, ...node.children.map(serialize)]) : node.payload;
  const header = Buffer.alloc(node.extended ? 16 : 8);
  const size = header.length + body.length;
  if (size > MAX_MOOV) fail('el índice modificado supera el límite de 64 MiB.');
  header.writeUInt32BE(node.extended ? 1 : size);
  header.write(node.type, 4, 4, 'latin1');
  if (node.extended) header.writeBigUInt64BE(BigInt(size), 8);
  return Buffer.concat([header, body]);
}

function collectOffsets(moov, media) {
  const tables = [];
  visit(moov, node => {
    if (node.type !== 'stco' && node.type !== 'co64') return;
    const bytes = node.type === 'stco' ? 4 : 8;
    if (node.payload.length < 8 || node.payload.readUInt32BE(0) !== 0) fail('tabla de offsets inválida.');
    const count = node.payload.readUInt32BE(4);
    if (node.payload.length !== 8 + count * bytes) fail('tabla de offsets incompleta.');
    const values = [];
    for (let index = 0; index < count; index++) {
      const position = 8 + index * bytes;
      const value = bytes === 4 ? BigInt(node.payload.readUInt32BE(position)) : node.payload.readBigUInt64BE(position);
      if (!media.some(box => value >= BigInt(box.offset + box.headerSize) && value < BigInt(box.end))) fail('un offset de pista apunta fuera de los datos mdat locales.');
      values.push(value);
    }
    tables.push({node, values});
  });
  if (!tables.length) fail('el MP4 no contiene tablas de offsets compatibles.');
  return tables;
}

function rewriteOffsets(moov, movie, tables) {
  let delta = 0;
  // Promoting stco to co64 can grow moov again. Converge against the original
  // offsets, never against an already adjusted table (including audio tracks).
  for (let iteration = 0; iteration < tables.length + 3; iteration++) {
    for (const {node, values} of tables) {
      const updated = values.map(value => value >= BigInt(movie.end) ? value + BigInt(delta) : value);
      if (updated.some(value => value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER))) fail('offset resultante fuera del rango seguro.');
      if (node.type === 'stco' && updated.some(value => value > UINT32_MAX)) node.type = 'co64';
      const bytes = node.type === 'stco' ? 4 : 8;
      node.payload = Buffer.alloc(8 + updated.length * bytes);
      node.payload.writeUInt32BE(updated.length, 4);
      updated.forEach((value, index) => {
        if (bytes === 4) node.payload.writeUInt32BE(Number(value), 8 + index * bytes);
        else node.payload.writeBigUInt64BE(value, 8 + index * bytes);
      });
    }
    const encoded = serialize(moov), nextDelta = encoded.length - movie.size;
    if (nextDelta === delta) return encoded;
    delta = nextDelta;
  }
  fail('no fue posible estabilizar los offsets de las pistas.');
}

async function writeAll(handle, bytes, signal) {
  for (let done = 0; done < bytes.length;) {
    checkAbort(signal);
    const {bytesWritten} = await handle.write(bytes, done, bytes.length - done);
    if (!bytesWritten) fail('no fue posible escribir el MP4.');
    done += bytesWritten;
  }
}

async function copyRange(source, target, start, size, scratch, signal) {
  for (let copied = 0; copied < size;) {
    checkAbort(signal);
    const amount = Math.min(scratch.length, size - copied);
    const {bytesRead} = await source.read(scratch, 0, amount, start + copied);
    if (!bytesRead) fail('los datos multimedia están truncados.');
    await writeAll(target, scratch.subarray(0, bytesRead), signal);
    copied += bytesRead;
  }
}

function validateEntries(tracks) {
  if (tracks.length !== 1) fail('se requiere exactamente una pista de video.');
  if (!tracks[0].entries.length) fail('la pista de video no tiene descripción.');
  for (const entry of tracks[0].entries) if (!VIDEO_ENTRIES.has(entry.type)) fail(`el códec ${entry.type} no es compatible.`);
  return tracks[0];
}

async function rewriteMetadata(input, output, {width, height, signal} = {}, spherical) {
  checkAbort(signal);
  if (path.resolve(input) === path.resolve(output)) fail('la salida debe ser distinta del original.');
  if (spherical && (!Number.isInteger(width) || !Number.isInteger(height) || height <= 0 || width !== height * 2 || width > 65535)) fail('el video 360° completo debe tener dimensiones válidas en proporción 2:1.');
  let source, target, created = false;
  try {
    source = await fs.open(input, 'r');
    const movie = await loadMovie(source, signal);
    const {track, entries} = validateEntries(videoTracks(movie.moov));
    const offsets = collectOffsets(movie.moov, movie.media);
    if (spherical) for (const entry of entries) {
      if (entry.prefix.readUInt16BE(24) !== width || entry.prefix.readUInt16BE(26) !== height) fail('las dimensiones solicitadas no coinciden con el video codificado.');
    }
    track.children = track.children.filter(node => !isSphericalUuid(node));
    if (spherical) track.children.push(sphericalV1(width, height));
    for (const entry of entries) {
      entry.children = entry.children.filter(node => !['st3d', 'sv3d'].includes(node.type));
      if (spherical) {
        const optional = entry.children.findIndex(node => ['clap', 'pasp', 'btrt'].includes(node.type));
        entry.children.splice(optional < 0 ? entry.children.length : optional, 0, ...sphericalV2());
      }
    }
    const encoded = rewriteOffsets(movie.moov, movie.movie, offsets);
    checkAbort(signal);
    target = await fs.open(output, 'wx');
    created = true;
    const scratch = Buffer.allocUnsafe(1024 * 1024);
    for (const box of movie.boxes) {
      if (box.type === 'moov') await writeAll(target, encoded, signal);
      else await copyRange(source, target, box.offset, box.size, scratch, signal);
    }
    const after = await source.stat();
    if (after.size !== movie.stat.size || after.mtimeMs !== movie.stat.mtimeMs) fail('el archivo de origen cambió durante la escritura.');
    await target.close(); target = undefined;
    checkAbort(signal);
    const inspection = await inspectSphericalMetadata(output);
    if (spherical && (!inspection.spherical || inspection.metadataVersions.length !== 2)) fail('no se pudo verificar la señalización esférica.');
    if (!spherical && (inspection.v1Count || inspection.v2Count || inspection.stereoBoxCount)) fail('no se pudo eliminar la señalización esférica.');
    return inspection;
  } catch (error) {
    await target?.close().catch(() => {});
    if (created) await fs.rm(output, {force: true}).catch(() => {});
    throw error;
  } finally { await source?.close(); }
}

/** Add mono, full-sphere V1 + V2 metadata to an already stitched 2:1 MP4.
 * Does not stitch or project pixels. Never overwrites either input or output.
 * Accepts non-fragmented MP4 with local stco/co64 media and one video track.
 */
export async function injectSphericalMetadata(input, output, options) {
  return rewriteMetadata(input, output, options, true);
}

/** Remove inherited spherical/stereo signalling after rendering a flat video. */
export async function stripSphericalMetadata(input, output, options) {
  return rewriteMetadata(input, output, options, false);
}

function v1Valid(node, width, height) {
  const xml = node.payload.subarray(16).toString('utf8');
  const read = name => xml.match(new RegExp(`<GSpherical:${name}>\\s*([^<]+?)\\s*</GSpherical:${name}>`))?.[1];
  return xml.includes('xmlns:GSpherical="http://ns.google.com/videos/1.0/spherical/"') &&
    read('Spherical') === 'true' && read('Stitched') === 'true' && Boolean(read('StitchingSoftware')) &&
    read('ProjectionType') === 'equirectangular' && (read('StereoMode') || 'mono') === 'mono' &&
    Number(read('FullPanoWidthPixels') || width) === width && Number(read('FullPanoHeightPixels') || height) === height &&
    Number(read('CroppedAreaImageWidthPixels') || width) === width && Number(read('CroppedAreaImageHeightPixels') || height) === height &&
    Number(read('CroppedAreaLeftPixels') || 0) === 0 && Number(read('CroppedAreaTopPixels') || 0) === 0;
}

function v2Valid(entry) {
  const stereo = entry.children.filter(node => node.type === 'st3d');
  const spherical = entry.children.filter(node => node.type === 'sv3d');
  if (stereo.length !== 1 || spherical.length !== 1 || stereo[0].payload.length !== 5 || !stereo[0].payload.equals(Buffer.alloc(5))) return false;
  try {
    // sv3d/proj are deliberately opaque during rewrite, so unknown future
    // metadata remains untouched unless explicitly removed or replaced.
    const sv3d = {children: parseBoxes(spherical[0].payload)};
    const header = oneChild(sv3d, 'svhd').payload;
    if (header.length < 5 || header.readUInt32BE(0) !== 0 || header.at(-1) !== 0) return false;
    const projection = {children: parseBoxes(oneChild(sv3d, 'proj').payload)};
    const orientation = oneChild(projection, 'prhd').payload;
    const equi = oneChild(projection, 'equi').payload;
    return orientation.length === 16 && orientation.equals(Buffer.alloc(16)) &&
      equi.length === 20 && equi.equals(Buffer.alloc(20)) && projection.children.length === 2;
  } catch { return false; }
}

/** Inspect signalling only; this does not prove that the pixels depict a sphere
 * or that a remote service has completed processing an uploaded video. */
export async function inspectSphericalMetadata(file) {
  const handle = await fs.open(file, 'r');
  try {
    const {moov, movie, media} = await loadMovie(handle);
    const tracks = videoTracks(moov);
    const {track, entries} = validateEntries(tracks);
    const width = entries[0].prefix.readUInt16BE(24), height = entries[0].prefix.readUInt16BE(26);
    const matchingDimensions = entries.every(entry => entry.prefix.readUInt16BE(24) === width && entry.prefix.readUInt16BE(26) === height);
    const uuids = track.children.filter(isSphericalUuid);
    const v1 = matchingDimensions && width === height * 2 && uuids.length === 1 && v1Valid(uuids[0], width, height);
    const v2 = matchingDimensions && width === height * 2 && entries.every(v2Valid);
    const versions = [v1 ? 1 : null, v2 ? 2 : null].filter(Boolean);
    const spherical = versions.length > 0;
    return {
      spherical, projection: spherical ? 'equirectangular' : null, stereoMode: spherical ? 'mono' : null,
      metadataVersions: versions, width, height, videoTracks: tracks.length,
      fastStart: movie.offset < media[0].offset,
      v1Count: uuids.length,
      v2Count: entries.reduce((sum, entry) => sum + entry.children.filter(node => node.type === 'sv3d').length, 0),
      stereoBoxCount: entries.reduce((sum, entry) => sum + entry.children.filter(node => node.type === 'st3d').length, 0),
    };
  } finally { await handle.close(); }
}
