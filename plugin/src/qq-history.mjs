import { parseMediaSegments } from './qq-media.mjs';

const pageSize = 15;
const maxSegments = 32;
const maxMessageChars = 600;
const maxHistoryChars = 4200;
const unavailableHistory = '暂时无法读取当前会话的聊天记录。';
const unavailableQuote = '暂时无法读取当前会话引用的消息。';

const historyMarkers = {
  at: '[@成员]', reply: '[引用消息]', image: '[图片未加载]', record: '[语音未转写]',
  video: '[视频未加载]', face: '[表情]', mface: '[表情]', forward: '[转发消息未展开]',
};
const supportedQuoteSegments = new Set(['text', 'image', 'record', 'video', 'face', 'mface', 'reply', 'at']);

function accountId(value) {
  const digits = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  return /^[1-9]\d{3,14}$/u.test(digits) ? digits : '';
}

function messageId(value) {
  const digits = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  return /^-?[1-9]\d{0,15}$/u.test(digits) && Number.isSafeInteger(Number(digits)) ? Number(digits) : null;
}

function isRecalled(row) {
  return [row.recalled, row.is_recalled, row.isRecalled, row.withdrawn, row.deleted]
    .some((flag) => flag === true || flag === 1 || flag === '1' || flag === 'true');
}

function belongsToConversation(row, kind, contact, selfId) {
  if (row?.message_type !== kind || !accountId(row.user_id)) return false;
  if (row.self_id != null && accountId(row.self_id) !== selfId) return false;
  if (kind === 'group') return accountId(row.group_id) === contact;
  if ((row.sub_type != null && row.sub_type !== 'friend') || accountId(row.group_id) || accountId(row.sender?.group_id)) return false;
  const sender = accountId(row.user_id);
  if (sender === contact) return row.target_id == null || accountId(row.target_id) === selfId;
  return sender === selfId && accountId(row.target_id) === contact;
}

function safeText(value, ids, limit) {
  if (typeof value !== 'string') return '';
  const text = value.normalize('NFKC').replace(/\p{C}/gu, ' ')
    .replace(/\[CQ:[^\]]{0,4096}\]/giu, '[QQ 消息]')
    .replace(/(?:[a-z][a-z0-9+.-]*:\/\/|www\.|data:)[^\s<>"'，、。！？；（）]+/giu, '[链接]')
    .replace(/\d+/gu, (digits) => ids.has(digits) || digits.length >= 5 ? '[号码]' : digits)
    .replace(/\s+/gu, ' ').trim();
  return text.length > limit ? text.slice(0, limit - 1) + '…' : text;
}

function plainText(segments, ids) {
  if (!Array.isArray(segments)) return '';
  const text = segments.slice(0, maxSegments).map((segment) =>
    segment?.type === 'text' && typeof segment.data?.text === 'string'
      ? segment.data.text.slice(0, maxMessageChars)
      : Object.hasOwn(historyMarkers, segment?.type) ? historyMarkers[segment.type] : '')
    .join('');
  return safeText(text, ids, maxMessageChars);
}

function senderName(row, kind, selfId, senderId, ids) {
  if (accountId(row.user_id) === selfId) return '我';
  const nickname = accountId(row.sender?.user_id) === accountId(row.user_id) &&
    typeof row.sender.nickname === 'string' && row.sender.nickname.length <= 48 && !/\p{C}/u.test(row.sender.nickname)
    ? safeText(row.sender.nickname, ids, 48) : '';
  return nickname || (kind === 'private' ? '对方' : accountId(row.user_id) === senderId ? '当前发言者' : '群成员');
}

function messageTime(value) {
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) && seconds > 0 && seconds <= 253402300799 ? seconds : 0;
}

function displayRow(row, content, kind, selfId, senderId, ids) {
  const time = messageTime(row.time);
  return (time ? new Date(time * 1000).toISOString() + ' ' : '') +
    senderName(row, kind, selfId, senderId, ids) + '：' + content;
}

