// 日程調整の計算（候補枠・予定との重なり・カレンダーURLの検査・集計）。本番に触らない
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const M = createRequire(import.meta.url)(path.join(ROOT, "functions/meet-core.js"));
const NOW = new Date("2026-10-05T01:00:00Z"); // 10/5(月) 10:00 JST
const poll = (o = {}) => M.normalizePollInput({ from: "2026-10-09", to: "2026-10-13", ...o }, NOW);

test("候補枠: JSTの11:00〜17:00に1時間が収まる開始を30分刻み・土日は除く", () => {
  const s = M.buildSlots(poll(), NOW);
  const days = [...new Set(s.map((x) => x.day))];
  assert.deepEqual(days, ["2026-10-09", "2026-10-12", "2026-10-13"]); // 10/10(土)・10/11(日)なし
  const d9 = s.filter((x) => x.day === "2026-10-09");
  assert.equal(d9.length, 11); // 11:00, 11:30 … 16:00
  assert.equal(d9[0].start, "2026-10-09T02:00:00.000Z"); // 11:00 JST は UTC 02:00
  assert.equal(d9[0].label, "10/9(金) 11:00〜12:00");
  assert.equal(d9.at(-1).label, "10/9(金) 16:00〜17:00");
});

test("候補枠: 土日を入れる指定・90分・過ぎた枠は出さない", () => {
  assert.ok(M.buildSlots(poll({ weekends: true }), NOW).some((x) => x.day === "2026-10-10"));
  const s = M.buildSlots(poll({ durationMin: 90 }), NOW).filter((x) => x.day === "2026-10-09");
  assert.equal(s.at(-1).label, "10/9(金) 15:30〜17:00");
  const today = M.buildSlots(M.normalizePollInput({ from: "2026-10-05", to: "2026-10-05" }, NOW), new Date("2026-10-05T04:10:00Z")); // 13:10 JST
  assert.equal(today[0].label, "10/5(月) 13:30〜14:30");
});

test("作成時の入力: 期間の逆転・31日超え・過去・変な長さははねる", () => {
  assert.throws(() => M.normalizePollInput({ from: "2026-10-10", to: "2026-10-09" }, NOW), /前/);
  assert.throws(() => M.normalizePollInput({ from: "2026-10-01", to: "2026-11-15" }, NOW), /31日/);
  assert.throws(() => M.normalizePollInput({ from: "2026-09-01", to: "2026-09-02" }, NOW), /過ぎ/);
  assert.throws(() => M.normalizePollInput({ from: "2026-10-09", to: "2026-10-09", durationMin: 50 }, NOW), /長さ/);
  assert.equal(poll().title, "あんBBQ定例");
});

test("山根さんの予定: 終日・空き扱い・辞退・キャンセルは数えない", () => {
  const items = [
    { start: { dateTime: "2026-10-09T11:00:00+09:00" }, end: { dateTime: "2026-10-09T12:00:00+09:00" } },
    { start: { date: "2026-10-12" }, end: { date: "2026-10-13" } },
    { transparency: "transparent", start: { dateTime: "2026-10-12T13:00:00+09:00" }, end: { dateTime: "2026-10-12T14:00:00+09:00" } },
    { attendees: [{ email: "yamane@potentialight.com", responseStatus: "declined" }], start: { dateTime: "2026-10-12T15:00:00+09:00" }, end: { dateTime: "2026-10-12T16:00:00+09:00" } },
    { status: "cancelled", start: { dateTime: "2026-10-13T11:00:00+09:00" }, end: { dateTime: "2026-10-13T12:00:00+09:00" } },
  ];
  const busy = M.busyFromGoogleEvents(items, "yamane@potentialight.com");
  assert.equal(busy.length, 1);
  const slots = M.buildSlots(poll(), NOW);
  const ids = M.busySlotIds(slots, busy);
  // 11:00-12:00 と重なるのは 11:00 と 11:30 開始の2枠（10:30開始は時間帯の外）。12:00開始は重ならない
  assert.deepEqual(ids.map((id) => slots.find((s) => s.id === id).label), ["10/9(金) 11:00〜12:00", "10/9(金) 11:30〜12:30"]);
});

