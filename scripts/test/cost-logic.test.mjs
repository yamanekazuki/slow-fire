// 食材の見積もり（cost.html）の計算。台帳とメニューは本物のJSONを読むだけ（本番に触らない）
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const C = createRequire(import.meta.url)(path.join(ROOT, "cost-logic.js"));
const L = JSON.parse(fs.readFileSync(path.join(ROOT, "data/price-ledger.json"), "utf8"));
const S = JSON.parse(fs.readFileSync(path.join(ROOT, "data/shopping-items.json"), "utf8"));
const line = (r, name) => r.lines.find((l) => l.name === name);

test("分量の読み取り（範囲は小さい方・kgはg・適量は読まない）", () => {
  assert.deepEqual(C.parseQty("3個"), { n: 3, unit: "個" });
  assert.deepEqual(C.parseQty("800g〜1kg"), { n: 800, unit: "g" });
  assert.deepEqual(C.parseQty("1.5kg"), { n: 1500, unit: "g" });
  assert.deepEqual(C.parseQty("10〜12尾"), { n: 10, unit: "尾" });
  assert.equal(C.parseQty("適量"), null);
  assert.equal(C.parseQty("各1"), null);
});

test("サーモン: 5〜8人はロピア500g1パック＝2,000円、いつもの店(コストコ)は約1kgで7,000円", () => {
  for (const n of [5, 6, 8]) {
    assert.equal(line(C.estimate(L, S, ["杉板サーモン"], n, "lopia"), "アトランティックサーモン").cost, 2000);
    assert.equal(line(C.estimate(L, S, ["杉板サーモン"], n, "usual"), "アトランティックサーモン").cost, 7000);
  }
  assert.equal(line(C.estimate(L, S, ["杉板サーモン"], 12, "lopia"), "アトランティックサーモン").cost, 4000);
});

test("丸鶏: いつもの=ハナマサ980円(入荷不安定の印つき)・ロピア中心=1,250円", () => {
  const u = line(C.estimate(L, S, ["丸鶏（ビアカン／インジェクション）"], 6, "usual"), "丸鶏");
  assert.equal(u.cost, 980); assert.equal(u.store, "hanamasa"); assert.equal(u.stock, "不安定");
  assert.equal(line(C.estimate(L, S, ["丸鶏（ビアカン／インジェクション）"], 6, "lopia"), "丸鶏").cost, 1250);
});

test("人数で比例・個数は切り上げ（パプリカ3個は8人基準→4人で2個）", () => {
  assert.equal(line(C.estimate(L, S, ["グリル野菜"], 4, "usual"), "パプリカ").cost, 2 * 258);
  assert.equal(line(C.estimate(L, S, ["グリル野菜"], 8, "lopia"), "パプリカ").cost, 3 * 175);
});

test("ロピアに値段がない食材はいつもの店で数える・どこにも無ければ合計から外して一覧へ", () => {
  const r = C.estimate(L, S, ["ソーセージ", "プルドポーク"], 8, "lopia");
  assert.equal(line(r, "ソーセージ").store, "super");
  assert.equal(line(r, "ソーセージ").cost, 1000);
  assert.ok(r.missing.some((m) => m.name === "豚肩ロース（大）"));
  assert.ok(!r.lines.some((l) => l.name === "豚肩ロース（大）"));
});

test("持参の物は買わない（合計に入れない）・共通のオリーブオイルは毎回入る", () => {
  const r = C.estimate(L, S, ["ご飯"], 8, "usual");
  assert.ok(r.bring.some((b) => b.name === "米"));
  assert.equal(line(r, "オリーブオイル").cost, 1080);
  assert.equal(r.total, 1080);
});

test("スペアリブ1.5kg(8人): 東急450円/100g=6,750円・ロピア400円/100g=6,000円（10/10実測）", () => {
  assert.equal(line(C.estimate(L, S, ["スペアリブ＋パイナップル"], 8, "usual"), "スペアリブ").cost, 6750);
  assert.equal(line(C.estimate(L, S, ["スペアリブ＋パイナップル"], 8, "lopia"), "スペアリブ").cost, 6000);
});

test("定番セットはロピア中心の方が安い", () => {
  const set = S.templates["定番セット"];
  const u = C.estimate(L, S, set, 6, "usual"), l = C.estimate(L, S, set, 6, "lopia");
  assert.ok(l.total < u.total, `${l.total} < ${u.total}`);
});

test("店くらべ: 大きい一枚のサーモン6人分は安い順にロピアが先頭（小さい切り身は別扱い）", () => {
  const c = C.compareItem(L, "サーモン", 6).filter((x) => !x.p.small);
  assert.equal(c[0].store, "lopia");
  assert.equal(c.find((x) => x.store === "lopia").unitPrice, 400);
});

test("台帳の値段はすべて店・単位・出どころ・日付がそろっている", () => {
  const ids = new Set(L.stores.map((s) => s.id));
  for (const p of L.prices) {
    assert.ok(ids.has(p.store), p.item + " " + p.store);
    assert.ok(p.price > 0 && p.size > 0 && p.unit, p.item);
    assert.ok(["実測", "相場", "仮"].includes(p.src), p.item);
    assert.match(p.date, /^\d{4}-\d{2}-\d{2}$/);
  }
});
