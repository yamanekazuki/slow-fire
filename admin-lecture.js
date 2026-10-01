/* 管理ページ：グリリスト講座の申込（lecture_regs）を開催回ごとに並べる（2026-10-01 山根さん「名古屋会の表示がない」）
   admin.html から読み込む。node のテスト（scripts/test/admin-lecture.test.mjs）からも同じ関数を読む */
(function (root) {
  // 開催回の表示名と定員。申込が0件でも枠を出したい回は always:true
  var LECTURES = {
    'lec-2026-09': { label: 'グリリスト講座 10/11(日) 名古屋', cap: 6, always: true },
    'lec-2026-10': { label: 'グリリスト講座 10/25(日) 東京' },
    'lec-2026-11': { label: 'グリリスト講座 11月 東京' }
  };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function fmt(iso) { if (!iso) return '—'; var d = new Date(iso); return d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }

  function lectureLabel(id, regs) {
    if (LECTURES[id]) return LECTURES[id].label;
    var r = (regs || []).find(function (x) { return x.eventLabel; });
    return r ? r.eventLabel : (id || '開催回なし');
  }

  // 開催回ID → 申込の配列（古い順）。always の回は申込0件でも入れる
  function groupLectures(regs) {
    var by = {};
    Object.keys(LECTURES).forEach(function (id) { if (LECTURES[id].always) by[id] = []; });
    (regs || []).forEach(function (r) { var id = r.eventId || ''; (by[id] = by[id] || []).push(r); });
    Object.keys(by).forEach(function (id) { by[id].sort(function (a, b) { return String(a.createdAt || '').localeCompare(String(b.createdAt || '')); }); });
    return by;
  }

  function people(regs) { return regs.reduce(function (n, r) { return n + (parseInt(r.party, 10) || 1); }, 0); }

  function lectureStatsHtml(regs) {
    var by = groupLectures(regs);
    return Object.keys(by).sort().map(function (id) {
      var list = by[id], n = people(list), cap = (LECTURES[id] || {}).cap;
      return '<div class="stat"><div class="n">' + n + '<small>' + (cap ? ' / ' + cap + '名' : ' 名') + '</small></div>'
        + '<div class="l">' + esc(lectureLabel(id, list)) + '</div>'
        + '<div class="sub2">' + list.length + '組' + (cap ? '・残り' + Math.max(cap - n, 0) + '枠' : '') + '</div></div>';
    }).join('');
  }

  function lectureBlocksHtml(regs) {
    var by = groupLectures(regs);
    var ids = Object.keys(by).sort();
    if (!ids.length) return '<div class="ev-block"><div class="empty">まだ講座の申込はありません。</div></div>';
    return ids.map(function (id) {
      var list = by[id], n = people(list), cap = (LECTURES[id] || {}).cap;
      var meter = cap
        ? (n >= cap ? '<span class="full-badge">満席</span>' : '') + '<span class="num">' + n + ' / ' + cap + '名</span><span class="bar"><i style="width:' + Math.min(n / cap * 100, 100) + '%"></i></span>'
        : '<span class="num">' + n + '名</span>';
      var body = list.length
        ? '<div class="tbl-scroll"><table><thead><tr><th>申込日時</th><th>お名前</th><th>メール</th><th>電話</th><th>人数</th><th>ひとこと</th></tr></thead><tbody>'
          + list.map(function (r) {
            return '<tr><td>' + fmt(r.createdAt) + '</td><td class="num">' + esc(r.name) + '</td>'
              + '<td><a class="mail" href="mailto:' + esc(r.email) + '">' + esc(r.email) + '</a></td>'
              + '<td>' + (r.tel ? '<a class="mail" href="tel:' + esc(r.tel) + '">' + esc(r.tel) + '</a>' : '—') + '</td>'
              + '<td class="num">' + (parseInt(r.party, 10) || 1) + '名</td><td>' + esc(r.note) + '</td></tr>';
          }).join('') + '</tbody></table></div>'
        : '<div class="empty">まだ申込はありません。</div>';
      return '<div class="ev-block"><div class="ev-head"><div class="t">' + esc(lectureLabel(id, list)) + '<small>' + list.length + '組の申込</small></div>'
        + '<div class="ev-meter">' + meter + '</div></div>' + body + '</div>';
    }).join('');
  }

  var api = { LECTURES: LECTURES, groupLectures: groupLectures, lectureStatsHtml: lectureStatsHtml, lectureBlocksHtml: lectureBlocksHtml };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AdminLecture = api;
})(this);
