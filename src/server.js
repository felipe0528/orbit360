import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes, randomUUID } from 'node:crypto';
import { run, codexCommand } from './process.js';
import { importAssets, scan, probe, prepare, exportVideo, frame, mediaPath, ffmpeg, ffprobe } from './media.js';
import { validatePlan, defaultPlan } from './plan.js';
import { planWithCodex } from './planner.js';
import { OPEN_STITCH_VERSION, stitchDimensions } from './stitch.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const json=(res,value,status=200)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
async function body(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new Error('Se requiere JSON.');
  let value=''; for await(const chunk of req) { value+=chunk; if(value.length>1024*1024) throw new Error('Solicitud demasiado grande.'); }
  return JSON.parse(value || '{}');
}
export async function createApp({dataDir=process.env.ORBIT_DATA_DIR || path.join(root,'.local'),port=Number(process.env.PORT || 3600),detect=true}={}) {
  dataDir=path.resolve(dataDir); await fs.mkdir(dataDir,{recursive:true});
  const token=randomBytes(32).toString('hex'), controllers=new Map();
  let state={assets:[],plan:null,jobs:[]}, config={};
  try { state=JSON.parse(await fs.readFile(path.join(dataDir,'project.json'),'utf8')); } catch(error) { if(error.code!=='ENOENT') throw new Error('project.json no es legible; conserva una copia y repáralo antes de iniciar.'); }
  try { config=JSON.parse(await fs.readFile(path.join(dataDir,'config.json'),'utf8')); } catch(error) { if(error.code!=='ENOENT') throw error; }
  if(process.env.ORBIT_SDK_EXE) config={...config,sdkExecutable:process.env.ORBIT_SDK_EXE,sdkKind:process.env.ORBIT_SDK_KIND || 'bridge',sdkModels:process.env.ORBIT_SDK_MODELS || config.sdkModels};
  config.stitchBackend=process.env.ORBIT_STITCH_BACKEND || config.stitchBackend || 'open';
  if(process.env.ORBIT_STITCH_WIDTH) config.stitchWidth=Number(process.env.ORBIT_STITCH_WIDTH);
  const stitchWidth=stitchDimensions(config.stitchWidth).width;
  for(const job of state.jobs) if(['queued','running'].includes(job.status)) Object.assign(job,{status:'failed',error:'La aplicación se cerró antes de terminar. Vuelve a iniciar la operación.'});
  for(const asset of state.assets) if(asset.projection==='insv'&&!existsSync(asset.preparedPath || '')) asset.ready=false;
  for(const asset of state.assets) if(asset.projection==='insv' && asset.preparedKey!==`${asset.id}-${config.stitchBackend==='open'?OPEN_STITCH_VERSION:'insta360-1'}-${config.stitchBackend==='open'?stitchWidth:3840}`) asset.ready=false;
  let saveQueue=Promise.resolve();
  function save() { const snapshot=JSON.stringify(state,null,2); saveQueue=saveQueue.catch(()=>{}).then(async()=>{const tmp=path.join(dataDir,'project.tmp');await fs.writeFile(tmp,snapshot);await fs.rename(tmp,path.join(dataDir,'project.json'));}); return saveQueue; }
  const capabilities={ffmpeg:false,codex:false,sdk:!!config.sdkExecutable&&existsSync(config.sdkExecutable),stitchBackend:config.stitchBackend,stitchWidth,openStitch:true};
  if(detect) {
    const [cmd,args]=codexCommand();
    const results=await Promise.allSettled([Promise.all([run(ffmpeg,['-version']),run(ffprobe,['-version'])]),run(cmd,[...args,'--version'])]);
    capabilities.ffmpeg=results[0].status==='fulfilled';capabilities.codex=results[1].status==='fulfilled';
  }
  const snapshot=()=>({...state,capabilities,exportDirectory:path.join(dataDir,'exports')});
  function selected(ids) {
    if(!Array.isArray(ids)||!ids.length||ids.length>100) throw new Error('Selecciona entre 1 y 100 archivos.');
    return [...new Set(ids)].map(id=>{const asset=state.assets.find(a=>a.id===id);if(!asset)throw new Error('Archivo no encontrado.');return asset;});
  }
  function job(type,fn) {
    if(state.jobs.some(j=>['queued','running'].includes(j.status))) throw new Error('Espera a que termine la operación actual o cancélala.');
    const item={id:randomUUID(),type,status:'queued',progress:0,message:'En cola',createdAt:new Date().toISOString()};
    const controller=new AbortController();controllers.set(item.id,controller);state.jobs.push(item);
    const progress=(value,message)=>{item.progress=Math.max(0,Math.min(99,Math.round(value)));item.message=message;};
    setImmediate(async()=>{
      item.status='running';
      try { await save();item.result=await fn({id:item.id,signal:controller.signal,progress});if(controller.signal.aborted)throw new Error('Operación cancelada.');item.status='complete';item.progress=100;item.message='Completado'; }
      catch(error) {item.status=controller.signal.aborted?'cancelled':'failed';item.error=error.message;item.message=item.status==='cancelled'?'Cancelado':'No se pudo completar';}
      finally {controllers.delete(item.id);await save().catch(error=>console.error('No se pudo guardar el proyecto:',error.message));}
    });
    return item;
  }
  async function ensureReady(asset,ctx) {
    const updated=await prepare(asset,config,path.join(dataDir,'cache'),ctx);
    state.assets[state.assets.findIndex(a=>a.id===asset.id)]=updated;await save();return updated;
  }
  async function serveFile(req,res,file,type,download=false) {
    const stat=await fs.stat(file);let start=0,end=stat.size-1,status=200;
    const range=req.headers.range;
    if(range) {
      const match=/^bytes=(\d*)-(\d*)$/.exec(range);
      if(!match || (!match[1]&&!match[2])) {res.writeHead(416,{'Content-Range':`bytes */${stat.size}`});res.end();return;}
      if(!match[1]) start=Math.max(0,stat.size-Number(match[2]));
      else {start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}
      if(start>end || start>=stat.size || !Number.isSafeInteger(start)) {res.writeHead(416,{'Content-Range':`bytes */${stat.size}`});res.end();return;}status=206;
    }
    res.writeHead(status,{'Content-Type':type,'Content-Length':end-start+1,'Accept-Ranges':'bytes',...(status===206?{'Content-Range':`bytes ${start}-${end}/${stat.size}`} : {}),...(download?{'Content-Disposition':'attachment; filename="orbit360-export.mp4"'}:{})});
    if(req.method==='HEAD')return res.end();
    const stream=createReadStream(file,{start,end});stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);
  }
  let frameBusy=false;
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try {
      const allowedHosts=[`127.0.0.1:${server.address().port}`,`localhost:${server.address().port}`];
      if(!allowedHosts.includes(req.headers.host)) return json(res,{error:'Host no permitido.'},403);
      const url=new URL(req.url,`http://${req.headers.host}`), origin=req.headers.origin;
      if(origin&&!allowedHosts.some(host=>origin===`http://${host}`)) return json(res,{error:'Origen no permitido.'},403);
      if(req.headers['sec-fetch-site']==='cross-site') return json(res,{error:'Acceso externo bloqueado.'},403);
      const route=url.pathname;
      if(route.startsWith('/api/')) {
        const supplied=req.headers['x-orbit-token'] || ((req.method==='GET'||req.method==='HEAD')&&url.searchParams.get('token'));
        if(supplied!==token) return json(res,{error:'Sesión no válida. Recarga Orbit360.'},403);
        if(req.method==='GET'&&route==='/api/state')return json(res,snapshot());
        if(req.method==='GET'&&route==='/api/project')return json(res,{version:1,assets:state.assets,plan:state.plan});
        if(req.method==='POST'&&route==='/api/scan')return json(res,await scan((await body(req)).directory));
        if(req.method==='POST'&&route==='/api/import') {const data=await body(req);const additions=await importAssets(data.paths,data.projection || 'flat',state.assets);state.assets.push(...additions);await save();return json(res,snapshot());}
        if(req.method==='POST'&&route==='/api/default-plan') {state.plan=validatePlan(defaultPlan(selected((await body(req)).assetIds)),state.assets);await save();return json(res,{plan:state.plan});}
        if(req.method==='PUT'&&route==='/api/plan') {state.plan=validatePlan((await body(req)).plan,state.assets);await save();return json(res,{plan:state.plan});}
        if(req.method==='POST'&&route==='/api/plan') {
          const data=await body(req), assets=selected(data.assetIds);
          if(typeof data.includeFrames!=='boolean' && data.includeFrames!==undefined)throw new Error('includeFrames debe ser booleano.');
          return json(res,{job:job('plan',async ctx=>{const plan=await planWithCodex({...data,assets,directory:path.join(dataDir,'planning',ctx.id),...ctx});state.plan=plan;return {plan};})},202);
        }
        if(req.method==='POST'&&route==='/api/prepare') {const [asset]=selected([(await body(req)).assetId]);return json(res,{job:job('prepare',async ctx=>({asset:await ensureReady(asset,ctx)}))},202);}
        if(req.method==='POST'&&route==='/api/export') {
          const plan=validatePlan((await body(req)).plan,state.assets);
          return json(res,{job:job('export',async ctx=>{
            for(const asset of selected(plan.clips.map(c=>c.assetId))) await ensureReady(asset,ctx);
            const result=await exportVideo(plan,state.assets,path.join(dataDir,'exports',ctx.id),ctx);
            return {...result,url:`/api/exports/${ctx.id}`};
          })},202);
        }
        const cancel=/^\/api\/jobs\/([\w-]+)\/cancel$/.exec(route);
        if(req.method==='POST'&&cancel) {controllers.get(cancel[1])?.abort();return json(res,{ok:true});}
        const assetRoute=/^\/api\/(media|frame)\/([a-f0-9]{20})$/.exec(route);
        if((req.method==='GET'||req.method==='HEAD')&&assetRoute) {
          const [asset]=selected([assetRoute[2]]);
          if(assetRoute[1]==='media') return await serveFile(req,res,mediaPath(asset),'video/mp4');
          if(frameBusy)return json(res,{error:'Espera a que termine la vista previa.'},429);
          frameBusy=true;
          const destination=path.join(dataDir,`preview-${randomUUID()}.jpg`);
          try {await frame(asset,{time:Number(url.searchParams.get('time')||0),yaw:Number(url.searchParams.get('yaw')||0),pitch:Number(url.searchParams.get('pitch')||0),fov:Number(url.searchParams.get('fov')||90),width:Number(url.searchParams.get('width')||480),height:Number(url.searchParams.get('height')||270),projection:url.searchParams.get('projection')||'flat'},destination);const bytes=await fs.readFile(destination);res.writeHead(200,{'Content-Type':'image/jpeg'});res.end(bytes);}
          finally {frameBusy=false;await fs.rm(destination,{force:true}).catch(()=>{});}return;
        }
        const exported=/^\/api\/exports\/([\w-]+)$/.exec(route);
        if((req.method==='GET'||req.method==='HEAD')&&exported) {const item=state.jobs.find(j=>j.id===exported[1]&&j.type==='export'&&j.status==='complete');if(!item)throw new Error('Exportación no disponible.');return await serveFile(req,res,item.result.path,'video/mp4',url.searchParams.get('download')==='1');}
        return json(res,{error:'Ruta no encontrada.'},404);
      }
      if(!['GET','HEAD'].includes(req.method))return json(res,{error:'Método no permitido.'},405);
      const statics={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/styles.css':['styles.css','text/css; charset=utf-8']};
      if(!statics[route])return json(res,{error:'No encontrado.'},404);
      const [file,mime]=statics[route];let content=await fs.readFile(path.join(root,'public',file),'utf8');if(file==='index.html')content=content.replaceAll('__ORBIT_TOKEN__',token);
      res.writeHead(200,{'Content-Type':mime});res.end(req.method==='HEAD'?'':content);
    } catch(error) {if(!res.headersSent)json(res,{error:error.message},400);else res.destroy();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  const url=`http://127.0.0.1:${server.address().port}`;
  return {server,url,token,close:async()=>{for(const c of controllers.values())c.abort();await saveQueue;await new Promise(resolve=>server.close(resolve));}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href) {
  createApp().then(app=>{
    console.log(`Orbit360 está listo: ${app.url}\nTus originales se conservan. Ctrl+C para cerrar.`);
    for(const name of ['SIGINT','SIGTERM'])process.once(name,async()=>{await app.close();process.exit(0);});
  }).catch(error=>{console.error(error.message);process.exitCode=1;});
}
