# 料理画像の差し替えガイド

このフォルダに `{recipe-id}.jpg` という名前で画像を置くと、
cookbook.html のカード／詳細モーダルに自動的に表示されます。

## ファイル名一覧（24品）

| ファイル名 | 料理名 |
|---|---|
| `cedar-salmon.jpg` | シダープランクサーモン |
| `veg-grill.jpg` | 季節の野菜グリル |
| `pork-steak.jpg` | ポークステーキ |
| `bratwurst.jpg` | ブラートソーセージ |
| `cheeseburger.jpg` | クラシックチーズバーガー |
| `shiitake.jpg` | 肉詰めしいたけ |
| `veg-skewer.jpg` | スキュアーベジタブル（串野菜） |
| `spare-ribs.jpg` | スペアリブ |
| `pizza.jpg` | マルゲリータピッツァ |
| `lemon-chicken.jpg` | ガーリックレモンチキン |
| `apple-pie.jpg` | アップルパイ |
| `gratin.jpg` | BBQポテトグラタン |
| `beer-can-chicken.jpg` | ビア缶チキン |
| `back-ribs.jpg` | バックリブ |
| `salmon-pro.jpg` | 上級サーモン（はちみつ×マスタード） |
| `banana.jpg` | バナナグリル |
| `pulled-pork.jpg` | プルドポーク |
| `jerk-chicken.jpg` | ジャマイカン ジャークチキン |
| `saikyo-fish.jpg` | さわらの西京焼き |
| `carne-asada.jpg` | カルネ・アサーダ |
| `tomahawk.jpg` | トマホークステーキ |
| `shrimp-grill.jpg` | ガーリックシュリンプ |
| `mushroom-grill.jpg` | ポートベローマッシュルーム |
| `asparagus-grill.jpg` | アスパラガスのグリル |

## 推奨スペック

- **サイズ**: 1200 × 800 px（横長 3:2 推奨）
- **形式**: JPG（80%品質） or WebP
- **重さ**: 1ファイル 200〜400KB に圧縮
- **色味**: 暖色寄り（火・煙・木目が映える）、濃い目で

## 画像が無いとどうなる？

ファイルが存在しない場合は、自動的にカラーグラデーション＋絵文字のフォールバックUIに切り替わります。
壊れて見えることはありません。

## 画像の入手方法

`PROMPTS.md` を参照してください。ChatGPT (DALL-E 3 / GPT-4o) や Gemini (Imagen) 用の
16品分のプロンプトを用意しています。

最終的には **山根さんが実際のBBQで撮影した実写真** に差し替えるのが一番強いです。
SLOW FIREの正規取扱という信頼性 × 実体験の臨場感は、AI画像では出ません。

---

両サイトで同じ画像を使い回すために、`/Users/yamanekazuki/Documents/bbq-site/images/recipes/`
にも同名でコピーしてください（または symlink）。
