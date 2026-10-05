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

test("マス: 11:00〜17:00を30分ずつ12マス・枠に必要なマスは長さ分", () => {
  const cells = M.buildCells(poll(), NOW).filter((c) => c.day === "2026-10-09");
  assert.equal(cells.length, 12);
  assert.equal(cells[0].id, "2026-10-09T02:00:00.000Z");
  assert.equal(cells.at(-1).id, "2026-10-09T07:30:00.000Z"); // 16:30 JST
  const slot = M.buildSlots(poll(), NOW)[0];
  assert.deepEqual(M.slotCellIds(slot, 60), ["2026-10-09T02:00:00.000Z", "2026-10-09T02:30:00.000Z"]);
});

test("集計: 枠の時間を全部塗った人だけ行ける・山根さんの予定ありの枠は出さない・候補外のマスは捨てる", () => {
  const slots = M.buildSlots(poll(), NOW);
  const cells = M.buildCells(poll(), NOW);
  const [a, b] = slots; // 11:00〜12:00, 11:30〜12:30
  const c11 = "2026-10-09T02:00:00.000Z", c1130 = "2026-10-09T02:30:00.000Z", c12 = "2026-10-09T03:00:00.000Z";
  const answers = {
    uetaku: { ok: [c11, c1130, c12], updatedAt: "x" },
    anri: { ok: [c11, c1130], updatedAt: "x" },
    yoshi: { ok: [c11], updatedAt: "x" }, // 11:00〜11:30 だけ → 1時間の枠はどれも行けない
  };
  let t = M.tally(slots, [], answers, 60);
  assert.deepEqual(t.rows.find((r) => r.id === a.id).okBy, ["uetaku", "anri"]);
  assert.deepEqual(t.rows.find((r) => r.id === b.id).okBy, ["uetaku"]);
  assert.deepEqual(t.allOkIds, []);
  answers.yoshi.ok.push(c1130);
  t = M.tally(slots, [b.id], answers, 60);
  assert.deepEqual(t.allOkIds, [a.id]);
  assert.ok(!t.rows.some((r) => r.id === b.id));
  assert.deepEqual(t.answered, ["uetaku", "anri", "yoshi"]);
  assert.deepEqual(M.cleanAnswer(cells, [c11, c11, "2020-01-01T00:00:00.000Z", a.id]), [c11]);
});

test("時間帯は00分か30分で区切る（マスが30分刻みのため・端の枠が永久に埋まらない事故の防止）", () => {
  assert.throws(() => M.normalizePollInput({ from: "2026-10-09", to: "2026-10-09", winEnd: "17:15" }, NOW), /00分か30分/);
  assert.equal(M.normalizePollInput({ from: "2026-10-09", to: "2026-10-09", winStart: "10:30", winEnd: "17:30" }, NOW).winStart, "10:30");
});

test("大きなiCal: 期間に関係ない過去の予定は解析前に捨てる・繰り返しと期間内は残る（2026-10-05 うえたくさんのカレンダーでメモリ超過）", () => {
  const old = Array.from({ length: 30000 }, (_, i) => {
    const d = new Date(Date.UTC(2015, 0, 1) + i * 3 * 3600e3).toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
    return `BEGIN:VEVENT\r\nDTSTART:${d}\r\nDTEND:${d}\r\nUID:old${i}@test\r\nSUMMARY:昔の予定\r\nEND:VEVENT`;
  }).join("\r\n");
  const ended = "BEGIN:VEVENT\r\nDTSTART:20200106T040000Z\r\nDTEND:20200106T050000Z\r\nRRULE:FREQ=WEEKLY;UNTIL=20201231T000000Z\r\nUID:ended@test\r\nEND:VEVENT";
  const big = ICS.replace("END:VCALENDAR", old + "\r\n" + ended + "\r\nEND:VCALENDAR");
  const from = new Date("2026-10-08T00:00:00Z"), to = new Date("2026-10-21T00:00:00Z");
  const trimmed = M.trimIcs(big, from, to);
  assert.ok(trimmed.length < 3000, `切り出し後 ${trimmed.length} 文字`);
  assert.ok(!/ended@test|old0@test/.test(trimmed));
  assert.ok(/weekly@test/.test(trimmed) && /once@test/.test(trimmed) && /VTIMEZONE/.test(trimmed));
  const starts = M.busyFromIcs(big, from, to).map((b) => new Date(b.start).toISOString()).sort();
  assert.deepEqual(starts, ["2026-10-13T06:00:00.000Z", "2026-10-19T04:00:00.000Z"]);
});

test("何年も前から続く毎日の予定も、今の期間まで展開して予定ありにする（2000回で打ち切らない）", () => {
  const ics = ICS.replace("END:VCALENDAR", [
    "BEGIN:VEVENT", "DTSTART;TZID=Asia/Tokyo:20160104T113000", "DTEND;TZID=Asia/Tokyo:20160104T120000",
    "RRULE:FREQ=DAILY", "UID:daily-since-2016@test", "END:VEVENT", "END:VCALENDAR"].join("\n"));
  const busy = M.busyFromIcs(ics, new Date("2026-10-08T00:00:00Z"), new Date("2026-10-21T00:00:00Z"));
  const daily = busy.filter((b) => new Date(b.start).toISOString().endsWith("T02:30:00.000Z"));
  assert.equal(daily.length, 13); // 10/8〜10/20 の13日分（11:30 JST）
});

test("切り出し: 終わった繰り返しに追加日（RDATE）がある予定・TZID名に数字が並ぶ予定も捨てない（点検の指摘）", () => {
  const from = new Date("2026-10-05T00:00:00Z"), to = new Date("2026-10-12T00:00:00Z");
  const wrap = (ev) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${ev}\r\nEND:VCALENDAR`;
  const rdate = wrap("BEGIN:VEVENT\r\nDTSTART:20200101T010000Z\r\nDTEND:20200101T020000Z\r\nRRULE:FREQ=DAILY;UNTIL=20200201T000000Z\r\nRDATE:20261007T010000Z\r\nUID:rdate@test\r\nEND:VEVENT");
  assert.ok(M.busyFromIcs(rdate, from, to).some((b) => new Date(b.start).toISOString() === "2026-10-07T01:00:00.000Z"));
  const tz = wrap("BEGIN:VTIMEZONE\r\nTZID:Custom/12345678\r\nBEGIN:STANDARD\r\nTZOFFSETFROM:+0900\r\nTZOFFSETTO:+0900\r\nDTSTART:19700101T000000\r\nEND:STANDARD\r\nEND:VTIMEZONE\r\nBEGIN:VEVENT\r\nDTSTART;TZID=Custom/12345678:20261007T100000\r\nDTEND;TZID=Custom/12345678:20261007T110000\r\nUID:tz@test\r\nEND:VEVENT");
  assert.match(M.trimIcs(tz, from, to), /tz@test/);
  const quoted = wrap('BEGIN:VEVENT\r\nDTSTART;TZID="(UTC+09:00) Osaka, Sapporo, Tokyo":20261007T100000\r\nDTEND;TZID="(UTC+09:00) Osaka, Sapporo, Tokyo":20261007T110000\r\nUID:q@test\r\nEND:VEVENT');
  assert.match(M.trimIcs(quoted, from, to), /q@test/);
  const oldQuoted = quoted.replace(/20261007/g, "20200107");
  assert.doesNotMatch(M.trimIcs(oldQuoted, from, to), /q@test/);
});
