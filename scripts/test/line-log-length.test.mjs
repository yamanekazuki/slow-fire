// 運営LINEの会話ログは、1通まるごと残す（2026-10-12 あんちゃんの長い振り返りが1000字で切れて後半が読めなかった）
// LINEのテキストは1通最大5000字。会話ログの保存でそれより短く切らない
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
const src = fs.readFileSync(new URL("../../functions/index.js", import.meta.url), "utf8");
test("会話ログ(line_group_log)の本文は5000字まで残す", () => {
  const m = src.match(/collection\('line_group_log'\)\.add\(\{[\s\S]{0,200}?text: rawText\.slice\(0, (\d+)\)/);
  assert.ok(m, "会話ログの保存処理が見つからない");
  assert.ok(Number(m[1]) >= 5000, `本文を${m[1]}字で切っている`);
});
