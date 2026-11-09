// 2026-11-10 山根さん指示: LINEの修正依頼には一切返さない（受付・作業中・遅延・失敗・完了すべて）。送信枠の節約
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const fn = readFileSync(new URL("../../functions/index.js", import.meta.url), "utf8");
const loop = readFileSync(new URL("../request-loop.mjs", import.meta.url), "utf8");

test("受付時にLINEで返さない（webhook）", () => {
  const start = fn.indexOf("const call = parseLineCall(");
  const end = fn.indexOf("lineWebhook:", start);
  const block = fn.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.ok(!block.includes("lineReply("), "修正依頼の受付処理にlineReplyが残っている");
});

test("遅延お知らせのLINE送信は既定で止まっている（watchdog）", () => {
  assert.match(fn, /if \(process\.env\.BBQ_WATCHDOG_LINE === '1'\) for \(const \[gid, items\] of byGroup\)/);
});

test("request-loopのLINE送信は既定で止まっている", () => {
  assert.match(loop, /const LINE_REPLY_ENABLED = process\.env\.BBQ_REQUEST_LINE_REPLY === "1";/);
  assert.match(loop, /if \(NO_LINE \|\| !LINE_REPLY_ENABLED\) \{ log\(/);
});
