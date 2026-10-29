// 公開イベントの「次回」自動切替（next-events.js）。今日の日付をずらして、過ぎた回が出ないことを確かめる。外部通信なし・ローカル配信のみ
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const N = createRequire(import.meta.url)(path.join(ROOT, "next-events.js"));
let chromium = null;
try { ({ chromium } = createRequire(path.join(process.env.HOME, "dev/tools/ux-patrol/"))("playwright")); } catch {}

const EV = [
  { date: "2026-10-11", kind: "lecture", place: "名古屋", short: "名古屋" },
  { date: "2026-11-22", kind: "bbq", no: "第4回", place: "経堂駅徒歩10分某所", short: "経堂" },
  { date: "2026-12-13", kind: "bbq", no: "第5回", place: "経堂駅徒歩10分某所", short: "経堂" },
];

test("今日は日本時間で数える（UTCの夜はもう翌日）", () => {
  assert.equal(N.todayJst(new Date("2026-11-22T14:59:00Z")), "2026-11-22");
  assert.equal(N.todayJst(new Date("2026-11-22T15:00:00Z")), "2026-11-23");
});

test("開催日の当日はまだ次回、翌日からは次の回になる", () => {
  assert.equal(N.upcoming("bbq", "2026-11-22", EV)[0].no, "第4回");
  assert.equal(N.upcoming("bbq", "2026-11-23", EV)[0].no, "第5回");
  assert.equal(N.upcoming("bbq", "2026-12-14", EV).length, 0);
  assert.equal(N.upcoming("lecture", "2026-10-12", EV).length, 0, "終わった講座は出さない");
});

test("表示の書き方（曜日は日付から計算）", () => {
  const e = EV[1];
  assert.equal(N.format(e, "dot"), "2026.11.22");
  assert.equal(N.format(e, "dow"), "SUN");
  assert.equal(N.format(e, "md-short"), "11月22日（日）・経堂");
  assert.equal(N.format(e, "ymd-place"), "2026年11月22日(日)・経堂駅徒歩10分某所");
});

test("台帳の日付は正しい形で、ページに書いた期限と食い違わない", () => {
  for (const e of N.EVENTS) assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/);
  const html = ["event.html", "index.html", "lecture.html"].map((f) => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n");
  for (const m of html.matchAll(/data-until="([^"]+)"/g)) assert.match(m[1], /^\d{4}-\d{2}-\d{2}$/, m[0]);
  for (const m of html.matchAll(/data-fmt="([^"]+)"/g)) assert.ok(["no", "dot", "dow", "md", "md-short", "ymd-place"].includes(m[1]), m[0]);
  for (const f of ["event.html", "index.html", "lecture.html"]) assert.match(fs.readFileSync(path.join(ROOT, f), "utf8"), /<script src="next-events\.js"><\/script>/, f);
});

function serve() {
  const s = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const f = path.join(ROOT, p);
    if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css" }[path.extname(f)] || "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((r) => s.listen(0, "127.0.0.1", () => r(s)));
}

async function open(browser, base, file, isoNow) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await page.clock.setFixedTime(new Date(isoNow));
  await page.route(/^https?:\/\/(?!127\.0\.0\.1)/, (r) => r.fulfill({ status: 200, body: "" }));
  await page.goto(`${base}/${file}`);
  await page.waitForLoadState("domcontentloaded");
  return { page, ctx };
}

test("月1BBQページ: 日付が過ぎた回は冒頭・カレンダー・申込ボタンから消える", { skip: !chromium && "playwright なし" }, async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  try {
    // 11/23（第4回の翌日）
    let { page, ctx } = await open(browser, base, "event.html", "2026-11-23T01:00:00+09:00");
    // 12/13はスキップ（2026-10-29）。11/22の翌日からは次回が無い
    assert.match(await page.textContent(".ev-hero-date"), /日程調整中/);
    assert.doesNotMatch(await page.textContent(".ev-hero-date"), /新木場/);
    const cal = await page.textContent(".evline");
    assert.doesNotMatch(cal, /10月11日|11月22日|12月13日/);
    assert.match(await page.textContent(".evmap"), /次回 東京（延期・日程調整中）/);
    await ctx.close();

    // 予定が全部終わったら「日程調整中」
    ({ page, ctx } = await open(browser, base, "event.html", "2026-12-14T09:00:00+09:00"));
    assert.match(await page.textContent(".ev-hero-date"), /日程調整中/);
    assert.doesNotMatch(await page.textContent(".ev-hero-date"), /2026\.12\.13/);
    await ctx.close();
  } finally { await browser.close(); server.close(); }
});

test("トップと講座ページ: 終わった回が次回・申込の選択肢に出ない", { skip: !chromium && "playwright なし" }, async () => {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  try {
    let { page, ctx } = await open(browser, base, "index.html", "2026-11-23T01:00:00+09:00");
    // 12/13はスキップ（2026-10-29）。11/22の翌日からは次回が無い
    assert.match(await page.textContent("body"), /次回・は日程調整中です。/);
    await ctx.close();

    ({ page, ctx } = await open(browser, base, "lecture.html", "2026-10-12T09:00:00+09:00"));
    const opts = await page.$$eval("#lectureSlot option", (os) => os.map((o) => o.value));
    assert.deepEqual(opts, ["lec-2026-11"]);
    assert.equal(await page.getAttribute("#lectureRegForm", "data-event-id"), "lec-2026-11");
    assert.doesNotMatch(await page.textContent("body"), /2026年10月11日（日）10:30/);
    await ctx.close();
  } finally { await browser.close(); server.close(); }
});
