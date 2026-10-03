// メニュー相談の3段（確定→やりたい→選択肢）と「やりたい」の付け外し（本番に触らない）
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const M = createRequire(import.meta.url)(path.join(ROOT, "menu-pick-logic.js"));
const P = ["やまちゃん", "うえたく"];
const D = ["グリル野菜", "サーモン", "丸鶏", "ピザ", "パエリア", "タコス"].map((name) => ({ name }));
const base = () => ({ menuFixed: { グリル野菜: "", サーモン: "", 丸鶏: "" }, wants: {}, dishes: ["グリル野菜", "サーモン", "丸鶏"] });
const names = (l) => l.map((d) => d.name);

test("最初は確定3品が上、残りは全部選択肢", () => {
  const g = M.group(D, base(), P, "やまちゃん");
  assert.deepEqual(names(g.fixed), ["グリル野菜", "サーモン", "丸鶏"]);
  assert.deepEqual(names(g.wanted), []);
  assert.deepEqual(names(g.options), ["ピザ", "パエリア", "タコス"]);
  assert.deepEqual(g.counts, { fixed: 3, want: 0, both: 0, mine: 0, shop: 3 });
});

test("やりたいを押すと、やりたい枠へ移り・誰が押したか付き・買い物リストにも入る", () => {
  let cur = base();
  const t = M.toggle(cur, "やまちゃん", "パエリア");
  assert.equal(t.on, true);
  cur = { ...cur, wants: t.wants, dishes: t.dishes };
  assert.ok(cur.dishes.includes("パエリア"));
  const g = M.group(D, cur, P, "やまちゃん");
  assert.deepEqual(names(g.wanted), ["パエリア"]);
  assert.deepEqual(g.st("パエリア").who, ["やまちゃん"]);
  assert.deepEqual(names(g.options), ["ピザ", "タコス"]);
  assert.deepEqual(g.counts, { fixed: 3, want: 1, both: 0, mine: 1, shop: 4 });
});

test("もう一度押すと選択肢に戻り、買い物リストからも外れる", () => {
  let cur = base();
  let t = M.toggle(cur, "やまちゃん", "ピザ"); cur = { ...cur, wants: t.wants, dishes: t.dishes };
  t = M.toggle(cur, "やまちゃん", "ピザ"); cur = { ...cur, wants: t.wants, dishes: t.dishes };
  assert.equal(t.on, false);
  assert.ok(!cur.dishes.includes("ピザ"));
  const g = M.group(D, cur, P, "やまちゃん");
  assert.deepEqual(names(g.options), ["ピザ", "パエリア", "タコス"]);
  assert.equal(g.counts.want, 0);
});

test("相手もやりたい料理は、自分が外してもやりたい枠と買い物リストに残る", () => {
  let cur = base();
  for (const [who, n] of [["やまちゃん", "タコス"], ["うえたく", "タコス"], ["うえたく", "ピザ"]]) {
    const t = M.toggle(cur, who, n); cur = { ...cur, wants: t.wants, dishes: t.dishes };
  }
  let g = M.group(D, cur, P, "やまちゃん");
  assert.deepEqual(names(g.wanted), ["タコス", "ピザ"], "2人ともが先");
  assert.deepEqual(g.counts, { fixed: 3, want: 2, both: 1, mine: 1, shop: 5 });
  const t = M.toggle(cur, "やまちゃん", "タコス"); cur = { ...cur, wants: t.wants, dishes: t.dishes };
  assert.ok(cur.dishes.includes("タコス"));
  g = M.group(D, cur, P, "やまちゃん");
  assert.deepEqual(g.st("タコス").who, ["うえたく"]);
  assert.equal(g.counts.mine, 0);
});

test("確定の料理は買い物リストから抜けない（抜けていたら戻す）", () => {
  const cur = { ...base(), dishes: ["グリル野菜"] };
  const t = M.toggle(cur, "うえたく", "ピザ");
  for (const n of ["グリル野菜", "サーモン", "丸鶏", "ピザ"]) assert.ok(t.dishes.includes(n), n);
});

test("買い物リスト側で足した料理は、やりたいの付け外しで消さない", () => {
  const cur = { ...base(), dishes: [...base().dishes, "パエリア"] };
  const t = M.toggle(cur, "うえたく", "ピザ");
  assert.ok(t.dishes.includes("パエリア"));
  assert.equal(M.group(D, { ...cur, ...t }, P, "うえたく").counts.shop, 5, "確定3＋ピザ＋パエリア");
});
