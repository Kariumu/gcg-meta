#!/usr/bin/env node
/**
 * generate_preview_sets.js
 * 発売前プレビューカードのセット別一覧ページ (sets/*.html) を生成する
 *
 * Input : data/cards_preview.json（読み取り専用。毎日のニュース記事生成で蓄積）
 * Output: sets/index.html + セットごとの sets/{set小文字}.html
 *
 * 仕様（cowork-instr-preview-sets-and-series-2026-06-10.md）:
 * - 対象セットはハードコードせず、カード番号プレフィックスを動的に検出
 * - 並び順: カード番号（型番）昇順のみ
 *   （2026-06-10 v3指示: レアリティ認識精度が不十分なためレアリティソートを廃止。バッジ表示は維持）
 * - ステータス（Lv/コスト/AP/HP）はラベル付き専用枠で表示。COMMAND は Lv/コストのみ。
 *   0 は「0」と表示し、null のみ「確認中」（falsy判定で0を欠落させない）
 * - 画像クリックでページ遷移なしのライトボックス拡大（素のJS+CSS。JS無効時は画像表示のみで無害）
 * - null フィールドは「確認中」表示（推測で補完しない）
 * - _pendingReview: true は「データ確認中」バッジ
 * - pilot サブ構造を持つカードはパイロット側情報も表示
 * - 各カードに source_url（公式Xポスト）への出典リンクを記載
 * - 各カードにローカル保存済み画像（images/news/{日付}/{番号}.jpg 等）を表示
 *   （2026-06-10 指示書 cowork-instr-g005-merge-images で初版の <img> 禁止を撤回）
 * - source_url に 'test-e2e-dummy' を含む E2E テスト用ダミーは除外（2026-06-10 松岡さん承認）
 */

const fs = require('fs');
const path = require('path');

// ROOT は auto-news.js と同じく NEWS_OUTPUT_ROOT で切替可能(2026-06-11 指示書v4 Task2)。
// 通常運用は未設定(= __dirname)で従来どおり。隔離検証時のみ別ディレクトリを指定し、
// 本番の data/ 読み取り・sets/ 書き込みを汚さない。
const ROOT = process.env.NEWS_OUTPUT_ROOT || __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const OUT_DIR = path.join(ROOT, 'sets');
const SITE_URL = 'https://gcg-stats.com';

// === データ読み込み ===
let cardsPreview = {};
try {
  // 末尾の NUL/BOM は OneDrive sparse mount 環境で混入することがあるため除去してからパースする
  const raw = fs.readFileSync(path.join(DATA_DIR, 'cards_preview.json'), 'utf-8')
    .replace(/^\uFEFF/, '')
    .replace(/[\u0000\s]+$/, '');
  cardsPreview = JSON.parse(raw);
  console.log(`  cards_preview.json: ${Object.keys(cardsPreview).length} 件読み込み`);
} catch (e) {
  console.error('  ✖ data/cards_preview.json が読み込めません: ' + e.message);
  process.exit(1);
}

// === 定数 ===
const COLOR_JP = {
  'Blue': '青', 'Green': '緑', 'Red': '赤',
  'White': '白', 'Purple': '紫', 'Colorless': '無色'
};
const COLOR_HEX = {
  'Blue': '#4488ff', 'Green': '#44cc64', 'Red': '#ff4444',
  'White': '#cccccc', 'Purple': '#b444ff', 'Colorless': '#888888'
};
const TYPE_JP = {
  'UNIT': 'ユニット', 'PILOT': 'パイロット',
  'COMMAND': 'コマンド', 'BASE': 'ベース'
};

// レアリティの有効値（バッジ表示用。SR は存在しない＝GCG 公式は LR/R/U/C の4種）
// 2026-06-10 v3指示: レアリティ「ソート」は廃止（認識精度不十分のため）。バッジ表示のみ維持。
const VALID_RARITIES = ['LR', 'R', 'U', 'C'];

// セットの表示順ヒント（判明している新弾のみ。未知のプレフィックスは末尾に英数順）
// 注: 'G005' は GD05 の OCR 誤読でありセットとして存在しない（2026-06-10 統合済み）
const SET_ORDER_HINT = ['ST10', 'EB01', 'GD05'];

// セットの公式呼称・発売日は data/sets_meta.json を「正」とし、既存表はフォールバックとして残す
// （指示書52 Task1: 二重管理を避けるため sets_meta を優先。sets_meta 未登録のセットは従来表を使用）
const SET_LABELS_FALLBACK = {
  'ST10': 'スタートデッキ Generation Pulse',
  'EB01': 'Eternal Nexus',
  'GD05': '第5弾ブースターパック',
};
const SET_RELEASE_FALLBACK = {
  'ST10': '2026-06-27',
  'EB01': '2026-06-27',
  'GD05': '2026-07-25',
};

