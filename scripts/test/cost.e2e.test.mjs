// 食材の見積もり（cost.html）を合成ユーザー（Playwright）で操作する。外部通信なし・ローカル配信のみ
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

function serve() {
  const s = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json" }[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
}
const num = (t) => Number(String(t).replace(/[^\d]/g, ""));

test("料理と人数を変えると2つの合計がその場で変わり、横スクロールが出ない", { skip: !chromium && "playwright なし" }, async () => {
  const server = await serve();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    const errs = []; page.on("pageerror", (e) => errs.push(e.message));
    await page.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, body: "" }));
    await page.goto(`http://127.0.0.1:${server.address().port}/cost.html`);
    await page.waitForFunction(() => /円/.test(document.querySelector("#yUsual").textContent));
    const u0 = num(await page.textContent("#yUsual")), l0 = num(await page.textContent("#yLopia"));
    assert.ok(l0 < u0, `定番セット6人: ロピア中心${l0} < いつもの${u0}`);
    assert.match(await page.textContent("#diff"), /ロピア中心にすると/);

    await page.click("#plus"); await page.click("#plus");
    assert.equal(await page.textContent("#pp"), "8人");
    assert.ok(num(await page.textContent("#yUsual")) > u0, "人数を増やすと増える");

    await page.click("text=少人数・軽め");
    assert.equal(await page.textContent("#dcnt"), "5");
    await page.click("#dishes .dish:has-text('丸鶏')");
    assert.equal(await page.textContent("#dcnt"), "6");
    assert.ok(await page.isVisible("#lines >> text=入荷が不安定"));

    assert.equal(await page.$$eval("#salmonBars .bar", (b) => b.length), 3);
    assert.ok((await page.textContent("#salmonBars .bar.hi")).includes("ロピア"));
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(w <= 390, "横スクロール " + w);
    await page.screenshot({ path: process.env.SHOT || "/dev/null", fullPage: true }).catch(() => {});
    assert.deepEqual(errs, []);
  } finally { await browser.close(); server.close(); }
});
