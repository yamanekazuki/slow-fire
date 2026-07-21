// =============================================================================
// act-engine — 「検知→打ち手→自動実装→台帳記録→翌週効果判定」の汎用執行核
// -----------------------------------------------------------------------------
// ドメイン非依存の“回転機構”だけをここに置く。打ち手カタログ・候補生成・発火・
// 効果計測はすべて利用側が注入する（関数/JSONインターフェース）。
//
//   台帳(ledger)の読み書き / cooldown判定（dispatch_failedは非消費）/
//   per-target 週1ガード / 予約(reserved)の繰越（基準日=ctx.today）/
//   回転カウント / エスカレーション閾値（既定10）/ 承認ゲート（approval:trueは
//   自動実行せず差し戻しリストへ）を核が担う。
//
// 利用側は runAct(cfg) を1回呼ぶだけ。cfg で catalog / generateCandidates /
// fire / effectValue を渡す（下記 JSDoc 参照）。依存パッケージゼロ・Nodeのみ。
// =============================================================================
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const WEEK_MS = 7 * 864e5;
const weeksBetween = (a, b) => Math.abs(new Date(a) - new Date(b)) / WEEK_MS;
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

// ── 台帳の読み書き ──────────────────────────────────────────────────────────
export function emptyLedger() {
  return { meta: { rotation_total: 0, escalation_threshold: 10, max_act_batch: 8 }, rotations: {}, history: [], reserved: [] };
}
export function loadLedger(path) {
  if (!existsSync(path)) return emptyLedger();
  return JSON.parse(readFileSync(path, "utf8"));
}
export function saveLedger(path, ledger) {
  writeFileSync(path, JSON.stringify(ledger, null, 2));
}

// ── cooldown / リトライ / 回転の判定（履歴ベース・純関数）─────────────────────
// dispatch失敗（未発火）はcooldown/リトライ回数を消費しない＝次回で再試行される。
const isRealAttempt = (h) => h.status !== "dispatch_failed";
function lastRun(ledger, cm, target) {
  return [...ledger.history].reverse().find((h) => h.countermeasure === cm && (h.targets || []).includes(target) && isRealAttempt(h));
}
function runCount(ledger, cm, target) {
  return ledger.history.filter((h) => h.countermeasure === cm && (h.targets || []).includes(target) && isRealAttempt(h)).length;
}
// cooldown内 / リトライ上限到達なら不適格。catalog[cm] が無い打ち手も不適格。
export function eligible(ledger, catalog, cm, target, today) {
  const spec = catalog[cm]; if (!spec) return false;
  const cooldown = spec.cooldown ?? 0;
  const retryMax = spec.retryMax ?? Infinity;
  const prev = lastRun(ledger, cm, target);
  if (prev && weeksBetween(prev.date, today) < cooldown) return false;
  if (runCount(ledger, cm, target) >= retryMax) return false;
  return true;
}

// ── 効果判定: due到来の in_progress を、利用側の effectValue で締める ─────────
function settleEffects(ledger, cfg, today, lines) {
  const { effectValue, afterKey = "value_after", metricLabel = "value" } = cfg;
  for (const h of ledger.history) {
    if (h.status !== "in_progress" || !h.effect_check_due || h.effect_check_due > today) continue;
    const after = (h.targets || []).map((t) => effectValue(t)).filter((v) => v !== null && v !== undefined);
    const lit = after.some((v) => v > 0);
    h.effect = { checked: today, [afterKey]: after, lit };
    h.status = lit ? "closed_effective" : "ineffective";
    if (!lit) {
      for (const t of (h.targets || [])) ledger.rotations[t] = (ledger.rotations[t] || 0) + 1;
      lines.push(`　効果判定: turn${h.turn} ${h.countermeasure} → 無効（未着火）。対象回転数を加算し次の打ち手へ`);
    } else {
      lines.push(`　効果判定: turn${h.turn} ${h.countermeasure} → ✅有効（着火 ${metricLabel}=${after.join("/")}）`);
    }
  }
}

/**
 * 汎用actエンジン本体。検知(候補生成)は注入・機構は核が担う。
 * @param {object} cfg
 * @param {string} cfg.ledgerPath                台帳JSONのパス（読み書き）
 * @param {object} [cfg.ledger]                  台帳を直接渡す場合（ledgerPath省略時の保存はしない）
 * @param {string} [cfg.today]                   基準日 YYYY-MM-DD（cooldown・予約繰越の基準）
 * @param {object} cfg.catalog                   { [cm]: { cooldown, retryMax, approval, ...任意 } }
 * @param {(ledger:object)=>Array<{cm:string,target:string,trigger:string}>} cfg.generateCandidates
 *        優先度順の候補列。核はこの順に eligible/guard/batch を適用して発火する。
 * @param {(cand,spec,cfg)=>Promise<{ok:boolean,error?:string,action?:string,effectMetric?:string,extra?:object}>} cfg.fire
 *        承認不要CMの実発火（GitHub dispatch等）。ok/失敗と台帳に載せる action/effectMetric を返す。
 * @param {(target:string)=>number|null} cfg.effectValue  効果判定の実測値取得
 * @param {string} [cfg.title]                   レポート見出し
 * @param {string} [cfg.approver]                エスカレーション文の宛先（既定「担当者」）
 * @param {string} [cfg.escalationAction]        承認差し戻し時に台帳へ記す action 文
 * @param {string} [cfg.afterKey]                効果objのafter配列キー（既定 value_after）
 * @param {string} [cfg.metricLabel]             効果ログの指標名（既定 value）
 * @returns {Promise<{lines:string[],fired:number,escalations:Array,ledger:object}>}
 */
