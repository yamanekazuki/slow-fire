// 与論島の宿の予約・問い合わせメール（本番に触らない）
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const core = require("../../functions/stay-inquiry-core.js");

test("件名: 名前・希望日・人数が一目でわかる。日程が空なら「日程未定」", () => {
  const d = core.normalizeInquiry({ name: "長谷川梨沙", email: "a@example.com", date: "2026年10月20日(火)〜22日(木)", party: "大人2名" });
  assert.equal(core.inquirySubject(d), "【与論の宿 問い合わせ】長谷川梨沙さん／2026年10月20日(火)〜22日(木)・大人2名");
  assert.equal(core.inquirySubject(core.normalizeInquiry({ name: "A" })), "【与論の宿 問い合わせ】Aさん／日程未定");
});

test("テスト送信は件名に【テスト】が付く（true のときだけ）", () => {
  assert.match(core.inquirySubject(core.normalizeInquiry({ name: "A", test: true })), /^【テスト】/);
  assert.equal(core.normalizeInquiry({ name: "A", test: "true" }).test, false);
});

test("整形: 文字列でない値は空、長すぎる値は上限で切る、前後の空白を落とす", () => {
  const d = core.normalizeInquiry({ name: "  A  ", party: 2, message: "x".repeat(6000) });
  assert.equal(d.name, "A");
  assert.equal(d.party, "");
  assert.equal(d.message.length, 5000);
});

test("本文の表: フォームの全項目が並び、空欄は「—」", () => {
  const rows = core.inquiryRows(core.normalizeInquiry({ name: "A", email: "a@example.com", interest: "BBQ＋宿泊＋シェアカー" }));
  assert.deepEqual(rows.map((r) => r[0]), ["お名前", "メール", "希望日", "人数", "ご興味", "メッセージ", "送信元"]);
  assert.equal(rows[4][1], "BBQ＋宿泊＋シェアカー");
  assert.equal(rows[2][1], "—");
});
