#!/usr/bin/env node
/**
 * x-weekly-banner.js  ―  週次環境速報の画像・窓集計・文面部品（指示書68 共通）
 *
 * A（月曜まとめ / post-x-weekly-pack.js）と B（金曜プレビュー / generate-friday-preview.js）が
 * **同じ実装**を共用するためのモジュール。指示書68 §2「共通」の「画像テンプレ1実装をA/B共用」。
 *
 * 設計上の鉄則（指示書68 §0/§2/§5）:
 *   - X 投稿・メディアアップロードへ到達する経路を持たない（このファイルは描画と集計だけ）
 *   - 窓集計は **data/events_index.json で完結**する。events.json（14.5MB）は読まない
 *   - wall-clock に依存しない。基準日は必ず呼び出し側から渡す（--date 追随のため）
 *   - 数値・文言・構図は決定論。同じ入力なら同じ SVG・同じ文面になる
 *     （PNG のエンコード差は許容。SVG と文面はバイト一致する）
 *   - DECK_COLORS は generate-ntc-dashboard.js の定義を **require して使う**。
 *     3つ目の写しを作らない（CLAUDE.md「common.js の写しは食い違う」への対処）
 *
 * 「rank≦4相当」は generate-events.js:572-578 と**同じ結果**になるように実装する。
 *   generate-events.js は consolidateNtcRank(rank → ceil(rank/2)) を**適用したあと**の
 *   rank に閾値を掛けている。索引は変換**前**の生 rank を持つので、ここで同じ変換をする:
 *     isNtc64 = (series.json の type==='ntc') かつ (results 総数 c >= 16)
 *       → rank = ceil(生rank / 2) に変換してから ≦ 8（＝生rank ≦ 16 = 全件）
 *     それ以外
 *       → 生rank ≦ 4
 *   この規則は meta.html（buildMetaStats:773-774）や post-x-daily.js:308-309 とも同じ。
 *   画像の数値がリンク先 meta.html と食い違わないために、ここを外さないこと。
 *   （2026-08-07 の二次確認で、生rank≦8 としていた誤りを修正。116→164 デッキ等）
 *
 * 作成: 2026-08-07（指示書68 実装セッション）
 */
'use strict';

const fs = require('fs');
const path = require('path');

// js/common.js の DECK_COLORS は generate-ntc-dashboard.js が既に写しを持っている。
// ここでは**その写しを require** して使う（新たな写しを作らない）。
const { DECK_COLORS } = require('./generate-ntc-dashboard.js');

// 指示書67 発行元裁定: type_key はサイト全体でこの順に統一する
const COLOR_SORT_ORDER = ['Blue', 'Red', 'Green', 'White', 'Purple'];

const CANVAS = { W: 1200, H: 675, PAD_X: 60, PAD_TOP: 46 };

// Windows(Yu Gothic UI) と Linux(Noto Sans CJK JP) の双方を1リストで解決する。
// Step 0 の実測: E:(Windows) では Yu Gothic UI で解決され、豆腐0。
const FONT_STACK = 'Yu Gothic UI,Yu Gothic,Meiryo,Noto Sans CJK JP,Noto Sans JP,MS PGothic,sans-serif';

const SITE_LABEL = 'gcg-stats.com/meta.html';

// ===================================================================
// 日付ユーティリティ（UTC 固定・wall-clock 非依存）
// ===================================================================
function toDate(s) { return new Date(s + 'T00:00:00Z'); }
function iso(d) { return d.toISOString().slice(0, 10); }
function addDays(s, n) { const d = toDate(s); d.setUTCDate(d.getUTCDate() + n); return iso(d); }
function dayOfWeek(s) { return toDate(s).getUTCDay(); }          // 0=日 1=月 … 6=土
function mondayOf(s) { const w = dayOfWeek(s); return addDays(s, w === 0 ? -6 : 1 - w); }
function mdSlash(s) { return Number(s.slice(5, 7)) + '/' + Number(s.slice(8, 10)); }
function isDateStr(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return false;
  const d = toDate(s);
  return !isNaN(d.getTime()) && iso(d) === s;
}

/**
 * A（月曜まとめ）の窓 = 実行日を含む週の月〜日。
 * 日曜21:30以降に実行する想定なので、日曜実行なら「その週の月〜当日」になる。
 */
