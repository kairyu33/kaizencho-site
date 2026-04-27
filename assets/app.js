// 献立帖 - 公開サイト
// GitHub Pagesで完全にクライアントサイド動作（data.jsonを読み込み）

const STORAGE_KEY = 'kondate_state';
const AB_KEY = 'kondate_ab';
const RARITY_KANJI = { SSR: '極', SR: '特', R: '上', N: '並' };

// シェア文面の A/B variant
//   v1: 落ち着いた料亭調（控えめ）
//   v2: 興奮を伝える即時投稿調（カジュアル）
// UTMの utm_content にバリアント名が入るので、note-article-manager / 解析側でCV比較可能
const SHARE_VARIANTS = {
  SSR: {
    v1: (title, handle) =>
      `${handle ? handle + ' さん\n' : ''}✨【極】を引き当てました…\n\n「${title}」\n\n千の記事から今日の一献を授かる、献立帖にて。`,
    v2: (title, handle) =>
      `${handle ? handle + ' さん、' : ''}見てください…！\n🏮【極】出ました…！\n\n「${title}」\n\n— 献立帖・成功のレシピ`,
  },
  SR: {
    v1: (title) => `🍶【特】の献立を頂きました\n\n「${title}」\n\n— 献立帖・成功のレシピ`,
    v2: (title) => `今日の一献は【特】でした✨\n\n「${title}」\n\n献立帖にて`,
  },
  R: {
    v1: (title) => `🌿【上】の献立を頂きました\n\n「${title}」\n\n— 献立帖・成功のレシピ`,
    v2: (title) => `今日の献立は【上】\n\n「${title}」\n\n— 献立帖にて`,
  },
  N: {
    v1: (title) => `🍙【並】の献立を頂きました\n\n「${title}」\n\n— 献立帖・成功のレシピ`,
    v2: (title) => `今日の一献は【並】\n\n「${title}」\n\n— 献立帖にて`,
  },
};

// 同一ユーザに同じバリアントを出し続け、誘引差をフェアに比較する
function getShareVariant() {
  try {
    let v = localStorage.getItem(AB_KEY);
    if (v !== 'v1' && v !== 'v2') {
      v = Math.random() < 0.5 ? 'v1' : 'v2';
      localStorage.setItem(AB_KEY, v);
    }
    return v;
  } catch {
    return Math.random() < 0.5 ? 'v1' : 'v2';
  }
}

// 流入元計測のためのUTM付きURLを生成
function buildShareUrl(rarity, variant) {
  const base = location.href.split('?')[0].split('#')[0]; // テストパラメータを除去
  const u = new URL(base);
  u.searchParams.set('utm_source', 'twitter');
  u.searchParams.set('utm_medium', 'ikkon_share');
  u.searchParams.set('utm_campaign', rarity.toLowerCase()); // ssr/sr/r/n
  u.searchParams.set('utm_content', variant);               // v1/v2
  return u.toString();
}

// ===== A/B イベント送信（TASK-014）=====
// state.data.ab_api_url が設定されていれば、そのエンドポイントへ POST。
// sendBeacon を優先し、フォールバックで fetch keepalive。
// 送信失敗は静かに握り潰す（公開サイトの体験を阻害しない）。
function abTrack(experiment, variant, event, extra) {
  try {
    if (!state.data || !state.data.ab_api_url) return;
    // 同一オリジンの場合は同一オリジンのパスにフォールバック可
    const url = state.data.ab_api_url;
    const sid = (() => {
      try {
        let s = localStorage.getItem('kondate_session');
        if (!s) { s = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem('kondate_session', s); }
        return s;
      } catch { return null; }
    })();
    const payload = JSON.stringify({ experiment, variant, event, session_id: sid, ...(extra || {}) });
    if (navigator.sendBeacon) {
      const blob = new Blob([payload], { type: 'application/json' });
      navigator.sendBeacon(url, blob);
    } else {
      fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        keepalive: true,
        mode: 'cors',
      }).catch(() => {});
    }
  } catch (_) { /* noop */ }
}

