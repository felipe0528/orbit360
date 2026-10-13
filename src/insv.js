// Orbit360's bounded INSV metadata reader. No vendor executable or library is used.
// Container fields and calibration conventions were cross-checked against:
// https://github.com/AdrianEddy/telemetry-parser/tree/a94d7ed06929eb9145411227c7f187189b96016f/src/insta360
// (MIT OR Apache-2.0), and three user-owned X2/X3/X4 recordings.
// Only the explicitly listed fields leave this reader; serial numbers and GPS do not.
import { open } from 'node:fs/promises';

const MAGIC = Buffer.from('8db42d694ccc418790edff439fe026bf');
const HEADER_BYTES = 72;
const MAX_METADATA_BYTES = 2 * 1024 * 1024;
const MAX_DIRECTORY_BYTES = 64 * 1024;
const MAX_RECORDS = 4096;
const MAX_TRAILER_BYTES = 2 ** 31;

function requireValue(condition, message) {
  if (!condition) throw new Error(`INSV: ${message}`);
}

async function readAt(file, position, size) {
  requireValue(Number.isSafeInteger(position) && position >= 0 && Number.isSafeInteger(size) && size >= 0,
    'posición o tamaño de lectura inválido.');
  const result = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await file.read(result, offset, size - offset, position + offset);
    requireValue(bytesRead > 0, 'archivo truncado.');
    offset += bytesRead;
  }
  return result;
}

function varint(data, state) {
  let value = 0n;
  for (let i = 0; i < 10; i++) {
    requireValue(state.offset < data.length, 'campo protobuf truncado.');
    const byte = data[state.offset++];
    if (i === 9) requireValue(byte <= 1, 'entero protobuf fuera de rango.');
    value |= BigInt(byte & 127) << BigInt(i * 7);
    if (!(byte & 128)) return value;
  }
  throw new Error('INSV: entero protobuf demasiado largo.');
}

// Unknown fields are skipped. Keeping byte slices here does not decode private strings.
function protobuf(data) {
  const fields = new Map();
  const state = { offset: 0 };
  let count = 0;
  while (state.offset < data.length) {
    requireValue(++count <= 10000, 'demasiados campos protobuf.');
    const key = varint(data, state);
    const wire = Number(key & 7n);
    const id = Number(key >> 3n);
    requireValue(Number.isSafeInteger(id) && id > 0 && id < 2 ** 29, 'identificador protobuf inválido.');
    let value;
    if (wire === 0) {
      const integer = varint(data, state);
      value = integer <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(integer) : integer;
    } else if (wire === 1 || wire === 5) {
      const size = wire === 1 ? 8 : 4;
      requireValue(state.offset + size <= data.length, 'número protobuf truncado.');
      value = wire === 1 ? data.readDoubleLE(state.offset) : data.readFloatLE(state.offset);
      state.offset += size;
    } else if (wire === 2) {
      const size = varint(data, state);
      requireValue(size <= BigInt(data.length - state.offset), 'cadena protobuf fuera de límites.');
      value = data.subarray(state.offset, state.offset + Number(size));
      state.offset += Number(size);
    } else {
      throw new Error('INSV: tipo protobuf no compatible.');
    }
    fields.set(id, value);
  }
  return fields;
}

function stringField(fields, id, maxLength = 16384) {
  const value = fields.get(id);
  if (value === undefined) return '';
  requireValue(Buffer.isBuffer(value) && value.length <= maxLength, 'cadena de metadatos inválida.');
  return value.toString('utf8');
}

function numberField(fields, id, fallback = 0) {
  const value = fields.get(id);
  if (value === undefined) return fallback;
  requireValue(typeof value === 'number' && Number.isFinite(value), 'valor numérico de metadatos inválido.');
  return value;
}

function messageField(fields, id) {
  const value = fields.get(id);
  if (value === undefined) return new Map();
  requireValue(Buffer.isBuffer(value), 'mensaje de metadatos inválido.');
  return protobuf(value);
}

function multiply(a, b) {
  const result = Array(9).fill(0);
  for (let row = 0; row < 3; row++) {
    for (let column = 0; column < 3; column++) {
      for (let k = 0; k < 3; k++) result[row * 3 + column] += a[row * 3 + k] * b[k * 3 + column];
    }
  }
  return result;
}

function transpose(a) { return [a[0], a[3], a[6], a[1], a[4], a[7], a[2], a[5], a[8]]; }

function rotation(axis, degrees) {
  const angle = degrees * Math.PI / 180;
  const c = Math.cos(angle), s = Math.sin(angle);
  if (axis === 'x') return [1, 0, 0, 0, c, -s, 0, s, c];
  if (axis === 'y') return [c, 0, s, 0, 1, 0, -s, 0, c];
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}

