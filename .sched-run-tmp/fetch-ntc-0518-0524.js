#!/usr/bin/env node
/**
 * .sched-run-tmp/fetch-ntc-0518-0524.js
 *
 * NTC MISSION3 (series=6776) の 2026-05-18〜2026-05-24 開催イベント結果のみを
 * 差分取得し、data/events.json に追加 → scraper.saveData で集計再生成する。
 *
 * scraper.js の fetchEventResults / fetchDeck と同一の解析ロジックを使用。
 * (scraper.js はこれら fetch 関数を export していないため driver 内に複製)
 */

const { execSync } = require('child_process');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const { saveData } = require(path.join(ROOT, 'scraper.js'));

const BASE_URL = 'https://www.gundam-gcg.com/jp';
const TOURNAMENT_URL = `${BASE_URL}/tournament-results/`;
const USER_AGENT = 'GCG-META-FanSite/1.0 (非公式ファンサイト)';
const DELAY_MS = 2000;
const DATA_DIR = path.join(ROOT, 'data');

const TARGET_SERIES = '6776';
const DATE_FROM = process.env.DATE_FROM || '2026-05-11';
const DATE_TO = process.env.DATE_TO || '2026-05-24';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchHTML(url) {
  try {
    return execSync(
      `curl -s -L --max-time 30 -H "User-Agent: ${USER_AGENT}" "${url}"`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    );
  } catch (e) {
    console.error(`  [ERROR] fetch failed: ${url}`, e.message);
    return null;
  }
}

function parseDate(s) { return s ? s.trim().replace(/\./g, '-') : ''; }

function parseRank(rankText) {
  if (!rankText) return 0;
  rankText = rankText.trim();
  if (rankText === '優勝') return 1;
  if (rankText === '準優勝') return 2;
  const m = rankText.match(/(\d+)位/);
  return m ? parseInt(m[1], 10) : 0;
}

function fetchEventList() {
  const html = fetchHTML(TOURNAMENT_URL);
  if (!html) throw new Error('イベント一覧の取得に失敗');
  const $ = cheerio.load(html);
  const events = [];
  $('a.shopListDetailInner').each((_, el) => {
    const href = $(el).attr('href') || '';
    const timeEl = $(el).find('span.shopDate time');
    const dateText = timeEl.attr('datetime') || timeEl.text().trim();
    const store = $(el).find('h4.shopName').text().trim();
    const sm = href.match(/series=(\d+)/);
    const em = href.match(/event=(\d+)/);
    if (sm && em) {
      events.push({ series_id: sm[1], event_id: em[1], date: parseDate(dateText), store });
    }
  });
  return events;
}

function fetchEventResults(seriesId, eventId) {
  const url = `${BASE_URL}/tournament-results/event.php?series=${seriesId}&event=${eventId}`;
  const html = fetchHTML(url);
  if (!html) return [];
  const $ = cheerio.load(html);
  const results = [];
  $('li.userListDetail').each((idx, el) => {
    const rankText = $(el).find('span').first().text();
    const rank = parseRank(rankText);
    const player = $(el).find('h4.userInfoName').text().trim();
    const deckLink = $(el).find('a[href*="players_deck"]').attr('href') || '';
    const noMatch = deckLink.match(/no=(\d+)/);
    const deckNo = noMatch ? parseInt(noMatch[1], 10) : idx;
    results.push({ rank, player, deck_no: deckNo, deck: [] });
  });
  return results;
}

function fetchDeck(seriesId, eventId, deckNo) {
  const url = `${BASE_URL}/tournament-results/players_deck.php?series=${seriesId}&event=${eventId}&no=${deckNo}`;
  const html = fetchHTML(url);
  if (!html) return { cards: [], tcgplus_url: '' };
  const $ = cheerio.load(html);
  const cards = [];
  $('li').each((_, el) => {
    const img = $(el).find('img[src*="/cards/card/"]');
    const countEl = $(el).find('span.useCardsNum');
    if (img.length > 0) {
      const cardId = img.attr('alt') || '';
      const count = parseInt(countEl.text().trim(), 10) || 1;
      if (cardId) cards.push({ card_id: cardId, count });
    }
  });
  const tcgplusLink = $('a[href*="bandai-tcg-plus.com"]').attr('href') || '';
  return { cards, tcgplus_url: tcgplusLink };
}

async function main() {
  console.log('=== NTC 5/18〜5/24 差分取得 ===\n');

  const eventsFile = path.join(DATA_DIR, 'events.json');
  const existingData = JSON.parse(fs.readFileSync(eventsFile, 'utf-8'));
  const beforeCount = Object.keys(existingData.events).length;

  const allEvents = fetchEventList();
  const targets = allEvents.filter(e =>
    e.series_id === TARGET_SERIES &&
    e.date >= DATE_FROM && e.date <= DATE_TO &&
    !existingData.events[e.event_id]
  );

  console.log(`一覧total: ${allEvents.length} / 対象(${DATE_FROM}〜${DATE_TO}, series ${TARGET_SERIES}, 未取得): ${targets.length}件\n`);
  if (targets.length === 0) { console.log('対象なし。終了。'); return; }

  let processed = 0;
  for (const event of targets) {
    processed++;
    console.log(`[${processed}/${targets.length}] ${event.date} ${event.store}`);
    await sleep(DELAY_MS);
    const results = await fetchEventResults(event.series_id, event.event_id);
    for (let i = 0; i < results.length; i++) {
      await sleep(DELAY_MS);
      const d = fetchDeck(event.series_id, event.event_id, results[i].deck_no);
      results[i].deck = d.cards;
      results[i].tcgplus_url = d.tcgplus_url;
      console.log(`    ${results[i].rank}位 ${results[i].player}: ${results[i].deck.length}枚種${d.tcgplus_url ? ' [TCG+]' : ''}`);
    }
    existingData.events[event.event_id] = {
      series_id: event.series_id,
      event_id: event.event_id,
      date: event.date,
      store: event.store,
      results,
      fetched_at: new Date().toISOString()
    };
    if (processed % 10 === 0) {
      console.log('  [中間保存...]');
      saveData(existingData);
    }
  }

  console.log('\n[保存] saveData で集計再生成...');
  const summary = saveData(existingData);
  const afterCount = Object.keys(existingData.events).length;
  console.log(`\n=== 完了 ===`);
  console.log(`  events: ${beforeCount} → ${afterCount} (+${afterCount - beforeCount})`);
  console.log(`  summary.total_decks: ${summary.total_decks}`);
}

main().catch(e => { console.error('致命的エラー:', e.message); process.exit(1); });
