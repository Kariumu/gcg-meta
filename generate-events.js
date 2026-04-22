#!/usr/bin/env node
/**
 * generate-events.js
 * イベント個別ページ (events/{event_id}.html) を静的生成し、sitemap.xml を更新する
 */

const fs = require('fs');
const path = require('path');
const { pushFiles } = require('./git-push');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const EVENTS_DIR = path.join(ROOT, 'events');
const SITE_URL = 'https://gcg-stats.com';

// カードマスターデータ（カード名表示用）
let cardsMaster = {};
try {
  cardsMaster = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'cards_master.json'), 'utf-8'));
} catch (e) {
  console.warn('  ⚠ cards_master.json が見つかりません。カードIDのみで生成します。');
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  return dateStr.replace(/-/g, '.');
}

function rankText(rank) {
  if (rank === 1) return '優勝';
  if (rank === 2) return '準優勝';
  return rank + '位';
}

function deckToText(deck) {
  if (!deck || deck.length === 0) return 'デッキ情報なし';
  return deck.map(c => {
    const name = cardsMaster[c.card_id] ? cardsMaster[c.card_id].name_jp : '';
    return name ? (c.card_id + '(' + name + ') x' + c.count) : (c.card_id + ' x' + c.count);
  }).join(', ');
}

function generateSeoContent(ev, seriesName) {
  const results = (ev.results || []).sort((a, b) => a.rank - b.rank);
  let h = '<h2>' + escapeHtml(ev.store) + ' 大会結果</h2>';
  h += '<p>開催日: ' + formatDate(ev.date) + '</p>';
  if (ev.region) h += '<p>地域: ' + escapeHtml(ev.region) + '</p>';
  if (seriesName) h += '<p>シリーズ: ' + escapeHtml(seriesName) + '</p>';
  h += '<h3>順位一覧</h3><ol>';
  for (const r of results) {
    h += '<li>' + rankText(r.rank) + ': ' + escapeHtml(r.player) + ' - デッキ: ' + escapeHtml(deckToText(r.deck)) + '</li>';
  }
  h += '</ol>';
  return h;
}

