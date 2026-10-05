// minutes-todo の停滞通知（同じ件を何度も流さない。2026-10-05 山根さん「いつも来る」）
import { test } from "node:test";
import assert from "node:assert/strict";
import { staleNotices, STALE_MAX_NOTICES } from "../minutes-todo.mjs";

const NOW = Date.parse("2026-10-05T00:00:00Z");
const h = (n) => new Date(NOW - n * 3600000).toISOString();

test("判断待ち（blocked）は運営LINEに出さず、山根さんへだけ", () => {
  const r = staleNotices([{ it: { status: "blocked", summary: "a" }, ageH: 84 }], NOW);
  assert.equal(r.line.length, 0);
  assert.equal(r.slack.length, 1);
});

test("順番待ち（queued）は運営LINEへ1件につき1回だけ", () => {
  assert.equal(staleNotices([{ it: { status: "queued" }, ageH: 50 }], NOW).line.length, 1);
  assert.equal(staleNotices([{ it: { status: "queued", staleNotices: [h(80)] }, ageH: 130 }], NOW).line.length, 0);
});

test("同じ件は72時間あけて・3回まで（1日4回の実行で毎回流さない）", () => {
  const it = (sent) => ({ it: { status: "blocked", staleNotices: sent }, ageH: 100 });
  assert.equal(staleNotices([it([h(6)])], NOW).slack.length, 0);
  assert.equal(staleNotices([it([h(73)])], NOW).slack.length, 1);
  assert.equal(staleNotices([it(Array.from({ length: STALE_MAX_NOTICES }, (_, i) => h(500 - i * 100)))], NOW).slack.length, 0);
});
