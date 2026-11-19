import { activeCharacter, characterContext, addMemory, cleanText, dataDirectory, listMemoryPage } from './store.mjs';
import { UnreadPool, evaluateWake, validateSocialDecision } from './social.mjs';
import { withRoleStorageLock } from './role-storage.mjs';
import { join } from 'node:path';
import { parseMediaSegments, resolveMessageMedia } from './qq-media.mjs';
import { autoExtractMemory } from './memory-extraction.mjs';
import { MEMORY_INTERVAL_MS } from './memory-daily-policy.mjs';
import { readCharacterPreferences } from './settings.mjs';
import { synthesize } from './voice.mjs';
import { createGroupBurstCollector } from './group-burst.mjs';
import { voiceCache } from './voice-cache.mjs';

const maxRecordJsonBytes = 42 * 1024 * 1024;

export async function readRecordJson(response) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > maxRecordJsonBytes) {
    if (response.body) await response.body.cancel().catch(() => {});
    throw new Error('OneBot get_record 响应过大。');
  }
  if (!response.body) return response.json();
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxRecordJsonBytes) throw new Error('OneBot get_record 响应过大。');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks, size).toString('utf8')); }
  catch { throw new Error('OneBot get_record 响应格式无效。'); }
}

function groupConsentAction(text) {
  const command = String(text ?? '').normalize('NFKC').replace(/[\s,，。！？!?、]/g, '');
  if (['同意群聊', '允许群聊', '授权群聊'].includes(command)) return 'grant';
  if (['不同意群聊', '拒绝群聊', '撤销群聊'].includes(command)) return 'revoke';
  return null;
}

function voiceRequestText(text) {
  const command = text.match(/^(?:\/语音|(?:请)?(?:用语音回复(?:我)?|发(?:一?条)?语音))(?:(?:[：:]|\s+)\s*([\s\S]+)|[。！？!?]*)$/u);
  return command ? command[1]?.trim() || '请用一句话回应当前对话。' : null;
}

