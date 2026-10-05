// =============================================================================
// レポートメールの「サイト名」と「対象期間」の正本（2026-10-05 山根さん指示）
// -----------------------------------------------------------------------------
// 「日次なのか週次なのか、直近28日なのか分からない」を無くすための共通部品。
//   - SITES      … 3サイトの正式名・URL・何のサイトか（件名・見出しは必ずここの name を使う）
//   - range      … 「n日前〜m日前」を実日付のラベルにする（GA4の 28daysAgo〜yesterday と同じ数え方）
//   - aboutBox   … メール冒頭の「このメールについて」（どのサイト／届く頻度／数字の期間）
// 日付はJSTの暦日（YYYY-MM-DD文字列）で扱う。+9hずらしたDateは作らない。
// ※ yoron-bbq と bbq-site に同じ内容を置いている（GitHub Actions から ~/dev/tools を読めないため）。直すときは両方。
// =============================================================================

export const SITES = {
  slowfire: { name: "SLOW FIRE", url: "an-bbq.jp", what: "バーベキュー用品のショップと、読み物（JOURNAL）のサイト" },
  guide: { name: "与論島ガイド", url: "yoron-bbq.web.app", what: "与論島の旅行情報（レンタカー・宿・ビーチなど）のサイト" },
  community: { name: "YORON BBQコミュニティ", url: "yoron-bbq.com", what: "月1回のバーベキューの会の、入会・申込・レポートのサイト" },
};

const WD = "日月火水木金土";

/** いまのJSTの日付（YYYY-MM-DD） */
export function todayJst(now = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** 暦日の足し引き（YYYY-MM-DD → YYYY-MM-DD） */
export function addDays(ymd, n) {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

/** 10/4（日） */
export function md(ymd, { weekday = true } = {}) {
  const d = new Date(`${ymd}T00:00:00Z`);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}${weekday ? `（${WD[d.getUTCDay()]}）` : ""}`;
}

/**
 * 今日から数えて fromDaysAgo日前〜toDaysAgo日前 の期間。
 * 例: range(28, 1) = GA4の「28daysAgo〜yesterday」= 28日間
 * label: 「9/7（日）〜10/4（土）の28日間」／ short: 「9/7〜10/4の28日間」／ 1日だけなら「10/4（土）の1日分」
 */
export function range(fromDaysAgo, toDaysAgo, now = new Date()) {
  const today = todayJst(now);
  const start = addDays(today, -fromDaysAgo);
  const end = addDays(today, -toDaysAgo);
  const days = fromDaysAgo - toDaysAgo + 1;
  const one = days === 1;
  return {
    start, end, days,
    label: one ? `${md(start)}の1日分` : `${md(start)}〜${md(end)}の${days}日間`,
    short: one ? `${md(start, { weekday: false })}の1日分` : `${md(start, { weekday: false })}〜${md(end, { weekday: false })}の${days}日間`,
  };
}

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * メール冒頭の「このメールについて」。
 * rows: [["数字の期間", "9/7（日）〜10/4（土）の28日間"], ...]
 */
export function aboutBox({ site, cadence, rows = [] }) {
  const all = [
    ["どのサイト", `<b>${esc(site.name)}</b>（${esc(site.url)}）＝${esc(site.what)}`],
    ["届く頻度", esc(cadence)],
    ...rows.map(([k, v]) => [esc(k), esc(v)]),
  ];
  const tr = all.map(([k, v]) => `<tr>
      <td style="font-size:12px;color:#666;padding:5px 10px 5px 0;white-space:nowrap;vertical-align:top">${k}</td>
      <td style="font-size:13px;color:#1b1b1b;padding:5px 0;line-height:1.7">${v}</td></tr>`).join("");
  return `<div style="background:#f7f5f0;border:1px solid #e7e2d6;border-radius:8px;padding:12px 14px;margin:0 0 16px">
    <div style="font-size:12px;font-weight:800;color:#444;margin-bottom:4px">このメールについて</div>
    <table role="presentation" style="border-collapse:collapse">${tr}</table>
  </div>`;
}
