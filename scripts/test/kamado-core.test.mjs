// 魔法のかまどタイマーの段取り計算（本番に触らない）
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPlan, stepAt, sayStep, fmt, summarize, cleanLog, LATE_COUNT } from "../../kamado-core.mjs";

test("3合: 前半1分半×6→後半1分×6→10分蒸らし→仕上げ1本→5分蒸らし（山根さんの手順どおり）", () => {
  const p = buildPlan(3);
  assert.equal(p.late, 6);
  assert.equal(p.sheets, 13);
  assert.equal(p.totalSec, 6 * 90 + 6 * 60 + 600 + 60 + 300);
  const kinds = p.steps.map((s) => s.kind === "rest" ? `蒸${s.sec / 60}` : `${s.side}${s.sec}`);
  assert.deepEqual(kinds, ["右90", "左90", "右90", "左90", "右90", "左90", "右60", "左60", "右60", "左60", "右60", "左60", "蒸10", "右60", "蒸5"]);
  // 前半の右・左は3本ずつ
  assert.equal(p.steps.filter((s) => s.phase === "前半" && s.side === "右").length, 3);
});

test("合数ごとの後半の本数＝2合4・3合6・4合8・5合10。上書きもできる", () => {
  assert.deepEqual([2, 3, 4, 5].map((g) => buildPlan(g).late), [4, 6, 8, 10]);
  assert.equal(buildPlan(4, 7).late, 7);
  assert.equal(buildPlan(4, 0).late, 8); // おかしな値は目安に戻す
  assert.throws(() => buildPlan(1));
  assert.equal(buildPlan(5).sheets, 6 + 10 + 1);
});

test("経過秒から今の手と残り秒が出る・終わりは done", () => {
  const p = buildPlan(3);
  assert.deepEqual(stepAt(p, 0), { done: false, index: 0, left: 90 });
  assert.deepEqual(stepAt(p, 89.5), { done: false, index: 0, left: 1 });
  assert.equal(stepAt(p, 90).index, 1);
  assert.equal(stepAt(p, 540).index, 6); // 後半の1本目
  assert.equal(p.steps[stepAt(p, 540 + 360).index].kind, "rest");
  assert.equal(stepAt(p, p.totalSec).done, true);
  assert.equal(fmt(90), "1:30");
  assert.match(sayStep(p.steps[1]), /2本目。左の穴/);
  assert.match(sayStep(p.steps[12]), /10分蒸らす/);
});

test("みんなの記録のまとめ: 3件以上で「ちょうど」が最多の本数をおすすめに", () => {
  const L = (go, late, result) => ({ go, late, result });
  const s = summarize([L(4, 8, "やわらかめ"), L(4, 9, "ちょうど"), L(4, 9, "ちょうど"), L(4, 8, "ちょうど"), L(3, 6, "ちょうど"), { go: 9, late: 1, result: "x" }]);
  assert.equal(s.length, 2);
  const g4 = s.find((g) => g.go === 4);
  assert.equal(g4.count, 4);
  assert.equal(g4.recommend, 9);
  assert.equal(s.find((g) => g.go === 3).recommend, null); // 1件ではまだ出さない
  assert.equal(LATE_COUNT[4], 8);
});

test("記録は決まった形だけ通す", () => {
  assert.equal(cleanLog({ go: 3, late: 6, result: "ちょうど", koge: "少し", memo: "a".repeat(300), by: " やま " }).memo.length, 200);
  assert.equal(cleanLog({ go: 3, late: 6, result: "ちょうど", koge: "少し", by: " やま " }).by, "やま");
  assert.equal(cleanLog({ go: 3, late: 6, result: "", koge: "少し" }), null);
  assert.equal(cleanLog({ go: 6, late: 6, result: "ちょうど", koge: "なし" }), null);
});
