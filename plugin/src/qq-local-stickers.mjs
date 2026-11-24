import { createHash } from 'node:crypto';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readActiveRoleId, roleStorageDirectory, withRoleStorageLock } from './role-storage.mjs';

const defaultLimitBytes = 200_000_000;
const rolePattern = /^[a-z][a-z0-9-]{0,39}$/u;
const scopePattern = /^(?:[1-9][0-9]{3,14}:)?qq-(?:group-)?[1-9][0-9]{3,14}$/u;
const idPattern = /^[a-f0-9]{64}$/u;
const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const schema = `
  CREATE TABLE IF NOT EXISTS stickers (
    role_id TEXT NOT NULL,
    scope TEXT NOT NULL,
    id TEXT NOT NULL,
    label TEXT NOT NULL,
    extension TEXT NOT NULL,
    visual_hash TEXT,
    bytes BLOB NOT NULL,
    byte_count INTEGER GENERATED ALWAYS AS (length(bytes)) STORED,
    PRIMARY KEY (role_id, scope, id)
  ) STRICT;
  CREATE UNIQUE INDEX IF NOT EXISTS sticker_visual
    ON stickers (role_id, scope, visual_hash) WHERE visual_hash IS NOT NULL;
  CREATE INDEX IF NOT EXISTS sticker_byte_count ON stickers (byte_count);
`;

function assertSource(roleId, scope) {
  if (typeof roleId !== 'string' || !rolePattern.test(roleId) ||
      typeof scope !== 'string' || !scopePattern.test(scope)) {
    throw new Error('本地表情的角色或会话范围无效。');
  }
}

function matchesImageFormat(bytes, extension) {
  if (!Buffer.isBuffer(bytes)) return false;
  if (extension === 'gif') return /^GIF8[79]a$/u.test(bytes.toString('latin1', 0, 6));
  if (extension === 'png') return bytes.subarray(0, 8).equals(pngSignature);
  if (extension === 'jpg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (extension === 'webp') return bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP';
  return false;
}

function cleanLabel(label) {
  if (typeof label !== 'string' || label.length > 4_000) throw new Error('本地表情标签无效。');
  const cleaned = [...label.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim()].slice(0, 60).join('').trimEnd();
  if (!cleaned) throw new Error('本地表情标签不能为空。');
  return cleaned;
}

function transaction(db, work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw error;
  }
}

const always = () => true;

export function createLocalStickerLibrary({ directory, limitBytes = defaultLimitBytes } = {}) {
  if (!Number.isSafeInteger(limitBytes) || limitBytes < 0 || limitBytes > defaultLimitBytes) {
    throw new Error('本地表情容量上限无效。');
  }
  const overrideDirectory = directory === undefined ? undefined : resolve(directory);

  async function useDatabase(work, { create = false, missing, writeRole, staleRole } = {}) {
    async function openDatabase() {
      const directory = overrideDirectory ?? roleStorageDirectory();
      if (overrideDirectory === undefined && writeRole && await readActiveRoleId(directory) !== writeRole) return staleRole;
      const root = overrideDirectory ?? join(directory, 'characters');
      const path = join(root, 'qq-local-stickers.sqlite');
      if (create) {
        await mkdir(root, { recursive: true, mode: 0o700 });
        const created = await open(path, 'wx', 0o600).catch((error) => {
          if (error.code === 'EEXIST') return null;
          throw error;
        });
        await created?.close();
      }
      const info = await lstat(path).catch((error) => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!info && !create) return missing;
      if (info && !info.isFile()) throw new Error('Invalid sticker database file.');
      const db = new DatabaseSync(path, { timeout: 2_000 });
      try {
        db.exec(schema);
        return work(db);
      } finally {
        db.close();
      }
    }

    try {
      // Migration copies characters and publishes a new storage root under this lock.
      return await (overrideDirectory === undefined ? withRoleStorageLock(openDatabase) : openDatabase());
    } catch (error) {
      throw new Error('本地表情库暂时不可用。', { cause: error });
    }
  }

  async function list(roleId, scope) {
    assertSource(roleId, scope);
    return useDatabase((db) => db.prepare(
      'SELECT id, label FROM stickers WHERE role_id = ? AND scope = ? ORDER BY rowid DESC',
    ).all(roleId, scope).map(({ id, label }) => ({ id, label })), { missing: [] });
  }

  async function save(roleId, scope, { bytes, extension, visualHash, label } = {}, { canWrite = always } = {}) {
    assertSource(roleId, scope);
    if (!matchesImageFormat(bytes, extension)) throw new Error('本地表情图片格式无效。');
    if (visualHash != null && (typeof visualHash !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(visualHash))) {
      throw new Error('本地表情视觉指纹无效。');
    }
    const safeLabel = cleanLabel(label);
    if (canWrite() !== true) return { status: 'cancelled' };
    const original = bytes.length <= limitBytes ? Buffer.from(bytes) : null;
    const id = createHash('sha256').update(roleId).update('\0').update(scope).update('\0').update(original ?? bytes).digest('hex');
    return useDatabase((db) => transaction(db, () => {
      if (canWrite() !== true) return { status: 'cancelled' };
      const exact = db.prepare('SELECT id, label FROM stickers WHERE role_id = ? AND scope = ? AND id = ?').get(roleId, scope, id);
      const duplicate = exact ?? (visualHash == null ? null : db.prepare(
        'SELECT id, label FROM stickers WHERE role_id = ? AND scope = ? AND visual_hash = ?',
      ).get(roleId, scope, visualHash));
      if (duplicate) return { status: 'duplicate', id: duplicate.id, label: duplicate.label };
      if (!original) return { status: 'full' };
      const { used } = db.prepare('SELECT coalesce(sum(byte_count), 0) AS used FROM stickers').get();
      if (used + original.length > limitBytes) return { status: 'full' };
      db.prepare(
        'INSERT INTO stickers (role_id, scope, id, label, extension, visual_hash, bytes) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(roleId, scope, id, safeLabel, extension, visualHash ?? null, original);
      return { status: 'saved', id, label: safeLabel };
    }), { create: original !== null, missing: { status: 'full' }, writeRole: roleId, staleRole: { status: 'cancelled' } });
  }

  async function remove(roleId, scope, id, { canWrite = always } = {}) {
    assertSource(roleId, scope);
    if (typeof id !== 'string' || !idPattern.test(id)) return false;
    return useDatabase((db) => {
      db.exec('PRAGMA secure_delete = ON');
      return transaction(db, () => {
        if (canWrite() !== true) return false;
        return db.prepare('DELETE FROM stickers WHERE role_id = ? AND scope = ? AND id = ?')
          .run(roleId, scope, id).changes === 1;
      });
    }, { missing: false, writeRole: roleId, staleRole: false });
  }

  async function read(roleId, scope, id) {
    assertSource(roleId, scope);
    if (typeof id !== 'string' || !idPattern.test(id)) return null;
    return useDatabase((db) => {
      const row = db.prepare('SELECT bytes, extension, label FROM stickers WHERE role_id = ? AND scope = ? AND id = ?')
        .get(roleId, scope, id);
      return row ? { bytes: Buffer.from(row.bytes), extension: row.extension, label: row.label } : null;
    }, { missing: null });
  }

  return { list, save, remove, read };
}

export const localStickers = createLocalStickerLibrary();
