// =============================================================================
// BBQ actステージ — SLOW FIRE SHOP と 与論島ガイド の「検知→打ち手→実装→効果測定」執行機関
// -----------------------------------------------------------------------------
// media-fleet の act-stage と同じ「薄いアダプタ」パターン。回転機構（台帳・cooldown・
// per-target週1ガード・回転・エスカレーション・承認ゲート）は汎用核 act-engine（./act-engine.mjs
// にvendor）が担い、ここは BBQ固有の打ち手カタログ・候補生成・発火(GitHub dispatch)・
// 効果計測(GA4 28日UUの前後比較)だけを注入する。
//
// 文章正本カタログ = ../PLAYBOOK-BBQ.md ／ 実行台帳 = ../bbq-act-ledger.json ／ 目標 = 各サイト月間1万UU。
//
// 設計原則（山根さん指示 2026-07-22）:
//   ・「提案→実装」で止めない。UU乖離が閉じるまで毎週最低1打ち手/軌道下サイトを回す。
//   ・同一打ち手×同一対象は cooldown_weeks 以内は再実行しない（重複防止）。
//   ・累計10回転しても着火しない対象のみ「構造的に無理・目標再交渉」を山根さんへエスカレーション。
//   ・低リスク打ち手はコード実行（LLM不要）で自動発火。承認必須系（広告費・社外送信・目標変更）は差し戻す。
// =============================================================================
import { runAct } from "./act-engine.mjs";

const OWNER = "yamanekazuki";
// 対象サイト → 発火先GitHubリポジトリ（BBQは個人アカウント。艦隊orgではない）
const REPO = { shop: `${OWNER}/slow-fire`, yoron: `${OWNER}/yoron-bbq` };

// 打ち手カタログ（機械版）。発動条件・cooldown・リトライ上限・承認要否・対象別workflow。
// workflow=null は「発火せず台帳記録のみ」（焦点注入 / 計測待ち / エスカレーション）。
// 文章正本 = PLAYBOOK-BBQ.md
const CATALOG = {
  // UU乖離大 → 既存ブログ生成/改善workflowを追加dispatch（コンテンツ供給を増やす）
  "CM-CONTENT-BOOST": {
    cooldown: 1, retryMax: Infinity, approval: false,
    workflow: { shop: "blog-improvement.yml", yoron: "generate-blog.yml" },
    inputs:   { yoron: { force: "true" } }, // generate-blog.yml は force 入力を宣言済み
  },
  // 流入チャネル偏り → 既存の改善提案ループに「SEO焦点」を注入（次回の分析プロンプトに効く）
  "CM-SEO-TEKOIRE": {
    cooldown: 2, retryMax: 4, approval: false,
    workflow: null, // 発火せず ledger.meta.focus[target] に焦点を書き込む（main側が次回プロンプトへ注入）
  },
  // 効果不明（UU未計測＝GA4プロパティ未接続 等）→ まず計測を整える。打たずに待つ
  "CM-MEASURE-FIRST": {
    cooldown: 1, retryMax: Infinity, approval: false, workflow: null,
  },
  // 広告費を投下（承認必須）＝自動実行せず山根さんへ差し戻し
  "CM-AD-BOOST": {
    cooldown: 4, retryMax: 3, approval: true, workflow: null,
  },
  // 回転上限到達＝構造要因。目標再交渉/凍結（承認必須）
  "CM-RENEGOTIATE": {
    cooldown: Infinity, retryMax: 1, approval: true, workflow: null,
  },
};

function dispatchToken() {
  return process.env.BBQ_DISPATCH_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
}

// GitHub workflow_dispatch 発火（コード実行・LLM不要・従量APIゼロ）。
async function ghDispatch(repo, workflow, inputs = {}) {
  const token = dispatchToken();
  if (!token) return { ok: false, error: "dispatch token未設定" };
  // 既定ブランチを解決（slow-fire=main想定だが取得して確実に）
  let ref = "main";
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    });
    if (r.ok) ref = (await r.json()).default_branch || "main";
  } catch { /* 既定 main のまま */ }
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/${workflow}/dispatches`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`, accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28", "content-type": "application/json",
      },
      body: JSON.stringify({ ref, inputs }),
    });
    if (r.status === 204) return { ok: true };
    return { ok: false, error: `dispatch ${r.status}: ${(await r.text()).slice(0, 160)}` };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 効果判定用の実測値（対象サイトの直近28日UU）。ctx.uu に main が入れておく。
