import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { run } from './process.js';
import { videoFilter, audioTempo, validatePlan } from './plan.js';
import { injectSphericalMetadata, stripSphericalMetadata } from './spherical.js';
import { stitchOpen, stitchDimensions, OPEN_STITCH_VERSION } from './stitch.js';

export const ffmpeg = process.env.ORBIT_FFMPEG || 'ffmpeg';
export const ffprobe = process.env.ORBIT_FFPROBE || 'ffprobe';
export async function probe(file) {
  const {stdout} = await run(ffprobe,['-v','error','-show_format','-show_streams','-of','json',file],{timeout:60000});
  const data = JSON.parse(stdout), videos = data.streams?.filter(s=>s.codec_type==='video'&&!s.disposition?.attached_pic) || [], video = videos[0];
  const duration = Math.min(...(path.extname(file).toLowerCase()==='.insv' ? videos : [video]).map(v=>Number(v?.duration || data.format?.duration)));
  if (!video || !Number.isFinite(duration) || duration <= 0) throw new Error('No se encontró un video con duración válida.');
  const [a,b] = (video.avg_frame_rate || '0/1').split('/').map(Number);
  const sphericalProjection=video.side_data_list?.find(item=>item.side_data_type==='Spherical Mapping')?.projection || null;
  return {duration,width:video.width,height:video.height,fps:b ? a/b : 0,hasAudio:data.streams.some(s=>s.codec_type==='audio'),codec:video.codec_name,sphericalProjection};
}
export async function importAssets(paths, projection, current) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 200) throw new Error('Indica entre 1 y 200 rutas de video.');
  if (!['flat','equirectangular'].includes(projection)) throw new Error('Selecciona la proyección de los MP4.');
  const additions = [];
  for (const requested of paths) {
    if (typeof requested !== 'string' || !path.isAbsolute(requested)) throw new Error('Usa rutas locales absolutas.');
    const file = await fs.realpath(requested);
    const ext = path.extname(file).toLowerCase();
    if (!['.insv','.mp4','.mov','.mkv'].includes(ext)) throw new Error('Solo se admiten INSV, MP4, MOV o MKV.');
    const stat = await fs.stat(file);
    if (!stat.isFile()) throw new Error('La ruta no es un archivo.');
    let pair = [file];
    if (ext === '.insv' && /_(00|10)_\d+\.insv$/i.test(file)) {
      const other = file.replace(/_(00|10)_(\d+\.insv)$/i,(_,lens,tail)=>`_${lens==='00'?'10':'00'}_${tail}`);
      try { if ((await fs.stat(other)).isFile()) pair.push(await fs.realpath(other)); } catch {}
    }
    pair.sort();
    const sourceStats=await Promise.all(pair.map(async source=>{const s=await fs.stat(source);return {size:s.size,mtimeMs:s.mtimeMs};}));
    const id = createHash('sha256').update(JSON.stringify({pair,sourceStats})).digest('hex').slice(0,20);
    if (current.some(a=>a.id===id) || additions.some(a=>a.id===id)) continue;
    const info = await probe(pair[0]);
    if (pair.length === 2) info.duration = Math.min(info.duration, (await probe(pair[1])).duration);
    additions.push({id,name:path.basename(pair[0]),paths:pair,sourceStats,...info,projection:ext==='.insv'?'insv':projection,ready:ext!=='.insv',size:stat.size});
  }
  return additions;
}
export async function scan(directory) {
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('Indica una carpeta absoluta.');
  const root = await fs.realpath(directory), queue = [root], paths = [];
  let inspected = 0;
  while (queue.length && paths.length < 200 && inspected < 30000) {
    const dir = queue.shift();
    let entries; try { entries = await fs.readdir(dir,{withFileTypes:true}); } catch { continue; }
    entries.sort((a,b)=>a.name.localeCompare(b.name));
    for (const item of entries) {
      if (++inspected > 30000 || paths.length >= 200) break;
      if (item.isSymbolicLink() || item.name.startsWith('.') || item.name.startsWith('$')) continue;
      if (item.isDirectory()) { if (!['System Volume Information','node_modules'].includes(item.name)) queue.push(path.join(dir,item.name)); }
      else if (item.isFile() && /\.insv$/i.test(item.name)) paths.push(path.join(dir,item.name));
    }
  }
  return {paths,truncated:queue.length>0 || paths.length>=200 || inspected>=30000,inspected};
}
export function mediaPath(asset) {
  if (asset.projection === 'insv') {
    if (!asset.ready || !asset.preparedPath) throw new Error('Prepara primero las dos lentes del archivo INSV.');
    return asset.preparedPath;
  }
  return asset.paths[0];
}
export async function prepare(asset, config, cacheDir, {signal, progress = () => {}} = {}) {
  for (let i=0;i<asset.paths.length;i++) {
    const stat=await fs.stat(asset.paths[i]), recorded=asset.sourceStats?.[i];
    if (recorded && (stat.size!==recorded.size || stat.mtimeMs!==recorded.mtimeMs)) throw new Error('El original cambió desde la importación. Vuelve a importarlo para evitar usar una copia antigua.');
  }
  if (asset.projection !== 'insv') return asset;
  const backend = config.stitchBackend || 'open';
  if (!['open','insta360'].includes(backend)) throw new Error('Motor de preparación desconocido.');
  const width = backend === 'open' ? stitchDimensions(config.stitchWidth).width : 3840;
  const engine = backend === 'open' ? OPEN_STITCH_VERSION : 'insta360-1';
  const cacheKey = `${asset.id}-${engine}-${width}`;
  if (asset.ready && asset.preparedPath && asset.preparedKey === cacheKey) { try { await fs.access(asset.preparedPath); return backend === 'open' ? {...asset,duration:Math.min(asset.duration,asset.preparedInfo.duration)} : asset; } catch {} }
  await fs.mkdir(cacheDir,{recursive:true});
  const output = path.join(cacheDir,`${cacheKey}.mp4`);
  const temporary = path.join(cacheDir,`${cacheKey}.partial.mp4`);
  await fs.rm(temporary,{force:true});
  if (backend === 'open') {
    try {
      const stitching = await stitchOpen(asset, temporary, {width, ffmpeg, ffprobe, signal, progress});
      const info = await probe(temporary);
      if (info.width !== width || info.height !== width / 2 || Math.abs(info.duration - stitching.duration) > Math.max(0.1, 2 / info.fps)) throw new Error('El motor abierto produjo una panorámica incompleta.');
      await fs.rename(temporary,output);
      return {...asset,duration:Math.min(asset.duration,info.duration),ready:true,preparedPath:output,preparedKey:cacheKey,preparedInfo:info,stitching};
    } catch (error) { await fs.rm(temporary,{force:true}).catch(()=>{}); throw error; }
  }
  if (!config.sdkExecutable) throw new Error('SDK sin configurar. Ejecuta scripts/setup-sdk.ps1 con tu ZIP de Insta360.');
  const args = config.sdkKind === 'sample'
    ? ['-inputs',...asset.paths,'-output',temporary,'-output_size','3840x1920','-enable_flowstate','-stitch_type','optflow','-camera_accessory_type','-1',...(config.sdkModels?['-model_root_dir',config.sdkModels + path.sep]:[])]
    : [...asset.paths.flatMap(p=>['--input',p]),'--output',temporary,'--width','3840','--height','1920','--flowstate','1','--direction-lock','0',...(config.sdkRoot?['--sdk-root',config.sdkRoot]:[]),...(config.sdkModels?['--models',config.sdkModels]:[])];
  try {
    const result = await run(config.sdkExecutable,args,{cwd:path.dirname(config.sdkExecutable),signal,timeout:6*3600000,onLine:line=>{
      if (line.startsWith('ORBIT360_JSON ')) { try { const event=JSON.parse(line.slice(14)); if (typeof event.percent==='number') progress(event.percent,'Uniendo lentes y aplicando FlowState…'); } catch {} }
      const match=line.match(/(?:progress|process)\s*[:=]?\s*(\d+(?:\.\d+)?)/i); if(match) progress(Math.min(99,Number(match[1])),'Preparando INSV…');
    }});
    if (/stitch\s*(?:failed|error)|error\s*code\s*[:=]\s*[1-9]/i.test(result.stdout)) throw new Error(`El SDK informó un error: ${result.stdout.slice(-1500)}`);
    if (config.sdkKind==='sample' && !/process\s*=\s*100%/.test(result.stdout)) throw new Error('El ejecutable del SDK no confirmó que terminara el 100 % del proceso.');
    const info=await probe(temporary);
    if (info.width !== info.height * 2 || info.duration < asset.duration * 0.95) throw new Error('El SDK produjo una salida incompleta o no panorámica.');
    await fs.rename(temporary,output);
    return {...asset,ready:true,preparedPath:output,preparedKey:cacheKey,preparedInfo:info,stitching:{backend:'insta360',engine,stabilized:true}};
  } catch (error) { await fs.rm(temporary,{force:true}).catch(()=>{}); throw error; }
}
export async function exportVideo(plan, assets, directory, {signal, progress}) {
  plan=validatePlan(plan,assets);
  await fs.mkdir(directory,{recursive:true});
  const total=plan.clips.reduce((s,c)=>s+(c.end-c.start)/c.speed,0);
  let completed=0;
  for (let i=0;i<plan.clips.length;i++) {
    const clip=plan.clips[i], asset=assets.find(a=>a.id===clip.assetId), duration=(clip.end-clip.start)/clip.speed;
    const input=mediaPath(asset), hasAudio=(asset.preparedInfo || asset).hasAudio && !clip.mute;
    const args=['-hide_banner','-nostdin','-y','-ss',String(clip.start),'-t',String(clip.end-clip.start),'-i',input];
    if (!hasAudio) args.push('-f','lavfi','-i','anullsrc=r=48000:cl=stereo');
    args.push('-map','0:v:0','-map',hasAudio?'0:a:0':'1:a:0','-vf',videoFilter(clip,plan.output,asset.projection));
    args.push('-af',hasAudio?`${audioTempo(clip.speed)},aresample=48000,apad`:'anull','-t',String(duration),'-c:v','libx264','-preset','fast','-crf','20','-c:a','aac','-b:a','192k','-ar','48000','-ac','2','-video_track_timescale','90000','-map_metadata','-1','-movflags','+faststart','-progress','pipe:1','-loglevel','error',path.join(directory,`segment-${i}.mp4`));
    await run(ffmpeg,args,{signal,timeout:6*3600000,onLine:line=>{
      const match=line.match(/^out_time_us=(\d+)$/); if(match) progress(Math.min(96,(completed+Number(match[1])/1e6)/total*96),`Exportando plano ${i+1} de ${plan.clips.length}…`);
    }});
    completed+=duration;
  }
  await fs.writeFile(path.join(directory,'concat.txt'),plan.clips.map((_,i)=>`file 'segment-${i}.mp4'`).join('\n'));
  const output=path.join(directory,'export.mp4'), intermediate=path.join(directory,'export.unmarked.mp4');
  await run(ffmpeg,['-hide_banner','-nostdin','-y','-f','concat','-safe','1','-i',path.join(directory,'concat.txt'),'-c','copy','-movflags','+faststart',intermediate],{signal,timeout:3600000});
  const isSpherical=plan.output.projection==='equirectangular';
  progress(97,isSpherical?'Añadiendo metadatos 360° para YouTube…':'Finalizando el MP4…');
  const metadata=isSpherical
    ? await injectSphericalMetadata(intermediate,output,{width:plan.output.width,height:plan.output.height,signal})
    : await stripSphericalMetadata(intermediate,output,{signal});
  const info=await probe(output);
  if (Math.abs(info.duration-total)>Math.max(0.5,plan.clips.length/plan.output.fps*2)) throw new Error('La duración exportada no coincide con el montaje.');
  if (info.width!==plan.output.width || info.height!==plan.output.height) throw new Error('Las dimensiones exportadas no coinciden con el montaje.');
  if (isSpherical && info.sphericalProjection!=='equirectangular') throw new Error('ffprobe no reconoció la proyección 360° del MP4 final.');
  if (!isSpherical && info.sphericalProjection) throw new Error('El vídeo plano conserva una marca 360° no válida.');
  await fs.writeFile(path.join(directory,'plan.json'),JSON.stringify(plan,null,2));
  for (let i=0;i<plan.clips.length;i++) await fs.rm(path.join(directory,`segment-${i}.mp4`),{force:true});
  await fs.rm(intermediate,{force:true});
  return {path:output,...info,...(isSpherical?{spherical:{...metadata,verified:true}}:{})};
}
export async function frame(asset,{time=0,yaw=0,pitch=0,fov=90,width=480,height=270,projection='flat'},destination,{signal}={}) {
  for (const [value,min,max] of [[time,0,asset.duration],[yaw,-180,180],[pitch,-89,89],[fov,30,150]]) if(!Number.isFinite(value)||value<min||value>max) throw new Error('Parámetro de vista previa no válido.');
  for(const dimension of [width,height])if(!Number.isFinite(dimension)||dimension<128||dimension>4096)throw new Error('Dimensiones de vista previa no válidas.');
  if(!['flat','equirectangular'].includes(projection))throw new Error('Proyección de vista previa no válida.');
  const scale=Math.min(480/width,480/height,1);
  const filter=videoFilter({speed:1,yaw,pitch,fov},{width:Math.max(2,Math.round(width*scale/2)*2),height:Math.max(2,Math.round(height*scale/2)*2),fps:30,projection},asset.projection);
  await run(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y','-ss',String(Math.min(time,Math.max(0,asset.duration-0.1))),'-i',mediaPath(asset),'-vf',filter,'-frames:v','1',destination],{signal});
}
