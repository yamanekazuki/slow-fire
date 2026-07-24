/* =============================================
   COOK LOG — Cloud Functions
   - analyzeCookPhoto : BBQ写真をClaude(Vision)で解析し
     料理名・タグ・作り方メモ・道具・温度帯を自動推定
   ============================================= */
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
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

const ROLE_LABEL = { fan: 'ファン（まず火を囲む）', ambassador: 'アンバサダー（広める）', sommelier: 'BBQソムリエ（知識で語る）', pitmaster: '焼き手（振る舞う）' };

async function bbqSendMail(apiKey, { to, subject, html, replyTo }) {
  const { Resend } = require('resend');
  const resend = new Resend(apiKey);
  const res = await resend.emails.send({ from: BBQ_FROM, to, subject, html, ...(replyTo ? { reply_to: replyTo } : {}) });
  if (res?.error) console.error('resend error:', JSON.stringify(res.error).slice(0, 300));
  return res;
}

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
  { document: 'event_regs/{id}', region: 'us-central1', secrets: [RESEND_API_KEY], maxInstances: 3 },
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
    const info = `<table style="border-collapse:collapse;width:100%;font-size:14px">
      ${[['開催回', esc(d.eventLabel || eventId)], ['お名前', esc(d.name)], ['メール', esc(d.email)], ['人数', `${party}名`], ['ひとこと', esc(d.note) || '—'], ['状態', waitlisted ? '⚠️ キャンセル待ち' : '✅ 受付'], ['現在の申込', `${newCount} / ${EVENT_CAPACITY}名`]].map(([k, v]) => `<tr><td style="padding:6px 10px;background:#f5efe2;border:1px solid #e8dcc8;width:96px;white-space:nowrap">${k}</td><td style="padding:6px 10px;border:1px solid #e8dcc8">${v}</td></tr>`).join('')}
    </table>`;

    await Promise.all([
      bbqSendMail(apiKey, {
        to: BBQ_ADMINS,
        replyTo: d.email,
        subject: `【月1BBQ申込】${d.name}さん ${party}名（${eventId}・${newCount}/${EVENT_CAPACITY}）${waitlisted ? '★キャンセル待ち' : ''}`,
        html: mailShell('月1BBQに新しい申込がありました', info + `<p style="margin-top:14px">一覧は <a href="https://yamanekazuki.github.io/slow-fire/admin.html">管理ページ</a> から。</p>`),
      }),
      d.email ? bbqSendMail(apiKey, {
        to: d.email,
        subject: waitlisted ? '【YORON BBQ】キャンセル待ちで承りました' : '【YORON BBQ】お申し込みありがとうございます',
        html: mailShell(
          waitlisted ? 'キャンセル待ちで承りました' : 'お申し込み、受け付けました🔥',
          `<p>${esc(d.name)}さん、ありがとうございます。</p>` +
          (waitlisted
            ? `<p>あいにく定員（${EVENT_CAPACITY}名）に達しているため、<b>キャンセル待ち</b>としてお預かりしました。お席が空き次第、このメールアドレスにご連絡します。</p>`
            : `<p><b>${esc(d.eventLabel || eventId)}</b> のご参加、楽しみにしています。当日の詳しいご案内は、開催が近づいたら改めてメールでお送りします。</p>
               <p style="background:#f5efe2;border-radius:8px;padding:12px 14px;font-size:14px">参加費は<b>5,000円</b>（施設利用料・食材・ソフトドリンク込み）。<b>お酒はご自身のお好きなものをお持ちください。</b></p>`) +
          `<p>ご都合が悪くなった場合は、このメールに返信いただければ大丈夫です。</p>`
        ),
      }) : Promise.resolve(),
    ]);
  }
);

// ---- コミュニティ入会 ----
exports.onMemberJoin = onDocumentCreated(
  { document: 'members/{id}', region: 'us-central1', secrets: [RESEND_API_KEY], maxInstances: 3 },
  async (event) => {
    const snap = event.data; if (!snap) return;
    const d = snap.data();
    const role = ROLE_LABEL[d.role] || 'ファン';
    const apiKey = RESEND_API_KEY.value();
    const info = `<table style="border-collapse:collapse;width:100%;font-size:14px">
      ${[['お名前', esc(d.name)], ['メール', esc(d.email)], ['関わり方', esc(role)], ['ひとこと', esc(d.note) || '—']].map(([k, v]) => `<tr><td style="padding:6px 10px;background:#f5efe2;border:1px solid #e8dcc8;width:96px;white-space:nowrap">${k}</td><td style="padding:6px 10px;border:1px solid #e8dcc8">${v}</td></tr>`).join('')}
    </table>`;
    await Promise.all([
      bbqSendMail(apiKey, {
        to: BBQ_ADMINS,
        replyTo: d.email,
        subject: `【コミュニティ入会】${d.name}さん（${role}）`,
        html: mailShell('新しい仲間が増えました', info + `<p style="margin-top:14px">LINEグループへの招待をお願いします。一覧は <a href="https://yamanekazuki.github.io/slow-fire/admin.html">管理ページ</a> から。</p>`),
      }),
      d.email ? bbqSendMail(apiKey, {
        to: d.email,
        subject: '【YORON BBQ】ようこそ、火の輪へ🔥',
        html: mailShell('ようこそ、YORON BBQ COMMUNITYへ',
          `<p>${esc(d.name)}さん、仲間入りありがとうございます。入会金も資格も審査もありません——今日からもう仲間です。</p>
           <p>このコミュニティでできること:</p>
           <ul style="padding-left:20px;margin:8px 0 14px">
             <li><b>月1BBQの先行案内</b> — 毎月の開催日程をメールでいちばん早くお届けします</li>
             <li><b>LINEグループへの招待</b> — 数日以内に運営からこのアドレスへ招待をお送りします。日々の「焼いたよ」報告や質問はこちらで</li>
             <li><b>ACADEMYで学ぶ</b> — <a href="https://yamanekazuki.github.io/slow-fire/academy.html">温度と道具の科学</a>はいつでも無料</li>
             <li><b>ときどきの便り</b> — レシピや開催レポートを月1〜2通だけお送りします（多すぎる配信はしません）</li>
           </ul>
           <p>まずは次回の<a href="https://yamanekazuki.github.io/slow-fire/event.html">月1BBQ</a>へ。「行ってみたい」の一言で参加成立です。</p>`),
      }) : Promise.resolve(),
    ]);
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
    const [regs, members, stats] = await Promise.all([
      db2.collection('event_regs').orderBy('createdAt', 'desc').limit(300).get(),
      db2.collection('members').orderBy('createdAt', 'desc').limit(500).get(),
      db2.collection('event_stats').get(),
    ]);
    const toJson = (s) => s.docs.map((doc) => { const x = doc.data(); return { id: doc.id, ...x, createdAt: x.createdAt?.toDate?.()?.toISOString() || null }; });
    return { regs: toJson(regs), members: toJson(members), stats: stats.docs.map((doc) => ({ id: doc.id, ...doc.data(), updatedAt: null })) };
  }
);
