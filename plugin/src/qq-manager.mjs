import { snowLumaDirectory } from './local-installation.mjs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { dataDirectory } from './store.mjs';
import { startOneBot } from './bridge.mjs';
import { runCodex } from './codex.mjs';
import { createQQFaceSettings, readQQFaces } from './qq-faces.mjs';

const file = join(dataDirectory, 'qq-settings.json');
const defaults = { owner: '', selfId: '', admins: [], groups: [], wsUrl: 'ws://127.0.0.1:3001', httpUrl: 'http://127.0.0.1:3000', social: { enabled: false, botName: '', botNames: [], keywords: [], speakerIds: [], probability: 0 } };
const idPattern = /^[1-9][0-9]{3,14}$/;

function validate(config) {
  if (!config || !idPattern.test(config.owner) || !idPattern.test(config.selfId) || config.owner === config.selfId) {
    throw new Error('请输入不同的主人 QQ 和机器人 QQ。');
  }
  for (const key of ['admins', 'groups']) {
    if (!Array.isArray(config[key]) || config[key].length > 100 || config[key].some((id) => typeof id !== 'string' || !idPattern.test(id))) {
      throw new Error('管理员和群白名单需填写有效号码，每项最多 100 个。');
    }
  }
  if (config.admins.includes(config.selfId)) throw new Error('管理员白名单不能包含机器人 QQ。');
  for (const [key, protocol] of [['wsUrl', 'ws:'], ['httpUrl', 'http:']]) {
    let url;
    try { url = new URL(config[key]); } catch { throw new Error('OneBot 地址无效。'); }
    if (url.protocol !== protocol || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash) {
      throw new Error('OneBot 地址只接受本机 127.0.0.1，令牌需单独填写。');
    }
  }
  const social = config.social && typeof config.social === 'object' ? config.social : defaults.social;
  if (typeof social.enabled !== 'boolean' || typeof (social.botName ?? '') !== 'string' || (social.botName ?? '').length > 40
    || (social.botNames !== undefined && (!Array.isArray(social.botNames) || social.botNames.length > 20
      || social.botNames.some((value) => typeof value !== 'string' || !value.trim() || value.length > 40)))
    || !Array.isArray(social.keywords ?? []) || (social.keywords ?? []).length > 20
    || (social.keywords ?? []).some((value) => typeof value !== 'string' || value.length > 40)
    || !Array.isArray(social.speakerIds ?? []) || (social.speakerIds ?? []).length > 100
    || (social.speakerIds ?? []).some((id) => typeof id !== 'string' || !idPattern.test(id))
    || !Number.isFinite(social.probability ?? 0) || (social.probability ?? 0) < 0 || (social.probability ?? 0) > 0.25) {
    throw new Error('自主参与设置无效：角色名最多 20 个、每个最多 40 字符；请检查关键词、成员 QQ 和 0–25% 概率。');
  }
  const names = social.botNames ?? (social.botName?.trim() ? [social.botName] : []);
  const botNames = [...new Set(names.map((name) => name.trim()))];
  return { owner: config.owner, selfId: config.selfId, admins: [...new Set(config.admins)], groups: [...new Set(config.groups)], wsUrl: config.wsUrl, httpUrl: config.httpUrl,
    social: { enabled: social.enabled, botName: botNames[0] ?? '', botNames, keywords: [...new Set(social.keywords ?? [])], speakerIds: [...new Set(social.speakerIds ?? [])], probability: social.probability ?? 0 } };
}

