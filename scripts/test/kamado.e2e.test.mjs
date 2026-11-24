// 魔法のかまどタイマーを合成ユーザー（Playwright・スマホ幅）で操作する。本番Firestoreには触らない（firebase-config.js を偽物に差し替え）
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

const FAKE = `
window.FIREBASE_READY = true;
window.__added = [];
var subs = [];
var db = { collection: function(){ return {
  orderBy: function(){ return { limit: function(){ return { onSnapshot: function(ok){ subs.push(ok); ok({ docs: [] }); } }; } }; },
  add: async function(d){ window.__added.push(d); var docs = window.__added.map(function(x){ return { data: function(){ return x; } }; }); subs.forEach(function(f){ f({ docs: docs }); }); } }; } };
window.db = db;
var firebase = { firestore: { FieldValue: { serverTimestamp: function(){ return null; } } } };
var sfAuth = { signInAnonymously: async function(){} };`;

function serve() {
  const s = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p === "/firebase-config.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(FAKE); }
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript" }[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
}

test("合数を選ぶ→本数が変わる→スタートで右→時間で左へ→最後まで進むと記録欄へ→記録が表に出る", { skip: !chromium && "playwright なし" }, async () => {
  const server = await serve();
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const errs = []; page.on("pageerror", (e) => errs.push(e.message));
    await page.route(/gstatic\.com|fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
    await page.clock.install();
    await page.goto(`http://127.0.0.1:${server.address().port}/kamado.html`);
    await page.waitForSelector("#goChips .chip");
    // 横にはみ出さない
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    assert.match(await page.textContent("#nSheets"), /13本/); // 3合
    await page.click('#goChips .chip[data-v="5"]');
    assert.match(await page.textContent("#nSheets"), /17本/);
    assert.equal(await page.textContent("#lateVal"), "10");
    await page.click('#goChips .chip[data-v="3"]');
    await page.click("#latePlus");
    assert.match(await page.textContent("#lateHint"), /目安は6本（今回は7本/);
    await page.click("#lateMinus");

    await page.click("#startBtn");
    assert.ok(await page.isVisible("#run"));
    assert.equal(await page.textContent("#rSide"), "右");
    assert.equal(await page.textContent("#rCd"), "1:30");
    await page.clock.runFor(91_000);
    assert.equal(await page.textContent("#rSide"), "左");
    assert.match(await page.textContent("#rPhase"), /2本目/);
    // 一時停止中は進まない
    await page.click("#rPause");
    const cd = await page.textContent("#rCd");
    await page.clock.runFor(30_000);
    assert.equal(await page.textContent("#rCd"), cd);
    await page.click("#rPause");
    // 読み直しても続きから
    await page.reload();
    await page.waitForSelector("#run.on");
    assert.match(await page.textContent("#rPhase"), /2本目/);
    // 「次へ」で手を進められる
    await page.click("#rFwd");
    assert.match(await page.textContent("#rPhase"), /3本目/);
    // 最後まで
    await page.clock.runFor(40 * 60_000);
    assert.ok(!(await page.isVisible("#run")));
    assert.equal(await page.textContent("#logLate"), "6");
    await page.click('#logResult .chip[data-v="ちょうど"]');
    await page.click('#logKoge .chip[data-v="少し"]');
    await page.fill("#logBy", "てすと");
    await page.click("#logSave");
    await page.waitForSelector("#logOk:not([hidden])");
    const added = await page.evaluate(() => window.__added);
    assert.deepEqual({ ...added[0], createdAt: undefined }, { go: 3, late: 6, result: "ちょうど", koge: "少し", memo: "", by: "てすと", createdAt: undefined });
    assert.match(await page.textContent("#stats"), /3合（記録1件）/);
    assert.deepEqual(errs, []);
  } finally { await browser.close(); server.close(); }
});
