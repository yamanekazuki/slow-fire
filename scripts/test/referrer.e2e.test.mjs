// 紹介者: 月1BBQ申込フォームで紹介者を送れること／管理画面の申込表・メンバー表に紹介者が出ること
// 合成ユーザー（Playwright）で操作する。本番Firestore・Functionsには触らない（firebase を偽物に差し替え）
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

const ADMIN_DATA = {
  regs: [
    { eventId: "2026-11-22", name: "申込で紹介者あり", email: "a@example.com", party: 1, referrer: "うえたく", note: "", createdAt: "2026-10-20T01:00:00Z" },
    { eventId: "2026-11-22", name: "入会時に紹介者あり", email: "B@Example.com", party: 2, note: "", createdAt: "2026-10-19T01:00:00Z" },
    { eventId: "2026-11-22", name: "紹介者なし", email: "c@example.com", party: 1, note: "はじめて", createdAt: "2026-10-18T01:00:00Z" },
  ],
  members: [
    { name: "入会時に紹介者あり", email: "b@example.com", role: "fan", referrer: "あんちゃん", createdAt: "2026-09-01T01:00:00Z" },
    { name: "紹介者なしメンバー", email: "d@example.com", role: "fan", createdAt: "2026-09-02T01:00:00Z" },
  ],
  stats: [{ id: "2026-11-22", capacity: 15 }], albums: [], lectureRegs: [], menuPicks: [],
};

// gstatic の最初のSDK読込で偽の firebase を置く（他のSDKは空）
const FAKE_SDK = `
if (!window.firebase) {
  window.__added = [];
  var fakeDb = {
    collection: function(n){ return { add: function(d){ window.__added.push([n, d]); return Promise.resolve(); } }; },
    doc: function(){ return { onSnapshot: function(){} }; }
  };
  window.firebase = {
    apps: [], initializeApp: function(){ return {}; },
    app: function(){ return { functions: function(){ return { httpsCallable: function(name){ return function(){ return Promise.resolve({ data: name === 'adminList' ? ${JSON.stringify(ADMIN_DATA)} : {} }); }; } }; } }; },
    firestore: Object.assign(function(){ return fakeDb; }, { FieldValue: { serverTimestamp: function(){ return 'TS'; } } }),
    auth: function(){ return { signInAnonymously: function(){ return Promise.resolve(); }, onAuthStateChanged: function(){} }; },
    functions: function(){ return {}; }, storage: function(){ return {}; }
  };
}`;
const FAKE_CONFIG = `window.db = firebase.firestore();`;

function serve() {
  const s = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p === "/firebase-config.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(FAKE_CONFIG); }
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json", ".css": "text/css" }[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
}

async function openPage(browser, server, url) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  await page.route(/gstatic\.com\/firebasejs/, (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: FAKE_SDK }));
  await page.route(/googletagmanager|fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
  await page.goto(`http://127.0.0.1:${server.address().port}${url}`);
  return { page, errs };
}

test("申込フォーム: 紹介者を選んで送ると referrer が保存される／その他は名前入りで送られる", { skip: !chromium && "playwright なし" }, async () => {
  const server = await serve();
  const browser = await chromium.launch();
  try {
    const { page, errs } = await openPage(browser, server, "/event.html");
    const form = page.locator("#eventRegForm");
    await form.locator("[name=name]").fill("テスト太郎");
    await form.locator("[name=email]").fill("t@example.com");
    assert.equal(await page.isVisible("#eventReferrerOtherWrap"), false);
    await page.selectOption("#eventReferrer", "その他");
    assert.equal(await page.isVisible("#eventReferrerOtherWrap"), true, "その他を選ぶと名前欄が出る");
    await form.locator("[name=referrerOther]").fill("田中さん");
    await form.locator("button[type=submit]").click();
    await page.waitForFunction(() => window.__added.length > 0);
    const [col, data] = (await page.evaluate(() => window.__added))[0];
    assert.equal(col, "event_regs");
    assert.equal(data.referrer, "その他: 田中さん");
    assert.deepEqual(errs, []);
  } finally { await browser.close(); server.close(); }
});

test("申込フォーム: 紹介者を選ばないと送れない", { skip: !chromium && "playwright なし" }, async () => {
  const server = await serve();
  const browser = await chromium.launch();
  try {
    const { page } = await openPage(browser, server, "/event.html");
    const form = page.locator("#eventRegForm");
    await form.locator("[name=name]").fill("テスト太郎");
    await form.locator("[name=email]").fill("t@example.com");
    await form.locator("button[type=submit]").click();
    await page.waitForTimeout(300);
    assert.equal((await page.evaluate(() => window.__added)).length, 0);
  } finally { await browser.close(); server.close(); }
});

test("管理画面: 申込表とメンバー表に紹介者列が出る（申込の記入→入会時の記入→—の順）", { skip: !chromium && "playwright なし" }, async () => {
  const server = await serve();
  const browser = await chromium.launch();
  try {
    const { page, errs } = await openPage(browser, server, "/admin.html");
    await page.fill("#passcode", "x");
    await page.click("#loginBtn");
    await page.waitForSelector("#events table");
    const cell = (table, rowName) => page.evaluate(([t, n]) => {
      const tbl = document.querySelector(t);
      const idx = [...tbl.querySelectorAll("thead th")].findIndex((th) => th.textContent === "紹介者");
      if (idx < 0) return null;
      const tr = [...tbl.querySelectorAll("tbody tr")].find((r) => r.children[1].textContent === n);
      return tr.children[idx].textContent;
    }, [table, rowName]);
    assert.equal(await cell("#events table", "申込で紹介者あり"), "うえたく");
    assert.equal(await cell("#events table", "入会時に紹介者あり"), "あんちゃん入会時の記入");
    assert.equal(await cell("#events table", "紹介者なし"), "—");
    assert.equal(await cell("#membersTable", "入会時に紹介者あり"), "あんちゃん");
    assert.equal(await cell("#membersTable", "紹介者なしメンバー"), "—");
    assert.deepEqual(errs, []);
  } finally { await browser.close(); server.close(); }
});
