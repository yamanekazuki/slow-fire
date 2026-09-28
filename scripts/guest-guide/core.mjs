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

/** 参加者向けの案内ページ（1ファイル・noindex）。見本=invite/kiba-0829.html */
export function renderGuide({ date, info, venue }) {
  const hasAddr = !!venue?.address;
  const map = venue?.mapUrl || (hasAddr ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(venue.address)}` : "");
  const route = hasAddr ? `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(venue.address)}` : "";
  const row = (k, v) => `<div class="row"><dt>${esc(k)}</dt><dd>${v}</dd></div>`;
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(jpDate(date))} ${esc(info.title)} 当日のご案内</title><meta name="robots" content="noindex,nofollow">
<link href="https://fonts.googleapis.com/css2?family=Zen+Maru+Gothic:wght@500;700;900&display=swap" rel="stylesheet">
<style>
:root{--bg:#f6f1e4;--card:#fffdf6;--ink:#2d251c;--ink2:#5b5044;--muted:#8a8177;--ember:#d95f3b;--ember2:#b74a2c;--soft:#efe8d6;--line:rgba(45,37,28,.12)}
*{box-sizing:border-box;margin:0;padding:0}body{background:var(--bg);color:var(--ink);font-family:'Zen Maru Gothic','Noto Sans JP',sans-serif;line-height:1.8;font-weight:500}
.w{max-width:640px;margin:0 auto;padding:28px 16px 60px}.e{font-size:.66rem;letter-spacing:.28em;color:var(--ember);font-weight:900}
h1{font-size:1.7rem;font-weight:900;line-height:1.35;margin-top:8px}.lead{color:var(--ink2);margin-top:8px}
.when{display:flex;gap:14px;align-items:center;background:var(--card);border-radius:18px;padding:16px 18px;margin-top:18px;box-shadow:0 4px 18px rgba(45,37,28,.06)}
.when b{font-size:2rem;font-weight:900;color:var(--ember2);line-height:1}.when span{font-weight:900}
section{background:var(--card);border-radius:18px;padding:18px;margin-top:14px;box-shadow:0 4px 18px rgba(45,37,28,.06)}
.k{font-size:.62rem;letter-spacing:.26em;color:var(--ember);font-weight:900}h2{font-size:1.1rem;font-weight:900;margin:2px 0 8px}
dl .row{display:grid;grid-template-columns:88px 1fr;gap:10px;padding:8px 0;border-top:1px solid var(--line)}dl .row:first-child{border-top:0}
dt{font-weight:900;font-size:.85rem}dd{font-size:.9rem;color:var(--ink2)}dd b{color:var(--ink)}
.btns{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}.btn{display:inline-block;padding:.6rem 1.1rem;border-radius:100px;background:var(--ember);color:#fff;font-weight:900;text-decoration:none;font-size:.88rem}.btn.sub{background:var(--soft);color:var(--ink)}
.menu{display:flex;flex-wrap:wrap;gap:6px;list-style:none}.menu li{background:var(--soft);border-radius:100px;padding:.25rem .8rem;font-size:.85rem;font-weight:700}
.s{font-size:.76rem;color:var(--muted);margin-top:8px}.notes li{list-style:none;padding:8px 0;border-top:1px solid var(--line)}.notes li:first-child{border-top:0}.notes b{display:block}
.notes span{font-size:.85rem;color:var(--ink2)}.pending{color:var(--ember2);font-weight:900}footer{text-align:center;font-size:.72rem;color:var(--muted);margin-top:24px}
</style></head><body><div class="w">
<p class="e">YORON BBQ — DAY GUIDE</p>
<h1>${esc(jpDate(date))}、お待ちしてます。</h1>
<p class="lead">${esc(info.title)} の当日のご案内です。ざっと目を通してもらえれば大丈夫です。</p>
<div class="when"><b>${esc(date.slice(5).split("-").map(Number).join("/"))}</b><span>${esc(info.start)} 集合<br><small>${esc(info.end)}まで</small></span></div>
<section><p class="k">INFO</p><h2>概要</h2><dl>
${row("日にち", esc(jpDate(date)))}
${row("集合", `<b>${esc(info.start)}</b>に現地へ`)}
${row("場所", hasAddr ? `<b>${esc(venue.address)}</b>` : `<span class="pending">住所はメールでお知らせします</span>`)}
${venue?.landmark ? row("目印", esc(venue.landmark)) : ""}
${info.access ? row("アクセス", esc(info.access)) : ""}
${row("会費", esc(info.fee))}
${row("ホスト", esc(info.hosts))}
</dl>${hasAddr ? `<div class="btns"><a class="btn" href="${esc(map)}">Googleマップで開く</a><a class="btn sub" href="${esc(route)}">ここから経路</a></div>` : ""}</section>
<section><p class="k">NOTE</p><h2>持ち物・当日のこと</h2><ul class="notes">
<li><b>お酒はお好きなものをご持参ください</b></li>
<li><b>煙の匂いがついても気にならない服で</b><span>焼く工程も一緒に楽しみたい方は、エプロンがあると汚れを気にせず動けます。</span></li>
<li><b>お腹をすかせて来てください</b><span>品数はまあまああります。朝ごはんは軽めがおすすめです。</span></li>
<li><b>雨でも大丈夫です</b><span>雨天時も問題なくできるようにしています。</span></li>
<li><b>遅れるとき・アレルギーがあるとき</b><span>案内メールに返信してください。</span></li>
</ul></section>
<footer>YORON BBQ ／ yoron-bbq.com</footer>
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
