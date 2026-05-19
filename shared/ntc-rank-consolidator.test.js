#!/usr/bin/env node
/**
 * shared/ntc-rank-consolidator.js のユニットテスト
 *
 * 実行: node shared/ntc-rank-consolidator.test.js
 * 全パスで exit 0、いずれか失敗で exit 1
 *
 * テストパターン(指示書 セクション6-2 Step1 のカバレッジ要件 + 二次確認指摘の追加):
 *  パターン1: 64名NTC大会、連番 [1..16] → 各順位2名
 *  パターン2: 64名NTC大会、タイ含み [1,2,3,4,5,5,7,8,9,..,16] → 各順位2名
 *  パターン3: 異常データ results.length=17、[1..16,16] → 新8位が3名
 *  パターン4: 32名NTC大会、results.length=8 → no-op
 *  パターン5: 異常データ results.length=9 → no-op
 *  パターン6: 他 series_id → no-op
 *  パターン7: 64名NTC大会で getDeckColors 提供 → top4_colors が新rank=1〜8 と整合する各2件
 *  パターン8: 32名NTC大会で getDeckColors 提供 → top4_colors は元のまま変更なし(R5補強)
 *  パターン9: 元オブジェクト不変性(破壊しないことの確認)
 *  パターン10: NTC でも results が無い/不正な場合 → no-op
 */

'use strict';

const assert = require('assert');
const { consolidateNtcRank, isTargetEvent, NTC_SERIES_IDS } =
  require('./ntc-rank-consolidator');

// === テストヘルパー ===

let passCount = 0;
let failCount = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passCount++;
    console.log('  [PASS] ' + name);
  } catch (e) {
    failCount++;
    failures.push({ name: name, error: e });
    console.log('  [FAIL] ' + name);
    console.log('         ' + e.message);
  }
}

// テスト用イベント生成
function makeEvent(seriesId, ranks, opts) {
  opts = opts || {};
  const results = ranks.map((rank, i) => ({
    rank: rank,
    player: 'p' + i,
    deck_no: i,
    deck: opts.withDecks
      ? [{ card_id: 'TEST-' + (i % 3 + 1), count: 4 }]
      : [],
    tcgplus_url: 'http://example.com/' + i
  }));
  const top4_colors = ranks
    .filter(r => r <= 4)
    .map((r, i) => ({
      rank: r,
      colors: ['Blue'],
      type_key: 'Blue'
    }));
  return {
    series_id: seriesId,
    event_id: 'evt-' + Math.random().toString(36).slice(2, 9),
    date: '2026-03-15',
    store: 'テスト店',
    region: 'テスト',
    results: results,
    top4_colors: top4_colors,
    fetched_at: '2026-03-15T00:00:00Z'
  };
}

// モック getDeckColors: card_id の末尾の数字で色を決定的に返す
function mockGetDeckColors(deck) {
  if (!deck || deck.length === 0) return [];
  const tail = (deck[0].card_id || '').slice(-1);
  if (tail === '1') return ['Blue'];
  if (tail === '2') return ['Red'];
  if (tail === '3') return ['Green'];
  return ['White'];
}

// === テスト本体 ===

console.log('=== ntc-rank-consolidator.js テスト開始 ===\n');

