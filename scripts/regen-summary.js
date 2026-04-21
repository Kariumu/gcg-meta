#!/usr/bin/env node
/**
 * scripts/regen-summary.js
 *
 * data/events.json から data/summary.json を再生成する。
 * 差分データマージ後などに呼び出す用途。
 *
 * 内部では scraper.js の generateSummary をそのまま使うため、
 * 本番スクレイピング時と完全に同じ集計ロジックで再計算される。
 *
 * 副作用: generateSummary は各 event に top4_colors / region を書き戻すため、
 *         新規追加イベント（これらの付加情報を持たない 59 件）にも自動的に付与される。
 */

const fs = require('fs');
const path = require('path');
const { generateSummary, generateMissingData } = require('../scraper.js');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const eventsFile = path.join(DATA_DIR, 'events.json');
const summaryFile = path.join(DATA_DIR, 'summary.json');

const existingData = JSON.parse(fs.readFileSync(eventsFile, 'utf-8'));
const before = {
  events: Object.keys(existingData.events).length,
  eventsWithTop4Colors: Object.values(existingData.events).filter(e => Array.isArray(e.top4_colors)).length,
  eventsWithRegion: Object.values(existingData.events).filter(e => e.region).length,
};

const summary = generateSummary(existingData);

// events.json は generateSummary により top4_colors / region が書き戻されるので更新して保存
fs.writeFileSync(eventsFile, JSON.stringify(existingData, null, 2), 'utf-8');
fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2), 'utf-8');

// 未取得データ一覧（missing_data.json）も再生成
generateMissingData(existingData);

const after = {
  events: Object.keys(existingData.events).length,
  eventsWithTop4Colors: Object.values(existingData.events).filter(e => Array.isArray(e.top4_colors)).length,
  eventsWithRegion: Object.values(existingData.events).filter(e => e.region).length,
};

console.log('=== summary 再生成完了 ===');
console.log('events.json:', eventsFile);
console.log('summary.json:', summaryFile);
console.log('event数:', after.events);
console.log(`top4_colors 保持: ${before.eventsWithTop4Colors} → ${after.eventsWithTop4Colors}`);
console.log(`region 保持   : ${before.eventsWithRegion} → ${after.eventsWithRegion}`);
console.log('total_events:', summary.total_events);
console.log('total_decks :', summary.total_decks);
console.log('card種数    :', summary.card_ranking.length);
console.log('deck_type数 :', summary.deck_type_ranking.length);
