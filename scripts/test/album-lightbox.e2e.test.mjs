// フォトアルバムの写真ビューアを合成ユーザー（Playwright・スマホ幅）で操作する。本番Firestoreには触らない（firebase-config.js を偽物に差し替え）
// 2026-10-04 山根さんFB: 「押した写真と違う（右隣の）写真が出る」「スマホで拡大できない・小さく戻せない」「保存ボタンでそのまま保存したい」
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

// 写真ごとに色の違う画像（どれが出ているかをURLで見分ける）
const COLORS = ["c0392b", "27ae60", "2980b9", "8e44ad", "f39c12"];
const PHOTOS = COLORS.map((c, i) => ({ url: `/__img/${c}.svg`, by: `p${i}`, createdAt: `2026-10-04T0${9 - i}:00:00Z` }));
const FAKE = `
window.FIREBASE_READY = true;
window.__photos = ${JSON.stringify(PHOTOS)};
var photoSubs = [];
window.__emitPhotos = function(){ var docs = window.__photos.map(function(p){ return { data: function(){ return p; } }; }); photoSubs.forEach(function(f){ f({ docs: docs }); }); };
function col(name){ return {
  doc: function(){ return { get: async function(){ return { exists: true, data: function(){ return { label: "テスト回", place: "どこか" }; } }; }, collection: col }; },
  orderBy: function(){ return { onSnapshot: function(ok){ if (name === 'photos') { photoSubs.push(ok); window.__emitPhotos(); } else ok({ docs: [] }); }, limit: function(){ return this; } }; },
  add: async function(){} }; }
var db = { collection: col };
var firebase = { firestore: { FieldValue: { serverTimestamp: function(){ return null; } } } };
var sfAuth = { signInAnonymously: async function(){}, currentUser: {} };
var sfStorage = {};`;

function serve() {
  const s = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p === "/firebase-config.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(FAKE); }
    const m = p.match(/^\/__img\/(\w+)\.svg$/);
    if (m) { res.writeHead(200, { "content-type": "image/svg+xml" }); return res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="900"><rect width="1200" height="900" fill="#${m[1]}"/></svg>`); }
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" }[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
}

// 指の操作を TouchEvent で直接送る（ピンチ・ダブルタップ・スワイプ）
const TOUCH = `
window.__touch = function(type, pts){
  var vp = document.getElementById('lbViewport');
  var target = document.elementFromPoint(pts.length ? pts[0][0] : 195, pts.length ? pts[0][1] : 420) || vp;
  var mk = function(p, i){ return new Touch({ identifier: i, target: target, clientX: p[0], clientY: p[1] }); };
  var list = pts.map(mk);
  var ev = new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : list, targetTouches: type === 'touchend' ? [] : list, changedTouches: list });
  target.dispatchEvent(ev);
};
window.__scale = function(){ var t = document.getElementById('lbS1').style.transform || ''; var m = t.match(/scale\\(([\\d.]+)\\)/); return m ? Number(m[1]) : 1; };
window.__shown = function(){ // 画面の真ん中に見えている写真のURL
  var vp = document.getElementById('lbViewport').getBoundingClientRect();
  return ['lbS0','lbS1','lbS2'].map(function(id){ var im = document.getElementById(id); var r = im.getBoundingClientRect(); return { src: im.getAttribute('src') || '', cx: r.left + r.width / 2 }; })
    .filter(function(x){ return x.cx > vp.left && x.cx < vp.right; }).map(function(x){ return x.src.replace(location.origin, ''); });
};`;

async function openPage(browser, server, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, ...opts });
  const page = await ctx.newPage();
  const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  await page.route(/gstatic\.com|fonts\.(googleapis|gstatic)\.com|cdnjs/, (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
  await page.goto(`http://127.0.0.1:${server.address().port}/album.html?a=2026-10-04-e2etest`);
  await page.waitForFunction(() => document.querySelectorAll("#grid figure").length === 5);
  await page.addScriptTag({ content: TOUCH });
  return { page, ctx, errs };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("押した写真がそのまま開く（隣の写真が出ない）・写真が増えても開いている写真がずれない", { skip: !chromium && "playwright なし" }, async () => {
  const server = await serve();
  const browser = await chromium.launch();
  try {
    const { page, errs } = await openPage(browser, server);
    for (const i of [0, 2, 4]) {
      await page.click(`#grid figure:nth-child(${i + 1})`);
      await page.waitForSelector("#lightbox.open");
      assert.deepEqual(await page.evaluate(() => window.__shown()), [PHOTOS[i].url], `${i + 1}枚目を押したら${i + 1}枚目が出る`);
      assert.match(await page.textContent("#lbMeta"), new RegExp(`${i + 1} / 5`));
      await page.click("#lbClose");
    }
    // 開いている間に写真が先頭に1枚増えても、見ている写真は変わらない
    await page.click("#grid figure:nth-child(3)");
    await page.evaluate(() => { window.__photos.unshift({ url: "/__img/111111.svg", by: "new", createdAt: "2026-10-04T10:00:00Z" }); window.__emitPhotos(); });
    await sleep(50);
    assert.deepEqual(await page.evaluate(() => window.__shown()), [PHOTOS[2].url]);
    assert.match(await page.textContent("#lbMeta"), /4 \/ 6/);
    assert.deepEqual(errs, []);
  } finally { await browser.close(); server.close(); }
});