// --- パターン1: 64名NTC大会、連番 [1..16] ---
test('P1: 64名NTC連番 → 新rank が [1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8]、各順位2名', () => {
  const ev = makeEvent('6226', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  const out = consolidateNtcRank(ev);

  assert.strictEqual(out.results.length, 16);
  const newRanks = out.results.map(r => r.rank);
  assert.deepStrictEqual(newRanks, [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8]);

  // 各順位2名であることを確認
  const counts = {};
  newRanks.forEach(r => { counts[r] = (counts[r] || 0) + 1; });
  for (let r = 1; r <= 8; r++) {
    assert.strictEqual(counts[r], 2, '新rank=' + r + ' が2名ではない: ' + counts[r]);
  }
});

// --- パターン2: 64名NTC大会、タイ含み [1,2,3,4,5,5,7,8,9..16] ---
test('P2: 64名NTCタイ含み → 同じく各順位2名(機械的振り分け)', () => {
  const ev = makeEvent('6226', [1, 2, 3, 4, 5, 5, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  const out = consolidateNtcRank(ev);

  const newRanks = out.results.map(r => r.rank);
  // Math.ceil([1,2,3,4,5,5,7,8,9,10,11,12,13,14,15,16]/2) = [1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8]
  assert.deepStrictEqual(newRanks, [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8]);

  const counts = {};
  newRanks.forEach(r => { counts[r] = (counts[r] || 0) + 1; });
  for (let r = 1; r <= 8; r++) {
    assert.strictEqual(counts[r], 2);
  }
});

// --- パターン3: results.length=17 異常データ ---
test('P3: results.length=17 [1..16,16] → 新8位が3名(他は2名)', () => {
  const ranks17 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 16];
  const ev = makeEvent('6226', ranks17);
  const out = consolidateNtcRank(ev);

  assert.strictEqual(out.results.length, 17);
  const newRanks = out.results.map(r => r.rank);
  assert.deepStrictEqual(newRanks,
    [1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 8],
    '17件の変換結果が想定と異なる');

  const counts = {};
  newRanks.forEach(r => { counts[r] = (counts[r] || 0) + 1; });
  assert.strictEqual(counts[8], 3, '新8位が3名でない: ' + counts[8]);
  for (let r = 1; r <= 7; r++) {
    assert.strictEqual(counts[r], 2, '新rank=' + r + ' が2名でない: ' + counts[r]);
  }
});

// --- パターン4: 32名NTC大会、results.length=8 → no-op ---
test('P4: 32名NTC大会(results.length=8) → 変換されず元のまま', () => {
  const ev = makeEvent('6226', [1, 2, 3, 4, 5, 6, 7, 8]);
  const out = consolidateNtcRank(ev);

  // 元オブジェクトと同一参照(no-op)
  assert.strictEqual(out, ev, 'no-op 時は元オブジェクト参照を返すべき');
  // rank が変更されていない
  const newRanks = out.results.map(r => r.rank);
  assert.deepStrictEqual(newRanks, [1, 2, 3, 4, 5, 6, 7, 8]);
});

// --- パターン5: results.length=9 異常データ → no-op ---
test('P5: results.length=9 → 変換対象外、no-op', () => {
  const ev = makeEvent('6226', [1, 2, 3, 4, 5, 6, 7, 8, 8]);
  const out = consolidateNtcRank(ev);

  assert.strictEqual(out, ev);
  const newRanks = out.results.map(r => r.rank);
  assert.deepStrictEqual(newRanks, [1, 2, 3, 4, 5, 6, 7, 8, 8]);
});

// --- パターン6: 他 series_id → no-op ---
test('P6: 別 series_id (チャンピオンシップ想定) → no-op (R5 充足)', () => {
  const ev = makeEvent('9999', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
  const out = consolidateNtcRank(ev);

  assert.strictEqual(out, ev, '他 series_id では no-op であるべき');
  const newRanks = out.results.map(r => r.rank);
  assert.deepStrictEqual(newRanks, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
});

// --- パターン7: 64名NTC + getDeckColors → top4_colors が新rank=1〜8 と整合 ---
test('P7: 64名NTC + getDeckColors → 完全再生成。新rank=1〜8 と整合する各2件', () => {
  const ev = makeEvent('6226',
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    { withDecks: true });
  const out = consolidateNtcRank(ev, { getDeckColors: mockGetDeckColors });

  // top4_colors は新rank=1〜8 の各2件 = 計16件であるべき
  assert.strictEqual(out.top4_colors.length, 16,
    'top4_colors が16件であるべき(実際: ' + out.top4_colors.length + ')');

  const colorCounts = {};
  out.top4_colors.forEach(t => {
    colorCounts[t.rank] = (colorCounts[t.rank] || 0) + 1;
  });
  for (let r = 1; r <= 8; r++) {
    assert.strictEqual(colorCounts[r], 2,
      'top4_colors の新rank=' + r + ' が2件でない: ' + colorCounts[r]);
  }

  // type_key と colors の整合性確認(各エントリ)
  out.top4_colors.forEach(t => {
    assert.ok(Array.isArray(t.colors), 'colors は配列であるべき');
    assert.strictEqual(t.type_key, t.colors.join('+'),
      'type_key は colors.join("+") と一致すべき');
  });
});

// --- パターン8: 32名NTC + getDeckColors → top4_colors は元のまま ---
test('P8: 32名NTC(results.length=8) + getDeckColors → 元 top4_colors のまま変更なし', () => {
  const ev = makeEvent('6226', [1, 2, 3, 4, 5, 6, 7, 8], { withDecks: true });
  const originalTop4 = ev.top4_colors;
  const out = consolidateNtcRank(ev, { getDeckColors: mockGetDeckColors });

  // no-op であるべき(同一参照)
  assert.strictEqual(out, ev, '32名NTC では no-op であるべき');
  assert.strictEqual(out.top4_colors, originalTop4,
    'top4_colors は元のまま(再生成されない)');
});

// --- パターン9: 元オブジェクト不変性 ---
test('P9: 64名NTC変換後、元イベントオブジェクトが破壊されない', () => {
  const ev = makeEvent('6226',
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16],
    { withDecks: true });
  const origResultsRef = ev.results;
  const origRank0 = ev.results[0].rank;
  const origTop4Ref = ev.top4_colors;

  const out = consolidateNtcRank(ev, { getDeckColors: mockGetDeckColors });

  assert.notStrictEqual(out, ev, '変換後は新オブジェクトであるべき');
  assert.notStrictEqual(out.results, origResultsRef, 'results は新配列であるべき');
  assert.notStrictEqual(out.top4_colors, origTop4Ref, 'top4_colors は新配列であるべき');
  assert.strictEqual(ev.results[0].rank, origRank0,
    '元オブジェクトの results[0].rank は変更されていない(' + origRank0 + ')');
  assert.strictEqual(ev.results.length, 16, '元 results.length は不変');
});

// --- パターン10: NTC でも results が無い/不正な場合 → no-op ---
test('P10: results が undefined / null / 配列でない場合 → no-op', () => {
  const ev1 = { series_id: '6226', event_id: 'x' }; // results なし
  assert.strictEqual(consolidateNtcRank(ev1), ev1);

  const ev2 = { series_id: '6226', results: null };
  assert.strictEqual(consolidateNtcRank(ev2), ev2);

  const ev3 = { series_id: '6226', results: 'not-an-array' };
  assert.strictEqual(consolidateNtcRank(ev3), ev3);

  // 完全に null event でもクラッシュしない
  assert.strictEqual(consolidateNtcRank(null), null);
  assert.strictEqual(consolidateNtcRank(undefined), undefined);
});

// --- 補助確認: isTargetEvent ---
test('isTargetEvent: 各境界条件で期待通り', () => {
  assert.strictEqual(isTargetEvent({ series_id: '6226', results: new Array(16) }), true);
  assert.strictEqual(isTargetEvent({ series_id: '6226', results: new Array(17) }), true);
  assert.strictEqual(isTargetEvent({ series_id: '6226', results: new Array(15) }), false);
  assert.strictEqual(isTargetEvent({ series_id: '6226', results: new Array(8) }), false);
  assert.strictEqual(isTargetEvent({ series_id: '6226', results: new Array(9) }), false);
  assert.strictEqual(isTargetEvent({ series_id: '9999', results: new Array(16) }), false);
  assert.strictEqual(isTargetEvent(null), false);
  assert.strictEqual(isTargetEvent({}), false);
});

// === サマリー ===
console.log('\n=== テスト結果 ===');
console.log('  PASS: ' + passCount);
console.log('  FAIL: ' + failCount);

if (failCount > 0) {
  console.log('\n失敗詳細:');
  failures.forEach(f => {
    console.log('  - ' + f.name);
    console.log('    ' + f.error.stack);
  });
  process.exit(1);
} else {
  console.log('\nすべてのテストがパスしました');
  process.exit(0);
}
