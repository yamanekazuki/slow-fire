// 日程調整ページを合成ユーザー（Playwright・スマホ幅）で操作する。本番に触らない（firebase-config.js を偽物に差し替え）
// 2026-10-05 週表示のマス目を「なぞって塗る」形に
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const Core = createRequire(import.meta.url)(path.join(ROOT, "functions/meet-core.js"));
let chromium = null;
try { ({ chromium } = createRequire(path.join(process.env.HOME, "dev/tools/ux-patrol/"))("playwright")); } catch {}

const NOW = new Date("2026-10-05T01:00:00Z");
const poll = Core.normalizePollInput({ from: "2026-10-13", to: "2026-10-14", note: "10/15(木)12:00の回を動かします" }, NOW);
const id = (day, hm) => Core.jstInstant(day, hm).toISOString();
const ownerBusy = [{ start: Date.parse(id("2026-10-14", "11:00")), end: Date.parse(id("2026-10-14", "12:00")) }];
const allCells = Core.buildCells(poll, NOW);
const busyCells = new Set(Core.busySlotIds(allCells, ownerBusy));
const slots = Core.buildSlots(poll, NOW);
const BASE = {
  title: "あんBBQ定例", note: poll.note, durationMin: 60, winStart: "11:00", winEnd: "17:00", status: "open", fixed: null,
  members: Core.MEMBERS, owner: Core.OWNER,
  cells: allCells.map((c) => ({ id: c.id, day: c.day, busy: busyCells.has(c.id) })),
  rows: Core.tally(slots, Core.busySlotIds(slots, ownerBusy), {}, 60).rows,
  answers: {
    uetaku: { ok: [id("2026-10-13", "13:00"), id("2026-10-13", "13:30"), id("2026-10-13", "14:00")], updatedAt: "x" },
    anri: { ok: [id("2026-10-13", "13:00"), id("2026-10-13", "13:30")], updatedAt: "x" },
  },
  // ヨッシーはカレンダーをつないでいて、10/13 の 11:00〜13:00 に予定がある
  memberBusy: { yoshi: ["11:00", "11:30", "12:00", "12:30"].map((t) => id("2026-10-13", t)) }, calendars: { yoshi: { ok: true } },
};
const FAKE = (isAdmin, data) => `
window.__calls = [];
var sfFunctions = { httpsCallable: function(name){ return function(p){
  window.__calls.push({ name: name, p: p });
  if (name === 'meetPollGet') { var d = JSON.parse(JSON.stringify(window.__data)); d.isAdmin = ${isAdmin}; return Promise.resolve({ data: d }); }
  if (name === 'meetPollFix') { window.__data.status = 'fixed'; window.__data.fixed = { label: '10/13(火) 13:00〜14:00', meetUrl: 'https://meet.google.com/abc-defg-hij' }; return Promise.resolve({ data: {} }); }
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
async function open(isAdmin, q = "p=testpoll1234", data = BASE) {
  const server = await serve(isAdmin, data);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: false });
  const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  await page.route(/gstatic\.com|fonts\.(googleapis|gstatic)\.com/, (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: "" }));
  await page.goto(`http://127.0.0.1:${server.address().port}/meet.html?${q}`);
  await page.waitForSelector("#app h1, #app .error", { timeout: 8000 });
  return { page, errs, close: async () => { await browser.close(); server.close(); } };
}
const lastSave = (page) => page.evaluate(() => (window.__calls.filter((c) => c.name === "meetPollAnswer").at(-1) || {}).p);
async function dragCells(page, fromId, toId) {
  const a = await page.locator(`.cell[data-c="${fromId}"]`).boundingBox();
  const b = await page.locator(`.cell[data-c="${toId}"]`).boundingBox();
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 6 });
  await page.mouse.up();
}

