/* 出張バーベキュー講座（lecture.html）の告知ポップアップ
   - ページ表示時に上部へスライドイン
   - スクロールしたら消える（追いかけない）／×で閉じたらそのセッション中は出さない */
(function () {
  if (sessionStorage.getItem('lecturePromoClosed')) return;
  if (location.pathname.replace(/^\//, '') === 'lecture.html') return;

  var el = document.createElement('div');
  el.id = 'lecturePromo';
  el.innerHTML =
    '<a href="lecture.html">' +
      '<span class="lp-new">NEW</span>' +
      '<span class="lp-text"><b>あんちゃんの出張バーベキュー講座、はじまります。</b><small>2026年は名古屋・東京で開催予定 — 特設ページへ</small></span>' +
      '<span class="lp-go" aria-hidden="true">→</span>' +
    '</a>' +
    '<button type="button" aria-label="閉じる">×</button>';

  var css = document.createElement('style');
  css.textContent =
    '#lecturePromo{position:fixed;top:76px;left:50%;transform:translateX(-50%);z-index:900;display:flex;align-items:center;' +
      'background:#fffdf6;border-radius:14px;box-shadow:0 10px 34px rgba(45,37,28,.22);max-width:min(560px,calc(100vw - 28px));' +
      'font-family:"Noto Sans JP",sans-serif;opacity:0;translate:0 -14px;transition:opacity .45s ease,translate .45s ease;}' +
    '#lecturePromo.show{opacity:1;translate:0 0;}' +
    '#lecturePromo.hide{opacity:0;translate:0 -14px;pointer-events:none;}' +
    '#lecturePromo a{display:flex;align-items:center;gap:.8rem;padding:.85rem 1.1rem;text-decoration:none;color:#2d251c;min-width:0;}' +
    '#lecturePromo .lp-new{background:#d95f3b;color:#fff;font-size:.62rem;font-weight:800;letter-spacing:.14em;padding:.28rem .7rem;border-radius:100px;white-space:nowrap;}' +
    '#lecturePromo .lp-text{display:flex;flex-direction:column;min-width:0;}' +
    '#lecturePromo .lp-text b{font-size:.85rem;font-weight:800;line-height:1.5;}' +
    '#lecturePromo .lp-text small{font-size:.72rem;color:#5c5347;line-height:1.5;}' +
    '#lecturePromo .lp-go{color:#d95f3b;font-weight:800;flex-shrink:0;}' +
    '#lecturePromo button{background:none;border:none;font-size:1.05rem;color:#8a7a63;cursor:pointer;padding:.6rem .8rem;line-height:1;flex-shrink:0;}' +
    '@media (max-width:600px){#lecturePromo{top:66px;}#lecturePromo .lp-text b{font-size:.78rem;}}';
  document.head.appendChild(css);
  document.body.appendChild(el);

  requestAnimationFrame(function () { requestAnimationFrame(function () { el.classList.add('show'); }); });

  function close(remember) {
    el.classList.add('hide');
    if (remember) sessionStorage.setItem('lecturePromoClosed', '1');
    window.removeEventListener('scroll', onScroll);
  }
  el.querySelector('button').addEventListener('click', function () { close(true); });

  // スクロールしたら静かに消える（追いかけて鬱陶しくしない）
  function onScroll() { if (window.scrollY > 350) close(false); }
  window.addEventListener('scroll', onScroll, { passive: true });
})();