function uuNow(ctx, target) {
  const v = ctx.uu?.[target];
  return v === null || v === undefined ? null : Number(v);
}

// 打ち手の発火。workflow=null は台帳記録のみ（焦点注入 or 計測待ち）。
async function fire(c, spec, ctx) {
  const effectMetric = "GA4 28日UU 前後比較";
  const before = uuNow(ctx, c.target);
  const wf = spec.workflow && spec.workflow[c.target];

  if (c.cm === "CM-SEO-TEKOIRE") {
    // 既存改善ループへ焦点を注入（次回の分析プロンプトが読む）。発火扱いだが従量ゼロ。
    ctx.ledger.meta.focus = ctx.ledger.meta.focus || {};
    ctx.ledger.meta.focus[c.target] = "流入チャネルが偏っている。organic以外（SNS/referral/被リンク）を増やすSEO・導線施策に重点を置くこと。";
    return { ok: true, action: `SEO焦点を ${c.target} の次回改善提案へ注入`, effectMetric, extra: { uu_before: before } };
  }
  if (!wf) {
    return { ok: true, action: "workflowなし（計測待ち/エスカレーションのみ）", effectMetric, extra: { uu_before: before } };
  }
  if (ctx.dryRun) return { ok: false, error: "dryRun（発火せず記録のみ）", action: `${REPO[c.target]} ${wf} をdispatch`, effectMetric };

  const inputs = (spec.inputs && spec.inputs[c.target]) || {};
  const r = await ghDispatch(REPO[c.target], wf, inputs);
  return { ...r, action: `${REPO[c.target]} ${wf} をdispatch`, effectMetric, extra: { uu_before: before } };
}

// 候補生成（BBQ固有ロジック）。優先度順に返す＝核が cooldown/guard/batch/承認を適用して発火。
function makeCandidates(ctx) {
  return (ledger) => {
    const escThreshold = ledger.meta?.escalation_threshold ?? 10;
    const cands = [];
    for (const target of ["shop", "yoron"]) {
      const uu = uuNow(ctx, target);
      // ① UU未計測（GA4プロパティ未接続 等）→ まず計測を整える
      if (uu === null) { cands.push({ cm: "CM-MEASURE-FIRST", target, trigger: "UU未計測＝効果測定不能。まず計測を接続" }); continue; }
      // ② 回転上限到達＝構造要因 → 目標再交渉（承認必須）
      if ((ledger.rotations[target] || 0) >= escThreshold) {
        cands.push({ cm: "CM-RENEGOTIATE", target, trigger: `累計${ledger.rotations[target]}回転しても未着火＝構造的に無理` });
        continue;
      }
      // ③ UU乖離大 → コンテンツ供給を増やす
      if (uu < ctx.TARGET) cands.push({ cm: "CM-CONTENT-BOOST", target, trigger: `28日UU ${uu} < 目標 ${ctx.TARGET}・乖離大` });
    }
    // ④ 流入チャネル偏り（shopのみチャネルデータあり）→ SEO焦点注入
    if (Array.isArray(ctx.channels) && ctx.channels.length) {
      const total = ctx.channels.reduce((s, c) => s + (c.sessions || 0), 0);
      const top = ctx.channels[0];
      if (total > 0 && top && top.sessions / total > 0.7) {
        cands.push({ cm: "CM-SEO-TEKOIRE", target: "shop", trigger: `流入が ${top.name} に偏り(${Math.round((top.sessions / total) * 100)}%)` });
      }
    }
    return cands;
  };
}

export async function runActStage(ctx) {
  return runAct({
    ledgerPath: ctx.ledgerPath,
    ledger: ctx.ledger,      // main が先に読んだ台帳オブジェクト（focus注入を共有するため）
    today: ctx.today,
    catalog: CATALOG,
    generateCandidates: makeCandidates(ctx),
    fire: (c, spec) => fire(c, spec, ctx),
    effectValue: (t) => uuNow(ctx, t),
    afterKey: "uu_after",
    metricLabel: "UU",
    title: "BBQ actステージ（UU乖離→打ち手→実装→効果測定）",
    approver: "山根さん",
    escalationAction: "自動実行せず山根さんへエスカレーション（承認必須）",
  });
}
