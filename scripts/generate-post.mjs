// =============================================================================
// SLOW FIRE — 自動ブログ生成スクリプト
// -----------------------------------------------------------------------------
// GitHub Actions（週3回 / 月・水・金 朝7時 JST）から実行される。
// Claude API を呼び、SLOW FIRE の思想・実体験を核にした記事を1本生成し、
//   1) blog/<date>-<slug>.html  …… 静的な記事ページ（SEO最適・構造化データ付き）
//   2) blog/posts.json          …… 記事マニフェスト
//   3) blog.html                …… 記事一覧（マニフェストから再生成）
//   4) sitemap.xml              …… 記事URLを含めて再生成
// を書き出す。外部依存なし（Node 20+ の global fetch を使用）。
//
// 必要な環境変数:
//   ANTHROPIC_API_KEY  …… GitHub Secrets に登録（必須）
//   BLOG_MODEL         …… 省略時 claude-opus-4-8
// =============================================================================

import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { existsSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");            // bbq-site/
const BLOG_DIR = join(ROOT, "blog");
const MANIFEST = join(BLOG_DIR, "posts.json");
const SITE = "https://yamanekazuki.github.io/slow-fire";
const MODEL = process.env.BLOG_MODEL || "claude-opus-4-8";

// -----------------------------------------------------------------------------
// SLOW FIRE 知識ベース — 記事の一次情報（E-E-A-T の核）。山根さんの実体験由来。
// これがあるから「AI量産記事」ではなく「経験に裏打ちされた記事」になる。
// -----------------------------------------------------------------------------
const KNOWLEDGE = `
# SLOW FIRE の思想（全記事の判断軸・最優先）
- ミッション:「BBQを日常にする」。
- 提供したいのは Concrete（美味しい）ではなく、Subtle / MetAware の領域の体験。
  ・場の雰囲気が転換する／会話の質が変わる／会話がなくても場が成立する。
  ・サウナ・森林浴・キスと同類の、神経学的・ホルモン的な変化を「食 × 日常」で起こす独自性。
- ポジション: Weber は思想を広める「吉田松陰（0→0.5の啓蒙家）」。SLOW FIRE は新しい「0→1」の創発役。
- なぜBBQか: 食は誰の趣味にも依存しない普遍的ニーズ。万人に届く超ブルーオーシャン。
- 判断基準: あらゆる文章で「これは Concrete 止まりか、Subtle 以上に届くか？」を問う。

# アメリカンBBQ vs 日本の一般的なバーベキュー（体験で掴んだ核心）
- 日本式: 直火（ダイレクト）・高温短時間・タレ/醤油ベース。焼肉に近い。
- アメリカンBBQ: 間接熱（インダイレクト）でグリル全体をオーブンとして使う。
  低温長時間（ロー&スロー）。乾燥スパイス=ラブ（rub）が味の核心。スモークで香り付け。
  温度管理が命=内部温度計（プローブ）必須、グリル表示は信用しない。ツーゾーンファイア。

# 道具（杉板・ラック・シールド）
- 20分超える → ラック+シールド／魚・崩れそう → 杉板／焦げそう → ラック。
- 杉板は30分水に浸してからグリルで温める。

# 料理別 温度・時間チャート（通常調理）
- シダープランク・サーモン: 杉板 200〜230℃ 8〜12分 中心53℃
- 鶏むね（しっとり）: ラック 200〜220℃→仕上げダイレクト 20〜25分 中心73℃
- 鶏もも（皮パリ）: ラック 220℃→260〜280℃で皮 15〜20分＋2〜3分
- 豚肩ロース厚切り: ラック+シールド 200〜220℃ 25〜40分 中心63℃
- 豚ロースステーキ: 280℃ 2cm片面2分半×2 中心63℃（休ませ1/3）
- ローストビーフ: ラック+シールド 180〜200℃ 40〜60分 レア中心52〜54℃
- 野菜: ラック 230〜250℃ 片面2〜3分
- カマンベール: 杉板 180〜200℃ 8〜12分

# ロー&スロー 温度チャート（上級）
- プルドポーク（豚肩）: 120〜125℃ 中心97℃
- スペアリブ（豚）: 120〜125℃ 中心92℃前後
- ビーフショートリブ: 110〜120℃ 中心92〜95℃
- ブリスケット（牛胸）: 110℃ 中心92〜96℃（スタリング=停滞に注意）
- 牛ほほ肉: 110〜120℃ 中心95〜98℃
- ラムショルダー: 120℃ 中心90〜92℃
- 丸鶏: 120〜135℃ 胸68〜70℃

# 実体験の気づき
- 仕込みは一括で。都度仕込むと追いつかない。
- ガスグリルの温度表示は信用しない、外付けプローブが正確。
- ラブをたっぷりつけた肉はインダイレクト推奨（ダイレクトだと焦げる）。
- ロー&スローは2品同時が効率的。
- 杉板料理（エビ・ホタテ・チーズ）は喝采が起きる。特に女性陣に効果的。
- テーブルファシリテーター（熱の流れ・ラブの違いを解説する人）の存在が場を作る。
- 参加型（一緒に味付け・盛り付け）で愛着・当事者意識が生まれる。
- BBQはカメレオン: 関係性によって役割が変わる
  ・既に対話できる仲→副菜的／日常的だが浅い仲→関係を超越させるきっかけ
  ・絶妙な仲→相互理解のきっかけ／冷え切った仲→普遍的な「おいしい」で場を温める。

# あんBBQ（An BBQ / ニューバーベキュー）の思想 — 正本 AN-BBQ-PHILOSOPHY.md の凝縮
- アメリカンBBQの優れたロジック（蓋付きグリル・間接熱・ロー&スロー・温度の科学）は継承する。
  ただし12時間級の長時間燻製スタイルは日本の暮らしに根づかない。その限界を超えて日常に溶け込む新概念が「あんBBQ」。
- コピーの3原則:
  1. 5〜6時間で完結（作って食べて楽しんで全部込み。12時間は憧れとして語ってよいが、推奨スタイルはこちら）
  2. 熱々を、出来立てで（冷めた塊肉＋ソースにしない。プルドポークは冷めるし乾く——それにBBQソースをかけるのは、A5焼肉を自家製タレで食べるのと同じロジック）
  3. 多品種（肉2〜3種＋副菜・シーフード。普通のスーパーの食材で。ヘルシー志向にも応える）
- 背景の洞察:
  ・アジア人はせっかち。忙しさの中に暮らしがあり、調理だけに12時間＋一晩は現実的でない。BBQ場・グランピング施設も5〜6時間超の利用を前提にしていない（環境的限界）。
  ・塊肉を何時間も育ててプルアップする儀式は「男のホビー」（プラモデル/ミニ四駆的な遊びの延長）としては面白いが、「日常の食として美味しい」感動を超えなかった。
  ・日本人の食の本質は「少しずつ、多種多様なものを、常に熱々で」。塊肉ドカン1つはバラエティ欠如。
  ・本場級の塊肉は流通構造・カット基準で普通のスーパーに無い。コストコ頼み＝非日常のままでは文化にならない。
  ・日本の従来BBQ=「直火で焼き、炭火で焦がす」→外は真っ黒・中はカスカス→「面倒なわりに美味しくない」という諦め。
  ・突破の鍵=蓋付きグリル（熱対流・インダイレクト）のロジック: 絶対に焦がさず、水分を保ち、食材のポテンシャルを最大化。片付け・後処理もスマート。
- 定義:「普通のスーパーで買える日常の食材や、日本全国の豊かな食材を、蓋付きグリルのロジックで圧倒的に美味しく変貌させる」日常に寄り添うアプローチ。
  その先にあるのは、豊かな食卓を囲み人間の温かい関係性をつなぎ直す、次世代のクリーンでサステナブルな食文化。
- 調味料のコモディティ化への挑戦: 日本は万能スパイスが大衆化しすぎ「誰が焼いても同じ味」に。世界一味覚に敏感なはずの日本人が創作の味付けを追求しなくなった。第一歩=BBQ先進国オーストラリアの多様なプレミアム・ラブの輸入、その先に自社オリジナルスパイスの開発。驚きのある食卓への新しい味覚の選択肢を架ける。
- AI時代の使命: ゴールは「今週末BBQしよう」と言い合えるカジュアル・カルチャー。テクノロジーで人間関係が希薄化する時代、同じ火を囲めば無言の時間すら心地よい「安心の場」＝人間関係の最強のハブ。温かい繋がりと対話を取り戻す次世代の食文化。

# チーム・事実
- Weber Grill Academy 初級〜上級まで全コース修了チームが運営。
- 海外（オーストラリア/アメリカ）のラブは深みが段違い。SLOW FIRE SHOP で正規取扱。
- Instagram 中心に発信（@afro_anri）。出張BBQ・体験サービスを提供。
`;

// -----------------------------------------------------------------------------
// テーマの種（投稿数で巡回。AIはこれを起点に、未掲載の切り口へ展開する）
// -----------------------------------------------------------------------------
const TOPIC_SEEDS = [
  "ロー&スローという哲学：低温長時間がなぜ場を変えるのか",
  "ラブ（乾燥スパイス）入門：タレ文化との決定的な違い",
  "ツーゾーンファイアの作り方と、火を操るという感覚",
  "プルドポークを初めて作る人へ：失敗しない温度と時間",
  "杉板料理が食卓に喝采を起こす理由（サーモン・ホタテ・チーズ）",
  "プローブ温度計という相棒：グリルの表示を信じてはいけない",
  "ブリスケットのスタリング（停滞）とどう向き合うか",
  "BBQはカメレオン：関係性によって役割が変わるという話",
  "なぜ『美味しい』の先を目指すのか：Subtle な体験という考え方",
  "週末の食卓をBBQにするだけで、会話の質はどう変わるか",
  "鶏もも肉の皮をパリッと仕上げる、間接熱からの逆算",
  "ホストの技術：テーブルファシリテーターという役割",
  "仕込みは一括で：段取りがBBQの体験を決める",
  "野菜とチーズが主役になる日：肉だけじゃないBBQ",
  "ローストビーフを家庭のグリルで：休ませる時間の意味",
  "スモークの香りの正体と、付けすぎないという美学",
  "BBQを日常にする、という挑戦について",
  "オーストラリア産ラブの深み：海外スパイスを選ぶ理由",
  // --- あんBBQ（日本の暮らしに翻訳したニューバーベキュー） ---
  "あんBBQとは何か——12時間の憧れと、5〜6時間の現実",
  "普通のスーパーの食材が劇的に美味しくなる、蓋付きグリルのロジック",
  "冷めたプルドポーク問題——熱々を出来立てで配るBBQの設計",
  "肉2〜3種＋副菜＋シーフード：飽きさせないあんBBQの組み立て方",
  "BBQ場の5時間枠で完結するタイムライン設計",
  "直火で焦がす日本のBBQからの卒業——「面倒なわりに美味しくない」を終わらせる",
  "片付けがスマートになる理由：蓋付きグリルの後処理ロジック",
  "男のホビーから、家族の食卓へ——BBQが日常になる条件",
  "塊肉ドカンでは足りない：日本人の「少しずつ、多種多様に、熱々で」に応える",
  "コストコに頼らないBBQ——日常の食材で文化にするという発想",
  "万能スパイスの標準化を超える——BBQラブで創作を取り戻す",
  "オーストラリアのプレミアムラブという選択肢",
  "AI時代にBBQが人間関係のハブになる理由——無言も心地よい火のまわり",
];

const CATEGORIES = ["哲学", "技術", "レシピ", "道具", "ホスト論", "カルチャー"];

// -----------------------------------------------------------------------------
// JSON スキーマ（structured output で構造化された記事を受け取る）
// -----------------------------------------------------------------------------
const SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    title: { type: "string", description: "記事タイトル。断言的で力強く、煽らない。28〜45字程度。" },
    slug: { type: "string", description: "URL用の英語スラッグ。小文字・ハイフン区切り・3〜6語。例: low-and-slow-philosophy" },
    category: { type: "string", enum: CATEGORIES, description: "記事カテゴリ" },
    description: { type: "string", description: "meta description。検索者の役に立つ要約。90〜120字。" },
    excerpt: { type: "string", description: "一覧やリードに使う一文。40〜70字。やわらかい語り口。" },
    tags: { type: "array", items: { type: "string" }, description: "3〜5個の日本語タグ" },
    body_html: {
      type: "string",
      description:
        "記事本文のHTML。<h2>/<h3>/<p>/<ul><li>/<blockquote> のみ使用（<h1>は使わない）。" +
        "1200〜1800字程度。導入→本論（具体的な温度・時間・道具など一次情報を必ず織り込む）→ " +
        "Subtle/MetAware の思想に着地。最後の段落で読者に問いかけるか、次の週末を想像させて締める。",
    },
  },
  required: ["title", "slug", "category", "description", "excerpt", "tags", "body_html"],
};

