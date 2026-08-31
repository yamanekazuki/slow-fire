/* =============================================
   COOK LOG — Cloud Functions
   - analyzeCookPhoto : BBQ写真をClaude(Vision)で解析し
     料理名・タグ・作り方メモ・道具・温度帯を自動推定
   ============================================= */
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { setGlobalOptions } = require('firebase-functions/v2');
const { defineSecret } = require('firebase-functions/params');
const admin = require('firebase-admin');
const crypto = require('crypto');

admin.initializeApp();
setGlobalOptions({ region: 'asia-northeast1', maxInstances: 10 });

// 設定: firebase functions:secrets:set ANTHROPIC_API_KEY
const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');
// SLOW FIRE JOURNAL 改善ループ Phase2：承認ボタンの署名鍵とディスパッチ用トークン
const APPROVAL_SECRET = defineSecret('APPROVAL_SECRET');
const BBQ_GH_DISPATCH_TOKEN = defineSecret('BBQ_GH_DISPATCH_TOKEN');
// 実装ワークフローを動かすGitHubリポジトリ（ブログ本体）
const BBQ_REPO = 'yamanekazuki/slow-fire-shop';

const COOK_TAGS = ['牛', '豚', '鶏', 'ラム', '魚介', '野菜', 'スモーク', 'ロースト', '直火', '低温長時間', '燻製', 'デザート', '初挑戦', '自信作'];

exports.analyzeCookPhoto = onCall(
  { secrets: [ANTHROPIC_API_KEY], cors: true, memory: '512MiB', timeoutSeconds: 60 },
  async (request) => {
    const data = request.data || {};
    const imageB64 = data.image;
    const mime = data.mime || 'image/jpeg';
    if (!imageB64 || typeof imageB64 !== 'string') {
      throw new HttpsError('invalid-argument', '画像データがありません');
    }

    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY.value() });

    const schema = {
      type: 'object',
      additionalProperties: false,
      properties: {
        dishName:  { type: 'string', description: '料理名。簡潔で具体的に（例：スペアリブのスモーク）' },
        tags:      { type: 'array', items: { type: 'string', enum: COOK_TAGS }, description: '当てはまるタグ（最大4つ）' },
        method:    { type: 'string', description: '写真から推測できる調理法・火加減・ポイントのメモ（2〜3文、日本語）' },
        gear:      { type: 'string', description: '使っていそうなグリル/道具。不明なら空文字' },
        tempLabel: { type: 'string', description: '推測される温度帯（例：高温直火 / 低温110℃）。不明なら空文字' },
        isFood:    { type: 'boolean', description: '料理・食材の写真ならtrue、そうでなければfalse' }
      },
      required: ['dishName', 'tags', 'method', 'gear', 'tempLabel', 'isFood']
    };

    try {
      const response = await client.messages.create({
        model: 'claude-opus-4-8',
        max_tokens: 1024,
        system: 'あなたはBBQ・グリル料理の専門家です。アップロードされた写真を見て、何の料理かを推測し、日本語でタイトル・タグ・作り方メモを生成します。確信が持てない部分は無理に断定せず、自然な範囲で推測してください。タグは指定された候補からのみ選びます。',
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mime, data: imageB64 } },
            { type: 'text', text: 'このBBQ/料理写真を解析して、料理名・タグ・作り方メモ・道具・温度帯を埋めてください。料理でない写真ならisFoodをfalseにしてください。' }
          ]
        }],
        output_config: { format: { type: 'json_schema', schema } }
      });

      const textBlock = (response.content || []).find(b => b.type === 'text');
      if (!textBlock) throw new HttpsError('internal', 'AI応答が空でした');
      return JSON.parse(textBlock.text);
    } catch (err) {
      console.error('analyzeCookPhoto error:', err);
      throw new HttpsError('internal', err.message || 'AI解析に失敗しました');
    }
  }
);

/* =============================================
   SLOW FIRE JOURNAL — 改善ループ Phase2（承認ボタンの受け口）
   - bbqProposalAction : メールの［承認/却下］→ 実装ワークフローを起動
   - bbqChangeAction    : プレビューの［公開/取消］・完了の［元に戻す］
   署名(HMAC)で改ざん・総当りを防ぐ。状態はリンクに署名付きで載せる
   ステートレス方式（Firestore不要）。実体の編集/公開は slow-fire-shop の
   GitHub Actions（repository_dispatch）が担当する。
   ============================================= */

// 署名検証：d(base64url JSON) と t(HMAC) が一致するか
function verifyToken(secret, d, t) {
  const expected = crypto.createHmac('sha256', String(secret)).update(String(d)).digest('hex').slice(0, 32);
  // タイミング安全比較
  const a = Buffer.from(String(t || ''));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function decodePayload(d) {
  const json = Buffer.from(String(d).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  return JSON.parse(json);
}

// GitHub repository_dispatch を送る
async function bbqDispatch(token, eventType, payload) {
  if (!token || token.startsWith('placeholder')) {
    console.warn('BBQ_GH_DISPATCH_TOKEN 未設定/placeholder。ディスパッチをスキップ');
    return false;
  }
  const r = await fetch(`https://api.github.com/repos/${BBQ_REPO}/dispatches`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      'User-Agent': 'slow-fire-loop',
    },
    body: JSON.stringify({ event_type: eventType, client_payload: payload }),
  });
  if (!r.ok) { console.error('bbqDispatch失敗', r.status, (await r.text()).slice(0, 200)); return false; }
  return true;
}