function cameraRotation([yaw, pitch, roll], index) {
  const angles = multiply(multiply(rotation('y', pitch + 90), rotation('z', yaw)), rotation('x', roll));
  return index === 0 ? multiply(angles, rotation('z', 180)) : angles;
}

const NOMINAL = cameraRotation([0, 0, 90], 0);

function parseNumbers(value, expected, version) {
  const parts = value.split('_');
  requireValue(parts.length === expected && parts.every(part => part.trim() !== ''), 'calibración de lente incompleta.');
  const numbers = parts.map(Number);
  requireValue(numbers.every(Number.isFinite), 'calibración con valores no finitos.');
  requireValue(numbers[0] === 2, 'se requieren exactamente dos lentes.');
  const flags = numbers.at(-1);
  requireValue(Number.isSafeInteger(flags) && flags >= 0 && Math.floor(flags / 65536) === version,
    'versión de calibración no compatible.');
  return numbers;
}

/** Normalize the clip's own v3/Mei Brown calibration into coded-frame pixels.
 * Rotation is a row-major 3×3 camera-to-rig matrix, with x right, y down, z forward.
 * A rig ray d is projected with transpose(rotation) * d.
 * No proprietary built-in lens tables, body masks, stabilization, or AI models are used.
 */
export function normalizeCalibration({ offsetV3, offset = '', dimension, crop }) {
  requireValue(typeof offsetV3 === 'string' && offsetV3.length > 0,
    'falta calibración v3; este motor necesita la calibración que contiene el archivo original.');
  const values = parseNumbers(offsetV3, 40, 3);
  const legacy = offset ? parseNumbers(offset, 16, 0) : null;
  const { width, height } = dimension;
  requireValue(Number.isInteger(width) && width >= 128 && width <= 16384 && width === height,
    'este motor admite pistas de ojo de pez cuadradas de hasta 16384 píxeles.');
  const frameWidth = values[17] / 2;
  const frameHeight = values[18];
  requireValue(frameWidth > 0 && frameHeight > 0 && frameWidth <= 32768 && frameHeight <= 32768,
    'dimensiones de calibración inválidas.');
  const cropWidth = crop.width, cropHeight = crop.height;
  requireValue(cropWidth > 0 && cropHeight > 0 && cropWidth <= frameWidth && cropHeight <= frameHeight,
    'ventana de captura incompatible.');
  requireValue(cropWidth === cropHeight && crop.sourceWidth === frameWidth && crop.sourceHeight === frameHeight,
    'ventana de captura desconocida; no se aplicará una calibración aproximada.');
  // The stored calibration is in the full sensor space; video is a centered crop.
  // X4: 8000×6000 → 5632×5632 → 3840×3840. X3: 5952² → 5760² → 2880².
  const scale = width / cropWidth;
  const mapX = (x, index) => (x - index * frameWidth - frameWidth / 2) * scale + width / 2;
  const mapY = y => (y - frameHeight / 2) * scale + height / 2;
  const lenses = [0, 1].map(index => {
    const start = 1 + index * 19;
    const p = values.slice(start, start + 19);
    requireValue(p[16] === frameWidth * 2 && p[17] === frameHeight,
      'las dos lentes no comparten el mismo espacio de calibración.');
    const [xi, fx, fy, cx, cy] = p;
    requireValue(xi > 1 && xi <= 5 && fx > 0 && fy > 0 && fx < frameWidth * 10 && fy < frameWidth * 10,
      'parámetros ópticos no compatibles.');
    requireValue(cx >= index * frameWidth && cx <= (index + 1) * frameWidth && cy >= 0 && cy <= frameHeight,
      'centro óptico fuera del sensor.');
    requireValue(p.slice(5, 8).every(angle => Math.abs(angle) <= 360) &&
      p.slice(8, 11).every(distance => Math.abs(distance) < 1) &&
      p.slice(11, 16).every(coefficient => Math.abs(coefficient) <= 100), 'calibración óptica fuera de rango.');
    let circle = null;
    if (legacy && legacy[13] === frameWidth * 2 && legacy[14] === frameHeight) {
      const i = 1 + index * 6;
      if (legacy[i] > 0 && legacy[i] <= Math.max(frameWidth, frameHeight)) {
        circle = { cx: mapX(legacy[i + 1], index), cy: mapY(legacy[i + 2]), radius: legacy[i] * scale };
      }
    }
    return {
      xi, fx: fx * scale, fy: fy * scale, cx: mapX(cx, index), cy: mapY(cy),
      distortion: p.slice(11, 16),
      rotation: multiply(NOMINAL, transpose(cameraRotation(p.slice(5, 8), index))),
      translation: p.slice(8, 11), circle, lensType: p[18],
      mirror: index === 0 && ((values.at(-1) >> 8) & 255) === 5,
    };
  });
  return { version: 3, frame: { width: frameWidth * 2, height: frameHeight }, crop: { ...crop }, lenses };
}

