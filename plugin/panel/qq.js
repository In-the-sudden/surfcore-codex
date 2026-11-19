'use strict';
let qqInitialized = false, qqBusy = false, qqState, qqSupportsAliases = false;
const qqFields = ['owner', 'bot', 'admins', 'groups', 'ws', 'http', 'social-enabled', 'social-name', 'social-keywords', 'social-speakers', 'social-probability'];
function addSocialControls() {
  if ($('qq-social-enabled')) return;
  const form = $('qq-settings'), group = document.createElement('fieldset');
  const legend = document.createElement('legend'); legend.textContent = '群聊自主参与'; group.append(legend);
  const fields = [
    ['social-enabled', '启用社交决策', 'checkbox'],
    ['social-name', '角色名字和绰号（逗号分隔，可选）', 'text'],
    ['social-keywords', '关键词（逗号分隔）', 'text'],
    ['social-speakers', '指定成员 QQ（逗号分隔）', 'text'],
    ['social-probability', '普通消息参与概率（0–25%）', 'number'],
  ];
  for (const [id, title, type] of fields) {
    const label = document.createElement('label'), input = document.createElement('input');
    input.id = 'qq-' + id; input.type = type;
    if (type === 'number') { input.min = '0'; input.max = '0.25'; input.step = '0.01'; input.value = '0'; }
    label.append(document.createTextNode(title), input); group.append(label);
  }
  const hint = document.createElement('p'); hint.className = 'hint';
  hint.textContent = '默认关闭且概率为 0。发送模式下，主人首次正常私聊回复后会询问是否允许本次登录参与白名单群；主人回复“同意群聊”后才接收白名单群成员消息，回复“撤销群聊”可立即关闭，退出或重启后授权失效。白名单外始终不处理；私聊仍直接回复。模型可选择发言、等待或潜水，等待和潜水不会启动后台发送。';
  group.append(hint); form.append(group);
}
addSocialControls();
function renderQQ(data) {
  qqState = data;
  $('qq-media-settings').hidden = data.mediaSettings !== true;
  qqSupportsAliases = Array.isArray(data.config?.social?.botNames);
  const labels = { stopped: '已停止', connecting: '连接中', connected: '已连接' };
  $('qq-state').textContent = '状态：' + (labels[data.state] || data.state) + (data.mode ? ' · ' + (data.mode === 'preview' ? '预览模式' : '发送模式') : '') + (data.paused ? ' · 已暂停' : '');
  if (!qqInitialized) {
    const config = data.config;
    $('qq-owner').value = config.owner; $('qq-bot').value = config.selfId;
    $('qq-admins').value = config.admins.join(', '); $('qq-groups').value = config.groups.join(', ');
    $('qq-ws').value = config.wsUrl; $('qq-http').value = config.httpUrl;
    const social = config.social || {};
    $('qq-social-enabled').checked = social.enabled === true;
    $('qq-social-name').value = (social.botNames || (social.botName ? [social.botName] : [])).join(', ');
    $('qq-social-keywords').value = (social.keywords || []).join(', ');
    $('qq-social-speakers').value = (social.speakerIds || []).join(', ');
    $('qq-social-probability').value = String(social.probability ?? 0);
    qqInitialized = true;
  }
  const running = data.state !== 'stopped';
  for (const field of qqFields) $('qq-' + field).disabled = running;
  $('qq-save').disabled = running;
  $('qq-preview').disabled = running; $('qq-send').disabled = running;
  $('qq-pause').disabled = data.state !== 'connected'; $('qq-pause').textContent = data.paused ? '恢复' : '暂停';
  $('qq-stop').disabled = !running;
  $('qq-log').textContent = data.log.length ? data.log.map((item) => new Date(item.at).toLocaleTimeString('zh-CN') + '  ' + item.message).join('\n') : '暂无记录';
}
async function refreshQQ() {
  if (qqBusy) return;
  try { renderQQ(await api('qq')); } catch (error) { $('qq-state').textContent = error.message; }
}
async function qqAction(button, path, data = {}) {
  qqBusy = true;
  button.disabled = true;
  try { renderQQ(await api('qq/' + path, 'POST', data)); status('QQ 桥接操作已完成。'); }
  catch (error) { status(error.message, true); }
  finally { qqBusy = false; await refreshQQ(); }
}
$('qq-settings').onsubmit = (event) => {
  event.preventDefault();
  const ids = (field) => $('qq-' + field).value.split(/[,，\s]+/).filter(Boolean);
  const names = $('qq-social-name').value.split(/[,，]/).map((name) => name.trim()).filter(Boolean);
  if (names.length > 1 && !qqSupportsAliases) {
    status('当前控制台后端不支持多个名字，请打开加载新版代码的新控制台后保存。', true);
    return;
  }
  qqAction($('qq-save'), 'settings', { owner: $('qq-owner').value.trim(), selfId: $('qq-bot').value.trim(), admins: ids('admins'), groups: ids('groups'), wsUrl: $('qq-ws').value.trim(), httpUrl: $('qq-http').value.trim(), social: { enabled: $('qq-social-enabled').checked, botName: names[0] || '', botNames: names, keywords: $('qq-social-keywords').value.split(/[,，\s]+/).filter(Boolean), speakerIds: $('qq-social-speakers').value.split(/[,，\s]+/).filter(Boolean), probability: Number($('qq-social-probability').value) } });
};
for (const mode of ['preview', 'send']) $('qq-' + mode).onclick = () => qqAction($('qq-' + mode), 'start', { mode, wsToken: $('qq-ws-token').value, httpToken: $('qq-http-token').value, useSnowTokens: $('qq-snow-tokens').checked });
$('qq-pause').onclick = () => qqAction($('qq-pause'), 'pause', { paused: !qqState.paused });
$('qq-stop').onclick = () => qqAction($('qq-stop'), 'stop');
$('qq-refresh').onclick = refreshQQ;
refreshQQ();
setInterval(refreshQQ, 5000);

