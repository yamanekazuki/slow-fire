// 日程調整ページの表示計算（日ごとのまとめ・○の数え直し・決めやすい枠・カレンダーからの初期値）
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const L = createRequire(import.meta.url)(path.join(ROOT, "meet-logic.js"));
const MEM = [{ key: "uetaku" }, { key: "anri" }, { key: "yoshi" }];
const rows = [
  { id: "a", day: "2026-10-13", label: "10/13(火) 11:00〜12:00" },
  { id: "b", day: "2026-10-13", label: "10/13(火) 11:30〜12:30" },
  { id: "c", day: "2026-10-14", label: "10/14(水) 11:00〜12:00" },
];

test("日ごとにまとめ、見出しは曜日つき・時刻だけ取り出せる", () => {
  const g = L.groupByDay(rows);
  assert.deepEqual(g.map((x) => [x.label, x.rows.length]), [["10/13(火)", 2], ["10/14(水)", 1]]);
  assert.equal(L.timeOf(rows[0]), "11:00〜12:00");
});

test("自分の手元の○で数え直し、全員そろうと全員OK・そろわなければあと1人の枠", () => {
  const answers = { uetaku: { ok: ["a", "b"] }, anri: { ok: ["a", "b"] }, yoshi: { ok: ["b"] } };
  let r = L.recount(rows, MEM, answers, "yoshi", ["b"]);
  assert.deepEqual(L.bestRows(r, MEM, 5).rows.map((x) => x.id), ["b"]);
  r = L.recount(rows, MEM, answers, "yoshi", []);
  const best = L.bestRows(r, MEM, 5);
  assert.equal(best.kind, "near");
  assert.deepEqual(best.rows.map((x) => x.id), ["a", "b"]);
});

test("カレンダーの予定ありを避けて○を付ける・タップで付け外し", () => {
  assert.deepEqual(L.prefillFromBusy(rows, ["b"]), ["a", "c"]);
  assert.deepEqual(L.toggle(["a"], "b"), ["a", "b"]);
  assert.deepEqual(L.toggle(["a", "b"], "a"), ["b"]);
});
