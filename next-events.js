/*
 * 公開イベントの「次回」表示を日付で自動更新する（2026-10-12 山根さん「今日を起点に、過去のBBQの日にちが出ないように」）
 *
 * ■ 予定を増やすとき：下の EVENTS に1行足すだけ。終わった回は消さなくてよい（表示側で勝手に消える）。
 *    身内回・招待制の回（531バーベキュー等）は載せない＝公開ページ用の台帳。
 * ■ ページ側の書き方（HTMLに書いた文言は「JSが動かないとき用」の控え。JSが今日の日付で上書きする）
 *    data-next="bbq|lecture" data-fmt="no|dot|dow|md|md-short|ymd-place"  … いちばん近い未来の回で埋める
 *    data-until="YYYY-MM-DD"  … その日を過ぎたら要素ごと消す（カレンダーの行・講座の申込選択肢など）
 *    data-next-none="..."     … 未来の回が1つも無いときの文言（省略時は「日程調整中」）
 * 日付の比較は日本時間の「今日」。開催日当日はまだ出し、翌日0時から消える。
 */
(function (root) {
  var EVENTS = [
    { date: '2026-10-11', kind: 'lecture', place: '名古屋', short: '名古屋' },
    { date: '2026-11-22', kind: 'bbq', no: '第4回', place: '新木場バーベキュー城', short: '新木場' },
  ];

  var DOW_JA = ['日', '月', '火', '水', '木', '金', '土'];
  var DOW_EN = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

  /** 日本時間の今日を YYYY-MM-DD で（Date は実時刻のまま・文字列化だけ JST） */
  function todayJst(now) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(now || new Date());
  }

  function isPast(date, today) { return !!date && date < today; }

  /** kind の未来の回をいちばん近い順に（開催日当日は含む） */
  function upcoming(kind, today, events) {
    return (events || EVENTS)
      .filter(function (e) { return e.kind === kind && !isPast(e.date, today); })
      .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
  }

  function format(ev, fmt) {
    var p = ev.date.split('-'), y = +p[0], m = +p[1], d = +p[2];
    var w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    switch (fmt) {
      case 'no': return ev.no || '';
      case 'dot': return y + '.' + m + '.' + d;
      case 'dow': return DOW_EN[w];
      case 'md': return m + '月' + d + '日（' + DOW_JA[w] + '）';
      case 'md-short': return m + '月' + d + '日（' + DOW_JA[w] + '）・' + ev.short;
      case 'ymd-place': return y + '年' + m + '月' + d + '日(' + DOW_JA[w] + ')・' + ev.place;
      default: return '';
    }
  }

  function apply(doc, today) {
    // 1) 過ぎた日付の要素を消す
    Array.prototype.forEach.call(doc.querySelectorAll('[data-until]'), function (el) {
      if (!isPast(el.getAttribute('data-until'), today)) return;
      var sel = el.tagName === 'OPTION' ? el.parentNode : null;
      var wasSelected = sel && el.selected;
      el.parentNode.removeChild(el);
      if (wasSelected && sel.options.length) {
        sel.selectedIndex = 0;
        var form = sel.form, op = sel.options[0];
        if (form) {
          form.setAttribute('data-event-id', op.value);
          form.setAttribute('data-event-label', op.getAttribute('data-label') || op.textContent);
        }
        sel.dispatchEvent(new Event('change'));
      }
    });
    // カレンダーの「次回」強調を、残った先頭の行へ付け直す
    Array.prototype.forEach.call(doc.querySelectorAll('.evline'), function (list) {
      var rows = list.querySelectorAll('.evline-row');
      Array.prototype.forEach.call(rows, function (r) { r.classList.remove('is-next'); });
      var firstBbq = Array.prototype.filter.call(rows, function (r) { return r.querySelector('.k-bbq'); })[0];
      if (firstBbq) firstBbq.classList.add('is-next');
    });
    // 2) 「次回」の文言をいちばん近い回で埋める
    Array.prototype.forEach.call(doc.querySelectorAll('[data-next]'), function (el) {
      var next = upcoming(el.getAttribute('data-next'), today)[0];
      el.textContent = next ? format(next, el.getAttribute('data-fmt'))
        : (el.hasAttribute('data-next-none') ? el.getAttribute('data-next-none') : '日程調整中');
    });
  }

  var api = { EVENTS: EVENTS, todayJst: todayJst, isPast: isPast, upcoming: upcoming, format: format, apply: apply };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root && root.document) {
    var run = function () { apply(root.document, todayJst()); };
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', run);
    else run();
  }
})(typeof window !== 'undefined' ? window : null);