export async function runAct(cfg) {
  const {
    ledgerPath,
    today = new Date().toISOString().slice(0, 10),
    catalog,
    generateCandidates,
    fire,
    title = "actステージ（打ち手→実装→検証→再計測）",
    approver = "担当者",
  } = cfg;
  const escalationAction = cfg.escalationAction ?? `自動実行せず${approver}へエスカレーション（承認必須）`;
  const ledger = cfg.ledger || loadLedger(ledgerPath);
  const lines = ["", `━━ ${title} ━━`];
  const batchMax = ledger.meta?.max_act_batch ?? 8;
  const escThreshold = ledger.meta?.escalation_threshold ?? 10;
  const escalations = [];
  let fired = 0, nextTurn = (ledger.history.at(-1)?.turn || 0) + 1;

  // 1) 効果判定を先に締める（due到来ぶん）
  settleEffects(ledger, cfg, today, lines);

  // 2) 候補生成は利用側に委譲（回転数・エスカレーション閾値を見せて判断させる）
  const candidates = generateCandidates(ledger) || [];

  // 3) 発火ループ: cooldown/リトライ/batch上限/per-target週1ガード＋承認ゲート
  const handledTargets = new Set(); // per-target guard: 1対象に複数CMが同週発火するのを防ぐ
  const firedCms = new Set();       // reserved消化判定用
  for (const c of candidates) {
    if (fired >= batchMax) break;
    if (handledTargets.has(c.target)) continue;
    if (!eligible(ledger, catalog, c.cm, c.target, today)) continue;
    const spec = catalog[c.cm];
    if (spec.approval) { // 承認必須系は自動実行せず差し戻し＋エスカレーション
      escalations.push({ cm: c.cm, target: c.target, trigger: c.trigger });
      ledger.history.push({ turn: nextTurn++, date: today, countermeasure: c.cm, targets: [c.target], trigger: c.trigger, action: escalationAction, auto: false, llm_used: false, effect_check_due: null, effect: null, status: "escalated" });
      lines.push(`🚨エスカレーション: ${c.target} ${c.cm}（${c.trigger}）→ ${approver}判断待ち`);
      handledTargets.add(c.target); firedCms.add(c.cm); fired++; continue;
    }
    const res = await fire(c, spec, cfg);
    const dueW = spec.cooldown ?? 1;
    const due = isoDay(Date.now() + dueW * WEEK_MS);
    ledger.history.push({ turn: nextTurn++, date: today, countermeasure: c.cm, targets: [c.target], trigger: c.trigger, action: res.action ?? `${c.cm} を実行`, auto: true, llm_used: false, dispatch_ok: res.ok, dispatch_error: res.error || null, effect_metric: res.effectMetric ?? "effect 前後比較", effect_check_due: due, effect: null, status: res.ok ? "in_progress" : "dispatch_failed", ...(res.extra || {}) });
    lines.push(`${res.ok ? "🚀発火" : "❌発火失敗"}: turn${nextTurn - 1} ${c.cm} → ${c.target}（${c.trigger}）${res.ok ? `／効果判定${due}` : ` / ${res.error}`}`);
    // dispatch失敗は同対象の再試行余地を残す（handledに入れない）。成功時のみ週1ガード＆予約消化。
    if (res.ok) { handledTargets.add(c.target); firedCms.add(c.cm); }
    fired++;
  }

  ledger.meta.rotation_total = (ledger.meta.rotation_total || 0) + fired;
  // 予約(reserved)は発火した打ち手のみ消化。未発火かつ計画日到来ぶんは翌週へ繰越（基準日=today）
  const nextWeek = () => isoDay(new Date(`${today}T00:00:00Z`).getTime() + WEEK_MS);
  ledger.reserved = (ledger.reserved || [])
    .filter((r) => !firedCms.has(r.countermeasure))
    .map((r) => (r.date_planned <= today ? { ...r, date_planned: nextWeek(), carried_over: true } : r));
  if (ledgerPath) saveLedger(ledgerPath, ledger);

  if (fired === 0) lines.push("　今週は発火対象なし（cooldown中/上限到達/軌道上）。");
  lines.push(`　今週の発火数=${fired}／累計回転=${ledger.meta.rotation_total}／エスカレーション=${escalations.length}`);
  return { lines, fired, escalations, ledger, escThreshold };
}
