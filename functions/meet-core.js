/* =============================================
   日程調整（2026-10-05 山根さん「4人の予定合わせを、僕を起点にURL1本で」）の計算部分
   - 候補枠: 山根さんの時間帯（既定 11:00〜17:00 JST）に、決めた長さの会議が収まる開始時刻を30分刻みで並べる
   - 山根さんの空き: Googleカレンダーの予定（終日・空き扱い・辞退は除く）と重ならない枠だけ
   - メンバーのカレンダー: iCal形式の非公開URLから「予定あり」の時間帯だけを取り出す（件名などは返さない）
   Date は常に本物の瞬間で持つ。JST は「何日の何時」を組み立てる時と表示文字列を作る時だけ使う
   ============================================= */
const IcalExpander = require('ical-expander');

const JST_OFFSET_MIN = 9 * 60;
const MEMBERS = [
  { key: 'uetaku', name: 'うえたく' },
  { key: 'anri', name: 'あんちゃん' },
  { key: 'yoshi', name: 'ヨッシー' },
];
const OWNER = { key: 'yamane', name: 'やまちゃん' };
const WEEK = ['日', '月', '火', '水', '木', '金', '土'];

/** JST の「年月日 時:分」が指す本物の瞬間 */
function jstInstant(ymd, hhmm) {
  const [y, m, d] = ymd.split('-').map(Number);
  const [hh, mm] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - JST_OFFSET_MIN * 60000);
}
/** 本物の瞬間 → JST の暦の部品（表示・日付計算用） */
function jstParts(date) {
  const t = new Date(date.getTime() + JST_OFFSET_MIN * 60000);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: t.getUTCDay(), hh: t.getUTCHours(), mm: t.getUTCMinutes() };
}
const pad = (n) => String(n).padStart(2, '0');
function jstYmd(date) { const p = jstParts(date); return `${p.y}-${pad(p.m)}-${pad(p.d)}`; }
function jstLabel(start, end) {
  const a = jstParts(start), b = jstParts(end);
  return `${a.m}/${a.d}(${WEEK[a.dow]}) ${a.hh}:${pad(a.mm)}〜${b.hh}:${pad(b.mm)}`;
}
function addDaysYmd(ymd, n) {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HM = /^([01]\d|2[0-3]):[0-5]\d$/;
/** 作成時の入力を検査して正規化する（不正は Error） */
function normalizePollInput(raw, now = new Date()) {
  const title = String(raw?.title || '').trim().slice(0, 60) || 'あんBBQ定例';
  const note = String(raw?.note || '').trim().slice(0, 120);
  const from = String(raw?.from || '');
  const to = String(raw?.to || '');
  if (!YMD.test(from) || !YMD.test(to)) throw new Error('候補の期間（開始日・終了日）を入れてください');
  if (to < from) throw new Error('終了日が開始日より前になっています');
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 864e5) + 1;
  if (days > 31) throw new Error('候補の期間は31日以内にしてください');
  if (to < jstYmd(now)) throw new Error('候補の期間がもう過ぎています');
  const durationMin = Number(raw?.durationMin || 60);
  if (![30, 45, 60, 90, 120].includes(durationMin)) throw new Error('長さは30・45・60・90・120分から選んでください');
  const winStart = String(raw?.winStart || '11:00');
  const winEnd = String(raw?.winEnd || '17:00');
  if (!HM.test(winStart) || !HM.test(winEnd) || winEnd <= winStart) throw new Error('時間帯の指定が正しくありません');
  if (!/:(00|30)$/.test(winStart) || !/:(00|30)$/.test(winEnd)) throw new Error('時間帯は00分か30分で区切ってください'); // マスが30分刻みのため
  return { title, note, from, to, durationMin, winStart, winEnd, weekends: !!raw?.weekends };
}

/** 候補枠（開始が30分刻み・時間帯の中に収まるもの・過去は除く） */
function buildSlots(poll, now = new Date()) {
  const out = [];
  for (let ymd = poll.from; ymd <= poll.to; ymd = addDaysYmd(ymd, 1)) {
    const dow = jstParts(jstInstant(ymd, '12:00')).dow;
    if (!poll.weekends && (dow === 0 || dow === 6)) continue;
    const winEnd = jstInstant(ymd, poll.winEnd).getTime();
    for (let s = jstInstant(ymd, poll.winStart).getTime(); s + poll.durationMin * 60000 <= winEnd; s += 30 * 60000) {
      if (s <= now.getTime()) continue;
      const start = new Date(s), end = new Date(s + poll.durationMin * 60000);
      out.push({ id: start.toISOString(), day: ymd, start: start.toISOString(), end: end.toISOString(), label: jstLabel(start, end) });
    }
  }
  return out;
}

