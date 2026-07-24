/* =====================================================================
   anchan.js — あんちゃんキャラクター共通部品（YORON BBQ COMMUNITY）
   使い方: ページに <script src="anchan.js" defer></script> を読み込み、
   置きたい場所に
     <div data-anchan="point" data-say="ここがポイント！"></div>
   を置くだけ。ポーズ: wave / point / guide / peek / think / cheer / tongs
   オプション: data-flip（左右反転） data-size="s|m|l"（既定 m）
   ===================================================================== */
(function () {
  "use strict";

  /* ---------- 共通パーツ ---------- */
  // アフロ＋花＋顔（表情差し替え可）。中心はだいたい x=150。
  function head(face) {
    return `
    <g class="an-head">
      <!-- afro -->
      <g fill="#3a2a23" stroke="#2d251c" stroke-width="4" stroke-linejoin="round">
        <circle cx="104" cy="66" r="33"/>
        <circle cx="150" cy="54" r="36"/>
        <circle cx="196" cy="68" r="32"/>
        <circle cx="78" cy="102" r="28"/>
        <circle cx="222" cy="104" r="27"/>
        <circle cx="150" cy="90" r="50" stroke="none"/>
        <circle cx="100" cy="124" r="24" stroke="none"/>
        <circle cx="202" cy="126" r="23" stroke="none"/>
      </g>
      <g fill="none" stroke="#5a4437" stroke-width="3.5" stroke-linecap="round" opacity=".9">
        <path d="M110 58 C116 52 125 49 132 51"/>
        <path d="M184 60 C191 59 198 62 202 68"/>
      </g>
      <!-- flower -->
      <g transform="translate(206 56)">
        <g fill="#e89b3f" stroke="#2d251c" stroke-width="3">
          <circle cx="0" cy="-10" r="6.5"/><circle cx="9.5" cy="-3" r="6.5"/>
          <circle cx="6" cy="8" r="6.5"/><circle cx="-6" cy="8" r="6.5"/><circle cx="-9.5" cy="-3" r="6.5"/>
        </g>
        <circle cx="0" cy="0" r="5" fill="#d95f3b" stroke="#2d251c" stroke-width="3"/>
      </g>
      <!-- face base -->
      <ellipse cx="150" cy="126" rx="46" ry="43" fill="#f2c49b" stroke="#2d251c" stroke-width="4"/>
      <circle cx="104" cy="129" r="8" fill="#f2c49b" stroke="#2d251c" stroke-width="4"/>
      <circle cx="196" cy="129" r="8" fill="#f2c49b" stroke="#2d251c" stroke-width="4"/>
      <circle cx="102" cy="143" r="6.5" fill="none" stroke="#c5a059" stroke-width="3.5"/>
      <circle cx="198" cy="143" r="6.5" fill="none" stroke="#c5a059" stroke-width="3.5"/>
      <circle cx="121" cy="135" r="9" fill="#f0906b" opacity=".35"/>
      <circle cx="179" cy="135" r="9" fill="#f0906b" opacity=".35"/>
      <g fill="#c98d5f">
        <circle cx="117" cy="132" r="1.4"/><circle cx="123" cy="129" r="1.4"/><circle cx="127" cy="134" r="1.4"/>
        <circle cx="173" cy="134" r="1.4"/><circle cx="178" cy="129" r="1.4"/><circle cx="183" cy="132" r="1.4"/>
      </g>
      <path d="M149 130 C147.5 134 149 137 152 138" fill="none" stroke="#2d251c" stroke-width="3" stroke-linecap="round"/>
      ${face}
    </g>`;
  }

  // 表情バリエーション
  const FACES = {
    smile: `
      <path d="M124 122 C128 116 137 116 141 122" fill="none" stroke="#2d251c" stroke-width="3.8" stroke-linecap="round"/>
      <path d="M159 122 C163 116 172 116 176 122" fill="none" stroke="#2d251c" stroke-width="3.8" stroke-linecap="round"/>
      <path d="M132 146 C139 158 161 158 168 146 C161 150 139 150 132 146 Z" fill="#8c3b28" stroke="#2d251c" stroke-width="3.5" stroke-linejoin="round"/>`,
    open: `
      <path d="M124 122 C128 116 137 116 141 122" fill="none" stroke="#2d251c" stroke-width="3.8" stroke-linecap="round"/>
      <path d="M159 122 C163 116 172 116 176 122" fill="none" stroke="#2d251c" stroke-width="3.8" stroke-linecap="round"/>
      <ellipse cx="150" cy="150" rx="13" ry="10" fill="#8c3b28" stroke="#2d251c" stroke-width="3.5"/>
      <path d="M142 155 C147 158 153 158 158 155" fill="#f28d78"/>`,
    wink: `
      <circle cx="132" cy="120" r="4.5" fill="#2d251c"/>
      <path d="M159 121 C163 116 172 116 176 121" fill="none" stroke="#2d251c" stroke-width="3.8" stroke-linecap="round"/>
      <path d="M134 148 C142 156 158 156 166 148" fill="none" stroke="#2d251c" stroke-width="4" stroke-linecap="round"/>`,
    think: `
      <circle cx="132" cy="120" r="4.5" fill="#2d251c"/>
      <circle cx="168" cy="120" r="4.5" fill="#2d251c"/>
      <path d="M140 149 C146 152 156 152 162 148" fill="none" stroke="#2d251c" stroke-width="4" stroke-linecap="round"/>`
  };

  // 胴体（Tシャツ＋YORONエプロン）。腕は各ポーズで上描きする。
  function torso() {
    return `
    <g class="an-torso">
      <path d="M116 170 C114 200 111 232 113 268 L187 268 C189 232 186 200 184 170 C172 178 128 178 116 170 Z" fill="#fffdf6" stroke="#2d251c" stroke-width="4" stroke-linejoin="round"/>
      <path d="M128 182 L172 182 C179 204 182 238 181 268 L119 268 C118 238 121 204 128 182 Z" fill="#d95f3b" stroke="#2d251c" stroke-width="4" stroke-linejoin="round"/>
      <path d="M128 182 C128 178 137 173 150 173 C163 173 172 178 172 182" fill="none" stroke="#2d251c" stroke-width="4" stroke-linecap="round"/>
      <path d="M135 228 L165 228 L163.5 248 L136.5 248 Z" fill="#b74a2c" stroke="#2d251c" stroke-width="3" stroke-linejoin="round"/>
      <text x="150" y="213" text-anchor="middle" font-family="sans-serif" font-weight="800" font-size="11" fill="#fffdf6" letter-spacing="1">YORON</text>
    </g>`;
  }

  function legs() {
    return `
    <g class="an-legs">
      <line x1="133" y1="268" x2="133" y2="300" stroke="#2d251c" stroke-width="4.5" stroke-linecap="round"/>
      <line x1="167" y1="268" x2="167" y2="300" stroke="#2d251c" stroke-width="4.5" stroke-linecap="round"/>
      <path d="M133 300 C123 300 118 306 118 310 L138 310 L138 300 Z" fill="#2d251c"/>
      <path d="M167 300 C177 300 182 306 182 310 L162 310 L162 300 Z" fill="#2d251c"/>
      <ellipse cx="150" cy="314" rx="58" ry="7" fill="#2d251c" opacity=".08"/>
    </g>`;
  }

  const ARM_STROKE = 'fill="#f2c49b" stroke="#2d251c" stroke-width="4" stroke-linejoin="round"';
  const HAND = 'fill="#f2c49b" stroke="#2d251c" stroke-width="4"';

  /* ---------- ポーズ定義（viewBox 0 0 300 320） ---------- */
  const POSES = {
    // 手を振ってあいさつ
    wave: () => `
      ${legs()}${torso()}
      <path d="M118 186 C100 180 88 164 84 144 L92 140 C97 158 108 170 124 176 Z" ${ARM_STROKE}/>
      <circle cx="88" cy="140" r="10" ${HAND}/>
      <path d="M182 186 C196 194 204 210 206 228 L197 231 C195 216 188 204 178 197 Z" ${ARM_STROKE}/>
      <circle cx="202" cy="231" r="10" ${HAND}/>
      ${head(FACES.open)}
      <g class="an-spark" stroke="#e89b3f" stroke-width="3" stroke-linecap="round">
        <path d="M62 110 L62 122 M56 116 L68 116"/>
        <path d="M238 150 L238 160 M233 155 L243 155"/>
      </g>`,

    // 指さし（ポイント解説）
    point: () => `
      ${legs()}${torso()}
      <path d="M118 186 C106 196 100 212 100 230 L109 232 C110 217 115 205 124 198 Z" ${ARM_STROKE}/>
      <circle cx="104" cy="233" r="10" ${HAND}/>
      <path d="M182 184 C204 176 222 160 232 140 L224 134 C215 151 200 164 178 172 Z" ${ARM_STROKE}/>
      <circle cx="229" cy="136" r="9" ${HAND}/>
      <path d="M234 130 L252 116" stroke="#2d251c" stroke-width="7" stroke-linecap="round"/>
      <path d="M234 130 L252 116" stroke="#f2c49b" stroke-width="4" stroke-linecap="round"/>
      ${head(FACES.smile)}
      <g class="an-spark" stroke="#e89b3f" stroke-width="3" stroke-linecap="round">
        <path d="M262 100 L262 112 M256 106 L268 106"/>
      </g>`,

    // 「どうぞ」と手のひらで案内
    guide: () => `
      ${legs()}${torso()}
      <path d="M118 186 C106 196 100 212 100 230 L109 232 C110 217 115 205 124 198 Z" ${ARM_STROKE}/>
      <circle cx="104" cy="233" r="10" ${HAND}/>
      <path d="M182 186 C206 188 224 200 234 218 L226 224 C217 209 202 200 180 198 Z" ${ARM_STROKE}/>
      <ellipse cx="233" cy="222" rx="13" ry="9" transform="rotate(28 233 222)" ${HAND}/>
      <g fill="none" stroke="#2d251c" stroke-width="2.5" stroke-linecap="round" opacity=".65">
        <path d="M228 216 L240 210"/><path d="M231 221 L244 216"/>
      </g>
      ${head(FACES.smile)}`,

    // ひょっこり顔だけ（セクションの隅から）
    peek: () => `
      <g transform="translate(0 60)">
        <path d="M96 190 C96 240 110 262 150 262 C190 262 204 240 204 190 Z" fill="#d95f3b" stroke="#2d251c" stroke-width="4" stroke-linejoin="round"/>
        <path d="M108 196 C90 192 78 180 72 164 L80 158 C86 172 96 182 112 186 Z" ${ARM_STROKE}/>
        <circle cx="76" cy="158" r="10" ${HAND}/>
        ${head(FACES.wink)}
      </g>`,

    // 考え中（ほっぺに手）
    think: () => `
      ${legs()}${torso()}
      <path d="M118 186 C106 196 100 212 100 230 L109 232 C110 217 115 205 124 198 Z" ${ARM_STROKE}/>
      <circle cx="104" cy="233" r="10" ${HAND}/>
      <path d="M182 186 C198 182 208 172 212 158 L204 152 C200 163 192 171 178 174 Z" ${ARM_STROKE}/>
      <circle cx="207" cy="152" r="10" ${HAND}/>
      ${head(FACES.think)}
      <g fill="none" stroke="#8a8177" stroke-width="3" stroke-linecap="round" opacity=".85">
        <circle cx="234" cy="98" r="4"/><circle cx="248" cy="80" r="6"/>
      </g>`,

    // 両手を上げて応援
    cheer: () => `
      ${legs()}${torso()}
      <path d="M120 178 C104 166 94 148 92 126 L101 124 C104 143 112 158 126 168 Z" ${ARM_STROKE}/>
      <circle cx="96" cy="122" r="10" ${HAND}/>
      <path d="M180 178 C196 166 206 148 208 126 L199 124 C196 143 188 158 174 168 Z" ${ARM_STROKE}/>
      <circle cx="204" cy="122" r="10" ${HAND}/>
      ${head(FACES.open)}
      <g class="an-spark" stroke="#e89b3f" stroke-width="3" stroke-linecap="round">
        <path d="M70 96 L70 108 M64 102 L76 102"/>
        <path d="M230 96 L230 108 M224 102 L236 102"/>
        <path d="M150 30 L150 40 M145 35 L155 35"/>
      </g>`,

    // トング＋ドラムスティック（ヒーローのミニ版）
    tongs: () => `
      ${legs()}${torso()}
      <path d="M118 186 C106 196 100 212 100 230 L109 232 C110 217 115 205 124 198 Z" ${ARM_STROKE}/>
      <circle cx="104" cy="233" r="10" ${HAND}/>
      <path d="M182 188 C202 192 216 204 223 220 L215 226 C208 212 196 202 180 199 Z" ${ARM_STROKE}/>
      <circle cx="219" cy="223" r="9" ${HAND}/>
      <g stroke="#5b5044" stroke-width="4" stroke-linecap="round" fill="none">
        <path d="M224 218 L252 197"/><path d="M227 227 L256 210"/>
      </g>
      <circle cx="225" cy="222" r="4" fill="#5b5044"/>
      <g transform="rotate(-18 258 200)">
        <ellipse cx="258" cy="199" rx="16" ry="11" fill="#c47a3a" stroke="#2d251c" stroke-width="3"/>
        <path d="M271 194 L281 187" stroke="#f3ead9" stroke-width="5" stroke-linecap="round"/>
        <circle cx="283" cy="186" r="4" fill="#f3ead9" stroke="#2d251c" stroke-width="2.5"/>
      </g>
      ${head(FACES.wink)}`
  };

  /* ---------- スタイル注入 ---------- */
  const CSS = `
  .anchan-spot { display:flex; align-items:flex-end; gap:.4rem; margin:1.6rem 0; }
  .center .anchan-spot { justify-content:center; text-align:left; }
  .anchan-spot.an-flip { flex-direction:row-reverse; }
  .anchan-spot .an-fig { flex:0 0 auto; width:130px; }
  .anchan-spot.an-s .an-fig { width:96px; }
  .anchan-spot.an-l .an-fig { width:170px; }
  .anchan-spot .an-fig svg { width:100%; height:auto; display:block; animation:anFloat 5s ease-in-out infinite; }
  .anchan-spot.an-flip .an-fig svg { transform:scaleX(-1); }
  .anchan-spot.an-flip .an-fig svg text { transform:scaleX(-1); transform-box:fill-box; transform-origin:center; }
  .anchan-spot .an-bubble {
    position:relative; max-width:420px; margin-bottom:2.2rem;
    background:#fffdf6; border:2px solid #2d251c; border-radius:16px;
    padding:.75rem 1rem; font-size:.88rem; font-weight:700; line-height:1.65;
    color:#2d251c; box-shadow:3px 3px 0 rgba(45,37,28,.12);
  }
  .anchan-spot .an-bubble::after, .anchan-spot .an-bubble::before {
    content:""; position:absolute; bottom:14px; border-style:solid;
  }
  .anchan-spot:not(.an-flip) .an-bubble::after { left:-11px; border-width:8px 12px 8px 0; border-color:transparent #fffdf6 transparent transparent; }
  .anchan-spot:not(.an-flip) .an-bubble::before { left:-14px; border-width:9px 13px 9px 0; border-color:transparent #2d251c transparent transparent; }
  .anchan-spot.an-flip .an-bubble::after { right:-11px; border-width:8px 0 8px 12px; border-color:transparent transparent transparent #fffdf6; }
  .anchan-spot.an-flip .an-bubble::before { right:-14px; border-width:9px 0 9px 13px; border-color:transparent transparent transparent #2d251c; }
  .anchan-spot .an-bubble b, .anchan-spot .an-bubble strong { color:#d95f3b; }
  .anchan-spot .an-name { display:block; margin-top:.3rem; font-size:.66rem; letter-spacing:.12em; color:#8a8177; font-weight:800; }
  .an-spark { animation:anTwinkle 2.4s ease-in-out infinite; transform-origin:center; }
  @keyframes anFloat { 0%,100%{ translate:0 0; } 50%{ translate:0 -6px; } }
  @keyframes anTwinkle { 0%,100%{ opacity:.35; } 50%{ opacity:1; } }
  @media (max-width:640px){
    .anchan-spot { gap:.25rem; }
    .anchan-spot .an-fig { width:96px; }
    .anchan-spot .an-bubble { font-size:.8rem; margin-bottom:1.2rem; }
  }
  @media (prefers-reduced-motion:reduce){
    .anchan-spot .an-fig svg, .an-spark { animation:none; }
  }`;

  /* ---------- レンダリング ---------- */
  function render() {
    const spots = document.querySelectorAll("[data-anchan]");
    if (!spots.length) return;

    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    spots.forEach(function (el) {
      const pose = POSES[el.dataset.anchan] ? el.dataset.anchan : "wave";
      const say = el.dataset.say || "";
      const size = el.dataset.size === "s" ? "an-s" : el.dataset.size === "l" ? "an-l" : "";
      const flip = el.hasAttribute("data-flip") ? "an-flip" : "";
      el.className = ("anchan-spot " + size + " " + flip).trim();
      el.innerHTML =
        '<div class="an-fig"><svg viewBox="0 0 300 320" role="img" aria-label="あんちゃん（YORON BBQのFounder・石原杏莉のキャラクター）">' +
        POSES[pose]() +
        "</svg></div>" +
        (say
          ? '<div class="an-bubble">' + say + '<span class="an-name">ANCHAN — FOUNDER</span></div>'
          : "");
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", render);
  } else {
    render();
  }
})();