function windowMonday(today) {
  const from = mondayOf(today);
  return { from, to: addDays(from, 6) };
}

/**
 * B（金曜プレビュー）の窓 = 前週金曜〜当週木曜（実行日）。
 * 実装は「実行日を終わりとする直近7日」。**木曜に呼ばれたときだけ**
 * 「前週金曜〜当週木曜」と一致する。呼び出し側（generate-friday-preview.js）は
 * 木曜以外を先に弾くので、この関数が木曜以外で評価されることはない。
 */
function windowFriday(today) {
  return { from: addDays(today, -6), to: today };
}

// ===================================================================
// 入力
// ===================================================================
function loadIndex(root) {
  const p = path.join(root, 'data', 'events_index.json');
  const idx = JSON.parse(fs.readFileSync(p, 'utf-8'));
  if (!idx || !Array.isArray(idx.events)) throw new Error('events_index.json の形式が不正です: ' + p);
  return idx;
}

/** series.json から type==='ntc' のシリーズID集合と、ID→official_name を返す */
function loadSeries(root) {
  const p = path.join(root, 'data', 'series.json');
  const s = JSON.parse(fs.readFileSync(p, 'utf-8'));
  const ntc = new Set();
  const nameById = {};
  for (const k of Object.keys(s)) {
    if (!s[k]) continue;
    nameById[String(k)] = s[k].official_name || s[k].display_name || '';
    if (s[k].type === 'ntc') ntc.add(String(k));
  }
  return { ntc, nameById };
}

// ===================================================================
// 窓集計
// ===================================================================
const COLOR_JP = {};
for (const k of Object.keys(DECK_COLORS)) COLOR_JP[k] = DECK_COLORS[k].jp;

/** 保存値の並びがどうであれ COLOR_SORT_ORDER に正規化する（指示書67 裁定「読み出し時に正規化」） */
function normalizeTypeKey(typeKey) {
  const cs = String(typeKey).split('+').filter(Boolean);
  const known = cs.filter((c) => COLOR_SORT_ORDER.includes(c));
  const rest = cs.filter((c) => !COLOR_SORT_ORDER.includes(c));
  known.sort((a, b) => COLOR_SORT_ORDER.indexOf(a) - COLOR_SORT_ORDER.indexOf(b));
  return known.concat(rest).join('+');
}
function labelOf(typeKey) {
  return String(typeKey).split('+').map((c) => COLOR_JP[c] || c).join('/');
}

/**
 * @param {object} idx      events_index.json
 * @param {Set}    ntcSet   NTC シリーズID
 * @param {string} from     'YYYY-MM-DD'（含む）
 * @param {string} to       'YYYY-MM-DD'（含む）
 * @param {object} [opts]   { topN=6 }
 */
function aggregateWindow(idx, ntcSet, from, to, opts) {
  const topN = (opts && opts.topN) || 6;
  const typeMap = new Map();
  const seriesCount = new Map();
  let deckTotal = 0, eventCount = 0, latestDate = null;

  for (const ev of idx.events) {
    if (!ev || !ev.d || ev.d < from || ev.d > to) continue;
    const sid = String(ev.s);
    if (!ntcSet.has(sid)) continue;                       // NTC 公式大会のみ

    const results = ev.r || [];
    // isTargetEvent(generate-events.js) と等価: NTC シリーズ かつ results が 16 件以上
    const isNtc64 = (ev.c || results.length) >= 16;
    const threshold = isNtc64 ? 8 : 4;

    let used = 0;
    for (const row of results) {
      const raw = row && row[0];
      const rawKey = row && row[1];
      if (typeof raw !== 'number' || !rawKey) continue;
      // NTC64 は consolidateNtcRank と同じ変換をしてから閾値を掛ける
      const rank = isNtc64 ? Math.ceil(raw / 2) : raw;
      if (rank > threshold) continue;
      const key = normalizeTypeKey(rawKey);
      typeMap.set(key, (typeMap.get(key) || 0) + 1);
      used++; deckTotal++;
    }
    if (used > 0) {
      eventCount++;
      seriesCount.set(sid, (seriesCount.get(sid) || 0) + 1);
      if (!latestDate || ev.d > latestDate) latestDate = ev.d;
    }
  }

  // 同数のときは type_key の辞書順で決める（決定論のため）
  const sorted = [...typeMap.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const top = sorted.slice(0, topN);
  const restCount = sorted.slice(topN).reduce((s, x) => s + x[1], 0);
  const share = (n) => (deckTotal ? Math.round((n / deckTotal) * 1000) / 10 : 0);

  const rows = top.map(([k, n]) => ({ typeKey: k, label: labelOf(k), colors: k.split('+'), count: n, share: share(n) }));
  if (restCount > 0) rows.push({ typeKey: null, label: 'その他', colors: null, count: restCount, share: share(restCount) });

  // 窓内で最も多いシリーズ（タグ表示用）。同数なら ID 昇順で決める
  let mainSeries = null;
  for (const [sid, n] of [...seriesCount.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))) {
    mainSeries = sid; break;
  }

  return { from, to, eventCount, deckTotal, distinctTypes: sorted.length, latestDate, rows, mainSeries };
}

