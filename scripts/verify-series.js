#!/usr/bin/env node
/**
 * 取得済みデータのシリーズID検証
 * ランダム20件のイベント詳細を取得してシリーズIDを確認
 */
const fs = require('fs');
const https = require('https');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function main() {
  const data = JSON.parse(fs.readFileSync('data/shopbattle/2026-04.json'));
  const events = data.events.filter(e => e.status === 'success');

  console.log(`検証対象: ${events.length}件`);
  console.log('サンプル20件のシリーズIDを確認します...\n');

  // ランダムに20件抽出
  const sample = [...events].sort(() => Math.random() - 0.5).slice(0, 20);

  const seriesCounts = {};
  for (let i = 0; i < sample.length; i++) {
    const e = sample[i];
    const url = `https://api.bandai-tcg-plus.com/api/user/event/${e.eventId}`;

    try {
      const res = await fetchJson(url);
      const seriesId = res.success?.event?.event_series_id;
      seriesCounts[seriesId] = (seriesCounts[seriesId] || 0) + 1;
      console.log(`  [${i+1}/20] event=${e.eventId}, organizer=${e.organizerName}, series_id=${seriesId}`);
    } catch (err) {
      console.warn(`  [${i+1}/20] event=${e.eventId}: エラー ${err.message}`);
    }

    await sleep(2000);
  }

  console.log('\n=== シリーズID別の分布 ===');
  for (const [sid, count] of Object.entries(seriesCounts)) {
    console.log(`  ${sid}: ${count}件`);
  }

  console.log('\n=== 判定 ===');
  if (Object.keys(seriesCounts).length === 1 && Object.keys(seriesCounts)[0] === '6490') {
    console.log('✅ 全サンプルがショップバトル(6490)のみ → 取得データは正しい');
  } else if ('6490' in seriesCounts) {
    const total = sample.length;
    const sb = seriesCounts['6490'] || 0;
    const ratio = (sb / total * 100).toFixed(1);
    console.log(`⚠️ ショップバトル(6490): ${sb}/${total}件 (${ratio}%)`);
    console.log(`   → ${total - sb}件が他のシリーズ → フィルタリングが必要`);
  } else {
    console.log('❌ ショップバトル(6490)が0件 → データが間違っている可能性');
  }
}

main().catch(console.error);
