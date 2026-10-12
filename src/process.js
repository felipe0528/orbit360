import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export function codexCommand() {
  if (process.env.ORBIT_CODEX_JS) return [process.execPath, [path.resolve(process.env.ORBIT_CODEX_JS)]];
  if (process.env.ORBIT_CODEX_EXE) return [process.env.ORBIT_CODEX_EXE, []];
  if (process.platform === 'win32') {
    const js = path.join(process.env.APPDATA || '', 'npm/node_modules/@openai/codex/bin/codex.js');
    if (existsSync(js)) return [process.execPath, [js]];
  }
  return ['codex', []];
}

export function run(command, args, {cwd, input, signal, onLine, timeout = 120000, maxOutput = 2e6, env} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Operación cancelada.'));
    const child = spawn(command, args, {cwd, env: env || process.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
    let stdout = '', stderr = '', pending = '', stopped = '';
    const kill = () => {
      if (child.pid && process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
      else child.kill('SIGKILL');
    };
    const abort = () => { stopped = 'Operación cancelada.'; kill(); };
    signal?.addEventListener('abort', abort, {once: true});
    const timer = setTimeout(() => { stopped = 'Se agotó el tiempo de la operación.'; kill(); }, timeout);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    child.stdout.on('data', data => {
      stdout = (stdout + data).slice(-maxOutput);
      pending += data;
      const lines = pending.split(/\r?\n/); pending = lines.pop().slice(-100000);
      for (const line of lines) onLine?.(line);
    });
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-maxOutput); });
    child.on('error', error => { cleanup(); reject(new Error(`No se pudo ejecutar ${path.basename(command)}: ${error.message}`)); });
    child.on('close', code => {
      cleanup();
      if (stopped || code !== 0) reject(new Error(stopped || `${path.basename(command)} terminó con código ${code}: ${stderr.slice(-3000) || stdout.slice(-3000)}`));
      else resolve({stdout, stderr});
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
