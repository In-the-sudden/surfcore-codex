import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { dataDirectory } from './role-storage.mjs';

export const VOICE_PROVIDERS = Object.freeze({
  local: { kind: 'voxd', label: 'SurfVoice 本地包', baseUrl: 'http://127.0.0.1:8765', online: false, tokenEnv: 'SURFCORE_VOICE_LOCAL_TOKEN' },
  cloud: { kind: 'voxd', label: 'SurfVoice 云端包', baseUrl: 'http://127.0.0.1:8767', online: true, tokenEnv: 'SURFCORE_VOICE_CLOUD_TOKEN' },
  breeze: { kind: 'breeze', label: 'Breeze 本机', baseUrl: 'http://127.0.0.1:7860', online: false, tokenEnv: 'SURFCORE_VOICE_BREEZE_TOKEN' },
});
const file = join(dataDirectory, 'voice-providers.jsonl');
export const DESIGN_VOICE = '@design';
export const DESIGN_INSTRUCTION = 'A young adult woman speaking clear, natural Mandarin with a warm, calm voice.';
export const validVoiceId = (id) => typeof id === 'string' && /^[a-zA-Z0-9_.-]{1,96}$/.test(id);

export function validateStyle(style = {}, providerId = 'breeze') {
  if (VOICE_PROVIDERS[providerId]?.kind === 'voxd') {
    if (!style || typeof style !== 'object' || Array.isArray(style) || JSON.stringify(style).length > 2048 || Object.entries(style).some(([key, value]) =>
      !/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/.test(key) || !['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value)))) throw new Error('voxd 风格应为不超过 2048 字符的简单 JSON 对象。');
    return { ...style };
  }
  if (!style || typeof style !== 'object' || Array.isArray(style) || Object.keys(style).some((key) => !['instruction', 'seed', 'cfgScale'].includes(key))) throw new Error('语音风格参数无效。');
  const result = {};
  if (style.instruction !== undefined) {
    if (typeof style.instruction !== 'string' || [...style.instruction].length > 500 || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(style.instruction)) throw new Error('语音指令最多 500 字符。');
    if (style.instruction.trim()) result.instruction = style.instruction.trim();
  }
  if (style.seed !== undefined) {
    if (!Number.isSafeInteger(style.seed) || style.seed < 0 || style.seed > 2_147_483_647) throw new Error('语音种子应为 0 到 2147483647 的整数。');
    result.seed = style.seed;
  }
  if (style.cfgScale !== undefined) {
    if (!Number.isFinite(style.cfgScale) || style.cfgScale < 1 || style.cfgScale > 3) throw new Error('语音指令强度应为 1 到 3。');
    result.cfgScale = style.cfgScale;
  }
  return result;
}

export function voiceBinding(value) {
  if (!value || !Object.hasOwn(VOICE_PROVIDERS, value.providerId) || !(validVoiceId(value.voiceId) || (value.providerId === 'breeze' && value.voiceId === DESIGN_VOICE))) throw new Error('请选择有效的语音服务和音色。');
  return { providerId: value.providerId, voiceId: value.voiceId, style: validateStyle(value.style, value.providerId) };
}

export async function readProvider(providerId) {
  if (!Object.hasOwn(VOICE_PROVIDERS, providerId)) throw new Error('请选择有效的语音服务。');
  let changes;
  try { changes = (await readFile(file, 'utf8')).split('\n').filter(Boolean).map((line) => JSON.parse(line)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; changes = []; }
  const saved = changes.findLast((row) => row.providerId === providerId) || {};
  return { ...VOICE_PROVIDERS[providerId], ...saved, providerId };
}

export async function configureProvider(value) {
  if (value?.providerId !== 'breeze') throw new Error('目前仅 Breeze 支持自定义本机服务配置。');
  const current = await readProvider(value.providerId);
  const next = { providerId: value.providerId };
  const url = new URL(value.baseUrl ?? current.baseUrl);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Breeze 地址须为 http://127.0.0.1:端口。');
  next.baseUrl = url.origin;
  for (const key of ['dir', 'modelPath']) {
    const path = value[key] ?? current[key] ?? '';
    if (typeof path !== 'string' || (path && !isAbsolute(path))) throw new Error('引擎与模型须使用绝对路径。');
    next[key] = path;
  }
  next.cpu = value.cpu ?? current.cpu ?? false;
  if (typeof next.cpu !== 'boolean') throw new Error('CPU 配置无效。');
  await mkdir(dataDirectory, { recursive: true });
  await appendFile(file, JSON.stringify(next) + '\n', { mode: 0o600 });
  return readProvider(next.providerId);
}
