# PLAYBOOK-BBQ — BBQ改善ループ 打ち手カタログ（正本）

「分析・提案」で止めず「**UU乖離 → 打ち手 → 実装 → 効果測定 → 回転**」まで自走させるための打ち手台帳。
機械版は `scripts/act-stage.mjs` の `CATALOG`、回転機構は汎用核 `scripts/act-engine.mjs`（potentialight-fleet/act-engine のvendorコピー）。

- **目標**: SLOW FIRE SHOP と 与論島ガイド の2サイトで **各 月間1万UU**（`UU_TARGET`、既定10000）。
- **実行台帳**: `bbq-act-ledger.json`（週次でコミット）。cooldown / 回転数 / 効果判定 / エスカレーションを記録。
- **実行タイミング**: `shop-improvement.yml`（毎週木曜 5:00 JST）の末尾で act ステージが走る。
- **効果測定**: GA4 直近28日 `totalUsers` の**前後比較**。shop=本ループのプロパティ、yoron=`YORON_GA4_PROPERTY_ID`（任意secret）。
- **対象(target)**: `shop`（→ repo `yamanekazuki/slow-fire`）／`yoron`（→ repo `yamanekazuki/yoron-bbq`）。

## 打ち手一覧

| CM | 発動条件 | 実行内容 | cooldown | 上限 | 承認 |
|----|----------|----------|:--:|:--:|:--:|
| **CM-CONTENT-BOOST** | UU乖離大（28日UU < 目標） | 既存ブログ生成/改善workflowを追加dispatch（shop=`blog-improvement.yml` / yoron=`generate-blog.yml` force=true） | 1週 | ∞ | 不要 |
| **CM-SEO-TEKOIRE** | 流入チャネル偏り（最大チャネル > 70%） | 既存改善提案ループに「SEO焦点」を注入（`ledger.meta.focus[target]`→次回の分析プロンプトが読む） | 2週 | 4 | 不要 |
| **CM-MEASURE-FIRST** | 効果不明（UU未計測＝GA4プロパティ未接続 等） | 打たずに待つ。まず計測を接続する | 1週 | ∞ | 不要 |
| **CM-AD-BOOST** | 広告費投下が必要な局面 | **承認必須**＝自動実行せず山根さんへ差し戻し | 4週 | 3 | **要** |
| **CM-RENEGOTIATE** | 累計10回転しても未着火＝構造要因 | 目標再交渉/凍結。**承認必須** | ∞ | 1 | **要** |

## 回転・エスカレーションの原則

- 1回打って終わりにしない。UU乖離が閉じるまで、軌道下サイトへ毎週最低1打ち手を回す。
- 同一打ち手×同一対象は cooldown 週以内は再実行しない（重複防止）。dispatch失敗は cooldown/リトライを消費せず翌週再試行。
- 効果判定で「無効（未着火）」なら対象の回転数を+1。累計 `escalation_threshold`（既定10）到達で **CM-RENEGOTIATE**（承認必須）へ。
- 承認必須系（広告費・目標変更）は自動実行せず、台帳に `escalated` として残し山根さんへ通知（メール末尾の act サマリー）。

## 必要な GitHub Secrets（新規は最小限）

- 既存流用: `GOOGLE_SERVICE_ACCOUNT_JSON` / `GA4_PROPERTY_ID` / `ANTHROPIC_API_KEY`。
- 任意追加:
  - `YORON_GA4_PROPERTY_ID` … 与論島ガイドのGA4プロパティID。**未設定なら与論UUは未計測扱い**（CM-MEASURE-FIRST が回るだけで無害）。
  - `BBQ_DISPATCH_TOKEN` … クロスrepo（与論）のworkflowをdispatchするPAT（actions:write）。**未設定なら同repo(slow-fire)のみ `GITHUB_TOKEN` で発火**、与論dispatchは `dispatch_failed`（翌週再試行）。