// ===================================================================
// 文面
//   weightedLength は呼び出し側（post-x-daily.js の実装）を注入してもらう。
//   ここで再実装すると X の数え方が二重定義になるため。
// ===================================================================
function pct(n) { return (Math.round(n * 10) / 10).toString(); }

function topLine(agg) {
  const t = agg.rows.find((r) => r.typeKey) || agg.rows[0];
  return t ? { label: t.label, share: pct(t.share), count: t.count } : null;
}

/** A: 月曜まとめ（指示書68 §2-A の趣旨） */
function buildMondayText(agg) {
  const t = topLine(agg);
  const lines = [
    '【NTC 週間環境まとめ】' + mdSlash(agg.from) + '〜' + mdSlash(agg.to) + ' の上位入賞'
      + agg.deckTotal + 'デッキを集計。',
    t ? ('トップは' + t.label + '（' + t.share + '%）。') : '',
    '詳しい環境分析は↓',
    'https://gcg-stats.com/meta.html',
    '#ガンダムカードゲーム'
  ].filter(Boolean);
  return lines.join('\n');
}

/** B: 金曜プレビュー（指示書68 §2-B の趣旨） */
function buildFridayText(agg) {
  const t = topLine(agg);
  const lines = [
    '【今週末の対戦の参考に】直近1週間（' + mdSlash(agg.from) + '〜' + mdSlash(agg.to) + '）のNTC環境。',
    t ? ('トップは' + t.label + '（' + t.share + '%・' + t.count + 'デッキ）。') : '',
    '上位入賞' + agg.deckTotal + 'デッキを集計しています。',
    'https://gcg-stats.com/meta.html',
    '#ガンダムカードゲーム'
  ].filter(Boolean);
  return lines.join('\n');
}

/**
 * 280（加重）検査。超過したら短くする。
 * 落とす順序は「本文の飾り → ハッシュタグ」。**URL は決して落とさない**（誘導先を失うため）。
 * ハッシュタグは最後の手段。それでも収まらなければ over=true を返し、呼び出し側が手動対応を促す。
 */
function fitText(text, weightedLength, max) {
  const limit = max || 280;
  let lines = text.split('\n');
  let w = weightedLength(lines.join('\n'));
  const dropped = [];
  const dropOrder = ['詳しい環境分析は↓', '#ガンダムカードゲーム'];
  for (const d of dropOrder) {
    if (w <= limit) break;
    const i = lines.indexOf(d);
    if (i < 0) continue;
    lines.splice(i, 1);
    dropped.push(d);
    w = weightedLength(lines.join('\n'));
  }
  return { text: lines.join('\n'), weighted: w, over: w > limit, dropped };
}

// ===================================================================
// 画像（SVG → PNG）
// ===================================================================
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** タグチップ幅の概算フォールバック（実寸取得に失敗したときだけ使う。安全側＝広めに出る） */
function approxWidth(text, fontSize, letterSpacing) {
  let u = 0;
  for (const ch of String(text)) {
    const c = ch.codePointAt(0);
    const full = (c >= 0x1100 && c <= 0x115F) || (c >= 0x2E80 && c <= 0xA4CF) ||
                 (c >= 0xAC00 && c <= 0xD7A3) || (c >= 0xF900 && c <= 0xFAFF) ||
                 (c >= 0xFE30 && c <= 0xFE6F) || (c >= 0xFF00 && c <= 0xFF60) ||
                 (c >= 0xFFE0 && c <= 0xFFE6) || (c >= 0x20000 && c <= 0x3FFFD);
    u += full ? 1.0 : 0.55;
  }
  return u * fontSize + Math.max(0, [...String(text)].length - 1) * (letterSpacing || 0);
}

