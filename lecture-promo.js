/* バーベキュー講座（lecture.html）の告知 v2 — あんちゃんローポリ3Dキャラ版（2026-08-08）
   - スクロール300pxで、あんちゃんキャラが右下からポンと登場（6ポーズをゆっくりクロスフェード＝踊る）
   - 吹き出し=講座告知（NEW＋タイトル＋特設ページリンク）。数秒踊ってウェルカムポーズで静止
   - ×で畳むと丸いあんちゃんボタンに。タップで再登場。セッション中は畳み状態を記憶 */
(function () {
  if (location.pathname.replace(/^\//, '') === 'lecture.html') return;
  try {
    var DIR = '/img/anchan-char/';
    var SEQ = ['pose-wave-t', 'pose-arms-half-t', 'pose-arms-up-t', 'pose-arms-half-t', 'pose-lean-t', 'pose-hands-front-t'].map(function (n) { return DIR + n + '.png'; });
    var REST = DIR + 'pose-present-t.png';
    var collapsed = !!sessionStorage.getItem('lecturePromoClosed');

    var el = document.createElement('div');
    el.id = 'lecturePromo';
    el.innerHTML =
      '<style>' +
      '#lecturePromo{position:fixed;right:16px;bottom:0;z-index:900;display:none;flex-direction:column;align-items:flex-end;font-family:"Noto Sans JP",sans-serif;pointer-events:none}' +
      '#lecturePromo.show{display:flex}' +
      '#lecturePromo [hidden]{display:none!important}' +
      '#lecturePromo .lp-bubble{position:relative;pointer-events:auto;background:#fffdf6;border-radius:14px;box-shadow:0 10px 34px rgba(45,37,28,.22);width:min(280px,calc(100vw - 120px));margin-right:64px;margin-bottom:10px;opacity:0;transform:translateY(10px) scale(.96);transition:opacity .35s ease,transform .35s ease}' +
      '#lecturePromo.open .lp-bubble{opacity:1;transform:none}' +
      '#lecturePromo .lp-bubble:after{content:"";position:absolute;right:-10px;bottom:26px;border:10px solid transparent;border-left-color:#fffdf6;border-right-width:0}' +
      '#lecturePromo .lp-bubble a{display:block;padding:.95rem 2rem .95rem 1.15rem;text-decoration:none;color:#2d251c}' +
      '#lecturePromo .lp-new{display:inline-block;background:#d95f3b;color:#fff;font-size:.6rem;font-weight:800;letter-spacing:.14em;padding:.24rem .65rem;border-radius:100px;margin-bottom:.4rem}' +
      '#lecturePromo .lp-bubble b{display:block;font-size:.82rem;font-weight:800;line-height:1.55}' +
      '#lecturePromo .lp-bubble small{display:block;font-size:.7rem;color:#5c5347;line-height:1.5;margin-top:.2rem}' +
      '#lecturePromo .lp-close{position:absolute;top:2px;right:2px;background:none;border:none;font-size:1rem;color:#8a7a63;cursor:pointer;padding:.45rem .6rem;line-height:1}' +
      '#lecturePromo .lp-char{pointer-events:auto;border:none;background:none;padding:0;cursor:pointer;display:block;transform:translateY(105%);transition:transform .55s cubic-bezier(.34,1.45,.55,1)}' +
      '#lecturePromo.open .lp-char{transform:translateY(0)}' +
      '#lecturePromo .lp-stage{position:relative;display:block;height:128px;width:100px}' +
      '#lecturePromo .lp-stage img{position:absolute;bottom:0;left:50%;transform:translateX(-50%);height:128px;width:auto;filter:drop-shadow(0 6px 14px rgba(45,37,28,.3));opacity:0;transition:opacity .55s ease}' +
      '#lecturePromo .lp-stage img.on{opacity:1}' +
      '#lecturePromo.open .lp-stage{animation:lpBob 2.6s ease-in-out infinite}' +
      '@keyframes lpBob{0%,100%{transform:translateY(0) rotate(0)}25%{transform:translateY(-4px) rotate(-1.2deg)}75%{transform:translateY(-2px) rotate(1.2deg)}}' +
      '#lecturePromo .lp-mini{pointer-events:auto;position:relative;border:2px solid #8c3b28;cursor:pointer;background:#fffdf6;border-radius:999px;width:56px;height:56px;margin-bottom:14px;box-shadow:0 6px 20px rgba(45,37,28,.28);overflow:hidden;padding:0}' +
      '#lecturePromo .lp-mini img{position:absolute;top:3px;left:50%;transform:translateX(-50%);width:46px}' +
      '@media(max-width:600px){#lecturePromo{right:10px}#lecturePromo .lp-bubble{width:min(236px,calc(100vw - 104px));margin-right:48px}#lecturePromo .lp-stage{height:108px;width:84px}#lecturePromo .lp-stage img{height:108px}}' +
      '@media (prefers-reduced-motion: reduce){#lecturePromo .lp-stage{animation:none!important}}' +
      '</style>' +
      '<div class="lp-bubble" hidden>' +
      '<button type="button" class="lp-close" aria-label="閉じる">×</button>' +
      '<a href="lecture.html">' +
      '<span class="lp-new">NEW</span>' +
      '<b>あんちゃんのバーベキュー講座、はじまります。</b>' +
      '<small>2026年は名古屋・東京で開催予定 — 特設ページへ →</small>' +
      '</a></div>' +
      '<button class="lp-char" aria-label="講座のお知らせを開く"><span class="lp-stage"><img alt="あんちゃん" class="on"><img alt="" aria-hidden="true"></span></button>' +
      '<button class="lp-mini" aria-label="講座のお知らせを開く" hidden><img alt="あんちゃん"></button>';
    document.body.appendChild(el);

    var bubble = el.querySelector('.lp-bubble');
    var charBtn = el.querySelector('.lp-char');
    var layers = charBtn.querySelectorAll('.lp-stage img');
    var miniBtn = el.querySelector('.lp-mini');
    var cur = 0, frame = 0, danceTimer = null, danceEnd = null;

    function show(src) {
      var next = 1 - cur;
      layers[next].src = src;
      layers[next].classList.add('on');
      layers[cur].classList.remove('on');
      cur = next;
    }
    function startDance(ms) {
      clearInterval(danceTimer); clearTimeout(danceEnd);
      danceTimer = setInterval(function () { frame = (frame + 1) % SEQ.length; show(SEQ[frame]); }, 950);
      danceEnd = setTimeout(function () { clearInterval(danceTimer); show(REST); }, ms);
    }
    function open() {
      if (!layers[cur].src) layers[cur].src = SEQ[0];
      miniBtn.hidden = true; bubble.hidden = false; charBtn.hidden = false;
      el.classList.add('show');
      requestAnimationFrame(function () { requestAnimationFrame(function () { el.classList.add('open'); }); });
      startDance(6200);
    }
    function fold(remember) {
      clearInterval(danceTimer); clearTimeout(danceEnd);
      el.classList.remove('open');
      setTimeout(function () {
        bubble.hidden = true; charBtn.hidden = true;
        miniBtn.hidden = false;
        miniBtn.querySelector('img').src = REST;
      }, 350);
      if (remember) sessionStorage.setItem('lecturePromoClosed', '1');
    }
    el.querySelector('.lp-close').addEventListener('click', function () { fold(true); });
    miniBtn.addEventListener('click', open);
    charBtn.addEventListener('click', function () { if (bubble.hidden) { bubble.hidden = false; el.classList.add('open'); } startDance(3000); });

    var shown = false;
    function onScroll() {
      if (shown) return;
      if (window.scrollY > 300) {
        shown = true;
        var pre = new Image();
        pre.onload = pre.onerror = function () {
          layers[cur].src = SEQ[0];
          if (collapsed) { el.classList.add('show'); bubble.hidden = true; charBtn.hidden = true; miniBtn.hidden = false; miniBtn.querySelector('img').src = REST; }
          else open();
        };
        pre.src = SEQ[0];
        SEQ.slice(1).concat([REST]).forEach(function (s) { (new Image()).src = s; });
        window.removeEventListener('scroll', onScroll);
      }
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  } catch (e) { /* ベストエフォート */ }
})();
