const num = {type: 'number'};
export const planSchema = {
  type: 'object', additionalProperties: false, required: ['version','title','explanation','output','clips'],
  properties: {
    version: {type: 'integer', enum: [1]}, title: {type: 'string'}, explanation: {type: 'string'},
    output: {type: 'object', additionalProperties: false, required: ['width','height','fps','projection'], properties: {
      width: {type: 'integer'}, height: {type: 'integer'}, fps: {type: 'integer'}, projection: {type: 'string', enum: ['flat','equirectangular']}
    }},
    clips: {type: 'array', items: {type:'object', additionalProperties:false, required: ['assetId','start','end','yaw','pitch','fov','speed','mute'], properties: {
      assetId: {type:'string'}, start:num, end:num, yaw:num, pitch:num, fov:num, speed:num, mute:{type:'boolean'}
    }}}
  }
};

function keys(object, allowed, name) {
  if (!object || typeof object !== 'object' || Array.isArray(object) || Object.keys(object).some(k => !allowed.includes(k)) || allowed.some(k => !(k in object))) throw new Error(`${name}: campos no válidos.`);
}
function bounded(value, min, max, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${name}: debe estar entre ${min} y ${max}.`);
}
export function validatePlan(plan, assets) {
  keys(plan,['version','title','explanation','output','clips'],'Plan');
  if (plan.version !== 1 || typeof plan.title !== 'string' || !plan.title.trim() || plan.title.length > 150 || typeof plan.explanation !== 'string' || plan.explanation.length > 8000) throw new Error('Título, versión o explicación no válidos.');
  keys(plan.output,['width','height','fps','projection'],'Salida');
  const {width,height,fps,projection} = plan.output;
  for (const n of [width,height]) if (!Number.isInteger(n) || n < 128 || n > 4096 || n % 2) throw new Error('Dimensiones pares entre 128 y 4096.');
  if (![24,25,30,50,60].includes(fps) || !['flat','equirectangular'].includes(projection)) throw new Error('FPS o proyección no válidos.');
  if (projection === 'equirectangular' && width !== height * 2) throw new Error('La salida panorámica debe tener proporción 2:1.');
  if (!Array.isArray(plan.clips) || !plan.clips.length || plan.clips.length > 100) throw new Error('El montaje necesita entre 1 y 100 planos.');
  let total = 0;
  for (const clip of plan.clips) {
    keys(clip,['assetId','start','end','yaw','pitch','fov','speed','mute'],'Plano');
    const asset = assets.find(a => a.id === clip.assetId);
    if (!asset) throw new Error('El plan hace referencia a un archivo no importado.');
    bounded(clip.start,0,asset.duration,'Inicio'); bounded(clip.end,0,asset.duration + 0.03,'Fin');
    if (clip.end - clip.start < 0.1 - 1e-9) throw new Error('Cada plano debe durar al menos 0,1 segundos.');
    bounded(clip.yaw,-180,180,'Giro'); bounded(clip.pitch,-89,89,'Inclinación'); bounded(clip.fov,30,150,'Campo visual'); bounded(clip.speed,0.25,4,'Velocidad');
    if (typeof clip.mute !== 'boolean') throw new Error('Silencio debe ser booleano.');
    if (projection === 'equirectangular' && asset.projection === 'flat') throw new Error('Un video plano no puede convertirse en una esfera 360 real.');
    total += (clip.end - clip.start) / clip.speed;
  }
  if (total > 3600) throw new Error('Esta versión admite montajes de hasta una hora.');
  return structuredClone(plan);
}
export function defaultPlan(assets) {
  return {version:1,title:'Mi montaje 360',explanation:'Plan inicial editable. Ajusta los cortes y el encuadre antes de exportar.',output:{width:1920,height:1080,fps:30,projection:'flat'},clips:assets.slice(0,100).map(a=>({assetId:a.id,start:0,end:Math.min(a.duration,5),yaw:0,pitch:0,fov:90,speed:1,mute:false}))};
}
export function videoFilter(clip, output, projection) {
  const {width,height,fps} = output;
  const filters = [`setpts=(PTS-STARTPTS)/${clip.speed}`];
  if (projection !== 'flat' && output.projection === 'flat') {
    const verticalFov = 2 * Math.atan(Math.tan(clip.fov * Math.PI / 360) * height / width) * 180 / Math.PI;
    filters.push(`v360=input=equirect:output=flat:w=${width}:h=${height}:yaw=${clip.yaw}:pitch=${clip.pitch}:h_fov=${clip.fov}:v_fov=${verticalFov.toFixed(6)}`);
  } else filters.push(`scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2`,`pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`);
  filters.push(`fps=${fps}`,'setsar=1','format=yuv420p');
  return filters.join(',');
}
export function audioTempo(speed) {
  const result = [];
  while (speed < 0.5) { result.push('atempo=0.5'); speed /= 0.5; }
  while (speed > 2) { result.push('atempo=2'); speed /= 2; }
  result.push(`atempo=${speed}`);
  return result.join(',');
}
