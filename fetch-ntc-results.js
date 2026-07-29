#!/usr/bin/env node
/**
 * fetch-ntc-results.js  (E:\GCGSTATS 直下・常設 / 指示書51 Task1)
 *
 * 公式サイト(gundam-gcg.com/jp/tournament-results/)から NTC 大会結果を差分取得し、
 * data/events.json に追加 → scraper.saveData で集計再生成する。
 * 土台: .sched-run-tmp/fetch-ntc-june-6791.js（解析ロジック・2秒間隔・冪等スキップを踏襲）。
 *
 * 変更点:
 *  - 対象シリーズを自動決定（ハードコード廃止）: env NTC_SERIES > schedule.json の
 *    「ニュータイプチャレンジ」を含む series を series.json 登録済みに限定（String比較）。
 *  - DATE_FROM 既定=2026-08-01（env上書き可）、DATE_TO 省略時=無制限。
 *  - HTML取得は execSync(curl)（旧スクリプト踏襲）。理由: 公式サイト指定の日本語UA
 *    「(非公式ファンサイト)」を正確に送るため（Node https は非Latin-1ヘッダ不可で送信できない）。
 *    curl.exe が必要（Win10+標準搭載。scraper.downloadCardImages も curl を使用）。2秒間隔・リトライ付き。
 *    ※ 画像取得(scraper.downloadCardImages)は既存の curl 実装のまま（未取得カードのみ・data保存後に実行）。
 *  - 0件時は即終了（no-op＝push無し）。取得件数・シリーズ別内訳・所要時間をログ出力。
 */
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const { saveData } = require(path.join(ROOT, 'scraper.js'));

const BASE_URL = 'https://www.gundam-gcg.com/jp';
const TOURNAMENT_URL = `${BASE_URL}/tournament-results/`;
const USER_AGENT = 'GCG-META-FanSite/1.0 (非公式ファンサイト)';
const DELAY_MS = 2000;

const DATE_FROM = process.env.DATE_FROM || '2026-08-01';
const DATE_TO = process.env.DATE_TO || ''; // 空=無制限

// バッチ側が「新規>0か」を判定するためのセンチネル（.sched-run-tmp はpush対象外）
const SENTINEL = path.join(ROOT, '.sched-run-tmp', 'ntc-new-events.flag');
function setSentinel(n) {
  try {
    fs.mkdirSync(path.dirname(SENTINEL), { recursive: true });
    if (n > 0) fs.writeFileSync(SENTINEL, String(n), 'utf-8');
    else if (fs.existsSync(SENTINEL)) fs.unlinkSync(SENTINEL);
  } catch (e) { console.warn('  ⚠ sentinel更新失敗:', e.message); }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// --- HTML取得: execSync(curl)。日本語UAを正確に送るため。2秒間隔・指数バックオフ再試行 ---
async function fetchHTML(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const out = execSync(
        `curl -s -L --max-time 30 -H "User-Agent: ${USER_AGENT}" "${url}"`,
        { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
      );
      if (out && out.length > 0) return out;
      throw new Error('empty response');
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(1500 * (i + 1));
    }
  }
  console.error(`  [ERROR] fetch failed: ${url} (${lastErr && lastErr.message})`);
  return null;
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

// --- 対象シリーズ自動決定 ---
function determineTargetSeries() {
  // 1) env NTC_SERIES（カンマ区切り）が最優先
  if (process.env.NTC_SERIES) {
    const ids = process.env.NTC_SERIES.split(',').map(s => s.trim()).filter(Boolean);
    console.log(`対象シリーズ(env NTC_SERIES): ${ids.join(',')}`);
    return ids;
  }
  // 2) schedule.json の「ニュータイプチャレンジ」を含む series を抽出
  let sched;
  try { sched = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'schedule.json'), 'utf-8')); }
  catch (e) { console.error('  [ERROR] schedule.json 読込失敗:', e.message); return []; }
  const ntcIds = (sched.series || [])
    .filter(s => String(s.event_series_title || '').includes('ニュータイプチャレンジ'))
    .map(s => String(s.event_series_id)); // 数値→文字列（series.jsonキーは文字列）
  // 3) series.json 登録済みに限定（未登録シリーズは取り込まない）
  let reg = {};
  try { reg = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'series.json'), 'utf-8')); }
  catch (e) { console.warn('  ⚠ series.json 読込失敗（登録ガード無効）:', e.message); }
  const registered = ntcIds.filter(id => Object.prototype.hasOwnProperty.call(reg, id));
  const unregistered = ntcIds.filter(id => !Object.prototype.hasOwnProperty.call(reg, id));
  if (unregistered.length) {
    console.warn(`  ⚠ series.json 未登録のためスキップ: ${unregistered.join(',')}（登録手順が必要。発行元へ報告）`);
  }
  console.log(`対象シリーズ(schedule.json∩series.json): ${registered.join(',') || '(なし)'}`);
  return registered;
}