let qqFaceRevision, qqFaceRows = [];
function renderQQFaces({ faces, revision }) {
  qqFaceRevision = revision;
  qqFaceRows = faces.map((face) => {
    const card = document.createElement('div');
    card.className = 'qq-face';
    if (face.image) {
      const image = document.createElement('img');
      image.alt = '';
      image.loading = 'lazy';
      image.onerror = () => { image.hidden = true; };
      image.src = face.image;
      card.append(image);
    }
    const check = document.createElement('label');
    check.className = 'check';
    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.checked = face.enabled;
    check.append(enabled, document.createTextNode(face.description));

    const label = document.createElement('label');
    const tag = document.createElement('input');
    tag.type = 'text';
    tag.maxLength = 60;
    tag.value = face.label;
    tag.required = face.enabled;
    enabled.onchange = () => { tag.required = enabled.checked; };
    label.append(document.createTextNode('标签'), tag);
    card.append(check, label);
    return { card, enabled, tag, id: face.id };
  });
  $('qq-faces-list').replaceChildren(...qqFaceRows.map(({ card }) => card));
  $('qq-faces-form').hidden = false;
}
async function qqFaceAction(work) {
  $('qq-faces-sync').disabled = true;
  $('qq-faces-form').inert = true;
  try { $('qq-faces-status').textContent = await work(); }
  catch (error) { $('qq-faces-status').textContent = error.message; }
  finally {
    $('qq-faces-sync').disabled = false;
    $('qq-faces-form').inert = false;
  }
}
$('qq-faces-sync').onclick = () => qqFaceAction(async () => {
  $('qq-faces-status').textContent = '正在同步机器人收藏…';
  const result = await api('qq/faces/sync', 'POST', {
    useSnowTokens: $('qq-snow-tokens').checked,
    httpToken: $('qq-http-token').value,
  });
  renderQQFaces(result);
  const enabled = result.faces.filter((face) => face.enabled).length;
  return '已同步 ' + result.faces.length + ' 张，已启用 ' + enabled + ' 张。';
});
$('qq-faces-form').onsubmit = (event) => {
  event.preventDefault();
  qqFaceAction(async () => {
    const faces = qqFaceRows.filter(({ enabled }) => enabled.checked).map(({ id, tag }) => ({ id, label: tag.value }));
    const result = await api('qq/faces/save', 'POST', { revision: qqFaceRevision, faces });
    return '已保存 ' + result.count + ' 张可用表情。';
  });
};
$('qq-song-import-form').onsubmit = async (event) => {
  event.preventDefault();
  const button = $('qq-song-import-save'), feedback = $('qq-song-import-status');
  const seconds = (id) => $(id).value === '' ? null : $(id).valueAsNumber;
  button.disabled = true;
  feedback.textContent = '正在读取录音…';
  try {
    const result = await api('qq/song/import', 'POST', {
      title: $('qq-song-title').value, artist: $('qq-song-artist').value, path: $('qq-song-path').value,
      vocal: $('qq-song-vocal').value,
      openingVocalStart: seconds('qq-song-opening-vocal-start'), openingEnd: seconds('qq-song-opening-end'),
      chorusStart: seconds('qq-song-chorus-start'), chorusEnd: seconds('qq-song-chorus-end'),
    });
    const portions = [result.hasOpening && '开头', result.hasChorus && '副歌'].filter(Boolean);
    feedback.textContent = '已导入《' + result.title + '》（' + result.artist + '）。' +
      (portions.length ? '可点' + portions.join('或') + '。' : '点唱前请补充这份录音的段落时间。');
    event.target.reset();
  } catch (error) { feedback.textContent = error.message; }
  finally { button.disabled = false; }
};

