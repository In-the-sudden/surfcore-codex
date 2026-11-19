'use strict';
const $ = (id) => document.getElementById(id);
const suppliedAccess = new URLSearchParams(location.hash.slice(1)).get('access');
let access = suppliedAccess || '';
try { if (suppliedAccess) sessionStorage.setItem('surfcore-access', suppliedAccess); else access = sessionStorage.getItem('surfcore-access') || ''; } catch {}
history.replaceState(null, '', location.pathname);
let memories = [], generation = 0, memoryGeneration = 0, memoryOffset = 0, memoryTotal = 0, memoryCapacityState = null, audioUrl, revision, activeRole;
let narrativePlan = null;
let extractionGeneration = 0, extractionPending = 0, extractionBusy = false, modelBusy = false, extractionRevision = '';
let voiceController, savedVoice = null, voiceStates = [];
const status = (text, error = false) => { $('status').textContent = text; $('status').classList.toggle('error', error); };
async function api(path, method = 'GET', data, audio = false, signal) {
  const response = await fetch('/api/' + path, { method, signal, headers: { 'X-SurfCore-Key': access, ...(data === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: data === undefined ? undefined : JSON.stringify(data) });
  if (!response.ok) { const result = await response.json(); throw new Error(result.error || '请求失败'); }
  return audio ? response.blob() : response.json();
}
function options(select, values) { select.replaceChildren(...Object.entries(values).map(([id, name]) => new Option(name, id))); }
function voiceReset() {
  voiceController?.abort();
  $('voice-style').hidden = $('pack').value !== 'breeze';
  $('voxd-style').hidden = !['local', 'cloud'].includes($('pack').value);
  $('voice').replaceChildren(); $('voice').disabled = true;
  $('sample').disabled = true; $('save-voice').disabled = $('pack').value !== 'none';
  $('load-voices').disabled = $('pack').value === 'none';
  $('voice-state').textContent = $('pack').value === 'none' ? '当前不使用语音包。' : '请加载此服务的音色后再保存。';
  $('audio').pause(); $('audio').hidden = true;
  if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = undefined; }
}
function renderMemories() {
  const rows = memories;
  $('memories').replaceChildren();
  if (!rows.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = '没有符合条件的记忆。'; $('memories').append(empty); }
  for (const row of rows) {
    const card = document.createElement('article'); card.className = 'memory';
    const head = document.createElement('div'); head.className = 'memory-head';
    const meta = document.createElement('span'); meta.className = 'badge'; meta.textContent = row.scope + ' · ' + new Date(row.at).toLocaleString('zh-CN');
    const controls = document.createElement('div'); controls.className = 'actions';
    const boost = document.createElement('button'); boost.type = 'button'; boost.className = 'secondary'; boost.textContent = '强化';
    boost.onclick = () => action(boost, async () => { await api('memory/weight', 'POST', { characterId: $('character').value, scope: row.scope, memoryId: row.id, action: 'boost' }); await loadMemories(); });
    const pin = document.createElement('button'); pin.type = 'button'; pin.className = 'secondary'; pin.textContent = row.pinned ? '取消永久固定' : '永久固定';
    pin.disabled = row.archived;
    if (row.archived) pin.title = '请先恢复召回';
    pin.setAttribute('aria-pressed', String(row.pinned));
    pin.onclick = () => action(pin, async () => { await api('memory/weight', 'POST', { characterId: $('character').value, scope: row.scope, memoryId: row.id, action: 'pin', enabled: !row.pinned }); await loadMemories(); });
    const archive = document.createElement('button'); archive.type = 'button'; archive.className = 'secondary'; archive.textContent = row.archived ? '恢复召回' : '仅存档';
    archive.disabled = row.pinned;
    if (row.pinned) archive.title = '请先取消永久固定';
    archive.onclick = () => action(archive, async () => { await api('memory/archive', 'POST', { characterId: $('character').value, scope: row.scope, memoryId: row.id, archived: !row.archived }); await loadMemories(); });
    controls.append(boost, pin, archive);
    if (row.reinforced) {
      const legacy = document.createElement('button'); legacy.type = 'button'; legacy.className = 'secondary'; legacy.textContent = '取消旧版强化';
      legacy.onclick = () => action(legacy, async () => { await api('memory/strength', 'POST', { characterId: $('character').value, scope: row.scope, memoryId: row.id, enabled: false }); await loadMemories(); });
      controls.append(legacy);
    }
    const text = document.createElement('p'); text.textContent = row.note || ['来信：' + (row.incoming || ''), '回复：' + (row.reply || '')].join('\n');
    const weight = document.createElement('p'); weight.textContent = (row.archived ? '仅存档，不参与召回 · ' : '') + '召回权重：' + row.weight + '% · ' + (row.clarity || '未提供清晰度') + ' · ' + (row.clarityReason || '随时间衰减');
    if (row.compressedLevel) {
      const restore = document.createElement('button'); restore.type = 'button'; restore.className = 'secondary'; restore.textContent = '恢复整理前清晰度';
      restore.onclick = () => action(restore, async () => { await api('memory/narrative-restore', 'POST', { characterId: $('character').value, scope: row.scope, memoryId: row.id }); await loadMemories(); });
      controls.append(restore);
    }
    const modelCard = row.modelCards?.[0];
    const cardFields = row.card || modelCard;
    const details = document.createElement('details'), summary = document.createElement('summary');
    summary.textContent = '记忆卡' + (row.card ? ' · 已编辑' : modelCard ? ' · 模型已填写' : ''); details.append(summary);
    if (row.modelCards?.length > 1) {
      const related = document.createElement('p');
      related.textContent = row.modelCards.map(({ who, event, feeling }) => [who, event, feeling].filter(Boolean).join(' · ')).join('\n');
      details.append(related);
    }
    const form = document.createElement('form');
    for (const [key, label] of [['who', '谁'], ['event', '做了什么'], ['feeling', '心情或感受']]) {
      const field = document.createElement('label'), input = document.createElement('textarea');
      field.textContent = label; input.maxLength = 500; input.rows = 2; input.value = cardFields?.[key] || ''; field.append(input); form.append(field);
      input.name = key;
    }
    const importanceLabel = document.createElement('label'), importance = document.createElement('select');
    importanceLabel.textContent = '重要程度'; importance.name = 'importance';
    options(importance, { 1: '普通', 2: '重要', 3: '特别重要' }); importance.value = String(cardFields?.importance ?? row.importance);
    importanceLabel.append(importance); form.append(importanceLabel);
    const save = document.createElement('button'); save.textContent = '保存记忆卡'; form.append(save);
    form.onsubmit = (event) => { event.preventDefault(); action(save, async () => {
      const card = Object.fromEntries(new FormData(form));
      card.importance = Number(card.importance);
      await api('memory/card', 'POST', { characterId: $('character').value, scope: row.scope, memoryId: row.id, card });
      await loadMemories();
    }); };
    details.append(form); head.append(meta, controls); card.append(head, text, weight, details); $('memories').append(card);
  }
  renderMemoryGraph(rows);
}
function renderMemoryGraph(rows) {
  const host = $('memory-graph'); host.replaceChildren(); $('memory-graph-selection').textContent = '';
  if (!rows.length) return;
  const ns = 'http://www.w3.org/2000/svg', svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 1000 400'); svg.setAttribute('aria-label', '当前页记忆，按时间排列');
  const scopes = [...new Set(rows.map((row) => row.scope))].sort();
  const sorted = [...rows].sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
  const previous = new Map();
  sorted.forEach((row, index) => {
    const x = 35 + (sorted.length === 1 ? 465 : index * 930 / (sorted.length - 1));
    const y = 40 + (scopes.length === 1 ? 160 : scopes.indexOf(row.scope) * 320 / (scopes.length - 1));
    if (previous.has(row.scope)) {
      const line = document.createElementNS(ns, 'line'), p = previous.get(row.scope);
      for (const [key, value] of Object.entries({ x1: p.x, y1: p.y, x2: x, y2: y })) line.setAttribute(key, value);
      line.setAttribute('class', 'graph-link'); svg.append(line);
    }
    previous.set(row.scope, { x, y });
    const node = document.createElementNS(ns, 'circle');
    for (const [key, value] of Object.entries({ cx: x, cy: y, r: 5 + row.weight / 20, tabindex: 0, role: 'button' })) node.setAttribute(key, value);
    node.setAttribute('class', row.archived ? 'graph-node archived' : row.pinned ? 'graph-node pinned' : 'graph-node');
    const label = row.card?.event || row.note || row.incoming || '记忆';
    node.setAttribute('aria-label', row.scope + '，' + label.slice(0, 80));
    const select = () => { $('memory-graph-selection').textContent = row.scope + ' · ' + new Date(row.at).toLocaleString('zh-CN') + ' · ' + label; };
    node.addEventListener('click', select); node.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); } });
    svg.append(node);
  });
  host.append(svg);
}
function updateMemoryControls() {
  $('memory-previous').disabled = memoryOffset === 0;
  $('memory-next').disabled = memoryOffset + memories.length >= memoryTotal;
  $('memory-preview').disabled = !$('scope').value || $('scope').value === 'shared';
  $('extraction-run').disabled = extractionBusy || modelBusy || !$('scope').value || $('scope').value === 'shared' || extractionPending === 0;
  const compact = $('memory-compact');
  const overCapacity = memoryCapacityState && memoryCapacityState.active > memoryCapacityState.maxRecords;
  compact.disabled = !overCapacity;
  compact.title = overCapacity ? '归档低权重记录至目标容量' : '活动记忆未超过容量上限，无需整理';
  compact.setAttribute('aria-label', overCapacity ? '整理超出容量的记忆' : '整理记忆容量（当前未超出上限）');
}
function renderExtraction(data) {
  extractionPending = data.pending;
  modelBusy = data.automatic?.state === 'running';
  const formatTime = (value) => new Date(value).toLocaleString('zh-CN');
  const { state, dueAt, lastFailureAt } = data.automatic || {};
  const bridgeMessage = { stopped: '发送桥接未运行', connecting: '发送桥接正在连接', preview: '桥接处于预览模式', paused: '发送桥接已暂停',
    'not-allowed': '此范围不在当前白名单内', 'group-authorization': '等待本次群聊授权' }[data.bridgeState];
  const progress = modelBusy ? '模型正在压缩' : !data.pending ? '' : ({
    manual: '可手动压缩', 'owner-unavailable': '请先配置主人 QQ', 'usage-unknown': '未知模型用量，自动压缩暂停',
    retry: '上次失败于 ' + (lastFailureAt ? formatTime(lastFailureAt) : '') + ' · 预计 ' + (dueAt ? formatTime(dueAt) : '') + ' 重试',
    waiting: '预计 ' + (dueAt ? formatTime(dueAt) : '') + ' 自动压缩', due: '已达到自动压缩条件',
  })[state];
  $('extraction-status').textContent = ['待处理 ' + data.pending + ' 条', '已处理 ' + data.processed + ' 条',
    '可跨对话共享 ' + (data.shareableCount ?? 0) + ' 条', data.lastProcessedAt && '最近完成 ' + formatTime(data.lastProcessedAt),
    bridgeMessage && data.pending && !modelBusy ? bridgeMessage : progress].filter(Boolean).join(' · ');
  updateMemoryControls();
  const revision = JSON.stringify(data.candidates);
  if (revision === extractionRevision) return;
  extractionRevision = revision;
  const host = $('extraction-candidates'); host.replaceChildren();
  for (const candidate of data.candidates) {
    const row = document.createElement('article'); row.className = 'memory';
    const meta = document.createElement('p'); meta.className = 'badge';
    meta.textContent = (candidate.superseded ? '历史版本 · ' : '') + '来源记录：' + candidate.sourceIds.join('、') + (candidate.at ? ' · ' + new Date(candidate.at).toLocaleString('zh-CN') : '');
    const content = document.createElement('p');
    content.textContent = '谁：' + (candidate.who || '未知') + '\n事件：' + (candidate.event || '未知') + '\n感受：' + (candidate.feeling || '未知') + '\n重要程度：' + candidate.importance;
    const privacy = document.createElement('p');
    privacy.textContent = candidate.share?.summary ? (candidate.shareAvailable ? '可共享概括：' : '当前不可共享：') + candidate.share.summary :
      '共享状态：' + ({ restricted: '隐私筛选拦截', review: '没有可共享概括', unassessed: '待评估' }[candidate.privacy?.status] || '待评估');
    row.append(meta, content, privacy);
    if (candidate.share?.summary) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary'; button.textContent = candidate.shareRevoked ? '已撤销' : '撤销共享'; button.disabled = candidate.shareRevoked === true;
      button.onclick = () => action(button, async () => {
        await api('memory/sharing/revoke', 'POST', { characterId: $('character').value, candidateId: candidate.id });
        await loadExtraction({ refresh: true });
      });
      row.append(button);
    }
    host.append(row);
  }
  updateMemoryControls();
}
async function loadExtraction({ refresh = false } = {}) {
  const version = ++extractionGeneration, role = $('character').value, scope = $('scope').value;
  if (!refresh) {
    extractionPending = 0; modelBusy = false; extractionRevision = ''; $('extraction-candidates').replaceChildren(); updateMemoryControls();
    $('extraction-policy').textContent = '';
    $('extraction-status').textContent = '正在读取压缩进度…';
  }
  if (!scope || scope === 'shared') { $('extraction-status').textContent = '请选择单个对话范围。'; return; }
  try {
    const query = new URLSearchParams({ id: role, scope });
    const data = await api('memory/extraction?' + query);
    if (version === extractionGeneration && role === $('character').value && scope === $('scope').value) renderExtraction(data);
    if (scope !== 'codex') {
      try {
        const policy = await api('memory/daily-policy?' + query);
        if (version === extractionGeneration && role === $('character').value && scope === $('scope').value) {
          $('extraction-policy').textContent = policy.limit === null ? '主人私聊摘要不限额' : '今日摘要 ' + policy.todayChars + ' / ' + policy.limit + ' 字';
        }
      } catch (error) {
        if (version === extractionGeneration) $('extraction-policy').textContent = '额度预览不可用：' + error.message;
      }
    }
  } catch (error) {
    if (version === extractionGeneration) $('extraction-status').textContent = '读取失败：' + error.message;
  }
}
async function loadMemories() {
  narrativePlan = null; $('narrative-apply').disabled = true;
  const version = ++memoryGeneration, role = $('character').value, scope = $('scope').value;
  const query = new URLSearchParams({ id: role, scope, search: $('memory-search').value, offset: String(memoryOffset) });
  const data = await api('memories?' + query);
  if (version !== memoryGeneration || role !== $('character').value) return;
  memories = data.items; memoryTotal = data.total;
  const scopes = [...new Set(['codex', ...Object.keys(data.scopeCounts)])].sort();
  options($('scope'), { '': '全部范围', ...Object.fromEntries(scopes.map((name) => [name, name + ' (' + (data.scopeCounts[name] || 0) + ')'])) });
  $('scope').value = scopes.includes(scope) ? scope : '';
  $('memory-count').textContent = '符合条件：' + memoryTotal + ' 条 · 当前显示 ' + (memoryTotal ? memoryOffset + 1 : 0) + '–' + Math.min(memoryOffset + memories.length, memoryTotal) + ' 条';
  const capacity = await api('memory/capacity?id=' + encodeURIComponent(role));
  memoryCapacityState = capacity;
  $('memory-capacity').textContent = '活动记忆：' + capacity.active + ' / ' + capacity.maxRecords + ' · 已归档：' + capacity.archived + ' · 永久固定：' + capacity.pinned + (capacity.overCapacity ? ' · 超出 ' + capacity.overCapacity + ' 条' : '');
  let narrative;
  try { narrative = await api('memory/narrative-capacity?id=' + encodeURIComponent(role)); }
  catch (error) {
    if (version !== memoryGeneration || role !== $('character').value) return;
    $('narrative-capacity').textContent = '此控制台后端未提供叙事记忆容量：' + error.message;
    $('narrative-form').inert = true; $('narrative-apply').disabled = true;
  }
  if (version !== memoryGeneration || role !== $('character').value) return;
  if (narrative) {
    $('narrative-form').inert = false;
    $('narrative-capacity').textContent = '叙事记忆 ' + narrative.chars + ' 字符 · ' + (narrative.maxChars ? '上限 ' + narrative.maxChars : '无容量上限，警告阈值 ' + narrative.warnChars) + (narrative.warning ? ' · 已达到 ' + narrative.warning + '% 警告' : '') + (narrative.blockedChars ? ' · 受保护记忆等限制，距离整理目标仍有 ' + narrative.blockedChars + ' 字符' : '');
    $('narrative-max').value = narrative.policy.maxChars; $('narrative-warn').value = narrative.policy.warnChars; $('narrative-auto').checked = narrative.policy.auto;
    $('narrative-target').value = Math.floor((narrative.policy.maxChars || narrative.policy.warnChars) * 0.8);
  }
  updateMemoryControls();
  if ($('extraction-details').open) await loadExtraction();
  $('memory-recall').hidden = true;
  renderMemories();
}
async function loadCharacter() {
  const version = ++generation;
  $('workspace').inert = true;
  try {
    const data = await api('character?id=' + encodeURIComponent($('character').value));
    if (version !== generation) return;
    revision = data.revision; $('persona').value = data.persona;
    $('activate-role').disabled = data.id === activeRole;
    $('snapshots').replaceChildren();
    for (const snapshot of data.snapshots) {
      const row = document.createElement('p'), button = document.createElement('button');
      button.textContent = '恢复人格'; button.className = 'secondary';
      button.onclick = () => action(button, async () => { await api('character/restore', 'POST', { id: $('character').value, snapshotId: snapshot.id }); await loadCharacter(); });
      row.append(snapshot.label + ' · ' + new Date(snapshot.at).toLocaleString('zh-CN') + ' ', button); $('snapshots').append(row);
    }
    $('language-select').value = data.preferences.language;
    savedVoice = data.preferences;
    $('pack').value = data.preferences.providerId ?? data.preferences.pack; voiceReset();
    $('voice-instruction').value = data.preferences.style?.instruction || '';
    $('voice-native-style').value = ['local', 'cloud'].includes($('pack').value) ? JSON.stringify(data.preferences.style || {}) : '{}';
    $('voice-seed').value = data.preferences.style?.seed ?? 42; $('voice-cfg').value = data.preferences.style?.cfgScale ?? 1;
    $('voice-online').checked = data.preferences.allowOnline === true;
    $('fallback-voice').replaceChildren(new Option('未绑定', ''));
    if (data.preferences.fallback) {
      const id = data.preferences.fallback.voiceId;
      $('fallback-voice').append(new Option('已保存：' + id, id)); $('fallback-voice').value = id;
    }
    if (data.preferences.voiceId) $('voice-state').textContent = '已保存音色：' + data.preferences.voiceId + '；加载服务后可试听或更换。';
    await loadMemories();
    if (version === generation) $('workspace').inert = false;
  } catch (error) { if (version === generation) status(error.message, true); }
}
function renderBudget(data) {
  $('used').textContent = data.used.toLocaleString(); $('turns').textContent = data.turns; $('unknown').textContent = data.unreported;
  $('budget-date').textContent = data.date + ' · 香港时间零点重置 · ' + (data.limit === null ? '日上限：仅统计' : '日上限 ' + data.limit.toLocaleString() + ' Token') + ' · 本周已用 ' + data.weeklyUsed.toLocaleString() + (data.weeklyLimit === null ? '' : ' / ' + data.weeklyLimit.toLocaleString());
  $('tracking').checked = data.limit === null; $('limit').disabled = data.limit === null; $('limit').required = data.limit !== null; $('limit').value = data.limit ?? '';
  $('weekly-tracking').checked = data.weeklyLimit === null; $('weekly-limit').disabled = data.weeklyLimit === null; $('weekly-limit').required = data.weeklyLimit !== null; $('weekly-limit').value = data.weeklyLimit ?? '';
  $('usage-progress').max = data.limit || 1; $('usage-progress').value = data.limit === null ? 0 : Math.min(data.used, data.limit);
}
async function action(button, work) {
  button.disabled = true; $('character').disabled = true;
  try { await work(); status('已完成。'); } catch (error) { status(error.message, true); }
  finally { button.disabled = false; $('character').disabled = false; updateMemoryControls(); }
}
function form(id, work) { $(id).onsubmit = (event) => { event.preventDefault(); action(event.submitter, work); }; }
let diarySnapshot = null;
async function reviewDiaryOnOpen(role) {
  const indicator = $('diary-auto-status');
  indicator.textContent = '正在回看前几天的记录…';
  try {
    const result = await api('diary/review-on-open', 'POST', {});
    indicator.textContent = {
      written: '今天的回看已写入日记。', skipped: '角色看过了，今天选择不写。',
      'already-written': '今天已有日记。', 'already-reviewed': '今天已启动过回看。',
      running: '今天的回看正在另一个页面进行。',
      'no-history': '前 3 天没有可供回看的记录。',
    }[result.state] || '';
    if (result.written && $('character').value === role && $('diary-details').open) await loadDiary({ preserveDraft: true });
  } catch (error) { indicator.textContent = '自动回看未完成：' + error.message; }
}
async function loadDiary({ preserveDraft } = {}) {
  const role = $('character').value;
  const result = await api('diary?id=' + encodeURIComponent(role));
  if (role !== $('character').value) return;
  const keepDraft = preserveDraft ?? (diarySnapshot?.role === role && $('diary-today-text').value !== diarySnapshot.text);
  const todayText = result.entries.find((entry) => entry.day === result.day)?.text || '';
  if (!keepDraft || preserveDraft === true) diarySnapshot = { role, day: result.day, version: result.version, text: todayText };
  $('diary-status').textContent = result.day + ' · ' + result.used + ' / ' + result.limit + ' 字符（香港时间）';
  $('diary-content').textContent = result.entries.map((entry) => '===== ' + entry.day + ' =====\n' + entry.text).join('\n\n') || '还没有日记。';
  if (!keepDraft) $('diary-today-text').value = todayText;
}
$('diary-details').ontoggle = () => { if ($('diary-details').open) loadDiary().catch((error) => status(error.message, true)); };
$('diary-refresh').onclick = () => action($('diary-refresh'), () => loadDiary({ preserveDraft: true }));
form('diary-form', async () => {
  await api('diary', 'POST', { characterId: $('character').value, text: $('diary-text').value });
  $('diary-text').value = ''; await loadDiary();
});
form('diary-today-form', async () => {
  if (!diarySnapshot || diarySnapshot.role !== $('character').value) throw new Error('请先刷新日记再保存。');
  await api('diary/today', 'POST', { characterId: diarySnapshot.role, day: diarySnapshot.day, version: diarySnapshot.version, text: $('diary-today-text').value });
  await loadDiary({ preserveDraft: false });
});
$('diary-delete').onclick = () => action($('diary-delete'), async () => {
  if (!diarySnapshot || diarySnapshot.role !== $('character').value) throw new Error('请先刷新日记再删除。');
  await api('diary/today/delete', 'POST', { characterId: diarySnapshot.role, day: diarySnapshot.day, version: diarySnapshot.version });
  await loadDiary({ preserveDraft: false });
});
$('diary-compose').onclick = () => action($('diary-compose'), async () => {
  const scope = $('scope').value;
  if (!scope || scope === 'shared') throw new Error('请先选择一个具体的对话范围。');
  const result = await api('diary/compose', 'POST', { characterId: $('character').value, scope });
  await loadDiary();
  if (!result.written) $('diary-status').textContent += ' · 这次选择不写';
});
form('memory-form', async () => { const result = await api('memory', 'POST', { characterId: $('character').value, note: $('note').value }); $('note').value = ''; memoryOffset = 0; await loadMemories(); if (result.maintenanceError) throw new Error(result.maintenanceError); });
form('memory-search-form', async () => { memoryOffset = 0; await loadMemories(); });
form('narrative-form', async () => {
  const characterId = $('character').value;
  const params = { characterId, maxChars: Number($('narrative-max').value), warnChars: Number($('narrative-warn').value), targetChars: Number($('narrative-target').value) };
  const result = await api('memory/narrative-preview', 'POST', params);
  if (characterId !== $('character').value) return;
  narrativePlan = { ...params, revision: result.revision };
  $('narrative-preview').textContent = '当前 ' + result.originalChars + ' 字符，整理后 ' + result.remainingChars + ' 字符；' + (result.reached ? '达到目标' : '未达到目标，仍超出 ' + result.blockedChars + ' 字符') + '\n\n' + result.changes.map((item) => item.scope + ' / ' + item.memoryId + '\n前：' + item.before + '\n后：' + (item.after || '不再注入')).join('\n\n');
  $('narrative-apply').disabled = !result.changes.length;
});
$('narrative-save-policy').onclick = () => action($('narrative-save-policy'), async () => {
  const policy = { maxChars: Number($('narrative-max').value), warnChars: Number($('narrative-warn').value), auto: $('narrative-auto').checked };
  const result = await api('memory/narrative-policy', 'POST', { characterId: $('character').value, policy });
  await loadMemories();
  if (result.maintenance.applied && !result.maintenance.reached) $('narrative-capacity').textContent += ' · 保护项过多，整理后仍超出目标 ' + result.maintenance.blockedChars + ' 字符';
});
$('narrative-apply').onclick = () => action($('narrative-apply'), async () => {
  if (!narrativePlan || narrativePlan.characterId !== $('character').value) throw new Error('请重新预览整理。');
  await api('memory/narrative-compress', 'POST', narrativePlan); $('narrative-preview').textContent = ''; await loadMemories();
});
for (const id of ['narrative-max', 'narrative-warn', 'narrative-target']) $(id).oninput = () => { narrativePlan = null; $('narrative-apply').disabled = true; };
form('budget-form', async () => renderBudget(await api('budget', 'PUT', { limit: $('tracking').checked ? null : Number($('limit').value), weeklyLimit: $('weekly-tracking').checked ? null : Number($('weekly-limit').value) })));
form('language-form', async () => { await api('language', 'POST', { characterId: $('character').value, language: $('language-select').value }); });
function voiceOptions() {
  return { providerId: $('pack').value, voiceId: $('voice').value,
    style: $('pack').value === 'breeze' ? { instruction: $('voice-instruction').value, seed: Number($('voice-seed').value), cfgScale: Number($('voice-cfg').value) } : $('pack').value === 'none' ? {} : JSON.parse($('voice-native-style').value || '{}'),
    allowOnline: $('voice-online').checked, fallback: $('fallback-voice').value ? { providerId: 'cloud', voiceId: $('fallback-voice').value,
      style: savedVoice?.fallback?.voiceId === $('fallback-voice').value ? savedVoice.fallback.style || {} : {} } : null };
}
form('voice-form', async () => {
  savedVoice = await api('voice', 'POST', { characterId: $('character').value, ...voiceOptions() });
  $('voice-state').textContent = '已保存角色语音绑定。';
});
$('tracking').onchange = () => { $('limit').disabled = $('tracking').checked; $('limit').required = !$('tracking').checked; };
$('weekly-tracking').onchange = () => { $('weekly-limit').disabled = $('weekly-tracking').checked; $('weekly-limit').required = !$('weekly-tracking').checked; };
$('scope').onchange = () => {
  ++extractionGeneration; extractionPending = 0; $('extraction-candidates').replaceChildren();
  $('extraction-status').textContent = '正在切换对话范围…'; updateMemoryControls();
  memoryOffset = 0; loadMemories().catch((error) => status(error.message, true));
};
$('extraction-details').ontoggle = () => { if ($('extraction-details').open) loadExtraction(); };
setInterval(() => {
  if ($('extraction-details').open && $('scope').value && !extractionBusy) void loadExtraction({ refresh: true });
}, 5_000);
$('extraction-run').onclick = () => action($('extraction-run'), async () => {
  const characterId = $('character').value, scope = $('scope').value;
  ++extractionGeneration;
  extractionBusy = true; updateMemoryControls(); $('extraction-status').textContent = '正在提炼当前范围的下一批记录…';
  try {
    await api('memory/extraction', 'POST', { characterId, scope });
    if (characterId === $('character').value && scope === $('scope').value) await loadMemories();
  } catch (error) {
    if (characterId === $('character').value && scope === $('scope').value) {
      await loadExtraction();
      $('extraction-status').textContent += ' · 提炼失败：' + error.message + '。可重试。';
    }
    throw error;
  } finally { extractionBusy = false; updateMemoryControls(); }
});
$('character').onchange = () => { diarySnapshot = null; $('diary-today-text').value = ''; $('note').value = ''; $('diary-text').value = ''; $('diary-content').textContent = ''; $('diary-status').textContent = ''; $('memory-search').value = ''; $('scope').value = ''; memoryOffset = 0; loadCharacter().then(() => { if ($('diary-details').open) return loadDiary(); }).catch((error) => status(error.message, true)); };
$('memory-previous').onclick = () => action($('memory-previous'), async () => { memoryOffset = Math.max(0, memoryOffset - 50); await loadMemories(); });
$('memory-next').onclick = () => action($('memory-next'), async () => { memoryOffset += 50; await loadMemories(); });
$('memory-compact').onclick = () => action($('memory-compact'), async () => { await api('memory/compact', 'POST', { characterId: $('character').value }); memoryOffset = 0; await loadMemories(); });
$('export-memory').onclick = () => action($('export-memory'), async () => {
  const id = $('character').value, scope = $('scope').value, search = $('memory-search').value;
  const items = []; let offset = 0, total;
  do {
    const query = new URLSearchParams({ id, scope, search, offset: String(offset) });
    const page = await api('memories?' + query);
    items.push(...page.items); total = page.total; offset += page.items.length;
    if (!page.items.length) break;
  } while (offset < total);
  const url = URL.createObjectURL(new Blob([JSON.stringify({ character: id, scope, search, records: items }, null, 2)], { type: 'application/json;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = id + '-memories.json';
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60_000);
});
$('memory-preview').onclick = () => action($('memory-preview'), async () => {
  const scope = $('scope').value, role = $('character').value;
  const query = new URLSearchParams({ id: role, scope });
  const result = await api('memory/preview?' + query);
  if (scope !== $('scope').value || role !== $('character').value) return;
  $('memory-recall-info').textContent = '范围：' + scope + ' · 最近对话 ' + result.recent.length + ' / ' + result.limits.recent + ' 条' + (result.includeShared ? ' · 共享手记 ' + result.shared.length + ' / ' + result.limits.shared + ' 条' : ' · 不包含角色共享手记') + '。主人 QQ 以本控制台设置为准，未设置时读取环境变量。';
  $('memory-recall-content').textContent = JSON.stringify(result.narrative ? { 实际注入记忆: result.narrative.map(({ text, clarity }) => ({ text, clarity })), 跨对话概括: (result.sharedConcepts || []).map(({ text, originScope, sourceIds }) => ({ text, originScope, sourceIds })) } : { 共享手记: result.shared.map(({ note }) => note), 最近对话: result.recent.map(({ incoming, reply }) => ({ 来信: incoming, 回复: reply })) }, null, 2);
  $('memory-recall').hidden = false;
});
$('pack').onchange = voiceReset;
$('load-voices').onclick = () => action($('load-voices'), async () => {
  const pack = $('pack').value; const version = generation; voiceReset();
  const data = await api('voices?pack=' + encodeURIComponent(pack));
  if (pack !== $('pack').value || version !== generation) return;
  options($('voice'), Object.fromEntries(data.voices.map((voice) => [voice.id, pack === 'breeze' && voice.id !== '@design' ? voice.id : voice.label])));
  const preferred = (savedVoice?.providerId ?? savedVoice?.pack) === pack ? savedVoice.voiceId : '';
  const missing = preferred && !data.voices.some(({ id }) => id === preferred);
  if (missing) { $('voice').prepend(new Option('已保存音色未加载，请选择', '')); $('voice').value = ''; }
  else $('voice').value = preferred || data.default;
  $('voice').disabled = false; $('sample').disabled = Boolean(missing); $('save-voice').disabled = Boolean(missing);
  $('voice-state').textContent = missing ? '已保存的音色未加载；未自动更换。' : '音色已加载。';
});
$('voice').onchange = () => { $('sample').disabled = !$('voice').value; $('save-voice').disabled = !$('voice').value; };
$('load-fallback').onclick = () => action($('load-fallback'), async () => {
  const selected = $('fallback-voice').value;
  const data = await api('voices?providerId=cloud');
  options($('fallback-voice'), { '': '未绑定', ...Object.fromEntries(data.voices.map((voice) => [voice.id, voice.label])) });
  $('fallback-voice').value = data.voices.some(({ id }) => id === selected) ? selected : '';
});
$('sample-cancel').onclick = () => voiceController?.abort();
$('sample').onclick = () => action($('sample'), async () => {
  const pack = $('pack').value, voiceId = $('voice').value, version = generation;
  const controller = new AbortController(); voiceController = controller; $('sample-cancel').disabled = false;
  $('voice-state').textContent = '正在合成…'; $('audio').pause(); $('audio').hidden = true;
  try {
    const result = await api('voice/synthesize', 'POST', { ...voiceOptions(), language: $('language-select').value, text: $('sample-text').value }, false, controller.signal);
    if (pack !== $('pack').value || voiceId !== $('voice').value || version !== generation) return;
    if (result.status !== 'audio') {
      $('voice-state').textContent = '已回文字：' + result.text + '\n原因：' + result.reason + (result.fallbackError ? '\n在线备选：' + result.fallbackError : '');
      return;
    }
    const bytes = Uint8Array.from(atob(result.audioBase64), (char) => char.charCodeAt(0));
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = URL.createObjectURL(new Blob([bytes], { type: 'audio/wav' })); $('audio').src = audioUrl; $('audio').hidden = false;
    $('voice-state').textContent = (result.fallbackUsed ? '已使用授权在线备选 ' + result.providerId + ' / ' + result.voiceId + '；本地失败：' + result.reason + '。' : '合成成功（' + result.providerId + ' / ' + result.voiceId + '）。') + ' 音频 ' + (result.metrics.durationMs / 1000).toFixed(2) + ' 秒；首音 ' + Math.round(result.metrics.firstAudioMs) + ' 毫秒；总耗时 ' + Math.round(result.metrics.totalMs) + ' 毫秒。' + (result.voiceId === '@design' ? ' 设计音色未保存为固定参考。' : '');
    try { await $('audio').play(); } catch { $('voice-state').textContent += ' 音频已就绪，请点击播放。'; }
  } catch (error) {
    if (controller.signal.aborted) { $('voice-state').textContent = '试听已取消，未启用在线备选。'; return; }
    $('voice-state').textContent = '试听失败：' + error.message; throw error;
  } finally { if (voiceController === controller) voiceController = undefined; $('sample-cancel').disabled = true; }
});
(async () => {
  try {
    const data = await api('overview');
    activeRole = data.active; $('active-role').textContent = '实际运行角色：' + data.active;
    $('quota-mode').value = data.quotaPolicy.enabled ? 'percentage' : 'fixed'; $('quota-primary').value = data.quotaPolicy.primaryRemaining; $('quota-secondary').value = data.quotaPolicy.secondaryRemaining;
    options($('character'), Object.fromEntries(data.characters.map((role) => [role.id, role.name])));
    $('character').value = data.active; $('character').disabled = false;
    options($('language-select'), data.languages); options($('pack'), data.packs);
    renderBudget(data.budget); await loadCharacter();
    void reviewDiaryOnOpen(data.active);
    if (!$('workspace').inert) status('已连接本机控制台。选择角色只切换此页查看对象。');
    refreshAccount();
  } catch (error) { status(error.message, true); }
})();

async function refreshRoles(selected) {
  const data = await api('overview'); activeRole = data.active;
  $('active-role').textContent = '实际运行角色：' + data.active;
  options($('character'), Object.fromEntries(data.characters.map((role) => [role.id, role.name])));
  $('character').value = selected || data.active; await loadCharacter();
}
form('persona-form', async () => { await api('character/persona', 'POST', { id: $('character').value, persona: $('persona').value, revision }); await refreshRoles($('character').value); });
form('create-role-form', async () => { const id = $('new-id').value; await api('character/create', 'POST', { id, persona: $('new-persona').value }); $('new-id').value = ''; $('new-persona').value = ''; await refreshRoles(id); });
$('activate-role').onclick = () => action($('activate-role'), async () => { await api('character/activate', 'POST', { id: $('character').value }); await refreshRoles($('character').value); });
$('snapshot-role').onclick = () => action($('snapshot-role'), async () => { await api('character/snapshot', 'POST', { id: $('character').value }); await loadCharacter(); });
$('export-persona').onclick = () => action($('export-persona'), async () => {
  const id = $('character').value;
  const data = await api('character?id=' + encodeURIComponent(id));
  const url = URL.createObjectURL(new Blob([data.persona + '\n'], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = id + '-persona.md';
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60_000);
});
async function refreshStorage() {
  const storage = await api('storage');
  $('storage-current').textContent = storage.directory;
}
$('storage-choose').onclick = () => action($('storage-choose'), async () => {
  const result = await api('storage/choose', 'POST', {});
  if (result.directory) $('storage-directory').value = result.directory;
});
$('storage-open').onclick = () => action($('storage-open'), () => api('storage/open', 'POST', {}));
$('storage-open-role').onclick = () => action($('storage-open-role'), () => api('storage/open', 'POST', { characterId: $('character').value }));
form('storage-form', async () => {
  await api('storage/move', 'POST', { directory: $('storage-directory').value.trim() });
  $('storage-directory').value = '';
  await refreshStorage();
  await refreshRoles($('character').value);
});
refreshStorage().catch((error) => { $('storage-current').textContent = error.message; });
$('persona-file').onchange = async () => {
  const file = $('persona-file').files[0]; if (!file) return;
  if (file.size > 48000) return status('人格文件过大。', true);
  const text = await file.text(); if (text.length > 12000) return status('人格最多 12000 字符。', true);
  $('persona').value = text; status('已读入文件，点击保存人格后生效。');
};
form('quota-form', async () => { await api('quota-policy', 'POST', { enabled: $('quota-mode').value === 'percentage', primaryRemaining: Number($('quota-primary').value), secondaryRemaining: Number($('quota-secondary').value) }); });
async function refreshAccount() {
  $('refresh-account').disabled = true;
  try {
    const data = await api('account');
    $('account-status').textContent = '模型：' + data.model + ' · 登录：' + (data.accountType || '未登录') + ' · 套餐：' + (data.plan || '—') + ' · 更新：' + new Date(data.at).toLocaleTimeString('zh-CN');
    $('account-quota').replaceChildren();
    for (const [key, label] of [['primary', '短周期'], ['secondary', '长周期']]) {
      const value = data.rateLimits?.[key], p = document.createElement('p');
      p.textContent = value ? label + '（' + value.windowDurationMins + ' 分钟）：剩余 ' + (100-value.usedPercent) + '% · 重置 ' + new Date(value.resetsAt*1000).toLocaleString('zh-CN', { timeZone: 'Asia/Hong_Kong' }) : label + '：' + (data.quotaError || '无额度数据');
      $('account-quota').append(p);
    }
  } catch (error) { $('account-status').textContent = error.message; }
  finally { $('refresh-account').disabled = false; }
}
$('refresh-account').onclick = refreshAccount;
async function refreshVoiceCache() {
  const { bytes, limitBytes, checkedAt, lastCleanup, error } = await api('voice/cache');
  const size = (value) => (value / 1_000_000).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) + ' MB';
  const usage = bytes === null ? '等待检查' : size(bytes) + ' / ' + size(limitBytes);
  const time = (at) => new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Hong_Kong' });
  $('voice-cache-status').textContent = '语音缓存（歌曲与说话）：' + usage + '。超过 ' + size(limitBytes) + ' 后自动清空。' +
    (checkedAt ? ' 上次检查：' + time(checkedAt) + '。' : '') +
    (lastCleanup ? ' 最近清理：' + time(lastCleanup.at) + '，释放 ' + size(lastCleanup.bytes) + '。' : '') +
    (error ? ' ' + error : '');
}
function updateVoiceCacheStatus() {
  return refreshVoiceCache().catch((error) => { $('voice-cache-status').textContent = error.message; });
}
$('qq-song-import').addEventListener('toggle', () => {
  if ($('qq-song-import').open) void updateVoiceCacheStatus();
});
async function refreshVoice() {
  void updateVoiceCacheStatus();
  const states = await api('voice/status');
  voiceStates = states;
  $('voice-diagnostics').textContent = states.map((s) => ({ local: '本地包', cloud: '云端包', breeze: 'Breeze' }[s.pack]) + '\n地址：' + s.baseUrl + '\n目录：' + (s.dir || '未配置') + '\n服务端口：' + (s.running ? '已监听' : '未监听') + (s.engineRunning === null ? '' : '\n推理引擎端口：' + (s.engineRunning ? '已监听' : '未监听')) + '\n健康检查：' + (s.health.healthy ? '通过（' + s.health.method + '）' : '失败：' + s.health.error) + '\n最近实际合成：' + (s.synthesis ? (s.synthesis.ok ? '成功，音色 ' + s.synthesis.voiceId : '失败：' + s.synthesis.error) + ' · ' + s.synthesis.at : '未执行') + '\n缺失：' + (s.missing.join('、') || '无') + '\n本页管理进程：' + (s.managed ? '是' : '否') + (s.lastExit ? '\n最近退出：' + s.lastExit.name + '，退出码 ' + (s.lastExit.code ?? '无') + '，信号 ' + (s.lastExit.signal || '无') : '')).join('\n\n');
  if (!$('voice-dir').value) fillVoiceDirectory();
}
function fillVoiceDirectory() {
  const state = voiceStates.find(({ pack }) => pack === $('managed-pack').value);
  $('breeze-config').hidden = $('managed-pack').value !== 'breeze';
  $('voice-dir').value = state?.dir || ''; $('voice-base').value = state?.baseUrl || 'http://127.0.0.1:7860';
  $('voice-model').value = state?.modelPath || ''; $('voice-cpu').checked = state?.cpu === true;
}
$('managed-pack').onchange = fillVoiceDirectory;
form('voice-directory-form', async () => { await api('voice/directory', 'POST', { pack: $('managed-pack').value, dir: $('voice-dir').value,
  ...($('managed-pack').value === 'breeze' ? { baseUrl: $('voice-base').value, modelPath: $('voice-model').value, cpu: $('voice-cpu').checked } : {}) }); await refreshVoice(); });
$('voice-refresh').onclick = () => action($('voice-refresh'), refreshVoice);
for (const command of ['start', 'stop']) $('voice-' + command).onclick = () => action($('voice-' + command), async () => {
  const result = await api('voice/' + command, 'POST', { pack: $('managed-pack').value });
  await refreshVoice(); $('voice-diagnostics').textContent += '\n\n' + result.message;
});
$('voice-check').onclick = () => action($('voice-check'), async () => {
  $('voice-diagnostics').textContent = '正在检查服务并实际合成测试音频…';
  const result = await api('voice/check', 'POST', { pack: $('managed-pack').value });
  $('voice-diagnostics').textContent = result.steps.map((step) => (step.ok === null ? '未执行' : step.ok ? '通过' : '失败') + ' · ' + step.step + '：' + step.detail).join('\n');
});
refreshVoice().catch((error) => { $('voice-diagnostics').textContent = error.message; });
