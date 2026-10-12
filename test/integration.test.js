import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../src/server.js';
import {run} from '../src/process.js';
import {ffmpeg,probe,exportVideo,importAssets,prepare} from '../src/media.js';
import {defaultPlan,validatePlan} from '../src/plan.js';

test('localhost API protects local paths and validates its edit boundary',async t=>{
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'orbit-api-'));
  const app=await createApp({dataDir:directory,port:0,detect:false});
  t.after(async()=>{await app.close();await fs.rm(directory,{recursive:true,force:true});});
  assert.equal((await fetch(app.url+'/api/state')).status,403);
  assert.equal((await fetch(app.url+'/api/state',{headers:{'x-orbit-token':app.token,Origin:'https://evil.example'}})).status,403);
  const response=await fetch(app.url+'/api/state',{headers:{'x-orbit-token':app.token}});assert.equal(response.status,200);assert.deepEqual((await response.json()).assets,[]);
  const bad=await fetch(app.url+'/api/export',{method:'POST',headers:{'x-orbit-token':app.token,'Content-Type':'application/json'},body:'{"plan":{}}'});assert.equal(bad.status,400);
  const traversal=await fetch(app.url+'/%2e%2e/package.json');assert.equal(traversal.status,404);
});
test('real FFmpeg: mixed audio, silent input, cuts, speed, portrait and concatenation',{timeout:120000},async t=>{
  try {await run(ffmpeg,['-version']);} catch {t.skip('FFmpeg no instalado');return;}
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'orbit-media-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const source=path.join(directory,'sphere.mp4'), silent=path.join(directory,'silent.mp4');
  await run(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=640x320:rate=24','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','2','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',source]);
  await run(ffmpeg,['-hide_banner','-loglevel','error','-i',source,'-an','-c:v','copy',silent]);
  const assets=await importAssets([source,silent],'equirectangular',[]);assert.equal(assets.length,2);
  const plan=defaultPlan(assets);plan.output={width:180,height:320,fps:30,projection:'flat'};
  plan.clips[0]={...plan.clips[0],start:0.25,end:1.75,speed:2,yaw:40};
  plan.clips[1]={...plan.clips[1],start:0.2,end:1.2,speed:0.5,pitch:20};
  validatePlan(plan,assets);
  const result=await exportVideo(plan,assets,path.join(directory,'render'),{progress:()=>{}});
  assert.equal(result.width,180);assert.equal(result.height,320);assert.equal(result.hasAudio,true);assert.ok(Math.abs(result.duration-2.75)<0.2);
  const muted=defaultPlan([assets[0]]);muted.clips[0].mute=true;muted.output={width:640,height:320,fps:24,projection:'equirectangular'};
  const result2=await exportVideo(muted,assets,path.join(directory,'mute'),{progress:()=>{}});assert.equal((await probe(result2.path)).width,640);
  assert.equal(result2.spherical.verified,true);assert.deepEqual(result2.spherical.metadataVersions,[1,2]);
  assert.equal(result2.spherical.fastStart,true);assert.equal(result2.sphericalProjection,'equirectangular');
  const [reimported]=await importAssets([result2.path],'equirectangular',[]);
  const reframed=defaultPlan([reimported]);reframed.output={width:180,height:320,fps:24,projection:'flat'};
  const flat=await exportVideo(reframed,[reimported],path.join(directory,'reframed'),{progress:()=>{}});
  assert.equal(flat.sphericalProjection,null);assert.equal(flat.spherical,undefined);
  await fs.utimes(source,new Date(),new Date(Date.now()+10000));
  await assert.rejects(()=>prepare(assets[0],{},directory,{progress:()=>{}}),/original cambió/);
  const replaced=await importAssets([source],'equirectangular',assets);assert.equal(replaced.length,1);assert.notEqual(replaced[0].id,assets[0].id);
});
