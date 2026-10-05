/* 日程調整ページ（meet.html）の表示まわりの計算。ブラウザとテスト（node）の両方で使う
   2026-10-05 山根さん「Googleカレンダーみたいな画面で、なぞったところがOKに」→ 回答は30分マス単位 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MeetLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var WEEK = ['日', '月', '火', '水', '木', '金', '土'];
  var CELL_MIN = 30;

  function dow(ymd) { var p = ymd.split('-').map(Number); return new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay(); }
  /** "2026-10-13" → "10/13(火)" */
  function dayLabel(ymd) { var p = ymd.split('-').map(Number); return p[1] + '/' + p[2] + '(' + WEEK[dow(ymd)] + ')'; }
  /** 枠のラベル "10/13(火) 11:00〜12:00" から時刻部分だけ */
  function timeOf(row) { return String(row.label).replace(/^\S+\s/, ''); }
  /** マスID（開始の瞬間）→ JST の "11:30" */
  function hhmm(iso) { return new Date(iso).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Tokyo' }); }

  /** 枠（会議の時間）に含まれるマスのID。サーバー側 meet-core.js の slotCellIds と同じ計算 */
  function slotCellIds(slot, durationMin) {
    var out = [];
    for (var t = 0; t < durationMin; t += CELL_MIN) out.push(new Date(Date.parse(slot.start) + t * 60000).toISOString());
    return out;
  }

  /** マス目の形: 週ごと（月曜はじまり）に日を並べ、行は時刻 */
  function grid(cells) {
    var days = [], byDay = {}, times = [], seenT = {};
    cells.forEach(function (c) {
      if (!byDay[c.day]) { byDay[c.day] = {}; days.push(c.day); }
      var t = hhmm(c.id);
      byDay[c.day][t] = c;
      if (!seenT[t]) { seenT[t] = 1; times.push(t); }
    });
    times.sort();
    var weeks = [], cur = null, curKey = '';
    days.forEach(function (d) {
      var p = d.split('-').map(Number);
      var mon = new Date(Date.UTC(p[0], p[1] - 1, p[2] - ((dow(d) + 6) % 7))).toISOString().slice(0, 10);
      if (mon !== curKey) { curKey = mon; cur = { days: [] }; weeks.push(cur); }
      cur.days.push(d);
    });
    return { weeks: weeks, times: times, at: function (day, t) { return (byDay[day] || {})[t] || null; } };
  }

  function sets(members, answers, me, mine) {
    var out = {};
    members.forEach(function (m) {
      var ok = (m.key === me && mine) ? mine : ((answers[m.key] && answers[m.key].ok) || []);
      var s = {}; ok.forEach(function (id) { s[id] = 1; }); out[m.key] = s;
    });
    return out;
  }

  /** いまの塗り（自分の分は手元の値）から、枠ごとに「全部塗った人」を数え直す */
  function recount(rows, members, answers, me, mine, durationMin) {
    var S = sets(members, answers, me, mine);
    return rows.map(function (r) {
      var need = slotCellIds(r, durationMin || 60);
      var okBy = members.filter(function (m) { return need.every(function (c) { return S[m.key][c]; }); }).map(function (m) { return m.key; });
      return Object.assign({}, r, { okBy: okBy, okCount: okBy.length + 1, allOk: okBy.length === members.length });
    });
  }

  /** マスごとに何人が塗ったか（やまちゃんは空いていれば1人に数える） */
  function heat(cells, members, answers, me, mine) {
    var S = sets(members, answers, me, mine), out = {};
    cells.forEach(function (c) {
      if (c.busy) { out[c.id] = 0; return; }
      out[c.id] = 1 + members.filter(function (m) { return S[m.key][c.id]; }).length;
    });
    return out;
  }

  /** 上に出す「決めやすい枠」: 全員OK → 足りない人が1人の枠 の順。最大 n 件 */
  function bestRows(rows, members, n) {
    var all = rows.filter(function (r) { return r.allOk; });
    if (all.length) return { kind: 'all', rows: all.slice(0, n) };
    var near = rows.filter(function (r) { return r.okBy.length === members.length - 1; });
    return { kind: near.length ? 'near' : 'none', rows: near.slice(0, n) };
  }

  /** カレンダーから最初の塗りを作る（やまちゃんが空いていて、自分の予定もないマス全部） */
  function prefillFromBusy(cells, busyIds) {
    var busy = {}; (busyIds || []).forEach(function (id) { busy[id] = 1; });
    return cells.filter(function (c) { return !c.busy && !busy[c.id]; }).map(function (c) { return c.id; });
  }

  /** なぞった範囲を塗る（add=true）か消す（add=false）。並びは元の順を保つ */
  function paint(list, ids, add) {
    var has = {}; list.forEach(function (id) { has[id] = 1; });
    if (add) return list.concat(ids.filter(function (id) { return !has[id]; }));
    var del = {}; ids.forEach(function (id) { del[id] = 1; });
    return list.filter(function (id) { return !del[id]; });
  }

  /** ドラッグの始点と今の位置から、長方形の範囲のマス（同じ週の表示内） */
  function rectIds(g, days, a, b) {
    var d0 = Math.min(a.d, b.d), d1 = Math.max(a.d, b.d), t0 = Math.min(a.t, b.t), t1 = Math.max(a.t, b.t), out = [];
    for (var d = d0; d <= d1; d++) for (var t = t0; t <= t1; t++) {
      var c = g.at(days[d], g.times[t]);
      if (c && !c.busy) out.push(c.id);
    }
    return out;
  }

  return { CELL_MIN: CELL_MIN, dayLabel: dayLabel, timeOf: timeOf, hhmm: hhmm, slotCellIds: slotCellIds, grid: grid, recount: recount, heat: heat, bestRows: bestRows, prefillFromBusy: prefillFromBusy, paint: paint, rectIds: rectIds };
});