/** 30分のマス（時間帯の中・過去は除く）。メンバーはこのマスを塗って「行ける」を伝える */
const CELL_MIN = 30;
function buildCells(poll, now = new Date()) {
  const out = [];
  for (let ymd = poll.from; ymd <= poll.to; ymd = addDaysYmd(ymd, 1)) {
    const dow = jstParts(jstInstant(ymd, '12:00')).dow;
    if (!poll.weekends && (dow === 0 || dow === 6)) continue;
    const winEnd = jstInstant(ymd, poll.winEnd).getTime();
    for (let s = jstInstant(ymd, poll.winStart).getTime(); s + CELL_MIN * 60000 <= winEnd; s += CELL_MIN * 60000) {
      if (s + CELL_MIN * 60000 <= now.getTime()) continue;
      out.push({ id: new Date(s).toISOString(), day: ymd, start: new Date(s).toISOString(), end: new Date(s + CELL_MIN * 60000).toISOString() });
    }
  }
  return out;
}
/** 枠（会議の時間）に含まれるマスのID */
function slotCellIds(slot, durationMin) {
  const out = [];
  for (let t = 0; t < durationMin; t += CELL_MIN) out.push(new Date(Date.parse(slot.start) + t * 60000).toISOString());
  return out;
}

const overlaps = (slot, b) => Date.parse(slot.start) < b.end && b.start < Date.parse(slot.end);
/** 枠ごとに「予定あり」か */
function busySlotIds(slots, busy) {
  return slots.filter((s) => busy.some((b) => overlaps(s, b))).map((s) => s.id);
}

/** Googleカレンダー API の予定 → 予定ありの時間帯（終日・空き扱い・本人が辞退・キャンセルは数えない） */
function busyFromGoogleEvents(items, selfEmail) {
  const me = String(selfEmail || '').toLowerCase();
  return (items || []).filter((e) => {
    if (e.status === 'cancelled' || e.transparency === 'transparent') return false;
    if (!e.start?.dateTime || !e.end?.dateTime) return false; // 終日予定は空き扱い（Googleの既定と同じ）
    const self = (e.attendees || []).find((a) => a.self || String(a.email || '').toLowerCase() === me);
    return !(self && self.responseStatus === 'declined');
  }).map((e) => ({ start: Date.parse(e.start.dateTime), end: Date.parse(e.end.dateTime) }));
}

/** iCal本文から、期間に関係しうる予定だけを残す（2026-10-05 うえたくさんの何年分ものカレンダーを丸ごと解析して256MBを超えて落ちた）
   残す: 繰り返し予定（終了日が期間より前のものは除く）／開始〜終了が期間（前後2日の余裕つき）に掛かる予定。予定以外の部品（タイムゾーン等）はそのまま */
function trimIcs(text, fromDate, toDate) {
  const s = String(text);
  const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
  const lo = ymd(new Date(fromDate.getTime() - 2 * 864e5)), hi = ymd(new Date(toDate.getTime() + 2 * 864e5));
  const dateOf = (block, name) => {
    const m = block.match(new RegExp(`^${name}[;:][^\\r\\n]*?(\\d{8})`, 'm'));
    return m ? m[1] : '';
  };
  const keep = (block) => {
    const b = block.replace(/\r?\n[ \t]/g, ''); // 折り返し行をつなぐ
    if (/^(RRULE|RDATE)[;:]/m.test(b)) {
      const until = (b.match(/^RRULE:[^\r\n]*UNTIL=(\d{8})/m) || [])[1];
      return !until || until >= lo;
    }
    const start = dateOf(b, 'DTSTART'), rid = dateOf(b, 'RECURRENCE-ID');
    if (!start) return true; // 読めないものは解析に任せる
    if (rid && rid >= lo && rid <= hi) return true; // 期間内の回を動かした・消した例外
    const end = dateOf(b, 'DTEND') || (/^DURATION[;:]/m.test(b) ? hi : start);
    return start <= hi && end >= lo;
  };
  const out = [];
  let i = 0;
  for (;;) {
    const a = s.indexOf('BEGIN:VEVENT', i);
    if (a < 0) { out.push(s.slice(i)); break; }
    const z = s.indexOf('END:VEVENT', a);
    if (z < 0) { out.push(s.slice(i)); break; }
    let e = z + 'END:VEVENT'.length;
    out.push(s.slice(i, a));
    const block = s.slice(a, e);
    if (keep(block)) out.push(block);
    else if (s.startsWith('\r\n', e)) e += 2; // 捨てた予定の改行も一緒に捨てる
    else if (s[e] === '\n') e += 1;
    i = e;
  }
  return out.join('');
}

