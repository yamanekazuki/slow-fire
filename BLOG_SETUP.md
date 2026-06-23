# SLOW FIRE 自動ブログ — セットアップと仕組み

週3回（月・水・金 朝7:00 JST）、AIが SLOW FIRE の思想と実体験を素材に記事を1本生成し、
本番サイト（GitHub Pages）へ自動公開します。Mac を起動しておく必要はありません。

## 仕組み（全体像）

```
GitHub Actions（cron: 月・水・金 07:00 JST）
  └─ scripts/generate-post.mjs を実行
       ├─ Claude API（claude-opus-4-8）に記事生成を依頼（構造化JSONで受信）
       ├─ blog/<日付>-<slug>.html を生成（SEO最適・構造化データ付きの静的ページ）
       ├─ blog/posts.json（記事マニフェスト）を更新
       ├─ blog.html（一覧）を再生成
       └─ sitemap.xml を再生成
  └─ 生成物を main に commit & push → GitHub Pages が自動公開
```

- **静的HTMLを生成してコミット**するので、SEO的にもっとも安全（クライアントレンダリングではない）。
- 記事は **SLOW FIRE の思想（Subtle/MetAware）と Weber Grill Academy 由来の一次情報**（温度・時間・道具・体験）を必ず織り込む設計。これにより Google の「量産コンテンツ判定」を避け、E-E-A-T を満たす。
- 頻度を週3回に抑え、機械的な毎日量産という印象を避けている。

## 必要な作業（山根さんのみ実施可能）— 1回だけ

ブログを稼働させるには **Anthropic の API キー** を GitHub のリポジトリ Secrets に登録します。

1. Anthropic Console（https://console.anthropic.com）で API キーを発行（`sk-ant-...`）。
2. GitHub で `yamanekazuki/slow-fire` リポジトリを開く。
3. **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `ANTHROPIC_API_KEY`
   - Secret: 発行したキー
4. **Settings → Actions → General → Workflow permissions** で
   **「Read and write permissions」** を選択して保存（ボットが push できるように）。

これだけで、次の月・水・金の朝7時から自動で記事が増えていきます。

## すぐ動作確認したいとき（手動実行）

GitHub の **Actions タブ → 「SLOW FIRE 自動ブログ」→ Run workflow** で即時に1本生成できます。
（同じ日に既に記事があればスキップされます。）

## コスト

`claude-opus-4-8`（入力 $5 / 出力 $25 per 1M tokens）。1記事あたり概ね $0.05 未満、
週3回でも月12本程度なので、月額のAPIコストはごくわずかです。

## 記事のテーマ・トーンを変えたいとき

`scripts/generate-post.mjs` の中の：

- `KNOWLEDGE` … 記事の素材になる一次情報（思想・温度チャート・体験）。ここを足すと記事の引き出しが増える。
- `TOPIC_SEEDS` … テーマの種（投稿数で巡回）。追加・削除で扱う話題を調整。
- `system` プロンプト … 声・トーン・SEO方針。

を編集してください。頻度の変更は `.github/workflows/daily-blog.yml` の `cron` を編集します。
（現在: `0 22 * * 0,2,4` = JST 月・水・金 07:00）

## ファイル一覧

| ファイル | 役割 |
|---|---|
| `.github/workflows/daily-blog.yml` | 週3回の自動実行ジョブ |
| `scripts/generate-post.mjs` | 記事生成エンジン（外部依存なし） |
| `scripts/package.json` | Node 設定（依存なし） |
| `blog.html` | 記事一覧（自動再生成） |
| `blog.css` | 読みもの専用スタイル |
| `blog/posts.json` | 記事マニフェスト |
| `blog/*.html` | 各記事ページ |

## 注意

- ボットのコミットは `push` トリガーに含めていないため、無限ループは起きません（cron と手動実行のみ）。
- `blog.html` / `sitemap.xml` / `blog/posts.json` は自動生成物です。手で編集してもよいですが、次回生成時に `blog.html` と `sitemap.xml` は上書きされます。記事個別ファイル（`blog/*.html`）は上書きされません。
