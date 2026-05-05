# Search Console / Bing / GA4 セットアップ手順

両サイト（slow-fire / slow-fire-shop）に同じ手順で実施します。所要時間 計15分。

## ① Google Search Console（5分・無料）

検索結果に出ているか・どんなクエリで来ているかを把握するため。

1. https://search.google.com/search-console にアクセス（Googleアカウントでログイン）
2. 「プロパティを追加」 → **URLプレフィックス** を選択
3. URLに `https://yamanekazuki.github.io/slow-fire/` を入力 → 続行
4. 所有権の確認方法として **「HTMLタグ」** を選択
5. 表示される `<meta name="google-site-verification" content="..." />` の **content の値だけコピー** して山根さんから私に送ってください
6. 私が両サイトの index.html に埋め込みます
7. 戻って「確認」ボタンを押すと完了
8. 確認後、左メニュー「サイトマップ」→ `sitemap.xml` を入力して送信

**slow-fire-shop も同じ手順** で `https://yamanekazuki.github.io/slow-fire-shop/` を追加。

---

## ② Bing Webmaster Tools（3分・無料）

ChatGPT・Copilot・DuckDuckGo はすべて Bing インデックスを使うため、これは絶対やる。

1. https://www.bing.com/webmasters にアクセス
2. Microsoft アカウントでログイン（無ければ作成、Googleアカウントでもログイン可）
3. 「Search Consoleからインポート」が表示されたら → ボタン押すだけで両サイトが自動登録される（最速）
4. それが使えない場合は「サイトを追加」→ HTMLメタタグ認証 → 私に送ってください

---

## ③ Google Analytics 4 (GA4) — 5分

訪問者数・どこから来たか・何を見たかを計測。

1. https://analytics.google.com/ にアクセス
2. 「管理」→ 「アカウントを作成」
   - アカウント名: `SLOW FIRE`
3. プロパティ名: `slow-fire-service`（サービスサイト用）
   - タイムゾーン: 日本
   - 通貨: JPY
4. 「データストリームを追加」→ ウェブ
5. URL: `https://yamanekazuki.github.io/slow-fire/`
6. 表示される **測定ID（`G-XXXXXXX` の形式）** を私に送ってください
7. 同じ手順で `slow-fire-shop` 用のプロパティも作成 → 別の測定IDが出ます

両IDを送っていただければ、私が両サイトのHTMLに計測タグを埋め込みます。

---

## 山根さんから私に送ってほしい3つの値

```
1. Google Search Console verification code (slow-fire用)
2. Google Search Console verification code (slow-fire-shop用)
3. GA4 測定ID (slow-fire用、G-XXXXXXX)
4. GA4 測定ID (slow-fire-shop用、G-XXXXXXX)
```

これらが揃ったら30秒で両サイトに埋め込み + 計測開始されます。
