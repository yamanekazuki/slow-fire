const test = require('node:test');
const assert = require('node:assert');
const g = require('../admin-gate');

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
  };
  return db;
}
const now = new Date('2026-11-11T03:10:00Z');

test('正しい合言葉は通し、違う・空・長さ違いは断る', async () => {
  const db = fakeDb();
  assert.deepEqual(await g.checkAdminPass(db, { pass: 'secret-pass', expected: 'secret-pass', ip: '1.2.3.4', now }), { ok: true });
  assert.equal((await g.checkAdminPass(db, { pass: 'wrong', expected: 'secret-pass', ip: '1.2.3.4', now })).reason, 'bad');
  assert.equal((await g.checkAdminPass(db, { pass: '', expected: 'secret-pass', ip: '1.2.3.4', now })).reason, 'bad');
  assert.equal((await g.checkAdminPass(db, { pass: 'x'.repeat(200), expected: 'secret-pass', ip: '1.2.3.4', now })).reason, 'bad');
});
test('合言葉が未設定なら誰も通さない', async () => {
  assert.equal((await g.checkAdminPass(fakeDb(), { pass: '', expected: '', ip: 'a', now })).ok, false);
});
test('同じ接続元の失敗が上限に達したら、正しい合言葉でもその時間は止める', async () => {
  const db = fakeDb();
  for (let i = 0; i < g.PER_IP_FAILS_PER_HOUR; i++) await g.checkAdminPass(db, { pass: 'x' + i, expected: 'ok', ip: '9.9.9.9', now });
  assert.equal((await g.checkAdminPass(db, { pass: 'ok', expected: 'ok', ip: '9.9.9.9', now })).reason, 'locked');
  assert.equal((await g.checkAdminPass(db, { pass: 'ok', expected: 'ok', ip: '8.8.8.8', now })).ok, true, '別の接続元は通る');
  const nextHour = new Date('2026-11-11T04:00:00Z');
  assert.equal((await g.checkAdminPass(db, { pass: 'ok', expected: 'ok', ip: '9.9.9.9', now: nextHour })).ok, true, '次の時間は通る');
});
test('全体の失敗が上限に達したら止める（接続元を変えた総当たり）', async () => {
  const db = fakeDb();
  for (let i = 0; i < g.GLOBAL_FAILS_PER_HOUR; i++) await g.checkAdminPass(db, { pass: 'x', expected: 'ok', ip: 'ip' + i, now });
  assert.equal((await g.checkAdminPass(db, { pass: 'ok', expected: 'ok', ip: 'fresh', now })).reason, 'locked');
});
test('台帳が読めない時は通さない', async () => {
  const db = fakeDb(); db.fail = true;
  assert.equal((await g.checkAdminPass(db, { pass: 'ok', expected: 'ok', ip: 'a', now })).reason, 'unavailable');
});
test('時間のキーは日本時間', () => {
  assert.equal(g.jstHour(new Date('2026-11-11T15:30:00Z')), '2026-11-12T00');
});