// 確認ページ（BBQの暖色トーン）
function page({ kind, headline, msg, title, brand }) {
  const b = brand || 'SLOW FIRE JOURNAL';
  const color = kind === 'error' ? '#dc2626' : kind === 'reject' ? '#64748b' : '#c2410c';
  const icon = kind === 'error' ? '⚠️' : kind === 'reject' ? '🗂' : '✅';
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${b}</title></head>
<body style="margin:0;background:#faf7f2;font-family:-apple-system,'Hiragino Sans',sans-serif">
  <div style="max-width:520px;margin:48px auto;background:#fff;border:1px solid #ececec;border-radius:14px;overflow:hidden">
    <div style="background:#080604;padding:18px 24px;color:#c2410c;font-size:12px;letter-spacing:.12em;font-weight:700">${b}</div>
    <div style="padding:30px 26px">
      <div style="font-size:40px;line-height:1">${icon}</div>
      <h1 style="font-size:19px;color:${color};margin:12px 0 8px">${headline}</h1>
      ${title ? `<div style="font-size:13px;color:#1b1b1b;background:#faf7f2;border-radius:8px;padding:10px 12px;margin-bottom:10px">${String(title).replace(/[<>]/g, '')}</div>` : ''}
      <p style="font-size:13px;color:#666;line-height:1.9">${msg}</p>
      <p style="font-size:12px;color:#aaa;margin-top:20px">このタブは閉じて大丈夫です。</p>
    </div>
  </div>
</body></html>`;
}

// 承認/却下：メールの［承認して実装する］［却下］の着地点
exports.bbqProposalAction = onRequest(
  { region: 'asia-northeast1', memory: '256MiB', secrets: [APPROVAL_SECRET, BBQ_GH_DISPATCH_TOKEN], maxInstances: 3, cors: false },
  async (req, res) => {
    const d = req.query.d, t = req.query.t;
    const secret = APPROVAL_SECRET.value();
    if (!d || !t || !verifyToken(secret, d, t)) {
      res.status(403).send(page({ kind: 'error', headline: 'リンクが無効です', msg: 'リンクが正しくないか、期限切れの可能性があります。' }));
      return;
    }
    let body;
    try { body = decodePayload(d); } catch { res.status(400).send(page({ kind: 'error', headline: 'データを読めませんでした', msg: 'リンクが壊れている可能性があります。' })); return; }
    const proposal = body.proposal || {};
    // domain で「ショップ本体(EC)」と「ブログ記事」を振り分ける（未指定は従来どおりarticle）。
    const isShop = proposal.domain === 'shop';
    const brand = isShop ? 'SLOW FIRE SHOP' : 'SLOW FIRE JOURNAL';
    if (body.kind === 'reject') {
      res.status(200).send(page({ kind: 'reject', brand, headline: '却下しました', title: proposal.title, msg: 'この提案は見送りました。サイトには何も変更していません。' }));
      return;
    }
    // 承認：実装ワークフローを起動（ショップは implement-shop、ブログは implement-article）
    try {
      const eventType = isShop ? 'implement-shop' : 'implement-article';
      const ok = await bbqDispatch(BBQ_GH_DISPATCH_TOKEN.value(), eventType, { proposal });
      res.status(200).send(page({
        kind: 'approve', brand,
        headline: ok ? 'AIが実装を始めました' : '承認を受け付けました',
        title: proposal.title,
        msg: ok
          ? `AIが${isShop ? '対象ページ' : '記事'}を直して自己採点します。合格したらプレビュー付きで「公開しますか？」のメールをお送りします。`
          : '実装エンジンの接続（GitHubトークン）が完了すると自動で動きます。',
      }));
    } catch (e) {
      console.error('bbqProposalAction失敗', String(e && e.message || e).slice(0, 200));
      res.status(500).send(page({ kind: 'error', headline: 'エラーが発生しました', msg: '時間をおいて再度お試しください。' }));
    }
  }
);

// 公開/取消/元に戻す：プレビュー・完了メールのボタンの着地点
exports.bbqChangeAction = onRequest(
  { region: 'asia-northeast1', memory: '256MiB', secrets: [APPROVAL_SECRET, BBQ_GH_DISPATCH_TOKEN], maxInstances: 3, cors: false },
  async (req, res) => {
    const d = req.query.d, t = req.query.t;
    const secret = APPROVAL_SECRET.value();
    if (!d || !t || !verifyToken(secret, d, t)) {
      res.status(403).send(page({ kind: 'error', headline: 'リンクが無効です', msg: 'リンクが正しくないか、期限切れの可能性があります。' }));
      return;
    }
    let body;
    try { body = decodePayload(d); } catch { res.status(400).send(page({ kind: 'error', headline: 'データを読めませんでした', msg: 'リンクが壊れている可能性があります。' })); return; }
    const { kind, branch, commit, title, domain } = body;
    const brand = domain === 'shop' ? 'SLOW FIRE SHOP' : 'SLOW FIRE JOURNAL';
    // 公開/取消/復元は記事もショップも同じ操作（branch/commit）。domainは下流の文言用に通す。
    const map = { publish: 'publish-article', discard: 'discard-article', revert: 'revert-article' };
    if (!map[kind]) { res.status(400).send(page({ kind: 'error', brand, headline: '不正な操作です', msg: '対応していない操作です。' })); return; }
    try {
      const ok = await bbqDispatch(BBQ_GH_DISPATCH_TOKEN.value(), map[kind], { branch, commit, domain });
      const copy = {
        publish: { headline: ok ? '本番への公開を始めました' : '公開を受け付けました', msg: '公開が完了したら、完了メールでご報告します。' },
        discard: { kind: 'reject', headline: '取り消しました', msg: 'プレビューを破棄しました。本番には反映していません。' },
        revert: { kind: 'reject', headline: '元に戻す処理を始めました', msg: 'この変更を取り消して本番を元に戻します。完了したらメールします。' },
      }[kind];
      res.status(200).send(page({ kind: copy.kind || 'approve', brand, headline: copy.headline, title, msg: copy.msg }));
    } catch (e) {
      console.error('bbqChangeAction失敗', String(e && e.message || e).slice(0, 200));
      res.status(500).send(page({ kind: 'error', headline: 'エラーが発生しました', msg: '時間をおいて再度お試しください。' }));
    }
  }
);

/* =============================================
   YORON BBQ COMMUNITY — 入会・月1BBQ申込（2026-07-25）
   - onEventRegistration : 月1BBQ申込 → 残枠カウンタ更新＋運営3名へ通知＋本人へ確認メール
   - onMemberJoin        : コミュニティ入会 → 運営3名へ通知＋本人へようこそメール
   - adminList           : パスコード式の管理画面API（申込・入会の一覧）
   ============================================= */
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const RESEND_API_KEY = defineSecret('RESEND_API_KEY');
const ADMIN_PASSCODE = defineSecret('ADMIN_PASSCODE');

const BBQ_ADMINS = ['yamane@potentialight.com', 'afroanri0126@gmail.com', 'woodyuetaku@gmail.com'];
const BBQ_FROM = 'YORON BBQ COMMUNITY <noreply@pmquest.jp>';
const EVENT_CAPACITY = 10;

const ROLE_LABEL = { fan: 'ファン（まず火を囲む）', ambassador: 'アンバサダー（広める）', sommelier: 'BBQソムリエ（知識で語る）', pitmaster: 'グリリスト（振る舞う）' };

// 入会直後ようこそメールの役割別「今週の、ひとつだけ」（roles.htmlの図鑑と対）
const ROLE_FIRST_STEP = {
  fan: '<b>次回の月1BBQの日程を、カレンダーに仮置きしてみてください。</b>来られたら、焼きたてを食べて「おいしい！」と言う——それがファンのいちばん大事な仕事です。「焼いてほしい」は遠慮しなくて大丈夫。食べたいの一言は、グリリストへの最高のプレゼントです。',
  ambassador: '<b>「これ好きそうだな」という顔がひとり浮かんだら、<a href="https://yoron-bbq.com/roles.html">役割図鑑のページ</a>をLINEでそのまま送ってみてください。</b>紹介文はページ内のボタンから1タップでコピーできます。ノルマはありません。その一通が、複利のループの一巡目です。',
  sommelier: '<b><a href="https://yoron-bbq.com/academy.html">ACADEMY</a>のレッスン1を開いて、鶏73℃・豚63℃・牛53℃だけ覚えて帰ってください。</b>次に誰かと肉を食べるとき、「なぜこの火入れなのか」をひとこと語れたら、もうソムリエの一歩目です。',
  pitmaster: '<b>次回の月1BBQで、グリリストの隣に立ってみてください。</b>火起こしから蓋の開け閉めまで、見て・触って・トングを受け取るのが最短ルートです。<a href="https://yoron-bbq.com/academy.html">ACADEMY</a>で火の設計を予習しておくと、当日の解像度が上がります。',
};

// ---- LINE公式アカウント連携（2026-07-25） ----
const LINE_CHANNEL_TOKEN = defineSecret('LINE_CHANNEL_TOKEN');
const LINE_FRIEND_URL = 'https://line.me/R/ti/p/@637uooyi';

async function linePushToGroups(token, text) {
  // グループ投稿は「やまちゃんです！」と名乗る（あんちゃんのツボ・山根さん指示 2026-07-25）
  text = 'やまちゃんです！\n' + text;
  const db2 = admin.firestore();
  const cfg = await db2.doc('line_state/config').get();
  const groupIds = (cfg.exists && cfg.data().groupIds) || [];
  await Promise.all(groupIds.map(async (gid) => {
    const res = await fetch('https://api.line.me/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ to: gid, messages: [{ type: 'text', text: text.slice(0, 4900) }] }),
    });
    if (!res.ok) console.error('LINE push失敗:', gid, res.status, (await res.text()).slice(0, 200));
  }));
}

/* ---- LINE修正受付システム（2026-07-25） --------------------------------
   運営グループで公式アカウントを呼ぶとサイト修正依頼としてキューに入る。
   受付＝この webhook（site_requests へ pending で保存）
   処理＝Mac側 scripts/request-loop.mjs（10分おき / claudeヘッドレス）
   ------------------------------------------------------------------------ */
const LINE_CHANNEL_SECRET = defineSecret('LINE_CHANNEL_SECRET');

// 「公式への呼びかけ」判定に使う接頭辞（全角/半角・読点ゆれを許容）
const LINE_CALL_PREFIXES = [
  '@yoron', '@ＹＯＲＯＮ', '@よろん', '@ヨロン',
  'よろん、', 'よろん,', 'よろん，', 'ヨロン、', 'ヨロン,', 'ヨロン，',
  'よろんbbq', 'yoron bbq',
];

/** 本文が公式アカウントへの呼びかけか判定し、呼びかけ部分を除いた依頼本文を返す */
function parseLineCall(text, mention) {
  const raw = String(text || '');
  // 1) 公式アカウント自身へのメンション（LINEが isSelf を付けてくれる）
  const self = ((mention && mention.mentionees) || []).find((m) => m.isSelf);
  if (self && typeof self.index === 'number') {
    const body = (raw.slice(0, self.index) + raw.slice(self.index + (self.length || 0))).trim();
    return { matched: true, body };
  }
  // 2) 本文の接頭辞での呼びかけ
  const head = raw.trimStart();
  const lower = head.toLowerCase();
  for (const p of LINE_CALL_PREFIXES) {
    if (lower.startsWith(p)) {
      return { matched: true, body: head.slice(p.length).replace(/^[\s、,，:：]+/, '').trim() };
    }
  }
  return { matched: false, body: '' };
}

async function lineReply(token, replyToken, text) {
  const res = await fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: text.slice(0, 4900) }] }),
  });
  if (!res.ok) console.error('LINE reply失敗:', res.status, (await res.text()).slice(0, 200));
}

async function lineGroupMemberName(token, groupId, userId) {
  try {
    const res = await fetch(`https://api.line.me/v2/bot/group/${groupId}/member/${userId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return '';
    return (await res.json()).displayName || '';
  } catch { return ''; }
}

