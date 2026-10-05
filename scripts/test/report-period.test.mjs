// レポートメールの「サイト名」と「対象期間」（本番に触らない）
// 2026-10-05 山根さん「日次なのか週次なのか、直近28日なのか分からない」「サイトの呼び名をきちんと定義して」
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { SITES, range, todayJst, aboutBox } from "../lib/report-period.mjs";

const NOW = new Date("2026-10-04T23:00:00Z"); // = 2026-10-05（月）8:00 JST

test("サイト名は3つで、呼び名・URLがそれぞれ別（与論島ガイドとコミュニティを混ぜない）", () => {
  assert.deepEqual(Object.values(SITES).map((s) => s.name), ["SLOW FIRE", "与論島ガイド", "YORON BBQコミュニティ"]);
  assert.deepEqual(Object.values(SITES).map((s) => s.url), ["an-bbq.jp", "yoron-bbq.web.app", "yoron-bbq.com"]);
});

test("期間はJSTの暦日で数える（UTCでは前日でもJSTで日付が変わっていれば今日）", () => {
  assert.equal(todayJst(new Date("2026-10-04T15:30:00Z")), "2026-10-05"); // JST 0:30
  assert.equal(todayJst(new Date("2026-10-04T14:59:00Z")), "2026-10-04"); // JST 23:59
});

test("28日分＝GA4の28daysAgo〜yesterdayと同じ日付を、曜日つきの実日付で書く", () => {
  const r = range(28, 1, NOW);
  assert.equal(r.start, "2026-09-07");
  assert.equal(r.end, "2026-10-04");
  assert.equal(r.days, 28);
  assert.equal(r.label, "9/7（月）〜10/4（日）の28日間");
  assert.equal(r.short, "9/7〜10/4の28日間");
  assert.equal(range(56, 29, NOW).label, "8/10（月）〜9/6（日）の28日間"); // 比べた期間
});

test("1日分は「◯/◯（曜）の1日分」、7日分・検索の遅れた窓も実日付", () => {
  assert.equal(range(1, 1, NOW).label, "10/4（日）の1日分");
  assert.equal(range(7, 1, NOW).short, "9/28〜10/4の7日間");
  assert.equal(range(8, 2, NOW).short, "9/27〜10/3の7日間");
});

test("「このメールについて」に、どのサイト・届く頻度・数字の期間が出る（文字は無害化）", () => {
  const h = aboutBox({ site: SITES.guide, cadence: "週1回（毎週月曜の朝）", rows: [["数字の期間", "<b>x</b>"]] });
  assert.match(h, /与論島ガイド/);
  assert.match(h, /yoron-bbq\.web\.app/);
  assert.match(h, /週1回（毎週月曜の朝）/);
  assert.match(h, /&lt;b&gt;x&lt;\/b&gt;/);
});

test("レポート便の件名には、サイト名と頻度（日次/週次）が必ず入る", () => {
  const src = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  assert.match(src("shop-improvement.mjs"), /【\$\{site\.name\}｜週次・ショップ】\$\{cur\.short\}/);
  assert.match(src("blog-improvement.mjs"), /【\$\{site\.name\}｜週次・読み物】\$\{cur\.short\}/);
  assert.match(src("weekly-report.mjs"), /【\$\{site\.name\}｜週次】/);
  // 週次メールに「日次」と書かない（旧【SLOW FIRE 日次＋AI改善】の混乱）
  assert.doesNotMatch(src("shop-improvement.mjs"), /日次＋AI改善/);
});

test("yoron-bbq側の同名ファイルと中身が同じ（片方だけ直す事故を防ぐ）", (t) => {
  let other;
  try { other = readFileSync(new URL("../../../yoron-bbq/scripts/lib/report-period.mjs", import.meta.url), "utf8"); }
  catch { t.skip("yoron-bbq が隣に無い環境"); return; }
  assert.equal(readFileSync(new URL("../lib/report-period.mjs", import.meta.url), "utf8"), other);
});
