import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {parseArguments, buildPlan} from '../src/cli.mjs';
import {run} from '../src/process.js';
import {ffmpeg, probe, importAssets} from '../src/media.js';
import {defaultPlan} from '../src/plan.js';

test('CLI rejects ambiguous, injected or invalid arguments before processing files', () => {
  assert.equal(parseArguments(['--help']).command,'help');
  const options=parseArguments(['render','--input','camera.insv','--output','result','--format','portrait','--start','5','--end','7','--width','7680']);
  assert.ok(path.isAbsolute(options.inputs[0]));
  assert.equal(options.start,5);assert.equal(options.end,7);assert.equal(options.width,7680);
  const base=['render','--input','camera.insv','--output','result'];
  for (const extra of [['--width','1919'],['--width','1922'],['--start','NaN'],['--end','0','--start','5'],['--format','shell'],['--plan','p.json','--format','portrait'],['--output','other'],['--unknown','x']]) {
    assert.throws(()=>parseArguments([...base,...extra]),{code:'INVALID_ARGUMENTS'});
  }
  assert.throws(()=>parseArguments(['inspect','--input']),{code:'INVALID_ARGUMENTS'});
});

test('portable plans resolve sourceIndex with strict validation and keep the input unchanged', () => {
  const assets=[{id:'a',duration:20,projection:'equirectangular'},{id:'b',duration:10,projection:'equirectangular'}];
  const original=defaultPlan(assets);original.clips=original.clips.map(({assetId,...clip},sourceIndex)=>({...clip,sourceIndex}));
  const plan=buildPlan({},assets,original);
  assert.deepEqual(plan.clips.map(c=>c.assetId),['a','b']);
  assert.equal(original.clips[0].sourceIndex,0);assert.equal(original.clips[0].assetId,undefined);
  const invalid=structuredClone(original);invalid.clips[0].sourceIndex=3;
  assert.throws(()=>buildPlan({},assets,invalid),/sourceIndex/);
  invalid.clips[0].sourceIndex=0;invalid.clips[0].assetId='a';
  assert.throws(()=>buildPlan({},assets,invalid),/no ambos/);
  const interval=buildPlan({format:'portrait',start:5,end:7},[assets[0]]);
  assert.equal(interval.output.width,1080);assert.equal(interval.output.height,1920);
  assert.equal(interval.clips[0].end-interval.clips[0].start,2);
  assert.throws(()=>buildPlan({start:5,end:7},assets),/un solo vídeo/);
});

test('CLI process inspects and renders a portable montage to exclusive output folders', {timeout:120000}, async t => {
  try {await run(ffmpeg,['-version']);} catch {t.skip('FFmpeg no instalado');return;}
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'orbit-cli-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const source=path.join(directory,'source.mp4'), output=path.join(directory,'exports');
  const cli=fileURLToPath(new URL('../src/cli.mjs',import.meta.url));
  await run(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=640x320:rate=24','-f','lavfi','-i','sine=frequency=500:sample_rate=48000','-t','2','-c:v','libx264','-c:a','aac',source]);
  const hash=async()=>createHash('sha256').update(await fs.readFile(source)).digest('hex');
  const before=await hash();
  const inspect=JSON.parse((await run(process.execPath,[cli,'inspect','--input',source])).stdout);
  assert.equal(inspect.ok,true);assert.equal(inspect.assets[0].sourceIndex,0);assert.equal(inspect.assets[0].duration,2);
  const plan=defaultPlan([{id:'placeholder',duration:2,projection:'equirectangular'}]);
  plan.output={width:180,height:320,fps:24,projection:'flat'};
  const {assetId,...clip}=plan.clips[0];
  plan.clips=[{...clip,sourceIndex:0,start:0.25,end:0.75},{...clip,sourceIndex:0,start:1,end:1.5,yaw:90}];
  const planFile=path.join(directory,'edit.json');await fs.writeFile(planFile,JSON.stringify(plan));
  const render=async()=>JSON.parse((await run(process.execPath,[cli,'render','--input',source,'--output',output,'--plan',planFile])).stdout);
  const first=await render(),second=await render();
  assert.equal(first.ok,true);assert.notEqual(first.directory,second.directory);
  assert.equal(first.result.width,180);assert.equal(first.result.height,320);assert.equal(first.result.duration,1);
  assert.equal(first.result.hasAudio,true);assert.equal(first.result.sphericalProjection,null);
  assert.equal((await probe(second.result.path)).duration,1);assert.equal(await hash(),before);
  assert.equal((await fs.stat(first.result.path)).isFile(),true);
  assert.deepEqual(JSON.parse(await fs.readFile(planFile,'utf8')),plan);
});

test('paired imports use the shared lens duration and deduplicate either input order', {timeout:60000}, async t => {
  try {await run(ffmpeg,['-version']);} catch {t.skip('FFmpeg no instalado');return;}
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'orbit-pair-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const main=path.join(directory,'VID_20000101_000000_00_001.insv'),other=main.replace('_00_001','_10_001');
  for (const [file,duration] of [[main,'1'],[other,'0.75']]) await run(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','color=red:size=128x128:rate=24','-t',duration,'-c:v','libx264','-f','mp4',file]);
  const assets=await importAssets([other,main],'flat',[]);
  assert.equal(assets.length,1);assert.equal(assets[0].duration,0.75);assert.deepEqual(assets[0].paths,[main,other]);
  const dual=path.join(directory,'dual.insv');
  await run(ffmpeg,['-hide_banner','-loglevel','error','-i',main,'-i',other,'-map','0:v','-map','1:v','-c','copy','-f','mp4',dual]);
  const [twoTracks]=await importAssets([dual],'flat',[]);
  assert.equal(twoTracks.duration,0.75);
});
