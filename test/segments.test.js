import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {run} from '../src/process.js';
import {ffmpeg,ffprobe,exportVideo,importAssets} from '../src/media.js';
import {defaultPlan,validatePlan} from '../src/plan.js';

const fps=30;
const digest=async file=>createHash('sha256').update(await fs.readFile(file)).digest('hex');

async function inspect(file) {
  const {stdout}=await run(ffprobe,['-v','error','-count_frames','-show_streams','-show_format','-of','json',file]);
  return JSON.parse(stdout);
}

// Each source frame has a unique Y/U combination. Spatially uniform frames
// retain this time code when reframed, so checks cover the actual selected
// content as well as duration without depending on lossy encoder hashes.
async function frameSignatures(file,destination) {
  await run(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y','-i',file,'-map','0:v:0','-vf','scale=1:1:flags=area,format=yuv444p','-fps_mode','passthrough','-f','rawvideo',destination]);
  const bytes=await fs.readFile(destination);
  assert.equal(bytes.length%3,0);
  return Array.from({length:bytes.length/3},(_,i)=>[...bytes.subarray(i*3,i*3+3)]);
}

function assertSelectedFrames(actual,source,ranges) {
  const expected=ranges.flatMap(([start,end])=>source.slice(start*fps,end*fps));
  assert.equal(actual.length,expected.length,'one output frame per selected source frame');
  for (let frame=0;frame<expected.length;frame++) {
    for (let channel=0;channel<3;channel++) {
      assert.ok(Math.abs(actual[frame][channel]-expected[frame][channel])<=2,
        `frame ${frame}, channel ${channel}: selected ${actual[frame][channel]}, expected ${expected[frame][channel]}`);
    }
  }
}

async function readAudio(file,destination) {
  await run(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y','-i',file,'-map','0:a:0','-ac','1','-ar','48000','-c:a','pcm_f32le','-f','f32le',destination]);
  const data=await fs.readFile(destination);
  return Array.from({length:data.length/4},(_,i)=>data.readFloatLE(i*4));
}

function assertToneAt(audio,outputTime,sourceTime) {
  const start=Math.round(outputTime*48000), size=4800;
  assert.ok(audio.length>=start+size,'audio covers the selected interval');
  const window=audio.slice(start,start+size);
  const rms=Math.sqrt(window.reduce((sum,value)=>sum+value*value,0)/size);
  assert.ok(rms>0.05,'source audio survives the cut');
  let crossings=0;
  for (let i=1;i<window.length;i++) if(window[i-1]<=0&&window[i]>0) crossings++;
  const frequency=crossings/0.1;
  const expected=300+100*(sourceTime+0.05);
  assert.ok(Math.abs(frequency-expected)<25,`audio at ${outputTime}s is ${frequency} Hz; source time ${sourceTime}s requires approximately ${expected} Hz`);
}

test('real FFmpeg: select 5–7 s and concatenate 5–7 + 12–15 s in flat and 360 formats',{timeout:120000},async t=>{
  try {await run(ffmpeg,['-version']);await run(ffprobe,['-version']);} catch {t.skip('FFmpeg/FFprobe no instalado');return;}
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'orbit-segments-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  const source=path.join(directory,'twenty-seconds.mkv');
  await run(ffmpeg,['-hide_banner','-loglevel','error','-nostdin','-y',
    '-f','lavfi','-i',`nullsrc=size=320x160:rate=${fps},geq=lum='32+8*mod(N,24)':cb='32+8*floor(N/24)':cr=128`,
    '-f','lavfi','-i','aevalsrc=0.3*sin(2*PI*(300*t+50*t*t)):s=48000',
    '-t','20','-c:v','ffv1','-pix_fmt','yuv420p','-c:a','pcm_s16le',source]);
  const originalHash=await digest(source), originalStat=await fs.stat(source);
  const reference=await frameSignatures(source,path.join(directory,'source.raw'));
  assert.equal(reference.length,20*fps);
  const assets=await importAssets([source],'equirectangular',[]);
  const formats=[
    {name:'9:16',width:180,height:320,projection:'flat'},
    {name:'16:9',width:320,height:180,projection:'flat'},
    {name:'3:4',width:192,height:256,projection:'flat'},
    {name:'2:1',width:320,height:160,projection:'equirectangular'},
  ];
  for (const [index,format] of formats.entries()) {
    await t.test(`5–7 seconds exports two seconds in ${format.name}`,async()=>{
      const plan=defaultPlan(assets);
      const {name,...output}=format;
      plan.output={...output,fps};
      plan.clips[0]={...plan.clips[0],start:5,end:7};
      const result=await exportVideo(validatePlan(plan,assets),assets,path.join(directory,`single-${index}`),{progress:()=>{}});
      assert.equal(result.width,format.width);assert.equal(result.height,format.height);
      const info=await inspect(result.path), video=info.streams.find(s=>s.codec_type==='video'), audio=info.streams.find(s=>s.codec_type==='audio');
      assert.equal(Number(video.nb_read_frames),2*fps);
      assert.ok(Math.abs(Number(video.duration)-2)<1/fps);
      assert.ok(Math.abs(Number(video.start_time))<1/fps,'video timestamps restart near zero');
      assert.ok(Math.abs(Number(audio.start_time))<1/fps,'audio timestamps restart near zero');
      assert.ok(Math.abs(Number(audio.duration)-2)<0.05,'AAC duration stays within codec padding');
      const frames=await frameSignatures(result.path,path.join(directory,`single-${index}.raw`));
      assertSelectedFrames(frames,reference,[[5,7]]);
      const samples=await readAudio(result.path,path.join(directory,`single-${index}.f32`));
      assertToneAt(samples,0.1,5.1);assertToneAt(samples,1.8,6.8);
    });
  }
  await t.test('two disjoint source ranges preserve order, selected frames and audio',async()=>{
    const plan=defaultPlan(assets);
    plan.output={width:320,height:160,fps,projection:'equirectangular'};
    plan.clips=[[5,7],[12,15]].map(([start,end])=>({...plan.clips[0],start,end}));
    const result=await exportVideo(validatePlan(plan,assets),assets,path.join(directory,'multiple'),{progress:()=>{}});
    const info=await inspect(result.path), video=info.streams.find(s=>s.codec_type==='video'), audio=info.streams.find(s=>s.codec_type==='audio');
    assert.equal(Number(video.nb_read_frames),5*fps);
    assert.ok(Math.abs(Number(video.duration)-5)<1/fps,'concatenation duration remains within one frame');
    assert.ok(Math.abs(Number(audio.duration)-5)<0.05,'concatenation audio does not accumulate excessive padding');
    assert.ok(Math.abs(Number(video.start_time))<1/fps);
    assert.ok(Math.abs(Number(audio.start_time))<1/fps);
    assertSelectedFrames(await frameSignatures(result.path,path.join(directory,'multiple.raw')),reference,[[5,7],[12,15]]);
    const samples=await readAudio(result.path,path.join(directory,'multiple.f32'));
    assertToneAt(samples,0.1,5.1);assertToneAt(samples,1.8,6.8);
    assertToneAt(samples,2.2,12.2);assertToneAt(samples,4.8,14.8);
  });
  assert.equal(await digest(source),originalHash,'export does not alter source bytes');
  const finalStat=await fs.stat(source);
  assert.equal(finalStat.size,originalStat.size);assert.equal(finalStat.mtimeMs,originalStat.mtimeMs);
});
