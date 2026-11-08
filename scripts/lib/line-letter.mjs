// YORON BBQ 公式LINE「登録者向けのお便り」の判定と文面づくり（本番に触らない純関数だけ。line-tips.mjs とテストが共用）
//
// 2026-11-08 山根さん依頼（11/5定例「LINE自動投稿の見直し」の決定事項）:
//   - 運営4人のグループに流すのはアジェンダ・議事録・BBQレポートだけ。それ以外の発信は登録者（公式LINEの友だち）へ回す
//   - 登録者向けは週1回まで。毎回、山根さんがメールで原稿を見て、運営LINEで「配信OK」と返したものだけ送る
//   - 登録者には「AIが書いている」と思われない文面にする（やまちゃんの口調・仕組みの話を出さない）
//   - 文面はテンプレートと事前に書いた原稿だけで作る（送信時のLLM呼び出しゼロ）

export const SITE = "https://yoron-bbq.com";
export const DEFAULT_CAPACITY = 15; // 月1BBQの定員（申込がこれ以上なら案内しない）
export const GROUP_RESERVE = 60; // 運営グループ（4人×アジェンダ・議事録・レポート等）のために残しておく月の通数
export const DRAFT_TTL_DAYS = 7; // 原稿はこの日数で取り下げ（承認済みでも、送れないまま古くなった原稿は送らない）

const DOW = "日月火水木金土";
const p2 = (n) => String(n).padStart(2, "0");

