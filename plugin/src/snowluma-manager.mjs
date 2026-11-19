import { snowLumaDirectory } from './local-installation.mjs';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { spawn } from 'node:child_process';
import { get } from 'node:http';

function portOpen(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.setTimeout(500); socket.once('connect', () => done(true));
    socket.once('error', () => done(false)); socket.once('timeout', () => done(false));
  });
}

function snowPage(port) {
  return new Promise((resolve) => {
    const req = get({ host: '127.0.0.1', port, path: '/', timeout: 1000 }, (res) => {
      let html = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { html += chunk; if (html.length > 65536) res.destroy(); });
      res.on('end', () => resolve(res.statusCode === 200 && /<title>SnowLuma 控制台<\/title>/i.test(html)));
      res.on('error', () => resolve(false));
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(false));
  });
}

export function createSnowLumaManager({ directory = snowLumaDirectory(), probe = portOpen, identify = snowPage, launch = spawn } = {}) {
  let starting = false, child, lastError = '';
  async function config() {
    const settings = JSON.parse(await readFile(join(directory, 'config', 'runtime.json'), 'utf8'));
    if (settings.hookAutoLoad !== false) throw new Error('SnowLuma 自动加载 QQ 未关闭，请先在 SnowLuma 设置中关闭，再从这里启动。');
    if (settings.webuiHost !== '127.0.0.1' || settings.webuiTls?.enabled || !Number.isInteger(settings.webuiPort) || settings.webuiPort < 1 || settings.webuiPort > 65535) {
      throw new Error('SnowLuma 控制台地址不是预期的本机 HTTP 地址，请检查 SnowLuma 配置。');
    }
    await Promise.all([access(join(directory, 'node.exe')), access(join(directory, 'index.mjs'))]);
    return settings;
  }
  async function status() {
    try {
      const settings = await config();
      const listening = await probe(settings.webuiPort);
      const ready = listening && await identify(settings.webuiPort);
      return { installed: true, directory, port: settings.webuiPort, listening, ready, starting, error: lastError, url: 'http://127.0.0.1:' + settings.webuiPort + '/' };
    } catch (error) {
      return { installed: false, directory, port: null, listening: false, starting: false, error: error.code === 'ENOENT' ? '没有找到已安装的 SnowLuma，请检查安装目录。' : error.message, url: null };
    }
  }
  async function start() {
    if (starting) throw new Error('SnowLuma 正在启动，请稍后刷新状态。');
    starting = true;
    try {
      const settings = await config();
      if (await probe(settings.webuiPort)) throw new Error('SnowLuma 页面端口已被占用，请先打开页面确认，不要重复启动。');
      if (child && child.exitCode === null && !child.killed) throw new Error('已发出启动请求，请等待 SnowLuma 页面就绪。');
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(SURFCORE_|SNOWLUMA_)/i.test(key)));
      child = launch(join(directory, 'node.exe'), [join(directory, 'index.mjs')], { cwd: directory, env, detached: true, windowsHide: true, stdio: 'ignore' });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      child.once('exit', (code) => { lastError = 'SnowLuma 进程已退出（退出码 ' + code + '），请查看 SnowLuma 自身日志。'; });
      child.unref(); lastError = '';
      return { started: true, message: '已启动 SnowLuma，请等待页面就绪后打开并登录机器人。' };
    } catch (error) { throw new Error(error.code === 'ENOENT' ? '没有找到已安装的 SnowLuma，请检查安装目录。' : error.message); }
    finally { starting = false; }
  }
  return { status, start };
}