// -----------------------------------------------------------------------------
// ユーティリティ
// -----------------------------------------------------------------------------
function jstDateString() {
  // 実行は UTC。JST(+9h) に補正して YYYY-MM-DD を得る。
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

function jstDisplayDate(iso) {
  const [y, m, d] = iso.split("-");
  return `${y}年${Number(m)}月${Number(d)}日`;
}

function sanitizeSlug(slug, date) {
  const cleaned = String(slug || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return cleaned || `slow-fire-${date}`;
}

function esc(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function loadManifest() {
  if (!existsSync(MANIFEST)) return [];
  try {
    return JSON.parse(await readFile(MANIFEST, "utf8"));
  } catch {
    return [];
  }
}

// -----------------------------------------------------------------------------
// Claude API 呼び出し（Messages API / structured output）
// -----------------------------------------------------------------------------
async function generateArticle(seed, avoidTitles) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY が未設定です。");

  const system = `あなたは BBQ ブランド「SLOW FIRE」のオウンドメディア編集者兼ライターです。
以下の思想と一次情報「だけ」を素材に、BBQを愛する人・これから愛したい人の心に届く記事を日本語で書きます。

${KNOWLEDGE}

# 記事の2系統（テーマの種からどちらか判断する）
- A系統=アメリカンBBQ探求の入口記事: ロー&スロー・ラブ・温度管理・ブリスケットなど、本場アメリカンBBQに憧れて検索してきた読者向け。憧れと探求心にまっすぐ応える。
  ただし結びで一段だけ、自然にあんBBQへの橋を架ける——読者が遠からず突き当たる同じ課題（12時間は現実的でない・塊肉は冷める・単調）にそっと触れ、「5〜6時間で完結する日本の暮らしに翻訳したやり方（あんBBQ）もある」と示す。橋は1段だけ。説教や宗旨替えの強要にせず、アメリカンBBQ探求そのものは否定しない。
- B系統=あんBBQ実践記事: あんBBQの思想（5〜6時間完結・熱々を出来立てで・多品種・普通のスーパーの食材・蓋付きグリルのロジック）を正面から実践的に書く。
- どちらの系統でも、アメリカンBBQの温度の科学・道具のロジックという土台は共通。全部をあんBBQに寄せず、入口記事の役割も大切にする。

# 書き方の指針（重要）
- 声: タイトルは断言的で力強く、本文はやわらかく語りかける。煽り・誇大表現・絵文字は使わない。
- 必ず一次情報（具体的な温度・時間・道具・体験の気づき）を本文に織り込む。一般論の寄せ集めにしない。
- 最終的に「美味しい(Concrete)」の先にある Subtle / MetAware（場・関係性・時間の体験）へ着地させる。
- 検索者の役に立つ実用性と、読み物としての余韻を両立させる。SEOのためのキーワード詰め込みはしない。
- 既出タイトルと内容が重複しないよう、新しい切り口で書く。
- 読者は出張BBQの見込み客でもある。最後にさりげなく「次の週末」や「場」を想像させて締めてよいが、売り込みはしない。

出力は指定された JSON スキーマに厳密に従うこと。`;

  const avoid =
    avoidTitles.length > 0
      ? `\n\n# 既に公開済みのタイトル（重複回避）\n- ${avoidTitles.join("\n- ")}`
      : "";

  const userMsg = `今回のテーマの種:「${seed}」
このテーマを起点に、SLOW FIRE の思想に貫かれた記事を1本書いてください。テーマの種は出発点であり、より具体的で新鮮な切り口に発展させて構いません。${avoid}`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 8000,
      system,
      output_config: {
        effort: "high",
        format: { type: "json_schema", schema: SCHEMA },
      },
      messages: [{ role: "user", content: userMsg }],
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Claude API エラー ${res.status}: ${text}`);
  }

  const data = await res.json();
  if (data.stop_reason === "refusal") {
    throw new Error("Claude が応答を拒否しました（refusal）。");
  }
  const textBlock = (data.content || []).find((b) => b.type === "text");
  if (!textBlock) throw new Error("テキストブロックが見つかりません。");
  return JSON.parse(textBlock.text);
}

// -----------------------------------------------------------------------------
// HTML レンダリング — サイト（index.html）のヘッダ/ナビ/フッタ構造を踏襲
// -----------------------------------------------------------------------------
const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400;0,700;0,900;1,400;1,700&family=Noto+Sans+JP:wght@300;400;500;700&family=Bebas+Neue&family=Cormorant+Garamond:ital,wght@1,300;1,400;1,600&display=swap" rel="stylesheet">`;

const FAVICON = `<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%23080604'/%3E%3Ctext x='16' y='22' font-family='serif' font-size='18' font-weight='700' fill='%23f97316' text-anchor='middle'%3ES%3C/text%3E%3C/svg%3E">`;

// Google Analytics (GA4) — 全ページ共通の計測タグ
const GA = `  <!-- Google Analytics (GA4) -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-S66C9TDVT2"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', 'G-S66C9TDVT2');
  </script>`;

// ナビ/モバイル/フッタ。相対パスのプレフィックス（記事ページは blog/ 配下なので "../"）
function nav(prefix) {
  return `<nav id="nav">
    <div class="nav-inner">
      <a href="${prefix}index.html" class="nav-logo">SLOW FIRE</a>
      <ul class="nav-links">
        <li><a href="${prefix}index.html#difference">哲学</a></li>
        <li><a href="${prefix}cookbook.html">料理ガイド</a></li>
        <li><a href="${prefix}cooklog.html">記録</a></li>
        <li><a href="${prefix}blog.html">読みもの</a></li>
        <li><a href="${prefix}index.html#services">サービス</a></li>
        <li><a href="${prefix}team.html">チーム</a></li>
        <li><a href="${prefix}venues.html">BBQスポット</a></li>
        <li><a href="https://yamanekazuki.github.io/slow-fire-shop/" target="_blank" rel="noopener">SHOP ↗</a></li>
        <li><a href="${prefix}index.html#contact" class="nav-cta">お問い合わせ</a></li>
      </ul>
      <button class="nav-hamburger" aria-label="メニュー" aria-expanded="false" aria-controls="mobileMenu">
        <span></span><span></span><span></span>
      </button>
    </div>
  </nav>

  <div class="mobile-menu" id="mobileMenu" aria-hidden="true">
    <a href="${prefix}index.html#difference">哲学</a>
    <a href="${prefix}cookbook.html">料理ガイド</a>
    <a href="${prefix}cooklog.html">記録</a>
    <a href="${prefix}blog.html">読みもの</a>
    <a href="${prefix}index.html#services">サービス</a>
    <a href="${prefix}team.html">チーム</a>
    <a href="${prefix}venues.html">BBQスポット</a>
    <a href="https://yamanekazuki.github.io/slow-fire-shop/" target="_blank" rel="noopener">SHOP ↗</a>
    <a href="${prefix}index.html#contact" class="mm-cta">お問い合わせ</a>
  </div>`;
}

function footer(prefix) {
  return `<footer>
    <div class="footer-inner">
      <div class="footer-top">
        <div class="footer-brand">
          <div class="footer-logo">SLOW FIRE</div>
          <p class="footer-tagline">火と時間が、食卓を変える。</p>
        </div>
        <nav class="footer-nav" aria-label="フッターナビゲーション">
          <a href="${prefix}index.html#difference">哲学</a>
          <a href="${prefix}cookbook.html">料理ガイド</a>
          <a href="${prefix}cooklog.html">記録</a>
          <a href="${prefix}blog.html">読みもの</a>
          <a href="${prefix}team.html">チーム</a>
          <a href="${prefix}venues.html">BBQスポット</a>
          <a href="https://yamanekazuki.github.io/slow-fire-shop/" target="_blank" rel="noopener">SHOP（BBQラブ通販）↗</a>
          <a href="${prefix}index.html#contact">お問い合わせ</a>
        </nav>
      </div>
      <div class="footer-bottom">
        <p class="footer-copy">© 2026 SLOW FIRE. All rights reserved.</p>
        <p class="footer-copy">Weber Grill Academy 受講チーム — Low n Slow Basics 日本正規取扱</p>
      </div>
    </div>
  </footer>`;
}

// 記事ページ（blog/<file>.html）
function renderPost(post) {
  const url = `${SITE}/blog/${post.file}`;
  const display = jstDisplayDate(post.date);
  const ld = {
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    headline: post.title,
    description: post.description,
    datePublished: post.date,
    dateModified: post.date,
    inLanguage: "ja-JP",
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
    author: { "@type": "Organization", name: "SLOW FIRE", url: SITE + "/" },
    publisher: {
      "@type": "Organization",
      name: "SLOW FIRE",
      url: SITE + "/",
    },
    articleSection: post.category,
    keywords: post.tags.join(", "),
  };
  const breadcrumb = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "SLOW FIRE", item: SITE + "/" },
      { "@type": "ListItem", position: 2, name: "読みもの", item: SITE + "/blog.html" },
      { "@type": "ListItem", position: 3, name: post.title, item: url },
    ],
  };

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${esc(post.title)}｜SLOW FIRE 読みもの</title>
  <meta name="description" content="${esc(post.description)}">
  <meta name="keywords" content="${esc(post.tags.join(","))},SLOW FIRE,アメリカンBBQ,ロー&スロー">
  <meta name="author" content="SLOW FIRE">
  <meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1">
  <link rel="canonical" href="${url}">
  <meta property="og:type" content="article">
  <meta property="og:site_name" content="SLOW FIRE">
  <meta property="og:title" content="${esc(post.title)}">
  <meta property="og:description" content="${esc(post.description)}">
  <meta property="og:url" content="${url}">
  <meta property="og:locale" content="ja_JP">
  <meta property="article:published_time" content="${post.date}">
  <meta property="article:section" content="${esc(post.category)}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(post.title)}">
  <meta name="twitter:description" content="${esc(post.description)}">
  <meta name="theme-color" content="#080604">
  ${FAVICON}
  ${FONTS}
  <link rel="stylesheet" href="../style.css">
  <link rel="stylesheet" href="../blog.css">
  <script type="application/ld+json">${JSON.stringify(ld)}</script>
  <script type="application/ld+json">${JSON.stringify(breadcrumb)}</script>
${GA}
</head>
<body>
  <div class="grain-overlay" aria-hidden="true"></div>
  ${nav("../")}

  <main class="blog-article">
    <article>
      <header class="article-head">
        <nav class="article-crumb" aria-label="パンくず">
          <a href="../blog.html">読みもの</a> <span>/</span> <span>${esc(post.category)}</span>
        </nav>
        <span class="article-cat">${esc(post.category)}</span>
        <h1 class="article-title">${esc(post.title)}</h1>
        <p class="article-meta"><time datetime="${post.date}">${display}</time> ・ SLOW FIRE</p>
      </header>
      <div class="article-body">
        ${post.body_html}
      </div>
      <div class="article-tags">
        ${post.tags.map((t) => `<span class="tag">#${esc(t)}</span>`).join("")}
      </div>
      <aside class="article-cta">
        <p>火と時間がつくる「場」を、あなたの食卓でも。</p>
        <a class="btn-fire" href="../index.html#contact">出張BBQ・体験について相談する</a>
        <a class="btn-ghost" href="../blog.html">ほかの読みものを見る</a>
      </aside>
    </article>
  </main>

  ${footer("../")}
  <script src="../script.js"></script>
</body>
</html>
`;
}

// 一覧ページ（blog.html）
function renderIndex(manifest) {
  const cards = manifest
    .map(
      (p) => `      <a class="post-card" href="blog/${p.file}">
        <span class="post-card-cat">${esc(p.category)}</span>
        <h2 class="post-card-title">${esc(p.title)}</h2>
        <p class="post-card-excerpt">${esc(p.excerpt)}</p>
        <span class="post-card-date"><time datetime="${p.date}">${jstDisplayDate(p.date)}</time></span>
      </a>`
    )
    .join("\n");

  const ld = {
    "@context": "https://schema.org",
    "@type": "Blog",
    name: "SLOW FIRE 読みもの",
    url: SITE + "/blog.html",
    inLanguage: "ja-JP",
    publisher: { "@type": "Organization", name: "SLOW FIRE", url: SITE + "/" },
    blogPost: manifest.slice(0, 20).map((p) => ({
      "@type": "BlogPosting",
      headline: p.title,
      datePublished: p.date,
      url: `${SITE}/blog/${p.file}`,
    })),
  };

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>読みもの｜SLOW FIRE — 火と時間が、食卓を変える</title>
  <meta name="description" content="ロー&スローの哲学、ラブの選び方、温度と時間の技術、そして『場』としてのBBQ。Weber Grill Academy受講チームSLOW FIREが、実体験から綴る読みもの。">
  <meta name="keywords" content="アメリカンBBQ,ロー&スロー,BBQラブ,プルドポーク,ブリスケット,出張BBQ,SLOW FIRE,BBQ コラム">
  <meta name="author" content="SLOW FIRE">
  <meta name="robots" content="index,follow,max-image-preview:large,max-snippet:-1">
  <link rel="canonical" href="${SITE}/blog.html">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="SLOW FIRE">
  <meta property="og:title" content="読みもの｜SLOW FIRE">
  <meta property="og:description" content="ロー&スローの哲学と技術、そして『場』としてのBBQを綴る読みもの。">
  <meta property="og:url" content="${SITE}/blog.html">
  <meta property="og:locale" content="ja_JP">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="theme-color" content="#080604">
  ${FAVICON}
  ${FONTS}
  <link rel="stylesheet" href="style.css">
  <link rel="stylesheet" href="blog.css">
  <script type="application/ld+json">${JSON.stringify(ld)}</script>
${GA}
</head>
<body>
  <div class="grain-overlay" aria-hidden="true"></div>
  ${nav("")}

  <header class="blog-hero">
    <div class="blog-hero-inner">
      <span class="blog-hero-eyebrow">READING / 読みもの</span>
      <h1 class="blog-hero-title">火と時間の、その先の話。</h1>
      <p class="blog-hero-sub">本場アメリカンBBQの探求も、日本の暮らしに翻訳したあんBBQも。温度・時間・道具という技術の話から、なぜBBQが「場」を変えるのかという話まで。Weber Grill Academy受講チームが、実体験から綴ります。</p>
    </div>
  </header>

  <main class="blog-list">
    <div class="post-grid">
${cards || '      <p class="post-empty">最初の記事を準備中です。</p>'}
    </div>
  </main>

  ${footer("")}
  <script src="script.js"></script>
</body>
</html>
`;
}