/** 実時刻 Date → 日本時間の YYYY-MM-DD（Dateはずらさず、文字列化だけJST） */
export function ymdJst(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

/** YYYY-MM-DD の日数差（b - a） */
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/** 日本時間の週（月曜はじまり）の月曜日を YYYY-MM-DD で。週1回の上限の数え方に使う */
export function weekKeyJst(d = new Date()) {
  const ymd = ymdJst(d);
  const dow = new Date(`${ymd}T00:00:00Z`).getUTCDay(); // 0=日
  const back = (dow + 6) % 7;
  const m = new Date(Date.parse(`${ymd}T00:00:00Z`) - back * 86400000);
  return `${m.getUTCFullYear()}-${p2(m.getUTCMonth() + 1)}-${p2(m.getUTCDate())}`;
}

/** 「11月22日（日）」 */
export function mdDow(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return `${m}月${d}日（${DOW[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}）`;
}

/**
 * 承認の言葉かどうか。「配信OK」「配信して」などの短い文だけ（レポートOKや別件の「OK」は拾わない）
 */
export function isLetterApprovalText(text) {
  const t = String(text || "").normalize("NFKC").replace(/^@\S+/, "").replace(/[\s　]+/g, "")
    .replace(/[!！。.、～〜]+$/g, "").replace(/(です|だよ|で大丈夫|でお願いします|でお願い|お願いします|お願い)$/g, "");
  if (/[?？]/.test(t)) return false;
  return /^(この)?(LINE)?(配信|はいしん)(は|も)?(OK|ok|Ok|オッケー|おっけー|おけ|オーケー|いいよ)$/i.test(t)
    || /^(この)?(LINE)?配信(して|しよう|しちゃって)$/i.test(t);
}

/** 原稿を送ったあと、承認者が運営グループで「配信OK」と言ったか。approverUserIds が空なら必ず null（フェイルクローズ） */
export function findLetterApproval(logs, sinceIso, { approverUserIds = [], groupId = "" } = {}) {
  if (!approverUserIds.length || !groupId || !sinceIso) return null;
  return (logs || []).find((l) => approverUserIds.includes(l.userId) && l.groupId === groupId
    && String(l.createdAt) > String(sinceIso) && isLetterApprovalText(l.text)) || null;
}

// ---------------------------------------------------------------------------
// 文面のチェック（登録者に「仕組み」や「AI」を感じさせない）
// ---------------------------------------------------------------------------
const BANNED = [
  [/AI|ＡＩ|人工知能/i, "AI"], [/自動/, "自動"], [/生成/, "生成"], [/Claude|ChatGPT|GPT|Gemini/i, "AIの名前"],
  [/ボット|bot\b/i, "ボット"], [/プロンプト/, "プロンプト"], [/テスト配信|【テスト】/, "テスト表記"],
  [/undefined|null|NaN|\$\{/, "埋め込み漏れ"],
];
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

/** 送ってはいけない文面の理由を返す（空配列＝送ってよい） */
export function lintLetter(text) {
  const t = String(text || "");
  const errs = [];
  if (!t.trim()) errs.push("本文が空");
  for (const [re, name] of BANNED) if (re.test(t)) errs.push(`「${name}」を含む`);
  if (EMOJI.test(t)) errs.push("絵文字を含む");
  if (t.length > 1200) errs.push(`長すぎる（${t.length}字）`);
  return errs;
}

// ---------------------------------------------------------------------------
// 何を送るか選ぶ
// ---------------------------------------------------------------------------

/**
 * 今回のお便りに入れる中身を選ぶ。
 *   本題（1つ）: ①次の月1BBQの案内（14〜45日先・未案内・定員未満） ②公開済みのBBQレポート（開催21日以内・未案内） ③BBQのコツ（原稿の残りから順に）
 *   おまけ（最大2本）: 前回のお便り以降（初回は直近10日）にサイトへ載せた読みもの・スパイス大全
 * @param {object} p
 * @param {string} p.today YYYY-MM-DD（日本時間）
 * @param {{date:string,kind:string,no?:string,place?:string}[]} p.events next-events.js の EVENTS
 * @param {Record<string,number>} p.regs 開催日→申込人数
 * @param {{date:string,title:string}[]} p.reports 公開済みレポート
 * @param {{date:string,title:string,url:string}[]} p.posts 読みもの・スパイス大全
 * @param {{id:string,type:string,text:string,sentAt?:string|null}[]} p.tips 事前に書いた原稿
 * @param {Record<string,string>} p.announced 案内済みのキー→日時
 * @param {string} [p.lastSentYmd] 前回のお便りの日（YYYY-MM-DD）
 */
export function pickContent({ today, events = [], regs = {}, capacity = DEFAULT_CAPACITY, reports = [], posts = [], tips = [], announced = {}, lastSentYmd = "" }) {
  let main = null;
  const ev = events.filter((e) => e.kind === "bbq" && e.date >= today)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .find((e) => {
      const d = daysBetween(today, e.date);
      return d >= 14 && d <= 45 && !announced[`event:${e.date}`] && (regs[e.date] || 0) < capacity && !/調整中/.test(e.place || "");
    });
  if (ev) main = { kind: "event", key: `event:${ev.date}`, event: ev, regs: regs[ev.date] || 0, capacity };

  if (!main) {
    const rp = reports.filter((r) => !announced[`report:${r.date}`] && daysBetween(r.date, today) >= 0 && daysBetween(r.date, today) <= 21)
      .sort((a, b) => (a.date < b.date ? 1 : -1))[0];
    if (rp) main = { kind: "report", key: `report:${rp.date}`, report: rp };
  }
  if (!main) {
    const tip = tips.find((t) => t.type === "tip" && !t.sentAt && !announced[`tip:${t.id}`]); // activity（活動報告）は日付・人数が古くなるので使わない
    if (tip) main = { kind: "tip", key: `tip:${tip.id}`, tip };
  }

  const since = lastSentYmd || ymdAdd(today, -10);
  const extras = posts.filter((p) => p.date > since && p.date <= today && !announced[`post:${p.url}`])
    .sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 2)
    .map((p) => ({ kind: "post", key: `post:${p.url}`, post: p }));

  // 本題が無くても、新しい読みものがあれば読みものを本題にして送る
  if (!main && extras.length) return { main: { kind: "posts", key: null }, extras };
  if (!main) return null;
  return { main, extras };
}

export function ymdAdd(ymd, days) {
  const d = new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86400000);
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`;
}

/** レポートの<title>から「 | YORON BBQ レポート」を外す */
export function reportTitle(html) {
  const m = String(html || "").match(/<title>([^<]*)<\/title>/i);
  return m ? m[1].replace(/\s*[|｜].*$/, "").trim() : "";
}

// ---------------------------------------------------------------------------
// 文面（やまちゃんの口調。仕組みの話・AIの気配を出さない）
// ---------------------------------------------------------------------------
export function composeLetter(pick) {
  if (!pick) return "";
  const { main, extras = [] } = pick;
  const parts = [];
  if (main.kind === "event") {
    const e = main.event;
    parts.push(`やまちゃんです！次の月1バーベキューのお知らせです。\n\n${mdDow(e.date)}、${e.place}でやります。蓋付きのグリルでじっくり焼くスタイルなので、はじめての方も大歓迎です。\n\n申込はこちらから\n${SITE}/event.html\n\n一緒に火を囲みましょう！`);
  } else if (main.kind === "report") {
    const r = main.report;
    const [, m, d] = r.date.split("-").map(Number);
    parts.push(`やまちゃんです！${m}月${d}日のバーベキューのレポートをまとめました。${r.title ? `\n\n「${r.title}」` : ""}\n\n当日の写真と、焼いたものを載せています。よかったらのぞいてみてください。\n${SITE}/report/${r.date}/`);
  } else if (main.kind === "tip") {
    parts.push(main.tip.text.trim());
  } else if (main.kind === "posts") {
    parts.push("やまちゃんです！サイトに新しい読みものを載せました。");
  }
  if (extras.length) {
    const head = main.kind === "posts" ? "" : "サイトにも新しい読みものを載せています。\n";
    parts.push(head + extras.map((x) => `・${x.post.title}\n${x.post.url}`).join("\n"));
  }
  return parts.join("\n\n");
}

/** 月の残り通数で、今回の一斉配信（友だち数ぶん消費）を送ってよいか */
export function quotaAllows({ limit, used, recipients, reserve = GROUP_RESERVE }) {
  if (limit == null || limit === "none") return { ok: true, left: Infinity };
  const left = Number(limit) - Number(used || 0);
  return { ok: left - Number(recipients || 0) >= reserve, left };
}

/**
 * 今回やること（台帳と今日の状態から決める。副作用なし）
 *   send: 承認済みの原稿を送る / expire: 期限切れの原稿を取り下げる / draft: 新しい原稿を作ってメール / wait: 何もしない / stuck: 配信途中で止まった原稿がある
 */
export function decide({ ledger, now = new Date(), approval = null }) {
  const week = weekKeyJst(now);
  const drafts = ledger.drafts || [];
  const sentThisWeek = drafts.some((d) => d.status === "sent" && d.sentAt && weekKeyJst(new Date(d.sentAt)) === week);
  // 配信の途中で止まった原稿（LINEが受け取ったか分からない）は、二重配信を避けるため人が確かめるまで何もしない
  const sending = drafts.find((d) => d.status === "sending");
  if (sending) return { action: "stuck", draft: sending };
  const waiting = drafts.filter((d) => d.status === "waiting").sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0] || null;
  if (waiting) {
    // 猶予はまる1週間＝火18時の原稿は翌週火18時の便まで「配信OK」を待つ（その便でOKがあれば送る）。
    // 半日の幅は実行時刻の数秒のずれ用。承認済みでもそれより古い原稿は送らない
    const age = (now.getTime() - Date.parse(waiting.createdAt)) / 86400000;
    const lastRun = age >= DRAFT_TTL_DAYS - 0.5;
    if (age >= DRAFT_TTL_DAYS + 0.5 || (lastRun && !approval)) return { action: "expire", draft: waiting };
    if (approval) {
      if (!sentThisWeek) return { action: "send", draft: waiting };
      return lastRun ? { action: "expire", draft: waiting } : { action: "wait", reason: "今週はもう送った（承認済みの原稿は来週送る）", draft: waiting };
    }
    return { action: "wait", reason: "承認待ち", draft: waiting };
  }
  if (sentThisWeek) return { action: "wait", reason: "今週はもう送った" };
  if (drafts.some((d) => weekKeyJst(new Date(d.createdAt)) === week && d.status !== "sent")) return { action: "wait", reason: "今週の原稿は取り下げ済み" };
  return { action: "draft" };
}
