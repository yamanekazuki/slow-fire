// 参加者への「当日のご案内」便の中身（純粋関数だけ。本番に触らない）
//   依頼（2026-09-28 山根さん）: 開催5日前に参加者へ連絡したい。その前日に運営（山根・うえたく・あんちゃん・ヨッシー）へ
//   メールで「そろそろ連絡を」と知らせ、参加者に見てもらう案内ページも自動で作る（8/29 木場公園の当日案内ページが見本）。
//   住所など公開しない情報は guest-guide-local.json（gitignore・miniだけ）から入れる。このリポジトリは公開なので。
import { esc } from "../../../../tools/lib/report-mail.mjs";

export const NOTIFY_DAYS_BEFORE = 6; // 運営へ知らせる日（参加者への連絡は5日前）
export const CONTACT_DAYS_BEFORE = 5;

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
 * 今日知らせる回を選ぶ。開催6日前〜前日のうち、まだ送っていない回（取りこぼしても開催前なら拾う）。
 * 参加者が0人の回は知らせない。
 */
export function dueEvents({ today, eventIds, regsByEvent, ledger }) {
  return eventIds.filter((id) => /^\d{4}-\d{2}-\d{2}$/.test(id)).filter((id) => {
    const left = daysBetween(today, id);
    if (left < 1 || left > NOTIFY_DAYS_BEFORE) return false;
    if (ledger[id]?.sentAt) return false;
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
    `日時：${jpDate(date)} ${info.start}に現地集合（${info.end}まで）`,
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
  <div class="st"><div class="t">徒歩 約${esc(String(s.walkMin))}分</div><div class="m">約${esc(String(s.meters))}m</div></div>
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
footer{margin-top:36px;font-size:.76rem;color:var(--ink-soft)}
@media (max-width:480px){h1{font-size:1.3rem}.card.navy .big{font-size:1.6rem}}
</style></head><body><div class="wrap">
<header><div class="logo">YORON BBQ<small>DAY GUIDE</small></div>
<h1>${esc(jpDate(date))}、お待ちしてます。</h1>
<p class="lead">${esc(info.title)} のしおりです。読むのは<b>「どこに行くか」「何を持ってくるか」「何時ごろか」</b>の3つだけ。あとは食べる係でお願いします。</p></header>

<p class="k">00 / まず全体図</p>
<h2>${near ? `${esc(near.name)}から歩いて約${esc(String(near.walkMin))}分。${esc(info.start)}に集合` : `${esc(info.start)}に集合`}</h2>
<div class="card">
  <h3>場所</h3>
  ${hasAddr ? `<p class="addr">${esc(venue.address)}</p><p style="color:var(--ink-soft);font-size:.85rem">${esc(place)}${venue.landmark ? `｜${esc(venue.landmark)}` : ""}</p>` : `<p class="pending">住所はメールでお知らせします</p>`}
  ${hasAddr ? `<iframe class="gmap" loading="lazy" referrerpolicy="no-referrer-when-downgrade" src="${esc(embed)}" title="会場の地図"></iframe>
  <div class="actions"><a class="btn" href="${esc(route)}">ここから経路を出す</a><a class="btn ghost" href="${esc(map)}">Googleマップで開く</a></div>` : ""}
</div>
${routeHtml ? `<p style="font-weight:900;font-size:.85rem;margin-top:14px">来かた（左から右へ）</p>${routeHtml}` : (info.access ? `<p class="src">アクセス：${esc(info.access)}</p>` : "")}

<div class="stat-row" style="margin-top:6px">
  <div class="card navy"><div class="big">${esc(info.start.split("〜")[0])}<small>集合</small></div><div class="l">${esc(info.start)}に現地へ。${esc(info.end)}まで</div></div>
  ${near ? `<div class="card navy"><div class="big">約${esc(String(near.walkMin))}<small>分</small></div><div class="l">${esc(near.name)}から徒歩（約${esc(String(near.meters))}m）</div></div>` : ""}
  <div class="card navy"><div class="big">${esc((info.fee.match(/[\d,]+円/) || [info.fee])[0])}</div><div class="l">${esc(info.fee.replace(/^[\d,]+円\s*/, ""))}</div></div>
</div>

<p class="k">01 / 来る人へ</p>
<h2>お酒だけ持って、手ぶらで来てください</h2>
<div class="card">
  <h3>持ってくるもの</h3>
  <ul class="chk">
    <li><i></i><div><b>お酒はお好きなものをご持参ください</b></div></li>
    <li><i></i><div><b>煙の匂いがついても気にならない服</b><span>グリルに近寄りすぎなければ大丈夫です</span></div></li>
    <li><i></i><div><b>エプロン（焼く工程も楽しみたい人だけ）</b><span>一緒に火のそばに立てます。もちろん食べる専門でも大歓迎</span></div></li>
  </ul>
</div>
<div class="card sand">
  <h3>持ってこなくていいもの</h3>
  <ul class="chk">
    <li class="no"><i></i><div><b>食材・ソフトドリンク・炭・機材</b><span>すべてこちらで用意します</span></div></li>
  </ul>
</div>
<div class="card">
  <ul>
    <li><b>雨でも大丈夫です</b><span>雨天時も問題なくできるようにしています。</span></li>
    <li><b>お子さま連れも歓迎です</b><span>お子さま用のメニューではない点だけご了承ください。</span></li>
    <li><b>遅れるとき・アレルギーがあるとき</b><span>案内メールに返信してください。</span></li>
  </ul>
</div>

<p class="k">02 / 時間のイメージ</p>
<h2>来た人から、焼き上がった順につまんでいく</h2>
<div class="card"><ul class="tl">
  <li><span class="time">${esc(info.start.split("〜")[0])}</span><div><b>${esc(info.start)}に集合</b><span>ホストは先に火を起こして待っています</span></div></li>
  <li><span class="time">そのあと</span><div><b>焼き上がった順に食べはじめ</b><span>時間のかかる肉は後半のお楽しみ</span></div></li>
  <li><span class="time">${esc(info.end.replace(/頃$/, ""))}頃</span><div><b>お開き</b></div></li>
</ul></div>

<footer>${venue?.measuredAt ? `駅からの時間と距離は、OpenStreetMapの徒歩ルートで計測したもの（${esc(venue.measuredAt)}）。<br>` : ""}ホスト：${esc(info.hosts)}　／　YORON BBQ ・ yoron-bbq.com</footer>
</div></body></html>`;
}

/** 運営へのメール本文（HTML）。参加者一覧と、1タップで参加者へ送れる mailto を載せる */
export function adminMailHtml({ date, info, venue, guideUrl, ros, mailto, text }) {
  const left = CONTACT_DAYS_BEFORE;
  const warn = venue?.address ? "" : `<p style="background:#fbe9e2;border-radius:10px;padding:10px 12px;font-weight:700;color:#b74a2c">住所がまだ登録されていません。会場の住所を山根さんに伝えてもらえれば、案内ページと文面に入れて送り直します（それまでは文面の【住所をここに】を書き換えて送ってください）。</p>`;
  const people = ros.ok.map((r) => `<tr><td style="padding:6px 8px;border-top:1px solid #eee"><b>${esc(r.name || "")}</b></td><td style="padding:6px 8px;border-top:1px solid #eee">${esc(String(r.party || 1))}名</td><td style="padding:6px 8px;border-top:1px solid #eee;font-size:12px">${esc(r.email || "")}</td><td style="padding:6px 8px;border-top:1px solid #eee;font-size:12px;color:#5b5044">${esc(r.note || "")}</td></tr>`).join("");
  return `<div style="font-family:'Hiragino Sans','Noto Sans JP',sans-serif;color:#2d251c;max-width:640px;line-height:1.7">
<p style="font-size:18px;font-weight:900;margin:0">${esc(jpDate(date))}の参加者 ${ros.people}名へ、明日（${left}日前）までに当日の案内を送りましょう</p>
<p style="color:#5b5044">${esc(info.title)}。案内ページと、そのまま送れる文面を用意しました。</p>
${warn}
<p><a href="${esc(mailto)}" style="display:inline-block;background:#d95f3b;color:#fff;padding:10px 18px;border-radius:100px;font-weight:900;text-decoration:none">参加者全員にメールを作る（BCC・文面入り）</a></p>
<p><a href="${esc(guideUrl)}" style="color:#b74a2c;font-weight:700">参加者向けの案内ページを見る</a>（URLを知っている人だけが開けます・検索には出ません）</p>
<p style="font-weight:900;margin-top:18px">参加者（確定 ${ros.ok.length}件・${ros.people}名${ros.wait.length ? `／キャンセル待ち ${ros.wait.length}件` : ""}）</p>
<table style="border-collapse:collapse;width:100%;font-size:13px">${people}</table>
<p style="font-weight:900;margin-top:18px">送る文面</p>
<pre style="white-space:pre-wrap;background:#f6f1e4;border-radius:10px;padding:12px;font-family:inherit;font-size:13px">${esc(text)}</pre>
<p style="font-size:12px;color:#8a8177">この便は開催の${NOTIFY_DAYS_BEFORE}日前に運営メンバーへ自動で届きます（YORON BBQ 当日案内便）。</p></div>`;
}

export function buildMailto({ bcc, subject, body }) {
  return `mailto:?bcc=${encodeURIComponent(bcc.join(","))}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}
