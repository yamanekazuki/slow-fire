// 魔法のかまど（タイガー魔法瓶「魔法のかまどごはん」）の炊き方の段取り（2026-11-24 山根さん・あんちゃん依頼）
// ページ kamado.html とテスト scripts/test/kamado-core.test.mjs の両方から読む。画面やタイマーには触らない純粋な計算だけ。
//
// 手順の正本＝山根さんの実地の手順（2026-11-24）:
//   前半 1分半ごとに新聞紙1本 ×6本（合数に関係なく同じ）→ 後半 1分ごとに1本 ×合数で変わる本数
//   → 10分蒸らす → 仕上げに1本（1分）→ 5分蒸らす
// 新聞紙1本＝朝日・毎日などの新聞1枚を半分にして丸めたもの。右・左の穴に交互に入れる。

/** 後半（1分ごと）の本数の目安。3合=6・4合=8・5合=10は山根さんの実績、2合=4は1合ごとに2本増える流れからの仮置き（山根さん了承） */
export const LATE_COUNT = { 2: 4, 3: 6, 4: 8, 5: 10 };
export const EARLY_COUNT = 6;
export const EARLY_SEC = 90;
export const LATE_SEC = 60;
export const REST1_SEC = 600;
export const FINISH_SEC = 60;
export const REST2_SEC = 300;
export const GO_LIST = [2, 3, 4, 5];

/** 合数（と後半の本数の上書き）から、1手ずつの段取りを作る */
export function buildPlan(go, lateOverride) {
  if (!GO_LIST.includes(go)) throw new Error(`合数は${GO_LIST.join("・")}のどれか: ${go}`);
  const late = Number.isInteger(lateOverride) && lateOverride >= 1 && lateOverride <= 20 ? lateOverride : LATE_COUNT[go];
  const steps = [];
  let n = 0;
  let at = 0;
  const side = () => (n % 2 === 1 ? "右" : "左"); // 1本目=右、2本目=左…と交互
  const burn = (sec, phase) => { n += 1; steps.push({ kind: "burn", no: n, side: side(), sec, phase, at }); at += sec; };
  for (let i = 0; i < EARLY_COUNT; i++) burn(EARLY_SEC, "前半");
  for (let i = 0; i < late; i++) burn(LATE_SEC, "後半");
  steps.push({ kind: "rest", sec: REST1_SEC, phase: "蒸らし", label: "10分蒸らす（何も入れない）", at }); at += REST1_SEC;
  burn(FINISH_SEC, "仕上げ");
  steps.push({ kind: "rest", sec: REST2_SEC, phase: "蒸らし", label: "5分蒸らす（何も入れない）", at }); at += REST2_SEC;
  return { go, late, sheets: n, totalSec: at, steps };
}

/** 始めてからの経過秒 → 今どの手か（終わっていれば done） */
export function stepAt(plan, elapsedSec) {
  if (elapsedSec >= plan.totalSec) return { done: true, index: plan.steps.length, left: 0 };
  let i = plan.steps.length - 1;
  while (i > 0 && plan.steps[i].at > elapsedSec) i--;
  const s = plan.steps[i];
  return { done: false, index: i, left: Math.ceil(s.at + s.sec - elapsedSec) };
}

/** 1手の指示を、画面と読み上げ用の言葉にする */
export function sayStep(s) {
  if (!s) return "炊き上がりです。ふたを開けて、全体をさっくり混ぜてください。";
  if (s.kind === "rest") return s.label.replace(/（.*）/, "") + "。新聞紙は入れずに待ちます。";
  return `${s.no}本目。${s.side}の穴に入れて、火をつけてください。`;
}

export const fmt = (sec) => `${Math.floor(sec / 60)}:${String(Math.max(0, sec % 60)).padStart(2, "0")}`;

export const RESULTS = ["かため", "ちょうど", "やわらかめ"];
export const KOGE = ["なし", "少し", "しっかり"];

/**
 * みんなの記録を、合数×後半の本数ごとにまとめる。
 * 「ちょうど」が一番多い本数を、その合数のおすすめにする（記録3件以上の時だけ・同数なら目安に近い方）
 */
export function summarize(logs) {
  const by = {};
  for (const l of logs || []) {
    if (!GO_LIST.includes(l.go) || !Number.isInteger(l.late) || !RESULTS.includes(l.result)) continue;
    const g = (by[l.go] ||= { go: l.go, count: 0, lates: {} });
    g.count += 1;
    const c = (g.lates[l.late] ||= { late: l.late, count: 0, かため: 0, ちょうど: 0, やわらかめ: 0 });
    c.count += 1; c[l.result] += 1;
  }
  return GO_LIST.filter((go) => by[go]).map((go) => {
    const g = by[go];
    const rows = Object.values(g.lates).sort((a, b) => a.late - b.late);
    let best = null;
    if (g.count >= 3) {
      for (const r of rows) {
        if (!r.ちょうど) continue;
        if (!best || r.ちょうど > best.ちょうど || (r.ちょうど === best.ちょうど && Math.abs(r.late - LATE_COUNT[go]) < Math.abs(best.late - LATE_COUNT[go]))) best = r;
      }
    }
    return { go, count: g.count, rows, recommend: best ? best.late : null };
  });
}

/** 記録1件を保存してよい形に整える（不正なら null） */
export function cleanLog(x) {
  const go = Number(x?.go), late = Number(x?.late);
  if (!GO_LIST.includes(go) || !Number.isInteger(late) || late < 1 || late > 20) return null;
  if (!RESULTS.includes(x.result) || !KOGE.includes(x.koge)) return null;
  return { go, late, result: x.result, koge: x.koge, memo: String(x.memo || "").trim().slice(0, 200), by: String(x.by || "").trim().slice(0, 30) };
}