// テスト用URLパラメータ:
//   ?force=SSR|SR|R|N  …次のガチャを必ずそのレアリティにする
//   ?reset=1           …localStorage の本日引いた記録を消す
const URL_PARAMS = new URLSearchParams(location.search);
const FORCE_RARITY = (URL_PARAMS.get('force') || '').toUpperCase();
const FORCED = ['SSR', 'SR', 'R', 'N'].includes(FORCE_RARITY) ? FORCE_RARITY : null;
if (URL_PARAMS.get('reset') === '1') {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
}

const state = {
  data: null,
  catalogOffset: 0,
  catalogFilter: { search: '', rarity: '', category: '', sort: 'rarity', unreadOnly: false },
  readSet: null, // 既読URLの Set（localStorage で永続化）
};

// ===== 既読管理（localStorage） =====
const READ_KEY = 'kondate_read_v1';
function loadReadSet() {
  if (state.readSet) return state.readSet;
  try {
    const raw = localStorage.getItem(READ_KEY);
    state.readSet = new Set(raw ? JSON.parse(raw) : []);
  } catch { state.readSet = new Set(); }
  return state.readSet;
}
function saveReadSet() {
  try {
    // localStorage の上限を考慮して 5000 件で打ち切り（最新を残す）
    const arr = Array.from(state.readSet).slice(-5000);
    localStorage.setItem(READ_KEY, JSON.stringify(arr));
  } catch {}
}
function markRead(article) {
  const key = article.url || `id:${article.id}`;
  loadReadSet().add(key);
  saveReadSet();
}
function isRead(article) {
  const key = article.url || `id:${article.id}`;
  return loadReadSet().has(key);
}
function clearReadSet() {
  state.readSet = new Set();
  try { localStorage.removeItem(READ_KEY); } catch {}
}

// ===== 投票の不正対策（多層防御） =====
// 1) localStorage（既存・最軽量）
// 2) IndexedDB （localStorage クリアされても残る）
// 3) ブラウザ・フィンガープリント（端末特定キー、cookie/Storageを跨いで一意性）
// 4) 任意で API 経由のサーバ集計（state.data.vote_api_url が設定されていれば送信）
const VOTE_DB_NAME = 'kondate_votes';
const VOTE_STORE = 'votes';
let _fpCache = null;

async function getFingerprint() {
  if (_fpCache) return _fpCache;
  // canvas + screen + navigator から疑似ユニーク値を作る
  // 同一ブラウザ・同一端末ではほぼ安定、incognito でも UA/screen は維持される
  const parts = [
    navigator.userAgent || '',
    navigator.language || '',
    (navigator.languages || []).join(','),
    `${screen.width}x${screen.height}x${screen.colorDepth}`,
    new Date().getTimezoneOffset(),
    navigator.hardwareConcurrency || '',
    navigator.platform || '',
  ];
  try {
    const c = document.createElement('canvas');
    c.width = 200; c.height = 60;
    const g = c.getContext('2d');
    g.textBaseline = 'top';
    g.font = '14px "Shippori Mincho", serif';
    g.fillStyle = '#B23A2E';
    g.fillRect(0, 0, 200, 30);
    g.fillStyle = '#1C1613';
    g.fillText('献立帖・成功のレシピ ◇♕✱', 2, 8);
    parts.push(c.toDataURL().slice(-80));
  } catch {}
  // SHA-256
  try {
    const buf = new TextEncoder().encode(parts.join('|'));
    const hash = await crypto.subtle.digest('SHA-256', buf);
    _fpCache = Array.from(new Uint8Array(hash)).slice(0, 12)
      .map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // crypto.subtle が無い古い環境向けフォールバック
    let h = 0;
    for (const ch of parts.join('|')) h = ((h << 5) - h + ch.charCodeAt(0)) | 0;
    _fpCache = 'fp' + Math.abs(h).toString(16);
  }
  return _fpCache;
}

function openVoteDB() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
    const req = indexedDB.open(VOTE_DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(VOTE_STORE)) {
        db.createObjectStore(VOTE_STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function readVoteIDB(key) {
  try {
    const db = await openVoteDB();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(VOTE_STORE, 'readonly');
      const r = tx.objectStore(VOTE_STORE).get(key);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => reject(r.error);
    });
  } catch { return null; }
}

