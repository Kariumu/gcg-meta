#!/usr/bin/env node
/**
 * GCG STATS スクレイパー
 * 公式サイトから大会結果を取得し、events.json / summary.json を生成する
 *
 * Usage:
 *   node scraper.js         # 差分のみ取得（通常実行）
 *   node scraper.js --full  # 全件再取得
 */

const { execSync } = require('child_process');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { pushFiles } = require('./git-push');

// === 設定 ===
const BASE_URL = 'https://www.gundam-gcg.com/jp';
const TOURNAMENT_URL = `${BASE_URL}/tournament-results/`;
const USER_AGENT = 'GCG-META-FanSite/1.0 (非公式ファンサイト)';
const DELAY_MS = 2000; // リクエスト間隔（2秒）
const DATA_DIR = path.join(__dirname, 'data');

// === ユーティリティ ===

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * curlでHTMLを取得（axiosはリダイレクト問題があるため）
 */
function fetchHTML(url) {
  try {
    const result = execSync(
      `curl -s -L --max-time 30 -H "User-Agent: ${USER_AGENT}" "${url}"`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    );
    return result;
  } catch (e) {
    console.error(`  [ERROR] fetch failed: ${url}`, e.message);
    return null;
  }
}

/**
 * 日付文字列をYYYY-MM-DD形式に変換
 * "2026.03.15" → "2026-03-15"
 */
function parseDate(dateStr) {
  if (!dateStr) return '';
  return dateStr.trim().replace(/\./g, '-');
}

/**
 * 順位テキストを数値に変換
 * "優勝" → 1, "準優勝" → 2, "3位" → 3, ...
 */
function parseRank(rankText) {
  if (!rankText) return 0;
  rankText = rankText.trim();
  if (rankText === '優勝') return 1;
  if (rankText === '準優勝') return 2;
  const match = rankText.match(/(\d+)位/);
  return match ? parseInt(match[1], 10) : 0;
}

// === メイン処理 ===

/**
 * イベント一覧ページからシリーズ情報とイベントリストを取得
 */
async function fetchEventList() {
  console.log('[1/3] イベント一覧を取得中...');
  const html = fetchHTML(TOURNAMENT_URL);
  if (!html) throw new Error('イベント一覧ページの取得に失敗しました');

  const $ = cheerio.load(html);

  // シリーズ情報（ドロップダウンはJS動的生成のためハードコード＋イベントリンクから自動検出）
  const series = {
    '6226': 'ニュータイプチャレンジ 2026 MISSION2（3月開催）'
  };
  let currentSeriesId = null;

  // イベントリンクを収集
  const events = [];
  $('a.shopListDetailInner').each((_, el) => {
    const href = $(el).attr('href') || '';
    const timeEl = $(el).find('span.shopDate time');
    const storeEl = $(el).find('h4.shopName');

    const dateText = timeEl.attr('datetime') || timeEl.text().trim();
    const store = storeEl.text().trim();

    // URLからseries_idとevent_idを抽出
    const seriesMatch = href.match(/series=(\d+)/);
    const eventMatch = href.match(/event=(\d+)/);

    if (seriesMatch && eventMatch) {
      events.push({
        series_id: seriesMatch[1],
        event_id: eventMatch[1],
        date: parseDate(dateText),
        store: store,
        url: href.startsWith('http') ? href : `${BASE_URL}/tournament-results/${href}`
      });
    }
  });

  // イベントリンクからシリーズIDを自動検出
  const detectedSeriesIds = [...new Set(events.map(e => e.series_id))];
  if (detectedSeriesIds.length > 0) {
    currentSeriesId = detectedSeriesIds[0];
  }

  console.log(`  シリーズ数: ${Object.keys(series).length}`);
  console.log(`  現在のシリーズ: ${currentSeriesId} (${series[currentSeriesId] || '不明'})`);
  console.log(`  イベント数: ${events.length}`);

  return { series, currentSeriesId, events };
}