// data/sets_meta.json を読み込み（新設・任意。無ければフォールバックのみで従来動作）
let setsMeta = [];
try {
  const rawMeta = fs.readFileSync(path.join(DATA_DIR, 'sets_meta.json'), 'utf-8')
    .replace(/^\uFEFF/, '')
    .replace(/[\u0000\s]+$/, '');
  setsMeta = JSON.parse(rawMeta);
  if (!Array.isArray(setsMeta)) setsMeta = [];
  console.log(`  sets_meta.json: ${setsMeta.length} 件読み込み`);
} catch (e) {
  console.warn('  ⚠ data/sets_meta.json が読めません（フォールバック表を使用）: ' + e.message);
  setsMeta = [];
}
const SET_META_BY_CODE = {};
for (const m of setsMeta) { if (m && m.code) SET_META_BY_CODE[m.code] = m; }

// 実効の呼称・発売日: フォールバックを基に sets_meta（正）で上書き
const SET_LABELS_PREVIEW = Object.assign({}, SET_LABELS_FALLBACK);
const SET_RELEASE_DATES = Object.assign({}, SET_RELEASE_FALLBACK);
for (const m of setsMeta) {
  if (!m || !m.code) continue;
  if (m.name_jp) SET_LABELS_PREVIEW[m.code] = m.name_jp;
  if (m.release_date) SET_RELEASE_DATES[m.code] = m.release_date;
}

