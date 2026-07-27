# LINE修正受付システム（YORON BBQ）

運営LINEグループ（山根・うえたく・あんちゃん＋YORON BBQ公式）で公式アカウントを呼んで
サイトの修正依頼を書くと、自動でキューに入り、Mac側のループが修正を実装してLINEに完了報告します。

## 使い方（メンバー向け）

グループで、次のどれかの形で書くだけです。

- 公式アカウントを**メンションする**（`@YORON BBQ` を選ぶ）
- 本文を `@YORON` / `@よろん` で始める
- 本文を `よろん、` で始める

例:

```
よろん、トップの「はじめての方へ」ボタンの文言を「まず読む」に変えて
```

すぐに「受け付けました🔥 直したらここで報告します」と返ってきます。
最大10分後に、直っていれば「直しました🔥 → URL」、
判断がつかなければ「〜という理解で合っていますか？」と質問が返ります。

## 構成

| 役割 | 実体 |
| --- | --- |
| 受付 | `functions/index.js` の `lineWebhook`（Firebase / cook-log-df240 / asia-northeast1） |
| キュー | Firestore `site_requests`（`status`: pending → done / needs_clarification） |
| 処理 | `scripts/request-loop.mjs`（Mac / launchd `com.yamane.bbq-request` / 10分おき） |
| 台帳 | `scripts/request-ledger.json`（重複実装の防止。gitignore対象） |
| ログ | `scripts/request-run.log` |

Webhook URL: `https://linewebhook-fscbz2uwjq-an.a.run.app`

## 安全弁（意図的な設計判断）

自動でコードが変わる仕組みなので、次を効かせています。

1. **署名検証**: `X-Line-Signature` を `LINE_CHANNEL_SECRET` で検証。不一致は403。
   シークレットが `UNSET` の間は、参加/退出の記録はしますが**修正依頼は一切受け付けません**。
2. **触れないファイル**: `functions/`、`firebase.json`、`firestore.rules`、`firestore.indexes.json`、
   `storage.rules`、`.firebaserc`、`.github/`、`firebase-config.js`、`scripts/`、`.gitignore`、
   `*.plist` / 鍵ファイル。ここに差分が出たら**全て破棄**して山根さんにSlack DMします。
3. **人間に戻す条件**: ページ・セクションの削除／料金・日程など事実の変更／
   YORON BBQ・SLOW FIRE の思想の根幹／サーバ設定・大規模変更。
   これらは実装せず、LINEで確認質問＋山根さんへSlack DM（`status=needs_clarification`）。
   **曖昧なだけの依頼は質問で返さない**（2026-07-27山根さん指示）: 直近のやり取りを文脈に
   最良解釈で実装し、「こう直したよ、違ったら言ってね」と報告する。追加メッセージは
   前の指示への追加指示として合流。雑談・テスト・取り消しは `skip`（黙って閉じてSlack通知のみ）。
4. **1回の実行で実装は最大2件**。
5. **作業ツリーが汚れていたら実装しない**（他作業を巻き込んでcommitしないため）。
6. 変更後は push → 本番URLの200を最大200秒待って確認してから報告。

## 運用コマンド

```bash
node scripts/request-loop.mjs                 # 通常実行（launchdと同じ）
node scripts/request-loop.mjs --dry-run       # 判定だけ。実装・push・送信なし
node scripts/request-loop.mjs --no-push       # 実装するがcommit/pushしない（差分を見る）
node scripts/request-loop.mjs --no-line       # 実装・pushはするがLINE送信しない
node scripts/request-loop.mjs --limit 1       # 1件だけ

launchctl load  ~/Library/LaunchAgents/com.yamane.bbq-request.plist   # 起動
launchctl unload ~/Library/LaunchAgents/com.yamane.bbq-request.plist  # 停止
```

## セットアップで残っている作業

### 1. `LINE_CHANNEL_SECRET` を本物にする（**必須。これをやるまで修正依頼は動きません**）

LINE Developers コンソール → 該当チャネル → 「Basic settings」の **Channel secret** をコピーし、

```bash
printf '（Channel secret）' | gcloud secrets versions add LINE_CHANNEL_SECRET \
  --project=cook-log-df240 --data-file=-
cd ~/dev/bbq/bbq-site && npx firebase deploy --only functions:lineWebhook --project cook-log-df240
```

※ 値をコードや設定ファイルに平文で書かないこと。シェル履歴にも残さないよう注意。

### 2. Webhook URL の登録 — ✅ 完了（API で自動設定済み）

`PUT /v2/bot/channel/webhook/endpoint` で自動設定できました。現在の状態:

```json
{"endpoint":"https://linewebhook-fscbz2uwjq-an.a.run.app","active":true}
```

確認・再設定するときは:

```bash
TOK=$(gcloud secrets versions access latest --secret=LINE_CHANNEL_TOKEN --project=cook-log-df240)
curl -s https://api.line.me/v2/bot/channel/webhook/endpoint -H "Authorization: Bearer $TOK"
```

コンソール側で1点だけ確認をお願いします: **Messaging API settings** の
**Auto-reply messages / Greeting messages** は Disabled 推奨です（自動応答と受付返信が二重になるため）。

### 3. グループIDの記録

公式アカウントを運営グループに招待し直すと `join` イベントが飛び、
`line_state/config.groupIds` に自動で記録されます（完了報告のpush先に使います）。
すでに招待済みなら一度退出→再招待するか、Firestoreに手で追加してください。

### 4. launchd の起動 — ✅ 完了（`com.yamane.bbq-request` を load 済み・10分間隔）

## 2026-07-25 構築時のテスト結果

- webhook 署名検証: 正しい署名=200 / 誤った署名=403 / 署名なし=403
- LINE公式の Verify（`POST /v2/bot/channel/webhook/test`）: `success:true, statusCode:200`
- 受付: 署名付きの message イベントを投げ、`@YORON` を除いた本文で `site_requests` に pending 生成を確認
- 処理（auto経路）: 解釈→`contact.html` の `<title>` 修正→commit→push→本番200確認→LINE文面出力まで通過
  （実コミット `ded0624`。LINE送信は `--no-line` で文面出力のみ）
- 処理（ask経路）: 「参加費を値上げ／使ってないページを消して」で `ask` 判定。実装せず確認質問を生成
- 安全弁: 作業ツリーが汚れている状態では実装を中止することを確認
- テストで作った Firestore ドキュメントは削除済み

未検証: LINEグループへの実push（実グループへ投稿できないため）と、Slack DMの実送信
（トークン取得は `SLACK_BOT_TOKEN` で確認済み）。
