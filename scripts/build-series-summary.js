#!/usr/bin/env node
/**
 * scripts/build-series-summary.js
 *
 * data/series.json と data/events.json を読み、シリーズ毎の集計サマリーを
 * data/series/{slug}-summary.json に出力する。
 *
 * シリーズ毎の出力内容:
 *   - series.json の meta 情報一式（status は今日の日付で再判定）
 *   - stats:
 *       event_count        : 該当シリーズのイベント数
 *       total_result_entries : 結果エントリ総数（results[].length を全件合算）
 *       total_decks        : Top4 として分類できたデッキ数（top4_colors 合算）
 *       by_region          : 地域別 {events, decks}
 *       deck_type_ranking  : デッキタイプ別 {type_key, colors, label, count, share}
 *                            share = count / total_decks * 100、count 降順
 *       winning_decks      : 優勝デッキタイプ別 {type_key, label, wins, win_rate}
 *                            win_rate = wins / count * 100、wins 降順
 *
 * status 判定: 今日 < start_date → upcoming / end_date 以前 → active / それ以降 → completed
 *
 * 使い方: node scripts/build-series-summary.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

// === NTC順位集計統合(指示書 NTC順位集計統合_最終版.md, 2026-05-18 実装、2026-05-19 type ベース対応) ===
// 64名定員NTC大会を「ベスト8(各順位2名)」表記に変換する。
// 旧: 集計対象を TOP4 → TOP8(各2件=最大16件)に拡張。指示書70(2026-08-12)で撤回し、
//     変換後 rank<=4(公式1〜8位=各セット4位まで)へ戻した。
// 32名定員大会や他大会には一切影響を与えない(R2/R5 厳守)。
// 注意: 64名NTC 大会は 1イベントあたり total_decks が 8 件(4位×2セット)になる。
//       旧実装では 16 件(TOP8×各2名・松岡さん回答 追加確認1: B案)。指示書70で撤回。
// NTC 判定は series.json の type='ntc' を参照(MISSION2/3/4... に自動対応)。
const {
  consolidateNtcRank,
  isTargetEvent: isNtcConsolidationTarget,
  makeIsNtcTypeFromSeriesMap
} = require('../shared/ntc-rank-consolidator');
const { getDeckColors } = require('../scraper');

let SERIES_MAP_FOR_NTC = {};
try {
  SERIES_MAP_FOR_NTC = JSON.parse(
    require('fs').readFileSync(require('path').join(__dirname, '..', 'data', 'series.json'), 'utf-8')
  );
} catch (_) {}
const isNtcType = makeIsNtcTypeFromSeriesMap(SERIES_MAP_FOR_NTC);

const ROOT = path.resolve(__dirname, '..');
const SERIES_PATH = path.join(ROOT, 'data', 'series.json');
const EVENTS_PATH = path.join(ROOT, 'data', 'events.json');
const OUT_DIR = path.join(ROOT, 'data', 'series');

const COLOR_JA = {
  Red: '赤',
  Blue: '青',
  White: '白',
  Purple: '紫',
  Green: '緑',
  Yellow: '黄',
  Black: '黒'
};

function colorsToLabel(colors) {
  if (!colors || colors.length === 0) return '';
  return colors.map(c => COLOR_JA[c] || c).join('/');
}

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

function writeJson(p, data) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function determineStatus(meta, today) {
  if (today < meta.start_date) return 'upcoming';
  if (today > meta.end_date) return 'completed';
  return 'active';
}

function buildSummary(seriesMeta, seriesEvents) {
  const event_count = seriesEvents.length;

  // 結果エントリ総数・Top4デッキ数
  let total_result_entries = 0;
  let total_decks = 0;
  const byRegion = {}; // region -> { events:Set<eid>, decks:number }
  const typeCountByKey = {}; // type_key -> { type_key, colors, count, wins }

  for (const evRaw of seriesEvents) {
    // 64名NTC大会のみ rank を「ベスト8(各順位2名)」表記に変換、top4_colors も
    // 新rank=1〜8(最大16件)に完全再生成する。32名・他大会は no-op(R2/R5 厳守)。
    const ev = consolidateNtcRank(evRaw, { getDeckColors, isNtcType });

    if (ev.results) total_result_entries += ev.results.length;

    if (ev.top4_colors) {
      for (const t of ev.top4_colors) {
        // 指示書70(2026-08-12): TOP8 拡張を撤回。64名NTC は変換後 rank<=4 のみ集計する
        // (32名・他大会の top4_colors は元から rank<=4 のみなので影響なし)
        if (t.rank > 4) continue;
        total_decks++;
        // regional tally
        const reg = ev.region || '(不明)';
        if (!byRegion[reg]) byRegion[reg] = { events: new Set(), decks: 0 };
        byRegion[reg].decks++;
        byRegion[reg].events.add(ev.event_id);

        // type ranking
        if (!typeCountByKey[t.type_key]) {
          typeCountByKey[t.type_key] = { type_key: t.type_key, colors: t.colors, count: 0, wins: 0 };
        }
        typeCountByKey[t.type_key].count++;
        // 優勝判定: 新rank=1。64名NTCでは1イベントあたり「優勝」が2件発生する(松岡さん回答 R1)。
        if (t.rank === 1) typeCountByKey[t.type_key].wins++;
      }
    } else {
      // top4 欠損時も region の events にはカウントする
      const reg = ev.region || '(不明)';
      if (!byRegion[reg]) byRegion[reg] = { events: new Set(), decks: 0 };
      byRegion[reg].events.add(ev.event_id);
    }
  }

  // by_region を整形
  const by_region = {};
  for (const [reg, v] of Object.entries(byRegion)) {
    by_region[reg] = { events: v.events.size, decks: v.decks };
  }

  // deck_type_ranking: count 降順
  const deck_type_ranking = Object.values(typeCountByKey)
    .map(x => ({
      type_key: x.type_key,
      colors: x.colors,
      label: colorsToLabel(x.colors),
      count: x.count,
      share: total_decks > 0 ? Number(((x.count / total_decks) * 100).toFixed(1)) : 0
    }))
    .sort((a, b) => b.count - a.count);

  // winning_decks: wins 降順
  const winning_decks = Object.values(typeCountByKey)
    .filter(x => x.wins > 0)
    .map(x => ({
      type_key: x.type_key,
      colors: x.colors,
      label: colorsToLabel(x.colors),
      wins: x.wins,
      count: x.count,
      win_rate: x.count > 0 ? Number(((x.wins / x.count) * 100).toFixed(1)) : 0
    }))
    .sort((a, b) => b.wins - a.wins);

  return {
    ...seriesMeta,
    stats: {
      event_count,
      total_result_entries,
      total_decks,
      by_region,
      deck_type_ranking,
      winning_decks
    }
  };
}

function main() {
  const series = loadJson(SERIES_PATH);
  const events = loadJson(EVENTS_PATH);
  const today = new Date().toISOString().split('T')[0];

  const allEvents = Object.values(events.events);

  for (const [id, meta] of Object.entries(series)) {
    // status 自動判定（series.json 側の値を上書きせず、summary に反映）
    const newStatus = determineStatus(meta, today);
    const metaWithStatus = { ...meta, status: newStatus };

    // 該当シリーズのイベント抽出（series_id を文字列比較）
    const seriesEvents = allEvents.filter(ev => String(ev.series_id) === String(id));

    const summary = buildSummary(metaWithStatus, seriesEvents);

    const outPath = path.join(OUT_DIR, meta.slug + '-summary.json');
    writeJson(outPath, summary);
    console.log('wrote: ' + path.relative(ROOT, outPath));
    console.log('  status: ' + newStatus);
    console.log('  event_count: ' + summary.stats.event_count);
    console.log('  total_decks: ' + summary.stats.total_decks);
    console.log('  deck_types: ' + summary.stats.deck_type_ranking.length);
    console.log('  regions: ' + Object.keys(summary.stats.by_region).length);
  }

  console.log('\n=== build-series-summary 完了 ===');
}

main();