// === カード画像インデックス（2026-06-10 追加、松岡さん指示）===
// images/news/ 配下の全日付フォルダを走査し {card_number}.(jpg|jpeg|png|webp) を検索する。
// _articleDate の決め打ちはしない（記事日付と画像フォルダ日付が一致しないケースがあるため）。
// 同名が複数日付にある場合は新しい日付を優先（昇順走査の後勝ち）。
// 画像は既存ローカルファイルへのサイトルート相対参照のみ（加工・別フォルダ複製はしない）。
const IMAGES_NEWS_DIR = path.join(ROOT, 'images', 'news');
const cardImageMap = {}; // card_number（大文字） -> サイトルート相対URL
try {
  const dateDirs = fs.readdirSync(IMAGES_NEWS_DIR).filter((d) => {
    try { return fs.statSync(path.join(IMAGES_NEWS_DIR, d)).isDirectory(); } catch (e) { return false; }
  }).sort();
  for (const dir of dateDirs) {
    for (const f of fs.readdirSync(path.join(IMAGES_NEWS_DIR, dir))) {
      const m = f.match(/^([A-Za-z0-9]+-[A-Za-z0-9]+)\.(jpe?g|png|webp)$/i);
      if (m) cardImageMap[m[1].toUpperCase()] = '/images/news/' + dir + '/' + f;
    }
  }
  console.log('  カード画像インデックス: ' + Object.keys(cardImageMap).length + ' 件');
} catch (e) {
  console.warn('  ⚠ images/news の走査に失敗（画像なしで生成継続）: ' + e.message);
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// null → 「確認中」(推測補完しない) / 空文字・空配列 → 「ー」
const PENDING_HTML = '<span class="val-pending">確認中</span>';
function fmtValue(v) {
  if (v === null || v === undefined) return PENDING_HTML;
  if (Array.isArray(v)) return v.length === 0 ? 'ー' : escapeHtml(v.join(' '));
  if (String(v).trim() === '') return 'ー';
  return escapeHtml(v);
}
function fmtEffect(v) {
  if (v === null || v === undefined) return PENDING_HTML;
  if (String(v).trim() === '') return 'ー';
  return escapeHtml(v).replace(/\n/g, '<br>');
}

function getSetPrefix(cardNumber) {
  return String(cardNumber).split('-')[0];
}

// === セット別に振り分け（テストダミー除外）===
const excluded = [];
const setMap = {}; // prefix -> [card,...]
for (const [key, card] of Object.entries(cardsPreview)) {
  if (card.source_url && String(card.source_url).includes('test-e2e-dummy')) {
    excluded.push(key);
    continue;
  }
  const prefix = getSetPrefix(key);
  if (!setMap[prefix]) setMap[prefix] = [];
  setMap[prefix].push({ key, ...card });
}

// セットの表示順: SET_ORDER_HINT 優先、未知のプレフィックスは末尾に英数順
const setNames = Object.keys(setMap).sort((a, b) => {
  const ia = SET_ORDER_HINT.indexOf(a);
  const ib = SET_ORDER_HINT.indexOf(b);
  if (ia >= 0 && ib >= 0) return ia - ib;
  if (ia >= 0) return -1;
  if (ib >= 0) return 1;
  return a.localeCompare(b);
});

// 各セット内の並び: カード番号（型番）昇順のみ（2026-06-10 v3指示）
for (const s of setNames) {
  setMap[s].sort((a, b) => a.key.localeCompare(b.key));
}

const today = new Date().toISOString().split('T')[0];

// === 共通HTMLパーツ ===
function pageHead({ title, description, canonical, ogImage }) {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <!-- Google Analytics -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-3MY17P4E7F"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', 'G-3MY17P4E7F');
  </script>
  <!-- Google AdSense -->
  <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-6912628791259344"
       crossorigin="anonymous"></script>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${canonical}">${ogImage ? `
  <meta property="og:image" content="${SITE_URL}/images/ogp-default.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(title)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${SITE_URL}/images/ogp-default.png">` : ''}
  <link rel="canonical" href="${canonical}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/style.css">
  <style>
    .preview-notice {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-left: 3px solid var(--accent);
      border-radius: var(--radius-lg);
      padding: 14px 18px;
      margin-bottom: 24px;
      font-size: 13px;
      color: var(--text-secondary);
      line-height: 1.7;
    }
    .preview-notice strong { color: var(--text-primary); }
    .val-pending {
      color: var(--text-muted);
      font-size: 12px;
      border: 1px dashed var(--border);
      border-radius: 4px;
      padding: 0 6px;
    }
    .pcard {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 16px 18px;
      margin-bottom: 14px;
    }
    .pcard-head {
      display: flex;
      align-items: baseline;
      gap: 10px;
      flex-wrap: wrap;
      margin-bottom: 10px;
    }
    .pcard-number {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text-muted);
    }
    .pcard-name {
      font-size: 15px;
      font-weight: 700;
      color: var(--text-primary);
      margin: 0;
    }
    .pcard-rarity {
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 700;
      padding: 1px 8px;
      border-radius: 4px;
      background: rgba(0,0,0,0.4);
    }
    .rarity-LR { color: #ffd700; border: 1px solid rgba(255,215,0,0.4); }
    .rarity-R  { color: #ff8844; border: 1px solid rgba(255,136,68,0.4); }
    .rarity-U  { color: #88bbff; border: 1px solid rgba(136,187,255,0.4); }
    .rarity-C  { color: #aabbcc; border: 1px solid rgba(170,187,204,0.3); }
    .rarity-unknown { color: var(--text-muted); border: 1px dashed var(--border); }
    .pcard-pending-badge {
      font-size: 11px;
      font-weight: 600;
      color: #ffcc44;
      border: 1px solid rgba(255,204,68,0.45);
      border-radius: 4px;
      padding: 1px 8px;
      background: rgba(255,204,68,0.08);
    }
    .pcard-media { margin-bottom: 10px; }
    .pcard-media img {
      max-width: 100%;
      width: 420px;
      height: auto;
      display: block;
      border-radius: var(--radius);
      border: 1px solid var(--border);
    }
    .pcard-tags {
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
      margin-bottom: 10px;
    }
    .pcard-tag {
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 600;
      padding: 2px 8px;
      border-radius: 4px;
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      color: var(--text-secondary);
    }
    .pcard-tag-color { border: 1px solid; background: transparent; }
    /* ステータス専用枠（2026-06-10 v3: Lv/コスト/AP/HP を大きく見やすく） */
    .pcard-stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(76px, 1fr));
      gap: 8px;
      margin-bottom: 12px;
      max-width: 420px;
    }
    .pcard-stat {
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 8px 6px;
      text-align: center;
    }
    .pcard-stat-label {
      display: block;
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 1.5px;
      margin-bottom: 4px;
    }
    .pcard-stat-value {
      display: block;
      font-family: var(--font-mono);
      font-size: 20px;
      font-weight: 700;
      color: var(--text-primary);
      line-height: 1.2;
    }
    .pcard-stat-value .val-pending { font-size: 11px; font-weight: 400; }
    .pcard-field-label {
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 1px;
      display: block;
      margin-bottom: 2px;
    }
    /* パイロット修正値（ユニットへの修正値のため + 表記） */
    .pcard-pilot-mods {
      font-family: var(--font-mono);
      font-size: 15px;
      font-weight: 700;
      color: var(--text-primary);
      margin-top: 6px;
    }
    /* 画像ライトボックス（素のJS+CSS。JS無効時は .pcard-media img の表示のみで無害） */
    .pcard-media img { cursor: zoom-in; }
    .lightbox {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.88);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      cursor: zoom-out;
      padding: 24px;
    }
    .lightbox.open { display: flex; }
    .lightbox img {
      max-width: min(96vw, 1200px);
      max-height: 92vh;
      border-radius: 8px;
      box-shadow: 0 8px 40px rgba(0,0,0,0.6);
    }
    .pcard-row { margin-bottom: 8px; font-size: 13px; color: var(--text-primary); line-height: 1.7; }
    .pcard-row .pcard-field-label { margin-bottom: 3px; }
    .pcard-effect {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 10px 12px;
    }
    .pcard-pilot {
      border: 1px solid var(--border);
      border-left: 3px solid #88bbff;
      border-radius: var(--radius);
      padding: 10px 12px;
      margin-bottom: 8px;
      background: var(--bg-secondary);
    }
    .pcard-pilot-title {
      font-family: var(--font-mono);
      font-size: 11px;
      color: #88bbff;
      font-weight: 700;
      margin-bottom: 6px;
      letter-spacing: 1px;
    }
    .pcard-source {
      margin-top: 10px;
      padding-top: 10px;
      border-top: 1px solid var(--border);
      font-size: 12px;
    }
    .pcard-source a { color: var(--accent); text-decoration: none; }
    .pcard-source a:hover { text-decoration: underline; }
    .set-index-list { list-style: none; padding: 0; }
    .set-index-item {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      margin-bottom: 12px;
      transition: border-color 0.15s;
    }
    .set-index-item:hover { border-color: var(--border-hover); }
    .set-index-item a {
      display: flex;
      align-items: baseline;
      gap: 12px;
      flex-wrap: wrap;
      padding: 16px 18px;
      text-decoration: none;
      color: inherit;
    }
    .set-index-code { font-family: var(--font-mono); font-size: 16px; font-weight: 700; color: var(--accent); }
    .set-index-label { font-size: 13px; color: var(--text-primary); }
    .set-index-meta { font-family: var(--font-mono); font-size: 12px; color: var(--text-muted); margin-left: auto; }
    .breadcrumb-simple { font-size: 12px; color: var(--text-muted); margin-bottom: 16px; }
    .breadcrumb-simple a { color: var(--accent); text-decoration: none; }
  </style>
</head>
<body>
  <div id="header"></div>

  <main class="container">
`;
}

function pageFoot() {
  return `  </main>

  <div id="footer"></div>

  <!-- 画像ライトボックス（外部ライブラリなし。JS無効時は表示されず無害） -->
  <div class="lightbox" id="lightbox" role="dialog" aria-label="拡大画像"><img id="lightbox-img" src="" alt=""></div>
  <script>
    (function () {
      var lb = document.getElementById('lightbox');
      var lbImg = document.getElementById('lightbox-img');
      if (!lb || !lbImg) return;
      function close() { lb.classList.remove('open'); lbImg.src = ''; lbImg.alt = ''; }
      Array.prototype.forEach.call(document.querySelectorAll('.pcard-media img'), function (img) {
        img.addEventListener('click', function () {
          lbImg.src = img.src;
          lbImg.alt = img.alt;
          lb.classList.add('open');
        });
      });
      lb.addEventListener('click', close);
      document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    })();
  </script>

  <script src="/js/common.js"></script>
  <script>
    GCG.init();
    document.getElementById('header').innerHTML = GCG.renderHeader('sets');
    document.getElementById('footer').innerHTML = GCG.renderFooter();
  </script>
</body>
</html>
`;
}

function noticeBlock(count, scopeText) {
  return `    <div class="preview-notice">
      <strong>発売前の判明カード一覧（毎日自動更新）</strong><br>
      公式X（@GUNDAM_GCG_JP）の発表に基づく非公式まとめです。${scopeText}現在 <strong>${count} 枚</strong>のカード情報を掲載しています。
      正式なカード情報は公式発表をご確認ください。「確認中」の項目は未判明のため推測掲載を行っていません。
    </div>
`;
}

// === カード1枚分のHTML ===
function cardBlock(card) {
  const colorHex = COLOR_HEX[card.color] || '#888';
  const colorJp = card.color === null || card.color === undefined ? null : (COLOR_JP[card.color] || card.color);
  const typeJp = card.card_type === null || card.card_type === undefined ? null : (TYPE_JP[card.card_type] || card.card_type);
  const rarityCls = VALID_RARITIES.includes(card.rarity) ? `rarity-${card.rarity}` : 'rarity-unknown';
  const rarityText = card.rarity === null || card.rarity === undefined ? '確認中' : escapeHtml(card.rarity);

  let html = '    <article class="pcard" id="' + escapeHtml(card.key) + '">\n';
  // ヘッダ行: 番号 / 名前 / レアリティ / データ確認中バッジ
  html += '      <div class="pcard-head">\n';
  html += `        <span class="pcard-number">${escapeHtml(card.key)}</span>\n`;
  html += `        <h3 class="pcard-name">${card.card_name === null || card.card_name === undefined ? PENDING_HTML : escapeHtml(card.card_name)}</h3>\n`;
  html += `        <span class="pcard-rarity ${rarityCls}">${rarityText}</span>\n`;
  if (card._pendingReview === true) {
    html += '        <span class="pcard-pending-badge">データ確認中</span>\n';
  }
  html += '      </div>\n';

  // カード画像（2026-06-10 追加。見つからないカードはテキストのみレイアウトにフォールバック）
  const imgUrl = cardImageMap[String(card.key).toUpperCase()];
  if (imgUrl) {
    const altText = card.card_name === null || card.card_name === undefined ? card.key : card.card_name;
    html += `      <div class="pcard-media"><img src="${escapeHtml(imgUrl)}" alt="${escapeHtml(altText)}" loading="lazy"></div>\n`;
  }

  // 色・タイプ
  html += '      <div class="pcard-tags">\n';
  if (colorJp === null) {
    html += `        <span class="pcard-tag">色: ${PENDING_HTML}</span>\n`;
  } else {
    html += `        <span class="pcard-tag pcard-tag-color" style="color:${colorHex};border-color:${colorHex}">${escapeHtml(colorJp)}</span>\n`;
  }
  html += `        <span class="pcard-tag">${typeJp === null ? PENDING_HTML : escapeHtml(typeJp)}</span>\n`;
  html += '      </div>\n';

  // ステータス専用枠（2026-06-10 v3指示）
  // 0 は「0」と表示する（fmtValue は null/undefined のみ「確認中」を返し、0 はそのまま通す。
  // `if (!value)` のような falsy 判定は 0 を欠落させるため使用しない）
  // COMMAND は Lv/コストのみ（AP/HP 枠は出さない）。UNIT/BASE/PILOT 等は4項目。
  const statItems = [
    ['Lv', card.level],
    ['COST', card.cost],
  ];
  if (card.card_type !== 'COMMAND') {
    statItems.push(['AP', card.ap], ['HP', card.hp]);
  }
  html += '      <div class="pcard-stats">\n';
  for (const [label, value] of statItems) {
    html += `        <div class="pcard-stat"><span class="pcard-stat-label">${label}</span><span class="pcard-stat-value">${fmtValue(value)}</span></div>\n`;
  }
  html += '      </div>\n';

  // 特徴 / リンク
  html += `      <div class="pcard-row"><span class="pcard-field-label">特徴</span>${fmtValue(card.traits)}</div>\n`;
  html += `      <div class="pcard-row"><span class="pcard-field-label">リンク</span>${fmtValue(card.link)}</div>\n`;

  // パイロットサブ構造（パイロット要素を持つコマンド等）
  // 修正値は「AP +1 / HP +0」形式（パイロット側の数値はユニットへの修正値のため + 表記）。
  // 0 は「+0」と表示する（null のみ「確認中」。falsy 判定で 0 を欠落させない）
  if (card.pilot && typeof card.pilot === 'object') {
    const fmtMod = (v) => (v === null || v === undefined) ? PENDING_HTML : '+' + escapeHtml(v);
    html += '      <div class="pcard-pilot">\n';
    html += '        <div class="pcard-pilot-title">PILOT（付属パイロット情報）</div>\n';
    html += `        <div class="pcard-row"><span class="pcard-field-label">名前</span>${fmtValue(card.pilot.name)}</div>\n`;
    html += `        <div class="pcard-row"><span class="pcard-field-label">特徴</span>${fmtValue(card.pilot.traits)}</div>\n`;
    html += `        <div class="pcard-pilot-mods">AP ${fmtMod(card.pilot.ap)} / HP ${fmtMod(card.pilot.hp)}</div>\n`;
    html += '      </div>\n';
  }

  // 効果
  html += `      <div class="pcard-row"><span class="pcard-field-label">効果</span><div class="pcard-effect">${fmtEffect(card.effect)}</div></div>\n`;

  // 出典（公式Xポストへのリンクのみ。画像の転載・ホットリンクはしない）
  if (card.source_url) {
    html += `      <div class="pcard-source">出典: <a href="${escapeHtml(card.source_url)}" target="_blank" rel="noopener">公式Xポスト</a></div>\n`;
  }
  html += '    </article>\n';
  return html;
}

// === セットページ生成 ===
function generateSetPage(setName, cards) {
  const label = SET_LABELS_PREVIEW[setName];
  const release = SET_RELEASE_DATES[setName];
  const titleSet = label ? `${setName}「${label}」` : setName;
  const title = `${titleSet} 発売前判明カード一覧 | GCG STATS`;
  const description = `ガンダムカードゲーム ${titleSet} の発売前判明カード${cards.length}枚の一覧。公式X発表に基づく非公式まとめ（毎日自動更新）。カード番号（型番）順に掲載。`;
  const fileName = `${setName.toLowerCase()}.html`;
  const canonical = `${SITE_URL}/sets/${fileName}`;

  let html = pageHead({ title, description, canonical });
  html += '    <div class="breadcrumb-simple"><a href="/sets/">新弾情報</a> › ' + escapeHtml(setName) + '</div>\n';
  html += '    <div class="section-header">\n';
  html += `      <h1 class="section-title">${escapeHtml(titleSet)} 判明カード</h1>\n`;
  html += `      <span class="section-badge">${cards.length} CARDS</span>\n`;
  html += '    </div>\n';
  // 指示書v8 B-3: 正式カードリスト公開済みセットへの案内(発売日までプレビューは従来どおり維持)
  const OFFICIAL_LIST_SETS = ['ST10', 'EB01']; // 公式カードリスト公開済み(2026-06-13)
  if (OFFICIAL_LIST_SETS.includes(setName)) {
    html += '    <div style="margin:12px 0 16px;padding:12px 16px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);font-size:13px">\n';
    html += `      公式カードリストが公開されました。<a href="../cards.html?set=${setName}">カードリスト(${escapeHtml(setName)} 全カード)</a>もご覧いただけます。本ページは発売日(${release || '未定'})までプレビューとして従来どおり更新されます。\n`;
    html += '    </div>\n';
  }
  const scope = release ? `発売日: ${release}。` : '';
  html += noticeBlock(cards.length, scope);
  for (const card of cards) {
    html += cardBlock(card);
  }
  html += `    <p style="font-size:12px;color:var(--text-muted);margin-top:20px">最終更新: ${today}</p>\n`;
  html += pageFoot();

  fs.writeFileSync(path.join(OUT_DIR, fileName), html, 'utf-8');
  return fileName;
}

// === インデックスページ生成 ===
// 掲載0件のときは「0 CARDS」バッジ・空グリッドを出さず、公開期間外である旨と
// 誘導リンクを表示する（2026-07-16 指示書41 Part A 松岡さん指示）
// === 指示書52 Task2: 新弾ハブ用の追加データ・ヘルパー（追加入力はすべて任意。無くても従来動作を壊さない）===
function loadJsonSafe(fileName, fallback) {
  try {
    const raw = fs.readFileSync(path.join(DATA_DIR, fileName), 'utf-8')
      .replace(/^\uFEFF/, '').replace(/[\u0000\s]+$/, '');
    return JSON.parse(raw);
  } catch (e) { return fallback; }
}
const hubArticlesRaw = loadJsonSafe('articles.json', []);
const hubArticles = Array.isArray(hubArticlesRaw) ? hubArticlesRaw : (hubArticlesRaw.articles || []);
const hubSummary = loadJsonSafe('summary.json', {});
const hubCardsMasterRaw = loadJsonSafe('cards_master.json', {});
const hubCardsArr = Array.isArray(hubCardsMasterRaw) ? hubCardsMasterRaw : Object.values(hubCardsMasterRaw);

// 生成時のJST日付（バッチは20:00 JST）。release_date 比較にのみ使用し、ページには一切出力しない
// （＝日次で差分を生まない。指示書52 Task2-α「定常時は差分ゼロ」を成立させるため「最終更新: 今日」も撤去）
const TODAY_JST = new Date(Date.now() + 9 * 3600 * 1000).toISOString().split('T')[0];

function cardIdOf(c) { return (c && (c.card_id || c.card_number || c.number || c.id)) || ''; }
function setPrefixOf(id) { return String(id).split('-')[0]; }
const hubCardNameById = {};
for (const c of hubCardsArr) { const id = cardIdOf(c); if (id) hubCardNameById[id] = c.card_name || c.name || id; }

// cards_master を code 接頭辞で集計（基本＝is_parallel!==true、パラレル＝is_parallel===true。パラレルはpackage_set=PROMOだが接頭辞で数える）
function countSetCards(code) {
  let base = 0, parallel = 0;
  for (const c of hubCardsArr) {
    if (setPrefixOf(cardIdOf(c)) !== code) continue;
    if (c.is_parallel === true) parallel++; else base++;
  }
  return { base, parallel };
}
// 関連記事: pinned 先頭 → title に code または name_jp を含む記事を新しい順・重複除外・上限8
function collectRelatedArticles(code, nameJp, pinned) {
  const byPath = {};
  for (const a of hubArticles) if (a && a.path) byPath[a.path] = a;
  const result = [], seen = new Set();
  for (const p of (pinned || [])) {
    if (seen.has(p)) continue;
    seen.add(p);
    result.push(byPath[p] || { path: p, title: p, date: '' });
    if (result.length >= 8) return result;
  }
  const matched = hubArticles.filter((a) => a && a.title && a.path && !seen.has(a.path) &&
    (String(a.title).includes(code) || (nameJp && String(a.title).includes(nameJp))))
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  for (const a of matched) { seen.add(a.path); result.push(a); if (result.length >= 8) break; }
  return result;
}
// 初動採用率: summary.card_ranking に code 接頭辞・decks>0 があれば TOP10、無ければ null（プレースホルダ表示）
function collectAdoption(code) {
  const cr = (hubSummary && hubSummary.card_ranking) || [];
  const rows = cr.filter((r) => r && setPrefixOf(r.card_id || '') === code && (r.decks || 0) > 0);
  if (!rows.length) return null;
  return rows.slice().sort((a, b) => (b.decks || 0) - (a.decks || 0)).slice(0, 10);
}
function releasedSetsMeta() {
  return setsMeta.filter((m) => m && m.code && m.release_date && m.release_date <= TODAY_JST)
    .sort((a, b) => String(b.release_date).localeCompare(String(a.release_date)));
}
function upcomingSetsMeta() {
  return setsMeta.filter((m) => m && m.code && m.release_date && m.release_date > TODAY_JST)
    .sort((a, b) => String(a.release_date).localeCompare(String(b.release_date)));
}
function fmtJpDate(iso) {
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${+m[1]}年${+m[2]}月${+m[3]}日` : String(iso);
}
function setDisplayName(meta) { return meta.name_jp || SET_LABELS_PREVIEW[meta.code] || meta.code; }

// --- ハブ セクション部品（新CSSクラスは足さずインラインstyleで完結＝プレビューページ側は無改変）---
function hubRelatedArticlesHtml(meta) {
  const arts = collectRelatedArticles(meta.code, meta.name_jp, meta.pinned_articles);
  if (!arts.length) return '';
  let h = '      <h3 style="font-size:15px;font-weight:700;margin:20px 0 8px;color:var(--text-primary)">関連記事</h3>\n';
  h += '      <ul style="list-style:none;padding:0;margin:0">\n';
  for (const a of arts) {
    const href = '/' + String(a.path).replace(/^\//, '');
    h += `        <li style="padding:7px 0;border-bottom:1px solid var(--border);font-size:14px"><a href="${href}" style="color:var(--accent);text-decoration:none">${escapeHtml(a.title || a.path)}</a>` +
         (a.date ? ` <span style="color:var(--text-muted);font-size:12px;font-family:var(--font-mono)">${escapeHtml(a.date)}</span>` : '') + '</li>\n';
  }
  h += '      </ul>\n';
  return h;
}
function hubAdoptionHtml(meta) {
  const rows = collectAdoption(meta.code);
  let h = '      <h3 style="font-size:15px;font-weight:700;margin:20px 0 8px;color:var(--text-primary)">初動採用率</h3>\n';
  if (!rows) {
    h += '      <div class="preview-notice">発売後の大会データが集まり次第、初動採用率をここに掲載します（次シーズン開幕後に自動更新）。</div>\n';
    return h;
  }
  h += '      <table style="width:100%;border-collapse:collapse;font-size:13px"><thead><tr>' +
       '<th style="text-align:left;padding:6px 8px;border-bottom:1px solid var(--border);color:var(--text-muted)">カード</th>' +
       '<th style="text-align:right;padding:6px 8px;border-bottom:1px solid var(--border);color:var(--text-muted)">採用デッキ数</th></tr></thead><tbody>\n';
  for (const r of rows) {
    const id = r.card_id;
    const name = hubCardNameById[id] || id;
    h += `        <tr><td style="padding:6px 8px;border-bottom:1px solid var(--border)"><a href="/cards/${escapeHtml(id)}/" style="color:var(--accent);text-decoration:none">${escapeHtml(name)}</a> <span style="color:var(--text-muted);font-size:11px;font-family:var(--font-mono)">${escapeHtml(id)}</span></td>` +
         `<td style="padding:6px 8px;border-bottom:1px solid var(--border);text-align:right;font-variant-numeric:tabular-nums">${r.decks}</td></tr>\n`;
  }
  h += '      </tbody></table>\n';
  return h;
}
// 最新弾まとめ（asUpcoming=true のときは「発売済み0件」の境界仕様＝次弾の詳細版として見出しを変える）
function hubSetSummaryBlock(meta, asUpcoming) {
  const name = setDisplayName(meta);
  const cnt = countSetCards(meta.code);
  let h = '    <section style="margin:28px 0 8px">\n';
  if (asUpcoming) {
    h += `      <h2 class="section-title" style="margin-bottom:4px">もうすぐ発売：${escapeHtml(meta.code)} ${escapeHtml(name)}</h2>\n`;
    h += `      <p style="color:var(--text-secondary);font-size:14px;margin:4px 0 12px">${fmtJpDate(meta.release_date)}発売予定。</p>\n`;
  } else {
    h += `      <h2 class="section-title" style="margin-bottom:4px">最新弾：${escapeHtml(meta.code)} ${escapeHtml(name)}</h2>\n`;
    h += `      <p style="color:var(--text-secondary);font-size:14px;margin:4px 0 12px">${fmtJpDate(meta.release_date)}発売。</p>\n`;
  }
  if (cnt.base > 0) {
    const par = cnt.parallel > 0 ? `＋関連パラレル${cnt.parallel}種` : '';
    h += `      <p style="font-size:14px;margin:0 0 12px">収録カード：<strong>基本${cnt.base}種</strong>${par}</p>\n`;
    h += `      <p style="margin:0 0 4px"><a href="/cards.html?set=${escapeHtml(meta.code)}" style="display:inline-block;padding:9px 18px;background:var(--accent);color:#fff;border-radius:var(--radius);text-decoration:none;font-size:14px;font-weight:600">収録カードを一覧で見る（基本${cnt.base}種）</a></p>\n`;
  }
  h += hubRelatedArticlesHtml(meta);
  h += hubAdoptionHtml(meta);
  h += '    </section>\n';
  return h;
}
function hubUpcomingHtml(upcoming) {
  if (!upcoming.length) {
    return '    <section style="margin:28px 0 8px">\n' +
      '      <h2 class="section-title">もうすぐ発売</h2>\n' +
      '      <div class="preview-notice">新カードが公式X（@GUNDAM_GCG_JP）で公開されると、このページに随時掲載されます。</div>\n' +
      '    </section>\n';
  }
  let h = '    <section style="margin:28px 0 8px">\n      <h2 class="section-title">もうすぐ発売</h2>\n      <ul style="list-style:none;padding:0;margin:8px 0 0">\n';
  for (const m of upcoming) {
    h += `        <li style="padding:7px 0;border-bottom:1px solid var(--border);font-size:14px">${escapeHtml(m.code)} ${escapeHtml(setDisplayName(m))} — ${fmtJpDate(m.release_date)}発売予定</li>\n`;
  }
  h += '      </ul>\n    </section>\n';
  return h;
}
// プレビュー枠（従来の set-index-list。有効件数>0のときのみ表示）
function hubPreviewSectionHtml(totalShown) {
  if (totalShown <= 0) return '';
  let h = '    <section style="margin:28px 0 8px">\n';
  h += '      <div class="section-header">\n';
  h += '        <h2 class="section-title">発売前プレビュー</h2>\n';
  h += `        <span class="section-badge">${totalShown} CARDS</span>\n`;
  h += '      </div>\n';
  h += noticeBlock(totalShown, '');
  h += '      <ul class="set-index-list">\n';
  for (const s of setNames) {
    const label = SET_LABELS_PREVIEW[s];
    const release = SET_RELEASE_DATES[s];
    h += '        <li class="set-index-item">\n';
    h += `          <a href="/sets/${s.toLowerCase()}.html">\n`;
    h += `            <span class="set-index-code">${escapeHtml(s)}</span>\n`;
    if (label) h += `            <span class="set-index-label">${escapeHtml(label)}</span>\n`;
    if (release) h += `            <span class="set-index-label" style="color:var(--text-muted)">発売日 ${release}</span>\n`;
    h += `            <span class="set-index-meta">${setMap[s].length} 枚判明</span>\n`;
    h += '          </a>\n';
    h += '        </li>\n';
  }
  h += '      </ul>\n    </section>\n';
  return h;
}

// === インデックス（新弾情報ハブ）生成 ===
// 指示書52: プレビュー期間外・発売後でも常に中身のある「新弾情報ハブ」にする。
// 「最終更新: 今日」は出力しない（日次差分を出さず、Task2-α の「変更時のみpush」を成立させる）。
function generateIndexPage(totalShown) {
  const released = releasedSetsMeta();
  const upcoming = upcomingSetsMeta();
  const latest = released[0] || null;
  const focus = latest || upcoming[0] || null;

  let title, description;
  if (latest) {
    const nm = setDisplayName(latest);
    title = `${latest.code} ${nm} 新弾情報 — 収録カード・考察・初動採用率 | GCG STATS`;
    description = `ガンダムカードゲーム ${latest.code} ${nm}（${fmtJpDate(latest.release_date)}発売）の新弾情報。収録カード一覧・関連考察記事・初動採用率をまとめた非公式ハブ。`;
  } else if (focus) {
    const nm = setDisplayName(focus);
    title = `${focus.code} ${nm} 新弾情報（発売前） | GCG STATS`;
    description = `ガンダムカードゲーム ${focus.code} ${nm}（${fmtJpDate(focus.release_date)}発売予定）の新弾情報。判明カード・関連記事をまとめた非公式ハブ。`;
  } else {
    title = '新弾情報 | GCG STATS';
    description = 'ガンダムカードゲームの新弾情報ハブ。発売前の判明カード、発売後の弾まとめ・初動採用率、次弾の案内を掲載する非公式まとめ。';
  }
  const canonical = `${SITE_URL}/sets/`;

  let html = pageHead({ title, description, canonical, ogImage: true });
  html += '    <div class="section-header">\n';
  html += '      <h1 class="section-title">新弾情報</h1>\n';
  html += '    </div>\n';

  // 1. プレビュー（有効件数>0のときのみ）
  html += hubPreviewSectionHtml(totalShown);

  // 2. 最新弾まとめ / 境界仕様（発売済み0件なら次弾を詳細版で表示＝空にしない）
  if (latest) {
    html += hubSetSummaryBlock(latest, false);
    html += hubUpcomingHtml(upcoming);
  } else if (upcoming.length) {
    html += hubSetSummaryBlock(upcoming[0], true);
    html += hubUpcomingHtml(upcoming.slice(1));
  } else if (totalShown <= 0) {
    // sets_meta 空 かつ プレビューも無い最終フォールバック（従来の空状態文言）
    html += '    <div class="preview-notice">\n';
    html += '      現在、新弾情報の公開期間ではありません。公式X（@GUNDAM_GCG_JP）で新カードが公開されると、このページに随時掲載されます。\n';
    html += '    </div>\n';
    html += '    <p style="margin-bottom:8px"><a href="/cards.html" style="color:var(--accent);text-decoration:none;font-size:14px">カードリストを見る →</a></p>\n';
    html += '    <p style="margin-bottom:8px"><a href="/reports/" style="color:var(--accent);text-decoration:none;font-size:14px">最新のレポートを見る →</a></p>\n';
  }

  html += pageFoot();
  fs.writeFileSync(path.join(OUT_DIR, 'index.html'), html, 'utf-8');
}

// === メイン実行 ===
console.log('[generate_preview_sets] プレビューセット一覧ページ生成を開始...');
if (!fs.existsSync(OUT_DIR)) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  console.log('  → sets/ ディレクトリを作成');
}

let totalShown = 0;
const generatedFiles = [];
for (const s of setNames) {
  const f = generateSetPage(s, setMap[s]);
  totalShown += setMap[s].length;
  generatedFiles.push(f);
  const withImg = setMap[s].filter((c) => cardImageMap[String(c.key).toUpperCase()]).length;
  console.log(`  → sets/${f} 生成 (${setMap[s].length} 枚、画像 ${withImg} 枚)`);
}
generateIndexPage(totalShown);
console.log('  → sets/index.html 生成');

// === 検証ログ ===
const totalEntries = Object.keys(cardsPreview).length;
console.log('--- 検証 ---');
console.log(`  cards_preview.json エントリ数: ${totalEntries}`);
console.log(`  テストダミー除外: ${excluded.length} 件 ${excluded.length ? '(' + excluded.join(', ') + ')' : ''}`);
console.log(`  掲載カード総数: ${totalShown}`);
console.log(`  生成HTML: ${generatedFiles.length} セット + index = ${generatedFiles.length + 1} ファイル`);
if (totalShown + excluded.length === totalEntries) {
  console.log('  ✔ 件数一致: 掲載数 + 除外数 = エントリ数');
} else {
  console.error('  ✖ 件数不一致! 掲載数 + 除外数 ≠ エントリ数');
  process.exit(1);
}
