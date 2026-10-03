/* 管理ページ：メニュー相談＋買い物リストを作る（2026-10-01 山根さん「管理ページからやりたい」）
   作るのは Functions の adminCreateMenuPick。ここは表示と入力の組み立てだけ。
   node のテスト（scripts/test/admin-menu.test.mjs）からも同じ関数を読む */
(function (root) {
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var WD = ['日', '月', '火', '水', '木', '金', '土'];
  function jpDate(ymd) {
    var p = String(ymd || '').split('-').map(Number);
    if (p.length !== 3 || !p[0]) return String(ymd || '');
    return p[1] + '/' + p[2] + '(' + WD[new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay()] + ')';
  }
  function todayJst(now) { return new Date((now ? now.getTime() : Date.now()) + 9 * 3600e3).toISOString().slice(0, 10); }

  // 開催日の初期値：今日以降でいちばん近い回（申込・定員の記録から）。無ければ空
  function nextEventId(ids, now) {
    var t = todayJst(now);
    var up = (ids || []).filter(function (id) { return /^\d{4}-\d{2}-\d{2}$/.test(id) && id >= t; }).sort();
    return up[0] || '';
  }

  // チェックした料理 → { 料理名: 誰が買うか等のメモ }（メモは当日案内便の既定 menuFixed から引く）
  function buildFixed(checked, defaults) {
    var out = {};
    (checked || []).forEach(function (n) { out[n] = (defaults && defaults[n]) || ''; });
    return out;
  }

  function dishChecksHtml(names, defaults) {
    var on = defaults || {};
    return names.map(function (n) {
      return '<label class="dish"><input type="checkbox" value="' + esc(n) + '"' + (Object.prototype.hasOwnProperty.call(on, n) ? ' checked' : '') + '><span>' + esc(n) + '</span></label>';
    }).join('');
  }

  function picksRowsHtml(picks) {
    return (picks || []).slice().sort(function (a, b) { return String(b.eventId || b.id).localeCompare(String(a.eventId || a.id)); }).map(function (p) {
      var id = p.eventId || p.id, sl = p.shoplist || '';
      var pick = 'https://yoron-bbq.com/menu-pick.html?l=' + sl, shop = 'https://yoron-bbq.com/shopping.html?l=' + sl;
      return '<tr><td class="num">' + esc(jpDate(id)) + '</td>'
        + '<td><a class="mail" href="' + esc(pick) + '" target="_blank" rel="noopener">メニュー相談 ↗</a><span class="hist-sep"> / </span><a class="mail" href="' + esc(shop) + '" target="_blank" rel="noopener">買い物リスト ↗</a><button class="ghost copy-album hist-copy" data-url="' + esc(pick) + '">URLをコピー</button></td></tr>';
    }).join('');
  }

  var api = { jpDate: jpDate, nextEventId: nextEventId, buildFixed: buildFixed, dishChecksHtml: dishChecksHtml, picksRowsHtml: picksRowsHtml };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AdminMenu = api;
})(this);
