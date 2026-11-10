const test = require('node:test');
const assert = require('node:assert');
const g = require('../cook-photo-guard');

test('未ログインは断る', () => {
  assert.equal(g.checkCookPhotoInput(null, { image: 'abc' }).code, 'unauthenticated');
});
test('画像なし・大きすぎ・形式違いは断る', () => {
  const a = { uid: 'u1' };
  assert.equal(g.checkCookPhotoInput(a, {}).code, 'invalid-argument');
  assert.equal(g.checkCookPhotoInput(a, { image: 'x'.repeat(g.MAX_B64_CHARS + 1) }).code, 'invalid-argument');
  assert.equal(g.checkCookPhotoInput(a, { image: 'abc', mime: 'text/html' }).code, 'invalid-argument');
});
test('正しい入力は通す', () => {
  assert.equal(g.checkCookPhotoInput({ uid: 'u1' }, { image: 'abc', mime: 'image/jpeg' }), null);
  assert.equal(g.checkCookPhotoInput({ uid: 'u1' }, { image: 'abc' }), null);
});

function fakeDb() {
  const store = {};
  const db = {
    fail: false,
    collection: (c) => ({ doc: (id) => ({ key: `${c}/${id}` }) }),
    runTransaction: async (fn) => {
      if (db.fail) throw new Error('down');
      return fn({
        get: async (ref) => ({ exists: !!store[ref.key], data: () => store[ref.key] }),
        set: (ref, v) => { store[ref.key] = { ...(store[ref.key] || {}), ...v }; },
      });
    },
    store,
  };
  return db;
}

test('1人あたりの上限で止まる', async () => {
  const db = fakeDb(); const now = new Date('2026-11-11T03:00:00Z');
  for (let i = 0; i < g.PER_USER_DAILY; i++) assert.equal(await g.takeCookPhotoQuota(db, 'u1', now), true);
  assert.equal(await g.takeCookPhotoQuota(db, 'u1', now), false);
  assert.equal(await g.takeCookPhotoQuota(db, 'u2', now), true);
});
test('全体の上限で止まる', async () => {
  const db = fakeDb(); const now = new Date('2026-11-11T03:00:00Z');
  for (let i = 0; i < g.GLOBAL_DAILY; i++) assert.equal(await g.takeCookPhotoQuota(db, 'u' + i, now), true);
  assert.equal(await g.takeCookPhotoQuota(db, 'new', now), false);
});
test('日本時間の日付が変われば数え直す', async () => {
  const db = fakeDb();
  for (let i = 0; i < g.PER_USER_DAILY; i++) await g.takeCookPhotoQuota(db, 'u1', new Date('2026-11-11T14:00:00Z'));
  assert.equal(await g.takeCookPhotoQuota(db, 'u1', new Date('2026-11-11T14:59:00Z')), false); // JST 23:59
  assert.equal(await g.takeCookPhotoQuota(db, 'u1', new Date('2026-11-11T15:00:00Z')), true);  // JST 翌0:00
});
test('台帳が読めない時は通さない', async () => {
  const db = fakeDb(); db.fail = true;
  assert.equal(await g.takeCookPhotoQuota(db, 'u1'), false);
});