// クライアントサイドJSテンプレート（event.htmlからコピーし、パスを ../に調整）
// ${EVENT_ID} は生成時に置換される
const CLIENT_JS_TEMPLATE = `
    GCG.init();

    var currentEventStore = '';

    function renderPlayerCard(player, animDelay) {
      const hasDeck = player.deck && player.deck.length > 0;
      const tagClass = player.rank === 1 ? 'tag-win' : 'tag-rate';
      const delayStyle = animDelay !== undefined
        ? 'animation:fadeIn 0.4s ease-out backwards;animation-delay:' + animDelay + 's'
        : 'animation:fadeIn 0.4s ease-out backwards';

      let linkHtml = '';
      if (player.tcgplus_url) {
        linkHtml = '<a href="' + GCG.escapeHtml(player.tcgplus_url) + '" target="_blank" rel="noopener" class="btn-link">' +
          '\\u{1F517} BANDAI TCG+ \\u3067\\u898B\\u308B' +
          '<span style="font-size:10px;color:var(--text-muted);margin-left:2px">\\u203BTCG+\\u306B\\u9077\\u79FB\\u3057\\u307E\\u3059</span>' +
          '</a>';
      } else if (hasDeck) {
        linkHtml = '<button class="btn-copy" onclick="GCG.copyToClipboard(GCG.deckToText(' +
          JSON.stringify(player.deck).replace(/"/g, '&quot;') + '), this)">' +
          '\\u{1F4CB} \\u30C7\\u30C3\\u30AD\\u30EA\\u30B9\\u30C8\\u3092\\u30B3\\u30D4\\u30FC</button>';
      }

      let deckHtml = '';
      if (hasDeck) {
        deckHtml = '<div class="deck-grid">' +
          player.deck.map(function(card) {
            return '<a href="' + GCG.getBasePath() + 'cards/' + card.card_id + '/?from=event&name=' + encodeURIComponent(currentEventStore) + '" class="deck-card" title="' + card.card_id + '">' +
              '<img src="' + GCG.cardImageUrl(card.card_id) + '" alt="' + card.card_id + '"' +
              ' onerror="this.onerror=null;this.style.display=\\'none\\';this.parentElement.insertAdjacentHTML(\\'afterbegin\\',\\'<div style=&quot;aspect-ratio:63/88;background:var(--bg-elevated);display:flex;align-items:center;justify-content:center;font-size:10px;color:var(--text-muted);font-family:var(--font-mono);padding:4px;text-align:center&quot;>' + card.card_id + '</div>\\')">' +
              '<span class="card-count">\\u00D7' + card.count + '</span>' +
              '</a>';
          }).join('') +
          '</div>';
      } else {
        deckHtml = '<div style="color:var(--text-muted);font-size:13px;padding:16px 0">\\u30C7\\u30C3\\u30AD\\u60C5\\u5831\\u306A\\u3057</div>';
      }

      return '<div style="margin-bottom:36px;' + delayStyle + '">' +
        '<div style="display:flex;align-items:center;gap:14px;margin-bottom:14px;flex-wrap:wrap">' +
        '<span class="tag ' + tagClass + '" style="font-size:13px;min-width:52px;text-align:center">' +
        GCG.rankText(player.rank) + '</span>' +
        '<span style="font-size:16px;font-weight:600">' + GCG.escapeHtml(player.player) + '</span>' +
        linkHtml +
        '</div>' +
        deckHtml +
        '</div>';
    }

    async function renderEvent() {
      const data = await GCG.loadEvents();
      var eventId = '{{EVENT_ID}}';
      const ev = data.events[eventId];
      if (!ev) {
        document.getElementById('event-content').innerHTML = '<p>\\u30A4\\u30D9\\u30F3\\u30C8\\u304C\\u898B\\u3064\\u304B\\u308A\\u307E\\u305B\\u3093\\u3002</p>';
        return;
      }

      document.title = ev.store + ' ' + GCG.formatDate(ev.date) + ' - GCG STATS';
      currentEventStore = ev.store;

      // schedule.json\u304B\u3089organizer_id\u3092\u691C\u7D22
      var organizerId = null;
      try {
        var schedRes = await fetch(GCG.getBasePath() + 'data/schedule.json');
        var schedData = await schedRes.json();
        var stores = schedData.stores || {};
        Object.keys(stores).some(function(storeId) {
          if (stores[storeId].name === ev.store) {
            organizerId = storeId;
            return true;
          }
          return false;
        });
      } catch(e) {}

      var storeDisplay = GCG.escapeHtml(ev.store);
      if (organizerId) {
        storeDisplay = '<a href="' + GCG.getBasePath() + 'store.html?id=' + organizerId + '" style="color:var(--text-primary);text-decoration:none">' + GCG.escapeHtml(ev.store) + '</a>';
      }

      const seriesName = data.series[ev.series_id] || '';

      // パンくずリスト
      let breadcrumbHtml = '';
      if (typeof GCG.renderBreadcrumb === 'function') {
        var bcItems = [
          { name: 'トップ', href: GCG.getBasePath() },
          { name: 'イベント', href: GCG.getBasePath() + 'events.html' }
        ];
        if (seriesName && ev.series_id) {
          bcItems.push({ name: seriesName, href: GCG.getBasePath() + 'series/' });
        }
        bcItems.push({ name: ev.store + ' ' + GCG.formatDate(ev.date) });
        breadcrumbHtml = GCG.renderBreadcrumb(bcItems);
      }

      let html = breadcrumbHtml +
        '<div class="section-header"><div>' +
        '<h1 class="section-title" style="margin-bottom:6px;font-size:16px">' + storeDisplay + '</h1>' +
        '<div style="font-size:13px;color:var(--text-secondary);display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
        '<span class="text-mono" style="color:var(--accent)">' + GCG.formatDate(ev.date) + '</span>' +
        (seriesName ? '<span style="opacity:0.3">|</span> <span>' + GCG.escapeHtml(seriesName) + '</span>' : '') +
        '</div></div>' +
        '<span class="section-badge">' + (ev.results || []).length + '\\u540D\\u53C2\\u52A0</span></div>';

      const results = (ev.results || []).sort(function(a, b) { return a.rank - b.rank; });

      for (var i = 0; i < results.length; i++) {
        html += renderPlayerCard(results[i], i * 0.06);
      }

      // 関連大会セクションを構築
      try {
        var allEvs = Object.values(data.events || {});

        // 同店舗の過去大会（最大 5 件）
        var sameStore = allEvs
          .filter(function(e){ return e.event_id !== ev.event_id && e.store === ev.store; })
          .sort(function(a, b){ return (b.date || '').localeCompare(a.date || ''); })
          .slice(0, 5);

        // 同シリーズ±3日の大会（最大 10 件）
        var sameSeriesNearDate = [];
        if (ev.date) {
          var baseMs = Date.parse(ev.date);
          if (!isNaN(baseMs)) {
            var THREE_DAYS = 3 * 24 * 60 * 60 * 1000;
            sameSeriesNearDate = allEvs
              .filter(function(e){
                if (e.event_id === ev.event_id) return false;
                if (String(e.series_id) !== String(ev.series_id)) return false;
                if (!e.date) return false;
                var dMs = Date.parse(e.date);
                if (isNaN(dMs)) return false;
                return Math.abs(dMs - baseMs) <= THREE_DAYS;
              })
              .sort(function(a, b){
                var da = Math.abs(Date.parse(a.date) - baseMs);
                var db = Math.abs(Date.parse(b.date) - baseMs);
                return da - db;
              })
              .slice(0, 10);
          }
        }

        function relatedCard(e) {
          return '<a href="' + GCG.getBasePath() + 'events/' + encodeURIComponent(e.event_id) + '.html" class="event-card">' +
                 '<span class="event-date">' + GCG.formatDate(e.date) + '</span>' +
                 '<span class="event-store">' + GCG.escapeHtml(e.store) + '</span>' +
                 '</a>';
        }

        var relatedHtml = '';
        if (sameStore.length > 0) {
          relatedHtml += '<section style="margin:24px 0">' +
                         '<h2 style="font-size:15px;color:var(--text-primary);margin:16px 0 10px">同店舗の過去大会（' + sameStore.length + '件）</h2>' +
                         sameStore.map(relatedCard).join('') +
                         '</section>';
        }
        if (sameSeriesNearDate.length > 0) {
          relatedHtml += '<section style="margin:24px 0">' +
                         '<h2 style="font-size:15px;color:var(--text-primary);margin:16px 0 10px">同シリーズ±3日の大会（' + sameSeriesNearDate.length + '件）</h2>' +
                         sameSeriesNearDate.map(relatedCard).join('') +
                         '</section>';
        }
        html += relatedHtml;
      } catch(e) { /* 無視 */ }

      html += '<div id="share-buttons" style="margin-top:16px"></div>';
      document.getElementById('event-content').innerHTML = html;
      GCG.renderShareButtons('share-buttons', ev.store + ' ' + GCG.formatDate(ev.date) + ' \\u5927\\u4F1A\\u7D50\\u679C | GCG STATS');
    }

    document.getElementById('header').innerHTML = GCG.renderHeader('events');
    document.getElementById('footer').innerHTML = GCG.renderFooter();

    renderEvent();
`;

