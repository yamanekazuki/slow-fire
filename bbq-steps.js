/* メニュー相談（menu-pick.html）と買い物リスト（shopping.html）を混同しないための共通部品（2026-10-01 山根さん）
   同じ回（shoplists/{l}）の「① メニューを決める → ② 買い物リスト」の2段を、両ページの上に同じ形で出す。
   node のテスト（scripts/test/bbq-steps.test.mjs）からも読む */
(function (root) {
  var WD = ['日', '月', '火', '水', '木', '金', '土'];
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // "20261122 月1BBQ" → "11/22(日) 月1BBQ"。日付で始まらない題名はそのまま
  function dateTitle(title) {
    var m = String(title || '').match(/^(\d{4})(\d\d)(\d\d)\s*(.*)$/);
    if (!m) return String(title || '');
    var w = WD[new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay()];
    return (+m[2]) + '/' + (+m[3]) + '(' + w + ') ' + m[4];
  }

  // メニュー相談つきの回か（管理ページ・当日案内便で作った回は menuFixed を持つ）
  function hasMenu(data) { return !!(data && (data.menuFixed || data.wants)); }

  var CSS = '.steps{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin:12px 0 4px}'
    + '.steps a,.steps span{display:block;border-radius:12px;padding:.55rem .75rem;text-decoration:none;line-height:1.35;font-family:inherit}'
    + '.steps b{display:block;font-size:.88rem;font-weight:900}'
    + '.steps small{display:block;font-size:.68rem;font-weight:700;margin-top:2px}'
    + '.steps .now{background:#2d251c;color:#fff}.steps .now small{color:rgba(255,255,255,.75)}'
    + '.steps a{background:#fffdf6;color:#2d251c;border:1.5px solid rgba(45,37,28,.18)}.steps a small{color:#b74a2c}';

  function html(listId, current) {
    var id = encodeURIComponent(listId || '');
    var items = [
      { key: 'menu', href: 'menu-pick.html?l=' + id, t: '① メニューを決める', s: '2人で「やりたい」を付け合う' },
      { key: 'shop', href: 'shopping.html?l=' + id, t: '② 買い物リスト', s: '買う物・持って行く物をチェック' }
    ];
    return '<style>' + CSS + '</style><nav class="steps" aria-label="この回の準備">' + items.map(function (it) {
      return it.key === current
        ? '<span class="now" aria-current="page"><b>' + esc(it.t) + '</b><small>いま見ているページ</small></span>'
        : '<a href="' + esc(it.href) + '"><b>' + esc(it.t) + ' →</b><small>' + esc(it.s) + '</small></a>';
    }).join('') + '</nav>';
  }

  var api = { dateTitle: dateTitle, hasMenu: hasMenu, html: html };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BbqSteps = api;
})(this);
