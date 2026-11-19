import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { copyFile, cp, lstat, mkdir, open, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const dataDirectory = resolve(process.env.SURFCORE_DATA_DIR || join(process.env.LOCALAPPDATA || homedir(), 'SurfCoreCodex'));
const configPath = join(dataDirectory, 'role-storage.json');
const lockPath = join(dataDirectory, '.role-storage.lock');
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

export function roleStorageDirectory() {
  let raw;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return dataDirectory;
    throw new Error('无法读取角色存储配置，已停止读取以保护数据。');
  }
  let directory;
  try {
    const config = JSON.parse(raw);
    if (!config || typeof config.directory !== 'string' || !isAbsolute(config.directory)) throw new Error();
    directory = resolve(config.directory);
  } catch { throw new Error('角色存储目录配置无效，已停止读取以保护数据。'); }
  try {
    if (!statSync(directory).isDirectory()) throw new Error();
  } catch { throw new Error('角色存储目录不可用，请检查磁盘或恢复原目录。'); }
  return directory;
}

export async function withRoleStorageLock(work) {
  await mkdir(dataDirectory, { recursive: true });
  let handle;
  for (let attempt = 0; attempt < 400; attempt++) {
    try { handle = await open(lockPath, 'wx', 0o600); break; }
    catch (error) {
      // Windows can report an existing/open lock as EPERM or EACCES.
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      await delay(25);
    }
  }
  if (!handle) throw new Error('角色存储正被占用。若程序异常退出，请确认没有 SurfCore 进程后清理存储锁。');
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    return await work();
  } finally { await handle.close(); await rm(lockPath, { force: true }); }
}

export async function getRoleStorage() {
  const directory = roleStorageDirectory();
  return { directory, characters: join(directory, 'characters'), active: join(directory, 'active.jsonl'), defaultDirectory: dataDirectory };
}

function nestedPath(a, b) {
  const path = relative(a, b);
  return path === '' || (!path.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) && path !== '..' && !isAbsolute(path));
}

// Copy to an empty destination and switch only after all files are present. The source remains a backup.
export async function moveRoleStorage(directory) {
  if (typeof directory !== 'string' || !isAbsolute(directory) || directory.length > 4096) throw new Error('请选择有效的绝对目录。');
  return withRoleStorageLock(async () => {
    const oldDir = roleStorageDirectory();
    await mkdir(directory, { recursive: true });
    const target = await realpath(directory);
    const source = await realpath(oldDir).catch((error) => { if (error.code === 'ENOENT') return oldDir; throw error; });
    if (nestedPath(source, target) || nestedPath(target, source)) throw new Error('新目录不能与当前数据目录相同或互相包含。');
    if ((await readdir(target)).length) throw new Error('请选择空目录，避免覆盖已有文件。');
    const sourceCharacters = join(source, 'characters');
    async function noLinks(path) {
      if (!(await lstat(path)).isDirectory()) throw new Error('角色目录无效或包含链接，无法迁移。');
      for (const entry of await readdir(path, { withFileTypes: true })) {
        if (entry.isSymbolicLink()) throw new Error('角色数据包含链接，请先检查后再迁移。');
        if (entry.isDirectory()) await noLinks(join(path, entry.name));
        else if (!entry.isFile()) throw new Error('角色数据包含不支持的文件类型。');
      }
    }
    await noLinks(sourceCharacters);
    await cp(sourceCharacters, join(target, 'characters'), { recursive: true, errorOnExist: true, force: false });
    const sourceActive = join(source, 'active.jsonl');
    const activeInfo = await lstat(sourceActive).catch((error) => { if (error.code === 'ENOENT') return null; throw error; });
    if (activeInfo && !activeInfo.isFile()) throw new Error('当前角色记录不是普通文件，无法迁移。');
    if (activeInfo) await copyFile(sourceActive, join(target, 'active.jsonl'), 1);
    const tmp = join(dirname(configPath), '.role-storage-' + randomUUID() + '.tmp');
    try {
      await writeFile(tmp, JSON.stringify({ directory: target }), { flag: 'wx', mode: 0o600 });
      await rename(tmp, configPath);
    } finally { await rm(tmp, { force: true }); }
    return { ...await getRoleStorage(), previousDirectory: source };
  });
}
