// 管理ページの講座申込表示（本番に触らない）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const L = createRequire(import.meta.url)(path.join(ROOT, "admin-lecture.js"));

test("10/11名古屋は申込0件でも枠が出る（定員6）", () => {
  const html = L.lectureBlocksHtml([]);
  assert.match(html, /10\/11\(日\) 名古屋/);
  assert.match(html, /0 \/ 6名/);
  assert.match(html, /まだ申込はありません/);
});

test("申込は開催回ごとにまとまり、人数は party の合計・電話も出る", () => {
  const regs = [
    { eventId: "lec-2026-09", name: "田中", email: "t@example.com", party: 2, tel: "000-TEST-0000", note: "楽しみ", createdAt: "2026-09-20T01:00:00.000Z" },
    { eventId: "lec-2026-09", name: "佐藤", email: "s@example.com", party: 1, createdAt: "2026-09-21T01:00:00.000Z" },
    { eventId: "lec-2026-11", name: "鈴木", email: "z@example.com", party: 1, createdAt: "2026-09-22T01:00:00.000Z" },
  ];
  const html = L.lectureBlocksHtml(regs);
  assert.match(html, /3 \/ 6名/);
  assert.match(html, /2組の申込/);
  assert.match(html, /11月 東京/);
  assert.match(html, /tel:000-TEST-0000/);
  assert.ok(html.indexOf("田中") < html.indexOf("佐藤"), "古い申込が上");
  assert.match(L.lectureStatsHtml(regs), /残り3枠/);
});

test("名前などは HTML エスケープされる", () => {
  const html = L.lectureBlocksHtml([{ eventId: "lec-2026-09", name: "<b>x</b>", email: "a@example.com", note: '"q"' }]);
  assert.ok(!html.includes("<b>x</b>"));
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
});

test("定員到達で満席バッジ", () => {
  const regs = Array.from({ length: 3 }, (_, i) => ({ eventId: "lec-2026-09", name: "n" + i, email: "a@example.com", party: 2 }));
  assert.match(L.lectureBlocksHtml(regs), /満席/);
});

test("adminList が lecture_regs を返し、admin.html が講座欄を描く", () => {
  const fn = fs.readFileSync(path.join(ROOT, "functions/index.js"), "utf8");
  const body = fn.slice(fn.indexOf("exports.adminList"), fn.indexOf("exports.bbqGuestGuideSend"));
  assert.match(body, /collection\('lecture_regs'\)/);
  assert.match(body, /lectureRegs: toJson\(lectureRegs\)/);
  const admin = fs.readFileSync(path.join(ROOT, "admin.html"), "utf8");
  assert.match(admin, /<script src="admin-lecture\.js"><\/script>/);
  assert.match(admin, /id="lectures"/);
  assert.match(admin, /AdminLecture\.lectureBlocksHtml\(data\.lectureRegs\)/);
});