function parseQuotedMedia(segments, ids, id) {
  if (!Array.isArray(segments)) return undefined;
  const parsed = parseMediaSegments(segments.slice(0, maxSegments).flatMap((segment) => {
    if (!supportedQuoteSegments.has(segment?.type)) return [];
    if (segment.type === 'at') return [{ type: 'text', data: { text: historyMarkers.at } }];
    if (segment.type === 'text') {
      return typeof segment.data?.text === 'string'
        ? [{ type: 'text', data: { text: segment.data.text.slice(0, maxMessageChars) } }] : [];
    }
    return [segment];
  }));
  if (!parsed?.media.length) return undefined;
  return { messageId: String(id), text: safeText(parsed.text, ids, maxMessageChars * 2), media: parsed.media };
}

export function createConversationReader(incoming, oneBotAction) {
  const { kind, subType, quotedMessageId } = incoming;
  const contact = accountId(incoming.contact);
  const selfId = accountId(incoming.selfId);
  const senderId = accountId(incoming.senderId);
  const isGroup = kind === 'group';
  const validScope = Boolean(contact && selfId && senderId && senderId !== selfId &&
    (isGroup || (kind === 'private' && contact === senderId && (subType == null || subType === 'friend'))));
  const belongs = (row) => belongsToConversation(row, kind, contact, selfId);

  return async (request) => {
    if (request !== 'history' && request !== 'quoted') return { text: '聊天记录读取请求无效。' };
    if (!validScope) return { text: request === 'history' ? unavailableHistory : unavailableQuote };

    const options = { timeout: 5000, requireOk: true };
    const ids = new Set([selfId, contact, senderId]);
    if (request === 'quoted') {
      const id = messageId(quotedMessageId);
      if (id === null) return { text: '当前消息没有可读取的引用。' };
      let row;
      const validQuote = (candidate) => belongs(candidate) && messageId(candidate.message_id) === id && !isRecalled(candidate);
      try {
        row = await oneBotAction('get_msg', { message_id: id }, options);
        if (!validQuote(row)) return { text: unavailableQuote };
        if (!isGroup && row.self_id == null && row.target_id == null) {
          const confirmation = await oneBotAction('get_friend_msg_history', {
            user_id: Number(contact), message_id: id, count: 1,
          }, options);
          if (!Array.isArray(confirmation?.messages) || confirmation.messages.length !== 1) return { text: unavailableQuote };
          [row] = confirmation.messages;
          if (!validQuote(row)) return { text: unavailableQuote };
        }
      } catch { return { text: unavailableQuote }; }
      ids.add(accountId(row.user_id));
      const content = plainText(row.message, ids);
      if (!content) return { text: '当前会话引用的消息没有可读取的内容。' };
      const quotedMedia = parseQuotedMedia(row.message, ids, id);
      if (quotedMedia) quotedMedia.text = displayRow(row, quotedMedia.text, kind, selfId, senderId, ids);
      return {
        text: '当前会话引用的消息\n' + displayRow(row, content, kind, selfId, senderId, ids),
        ...(quotedMedia && { quotedMedia }),
      };
    }

    let page;
    try {
      page = await oneBotAction(isGroup ? 'get_group_msg_history' : 'get_friend_msg_history',
        { [isGroup ? 'group_id' : 'user_id']: Number(contact), count: pageSize }, options);
    } catch {
      return { text: unavailableHistory };
    }
    if (!Array.isArray(page?.messages)) return { text: unavailableHistory };

    const rows = page.messages.slice(0, pageSize * 4).filter(belongs);
    const recalledIds = new Set(rows.filter(isRecalled).map((row) => messageId(row.message_id)));
    const seen = new Set();
    const lines = [];
    let usedChars = 0;
    for (const row of rows) ids.add(accountId(row.user_id));
    rows.sort((first, second) => messageTime(second.time) - messageTime(first.time));
    for (const row of rows) {
      const id = messageId(row.message_id);
      if (id === null || recalledIds.has(id) || seen.has(id)) continue;
      const content = plainText(row.message, ids);
      if (!content) continue;
      const line = displayRow(row, content, kind, selfId, senderId, ids);
      if (lines.length >= pageSize || usedChars + line.length + 1 > maxHistoryChars) break;
      seen.add(id);
      lines.push(line);
      usedChars += line.length + 1;
    }
    if (!lines.length) return { text: '当前会话这页没有可读取的消息。' };
    return { text: '当前会话最近可读取的消息\n' + lines.reverse().join('\n') };
  };
}