async function fetchEventList() {
  const html = await fetchHTML(TOURNAMENT_URL);
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

async function fetchEventResults(seriesId, eventId) {
  const url = `${BASE_URL}/tournament-results/event.php?series=${seriesId}&event=${eventId}`;
  const html = await fetchHTML(url);
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

async function fetchDeck(seriesId, eventId, deckNo) {
  const url = `${BASE_URL}/tournament-results/players_deck.php?series=${seriesId}&event=${eventId}&no=${deckNo}`;
  const html = await fetchHTML(url);
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
  const t0 = Date.now();
  console.log('=== NTC 大会結果 差分取得 (指示書51) ===');
  setSentinel(0); // 実行開始時にクリア（fetch中に例外終了しても前回の新規フラグが残り誤って再生成/deployされるのを防ぐ）

  const targetSeries = determineTargetSeries();
  if (targetSeries.length === 0) {
    console.log('対象シリーズなし。終了。');
    setSentinel(0);
    return;
  }
  const targetSet = new Set(targetSeries.map(String));
  console.log(`日付フィルタ: ${DATE_FROM} 〜 ${DATE_TO || '(無制限)'}`);

  const eventsFile = path.join(DATA_DIR, 'events.json');
  const existingData = JSON.parse(fs.readFileSync(eventsFile, 'utf-8'));
  const beforeCount = Object.keys(existingData.events).length;

  const allEvents = await fetchEventList();
  const targets = allEvents.filter(e =>
    targetSet.has(String(e.series_id)) &&
    e.date >= DATE_FROM && (!DATE_TO || e.date <= DATE_TO) &&
    !existingData.events[e.event_id]
  );

  // シリーズ別内訳
  const bySeries = {};
  for (const e of targets) bySeries[e.series_id] = (bySeries[e.series_id] || 0) + 1;
  console.log(`一覧total: ${allEvents.length} / 対象(未取得): ${targets.length}件`);
  console.log('  シリーズ別: ' + (Object.entries(bySeries).map(([s, n]) => `${s}=${n}`).join(', ') || '(なし)'));

  if (targets.length === 0) {
    console.log('対象なし（全て既取得 or 未掲載）。終了（no-op）。');
    setSentinel(0);
    return;
  }

  let processed = 0;
  for (const event of targets) {
    processed++;
    console.log(`[${processed}/${targets.length}] series ${event.series_id} ${event.date} ${event.store}`);
    await sleep(DELAY_MS);
    const results = await fetchEventResults(event.series_id, event.event_id);
    for (let i = 0; i < results.length; i++) {
      await sleep(DELAY_MS);
      const d = await fetchDeck(event.series_id, event.event_id, results[i].deck_no);
      results[i].deck = d.cards;
      results[i].tcgplus_url = d.tcgplus_url;
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

  console.log('[保存] saveData で集計再生成...');
  const summary = saveData(existingData);
  const afterCount = Object.keys(existingData.events).length;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log('=== 完了 ===');
  console.log(`  events: ${beforeCount} → ${afterCount} (+${afterCount - beforeCount})`);
  console.log(`  summary.total_decks: ${summary.total_decks}`);
  console.log(`  所要: ${elapsed}s`);
  const newCount = afterCount - beforeCount;
  setSentinel(newCount); // 新規>0でセンチネル作成、0で削除（バッチが再生成/deploy要否を判定）
  console.log(`  NEW_EVENTS=${newCount}`);
}

main().catch(e => { console.error('致命的エラー:', e.message); process.exit(1); });