// グループ参加/退出の記録＋「公式への呼びかけ」をサイト修正依頼として受付
exports.lineWebhook = onRequest(
  { cors: false, maxInstances: 3, secrets: [LINE_CHANNEL_TOKEN, LINE_CHANNEL_SECRET] },
  async (req, res) => {
    // --- 署名検証（X-Line-Signature = HMAC-SHA256(channelSecret, rawBody) のBase64） ---
    const channelSecret = (LINE_CHANNEL_SECRET.value() || '').trim();
    const configured = channelSecret && channelSecret !== 'UNSET';
    let verified = false;
    if (configured) {
      const sig = req.get('x-line-signature') || '';
      const expect = crypto.createHmac('sha256', channelSecret)
        .update(req.rawBody || Buffer.from('')).digest('base64');
      const a = Buffer.from(sig), b = Buffer.from(expect);
      verified = a.length === b.length && crypto.timingSafeEqual(a, b);
      if (!verified) {
        console.error('lineWebhook: 署名不一致のため拒否');
        return res.status(403).send('invalid signature');
      }
    } else {
      // LINE_CHANNEL_SECRET が未設定の間は「検証できない入力」として扱い、
      // 修正依頼（＝自動コード変更のトリガー）は受け付けない（安全弁）
      console.warn('lineWebhook: LINE_CHANNEL_SECRET 未設定。修正依頼の受付は無効です');
    }

    try {
      const events = (req.body && req.body.events) || [];
      const db2 = admin.firestore();
      for (const ev of events) {
        // 友だち追加（follow）: あいさつ＋コミュニティ登録への導線、運営グループへ通知（2026-07-25）
        if (ev.type === 'follow' && ev.source && ev.source.type === 'user' && verified) {
          const token = LINE_CHANNEL_TOKEN.value();
          let name = '';
          try {
            const r = await fetch(`https://api.line.me/v2/bot/profile/${ev.source.userId}`, { headers: { Authorization: `Bearer ${token}` } });
            if (r.ok) name = ((await r.json()).displayName || '').slice(0, 40);
          } catch {}
          if (ev.replyToken) {
            await lineReply(token, ev.replyToken,
              `${name ? name + 'さん、' : ''}友だち追加ありがとうございます🔥\nYORON BBQです。月1BBQの先行案内や前日リマインドを、ここでお届けします。\n\nコミュニティ登録（30秒・無料・メールだけ）がまだの方は、こちらからどうぞ！\nhttps://yoron-bbq.com/#join\n\n次回の月1BBQ=8/23(日)・都立野川公園も受付中です。\nhttps://yoron-bbq.com/event.html`);
          }
          linePushToGroups(token, `💬【LINE友だち追加】\n${name || '（名前を取得できず）'}さん\n※コミュニティ登録が済んでいるかは admin ページで確認できます`)
            .catch((e) => console.error('LINE通知:', String(e).slice(0, 200)));
          continue;
        }
        const gid = ev.source && ev.source.groupId;
        if (!gid) continue;

        if (ev.type === 'join') {
          await db2.doc('line_state/config').set({ groupIds: admin.firestore.FieldValue.arrayUnion(gid) }, { merge: true });
          console.log('LINEグループ参加:', gid);
          continue;
        }
        if (ev.type === 'leave') {
          await db2.doc('line_state/config').set({ groupIds: admin.firestore.FieldValue.arrayRemove(gid) }, { merge: true });
          continue;
        }
        // 画像メッセージ: 修正依頼の参考写真として保存（2026-07-30「写真参考にしてね」が拾えなかった事故の再発防止）
        if (ev.type === 'message' && ev.message && ev.message.type === 'image' && verified) {
          try {
            const token = LINE_CHANNEL_TOKEN.value();
            const r = await fetch(`https://api-data.line.me/v2/bot/message/${ev.message.id}/content`, { headers: { Authorization: `Bearer ${token}` } });
            if (r.ok) {
              const buf = Buffer.from(await r.arrayBuffer());
              const mime = r.headers.get('content-type') || 'image/jpeg';
              const ext = mime.includes('png') ? 'png' : 'jpg';
              const p = `site_request_assets/${Date.now()}-${ev.message.id}.${ext}`;
              await admin.storage().bucket().file(p).save(buf, { contentType: mime });
              const uid = (ev.source && ev.source.userId) || '';
              const who2 = (uid ? await lineGroupMemberName(token, gid, uid) : '') || '不明';
              await db2.collection('site_request_assets').add({ groupId: gid, who: who2, userId: uid, path: p, mime, createdAt: new Date().toISOString() });
              console.log('参考画像を保存:', p, who2);
              await db2.collection('line_group_log').add({
                groupId: gid, userId: uid, who: who2, text: '（写真を1枚送った）', createdAt: new Date().toISOString(),
              });
              // 「写真待ち」で保留中の依頼があれば自動で再開する（写真だけの再送でも処理が走るように）
              const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
              const held = await db2.collection('site_requests')
                .where('status', '==', 'needs_clarification').get();
              const target = held.docs
                .filter((x) => { const v = x.data(); return v.groupId === gid && (v.createdAt || '') > since; })
                .sort((a, b) => (b.data().createdAt || '').localeCompare(a.data().createdAt || ''))[0];
              if (target) {
                await target.ref.set({ status: 'pending', reopenedAt: new Date().toISOString(), reopenReason: '参考写真の到着' }, { merge: true });
                console.log('写真到着により依頼を再開:', target.id);
              }
            } else {
              console.error('LINE画像取得失敗:', r.status);
            }
          } catch (e) { console.error('LINE画像保存例外:', String(e).slice(0, 200)); }
          continue;
        }
        if (ev.type !== 'message' || !ev.message || ev.message.type !== 'text') continue;
        if (!verified) continue; // 署名未検証の間は依頼を作らない

        // グループの会話ログを保存（メンションなしの発言も依頼解釈の文脈に使う。2026-07-30 山根さん指示
        // 「メンション＋別送写真＋前後の会話を、人間のようにひとつの流れとして読む」）
        const rawText = String(ev.message.text || '');
        try {
          const uid0 = (ev.source && ev.source.userId) || '';
          const who0 = (uid0 ? await lineGroupMemberName(LINE_CHANNEL_TOKEN.value(), gid, uid0) : '') || '不明';
          await db2.collection('line_group_log').add({
            groupId: gid, userId: uid0, who: who0, text: rawText.slice(0, 1000), createdAt: new Date().toISOString(),
          });
        } catch (e) { console.error('会話ログ保存例外:', String(e).slice(0, 150)); }

        const call = parseLineCall(ev.message.text, ev.message.mention);
        if (!call.matched) continue;
        if (!call.body) {
          await lineReply(LINE_CHANNEL_TOKEN.value(), ev.replyToken,
            'やまちゃんです！呼んだ？直したい箇所と、どう直したいか続けて書いて！');
          continue;
        }

        const userId = (ev.source && ev.source.userId) || '';
        const who = (userId ? await lineGroupMemberName(LINE_CHANNEL_TOKEN.value(), gid, userId) : '') || '不明';
        await db2.collection('site_requests').add({
          who,
          userId,
          groupId: gid,
          text: call.body.slice(0, 2000),
          raw: String(ev.message.text || '').slice(0, 2000),
          status: 'pending',
          source: 'line',
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
          createdAt: new Date().toISOString(),
        });
        console.log('修正依頼を受付:', who, call.body.slice(0, 60));
        await lineReply(LINE_CHANNEL_TOKEN.value(), ev.replyToken,
          'やまちゃんです！おけ、受け付けた！直したらここで報告するね');
      }
    } catch (e) { console.error('lineWebhook:', String(e).slice(0, 300)); }
    res.status(200).send('ok');
  }
);