function generateEventPage(eventId, ev, seriesName) {
  const storeName = escapeHtml(ev.store);
  const dateFormatted = formatDate(ev.date);
  const winnerResult = (ev.results || []).find(r => r.rank === 1);
  const winnerName = winnerResult ? escapeHtml(winnerResult.player) : '';
  const seoContent = generateSeoContent(ev, seriesName);

  // クライアントJSのイベントIDを置換
  const clientJs = CLIENT_JS_TEMPLATE.replace('{{EVENT_ID}}', eventId);

  return '<!DOCTYPE html>\n' +
'<html lang="ja">\n' +
'<head>\n' +
'  <!-- Google Analytics -->\n' +
'  <script async src="https://www.googletagmanager.com/gtag/js?id=G-3MY17P4E7F"></script>\n' +
'  <script>\n' +
'    window.dataLayer = window.dataLayer || [];\n' +
'    function gtag(){dataLayer.push(arguments);}\n' +
'    gtag(\'js\', new Date());\n' +
'    gtag(\'config\', \'G-3MY17P4E7F\');\n' +
'  </script>\n' +
'  <meta charset="UTF-8">\n' +
'  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
'  <title>' + storeName + ' ' + dateFormatted + ' GCG大会結果 | GCG STATS</title>\n' +
'  <meta name="description" content="' + dateFormatted + ' ' + storeName + 'で開催されたガンダムカードゲーム ニュータイプチャレンジの大会結果。優勝: ' + winnerName + '">\n' +
'  <!-- OGP -->\n' +
'  <meta property="og:site_name" content="GCG STATS">\n' +
'  <meta property="og:locale" content="ja_JP">\n' +
'  <meta property="og:title" content="' + storeName + ' ' + dateFormatted + ' GCG大会結果 | GCG STATS">\n' +
'  <meta property="og:description" content="優勝: ' + winnerName + ' - ガンダムカードゲーム大会結果">\n' +
'  <meta property="og:type" content="article">\n' +
'  <meta property="og:url" content="' + SITE_URL + '/events/' + eventId + '.html">\n' +
'  <meta property="og:image" content="' + SITE_URL + '/images/ogp-default.png">\n' +
'  <meta name="twitter:card" content="summary_large_image">\n' +
'  <meta name="twitter:image" content="' + SITE_URL + '/images/ogp-default.png">\n' +
'  <link rel="canonical" href="' + SITE_URL + '/events/' + eventId + '.html">\n' +
'  <link rel="preconnect" href="https://fonts.googleapis.com">\n' +
'  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">\n' +
'  <link rel="stylesheet" href="../css/style.css">\n' +
'  <style>.section-title a:hover { text-decoration: underline; }</style>\n' +
'</head>\n' +
'<body>\n' +
'  <div id="header"></div>\n' +
'\n' +
'  <main class="container">\n' +
'    <div id="event-content">\n' +
'      <div class="loading">データを読み込み中</div>\n' +
'    </div>\n' +
'  </main>\n' +
'\n' +
'  <noscript>' + seoContent + '</noscript>\n' +
'  <div class="seo-content" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap">' + seoContent + '</div>\n' +
'\n' +
'  <div id="footer"></div>\n' +
'\n' +
'  <script src="../js/common.js?v=5"></script>\n' +
'  <script>\n' +
clientJs +
'  </script>\n' +
'</body>\n' +
'</html>';
}