let snowBusy = false;
async function refreshSnow() {
  const state = await api('snowluma');
  if (typeof state.ready !== 'boolean' && state.installed) {
    $('snow-status').textContent = '请重新启动 SurfCore 控制台以加载新版 SnowLuma 启动功能。';
    $('snow-start').disabled = true;
    $('snow-open').hidden = true;
    return state;
  }
  $('snow-status').textContent = state.error || (state.ready ? 'SnowLuma 页面已就绪。' : state.listening ? '页面端口已被占用，但无法确认是 SnowLuma。' : state.starting || snowBusy ? '正在启动 SnowLuma…' : 'SnowLuma 尚未运行。');
  $('snow-start').disabled = snowBusy || !state.installed || state.listening || state.starting;
  $('snow-open').hidden = !state.ready || !state.url;
  if (state.ready && state.url) $('snow-open').href = state.url;
  return state;
}
$('snow-start').onclick = async () => {
  const popup = window.open('about:blank', '_blank');
  let failure = '';
  snowBusy = true;
  $('snow-start').disabled = true;
  $('snow-status').textContent = '正在启动 SnowLuma…';
  try {
    if (popup) { popup.document.title = '正在启动 SnowLuma'; popup.document.body.textContent = '正在启动 SnowLuma，请稍候…'; }
    await api('snowluma/start', 'POST', {});
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const state = await refreshSnow();
      if (state.ready && state.url) {
        if (popup) popup.location.replace(state.url);
        else $('snow-status').textContent = 'SnowLuma 已就绪，请点击“打开 SnowLuma”（浏览器拦截了自动打开）。';
        return;
      }
      if (state.error) throw new Error(state.error);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error('等待 SnowLuma 页面超时，请检查 SnowLuma 自身日志后重试。');
  } catch (error) {
    if (popup) popup.close();
    status(error.message, true);
    failure = error.message;
  } finally {
    snowBusy = false;
    try { await refreshSnow(); } catch {}
    if (failure) $('snow-status').textContent = failure;
  }
};
$('snow-refresh').onclick = () => refreshSnow().catch((error) => { $('snow-status').textContent = error.message; });
refreshSnow().catch((error) => { $('snow-status').textContent = error.message; });
setInterval(() => refreshSnow().catch(() => {}), 5000);
