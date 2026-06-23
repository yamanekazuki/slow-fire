# SLOW FIRE 日次レポートメール — セットアップ

毎朝7:00 JST に前日のサイト数値（GA4）＋検索キーワード（Search Console）を
3名（yamane / 石原 / 植田）にメール配信します。仕組みは `.github/workflows/daily-analytics.yml`
＋ `scripts/daily-report.mjs`（依存ゼロ・サービスアカウントJWTでGA4/SC APIを直接呼び出し）。

## 稼働に必要な準備（一度だけ）

### A. GA4 の計測タグをサイトに埋め込む（データを発生させる）
現状サイトにGA4タグは未設置 ＝ このままだと数値が0のままです。
- 山根さんから **測定ID（`G-XXXXXXX`）** を共有 → 私が全ページの `<head>` に gtag を埋め込みます。
- 埋め込み後の訪問から計測が始まります（過去分は取れません）。

### B. GA4 の数値プロパティID を控える
- GA4 → 管理 → プロパティ設定 → **プロパティID**（`G-` ではなく **数字**、例 `123456789`）。
- これを GitHub Secret `GA4_PROPERTY_ID` に登録（API取得用。測定IDとは別物）。

### C. Search Console を認証する（検索キーワードを取るため・任意）
- `SEARCH_CONSOLE_SETUP.md` の手順で `https://yamanekazuki.github.io/slow-fire/` を URLプレフィックスで追加。
- HTMLタグ認証の `content` 値を共有 → 私が `<head>` に埋め込み → 「確認」。
- 未認証でもレポートは動きます（検索キーワード欄が「未接続」と表示されるだけ）。

### D. Google サービスアカウントを用意（API認証）
1. https://console.cloud.google.com → プロジェクトを作成/選択。
2. 「APIとサービス → ライブラリ」で次の2つを **有効化**：
   - **Google Analytics Data API**
   - **Search Console API**
3. 「IAMと管理 → サービスアカウント → 作成」。名前 `slow-fire-reporter` など → 作成。
4. 作ったSAの「キー → 鍵を追加 → JSON」で**JSONキーをダウンロード**。
5. SAのメール（`...@...iam.gserviceaccount.com`）をコピー。
6. **GA4** → 管理 → プロパティのアクセス管理 → そのSAメールを **閲覧者** で追加。
7. **Search Console**（Cで認証した場合）→ 設定 → ユーザーと権限 → そのSAメールを **制限付き** で追加。

### E. GitHub Secrets を登録
`slow-fire` → Settings → Secrets and variables → Actions → New repository secret：

| Name | 値 |
|---|---|
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Dでダウンロードした **JSONファイルの中身を丸ごと**貼り付け |
| `GA4_PROPERTY_ID` | Bの数値プロパティID |
| `GA4_DASHBOARD_URL`（任意） | 「GA4で詳細を見る」リンク先URL |
| `SC_SITE_URL`（任意） | 既定で `https://yamanekazuki.github.io/slow-fire/`。変える場合のみ |

（メール送信は既存の `MAIL_USERNAME` / `MAIL_PASSWORD` を流用します）

## 動作確認
Actions → 「SLOW FIRE 日次レポート」→ Run workflow。
- 緑✓＋メール受信で成功。
- 数値が0ばかりのときは、A（GA4タグ）が未設置か、計測開始から日が浅いだけです。

## 仕様メモ
- 必須シークレット（`GOOGLE_SERVICE_ACCOUNT_JSON` / `GA4_PROPERTY_ID`）が未設定の間は、
  ジョブは**何も送らず正常終了**します（赤い失敗にはなりません）。
- レポートは前日データ。Search Console はデータ確定に2〜3日の遅延があるため、
  検索キーワードは「8〜2日前」の確定済み7日間で集計しています。
- 配信先・時刻・項目は `daily-analytics.yml` / `daily-report.mjs` で調整可能。
