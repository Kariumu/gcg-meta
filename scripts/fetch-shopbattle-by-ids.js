#!/usr/bin/env node
/**
 * 既知のevent_idリストから参加者数を一括取得
 * schedule.json から救出した event_id を使って参加者データを取得
 *
 * 使い方:
 *   node scripts/fetch-shopbattle-by-ids.js --ids /tmp/rescued-event-ids.json --month 2026-04 --series 6490
 *   node scripts/fetch-shopbattle-by-ids.js --ids /tmp/rescued-event-ids.json --month 2026-04 --series 6490 --test 10
 *   node scripts/fetch-shopbattle-by-ids.js --ids /tmp/rescued-event-ids.json --month 2026-04 --series 6490 --offset 100 --limit 200
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const API_BASE = 'https://api.bandai-tcg-plus.com';
const REQUEST_DELAY_MS = 6000;
const RETRY_DELAY_MS = 30000;
const MAX_RETRIES = 3;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

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
          } catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
        });
      }).on('error', reject);
    });
  } catch (err) {
    if (retryCount < MAX_RETRIES - 1) {
      console.log(`    リトライ ${retryCount + 1}/${MAX_RETRIES}: ${err.message}`);
      await sleep(RETRY_DELAY_MS);
      return fetchJson(url, retryCount + 1);
    }
    throw err;
  }
}

async function main() {
  const args = process.argv.slice(2);
  let idsFile = null, monthLabel = null, seriesId = null;
  let testLimit = 0, offset = 0, limit = 0;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ids') idsFile = args[i + 1];
    if (args[i] === '--month') monthLabel = args[i + 1];
    if (args[i] === '--series') seriesId = args[i + 1];
    if (args[i] === '--test') testLimit = parseInt(args[i + 1], 10);
    if (args[i] === '--offset') offset = parseInt(args[i + 1], 10);
    if (args[i] === '--limit') limit = parseInt(args[i + 1], 10);
  }

  if (!idsFile || !monthLabel) {
    console.error('使い方: node scripts/fetch-shopbattle-by-ids.js --ids /tmp/rescued-event-ids.json --month 2026-04 --series 6490');
    console.error('オプション: --test 10 (テスト件数) --offset 100 --limit 200 (バッチ指定)');
    process.exit(1);
  }

  // schedule.json からイベント詳細情報を取得（API呼び出し不要）
  const scheduleData = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'schedule.json'), 'utf8'));
  const scheduleEvents = scheduleData.events[seriesId] || [];
  const scheduleMap = new Map();
  for (const e of scheduleEvents) {
    scheduleMap.set(e.id, e);
  }

  // 店舗名マップ（organizer_id → name）
  const storeMap = new Map();
  if (scheduleData.stores) {
    const stores = Array.isArray(scheduleData.stores) ? scheduleData.stores : Object.values(scheduleData.stores);
    for (const s of stores) {
      storeMap.set(s.id, s.name);
    }
  }

  let ids = JSON.parse(fs.readFileSync(idsFile, 'utf8'));
  const retryPendingOnly = args.includes('--retry-pending-only');

  // --retry-pending-only: 既存ファイルのpendingのみ再試行
  if (retryPendingOnly) {
    const existingPath = path.join(__dirname, '..', 'data', 'shopbattle', `${monthLabel}.json`);
    if (fs.existsSync(existingPath)) {
      const existing = JSON.parse(fs.readFileSync(existingPath, 'utf8'));
      const pendingIds = (existing.events || [])
        .filter(e => e.status === 'pending')
        .map(e => e.eventId);
      console.log(`🔄 pending ${pendingIds.length}件のみ再試行します`);
      ids = pendingIds;
    } else {
      console.log('既存ファイルが見つかりません。全件取得します。');
    }
  }

  // バッチ制御
  if (testLimit > 0) {
    ids = ids.slice(0, testLimit);
    console.log(`🧪 テストモード: 最初の${testLimit}件のみ`);
  } else if (offset > 0 || limit > 0) {
    const end = limit > 0 ? offset + limit : ids.length;
    ids = ids.slice(offset, end);
    console.log(`📦 バッチモード: offset=${offset}, limit=${limit || 'all'} → ${ids.length}件`);
  }

  console.log(`📋 ${ids.length}件のevent_idから参加者数を取得します`);

  const outputDir = path.join(__dirname, '..', 'data', 'shopbattle');
  fs.mkdirSync(outputDir, { recursive: true });

  // 既存の結果ファイルがあれば読み込み（差分取得サポート）
  const outputPath = path.join(outputDir, `${monthLabel}.json`);
  let existingResults = [];
  const existingIds = new Set();
  if (fs.existsSync(outputPath)) {
    const existing = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    existingResults = existing.events || [];
    if (retryPendingOnly) {
      // pending再試行: pendingエントリを除外（再取得するため）
      const pendingSet = new Set(ids);
      existingResults = existingResults.filter(e => !pendingSet.has(e.eventId));
      console.log(`  pending除外後: ${existingResults.length}件を保持`);
    }
    existingResults.forEach(e => existingIds.add(e.eventId));
    console.log(`  既存データ: ${existingResults.length}件（スキップ対象）`);
  }

  const results = [...existingResults];
  let success = existingResults.filter(e => e.status === 'success').length;
  let pending = existingResults.filter(e => e.status === 'pending').length;
  let errorCount = existingResults.filter(e => e.status === 'error').length;
  let skipped = 0;

  for (let i = 0; i < ids.length; i++) {
    const eventId = ids[i];

    // 既に取得済みならスキップ
    if (existingIds.has(eventId)) {
      skipped++;
      continue;
    }

    // schedule.json からイベント詳細を取得（API呼び出し不要）
    const schedEvent = scheduleMap.get(eventId);

    // ランキング（参加者数）を取得
    try {
      const { data } = await fetchJson(`${API_BASE}/api/user/ranking/event_result/${eventId}`);

      if (data.success?.rankings) {
        const rankings = data.success.rankings;
        const participants = rankings.reduce((sum, r) => sum + (r.users?.length || 0), 0);

        const prefCode = schedEvent?.pref_code || null;
        results.push({
          eventId,
          status: 'success',
          participants,
          organizerId: schedEvent?.organizer_id || null,
          organizerName: storeMap.get(schedEvent?.organizer_id) || null,
          prefCode,
          prefName: PREF_MAP[prefCode]?.name || '不明',
          region: PREF_MAP[prefCode]?.region || '不明',
          startDatetime: schedEvent?.start_datetime || null,
          maxJoinCount: schedEvent?.max_join_count || null,
          statusId: 51,
          isCanceled: false,
          rankings: rankings.map(r => ({ rank: r.rank, playerCount: r.users?.length || 0 }))
        });
        existingIds.add(eventId);
        success++;
      } else {
        // 結果未確定
        const prefCode = schedEvent?.pref_code || null;
        results.push({
          eventId,
          status: 'pending',
          participants: 0,
          organizerId: schedEvent?.organizer_id || null,
          organizerName: storeMap.get(schedEvent?.organizer_id) || null,
          prefCode,
          prefName: PREF_MAP[prefCode]?.name || '不明',
          region: PREF_MAP[prefCode]?.region || '不明',
          startDatetime: schedEvent?.start_datetime || null,
          maxJoinCount: schedEvent?.max_join_count || null,
          statusId: schedEvent?.status_id || null,
          isCanceled: false,
          error: JSON.stringify(data.error?.validations || data.error?.message || '?').substring(0, 100)
        });
        existingIds.add(eventId);
        pending++;
      }
    } catch (err) {
      results.push({ eventId, status: 'error', participants: 0, error: err.message });
      existingIds.add(eventId);
      errorCount++;
    }

    const processed = i + 1 - skipped;
    if (processed % 10 === 0 || i === ids.length - 1) {
      console.log(`  進捗 ${i + 1}/${ids.length} (新規${processed}件): 成功=${success}, 未確定=${pending}, エラー=${errorCount}, スキップ=${skipped}`);
    }

    // 中間保存（50件ごと）- タイムアウト対策
    if (processed > 0 && processed % 50 === 0) {
      const interim = {
        seriesId, monthLabel,
        fetchedAt: new Date().toISOString(),
        totalEvents: results.length,
        successCount: success, pendingCount: pending, errorCount,
        events: results
      };
      fs.writeFileSync(outputPath, JSON.stringify(interim, null, 2));
      console.log(`  💾 中間保存 (${results.length}件)`);
    }

    await sleep(REQUEST_DELAY_MS);
  }

  // 最終保存
  const output = {
    seriesId,
    monthLabel,
    fetchedAt: new Date().toISOString(),
    totalEvents: results.length,
    successCount: success,
    pendingCount: pending,
    errorCount,
    events: results
  };

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n✅ 保存完了: ${outputPath}`);
  console.log(`  成功: ${success}件、未確定: ${pending}件、エラー: ${errorCount}件、スキップ: ${skipped}件`);

  // マニフェスト更新
  const manifestPath = path.join(outputDir, 'manifest.json');
  let manifest = { availableMonths: [] };
  if (fs.existsSync(manifestPath)) {
    manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  }
  if (!manifest.availableMonths.includes(monthLabel)) {
    manifest.availableMonths.push(monthLabel);
    manifest.availableMonths.sort();
  }
  manifest.latestMonth = manifest.availableMonths[manifest.availableMonths.length - 1];
  manifest.lastUpdated = new Date().toISOString();
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

main().catch(err => {
  console.error('エラー:', err);
  process.exit(1);
});