/**
 * 文字列の実寸を sharp のテキストメタデータで測る。
 * 解決されるフォントは OS で異なる（Windows=Yu Gothic UI / Linux=Noto Sans CJK JP）ため
 * 幅は環境間で一致しない。同一環境内では同一入力→同一幅で決定論的。
 */
async function measureTextWidth(text, sizePx) {
  const sharp = require('sharp');
  const meta = await sharp({
    text: { text: String(text), font: FONT_STACK + ' ' + sizePx + 'px', dpi: 72, rgba: true }
  }).metadata();
  return meta.width;
}

/**
 * spec = { tag, title, sub, rows:[{label, share, count, colors}], note }
 * metrics = { tagWidth } 省略時は概算
 */
function buildSvg(spec, metrics) {
  const W = CANVAS.W, H = CANVAS.H, PAD_X = CANVAS.PAD_X;
  const rows = spec.rows || [];
  const max = rows.reduce((m, r) => Math.max(m, r.share), 0) || 1;
  const p = [];

  p.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">');
  p.push('<defs>');
  p.push('<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">'
    + '<stop offset="0%" stop-color="#0d1420"/><stop offset="55%" stop-color="#131c2e"/>'
    + '<stop offset="100%" stop-color="#18243a"/></linearGradient>');
  rows.forEach((r, i) => {
    if (!r.colors || !r.colors.length) return;
    const a = (DECK_COLORS[r.colors[0]] || DECK_COLORS.Unknown).hex;
    const b = (DECK_COLORS[r.colors[r.colors.length - 1]] || DECK_COLORS.Unknown).hex;
    p.push('<linearGradient id="g' + i + '" x1="0" y1="0" x2="1" y2="0">'
      + '<stop offset="0%" stop-color="' + a + '"/><stop offset="100%" stop-color="' + b + '"/></linearGradient>');
  });
  p.push('</defs>');
  p.push('<rect width="' + W + '" height="' + H + '" fill="url(#bg)"/>');

  const FF = 'font-family="' + FONT_STACK + '"';

  // タグチップ
  const tagFS = 19, tagLS = 1, tagPadX = 14;
  const nChars = [...String(spec.tag)].length;
  const textW = (metrics && typeof metrics.tagWidth === 'number')
    ? metrics.tagWidth + Math.max(0, nChars - 1) * tagLS
    : approxWidth(spec.tag, tagFS, tagLS);
  p.push('<rect x="' + PAD_X + '" y="' + CANVAS.PAD_TOP + '" width="' + (textW + tagPadX * 2).toFixed(1)
    + '" height="36" rx="6" ry="6" fill="#1f3050" stroke="#35507c" stroke-width="1"/>');
  p.push('<text x="' + (PAD_X + tagPadX) + '" y="' + (CANVAS.PAD_TOP + 25) + '" ' + FF
    + ' font-size="' + tagFS + '" letter-spacing="' + tagLS + '" fill="#9fc0ee">' + esc(spec.tag) + '</text>');

  p.push('<text x="' + PAD_X + '" y="138" ' + FF + ' font-size="40" font-weight="900" fill="#e8edf5"'
    + ' letter-spacing="0.5">' + esc(spec.title) + '</text>');
  p.push('<text x="' + PAD_X + '" y="182" ' + FF + ' font-size="21" fill="#93a5c0">' + esc(spec.sub) + '</text>');

  // チャート
  const CHART_TOP = 218, ROW_H = 36, ROW_GAP = 13, LBL_W = 118, LBL_PAD = 14;
  const TRACK_X = PAD_X + LBL_W;
  const TRACK_W = (W - PAD_X) - TRACK_X;

  rows.forEach((r, i) => {
    const y = CHART_TOP + i * (ROW_H + ROW_GAP);
    const base = y + 26;
    p.push('<text x="' + (TRACK_X - LBL_PAD) + '" y="' + base + '" ' + FF
      + ' font-size="23" font-weight="700" text-anchor="end" fill="#e8edf5">' + esc(r.label) + '</text>');
    p.push('<rect x="' + TRACK_X + '" y="' + y + '" width="' + TRACK_W + '" height="' + ROW_H
      + '" rx="7" ry="7" fill="#1a2436"/>');

    const ratio = r.share / max;
    const barW = Math.max(TRACK_W * ratio, 64);
    const fill = (r.colors && r.colors.length) ? 'url(#g' + i + ')' : '#5a6b85';
    p.push('<rect x="' + TRACK_X + '" y="' + y + '" width="' + barW.toFixed(1) + '" height="' + ROW_H
      + '" rx="7" ry="7" fill="' + fill + '"/>');

    // 満杯バー（>0.85）は %+デッキ数をバー内に併記し、右端のデッキ数を消す（ラベル重なり対策）
    const full = ratio > 0.85;
    const inBar = full ? (pct(r.share) + '%（' + r.count + 'デッキ）') : (pct(r.share) + '%');
    p.push('<text x="' + (TRACK_X + barW - 10).toFixed(1) + '" y="' + base + '" ' + FF
      + ' font-size="20" font-weight="800" text-anchor="end" fill="#0d1420">' + esc(inBar) + '</text>');
    if (!full) {
      p.push('<text x="' + (TRACK_X + TRACK_W - 12) + '" y="' + base + '" ' + FF
        + ' font-size="17" text-anchor="end" fill="#7e91ad">' + r.count + 'デッキ</text>');
    }
  });

  p.push('<text x="' + PAD_X + '" y="636" ' + FF + ' font-size="24" font-weight="800" fill="#79b4ff">'
    + esc(SITE_LABEL) + '</text>');
  p.push('<text x="' + (W - PAD_X) + '" y="636" ' + FF
    + ' font-size="17" text-anchor="end" fill="#7e91ad">' + esc(spec.note) + '</text>');
  p.push('</svg>');
  return p.join('\n');
}

