// fetch-schedule.js
// 使い方: node fetch-schedule.js            本番(取得→data/schedule.json 更新→アーカイブ upsert→push)
//         node fetch-schedule.js --dry-run  検証(取得はするが本番ファイルを書かない・アーカイブ更新もpushもしない)
// run-auto-news-daily.bat から毎日20:00に実行される

const fs = require('fs');
const https = require('https');
const path = require('path');

const API_BASE = 'https://api.bandai-tcg-plus.com';
const GCG_GAME_TITLE_ID = 15;
const OUTPUT_PATH = path.join(__dirname, 'data', 'schedule.json');

// 指示書74 §2-4: dry-run。読み取り元(OUTPUT_PATH)は本番のまま、書き込み先だけ tmp へ逃がす。
const DRY_RUN = process.argv.includes('--dry-run');
const WRITE_PATH = DRY_RUN ? path.join(__dirname, 'tmp', 'schedule.dryrun.json') : OUTPUT_PATH;

// 指示書74: 国内判定の一段目 — ゲームタイトルID構成による判定。
// 国内シリーズは event_series_game_title_ids が「15」単独。海外シリーズは海外版GCG
// (game_title_id 16)にも紐づき「15,16」等の複数構成になる(2026-08-20 実測で完全分離)。
// フィールド欠落・空の場合は game_title_id 単独構成とみなして通す(最終防壁は二段目)。
function isDomesticSeries(s) {
  const raw = (s.event_series_game_title_ids == null || s.event_series_game_title_ids === '')
    ? String(s.game_title_id)
    : String(s.event_series_game_title_ids);
  const ids = raw.split(',').map(t => t.trim()).filter(t => t !== '');
  return ids.length === 1 && ids[0] === String(GCG_GAME_TITLE_ID);
}

// TCG+ のWAFはUA種別で選別するため、ブラウザ系UA(身元併記)+Referer/Origin を付与する
// (既知知見: scripts/scan-tcgplus-tokens.js L108-113)
const TCGPLUS_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 gcg-stats-schedule/1.0 (+https://gcg-stats.com)',
  'Accept': 'application/json',
  'Referer': 'https://www.bandai-tcg-plus.com/',
  'Origin': 'https://www.bandai-tcg-plus.com'
};

function fetchJSONOnce(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: TCGPLUS_HEADERS }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 400) {
          reject(new Error('HTTP ' + res.statusCode + ': ' + String(data).slice(0, 120)));
          return;
        }
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse failed (HTTP ' + res.statusCode + '): ' + String(data).slice(0, 120))); }
      });
    }).on('error', reject);
  });
}

