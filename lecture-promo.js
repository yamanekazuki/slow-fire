/* バーベキュー講座（lecture.html）の告知バッジ
   - 右下固定の丸バッジ（あんちゃんの顔）＋吹き出し
   - 表示直後は吹き出し付き、数秒で丸だけに畳む（スクロールを邪魔しない）
   - 丸をタップ/ホバーで吹き出し再表示、吹き出しの×で閉じてもセッション中は丸だけ残す */
(function () {
  if (location.pathname.replace(/^\//, '') === 'lecture.html') return;

  var collapsed = !!sessionStorage.getItem('lecturePromoClosed');

  // あんちゃんの顔（anchan.js のアフロ＋眼鏡＋そばかすを静的SVG化）
  var FACE_SVG =
    '<svg viewBox="42 14 216 176" aria-hidden="true">' +
      '<g fill="#3a2a23" stroke="#2d251c" stroke-width="4" stroke-linejoin="round">' +
        '<circle cx="104" cy="66" r="33"/><circle cx="150" cy="54" r="36"/><circle cx="196" cy="68" r="32"/>' +
        '<circle cx="78" cy="102" r="28"/><circle cx="222" cy="104" r="27"/>' +
        '<circle cx="150" cy="90" r="50" stroke="none"/><circle cx="100" cy="124" r="24" stroke="none"/><circle cx="202" cy="126" r="23" stroke="none"/>' +
      '</g>' +
      '<g fill="none" stroke="#5a4437" stroke-width="3.5" stroke-linecap="round" opacity=".9">' +
        '<path d="M110 58 C116 52 125 49 132 51"/><path d="M184 60 C191 59 198 62 202 68"/>' +
      '</g>' +
      '<ellipse cx="150" cy="126" rx="46" ry="43" fill="#f2c49b" stroke="#2d251c" stroke-width="4"/>' +
      '<circle cx="104" cy="129" r="8" fill="#f2c49b" stroke="#2d251c" stroke-width="4"/>' +
      '<circle cx="196" cy="129" r="8" fill="#f2c49b" stroke="#2d251c" stroke-width="4"/>' +
      '<circle cx="121" cy="135" r="9" fill="#f0906b" opacity=".3"/><circle cx="179" cy="135" r="9" fill="#f0906b" opacity=".3"/>' +
      '<g fill="#c98d5f">' +
        '<circle cx="117" cy="132" r="1.4"/><circle cx="123" cy="129" r="1.4"/><circle cx="127" cy="134" r="1.4"/>' +
        '<circle cx="173" cy="134" r="1.4"/><circle cx="178" cy="129" r="1.4"/><circle cx="183" cy="132" r="1.4"/>' +
      '</g>' +
      '<path d="M149 130 C147.5 134 149 137 152 138" fill="none" stroke="#2d251c" stroke-width="3" stroke-linecap="round"/>' +
      '<path d="M124 122 C128 116 137 116 141 122" fill="none" stroke="#2d251c" stroke-width="3.8" stroke-linecap="round"/>' +
      '<path d="M159 122 C163 116 172 116 176 122" fill="none" stroke="#2d251c" stroke-width="3.8" stroke-linecap="round"/>' +
      '<path d="M132 146 C139 158 161 158 168 146 C161 150 139 150 132 146 Z" fill="#8c3b28" stroke="#2d251c" stroke-width="3.5" stroke-linejoin="round"/>' +
      '<g fill="none" stroke="#2d251c" stroke-width="3.8">' +
        '<rect x="114" y="110" width="31" height="24" rx="7"/><rect x="155" y="110" width="31" height="24" rx="7"/>' +
        '<line x1="145" y1="121" x2="155" y2="121"/>' +
      '</g>' +
    '</svg>';

  var el = document.createElement('div');
  el.id = 'lecturePromo';
  el.innerHTML =
    '<div class="lp-bubble" role="note">' +
      '<button type="button" class="lp-close" aria-label="閉じる">×</button>' +
      '<a href="lecture.html">' +
        '<span class="lp-new">NEW</span>' +
        '<b>あんちゃんのバーベキュー講座、はじまります。</b>' +
        '<small>2026年は名古屋・東京で開催予定 — 特設ページへ →</small>' +
      '</a>' +
    '</div>' +
    '<a class="lp-fab" href="lecture.html" aria-label="あんちゃんのバーベキュー講座 特設ページ">' +
      FACE_SVG + '<span class="lp-dot" aria-hidden="true"></span>' +
    '</a>';

  var css = document.createElement('style');
  css.textContent =
    '#lecturePromo{position:fixed;right:16px;bottom:16px;z-index:900;display:flex;flex-direction:column;align-items:flex-end;gap:10px;' +
      'font-family:"Noto Sans JP",sans-serif;opacity:0;translate:0 12px;transition:opacity .45s ease,translate .45s ease;}' +
    '#lecturePromo.show{opacity:1;translate:0 0;}' +
    '#lecturePromo .lp-fab{position:relative;display:block;width:64px;height:64px;border-radius:50%;background:#fffdf6;' +
      'box-shadow:0 8px 26px rgba(45,37,28,.28);overflow:hidden;transition:transform .25s ease;}' +
    '#lecturePromo .lp-fab:hover{transform:scale(1.06);}' +
    '#lecturePromo .lp-fab svg{position:absolute;inset:6px 4px 0;width:calc(100% - 8px);}' +
    '#lecturePromo .lp-dot{position:absolute;top:4px;right:4px;width:12px;height:12px;border-radius:50%;background:#d95f3b;border:2px solid #fffdf6;}' +
    '#lecturePromo .lp-bubble{position:relative;background:#fffdf6;border-radius:14px;box-shadow:0 10px 34px rgba(45,37,28,.22);' +
      'max-width:min(300px,calc(100vw - 32px));transition:opacity .35s ease,translate .35s ease;}' +
    '#lecturePromo.folded .lp-bubble{opacity:0;translate:0 8px;pointer-events:none;}' +
    '#lecturePromo .lp-bubble::after{content:"";position:absolute;right:24px;bottom:-7px;width:14px;height:14px;background:#fffdf6;' +
      'transform:rotate(45deg);box-shadow:4px 4px 10px rgba(45,37,28,.08);}' +
    '#lecturePromo .lp-bubble a{display:block;padding:.9rem 2rem .9rem 1.1rem;text-decoration:none;color:#2d251c;}' +
    '#lecturePromo .lp-new{display:inline-block;background:#d95f3b;color:#fff;font-size:.6rem;font-weight:800;letter-spacing:.14em;' +
      'padding:.24rem .65rem;border-radius:100px;margin-bottom:.4rem;}' +
    '#lecturePromo .lp-bubble b{display:block;font-size:.82rem;font-weight:800;line-height:1.55;}' +
    '#lecturePromo .lp-bubble small{display:block;font-size:.7rem;color:#5c5347;line-height:1.5;margin-top:.2rem;}' +
    '#lecturePromo .lp-close{position:absolute;top:2px;right:2px;background:none;border:none;font-size:1rem;color:#8a7a63;' +
      'cursor:pointer;padding:.45rem .6rem;line-height:1;}' +
    '@media (max-width:600px){' +
      '#lecturePromo{right:12px;bottom:12px;}' +
      '#lecturePromo .lp-fab{width:54px;height:54px;}' +
      '#lecturePromo .lp-bubble{max-width:min(240px,calc(100vw - 88px));}' +
      '#lecturePromo .lp-bubble b{font-size:.76rem;}' +
      '#lecturePromo .lp-bubble small{font-size:.66rem;}' +
    '}';
  document.head.appendChild(css);
  document.body.appendChild(el);

  if (collapsed) el.classList.add('folded');
  requestAnimationFrame(function () { requestAnimationFrame(function () { el.classList.add('show'); }); });

  function fold(remember) {
    el.classList.add('folded');
    if (remember) sessionStorage.setItem('lecturePromoClosed', '1');
    clearTimeout(autoFold);
  }
  function unfold() {
    el.classList.remove('folded');
    clearTimeout(autoFold);
  }

  // 数秒で吹き出しを畳んで丸だけに（×で閉じた履歴があれば最初から丸だけ）
  var autoFold = collapsed ? null : setTimeout(function () { fold(false); }, 7000);

  el.querySelector('.lp-close').addEventListener('click', function () { fold(true); });

  var fab = el.querySelector('.lp-fab');
  var hoverable = matchMedia('(hover: hover)').matches;
  if (hoverable) {
    fab.addEventListener('mouseenter', unfold);
    el.addEventListener('mouseleave', function () {
      if (sessionStorage.getItem('lecturePromoClosed')) fold(false);
    });
  } else {
    // タッチ端末: 畳まれているときの初回タップは吹き出しを開くだけ（誤遷移防止）
    fab.addEventListener('click', function (e) {
      if (el.classList.contains('folded')) { e.preventDefault(); unfold(); }
    });
  }
})();
