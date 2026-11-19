import { access, appendFile, readFile, mkdir, realpath } from 'node:fs/promises';
import { join, isAbsolute, relative } from 'node:path';
import { spawn } from 'node:child_process';
import { createConnection } from 'node:net';
import { dataDirectory } from './store.mjs';
import { loadVoices, synthesize, health, synthesisStatus } from './voice.mjs';
import { readProvider, configureProvider } from './voice-config.mjs';
const file = join(dataDirectory, 'voice-directories.jsonl'), owned = new Map(), exits = new Map(), operations = new Map();
async function serialized(pack, work) {
  validate(pack);
  const previous = operations.get(pack) || Promise.resolve();
  const current = previous.catch(() => {}).then(work);
  operations.set(pack, current);
  try { return await current; } finally { if (operations.get(pack) === current) operations.delete(pack); }
}
const required = ['config.toml', '.venv/Scripts/python.exe'];
function validate(pack) { if (!['local', 'cloud', 'breeze'].includes(pack)) throw new Error('语音包无效。'); }
async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function directories() {
  try { return Object.fromEntries((await readFile(file, 'utf8')).trim().split('\n').filter(Boolean).map((line) => { const row = JSON.parse(line); return [row.pack, row.dir]; })); }
  catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
}
function portOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(500); socket.once('connect', () => done(true)); socket.once('error', () => done(false)); socket.once('timeout', () => done(false));
  });
}
export async function packStatus(pack) {
  validate(pack); const provider = await readProvider(pack);
  const dir = pack === 'breeze' ? provider.dir || '' : (await directories())[pack] || '';
  const files = pack === 'breeze' ? ['breeze-server.exe'] : [...required, ...(pack === 'local' ? ['.venv-gsv/Scripts/python.exe', 'vendor/GPT-SoVITS/code/api_v2.py', 'logs/gsv/tts_infer.yaml'] : [])];
  const missing = [];
  for (const item of files) if (!dir || !(await exists(join(dir, item)))) missing.push(item);
  if (pack === 'breeze' && (!provider.modelPath || !await exists(provider.modelPath))) missing.push('GGUF 模型');
  const running = await portOpen(Number(new URL(provider.baseUrl).port) || 80);
  const serviceHealth = await health(pack);
  return { pack, providerId: pack, baseUrl: provider.baseUrl, dir, modelPath: provider.modelPath || '', cpu: provider.cpu ?? false,
    missing, readyToStart: missing.length === 0, running, health: serviceHealth, synthesis: synthesisStatus(pack), engineRunning: pack === 'local' ? await portOpen(9880) : null,
    managed: (owned.get(pack) || []).some((child) => child.exitCode === null && !child.killed),
    processes: (owned.get(pack) || []).map((child) => ({ name: child.surfcoreName, pid: child.pid, running: child.exitCode === null && !child.killed, exitCode: child.exitCode, signal: child.signalCode, diagnostic: child.surfcoreOutput || '' })),
    lastExit: exits.get(pack) || null,
    note: '运行状态为端口探测；请执行自检确认服务身份和合成能力。' };
}
export function configurePack(pack, dir, options = {}) { return serialized(pack, () => configureInternal(pack, dir, options)); }
async function configureInternal(pack, dir, options) {
  validate(pack);
  if (typeof dir !== 'string' || !isAbsolute(dir)) throw new Error('请选择语音包的绝对目录。');
  if ((await packStatus(pack)).managed) throw new Error('请先停止此控制台启动的语音服务再更换目录。');
  const resolved = await realpath(dir);
  if (pack === 'breeze') {
    await configureProvider({ providerId: pack, ...options, dir: resolved });
    return packStatus(pack);
  }
  await mkdir(dataDirectory, { recursive: true });
  await appendFile(file, JSON.stringify({ pack, dir: resolved }) + '\n', { mode: 0o600 });
  return packStatus(pack);
}
async function launch(pack, name, exe, args, cwd, env = {}) {
  const child = spawn(exe, args, { cwd, windowsHide: true, stdio: pack === 'breeze' ? ['ignore', 'pipe', 'pipe'] : 'ignore', env: { ...process.env, ...env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } });
  child.surfcoreName = name;
  if (pack === 'breeze') for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { child.surfcoreOutput = ((child.surfcoreOutput || '') + chunk.toString()).slice(-8000); });
  child.once('exit', (code, signal) => exits.set(pack, { name, code, signal, at: new Date().toISOString(), diagnostic: child.surfcoreOutput || '' }));
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(new Error('语音进程启动失败，请检查引擎文件和运行环境。'))); });
  return child;
}
export function startPack(pack) { return serialized(pack, () => startInternal(pack)); }
async function startInternal(pack) {
  const state = await packStatus(pack);
  if (state.missing.length) throw new Error('语音包缺少：' + state.missing.join('、'));
  if (state.managed) throw new Error('本控制台已有语音进程运行或正在启动，请刷新状态或先停止。');
  if (state.running) throw new Error('服务端口已被占用，请先自检或停止原服务。');
  const children = [];
  exits.delete(pack);
  try {
    if (pack === 'breeze') {
      const args = [relative(state.dir, state.modelPath), '--host', '127.0.0.1', '--port', String(new URL(state.baseUrl).port || 80),
        '--ws-port', '-1', '--parallel', '1', '--voices-dir', 'voices'];
      if (state.cpu) args.push('--cpu');
      children.push(await launch(pack, 'Breeze', join(state.dir, 'breeze-server.exe'), args, state.dir));
      owned.set(pack, children);
      return { started: true, message: '已创建 Breeze 进程；请等待健康检查通过后执行合成自检。' };
    }
    if (pack === 'local' && !state.engineRunning) {
      const code = join(state.dir, 'vendor/GPT-SoVITS/code');
      children.push(await launch(pack, 'GPT-SoVITS', join(state.dir, '.venv-gsv/Scripts/python.exe'), ['-s', 'api_v2.py', '-a', '127.0.0.1', '-p', '9880', '-c', join(state.dir, 'logs/gsv/tts_infer.yaml')], code, { PYTHONPATH: join(code, 'GPT_SoVITS') + ';' + code }));
    }
    children.push(await launch(pack, '语音服务', join(state.dir, '.venv/Scripts/python.exe'), ['-m', 'voxd', '--config', 'config.toml'], state.dir));
    owned.set(pack, children);
    return { started: true, message: '启动请求已提交。模型加载可能需要约 40 秒，请刷新状态并执行自检。' };
  } catch (error) { for (const child of children) child.kill(); throw error; }
}
export function stopPack(pack) { return serialized(pack, () => stopInternal(pack)); }
async function stopInternal(pack) {
  validate(pack);
  for (const child of owned.get(pack) || []) if (child.exitCode === null && !child.killed) child.kill();
  owned.delete(pack);
  return { stopped: true, message: '已停止此控制台启动的进程；外部启动的服务不受影响。' };
}
export async function checkPack(pack) {
  const steps = [];
  try {
    const catalog = await loadVoices(pack); steps.push({ step: '服务与音色', ok: true, detail: catalog.voices.length + ' 个音色' });
    const result = await synthesize({ pack, voiceId: catalog.default, language: 'zh-CN' });
    if (result.status !== 'audio') throw new Error(result.reason);
    steps.push({ step: '实际合成', ok: true, detail: result.metrics.bytes + ' 字节 WAV，' + Math.round(result.metrics.durationMs) + ' 毫秒，耗时 ' + Math.round(result.metrics.totalMs) + ' 毫秒' });
  } catch (error) { steps.push({ step: steps.length ? '实际合成' : '服务与音色', ok: false, detail: error.message }); }
  steps.push({ step: 'QQ 发送', ok: null, detail: '未执行真实发送；本页只验证语音服务。' });
  return { steps };
}
