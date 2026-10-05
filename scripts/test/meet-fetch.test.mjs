// 日程調整: Google が一時的に断った（429）時の取り直し（2026-10-05 SRE点検で、クラウドからの取得に429が出ると判明）
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const F = require("../../functions/meet-fetch.js");
const ICS = "BEGIN:VCALENDAR\r\nEND:VCALENDAR";
function fake(statuses) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    const st = statuses[Math.min(calls.length - 1, statuses.length - 1)];
    if (st === "boom") throw new Error("network");
    return { ok: st === 200, status: st, text: async () => (st === 200 ? ICS : "") };
  };
  return calls;
}
const fast = { waits: [1, 1] };

test("429が2回続いても3回目で読めれば成功する", async () => {
  F._icsCache.clear();
  const calls = fake([429, 503, 200]);
  assert.equal(await F.fetchIcs("https://calendar.google.com/a/basic.ics", fast), ICS);
  assert.equal(calls.length, 3);
});

test("ずっと429なら3回で止めて「一時的」と分かる失敗にする", async () => {
  F._icsCache.clear();
  const calls = fake([429]);
  await assert.rejects(F.fetchIcs("https://calendar.google.com/b/basic.ics", fast), (e) => e.transient === true && /429/.test(e.message));
  assert.equal(calls.length, 3);
});

test("404やiCalでない中身は取り直さず、すぐ「URLの問題」として返す", async () => {
  F._icsCache.clear();
  const calls = fake([404]);
  await assert.rejects(F.fetchIcs("https://calendar.google.com/c/basic.ics", fast), (e) => !e.transient);
  assert.equal(calls.length, 1);
});

test("通信エラーも一時的扱いで取り直す・読めたものは5分控えて二度取りしない", async () => {
  F._icsCache.clear();
  const calls = fake(["boom", 200]);
  await F.fetchIcs("https://calendar.google.com/d/basic.ics", fast);
  await F.fetchIcs("https://calendar.google.com/d/basic.ics", fast);
  assert.equal(calls.length, 2);
});

test("登録時の待ち時間は回ごとに変えられる（1回目25秒・2回目20秒）", async () => {
  F._icsCache.clear();
  const calls = fake([429, 200]);
  assert.equal(await F.fetchIcs("https://calendar.google.com/e/basic.ics", { waits: [1], timeoutMs: [25000, 20000] }), ICS);
  assert.equal(calls.length, 2);
});
