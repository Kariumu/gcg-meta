#!/usr/bin/env node
/**
 * ショップバトル参加者数取得スクリプト
 *
 * 使い方:
 *   node scripts/fetch-shopbattle-results.js --series 6490 --month 2026-04
 *   node scripts/fetch-shopbattle-results.js --series 6768 --month 2026-05
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

// ===== 設定 =====
const API_BASE = 'https://api.bandai-tcg-plus.com';
const REQUEST_DELAY_MS = 6000;
const RETRY_DELAY_MS = 30000;
const MAX_RETRIES = 3;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// ===== 都道府県コード変換（ISO 3166-2:JP → 日本語） =====
const PREF_MAP = {
  'JP-01': { name: '北海道', region: '北海道' },
  'JP-02': { name: '青森県', region: '東北' },
  'JP-03': { name: '岩手県', region: '東北' },
  'JP-04': { name: '宮城県', region: '東北' },
  'JP-05': { name: '秋田県', region: '東北' },
  'JP-06': { name: '山形県', region: '東北' },
  'JP-07': { name: '福島県', region: '東北' },
  'JP-08': { name: '茨城県', region: '関東' },
  'JP-09': { name: '栃木県', region: '関東' },
  'JP-10': { name: '群馬県', region: '関東' },
  'JP-11': { name: '埼玉県', region: '関東' },
  'JP-12': { name: '千葉県', region: '関東' },
  'JP-13': { name: '東京都', region: '関東' },
  'JP-14': { name: '神奈川県', region: '関東' },
  'JP-15': { name: '新潟県', region: '中部・甲信越' },
  'JP-16': { name: '富山県', region: '中部・甲信越' },
  'JP-17': { name: '石川県', region: '中部・甲信越' },
  'JP-18': { name: '福井県', region: '中部・甲信越' },
  'JP-19': { name: '山梨県', region: '中部・甲信越' },
  'JP-20': { name: '長野県', region: '中部・甲信越' },
  'JP-21': { name: '岐阜県', region: '中部・甲信越' },
  'JP-22': { name: '静岡県', region: '中部・甲信越' },
  'JP-23': { name: '愛知県', region: '中部・甲信越' },
  // ★ 三重県は関西扱い（既存stores.htmlの仕様に合わせる）
  'JP-24': { name: '三重県', region: '関西' },
  'JP-25': { name: '滋賀県', region: '関西' },
  'JP-26': { name: '京都府', region: '関西' },
  'JP-27': { name: '大阪府', region: '関西' },
  'JP-28': { name: '兵庫県', region: '関西' },
  'JP-29': { name: '奈良県', region: '関西' },
  'JP-30': { name: '和歌山県', region: '関西' },
  'JP-31': { name: '鳥取県', region: '中国' },
  'JP-32': { name: '島根県', region: '中国' },
  'JP-33': { name: '岡山県', region: '中国' },
  'JP-34': { name: '広島県', region: '中国' },
  'JP-35': { name: '山口県', region: '中国' },
  'JP-36': { name: '徳島県', region: '四国' },
  'JP-37': { name: '香川県', region: '四国' },
  'JP-38': { name: '愛媛県', region: '四国' },
  'JP-39': { name: '高知県', region: '四国' },
  'JP-40': { name: '福岡県', region: '九州・沖縄' },
  'JP-41': { name: '佐賀県', region: '九州・沖縄' },
  'JP-42': { name: '長崎県', region: '九州・沖縄' },
  'JP-43': { name: '熊本県', region: '九州・沖縄' },
  'JP-44': { name: '大分県', region: '九州・沖縄' },
  'JP-45': { name: '宮崎県', region: '九州・沖縄' },
  'JP-46': { name: '鹿児島県', region: '九州・沖縄' },
  'JP-47': { name: '沖縄県', region: '九州・沖縄' },
  'CN-HK': { name: '香港', region: '海外' }
};

// ===== ヘルパー =====
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url, retryCount = 0) {
  try {
    return await new Promise((resolve, reject) => {
      https.get(url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'application/json' }
      }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => {
          try {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({ status: res.statusCode, data: JSON.parse(text) });
          } catch (e) {
            reject(new Error(`JSON parse error: ${e.message}`));
          }
        });
      }).on('error', reject);
    });
  } catch (err) {
    if (retryCount < MAX_RETRIES - 1) {
      console.log(`    リトライ ${retryCount + 1}/${MAX_RETRIES}: ${err.message} → ${RETRY_DELAY_MS / 1000}秒待機`);
      await sleep(RETRY_DELAY_MS);
      return fetchJson(url, retryCount + 1);
    }
    throw err;
  }
}

// ===== Step 1: シリーズ内の全イベント一覧を取得 =====
async function fetchAllEvents(seriesId) {
  console.log(`📋 シリーズ ${seriesId} のイベント一覧を取得中...`);
  const allEvents = [];
  let offset = 0;
  const limit = 50;

  while (true) {
    const url = `${API_BASE}/api/user/event/list?event_series_id=${seriesId}&limit=${limit}&offset=${offset}`;
    const { data } = await fetchJson(url);
    const events = data.success?.event_list || [];
    const total = data.success?.total || 0;

    allEvents.push(...events);
    console.log(`  offset=${offset}: ${events.length}件取得（累計 ${allEvents.length}/${total}）`);

    if (allEvents.length >= total || events.length === 0) break;
    offset += limit;
    await sleep(REQUEST_DELAY_MS);
  }

  // 重複除去
  const seen = new Set();
  const unique = [];
  for (const e of allEvents) {
    if (!seen.has(e.id)) {
      seen.add(e.id);
      unique.push(e);
    }
  }

  console.log(`✅ ユニークイベント数: ${unique.length}件`);
  return unique;
}

// ===== Step 2: 各イベントの参加者数を取得 =====
async function fetchEventResult(eventId) {
  const url = `${API_BASE}/api/user/ranking/event_result/${eventId}`;
  try {
    const { status, data } = await fetchJson(url);

    if (status === 404) {
      return { eventId, status: 'cancelled', participants: 0, error: '404' };
    }

    if (data.error) {
      const msg = data.error.validations || data.error.message;
      return { eventId, status: 'pending', participants: 0, error: JSON.stringify(msg).substring(0, 100) };
    }

    const rankings = data.success?.rankings || [];
    const participants = rankings.reduce((sum, r) => sum + (r.users?.length || 0), 0);

    return {
      eventId,
      status: 'success',
      participants,
      rankings: rankings.map(r => ({
        rank: r.rank,
        playerCount: r.users?.length || 0
      }))
    };
  } catch (err) {
    return { eventId, status: 'error', participants: 0, error: err.message };
  }
}

// ===== メイン処理 =====
async function main() {
  const args = process.argv.slice(2);
  let seriesId = null;
  let monthLabel = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--series') seriesId = args[i + 1];
    if (args[i] === '--month') monthLabel = args[i + 1];
    if (args[i] === '--test-mode') process.env.TEST_MODE = '1';
  }

  if (!seriesId || !monthLabel) {
    console.error('使い方: node scripts/fetch-shopbattle-results.js --series 6490 --month 2026-04');
    process.exit(1);
  }

  const outputDir = path.join(__dirname, '..', 'data', 'shopbattle');
  fs.mkdirSync(outputDir, { recursive: true });

  // Step 1: 全イベント取得
  let events = await fetchAllEvents(seriesId);

  // テストモード: status=51のイベントのみ
  if (process.env.TEST_MODE) {
    events = events.filter(e => e.status_id === 51);
    console.log(`\n🧪 テストモード: status=51 の${events.length}件のみ処理`);
  }

  // Step 2: 各イベントの参加者数を取得
  console.log(`\n📊 ${events.length}件のイベントから参加者数を取得中...`);
  const results = [];
  let successCount = 0;
  let pendingCount = 0;
  let errorCount = 0;

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    const result = await fetchEventResult(event.id);

    // イベント詳細とマージ
    const merged = {
      eventId: event.id,
      organizerId: event.organizer_id,
      organizerName: event.organizer_name,
      prefCode: event.pref_code,
      prefName: PREF_MAP[event.pref_code]?.name || '不明',
      region: PREF_MAP[event.pref_code]?.region || '不明',
      city: event.city_code,
      startDatetime: event.start_datetime,
      maxJoinCount: event.max_join_count,
      statusId: event.status_id,
      isCanceled: event.is_canceled,
      ...result
    };

    results.push(merged);

    if (result.status === 'success') successCount++;
    else if (result.status === 'pending') pendingCount++;
    else errorCount++;

    if ((i + 1) % 10 === 0 || i === events.length - 1) {
      console.log(`  進捗 ${i + 1}/${events.length}: 成功=${successCount}, 未確定=${pendingCount}, エラー=${errorCount}`);
    }

    await sleep(REQUEST_DELAY_MS);
  }

  // Step 3: 結果保存
  const outputPath = path.join(outputDir, `${monthLabel}.json`);
  const output = {
    seriesId,
    monthLabel,
    fetchedAt: new Date().toISOString(),
    totalEvents: events.length,
    successCount,
    pendingCount,
    errorCount,
    events: results
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n✅ 保存完了: ${outputPath}`);
  console.log(`  成功: ${successCount}件、未確定: ${pendingCount}件、エラー: ${errorCount}件`);

  // マニフェストファイル更新
  updateManifest(monthLabel, outputDir);
}

// ===== マニフェストファイル更新 =====
function updateManifest(monthLabel, outputDir) {
  const manifestPath = path.join(outputDir, 'manifest.json');
  let manifest = { availableMonths: [] };
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  }

  if (!manifest.availableMonths.includes(monthLabel)) {
    manifest.availableMonths.push(monthLabel);
    manifest.availableMonths.sort();
  }
  manifest.latestMonth = manifest.availableMonths[manifest.availableMonths.length - 1];
  manifest.lastUpdated = new Date().toISOString();

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  console.log(`📋 manifest.json 更新: latestMonth=${manifest.latestMonth}`);
}

main().catch(err => {
  console.error('エラー:', err);
  process.exit(1);
});
