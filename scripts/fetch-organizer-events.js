#!/usr/bin/env node
/**
 * organizer_id ベースで全店舗のイベント取得（新方式）
 *
 * 各 organizer_id に対して /api/user/event/list?organizer_id=X を叩き、
 * 指定月のショップバトル event_id を収集する。
 *
 * 使い方:
 *   node scripts/fetch-organizer-events.js --month 2026-05
 *   node scripts/fetch-organizer-events.js --month 2026-05 --offset 0 --limit 200
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const API_BASE = 'https://api.bandai-tcg-plus.com';
const REQUEST_DELAY_MS = 4000;  // 4秒間隔
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 10000;
const SAVE_INTERVAL = 50;  // 50件ごとに中間保存

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchJson(url, retries) {
  retries = retries || 0;
  try {
    return await new Promise(function(resolve, reject) {
      https.get(url, {
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
      }, function(res) {
        var chunks = [];
        res.on('data', function(c) { chunks.push(c); });
        res.on('end', function() {
          try { resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }); }
          catch (e) { reject(e); }
        });
      }).on('error', reject);
    });
  } catch (err) {
    if (retries < MAX_RETRIES) {
      console.warn('    リトライ ' + (retries + 1) + '/' + MAX_RETRIES + ': ' + err.message);
      await sleep(RETRY_DELAY_MS);
      return fetchJson(url, retries + 1);
    }
    throw err;
  }
}

async function main() {
  var args = process.argv.slice(2);
  var monthLabel = null;
  var offsetArg = 0, limitArg = 0;

  for (var i = 0; i < args.length; i++) {
    if (args[i] === '--month') monthLabel = args[i + 1];
    if (args[i] === '--offset') offsetArg = parseInt(args[i + 1]) || 0;
    if (args[i] === '--limit') limitArg = parseInt(args[i + 1]) || 0;
  }

  if (!monthLabel) {
    console.error('使い方: node scripts/fetch-organizer-events.js --month 2026-05 [--offset 0] [--limit 200]');
    process.exit(1);
  }

  // organizer_id リストの取得 (schedule.json + aggregated.json の和集合)
  var organizerSet = new Set();

  // schedule.json
  var schedulePath = path.join(__dirname, '..', 'data', 'schedule.json');
  if (fs.existsSync(schedulePath)) {
    var schedule = JSON.parse(fs.readFileSync(schedulePath));
    for (var key of Object.keys(schedule.stores || {})) {
      organizerSet.add(parseInt(key));
    }
    console.log('schedule.json から ' + organizerSet.size + ' 店舗のorganizer_id取得');
  }

  // 4月aggregatedからも追加
  var aggPath = path.join(__dirname, '..', 'data', 'shopbattle', '2026-04-aggregated.json');
  if (fs.existsSync(aggPath)) {
    var agg = JSON.parse(fs.readFileSync(aggPath));
    var beforeSize = organizerSet.size;
    for (var store of agg.stores) {
      organizerSet.add(store.organizerId);
    }
    console.log('aggregated.json から ' + (organizerSet.size - beforeSize) + ' 件追加');
  }

  var organizerIds = Array.from(organizerSet).filter(function(id) { return id > 0; }).sort(function(a, b) { return a - b; });

  // offset/limit 適用
  if (limitArg > 0) {
    organizerIds = organizerIds.slice(offsetArg, offsetArg + limitArg);
    console.log('--offset ' + offsetArg + ' --limit ' + limitArg + ' → ' + organizerIds.length + ' 件対象');
  }

  console.log('\n対象organizer数: ' + organizerIds.length);
  console.log('想定時間: 約' + Math.round(organizerIds.length * REQUEST_DELAY_MS / 60000) + '分');

  // 月フィルタ用 (例: "2026-05")
  var monthPrefix = monthLabel;

  // 既存の中間結果読み込み（差分取得対応）
  var outputDir = path.join(__dirname, '..', 'data', 'shopbattle');
  fs.mkdirSync(outputDir, { recursive: true });
  var eventListPath = path.join(outputDir, monthLabel + '-event-list.json');

  var existingEventMap = new Map();
  var processedOrganizers = new Set();
  if (fs.existsSync(eventListPath)) {
    var existing = JSON.parse(fs.readFileSync(eventListPath));
    if (existing.events) {
      for (var ev of existing.events) {
        existingEventMap.set(ev.id, ev);
      }
    }
    if (existing.processedOrganizers) {
      for (var oid of existing.processedOrganizers) {
        processedOrganizers.add(oid);
      }
    }
    console.log('既存データ: ' + existingEventMap.size + ' events, ' + processedOrganizers.size + ' organizers処理済み');
  }

  var allEventMap = new Map(existingEventMap);
  var successCount = 0, errorCount = 0, skipCount = 0;
  var newEventsFound = 0;

  for (var idx = 0; idx < organizerIds.length; idx++) {
    var orgId = organizerIds[idx];

    // 既に処理済みならスキップ
    if (processedOrganizers.has(orgId)) {
      skipCount++;
      continue;
    }

    try {
      var url = API_BASE + '/api/user/event/list?organizer_id=' + orgId + '&limit=100&offset=0';
      var response = await fetchJson(url);
      var events = (response.data.success && response.data.success.event_list) || [];

      // 月フィルタ: start_datetime が指定月で始まるもの
      var targetEvents = events.filter(function(e) {
        var dt = e.start_datetime || '';
        return dt.substring(0, 7) === monthPrefix;
      });

      for (var ev of targetEvents) {
        if (!allEventMap.has(ev.id)) {
          newEventsFound++;
        }
        allEventMap.set(ev.id, {
          id: ev.id,
          organizerId: ev.organizer_id,
          organizerName: ev.organizer_name,
          seriesId: ev.event_series_id,
          seriesName: ev.event_series_name || '',
          startDatetime: ev.start_datetime,
          maxJoinCount: ev.max_join_count,
          prefCode: ev.pref_code,
          statusId: ev.status_id,
          isCanceled: ev.is_canceled
        });
      }

      processedOrganizers.add(orgId);
      successCount++;
    } catch (err) {
      console.warn('  organizer_id=' + orgId + ': ' + err.message);
      errorCount++;
    }

    var processed = successCount + errorCount;
    if (processed > 0 && processed % SAVE_INTERVAL === 0) {
      // 中間保存
      saveResults(eventListPath, monthLabel, organizerIds.length, successCount, errorCount, skipCount, allEventMap, processedOrganizers, newEventsFound);
      console.log('  中間保存 (' + allEventMap.size + ' events, ' + processedOrganizers.size + ' organizers)');
    }

    if ((idx + 1) % 25 === 0) {
      console.log('  進捗 ' + (idx + 1) + '/' + organizerIds.length + ': ' + allEventMap.size + ' events収集 (成功' + successCount + ' / スキップ' + skipCount + ' / エラー' + errorCount + ')');
    }

    await sleep(REQUEST_DELAY_MS);
  }

  // 最終保存
  saveResults(eventListPath, monthLabel, organizerIds.length, successCount, errorCount, skipCount, allEventMap, processedOrganizers, newEventsFound);

  // event_id リスト保存
  var idsPath = path.join(outputDir, monthLabel + '-event-ids.json');
  var allIds = Array.from(allEventMap.keys());
  fs.writeFileSync(idsPath, JSON.stringify(allIds, null, 2));

  // シリーズ別の分布表示
  var seriesDistribution = {};
  for (var [id, ev] of allEventMap) {
    var sid = ev.seriesId || 'unknown';
    if (!seriesDistribution[sid]) seriesDistribution[sid] = { count: 0, name: ev.seriesName || '' };
    seriesDistribution[sid].count++;
  }

  console.log('\n=== 完了 ===');
  console.log('対象organizer: ' + organizerIds.length);
  console.log('成功: ' + successCount + ' / スキップ(処理済み): ' + skipCount + ' / エラー: ' + errorCount);
  console.log('発見event総数: ' + allEventMap.size + ' (新規: ' + newEventsFound + ')');
  console.log('\nシリーズ別分布:');
  for (var [sid, info] of Object.entries(seriesDistribution)) {
    console.log('  ' + sid + ' (' + info.name + '): ' + info.count + '件');
  }
  console.log('\n保存先:');
  console.log('  event一覧: ' + eventListPath);
  console.log('  event_idリスト: ' + idsPath);
}

function saveResults(outputPath, monthLabel, totalOrganizers, success, errors, skipped, eventMap, processedSet, newEvents) {
  var events = Array.from(eventMap.values());
  fs.writeFileSync(outputPath, JSON.stringify({
    monthLabel: monthLabel,
    fetchedAt: new Date().toISOString(),
    totalOrganizers: totalOrganizers,
    successOrganizers: success,
    errorOrganizers: errors,
    skippedOrganizers: skipped,
    totalEvents: events.length,
    newEventsFound: newEvents,
    processedOrganizers: Array.from(processedSet),
    events: events
  }, null, 2));
}

main().catch(console.error);
