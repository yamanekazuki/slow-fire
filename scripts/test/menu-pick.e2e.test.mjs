// メニュー相談を合成ユーザー（Playwright）で操作する。本番Firestoreには触らない（firebase-config.js を偽物に差し替え）
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

const R = JSON.parse(fs.readFileSync(path.join(ROOT, "data/recipes.json"), "utf8")).dishes.map((d) => d.name);
const [F1, F2, F3, A, B] = R;
const FAKE = `
window.__doc = ${JSON.stringify({ title: "20261011 月1BBQ", menuFixed: { [F1]: "", [F2]: "", [F3]: "" }, wants: {}, dishes: [F1, F2, F3] })};
var subs = [];
function snap(){ var d = JSON.parse(JSON.stringify(window.__doc)); return { exists: true, data: function(){ return d; } }; }
function emit(){ subs.forEach(function(f){ setTimeout(function(){ f(snap()); }, 0); }); }
var ref = { onSnapshot: function(ok){ subs.push(ok); ok(snap()); } };
var db = { collection: function(){ return { doc: function(){ return ref; } }; },
  runTransaction: async function(fn){ var ups = []; await fn({ get: async function(){ return snap(); }, update: function(){ ups.push([].slice.call(arguments, 1)); } }); ups.forEach(applyUpdate); emit(); } };
// 本物の update と同じく「(ref, 辞書)」と「(ref, 項目, 値, 項目, 値, ...)」の両方を受ける。項目は FieldPath か「a.b」の文字列
window.firebase = { firestore: { FieldPath: function(){ this.p = [].slice.call(arguments); } } };
function setPath(o, p, v){ for (var i = 0; i < p.length - 1; i++) { o[p[i]] = (o[p[i]] && typeof o[p[i]] === "object") ? o[p[i]] : {}; o = o[p[i]]; } o[p[p.length - 1]] = v; }
function applyUpdate(a){
  if (a.length === 1) { Object.keys(a[0]).forEach(function(k){ setPath(window.__doc, k.split("."), a[0][k]); }); return; }
  for (var i = 0; i < a.length; i += 2) setPath(window.__doc, a[i] && a[i].p ? a[i].p : String(a[i]).split("."), a[i + 1]);
}
var sfAuth = { signInAnonymously: async function(){} };`;

function serve() {
  const s = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    if (p === "/firebase-config.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(FAKE); }
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json" }[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
}

test("確定→やりたい→選択肢: 押すと誰のやりたいか付きで移り、もう一度で戻る・件数がその場で変わる", { skip: !chromium && "playwright なし" }, async () => {
  const server = await serve();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errs = []; page.on("pageerror", (e) => errs.push(e.message));
    await page.route(/gstatic\.com|fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
    await page.goto(`http://127.0.0.1:${server.address().port}/menu-pick.html?l=e2etest123`);
    await page.waitForSelector("h2.sh");
    const sec = (title) => page.evaluate((t) => { const h = [...document.querySelectorAll("h2.sh")].find((x) => x.firstChild.textContent === t); let n = h.nextElementSibling; while (n && !n.classList.contains("grid") && !n.classList.contains("empty")) n = n.nextElementSibling; return n.classList.contains("grid") ? [...n.querySelectorAll("[data-card]")].map((c) => c.dataset.card) : []; }, title);
    const sum = () => page.textContent("#sum");

    assert.deepEqual(await sec("確定（毎回これはやる）"), [F1, F2, F3]);
    assert.deepEqual(await sec("やりたい"), []);
    assert.ok((await sec("選択肢")).includes(A));
    assert.match(await sum(), /確定3品＋やりたい0品｜買い物リストに3品/);

    await page.click('[data-me="やまちゃん"]');
    await page.click(`.btn[data-n="${A}"]`);
    await page.waitForFunction((a) => document.querySelector(`[data-card="${a}"] .btn.on`), A);
    assert.deepEqual(await sec("やりたい"), [A]);
    assert.ok(!(await sec("選択肢")).includes(A));
    // 札は2人分いつも出る（自分／相手・選択済みか未選択か）
    assert.match(await page.textContent(`[data-card="${A}"] .who`), /自分：やまちゃん｜✓ やりたいを選択済み/);
    assert.match(await page.textContent(`[data-card="${A}"] .who`), /相手：うえたく｜未選択/);
    assert.match(await page.textContent("#toast"), /上の確認欄へ反映しました/);
    assert.match(await sum(), /確定3品＋やりたい1品（やまちゃん 1品）｜買い物リストに4品/);
    assert.ok((await page.evaluate(() => window.__doc.dishes)).includes(A), "買い物リストに入る");

    // うえたくに切り替えて同じ料理を押す → 2人とも
    await page.click('[data-me="うえたく"]');
    await page.click(`.btn[data-n="${B}"]`);
    await page.click(`.btn[data-n="${A}"]`);
    await page.waitForFunction((a) => document.querySelectorAll(`[data-card="${a}"] .who span.on`).length === 2, A);
    assert.deepEqual(await sec("やりたい"), [A, B], "2人ともが先");

    // もう一度押すと戻る（Bはうえたくだけ → 選択肢へ・買い物リストからも外れる）
    await page.click(`.btn[data-n="${B}"]`);
    await page.waitForFunction((b) => !document.querySelector(`[data-card="${b}"].want`), B);
    assert.ok((await sec("選択肢")).includes(B));
    assert.match(await page.textContent("#toast"), /今回の「やりたい」から外しました/);
    assert.ok(!(await page.evaluate(() => window.__doc.dishes)).includes(B));
    // 保存後の最新の中身が届くのを待つ（押した直後の表示は手元の仮の中身）
    await page.waitForFunction(() => /買い物リストに4品/.test(document.querySelector("#sum").textContent), null, { timeout: 5000 }).catch(() => {});
    assert.match(await sum(), /確定3品＋やりたい1品（うえたく 1品）｜買い物リストに4品/);
    await page.screenshot({ path: path.join(process.env.TMPDIR || "/tmp", "menu-pick-e2e.png"), fullPage: true });
    assert.deepEqual(errs, []);
  } finally { await browser.close(); server.close(); }
});
