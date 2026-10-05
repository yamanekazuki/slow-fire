/* 日程調整ページ（meet.html）の表示まわりの計算。ブラウザとテスト（node）の両方で使う */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MeetLogic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var WEEK = ['日', '月', '火', '水', '木', '金', '土'];

  /** "2026-10-13" → "10/13(火)" */
  function dayLabel(ymd) {
    var p = ymd.split('-').map(Number);
    var dow = new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay();
    return p[1] + '/' + p[2] + '(' + WEEK[dow] + ')';
  }
  /** 枠のラベル "10/13(火) 11:00〜12:00" から時刻部分だけ */
  function timeOf(row) { return String(row.label).replace(/^\S+\s/, ''); }

  /** 日ごとにまとめる（並びは枠の順のまま） */
  function groupByDay(rows) {
    var out = [], cur = null;
    rows.forEach(function (r) {
      if (!cur || cur.day !== r.day) { cur = { day: r.day, label: dayLabel(r.day), rows: [] }; out.push(cur); }
      cur.rows.push(r);
    });
    return out;
  }

  /** いまの○（自分の分は手元の値で上書き）から、枠ごとの○の人を数え直す */
  function recount(rows, members, answers, me, mine) {
    return rows.map(function (r) {
      var okBy = members.filter(function (m) {
        var ok = (m.key === me && mine) ? mine : ((answers[m.key] && answers[m.key].ok) || []);
        return ok.indexOf(r.id) >= 0;
      }).map(function (m) { return m.key; });
      return Object.assign({}, r, { okBy: okBy, okCount: okBy.length + 1, allOk: okBy.length === members.length });
    });
  }

  /** 上に出す「決めやすい枠」: 全員OK → 足りない人が1人の枠 の順。最大 n 件 */
  function bestRows(rows, members, n) {
    var all = rows.filter(function (r) { return r.allOk; });
    if (all.length) return { kind: 'all', rows: all.slice(0, n) };
    var near = rows.filter(function (r) { return r.okBy.length === members.length - 1; });
    return { kind: near.length ? 'near' : 'none', rows: near.slice(0, n) };
  }

  /** カレンダーの予定ありから最初の○を作る（予定がない枠に全部○） */
  function prefillFromBusy(rows, busyIds) {
    var busy = {}; (busyIds || []).forEach(function (id) { busy[id] = 1; });
    return rows.filter(function (r) { return !busy[r.id]; }).map(function (r) { return r.id; });
  }

  function toggle(list, id) {
    var i = list.indexOf(id);
    return i >= 0 ? list.slice(0, i).concat(list.slice(i + 1)) : list.concat([id]);
  }

  return { dayLabel: dayLabel, timeOf: timeOf, groupByDay: groupByDay, recount: recount, bestRows: bestRows, prefillFromBusy: prefillFromBusy, toggle: toggle };
});