/** spec → 1200x675 PNG。戻り値は { svg, metrics }（検証で SVG のバイト一致を見るため） */
async function renderBanner(spec, outPath) {
  const sharp = require('sharp');
  let metrics = null;
  try {
    metrics = { tagWidth: await measureTextWidth(spec.tag, 19) };
  } catch (_) {
    metrics = null;   // 測定に失敗しても概算で描く（描画は止めない・安全側に広くなるだけ）
  }
  const svg = buildSvg(spec, metrics);
  await sharp(Buffer.from(svg, 'utf8'), { density: 72 })
    .png({ compressionLevel: 9 }).toFile(outPath);
  return { svg, metrics };
}

/**
 * 集計結果から画像 spec を組み立てる。
 * フッターの「◯/◯時点」は **データ最新日**から導出する（wall-clock 非依存・--date 追随）。
 */
function buildSpec(agg, series, kind) {
  const tag = (series.nameById[agg.mainSeries] || 'ニュータイプチャレンジ');
  const asOf = agg.latestDate ? mdSlash(agg.latestDate) : mdSlash(agg.to);
  if (kind === 'friday') {
    return {
      tag,
      title: '直近1週間のデッキタイプ割合',
      sub: mdSlash(agg.from) + '〜' + mdSlash(agg.to) + ' 開催分を集計｜' + agg.eventCount
        + 'イベント・上位入賞（ベスト4相当）' + agg.deckTotal + 'デッキ',
      rows: agg.rows,
      note: '非公式ファンサイト GCG STATS 調べ（' + asOf + '時点・集計継続中）'
    };
  }
  return {
    tag,
    title: '上位入賞デッキタイプ割合',
    sub: mdSlash(agg.from) + '〜' + mdSlash(agg.to) + ' 開催分を集計｜' + agg.eventCount
      + 'イベント・上位入賞（ベスト4相当）' + agg.deckTotal + 'デッキ',
    rows: agg.rows,
    note: '非公式ファンサイト GCG STATS 調べ（' + asOf + '時点）'
  };
}

module.exports = {
  CANVAS, FONT_STACK, COLOR_SORT_ORDER, DECK_COLORS,
  addDays, dayOfWeek, mondayOf, mdSlash, isDateStr,
  windowMonday, windowFriday,
  loadIndex, loadSeries, aggregateWindow, normalizeTypeKey, labelOf,
  buildMondayText, buildFridayText, fitText, topLine,
  buildSpec, buildSvg, renderBanner, measureTextWidth
};
