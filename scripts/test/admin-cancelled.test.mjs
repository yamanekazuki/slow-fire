// 管理ページ: キャンセル（status=cancelled）の申込は受付人数・組数に数えない（本番に触らない）
// 2026-11-16 うえたく依頼で22日の回に初めて cancelled を使ったため。案内便(guest-guide/core.mjs)と同じ扱いに揃える
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const html = fs.readFileSync(path.join(ROOT, "admin.html"), "utf8");

test("サマリーの受付人数と組数からキャンセルを外す", () => {
  assert.match(html, /if\(r\.status==='cancelled'\) return; if\(r\.status==='waitlist'\)/);
  assert.match(html, /regs\.filter\(function\(r\)\{return r\.status!=='cancelled';\}\)\.length\+'組'/);
});

test("開催回ブロックの人数メーターからキャンセルを外す", () => {
  assert.match(html, /if\(r\.status!=='waitlist' && r\.status!=='cancelled'\) confirmed \+=/);
});

test("一覧ではキャンセルの札を出す", () => {
  assert.match(html, /cx\?'キャンセル':'受付'/);
  assert.match(html, /\.tag\.cancel \{/);
});

test("受付を数える箇所に、キャンセルを数えてしまう古い書き方が残っていない", () => {
  assert.doesNotMatch(html, /if\(r\.status!=='waitlist'\) confirmed/);
});