test("ヨッシー: カレンダーの空きで最初から塗られる→なぞって消す・塗ると全員OKが変わる", { skip: !chromium && "playwright なし" }, async () => {
  const { page, errs, close } = await open(false);
  try {
    assert.match(await page.textContent("#below"), /あと1人で全員そろう時間/); // 10/13 13:00〜14:00 はうえたく・あんちゃん
    // 最初に「あなたは誰？」のポップアップ
    assert.match(await page.textContent(".modal"), /あなたは誰ですか/);
    await page.click('.modal [data-who="yoshi"]');
    assert.equal(await page.$(".modal"), null);
    await page.waitForFunction(() => window.__calls.some((c) => c.name === "meetPollAnswer"));
    let saved = await lastSave(page);
    assert.equal(saved.member, "yoshi");
    assert.ok(!saved.ok.includes(id("2026-10-13", "11:00")), "自分の予定がある時間は塗らない");
    assert.ok(!saved.ok.includes(id("2026-10-14", "11:00")), "やまちゃんが埋まっている時間は塗らない");
    assert.ok(saved.ok.includes(id("2026-10-13", "13:00")));
    assert.match(await page.textContent("#below"), /全員OKの時間/);
    // ヨッシーの色（青）で塗られ、下に「何月何日の何時〜何時」が出る
    assert.match(await page.getAttribute(`.cell[data-c="${id("2026-10-13", "13:00")}"] i`, "style"), /--c-yoshi/);
    assert.match(await page.textContent(".mine-list"), /10\/13\(火\) 13:00〜17:00/);
    assert.match(await page.getAttribute(`.cell[data-c="${id("2026-10-13", "11:00")}"]`, "class"), /\bcb\b/, "自分の予定があるマスに印");

    // 塗ってある 10/13 13:00〜13:30 をなぞる → 消える → 全員OKがなくなる
    await dragCells(page, id("2026-10-13", "13:00"), id("2026-10-13", "13:30"));
    await page.waitForFunction((x) => { const c = window.__calls.filter((c) => c.name === "meetPollAnswer").at(-1); return c && !c.p.ok.includes(x); }, id("2026-10-13", "13:00"));
    assert.doesNotMatch(await page.textContent("#below"), /全員OKの時間/);
    // もう一度なぞる → 塗れる
    await dragCells(page, id("2026-10-13", "13:00"), id("2026-10-13", "13:30"));
    await page.waitForFunction((x) => window.__calls.filter((c) => c.name === "meetPollAnswer").at(-1).p.ok.includes(x), id("2026-10-13", "13:00"));
    assert.match(await page.textContent("#below"), /全員OKの時間/);
    // やまちゃんが埋まっているマスはなぞっても塗れない
    await dragCells(page, id("2026-10-14", "11:00"), id("2026-10-14", "11:30"));
    saved = await lastSave(page);
    assert.ok(!saved.ok.includes(id("2026-10-14", "11:00")));

    // みんなの重なりに切り替え → 行ける人の色の帯。全員そろったマスは「全員OK」
    await page.click('[data-view="all"]');
    const c13 = `.cell[data-c="${id("2026-10-13", "13:00")}"]`;
    assert.equal(await page.locator(`${c13} i`).count(), 3);
    assert.match(await page.getAttribute(c13, "class"), /allok/);
    assert.equal(await page.locator(`.cell[data-c="${id("2026-10-13", "14:30")}"] i`).count(), 1); // 14:30 はヨッシーだけ
    // マスを押すと下に日時（メンバーには確定ボタンなし）
    await page.click(c13);
    assert.match(await page.textContent(".pick-panel"), /10\/13\(火\) 13:00〜14:00/);
    assert.equal(await page.$(".pick-panel [data-fix]"), null);
    // 時刻の目盛りは終わりの 17:00 まで出る
    assert.match(await page.textContent("#grid"), /17:00/);
    // 見るだけの画面ではマスの上でもスクロールできる（塗る画面だけ touch-action:none）
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#grid .cell[data-c]")).touchAction), "auto");
    await page.click('[data-view="me"]');
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector("#grid .cell[data-c]")).touchAction), "none");
    const w = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(w <= 390, `横にはみ出している: ${w}px`);
    assert.deepEqual(errs, []);
  } finally { await close(); }
});

test("やまちゃん用URL: 重なりだけ見せて塗らせない・全員OKの枠を確定→決まった画面とMeet", { skip: !chromium && "playwright なし" }, async () => {
  const data = JSON.parse(JSON.stringify(BASE));
  data.answers.yoshi = { ok: [id("2026-10-13", "13:00"), id("2026-10-13", "13:30")], updatedAt: "x" };
  const { page, errs, close } = await open(true, "p=testpoll1234&k=secretkey", data);
  try {
    assert.match(await page.textContent("#app"), /やまちゃん用の画面/);
    assert.equal(await page.$(".modal"), null); // やまちゃんには「あなたは誰？」を出さない
    // 前にメンバーとして名前を選んでいても、やまちゃん用では塗らせず保存もしない
    await page.evaluate(() => localStorage.setItem("bbqMeetMe", "yoshi"));
    await page.reload(); await page.waitForSelector("#below");
    await dragCells(page, id("2026-10-13", "15:00"), id("2026-10-13", "15:30"));
    assert.ok(!(await page.evaluate(() => window.__calls.some((c) => c.name === "meetPollAnswer"))));
    page.on("dialog", (d) => d.accept());
    const slotId = id("2026-10-13", "13:00");
    // マスを押す → 下に日時と「この日時で確定する」
    await page.click(`.cell[data-c="${slotId}"]`);
    assert.match(await page.textContent(".pick-panel"), /10\/13\(火\) 13:00〜14:00/);
    await page.click(`.pick-panel [data-fix="${slotId}"]`);
    await page.waitForSelector(".done-card");
    const fix = await page.evaluate(() => window.__calls.find((c) => c.name === "meetPollFix").p);
    assert.deepEqual(fix, { id: "testpoll1234", k: "secretkey", slot: slotId });
    assert.equal(await page.getAttribute(".done-card a", "href"), "https://meet.google.com/abc-defg-hij");
    assert.deepEqual(errs, []);
  } finally { await close(); }
});

test("なぞった直後に名前を切り替えても、前の人の塗りは前の人の名前で保存される", { skip: !chromium && "playwright なし" }, async () => {
  const { page, errs, close } = await open(false);
  try {
    await page.click('.modal [data-who="anri"]');
    await dragCells(page, id("2026-10-13", "15:00"), id("2026-10-13", "15:30"));
    await page.click('.names [data-who2="uetaku"]'); // 500ms の保存待ちの間に、上の名前ですぐ切り替える
    assert.match(await page.getAttribute('.names [data-who2="uetaku"]', "class"), /on/);
    await page.waitForTimeout(800);
    const saves = await page.evaluate(() => window.__calls.filter((c) => c.name === "meetPollAnswer").map((c) => c.p));
    const anri = saves.filter((p) => p.member === "anri");
    assert.ok(anri.length && anri.at(-1).ok.includes(id("2026-10-13", "15:00")), "あんちゃんの塗りはあんちゃんの名前で");
    assert.ok(!saves.some((p) => p.member === "uetaku" && p.ok.includes(id("2026-10-13", "15:00"))), "うえたくの名前で保存しない");
    assert.deepEqual(errs, []);
  } finally { await close(); }
});

test("URLが切れている: 案内を出して止まる", { skip: !chromium && "playwright なし" }, async () => {
  const { page, close } = await open(false, "");
  try { assert.match(await page.textContent("#app"), /URLが途中で切れています/); } finally { await close(); }
});