async function readConfig() {
  try { return validate(JSON.parse(await readFile(file, 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return { ...defaults }; throw error; }
}

export async function snowTokens(config, directory = snowLumaDirectory()) {
  const snow = JSON.parse(await readFile(join(directory, 'config', 'onebot_' + config.selfId + '.json'), 'utf8'));
  function token(servers, address) {
    const url = new URL(address);
    const matches = (servers ?? []).filter((server) => server.host === url.hostname && String(server.port) === url.port && (server.path || '/') === url.pathname);
    if (matches.length !== 1 || typeof matches[0].accessToken !== 'string') throw new Error('无法匹配 SnowLuma 的 OneBot 地址和令牌，请检查机器人及端口配置。');
    return matches[0].accessToken;
  }
  return { httpToken: token(snow.networks?.httpServers, config.httpUrl), wsToken: token(snow.networks?.wsServers, config.wsUrl) };
}

export function createQQManager({ runner = startOneBot, generate = runCodex, loadTokens = snowTokens } = {}) {
  let state = 'stopped', mode = null, paused = false, controller, running, starting = false, generation = 0;
  let activeHttpToken, groupAuthorized = false;
  const faceSettings = createQQFaceSettings();
  const log = [];
  function note(message) {
    log.push({ at: new Date().toISOString(), message });
    if (log.length > 100) log.shift();
  }
  async function status() { return { state, mode, paused, groupAuthorized, config: await readConfig(), log: [...log], mediaSettings: true }; }
  async function syncFaces({ httpToken = '', useSnowTokens = false } = {}) {
    const config = await readConfig();
    if (!config.selfId) throw new Error('请先保存机器人 QQ 和 OneBot 地址。');
    if (typeof httpToken !== 'string' || httpToken.length > 4096 || typeof useSnowTokens !== 'boolean') throw new Error('OneBot 令牌无效。');
    const token = activeHttpToken ?? (useSnowTokens ? (await loadTokens(config)).httpToken : httpToken);
    return faceSettings.sync(config, token);
  }
  async function saveFaces(input) { return faceSettings.save(await readConfig(), input); }
  async function save(input) {
    if (running || starting) throw new Error('请先停止本控制台管理的桥接，再修改连接设置。');
    const current = await readConfig();
    let social = input?.social ?? current.social;
    if (social && social.botNames === undefined && social.botName === current.social.botName) {
      social = { ...social, botNames: current.social.botNames };
    }
    const config = validate({ ...input, social });
    await mkdir(dataDirectory, { recursive: true });
    const temp = file + '.' + randomUUID() + '.tmp';
    await writeFile(temp, JSON.stringify(config, null, 2), { mode: 0o600 });
    await rename(temp, file);
    note('连接设置已保存。');
    return status();
  }
  async function start({ mode: requested, wsToken = '', httpToken = '', useSnowTokens = false }) {
    if (running || starting) throw new Error('本控制台已启动桥接。');
    if (!['preview', 'send'].includes(requested)) throw new Error('请选择预览或发送模式。');
    if (typeof useSnowTokens !== 'boolean' || typeof wsToken !== 'string' || typeof httpToken !== 'string' || wsToken.length > 4096 || httpToken.length > 4096) throw new Error('OneBot 令牌无效。');
    starting = true;
    controller = new AbortController();
    const thisController = controller;
    mode = requested; paused = false; groupAuthorized = false; state = 'connecting';
    let config;
    try {
      config = validate(await readConfig());
      if (useSnowTokens) ({ wsToken, httpToken } = await loadTokens(config));
      if (typeof wsToken !== 'string' || typeof httpToken !== 'string' || wsToken.length > 4096 || httpToken.length > 4096) throw new Error('OneBot 令牌无效。');
      if (thisController.signal.aborted) { controller = null; return status(); }
    } catch (error) {
      state = 'stopped'; mode = null; controller = null;
      throw error;
    } finally { starting = false; }
    note('正在连接 OneBot（' + (mode === 'preview' ? '预览' : '发送') + '）。');
    activeHttpToken = httpToken;
    running = Promise.resolve().then(() => runner({ ...config, wsToken, httpToken, generate, send: mode === 'send', autonomousMedia: true, signal: thisController.signal,
      loadReplyFaces: (roleId) => roleId === 'zhiwei' ? readQQFaces(config.selfId) : [],
      shouldContinue: () => !paused && !thisController.signal.aborted,
      generationToken: () => generation,
      onEvent: (event) => {
        if (event.type === 'connected') { state = 'connected'; note('OneBot WebSocket 已连接。'); }
        else if (event.type === 'error') note('处理失败：' + event.message);
        else if (event.type === 'preview') note('预览 · ' + (event.kind === 'group' ? '群' : '私聊') + '尾号 ' + event.contact.slice(-4) + '：' + event.reply);
        else if (event.type === 'sent') note((event.format === 'record' ? 'OneBot 已接受语音' : event.format === 'face' ? 'OneBot 已接受收藏表情' : event.format === 'local-sticker' ? 'OneBot 已接受本地表情' : '已发送') +
          ' · ' + (event.kind === 'group' ? '群' : '私聊') + '尾号 ' + event.contact.slice(-4));
        else if (event.type === 'voiceFallback') note('语音合成不可用，改用文字：' + event.reason);
        else if (event.type === 'voiceVerified') note('OneBot 回读确认是语音条。');
        else if (event.type === 'voiceUnverified') note('OneBot 已接受语音，暂未回读确认。');
        else if (event.type === 'group-authorization') groupAuthorized = event.authorized === true;
        else if (event.type === 'memory-compressed') note('模型压缩完成 · ' + (event.scope.includes('-group-') ? '群' : '私聊') + '尾号 ' + event.scope.slice(-4) + ' · ' + event.processed + ' 条来源记录');
      },
    })).then(() => { note('桥接已停止或连接已关闭。'); }, (error) => {
      if (!thisController.signal.aborted) note('桥接连接失败：' + error.message);
    }).finally(() => { state = 'stopped'; mode = null; paused = false; groupAuthorized = false; running = null; controller = null; activeHttpToken = undefined; });
    return status();
  }
  async function stop() {
    if (controller) controller.abort();
    if (running) await running;
    else { state = 'stopped'; mode = null; paused = false; }
    return status();
  }
  async function pause(value) {
    if (!running || state !== 'connected' || typeof value !== 'boolean') throw new Error('只有已连接的桥接可以暂停或恢复。');
    if (value && !paused) generation++;
    paused = value; note(value ? '已暂停处理新消息。' : '已恢复处理消息。');
    return status();
  }
  return { status, save, start, stop, pause, syncFaces, saveFaces };
}
