#!/usr/bin/env node
/**
 * scripts/build-ntc-june-interim.js
 * NTC 2026 MISSION3(6月開催, series 6791)の中間集計(指示書v8 Task A-2)
 * data/analysis/ntc-2026-06-interim.json を生成する。
 *
 * 集計規則(松岡さん指定・consolidator 適用後):
 *  - 64名定員大会(results>=16)は consolidateNtcRank で「ベスト8・各順位2名」に換算
 *    (優勝も2名としてカウント)
 *  - 集計対象は rank<=8 かつデッキデータあり
 *  - デッキタイプ = 色組み合わせ(scraper.js の getDeckColors と同一ロジック)
 *  - 5月(series 6776)も同一規則で算出し、シェア増減を比較
 *
 * 使い方:
 *   node scripts/build-ntc-june-interim.js
 *   NTC_INTERIM_ROOT=/path/to/root node scripts/build-ntc-june-interim.js  # 検証用ルート差替え
 */
const fs = require('fs');
const path = require('path');
const ROOT = process.env.NTC_INTERIM_ROOT || path.resolve(__dirname, '..');
// scraper / consolidator は ROOT 配下のものを使用(分類ロジックの同一性を保証)
const { getDeckColors, getRegion } = require(path.join(ROOT, 'scraper.js'));
const { consolidateNtcRank, isTargetEvent } = require(path.join(ROOT, 'shared', 'ntc-rank-consolidator.js'));

const COLOR_JP = { Blue: '青', Red: '赤', Green: '緑', White: '白', Purple: '紫', Unknown: '不明' };
const toLabel = (colors) => colors.map(c => COLOR_JP[c] || c).join('/');

function aggregate(events) {
  const types = {};
  const rankDist = {}; // ベスト8換算の入賞分布(rank別デッキ数)
  const regions = {};
  let decks = 0, winners = 0, consolidated = 0;
  for (const ev of events) {
    const region = ev.region || getRegion(ev.store || '');
    if (!regions[region]) regions[region] = { events: 0, decks: 0, types: {} };
    regions[region].events++;
    if (isTargetEvent(ev, {})) consolidated++;
    const c = consolidateNtcRank(ev, {});
    for (const r of (c.results || [])) {
      if (r.rank > 8) continue;
      if (!r.deck || !r.deck.length) continue;
      decks++;
      rankDist[r.rank] = (rankDist[r.rank] || 0) + 1;
      const colors = getDeckColors(r.deck);
      const key = colors.join('+');
      if (!types[key]) types[key] = { type_key: key, colors, label: toLabel(colors), count: 0, wins: 0 };
      types[key].count++;
      regions[region].decks++;
      regions[region].types[key] = (regions[region].types[key] || 0) + 1;
      if (r.rank === 1) { types[key].wins++; winners++; }
    }
  }
  const list = Object.values(types).sort((a, b) => b.count - a.count || a.type_key.localeCompare(b.type_key));
  for (const t of list) {
    t.share = decks ? Math.round(t.count / decks * 1000) / 10 : 0;
    t.win_rate = t.count ? Math.round(t.wins / t.count * 1000) / 10 : 0;
    t.win_share = winners ? Math.round(t.wins / winners * 1000) / 10 : 0;
  }
  const regionList = Object.entries(regions).map(([name, r]) => ({
    region: name, events: r.events, decks: r.decks,
    top_types: Object.entries(r.types).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([k, n]) => ({ type_key: k, count: n }))
  })).sort((a, b) => b.decks - a.decks);
  return {
    events: events.length, consolidated_events: consolidated,
    decks, winners,
    deck_types: list, rank_distribution: rankDist, regions: regionList
  };
}

function main() {
  const eventsAll = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'events.json'), 'utf-8')).events;
  const june = Object.values(eventsAll).filter(v => String(v.series_id) === '6791');
  const may = Object.values(eventsAll).filter(v => String(v.series_id) === '6776');
  const j = aggregate(june), m = aggregate(may);

  // 5月比較(使用シェアの増減)
  const mShare = {}; for (const t of m.deck_types) mShare[t.type_key] = t.share;
  const cmp = j.deck_types.map(t => ({
    type_key: t.type_key, label: t.label,
    june_share: t.share, may_share: mShare[t.type_key] || 0,
    diff: Math.round((t.share - (mShare[t.type_key] || 0)) * 10) / 10
  }));
  for (const t of m.deck_types) {
    if (!cmp.find(x => x.type_key === t.type_key)) {
      cmp.push({ type_key: t.type_key, label: t.label, june_share: 0, may_share: t.share, diff: Math.round(-t.share * 10) / 10 });
    }
  }
  cmp.sort((a, b) => b.diff - a.diff);

  const dates = june.map(v => v.date).sort();
  const out = {
    generated_at: new Date().toISOString(),
    series_id: '6791',
    period: { from: dates[0], to: dates[dates.length - 1] },
    methodology: '64名定員大会(results>=16)は consolidator で「ベスト8・各順位2名(優勝2名)」に換算。集計対象は rank<=8 かつデッキデータあり。デッキタイプは scraper.js getDeckColors の色組み合わせ。5月(6776)も同一規則で算出。',
    june: j,
    may_baseline: {
      events: m.events, decks: m.decks, winners: m.winners,
      deck_types: m.deck_types.map(({ type_key, label, count, share, wins, win_rate, win_share }) =>
        ({ type_key, label, count, share, wins, win_rate, win_share }))
    },
    share_comparison: cmp
  };
  const outDir = path.join(ROOT, 'data', 'analysis');
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'ntc-2026-06-interim.json');
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n', 'utf-8');
  console.log('書き込み:', outPath);
  console.log('6月: events=' + j.events + ' decks=' + j.decks + ' winners=' + j.winners + ' types=' + j.deck_types.length);
  console.log('上位5タイプ:', j.deck_types.slice(0, 5).map(t => t.label + ' ' + t.share + '%(優勝' + t.wins + ')').join(' / '));
}

main();
// EOF