async function readMetadataPayload(file, fileSize) {
  requireValue(fileSize >= HEADER_BYTES + 6, 'archivo demasiado pequeño para contener metadatos.');
  const footer = await readAt(file, fileSize - HEADER_BYTES, HEADER_BYTES);
  requireValue(footer.subarray(40).equals(MAGIC),
    'sin metadatos de cámara; en grabaciones con dos archivos selecciona el archivo _00_.');
  const trailerSize = footer.readUInt32LE(32);
  requireValue(trailerSize >= HEADER_BYTES + 6 && trailerSize <= fileSize && trailerSize <= MAX_TRAILER_BYTES,
    'tamaño de metadatos fuera de límites.');
  const start = fileSize - trailerSize;
  const end = fileSize - HEADER_BYTES;
  let cursor = end - 6;
  const last = await readAt(file, cursor, 6);
  if (last[1] === 0) {
    const size = last.readUInt32LE(2);
    requireValue(size > 0 && size <= MAX_DIRECTORY_BYTES && size % 10 === 0 && cursor - size >= start,
      'directorio de metadatos inválido.');
    const directory = await readAt(file, cursor - size, size);
    let entry = null;
    for (let i = 0; i < size; i += 10) {
      const id = directory[i], format = directory[i + 1];
      const length = directory.readUInt32LE(i + 2), offset = directory.readUInt32LE(i + 6);
      if (id === 0) continue;
      requireValue(offset + length <= trailerSize - HEADER_BYTES, 'registro fuera de los metadatos.');
      if (id === 1) {
        requireValue(entry === null && format === 1 && length > 0 && length <= MAX_METADATA_BYTES,
          'registro de calibración inválido o duplicado.');
        entry = { position: start + offset, length };
      }
    }
    requireValue(entry !== null, 'el directorio no contiene calibración.');
    return readAt(file, entry.position, entry.length);
  }
  for (let count = 0; count < MAX_RECORDS && cursor >= start; count++) {
    const record = await readAt(file, cursor, 6);
    const format = record[0], id = record[1], length = record.readUInt32LE(2);
    requireValue(cursor - length >= start, 'registro truncado o fuera de límites.');
    if (id === 1) {
      requireValue(format === 1 && length > 0 && length <= MAX_METADATA_BYTES, 'registro de calibración inválido.');
      return readAt(file, cursor - length, length);
    }
    cursor -= length + 6;
  }
  throw new Error('INSV: no se encontró calibración dentro del límite de búsqueda.');
}

/** Read only safe technical metadata. Original recordings are opened read-only. */
export async function readInsvMetadata(path, { signal } = {}) {
  signal?.throwIfAborted();
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    requireValue(stat.isFile() && Number.isSafeInteger(stat.size), 'se esperaba un archivo regular.');
    const fields = protobuf(await readMetadataPayload(file, stat.size));
    signal?.throwIfAborted();
    const dimensions = messageField(fields, 19);
    const cropFields = messageField(fields, 27);
    const dimension = { width: numberField(dimensions, 1), height: numberField(dimensions, 2) };
    const crop = {
      sourceWidth: numberField(cropFields, 1), sourceHeight: numberField(cropFields, 2),
      width: numberField(cropFields, 3), height: numberField(cropFields, 4),
    };
    // Nonzero extra crop fields have not been validated; do not silently guess their meaning.
    for (const id of [5, 6]) requireValue(numberField(cropFields, id) === 0, 'desplazamiento de captura no compatible.');
    const calibration = normalizeCalibration({ offsetV3: stringField(fields, 54), offset: stringField(fields, 5), dimension, crop });
    const gyro = messageField(fields, 65);
    const streamType = numberField(fields, 131);
    return {
      model: stringField(fields, 2, 256), firmware: stringField(fields, 3, 256), dimension,
      fps: numberField(fields, 20), calibration: { ...calibration, streamType,
        layout: streamType === 2 ? 'files' : streamType === 4 ? 'reversed-tracks' : 'unspecified' },
      imu: {
        raw: numberField(fields, 62) !== 0,
        firstFrameTimestamp: numberField(fields, 24), gyroTimestamp: numberField(fields, 28),
        readoutTime: numberField(fields, 25), accRange: numberField(gyro, 1), gyroRange: numberField(gyro, 2),
      },
      limits: ['Sin estabilización IMU.', 'Sin corrección de paralaje ni de lente protectora.'],
    };
  } finally { await file.close(); }
}
