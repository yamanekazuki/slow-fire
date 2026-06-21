/* =====================================================
   SLOW FIRE — みんなのBBQ記録 (COOK community feed)
   Features:
     • ユーザー登録（プロフィール）ゲート
     • 複数写真を一気に → 1枚=1記録カード → AI自動入力 → まとめて投稿
     • Claude Vision による料理名/タグ/メモ自動生成（Cloud Function `analyzeCookPhoto`）
     • 検索（料理名・タグ・投稿者・メモ）
   Dual-mode storage:
     • FIREBASE_READY  → Firestore(`cooks`) + Storage + Functions
     • fallback        → localStorage（個人記録＆デモ）
   ===================================================== */
(function () {
  'use strict';

  // ---------- constants ----------
  const TAGS = ['牛', '豚', '鶏', 'ラム', '魚介', '野菜', 'スモーク', 'ロースト', '直火', '低温長時間', '燻製', 'デザート', '初挑戦', '自信作'];
  const AVATARS = ['🔥', '🍖', '🥩', '🍗', '🌶️', '🍔', '🥓', '🧑‍🍳', '🪵', '🏕️', '🍻', '🐷'];
  const MAX_PHOTOS = 12;
  const MAX_EDGE = 1600;
  const JPEG_Q = 0.82;
  const LS_POSTS = 'sf_cook_posts';
  const LS_PROFILE = 'sf_cook_profile';
  const LS_UID = 'sf_cook_uid';
  const LS_REACTED = 'sf_cook_reacted';

  // ---------- helpers ----------
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { console.warn('localStorage full', e); } };
  function hash(str) { let h = 0; for (let i = 0; i < str.length; i++) { h = (h << 5) - h + str.charCodeAt(i); h |= 0; } return h; }
  let __idc = 0;
  function newId() { return Date.now().toString(36) + (__idc++).toString(36) + Math.abs(hash(navigator.userAgent + performance.now())).toString(36).slice(0, 4); }
  function fmtDate(d) {
    if (!d) return '';
    const dt = (typeof d === 'number') ? new Date(d) : new Date(d);
    if (isNaN(dt)) return '';
    return `${dt.getFullYear()}.${String(dt.getMonth() + 1).padStart(2, '0')}.${String(dt.getDate()).padStart(2, '0')}`;
  }
  function monthKey(d) { const dt = new Date(d); return `${dt.getFullYear()}年${dt.getMonth() + 1}月`; }
  function todayISO() { const dt = new Date(); return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`; }

  const FB = !!window.FIREBASE_READY;

  // =====================================================
  // PROFILE / 登録
  // =====================================================
  const Profile = {
    uid: null, name: null, avatar: '🔥', bio: '',
    async ensureLocalId() {
      let id = lsGet(LS_UID, null);
      if (!id) { id = newId(); lsSet(LS_UID, id); }
      return id;
    },
    load() {
      const p = lsGet(LS_PROFILE, null);
      if (p) { this.name = p.name; this.avatar = p.avatar || '🔥'; this.bio = p.bio || ''; }
    },
    async init() {
      this.load();
      if (FB && window.sfAuth) {
        await new Promise((res) => {
          let done = false;
          window.sfAuth.onAuthStateChanged((user) => { if (user) this.uid = user.uid; if (!done) { done = true; res(); } });
          setTimeout(res, 1500);
        });
      }
      if (!this.uid) this.uid = await this.ensureLocalId();
    },
    isRegistered() { return !!this.name; },
    async signInIfNeeded() {
      if (FB && window.sfAuth && !window.sfAuth.currentUser) {
        try { const cred = await window.sfAuth.signInAnonymously(); this.uid = cred.user.uid; }
        catch (e) { console.warn('anon sign-in failed', e); }
      }
    },
    async save(name, avatar, bio) {
      this.name = name; this.avatar = avatar || '🔥'; this.bio = bio || '';
      lsSet(LS_PROFILE, { name: this.name, avatar: this.avatar, bio: this.bio });
      if (FB) {
        await this.signInIfNeeded();
        if (window.db && this.uid) {
          try { await window.db.collection('users').doc(this.uid).set({ name: this.name, avatar: this.avatar, bio: this.bio, updatedAt: Date.now() }, { merge: true }); }
          catch (e) { console.warn('profile save failed', e); }
        }
      }
    }
  };

  // =====================================================
  // STORE
  // =====================================================
  const Store = {
    async list() {
      if (FB && window.db) {
        const snap = await window.db.collection('cooks').orderBy('createdAt', 'desc').limit(300).get();
        return snap.docs.map(d => ({ id: d.id, ...d.data() }));
      }
      return lsGet(LS_POSTS, []).sort((a, b) => b.createdAt - a.createdAt);
    },
    async add(post) {
      if (FB && window.db) { await window.db.collection('cooks').doc(post.id).set(post); return post; }
      const all = lsGet(LS_POSTS, []); all.push(post); lsSet(LS_POSTS, all); return post;
    },
    async remove(id) {
      if (FB && window.db) { await window.db.collection('cooks').doc(id).delete(); return; }
      lsSet(LS_POSTS, lsGet(LS_POSTS, []).filter(p => p.id !== id));
    },
    async react(id, delta) {
      if (FB && window.db) { await window.db.collection('cooks').doc(id).update({ reactionCount: firebase.firestore.FieldValue.increment(delta) }); return; }
      const all = lsGet(LS_POSTS, []); const p = all.find(x => x.id === id);
      if (p) { p.reactionCount = Math.max(0, (p.reactionCount || 0) + delta); lsSet(LS_POSTS, all); }
    },
    async uploadOne(postId, photo) {
      if (FB && window.sfStorage) {
        const ref = window.sfStorage.ref(`cooks/${Profile.uid}/${postId}/0.jpg`);
        await ref.put(photo.blob, { contentType: 'image/jpeg' });
        return await ref.getDownloadURL();
      }
      return photo.dataUrl;
    }
  };

  // =====================================================
  // AI (Claude Vision via Cloud Function)
  // =====================================================
  const AI = {
    available: FB && !!window.sfFunctions,
    callable: null,
    failed: false,
    get fn() {
      if (!this.callable && FB && window.sfFunctions) this.callable = window.sfFunctions.httpsCallable('analyzeCookPhoto');
      return this.callable;
    },
    async analyze(b64, mime) {
      if (!this.available || this.failed || !this.fn) throw new Error('AI unavailable');
      const res = await this.fn({ image: b64, mime });
      return res.data;
    }
  };

  // =====================================================
  // IMAGE
  // =====================================================
  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        let { width: w, height: h } = img;
        if (w > h && w > MAX_EDGE) { h = Math.round(h * MAX_EDGE / w); w = MAX_EDGE; }
        else if (h >= w && h > MAX_EDGE) { w = Math.round(w * MAX_EDGE / h); h = MAX_EDGE; }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', JPEG_Q);
        const b64 = dataUrl.split(',')[1];
        canvas.toBlob(blob => resolve({ blob: blob || dataURLtoBlob(dataUrl), dataUrl, b64, mime: 'image/jpeg' }), 'image/jpeg', JPEG_Q);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('画像を読み込めませんでした')); };
      img.src = url;
    });
  }
  function dataURLtoBlob(dataUrl) {
    const [head, b64] = dataUrl.split(','); const mime = head.match(/:(.*?);/)[1];
    const bin = atob(b64); const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: mime });
  }

  // =====================================================
  // STATE
  // =====================================================
  let posts = [];
  let activeTab = 'all';
  let activeTag = null;
  let searchQuery = '';
  let drafts = [];   // [{id, blob, dataUrl, b64, mime, dishName, cookedAt, method, gear, tempLabel, tags[], aiStatus}]
  let reacted = new Set(lsGet(LS_REACTED, []));

  // =====================================================
  // FEED RENDER
  // =====================================================
  function matchesSearch(p) {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return [p.dishName, p.method, p.authorName, p.gear, p.tempLabel, (p.tags || []).join(' ')]
      .some(v => (v || '').toLowerCase().includes(q));
  }
  function visiblePosts() {
    let list = posts.slice();
    if (activeTab === 'mine') list = list.filter(p => p.uid === Profile.uid);
    if (activeTag) list = list.filter(p => (p.tags || []).includes(activeTag));
    list = list.filter(matchesSearch);
    return list;
  }

  function renderFeed() {
    const feed = $('#feed');
    const empty = $('#emptyState');
    const list = visiblePosts();

    const mineHead = $('#mineHead');
    if (activeTab === 'mine') { mineHead.hidden = false; renderMineStats(); }
    else { mineHead.hidden = true; }

    if (!list.length) {
      feed.innerHTML = '';
      empty.hidden = false;
      const reason = searchQuery ? `「${esc(searchQuery)}」に一致する投稿は見つかりませんでした。`
        : (activeTab === 'mine' ? 'まだ記録がありません。焼いた料理を投稿して、自分のBBQ歴を残しましょう。'
          : 'まだ投稿がありません。いちばん最初の投稿者になりましょう。');
      empty.innerHTML = `<strong>${searchQuery ? '該当なし' : 'まだありません'}</strong>${reason}<br><br><button class="btn-fire" onclick="window.__cookOpenComposer()">＋ 投稿する</button>`;
      return;
    }
    empty.hidden = true;

    let html = '';
    let lastMonth = null;
    list.forEach(p => {
      if (activeTab === 'mine') {
        const mk = monthKey(p.cookedAt || p.createdAt);
        if (mk !== lastMonth) { html += `<div class="cook-month">${esc(mk)}</div>`; lastMonth = mk; }
      }
      html += cardHTML(p);
    });
    feed.innerHTML = html;

    $$('.cook-card', feed).forEach(card => card.addEventListener('click', (e) => {
      if (e.target.closest('.cook-react')) return;
      openDetail(card.dataset.id);
    }));
    $$('.cook-react', feed).forEach(btn => btn.addEventListener('click', (e) => { e.stopPropagation(); toggleReact(btn.dataset.id); }));
  }

  function cardHTML(p) {
    const photos = p.photos || [];
    const cover = photos[0];
    const media = cover
      ? `<div class="cook-card-media"><img src="${esc(cover)}" alt="${esc(p.dishName)}" loading="lazy">${photos.length > 1 ? `<span class="cook-photo-count">📷 ${photos.length}</span>` : ''}</div>`
      : `<div class="cook-card-media no-img">🍖</div>`;
    const tags = (p.tags || []).slice(0, 3).map(t => `<span class="cook-tag-mini">${esc(t)}</span>`).join('');
    const on = reacted.has(p.id);
    return `
      <article class="cook-card" data-id="${esc(p.id)}">
        ${media}
        <div class="cook-card-body">
          <h3 class="cook-card-dish">${esc(p.dishName)}</h3>
          <div class="cook-card-meta">
            <span class="cook-card-author">${esc(p.authorAvatar || '🔥')} ${esc(p.authorName || '名無し')}</span>
            <span>·</span>
            <span>${esc(fmtDate(p.cookedAt || p.createdAt))}</span>
          </div>
          ${tags ? `<div class="cook-card-tags">${tags}</div>` : ''}
          <div class="cook-card-foot">
            <button class="cook-react ${on ? 'is-on' : ''}" data-id="${esc(p.id)}" aria-label="焼けた!">🔥 <span>${p.reactionCount || 0}</span></button>
          </div>
        </div>
      </article>`;
  }

  function renderMineStats() {
    const mine = posts.filter(p => p.uid === Profile.uid);
    const total = mine.length;
    const dishes = new Set(mine.map(p => p.dishName)).size;
    let lastDays = '—';
    if (mine.length) {
      const latest = Math.max(...mine.map(p => new Date(p.cookedAt || p.createdAt).getTime()));
      lastDays = Math.floor((Date.now() - latest) / 86400000);
    }
    $('#mineStats').innerHTML = `
      <div class="cook-mstat"><div class="cook-mstat-num">${total}</div><div class="cook-mstat-label">投稿した記録</div></div>
      <div class="cook-mstat"><div class="cook-mstat-num">${dishes}</div><div class="cook-mstat-label">作った料理の種類</div></div>
      <div class="cook-mstat"><div class="cook-mstat-num">${lastDays}</div><div class="cook-mstat-label">最後のBBQから(日)</div></div>`;
  }

  function renderFilters() {
    const used = new Set();
    posts.forEach(p => (p.tags || []).forEach(t => used.add(t)));
    const el = $('#tagFilters');
    const chips = ['すべて', ...TAGS.filter(t => used.has(t))];
    el.innerHTML = chips.map(t => {
      const val = t === 'すべて' ? null : t;
      const on = activeTag === val || (val === null && activeTag === null);
      return `<button class="cook-chip ${on ? 'is-active' : ''}" data-tag="${val == null ? '' : esc(val)}">${esc(t)}</button>`;
    }).join('');
    $$('.cook-chip', el).forEach(c => c.addEventListener('click', () => { activeTag = c.dataset.tag || null; renderFilters(); renderFeed(); }));
  }

  // =====================================================
  // REACTIONS
  // =====================================================
  async function toggleReact(id) {
    const p = posts.find(x => x.id === id);
    if (!p) return;
    if (reacted.has(id)) { reacted.delete(id); p.reactionCount = Math.max(0, (p.reactionCount || 0) - 1); await Store.react(id, -1); }
    else { reacted.add(id); p.reactionCount = (p.reactionCount || 0) + 1; await Store.react(id, +1); }
    lsSet(LS_REACTED, Array.from(reacted));
    renderFeed();
    if (!$('#detail').hidden && $('#detail').dataset.id === id) openDetail(id);
  }

  // =====================================================
  // DETAIL
  // =====================================================
  function openDetail(id) {
    const p = posts.find(x => x.id === id);
    if (!p) return;
    const photos = p.photos || [];
    const gClass = photos.length <= 1 ? 'g-1' : photos.length === 2 ? 'g-2' : 'g-many';
    const gallery = photos.length ? `<div class="cook-d-gallery ${gClass}">${photos.map(u => `<img src="${esc(u)}" alt="${esc(p.dishName)}" loading="lazy">`).join('')}</div>` : '';
    const specs = [];
    if (p.gear) specs.push(`<div class="cook-d-spec"><b>グリル/道具</b>${esc(p.gear)}</div>`);
    if (p.tempLabel) specs.push(`<div class="cook-d-spec"><b>温度帯</b>${esc(p.tempLabel)}</div>`);
    const tags = (p.tags || []).map(t => `<span class="cook-tag-mini">${esc(t)}</span>`).join(' ');
    const on = reacted.has(p.id);
    const isMine = p.uid === Profile.uid;

    $('#detailBody').innerHTML = `
      ${gallery}
      <h2 class="cook-d-dish">${esc(p.dishName)}</h2>
      <div class="cook-d-meta">
        <span><b>${esc(p.authorAvatar || '🔥')} ${esc(p.authorName || '名無し')}</b></span>
        <span>焼いた日：${esc(fmtDate(p.cookedAt || p.createdAt)) || '—'}</span>
      </div>
      ${tags ? `<div class="cook-card-tags" style="margin-bottom:6px;">${tags}</div>` : ''}
      ${specs.length ? `<div class="cook-d-section"><div class="cook-d-specs">${specs.join('')}</div></div>` : ''}
      ${p.method ? `<div class="cook-d-section"><h4>どう作った？</h4><div class="cook-d-method">${esc(p.method)}</div></div>` : ''}
      <div class="cook-d-foot">
        <button class="cook-react ${on ? 'is-on' : ''}" data-id="${esc(p.id)}">🔥 焼けた! <span>${p.reactionCount || 0}</span></button>
        ${isMine ? `<button class="cook-d-del" data-id="${esc(p.id)}">この記録を削除</button>` : ''}
      </div>`;

    $('.cook-react', $('#detailBody')).addEventListener('click', () => toggleReact(p.id));
    const del = $('.cook-d-del', $('#detailBody'));
    if (del) del.addEventListener('click', async () => {
      if (!confirm('この記録を削除しますか？')) return;
      await Store.remove(p.id);
      posts = posts.filter(x => x.id !== p.id);
      closeModal('#detail'); renderFilters(); renderFeed();
    });

    $('#detail').dataset.id = id;
    openModal('#detail');
  }

  // =====================================================
  // COMPOSER (bulk / multi-post)
  // =====================================================
  function buildComposer() {
    const dz = $('#dropzone');
    const input = $('#photoInput');
    dz.addEventListener('click', () => input.click());
    input.addEventListener('change', () => handleFiles(input.files));
    ['dragenter', 'dragover'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.add('is-drag'); }));
    ['dragleave', 'drop'].forEach(ev => dz.addEventListener(ev, e => { e.preventDefault(); dz.classList.remove('is-drag'); }));
    dz.addEventListener('drop', e => { if (e.dataTransfer.files) handleFiles(e.dataTransfer.files); });
    $('#submitBtn').addEventListener('click', submitAll);
  }

  async function handleFiles(fileList) {
    const files = Array.from(fileList).filter(f => f.type.startsWith('image/'));
    const room = MAX_PHOTOS - drafts.length;
    if (room <= 0) { setMsg(`写真は最大${MAX_PHOTOS}枚までです`, 'err'); return; }
    const take = files.slice(0, room);
    setMsg(`画像を処理中… (${take.length}枚)`, '');
    const added = [];
    for (const f of take) {
      try {
        const img = await compressImage(f);
        const d = { id: newId(), ...img, dishName: '', cookedAt: todayISO(), method: '', gear: '', tempLabel: '', tags: [], aiStatus: AI.available && !AI.failed ? 'pending' : 'na' };
        drafts.push(d); added.push(d);
      } catch (e) { console.warn(e); }
    }
    setMsg('', '');
    renderDrafts();
    $('#photoInput').value = '';
    // AI auto-fill each new draft
    showAiNote();
    added.forEach(d => { if (d.aiStatus === 'pending') runAI(d); });
  }

  function showAiNote() {
    const note = $('#aiNote');
    if (!FB) {
      note.hidden = false;
      note.innerHTML = '💡 写真のAI自動入力（料理名・タグ・メモ）は、FirebaseとAnthropic APIキーの設定後に有効になります。今は手動でどうぞ。';
    } else if (AI.failed) {
      note.hidden = false;
      note.innerHTML = '⚠️ AI自動入力が利用できませんでした（Functions未デプロイの可能性）。手動で入力してください。';
    } else if (AI.available) {
      note.hidden = false;
      note.innerHTML = '✨ AIが写真を見て、料理名・タグ・作り方メモを自動で下書きします。自由に直してください。';
    } else { note.hidden = true; }
  }

  async function runAI(draft) {
    setDraftStatus(draft.id, 'running');
    try {
      const d = await AI.analyze(draft.b64, draft.mime);
      if (d && d.isFood !== false) {
        const card = $(`#draft-${draft.id}`);
        if (!draft.dishName && d.dishName) { draft.dishName = d.dishName; if (card) $('[data-f="dishName"]', card).value = d.dishName; }
        if (!draft.method && d.method) { draft.method = d.method; if (card) $('[data-f="method"]', card).value = d.method; }
        if (!draft.gear && d.gear) { draft.gear = d.gear; if (card) $('[data-f="gear"]', card).value = d.gear; }
        if (!draft.tempLabel && d.tempLabel) { draft.tempLabel = d.tempLabel; if (card) $('[data-f="tempLabel"]', card).value = d.tempLabel; }
        if (Array.isArray(d.tags) && !draft.tags.length) {
          draft.tags = d.tags.filter(t => TAGS.includes(t)).slice(0, 4);
          if (card) $$('.cook-tagopt', card).forEach(b => b.classList.toggle('is-on', draft.tags.includes(b.dataset.tag)));
        }
      }
      setDraftStatus(draft.id, 'done');
    } catch (e) {
      console.warn('AI analyze failed', e);
      AI.failed = true;
      setDraftStatus(draft.id, 'na');
      showAiNote();
      drafts.forEach(d => { if (d.aiStatus === 'pending' || d.aiStatus === 'running') setDraftStatus(d.id, 'na'); });
    }
  }

  function setDraftStatus(id, status) {
    const d = drafts.find(x => x.id === id); if (d) d.aiStatus = status;
    const badge = $(`#draft-${id} .cook-draft-ai`);
    if (!badge) return;
    const map = { pending: '✨ AI待機', running: '✨ AI解析中…', done: '✓ AI入力済', na: '手動入力', error: 'AI不可' };
    badge.textContent = map[status] || '';
    badge.className = 'cook-draft-ai is-' + status;
  }

  function renderDrafts() {
    const wrap = $('#drafts');
    wrap.innerHTML = drafts.map(d => draftCardHTML(d)).join('');
    $('#composerActions').hidden = drafts.length === 0;
    $('#dropzonePrompt').querySelector('span:last-child').textContent = drafts.length
      ? `さらに写真を追加（現在 ${drafts.length} 枚 / 最大${MAX_PHOTOS}）`
      : 'タップして写真を選ぶ（何枚でもOK）/ ここにドラッグ';
    $('#submitBtn').textContent = drafts.length > 1 ? `${drafts.length}件まとめて投稿` : '投稿する';

    drafts.forEach(d => {
      const card = $(`#draft-${d.id}`);
      if (!card) return;
      $('.cook-draft-x', card).addEventListener('click', () => { drafts = drafts.filter(x => x.id !== d.id); renderDrafts(); });
      ['dishName', 'cookedAt', 'method', 'gear', 'tempLabel'].forEach(f => {
        const el = $(`[data-f="${f}"]`, card);
        if (el) el.addEventListener('input', () => { d[f] = el.value; });
      });
      $$('.cook-tagopt', card).forEach(b => b.addEventListener('click', () => {
        const t = b.dataset.tag;
        if (d.tags.includes(t)) { d.tags = d.tags.filter(x => x !== t); b.classList.remove('is-on'); }
        else { d.tags.push(t); b.classList.add('is-on'); }
      }));
      setDraftStatus(d.id, d.aiStatus);
    });
  }

  function draftCardHTML(d) {
    return `
      <div class="cook-draft" id="draft-${esc(d.id)}">
        <div class="cook-draft-photo"><img src="${d.dataUrl}" alt=""><button type="button" class="cook-draft-x" aria-label="削除">✕</button></div>
        <div class="cook-draft-fields">
          <div class="cook-draft-top">
            <span class="cook-draft-ai is-${esc(d.aiStatus)}"></span>
          </div>
          <input type="text" class="cook-input" data-f="dishName" placeholder="料理名（例：スペアリブのスモーク）" maxlength="60" value="${esc(d.dishName)}">
          <div class="cook-meta-row">
            <input type="date" class="cook-input" data-f="cookedAt" value="${esc(d.cookedAt)}">
            <input type="text" class="cook-input" data-f="gear" placeholder="グリル/道具" maxlength="40" value="${esc(d.gear)}">
          </div>
          <input type="text" class="cook-input" data-f="tempLabel" placeholder="温度帯（例：110℃ / 弱火）" maxlength="30" value="${esc(d.tempLabel)}">
          <textarea class="cook-input cook-textarea" data-f="method" rows="3" placeholder="どう作った？（メモ）" maxlength="2000">${esc(d.method)}</textarea>
          <div class="cook-tagpick">${TAGS.map(t => `<button type="button" class="cook-tagopt ${d.tags.includes(t) ? 'is-on' : ''}" data-tag="${esc(t)}">${esc(t)}</button>`).join('')}</div>
        </div>
      </div>`;
  }

  function setMsg(msg, cls) { const el = $('#formMsg'); el.textContent = msg; el.className = 'cook-form-msg ' + (cls || ''); }

  async function submitAll() {
    if (!drafts.length) { setMsg('写真を追加してください', 'err'); return; }
    if (!Profile.isRegistered()) { requireRegister(() => submitAll()); return; }
    const missing = drafts.filter(d => !(d.dishName || '').trim());
    if (missing.length) { setMsg(`料理名が空のカードが${missing.length}件あります`, 'err'); return; }

    const btn = $('#submitBtn'); btn.disabled = true;
    try {
      await Profile.signInIfNeeded();
      let done = 0;
      for (const d of drafts) {
        setMsg(`投稿中… (${done + 1}/${drafts.length})`, '');
        const id = newId();
        const url = await Store.uploadOne(id, { blob: d.blob, dataUrl: d.dataUrl });
        const post = {
          id, uid: Profile.uid, authorName: Profile.name, authorAvatar: Profile.avatar,
          dishName: d.dishName.trim(), method: (d.method || '').trim(),
          gear: (d.gear || '').trim(), tempLabel: (d.tempLabel || '').trim(),
          tags: (d.tags || []).slice(), photos: [url],
          cookedAt: d.cookedAt || todayISO(), createdAt: Date.now() - (drafts.length - done), reactionCount: 0
        };
        await Store.add(post);
        posts.unshift(post);
        done++;
      }
      drafts = [];
      renderDrafts();
      closeModal('#composer');
      renderFilters(); renderFeed();
      if (typeof gtag === 'function') gtag('event', 'cook_post', { count: done, mode: FB ? 'firebase' : 'local' });
    } catch (err) {
      console.error(err);
      setMsg('投稿に失敗しました：' + (err.message || err), 'err');
    } finally { btn.disabled = false; }
  }

  function openComposer() {
    if (!Profile.isRegistered()) { requireRegister(() => openComposer()); return; }
    showAiNote();
    renderDrafts();
    openModal('#composer');
  }
  window.__cookOpenComposer = openComposer;

  // =====================================================
  // REGISTRATION
  // =====================================================
  let regThen = null;
  let regAvatar = '🔥';
  function buildRegister() {
    $('#avatarPick').innerHTML = AVATARS.map(a => `<button type="button" class="cook-avatar" data-a="${a}">${a}</button>`).join('');
    $$('.cook-avatar').forEach(b => b.addEventListener('click', () => {
      regAvatar = b.dataset.a;
      $$('.cook-avatar').forEach(x => x.classList.toggle('is-on', x === b));
    }));
    $('#regSave').addEventListener('click', saveRegister);
    $('#regName').addEventListener('keydown', e => { if (e.key === 'Enter') saveRegister(); });
  }
  function requireRegister(then) {
    regThen = then || null;
    regAvatar = Profile.avatar || '🔥';
    $('#regName').value = Profile.name || '';
    $('#regBio').value = Profile.bio || '';
    $$('.cook-avatar').forEach(x => x.classList.toggle('is-on', x.dataset.a === regAvatar));
    $('#regMsg').textContent = '';
    openModal('#regModal');
    setTimeout(() => $('#regName').focus(), 50);
  }
  async function saveRegister() {
    const name = $('#regName').value.trim();
    if (!name) { $('#regMsg').textContent = '表示名を入力してください'; $('#regMsg').className = 'cook-form-msg err'; $('#regName').focus(); return; }
    $('#regSave').disabled = true;
    await Profile.save(name, regAvatar, $('#regBio').value.trim());
    $('#regSave').disabled = false;
    renderProfileChip();
    closeModal('#regModal');
    if (regThen) { const fn = regThen; regThen = null; fn(); }
    renderFeed();
  }

  function renderProfileChip() {
    const el = $('#identityChip');
    if (Profile.isRegistered()) {
      el.innerHTML = `${esc(Profile.avatar)} <strong>${esc(Profile.name)}</strong> <a id="editProfile">プロフィール編集</a>`;
      $('#editProfile').addEventListener('click', () => requireRegister());
    } else {
      el.innerHTML = `<a id="doRegister">＋ ユーザー登録して参加</a>`;
      $('#doRegister').addEventListener('click', () => requireRegister());
    }
  }

  // =====================================================
  // MODAL utils
  // =====================================================
  function openModal(sel) { $(sel).hidden = false; document.body.style.overflow = 'hidden'; }
  function closeModal(sel) { $(sel).hidden = true; document.body.style.overflow = ''; }

  // =====================================================
  // INIT
  // =====================================================
  async function init() {
    const banner = $('#modeBanner');
    if (!FB) {
      banner.hidden = false;
      banner.innerHTML = 'この端末に保存される<strong>お試し / 個人記録モード</strong>で動作中です（Firebase未設定）。設定するとみんなで共有でき、写真のAI自動入力も使えます。';
    }

    await Profile.init();
    renderProfileChip();
    buildComposer();
    buildRegister();

    // tabs
    $$('.cook-tab').forEach(t => t.addEventListener('click', () => {
      $$('.cook-tab').forEach(x => x.classList.remove('is-active'));
      t.classList.add('is-active');
      activeTab = t.dataset.tab;
      if (activeTab === 'mine' && !Profile.isRegistered()) requireRegister();
      renderFeed();
    }));

    // search
    const searchInput = $('#searchInput');
    searchInput.addEventListener('input', () => {
      searchQuery = searchInput.value.trim();
      $('#searchClear').hidden = !searchQuery;
      renderFeed();
    });
    $('#searchClear').addEventListener('click', () => { searchInput.value = ''; searchQuery = ''; $('#searchClear').hidden = true; renderFeed(); searchInput.focus(); });

    // buttons
    $('#fab').addEventListener('click', openComposer);
    $('#heroPostBtn').addEventListener('click', openComposer);
    $('#composerClose').addEventListener('click', () => closeModal('#composer'));
    $('#composerCancel').addEventListener('click', () => closeModal('#composer'));
    $('#detailClose').addEventListener('click', () => closeModal('#detail'));
    $$('.cook-modal').forEach(m => m.addEventListener('click', e => { if (e.target === m) closeModal('#' + m.id); }));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') $$('.cook-modal').forEach(m => { if (!m.hidden) closeModal('#' + m.id); }); });

    try { posts = await Store.list(); }
    catch (e) { console.error('load failed', e); posts = lsGet(LS_POSTS, []); }
    $('#loadingState').hidden = true;
    renderFilters();
    renderFeed();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