async function writeVoteIDB(record) {
  try {
    const db = await openVoteDB();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(VOTE_STORE, 'readwrite');
      tx.objectStore(VOTE_STORE).put(record);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch {}
}

// 「この choice に投票済みか？」を3経路で確認
async function hasVoted(choiceId) {
  const saved = loadState();
  if (saved[`vote_${choiceId}`]) return saved[`vote_${choiceId}`];
  const fp = await getFingerprint();
  const key = `${choiceId}:${fp}`;
  const rec = await readVoteIDB(key);
  return rec ? rec.option : null;
}

async function init() {
  try {
    const res = await fetch('data.json?t=' + Date.now());
    if (!res.ok) throw new Error('data.jsonが見つかりません');
    state.data = await res.json();

    const noteUrl = state.data.creator?.note_url || 'https://note.com/';
    const memberUrl = state.data.creator?.membership_url || (noteUrl.replace(/\/$/, '') + '/membership');
    document.getElementById('noteLink').href = noteUrl;
    document.getElementById('footNote').href = noteUrl;
    document.getElementById('footMember').href = memberUrl;

    // Xハンドルを SSRボーナス文面に反映
    const handle = (state.data.creator?.x_handle || '').trim();
    const xMention = document.getElementById('xMention');
    if (xMention && handle) {
      xMention.textContent = handle;
      // メンション部をXのプロフへリンクに
      const a = document.createElement('a');
      a.href = 'https://twitter.com/' + handle.replace(/^@/, '');
      a.target = '_blank';
      a.rel = 'noopener';
      a.className = 'x-mention';
      a.textContent = handle;
      xMention.replaceWith(a);
    }

    initGacha();
    initVote();
    initCatalog();
    initRanking();
  } catch (e) {
    console.error(e);
    showToast('読込に失敗しました: ' + e.message);
  }
}

// ===== 目利き帖（読者ランキング / TASK-015） =====
function getSessionId() {
  try {
    let s = localStorage.getItem('kondate_session');
    if (!s) {
      s = Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem('kondate_session', s);
    }
    return s;
  } catch {
    return null;
  }
}

async function initRanking() {
  const apiUrl = state.data && state.data.readers_api_url;
  const section = document.getElementById('ranking');
  if (!apiUrl || !section) return; // API未設定時は完全に隠す

  section.style.display = '';
  await loadRanking();

  // 登録フォーム
  const submitBtn = document.getElementById('rankSubmitBtn');
  if (submitBtn) {
    submitBtn.onclick = async (ev) => {
      ev.preventDefault();
      const nick = (document.getElementById('rankNick').value || '').trim();
      const handle = (document.getElementById('rankXHandle').value || '').trim().replace(/^@+/, '');
      if (!nick && !handle) {
        showToast('お呼び名 か X ID をご入力ください');
        return;
      }
      try {
        const base = apiUrl.replace(/\/$/, '');
        const res = await fetch(`${base}/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: getSessionId(),
            nickname: nick || null,
            x_handle: handle || null,
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '登録に失敗');
        showToast('お届け先を承りました');
        document.getElementById('rankNick').value = '';
        document.getElementById('rankXHandle').value = '';
        await loadRanking(); // 再描画
      } catch (e) {
        showToast(e.message);
      }
    };
  }
}

async function loadRanking() {
  const apiUrl = state.data && state.data.readers_api_url;
  if (!apiUrl) return;
  const sid = getSessionId();
  // apiUrl は /api/readers のベース。末尾スラッシュを除去して /ranking を付ける
  const base = apiUrl.replace(/\/$/, '');
  const finalUrl = `${base}/ranking?limit=10` + (sid ? `&session_id=${encodeURIComponent(sid)}` : '');

  let data;
  try {
    const res = await fetch(finalUrl);
    data = await res.json();
    if (!res.ok) throw new Error(data.error || 'ranking取得失敗');
  } catch (e) {
    console.warn('ranking load failed', e);
    return;
  }

  // 自分の順位
  const meEl = document.getElementById('rankingMe');
  if (meEl) {
    if (data.me) {
      meEl.innerHTML = `
        貴方様は今月、<span class="me-rank">第${data.me.rank}位</span> にいらっしゃいます。<br>
        ご献立 ${data.me.draw_count}回 ／ お声 ${data.me.vote_count}回 ／ ご紹介 ${data.me.share_count}回
      `;
    } else {
      meEl.innerHTML = `<span class="muted">まだご活動の記録がございません。一献目を引いて頂戴できれば嬉しゅうございます。</span>`;
    }
  }

  // ランキングリスト
  const listEl = document.getElementById('rankingList');
  if (listEl) {
    if (!data.top || !data.top.length) {
      listEl.innerHTML = '<div class="ranking-empty">— 今月、まだご記録はございません —</div>';
    } else {
      listEl.innerHTML = data.top.map((r) => `
        <li>
          <span class="rk-num">${r.rank}</span>
          <span>
            <span class="rk-name">${escHtml(r.display_name)}</span>
            <span class="rk-meta">献 ${r.draw_count} / 声 ${r.vote_count} / 紹 ${r.share_count}</span>
          </span>
          <span class="rk-score">${r.score}</span>
        </li>
      `).join('');
    }
  }
}

// ===== ガチャ =====
function initGacha() {
  const drawBtn = document.getElementById('drawBtn');
  const drawState = document.getElementById('drawState');
  const saved = loadState();
  const today = new Date().toISOString().split('T')[0];

  if (!FORCED && saved.lastDraw === today && saved.lastResult) {
    showResult(saved.lastResult, false);
    drawState.textContent = '本日の一献はお引きになりました';
  } else {
    drawBtn.addEventListener('click', drawGacha);
    if (FORCED) {
      drawState.innerHTML = `<strong style="color:#b23a2e">テストモード：${RARITY_KANJI[FORCED]}（${FORCED}）を強制抽選します</strong>`;
    }
  }

  document.getElementById('againBtn')?.addEventListener('click', () => {
    document.getElementById('gachaIdle').style.display = '';
    document.getElementById('gachaResult').style.display = 'none';
    drawBtn.disabled = true;
    drawState.textContent = '本日の一献はお引きになりました';
  });
}

async function drawGacha() {
  document.getElementById('gachaIdle').style.display = 'none';
  document.getElementById('gachaAnim').style.display = '';

  // 巻物が開くアニメを見せる
  await new Promise(r => setTimeout(r, 1800));

  let targetRarity;
  if (FORCED) {
    // テストモード: URL ?force=SSR|SR|R|N
    targetRarity = FORCED;
  } else {
    const rand = Math.random();
    if (rand < 0.02) targetRarity = 'SSR';
    else if (rand < 0.10) targetRarity = 'SR';
    else if (rand < 0.30) targetRarity = 'R';
    else targetRarity = 'N';
  }

  let pool = state.data.articles.filter(a => a.rarity === targetRarity && !a.is_membership);
  if (!pool.length) pool = state.data.articles.filter(a => a.rarity === targetRarity);
  if (!pool.length) {
    pool = state.data.articles;
    targetRarity = 'N';
  }
  if (!pool.length) {
    showToast('献立がまだ登録されていません');
    return;
  }

  const article = pool[Math.floor(Math.random() * pool.length)];
  const result = { article, rarity: targetRarity, at: new Date().toISOString() };

  // テストモード時は localStorage に記録しない（何度でも引けるように）
  if (!FORCED) {
    const today = new Date().toISOString().split('T')[0];
    saveState({ lastDraw: today, lastResult: result });
  }

  document.getElementById('gachaAnim').style.display = 'none';
  showResult(result, true);
}

function showResult(result, animate) {
  const { article, rarity } = result;
  const resultEl = document.getElementById('gachaResult');
  resultEl.style.display = '';

  if (animate && rarity !== 'N') {
    const flash = document.getElementById('resultFlash');
    flash.className = 'flash ' + rarity.toLowerCase() + ' active';
    setTimeout(() => flash.className = 'flash', 1800);
  }

  const stamp = document.getElementById('resultRarity');
  stamp.className = 'rarity-stamp ' + rarity;
  stamp.innerHTML = RARITY_KANJI[rarity];

  document.getElementById('resultTitle').textContent = article.title;
  document.getElementById('resultCat').textContent = article.category ? `— ${article.category} —` : '';

  const readBtn = document.getElementById('readBtn');
  readBtn.href = article.url || state.data.creator.note_url;

  const ssrBonus = document.getElementById('ssrBonus');
  ssrBonus.style.display = rarity === 'SSR' ? '' : 'none';

  // A/B: impression（結果が画面表示された）
  const abVariant = getShareVariant();
  abTrack('share_text', abVariant, 'impression', { rarity });

  // CTA（記事を読む）クリック計測
  readBtn.onclick = () => {
    abTrack('share_text', abVariant, 'cta_click', { rarity });
  };

  document.getElementById('shareBtn').onclick = () => {
    const handle = (state.data.creator?.x_handle || '').trim();
    const variant = abVariant;
    const builder = (SHARE_VARIANTS[rarity] || SHARE_VARIANTS.N)[variant]
                  || SHARE_VARIANTS[rarity].v1;
    const text = builder(article.title, handle);
    const url = buildShareUrl(rarity, variant);
    abTrack('share_text', variant, 'share', { rarity });
    window.open(
      `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}&hashtags=献立帖,成功のレシピ`,
      '_blank'
    );
  };

  renderRelated(article);
}

function renderRelated(base) {
  const all = state.data.articles.filter(a => a.id !== base.id);
  let related = [];

  if (base.category) {
    related = all.filter(a => a.category === base.category).slice(0, 3);
  }
  if (related.length < 3) {
    const tags = (base.tags || '').split(/[,、\s]+/).filter(Boolean);
    if (tags.length) {
      const more = all.filter(a =>
        !related.includes(a) &&
        tags.some(t => (a.tags || '').includes(t))
      ).slice(0, 3 - related.length);
      related = related.concat(more);
    }
  }
  if (related.length < 3) {
    const shuffled = all.filter(a => !related.includes(a)).sort(() => Math.random() - 0.5);
    related = related.concat(shuffled.slice(0, 3 - related.length));
  }

  document.getElementById('relatedList').innerHTML = related.map(a => `
    <a href="${escAttr(a.url || state.data.creator.note_url)}" target="_blank" rel="noopener" class="related-item">
      <span>${escHtml(a.title)}</span>
      <span class="r-rarity ${a.rarity}">${RARITY_KANJI[a.rarity] || '並'}</span>
    </a>
  `).join('');
}

// ===== 投票 =====
async function initVote() {
  const area = document.getElementById('voteArea');
  const tc = state.data.today_choice;

  if (!tc) {
    area.innerHTML = '<p class="empty">本日のお品書きは、まだご用意出来ておりません。</p>';
    return;
  }

  const userVote = await hasVoted(tc.id);
  renderVote(tc, userVote);
}

function renderVote(tc, userVote) {
  const area = document.getElementById('voteArea');
  const total = (tc.votes_a || 0) + (tc.votes_b || 0) + (tc.votes_c || 0);

  const opts = [
    { key: 'a', letter: '甲', text: tc.option_a, votes: tc.votes_a || 0 },
    { key: 'b', letter: '乙', text: tc.option_b, votes: tc.votes_b || 0 },
    { key: 'c', letter: '丙', text: tc.option_c, votes: tc.votes_c || 0 },
  ];

  const html = userVote
    ? opts.map(o => {
        const pct = total > 0 ? (o.votes / total * 100) : 0;
        return `
          <div class="vote-opt voted" style="--pct:${pct.toFixed(1)}%">
            <span class="opt-letter">${o.letter}</span>${escHtml(o.text)}
            <div class="vote-result"><span>${o.votes} 票</span><span>${pct.toFixed(1)}%</span></div>
          </div>`;
      }).join('')
    : opts.map(o => `
        <button class="vote-opt" data-opt="${o.key}">
          <span class="opt-letter">${o.letter}</span>${escHtml(o.text)}
        </button>`).join('');

  const voted = opts.find(o => o.key === userVote);
  area.innerHTML = `
    <div class="vote-date">${formatDateJa(tc.date)}</div>
    <div class="vote-options">${html}</div>
    ${userVote
      ? `<p class="vote-msg">「${voted?.letter}」に一票、頂戴いたしました。明日の献立にご期待を。</p>`
      : '<p class="vote-msg">気になる献立に、一票どうぞ</p>'}
  `;

  if (!userVote) {
    area.querySelectorAll('.vote-opt').forEach(btn => {
      btn.addEventListener('click', () => castVote(tc.id, btn.dataset.opt, tc));
    });
  }
}

function formatDateJa(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}年 ${d.getMonth() + 1}月 ${d.getDate()}日`;
}

async function castVote(choiceId, option, tc) {
  // 二重投票チェック（フィンガープリント＋IndexedDB）
  const already = await hasVoted(choiceId);
  if (already) {
    renderVote(tc, already);
    showToast('— 既にご投票頂いております —');
    return;
  }

  // 即時UI反映（楽観的）
  const saved = loadState();
  saved[`vote_${choiceId}`] = option;
  saveState(saved);

  const fp = await getFingerprint();
  await writeVoteIDB({
    key: `${choiceId}:${fp}`,
    choice_id: choiceId,
    option,
    fingerprint: fp,
    voted_at: new Date().toISOString(),
  });

  tc['votes_' + option] = (tc['votes_' + option] || 0) + 1;
  renderVote(tc, option);
  showToast('— 一票、頂戴いたしました —');

  // サーバ集計APIが構成されていれば送信（将来 vote-api/ をデプロイした時用）
  const apiUrl = state.data.vote_api_url;
  if (apiUrl) {
    try {
      await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ choice_id: choiceId, option, fingerprint: fp }),
        keepalive: true,
      });
    } catch (e) {
      // ネットワーク失敗は致命傷ではない（クライアント側集計は出来ている）
      console.warn('vote API failed', e);
    }
  }
}

