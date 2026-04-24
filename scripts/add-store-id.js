#!/usr/bin/env node
/**
 * scripts/add-store-id.js
 *
 * events.json の各イベントに store_id を付与する。
 *
 * 仕様:
 *  - schedule.json の stores を参照し、store 名で突合
 *  - 名称不一致による取りこぼし低減のため、両側を trim() し全角/半角スペースを正規化
 *  - 正規化後も一致しない店舗は MANUAL_STORE_MAP を参照
 *  - どちらでもヒットしない場合は store_id を付与しない（後方互換のため store 名は残す）
 *  - events.json の .events[eid].store（文字列）は保持。store_id を追加するのみ
 *
 * 使い方:
 *   node scripts/add-store-id.js           # 実行して events.json を更新
 *   node scripts/add-store-id.js --dry-run # 統計のみ出力、書き込みなし
 */

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SCHEDULE_PATH = path.join(ROOT, 'data', 'schedule.json');
const EVENTS_PATH = path.join(ROOT, 'data', 'events.json');
const DRY_RUN = process.argv.includes('--dry-run');

// 手動マッピング（schedule.json に該当店舗が無い場合の fallback）
// 2026-04 時点: 以下2店舗は schedule.json に未掲載のため unmatched のまま残す
//   - TSUTAYA若杉店
//   - カードショップデュエルガルドイオン長岡店
// schedule.json に追加された時点でこのファイルから削除し自動マッチに戻すこと。
const MANUAL_STORE_MAP = {
  // '店舗名（events.json 表記）': 店舗ID（数値 or 文字列）
};

/** 店舗名の正規化: trim, 全角スペース→半角スペース, 連続スペース畳み込み */
function normalizeStoreName(name) {
  if (!name) return '';
  return String(name).replace(/\u3000/g, ' ').replace(/\s+/g, ' ').trim();
}

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function writeJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function main() {
  if (!fs.existsSync(SCHEDULE_PATH)) {
    console.error('ERR: ' + SCHEDULE_PATH + ' が見つかりません。');
    console.error('     schedule.json はリポジトリ main に存在するため、clone/pull してください。');
    process.exit(1);
  }
  const schedule = loadJson(SCHEDULE_PATH);
  const events = loadJson(EVENTS_PATH);

  // 店舗名（正規化）→ id マップ
  const storeByNormName = new Map();
  const duplicates = [];
  for (const [id, store] of Object.entries(schedule.stores || {})) {
    const norm = normalizeStoreName(store.name);
    if (!norm) continue;
    if (storeByNormName.has(norm)) {
      duplicates.push({ name: norm, ids: [storeByNormName.get(norm), id] });
    }
    storeByNormName.set(norm, id);
  }
  if (duplicates.length > 0) {
    console.warn('⚠ 同名店舗 ' + duplicates.length + ' 組（後勝ちで処理）');
  }

  // 各イベントに store_id を付与
  let matched = 0;
  let manualMatched = 0;
  const unmatched = [];

  for (const [eid, ev] of Object.entries(events.events)) {
    const origName = ev.store;
    const norm = normalizeStoreName(origName);
    let id = storeByNormName.get(norm);

    if (!id && MANUAL_STORE_MAP[origName]) {
      id = MANUAL_STORE_MAP[origName];
      manualMatched++;
    } else if (!id && MANUAL_STORE_MAP[norm]) {
      id = MANUAL_STORE_MAP[norm];
      manualMatched++;
    }

    if (id !== undefined && id !== null) {
      // number に統一（schedule.json の store.id は number）
      const numId = Number(id);
      ev.store_id = Number.isFinite(numId) ? numId : id;
      matched++;
    } else {
      unmatched.push({ event_id: eid, store: origName });
    }
  }

  const total = Object.keys(events.events).length;
  const rate = ((matched / total) * 100).toFixed(2);
  console.log('=== add-store-id 結果 ===');
  console.log('総イベント数   : ' + total);
  console.log('マッチ（自動） : ' + (matched - manualMatched));
  console.log('マッチ（手動） : ' + manualMatched);
  console.log('マッチ合計     : ' + matched + ' (' + rate + '%)');
  console.log('未マッチ       : ' + unmatched.length);
  if (unmatched.length > 0) {
    console.log('未マッチ店舗一覧:');
    const byStore = {};
    for (const u of unmatched) {
      if (!byStore[u.store]) byStore[u.store] = [];
      byStore[u.store].push(u.event_id);
    }
    for (const [name, ids] of Object.entries(byStore)) {
      console.log('  ' + name + ' (' + ids.length + '件): ' + ids.join(', '));
    }
  }

  if (DRY_RUN) {
    console.log('\n(dry-run: events.json は書き込みません)');
    return;
  }
  writeJson(EVENTS_PATH, events);
  console.log('\nwrote: ' + EVENTS_PATH);
}

main();
