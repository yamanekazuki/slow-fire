# 料理画像 — AI生成プロンプト集（16品）

ChatGPT (GPT-4o / DALL-E 3) や Gemini (Imagen) で各料理のリアル写真を生成するためのプロンプト。

## 共通スタイル指針

すべてのプロンプトの末尾に以下を**追加してください**（もしくは1度だけ「以降このスタイルで」と指定）：

```
Style: editorial food photography, hyperrealistic, warm tungsten lighting,
shallow depth of field, dark wooden table, slight smoke wisps, professional
DSLR shot, magazine-quality, 3:2 aspect ratio, no text, no logos
```

日本語版：
```
スタイル：エディトリアルなフードフォトグラフィ、超リアル写実、暖色系の照明、
浅い被写界深度、濃い色の木製テーブル、煙のかすかな立ち昇り、プロのDSLR撮影、
雑誌品質、横長3:2、文字なし、ロゴなし
```

ChatGPT/DALL-E 3 では英語の方が忠実に反映されます。Geminiは日本語でも比較的精度高め。

---

## 1. シダープランクサーモン → `cedar-salmon.jpg`

```
A perfectly grilled salmon fillet sitting on a slightly charred cedar plank,
visible char marks on the wood, fresh herbs, lemon slices on top, gentle smoke
rising, dark wooden table background, restaurant-grade plating.
```

## 2. 季節の野菜グリル → `veg-grill.jpg`

```
Assorted grilled vegetables on a vegetable basket: bell peppers, zucchini,
king trumpet mushrooms, eringi, mini tomatoes, with grill marks, slight olive
oil sheen, scattered sea salt, dark backdrop.
```

## 3. ポークステーキ → `pork-steak.jpg`

```
A thick 2cm pork loin steak with diamond-shaped grill marks at 45 degrees,
juicy and pink inside, topped with a pat of compound butter melting (rosemary,
maple syrup, mustard visible), dark plate, herbs on the side.
```

## 4. ブラートソーセージ → `bratwurst.jpg`

```
Four bratwurst sausages on a grill grate, golden-brown with crisp blistered
skin, light grill marks, served with a side of honey-mustard sauce in a small
ramekin, dark moody backdrop.
```

## 5. クラシックチーズバーガー → `cheeseburger.jpg`

```
A classic American cheeseburger: toasted brioche bun with grill marks on the
inside, melted cheddar cheese over a juicy beef patty with char, fresh lettuce,
tomato slice, red onion, all stacked tall, served on a wooden board, slight
smoke in background.
```

## 6. 肉詰めしいたけ → `shiitake.jpg`

```
Five large shiitake mushroom caps stuffed with seasoned ground pork mince,
topped with a single shiso (perilla) leaf and brushed with yakitori-style soy
glaze, charred edges, on a cast-iron grill plate, Japanese aesthetic.
```

## 7. スキュアーベジタブル（串野菜）→ `veg-skewer.jpg`

```
Bamboo skewers of bite-sized vegetables (red bell pepper, zucchini, eggplant,
king trumpet mushroom, cherry tomato), basted with basil-pesto and olive oil,
clear grill marks, served on a slate board.
```

## 8. スペアリブ → `spare-ribs.jpg`

```
Hero shot of a rack of glazed spare ribs, glossy BBQ sauce coating, deep
mahogany color, visible bone tips poking through, sliced with one rib pulled
away showing tender pink-red meat inside, cutting board, dark dramatic lighting.
```

## 9. マルゲリータピッツァ → `pizza.jpg`

```
A wood-fired margherita pizza fresh off a pizza stone, blistered crust with
dark spots, melted mozzarella pools, fresh basil leaves on top, ripe cherry
tomatoes, the pizza stone visible underneath in a Weber-style kettle grill.
```

## 10. ガーリックレモンチキン → `lemon-chicken.jpg`

```
Two grilled bone-in chicken thighs, golden crispy skin with char marks,
surrounded by roasted garlic cloves and lemon halves with grill marks,
fresh thyme sprigs, in a cast-iron pan, drizzled with olive oil.
```

## 11. アップルパイ → `apple-pie.jpg`

```
A rustic apple pie with golden-brown puff pastry and slight char on the crust,
cinnamon-sugar dusted, scoop of vanilla ice cream beside it melting, served on
a wooden board with apple slices and a cinnamon stick as garnish.
```

## 12. BBQポテトグラタン → `gratin.jpg`

```
A potato gratin in a foil tray fresh from the grill, deeply browned bubbling
parmesan crust on top, visible cream and cheese layers, sliced potatoes,
slight smoke rising, dark moody background, side of grilled bread.
```

## 13. ビア缶チキン → `beer-can-chicken.jpg`

```
A whole chicken standing upright on a beer can roaster, deeply golden-brown
crispy skin, char marks, in a Weber kettle grill with the lid off, smoke
rising, the iconic "sexy chicken" pose, dramatic lighting.
```

## 14. バックリブ → `back-ribs.jpg`

```
A rack of back ribs after 4-hour low-and-slow smoking, deep mahogany bark,
visible smoke ring (pink layer just below the surface), bones starting to
poke out, pulled apart to show extreme tenderness, on butcher paper, with a
meat thermometer reading 92°C visible.
```

## 15. 上級サーモン（はちみつ×マスタード）→ `salmon-pro.jpg`

```
A salmon fillet with a glossy honey-mustard glaze, beautifully caramelized,
slight char from initial high heat, smoking on a grill, served on a slate
board with grilled lemon halves, dill sprigs.
```

## 16. バナナグリル → `banana.jpg`

```
A banana sliced lengthwise with the skin still on, grilled to caramelization,
drizzled with rum and honey, small flames flickering on the surface, topped
with a melting scoop of vanilla ice cream, dark plate, dramatic side lighting.
```

---

## 一括で頼みたい場合

ChatGPT (GPT-4o) なら一度の会話の中で連続で生成できます。以下のように頼んでください：

```
これから16品のBBQ料理について、以下のスタイル指針で1品ずつ写真を生成してください。
私が「次」と言うたびに次の料理に進んでください。

スタイル指針：
- editorial food photography
- hyperrealistic
- warm tungsten lighting
- shallow depth of field
- dark wooden table
- slight smoke wisps
- 3:2 aspect ratio
- no text, no logos

最初の料理：[1番のプロンプトを貼り付け]
```

そして「次」「次」と進めれば、16品すべて同じ世界観で揃った画像セットが手に入ります。

## 保存先

生成した画像は以下のディレクトリに保存してください：

- `/Users/yamanekazuki/Documents/bbq-shop/images/recipes/{filename}.jpg`
- `/Users/yamanekazuki/Documents/bbq-site/images/recipes/{filename}.jpg`

両方に同じファイルを置くのが一番確実です。
