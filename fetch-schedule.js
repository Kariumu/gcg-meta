// fetch-schedule.js
// 使い方: node fetch-schedule.js
// Coworkが毎日14:00に実行する

const fs = require('fs');
const https = require('https');

const API_BASE = 'https://api.bandai-tcg-plus.com';
const GCG_GAME_TITLE_ID = 15;
const OUTPUT_PATH = 'data/schedule.json';

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('=== GCG Schedule Fetch ===');
  console.log('Date:', new Date().toISOString());

  // 1. イベントシリーズ一覧を取得
  const paramsData = await fetchJSON(`${API_BASE}/api/user/event/list/params`);
  const allSeries = paramsData.success.event_series_with_game_title_id;

  // 2. GCG + 日本開催のみ抽出
  const jpSeries = allSeries.filter(s =>
    s.game_title_id === GCG_GAME_TITLE_ID &&
    !s.event_series_title.includes('[') &&
    !s.event_series_title.includes('Championships26-27 Store')
  );

  console.log(`Found ${jpSeries.length} JP series`);

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

    // 店舗情報マスタに追加・更新
    events.forEach(e => {
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

    // キャンセル済みを除外してイベントデータを保存
    const activeEvents = events.filter(e => !e.is_canceled);
    allEvents[sid] = activeEvents.map(e => ({
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
      total: activeEvents.length,
      apply_end_datetime: activeEvents[0] ? activeEvents[0].apply_end_datetime : null,
      first_start_datetime: activeEvents[0] ? activeEvents[0].start_datetime : null,
      last_start_datetime: activeEvents.length > 0
        ? activeEvents.reduce((max, e) => e.start_datetime > max ? e.start_datetime : max, activeEvents[0].start_datetime)
        : null
    });

    console.log(`    → ${activeEvents.length} events`);

    // API負荷軽減のため500ms待機
    await new Promise(r => setTimeout(r, 500));
  }

  // 5. JSONファイルに保存
  const output = {
    series: seriesList,
    events: allEvents,
    stores: allStores,
    last_updated: new Date().toISOString()
  };

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(output), 'utf-8');
  console.log(`\nSaved to ${OUTPUT_PATH}`);
  console.log(`  Series: ${seriesList.length}`);
  console.log(`  Stores: ${Object.keys(allStores).length}`);
  console.log(`  Last updated: ${output.last_updated}`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