/** iCal（.ics）本文 → 期間内の予定ありの時間帯。繰り返し予定・例外日も展開する */
function busyFromIcs(text, fromDate, toDate) {
  const exp = new IcalExpander({ ics: trimIcs(text, fromDate, toDate), maxIterations: 2000 });
  const { events, occurrences } = exp.between(fromDate, toDate);
  const busy = [];
  const take = (ev, startTime, endTime) => {
    if (startTime.isDate) return; // 終日予定は空き扱い
    const transp = ev.component.getFirstPropertyValue('transp');
    if (String(transp || '').toUpperCase() === 'TRANSPARENT') return;
    const status = ev.component.getFirstPropertyValue('status');
    if (String(status || '').toUpperCase() === 'CANCELLED') return;
    busy.push({ start: startTime.toJSDate().getTime(), end: endTime.toJSDate().getTime() });
  };
  for (const e of events) take(e, e.startDate, e.endDate);
  for (const o of occurrences) take(o.item, o.startDate, o.endDate);
  return busy;
}

/** 登録してよいカレンダーURL（よその場所を叩かせないよう、カレンダーの配信元だけ） */
const ICS_HOSTS = ['calendar.google.com', 'outlook.office365.com', 'outlook.live.com', 'calendar.yahoo.co.jp', 'export.calendar.yandex.com'];
function normalizeIcsUrl(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/^webcal:\/\//i, 'https://');
  let u;
  try { u = new URL(s); } catch { throw new Error('URLの形になっていません'); }
  if (u.protocol !== 'https:') throw new Error('https で始まるURLを貼ってください');
  const host = u.hostname.toLowerCase();
  const ok = ICS_HOSTS.includes(host) || /^p\d+-caldav\.icloud\.com$/.test(host);
  if (!ok) throw new Error('Googleカレンダー・iPhoneのカレンダー・Outlookの「非公開URL（iCal形式）」を貼ってください');
  if (host === 'calendar.google.com' && !/\/calendar\/ical\/.+\/basic\.ics$/.test(u.pathname)) {
    throw new Error('Googleカレンダーは「iCal形式の非公開URL」（最後が basic.ics）を貼ってください');
  }
  return u.toString();
}

/**
 * 集計: 山根さんが空いている枠だけを出し、枠の時間を全部塗った人を「行ける」と数える
 * answers = { uetaku: { ok: [マスID...] }, ... }
 */
function tally(slots, ownerBusyIds, answers, durationMin = 60) {
  const ownerBusy = new Set(ownerBusyIds);
  const open = slots.filter((s) => !ownerBusy.has(s.id));
  const sets = Object.fromEntries(MEMBERS.map((m) => [m.key, new Set(answers?.[m.key]?.ok || [])]));
  const rows = open.map((s) => {
    const need = slotCellIds(s, durationMin);
    const okBy = MEMBERS.filter((m) => need.every((c) => sets[m.key].has(c))).map((m) => m.key);
    return { ...s, okBy, okCount: okBy.length + 1, allOk: okBy.length === MEMBERS.length };
  });
  const answered = MEMBERS.filter((m) => answers?.[m.key]?.updatedAt).map((m) => m.key);
  return { rows, allOkIds: rows.filter((r) => r.allOk).map((r) => r.id), answered };
}

/** 回答の検査: 候補にあるマスだけ・重複なし */
function cleanAnswer(cells, ok) {
  const valid = new Set(cells.map((s) => s.id));
  return [...new Set((Array.isArray(ok) ? ok : []).map(String))].filter((id) => valid.has(id)).slice(0, 500);
}

module.exports = {
  MEMBERS, OWNER, ICS_HOSTS,
  jstInstant, jstParts, jstYmd, jstLabel, addDaysYmd,
  normalizePollInput, buildSlots, buildCells, slotCellIds, CELL_MIN, busySlotIds, busyFromGoogleEvents, busyFromIcs, trimIcs, normalizeIcsUrl, tally, cleanAnswer,
};
