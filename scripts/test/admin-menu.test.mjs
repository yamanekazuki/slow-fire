// 管理ページからメニュー相談＋買い物リストを作る（本番に触らない）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const req = createRequire(import.meta.url);
const M = req(path.join(ROOT, "admin-menu.js"));
const core = req(path.join(ROOT, "functions/menu-pick-core.js"));
const recipes = JSON.parse(fs.readFileSync(path.join(ROOT, "data/recipes.json"), "utf8"));
const events = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/guest-guide/events.json"), "utf8"));

test("開催日の初期値は今日（JST）以降でいちばん近い回", () => {
  const now = new Date("2026-10-01T16:00:00Z"); // JST 10/2 01:00
  assert.equal(M.nextEventId(["2026-10-01", "2026-12-13", "2026-11-22", "lec-x"], now), "2026-11-22");
  assert.equal(M.nextEventId(["2026-10-02"], now), "2026-10-02");
  assert.equal(M.nextEventId([], now), "");
});

test("定番の確定料理はレシピに実在し、最初からチェックされ、メモも引き継ぐ", () => {
  const names = recipes.dishes.map((d) => d.name);
  const defaults = events.defaults.menuFixed;
  for (const n of Object.keys(defaults)) assert.ok(names.includes(n), `${n} がレシピに無い`);
  const html = M.dishChecksHtml(names, defaults);
  assert.equal((html.match(/ checked/g) || []).length, Object.keys(defaults).length);
  const fixed = M.buildFixed(["杉板サーモン", "ピザ"], defaults);
  assert.deepEqual(fixed, { "杉板サーモン": defaults["杉板サーモン"], "ピザ": "" });
});

test("作った回の一覧は新しい順で、メニュー相談と買い物リストのURLが出る", () => {
  const html = M.picksRowsHtml([{ id: "2026-11-22", shoplist: "abc123def" }, { id: "2026-12-13", shoplist: "zzz999" }]);
  assert.ok(html.indexOf("12/13") < html.indexOf("11/22"));
  assert.match(html, /menu-pick\.html\?l=abc123def/);
  assert.match(html, /shopping\.html\?l=abc123def/);
  assert.match(html, /<td class="num">12\/13\(日\)<\/td>/);
  assert.match(html, /<td><a class="mail"[^>]+>メニュー相談 ↗<\/a><span class="hist-sep"> \/ <\/span><a class="mail"[^>]+>買い物リスト ↗<\/a>/);
  assert.match(M.jpDate("2026-11-22"), /11\/22\(日\)/);
});

test("入力の検査: 開催日の形式・料理は12品まで・長さを切る", () => {
  assert.throws(() => core.normalizeMenuPickInput({ eventId: "11/22" }), /開催日/);
  const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => ["料理" + i, ""]));
  const r = core.normalizeMenuPickInput({ eventId: "2026-11-22", fixed: { ...many, ["x".repeat(100)]: "y".repeat(100) } });
  assert.equal(Object.keys(r.fixed).length, 12);
  assert.equal(r.shortTitle, "月1BBQ");
});

test("作る買い物リストは mini の便と同じ形（menu-pick の見出しの形・2人・確定料理が dishes に入る）", () => {
  const doc = core.shoplistDoc({ eventId: "2026-11-22", fixed: { "グリル野菜": "" }, shortTitle: "月1BBQ" }, "2026-10-01T00:00:00.000Z");
  assert.equal(doc.title, "20261122 月1BBQ");
  assert.deepEqual(doc.owners, ["やまちゃん", "うえたく"]);
  assert.deepEqual(doc.dishes, ["グリル野菜"]);
  assert.deepEqual(doc.menuFixed, { "グリル野菜": "" });
  assert.deepEqual(doc.wants, {});
  assert.equal(doc.menuPickEventId, "2026-11-22");
  assert.deepEqual(doc.wantsByEvent, { "2026-11-22": {} });
  assert.match(core.menuPickUrls("abc").pickUrl, /^https:\/\/yoron-bbq\.com\/menu-pick\.html\?l=abc$/);
});

test("やりたいは開催回ごとに読み分け、別回の前回値を当回の双方賛成にしない", () => {
  const data = {
    menuPickEventId: "2026-11-22",
    wants: { "やまちゃん": ["丸鶏"], "うえたく": ["丸鶏"] },
    wantsByEvent: {
      "2026-11-22": { "やまちゃん": ["丸鶏"], "うえたく": [] },
      "2026-10-04": { "やまちゃん": ["ピザ"], "うえたく": ["ピザ"] },
    },
  };
  assert.deepEqual(core.currentWantsForEvent(data, "2026-11-22"), { "やまちゃん": ["丸鶏"], "うえたく": [] });
  assert.deepEqual(core.currentWantsForEvent(data, "2026-12-13"), { "やまちゃん": [], "うえたく": [] });
});

