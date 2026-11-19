import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDirectory } from './role-storage.mjs';

const MAX_FACES = 100;
const accountId = /^[1-9]\d{3,14}$/u;
const faceId = /^[^\p{Cc}\s]{1,512}$/u;

function labelText(value) {
  return typeof value === 'string' ? value.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim().slice(0, 60) : '';
}

function faceImage(value) {
  if (typeof value !== 'string' || value.length > 4096) return undefined;
  try {
    const url = new URL(value);
    if (url.origin === 'https://p.qpic.cn' && !url.username && !url.password) return url.href;
  } catch {}
  return undefined;
}

function selectionFile(selfId) {
  if (typeof selfId !== 'string' || !accountId.test(selfId)) throw new Error('请先保存机器人 QQ。');
  return join(dataDirectory, 'qq-faces-' + selfId + '.json');
}

export async function readQQFaces(selfId) {
  try {
    const entries = JSON.parse(await readFile(selectionFile(selfId), 'utf8'));
    if (!Array.isArray(entries) || entries.length > MAX_FACES) return [];
    return entries.filter((entry) => typeof entry?.id === 'string' && faceId.test(entry.id) && labelText(entry.label))
      .map((entry) => ({ id: entry.id, label: labelText(entry.label) }));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export function createQQFaceSettings() {
  let lastSync;
  async function sync({ selfId, httpUrl }, token) {
    selectionFile(selfId);
    lastSync = undefined;
    const url = new URL(httpUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password) {
      throw new Error('OneBot 地址只接受本机 127.0.0.1。');
    }
    async function action(name, body) {
      const response = await fetch(new URL('/' + name, url), {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/json', ...(token && { Authorization: 'Bearer ' + token }) },
        body: JSON.stringify(body),
      });
      if (!response.ok) throw new Error('读取 SnowLuma 失败，请检查机器人登录和 OneBot HTTP 令牌。');
      const result = await response.json();
      if (result?.retcode !== 0) throw new Error('SnowLuma 无法读取当前机器人收藏。');
      return result.data;
    }
    const login = await action('get_login_info', {});
    if (String(login?.user_id) !== selfId) throw new Error('SnowLuma 当前登录账号与配置的机器人 QQ 不一致。');
    const details = await action('fetch_custom_face_detail', { count: MAX_FACES });
    if (!Array.isArray(details)) throw new Error('SnowLuma 返回的收藏列表格式无效。');
    const selected = new Map((await readQQFaces(selfId)).map(({ id, label }) => [id, label]));
    const catalog = new Map();
    for (const face of details.slice(0, MAX_FACES)) {
      const id = face?.emoji_id;
      if (typeof id !== 'string' || !faceId.test(id) || catalog.has(id)) continue;
      const description = labelText(face.desc) || '无备注表情';
      catalog.set(id, { id, description, image: faceImage(face.url), enabled: selected.has(id), label: selected.get(id) ?? description });
    }
    const revision = randomUUID();
    lastSync = { selfId, httpUrl, revision, catalog };
    return { revision, faces: [...catalog.values()] };
  }

  async function save({ selfId, httpUrl }, { revision, faces } = {}) {
    const file = selectionFile(selfId);
    if (!lastSync || selfId !== lastSync.selfId || httpUrl !== lastSync.httpUrl || revision !== lastSync.revision) {
      throw new Error('请先同步当前机器人收藏。');
    }
    if (!Array.isArray(faces) || faces.length > MAX_FACES) throw new Error('表情勾选格式无效。');
    const seen = new Set();
    const selected = faces.map((face) => {
      const id = face?.id;
      const label = labelText(face?.label);
      if (!lastSync.catalog.has(id) || seen.has(id) || !label) throw new Error('请为勾选的收藏表情填写标签。');
      seen.add(id);
      return { id, label };
    });
    const temporary = file + '.' + randomUUID() + '.tmp';
    await mkdir(dataDirectory, { recursive: true });
    try {
      await writeFile(temporary, JSON.stringify(selected, null, 2), { flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
    } finally { await unlink(temporary).catch(() => {}); }
    return { count: selected.length };
  }
  return { sync, save };
}
