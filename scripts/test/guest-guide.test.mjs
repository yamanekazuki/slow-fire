// 当日案内便の中身（本番に触らない）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dueEvents, roster, renderGuide, participantMailText, buildMailto, daysBetween, jpDate } from "../guest-guide/core.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const info = { title: "第3回", start: "10:00", end: "13:00頃", fee: "5,000円", bring: "お酒", hosts: "山根・うえたく", access: "経堂駅から徒歩10分ほど" };

test("daysBetween / jpDate は暦日で数える（時刻・時差を使わない）", () => {
  assert.equal(daysBetween("2026-09-28", "2026-10-04"), 6);
  assert.equal(daysBetween("2026-12-31", "2027-01-01"), 1);
  assert.equal(jpDate("2026-10-04"), "10月4日（日）");
});

test("dueEvents: 6日前〜前日・未送信・参加者ありだけ", () => {
  const regsByEvent = { "2026-10-04": [{}], "2026-10-05": [{}], "2026-09-28": [{}], "2026-10-02": [], "531-02": [{}], "2026-10-03": [{}] };
  const ids = Object.keys(regsByEvent);
  const r = dueEvents({ today: "2026-09-28", eventIds: ids, regsByEvent, ledger: { "2026-10-03": { sentAt: "x" } } });
  assert.deepEqual(r, ["2026-10-04"]); // 10/5=7日前は早い・当日は遅い・0人・日付でないID・送信済みは除く
});

test("roster: キャンセル待ちは数えず、人数は1〜4に丸める", () => {
  const r = roster([{ party: "2" }, { party: "9" }, { party: "1", status: "waitlist" }, { status: "confirmed" }]);
  assert.equal(r.ok.length, 3);
  assert.equal(r.people, 2 + 4 + 1);
  assert.equal(r.wait.length, 1);
});

test("住所が無いときは案内ページに住所を出さず、文面は差し込み欄を残す", () => {
  const html = renderGuide({ date: "2026-10-04", info, venue: null, });
  assert.match(html, /住所はメールでお知らせします/);
  assert.match(html, /noindex/);
  assert.doesNotMatch(html, /maps\/dir/);
  assert.match(participantMailText({ date: "2026-10-04", info, venue: null, guideUrl: "u" }), /【住所をここに】/);
});

test("住所があるときは地図と経路のボタン・文面に住所が入り、HTMLはエスケープされる", () => {
  const venue = { address: "東京都<テスト>1-2-3", landmark: "青い門", stations: [{ name: "テスト駅", line: "テスト線", walkMin: 13, meters: 970 }] };
  const html = renderGuide({ date: "2026-10-04", info, venue });
  assert.match(html, /東京都&lt;テスト&gt;1-2-3/);
  assert.match(html, /maps\/dir\/\?api=1&amp;destination=/);
  assert.match(html, /テスト駅から歩いて約13分/);
  assert.doesNotMatch(html, /970/); // 距離は出さない
  assert.match(html, /output=embed/);
  assert.match(participantMailText({ date: "2026-10-04", info, venue, guideUrl: "u" }), /場所：東京都<テスト>1-2-3\n目印：青い門/);
});

test("mailto は宛先をBCCに入れ、件名・本文をエンコードする", () => {
  const m = buildMailto({ bcc: ["a@example.com", "b@example.com"], subject: "件名 1", body: "本文\n2行" });
  assert.ok(m.startsWith("mailto:?bcc=a%40example.com%2Cb%40example.com&subject="));
  assert.match(m, /%0A/);
});

test("events.json は住所など非公開の値を持たない", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/guest-guide/events.json"), "utf8"));
  for (const [id, ev] of Object.entries(cfg.events)) {
    assert.equal(ev.address, undefined, `${id}: 住所は guest-guide-local.json へ（公開リポジトリ）`);
  }
  assert.match(fs.readFileSync(path.join(ROOT, ".gitignore"), "utf8"), /scripts\/guest-guide-local\.json/);
});

test("メニューは載せず、雨天OK・お酒持参・集合時刻が入り、日付は 10/4 の形", () => {
  const html = renderGuide({ date: "2026-10-04", info: { ...info, start: "10:00〜10:15頃" }, venue: null });
  assert.match(html, /10月4日（日）、お待ちしてます/);
  assert.doesNotMatch(html, /当日のメニュー|MENU/);
  assert.match(html, /雨天時も問題なくできるようにしています/);
  assert.match(html, /お好きなものをご持参ください/);
  assert.match(html, /10:00〜10:15頃に現地へ/);
  assert.match(participantMailText({ date: "2026-10-04", info, venue: null, guideUrl: "u" }), /雨天時も問題なく/);
});

test("guide.html は中身（住所）を持たず Firestore guest_guides から読み、ルールは1件getだけ許す", () => {
  const g = fs.readFileSync(path.join(ROOT, "guide.html"), "utf8");
  assert.match(g, /guest_guides\/' \+ g/);
  assert.match(g, /noindex/);
  const rules = fs.readFileSync(path.join(ROOT, "firestore.rules"), "utf8");
  assert.match(rules, /match \/guest_guides\/\{id\} \{\s*allow get: if true;\s*allow list, write: if false;/);
});

test("終了時刻が空なら「まで」「お開き」を出さず、雨天・お子さま・YORON BBQのリンクが入る", () => {
  const html = renderGuide({ date: "2026-10-04", info: { ...info, end: "" }, venue: { address: "x", stations: [{ name: "経堂駅", walkMin: 10, walkLabel: "10分ちょっと" }] } });
  assert.doesNotMatch(html, /お開き|まで<\/div>/);
  assert.match(html, /徒歩10分ちょっと/);
  assert.match(html, /室内もあり、テントもある/);
  assert.match(html, /事前に教えてください。メニューを変えよう/);
  for (const u of ["team.html", "academy.html", "context.html"]) assert.match(html, new RegExp(u));
  assert.doesNotMatch(participantMailText({ date: "2026-10-04", info: { ...info, end: "" }, venue: null, guideUrl: "u" }), /まで）/);
});

test("ホスト2人のキャラと、飲み物・これまでのメニューが入る", () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/guest-guide/events.json"), "utf8"));
  const html = renderGuide({ date: "2026-10-04", info: { ...cfg.defaults, ...cfg.events["2026-10-04"] }, venue: { address: "x", note: "家の前の庭でやります" } });
  assert.match(html, /yama\.svg/);
  assert.match(html, /uetaku\.svg/);
  assert.match(html, /家の前の庭でやります/);
  assert.match(html, /ソフトドリンクも、好きなものがあれば/);
  assert.match(html, /menu\.html/);
  assert.doesNotMatch(html, /うえたくの家/);
});