function parseReplyPlan(value) {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function privateReplyText(value, plan) {
  if (plan?.action === 'speak' && typeof plan.text === 'string') return plan.text;
  if (typeof value === 'string' && !plan && !/^\s*(?:\{|\[|```)/u.test(value)) return value;
  return '我刚才没想好怎么回。';
}

const speechCharacterLimit = 15;
const speechTimeoutMs = 4_000;

function songErrorText(error) {
  const seen = new Set();
  const messages = [];
  let phase;
  for (let current = error, depth = 0; current != null && depth < 5; current = current?.cause, depth++) {
    if (seen.has(current)) break;
    seen.add(current);
    if (!phase && typeof current.phase === 'string') phase = current.phase.trim().slice(0, 120);
    const message = (typeof current.message === 'string' ? current.message : String(current)).trim().slice(0, 1_800);
    if (message && !messages.includes(message)) messages.push(message);
  }
  return ('歌曲处理失败。' + (phase ? '\n阶段：' + phase : '') + '\n原因：' +
    (messages.join('\n底层原因：') || '未知错误。')).slice(0, 4_000);
}

function songPerformanceNote(performance) {
  if (!performance || typeof performance !== 'object') return null;
  const diagnostic = /(?:\b[a-z]:[\\/]|\\\\[^\\\s]+\\|file:\/\/|\/(?:[^/\s]+\/)+[^\s]+|\b(?:access[_-]?token|api[_-]?key|authorization|bearer|password|secret|(?:qq|user|account)[_-]?id)\s*[:=])/iu;
  const field = (value, limit) => typeof value === 'string'
    ? value.slice(0, limit).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .split(/\r?\n/u).filter((line) => !diagnostic.test(line)).join('\n').trim() : '';
  const title = field(performance.title, 200) || '歌名不详';
  const artist = field(performance.artist, 120);
  const portion = field(performance.portion, 80) || '片段';
  const { start, end } = performance;
  const timing = Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && end <= 86_400
    ? '；原录音约 ' + Math.round(start * 100) / 100 + '–' + Math.round(end * 100) / 100 + ' 秒' : '';
  const text = field(performance.lyrics?.text, 3_200);
  const status = performance.lyrics?.status;
  const lyrics = status === 'aligned' && text
    ? '对应片段的时间轴歌词（按' + (performance.lyrics.alignment === 'indexed' ? '人工索引' : ' LRC ') +
      '时间区间匹配，未逐词确认实际唱词）：\n' + text
    : status === 'untimed' && text
      ? '只有未对齐的歌词资料，不能确认本次片段唱了其中哪些句子：\n' + text
      : '没有可确认的对应歌词，不能确定这段唱了什么或表达什么情感。';
  const uncertainty = [
    status === 'aligned' && performance.lyrics?.uncertainLastLine === true
      ? '末行没有下一时间点，仅可能对应片段剩余部分，不能确认末行实际唱出。' : '',
    text && (performance.lyrics?.truncated === true || performance.lyrics.text.length > 3_200)
      ? '歌词资料已截短，不能据此概括完整演唱内容。' : '',
  ].filter(Boolean).join('\n');
  return '演唱记录：我已在本会话成功发送《' + title + '》' + (artist ? '（' + artist + '）' : '') +
    '的' + portion + timing + '。这条记录只代表实际发送的片段。\n' + lyrics + (uncertainty ? '\n' + uncertainty : '');
}

function parseMessage(event, { owner, selfId, admins, groups, socialMode = false, allowBareMention = false }) {
  if (event?.post_type !== 'message' || String(event.self_id) !== selfId) return null;
  const sender = String(event.user_id);
  if (sender === selfId) return null;
  const kind = event.message_type;
  const contact = kind === 'group' ? String(event.group_id) : sender;
  if (kind !== 'private' && (kind !== 'group' || !groups.includes(contact))) return null;
  if (kind === 'private' && sender !== owner && !admins.includes(sender)) return null;
  if (sender !== owner && !admins.includes(sender) && !(kind === 'group' && socialMode)) return null;

  const segments = event.message;
  if (!Array.isArray(segments)) return null;
  const isBotMention = (segment) => segment?.type === 'at' && String(segment.data?.qq) === selfId;
  if (kind === 'group' && !segments.some(isBotMention) && !socialMode) return null;
  const textSegments = kind === 'group' ? segments.filter((segment) => !isBotMention(segment)) : segments;
  const parsed = parseMediaSegments(textSegments);
  if (!parsed) return null;
  const atBot = kind === 'group' && segments.some(isBotMention);
  const { media } = parsed;
  const text = parsed.text || (allowBareMention && socialMode && atBot ? '[@我]' : '');
  if (!text || text.length > 2_000 || !/^-?[0-9]{1,20}$/.test(String(event.message_id ?? ''))) return null;
  const nick = event.sender?.nickname;
  const senderNickname = typeof nick === 'string' && nick.length <= 128 && !/[\p{C}]/u.test(nick) ? nick.trim() : '';
  return { kind, contact, messageId: String(event.message_id), text, media, senderId: sender,
    ...(senderNickname && { senderNickname }), atBot };
}

export function createMessageHandler({ owner, selfId, admins = [], groups = [], generate, deliver, prepareReplyVoice = null, chooseReplyFormat = null, resolveReplySong = null, audioCache = null, loadReplyFaces = null, sendReplyFace = null, groupBursts = false, resolveMedia = async (item) => ({ text: item.text.replace(/\[图片(\d+)\]/g, '[图片$1获取失败]').replaceAll('[语音]', '[语音转写不可用]').replaceAll('[视频]', '[视频未加载]'), images: [] }), autoExtract = null, simulated = false, persistUnread = false, record = true, social = { enabled: false }, askGroupConsent = false, shouldContinue = () => true, generationToken = () => 0, unreadStateFile = null, stateLock = withRoleStorageLock, scheduleTimer = setTimeout, cancelTimer = clearTimeout, waitMinMs = 5_000, onError = () => {}, onExtraction = () => {}, onGroupAuthorization = () => {} }) {
  const withAudioCache = (work) => audioCache ? audioCache.run(work) : work();
  const seen = new Set();
  const unreadPool = new UnreadPool({ stateFile: !simulated && persistUnread && social.enabled && unreadStateFile ? unreadStateFile : null, lock: stateLock });
  const waiters = new Map();
  let groupAuthorized = false;
  let authorizationGeneration = 0;
  let consentPrompted = false;
  let queued = 0;
  let closed = false;
  let tail = Promise.resolve();
  let songJob = null;
  const extractionTimers = new Map();
  const extractionJobs = new Set();
  const bursts = groupBursts ? createGroupBurstCollector({
    process: (records, context) => enqueue(() => processIncoming(records.at(-1), { ...context, records })),
  }) : null;
  function scopeFor(incoming) {
    return (simulated ? 'demo-' : 'qq-') + (incoming.kind === 'group' ? 'group-' : '') + incoming.contact;
  }
  async function availableFaces(roleId) {
    try { return await loadReplyFaces(roleId); }
    catch (error) { onError(error); return []; }
  }
  function persistWaiter(scope, waiter) {
    unreadPool.setPending(scope, { action: waiter.action, deadline: waiter.waitUntil, waitMs: waiter.waitMs,
      watermark: waiter.lastId, incoming: waiter.incoming });
  }
  function cancelWait(scope, { persist = true } = {}) {
    const waiter = waiters.get(scope);
    if (waiter) {
      cancelTimer(waiter.timer);
      waiters.delete(scope);
    }
    if (persist) unreadPool.clearPending(scope);
  }
  function cancelGroupWaiters({ persist = true } = {}) {
    for (const scope of waiters.keys()) cancelWait(scope, { persist });
  }
  function isCurrent(token, authGeneration, groupSession) {
    return !closed && shouldContinue() && generationToken() === token &&
      (!groupSession || (groupAuthorized && authorizationGeneration === authGeneration));
  }
  async function rememberSong(performance, incoming, role, canDeliver, receipt, signal) {
    if (!record || simulated || receipt?.verified !== true || signal?.aborted) return;
    try {
      const note = songPerformanceNote(performance);
      if (!note || !await canDeliver() || signal?.aborted) return;
      const saved = await addMemory(role.id, scopeFor(incoming), { note });
      if (saved.maintenanceError) onError(new Error(saved.maintenanceError));
    } catch (error) { onError(error); }
  }
  async function songOperationReply({ incoming, role, message, request, status, stage, detail, signal }) {
    const fallback = status === 'preparing' ? '我先准备这首歌。'
      : status === 'busy' ? '这首还在准备，稍等一会儿。' : '这段暂时没唱成。';
    if (incoming.kind === 'private' && incoming.senderId === owner) {
      return typeof detail === 'string' && detail.trim() ? detail.trim().slice(0, 4_000) : fallback;
    }
    const timeout = AbortSignal.timeout(12_000);
    const workSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    let abort;
    try {
      workSignal.throwIfAborted();
      const cancelled = new Promise((_, reject) => {
        abort = () => reject(workSignal.reason);
        workSignal.addEventListener('abort', abort, { once: true });
      });
      const generated = await Promise.race([generate({ role,
        message: JSON.stringify({ incomingMessage: message, songRequest: request }),
        operationReplyMode: true, operationStatus: { operation: 'song', status, stage }, signal: workSignal,
      }), cancelled]);
      workSignal.throwIfAborted();
      if (typeof generated !== 'string' || /^\s*(?:\{|\[|```)/u.test(generated)) {
        throw new Error('歌曲状态回复需要是普通文本。');
      }
      return cleanText(generated, 4_000, '歌曲状态回复').slice(0, 1_000);
    } catch (error) {
      if (signal?.aborted) return null;
      onError(new Error('歌曲状态回复生成失败：' + error.message, { cause: error }));
      return fallback;
    } finally {
      if (abort) workSignal.removeEventListener('abort', abort);
    }
  }
  function startSongJob(learn, { incoming, role, message, request, canDeliver, current }) {
    const controller = new AbortController();
    const job = { controller, kind: incoming.kind };
    songJob = job;
    const watch = setInterval(() => {
      if (!current()) controller.abort();
    }, 400);
    watch.unref();
    job.promise = Promise.resolve().then(async () => {
      let song;
      let failure;
      try {
        song = await withAudioCache(async () => {
          try { return await learn(controller.signal); }
          finally { if (audioCache) void audioCache.check(); }
        });
      }
      catch (error) {
        if (controller.signal.aborted) return;
        onError(error);
        failure = error;
      }
      if (controller.signal.aborted || !current()) return;
      await enqueue(async () => {
        if (!await canDeliver() || controller.signal.aborted) return;
        const audio = Buffer.isBuffer(song?.audio) ? song.audio : null;
        let text = song?.text || '暂时没有可唱的片段。';
        if (!audio) {
          if (!failure) onError(new Error('歌曲学唱未返回音频：' + text));
          text = await songOperationReply({ incoming, role, message, request, status: 'failed', stage: 'learn',
            detail: failure ? songErrorText(failure) : text, signal: controller.signal });
          if (!await canDeliver() || controller.signal.aborted) return;
        }
        if (audio && song.credit) {
          await deliver(incoming.contact, song.credit, incoming.kind);
          if (!await canDeliver() || controller.signal.aborted) return;
        }
        if (audio) {
          const receipt = await deliver(incoming.contact, text, incoming.kind, audio);
          await rememberSong(song.performance, incoming, role, canDeliver, receipt, controller.signal);
        } else await deliver(incoming.contact, text, incoming.kind);
      }).catch(() => {});
    }).catch(onError).finally(() => {
      clearInterval(watch);
      if (songJob === job) songJob = null;
    });
  }
  function enqueue(work) {
    const job = tail.then(work);
    tail = job.catch((error) => { onError(error); });
    return job;
  }
  function scheduleAutomaticExtraction(characterId, scope, authGeneration, groupSession) {
    if (!autoExtract || simulated) return;
    const timerKey = characterId + ':' + scope;
    const previous = extractionTimers.get(timerKey);
    if (previous && previous.timer !== null) cancelTimer(previous.timer);
    if (previous?.timer === null && previous.authGeneration === authGeneration) {
      previous.checkAgain = true;
      return;
    }
    const entry = { timer: null, checkAgain: false, authGeneration };
    const authorized = () => !closed && (!groupSession || (groupAuthorized && authorizationGeneration === authGeneration));
    function arm(wait) {
      entry.timer = scheduleTimer(run, wait);
      entry.timer?.unref?.();
    }
    function run() {
      if (extractionTimers.get(timerKey) !== entry) return;
      if (!authorized()) { extractionTimers.delete(timerKey); return; }
      if (!shouldContinue()) { arm(30_000); return; }
      entry.timer = null;
      const job = Promise.resolve().then(() => autoExtract(characterId, scope, { owner, generate, canCommit: authorized })).then((result) => {
        if (result?.error) onError(new Error('自动提炼未完成：' + result.error));
        else if (result?.processed > 0) onExtraction(scope, result);
        if (extractionTimers.get(timerKey) !== entry) return;
        if (!authorized()) { extractionTimers.delete(timerKey); return; }
        const wait = entry.checkAgain ? 0 : result?.dueAt ? Math.max(0, Date.parse(result.dueAt) - Date.now())
          : result?.nextImmediate ? 0 : result?.triggered && result?.pending > 0 ? MEMORY_INTERVAL_MS : null;
        entry.checkAgain = false;
        if (wait !== null && Number.isFinite(wait)) arm(wait);
        else extractionTimers.delete(timerKey);
      }).catch((error) => {
        onError(error);
        if (extractionTimers.get(timerKey) !== entry) return;
        if (authorized()) arm(MEMORY_INTERVAL_MS);
        else extractionTimers.delete(timerKey);
      }).finally(() => extractionJobs.delete(job));
      extractionJobs.add(job);
    }
    extractionTimers.set(timerKey, entry);
    arm(0);
  }
  async function scheduleDecision(scope, incoming, decision, token, authGeneration) {
    cancelWait(scope);
    const waiter = { timer: null, incoming, action: decision.action, waitMs: decision.waitMs,
      lastId: unreadPool.unread(scope).at(-1)?.messageId, token, authGeneration };
    waiters.set(scope, waiter);
    armWait(scope, waiter);
    await unreadPool.flush();
  }
  function armWait(scope, waiter, resume = false) {
    const delay = resume ? Math.max(0, waiter.waitUntil - Date.now()) : waiter.waitMs;
    if (!resume) waiter.waitUntil = Date.now() + delay;
    persistWaiter(scope, waiter);
    waiter.timer = scheduleTimer(() => {
      if (waiters.get(scope) !== waiter) return;
      waiter.timer = null;
      enqueue(async () => {
        if (!isCurrent(waiter.token, waiter.authGeneration, true)) {
          return null;
        }
        const unread = unreadPool.unread(scope, { limit: 100 });
        if (!unread.length) {
          waiters.delete(scope);
          unreadPool.clearPending(scope);
          return null;
        }
        if (waiter.action === 'lurk' && unread.at(-1).messageId === waiter.lastId) return null;
        waiters.delete(scope);
        unreadPool.clearPending(scope);
        return processIncoming(waiter.incoming, { wakeReason: waiter.action + 'Timeout', token: waiter.token,
          authGeneration: waiter.authGeneration, timerRetry: true });
      });
    }, delay);
    waiter.timer?.unref?.();
  }
  function processIncoming(incoming, context) {
    return withAudioCache(() => processIncomingCore(incoming, context));
  }
  async function processIncomingCore(incoming, { wakeReason: overrideWakeReason, token = generationToken(), authGeneration = authorizationGeneration,
    timerRetry = false, records = [incoming],
  } = {}) {
    const isGroup = incoming.kind === 'group';
    const autonomous = social.enabled && isGroup;
    const scope = scopeFor(incoming);
    if (!isCurrent(token, authGeneration, autonomous)) return null;
    let unread = [];
    let wakeReason = overrideWakeReason || 'direct';
    if (autonomous) {
      if (!timerRetry) {
        records = records.filter((item) => unreadPool.add(scope, item));
        await unreadPool.flush();
        if (!records.length) return null;
        incoming = records.at(-1);
        if (records.length > 1) incoming = { ...incoming,
          text: records.map(({ text }) => text).join('\n'), atBot: records.some(({ atBot }) => atBot) };
      }
      unread = unreadPool.unread(scope, { limit: 100 });
      if (!timerRetry) {
        const wakeOptions = { ...social, enabled: true, random: social.random ?? Math.random };
        const explicitWake = { ...wakeOptions, probability: 0 };
        const wake = records.length > 1
          ? [incoming, ...records].map((item) => evaluateWake(item, explicitWake)).find((item) => item.wake)
            || evaluateWake(incoming, wakeOptions)
          : evaluateWake(incoming, wakeOptions);
        if (!wake.wake) {
          const waiter = waiters.get(scope);
          if (waiter) {
            waiter.incoming = records.at(-1);
            waiter.token = token;
            waiter.authGeneration = authGeneration;
            persistWaiter(scope, waiter);
            if (!waiter.timer) armWait(scope, waiter);
          }
          return { character: null, action: 'wait', reason: wake.reason };
        }
        wakeReason = wake.reason;
        cancelWait(scope);
      }
      if (!unread.length) return null;
    }
    const requestedText = prepareReplyVoice && voiceRequestText(incoming.text);
    const resolved = await resolveMedia(incoming);
    if (!isCurrent(token, authGeneration, autonomous)) return null;
    const role = await characterContext(scope, { includeShared: !isGroup && incoming.contact === owner });
    const modelText = requestedText ? voiceRequestText(resolved.text) || resolved.text : resolved.text;
    const burstIds = records.length > 1 ? records.map(({ messageId }) => messageId) : null;
    const message = autonomous
      ? JSON.stringify({ wakeReason, unread: unread
        .filter(({ messageId }) => messageId === incoming.messageId || !burstIds?.includes(messageId))
        .map(({ messageId, text, senderId, at }) => messageId === incoming.messageId
          ? { messageId, text: modelText, senderId, at, ...(burstIds ? { messageIds: burstIds } : {}) }
          : { messageId, text: text.replace(/\[图片(\d+)\]/g, '[图片$1未加载]').replaceAll('[语音]', '[语音未转写]').replaceAll('[视频]', '[视频未加载]'), senderId, at }) })
      : modelText;
    const faces = !requestedText && loadReplyFaces && sendReplyFace ? await availableFaces(role.id) : [];
    const faceOptions = faces.map(({ label }, index) => ({ choice: index + 1, label }));
    if (!isCurrent(token, authGeneration, autonomous)) return null;
    const mediaPlan = Boolean(chooseReplyFormat || resolveReplySong || faceOptions.length);
    const generated = await generate({ role, message, mediaImages: resolved.images, decisionMode: autonomous,
      ...(mediaPlan ? { mediaPlan, songPlan: Boolean(resolveReplySong) } : {}),
      ...(faceOptions.length ? { faceOptions } : {}) });
    const plan = mediaPlan ? parseReplyPlan(generated) : null;
    const songRequest = resolveReplySong && plan?.action === 'sing' && plan.song;
    const decision = songRequest ? { action: 'speak', text: '这段暂时唱不了。' }
      : autonomous ? validateSocialDecision(generated, { minWaitMs: waitMinMs })
        : { action: 'speak', text: mediaPlan ? privateReplyText(generated, plan) : generated };
    if (decision.action !== 'speak') {
      if (autonomous && isCurrent(token, authGeneration, true)) {
        await scheduleDecision(scope, records.at(-1), decision, token, authGeneration);
      }
      return { character: role.id, action: decision.action, unread: unread.length };
    }
    let reply = cleanText(decision.text, 4_000, '回复').slice(0, 1_000);
    const canDeliver = async () => isCurrent(token, authGeneration, autonomous) &&
      (await activeCharacter()).id === role.id && isCurrent(token, authGeneration, autonomous);
    if (!await canDeliver()) return null;
    let audio = null;
    let performance = null;
    let learnSong = null;
    let faceSent = false;
    const face = plan?.action === 'speak' && typeof plan.text === 'string' && plan.text.trim() &&
      Number.isInteger(plan.face) && faces[plan.face - 1];
    if (face) {
      const stillEnabled = (await availableFaces(role.id)).some(({ id }) => id === face.id);
      if (!await canDeliver()) return null;
      if (stillEnabled) {
        await sendReplyFace(incoming.contact, incoming.kind, face.id);
        faceSent = true;
        reply = '[收藏表情：' + face.label + ']';
      }
    }
    if (songRequest) {
      let operation;
      try {
        const song = await resolveReplySong(songRequest, { roleId: role.id });
        if (typeof song?.text === 'string' && song.text.trim()) reply = cleanText(song.text, 4_000, '点歌回复').slice(0, 1_000);
        if (Buffer.isBuffer(song?.audio)) {
          audio = song.audio;
          performance = song.performance;
        }
        if (typeof song?.learn === 'function') {
          if (songJob) operation = { status: 'busy', detail: '我正在学另一首歌，等这段唱完再点吧。' };
          else {
            learnSong = song.learn;
            operation = { status: 'preparing', detail: song.text };
          }
        } else if (!audio) {
          onError(new Error('歌曲解析未返回音频：' + (song?.text || '没有可用音源。')));
          operation = { status: 'failed', detail: song?.text || '暂时没有可唱的片段。' };
        }
      } catch (error) {
        onError(error);
        operation = { status: 'failed', detail: songErrorText(error) };
      }
      if (operation) {
        if (!await canDeliver()) return null;
        reply = await songOperationReply({ incoming, role, message: modelText, request: songRequest,
          stage: 'resolve', ...operation });
      }
      if (!await canDeliver()) return null;
    } else if (!face && prepareReplyVoice && (requestedText || chooseReplyFormat) &&
        (!mediaPlan || [...reply].length <= speechCharacterLimit)) {
      audio = await prepareReplyVoice(role.id, reply, mediaPlan ? speechTimeoutMs : undefined);
      if (!await canDeliver()) return null;
      if (audio && !requestedText && chooseReplyFormat) {
        let format;
        try { format = await chooseReplyFormat({ role, message, reply, kind: incoming.kind }); } catch {}
        if (format !== 'voice') audio = null;
        if (!await canDeliver()) return null;
      }
    }
    if (!faceSent) {
      if (audio) {
        const receipt = await deliver(incoming.contact, reply, incoming.kind, audio);
        if (songRequest) await rememberSong(performance, incoming, role, canDeliver, receipt);
      } else await deliver(incoming.contact, reply, incoming.kind);
    }
    if (learnSong && await canDeliver()) {
      startSongJob(learnSong, { incoming, role, message: modelText, request: songRequest, canDeliver,
        current: () => isCurrent(token, authGeneration, autonomous) });
    }
    if (record) {
      const messages = (unread.length ? unread : [incoming]).map((item) =>
        !burstIds && item.messageId === incoming.messageId ? { ...item, text: resolved.text } : item);
      const saved = await addMemory(role.id, scope, {
        incoming: messages.map(({ text }) => text).join('\n'), reply, messageId: incoming.messageId,
        messages: messages.map(({ messageId, senderId, senderNickname, text, at }) =>
          ({ messageId, senderId, text, ...(senderNickname && { senderNickname }), ...(at ? { at } : {}) })),
        ...(role.sharedConcepts?.length ? { sharedContextUsed: true } : {}),
      });
      if (saved.maintenanceError) onError(new Error(saved.maintenanceError));
      scheduleAutomaticExtraction(role.id, scope, authGeneration, autonomous);
    }
    if (autonomous && unread.length) {
      unreadPool.markRead(scope, unread.at(-1).messageId);
      await unreadPool.flush();
      cancelWait(scope);
      await unreadPool.flush();
    }
    if (askGroupConsent && social.enabled && groups.length > 0 && incoming.kind === 'private' &&
        incoming.contact === owner && !consentPrompted && isCurrent(token, authGeneration, false)) {
      await deliver(owner, '如果允许我在本次桥接登录期间参与已配置的白名单群，请回复“同意群聊”。回复“撤销群聊”可立即取消；退出或重启后授权失效，白名单外群始终不处理。', 'private');
      consentPrompted = true;
    }
    return { character: role.id, reply, action: 'speak', wakeReason };
  }
  const handle = async (event) => {
    const receivedToken = generationToken();
    await unreadPool.ready();

    const incoming = parseMessage(event, { owner, selfId, admins, groups, allowBareMention: groupBursts,
      socialMode: social.enabled && groupAuthorized && event?.message_type === 'group' });
    if (!incoming || !shouldContinue()) return null;
    const eventKey = incoming.kind + ':' + incoming.contact + ':' + incoming.messageId;
    if (seen.has(eventKey)) return null;
    const consentAction = incoming.kind === 'private' && incoming.senderId === owner ? groupConsentAction(incoming.text) : null;
    const queueFull = queued >= 8;
    if (queueFull && consentAction !== 'revoke') return null;
    seen.add(eventKey);
    if (seen.size > 200) seen.delete(seen.values().next().value);
    if (consentAction) {
      authorizationGeneration += 1;
      groupAuthorized = consentAction === 'grant';
      onGroupAuthorization(groupAuthorized && social.enabled && groups.length > 0);
      bursts?.cancel();
      if (!groupAuthorized) {
        if (songJob?.kind === 'group') songJob.controller.abort();
        cancelGroupWaiters();
        unreadPool.clear();
      }
    }
    if (queueFull) {
      await unreadPool.flush();
      return { action: 'authorization', authorized: false, effective: false };
    }
    const token = receivedToken;
    const authGeneration = authorizationGeneration;
    queued += 1;
    if (bursts && social.enabled && groupAuthorized && incoming.kind === 'group') {
      const mergeable = event.message.every((segment) =>
        segment.type === 'text' || (segment.type === 'at' && String(segment.data?.qq) === selfId));
      return bursts.add(incoming, { mergeable, context: { token, authGeneration } }).finally(() => { queued -= 1; });
    }
    return enqueue(async () => {
      if (!isCurrent(token, authGeneration, social.enabled && incoming.kind === 'group')) return null;
      if (consentAction) {
        const effective = consentAction === 'grant' && social.enabled && groups.length > 0;
        const reply = consentAction === 'revoke'
          ? '已撤销本次桥接登录的群聊授权。'
          : effective
            ? '收到。本次桥接登录期间，我只会在已配置的白名单群中按设置参与；退出或重启后授权失效。'
            : '收到本次登录的群聊授权；目前没有启用群聊自主参与或配置白名单群，因此不会处理群成员消息。';
        await deliver(owner, reply, 'private');
        if (consentAction === 'grant') {
          if (effective && autoExtract && !simulated) {
            const role = await activeCharacter();
            for (const group of groups) scheduleAutomaticExtraction(role.id, 'qq-group-' + group, authGeneration, true);
          }
          for (const group of groups) {
            const prefix = (simulated ? 'demo-' : 'qq-') + 'group-';
            const scope = prefix + group;
            const saved = unreadPool.pending(scope);
            if (!saved) continue;
            const latest = unreadPool.unread(scope, { limit: 100 }).at(-1);
            if (!latest || saved.incoming.contact !== group) {
              unreadPool.clearPending(scope);
              continue;
            }
            const waiter = {
              timer: null, incoming: saved.incoming,
              action: saved.action, waitUntil: saved.deadline, waitMs: saved.waitMs,
              lastId: saved.watermark, token: generationToken(), authGeneration,
            };
            cancelWait(scope, { persist: false });
            waiters.set(scope, waiter);
            armWait(scope, waiter, true);
          }
          await unreadPool.flush();
        }
        if (consentAction === 'revoke') {
          await unreadPool.flush();
        }
        return { action: 'authorization', authorized: consentAction === 'grant', effective };
      }
      return processIncoming(incoming, { token, authGeneration });
    }).finally(() => { queued -= 1; });
  };
  handle.close = () => {
    closed = true;
    songJob?.controller.abort();
    bursts?.cancel();
    for (const { timer } of extractionTimers.values()) if (timer !== null) cancelTimer(timer);
    extractionTimers.clear();
    cancelGroupWaiters({ persist: false });
    return tail.then(() => Promise.allSettled([...extractionJobs, songJob?.promise])).then(() => unreadPool.flush());
  };
  handle.idle = async () => { bursts?.flush(); await tail; await unreadPool.flush(); };
  handle.resumeExtractions = async () => {
    if (!autoExtract || simulated) return;
    const role = await activeCharacter();
    const { scopeCounts } = await listMemoryPage(role.id, { limit: 1 });
    const allowed = new Set([owner, ...admins]);
    for (const scope of Object.keys(scopeCounts)) {
      if (/^qq-[1-9][0-9]{3,14}$/.test(scope) && allowed.has(scope.slice(3))) {
        scheduleAutomaticExtraction(role.id, scope, authorizationGeneration, false);
      }
    }
  };
  return handle;
}

export function sampleEvent(text, messageId = Date.now()) {
  return { post_type: 'message', message_type: 'private', self_id: 10001, user_id: 10002,
    message_id: messageId, message: [{ type: 'text', data: { text } }] };
}

export async function startOneBot({ owner, selfId, admins = [], groups = [], wsUrl, httpUrl, wsToken, httpToken, generate, send, social, autonomousMedia = false, loadReplyFaces = null, signal, shouldContinue = () => true, generationToken = () => 0, onEvent = () => {} }) {
  for (const id of [owner, selfId]) {
    if (!/^[1-9][0-9]{3,14}$/.test(id)) throw new Error('请设置 SURFCORE_QQ_OWNER 和 SURFCORE_QQ_BOT。');
  }
  if (owner === selfId) throw new Error('主人 QQ 与机器人 QQ 必须不同。');
  if (admins.some((id) => !/^[1-9][0-9]{3,14}$/.test(id) || id === selfId)) {
    throw new Error('SURFCORE_QQ_ADMINS 必须是逗号分隔的有效 QQ 号，且不能包含机器人号。');
  }
  if (groups.some((id) => !/^[1-9][0-9]{3,14}$/.test(id))) {
    throw new Error('SURFCORE_QQ_GROUPS 必须是逗号分隔的有效群号。');
  }
  const ws = new URL(wsUrl);
  const http = new URL(httpUrl);
  for (const [url, protocol] of [[ws, 'ws:'], [http, 'http:']]) {
    if (url.protocol !== protocol || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash) {
      throw new Error('OneBot 地址只接受本机 127.0.0.1，令牌请用环境变量。');
    }
  }
  const auth = (token) => token ? { Authorization: 'Bearer ' + token } : {};
  async function oneBotAction(action, body, {
    timeout = action === 'fetch_ptt_text' ? 25_000 : 10_000, requireOk = false,
  } = {}) {
    const response = await fetch(new URL('/' + action, http), {
      method: 'POST', redirect: 'error', headers: { ...auth(httpToken), 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw new Error('OneBot ' + action + ' 失败（HTTP ' + response.status + '）。');
    const result = action === 'get_record' ? await readRecordJson(response) : await response.json();
    if (result?.retcode !== 0 || (requireOk && result.status !== 'ok')) throw new Error('OneBot ' + action + ' 失败。');
    return result.data;
  }

  const account = await oneBotAction('get_login_info', {});
  if (String(account?.user_id) !== selfId) {
    throw new Error('OneBot HTTP 登录账号和配置的机器人 QQ 不一致，请核对账号与端口。');
  }

  if (signal?.aborted) return;
  const handle = createMessageHandler({ owner, selfId, admins, groups, generate, autoExtract: send ? autoExtractMemory : null, social, record: send, persistUnread: send,
    groupBursts: autonomousMedia,
    audioCache: send && autonomousMedia ? voiceCache : null,
    onExtraction: (scope, result) => onEvent({ type: 'memory-compressed', scope, processed: result.processed }),
    onGroupAuthorization: (authorized) => onEvent({ type: 'group-authorization', authorized }),
    loadReplyFaces: send && autonomousMedia ? loadReplyFaces : null,
    sendReplyFace: send && autonomousMedia && loadReplyFaces ? async (contact, kind, id) => {
      const result = await oneBotAction('send_custom_face', {
        [kind === 'group' ? 'group_id' : 'user_id']: Number(contact), emoji_id: id,
      });
      if (!Number.isSafeInteger(result?.message_id) || result.message_id === 0) {
        throw new Error('QQ 收藏表情缺少发送回执，请在 QQ 中查看。');
      }
      onEvent({ type: 'sent', kind, contact, format: 'face' });
    } : null,
    resolveMedia: (incoming) => resolveMessageMedia(incoming, oneBotAction),
    chooseReplyFormat: send && autonomousMedia ? async ({ role, message, reply, kind }) => {
      const timeout = AbortSignal.timeout(12_000);
      const result = await generate({
        role, message: JSON.stringify({ kind, incoming: message.slice(-2_000), reply }), deliveryMode: true,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      return parseReplyPlan(result)?.format;
    } : null,
    resolveReplySong: send && autonomousMedia ? async (request, { roleId }) => {
      const { prepareSongReply } = await import('./qq-song-autolearn.mjs');
      const acquireQQMusic = roleId === 'zhiwei'
        ? async (...args) => (await import('./qq-music-source.mjs')).acquireQQMusic(...args)
        : undefined;
      return prepareSongReply(request, { signal, roleId, acquireQQMusic });
    } : null,
    prepareReplyVoice: send ? async (roleId, text, timeoutMs) => {
      try {
        const preferences = await readCharacterPreferences(roleId);
        if (preferences.providerId === 'none') throw new Error('当前角色尚未绑定音色。');
        const result = await synthesize({ ...preferences, text, allowOnline: false, signal, timeoutMs });
        if (result.status === 'audio') return result.audio;
        onEvent({ type: 'voiceFallback', reason: result.reason });
      } catch (error) {
        onEvent({ type: 'voiceFallback', reason: error.message });
      }
      return null;
    } : null,
    unreadStateFile: send ? join(dataDirectory, 'social-unread.jsonl') : null,
    askGroupConsent: send && social?.enabled === true && groups.length > 0, shouldContinue, generationToken,
    onError: (error) => {
      onEvent({ type: 'error', message: error.phase ? songErrorText(error) : error.message });
      console.error('处理失败：', error);
    },
    deliver: async (contact, reply, kind, audio) => {
      const isGroup = kind === 'group';
      if (!send) {
        onEvent({ type: 'preview', kind, contact, reply });
        process.stdout.write('[预览 | ' + (isGroup ? '群' : '私聊') + '尾号 ' + contact.slice(-4) + '] ' + reply + '\n');
        return;
      }
      const segment = audio ? { type: 'record', data: { file: 'base64://' + audio.toString('base64') } }
        : { type: 'text', data: { text: reply } };
      let result;
      try {
        result = await oneBotAction(isGroup ? 'send_group_msg' : 'send_private_msg', {
          [isGroup ? 'group_id' : 'user_id']: Number(contact), message: [segment],
        }, audio ? { timeout: 60_000, requireOk: true } : undefined);
      } catch (error) {
        if (!audio) throw error;
        throw new Error('QQ 语音发送结果未确认，请先在 QQ 中查看。', { cause: error });
      }
      if (!audio) {
        onEvent({ type: 'sent', kind, contact });
        return;
      }
      const messageId = Number(result?.message_id);
      if (!Number.isSafeInteger(messageId) || messageId === 0) throw new Error('QQ 语音发送回执缺少消息 ID，发送结果未确认。');
      onEvent({ type: 'sent', kind, contact, format: 'record' });
      let verified = false;
      try {
        const message = await oneBotAction('get_msg', { message_id: messageId }, { timeout: 5_000, requireOk: true });
        const target = isGroup ? message?.group_id : message?.target_id;
        verified = String(message?.message_id) === String(messageId) && message?.message_type === kind &&
          String(target) === contact && String(message?.user_id) === selfId &&
          Array.isArray(message.message) && message.message.some((segment) => segment?.type === 'record');
      } catch {}
      onEvent({ type: verified ? 'voiceVerified' : 'voiceUnverified', kind, contact });
      return { verified, messageId };
    } });
  await handle.resumeExtractions();
  const socket = new WebSocket(ws, { headers: auth(wsToken) });
  const abort = () => socket.close(1000, 'Stopped');
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  socket.addEventListener('open', () => { onEvent({ type: 'connected' }); console.log('OneBot 已连接。' + (send ? '已开启白名单回复。' : '仅预览回复。')); });
  socket.addEventListener('message', async ({ data }) => {
    try {
      if (typeof data === 'string') await handle(JSON.parse(data));
    } catch (error) {
      onEvent({ type: 'error', message: error.message });
      console.error('处理失败：' + error.message);
    }
  });
  try { await new Promise((resolve, reject) => {
    socket.addEventListener('error', () => signal?.aborted ? resolve() : reject(new Error('OneBot WebSocket 连接失败。')), { once: true });
    socket.addEventListener('close', ({ code }) => {
      if (code === 1000 || signal?.aborted) resolve();
      else reject(new Error('OneBot WebSocket 已断开（' + code + '）。'));
    }, { once: true });
  }); } finally { signal?.removeEventListener('abort', abort); await handle.close(); }
}
