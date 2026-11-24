import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createConnection, createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { startPanel } from './panel.mjs';
import { dataDirectory } from './role-storage.mjs';

const profile = createHash('sha256').update(homedir().toLowerCase()).update('\0')
  .update(dataDirectory.toLowerCase()).digest('hex');
const panelPipe = '\\\\.\\pipe\\surfcore-panel-v1-' + profile;
const openCommand = Buffer.of(1);

function openDefaultBrowser(url) {
  const powershell = join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    const failed = () => reject(new Error('无法打开默认浏览器，请确认 Windows 已设置默认浏览器后重试。'));
    // Keep the panel address out of command-line arguments, tool results and logs.
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-Command',
      'Start-Process -FilePath ([Console]::In.ReadToEnd()) -ErrorAction Stop'], {
      windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'],
      signal: AbortSignal.timeout(10_000),
    });
    child.once('error', failed);
    child.once('close', (code) => code === 0 ? resolve() : failed());
    child.stdin.on('error', failed);
    child.stdin.end(url);
  });
}

export function createPanelLauncher({ openBrowser = openDefaultBrowser } = {}) {
  let panel;
  let opening;

  async function open() {
    if (process.platform !== 'win32') throw new Error('此入口需要 Windows 桌面。');
    opening ??= (async () => {
      panel ??= await startPanel({ maintainVoiceCache: true });
      await openBrowser(panel.url);
      return { opened: true };
    })().finally(() => { opening = undefined; });
    return opening;
  }

  async function close() {
    await opening?.catch(() => {});
    const active = panel;
    panel = undefined;
    await active?.close();
  }

  return { open, close };
}

export function requestPanelOpen(pipe = panelPipe) {
  return new Promise((resolve, reject) => {
    const unavailable = () => new Error('控制台未能打开，请稍后重试。');
    const socket = createConnection(pipe);
    socket.setTimeout(12_000, () => socket.destroy(unavailable()));
    socket.once('connect', () => socket.write(openCommand));
    socket.once('data', (bytes) => {
      if (bytes.equals(openCommand)) {
        resolve(true);
        socket.destroy();
      } else socket.destroy(unavailable());
    });
    socket.once('end', () => reject(unavailable()));
    socket.once('error', (error) => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') resolve(false);
      else reject(unavailable());
    });
  });
}

export async function servePanelLauncher(pipe = panelPipe, openBrowser) {
  const launcher = createPanelLauncher({ openBrowser });
  const server = createServer((socket) => {
    // The pipe accepts only an open command. The HTTP access key stays in this process.
    socket.on('error', () => socket.destroy());
    socket.setTimeout(2_000, () => socket.destroy());
    socket.once('data', async (bytes) => {
      if (!bytes.equals(openCommand)) return socket.destroy();
      socket.setTimeout(0);
      try {
        await launcher.open();
        socket.end(openCommand);
      } catch {
        socket.end(Buffer.of(0));
      }
    });
  });
  await once(server.listen({ path: pipe, readableAll: false, writableAll: false }), 'listening');
  return async () => {
    await new Promise((resolve) => server.close(resolve));
    await launcher.close();
  };
}

export async function openSurfcorePanel() {
  if (process.platform !== 'win32') throw new Error('此入口需要 Windows 桌面。');
  if (await requestPanelOpen()) return { opened: true };
  const worker = fileURLToPath(new URL('./panel-worker.mjs', import.meta.url));
  const child = spawn(process.execPath, [worker], {
    detached: true, windowsHide: true, stdio: 'ignore',
  });
  await once(child, 'spawn');
  child.unref();
  for (let attempt = 0; attempt < 60; attempt++) {
    await delay(100);
    if (await requestPanelOpen()) return { opened: true };
  }
  throw new Error('控制台进程未能启动，请稍后重试。');
}
