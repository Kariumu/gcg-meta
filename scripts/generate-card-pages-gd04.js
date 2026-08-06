#!/usr/bin/env node
/**
 * generate-card-pages-gd04.js
 * GD04カード個別ページ (cards/GD04-XXX/index.html) を生成する
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const CARDS_DIR = path.join(ROOT, 'cards');
const SITE_URL = 'https://gcg-stats.com';

const cardsMaster = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'cards_master.json'), 'utf-8'));

const COLOR_JP = { 'Blue': '青', 'Green': '緑', 'Red': '赤', 'White': '白', 'Purple': '紫', 'Colorless': '無色' };
const TYPE_JP = { 'UNIT': 'ユニット', 'PILOT': 'パイロット', 'COMMAND': 'コマンド', 'BASE': 'ベース' };
const RARITY_LABEL = { 'LR': 'LR', 'R': 'R', 'U': 'U', 'C': 'C' };
const DECK_COLORS = {
  Blue:    { hex: '#4488ff' },
  Red:     { hex: '#ff4444' },
  Green:   { hex: '#44cc64' },
  White:   { hex: '#cccccc' },
  Purple:  { hex: '#b444ff' },
  Unknown: { hex: '#888888' }
};

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function generateCardPage(cardId, masterCard) {
  const cardName = masterCard.name_jp || cardId;
  const colorJp = COLOR_JP[masterCard.color] || masterCard.color || '';
  const typeJp = TYPE_JP[masterCard.card_type] || masterCard.card_type || '';
  const colorHex = (DECK_COLORS[masterCard.color] || DECK_COLORS.Unknown).hex;

  const description = `ガンダムカードゲーム ${cardName}（${cardId}）の詳細情報。色:${colorJp} タイプ:${typeJp}${masterCard.level ? ' Lv.' + masterCard.level : ''}`;
  const pageTitle = `${cardName}（${cardId}）の大会採用率 | GCG STATS`;

  const stats = masterCard.stats || {};
  const ap = stats.ap !== undefined ? stats.ap : (masterCard.ap || 0);
  const hp = stats.hp !== undefined ? stats.hp : (masterCard.hp || 0);

  let cardTypeBadges = `
          <span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-family:var(--font-mono);background:${colorHex}22;color:${colorHex};border:1px solid ${colorHex}44">${escapeHtml(colorJp)}</span>
          <span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-family:var(--font-mono);background:var(--bg-card);color:var(--text-secondary);border:1px solid var(--border)">${escapeHtml(typeJp)}</span>
          <span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-family:var(--font-mono);background:var(--bg-card);color:var(--text-secondary);border:1px solid var(--border)">${escapeHtml(RARITY_LABEL[masterCard.rarity] || masterCard.rarity || '')}</span>`;
  if (masterCard.card_type === 'UNIT') {
    cardTypeBadges += `
          <span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-family:var(--font-mono);background:var(--bg-card);color:var(--text-secondary);border:1px solid var(--border)">Lv.${masterCard.level} / コスト${masterCard.cost}</span>
          <span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-family:var(--font-mono);background:var(--bg-card);color:var(--text-secondary);border:1px solid var(--border)">AP${ap} / HP${hp}</span>`;
  } else if (masterCard.card_type === 'PILOT') {
    cardTypeBadges += `
          <span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-family:var(--font-mono);background:var(--bg-card);color:var(--text-secondary);border:1px solid var(--border)">Lv.${masterCard.level} / コスト${masterCard.cost}</span>`;
  } else if (masterCard.card_type === 'COMMAND') {
    cardTypeBadges += `
          <span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-family:var(--font-mono);background:var(--bg-card);color:var(--text-secondary);border:1px solid var(--border)">コスト${masterCard.cost}</span>`;
  }

  const traitsHtml = (masterCard.traits && masterCard.traits.length > 0)
    ? `<p style="font-size:12px;color:var(--text-muted);margin:0 0 4px">特徴: ${escapeHtml(masterCard.traits.join(', '))}</p>` : '';
  const sourceTitleHtml = masterCard.source_title
    ? `<p style="font-size:12px;color:var(--text-muted);margin:0 0 8px">作品: ${escapeHtml(masterCard.source_title)}</p>` : '';

  const effectHtml = masterCard.effect
    ? `<div style="margin-top:16px;padding:12px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius)">
        <p style="font-size:11px;color:var(--text-muted);margin:0 0 4px">効果テキスト</p>
        <p style="font-size:13px;line-height:1.6;margin:0;white-space:pre-wrap">${escapeHtml(masterCard.effect)}</p>
      </div>` : '';

  const adoptionTableHtml = `
        <details class="collapsible-section">
          <summary class="section-header collapsible-toggle">
            <h2 class="section-title">TOP4 採用実績</h2>
            <div style="display:flex;align-items:center;gap:8px"><span class="section-badge">0件</span><span class="toggle-icon"></span></div>
          </summary>
          <div style="text-align:center;padding:32px;color:var(--text-muted)">TOP4での採用実績がありません</div>
        </details>`;

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
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(pageTitle)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta property="og:site_name" content="GCG STATS">
  <meta property="og:locale" content="ja_JP">
  <meta property="og:title" content="${escapeHtml(pageTitle)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="${SITE_URL}/cards/${cardId}/">
  <meta property="og:image" content="${SITE_URL}/images/cards/${cardId}.webp">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(pageTitle)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${SITE_URL}/images/cards/${cardId}.webp">
  <link rel="canonical" href="${SITE_URL}/cards/${cardId}/">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="../../css/style.css">
</head>
<body>
  <header class="site-header">
    <div class="header-inner">
      <a href="../../index.html" class="site-logo">
        <span class="logo-icon">G</span>
        <div>
          <span class="logo-text">GCG STATS</span>
          <span class="logo-sub">Tournament Analytics</span>
        </div>
      </a>
      <nav>
        <a href="../../index.html">ダッシュボード</a>
        <a href="../../events.html">イベント</a>
        <a href="../../meta.html">環境分析</a>
        <a href="../../cards.html">カードリスト</a>
      </nav>
    </div>
  </header>

  <main class="container">
    <div style="margin-bottom:12px">
      <a id="back-link" href="../../meta.html" style="color:var(--text-muted);text-decoration:none;font-size:13px;transition:color 0.15s;cursor:pointer"
         onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--text-muted)'">
        \u2190 \u623b\u308b
      </a>
    </div>
    <script>
      (function() {
        var params = new URLSearchParams(window.location.search);
        var from = params.get('from');
        var name = params.get('name');
        var el = document.getElementById('back-link');
        if (from === 'event' && name) {
          el.textContent = '\u2190 ' + decodeURIComponent(name) + '\u306e\u7d50\u679c\u306b\u623b\u308b';
          el.removeAttribute('href');
          el.onclick = function() { history.back(); };
        } else if (from === 'meta') {
          el.textContent = '\u2190 \u74b0\u5883\u5206\u6790\u306b\u623b\u308b';
          el.href = '../../meta.html';
        } else if (from === 'top') {
          el.textContent = '\u2190 \u30c8\u30c3\u30d7\u306b\u623b\u308b';
          el.href = '../../index.html';
        } else if (document.referrer) {
          var ref = document.referrer;
          if (ref.indexOf('/meta.html') !== -1) {
            el.textContent = '\u2190 \u74b0\u5883\u5206\u6790\u306b\u623b\u308b';
            el.removeAttribute('href');
            el.onclick = function() { history.back(); };
          } else if (ref.indexOf('/event.html') !== -1) {
            el.textContent = '\u2190 \u30a4\u30d9\u30f3\u30c8\u7d50\u679c\u306b\u623b\u308b';
            el.removeAttribute('href');
            el.onclick = function() { history.back(); };
          } else if (ref.indexOf('gcg-stats.com') !== -1 && (ref.endsWith('/') || ref.indexOf('/index.html') !== -1)) {
            el.textContent = '\u2190 \u30c8\u30c3\u30d7\u306b\u623b\u308b';
            el.removeAttribute('href');
            el.onclick = function() { history.back(); };
          } else {
            el.textContent = '\u2190 \u623b\u308b';
            el.removeAttribute('href');
            el.onclick = function() { history.back(); };
          }
        } else {
          el.textContent = '\u2190 \u623b\u308b';
          el.href = '../../index.html';
        }
      })();
    </script>

    <div style="display:flex;gap:24px;margin-bottom:32px;flex-wrap:wrap">
      <div style="flex-shrink:0">
        <img id="card-img" src="/images/cards/${cardId}.webp" alt="${escapeHtml(cardName)}"
             style="width:180px;border-radius:var(--radius-lg);border:1px solid var(--border);box-shadow:var(--shadow-md);cursor:zoom-in"
             onclick="openLightbox(this.src)"
             onerror="if(!this.dataset.retried){this.dataset.retried='1';this.src='/images/cards/${cardId}.webp?t='+Date.now();}else{this.onerror=null;this.style.display='none';}">
      </div>
      <div style="flex:1;min-width:300px">
        <h1 style="font-family:var(--font-mono);font-size:22px;margin-bottom:4px">${escapeHtml(cardName)}</h1>
        <p style="font-family:var(--font-mono);font-size:13px;color:var(--text-muted);margin:0 0 8px">${escapeHtml(cardId)}</p>
        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">${cardTypeBadges}
        </div>
        ${traitsHtml}
        ${sourceTitleHtml}
        <a href="https://www.gundam-gcg.com/jp/cards/index.php?freeword=${cardId}" target="_blank" rel="noopener"
           style="color:var(--blue);font-size:13px;text-decoration:none">
          \u516c\u5f0f\u30ab\u30fc\u30c9\u60c5\u5831\u3092\u898b\u308b \u2192
        </a>

        <div class="stats-grid" style="margin-top:16px">
          <div class="stat-card">
            <div class="stat-label">\u63a1\u7528\u30c7\u30c3\u30ad\u6570</div>
            <div class="stat-value">0<span class="unit"> \u30c7\u30c3\u30ad</span></div>
          </div>
          <div class="stat-card">
            <div class="stat-label">\u5168\u4f53\u63a1\u7528\u7387</div>
            <div class="stat-value">0<span class="unit">%</span></div>
          </div>
          <div class="stat-card">
            <div class="stat-label">\u512a\u52dd\u30c7\u30c3\u30ad\u6570</div>
            <div class="stat-value">0</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">\u5e73\u5747\u63a1\u7528\u679a\u6570</div>
            <div class="stat-value">0<span class="unit">\u679a</span></div>
          </div>
        </div>
        ${effectHtml}
      </div>
    </div>

    ${adoptionTableHtml}

    <div id="share-buttons" style="margin-top:24px"></div>
  </main>

  <footer class="site-footer">
    <div class="footer-disclaimer">
      \u672c\u30b5\u30a4\u30c8\u306f\u30ac\u30f3\u30c0\u30e0\u30ab\u30fc\u30c9\u30b2\u30fc\u30e0\u306e\u975e\u516c\u5f0f\u30d5\u30a1\u30f3\u30b5\u30a4\u30c8\u3067\u3059\u3002<br>
      \u30d0\u30f3\u30c0\u30a4\u30fb\u30b5\u30f3\u30e9\u30a4\u30ba\u306e\u8a8d\u53ef\u30fb\u8a31\u8afe\u306f\u5f97\u3066\u3044\u307e\u305b\u3093\u3002<br>
      \u6b32\u8f09\u60c5\u5831\u306f\u516c\u5f0f\u5927\u4f1a\u7d50\u679c\u3092\u57fa\u306b\u81ea\u52d5\u96c6\u8a08\u3057\u3066\u3044\u307e\u3059\u3002<br>
      &copy;SOTSU&middot;SUNRISE &copy;BANDAI
    </div>
    <div class="footer-links" style="margin-top:16px;display:flex;justify-content:center;gap:20px;font-size:11px;font-family:var(--font-mono)">
      <a href="../../privacy.html" style="color:var(--text-muted);text-decoration:none;transition:color 0.15s" onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--text-muted)'">\u30d7\u30e9\u30a4\u30d0\u30b7\u30fc\u30dd\u30ea\u30b7\u30fc</a>
      <a href="../../contact.html" style="color:var(--text-muted);text-decoration:none;transition:color 0.15s" onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--text-muted)'">\u304a\u554f\u3044\u5408\u308f\u305b</a>
    </div>
  </footer>

  <!-- Lightbox Modal -->
  <div id="lightbox" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:9999;cursor:zoom-out;justify-content:center;align-items:center"
       onclick="closeLightbox()">
    <img id="lightbox-img" src="" alt=""
         style="max-width:90vw;max-height:90vh;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,0.6);object-fit:contain;animation:lbFadeIn 0.2s ease">
    <button onclick="closeLightbox()" style="position:absolute;top:16px;right:20px;background:none;border:none;color:#fff;font-size:32px;cursor:pointer;opacity:0.7;transition:opacity 0.15s;line-height:1" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.7'">&times;</button>
  </div>
  <style>
    @keyframes lbFadeIn { from { opacity:0; transform:scale(0.92); } to { opacity:1; transform:scale(1); } }
  </style>
  <script>
    function openLightbox(src) {
      var lb = document.getElementById('lightbox');
      document.getElementById('lightbox-img').src = src;
      lb.style.display = 'flex';
      document.body.style.overflow = 'hidden';
    }
    function closeLightbox() {
      document.getElementById('lightbox').style.display = 'none';
      document.body.style.overflow = '';
    }
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') closeLightbox();
    });
  </script>

  <script src="../../js/common.js?v=5"></script>
  <script>
    GCG.renderShareButtons('share-buttons', '${escapeHtml(cardName)}\uff08${cardId}\uff09\u63a1\u7528\u73870% | GCG STATS');
  </script>
</body>
</html>`;
}

// GD04-001〜088のみフィルタ
const gd04Cards = Object.entries(cardsMaster)
  .filter(([id]) => {
    if (!id.startsWith('GD04-')) return false;
    const num = parseInt(id.split('-')[1]);
    return num >= 1 && num <= 88;
  })
  .sort(([a], [b]) => a.localeCompare(b));

console.log('[generate-card-pages-gd04] ' + gd04Cards.length + ' 枚のGD04カードページを生成...');

let generated = 0;
for (const [cardId, masterCard] of gd04Cards) {
  const html = generateCardPage(cardId, masterCard);
  const cardDir = path.join(CARDS_DIR, cardId);
  fs.mkdirSync(cardDir, { recursive: true });
  fs.writeFileSync(path.join(cardDir, 'index.html'), html, 'utf-8');
  generated++;
}

console.log('  -> ' + generated + ' ページ生成完了');
if (generated !== 88) {
  console.error('Warning: Expected 88 pages, got ' + generated);
} else {
  console.log('OK: 88ページ生成成功');
}
