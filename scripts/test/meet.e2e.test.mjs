// 日程調整ページを合成ユーザー（Playwright・スマホ幅）で操作する。本番に触らない（firebase-config.js を偽物に差し替え）
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
let chromium = null;
try { ({ chromium } = createRequire(path.join(process.env.HOME, "dev/tools/ux-patrol/"))("playwright")); } catch {}

const rows = [
  { id: "s1", day: "2026-10-13", label: "10/13(火) 11:00〜12:00" },
  { id: "s2", day: "2026-10-13", label: "10/13(火) 16:00〜17:00" },
  { id: "s3", day: "2026-10-14", label: "10/14(水) 13:00〜14:00" },
];
const DATA = {
  title: "あんBBQ定例", note: "10/15(水)12:00の回を動かします", durationMin: 60, winStart: "11:00", winEnd: "17:00", status: "open", fixed: null,
  members: [{ key: "uetaku", name: "うえたく" }, { key: "anri", name: "あんちゃん" }, { key: "yoshi", name: "ヨッシー" }],
  owner: { key: "yamane", name: "やまちゃん" },
  rows: rows.map((r) => ({ ...r, okBy: [], okCount: 1, allOk: false })),
  answers: { uetaku: { ok: ["s2", "s3"], updatedAt: "x" }, anri: { ok: ["s2"], updatedAt: "x" } },
  memberBusy: { yoshi: ["s3"] }, calendars: { yoshi: { ok: true } },
};
const FAKE = (isAdmin, data) => `
window.__calls = [];
var sfFunctions = { httpsCallable: function(name){ return function(p){
  window.__calls.push({ name: name, p: p });
  if (name === 'meetPollGet') { var d = JSON.parse(JSON.stringify(window.__data)); d.isAdmin = ${isAdmin}; return Promise.resolve({ data: d }); }
  if (name === 'meetPollFix') { window.__data.status = 'fixed'; window.__data.fixed = { label: '10/13(火) 16:00〜17:00', meetUrl: 'https://meet.google.com/abc-defg-hij' }; return Promise.resolve({ data: {} }); }
  return Promise.resolve({ data: {} });
}; } };
window.__data = ${JSON.stringify(data)};`;

function serve(isAdmin, data) {
  const s = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p === "/firebase-config.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(FAKE(isAdmin, data)); }
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": { ".html": "text/html; charset=utf-8", ".js": "text/javascript" }[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
}
async function open(isAdmin, q = "p=testpoll1234", data = DATA) {
  const server = await serve(isAdmin, data);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  await page.route(/gstatic\.com|fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
  await page.goto(`http://127.0.0.1:${server.address().port}/meet.html?${q}`);
  await page.waitForSelector("#app h1, #app .error", { timeout: 8000 });
  return { page, errs, close: async () => { await browser.close(); server.close(); } };
}

test("ヨッシーが開く: カレンダーの空きで自動で○→保存・1枠タップで全員OKが出る", { skip: !chromium && "playwright なし" }, async () => {
  const { page, errs, close } = await open(false);
  try {
    assert.match(await page.textContent(".lead"), /11:00〜17:00/);
    assert.match(await page.textContent("#top"), /あと1人/); // s2 はうえたく・あんちゃんが○
    await page.click('[data-me="yoshi"]');
    // つないだカレンダーで s3 は予定あり → s1, s2 に自動で○
    await page.waitForFunction(() => window.__calls.some((c) => c.name === "meetPollAnswer"));
    const saved = await page.evaluate(() => window.__calls.filter((c) => c.name === "meetPollAnswer").at(-1).p);
    assert.deepEqual(saved, { id: "testpoll1234", member: "yoshi", ok: ["s1", "s2"] });
    assert.match(await page.textContent('[data-row="s3"]'), /予定あり/);
    assert.match(await page.textContent("#top"), /全員OKの枠/);
    assert.match(await page.textContent("#top"), /16:00〜17:00/);
    assert.equal(await page.$("#top .fix"), null); // メンバーには確定ボタンを出さない
    // 外すと全員OKが消える
    await page.click('#app .day [data-tg="s2"]');
    await page.waitForFunction(() => window.__calls.filter((c) => c.name === "meetPollAnswer").at(-1).p.ok.join() === "s1");
    assert.doesNotMatch(await page.textContent("#top"), /全員OKの枠/);
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(w <= 390, `横にはみ出している: ${w}px`);
    assert.deepEqual(errs, []);
  } finally { await close(); }
});

test("やまちゃん用URL: 全員OKの枠に確定ボタン→押すと決まった画面とMeetのボタン", { skip: !chromium && "playwright なし" }, async () => {
  const data = JSON.parse(JSON.stringify(DATA));
  data.answers.yoshi = { ok: ["s2"], updatedAt: "x" };
  const { page, errs, close } = await open(true, "p=testpoll1234&k=secretkey", data);
  try {
    assert.match(await page.textContent("#app"), /やまちゃん用の画面/);
    assert.equal(await page.$("[data-me]"), null); // 名前選びは出さない
    // 同じブラウザで前にメンバーとして名前を選んでいても、やまちゃん用では回答ボタンを出さず保存もしない
    await page.evaluate(() => localStorage.setItem("bbqMeetMe", "yoshi"));
    await page.reload(); await page.waitForSelector("#top");
    assert.equal(await page.$("[data-tg]"), null);
    assert.ok(!(await page.evaluate(() => window.__calls.some((c) => c.name === "meetPollAnswer"))));
    assert.match(await page.textContent("#top"), /全員OKの枠/);
    page.on("dialog", (d) => d.accept());
    await page.click('#top [data-fix="s2"]');
    await page.waitForSelector(".done-card");
    const fix = await page.evaluate(() => window.__calls.find((c) => c.name === "meetPollFix").p);
    assert.deepEqual(fix, { id: "testpoll1234", k: "secretkey", slot: "s2" });
    assert.match(await page.textContent(".done-card"), /10\/13\(火\) 16:00〜17:00/);
    assert.equal(await page.getAttribute(".done-card a", "href"), "https://meet.google.com/abc-defg-hij");
    assert.deepEqual(errs, []);
  } finally { await close(); }
});

test("URLが切れている: 案内を出して止まる", { skip: !chromium && "playwright なし" }, async () => {
  const { page, close } = await open(false, "");
  try { assert.match(await page.textContent("#app"), /URLが途中で切れています/); } finally { await close(); }
});
