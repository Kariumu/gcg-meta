#!/usr/bin/env node
/**
 * generate_cards.js
 * カード個別ページ (cards/{card_id}/index.html) を生成し、sitemap.xml を更新する
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const CARDS_DIR = path.join(ROOT, 'cards');
const SITE_URL = 'https://gcg-stats.com';

// デッキカラー定義
const DECK_COLORS = {
  Blue:    { hex: '#4488ff', jp: '青', cssClass: 'c-blue' },
  Red:     { hex: '#ff4444', jp: '赤', cssClass: 'c-red' },
  Green:   { hex: '#44cc64', jp: '緑', cssClass: 'c-green' },
  White:   { hex: '#cccccc', jp: '白', cssClass: 'c-white' },
  Purple:  { hex: '#b444ff', jp: '紫', cssClass: 'c-purple' },
  Unknown: { hex: '#888888', jp: '不明', cssClass: '' }
};

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function renderColorTags(colors) {
  return colors.map(c => {
    const info = DECK_COLORS[c] || DECK_COLORS.Unknown;
    return `<span class="color-tag color-tag-${c.toLowerCase()}">${info.jp}</span>`;
  }).join(' ');
}

function primaryColorHex(colors) {
  if (!colors || colors.length === 0) return '#888';
  return (DECK_COLORS[colors[0]] || DECK_COLORS.Unknown).hex;
}

function rankText(rank) {
  if (rank === 1) return '優勝';
  if (rank === 2) return '準優勝';
  return `${rank}位`;
}

function rankClass(rank) {
  if (rank <= 3) return `rank-${rank}`;
  return '';
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  return dateStr.replace(/-/g, '.');
}

function main() {
  console.log('[generate_cards] カード個別ページ生成を開始...');

  const summary = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'summary.json'), 'utf-8'));
  const eventsData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'events.json'), 'utf-8'));

  const cardRanking = summary.card_ranking || [];
  const deckTypes = summary.deck_type_ranking || [];

  console.log(`  カード数: ${cardRanking.length}`);

  const generatedCardIds = [];

  for (const card of cardRanking) {
    const cardId = card.card_id;
    generatedCardIds.push(cardId);

    // デッキタイプ別採用状況
    const typeUsage = [];
    for (const dt of deckTypes) {
      const c = (dt.card_ranking || []).find(x => x.card_id === cardId);
      if (c) {
        typeUsage.push({
          label: dt.label,
          colors: dt.colors,
          deckCount: dt.count,
          adoptionCount: c.decks,
          usageRate: c.usage_rate,
          avgCount: c.avg_count
        });
      }
    }

    // TOP4採用実績
    const adoptions = [];
    for (const ev of Object.values(eventsData.events)) {
      for (const result of (ev.results || [])) {
        if (result.rank > 4) continue;
        const c = (result.deck || []).find(x => x.card_id === cardId);
        if (c) {
          adoptions.push({
            eventId: ev.event_id,
            date: ev.date,
            store: ev.store,
            player: result.player,
            rank: result.rank,
            count: c.count
          });
        }
      }
    }
    adoptions.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    const html = generateCardPage(cardId, card, typeUsage, adoptions, summary);

    const cardDir = path.join(CARDS_DIR, cardId);
    fs.mkdirSync(cardDir, { recursive: true });
    fs.writeFileSync(path.join(cardDir, 'index.html'), html, 'utf-8');
  }

  console.log(`  → ${generatedCardIds.length} ページ生成完了`);

  // sitemap.xml 更新
  updateSitemap(generatedCardIds);
  console.log('  → sitemap.xml 更新完了');
}

function generateCardPage(cardId, card, typeUsage, adoptions, summary) {
  const usageRate = card.usage_rate;
  const decks = card.decks;
  const wins = card.wins;
  const avgCount = card.avg_count;
  const totalDecks = summary.total_decks;

  const description = `${cardId}のニュータイプチャレンジ大会での採用率は${usageRate}%。${decks}デッキで採用されています。GCG STATSで詳細な使用データを確認できます。`;

  // デッキタイプ別テーブル
  let typeTableHtml = '';
  if (typeUsage.length > 0) {
    const rows = typeUsage.map(tu => `
              <tr>
                <td>${renderColorTags(tu.colors)}</td>
                <td class="text-mono">${tu.adoptionCount} / ${tu.deckCount}</td>
                <td>
                  <div class="flex items-center gap-8">
                    <div class="usage-bar-container">
                      <div class="usage-bar" style="width:${tu.usageRate}%;background:${primaryColorHex(tu.colors)}"></div>
                    </div>
                    <span class="usage-rate">${tu.usageRate}%</span>
                  </div>
                </td>
                <td class="text-mono">${tu.avgCount}</td>
              </tr>`).join('');

    typeTableHtml = `
        <section class="mb-32">
          <div class="section-header">
            <h2 class="section-title">デッキタイプ別採用状況</h2>
          </div>
          <table class="data-table">
            <thead>
              <tr>
                <th>デッキタイプ</th>
                <th style="width:90px">採用数</th>
                <th style="width:180px">採用率</th>
                <th style="width:60px">平均枚数</th>
              </tr>
            </thead>
            <tbody>${rows}
            </tbody>
          </table>
        </section>`;
  }

  // TOP4採用実績テーブル
  let adoptionTableHtml = '';
  const displayAdoptions = adoptions.slice(0, 100);
  if (displayAdoptions.length > 0) {
    const rows = displayAdoptions.map(a => `
              <tr>
                <td class="text-mono" style="color:var(--accent)">${formatDate(a.date)}</td>
                <td><a href="../../event.html?id=${a.eventId}" style="color:var(--text-primary);text-decoration:none">${escapeHtml(a.store)}</a></td>
                <td>${escapeHtml(a.player)}</td>
                <td class="rank-cell ${rankClass(a.rank)}">${rankText(a.rank)}</td>
                <td class="text-mono">×${a.count}</td>
              </tr>`).join('');

    adoptionTableHtml = `
        <section>
          <div class="section-header">
            <h2 class="section-title">TOP4 採用実績</h2>
            <span class="section-badge">${adoptions.length}件</span>
          </div>
          <table class="data-table">
            <thead>
              <tr>
                <th>日付</th>
                <th>店舗</th>
                <th>プレイヤー</th>
                <th style="width:60px">順位</th>
                <th style="width:60px">枚数</th>
              </tr>
            </thead>
            <tbody>${rows}
            </tbody>
          </table>
          ${adoptions.length > 100 ? '<p style="text-align:center;margin-top:16px;color:var(--text-muted);font-size:13px">最新100件を表示</p>' : ''}
        </section>`;
  } else {
    adoptionTableHtml = `
        <section>
          <div class="section-header">
            <h2 class="section-title">TOP4 採用実績</h2>
            <span class="section-badge">0件</span>
          </div>
          <div style="text-align:center;padding:32px;color:var(--text-muted)">TOP4での採用実績がありません</div>
        </section>`;
  }

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
  <title>${escapeHtml(cardId)} の大会採用率・使用デッキ | GCG STATS</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta property="og:title" content="${escapeHtml(cardId)} の大会採用率・使用デッキ | GCG STATS">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="${SITE_URL}/cards/${cardId}/">
  <meta property="og:image" content="https://www.gundam-gcg.com/jp/images/cards/card/${cardId}.webp">
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
      </nav>
    </div>
  </header>

  <main class="container">
    <div style="margin-bottom:12px">
      <a href="../../meta.html" style="color:var(--text-muted);text-decoration:none;font-size:13px;transition:color 0.15s"
         onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--text-muted)'">
        ← 環境分析に戻る
      </a>
    </div>

    <div style="display:flex;gap:24px;margin-bottom:32px;flex-wrap:wrap">
      <div style="flex-shrink:0">
        <img src="../../images/cards/${cardId}.webp" alt="${escapeHtml(cardId)}"
             style="width:180px;border-radius:var(--radius-lg);border:1px solid var(--border);box-shadow:var(--shadow-md)"
             onerror="this.src='https://www.gundam-gcg.com/jp/images/cards/card/${cardId}.webp';this.onerror=null;">
      </div>
      <div style="flex:1;min-width:300px">
        <h1 style="font-family:var(--font-mono);font-size:22px;margin-bottom:8px">${escapeHtml(cardId)}</h1>
        <a href="https://www.gundam-gcg.com/jp/cards/${cardId}" target="_blank" rel="noopener"
           style="color:var(--blue);font-size:13px;text-decoration:none">
          公式カード情報を見る →
        </a>

        <div class="stats-grid" style="margin-top:16px">
          <div class="stat-card">
            <div class="stat-label">TOP4 採用数</div>
            <div class="stat-value">${decks}<span class="unit"> / ${totalDecks}</span></div>
          </div>
          <div class="stat-card">
            <div class="stat-label">TOP4 採用率</div>
            <div class="stat-value">${usageRate}<span class="unit">%</span></div>
          </div>
          <div class="stat-card">
            <div class="stat-label">優勝デッキ数</div>
            <div class="stat-value">${wins}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">平均採用枚数</div>
            <div class="stat-value">${avgCount}<span class="unit">枚</span></div>
          </div>
        </div>
      </div>
    </div>

    ${typeTableHtml}
    ${adoptionTableHtml}
  </main>

  <footer class="site-footer">
    <div class="footer-disclaimer">
      本サイトはガンダムカードゲームの非公式ファンサイトです。<br>
      バンダイ・サンライズの認可・許諾は得ていません。<br>
      掲載情報は公式大会結果を基に自動集計しています。<br>
      ©SOTSU・SUNRISE ©BANDAI
    </div>
    <div class="footer-links" style="margin-top:16px;display:flex;justify-content:center;gap:20px;font-size:11px;font-family:var(--font-mono)">
      <a href="../../privacy.html" style="color:var(--text-muted);text-decoration:none;transition:color 0.15s" onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--text-muted)'">プライバシーポリシー</a>
      <a href="../../contact.html" style="color:var(--text-muted);text-decoration:none;transition:color 0.15s" onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--text-muted)'">お問い合わせ</a>
    </div>
  </footer>

  <script src="../../js/common.js?v=2"></script>
</body>
</html>`;
}

function updateSitemap(cardIds) {
  const now = new Date().toISOString().split('T')[0];

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${SITE_URL}/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
    <lastmod>${now}</lastmod>
  </url>
  <url>
    <loc>${SITE_URL}/events.html</loc>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
    <lastmod>${now}</lastmod>
  </url>
  <url>
    <loc>${SITE_URL}/meta.html</loc>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
    <lastmod>${now}</lastmod>
  </url>
  <url>
    <loc>${SITE_URL}/privacy.html</loc>
    <changefreq>monthly</changefreq>
    <priority>0.3</priority>
  </url>
  <url>
    <loc>${SITE_URL}/contact.html</loc>
    <changefreq>monthly</changefreq>
    <priority>0.3</priority>
  </url>
`;

  for (const cardId of cardIds) {
    xml += `  <url>
    <loc>${SITE_URL}/cards/${cardId}/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
    <lastmod>${now}</lastmod>
  </url>
`;
  }

  xml += `</urlset>
`;

  fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), xml, 'utf-8');
}

main();
