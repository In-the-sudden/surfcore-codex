import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const DEFAULT_LIMIT = 100;
const DEFAULT_TTL_MS = 30 * 60_000;

function boundedInt(value, fallback, min, max) {
  const number = Number(value);
  return Number.isInteger(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function normalized(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase().trim();
}

function safePattern(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export class UnreadPool {
  #sessions = new Map();
  #seenIds = new Map();
  #pendingWaits = new Map();
  #limit;
  #ttlMs;
  #stateFile;
  #load;
  #write = Promise.resolve();
  #lock;
  #writeError = null;

  constructor({ limit = DEFAULT_LIMIT, ttlMs = DEFAULT_TTL_MS, stateFile = null, lock = async (work) => work() } = {}) {
    this.#limit = boundedInt(limit, DEFAULT_LIMIT, 1, 1000);
    this.#ttlMs = boundedInt(ttlMs, DEFAULT_TTL_MS, 1000, 7 * 24 * 60 * 60_000);
    this.#stateFile = typeof stateFile === 'string' ? stateFile : null;
    this.#lock = lock;
    this.#load = this.#stateFile ? this.#loadFile() : Promise.resolve();
  }

  async #loadFile() {
    let raw;
    try { raw = await readFile(this.#stateFile, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const line of raw.trim().split('\n').filter(Boolean)) {
      try { this.#apply(JSON.parse(line)); }
      catch { /* Ignore a truncated or invalid journal row. */ }
    }
    if (this.#prune(Date.now())) this.#persist({ op: 'prune' });
  }

  #apply(entry) {
    if (entry.op === 'snapshot' && entry.sessions && typeof entry.sessions === 'object') {
      this.#sessions.clear();
      for (const [session, messages] of Object.entries(entry.sessions)) {
        if (Array.isArray(messages)) this.#sessions.set(session, messages.map((message) => ({ ...message })));
      }
      this.#seenIds = new Map(Object.entries(entry.seen || {}).map(([session, ids]) => [session, Array.isArray(ids) ? ids.map(String).slice(-200) : []]));
      this.#pendingWaits.clear();
      for (const [session, pending] of Object.entries(entry.pending || {})) this.#restorePending(session, pending);
    } else if (entry.op === 'add') this.#restoreAdd(entry.session, entry.message);
    else if (entry.op === 'read') this.#restoreRead(entry.session, entry.throughId);
    else if (entry.op === 'pending') this.#restorePending(entry.session, entry.pending);
    else if (entry.op === 'clearPending') this.#pendingWaits.delete(String(entry.session ?? ''));
    else if (entry.op === 'prune') this.#prune(Date.now());
    else if (entry.op === 'clear') {
      const key = String(entry.session ?? '');
      this.#sessions.delete(key);
      this.#seenIds.delete(key);
      this.#pendingWaits.delete(key);
    } else if (entry.op === 'clearAll') {
      this.#sessions.clear();
      this.#seenIds.clear();
      this.#pendingWaits.clear();
    }
  }

  #restoreAdd(session, input) {
    const key = String(session ?? '').trim();
    if (!key || !input?.messageId || !input?.text) return;
    const messages = this.#sessions.get(key) ?? [];
    if (messages.some((message) => message.messageId === String(input.messageId))) return;
    this.#remember(key, String(input.messageId));
    messages.push({ messageId: String(input.messageId), text: String(input.text), at: Number(input.at), senderId: String(input.senderId ?? ''), isSelf: input.isSelf === true });
    if (messages.length > this.#limit) messages.splice(0, messages.length - this.#limit);
    this.#sessions.set(key, messages);
  }

  #remember(session, messageId) {
    const ids = this.#seenIds.get(session) ?? [];
    if (!ids.includes(messageId)) ids.push(messageId);
    if (ids.length > 200) ids.splice(0, ids.length - 200);
    this.#seenIds.set(session, ids);
  }

  #restoreRead(session, throughId) {
    const key = String(session ?? '');
    const messages = this.#sessions.get(key);
    if (!messages?.length) return;
    const index = messages.findIndex((message) => message.messageId === String(throughId));
    if (index < 0) return;
    if (index + 1 === messages.length) {
      this.#sessions.delete(key);
      this.#pendingWaits.delete(key);
    } else this.#sessions.set(key, messages.slice(index + 1));
  }

  #restorePending(session, input) {
    const key = String(session ?? '').trim();
    const pending = normalizePendingWait(input);
    if (key && pending) this.#pendingWaits.set(key, pending);
  }

  #prune(now) {
    let changed = false;
    for (const [session, messages] of this.#sessions) {
      const retained = messages.filter((message) => now - message.at <= this.#ttlMs);
      if (retained.length) this.#sessions.set(session, retained);
      else {
        this.#sessions.delete(session);
        if (this.#pendingWaits.delete(session)) changed = true;
      }
    }
    for (const session of this.#pendingWaits.keys()) {
      if (!this.#sessions.get(session)?.length) {
        this.#pendingWaits.delete(session);
        changed = true;
      }
    }
    return changed;
  }

  async ready() { await this.#load; }

  async flush() {
    await this.#write;
    if (this.#writeError) {
      const error = this.#writeError;
      this.#writeError = null;
      throw error;
    }
  }

  #persist(entry) {
    if (!this.#stateFile) return;
    this.#write = this.#write.then(async () => {
      await this.#lock(async () => {
        await mkdir(dirname(this.#stateFile), { recursive: true });
        let current = new Map();
        const seen = new Map();
        const pending = new Map();
        try {
          const raw = await readFile(this.#stateFile, 'utf8');
          for (const line of raw.trim().split('\n').filter(Boolean)) {
            try {
              const row = JSON.parse(line);
              if (row.op === 'snapshot' && row.sessions && typeof row.sessions === 'object') {
                current = new Map(Object.entries(row.sessions).map(([key, rows]) => [key, Array.isArray(rows) ? rows.map((item) => ({ ...item })) : []]));
                seen.clear();
                for (const [key, ids] of Object.entries(row.seen || {})) if (Array.isArray(ids)) seen.set(key, ids.map(String).slice(-200));
                pending.clear();
                for (const [key, value] of Object.entries(row.pending || {})) restorePending(pending, key, value);
              } else if (row.op === 'add') applyAdd(current, seen, row.session, row.message, this.#limit);
              else if (row.op === 'read') applyRead(current, pending, row.session, row.throughId);
              else if (row.op === 'pending') restorePending(pending, row.session, row.pending);
              else if (row.op === 'clearPending') pending.delete(String(row.session ?? ''));
              else if (row.op === 'prune') pruneSessions(current, pending, Date.now(), this.#ttlMs);
              else if (row.op === 'clear') {
                const key = String(row.session ?? '');
                current.delete(key);
                seen.delete(key);
                pending.delete(key);
              } else if (row.op === 'clearAll') {
                current.clear();
                seen.clear();
                pending.clear();
              }
            } catch { /* Ignore a truncated or invalid journal row. */ }
          }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        applyEntry(current, seen, pending, entry, this.#limit);
        pruneSessions(current, pending, Date.now(), this.#ttlMs);
        const snapshot = JSON.stringify({ op: 'snapshot', sessions: Object.fromEntries(current), seen: Object.fromEntries(seen), pending: Object.fromEntries(pending) }) + '\n';
        const temp = this.#stateFile + '.tmp';
        await writeFile(temp, snapshot, { mode: 0o600 });
        await rename(temp, this.#stateFile);
      });
    });
    this.#write = this.#write.catch((error) => { this.#writeError = error; });
  }

  add(session, input, now = Date.now()) {
    const key = String(session ?? '').trim();
    const messageId = String(input?.messageId ?? '').trim();
    const text = String(input?.text ?? '').trim();
    const at = Number(input?.at ?? now);
    if (!key || !messageId || !text || text.length > 4000 || !Number.isFinite(at) || at <= 0 || at > now + 120_000) return false;
    const messages = this.#sessions.get(key) ?? [];
    if (messages.some((message) => message.messageId === messageId) || this.#seenIds.get(key)?.includes(messageId)) return false;
    const retained = messages.filter((message) => now - message.at <= this.#ttlMs);
    if (!retained.length && this.#pendingWaits.delete(key)) this.#persist({ op: 'clearPending', session: key });
    retained.push({ messageId, text, at, senderId: String(input.senderId ?? ''),
      ...(input.senderNickname && { senderNickname: input.senderNickname }), isSelf: input.isSelf === true });
    if (retained.length > this.#limit) retained.splice(0, retained.length - this.#limit);
    this.#sessions.set(key, retained);
    this.#remember(key, messageId);
    this.#persist({ op: 'add', session: key, message: retained.at(-1) });
    return true;
  }

  unread(session, { afterId = '', limit = this.#limit } = {}) {
    const messages = this.#sessions.get(String(session ?? '')) ?? [];
    const index = afterId ? messages.findIndex((message) => message.messageId === String(afterId)) : -1;
    const start = index >= 0 ? index + 1 : 0;
    const cap = boundedInt(limit, this.#limit, 1, this.#limit);
    return messages.slice(start, start + cap).map((message) => ({ ...message }));
  }

  markRead(session, throughId) {
    const key = String(session ?? '');
    const messages = this.#sessions.get(key);
    if (!messages?.length) return 0;
    const index = messages.findIndex((message) => message.messageId === String(throughId));
    if (index < 0) return 0;
    this.#sessions.set(key, messages.slice(index + 1));
    if (index + 1 === messages.length) this.#sessions.delete(key);
    this.#persist({ op: 'read', session: key, throughId: String(throughId) });
    return index + 1;
  }

  pending(session) {
    const pending = this.#pendingWaits.get(String(session ?? ''));
    return pending ? { ...pending, incoming: { ...pending.incoming } } : null;
  }

  setPending(session, input) {
    const key = String(session ?? '').trim();
    const pending = normalizePendingWait(input);
    if (!key || !pending || !this.#sessions.get(key)?.length) return false;
    this.#pendingWaits.set(key, pending);
    this.#persist({ op: 'pending', session: key, pending });
    return true;
  }

  clearPending(session) {
    const key = String(session ?? '');
    if (!this.#pendingWaits.delete(key)) return false;
    this.#persist({ op: 'clearPending', session: key });
    return true;
  }

  clear(session) {
    if (session === undefined) {
      this.#sessions.clear();
      this.#pendingWaits.clear();
      this.#persist({ op: 'clearAll' });
    } else {
      const key = String(session);
      this.#sessions.delete(key);
      this.#pendingWaits.delete(key);
      this.#persist({ op: 'clear', session: key });
    }
  }
}

function rememberSeen(seen, session, messageId) {
  const key = String(session ?? '').trim();
  if (!key || messageId === undefined || messageId === null) return;
  const ids = seen.get(key) ?? [];
  const id = String(messageId);
  if (!ids.includes(id)) ids.push(id);
  if (ids.length > 200) ids.splice(0, ids.length - 200);
  seen.set(key, ids);
}

function applyAdd(sessions, seen, session, message, limit) {
  const key = String(session ?? '').trim();
  if (!key || !message?.messageId || !message?.text) return;
  const messages = sessions.get(key) ?? [];
  if (messages.some((row) => row.messageId === String(message.messageId)) || seen.get(key)?.includes(String(message.messageId))) return;
  rememberSeen(seen, key, message.messageId);
  messages.push({ messageId: String(message.messageId), text: String(message.text), at: Number(message.at), senderId: String(message.senderId ?? ''),
    ...(message.senderNickname && { senderNickname: message.senderNickname }), isSelf: message.isSelf === true });
  if (messages.length > limit) messages.splice(0, messages.length - limit);
  sessions.set(key, messages);
}

function applyRead(sessions, pending, session, throughId) {
  const key = String(session ?? '');
  const messages = sessions.get(key);
  if (!messages?.length) return;
  const index = messages.findIndex((message) => message.messageId === String(throughId));
  if (index < 0) return;
  if (index + 1 === messages.length) {
    sessions.delete(key);
    pending.delete(key);
  }
  else sessions.set(key, messages.slice(index + 1));
}

function applyEntry(sessions, seen, pending, entry, limit) {
  if (entry.op === 'add') applyAdd(sessions, seen, entry.session, entry.message, limit);
  else if (entry.op === 'read') applyRead(sessions, pending, entry.session, entry.throughId);
  else if (entry.op === 'pending') restorePending(pending, entry.session, entry.pending);
  else if (entry.op === 'clearPending') pending.delete(String(entry.session ?? ''));
  else if (entry.op === 'prune') pruneSessions(sessions, pending, Date.now(), DEFAULT_TTL_MS);
  else if (entry.op === 'clear') {
    const key = String(entry.session ?? '');
    sessions.delete(key);
    seen.delete(key);
    pending.delete(key);
  } else if (entry.op === 'clearAll') {
    sessions.clear();
    seen.clear();
    pending.clear();
  }
}

function normalizePendingWait(input) {
  if (!input || !['wait', 'lurk'].includes(input.action)) return null;
  const deadline = Number(input.deadline);
  const waitMs = Number(input.waitMs);
  const watermark = String(input.watermark ?? '');
  const incoming = input.incoming;
  if (!Number.isFinite(deadline) || deadline <= 0 || deadline > Date.now() + waitMs + 60_000 || !watermark || !incoming || incoming.kind !== 'group' ||
      !incoming.contact || !incoming.messageId || typeof incoming.text !== 'string' || incoming.text.length > 2000 ||
      !Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 10 * 60_000) return null;
  return {
    action: input.action,
    deadline,
    waitMs,
    watermark,
    incoming: {
      kind: 'group', contact: String(incoming.contact), messageId: String(incoming.messageId),
      text: incoming.text, senderId: String(incoming.senderId ?? ''), atBot: incoming.atBot === true,
    },
  };
}

function restorePending(pending, session, input) {
  const key = String(session ?? '').trim();
  const value = normalizePendingWait(input);
  if (key && value) pending.set(key, value);
}

function pruneSessions(sessions, pending, now, ttlMs) {
  for (const [session, messages] of sessions) {
    const retained = messages.filter((message) => now - message.at <= ttlMs);
    if (retained.length) sessions.set(session, retained);
    else {
      sessions.delete(session);
      pending.delete(session);
    }
  }
  for (const session of pending.keys()) if (!sessions.get(session)?.length) pending.delete(session);
}

export function evaluateWake(message, {
  enabled = false,
  botName = '',
  botNames,
  keywords = [],
  speakerIds = [],
  atMention = true,
  nameMention = true,
  question = true,
  probability = 0,
  random = Math.random,
} = {}) {
  if (!enabled || !message || message.isSelf) return { wake: false, reason: 'disabled-or-self' };
  const text = normalized(message.text);
  const names = (Array.isArray(botNames) ? botNames : [botName]).map(normalized).filter(Boolean);
  if (message.atBot === true && atMention) return { wake: true, reason: 'atMention' };
  if (atMention && /@[\w\u3400-\u9fff-]{1,32}/u.test(text) && names.some((name) => text.includes('@' + name))) return { wake: true, reason: 'atMention' };
  if (nameMention && names.some((name) => new RegExp('(?:^|[\\s,，。！？!?、])' + safePattern(name) + '(?:$|[\\s,，。！？!?、])', 'u').test(text))) {
    return { wake: true, reason: 'nameMention' };
  }
  if (speakerIds.map(String).includes(String(message.senderId ?? ''))) return { wake: true, reason: 'speaker' };
  if (keywords.some((keyword) => normalized(keyword) && text.includes(normalized(keyword)))) return { wake: true, reason: 'keyword' };
  if (question && /[？?]\s*$/.test(text)) return { wake: true, reason: 'question' };
  const chance = Number(probability);
  if (Number.isFinite(chance) && chance > 0 && random() < Math.min(chance, 0.25)) return { wake: true, reason: 'probability' };
  return { wake: false, reason: 'no-trigger' };
}

export function validateSocialDecision(value, { maxWaitMs = 10 * 60_000, minWaitMs = 5_000, maxText = 1000 } = {}) {
  let decision = value;
  if (typeof decision === 'string') {
    try { decision = JSON.parse(decision); } catch { return { action: 'wait', waitMs: 30_000, reason: 'invalid-decision' }; }
  }
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) return { action: 'wait', waitMs: 30_000, reason: 'invalid-decision' };
  if (decision.action === 'speak' && typeof decision.text === 'string') {
    const text = decision.text.trim();
    if (text && text.length <= maxText) return { action: 'speak', text };
  }
  if (decision.action === 'wait' || decision.action === 'lurk') {
    const waitMs = boundedInt(decision.waitMs, 30_000, minWaitMs, maxWaitMs);
    return { action: decision.action, waitMs };
  }
  return { action: 'wait', waitMs: 30_000, reason: 'invalid-decision' };
}