// WAF/瞬断対策: 最大3回まで指数バックオフで再試行
async function fetchJSON(url, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await fetchJSONOnce(url); }
    catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise(r => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

async function main() {
  console.log('=== GCG Schedule Fetch ===');
  if (DRY_RUN) {
    console.log('*** DRY-RUN *** 本番ファイルは書き換えません / アーカイブ更新・push もしません');
    console.log('    書き込み先: ' + WRITE_PATH);
  }
  console.log('Date:', new Date().toISOString());

  // 1. イベントシリーズ一覧を取得
  const paramsData = await fetchJSON(`${API_BASE}/api/user/event/list/params`);
  const allSeries = paramsData.success.event_series_with_game_title_id;

  // 2. GCG + 日本開催のみ抽出(指示書74 一段目)
  const jpSeries = allSeries.filter(s => s.game_title_id === GCG_GAME_TITLE_ID && isDomesticSeries(s));
  console.log(`Found ${jpSeries.length} domestic series (excluded ${allSeries.filter(s => s.game_title_id === GCG_GAME_TITLE_ID).length - jpSeries.length} of GCG total)`);

  // 3. 既存のschedule.jsonを読み込み（存在する場合）
  let existingData = { series: [], events: {}, stores: {}, last_updated: null };
  if (fs.existsSync(OUTPUT_PATH)) {
    existingData = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf-8'));
  }

  // 4. 各シリーズのイベント一覧を取得
  const seriesList = [];
  const allEvents = {};
  const allStores = existingData.stores || {};

  for (const series of jpSeries) {
    const sid = series.event_series_id;

    console.log(`  Fetching series ${sid}: ${series.event_series_title}`);

    let offset = 0;
    let events = [];
    while (true) {
      const evData = await fetchJSON(
        `${API_BASE}/api/user/event/list?game_title_id=${GCG_GAME_TITLE_ID}&event_series_id=${sid}&limit=1000&offset=${offset}`
      );
      const list = evData.success.event_list || [];
      events = events.concat(list);
      if (list.length < 1000) break;
      offset += 1000;
    }

    // キャンセル済みを除外
    const activeEvents = events.filter(e => !e.is_canceled);

    // 指示書74: 二段目 — 開催地コード防壁。pref_code が「JP-」で始まらないイベントを除外。
    // pref_code 空/欠落は除外しない(公式の入力漏れで国内イベントを消さないため)。
    const jpEvents = activeEvents.filter(e => !e.pref_code || String(e.pref_code).startsWith('JP-'));
    const removedCount = activeEvents.length - jpEvents.length;
    if (removedCount > 0) console.log(`    [overseas-guard] 非JP開催 ${removedCount} 件を除外`);
    if (activeEvents.length > 0 && jpEvents.length === 0) {
      console.log(`    [overseas-guard] JP開催0件のためシリーズごと除外: ${series.event_series_title}`);
      await new Promise(r => setTimeout(r, 500)); // API負荷軽減待機を跳ばさない
      continue; // seriesList・allEvents・stores のいずれにも載せない
    }

    // 店舗情報マスタに追加・更新(指示書74 §2-3: 二段目フィルタ後の jpEvents ベース)
    jpEvents.forEach(e => {
      if (e.organizer_id) {
        allStores[e.organizer_id] = {
          id: e.organizer_id,
          name: e.organizer_name,
          pref_code: e.pref_code,
          city: e.city_code || '',
          address: e.street_address || '',
          phone: e.phone_number || '',
          geo: e.event_place_geo || null
        };
      }
    });

    // イベントデータを保存
    allEvents[sid] = jpEvents.map(e => ({
      id: e.id,
      start_datetime: e.start_datetime,
      apply_start_datetime: e.apply_start_datetime,
      apply_end_datetime: e.apply_end_datetime,
      max_join_count: e.max_join_count,
      pref_code: e.pref_code,
      organizer_id: e.organizer_id,
      entry_fee: Math.round(parseFloat(e.entryFee || 0)),
      status_id: e.status_id,
      application_open: e.applicationOpen
    }));

    // シリーズ情報
    seriesList.push({
      event_series_id: sid,
      event_series_title: series.event_series_title,
      total: jpEvents.length,
      apply_end_datetime: jpEvents[0] ? jpEvents[0].apply_end_datetime : null,
      first_start_datetime: jpEvents[0] ? jpEvents[0].start_datetime : null,
      last_start_datetime: jpEvents.length > 0
        ? jpEvents.reduce((max, e) => e.start_datetime > max ? e.start_datetime : max, jpEvents[0].start_datetime)
        : null
    });

    console.log(`    → ${jpEvents.length} events`);

    // API負荷軽減のため500ms待機
    await new Promise(r => setTimeout(r, 500));
  }

  // 5. JSONファイルに保存
  // 指示書65: 開催済みイベント保全のため、置換前の schedule.json を控える
  let prevSchedule = null;
  try { prevSchedule = JSON.parse(fs.readFileSync(OUTPUT_PATH, 'utf-8').replace(/^\uFEFF/, '')); } catch (_) { /* 初回不在・破損は無視 */ }

  const output = {
    series: seriesList,
    events: allEvents,
    stores: allStores,
    last_updated: new Date().toISOString()
  };

  const jsonContent = JSON.stringify(output);
  fs.mkdirSync(path.dirname(WRITE_PATH), { recursive: true });
  fs.writeFileSync(WRITE_PATH, jsonContent, 'utf-8');
  console.log(`\nSaved to ${WRITE_PATH}`);
  console.log(`  Series: ${seriesList.length}`);
  console.log(`  Stores: ${Object.keys(allStores).length}`);
  console.log(`  Last updated: ${output.last_updated}`);

  // 開催済みイベント保全: アーカイブへ upsert(失敗しても本処理は止めない)
  if (DRY_RUN) {
    console.log('[dry-run] アーカイブ更新スキップ');
  } else {
    try {
      const { updateArchive } = require('./shared/schedule-archive');
      const stats = updateArchive(path.join(__dirname, 'data', 'schedule_archive.json'), [prevSchedule, output].filter(Boolean));
      console.log('[schedule-archive] events=' + stats.events_total + ' (+' + stats.events_added + ' new, ~' + stats.events_updated + ' updated)');
    } catch (e) {
      console.log('[schedule-archive] WARN 取り込み失敗(本処理は続行): ' + e.message);
    }
  }

  // 6. GitHub API経由でpush
  if (DRY_RUN) {
    console.log('[dry-run] push スキップ');
  } else {
    const { pushFiles } = require('./git-push');
    await pushFiles([
      { path: 'data/schedule.json', content: jsonContent }
    ], `Update schedule data ${new Date().toISOString().split('T')[0]}`);
  }
}

module.exports = { isDomesticSeries };

if (require.main === module) {
  main().catch(err => {
    console.error('Error:', err);
    process.exit(1);
  });
}