/**
 * 個別イベントページから結果（1〜8位）を取得
 */
async function fetchEventResults(seriesId, eventId) {
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

    // deck_noを抽出
    const noMatch = deckLink.match(/no=(\d+)/);
    const deckNo = noMatch ? parseInt(noMatch[1], 10) : idx;

    results.push({
      rank,
      player,
      deck_no: deckNo,
      deck: [] // デッキ詳細は別途取得
    });
  });

  return results;
}

/**
 * デッキページからカードリストとTCG+リンクを取得
 */
async function fetchDeck(seriesId, eventId, deckNo) {
  const url = `${BASE_URL}/tournament-results/players_deck.php?series=${seriesId}&event=${eventId}&no=${deckNo}`;
  const html = fetchHTML(url);
  if (!html) return { cards: [], tcgplus_url: '' };

  const $ = cheerio.load(html);
  const cards = [];

  // カードIDと枚数を取得（カード画像のみフィルタ）
  $('li').each((_, el) => {
    const img = $(el).find('img[src*="/cards/card/"]');
    const countEl = $(el).find('span.useCardsNum');

    if (img.length > 0) {
      const cardId = img.attr('alt') || '';
      const countText = countEl.text().trim();
      const count = parseInt(countText, 10) || 1;

      if (cardId) {
        cards.push({ card_id: cardId, count });
      }
    }
  });

  // TCG+リンクを取得
  const tcgplusLink = $('a[href*="bandai-tcg-plus.com"]').attr('href') || '';

  return { cards, tcgplus_url: tcgplusLink };
}

// === カード色判定 ===

// 個別カード色マッピング（card_colors.jsonから読み込み）
let CARD_COLORS = {};
const cardColorsPath = path.join(DATA_DIR, 'card_colors.json');
if (fs.existsSync(cardColorsPath)) {
  try {
    CARD_COLORS = JSON.parse(fs.readFileSync(cardColorsPath, 'utf-8'));
    console.log(`  カード色データ: ${Object.keys(CARD_COLORS).length}枚読み込み`);
  } catch (e) {
    console.warn('  カード色データの読み込みに失敗:', e.message);
  }
}

// フォールバック: セットIDからのデフォルト色
const SET_COLORS = {
  'ST01': 'Blue', 'ST02': 'Blue', 'ST03': 'Red', 'ST04': 'White',
  'ST05': 'Green', 'ST06': 'Red', 'ST07': 'Purple', 'ST08': 'Blue', 'ST09': 'White'
};

/**
 * カードIDから色を取得
 * card_colors.jsonの個別データを優先、なければセットIDから推定
 */
function getCardColor(cardId) {
  if (CARD_COLORS[cardId]) return CARD_COLORS[cardId];
  const prefix = cardId.split('-')[0];
  return SET_COLORS[prefix] || 'Unknown';
}

/**
 * デッキのカードリストからデッキの色（タイプ）を判定
 * 各カードの色×枚数を集計し、閾値以上の色をデッキタイプとする
 */
function getDeckColors(cards) {
  const colorCount = {};
  let total = 0;
  for (const card of cards) {
    const color = getCardColor(card.card_id);
    if (color === 'Unknown' || color === 'Colorless') continue;
    colorCount[color] = (colorCount[color] || 0) + card.count;
    total += card.count;
  }
  if (total === 0) return ['Unknown'];

  const colorOrder = ['Blue', 'Red', 'Green', 'White', 'Purple'];
  // 1枚以上ある色をすべて含む
  return Object.entries(colorCount)
    .filter(([_, count]) => count >= 1)
    .sort((a, b) => b[1] - a[1])
    .map(([color]) => color)
    .sort((a, b) => colorOrder.indexOf(a) - colorOrder.indexOf(b));
}