test("スマホ: ダブルタップで拡大→もう一度で戻る／ピンチで拡大・縮小／下スワイプで閉じる／横スワイプで次の写真", { skip: !chromium && "playwright なし" }, async () => {
  const server = await serve();
  const browser = await chromium.launch();
  try {
    const { page, errs } = await openPage(browser, server);
    await page.click("#grid figure:nth-child(2)");
    await page.waitForSelector("#lightbox.open");
    const tap = async (x, y) => { await page.evaluate(([x, y]) => { window.__touch("touchstart", [[x, y]]); window.__touch("touchend", [[x, y]]); }, [x, y]); };

    await tap(195, 420); await sleep(80); await tap(195, 420); await sleep(300);
    assert.ok((await page.evaluate(() => window.__scale())) > 2, "ダブルタップで拡大");
    await tap(195, 420); await sleep(80); await tap(195, 420); await sleep(300);
    assert.equal(await page.evaluate(() => window.__scale()), 1, "もう一度ダブルタップで元に戻る");

    // ピンチで広げる → 拡大
    await page.evaluate(() => { window.__touch("touchstart", [[150, 420], [240, 420]]); for (let k = 1; k <= 5; k++) window.__touch("touchmove", [[150 - k * 20, 420], [240 + k * 20, 420]]); window.__touch("touchend", [[50, 420], [340, 420]]); });
    const big = await page.evaluate(() => window.__scale());
    assert.ok(big > 1.8, `ピンチで拡大（${big}）`);
    // ピンチで縮める → 小さく戻せる（1より小さくしたら等倍に戻る）
    await page.evaluate(() => { window.__touch("touchstart", [[50, 420], [340, 420]]); for (let k = 1; k <= 6; k++) window.__touch("touchmove", [[50 + k * 22, 420], [340 - k * 22, 420]]); window.__touch("touchend", [[182, 420], [208, 420]]); });
    await sleep(300);
    assert.equal(await page.evaluate(() => window.__scale()), 1, "ピンチで縮めると元の大きさに戻る");
    assert.ok(await page.isVisible("#lightbox.open"), "縮めても閉じない");

    // 横スワイプで次の写真
    await page.evaluate(() => { window.__touch("touchstart", [[300, 420]]); for (let k = 1; k <= 6; k++) window.__touch("touchmove", [[300 - k * 30, 422]]); window.__touch("touchend", [[120, 422]]); });
    await sleep(450);
    assert.deepEqual(await page.evaluate(() => window.__shown()), [PHOTOS[2].url]);

    // 下スワイプで閉じる
    await page.evaluate(() => { window.__touch("touchstart", [[195, 300]]); for (let k = 1; k <= 6; k++) window.__touch("touchmove", [[196, 300 + k * 30]]); window.__touch("touchend", [[196, 480]]); });
    await sleep(100);
    assert.ok(!(await page.isVisible("#lightbox.open")), "下スワイプで閉じる");
    assert.deepEqual(errs, []);
  } finally { await browser.close(); server.close(); }
});

test("保存ボタン: Android・パソコンは確認なしでそのままダウンロードされる", { skip: !chromium && "playwright なし" }, async () => {
  const server = await serve();
  const browser = await chromium.launch();
  try {
    const { page, errs } = await openPage(browser, server, { userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Mobile Safari/537.36", acceptDownloads: true });
    await page.click("#grid figure:nth-child(4)");
    await page.waitForSelector("#lightbox.open");
    const [dl] = await Promise.all([page.waitForEvent("download"), page.click("#lbDownload")]);
    assert.equal(dl.suggestedFilename(), "bbq-2026-10-04-004.jpg");
    assert.match(await page.textContent("#lbDownload"), /保存/);
    assert.deepEqual(errs, []);
  } finally { await browser.close(); server.close(); }
});
