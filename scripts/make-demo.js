import fs from 'node:fs/promises';
import path from 'node:path';
import {run} from '../src/process.js';
import {ffmpeg} from '../src/media.js';
const folder=path.resolve('.local/demo');await fs.mkdir(folder,{recursive:true});
const output=path.join(folder,'demo-360.mp4');
await run(ffmpeg,['-hide_banner','-loglevel','error','-y','-f','lavfi','-i','testsrc2=size=1280x640:rate=30','-f','lavfi','-i','sine=frequency=220:sample_rate=48000','-t','8','-c:v','libx264','-pix_fmt','yuv420p','-c:a','aac',output]);
console.log(`Demo sintética 2:1 creada. Importa como panorámico:\n${output}`);