function updateSitemap(eventIds) {
  const now = new Date().toISOString().split('T')[0];

  // 既存のカードページURLを保持
  let cardIds = [];
  try {
    const existing = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf-8');
    const matches = existing.match(/\/cards\/([^/]+)\//g);
    if (matches) {
      cardIds = [...new Set(matches.map(m => m.replace('/cards/', '').replace('/', '')))];
    }
  } catch (e) {}

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
'  <url>\n' +
'    <loc>' + SITE_URL + '/</loc>\n' +
'    <changefreq>daily</changefreq>\n' +
'    <priority>1.0</priority>\n' +
'    <lastmod>' + now + '</lastmod>\n' +
'  </url>\n' +
'  <url>\n' +
'    <loc>' + SITE_URL + '/events.html</loc>\n' +
'    <changefreq>daily</changefreq>\n' +
'    <priority>0.9</priority>\n' +
'    <lastmod>' + now + '</lastmod>\n' +
'  </url>\n' +
'  <url>\n' +
'    <loc>' + SITE_URL + '/meta.html</loc>\n' +
'    <changefreq>daily</changefreq>\n' +
'    <priority>0.9</priority>\n' +
'    <lastmod>' + now + '</lastmod>\n' +
'  </url>\n' +
'  <url>\n' +
'    <loc>' + SITE_URL + '/cards.html</loc>\n' +
'    <changefreq>weekly</changefreq>\n' +
'    <priority>0.8</priority>\n' +
'    <lastmod>' + now + '</lastmod>\n' +
'  </url>\n' +
'  <url>\n' +
'    <loc>' + SITE_URL + '/privacy.html</loc>\n' +
'    <changefreq>monthly</changefreq>\n' +
'    <priority>0.3</priority>\n' +
'  </url>\n' +
'  <url>\n' +
'    <loc>' + SITE_URL + '/contact.html</loc>\n' +
'    <changefreq>monthly</changefreq>\n' +
'    <priority>0.3</priority>\n' +
'  </url>\n';

  // イベントページ
  for (const eid of eventIds) {
    xml += '  <url>\n' +
'    <loc>' + SITE_URL + '/events/' + eid + '.html</loc>\n' +
'    <changefreq>monthly</changefreq>\n' +
'    <priority>0.6</priority>\n' +
'    <lastmod>' + now + '</lastmod>\n' +
'  </url>\n';
  }

  // カードページ
  for (const cid of cardIds) {
    xml += '  <url>\n' +
'    <loc>' + SITE_URL + '/cards/' + cid + '/</loc>\n' +
'    <changefreq>weekly</changefreq>\n' +
'    <priority>0.7</priority>\n' +
'    <lastmod>' + now + '</lastmod>\n' +
'  </url>\n';
  }

  xml += '</urlset>\n';
  fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), xml, 'utf-8');
}

function main() {
  console.log('=== イベント個別ページ生成 ===');

  const eventsData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'events.json'), 'utf-8'));
  const events = eventsData.events;
  const series = eventsData.series || {};
  const eventIds = Object.keys(events);

  console.log('  イベント数: ' + eventIds.length + ' 件');

  if (!fs.existsSync(EVENTS_DIR)) {
    fs.mkdirSync(EVENTS_DIR, { recursive: true });
  }

  let generated = 0;
  for (const eid of eventIds) {
    const ev = events[eid];
    const seriesName = series[ev.series_id] || '';
    const html = generateEventPage(eid, ev, seriesName);
    fs.writeFileSync(path.join(EVENTS_DIR, eid + '.html'), html, 'utf-8');
    generated++;
  }

  console.log('  → ' + generated + ' ページ生成完了');

  updateSitemap(eventIds);
  console.log('  → sitemap.xml 更新完了');

  // --push オプション付きで実行した場合、GitHub API経由でpush
  if (process.argv.includes('--push')) {
    const filesToPush = [];
    for (const eid of eventIds) {
      filesToPush.push({
        path: 'events/' + eid + '.html',
        content: fs.readFileSync(path.join(EVENTS_DIR, eid + '.html'), 'utf-8')
      });
    }
    filesToPush.push({
      path: 'sitemap.xml',
      content: fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf-8')
    });
    return pushFiles(filesToPush, `Update event pages (${generated} pages)`);
  }
}

main();
