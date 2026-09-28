// 参加者への「当日のご案内」便の中身（純粋関数だけ。本番に触らない）
//   依頼（2026-09-28 山根さん）: 開催5日前に参加者へ連絡したい。その前日に運営（山根・うえたく・あんちゃん・ヨッシー）へ
//   メールで「そろそろ連絡を」と知らせ、参加者に見てもらう案内ページも自動で作る（8/29 木場公園の当日案内ページが見本）。
//   住所など公開しない情報は guest-guide-local.json（gitignore・miniだけ）から入れる。このリポジトリは公開なので。
import { esc } from "../../../../tools/lib/report-mail.mjs";

export const NOTIFY_DAYS_BEFORE = 5; // 開催5日前から、山根さんへ「送っていい？」の確認を出す（2026-09-28 山根さん）
export const MENU_DAYS_BEFORE = 7; // 開催1週間前に、うえたく・山根さんへメニュー相談のメール（2026-09-28 山根さん）
export const SEND_FN = "https://asia-northeast1-cook-log-df240.cloudfunctions.net/bbqGuestGuideSend";

/** YYYY-MM-DD 同士の日数差（暦日。時刻は使わない） */
export function daysBetween(fromYmd, toYmd) {
  const a = Date.UTC(...fromYmd.split("-").map((n, i) => (i === 1 ? +n - 1 : +n)));
  const b = Date.UTC(...toYmd.split("-").map((n, i) => (i === 1 ? +n - 1 : +n)));
  return Math.round((b - a) / 86400000);
}

export function addDays(ymd, n) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

const WD = ["日", "月", "火", "水", "木", "金", "土"];
export function jpDate(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return `${m}月${d}日（${WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}）`;
}

/**
 * 今日見る回を選ぶ。開催5日前〜前日で、申込がある回（まだ送っていない人がいるかは pendingOf で見る）。
 */
export function dueEvents({ today, eventIds, regsByEvent, ledger }) {
  return eventIds.filter((id) => /^\d{4}-\d{2}-\d{2}$/.test(id)).filter((id) => {
    const left = daysBetween(today, id);
    if (left < 1 || left > NOTIFY_DAYS_BEFORE) return false;
    return (regsByEvent[id] || []).length > 0;
  }).sort();
}

/** 申込を名簿にする（確定だけ・キャンセル待ちは別に数える） */
export function roster(regs) {
  const ok = regs.filter((r) => r.status !== "waitlist" && r.status !== "cancelled");
  const wait = regs.filter((r) => r.status === "waitlist");
  const people = ok.reduce((s, r) => s + Math.min(Math.max(parseInt(r.party, 10) || 1, 1), 4), 0);
  return { ok, wait, people };
}

/** 参加者に送る文面（運営が自分のメールから送る。mailto の本文にも使う） */
export function participantMailText({ date, info, venue, guideUrl }) {
  const addr = venue?.address ? venue.address : "【住所をここに】";
  return [
    `YORON BBQ です。${jpDate(date)}のバーベキュー、お申し込みありがとうございます。`,
    "当日のご案内をお送りします。",
    "",
    `日時：${jpDate(date)} ${info.start}に現地集合${info.end ? `（${info.end}まで）` : ""}`,
    `場所：${addr}`,
    venue?.landmark ? `目印：${venue.landmark}` : null,
    info.access ? `アクセス：${info.access}` : null,
    `会費：${info.fee}`,
    "雨天時も問題なくできるようにしています。",
    `持ち物：${info.bring}`,
    "",
    `地図と当日のことはこちらにまとめました：`,
    guideUrl,
    "",
    "アレルギーや苦手な食材、当日の遅れなどは、このメールに返信してください。",
    "お会いできるのを楽しみにしています。",
  ].filter((l) => l !== null).join("\n");
}

const CHAR = "https://yoron-bbq.com/report/2026-09-26/img/bbq/";
/** ホスト2人のキャラを章ごとに置く（info.hostVoices: [{at, name, char, text}]・at=place/bring/time/more）。左右交互 */
function voiceAt(info, at) {
  const v = (info.hostVoices || []).filter((h) => h.at === at);
  return v.map((h) => `<div class="voice${h.right ? " r" : ""}"><img src="${CHAR}${esc(h.char)}.svg" alt="${esc(h.name)}"><div class="sb">${esc(h.text)}<span class="lb">${esc(h.name)}</span></div></div>`).join("");
}

