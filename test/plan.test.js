import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultPlan,validatePlan,videoFilter,audioTempo} from '../src/plan.js';
const assets=[{id:'abc',duration:10,projection:'equirectangular'}];
test('accepts a valid edit and isolates the caller object',()=>{const plan=defaultPlan(assets);const result=validatePlan(plan,assets);result.clips[0].start=1;assert.equal(plan.clips[0].start,0);});
test('rejects hallucinated files, injected fields, non-finite values and impossible cuts',()=>{
  for(const change of [p=>p.clips[0].assetId='unknown',p=>p.command='rm',p=>p.clips[0].end=11,p=>p.clips[0].start=5,p=>p.clips[0].yaw=NaN,p=>p.clips[0].speed=0,p=>p.output.width=1081,p=>p.output.fps=1000,p=>p.clips[0].mute='true']) {
    const plan=defaultPlan(assets);change(plan);assert.throws(()=>validatePlan(plan,assets));
  }
});
test('rejects fabricated panoramic output from flat sources',()=>{const plan=defaultPlan(assets);plan.output={width:1920,height:960,fps:30,projection:'equirectangular'};assert.throws(()=>validatePlan(plan,[{...assets[0],projection:'flat'}]));});
test('portrait reframe uses correct vertical FOV and safe filter',()=>{const plan=defaultPlan(assets);plan.output={width:1080,height:1920,fps:30,projection:'flat'};const filter=videoFilter(plan.clips[0],plan.output,'insv');assert.match(filter,/v360=input=equirect:output=flat/);const vfov=Number(filter.match(/v_fov=([\d.]+)/)[1]);assert.ok(vfov>120&&vfov<122);assert.equal(audioTempo(0.25),'atempo=0.5,atempo=0.5');assert.equal(audioTempo(4),'atempo=2,atempo=2');});
