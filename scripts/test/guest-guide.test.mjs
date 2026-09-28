// 当日案内便の中身（本番に触らない）
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dueEvents, roster, renderGuide, participantMailText, participantMailHtml, confirmMailHtml, pendingOf, pendingKey, daysBetween, jpDate, menuDueEvents, menuConsultMail } from "../guest-guide/core.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const info = { title: "第3回", start: "10:00", end: "13:00頃", fee: "5,000円", bring: "お酒", hosts: "山根・うえたく", access: "経堂駅から徒歩10分ほど" };

test("daysBetween / jpDate は暦日で数える（時刻・時差を使わない）", () => {
  assert.equal(daysBetween("2026-09-28", "2026-10-04"), 6);
  assert.equal(daysBetween("2026-12-31", "2027-01-01"), 1);
  assert.equal(jpDate("2026-10-04"), "10月4日（日）");
});

test("dueEvents: 5日前〜前日・参加者ありの回だけ（日付でないIDは除く）", () => {
  const regsByEvent = { "2026-10-04": [{}], "2026-10-03": [{}], "2026-09-28": [{}], "2026-10-02": [], "531-02": [{}] };
  const r = dueEvents({ today: "2026-09-28", eventIds: Object.keys(regsByEvent), regsByEvent, ledger: {} });
  assert.deepEqual(r, ["2026-10-03"]); // 10/4=6日前はまだ・当日は遅い・0人・日付でないID は除く
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

test("pendingOf: 送信済み・キャンセル待ち・メール無し・重複を除き、キーは順不同で同じ", () => {
  const ros = roster([{ name: "A", email: "a@example.com" }, { name: "B", email: "B@example.com" }, { name: "B2", email: "b@example.com" }, { name: "C", email: "" }, { name: "W", email: "w@example.com", status: "waitlist" }]);
  const p = pendingOf(ros, ["a@example.com"]);
  assert.deepEqual(p, [{ name: "B", email: "b@example.com" }]);
  assert.equal(pendingKey([{ email: "b2@example.com" }, { email: "a2@example.com" }]), pendingKey([{ email: "a2@example.com" }, { email: "b2@example.com" }]));
});

test("確認メールは送り先・文面・確認リンクを載せ、開いただけでは送らないと書く", () => {
  const html = confirmMailHtml({ date: "2026-10-04", info, guideUrl: "https://yoron-bbq.com/guide.html?g=abc123", pending: [{ name: "A<b>", email: "a@example.com" }], sentCount: 0, approveUrl: "https://fn.example/x?g=abc123&t=ff", text: "本文" });
  assert.match(html, /参加者1名へ/);
  assert.match(html, /A&lt;b&gt;/);
  assert.match(html, /開いただけでは送りません/);
  assert.match(html, /fn\.example\/x\?g=abc123&amp;t=ff/);
  const pm = participantMailHtml({ text: "見てね\nhttps://yoron-bbq.com/guide.html?g=abc123", guideUrl: "https://yoron-bbq.com/guide.html?g=abc123" });
  assert.match(pm, /当日のしおりを開く/);
  assert.match(pm, /<br>/);
});

test("送信関数は GET では送らず POST で合言葉を消してから送る（誤送信・二重送信の防止）", () => {
  const fn = fs.readFileSync(path.join(ROOT, "functions/index.js"), "utf8");
  const body = fn.slice(fn.indexOf("exports.bbqGuestGuideSend"));
  assert.match(body, /if \(req\.method !== 'POST'\)/);
  assert.ok(body.indexOf("token: admin.firestore.FieldValue.delete()") < body.indexOf("bbqSendMail(key, { to: [p.email]"), "合言葉を消す前に送っている");
  assert.ok(body.indexOf("arrayUnion(p.email)") > body.indexOf("bbqSendMail(key, { to: [p.email]") && body.indexOf("arrayUnion(p.email)") < body.indexOf("lastSentAt: now"), "1人ごとに sentTo へ記録する");
  const loop = fs.readFileSync(path.join(ROOT, "scripts/guest-guide-loop.mjs"), "utf8");
  assert.match(loop, /const awaiting = !!sends\?\.token\?\.stringValue;/); // 合言葉が消えた（送信を試した）あとは、残った人の確認を出し直す
  const rules = fs.readFileSync(path.join(ROOT, "firestore.rules"), "utf8");
  assert.match(rules, /match \/guest_guide_sends\/\{id\} \{\s*allow read, write: if false;/);
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
  assert.ok((html.match(/class="voice/g) || []).length >= 4, "キャラは章ごとに置く");
  assert.match(html, /class="hero"/);
  assert.match(html, /家の前の庭でやります/);
  assert.match(html, /ソフトドリンクも、好きなものがあれば/);
  assert.match(html, /menu\.html/);
  assert.doesNotMatch(html, /うえたくの家/);
});

test("メニュー相談: 7日前〜前日・未送・申込ありだけ／文面に確定と買う人・相談ページ", () => {
  const regsByEvent = { "2026-10-05": [{}], "2026-10-06": [{}], "2026-10-04": [{}], "2026-10-03": [] };
  assert.deepEqual(menuDueEvents({ today: "2026-09-28", eventIds: Object.keys(regsByEvent), regsByEvent, ledger: { "2026-10-04": { menuAskedAt: "x" } } }), ["2026-10-05"]);
  const m = menuConsultMail({ date: "2026-10-04", info: { title: "第3回" }, fixed: { "グリル野菜": "", "丸鶏（ビアカン／インジェクション）": "やまちゃんが前日に仕入れ" }, pickUrl: "https://yoron-bbq.com/menu-pick.html?l=abc123", people: 5 });
  assert.match(m.subject, /10月4日（日）のメニュー/);
  assert.match(m.text, /グリル野菜・丸鶏は確定/);
  assert.match(m.text, /丸鶏はやまちゃんが前日に仕入れ/);
  assert.match(m.html, /menu-pick\.html\?l=abc123/);
});