/**
 * summary.jsonを生成
 * - TOP4のみ集計（rank <= 4）
 * - デッキデータなしを除外
 * - デッキタイプ別カード採用率を生成
 */
// === 地域判定 ===
// shop_master.json から店舗→地域マッピングを読み込み
let SHOP_MASTER = {};
const shopMasterPath = path.join(DATA_DIR, 'shop_master.json');
if (fs.existsSync(shopMasterPath)) {
  try {
    SHOP_MASTER = JSON.parse(fs.readFileSync(shopMasterPath, 'utf-8'));
    console.log(`  店舗マスター: ${Object.keys(SHOP_MASTER).length}店舗読み込み`);
  } catch (e) {
    console.warn('  店舗マスターの読み込みに失敗:', e.message);
  }
}

// フォールバック用キーワード（shop_masterに未登録の店舗向け）
const REGION_KEYWORDS = {
  '北海道': ['北海道','札幌'],
  '東北': ['仙台','盛岡','山形','鶴岡','福島','郡山','秋田','青森','岩手','いわき'],
  '関東': ['東京','渋谷','新宿','秋葉原','池袋','横浜','川崎','千葉','埼玉','大宮','茨城','栃木','群馬','北千住','錦糸町','町田','津田沼','八王子'],
  '中部': ['名古屋','大須','岐阜','静岡','浜松','新潟','長野','金沢','甲府','西尾','津店'],
  '関西': ['大阪','梅田','難波','なんば','京都','神戸','姫路','高槻','天王寺'],
  '中国': ['広島','岡山','福山','山口','倉敷','下関'],
  '四国': ['高松','松山','高知','徳島'],
  '九州': ['福岡','天神','博多','小倉','熊本','鹿児島','長崎','佐賀','大分','宮崎','沖縄','那覇']
};

// 正規化: スペース・記号のゆれを吸収
function normalizeStoreName(name) {
  return name.replace(/[\s\u3000ー―\-–—・]/g, '').replace(/[（(]/g, '(').replace(/[）)]/g, ')');
}

function getRegion(storeName) {
  // 1. shop_masterで完全一致
  if (SHOP_MASTER[storeName]) return SHOP_MASTER[storeName].region;
  // 2. 正規化して一致
  const norm = normalizeStoreName(storeName);
  for (const [name, info] of Object.entries(SHOP_MASTER)) {
    if (normalizeStoreName(name) === norm) return info.region;
  }
  // 3. shop_masterで部分一致（店舗名が微妙に異なるケース対策）
  for (const [name, info] of Object.entries(SHOP_MASTER)) {
    if (storeName.includes(name) || name.includes(storeName)) return info.region;
  }
  // 4. フォールバック: キーワード判定
  for (const [region, keywords] of Object.entries(REGION_KEYWORDS)) {
    for (const kw of keywords) {
      if (storeName.includes(kw)) return region;
    }
  }
  return 'その他';
}

