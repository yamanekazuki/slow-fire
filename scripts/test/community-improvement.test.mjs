// コミュニティサイトの週次・サイト改善メール（本番に触らない）
// 2026-10-29 山根さん「YORONバーベキューのコミュニティのサイトも、SLOW FIREと同じようにPVと改善案を」
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSubject, sitemapUrls } from "../community-improvement.mjs";

test("件名は今の会員数メールと見分けられる形で、28日間のPVと前の28日比を出す", () => {
  assert.equal(
    buildSubject({ short: "10/1〜10/28の28日間", pv: 548, ppv: 400, count: 3 }),
    "【YORON BBQ｜週次・サイト改善】10/1〜10/28の28日間｜PV 548（前の28日比+37%）・改善案3件",
  );
});

test("減ったときはマイナス、前の28日が0なら+100%", () => {
  assert.match(buildSubject({ short: "x", pv: 90, ppv: 100, count: 2 }), /前の28日比−10%）・改善案2件$/);
  assert.match(buildSubject({ short: "x", pv: 5, ppv: 0, count: 0 }), /前の28日比\+100%/);
});

test("sitemap.xml からページのURLだけを取り出す", () => {
  const xml = `<urlset><url><loc>https://yoron-bbq.com/</loc></url><url><loc>
    https://yoron-bbq.com/event.html </loc></url></urlset>`;
  assert.deepEqual(sitemapUrls(xml), ["https://yoron-bbq.com/", "https://yoron-bbq.com/event.html"]);
});

test("滞在時間は分と秒で書く", async () => {
  const { fmtDuration } = await import("../community-improvement.mjs");
  assert.equal(fmtDuration(83.4), "1分23秒");
  assert.equal(fmtDuration(42), "42秒");
});

test("月と週の呼び名（週は月曜はじまり、最後の週は昨日で切る）", async () => {
  const { monthLabel, weekLabel } = await import("../community-improvement.mjs");
  assert.equal(monthLabel("202610"), "2026年10月");
  assert.equal(weekLabel("202643"), "10/19〜10/25");
  assert.equal(weekLabel("202644", "2026-10-28"), "10/26〜10/28");
  assert.equal(weekLabel("202601"), "12/29〜1/4");
});

test("期間の表に4つの期間・UU・PV・入会・申込が並び、増減は前の同じ長さの期間と比べる", async () => {
  const { periodTable } = await import("../community-improvement.mjs");
  const z = { screenPageViews: 0, totalUsers: 0, newUsers: 0, sessions: 0, screenPageViewsPerSession: 0, averageSessionDuration: 0, engagementRate: 0 };
  const periods = { d7: { ...z, screenPageViews: 120, totalUsers: 50 }, p7: { ...z, screenPageViews: 100, totalUsers: 50 }, d28: { ...z, screenPageViews: 548 }, p28: { ...z, screenPageViews: 400 } };
  const goals = { d7: { member_join: 1, event_register: 2, form_start: 3 }, p7: {}, d28: { member_join: 3, event_register: 11, form_start: 19 }, p28: {} };
  const html = periodTable(periods, goals, { d7: "10/22〜10/28の7日間" });
  for (const w of ["直近7日", "その前の7日", "直近28日", "その前の28日", "見た人の数（UU）", "見られた回数（PV）", "入会", "BBQの申込", "10/22〜10/28の7日間"]) assert.ok(html.includes(w), w);
  assert.ok(html.includes("▲20%"), "7日のPVは前の7日比+20%");
  assert.ok(html.includes("▲37%"), "28日のPVは前の28日比+37%");
});