// ===== カタログ =====
function initCatalog() {
  loadReadSet();

  const search = document.getElementById('searchBox');
  search.addEventListener('input', debounce(() => {
    state.catalogFilter.search = search.value.toLowerCase();
    state.catalogOffset = 0;
    renderCatalog();
  }, 200));

  document.querySelectorAll('.toc-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.toc-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.catalogFilter.rarity = btn.dataset.r;
      state.catalogOffset = 0;
      renderCatalog();
    });
  });

  // テーマ（category / genre）プルダウンを動的生成。category 優先、無ければ genre
  const catSel = document.getElementById('catCategory');
  if (catSel) {
    const useGenre = state.data.articles.some(a => a.genre) && !state.data.articles.some(a => a.category);
    const field = useGenre ? 'genre' : 'category';
    const counts = {};
    for (const a of state.data.articles) {
      const v = (a[field] || '').trim();
      if (!v) continue;
      counts[v] = (counts[v] || 0) + 1;
    }
    const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    for (const [v, n] of sorted) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = `${v} (${n})`;
      catSel.appendChild(opt);
    }
    catSel.dataset.field = field;
    catSel.addEventListener('change', () => {
      state.catalogFilter.category = catSel.value;
      state.catalogOffset = 0;
      renderCatalog();
    });
  }

  const sortSel = document.getElementById('catSort');
  if (sortSel) {
    sortSel.addEventListener('change', () => {
      state.catalogFilter.sort = sortSel.value;
      state.catalogOffset = 0;
      renderCatalog();
    });
  }

  const unreadCb = document.getElementById('catUnreadOnly');
  if (unreadCb) {
    unreadCb.addEventListener('change', () => {
      state.catalogFilter.unreadOnly = unreadCb.checked;
      state.catalogOffset = 0;
      renderCatalog();
    });
  }

  const resetBtn = document.getElementById('catReset');
  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      if (!confirm('既読の記録をすべて消しますか？（この端末のみに保存されています）')) return;
      clearReadSet();
      renderCatalog();
    });
  }

  document.getElementById('loadMore').addEventListener('click', () => {
    state.catalogOffset += 30;
    renderCatalog();
  });

  renderCatalog();
}

