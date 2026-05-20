#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  consolidateNtcRank,
  isTargetEvent,
  isTargetSeries,
  makeIsNtcTypeFromSeriesMap,
  NTC_SERIES_IDS
} = require('./ntc-rank-consolidator');

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

function makeEvent(seriesId, ranks, opts) {
  opts = opts || {};
  const results = ranks.map((rank, i) => ({
    rank, player: 'p' + i, deck_no: i,
    deck: opts.withDecks ? [{ card_id: 'TEST-' + (i % 3 + 1), count: 4 }] : [],
    tcgplus_url: 'http://example.com/' + i
  }));
  const top4_colors = ranks.filter(r => r <= 4).map(r => ({
    rank: r, colors: ['Blue'], type_key: 'Blue'
  }));
  return {
    series_id: seriesId, event_id: 'evt-' + Math.random().toString(36).slice(2, 9),
    date: '2026-03-15', store: 'テスト店', region: 'テスト',
    results, top4_colors, fetched_at: '2026-03-15T00:00:00Z'
  };
}

function mockGetDeckColors(deck) {
  if (!deck || deck.length === 0) return [];
  const tail = (deck[0].card_id || '').slice(-1);
  if (tail === '1') return ['Blue'];
  if (tail === '2') return ['Red'];
  if (tail === '3') return ['Green'];
  return ['White'];
}

console.log('=== ntc-rank-consolidator.js テスト ===\n');

test('P1: 64名NTC連番 → 各順位2名', () => {
  const ev = makeEvent('6226', [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]);
  const out = consolidateNtcRank(ev);
  assert.deepStrictEqual(out.results.map(r => r.rank), [1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8]);
});

test('P2: タイ含み 64名NTC → 各順位2名', () => {
  const ev = makeEvent('6226', [1,2,3,4,5,5,7,8,9,10,11,12,13,14,15,16]);
  const out = consolidateNtcRank(ev);
  assert.deepStrictEqual(out.results.map(r => r.rank), [1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8]);
});

test('P3: results.length=17 → 新8位3名', () => {
  const ev = makeEvent('6226', [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,16]);
  const out = consolidateNtcRank(ev);
  assert.deepStrictEqual(out.results.map(r => r.rank), [1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,8]);
});

test('P4: 32名NTC (length=8) → no-op', () => {
  const ev = makeEvent('6226', [1,2,3,4,5,6,7,8]);
  assert.strictEqual(consolidateNtcRank(ev), ev);
});

test('P5: length=9 → no-op', () => {
  const ev = makeEvent('6226', [1,2,3,4,5,6,7,8,8]);
  assert.strictEqual(consolidateNtcRank(ev), ev);
});

test('P6: 別 series_id → no-op', () => {
  const ev = makeEvent('99999', [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]);
  assert.strictEqual(consolidateNtcRank(ev), ev);
});

test('P7: getDeckColors 提供 → top4_colors 完全再生成 16件', () => {
  const ev = makeEvent('6226', [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16], { withDecks: true });
  const out = consolidateNtcRank(ev, { getDeckColors: mockGetDeckColors });
  assert.strictEqual(out.top4_colors.length, 16);
  const counts = {};
  out.top4_colors.forEach(t => { counts[t.rank] = (counts[t.rank]||0)+1; });
  for (let r = 1; r <= 8; r++) assert.strictEqual(counts[r], 2);
});

test('P8: 32名NTC + getDeckColors → top4_colors 不変', () => {
  const ev = makeEvent('6226', [1,2,3,4,5,6,7,8], { withDecks: true });
  const orig = ev.top4_colors;
  const out = consolidateNtcRank(ev, { getDeckColors: mockGetDeckColors });
  assert.strictEqual(out, ev);
  assert.strictEqual(out.top4_colors, orig);
});

test('P9: 元オブジェクト不変', () => {
  const ev = makeEvent('6226', [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16], { withDecks: true });
  const orig0 = ev.results[0].rank;
  const out = consolidateNtcRank(ev, { getDeckColors: mockGetDeckColors });
  assert.notStrictEqual(out, ev);
  assert.notStrictEqual(out.results, ev.results);
  assert.strictEqual(ev.results[0].rank, orig0);
});

test('P10: results 不正 → no-op', () => {
  const e1 = { series_id: '6226', event_id: 'x' };
  assert.strictEqual(consolidateNtcRank(e1), e1);
  assert.strictEqual(consolidateNtcRank(null), null);
  assert.strictEqual(consolidateNtcRank(undefined), undefined);
});

test('P11: MISSION3 series_id=6776 がハードコード配列で NTC 判定', () => {
  const ev = makeEvent('6776', [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]);
  const out = consolidateNtcRank(ev);
  assert.deepStrictEqual(out.results.map(r => r.rank), [1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8]);
});

test('P12: options.isNtcType を渡すと未知 series でも NTC 判定', () => {
  const ev = makeEvent('99999', [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]);
  const out = consolidateNtcRank(ev, { isNtcType: (s) => s === '99999' });
  assert.deepStrictEqual(out.results.map(r => r.rank), [1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8]);
});

test('P13: ハードコード内 + isNtcType=false でもフォールバックで判定', () => {
  const ev = makeEvent('6226', [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]);
  const out = consolidateNtcRank(ev, { isNtcType: () => false });
  assert.deepStrictEqual(out.results.map(r => r.rank), [1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8]);
});

test('P14: 未知 series + isNtcType=false → no-op', () => {
  const ev = makeEvent('99999', [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16]);
  const out = consolidateNtcRank(ev, { isNtcType: () => false });
  assert.strictEqual(out, ev);
});

test('P15: makeIsNtcTypeFromSeriesMap', () => {
  const map = {
    '6226': { type: 'ntc' },
    '6776': { type: 'ntc' },
    '9999': { type: 'championship' }
  };
  const isNtc = makeIsNtcTypeFromSeriesMap(map);
  assert.strictEqual(isNtc('6226'), true);
  assert.strictEqual(isNtc('6776'), true);
  assert.strictEqual(isNtc('9999'), false);
  assert.strictEqual(isNtc('xxx'), false);
  assert.strictEqual(isNtc(null), false);
});

test('P16: type ベースで未知 NTC series + getDeckColors', () => {
  const map = { '7777': { type: 'ntc' } };
  const isNtc = makeIsNtcTypeFromSeriesMap(map);
  const ev = makeEvent('7777', [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16], { withDecks: true });
  const out = consolidateNtcRank(ev, { isNtcType: isNtc, getDeckColors: mockGetDeckColors });
  assert.deepStrictEqual(out.results.map(r => r.rank), [1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8]);
  assert.strictEqual(out.top4_colors.length, 16);
});

console.log('\n=== 結果 ===');
console.log('  PASS: ' + passCount);
console.log('  FAIL: ' + failCount);
if (failCount > 0) {
  failures.forEach(f => console.log('  - ' + f.name + ': ' + f.error.message));
  process.exit(1);
} else {
  console.log('\nすべてのテストがパスしました');
  process.exit(0);
}
