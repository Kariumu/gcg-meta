// scripts/merge-diff-events.js
// 差分データ (diff_events_YYYYMMDD.json) を data/events.json へ追加マージする。
//
// 方針（2026-04-21, 松岡さん確認済み）:
//   - 新規イベント（既存 events.json に event_id が存在しないもの）はそのまま追加
//   - 重複イベント（event_id が既存にあるもの）は **現状を維持** し、diff を無視
//       理由: 現状 events.json の重複 3 件は既に results が完全一致で入っており、
//             かつ top4_colors / region / fetched_at / tcgplus_url など diff 側に
//             存在しない付加情報を保持しているため、上書きすると情報欠損する。
//   - 件数等の整合性レポートを標準出力に書き出す。
//
// 使い方:
//   node scripts/merge-diff-events.js <diff_json_path>

const fs = require('fs');
const path = require('path');

const diffPath = process.argv[2];
if (!diffPath) {
  console.error('Usage: node scripts/merge-diff-events.js <diff_json_path>');
  process.exit(1);
}

const eventsPath = path.resolve(__dirname, '..', 'data', 'events.json');

const diff = JSON.parse(fs.readFileSync(diffPath, 'utf8'));
const current = JSON.parse(fs.readFileSync(eventsPath, 'utf8'));

if (!current.events) {
  console.error('ERROR: current events.json has no "events" key.');
  process.exit(2);
}

const beforeCount = Object.keys(current.events).length;
let newCount = 0;
let skippedCount = 0;
const skippedIds = [];

for (const [eventId, eventData] of Object.entries(diff.events)) {
  if (current.events[eventId]) {
    // 重複 → 現状維持（付加情報の欠損を避ける）
    skippedCount++;
    skippedIds.push(eventId);
    continue;
  }
  current.events[eventId] = eventData;
  newCount++;
}

const afterCount = Object.keys(current.events).length;

fs.writeFileSync(eventsPath, JSON.stringify(current, null, 2), 'utf8');

console.log('=== マージ結果 ===');
console.log(`diff 対象件数: ${Object.keys(diff.events).length}件`);
console.log(`マージ前 events.json: ${beforeCount}件`);
console.log(`マージ後 events.json: ${afterCount}件`);
console.log(`新規追加: ${newCount}件`);
console.log(`重複スキップ（現状維持）: ${skippedCount}件`);
if (skippedIds.length) {
  console.log(`重複ID: ${skippedIds.join(', ')}`);
}
