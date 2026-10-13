import {execFile} from 'node:child_process';
import {existsSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {promisify} from 'node:util';

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const runtimeRelease = 'b6.1.1';
const execute = promisify(execFile);

export function runtimePaths(directory = path.join(projectRoot, '.local', 'runtime'), platform = process.platform, arch = process.arch) {
  const root = path.resolve(directory, `ffmpeg-${runtimeRelease}-${platform}-${arch}`);
  const suffix = platform === 'win32' ? '.exe' : '';
  return {root, ffmpeg: path.join(root, `ffmpeg${suffix}`), ffprobe: path.join(root, `ffprobe${suffix}`)};
}

export function runtimeEnvironment({env = process.env, runtimeDir, platform = process.platform, arch = process.arch} = {}) {
  const files = runtimePaths(runtimeDir, platform, arch);
  return {...env,
    ORBIT_FFMPEG: env.ORBIT_FFMPEG || (existsSync(files.ffmpeg) ? files.ffmpeg : 'ffmpeg'),
    ORBIT_FFPROBE: env.ORBIT_FFPROBE || (existsSync(files.ffprobe) ? files.ffprobe : 'ffprobe')};
}

async function runTool(command, args) {
  return execute(command, args, {windowsHide: true, timeout: 20000, maxBuffer: 2 * 1024 * 1024});
}

// No inicia sesión ni lee archivos de autenticación. Cada usuario usa su propia cuenta.
export async function diagnose({env = process.env, runtimeDir, platform = process.platform, arch = process.arch,
  nodeVersion = process.versions.node, executeTool = runTool} = {}) {
  const effective = runtimeEnvironment({env, runtimeDir, platform, arch});
  const checks = [{id: 'node', required: true, ok: Number(nodeVersion.split('.')[0]) >= 22,
    detail: `Node.js ${nodeVersion}; se requiere ≥22.`}];
  const check = async (id, command, args, required, predicate = () => true) => {
    try {
      const result = await executeTool(command, args);
      const output = `${result.stdout || ''}\n${result.stderr || ''}`;
      const ok = predicate(output);
      checks.push({id, required, ok, detail: ok ? output.trim().split(/\r?\n/)[0].slice(0, 300) : `Falta ${id}.`});
      return output;
    } catch (error) {
      checks.push({id, required, ok: false, detail: `${command}: ${error.code || error.message}`.slice(0, 300)});
      return '';
    }
  };
  await check('ffmpeg', effective.ORBIT_FFMPEG, ['-version'], true, text => /^ffmpeg version /m.test(text));
  await check('ffprobe', effective.ORBIT_FFPROBE, ['-version'], true, text => /^ffprobe version /m.test(text));
  const filters = await check('filters', effective.ORBIT_FFMPEG, ['-hide_banner', '-filters'], true, text => /\bv360\b/.test(text));
  for (const name of ['v360', 'remap', 'maskedmerge']) {
    checks.push({id: `filter:${name}`, required: true, ok: new RegExp(`^\\s*[.A-Z|]{2,6}\\s+${name}\\s`, 'm').test(filters), detail: name});
  }
  const encoders = await check('encoders', effective.ORBIT_FFMPEG, ['-hide_banner', '-encoders'], true, text => /\blibx264\b/.test(text));
  for (const name of ['libx264', 'aac']) {
    checks.push({id: `encoder:${name}`, required: true, ok: new RegExp(`^\\s*[.A-Z]{6}\\s+${name}\\s`, 'm').test(encoders), detail: name});
  }
  const decoders = await check('decoders', effective.ORBIT_FFMPEG, ['-hide_banner', '-decoders'], true);
  for (const name of ['h264', 'hevc']) {
    checks.push({id: `decoder:${name}`, required: true, ok: new RegExp(`^\\s*[.A-Z]{6}\\s+${name}\\s`, 'm').test(decoders), detail: name});
  }
  const codexJs = env.ORBIT_CODEX_JS || (platform === 'win32' && env.APPDATA
    ? path.join(env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js') : null);
  await check('codex', codexJs && existsSync(codexJs) ? process.execPath : (env.ORBIT_CODEX_EXE || 'codex'),
    codexJs && existsSync(codexJs) ? [codexJs, '--version'] : ['--version'], false);
  await check('python', env.ORBIT_PYTHON || (platform === 'win32' ? 'python' : 'python3'), ['--version'], false,
    text => { const match = /Python (\d+)\.(\d+)/.exec(text); return !!match && (Number(match[1]) > 3 || (Number(match[1]) === 3 && Number(match[2]) >= 10)); });
  return {ok: checks.every(item => !item.required || item.ok), platform, arch, checks,
    commands: {ffmpeg: effective.ORBIT_FFMPEG, ffprobe: effective.ORBIT_FFPROBE},
    notes: ['El SDK propietario de Insta360 no es requisito de este diagnóstico.',
      'Codex es opcional; su instalación no confirma autenticación. Usa tu propia cuenta.',
      'Python ≥3.10 es opcional y no se instala automáticamente.',
      'La primera descarga requiere Internet. Node.js debe estar instalado previamente.']};
}

export function printDiagnosis(report, json = false) {
  if (json) { console.log(JSON.stringify(report, null, 2)); return; }
  console.log(`Orbit360 · ${report.platform}/${report.arch} · ${report.ok ? 'requisitos disponibles' : 'faltan requisitos'}`);
  for (const item of report.checks) console.log(`${item.ok ? 'OK' : item.required ? 'FALTA' : 'OPCIONAL'} ${item.id}: ${item.detail}`);
  for (const note of report.notes) console.log(note);
  if (!report.ok) console.log('Para descargar el runtime multimedia local: node scripts/bootstrap.mjs --install');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--json')) { console.error('Uso: node scripts/doctor.mjs [--json]'); process.exitCode = 2; }
  else { const report = await diagnose(); printDiagnosis(report, args.includes('--json')); process.exitCode = report.ok ? 0 : 1; }
}