// sitemap.xml（静的ページ + ブログ + 記事をすべて再生成）
function renderSitemap(manifest, today) {
  const staticPages = [
    { loc: `${SITE}/`, freq: "weekly", pri: "1.0", mod: "2026-05-05" },
    { loc: `${SITE}/blog.html`, freq: "weekly", pri: "0.9", mod: today },
    { loc: `${SITE}/cookbook.html`, freq: "monthly", pri: "0.9", mod: "2026-05-05" },
    { loc: `${SITE}/cooklog.html`, freq: "weekly", pri: "0.9", mod: "2026-06-21" },
    { loc: `${SITE}/venues.html`, freq: "monthly", pri: "0.8", mod: "2026-05-05" },
    { loc: `${SITE}/team.html`, freq: "monthly", pri: "0.8", mod: "2026-05-05" },
  ];
  const postUrls = manifest.map((p) => ({
    loc: `${SITE}/blog/${p.file}`,
    freq: "monthly",
    pri: "0.7",
    mod: p.date,
  }));
  const all = [...staticPages, ...postUrls];
  const body = all
    .map(
      (u) =>
        `  <url>\n    <loc>${u.loc}</loc>\n    <lastmod>${u.mod}</lastmod>\n    <changefreq>${u.freq}</changefreq>\n    <priority>${u.pri}</priority>\n  </url>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

// GitHub Actions のステップ出力に書き出す（メール通知ステップが参照する）。
// 複数行・記号を含む値も安全に渡せるようヒアドキュメント形式を使う。
function setGithubOutput(pairs) {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) return;
  let body = "";
  for (const [k, v] of Object.entries(pairs)) {
    body += `${k}<<SFEOF\n${v}\nSFEOF\n`;
  }
  appendFileSync(out, body);
}

// -----------------------------------------------------------------------------
// メイン
// -----------------------------------------------------------------------------
async function main() {
  await mkdir(BLOG_DIR, { recursive: true });
  const manifest = await loadManifest();
  const date = jstDateString();

  // 同日に既に生成済みなら何もしない（手動再実行の二重生成を防ぐ）。
  // ただし FORCE=true（手動テスト）のときはこのガードを無視して必ず生成する。
  const force = process.env.FORCE === "true";
  if (!force && manifest.some((p) => p.date === date)) {
    console.log(`本日(${date})の記事は既に存在します。スキップします。`);
    setGithubOutput({ generated: "false" });
    return;
  }

  const seed = TOPIC_SEEDS[manifest.length % TOPIC_SEEDS.length];
  const avoidTitles = manifest.map((p) => p.title);
  console.log(`テーマの種: ${seed}`);

  const article = await generateArticle(seed, avoidTitles);
  const slug = sanitizeSlug(article.slug, date);
  const file = `${date}-${slug}.html`;

  const post = {
    title: article.title,
    category: CATEGORIES.includes(article.category) ? article.category : "カルチャー",
    description: article.description,
    excerpt: article.excerpt,
    tags: Array.isArray(article.tags) ? article.tags.slice(0, 5) : [],
    body_html: article.body_html,
    date,
    slug,
    file,
  };

  // 記事ページ書き出し
  await writeFile(join(BLOG_DIR, file), renderPost(post), "utf8");

  // マニフェスト更新（新しい順 = 先頭に追加）。本文はファイルにあるので一覧用に軽くしてもよいが保持。
  const next = [{ ...post }, ...manifest];
  await writeFile(MANIFEST, JSON.stringify(next, null, 2) + "\n", "utf8");

  // 一覧・サイトマップ再生成
  await writeFile(join(ROOT, "blog.html"), renderIndex(next), "utf8");
  await writeFile(join(ROOT, "sitemap.xml"), renderSitemap(next, date), "utf8");

  // メール通知ステップ向けに出力をセット
  setGithubOutput({
    generated: "true",
    title: post.title,
    excerpt: post.excerpt,
    category: post.category,
    url: `${SITE}/blog/${file}`,
  });

  console.log(`生成完了: blog/${file}`);
  console.log(`タイトル: ${post.title}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
