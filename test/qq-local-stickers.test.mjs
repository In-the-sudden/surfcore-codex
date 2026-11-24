import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const roleData = await mkdtemp(join(tmpdir(), 'surfcore-sticker-role-root-'));
process.env.SURFCORE_DATA_DIR = roleData;
after(() => rm(roleData, { recursive: true, force: true }));

const gif = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jM1sAAAAASUVORK5CYII=', 'base64');
const role = 'ming';
const privateScope = 'qq-10001';
const groupScope = 'qq-group-10001';

async function setup(t, limitBytes) {
  const directory = await mkdtemp(join(tmpdir(), 'surfcore-local-sticker-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { createLocalStickerLibrary } = await import('../plugin/src/qq-local-stickers.mjs');
  const open = () => createLocalStickerLibrary({ directory, limitBytes });
  return { library: open(), open };
}

test('persists the original sticker bytes and restricts every operation to the source role and scope', async (t) => {
  const { library, open } = await setup(t);
  const saved = await library.save(role, privateScope, { bytes: gif, extension: 'gif', label: '  欢迎\n回来  ' });
  assert.equal(saved.status, 'saved');
  assert.match(saved.id, /^[a-f0-9]{64}$/u);
  assert.equal(saved.label, '欢迎 回来');

  const reopened = open();
  assert.deepEqual(await reopened.list(role, privateScope), [{ id: saved.id, label: '欢迎 回来' }]);
  assert.deepEqual(await reopened.read(role, privateScope, saved.id), { bytes: gif, extension: 'gif', label: '欢迎 回来' });
  for (const [otherRole, otherScope] of [[role, groupScope], [role, 'qq-10002'], ['lin', privateScope]]) {
    assert.deepEqual(await reopened.list(otherRole, otherScope), []);
    assert.equal(await reopened.read(otherRole, otherScope, saved.id), null);
    assert.equal(await reopened.remove(otherRole, otherScope, saved.id), false);
  }
  assert.equal(await reopened.remove(role, privateScope, saved.id), true);
  assert.equal(await reopened.read(role, privateScope, saved.id), null);
  assert.equal(await reopened.remove(role, privateScope, saved.id), false);
});

test('deduplicates bytes and decoder-supplied visual fingerprints inside one scope', async (t) => {
  const { library } = await setup(t);
  const original = { bytes: gif, extension: 'gif', visualHash: 'fixture-visual', label: '贴贴' };
  const saved = await library.save(role, privateScope, original);
  const duplicate = { status: 'duplicate', id: saved.id, label: '贴贴' };
  assert.deepEqual(await library.save(role, privateScope, { ...original, visualHash: undefined, label: '重复' }), duplicate);
  assert.deepEqual(await library.save(role, privateScope, { ...original, bytes: png, extension: 'png' }), duplicate);
  const group = await library.save(role, groupScope, original);
  assert.equal(group.status, 'saved');
  assert.notEqual(group.id, saved.id);
  assert.deepEqual(await library.list(role, groupScope), [{ id: group.id, label: '贴贴' }]);
  assert.equal(await library.read(role, privateScope, group.id), null);
});

test('enforces one original-byte budget across roles under concurrent writes', async (t) => {
  const { library, open } = await setup(t, gif.length);
  const sticker = { bytes: gif, extension: 'gif', label: '这个表情' };
  const results = await Promise.all([
    library.save(role, privateScope, sticker),
    open().save('lin', groupScope, sticker),
  ]);
  assert.deepEqual(results.map(({ status }) => status).sort(), ['full', 'saved']);
  const [winnerRole, winnerScope, loserRole, loserScope] = results[0].status === 'saved'
    ? [role, privateScope, 'lin', groupScope]
    : ['lin', groupScope, role, privateScope];
  const winner = results.find(({ status }) => status === 'saved');
  assert.equal((await library.save(winnerRole, winnerScope, sticker)).status, 'duplicate');
  assert.equal(await library.remove(winnerRole, winnerScope, winner.id), true);
  assert.equal((await library.save(loserRole, loserScope, sticker)).status, 'saved');
});

test('checks the write guard before committing or removing a sticker', async (t) => {
  const { library } = await setup(t);
  const sticker = { bytes: gif, extension: 'gif', label: '这个表情' };
  const denied = { canWrite: () => false };
  assert.deepEqual(await library.save(role, privateScope, sticker, denied), { status: 'cancelled' });
  assert.deepEqual(await library.list(role, privateScope), []);
  const saved = await library.save(role, privateScope, sticker);
  assert.equal(await library.remove(role, privateScope, saved.id, denied), false);
  assert.deepEqual(await library.list(role, privateScope), [{ id: saved.id, label: '这个表情' }]);
});

test('rejects invalid sources, formats and labels before persisting any item', async (t) => {
  const { library } = await setup(t);
  const sticker = { bytes: gif, extension: 'gif', label: '这个表情' };
  await assert.rejects(library.save('../ming', privateScope, sticker));
  await assert.rejects(library.save(role, 'codex', sticker));
  await assert.rejects(library.save(role, privateScope, { ...sticker, extension: 'svg' }));
  await assert.rejects(library.save(role, privateScope, { ...sticker, bytes: Buffer.from('broken') }));
  await assert.rejects(library.save(role, privateScope, { ...sticker, label: ' \n ' }));
  assert.deepEqual(await library.list(role, privateScope), []);
  assert.equal(await library.read(role, privateScope, '../../anything'), null);
  assert.equal(await library.remove(role, privateScope, '../../anything'), false);
  const long = await library.save(role, privateScope, { ...sticker, label: '🌟'.repeat(100) });
  assert.equal([...long.label].length, 60);
});

test('an existing visual match stays a duplicate when a larger encoding exceeds the byte limit', async (t) => {
  const { library } = await setup(t, gif.length);
  const source = { bytes: gif, extension: 'gif', visualHash: 'same-visual', label: '留在这里' };
  const saved = await library.save(role, privateScope, source);
  const otherEncoding = { ...source, bytes: png, extension: 'png' };
  assert.deepEqual(await library.save(role, privateScope, otherEncoding),
    { status: 'duplicate', id: saved.id, label: saved.label });
});

test('default library rejects stale sticker writes when the role has changed', async () => {
  const { localStickers } = await import('../plugin/src/qq-local-stickers.mjs');
  const { activateCharacter } = await import('../plugin/src/store.mjs');
  await activateCharacter('lin');
  const scope = '10001:qq-10002';
  const sticker = { bytes: gif, extension: 'gif', label: '示例表情' };
  const saved = await localStickers.save('lin', scope, sticker);
  assert.equal(saved.status, 'saved');
  await activateCharacter('ming');
  assert.deepEqual(await localStickers.save('lin', scope, { ...sticker, bytes: png, extension: 'png' }), { status: 'cancelled' });
  assert.equal(await localStickers.remove('lin', scope, saved.id), false);
  assert.deepEqual(await localStickers.list('lin', scope), [{ id: saved.id, label: sticker.label }]);
});

test('default library writes coordinate with the role-storage migration lock', async (t) => {
  const destination = await mkdtemp(join(tmpdir(), 'surfcore-sticker-reopen-'));
  t.after(() => rm(destination, { recursive: true, force: true }));
  const { localStickers } = await import('../plugin/src/qq-local-stickers.mjs');
  const { moveRoleStorage, withRoleStorageLock } = await import('../plugin/src/role-storage.mjs');
  const { activateCharacter } = await import('../plugin/src/store.mjs');
  await activateCharacter(role);
  const saved = await localStickers.save(role, privateScope, { bytes: gif, extension: 'gif', label: '迁移前' });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const held = withRoleStorageLock(async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;

  const next = localStickers.save(role, privateScope, { bytes: png, extension: 'png', label: '迁移时' });
  const moving = moveRoleStorage(destination);
  const winner = await Promise.race([next.then(() => 'saved'), delay(120, 'waiting')]).finally(release.resolve);
  await held;
  const [added] = await Promise.all([next, moving]);

  assert.equal(winner, 'waiting');
  assert.deepEqual(await localStickers.read(role, privateScope, saved.id), { bytes: gif, extension: 'gif', label: '迁移前' });
  assert.deepEqual(await localStickers.read(role, privateScope, added.id), { bytes: png, extension: 'png', label: '迁移时' });
});