function generateSummary(eventsData) {
  const allEvents = Object.values(eventsData.events);
  const totalEvents = allEvents.length;
  let totalDecks = 0;
  const deckTypeStats = {};
  const regionStats = {};

  // Pass 1: TOP4のみ、デッキデータありのみ集計
  for (const event of allEvents) {
    const region = getRegion(event.store || '');

    // 地域別イベント集計
    if (!regionStats[region]) {
      regionStats[region] = { events: 0, decks: 0, wins: {}, deck_types: {} };
    }
    regionStats[region].events++;

    // TOP4のデッキカラーをイベントに付与
    const top4Colors = [];

    for (const result of (event.results || [])) {
      // TOP4のみ
      if (result.rank > 4) continue;
      // デッキデータなしを除外
      if (!result.deck || result.deck.length === 0) continue;

      totalDecks++;
      const isWinner = result.rank === 1;
      const colors = getDeckColors(result.deck);
      const typeKey = colors.join('+');

      top4Colors.push({ rank: result.rank, colors, type_key: typeKey });

      // 地域別デッキタイプ集計
      regionStats[region].decks++;
      if (!regionStats[region].deck_types[typeKey]) {
        regionStats[region].deck_types[typeKey] = { colors, count: 0, wins: 0 };
      }
      regionStats[region].deck_types[typeKey].count++;
      if (isWinner) regionStats[region].deck_types[typeKey].wins++;

      if (!deckTypeStats[typeKey]) {
        deckTypeStats[typeKey] = {
          colors,
          count: 0,
          wins: 0,
          rank_sum: 0,
          card_stats: {}
        };
      }
      const dt = deckTypeStats[typeKey];
      dt.count++;
      if (isWinner) dt.wins++;
      dt.rank_sum += result.rank;

      // デッキタイプ別カード集計（max_count, min_count追加）
      const cardCountsInDeck = {};
      for (const card of result.deck) {
        cardCountsInDeck[card.card_id] = (cardCountsInDeck[card.card_id] || 0) + card.count;
      }

      for (const [cardId, count] of Object.entries(cardCountsInDeck)) {
        if (!dt.card_stats[cardId]) {
          dt.card_stats[cardId] = { decks: 0, wins: 0, total_count: 0, max_count: 0, min_count: Infinity, counts: [] };
        }
        const cs = dt.card_stats[cardId];
        cs.decks++;
        if (isWinner) cs.wins++;
        cs.total_count += count;
        cs.max_count = Math.max(cs.max_count, count);
        cs.min_count = Math.min(cs.min_count, count);
        cs.counts.push(count);
      }
    }

    // イベントにTOP4デッキカラー情報を付与
    event.top4_colors = top4Colors;
    // イベントに地域情報を付与
    event.region = region;
  }

  // デッキタイプランキング生成（デッキ数降順）
  const COLOR_JP = { Blue: '青', Red: '赤', Green: '緑', White: '白', Purple: '紫', Unknown: '不明' };
  const deckTypeRanking = Object.entries(deckTypeStats)
    .map(([key, stats]) => {
      // デッキタイプ別カード採用率
      // ソート順: 採用率→採用数→優勝率→優勝数→最大枚数→平均枚数
      const cardRanking = Object.entries(stats.card_stats)
        .map(([cardId, cs]) => {
          const usageRate = stats.count > 0 ? Math.round((cs.decks / stats.count) * 1000) / 10 : 0;
          const winRate = cs.decks > 0 ? Math.round((cs.wins / cs.decks) * 1000) / 10 : 0;
          // 中央値計算
          const sorted = (cs.counts || []).slice().sort((a, b) => a - b);
          let medianCount = 0;
          if (sorted.length > 0) {
            const mid = Math.floor(sorted.length / 2);
            medianCount = sorted.length % 2 === 0
              ? Math.round(((sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10
              : sorted[mid];
          }
          return {
            card_id: cardId,
            decks: cs.decks,
            usage_rate: usageRate,
            wins: cs.wins,
            win_rate: winRate,
            avg_count: cs.decks > 0 ? Math.round((cs.total_count / cs.decks) * 10) / 10 : 0,
            median_count: medianCount,
            max_count: cs.max_count,
            min_count: cs.min_count === Infinity ? 0 : cs.min_count
          };
        })
        .sort((a, b) => {
          // 採用率→採用数→優勝率→優勝数→最大枚数→平均枚数
          if (b.usage_rate !== a.usage_rate) return b.usage_rate - a.usage_rate;
          if (b.decks !== a.decks) return b.decks - a.decks;
          if (b.win_rate !== a.win_rate) return b.win_rate - a.win_rate;
          if (b.wins !== a.wins) return b.wins - a.wins;
          if (b.max_count !== a.max_count) return b.max_count - a.max_count;
          return b.avg_count - a.avg_count;
        });

      return {
        type_key: key,
        colors: stats.colors,
        label: stats.colors.map(c => COLOR_JP[c] || c).join('/'),
        count: stats.count,
        share: totalDecks > 0 ? Math.round((stats.count / totalDecks) * 1000) / 10 : 0,
        wins: stats.wins,
        win_rate: stats.count > 0 ? Math.round((stats.wins / stats.count) * 1000) / 10 : 0,
        avg_rank: stats.count > 0 ? Math.round((stats.rank_sum / stats.count) * 10) / 10 : 0,
        card_ranking: cardRanking
      };
    })
    .filter(dt => dt.colors[0] !== 'Unknown')
    .sort((a, b) => b.count - a.count);

  // 全デッキタイプ横断のカード採用率（参考値）
  const globalCardStats = {};
  for (const dt of Object.values(deckTypeStats)) {
    for (const [cardId, cs] of Object.entries(dt.card_stats)) {
      if (!globalCardStats[cardId]) {
        globalCardStats[cardId] = { decks: 0, wins: 0, total_count: 0, max_count: 0, min_count: Infinity, counts: [] };
      }
      const g = globalCardStats[cardId];
      g.decks += cs.decks;
      g.wins += cs.wins;
      g.total_count += cs.total_count;
      g.max_count = Math.max(g.max_count, cs.max_count);
      g.min_count = Math.min(g.min_count, cs.min_count);
      g.counts.push(...(cs.counts || []));
    }
  }
  const globalCardRanking = Object.entries(globalCardStats)
    .map(([cardId, stats]) => ({
      card_id: cardId,
      decks: stats.decks,
      usage_rate: totalDecks > 0 ? Math.round((stats.decks / totalDecks) * 1000) / 10 : 0,
      wins: stats.wins,
      avg_count: stats.decks > 0 ? Math.round((stats.total_count / stats.decks) * 10) / 10 : 0,
      max_count: stats.max_count,
      min_count: stats.min_count === Infinity ? 0 : stats.min_count
    }))
    .sort((a, b) => b.decks - a.decks);

  // 地域別ランキング生成
  const regionRanking = Object.entries(regionStats)
    .map(([region, stats]) => ({
      region,
      events: stats.events,
      decks: stats.decks,
      top_deck_types: Object.entries(stats.deck_types)
        .map(([key, dt]) => ({
          type_key: key,
          colors: dt.colors,
          label: dt.colors.map(c => COLOR_JP[c] || c).join('/'),
          count: dt.count,
          wins: dt.wins
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5)
    }))
    .sort((a, b) => b.events - a.events);

  return {
    total_events: totalEvents,
    total_decks: totalDecks,
    card_ranking: globalCardRanking,
    deck_type_ranking: deckTypeRanking,
    region_ranking: regionRanking,
    updated_at: new Date().toISOString()
  };
}

// === カード画像ダウンロード ===
const IMAGES_DIR = path.join(__dirname, 'images', 'cards');

/**
 * 全イベントから使用カードを収集し、未ダウンロードの画像を取得
 */
function downloadCardImages(eventsData) {
  if (!fs.existsSync(IMAGES_DIR)) {
    fs.mkdirSync(IMAGES_DIR, { recursive: true });
  }

  const cardIds = new Set();
  for (const ev of Object.values(eventsData.events)) {
    for (const r of (ev.results || [])) {
      for (const c of (r.deck || [])) {
        cardIds.add(c.card_id);
      }
    }
  }

  let downloaded = 0, skipped = 0;
  for (const cardId of cardIds) {
    const filePath = path.join(IMAGES_DIR, `${cardId}.webp`);
    if (fs.existsSync(filePath)) { skipped++; continue; }

    const url = `https://www.gundam-gcg.com/jp/images/cards/card/${cardId}.webp`;
    try {
      execSync(`curl -s -L -o "${filePath}" --max-time 15 -H "Referer: https://www.gundam-gcg.com/jp/" "${url}"`);
      const stat = fs.statSync(filePath);
      if (stat.size > 1000) {
        downloaded++;
      } else {
        fs.unlinkSync(filePath);
      }
    } catch (e) { /* skip */ }
  }
  if (downloaded > 0) console.log(`  カード画像: ${downloaded}枚ダウンロード (${skipped}枚スキップ)`);
}

// === エントリポイント ===

/**
 * データを保存する共通関数
 */
function saveData(existingData) {
  // generateSummaryが各eventにregion/top4_colorsを付与するので先に呼ぶ
  const summary = generateSummary(existingData);
  const eventsFile = path.join(DATA_DIR, 'events.json');
  fs.writeFileSync(eventsFile, JSON.stringify(existingData, null, 2), 'utf-8');
  const summaryFile = path.join(DATA_DIR, 'summary.json');
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2), 'utf-8');
  // 未取得データ一覧を生成
  generateMissingData(existingData);
  // カード画像の自動ダウンロード
  downloadCardImages(existingData);
  return summary;
}

/**
 * 未取得データ一覧 (missing_data.json) を生成
 * - 結果データ未取得のイベント
 * - TOP4のデッキデータ未取得
 */
function generateMissingData(eventsData) {
  const missing = [];
  for (const ev of Object.values(eventsData.events)) {
    const results = ev.results || [];
    if (results.length === 0) {
      missing.push({
        event_id: ev.event_id, date: ev.date, store: ev.store,
        region: ev.region || '', type: 'no_results', detail: '結果データ未取得'
      });
      continue;
    }
    for (const r of results) {
      if (r.rank > 4) continue;
      if (!r.deck || r.deck.length === 0) {
        missing.push({
          event_id: ev.event_id, date: ev.date, store: ev.store,
          region: ev.region || '', type: 'no_deck',
          detail: `rank ${r.rank} (${r.player || '不明'}) のデッキデータ未取得`
        });
      }
    }
  }
  missing.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const missingFile = path.join(DATA_DIR, 'missing_data.json');
  fs.writeFileSync(missingFile, JSON.stringify(missing, null, 2), 'utf-8');
  if (missing.length > 0) {
    console.log(`  未取得データ: ${missing.length}件 → ${missingFile}`);
  }
}

async function main() {
  const isFullMode = process.argv.includes('--full');
  const limitArg = process.argv.find(a => a.startsWith('--limit='));
  const limit = limitArg ? parseInt(limitArg.split('=')[1], 10) : 0;
  console.log(`=== GCG STATS スクレイパー (${isFullMode ? '全件取得' : '差分取得'}${limit ? ` / 上限${limit}件` : ''}) ===\n`);

  // dataディレクトリ作成
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  // 既存データ読み込み
  let existingData = { series: {}, events: {} };
  const eventsFile = path.join(DATA_DIR, 'events.json');
  if (!isFullMode && fs.existsSync(eventsFile)) {
    try {
      existingData = JSON.parse(fs.readFileSync(eventsFile, 'utf-8'));
    } catch (e) {
      console.warn('  既存データの読み込みに失敗。全件取得に切り替えます。');
    }
  }

  // Step 1: イベント一覧取得
  const { series, events } = await fetchEventList();

  // シリーズ情報をマージ
  existingData.series = { ...existingData.series, ...series };

  // 新規イベントのフィルタリング
  let newEvents = isFullMode
    ? events
    : events.filter(e => !existingData.events[e.event_id]);

  // 件数制限
  if (limit > 0) {
    newEvents = newEvents.slice(0, limit);
  }

  console.log(`\n[2/3] イベント詳細を取得中... (${newEvents.length}件)\n`);

  // Step 2: 各イベントの詳細取得
  let processed = 0;
  for (const event of newEvents) {
    processed++;
    console.log(`  [${processed}/${newEvents.length}] ${event.date} ${event.store}`);

    // イベント結果を取得
    await sleep(DELAY_MS);
    const results = await fetchEventResults(event.series_id, event.event_id);

    // 各プレイヤーのデッキを取得
    for (let i = 0; i < results.length; i++) {
      await sleep(DELAY_MS);
      const deckData = await fetchDeck(event.series_id, event.event_id, results[i].deck_no);
      results[i].deck = deckData.cards;
      results[i].tcgplus_url = deckData.tcgplus_url;
      console.log(`    ${results[i].rank}位 ${results[i].player}: ${results[i].deck.length}枚種${deckData.tcgplus_url ? ' [TCG+]' : ''}`);
    }

    existingData.events[event.event_id] = {
      series_id: event.series_id,
      event_id: event.event_id,
      date: event.date,
      store: event.store,
      results,
      fetched_at: new Date().toISOString()
    };

    // 10件ごとに中間保存
    if (processed % 10 === 0) {
      console.log('  [中間保存...]');
      saveData(existingData);
    }
  }

  // Step 3: データ保存
  console.log('\n[3/3] データを保存中...');
  const summary = saveData(existingData);
  console.log(`  → ${path.join(DATA_DIR, 'events.json')}`);
  console.log(`  → ${path.join(DATA_DIR, 'summary.json')}`);

  console.log(`\n=== スクレイピング完了 ===`);
  console.log(`  イベント数: ${Object.keys(existingData.events).length}`);
  console.log(`  総デッキ数: ${summary.total_decks}`);
  console.log(`  カード種数: ${summary.card_ranking.length}`);

  // 静的HTML生成 & カードページ生成
  console.log('\n[後処理] 静的HTML・カードページを生成中...');
  try {
    execSync('node generate.js', { cwd: __dirname, stdio: 'inherit' });
    execSync('node generate_cards.js', { cwd: __dirname, stdio: 'inherit' });
    console.log('[後処理] 生成完了');
  } catch (e) {
    console.error('[後処理] 生成でエラー:', e.message);
  }

  // GitHub API経由でpush（CI環境など自動実行時）
  if (process.env.AUTO_DEPLOY === '1' || process.argv.includes('--deploy')) {
    console.log('\n[デプロイ] GitHub API push...');
    try {
      const dateStr = new Date().toISOString().split('T')[0];
      const filesToPush = [
        { path: 'data/events.json', content: fs.readFileSync(path.join(__dirname, 'data', 'events.json'), 'utf-8') },
        { path: 'data/summary.json', content: fs.readFileSync(path.join(__dirname, 'data', 'summary.json'), 'utf-8') }
      ];
      // 生成されたイベントページも追加
      const eventsDir = path.join(__dirname, 'events');
      if (fs.existsSync(eventsDir)) {
        const eventFiles = fs.readdirSync(eventsDir).filter(f => f.endsWith('.html'));
        for (const ef of eventFiles) {
          filesToPush.push({
            path: 'events/' + ef,
            content: fs.readFileSync(path.join(eventsDir, ef), 'utf-8')
          });
        }
      }
      // sitemap
      const sitemapPath = path.join(__dirname, 'sitemap.xml');
      if (fs.existsSync(sitemapPath)) {
        filesToPush.push({ path: 'sitemap.xml', content: fs.readFileSync(sitemapPath, 'utf-8') });
      }
      await pushFiles(filesToPush, `データ更新: ${dateStr}`);
      console.log('[デプロイ] 完了');
    } catch (e) {
      console.error('[デプロイ] エラー:', e.message);
    }
  }
}

// モジュールとして読み込まれた場合は関数のみ公開（差分マージ時の集計再生成で利用）
if (require.main === module) {
  main().catch(err => {
    console.error('致命的エラー:', err.message);
    process.exit(1);
  });
}

module.exports = {
  generateSummary,
  generateMissingData,
  getDeckColors,
  getRegion,
  saveData,
};
