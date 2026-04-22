#!/usr/bin/env node
/**
 * scripts/build-series-pages.js
 *
 * data/series.json と data/series/{slug}-summary.json, data/events.json から
 * /series/{slug}.html を静的生成する。
 *
 * 使い方: node scripts/build-series-pages.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SERIES_PATH = path.join(ROOT, 'data', 'series.json');
const SUMMARY_DIR = path.join(ROOT, 'data', 'series');
const EVENTS_PATH = path.join(ROOT, 'data', 'events.json');
const OUT_DIR = path.join(ROOT, 'series');

const SITE_URL = 'https://gcg-stats.com';

function loadJson(p) { return JSON.parse(fs.readFileSync(p, 'utf-8')); }

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function fmtDate(s) { return s ? s.replace(/-/g, '/') : ''; }

function statusLabel(status) {
  const m = {
    active:    { emoji: '\u{1F7E2}', text: '開催中', cls: 'status-active' },
    upcoming:  { emoji: '\u{1F7E1}', text: '予告',   cls: 'status-upcoming' },
    completed: { emoji: '\u26AB',    text: '終了',   cls: 'status-completed' }
  };
  return m[status] || m.completed;
}

function renderBreadcrumb(items) {
  const ol = items.map((it, idx) => {
    const isLast = idx === items.length - 1;
    const inner = isLast || !it.href ? '<span>' + esc(it.name) + '</span>'
                                     : '<a href="' + esc(it.href) + '">' + esc(it.name) + '</a>';
    return '<li' + (isLast ? ' aria-current="page"' : '') + '>' + inner + '</li>';
  }).join('');
  return '<nav class="breadcrumb" aria-label="パンくずリスト"><ol>' + ol + '</ol></nav>';
}

function renderBreadcrumbJsonLd(items) {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, idx) => {
      const el = { '@type': 'ListItem', position: idx + 1, name: it.name };
      if (it.href) el.item = /^https?:/.test(it.href) ? it.href : SITE_URL + it.href;
      return el;
    })
  };
  return '<script type="application/ld+json">' + JSON.stringify(data) + '</script>';
}

function renderDeckTypeTop10(stats) {
  const list = (stats.deck_type_ranking || []).slice(0, 10);
  if (list.length === 0) return '<p style="color:var(--text-muted);font-size:13px">データなし</p>';
  const rows = list.map((r, i) => {
    return '<tr>'
      + '<td style="width:40px;text-align:center;color:var(--text-muted)">' + (i + 1) + '</td>'
      + '<td>' + esc(r.label || r.type_key) + '</td>'
      + '<td style="text-align:right;font-variant-numeric:tabular-nums">' + r.count + 'デッキ</td>'
      + '<td style="text-align:right;font-variant-numeric:tabular-nums">' + r.share + ' %</td>'
      + '</tr>';
  }).join('');
  return '<table class="series-rank-table">'
    + '<thead><tr><th></th><th>デッキタイプ</th><th style="text-align:right">使用数</th><th style="text-align:right">使用率</th></tr></thead>'
    + '<tbody>' + rows + '</tbody></table>';
}

function renderWinningTop10(stats) {
  const list = (stats.winning_decks || []).slice(0, 10);
  if (list.length === 0) return '<p style="color:var(--text-muted);font-size:13px">データなし</p>';
  const rows = list.map((r, i) => {
    return '<tr>'
      + '<td style="width:40px;text-align:center;color:var(--text-muted)">' + (i + 1) + '</td>'
      + '<td>' + esc(r.label || r.type_key) + '</td>'
      + '<td style="text-align:right;font-variant-numeric:tabular-nums">' + r.wins + '回優勝</td>'
      + '<td style="text-align:right;font-variant-numeric:tabular-nums">勝率 ' + r.win_rate + ' %</td>'
      + '</tr>';
  }).join('');
  return '<table class="series-rank-table">'
    + '<thead><tr><th></th><th>デッキタイプ</th><th style="text-align:right">優勝数</th><th style="text-align:right">勝率(Top4出現のうち)</th></tr></thead>'
    + '<tbody>' + rows + '</tbody></table>';
}

function renderByRegion(stats) {
  const entries = Object.entries(stats.by_region || {}).sort((a, b) => b[1].events - a[1].events);
  if (entries.length === 0) return '<p style="color:var(--text-muted);font-size:13px">データなし</p>';
  const rows = entries.map(([reg, v]) => {
    return '<tr>'
      + '<td>' + esc(reg) + '</td>'
      + '<td style="text-align:right;font-variant-numeric:tabular-nums">' + v.events + ' 店舗</td>'
      + '<td style="text-align:right;font-variant-numeric:tabular-nums">' + v.decks + ' デッキ</td>'
      + '</tr>';
  }).join('');
  return '<table class="series-rank-table">'
    + '<thead><tr><th>地域</th><th style="text-align:right">開催店舗数</th><th style="text-align:right">Top4デッキ数</th></tr></thead>'
    + '<tbody>' + rows + '</tbody></table>';
}

function renderEventsList(seriesEvents) {
  if (seriesEvents.length === 0) return '<p style="color:var(--text-muted);font-size:13px">イベントデータなし</p>';
  // 日付新しい順
  seriesEvents.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const show = seriesEvents.slice(0, 30);
  const rows = show.map(ev => {
    const top4 = (ev.top4_colors || []).slice(0, 4).map(t => esc(t.colors ? t.colors.join('/') : '')).join(' / ');
    return '<a href="/events/' + encodeURIComponent(ev.event_id) + '.html" class="event-card">'
      + '<span class="event-date">' + fmtDate(ev.date) + '</span>'
      + '<span class="event-store">' + esc(ev.store) + '</span>'
      + '<span style="font-size:11px;color:var(--text-muted)">' + top4 + '</span>'
      + '</a>';
  }).join('');
  const more = seriesEvents.length > 30
    ? '<div style="margin-top:12px;text-align:center"><a href="/events.html" style="color:var(--accent);font-size:13px">全' + seriesEvents.length + '件を /events.html で見る →</a></div>'
    : '';
  return '<div id="event-list">' + rows + '</div>' + more;
}

function buildHtml(meta, stats, seriesEvents) {
  const sl = statusLabel(meta.status);
  const breadcrumbItems = [
    { name: 'トップ', href: '/' },
    { name: 'シリーズ一覧', href: '/series/' },
    { name: meta.short_name || meta.display_name }
  ];

  const sportsEventJsonLd = {
    '@context': 'https://schema.org',
    '@type': 'SportsEvent',
    name: meta.official_name,
    description: meta.description,
    startDate: meta.start_date,
    endDate: meta.end_date,
    eventStatus: meta.status === 'active'    ? 'https://schema.org/EventScheduled'
               : meta.status === 'upcoming'  ? 'https://schema.org/EventScheduled'
                                             : 'https://schema.org/EventScheduled',
    url: SITE_URL + '/series/' + meta.slug + '.html',
    location: {
      '@type': 'Place',
      name: '全国' + (stats ? stats.event_count : '') + '店舗'
    }
  };

  const html = [
    '<!DOCTYPE html>',
    '<html lang="ja">',
    '<head>',
    '  <script async src="https://www.googletagmanager.com/gtag/js?id=G-3MY17P4E7F"></script>',
    '  <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag(\'js\',new Date());gtag(\'config\',\'G-3MY17P4E7F\');</script>',
    '  <meta charset="UTF-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '  <title>' + esc(meta.official_name) + ' | GCG STATS</title>',
    '  <meta name="description" content="' + esc(meta.description) + '">',
    '  <link rel="canonical" href="' + SITE_URL + '/series/' + esc(meta.slug) + '.html">',
    '  <meta property="og:site_name" content="GCG STATS">',
    '  <meta property="og:locale" content="ja_JP">',
    '  <meta property="og:title" content="' + esc(meta.display_name) + ' | GCG STATS">',
    '  <meta property="og:description" content="' + esc(meta.description) + '">',
    '  <meta property="og:type" content="article">',
    '  <meta property="og:url" content="' + SITE_URL + '/series/' + esc(meta.slug) + '.html">',
    '  <meta property="og:image" content="' + SITE_URL + '/images/ogp-default.png">',
    '  <meta name="twitter:card" content="summary_large_image">',
    '  <link rel="preconnect" href="https://fonts.googleapis.com">',
    '  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">',
    '  <link rel="stylesheet" href="/css/style.css">',
    '  ' + renderBreadcrumbJsonLd(breadcrumbItems),
    '  <script type="application/ld+json">' + JSON.stringify(sportsEventJsonLd) + '</script>',
    '</head>',
    '<body>',
    '  <div id="header"></div>',
    '  <main class="container">',
    '    ' + renderBreadcrumb(breadcrumbItems),
    '    <div class="section-header">',
    '      <span class="status-badge ' + sl.cls + '">' + sl.emoji + ' ' + sl.text + '</span>',
    '      <h1 class="section-title" style="margin-top:6px">' + esc(meta.display_name) + '</h1>',
    '    </div>',
    '    <p style="color:var(--text-muted);font-size:13px;margin:0 0 4px">' + esc(meta.subtitle || '') + '</p>',
    '    <p style="color:var(--text-muted);font-size:13px;margin:0 0 4px">期間: ' + fmtDate(meta.start_date) + ' 〜 ' + fmtDate(meta.end_date) + '</p>',
    stats ? '    <p style="color:var(--text-muted);font-size:13px;margin:0 0 20px">' + stats.event_count + '店舗で開催、Top4記録デッキ数 ' + stats.total_decks + '</p>' : '',
    '    <p style="margin:0 0 24px">' + esc(meta.description) + '</p>',
    stats ? '    <section style="margin:32px 0">' : '',
    stats ? '      <h2 style="font-size:16px;color:var(--text-primary);margin:0 0 12px">このシリーズの使用率 Top10</h2>' : '',
    stats ? renderDeckTypeTop10(stats) : '',
    stats ? '      <p style="margin-top:8px"><a href="/meta.html" style="color:var(--accent);font-size:13px">環境分析で詳しく見る →</a></p>' : '',
    stats ? '    </section>' : '',
    stats ? '    <section style="margin:32px 0">' : '',
    stats ? '      <h2 style="font-size:16px;color:var(--text-primary);margin:0 0 12px">優勝デッキ Top10</h2>' : '',
    stats ? renderWinningTop10(stats) : '',
    stats ? '    </section>' : '',
    stats ? '    <section style="margin:32px 0">' : '',
    stats ? '      <h2 style="font-size:16px;color:var(--text-primary);margin:0 0 12px">地域別成績</h2>' : '',
    stats ? renderByRegion(stats) : '',
    stats ? '    </section>' : '',
    '    <section style="margin:32px 0">',
    '      <h2 style="font-size:16px;color:var(--text-primary);margin:0 0 12px">イベント一覧（' + seriesEvents.length + '件）</h2>',
    renderEventsList(seriesEvents),
    '    </section>',
    '  </main>',
    '  <div id="footer"></div>',
    '  <script src="/js/common.js"></script>',
    '  <script>',
    '    document.getElementById(\'header\').innerHTML = GCG.renderHeader(\'series\');',
    '    document.getElementById(\'footer\').innerHTML = GCG.renderFooter();',
    '    try { GCG.initHeaderSearch(); } catch (e) {}',
    '  </script>',
    '</body>',
    '</html>'
  ].filter(Boolean).join('\n');

  return html;
}

function main() {
  const seriesMap = loadJson(SERIES_PATH);
  const eventsJson = loadJson(EVENTS_PATH);
  const allEvents = Object.values(eventsJson.events || {});
  const today = new Date().toISOString().split('T')[0];

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const generated = [];
  for (const [id, meta] of Object.entries(seriesMap)) {
    // status 自動判定（summary と同じロジック）
    const status = today < meta.start_date ? 'upcoming'
                 : today > meta.end_date   ? 'completed'
                                           : 'active';
    const withStatus = Object.assign({}, meta, { status });

    // summary を読み込み（任意）
    let stats = null;
    const sumPath = path.join(SUMMARY_DIR, meta.slug + '-summary.json');
    if (fs.existsSync(sumPath)) {
      try {
        const j = loadJson(sumPath);
        stats = j.stats || null;
      } catch (e) {
        console.warn('summary 読み込み失敗: ' + sumPath + ' (' + e.message + ')');
      }
    }

    const seriesEvents = allEvents.filter(ev => String(ev.series_id) === String(id));

    const html = buildHtml(withStatus, stats, seriesEvents);
    const outPath = path.join(OUT_DIR, meta.slug + '.html');
    fs.writeFileSync(outPath, html, 'utf-8');
    generated.push({ slug: meta.slug, path: path.relative(ROOT, outPath), size: Buffer.byteLength(html, 'utf-8'), events: seriesEvents.length });
    console.log('wrote: ' + path.relative(ROOT, outPath) + ' (' + Buffer.byteLength(html, 'utf-8') + ' B, events=' + seriesEvents.length + ')');
  }

  console.log('\n=== build-series-pages 完了 (' + generated.length + ' ファイル) ===');
}

main();