const ICS = `BEGIN:VCALENDAR
VERSION:2.0
PRODID:-//Google Inc//Google Calendar 70.9054//EN
BEGIN:VTIMEZONE
TZID:Asia/Tokyo
BEGIN:STANDARD
TZOFFSETFROM:+0900
TZOFFSETTO:+0900
TZNAME:JST
DTSTART:19700101T000000
END:STANDARD
END:VTIMEZONE
BEGIN:VEVENT
DTSTART;TZID=Asia/Tokyo:20261005T130000
DTEND;TZID=Asia/Tokyo:20261005T140000
RRULE:FREQ=WEEKLY;BYDAY=MO
EXDATE;TZID=Asia/Tokyo:20261012T130000
UID:weekly@test
SUMMARY:秘密の会議
END:VEVENT
BEGIN:VEVENT
DTSTART:20261013T060000Z
DTEND:20261013T070000Z
UID:once@test
SUMMARY:単発
END:VEVENT
BEGIN:VEVENT
DTSTART:20261009T020000Z
DTEND:20261009T030000Z
TRANSP:TRANSPARENT
UID:free@test
SUMMARY:空き扱い
END:VEVENT
BEGIN:VEVENT
DTSTART;VALUE=DATE:20261009
DTEND;VALUE=DATE:20261010
UID:allday@test
SUMMARY:終日
END:VEVENT
END:VCALENDAR`;

test("メンバーのiCal: 繰り返し・除外日・タイムゾーンを展開し、空き扱いと終日は数えない", () => {
  const busy = M.busyFromIcs(ICS, new Date("2026-10-08T00:00:00Z"), new Date("2026-10-21T00:00:00Z"));
  const starts = busy.map((b) => new Date(b.start).toISOString()).sort();
  // 毎週月曜13時JST: 10/12は除外日なので 10/19 だけ。単発は 10/13 15:00 JST
  assert.deepEqual(starts, ["2026-10-13T06:00:00.000Z", "2026-10-19T04:00:00.000Z"]);
});

test("カレンダーURL: Google/iCloud/Outlookの配信元だけ通す・webcalはhttpsに", () => {
  assert.equal(M.normalizeIcsUrl("webcal://calendar.google.com/calendar/ical/abc%40gmail.com/private-xyz/basic.ics"),
    "https://calendar.google.com/calendar/ical/abc%40gmail.com/private-xyz/basic.ics");
  assert.ok(M.normalizeIcsUrl("webcal://p42-caldav.icloud.com/published/2/abc"));
  assert.throws(() => M.normalizeIcsUrl("http://calendar.google.com/calendar/ical/a/basic.ics"), /https/);
  assert.throws(() => M.normalizeIcsUrl("https://169.254.169.254/latest"), /非公開URL/);
  assert.throws(() => M.normalizeIcsUrl("https://calendar.google.com/calendar/embed?src=a"), /basic\.ics/);
  assert.throws(() => M.normalizeIcsUrl("あいう"), /URL/);
});

test("集計: 山根さんの予定ありの枠は出さない・全員○で全員OK・候補外の回答は捨てる", () => {
  const slots = M.buildSlots(poll(), NOW);
  const [a, b, c] = slots;
  const answers = { uetaku: { ok: [a.id, b.id], updatedAt: "x" }, anri: { ok: [a.id, b.id] , updatedAt: "x"}, yoshi: { ok: [a.id], updatedAt: "x" } };
  const t = M.tally(slots, [b.id], answers);
  assert.ok(!t.rows.some((r) => r.id === b.id));
  assert.deepEqual(t.allOkIds, [a.id]);
  assert.equal(t.rows.find((r) => r.id === c.id).okCount, 1);
  assert.deepEqual(t.answered, ["uetaku", "anri", "yoshi"]);
  assert.deepEqual(M.cleanAnswer(slots, [a.id, a.id, "2020-01-01T00:00:00.000Z"]), [a.id]);
});