test("イベント未紐づけの旧wantsは当回投票にせず、出所未確認として残す", () => {
  const legacy = { wants: { "やまちゃん": ["ピザ"], "うえたく": ["ピザ"] } };
  assert.deepEqual(core.currentWantsForEvent(legacy, "2026-11-22"), { "やまちゃん": [], "うえたく": [] });
  assert.deepEqual(core.legacyUnscopedWants(legacy, "2026-11-22"), { "やまちゃん": ["ピザ"], "うえたく": ["ピザ"] });
});

test("2クライアントの参加者別保存は相手と別イベントの値を消さない", () => {
  const base = {
    wants: { "やまちゃん": ["旧ピザ"], "うえたく": ["旧ピザ"] },
    wantsByEvent: {
      "2026-10-04": { "やまちゃん": ["ピザ"], "うえたく": ["ピザ"] },
      "2026-11-22": { "うえたく": ["丸鶏"] },
    },
  };
  const afterA = core.withParticipantWants(base, "2026-11-22", "やまちゃん", ["杉板サーモン"]);
  const afterB = core.withParticipantWants(afterA, "2026-11-22", "うえたく", ["丸鶏", "グリル野菜"]);
  assert.deepEqual(afterB.wants, base.wants);
  assert.deepEqual(afterB.wantsByEvent["2026-10-04"], base.wantsByEvent["2026-10-04"]);
  assert.deepEqual(afterB.wantsByEvent["2026-11-22"], {
    "やまちゃん": ["杉板サーモン"],
    "うえたく": ["丸鶏", "グリル野菜"],
  });
});

test("Functions: パスコード確認・同じ回は作り直さない・adminList が menu_picks を返す", () => {
  const fn = fs.readFileSync(path.join(ROOT, "functions/index.js"), "utf8");
  const body = fn.slice(fn.indexOf("exports.adminCreateMenuPick"), fn.indexOf("// ---- 管理画面API"));
  assert.match(body, /timingSafeEqual/);
  assert.match(body, /runTransaction/);
  assert.match(body, /cur\.exists && cur\.data\(\)\.shoplist/);
  assert.match(fn, /collection\('menu_picks'\)\.get\(\)/);
  assert.match(fn, /menuPicks: menuPicks\.docs/);
});

test("mini の便は管理ページで作った回を先に見る（二重に作らない）", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts/guest-guide-loop.mjs"), "utf8");
  const ens = src.slice(src.indexOf("async function ensureShoplist"), src.indexOf("async function menuConsult"));
  assert.ok(ens.indexOf("menu_picks/${id}") > 0 && ens.indexOf("menu_picks/${id}") < ens.indexOf("method: \"POST\""), "作る前に menu_picks を見る");
  assert.match(ens, /menu_picks\?documentId=\$\{id\}/);
});

test("admin.html は買い物リスト作成をCTA＋履歴＋同画面作成パネルに統合する", () => {
  const admin = fs.readFileSync(path.join(ROOT, "admin.html"), "utf8");
  assert.match(admin, /<script src="admin-menu\.js"><\/script>/);
  assert.match(admin, /httpsCallable\('adminCreateMenuPick'\)/);
  assert.match(admin, /id="mpHome"/);
  assert.match(admin, /id="mpOpenCreate"/);
  assert.match(admin, /id="mpCreatePanel" hidden/);
  assert.match(admin, /id="mpBackBtn"/);
  assert.match(admin, /id="menuPicksTable"/);
  assert.match(admin, /<thead><tr><th>日付<\/th><th>開く<\/th><\/tr><\/thead>/);
  assert.match(admin, /まだ作った回はありません。上の「新しく作る」/);
  assert.match(admin, /function openMenuCreate\(\)/);
  assert.match(admin, /function closeMenuCreate\(\)/);
  assert.match(admin, /mpCreateBtn'\)\.addEventListener\('click'/);
  assert.match(admin, /btn\.disabled=true; btn\.textContent='作成中…'/);
  assert.match(admin, /作成に失敗しました/);
  assert.match(admin, /@media \(max-width:640px\)[\s\S]*\.mp-home button/);
  // URLコピーのボタン付けより前に一覧を描く
  assert.ok(admin.indexOf("AdminMenu.picksRowsHtml") < admin.indexOf("querySelectorAll('.copy-album')"));
});
