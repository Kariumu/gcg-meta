#!/usr/bin/env node
/**
 * generate.js
 * 静的HTML生成: index.html, events.html, meta.html にデータを直接埋め込み
 * Googleクローラーがコンテンツを読めるようにする
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');

// デッキカラー定義
const DECK_COLORS = {
  Blue:    { hex: '#4488ff', jp: '青' },
  Red:     { hex: '#ff4444', jp: '赤' },
  Green:   { hex: '#44cc64', jp: '緑' },
  White:   { hex: '#cccccc', jp: '白' },
  Purple:  { hex: '#b444ff', jp: '紫' },
  Unknown: { hex: '#888888', jp: '不明' }
};

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function deckTypeLabel(colors) {
  return colors.map(c => (DECK_COLORS[c] || DECK_COLORS.Unknown).jp).join('/');
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  return dateStr.replace(/-/g, '.');
}

function main() {
  console.log('[generate] 静的HTML埋め込みを開始...');

  const summary = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'summary.json'), 'utf-8'));
  const eventsData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'events.json'), 'utf-8'));

  generateIndex(summary, eventsData);
  generateEvents(summary, eventsData);
  generateMeta(summary, eventsData);

  console.log('[generate] 完了');
}

/**
 * SEO用の非表示コンテンツブロックを生成
 * JSで動的描画されるが、クローラー向けに静的テキストも埋め込む
 */
function seoBlock(html) {
  // noscript + hidden div の両方で提供
  return `
    <noscript>${html}</noscript>
    <div class="seo-content" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap">${html}</div>`;
}

// ========== index.html ==========
function generateIndex(summary, eventsData) {
  const filePath = path.join(ROOT, 'index.html');
  let content = fs.readFileSync(filePath, 'utf-8');

  // title と description を更新
  content = content.replace(
    /<title>[^<]*<\/title>/,
    '<title>GCG STATS - ガンダムカードゲーム 大会結果・環境分析</title>'
  );
  content = content.replace(
    /<meta name="description" content="[^"]*">/,
    '<meta name="description" content="ガンダムカードゲームのニュータイプチャレンジ大会結果を自動集計。カード採用率・デッキタイプ分布・地域別メタを分析する非公式ファンサイトです。">'
  );

  // SEOコンテンツを埋め込み（</main>の直前）
  const deckTypes = summary.deck_type_ranking || [];
  const events = Object.values(eventsData.events)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .slice(0, 20);

  let seoHtml = `<h2>大会データ概要</h2>`;
  seoHtml += `<p>全${summary.total_events}イベント、TOP4合計${summary.total_decks}デッキのデータを掲載しています。</p>`;

  seoHtml += `<h3>デッキタイプ分布</h3><ul>`;
  for (const dt of deckTypes) {
    seoHtml += `<li>${dt.label}：${dt.count}デッキ（シェア${dt.share}%、優勝率${dt.win_rate}%）</li>`;
  }
  seoHtml += `</ul>`;

  seoHtml += `<h3>最新イベント</h3><ul>`;
  for (const ev of events) {
    seoHtml += `<li><a href="events/${ev.event_id}.html">${formatDate(ev.date)} ${escapeHtml(ev.store)}</a></li>`;
  }
  seoHtml += `</ul>`;

  const seoInsert = seoBlock(seoHtml);

  // </main>の直前に挿入（既存のSEOブロックがあれば置換）
  content = content.replace(/\n\s*<noscript>[\s\S]*?<\/div>\s*(?=<\/main>)/g, '');
  content = content.replace('</main>', seoInsert + '\n  </main>');

  fs.writeFileSync(filePath, content, 'utf-8');
  console.log('  → index.html 更新');
}

// ========== events.html ==========
function generateEvents(summary, eventsData) {
  const filePath = path.join(ROOT, 'events.html');
  let content = fs.readFileSync(filePath, 'utf-8');

  const totalEvents = Object.keys(eventsData.events).length;
  const totalDecks = summary.total_decks;

  content = content.replace(
    /<title>[^<]*<\/title>/,
    '<title>イベント一覧 | GCG STATS</title>'
  );
  content = content.replace(
    /<meta name="description" content="[^"]*">/,
    `<meta name="description" content="ガンダムカードゲーム ニュータイプチャレンジの大会結果一覧。全国${totalEvents}件のイベント・${totalDecks}デッキのデータを掲載。">`
  );

  // SEOコンテンツ
  const events = Object.values(eventsData.events)
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  let seoHtml = `<h2>イベント一覧（全${totalEvents}件）</h2><ul>`;
  for (const ev of events) {
    const winner = (ev.results || []).find(r => r.rank === 1);
    seoHtml += `<li><a href="events/${ev.event_id}.html">${formatDate(ev.date)} ${escapeHtml(ev.store)}</a>`;
    if (winner) seoHtml += ` 優勝: ${escapeHtml(winner.player)}`;
    seoHtml += `</li>`;
  }
  seoHtml += `</ul>`;

  content = content.replace(/\n\s*<noscript>[\s\S]*?<\/div>\s*(?=<\/main>)/g, '');
  content = content.replace('</main>', seoBlock(seoHtml) + '\n  </main>');

  fs.writeFileSync(filePath, content, 'utf-8');
  console.log('  → events.html 更新');
}

// ========== meta.html ==========
function generateMeta(summary, eventsData) {
  const filePath = path.join(ROOT, 'meta.html');
  let content = fs.readFileSync(filePath, 'utf-8');

  content = content.replace(
    /<title>[^<]*<\/title>/,
    '<title>環境分析 | GCG STATS</title>'
  );
  content = content.replace(
    /<meta name="description" content="[^"]*">/,
    '<meta name="description" content="ガンダムカードゲームの環境メタ分析。デッキタイプ別シェア・カード採用率ランキング・地域別メタを数値で確認できます。">'
  );

  // SEOコンテンツ
  const deckTypes = summary.deck_type_ranking || [];
  const cardRanking = summary.card_ranking || [];
  const regionRanking = summary.region_ranking || [];

  let seoHtml = `<h2>環境分析データ</h2>`;

  seoHtml += `<h3>デッキタイプ別シェア</h3><ul>`;
  for (const dt of deckTypes) {
    seoHtml += `<li>${dt.label}：${dt.count}デッキ（シェア${dt.share}%、優勝${dt.wins}回、優勝率${dt.win_rate}%、平均順位${dt.avg_rank}）</li>`;
  }
  seoHtml += `</ul>`;

  seoHtml += `<h3>カード採用率ランキング（TOP30）</h3><ol>`;
  for (const card of cardRanking.slice(0, 30)) {
    seoHtml += `<li><a href="cards/${card.card_id}/">${card.card_id}</a>：採用率${card.usage_rate}%（${card.decks}デッキ、優勝${card.wins}回、平均${card.avg_count}枚）</li>`;
  }
  seoHtml += `</ol>`;

  seoHtml += `<h3>地域別メタ</h3><ul>`;
  for (const r of regionRanking) {
    const topTypes = (r.top_deck_types || []).slice(0, 3).map(t => t.label || '').join('、');
    seoHtml += `<li>${r.region}：${r.events}イベント・${r.decks}デッキ（上位: ${topTypes}）</li>`;
  }
  seoHtml += `</ul>`;

  content = content.replace(/\n\s*<noscript>[\s\S]*?<\/div>\s*(?=<\/main>)/g, '');
  content = content.replace('</main>', seoBlock(seoHtml) + '\n  </main>');

  fs.writeFileSync(filePath, content, 'utf-8');
  console.log('  → meta.html 更新');
}

main();