/**
 * 参加者向けの案内ページ（しおり）。見本=venue-kiba.html（9/5 木場公園の「来る人用」案内）の型:
 *   まず全体図（地図＋駅から左→右のルート）→ 数字3つ → 来る人へ（持ってくるもの／要らないもの）→ 時間のイメージ
 * venue = { address, label, landmark, stations:[{name, line, walkMin, meters}], measuredAt }（guest-guide-local.json）
 */
export function renderGuide({ date, info, venue }) {
  const hasAddr = !!venue?.address;
  const map = venue?.mapUrl || (hasAddr ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(venue.address)}` : "");
  const route = hasAddr ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(venue.address)}&travelmode=walking` : "";
  const embed = hasAddr ? `https://maps.google.com/maps?q=${encodeURIComponent(venue.address)}&z=15&hl=ja&output=embed` : "";
  const st = (venue?.stations || []).slice(0, 2);
  const md = date.slice(5).split("-").map(Number).join("/");
  const place = venue?.label || "会場";
  const routeHtml = st.map((s, i) => `<div class="route">
  <div class="st"><div class="t">${esc(s.name)}</div><div class="m">${esc(s.line || "")}</div></div>
  <div class="arrow">→</div>
  <div class="st"><div class="t">徒歩${esc(s.walkLabel || `約${s.walkMin}分`)}</div></div>
  <div class="arrow">→</div>
  <div class="st goal"><div class="t">会場</div><div class="m">${i === 0 ? "ここに集合" : "こちらからも歩ける"}</div></div>
</div>`).join("");
  const near = st[0];
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(jpDate(date))} ${esc(info.title)} 当日のご案内</title><meta name="robots" content="noindex,nofollow">
<link href="https://fonts.googleapis.com/css2?family=Zen+Maru+Gothic:wght@500;700;900&family=Noto+Sans+JP:wght@400;500;700;900&display=swap" rel="stylesheet">
<style>
:root{--ember:#d95f3b;--ember-deep:#8c3b28;--amber:#e89b3f;--ink:#2d251c;--ink-soft:#5c5347;--paper:#f6f1e4;--card:#fffdf6;--line:rgba(45,37,28,.18);--ok:#3d7a4a;--ok-bg:#e9f3ea;--navy:#2b3a55;--sand:#efe7d4}
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:"Noto Sans JP",sans-serif;background:var(--paper);color:var(--ink);line-height:1.75;-webkit-font-smoothing:antialiased;padding-bottom:60px}
.wrap{max-width:760px;margin:0 auto;padding:0 16px}
header{padding:22px 0 8px}
.logo{font-family:"Zen Maru Gothic",sans-serif;font-weight:900;font-size:.95rem;letter-spacing:.08em;color:var(--ink)}
.logo small{color:var(--ember);font-size:.6rem;letter-spacing:.22em;margin-left:.5em}
h1{font-family:"Zen Maru Gothic",sans-serif;font-size:1.5rem;font-weight:900;line-height:1.45;margin-top:12px}
.lead{color:var(--ink-soft);font-size:.92rem;margin-top:8px}.lead b{color:var(--ink)}
.k{font-size:.68rem;letter-spacing:.3em;color:var(--ember);font-weight:800;margin:30px 0 8px}
h2{font-family:"Zen Maru Gothic",sans-serif;font-size:1.22rem;font-weight:900;line-height:1.5;margin-bottom:12px}
h3{font-size:1rem;font-weight:900;margin:4px 0 6px}
p{font-size:.93rem}
.card{background:var(--card);border-radius:18px;padding:1.1rem 1.15rem;margin-bottom:12px}
.card.navy{background:var(--navy);color:#f3ead9}
.card.navy .big{font-family:"Zen Maru Gothic",sans-serif;font-size:1.9rem;font-weight:900;color:var(--amber);line-height:1.1}
.card.navy .big small{font-size:.9rem;color:#f3ead9;margin-left:.2em}
.card.navy .l{font-size:.78rem;opacity:.85;margin-top:4px}
.card.sand{background:var(--sand)}
ul{list-style:none}
li{padding:.45rem 0;border-top:1px dashed var(--line);font-size:.92rem}li:first-child{border-top:0}
li b{display:block;font-weight:900}li span{display:block;color:var(--ink-soft);font-size:.85rem;line-height:1.6}
.addr{font-family:"Zen Maru Gothic",sans-serif;font-weight:900;font-size:1.1rem;line-height:1.5}
.pending{color:var(--ember-deep);font-weight:900}
.gmap{border:0;width:100%;height:280px;border-radius:14px;display:block;background:#e8e2d2;margin-top:10px}
.route{display:flex;align-items:stretch;padding:4px 0 8px;margin-top:10px}
.route .st{flex:1 1 0;min-width:0;background:var(--card);border-radius:14px;padding:.7rem .5rem;text-align:center}
.route .st.goal{background:var(--ember);color:#fff}.route .st.goal .m{color:#fff}
.route .st .t{font-weight:900;font-size:.86rem;line-height:1.35}
.route .st .m{font-size:.7rem;color:var(--ink-soft);margin-top:2px;line-height:1.4}
.route .arrow{flex:0 0 22px;display:flex;align-items:center;justify-content:center;font-weight:900;color:var(--ember)}
.stat-row{display:flex;gap:10px;flex-wrap:wrap}.stat-row .card{flex:1 1 150px;margin:0}
.btn{display:inline-block;background:var(--ember);color:#fff;font-weight:800;padding:.6rem 1.1rem;border-radius:100px;font-size:.85rem;text-decoration:none}
.btn.ghost{background:transparent;border:1.5px solid var(--line);color:var(--ink-soft)}
.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
.chk li{display:grid;grid-template-columns:22px 1fr;gap:8px;align-items:start}
.chk i{display:block;width:16px;height:16px;border:2px solid var(--line);border-radius:5px;margin-top:6px}
.chk li.no i{border-style:dashed;opacity:.6}
.tl li{display:grid;grid-template-columns:78px 1fr;gap:10px;align-items:start;padding:.6rem 0}
.tl .time{font-family:"Zen Maru Gothic",sans-serif;font-weight:900;color:var(--ember-deep);font-size:.95rem;line-height:1.5}
.src{font-size:.74rem;color:var(--ink-soft);margin-top:8px}
.links{display:grid;gap:8px}
.lk{display:flex;gap:12px;align-items:center;background:var(--card);border-radius:14px;padding:8px;text-decoration:none;color:var(--ink)}
.lk img{width:84px;height:60px;object-fit:cover;border-radius:10px;flex:none;background:var(--sand)}
.lk b{display:block;font-size:.92rem;font-weight:900}.lk span{display:block;font-size:.78rem;color:var(--ink-soft);line-height:1.5}
.voice{display:flex;align-items:flex-end;gap:8px;margin:4px 0 12px}.voice.r{flex-direction:row-reverse}
.hero{position:relative;margin:12px -16px 0;height:240px;overflow:hidden}
.hero img{width:100%;height:100%;object-fit:cover;object-position:center 45%}
.hero .badge{position:absolute;left:16px;bottom:14px;background:var(--ember);color:#fff;font-family:"Zen Maru Gothic",sans-serif;font-weight:900;font-size:1.5rem;line-height:1;padding:.5rem .8rem;border-radius:14px}
.hero .badge small{font-size:.8rem;margin-left:.3em}
@media(min-width:792px){.hero{margin:12px 0 0;border-radius:18px;height:300px}}
.voice img{width:58px;height:auto;flex:none}
.voice .sb{position:relative;background:#fff;border:2px solid var(--ink);border-radius:16px;padding:9px 12px 7px;font-size:.84rem;font-weight:700;line-height:1.65}
.voice .lb{display:block;font-size:.62rem;letter-spacing:.12em;color:var(--ink-soft);font-weight:900;margin-top:3px}
footer{margin-top:36px;font-size:.76rem;color:var(--ink-soft)}
@media (max-width:480px){h1{font-size:1.3rem}.card.navy .big{font-size:1.6rem}}
</style></head><body><div class="wrap">
<header><div class="logo">YORON BBQ<small>DAY GUIDE</small></div>\n${info.heroImg ? `<div class="hero"><img src="${esc(info.heroImg)}" alt="グリルで焼いている鶏"><span class="badge">${esc(md)}<small>${esc(jpDate(date).replace(/^.*（(.)）$/, "$1"))}曜</small></span></div>` : ""}
<h1>${esc(jpDate(date))}、お待ちしてます。</h1>
<p class="lead">${esc(info.title)} のしおりです。読むのは<b>「どこに行くか」「何を持ってくるか」「何時ごろか」</b>の3つだけ。あとは食べる係でお願いします。</p></header>

<p class="k">00 / まず全体図</p>
<h2>${near ? `${esc(near.name)}から歩いて${esc(near.walkLabel || `約${near.walkMin}分`)}。${esc(info.start)}に集合` : `${esc(info.start)}に集合`}</h2>
<div class="card">
  <h3>場所</h3>
  ${hasAddr ? `<p class="addr">${esc(venue.address)}</p>${venue.note ? `<p style="color:var(--ink-soft);font-size:.85rem;margin-top:4px">${esc(venue.note)}</p>` : ""}${venue.landmark ? `<p style="color:var(--ink-soft);font-size:.85rem">目印：${esc(venue.landmark)}</p>` : ""}` : `<p class="pending">住所はメールでお知らせします</p>`}
  ${hasAddr ? `<iframe class="gmap" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="${esc(embed)}" title="会場の地図"></iframe>
  <div class="actions"><a class="btn" href="${esc(route)}">ここから経路を出す</a><a class="btn ghost" href="${esc(map)}">Googleマップで開く</a></div>` : ""}
</div>
${voiceAt(info, "place")}\n${routeHtml ? `<p style="font-weight:900;font-size:.85rem;margin-top:14px">来かた（左から右へ）</p>${routeHtml}` : (info.access ? `<p class="src">アクセス：${esc(info.access)}</p>` : "")}

<div class="stat-row" style="margin-top:6px">
  <div class="card navy"><div class="big">${esc(info.start.split("〜")[0])}<small>集合</small></div><div class="l">${esc(info.start)}に現地へ</div></div>
  ${near ? `<div class="card navy"><div class="big">${esc(String(near.walkMin))}<small>${near.walkLabel ? "分ちょっと" : "分"}</small></div><div class="l">${esc(near.name)}から徒歩</div></div>` : ""}
  <div class="card navy"><div class="big">${esc((info.fee.match(/[\d,]+円/) || [info.fee])[0])}</div><div class="l">${esc(info.fee.replace(/^[\d,]+円\s*/, ""))}</div></div>
</div>

<p class="k">01 / 来る人へ</p>
<h2>ほぼ手ぶらで来てください</h2>\n${voiceAt(info, "bring")}
<div class="card">
  <h3>持ってくるもの</h3>
  <ul class="chk">
    <li><i></i><div><b>お酒が飲みたい方は、お好きなものをご持参ください</b></div></li>\n    <li><i></i><div><b>ソフトドリンクも、好きなものがあれば気軽にお持ちください</b><span>こちらでも用意しています</span></div></li>
    <li><i></i><div><b>煙の匂いがついても気にならない服</b><span>グリルに近寄りすぎなければ大丈夫です</span></div></li>
    <li><i></i><div><b>エプロン（焼く工程も楽しみたい人だけ）</b><span>一緒に火のそばに立てます。もちろん食べる専門でも大歓迎</span></div></li>
  </ul>
</div>
<div class="card sand">
  <h3>持ってこなくていいもの</h3>
  <ul class="chk">
    <li class="no"><i></i><div><b>食材・炭・機材</b><span>すべてこちらで用意します</span></div></li>
  </ul>
</div>
<div class="card">
  <ul>
    <li><b>雨でも大丈夫です</b><span>室内もあり、テントもあるので、雨天時も問題なくできるようにしています。</span></li>
    <li><b>お子さま連れも歓迎です</b><span>お子さまがいらっしゃる場合は、事前に教えてください。メニューを変えようと思います。</span></li>
    <li><b>遅れるとき・アレルギーがあるとき</b><span>案内メールに返信してください。</span></li>
  </ul>
</div>

<p class="k">02 / 時間のイメージ</p>
<h2>来た人から、焼き上がった順につまんでいく</h2>\n${voiceAt(info, "time")}
<div class="card"><ul class="tl">
  <li><span class="time">${esc(info.start.split("〜")[0])}</span><div><b>${esc(info.start)}に集合</b><span>ホストは先に火を起こして待っています</span></div></li>
  <li><span class="time">そのあと</span><div><b>焼き上がった順に食べはじめ</b><span>時間のかかる肉は後半のお楽しみ</span></div></li>
${info.end ? `  <li><span class="time">${esc(info.end)}</span><div><b>お開き</b></div></li>\n` : ""}</ul></div>

<p class="k">03 / よかったら</p>
<h2>YORON BBQ のこと、少しだけ</h2>\n${voiceAt(info, "more")}
<p style="color:var(--ink-soft);font-size:.88rem;margin-bottom:10px">蓋を閉めた炭のグリルで、じっくり火を通すバーベキューをやっています。読まなくても当日はまったく困りません。気が向いたらどうぞ。</p>
<div class="links">
  <a class="lk" href="https://yoron-bbq.com/team.html"><img src="https://yoron-bbq.com/images/team-selfie.jpg" alt=""><div><b>3人の物語</b><span>火を囲む文化を、はじめた3人のこと</span></div></a>
  <a class="lk" href="https://yoron-bbq.com/academy.html"><img src="https://yoron-bbq.com/images/thumbs/academy.jpg" alt=""><div><b>学ぶ</b><span>火の置き方や温度のこと。焼いてみたくなった人へ</span></div></a>
  <a class="lk" href="https://yoron-bbq.com/menu.html"><img src="https://yoron-bbq.com/images/back-ribs.jpg" alt=""><div><b>これまで焼いてきたメニュー</b><span>スペアリブや杉板サーモンなど。作り方と、なぜそう焼くのか</span></div></a>
  <a class="lk" href="https://yoron-bbq.com/context.html"><img src="https://yoron-bbq.com/images/thumbs/context.jpg" alt=""><div><b>YORON BBQって？</b><span>大事にしていることを、まとめたページ</span></div></a>
</div>

<footer>ホスト：${esc(info.hosts)}　／　YORON BBQ ・ yoron-bbq.com</footer>
</div></body></html>`;
}

/** まだ案内を送っていない参加者（確定・メールあり・sentTo に無い）。同じアドレスは1通だけ */
export function pendingOf(ros, sentTo = []) {
  const done = new Set(sentTo.map((e) => String(e).toLowerCase()));
  const out = [];
  for (const r of ros.ok) {
    const email = String(r.email || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || done.has(email) || out.some((p) => p.email === email)) continue;
    out.push({ name: r.name || "", email });
  }
  return out;
}
export const pendingKey = (pending) => pending.map((p) => p.email).sort().join(",");

/** 参加者へ送るメール（HTML）。文面＋案内ページのボタン */
export function participantMailHtml({ text, guideUrl }) {
  const body = esc(text).replace(esc(guideUrl), `<a href="${esc(guideUrl)}" style="color:#b74a2c;font-weight:700">${esc(guideUrl)}</a>`).replace(/\n/g, "<br>");
  return `<div style="font-family:'Hiragino Sans','Noto Sans JP',sans-serif;color:#2d251c;max-width:600px;line-height:1.8;font-size:15px">
<p style="margin:0 0 16px"><a href="${esc(guideUrl)}" style="display:inline-block;background:#d95f3b;color:#fff;padding:10px 20px;border-radius:100px;font-weight:900;text-decoration:none">当日のしおりを開く</a></p>
<p style="margin:0">${body}</p>
<p style="font-size:12px;color:#8a8177;margin-top:18px">YORON BBQ ／ yoron-bbq.com</p></div>`;
}

/** 山根さんへの確認メール（HTML）。押すと確認画面→「送る」で参加者へ */
export function confirmMailHtml({ date, info, guideUrl, pending, sentCount, approveUrl, text }) {
  const list = pending.map((p) => `<li>${esc(p.name)}（${esc(p.email)}）</li>`).join("");
  return `<div style="font-family:'Hiragino Sans','Noto Sans JP',sans-serif;color:#2d251c;max-width:640px;line-height:1.7">
<p style="font-size:18px;font-weight:900;margin:0">${esc(jpDate(date))}の参加者${pending.length}名へ、当日の案内を送っていいですか？</p>
<p style="color:#5b5044">${esc(info.title)}${sentCount ? `。すでに${sentCount}名には送ってあり、今回はその後に申し込んだ方の分です` : ""}。</p>
<p><a href="${esc(approveUrl)}" style="display:inline-block;background:#d95f3b;color:#fff;padding:12px 22px;border-radius:100px;font-weight:900;text-decoration:none">確認して送る</a></p>
<p style="font-size:12px;color:#8a8177">開くと送り先の一覧が出ます。そこで「送る」を押したときだけ送ります（開いただけでは送りません）。直したいところがあれば、送らずにClaudeへ伝えてください。</p>
<p><a href="${esc(guideUrl)}" style="color:#b74a2c;font-weight:700">送る案内ページを見る</a></p>
<p style="font-weight:900;margin-top:16px">送り先</p><ul>${list}</ul>
<p style="font-weight:900;margin-top:16px">送る文面</p>
<pre style="white-space:pre-wrap;background:#f6f1e4;border-radius:10px;padding:12px;font-family:inherit;font-size:13px">${esc(text)}</pre>
<p style="font-size:12px;color:#8a8177">YORON BBQ 当日案内便（開催${NOTIFY_DAYS_BEFORE}日前から・送信後は運営メンバーにもお知らせします）</p></div>`;
}

/** メニュー相談を出す回（開催7日前〜前日・申込がある・まだ出していない） */
export function menuDueEvents({ today, eventIds, regsByEvent, ledger }) {
  return eventIds.filter((id) => /^\d{4}-\d{2}-\d{2}$/.test(id)).filter((id) => {
    const left = daysBetween(today, id);
    return left >= 1 && left <= MENU_DAYS_BEFORE && !ledger[id]?.menuAskedAt && (regsByEvent[id] || []).length > 0;
  }).sort();
}

/** うえたく・山根さんへのメニュー相談メール（やまちゃんの言葉で。確定の料理と、相談ページへのボタン） */
export function menuConsultMail({ date, info, fixed, pickUrl, people }) {
  // info.menuNote があればそれを使う（例:「サーモンと丸鶏は、僕が前日に仕入れて持っていくね。」）
  const md = jpDate(date);
  const fixedNames = Object.keys(fixed).map((n) => n.replace(/（[^）]*）/g, ""));
  const buyers = Object.entries(fixed).filter(([, v]) => v).map(([n, v]) => `${n.replace(/（[^）]*）/g, "")}は${v}`);
  const lines = [
    `うえたくへ`,
    ``,
    `${md}の${info.title}、メニューを決めよう！いま申込は${people}名です。`,
    `月1BBQは、はじめて来てくれる方が多いので、${fixedNames.join("・")}は確定でいこうと思ってます。${info.menuNote || (buyers.length ? `（${buyers.join("、")}）` : "")}`,
    ``,
    `ほかは、下のページでやりたいものに「やりたい」を付けてください。2人の「やりたい」はその場で見えて、買い物リストにもそのまま入ります。`,
    pickUrl,
    ``,
    `やまちゃん`,
  ];
  const text = lines.join("\n");
  const html = `<div style="font-family:'Hiragino Sans','Noto Sans JP',sans-serif;color:#2d251c;max-width:600px;line-height:1.8;font-size:15px">
<p style="margin:0">${esc(lines.slice(0, 5).join("\n")).replace(/\n/g, "<br>")}</p>
<p style="margin:14px 0 4px;font-weight:900">確定</p><p style="margin:0">${fixedNames.map(esc).join("・")}</p>
<p style="margin:16px 0"><a href="${esc(pickUrl)}" style="display:inline-block;background:#d95f3b;color:#fff;padding:11px 22px;border-radius:100px;font-weight:900;text-decoration:none">メニュー相談を開く</a></p>
<p style="margin:0">${esc(lines[5])}</p>
<p style="margin:14px 0 0">やまちゃん</p>
<p style="font-size:12px;color:#8a8177;margin-top:18px">YORON BBQ の自動便（開催1週間前に届きます）</p></div>`;
  return { subject: `【YORON BBQ】${md}のメニュー、どうする？`, text, html };
}