/* 修正依頼の見張り（2026-07-30 山根さん指示「依頼者を無音で待たせない」）
   Mac側の処理ループ（request-loop.mjs）が止まっていても、サーバー側だけで
   「受け取ってるけど遅れてる」を依頼者に返し、山根へメールで知らせる。 */
exports.siteRequestWatchdog = onSchedule(
  { schedule: 'every 30 minutes', secrets: [LINE_CHANNEL_TOKEN, RESEND_API_KEY] },
  async () => {
    const db2 = admin.firestore();
    const cutoff = new Date(Date.now() - 45 * 60 * 1000).toISOString();
    const snap = await db2.collection('site_requests').where('status', '==', 'pending').get();
    for (const doc of snap.docs) {
      const d = doc.data() || {};
      const createdAt = d.createdAt || '';
      if (!createdAt || createdAt > cutoff) continue;          // 受付から45分未満は正常範囲
      if (d.watchdogNotifiedAt || d.stallNotifiedAt) continue; // 既にどちらかの経路で途中経過を伝えている
      const mins = Math.round((Date.now() - Date.parse(createdAt)) / 60000);
      if (d.groupId) {
        try {
          const res = await fetch('https://api.line.me/v2/bot/message/push', {
            method: 'POST',
            headers: { Authorization: `Bearer ${LINE_CHANNEL_TOKEN.value()}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ to: d.groupId, messages: [{ type: 'text', text:
              `やまちゃんです！${d.who && d.who !== '不明' ? d.who + '、' : ''}さっきの依頼はちゃんと受け取ってるよ。こっちの作業が詰まってて遅くなっててごめん！直したら必ずここで報告するね` }] }),
          });
          if (!res.ok) console.error('watchdog LINE失敗:', res.status, (await res.text()).slice(0, 200));
        } catch (e) { console.error('watchdog LINE例外:', String(e).slice(0, 200)); }
      }
      try {
        await bbqSendMail(RESEND_API_KEY.value(), {
          to: 'yamane@potentialight.com',
          subject: `【要対応】YORON BBQ 修正依頼が${mins}分未処理（request-loop停止の疑い）`,
          html: `<p>LINE修正依頼が pending のまま処理されていません。Mac側の request-loop が止まっている可能性があります。</p><p>依頼者: ${d.who || '不明'}<br>依頼: ${(d.text || '').slice(0, 300)}<br>受付: ${createdAt}</p>`,
        });
      } catch (e) { console.error('watchdog mail例外:', String(e).slice(0, 200)); }
      await doc.ref.set({ watchdogNotifiedAt: new Date().toISOString() }, { merge: true });
    }
    // 会話ログの掃除（72時間より古いものを削除。文脈用の短期メモリなので溜め込まない）
    try {
      const old = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
      const stale = await db2.collection('line_group_log').where('createdAt', '<', old).limit(200).get();
      await Promise.all(stale.docs.map((x) => x.ref.delete()));
      if (stale.size) console.log('会話ログ掃除:', stale.size, '件');
    } catch (e) { console.error('会話ログ掃除例外:', String(e).slice(0, 150)); }
  }
);


async function bbqSendMail(apiKey, { to, subject, html, replyTo }) {
  const { Resend } = require('resend');
  const resend = new Resend(apiKey);
  const res = await resend.emails.send({ from: BBQ_FROM, to, subject, html, ...(replyTo ? { reply_to: replyTo } : {}) });
  if (res?.error) console.error('resend error:', JSON.stringify(res.error).slice(0, 300));
  return res;
}

// 月1BBQの開催情報（新しい回や場所が決まったらここを更新）
const BBQ_ACCESS = '京王線「飛田給」駅、またはJR中央線「武蔵境」「東小金井」駅からタクシー約10分（1,500〜2,000円程度）。駅で待ち合わせてのタクシー相乗りがいちばんラクでおすすめです。電車のみなら西武多摩川線「新小金井」「多磨」駅から徒歩約15分。お車は園内有料駐車場へ。';
const BBQ_COMMON = {
  time: '10:00〜13:00頃（10:00 現地集合）',
  fee: '5,000円（施設利用料・食材・ソフトドリンク込み）',
  bring: 'お酒を飲まれる方は、お好きなお酒だけご持参ください。機材・炭・食材・ソフトドリンクはすべてこちらで用意します。',
  url: 'https://yoron-bbq.com/event.html',
};
const BBQ_EVENTS = {
  '2026-08-23': { label: '第2回 2026年8月23日（日）', place: '都立 野川公園', access: BBQ_ACCESS, mapUrl: 'https://www.google.com/maps/search/?api=1&query=%E9%83%BD%E7%AB%8B%E9%87%8E%E5%B7%9D%E5%85%AC%E5%9C%92', officialUrl: 'https://www.tokyo-park.or.jp/park/nogawa/' },
  '2026-10-04': { label: '第3回 2026年10月4日（日）', place: '世田谷の某所（詳しい場所は開催が近づいたらこのメール宛にご案内します）' },
  '2026-11-22': { label: '第4回 2026年11月22日（日）', place: '世田谷の某所（詳しい場所は開催が近づいたらこのメール宛にご案内します）' },
  '2026-12-13': { label: '第5回 2026年12月13日（日）', place: '世田谷の某所（詳しい場所は開催が近づいたらこのメール宛にご案内します）' },
  '531-02': { label: '531 第2回（2026年10月18日）' },
};
const NEXT_EVENT_ID = '2026-10-04'; // ようこそメールで案内する直近回

const infoTable = (rows) => `<table style="border-collapse:collapse;width:100%;font-size:14px;margin:10px 0 16px">
  ${rows.map(([k, v]) => `<tr><td style="padding:7px 12px;background:#f5efe2;border:1px solid #e8dcc8;width:110px;white-space:nowrap;font-weight:700">${k}</td><td style="padding:7px 12px;border:1px solid #e8dcc8">${v}</td></tr>`).join('')}
</table>`;

const esc = (s) => String(s || '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function mailShell(title, bodyHtml) {
  return `<div style="font-family:'Hiragino Sans',sans-serif;max-width:560px;margin:0 auto;background:#fffdf6;border:1px solid #e8dcc8;border-radius:12px;overflow:hidden">
    <div style="background:#2d251c;color:#f5e9d6;padding:18px 24px;font-weight:800;letter-spacing:.06em">YORON BBQ COMMUNITY</div>
    <div style="padding:24px;color:#3a2a23;line-height:1.9">
      <h2 style="margin:0 0 14px;font-size:18px;color:#8c3b28">${title}</h2>
      ${bodyHtml}
    </div>
    <div style="padding:14px 24px;background:#f5efe2;color:#8a7a63;font-size:12px">© YORON BBQ COMMUNITY｜このメールは自動送信です。返信いただければ運営に届きます。</div>
  </div>`;
}

// ---- 月1BBQ申込 ----
exports.onEventRegistration = onDocumentCreated(
  { document: 'event_regs/{id}', region: 'us-central1', secrets: [RESEND_API_KEY, LINE_CHANNEL_TOKEN], maxInstances: 3 },
  async (event) => {
    const snap = event.data; if (!snap) return;
    const d = snap.data();
    const eventId = String(d.eventId || '').slice(0, 20);
    if (!eventId) return;
    const party = Math.min(Math.max(parseInt(d.party, 10) || 1, 1), 4);
    const db2 = admin.firestore();
    const statsRef = db2.doc(`event_stats/${eventId}`);

    // 残枠カウンタ更新（超過分はキャンセル待ち）
    let newCount = 0, waitlisted = false;
    await db2.runTransaction(async (tx) => {
      const st = await tx.get(statsRef);
      const cur = (st.exists && st.data().count) || 0;
      const cap = (st.exists && st.data().capacity) || EVENT_CAPACITY;
      newCount = cur + party;
      waitlisted = newCount > cap; // この申込で定員を超えるなら待ち（部分超過含む）
      tx.set(statsRef, { count: newCount, capacity: cap, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      tx.update(snap.ref, { status: waitlisted ? 'waitlist' : 'confirmed', party });
    });

    const apiKey = RESEND_API_KEY.value();
    const lineText = `🔥【月1BBQ申込】\n${d.name}さん ${party}名\n${d.eventLabel || eventId}\n${waitlisted ? '⚠️キャンセル待ち' : '✅受付'}（現在 ${newCount}/${EVENT_CAPACITY}名）${d.referrer ? '\n紹介者: ' + d.referrer : ''}${d.note ? '\nひとこと: ' + d.note : ''}`;
    linePushToGroups(LINE_CHANNEL_TOKEN.value(), lineText).catch((e) => console.error('LINE通知:', String(e).slice(0, 200)));
    const info = `<table style="border-collapse:collapse;width:100%;font-size:14px">
      ${[['開催回', esc(d.eventLabel || eventId)], ['お名前', esc(d.name)], ['メール', esc(d.email)], ['人数', `${party}名`], ['紹介者', esc(d.referrer) || '—'], ['ひとこと', esc(d.note) || '—'], ['状態', waitlisted ? '⚠️ キャンセル待ち' : '✅ 受付'], ['現在の申込', `${newCount} / ${EVENT_CAPACITY}名`]].map(([k, v]) => `<tr><td style="padding:6px 10px;background:#f5efe2;border:1px solid #e8dcc8;width:96px;white-space:nowrap">${k}</td><td style="padding:6px 10px;border:1px solid #e8dcc8">${v}</td></tr>`).join('')}
    </table>`;

    await Promise.all([
      bbqSendMail(apiKey, {
        to: BBQ_ADMINS,
        replyTo: d.email,
        subject: `【月1BBQ申込】${d.name}さん ${party}名（${eventId}・${newCount}/${EVENT_CAPACITY}）${waitlisted ? '★キャンセル待ち' : ''}`,
        html: mailShell('月1BBQに新しい申込がありました', info + `<p style="margin-top:14px">一覧は <a href="https://yoron-bbq.com/admin.html">管理ページ</a> から。</p>`),
      }),
      d.email ? bbqSendMail(apiKey, {
        to: d.email,
        subject: waitlisted ? '【YORON BBQ】キャンセル待ちで承りました（ご案内つき）' : `【YORON BBQ】お申し込み完了｜${(BBQ_EVENTS[eventId] || {}).label || eventId}のご案内`,
        html: mailShell(
          waitlisted ? 'キャンセル待ちで承りました' : 'お申し込み、受け付けました🔥',
          `<p>${esc(d.name)}さん、この度はお申し込みいただきありがとうございます。ご参加いただけるとのこと、とても嬉しく思います。</p>` +
          (waitlisted
            ? `<p>あいにく定員（${EVENT_CAPACITY}名）に達しているため、<b>キャンセル待ち</b>としてお預かりしました。お席が空き次第、このメールアドレスへ最優先でご連絡します。ご都合が変わった場合は、このメールへの返信一本で取り消せます。</p>
               <p>参考までに、当日の概要はこちらです。</p>`
            : `<p><b>${esc(d.eventLabel || eventId)}</b> のご参加、確定です。当日お会いできるのを楽しみにしています。詳細は改めて別途ご連絡差し上げます。</p>`) +
          (() => {
            const ev = BBQ_EVENTS[eventId] || {};
            const placeRows = ev.place
              ? [['場所', `${esc(ev.place)}（<a href="${ev.mapUrl}">地図を開く</a>／<a href="${ev.officialUrl}">公園公式サイト</a>）`], ['アクセス', esc(ev.access)]]
              : [['場所', '調整中です。決まり次第、このメールアドレスへいちばんにご案内します（都内の公園バーベキュー場を予定）']];
            return `<h3 style="font-size:15px;color:#8c3b28;margin:18px 0 4px">📋 開催概要</h3>` + infoTable([
              ['開催回', esc(ev.label || eventId)],
              ['時間', esc(BBQ_COMMON.time)],
              ...placeRows,
              ['会費', esc(BBQ_COMMON.fee) + '（当日、現地でお支払いください）'],
              ['持ちもの', esc(BBQ_COMMON.bring)],
              ['服装', '煙の匂いがついても気にならない服装で。エプロンがあると焼く工程にも気軽に参加できます'],
              ['雨天時', '中止の場合は前日までにメールでご連絡します'],
            ]);
          })() +
          `<h3 style="font-size:15px;color:#8c3b28;margin:18px 0 4px">🍖 当日の流れ</h3>
           <p style="font-size:14px">10:00に現地集合したら、まずは火起こしから見学どうぞ。蓋を閉めた炭のグリルで低温からじっくり火を入れる「YORONバーベキュー」を、お昼を挟んで13:00頃までゆっくり楽しみます。メニューはお肉類・魚介類などの予定です。<b>お苦手な食材・アレルギーがあれば、このメールに返信でお知らせください。</b>可能な範囲で配慮します。</p>` +
          `<h3 style="font-size:15px;color:#8c3b28;margin:18px 0 4px">✍️ お申し込み内容</h3>` +
          infoTable([
            ['お名前', esc(d.name)],
            ['人数', `${party}名（ご本人含む）`],
            ['ひとこと', esc(d.note) || '—'],
            ['受付状態', waitlisted ? 'キャンセル待ち' : '受付確定'],
          ]) +
          `<p style="font-size:14px">集合場所の詳細（公園内バーベキュー広場の位置・目印）は、<b>前日までに改めてこのアドレスへお送りします。</b></p>
           <p style="font-size:14px">キャンセル・人数変更は、このメールに返信いただくだけで大丈夫です（直前でも遠慮なく）。</p>
           <p style="font-size:13px;color:#8a7a63">はじめての方は、コミュニティの雰囲気が分かる<a href="https://yoron-bbq.com/context.html">「はじめての方へ」</a>もどうぞ。</p>`
        ),
      }) : Promise.resolve(),
    ]);
  }
);

// ---- バーベキュー講座申込 ----
const LECTURE_EVENTS = {
  'lec-2026-09': { label: 'Grillist Basic Course（初級編）2026年10月11日 名古屋' },
  'lec-2026-10': { label: 'Grillist Basic Course（初級編）2026年10月25日 東京' },
  'lec-2026-11': { label: 'Grillist Basic Course（初級編）2026年11月 東京' },
};
exports.onLectureRegistration = onDocumentCreated(
  { document: 'lecture_regs/{id}', region: 'us-central1', secrets: [RESEND_API_KEY, LINE_CHANNEL_TOKEN], maxInstances: 3 },
  async (event) => {
    const snap = event.data; if (!snap) return;
    const d = snap.data();
    const eventId = String(d.eventId || '').slice(0, 20);
    const label = (LECTURE_EVENTS[eventId] || {}).label || d.eventLabel || eventId;
    const party = Math.min(Math.max(parseInt(d.party, 10) || 1, 1), 4);
    const apiKey = RESEND_API_KEY.value();
    linePushToGroups(LINE_CHANNEL_TOKEN.value(), `【BBQ講座申込】\n${d.name}さん ${party}名\n${label}${d.tel ? '\n電話: ' + d.tel : ''}${d.note ? '\nひとこと: ' + d.note : ''}`).catch((e) => console.error('LINE通知:', String(e).slice(0, 200)));
    const info = infoTable([
      ['開催回', esc(label)],
      ['お名前', esc(d.name)],
      ['メール', esc(d.email)],
      ['電話番号', esc(d.tel) || '—'],
      ['人数', `${party}名`],
      ['ひとこと', esc(d.note) || '—'],
    ]);
    await Promise.all([
      bbqSendMail(apiKey, {
        to: BBQ_ADMINS,
        replyTo: d.email,
        subject: `【BBQ講座申込】${d.name}さん ${party}名（${eventId}）`,
        html: mailShell('バーベキュー講座に新しい申込がありました', info),
      }),
      d.email ? bbqSendMail(apiKey, {
        to: d.email,
        subject: `【YORON BBQ】お申し込みありがとうございます｜${label}`,
        html: mailShell('バーベキュー講座のお申し込み、受け付けました',
          `<p>${esc(d.name)}さん、この度はお申し込みいただきありがとうございます。<b>${esc(label)}</b>にご参加いただけるとのこと、とても嬉しく思います。</p>
           <p style="font-size:14px">講座は実践型のレッスンです。会場・当日の詳細については、別途改めてこのメールアドレスへご連絡差し上げますので、しばらくお待ちください。</p>` +
          infoTable([
            ['開催回', esc(label)],
            ['時間', '約3〜3.5時間（開始時刻は別途ご案内します）'],
            ['会場', '調整中（決まり次第ご案内します）'],
            ['持ちもの', '手ぶらでOK。機材・炭・食材はすべてこちらで用意します'],
            ['人数', `${party}名（ご本人含む）`],
          ]) +
          `<p style="font-size:14px">キャンセル・人数変更は、このメールに返信いただくだけで大丈夫です。</p>
           <p style="font-size:13px;color:#8a7a63">講座の内容は<a href="https://yoron-bbq.com/lecture.html">バーベキュー講座のページ</a>で、教科書は<a href="https://yoron-bbq.com/academy.html">ACADEMY</a>でいつでも読めます。</p>`
        ),
      }) : Promise.resolve(),
    ]);
  }
);

// ---- コミュニティ入会 ----
exports.onMemberJoin = onDocumentCreated(
  { document: 'members/{id}', region: 'us-central1', secrets: [RESEND_API_KEY, LINE_CHANNEL_TOKEN], maxInstances: 3 },
  async (event) => {
    const snap = event.data; if (!snap) return;
    const d = snap.data();
    const role = ROLE_LABEL[d.role] || 'ファン';
    const apiKey = RESEND_API_KEY.value();
    linePushToGroups(LINE_CHANNEL_TOKEN.value(), `👥【コミュニティ入会】\n${d.name}さん（${role}）${d.referrer ? '\n紹介: ' + d.referrer : ''}${d.note ? '\nひとこと: ' + d.note : ''}`).catch((e) => console.error('LINE通知:', String(e).slice(0, 200)));
    const info = `<table style="border-collapse:collapse;width:100%;font-size:14px">
      ${[['お名前', esc(d.name)], ['メール', esc(d.email)], ['関わり方', esc(role)], ['紹介者', esc(d.referrer) || '—'], ['ひとこと', esc(d.note) || '—']].map(([k, v]) => `<tr><td style="padding:6px 10px;background:#f5efe2;border:1px solid #e8dcc8;width:96px;white-space:nowrap">${k}</td><td style="padding:6px 10px;border:1px solid #e8dcc8">${v}</td></tr>`).join('')}
    </table>`;
    await Promise.all([
      bbqSendMail(apiKey, {
        to: BBQ_ADMINS,
        replyTo: d.email,
        subject: `【コミュニティ入会】${d.name}さん（${role}）`,
        html: mailShell('新しい仲間が増えました', info + `<p style="margin-top:14px">一覧は <a href="https://yoron-bbq.com/admin.html">管理ページ</a> から。</p>`),
      }),
      d.email ? bbqSendMail(apiKey, {
        to: d.email,
        subject: `【YORON BBQ】ようこそ、火の輪へ🔥 ${esc(d.name)}さんへのご案内`,
        html: mailShell('ようこそ、YORON BBQ COMMUNITYへ',
          `<p>${esc(d.name)}さん、仲間入りありがとうございます。ファウンダーのあんちゃん、山根（やまちゃん）、うえたくの3人でお迎えします。入会金も資格も審査もありません——今日からもう仲間です。</p>
           <p style="background:#f5efe2;border-radius:8px;padding:12px 14px;font-size:14px">私たちがやっているのは、薄切り肉を焦がす「いつものBBQ」ではなく、<b>蓋を閉めた炭のグリルで、低温からじっくり火を入れるYORONバーベキュー</b>。普通の食材が異常に美味しくなる体験を、日本の食卓の3人に1人へ届けるのがこのコミュニティの野望です。</p>
           <h3 style="font-size:15px;color:#8c3b28;margin:18px 0 4px">🎁 メンバーになると</h3>
           <ul style="padding-left:20px;margin:8px 0 14px;font-size:14px">
             <li style="margin-bottom:8px"><b>月1BBQの先行案内</b> — 毎月の開催日程をいちばん早くお届けします。各回の枠は10名なので、先行案内が実質の優先枠です</li>
             <li style="margin-bottom:8px"><b>公式LINEでつながる</b> — 開催案内やリマインドがいちばん確実に届きます。「今日焼いたよ」の報告も、火加減の質問も、トークで気軽に<br><a href="https://line.me/R/ti/p/@637uooyi" style="display:inline-block;background:#06C755;color:#fff;font-weight:800;padding:8px 20px;border-radius:100px;text-decoration:none;margin-top:6px">💬 LINEで友だち追加する（@637uooyi）</a></li>
             <li style="margin-bottom:8px"><b>ACADEMYで学ぶ</b> — 鶏73℃・豚63℃・牛53℃。<a href="https://yoron-bbq.com/academy.html">温度と道具の科学の全8レッスン</a>がいつでも無料</li>
             <li><b>ときどきの便り</b> — レシピや開催レポートを月1〜2通だけ。多すぎる配信はしません</li>
           </ul>
           <h3 style="font-size:15px;color:#8c3b28;margin:18px 0 4px">📅 さっそく次回の月1BBQへ</h3>` +
          (() => {
            const ev = BBQ_EVENTS[NEXT_EVENT_ID] || {};
            return infoTable([
              ['開催回', esc(ev.label || NEXT_EVENT_ID)],
              ['時間', esc(BBQ_COMMON.time)],
              ['場所', `${esc(ev.place)}（<a href="${ev.mapUrl}">地図</a>）`],
              ['アクセス', esc(ev.access)],
              ['会費', esc(BBQ_COMMON.fee)],
              ['持ちもの', esc(BBQ_COMMON.bring)],
            ]);
          })() +
          `<p style="margin:0 0 18px"><a href="${BBQ_COMMON.url}#register" style="display:inline-block;background:#d95f3b;color:#fff;font-weight:800;padding:10px 22px;border-radius:100px;text-decoration:none">残り枠を見て申し込む →</a></p>
           <h3 style="font-size:15px;color:#8c3b28;margin:18px 0 4px">🪜 「${esc(role)}」のあなたへ — 今週の、ひとつだけ</h3>
           <p style="background:#fdf6e8;border:1px solid #e8dcc8;border-radius:8px;padding:12px 14px;font-size:14px;margin:8px 0 10px">${ROLE_FIRST_STEP[d.role] || ROLE_FIRST_STEP.fan}</p>
           <p style="font-size:14px">このコミュニティには <b>ファン → アンバサダー → BBQソムリエ → グリリスト</b> という役割のはしごがあります。どれが上でどれが下、はありません。登るペースは自由、降りても、また来てもいい。4つの役割がどんな人か（そして自分に何ができるか）は、<a href="https://yoron-bbq.com/roles.html">役割図鑑</a>にキャラクターつきでまとめています。<a href="https://yoron-bbq.com/context.html">はじめての方へ</a>と<a href="https://yoron-bbq.com/team.html">3人の物語</a>もどうぞ。</p>
           <p style="font-size:14px">質問・雑談・「こんなBBQやってみたい」は、いつでも<b>このメールに返信</b>してください。運営3人に届きます。</p>`),
      }) : Promise.resolve(),
    ]);
  }
);

// ---- 法人・団体からのご相談（contact.html）2026-07-25 ----
const CONTACT_TOPIC_LABEL = {
  event: 'BBQ体験イベント',
  coaching: 'グリルコーチング',
  teambuilding: 'チームビルディングBBQ',
  media: '取材・メディア掲載',
  other: 'その他・まずは相談',
};

exports.onContactMessage = onDocumentCreated(
  { document: 'contact_messages/{id}', region: 'us-central1', secrets: [RESEND_API_KEY, LINE_CHANNEL_TOKEN], maxInstances: 3 },
  async (event) => {
    const snap = event.data; if (!snap) return;
    const d = snap.data();
    const topic = CONTACT_TOPIC_LABEL[d.topic] || 'ご相談';
    const apiKey = RESEND_API_KEY.value();
    linePushToGroups(LINE_CHANNEL_TOKEN.value(), `📮【お問い合わせ】${topic}\n${d.name}さん${d.org ? '（' + d.org + '）' : ''}\n${String(d.message || '').slice(0, 200)}`)
      .catch((e) => console.error('LINE通知:', String(e).slice(0, 200)));
    const info = infoTable([
      ['お名前', esc(d.name)],
      ['会社・団体', esc(d.org) || '—'],
      ['メール', esc(d.email)],
      ['ご相談', esc(topic)],
      ['内容', esc(d.message).replace(/\n/g, '<br>')],
    ]);
    await Promise.all([
      bbqSendMail(apiKey, {
        to: BBQ_ADMINS,
        replyTo: d.email,
        subject: `【お問い合わせ】${topic}／${d.name}さん${d.org ? '（' + d.org + '）' : ''}`,
        html: mailShell('法人・団体からのご相談が届きました', info + '<p style="margin-top:14px;font-size:14px">このメールにそのまま返信すれば、ご本人に届きます。</p>'),
      }),
      d.email ? bbqSendMail(apiKey, {
        to: d.email,
        replyTo: BBQ_ADMINS[0],
        subject: '【YORON BBQ】ご相談を受け取りました',
        html: mailShell('ご相談ありがとうございます',
          `<p>${esc(d.name)}さん、ご連絡ありがとうございます。以下の内容で受け取りました。運営3名（あんちゃん・やまちゃん・うえたく）で確認し、<b>3営業日を目安に</b>このメールアドレスへお返事します。</p>` +
          info +
          `<p style="font-size:14px">お待ちいただくあいだに、私たちのやっているバーベキューの中身は <a href="https://yoron-bbq.com/academy.html">ACADEMY</a>、雰囲気は <a href="https://yoron-bbq.com/event.html">月1BBQ</a> のページをどうぞ。</p>`),
      }) : Promise.resolve(),
    ]);
  }
);

/* =============================================
   月1BBQ フォトアルバム（2026-08-24）
   - 開催日の夜18:30に推測不可IDのアルバムを自動発行し、
     運営3名へURLをメール。参加者にはそのURLを転送してもらう運用。
   - 直近3日以内の開催分で未発行のものも拾う（当日実行漏れの保険）
   ============================================= */
const ALBUM_CATCHUP_DAYS = 3;

async function bbqEnsureAlbums(resendKey) {
  const db2 = admin.firestore();
  const today = new Date(Date.now() + 9 * 3600 * 1000); // JST
  const created = [];
  for (const [eventId, ev] of Object.entries(BBQ_EVENTS)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(eventId)) continue; // 531等の日付でないIDは対象外
    const diffDays = (today - new Date(eventId + 'T00:00:00+09:00')) / 86400000;
    if (diffDays < 0 || diffDays > ALBUM_CATCHUP_DAYS) continue;
    const dup = await db2.collection('albums').where('eventId', '==', eventId).limit(1).get();
    if (!dup.empty) continue;
    const albumId = `${eventId}-${crypto.randomBytes(6).toString('hex')}`;
    await db2.doc(`albums/${albumId}`).set({
      eventId,
      label: ev.label || eventId,
      place: (ev.place || '').split('（')[0],
      createdAt: new Date().toISOString(),
    });
    const url = `https://yoron-bbq.com/album.html?a=${albumId}`;
    await bbqSendMail(resendKey, {
      to: BBQ_ADMINS,
      subject: `【YORON BBQ】${ev.label || eventId} のフォトアルバムができました`,
      html: mailShell('今日のバーベキュー、写真を集めよう', `
        <p>${esc(ev.label || eventId)}${ev.place ? '（' + esc((ev.place || '').split('（')[0]) + '）' : ''}のフォトアルバムを発行しました。</p>
        <p style="margin:16px 0"><a href="${url}" style="display:inline-block;background:#8c3b28;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700">アルバムを開く</a></p>
        <p style="font-size:13px;color:#8a7a63">このURLを知っている人だけが開けます。参加者のみなさんにLINE等でそのまま転送してください。開いた人は誰でも写真をまとめてアップロードでき、みんなの写真をその場で見られます。<br>URL: ${url}</p>
      `),
    });
    created.push({ albumId, url });
    console.log('album created:', albumId);
  }
  return created;
}

/* アルバム新着写真の通知便（2026-08-24 山根さん依頼「誰かがアップしても分からない」対策）
   30分ごとに各アルバムの未通知写真を突合し、新着があれば山根さんへ1通にまとめてメール。
   1枚ごとの即時通知にしない設計判断: BBQ当日夜は連投になるため、30分バッチで
   「誰が何枚」を集約する（通知カーソル=albums/{id}.notifyCursor）。 */
exports.bbqAlbumPhotoWatch = onSchedule(
  { schedule: 'every 30 minutes', secrets: [RESEND_API_KEY] },
  async () => {
    const db2 = admin.firestore();
    // 直近60日のアルバムだけ見る（古いアルバムへの追加はまれ・読み取り節約）
    const cutoff = new Date(Date.now() - 60 * 86400000).toISOString();
    const albums = await db2.collection('albums').where('createdAt', '>', cutoff).get();
    for (const doc of albums.docs) {
      const a = doc.data() || {};
      const cursor = a.notifyCursor || '';
      const snap = cursor
        ? await doc.ref.collection('photos').where('createdAt', '>', cursor).get()
        : await doc.ref.collection('photos').get();
      if (snap.empty) continue;
      const items = snap.docs.map((p) => p.data() || {});
      const byName = {};
      let maxTs = cursor;
      for (const p of items) {
        const who = (p.by || '').trim() || 'なまえなし';
        byName[who] = (byName[who] || 0) + 1;
        if ((p.createdAt || '') > maxTs) maxTs = p.createdAt;
      }
      const who = Object.entries(byName).map(([n, c]) => `${esc(n)} ${c}枚`).join('・');
      const url = `https://yoron-bbq.com/album.html?a=${doc.id}`;
      const total = await doc.ref.collection('photos').count().get();
      try {
        await bbqSendMail(RESEND_API_KEY.value(), {
          to: 'yamane@potentialight.com',
          subject: `【YORON BBQ】アルバムに新しい写真 ${items.length}枚｜${a.label || doc.id}`,
          html: mailShell('アルバムに写真が届きました', `
            <p><b>${esc(a.label || doc.id)}</b> のアルバムに、新しく<b>${items.length}枚</b>の写真がアップロードされました。</p>
            <p style="font-size:14px">内訳: ${who}<br>アルバム全体: ${total.data().count}枚</p>
            <p style="margin:16px 0"><a href="${url}" style="display:inline-block;background:#8c3b28;color:#fff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:700">アルバムを見る</a></p>
          `),
        });
        await doc.ref.set({ notifyCursor: maxTs }, { merge: true });
        console.log('photo notify:', doc.id, items.length);
      } catch (e) { console.error('photo notify失敗（カーソル据え置き・次回再送）:', String(e).slice(0, 200)); }
    }
  }
);

exports.bbqAlbumDaily = onSchedule(
  { schedule: '30 18 * * *', timeZone: 'Asia/Tokyo', secrets: [RESEND_API_KEY] },
  async () => { await bbqEnsureAlbums(RESEND_API_KEY.value()); }
);

// ---- 管理画面からのアルバム手動発行（2026-08-27 山根さん依頼: 自動発行を待たず運営が任意のBBQで作れる） ----
exports.adminCreateAlbum = onCall(
  { secrets: [ADMIN_PASSCODE], cors: true, maxInstances: 3 },
  async (request) => {
    const pass = String(request.data?.passcode || '');
    const expected = ADMIN_PASSCODE.value().trim();
    if (!pass || !crypto.timingSafeEqual(Buffer.from(pass.padEnd(64)), Buffer.from(expected.padEnd(64)))) {
      throw new HttpsError('permission-denied', 'パスコードが違います');
    }
    const label = String(request.data?.label || '').trim().slice(0, 60);
    const place = String(request.data?.place || '').trim().slice(0, 60);
    const date = String(request.data?.date || '').trim();
    if (!label) throw new HttpsError('invalid-argument', 'アルバム名は必須です');
    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpsError('invalid-argument', '開催日の形式が不正です');
    const db2 = admin.firestore();
    const albumId = `${date || 'manual'}-${crypto.randomBytes(6).toString('hex')}`;
    await db2.doc(`albums/${albumId}`).set({
      eventId: date || null,
      label, place,
      manual: true,
      createdBy: String(request.data?.by || '').trim().slice(0, 30),
      createdAt: new Date().toISOString(),
    });
    const url = `https://yoron-bbq.com/album.html?a=${albumId}`;
    console.log('album created (manual):', albumId);
    return { albumId, url };
  }
);

// ---- 管理画面API（山根・あんちゃん・うえたく用） ----
exports.adminList = onCall(
  { secrets: [ADMIN_PASSCODE], cors: true, maxInstances: 3 },
  async (request) => {
    const pass = String(request.data?.passcode || '');
    const expected = ADMIN_PASSCODE.value().trim();
    if (!pass || !crypto.timingSafeEqual(Buffer.from(pass.padEnd(64)), Buffer.from(expected.padEnd(64)))) {
      throw new HttpsError('permission-denied', 'パスコードが違います');
    }
    const db2 = admin.firestore();
    const [regs, members, stats, albumsSnap] = await Promise.all([
      db2.collection('event_regs').orderBy('createdAt', 'desc').limit(300).get(),
      db2.collection('members').orderBy('createdAt', 'desc').limit(500).get(),
      db2.collection('event_stats').get(),
      db2.collection('albums').orderBy('createdAt', 'desc').limit(50).get(),
    ]);
    const toJson = (s) => s.docs.map((doc) => { const x = doc.data(); return { id: doc.id, ...x, createdAt: x.createdAt?.toDate?.()?.toISOString() || null }; });
    const albums = await Promise.all(albumsSnap.docs.map(async (doc) => {
      const cnt = await doc.ref.collection('photos').count().get();
      return { id: doc.id, ...doc.data(), photoCount: cnt.data().count };
    }));
    return { regs: toJson(regs), members: toJson(members), stats: stats.docs.map((doc) => ({ id: doc.id, ...doc.data(), updatedAt: null })), albums };
  }
);
