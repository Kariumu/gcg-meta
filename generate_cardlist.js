#!/usr/bin/env node
/**
 * generate_cardlist.js
 * カードリストページ (cards.html) を生成する
 * cards_master.json + summary.json を読み込み、全526枚のカードを一覧表示する静的HTMLを出力
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const SITE_URL = 'https://gcg-stats.com';

// === データ読み込み ===
let cardsMaster = {};
try {
  cardsMaster = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'cards_master.json'), 'utf-8'));
  console.log(`  カードマスター: ${Object.keys(cardsMaster).length} 件読み込み`);
} catch (e) {
  console.error('  ✖ cards_master.json が見つかりません');
  process.exit(1);
}

let summary = {};
try {
  summary = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'summary.json'), 'utf-8'));
  console.log(`  サマリー: card_ranking ${(summary.card_ranking || []).length} 件`);
} catch (e) {
  console.warn('  ⚠ summary.json が見つかりません。採用率データなしで生成します。');
  summary = { card_ranking: [], total_events: 0, total_decks: 0 };
}

// === 定数 ===
const COLOR_JP = {
  'Blue': '青', 'Green': '緑', 'Red': '赤',
  'White': '白', 'Purple': '紫', 'Colorless': '無色'
};
const COLOR_HEX = {
  'Blue': '#4488ff', 'Green': '#44cc64', 'Red': '#ff4444',
  'White': '#cccccc', 'Purple': '#aa44ff', 'Colorless': '#888888'
};
const TYPE_JP = {
  'UNIT': 'ユニット', 'PILOT': 'パイロット',
  'COMMAND': 'コマンド', 'BASE': 'ベース'
};
const RARITY_ORDER = ['LR', 'R', 'U', 'C'];

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// === card_ranking をマップ化 ===
const cardRankingMap = {};
for (const c of (summary.card_ranking || [])) {
  cardRankingMap[c.card_id] = c;
}

// === 収録弾ラベル ===
const SET_LABELS = {
  'GD01': '第1弾ブースターパック',
  'GD02': '第2弾ブースターパック',
  'GD03': '第3弾ブースターパック',
  'ST01': 'スタートデッキ 地球連邦',
  'ST02': 'スタートデッキ ジオン',
  'ST03': 'スタートデッキ アナハイム',
  'ST04': 'スタートデッキ OZ',
  'ST05': 'スタートデッキ ザフト',
  'ST06': 'スタートデッキ ソレスタルビーイング',
  'ST07': 'スタートデッキ ネオ・ジオン',
  'ST08': 'スタートデッキ ティターンズ',
  'ST09': 'スタートデッキ インパルス',
  // 2026-06-10 新弾追加（発売後の備え）。※「G005」は GD05 の OCR 誤読でありセットとして存在しない
  'GD05': '第5弾ブースターパック',
  'ST10': 'スタートデッキ Generation Pulse',
  'EB01': 'Eternal Nexus',
};

function getSetPrefix(cardId) {
  return cardId.replace(/-\d+$/, '');
}

// === 収録弾の正となる値の決定（package_set 基準）===
// 収録弾の正 ＝ 各カードの package_set（取り得る値: GD01-04 / ST01-09 / β / PROMO の15種）。
// 公開中 cards.html の挙動（set=package_set、β/PROMO を独立した箱として保持）に揃える。
// フォールバック: package_set が未設定/空のカードが将来現れた場合に限り、ID由来の
//   prefix へ退避する。_pN（パラレル接尾辞）と末尾連番を除去して基本弾へ寄せるため、
//   例 "GD05-001_p1" → "GD05"。これにより set が undefined/空になって箱が壊れるのを防ぐ。
function getCardSet(card) {
  const ps = card && card.package_set;
  if (ps !== undefined && ps !== null && String(ps).trim() !== '') {
    return String(ps).trim();
  }
  // フォールバック（package_set 欠落/空のときのみ発動）
  return getSetPrefix(String((card && card.id) || '').replace(/_p\d+$/, ''));
}

// === 収録弾の表示順（正準順）===
// chip と並びは package_set 基準。この順で整列し、正準順に無い未知の収録弾
// （将来の新弾やフォールバック値）は末尾へ出現順で回す。
// 2026-06-10 新弾追加（指示書 cowork-instr-preview-sets-and-series-2026-06-10.md Task 3）:
//   既存の並び思想は「ブースター(GD) → スタートデッキ(ST) → 特殊(β/PROMO)」のため、
//   GD05 は GD04 の直後、ST10 は ST09 の直後に挿入。
//   EB01（Eternal Nexus）は既存カテゴリに属さない新シリーズのため、
//   通常販売パック群の末尾（ST の後）かつ特殊枠（β/PROMO）の前に配置。
//   ※「G005」は GD05 の OCR 誤読でありセットとして存在しないため除去
//     （2026-06-10 指示書 cowork-instr-g005-merge-images Task E）
const SET_DISPLAY_ORDER = ['GD01','GD02','GD03','GD04','GD05','ST01','ST02','ST03','ST04','ST05','ST06','ST07','ST08','ST09','ST10','EB01','β','PROMO'];

// === 収録弾 表示名対応表（生値 → 画面表示名）===
// 既存の SET_LABELS（収録弾の長い説明文。例 "第1弾ブースターパック"。GD01-03/ST01-09 のみ定義）
// とは役割が異なるため統合せず別表として新設する。
//   SET_LABELS        … セクション小見出し用の説明文
//   SET_DISPLAY_NAMES … chip 等で使う短い表示名（生値=表示でよいものは記載を省略）
// 現状 "PROMO" のみ日本語表示「プロモ」。GD01-04 / ST01-09 / β は生値=表示で齟齬なし。
const SET_DISPLAY_NAMES = { 'PROMO': 'プロモ' };
function getSetDisplayName(set) {
  return SET_DISPLAY_NAMES[set] || set;
}

// === 全カードのソート済みリスト ===
const allCards = Object.values(cardsMaster).sort((a, b) => a.id.localeCompare(b.id));
const totalCards = allCards.length;
const tournamentCards = allCards.filter(c => cardRankingMap[c.id]).length;

// 収録弾リスト（出現順）
const setOrder = [];
const setCardCounts = {};
for (const card of allCards) {
  const prefix = getCardSet(card);          // 収録弾の正 = package_set（フォールバック付き）
  if (!setCardCounts[prefix]) {
    setOrder.push(prefix);
    setCardCounts[prefix] = 0;
  }
  setCardCounts[prefix]++;
}
// 表示順を正準順（SET_DISPLAY_ORDER）に整列。正準順に無い未知の収録弾は末尾へ。
setOrder.sort((a, b) => {
  const ia = SET_DISPLAY_ORDER.indexOf(a);
  const ib = SET_DISPLAY_ORDER.indexOf(b);
  return (ia < 0 ? 9999 : ia) - (ib < 0 ? 9999 : ib);
});

console.log(`  全カード: ${totalCards} 枚 (入賞実績あり: ${tournamentCards} 枚)`);
console.log(`  収録弾: ${setOrder.length} セット`);

// === HTMLテンプレート生成 ===

function generateNoscriptContent() {
  let html = '  <noscript>\n';
  html += '    <div style="padding:32px;max-width:1280px;margin:0 auto">\n';
  html += '      <h1 style="color:#d4a029;font-size:18px;margin-bottom:16px">ガンダムカードゲーム カードリスト</h1>\n';
  html += `      <p style="color:#8b95a5;margin-bottom:24px">全${totalCards}枚のカード情報を掲載しています。</p>\n`;
  html += '      <ul style="list-style:none;padding:0">\n';
  for (const card of allCards) {
    const colorJp = COLOR_JP[card.color] || card.color;
    const typeJp = TYPE_JP[card.card_type] || card.card_type;
    html += `        <li style="margin-bottom:4px"><a href="/cards/${card.id}/" style="color:#4d9ff7;text-decoration:none">${escapeHtml(card.name_jp)}（${card.id}）- ${typeJp}・${colorJp}・${card.rarity}</a></li>\n`;
  }
  html += '      </ul>\n';
  html += '    </div>\n';
  html += '  </noscript>\n';
  return html;
}

function generateCardsDataJS() {
  // カードデータをJavaScript配列として埋め込む
  const cardsArr = allCards.map(card => {
    const ranking = cardRankingMap[card.id];
    return {
      id: card.id,
      name: card.name_jp,
      rarity: card.rarity,
      type: card.card_type,
      color: card.color,
      set: getCardSet(card),  // 収録弾の正 = package_set（フォールバック付き）
      level: card.level || 0,
      cost: card.cost || 0,
      ap: card.stats ? card.stats.ap : 0,
      hp: card.stats ? card.stats.hp : 0,
      usage: ranking ? ranking.usage_rate : 0,
      decks: ranking ? ranking.decks : 0,
      wins: ranking ? ranking.wins : 0,
      hasTournament: !!ranking
    };
  });
  return JSON.stringify(cardsArr);
}

function generateHTML() {
  const today = new Date().toISOString().split('T')[0];

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
  <title>カードリスト | GCG STATS</title>
  <meta name="description" content="ガンダムカードゲームの全カード一覧。ユニット・パイロット・コマンド・ベースカード${totalCards}枚を色・タイプ・レアリティでフィルタリングして検索できます。大会採用率データも確認可能。">
  <meta property="og:title" content="カードリスト | GCG STATS">
  <meta property="og:description" content="ガンダムカードゲーム全${totalCards}枚のカードリスト。大会採用率・フィルタリング検索対応。">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${SITE_URL}/cards.html">
  <link rel="canonical" href="${SITE_URL}/cards.html">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="css/style.css">
  <style>
    /* === Card List Page Styles === */
    .cardlist-stats {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 14px;
      margin-bottom: 28px;
    }

    /* Filter Section */
    .cardlist-filters {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 20px;
      margin-bottom: 24px;
    }
    .filter-group {
      margin-bottom: 16px;
    }
    .filter-group:last-child {
      margin-bottom: 0;
    }
    .filter-group-label {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 1.5px;
      margin-bottom: 8px;
      display: block;
    }
    .filter-chips {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .filter-chip {
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      color: var(--text-secondary);
      padding: 6px 14px;
      border-radius: 6px;
      font-size: 12px;
      font-family: var(--font-mono);
      cursor: pointer;
      transition: all var(--transition-fast);
      user-select: none;
      -webkit-user-select: none;
    }
    .filter-chip:hover {
      border-color: var(--border-hover);
      color: var(--text-primary);
    }
    .filter-chip.active {
      background: var(--accent-dim);
      border-color: var(--accent);
      color: var(--accent);
      font-weight: 600;
    }

    /* Color-specific active chips */
    .filter-chip[data-color="Blue"].active { background: rgba(68,136,255,0.12); border-color: #4488ff; color: #4488ff; }
    .filter-chip[data-color="Green"].active { background: rgba(68,204,100,0.12); border-color: #44cc64; color: #44cc64; }
    .filter-chip[data-color="Red"].active { background: rgba(255,68,68,0.12); border-color: #ff4444; color: #ff4444; }
    .filter-chip[data-color="White"].active { background: rgba(200,200,200,0.12); border-color: #cccccc; color: #cccccc; }
    .filter-chip[data-color="Purple"].active { background: rgba(180,68,255,0.12); border-color: #b444ff; color: #b444ff; }

    /* Search + Sort row */
    .filter-controls {
      display: flex;
      gap: 12px;
      align-items: stretch;
    }
    .search-wrapper {
      flex: 1;
      position: relative;
    }
    .search-input {
      width: 100%;
      background: var(--bg-input);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 10px 14px 10px 38px;
      color: var(--text-primary);
      font-size: 13px;
      font-family: var(--font-sans);
      transition: border-color var(--transition-fast);
      outline: none;
    }
    .search-input:focus {
      border-color: var(--accent);
    }
    .search-input::placeholder {
      color: var(--text-muted);
    }
    .search-icon {
      position: absolute;
      left: 12px;
      top: 50%;
      transform: translateY(-50%);
      color: var(--text-muted);
      font-size: 14px;
      pointer-events: none;
    }
    .sort-select {
      background: var(--bg-input);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 10px 14px;
      color: var(--text-primary);
      font-size: 13px;
      font-family: var(--font-mono);
      cursor: pointer;
      outline: none;
      transition: border-color var(--transition-fast);
      min-width: 160px;
    }
    .sort-select:focus {
      border-color: var(--accent);
    }
    .sort-select option {
      background: var(--bg-card);
      color: var(--text-primary);
    }

    /* Results count */
    .results-count {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text-muted);
      margin-bottom: 16px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .results-count .count-num {
      color: var(--accent);
      font-weight: 600;
    }

    /* Card Grid */
    .card-grid {
      display: grid;
      grid-template-columns: repeat(5, 1fr);
      gap: 16px;
      margin-bottom: 32px;
    }

    /* Individual Card Item */
    .card-item {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      overflow: hidden;
      transition: all var(--transition-med);
      text-decoration: none;
      color: inherit;
      display: block;
      position: relative;
    }
    .card-item:hover {
      border-color: var(--border-accent);
      box-shadow: var(--shadow-glow);
      transform: translateY(-3px);
    }
    .card-item-img-wrap {
      position: relative;
      background: var(--bg-secondary);
      aspect-ratio: 63/88;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .card-item-img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      transition: transform 0.3s ease;
    }
    .card-item:hover .card-item-img {
      transform: scale(1.03);
    }
    .card-item-fallback {
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 12px;
      text-align: center;
      width: 100%;
      height: 100%;
      position: absolute;
      top: 0;
      left: 0;
    }
    .card-item-fallback-id {
      font-family: var(--font-mono);
      font-size: 11px;
      color: var(--text-muted);
      word-break: break-all;
    }
    .card-item-fallback-name {
      font-size: 11px;
      color: var(--text-secondary);
      line-height: 1.3;
    }

    /* Card rarity badge */
    .card-rarity-badge {
      position: absolute;
      top: 6px;
      right: 6px;
      font-family: var(--font-mono);
      font-size: 10px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 4px;
      background: rgba(0,0,0,0.7);
      backdrop-filter: blur(4px);
      z-index: 2;
    }
    .rarity-LR { color: #ffd700; border: 1px solid rgba(255,215,0,0.4); }
    .rarity-R { color: #ff8844; border: 1px solid rgba(255,136,68,0.4); }
    .rarity-U { color: #88bbff; border: 1px solid rgba(136,187,255,0.4); }
    .rarity-C { color: #aabbcc; border: 1px solid rgba(170,187,204,0.3); }

    /* Card info area */
    .card-item-info {
      padding: 10px 10px 12px;
    }
    .card-item-name {
      font-size: 12px;
      font-weight: 600;
      line-height: 1.35;
      margin-bottom: 6px;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      min-height: 32px;
    }
    .card-item-meta {
      display: flex;
      align-items: center;
      gap: 4px;
      margin-bottom: 6px;
      flex-wrap: wrap;
    }
    .card-item-id {
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--text-muted);
    }
    .card-mini-tag {
      display: inline-block;
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 10px;
      font-weight: 600;
      font-family: var(--font-mono);
    }
    .card-mini-tag-color {
      border: 1px solid;
    }
    .card-mini-tag-type {
      background: var(--bg-elevated);
      border: 1px solid var(--border);
      color: var(--text-secondary);
    }

    /* Usage rate */
    .card-item-usage {
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px solid var(--border);
    }
    .card-usage-bar {
      height: 3px;
      background: rgba(255,255,255,0.04);
      border-radius: 2px;
      overflow: hidden;
      margin-bottom: 4px;
    }
    .card-usage-bar-fill {
      height: 100%;
      border-radius: 2px;
      transition: width 0.4s ease;
    }
    .card-usage-text {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .card-usage-label {
      font-family: var(--font-mono);
      font-size: 10px;
      color: var(--text-muted);
    }
    .card-usage-value {
      font-family: var(--font-mono);
      font-size: 11px;
      font-weight: 600;
    }
    .card-no-data {
      font-size: 10px;
      color: var(--text-muted);
      font-family: var(--font-mono);
      margin-top: 6px;
      padding-top: 6px;
      border-top: 1px solid var(--border);
    }

    /* Set Sections */
    .set-section {
      margin-bottom: 40px;
    }
    .set-section:last-child {
      margin-bottom: 16px;
    }
    .set-section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
      padding-bottom: 10px;
      border-bottom: 1px solid var(--border);
    }
    .set-section-title {
      font-family: var(--font-mono);
      font-size: 15px;
      font-weight: 700;
      color: var(--text-primary);
      display: flex;
      align-items: baseline;
      gap: 10px;
    }
    .set-section-label {
      font-size: 12px;
      font-weight: 500;
      color: var(--text-secondary);
    }
    .set-section-count {
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text-muted);
      background: var(--bg-elevated);
      padding: 3px 10px;
      border-radius: 4px;
      border: 1px solid var(--border);
    }

    /* No results */
    .no-results {
      text-align: center;
      padding: 64px 24px;
      color: var(--text-muted);
      font-family: var(--font-mono);
      font-size: 13px;
      display: none;
    }
    .no-results-icon {
      font-size: 48px;
      margin-bottom: 16px;
      opacity: 0.3;
    }

    /* Back to top */
    .back-to-top {
      position: fixed;
      bottom: 24px;
      right: 24px;
      width: 44px;
      height: 44px;
      border-radius: 50%;
      background: var(--bg-card);
      border: 1px solid var(--border);
      color: var(--text-secondary);
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 100;
      opacity: 0;
      visibility: hidden;
      transition: all var(--transition-fast);
      box-shadow: var(--shadow-md);
    }
    .back-to-top.visible {
      opacity: 1;
      visibility: visible;
    }
    .back-to-top:hover {
      border-color: var(--accent);
      color: var(--accent);
      transform: translateY(-2px);
    }

    /* Responsive */
    @media (max-width: 1100px) {
      .card-grid { grid-template-columns: repeat(4, 1fr); gap: 14px; }
    }
    @media (max-width: 768px) {
      .card-grid { grid-template-columns: repeat(3, 1fr); gap: 10px; }
      .card-item-info { padding: 8px 8px 10px; }
      .card-item-name { font-size: 11px; min-height: 28px; }
      .filter-controls { flex-direction: column; }
      .sort-select { min-width: unset; }
      .cardlist-stats { grid-template-columns: repeat(2, 1fr); }
    }
    @media (max-width: 480px) {
      .card-grid { grid-template-columns: repeat(3, 1fr); gap: 8px; }
      .card-item-info { padding: 6px 6px 8px; }
      .card-item-name { font-size: 10px; min-height: 24px; -webkit-line-clamp: 1; }
      .card-item-meta { display: none; }
      .card-rarity-badge { font-size: 9px; padding: 1px 4px; top: 4px; right: 4px; }
      .cardlist-filters { padding: 14px; }
      .filter-chip { padding: 5px 10px; font-size: 11px; }
    }
  </style>
</head>
<body>
  <div id="header"></div>

  <main class="container">
    <div class="section-header">
      <h1 class="section-title">カードリスト</h1>
      <span class="section-badge" id="total-badge">${totalCards} CARDS</span>
    </div>

    <!-- 統計サマリー -->
    <div class="cardlist-stats">
      <div class="stat-card">
        <div class="stat-label">総カード数</div>
        <div class="stat-value" style="color:var(--accent)">${totalCards}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">大会入賞あり</div>
        <div class="stat-value" style="color:var(--green)">${tournamentCards}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">未入賞</div>
        <div class="stat-value" style="color:var(--text-muted)">${totalCards - tournamentCards}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">分析イベント数</div>
        <div class="stat-value">${summary.total_events || 0}</div>
      </div>
    </div>

    <!-- フィルター -->
    <div class="cardlist-filters">
      <!-- 色フィルター -->
      <div class="filter-group">
        <span class="filter-group-label">色 / Color</span>
        <div class="filter-chips" id="filter-color">
          <button class="filter-chip active" data-value="all">全て</button>
          <button class="filter-chip" data-color="Blue" data-value="Blue">青</button>
          <button class="filter-chip" data-color="Green" data-value="Green">緑</button>
          <button class="filter-chip" data-color="Red" data-value="Red">赤</button>
          <button class="filter-chip" data-color="White" data-value="White">白</button>
          <button class="filter-chip" data-color="Purple" data-value="Purple">紫</button>
        </div>
      </div>

      <!-- 収録弾フィルター -->
      <div class="filter-group">
        <span class="filter-group-label">収録弾 / Set</span>
        <div class="filter-chips" id="filter-set">
          <button class="filter-chip active" data-value="all">全て</button>
${setOrder.map(prefix => `          <button class="filter-chip" data-value="${prefix}">${getSetDisplayName(prefix)}</button>`).join('\n')}
        </div>
      </div>

      <!-- タイプフィルター -->
      <div class="filter-group">
        <span class="filter-group-label">タイプ / Type</span>
        <div class="filter-chips" id="filter-type">
          <button class="filter-chip active" data-value="all">全て</button>
          <button class="filter-chip" data-value="UNIT">ユニット</button>
          <button class="filter-chip" data-value="PILOT">パイロット</button>
          <button class="filter-chip" data-value="COMMAND">コマンド</button>
          <button class="filter-chip" data-value="BASE">ベース</button>
        </div>
      </div>

      <!-- レアリティフィルター -->
      <div class="filter-group">
        <span class="filter-group-label">レアリティ / Rarity</span>
        <div class="filter-chips" id="filter-rarity">
          <button class="filter-chip active" data-value="all">全て</button>
          <button class="filter-chip" data-value="LR">LR</button>
          <button class="filter-chip" data-value="R">R</button>
          <button class="filter-chip" data-value="U">U</button>
          <button class="filter-chip" data-value="C">C</button>
        </div>
      </div>

      <!-- 採用状況フィルター -->
      <div class="filter-group">
        <span class="filter-group-label">採用状況 / Tournament</span>
        <div class="filter-chips" id="filter-tournament">
          <button class="filter-chip active" data-value="all">全て</button>
          <button class="filter-chip" data-value="yes">大会入賞あり</button>
          <button class="filter-chip" data-value="no">未入賞</button>
        </div>
      </div>

      <!-- 検索 + ソート -->
      <div class="filter-group">
        <div class="filter-controls">
          <div class="search-wrapper">
            <span class="search-icon">&#x1F50D;</span>
            <input type="text" class="search-input" id="search-input" placeholder="カード名・IDで検索..." autocomplete="off">
          </div>
          <select class="sort-select" id="sort-select">
            <option value="id-asc">カードID順</option>
            <option value="usage-desc">採用率が高い順</option>
            <option value="rarity-asc">レアリティ順</option>
            <option value="name-asc">名前順</option>
          </select>
        </div>
      </div>
    </div>

    <!-- 結果件数 -->
    <div class="results-count">
      <span id="results-text"><span class="count-num">${totalCards}</span> / ${totalCards} 件表示</span>
    </div>

    <!-- カードグリッド -->
    <div id="card-grid"></div>

    <!-- 結果なし表示 -->
    <div class="no-results" id="no-results">
      <div class="no-results-icon">&#x1F50D;</div>
      <div>該当するカードが見つかりません</div>
      <div style="margin-top:8px;font-size:12px">フィルターまたは検索条件を変更してください</div>
    </div>
  </main>

  <div id="footer"></div>

  <!-- Back to top -->
  <button class="back-to-top" id="back-to-top" onclick="window.scrollTo({top:0,behavior:'smooth'})" aria-label="ページ上部へ">&#x25B2;</button>

${generateNoscriptContent()}
  <script src="js/common.js?v=15"></script>
  <script>
    // === Card Data (embedded at build time) ===
    var CARDS = ${generateCardsDataJS()};

    // === Constants ===
    var COLOR_JP = { Blue:'青', Green:'緑', Red:'赤', White:'白', Purple:'紫', Colorless:'無色' };
    var COLOR_HEX = { Blue:'#4488ff', Green:'#44cc64', Red:'#ff4444', White:'#cccccc', Purple:'#b444ff', Colorless:'#888888' };
    var TYPE_JP = { UNIT:'ユニット', PILOT:'パイロット', COMMAND:'コマンド', BASE:'ベース' };
    var RARITY_ORDER = { LR: 0, R: 1, U: 2, C: 3 };
    var TOTAL_CARDS = ${totalCards};
    var SET_ORDER = ${JSON.stringify(setOrder)};
    var SET_LABELS = ${JSON.stringify(SET_LABELS)};

    // === Filter State ===
    var filterState = {
      colors: [],      // empty = all
      sets: [],        // empty = all
      types: [],       // empty = all
      rarities: [],    // empty = all
      tournament: 'all', // 'all', 'yes', 'no'
      search: '',
      sort: 'id-asc'
    };

    // === DOM ===
    var gridEl = document.getElementById('card-grid');
    var noResultsEl = document.getElementById('no-results');
    var resultsTextEl = document.getElementById('results-text');
    var searchInput = document.getElementById('search-input');
    var sortSelect = document.getElementById('sort-select');
    var backToTop = document.getElementById('back-to-top');

    // === Filter Logic (multi-select) ===
    function setupFilterGroup(groupId, stateKey, isMulti) {
      var group = document.getElementById(groupId);
      var chips = group.querySelectorAll('.filter-chip');
      chips.forEach(function(chip) {
        chip.addEventListener('click', function() {
          var val = chip.dataset.value;
          if (isMulti) {
            // Multi-select: color, type, rarity
            if (val === 'all') {
              // Toggle to "all" — clear specific selections
              filterState[stateKey] = [];
              chips.forEach(function(c) { c.classList.remove('active'); });
              chip.classList.add('active');
            } else {
              // Remove "all" active state
              chips[0].classList.remove('active');
              var idx = filterState[stateKey].indexOf(val);
              if (idx >= 0) {
                filterState[stateKey].splice(idx, 1);
                chip.classList.remove('active');
                // If nothing selected, revert to "all"
                if (filterState[stateKey].length === 0) {
                  chips[0].classList.add('active');
                }
              } else {
                filterState[stateKey].push(val);
                chip.classList.add('active');
              }
            }
          } else {
            // Single select: tournament
            filterState[stateKey] = val;
            chips.forEach(function(c) { c.classList.remove('active'); });
            chip.classList.add('active');
          }
          renderCards();
        });
      });
    }

    // === Filtering ===
    function getFilteredCards() {
      var result = CARDS.filter(function(card) {
        // Color filter
        if (filterState.colors.length > 0 && filterState.colors.indexOf(card.color) < 0) return false;
        // Set filter
        if (filterState.sets.length > 0 && filterState.sets.indexOf(card.set) < 0) return false;
        // Type filter
        if (filterState.types.length > 0 && filterState.types.indexOf(card.type) < 0) return false;
        // Rarity filter
        if (filterState.rarities.length > 0 && filterState.rarities.indexOf(card.rarity) < 0) return false;
        // Tournament filter
        if (filterState.tournament === 'yes' && !card.hasTournament) return false;
        if (filterState.tournament === 'no' && card.hasTournament) return false;
        // Search filter
        if (filterState.search) {
          var q = filterState.search.toLowerCase();
          if (card.name.toLowerCase().indexOf(q) < 0 && card.id.toLowerCase().indexOf(q) < 0) return false;
        }
        return true;
      });

      // Sort
      var sort = filterState.sort;
      if (sort === 'id-asc') {
        result.sort(function(a, b) { return a.id.localeCompare(b.id); });
      } else if (sort === 'usage-desc') {
        result.sort(function(a, b) { return b.usage - a.usage || a.id.localeCompare(b.id); });
      } else if (sort === 'rarity-asc') {
        result.sort(function(a, b) {
          return (RARITY_ORDER[a.rarity] || 9) - (RARITY_ORDER[b.rarity] || 9) || a.id.localeCompare(b.id);
        });
      } else if (sort === 'name-asc') {
        result.sort(function(a, b) { return a.name.localeCompare(b.name, 'ja'); });
      }
      return result;
    }

    // === Render Card HTML ===
    function cardHTML(card) {
      var colorHex = COLOR_HEX[card.color] || '#888';
      var colorJp = COLOR_JP[card.color] || card.color;
      var typeJp = TYPE_JP[card.type] || card.type;
      var imgSrc = '/images/cards/' + card.id + '.webp';

      var usageHtml = '';
      if (card.hasTournament && card.usage > 0) {
        var barColor = card.usage > 30 ? 'var(--accent)' : card.usage > 15 ? 'var(--blue)' : 'var(--text-muted)';
        usageHtml = '<div class="card-item-usage">' +
          '<div class="card-usage-bar"><div class="card-usage-bar-fill" style="width:' + Math.min(card.usage, 100) + '%;background:' + barColor + '"></div></div>' +
          '<div class="card-usage-text"><span class="card-usage-label">採用率</span><span class="card-usage-value" style="color:' + barColor + '">' + card.usage.toFixed(1) + '%</span></div>' +
          '</div>';
      } else {
        usageHtml = '<div class="card-no-data">未入賞</div>';
      }

      return '<a class="card-item" href="/cards/' + card.id + '/">' +
        '<div class="card-item-img-wrap">' +
          '<img class="card-item-img" src="' + imgSrc + '" alt="' + escapeAttr(card.name) + '" loading="lazy" onerror="this.style.display=&quot;none&quot;;this.nextElementSibling.style.display=&quot;flex&quot;">' +
          '<div class="card-item-fallback"><div class="card-item-fallback-id">' + card.id + '</div><div class="card-item-fallback-name">' + escapeAttr(card.name) + '</div></div>' +
          '<span class="card-rarity-badge rarity-' + card.rarity + '">' + card.rarity + '</span>' +
        '</div>' +
        '<div class="card-item-info">' +
          '<div class="card-item-name">' + escapeAttr(card.name) + '</div>' +
          '<div class="card-item-meta">' +
            '<span class="card-mini-tag card-mini-tag-color" style="color:' + colorHex + ';border-color:' + colorHex + ';background:' + colorHex + '1a">' + colorJp + '</span>' +
            '<span class="card-mini-tag card-mini-tag-type">' + typeJp + '</span>' +
            '<span class="card-item-id">' + card.id + '</span>' +
          '</div>' +
          usageHtml +
        '</div>' +
      '</a>';
    }

    function escapeAttr(str) {
      return String(str).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    // === Render ===
    var renderTimer = null;
    function renderCards() {
      // Debounce for search input
      if (renderTimer) clearTimeout(renderTimer);
      renderTimer = setTimeout(doRender, 16);
    }

    function doRender() {
      var filtered = getFilteredCards();
      var count = filtered.length;

      resultsTextEl.innerHTML = '<span class="count-num">' + count + '</span> / ' + TOTAL_CARDS + ' 件表示';

      if (count === 0) {
        gridEl.innerHTML = '';
        noResultsEl.style.display = 'block';
        return;
      }
      noResultsEl.style.display = 'none';

      // Group by set
      var groups = {};
      var groupOrder = [];
      for (var i = 0; i < count; i++) {
        var card = filtered[i];
        var setKey = card.set;
        if (!groups[setKey]) {
          groups[setKey] = [];
          groupOrder.push(setKey);
        }
        groups[setKey].push(card);
      }

      // Maintain original set order when sorted by ID
      if (filterState.sort === 'id-asc') {
        groupOrder.sort(function(a, b) {
          return SET_ORDER.indexOf(a) - SET_ORDER.indexOf(b);
        });
      }

      // Build HTML with set sections
      var html = '';
      for (var g = 0; g < groupOrder.length; g++) {
        var setKey = groupOrder[g];
        var cards = groups[setKey];
        var label = SET_LABELS[setKey] || setKey;
        html += '<div class="set-section">';
        html += '<div class="set-section-header">';
        html += '<h2 class="set-section-title">' + setKey + '<span class="set-section-label">' + escapeAttr(label) + '</span></h2>';
        html += '<span class="set-section-count">' + cards.length + ' 枚</span>';
        html += '</div>';
        html += '<div class="card-grid">';
        for (var j = 0; j < cards.length; j++) {
          html += cardHTML(cards[j]);
        }
        html += '</div>';
        html += '</div>';
      }
      gridEl.innerHTML = html;
    }

    // === Event Listeners ===
    setupFilterGroup('filter-color', 'colors', true);
    setupFilterGroup('filter-set', 'sets', true);
    setupFilterGroup('filter-type', 'types', true);
    setupFilterGroup('filter-rarity', 'rarities', true);
    setupFilterGroup('filter-tournament', 'tournament', false);

    searchInput.addEventListener('input', function() {
      filterState.search = this.value.trim();
      renderCards();
    });

    sortSelect.addEventListener('change', function() {
      filterState.sort = this.value;
      renderCards();
    });

    // Back to top
    window.addEventListener('scroll', function() {
      if (window.scrollY > 400) {
        backToTop.classList.add('visible');
      } else {
        backToTop.classList.remove('visible');
      }
    });

    // URL params support
    (function() {
      var params = new URLSearchParams(window.location.search);
      if (params.get('color')) {
        var colors = params.get('color').split(',');
        filterState.colors = colors;
        var chips = document.querySelectorAll('#filter-color .filter-chip');
        chips[0].classList.remove('active');
        chips.forEach(function(c) { if (colors.indexOf(c.dataset.value) >= 0) c.classList.add('active'); });
      }
      if (params.get('set')) {
        var sets = params.get('set').split(',');
        filterState.sets = sets;
        var chips = document.querySelectorAll('#filter-set .filter-chip');
        chips[0].classList.remove('active');
        chips.forEach(function(c) { if (sets.indexOf(c.dataset.value) >= 0) c.classList.add('active'); });
      }
      if (params.get('type')) {
        var types = params.get('type').split(',');
        filterState.types = types;
        var chips = document.querySelectorAll('#filter-type .filter-chip');
        chips[0].classList.remove('active');
        chips.forEach(function(c) { if (types.indexOf(c.dataset.value) >= 0) c.classList.add('active'); });
      }
      if (params.get('rarity')) {
        var rarities = params.get('rarity').split(',');
        filterState.rarities = rarities;
        var chips = document.querySelectorAll('#filter-rarity .filter-chip');
        chips[0].classList.remove('active');
        chips.forEach(function(c) { if (rarities.indexOf(c.dataset.value) >= 0) c.classList.add('active'); });
      }
      if (params.get('q')) {
        filterState.search = params.get('q');
        searchInput.value = filterState.search;
      }
      if (params.get('sort')) {
        filterState.sort = params.get('sort');
        sortSelect.value = filterState.sort;
      }
    })();

    // Header/Footer
    GCG.init();
    document.getElementById('header').innerHTML = GCG.renderHeader('cards');
    document.getElementById('footer').innerHTML = GCG.renderFooter();

    // Initial render
    renderCards();
  </script>
</body>
</html>`;
}

// === メイン実行 ===
console.log('[generate_cardlist] カードリストページ生成を開始...');
const html = generateHTML();
const outputPath = path.join(ROOT, 'cards.html');
fs.writeFileSync(outputPath, html, 'utf-8');
console.log(`  → cards.html 生成完了 (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
