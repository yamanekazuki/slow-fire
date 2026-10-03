// メニュー相談と買い物リストの見分け（本番に触らない）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const S = createRequire(import.meta.url)(path.join(ROOT, "bbq-steps.js"));

test("題名は曜日つきの日付にそろえる", () => {
  assert.equal(S.dateTitle("20261122 月1BBQ"), "11/22(日) 月1BBQ");
  assert.equal(S.dateTitle("20261004 月1BBQ"), "10/4(日) 月1BBQ");
  assert.equal(S.dateTitle("木場公園 OB/OG会"), "木場公園 OB/OG会");
});

test("段階表示: 今のページは塗り、もう一方は同じ回へのリンク", () => {
  const shop = S.html("abc123", "shop");
  assert.match(shop, /<a href="menu-pick\.html\?l=abc123"><b>① メニューを決める →/);
  assert.match(shop, /class="now" aria-current="page"><b>② 買い物リスト/);
  const menu = S.html("abc123", "menu");
  assert.match(menu, /<a href="shopping\.html\?l=abc123"><b>② 買い物リスト →/);
  assert.match(menu, /class="now" aria-current="page"><b>① メニューを決める/);
});

test("メニュー相談つきの回だけ段階表示を出す", () => {
  assert.equal(S.hasMenu({ menuFixed: {} }), true);
  assert.equal(S.hasMenu({ wants: {} }), true);
  assert.equal(S.hasMenu({ title: "OB会", dishes: [] }), false);
});

test("両ページが部品を読み込み、題名をそろえて使う", () => {
  const shop = fs.readFileSync(path.join(ROOT, "shopping.html"), "utf8");
  const pick = fs.readFileSync(path.join(ROOT, "menu-pick.html"), "utf8");
  for (const h of [shop, pick]) assert.match(h, /<script src="bbq-steps\.js"><\/script>/);
  assert.match(shop, /BbqSteps\.html\(listId,'shop'\)/);
  assert.match(shop, /' の買い物リスト'/);
  assert.match(shop, /\$\('#dishWrap'\)\.open=false/);
  assert.match(pick, /BbqSteps\.html\(id,'menu'\)/);
  assert.match(pick, /BbqSteps\.dateTitle\(data\.title\)\)\} のメニュー相談/);
});

test("メニュー相談UIは選択状態と保存状態を文字で区別する", () => {
  const pick = fs.readFileSync(path.join(ROOT, "menu-pick.html"), "utf8");
  assert.match(pick, /id="summary"/);
  assert.match(pick, /未選択：やりたいにする/);
  assert.match(pick, /✓ やりたいを選択済み/);
  assert.match(pick, /保存中…/);
  assert.match(pick, /保存しました/);
  assert.match(pick, /aria-pressed/);
  assert.match(pick, /scrollIntoView/);
  assert.match(pick, /出所未確認/);
  assert.doesNotMatch(pick, /tx\.update\(ref,\{ wants,/);
  assert.match(pick, /new firebase\.firestore\.FieldPath\('wantsByEvent', key, me\)/);
  assert.doesNotMatch(pick, /tx\.update\(ref,\{ wantsByEvent,/);
  assert.match(pick, /if\(!me\|\|busy\) return; busy=true/);
  assert.match(pick, /const before=JSON\.parse\(JSON\.stringify\(data\|\|\{\}\)\)/);
  assert.match(pick, /data=before/);
});