function getFilteredArticles() {
  const { search, rarity, category, sort, unreadOnly } = state.catalogFilter;
  const catSel = document.getElementById('catCategory');
  const field = catSel?.dataset?.field || 'category';

  const filtered = state.data.articles.filter(a => {
    if (rarity && a.rarity !== rarity) return false;
    if (search && !a.title.toLowerCase().includes(search)) return false;
    if (category && (a[field] || '') !== category) return false;
    if (unreadOnly && isRead(a)) return false;
    return true;
  });

  if (sort === 'newest' || sort === 'oldest') {
    const dir = sort === 'newest' ? -1 : 1;
    filtered.sort((a, b) => {
      const ax = a.published_at || '';
      const bx = b.published_at || '';
      if (!ax && !bx) return 0;
      if (!ax) return 1;   // 日付不明は末尾
      if (!bx) return -1;
      return ax < bx ? -1 * dir : ax > bx ? 1 * dir : 0;
    });
  } else if (sort === 'random') {
    filtered.sort(() => Math.random() - 0.5);
  } else {
    const order = { SSR: 0, SR: 1, R: 2, N: 3 };
    filtered.sort((a, b) => (order[a.rarity] ?? 4) - (order[b.rarity] ?? 4));
  }
  return filtered;
}

function renderCatalog() {
  const filtered = getFilteredArticles();
  const end = state.catalogOffset + 30;
  const visible = filtered.slice(0, end);
  const el = document.getElementById('catalogList');
  const total = state.data.articles.length;
  const readCount = loadReadSet().size;

  // 件数表示
  const stat = document.getElementById('catalogStat');
  if (stat) {
    stat.textContent = `${filtered.length} / ${total} 件 ／ 既読 ${readCount} 件`;
  }

  if (!visible.length) {
    el.innerHTML = '<p class="empty" style="grid-column:1/-1">該当する献立はございません。</p>';
  } else {
    el.innerHTML = visible.map(a => {
      const read = isRead(a);
      const dateLabel = a.published_at ? a.published_at.slice(0, 10) : '';
      return `
      <a href="${escAttr(a.url || state.data.creator.note_url)}" target="_blank" rel="noopener" class="cat-item ${read ? 'is-read' : ''}" data-rarity="${a.rarity}" data-id="${a.id}">
        <span class="cat-r ${a.rarity}">${RARITY_KANJI[a.rarity] || '並'}</span>
        <div class="cat-title">${escHtml(a.title)}</div>
        ${dateLabel ? `<div class="cat-date">${escHtml(dateLabel)}</div>` : ''}
        ${a.is_membership ? '<div class="cat-member">◈ 会員席限定</div>' : ''}
        ${read ? '<div class="cat-read">読了</div>' : ''}
      </a>`;
    }).join('');

    // クリックで既読化
    el.querySelectorAll('.cat-item').forEach(node => {
      node.addEventListener('click', () => {
        const id = parseInt(node.dataset.id, 10);
        const article = state.data.articles.find(x => x.id === id);
        if (!article) return;
        markRead(article);
        node.classList.add('is-read');
        if (!node.querySelector('.cat-read')) {
          const tag = document.createElement('div');
          tag.className = 'cat-read';
          tag.textContent = '読了';
          node.appendChild(tag);
        }
        // 件数表示の更新（未読フィルタ中は再描画）
        if (state.catalogFilter.unreadOnly) {
          setTimeout(renderCatalog, 50);
        } else if (stat) {
          stat.textContent = `${filtered.length} / ${total} 件 ／ 既読 ${loadReadSet().size} 件`;
        }
      });
    });
  }

  document.getElementById('loadMore').style.display = filtered.length > end ? '' : 'none';
}

// ===== Utility =====
function loadState() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
  catch { return {}; }
}
function saveState(obj) {
  const cur = loadState();
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...cur, ...obj }));
}
function escHtml(s) {
  if (!s) return '';
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function escAttr(s) { return escHtml(s); }
function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2800);
}

init();
