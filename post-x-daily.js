#!/usr/bin/env node
/**
 * post-x-daily.js  ―  X(旧Twitter) 毎日投稿基盤（指示書61）
 *
 * 夜間バッチ run-auto-news-daily.bat から 1 工程だけ呼ばれるオーケストレータ。
 *
 *   1) 「今日のカード」 … 毎晩 1 件（既定レンジの採用上位プールから日付シードで決定論選定）
 *   2) 「週次ムーバー」 … 月曜のみ（前週 vs 前々週の採用デッキ数の絶対増分 TOP3〜5）
 *
 * Usage:
 *   node post-x-daily.js                      # 本番（夜間バッチから呼ばれる想定）
 *   node post-x-daily.js --dry-run            # 真の dry-run（投稿・メディアup・状態書込を一切しない）
 *   node post-x-daily.js --dry-run --date 2026-08-03
 *                                             # 日付を偽装（曜日判定・窓集計・状態キー・ガード・文面日付の全参照が追随）
 *   node post-x-daily.js --dry-run --only mover
 *   node post-x-daily.js --dry-run --state-file <path>   # 検証用に状態ファイルを差し替え
 *
 * 設計上の鉄則（指示書61 §1）:
 *   - 時刻参照は getNow() / getTodayJst() の単一経路のみ。他所で new Date() を直に使わない
 *   - 投稿失敗は「ログのみ」。終了コードは常に 0（FETCHRC/SYNCRC・バッチ最終 exit へ不伝播）
 *   - 状態ファイルは .sched-run-tmp/x-daily-log.json。git に入れない・push しない
 *   - 起動時に当日（当週）キーが存在すれば status を問わず無条件スキップ（at-most-once 優先）
 *   - dry-run では「読み」だけ行い、書き込み系 3 種（postTweet / uploadMediaToX / 状態ファイル書込）
 *     には構造的に到達しない。加えて各書込関数の先頭で assertNotDryRun() が二重に防御する
 *
 * 作成: 2026-08-01（指示書61 実装セッション）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

require('dotenv').config({ path: path.join(__dirname, '.env'), override: true, quiet: true });

const {
  consolidateNtcRank,
  isTargetEvent,
  makeIsNtcTypeFromSeriesMap
} = require('./shared/ntc-rank-consolidator');

// ===================================================================
// 調整可能な定数（指示書61 §1-1「プール定義は定数として冒頭に定義・調整可」）
// ===================================================================
const CONFIG = {
  // --- 今日のカード ---
  POOL_TOP_N: 100,            // 既定レンジの採用デッキ数降順で上位何枚をプールにするか
  POOL_MIN_DECKS: 5,          // プール入りの最低採用デッキ数
  REPOST_GUARD_DAYS: 60,      // 再登場ガード（直近 N 日に投稿したカードはスキップ）

  // --- 週次ムーバー ---
  MOVER_WEEKDAY: 1,           // 0=日 1=月 … 実行曜日（JST）
  MOVER_MIN_WINDOW_DECKS: 20, // 窓のデッキ総数がこれ未満ならフォールバック判定に入る
  // 前週の採用デッキ数がこれ未満のカードをムーバー候補から外す。
  // 既定 0 = 無効（指示書61 の「指標=採用デッキ数の絶対増分」をそのまま適用）。
  // 0→4 のような母数の小さいカードが上位を占める場合に発行元判断で引き上げる。
  MOVER_MIN_PREV_DECKS: 0,
  MOVER_TOP_MAX: 5,           // 文面の最大件数
  MOVER_TOP_MIN: 3,           // 加重280超過時に縮退できる下限件数
  MOVER_MAX_MEDIA: 4,         // 添付画像の最大枚数（X 仕様上限 4）

  // --- 共通 ---
  DAILY_MAX_MEDIA: 1,
  MAX_WEIGHTED_LENGTH: 280,   // X の加重文字数上限
  URL_WEIGHTED_LENGTH: 23,    // URL は長さに関わらず一律 23（t.co 変換）
  POST_RETRY: 1,              // 投稿失敗時のリトライ回数
  POST_INTERVAL_MS: 5000,     // 同一夜に複数投稿する場合の間隔
  MEDIA_INTERVAL_MS: 500,
  SITE_URL: 'https://gcg-stats.com',
  META_PATH: '/meta.html',    // 環境分析ページ
  HASHTAG: '#ガンダムカードゲーム',
  CONVERT_WEBP_TO_JPEG: true  // webp を sharp で jpeg 変換してから up（sharp は既存依存）
};

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const IMAGES_CARDS_DIR = path.join(ROOT, 'images', 'cards');
const STATE_DIR = path.join(ROOT, '.sched-run-tmp');

// ===================================================================
// CLI 引数
// ===================================================================
function argValue(name) {
  const argv = process.argv;
  const i = argv.indexOf('--' + name);
  if (i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith('--' + name + '='));
  if (eq) return eq.slice(('--' + name + '=').length);
  return null;
}

// --dry-run / --dry-run=true / --dry-run=1 のいずれも dry-run とみなす。
// （--date は --name=value 形式も受けるため、書式の混在で誤って本番投稿するのを防ぐ）
const DRY_RUN = process.argv.some((a) => a === '--dry-run' || a.startsWith('--dry-run='));
const FIXED_DATE = argValue('date');            // YYYY-MM-DD（JST）を偽装
const ONLY = argValue('only');                  // 'daily' | 'mover' | null
const STATE_FILE = argValue('state-file') || path.join(STATE_DIR, 'x-daily-log.json');

if (FIXED_DATE && !/^\d{4}-\d{2}-\d{2}$/.test(FIXED_DATE)) {
  console.error('[post-x-daily] --date の形式が不正です（YYYY-MM-DD）: ' + FIXED_DATE);
  process.exit(0); // 終了コードはバッチへ不伝播（常に 0）
}

// ===================================================================
// ログ
// ===================================================================
function log(msg) {
  const t = getNow();
  const jst = new Date(t.getTime() + 9 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  console.log('[' + jst + ' JST][post-x-daily] ' + msg);
}
function logError(msg) { log('*** ERROR *** ' + msg); }

// ===================================================================
// 時刻（JST）― 参照は必ずこの単一経路を通す
// ===================================================================
function getNow() {
  // --date 指定時は「その日の JST 20:30」を現在時刻とみなす（夜間バッチの実行時刻帯）
  if (FIXED_DATE) return new Date(FIXED_DATE + 'T20:30:00+09:00');
  return new Date();
}
function getTodayJst() {
  if (FIXED_DATE) return FIXED_DATE;
  return new Date(getNow().getTime() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
// 日付文字列（YYYY-MM-DD）ベースの算術。UTC 固定の Date を使うので DST/TZ の影響を受けない
function dayOfWeek(dateStr) { return new Date(dateStr + 'T00:00:00Z').getUTCDay(); }
function addDays(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function diffDays(a, b) {
  return Math.round((Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000);
}
// 当該日を含む週の月曜日（JST）
function mondayOf(dateStr) {
  const dow = dayOfWeek(dateStr);
  const back = (dow === 0) ? 6 : (dow - 1);
  return addDays(dateStr, -back);
}

// ===================================================================
// X 加重文字数（twitter-text v3 の重み設定と同一）
//   既定重み 2 / 下記レンジのみ重み 1 / URL は一律 23
// ===================================================================
const URL_REGEX = /https?:\/\/[^\s]+/g;
function isLightWeightCodePoint(cp) {
  return (cp >= 0x0000 && cp <= 0x10ff)
    || (cp >= 0x2000 && cp <= 0x200d)
    || (cp >= 0x2010 && cp <= 0x201f)
    || (cp >= 0x2032 && cp <= 0x2037);
}
function weightedLength(text) {
  const PLACEHOLDER = '';
  const replaced = String(text).replace(URL_REGEX, PLACEHOLDER);
  let total = 0;
  for (const ch of replaced) {
    if (ch === PLACEHOLDER) { total += CONFIG.URL_WEIGHTED_LENGTH; continue; }
    total += isLightWeightCodePoint(ch.codePointAt(0)) ? 1 : 2;
  }
  return total;
}

// ===================================================================
// 決定論シード（同一日 = 同一選定）
// ===================================================================
function hash32(str) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// ===================================================================
// データ読み込み（すべて読み取りのみ）
// ===================================================================
function readJsonSafe(file, fallback, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    log('  ⚠ ' + (label || file) + ' を読めませんでした: ' + e.message);
    return fallback;
  }
}

function loadInputs() {
  const events = readJsonSafe(path.join(DATA_DIR, 'events.json'), null, 'data/events.json');
  const cardsMaster = readJsonSafe(path.join(DATA_DIR, 'cards_master.json'), {}, 'data/cards_master.json');
  const cardsPreview = readJsonSafe(path.join(DATA_DIR, 'cards_preview.json'), {}, 'data/cards_preview.json');
  const seriesMap = readJsonSafe(path.join(DATA_DIR, 'series.json'), {}, 'data/series.json');
  const topStats = readJsonSafe(path.join(DATA_DIR, 'top_stats.json'), null, 'data/top_stats.json');
  return { events, cardsMaster, cardsPreview, seriesMap, topStats };
}

// 既定レンジ。top_stats.json（generate-events.js が出力する正）を第一候補にし、
// 読めない場合のみ generate-events.js と同一ロジックで自前計算する。
function resolveDefaultRange(topStats, eventsObj, seriesMap) {
  if (topStats && topStats.default_range
    && (topStats.default_range.start || topStats.default_range.end)) {
    return {
      start: topStats.default_range.start || '',
      end: topStats.default_range.end || '',
      series_slug: topStats.default_range.series_slug || '',
      source: 'top_stats.json'
    };
  }
  const s = pickDefaultSeriesWithData(seriesMap, eventsObj);
  if (s && (s.start_date || s.end_date)) {
    return { start: s.start_date || '', end: s.end_date || '', series_slug: s.slug || '', source: 'series.json(fallback)' };
  }
  let latest = '';
  for (const k of Object.keys(eventsObj || {})) {
    const ev = eventsObj[k];
    if (ev && ev.date && ev.date > latest) latest = ev.date;
  }
  const r = halfMonthRangeFromDate(latest);
  return { start: r.start, end: r.end, series_slug: '', source: 'half-month(fallback)' };
}

// --- 以下 2 関数は generate-events.js / js/common.js と同一ロジック（フォールバック用） ---
function pickDefaultSeries(seriesInput) {
  let list;
  if (Array.isArray(seriesInput)) list = seriesInput.slice();
  else if (seriesInput && typeof seriesInput === 'object') list = Object.values(seriesInput);
  else return null;
  list = list.filter((s) => s && s.id);
  if (list.length === 0) return null;
  const byAsc = (a, b) => (a.start_date || '').localeCompare(b.start_date || '');
  const byDesc = (a, b) => (b.start_date || '').localeCompare(a.start_date || '');
  const actives = list.filter((s) => s.status === 'active').sort(byAsc);
  if (actives.length > 0) return actives[0];
  const upcoming = list.filter((s) => s.status === 'upcoming').sort(byAsc);
  if (upcoming.length > 0) return upcoming[0];
  const completed = list.filter((s) => s.status === 'completed').sort(byDesc);
  if (completed.length > 0) return completed[0];
  return list[0];
}
function pickDefaultSeriesWithData(seriesInput, eventsObj) {
  let list;
  if (Array.isArray(seriesInput)) list = seriesInput.slice();
  else if (seriesInput && typeof seriesInput === 'object') list = Object.values(seriesInput);
  else return null;
  list = list.filter((s) => s && s.id);
  if (list.length === 0) return null;
  const byAsc = (a, b) => (a.start_date || '').localeCompare(b.start_date || '');
  const byDesc = (a, b) => (b.start_date || '').localeCompare(a.start_date || '');
  const candidates = []
    .concat(list.filter((s) => s.status === 'active').sort(byAsc))
    .concat(list.filter((s) => s.status === 'upcoming').sort(byAsc))
    .concat(list.filter((s) => s.status === 'completed').sort(byDesc));
  const evMap = eventsObj || {};
  for (const s of candidates) {
    const start = s.start_date || '';
    const end = s.end_date || '';
    for (const key of Object.keys(evMap)) {
      const ev = evMap[key];
      if (!ev || !ev.date) continue;
      if (start && ev.date < start) continue;
      if (end && ev.date > end) continue;
      return s;
    }
  }
  return pickDefaultSeries(seriesInput);
}
function halfMonthRangeFromDate(baseDateStr) {
  const parts = String(baseDateStr || '').split('-');
  if (parts.length !== 3) return { start: '', end: '' };
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10) - 1;
  const d = parseInt(parts[2], 10);
  if (isNaN(y) || isNaN(m) || isNaN(d)) return { start: '', end: '' };
  let startDate, endDate;
  if (d <= 7) {
    const pm = m === 0 ? 11 : m - 1;
    const py = m === 0 ? y - 1 : y;
    startDate = new Date(Date.UTC(py, pm, 16));
    endDate = new Date(Date.UTC(py, pm + 1, 0));
  } else if (d <= 22) {
    startDate = new Date(Date.UTC(y, m, 1));
    endDate = new Date(Date.UTC(y, m, 15));
  } else {
    startDate = new Date(Date.UTC(y, m, 16));
    endDate = new Date(Date.UTC(y, m + 1, 0));
  }
  const fmt = (dt) => dt.toISOString().slice(0, 10);
  return { start: fmt(startDate), end: fmt(endDate) };
}

// ===================================================================
// 採用集計（generate-events.js buildTopStats() と同一の抽出条件）
//   ・NTC 64名大会は consolidateNtcRank 後 rank<=8、それ以外は rank<=4
//   ・deck が空の結果は分母にも分子にも入れない
// ===================================================================
function aggregateUsage(eventsObj, isNtcTypeFn, startDate, endDate) {
  let totalDecks = 0;
  const usage = {};
  let eventCount = 0;
  for (const key of Object.keys(eventsObj || {})) {
    const evRaw = eventsObj[key];
    if (!evRaw || !evRaw.date) continue;
    if (startDate && evRaw.date < startDate) continue;
    if (endDate && evRaw.date > endDate) continue;
    eventCount++;
    const ev = consolidateNtcRank(evRaw, { isNtcType: isNtcTypeFn });
    const rankThreshold = isTargetEvent(evRaw, { isNtcType: isNtcTypeFn }) ? 8 : 4;
    const results = ev.results || [];
    for (const r of results) {
      if (r.rank > rankThreshold) continue;
      const deck = r.deck;
      if (!deck || deck.length === 0) continue;
      totalDecks++;
      for (const entry of deck) {
        const id = entry.card_id;
        if (!id) continue;
        if (!usage[id]) usage[id] = { card_id: id, decks: 0, copies: 0 };
        usage[id].decks++;
        usage[id].copies += (entry.count || 0);
      }
    }
  }
  return { totalDecks, usage, eventCount };
}

function cardName(cardsMaster, id) {
  const c = cardsMaster[id];
  return (c && (c.name_jp || c.name)) || '';
}

// ===================================================================
// プール構築（指示書61 §1-1）
// ===================================================================
function buildDailyPool(agg, cardsMaster, cardsPreview) {
  const previewIds = new Set(Object.keys(cardsPreview || {}));
  const sorted = Object.values(agg.usage).sort(
    (a, b) => (b.decks - a.decks) || (a.card_id < b.card_id ? -1 : a.card_id > b.card_id ? 1 : 0)
  );
  const topN = sorted.slice(0, CONFIG.POOL_TOP_N);
  const excluded = { belowMinDecks: 0, preview: [], noMaster: [] };
  const pool = [];
  for (const u of topN) {
    if (u.decks < CONFIG.POOL_MIN_DECKS) { excluded.belowMinDecks++; continue; }
    if (previewIds.has(u.card_id)) { excluded.preview.push(u.card_id); continue; }
    if (!cardName(cardsMaster, u.card_id)) { excluded.noMaster.push(u.card_id); continue; }
    pool.push({
      card_id: u.card_id,
      name: cardName(cardsMaster, u.card_id),
      decks: u.decks,
      copies: u.copies,
      usage_rate: agg.totalDecks > 0 ? Math.round(u.decks / agg.totalDecks * 1000) / 10 : 0,
      avg_copies: u.decks > 0 ? Math.round(u.copies / u.decks * 10) / 10 : 0
    });
  }
  return { pool, excluded };
}

// ===================================================================
// 状態ファイル
// ===================================================================
function assertNotDryRun(what) {
  if (DRY_RUN) {
    throw new Error('[BUG] dry-run 中に書き込み系処理へ到達しました: ' + what);
  }
}

// 読み取りは dry-run でも行う（選定・ガードに必要）
function readState() {
  if (!fs.existsSync(STATE_FILE)) {
    return { ok: true, isNew: true, state: { version: 1, entries: {} } };
  }
  let raw;
  try {
    raw = fs.readFileSync(STATE_FILE, 'utf-8');
  } catch (e) {
    return { ok: false, reason: 'read-failed', message: e.message };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.entries || typeof parsed.entries !== 'object') {
      return { ok: false, reason: 'shape-invalid', message: 'entries オブジェクトがありません' };
    }
    return { ok: true, isNew: false, state: parsed };
  } catch (e) {
    return { ok: false, reason: 'parse-failed', message: e.message };
  }
}

function writeStateAtomic(state) {
  assertNotDryRun('writeStateAtomic');
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = STATE_FILE + '.tmp-' + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    // rename 前に落ちても本体ファイルは無破損。残骸だけ掃除して再送出する
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) { /* noop */ }
    throw e;
  }
}

// 破損時: 退避して新規作成（当夜の投稿は中止済み ＝ fail-close）
function quarantineCorruptState() {
  assertNotDryRun('quarantineCorruptState');
  const stamp = new Date(getNow().getTime() + 9 * 3600 * 1000).toISOString()
    .replace(/[-:T]/g, '').slice(0, 14);
  const dest = STATE_FILE + '.corrupt-' + stamp;
  try {
    fs.renameSync(STATE_FILE, dest);
    logError('状態ファイルを退避しました: ' + path.basename(dest)
      + ' / 再登場ガード用の投稿履歴（最大' + CONFIG.REPOST_GUARD_DAYS + '日分）が失われます');
  } catch (e) {
    logError('状態ファイルの退避に失敗: ' + e.message);
    return false;
  }
  writeStateAtomic({ version: 1, entries: {} });
  log('状態ファイルを新規作成しました（次回実行から通常運用に戻ります）');
  return true;
}

// カードごとの最終投稿日（daily エントリのみ）。
// status='failed'（リトライまで尽きて未投稿が確定）は除外する。
// 'attempting'（投稿済みか不明）は安全側に倒して投稿扱いのままガードに算入する。
function lastPostedDateByCard(state) {
  const map = {};
  for (const [key, e] of Object.entries(state.entries || {})) {
    if (!key.startsWith('daily:')) continue;
    if (e && e.status === 'failed') continue;
    const date = key.slice('daily:'.length);
    const id = e && e.card_id;
    if (!id) continue;
    if (!map[id] || date > map[id]) map[id] = date;
  }
  return map;
}

// ===================================================================
// 文面生成
// ===================================================================
// dropOrder に並べた順（先頭から）に任意要素を落として加重280以内に収める
function fitToLimit(buildFn, dropOrder) {
  const enabled = new Set(dropOrder);
  const dropped = [];
  let text = buildFn(enabled);
  let w = weightedLength(text);
  for (let i = 0; i < dropOrder.length && w > CONFIG.MAX_WEIGHTED_LENGTH; i++) {
    enabled.delete(dropOrder[i]);
    dropped.push(dropOrder[i]);
    text = buildFn(enabled);
    w = weightedLength(text);
  }
  return { text, weighted: w, dropped };
}

// 今日のカードの文面。必須＝カード名・型番／採用率・採用デッキ数／カードページURL／ハッシュタグ。
// 任意＝集計期間・平均採用枚数（この順で落とす）。
const DAILY_DROP_ORDER = ['period', 'avg'];
function buildDailyBody(card, range, totalDecks, on) {
  const lines = [];
  lines.push('【今日のカード】' + card.name + '（' + card.card_id + '）');
  lines.push('採用率 ' + card.usage_rate.toFixed(1) + '%（' + card.decks + '/' + totalDecks + 'デッキ）');
  if (on.has('avg') && card.avg_copies > 0) lines.push('平均採用枚数 ' + card.avg_copies.toFixed(1) + '枚');
  if (on.has('period') && range.start && range.end) lines.push('集計期間 ' + range.start + '〜' + range.end);
  lines.push(CONFIG.SITE_URL + '/cards/' + card.card_id + '/');
  lines.push(CONFIG.HASHTAG);
  return lines.join('\n');
}
function buildDailyText(card, range, totalDecks) {
  let r = fitToLimit((on) => buildDailyBody(card, range, totalDecks, on), DAILY_DROP_ORDER);
  if (r.weighted > CONFIG.MAX_WEIGHTED_LENGTH) {
    // 最終手段: カード名を切り詰める（必須要素だけでも超過する異常長のカード名対策）
    let name = card.name;
    let guard = 0;
    while (r.weighted > CONFIG.MAX_WEIGHTED_LENGTH && name.length > 1 && guard++ < 200) {
      name = name.slice(0, -1);
      const shortCard = Object.assign({}, card, { name: name + '…' });
      r = fitToLimit((on) => buildDailyBody(shortCard, range, totalDecks, on), DAILY_DROP_ORDER);
    }
    r.nameTruncated = true;
  }
  return r;
}

// ムーバー文面。加重280に収まるまで
//   件数 5→4→3 → デッキ数の併記を省略 → カード名を短縮 → 件数 2→1
// の順に縮退する。すべて試して収まらない場合のみ overLimit を立てる
// （呼び出し側で「投稿しない」判断に使う。403 確定の文面を送らないため）。
function buildMoverText(mode, rows, win) {
  const url = CONFIG.SITE_URL + CONFIG.META_PATH;
  const md = (d) => { const p = d.split('-'); return parseInt(p[1], 10) + '/' + parseInt(p[2], 10); };
  const header = (mode === 'mover')
    ? '【週間ムーバー】' + md(win.prev.start) + '〜' + md(win.prev.end) + ' 採用デッキ数の伸び'
    : '【今週の採用TOP】' + md(win.prev.start) + '〜' + md(win.prev.end);
  const sign = (v) => (v > 0 ? '+' + v : String(v));
  const shorten = (name, max) => (max > 0 && name.length > max) ? (name.slice(0, max) + '…') : name;

  const build = (opt) => {
    const lines = [header];
    rows.slice(0, opt.n).forEach((r, i) => {
      const nm = shorten(r.name, opt.nameMax);
      if (mode === 'mover') {
        lines.push((i + 1) + '. ' + nm + '（' + r.card_id + '）' + sign(r.delta)
          + (opt.showDecks ? '（' + r.prev + 'デッキ）' : ''));
      } else {
        lines.push((i + 1) + '. ' + nm + '（' + r.card_id + '）'
          + (opt.showDecks ? r.prev + 'デッキ' : ''));
      }
    });
    lines.push(url);
    lines.push(CONFIG.HASHTAG);
    return lines.join('\n');
  };

  const maxN = Math.min(CONFIG.MOVER_TOP_MAX, rows.length);
  const minN = Math.min(CONFIG.MOVER_TOP_MIN, maxN);
  const candidates = [];
  for (let n = maxN; n >= minN; n--) candidates.push({ n, showDecks: true, nameMax: 0 });
  for (let n = maxN; n >= minN; n--) candidates.push({ n, showDecks: false, nameMax: 0 });
  for (const nameMax of [24, 18, 12]) {
    for (let n = maxN; n >= minN; n--) candidates.push({ n, showDecks: false, nameMax });
  }
  for (let n = Math.min(2, maxN); n >= 1; n--) candidates.push({ n, showDecks: false, nameMax: 12 });

  let last = null;
  for (const opt of candidates) {
    const text = build(opt);
    const w = weightedLength(text);
    last = { text, weighted: w, count: opt.n, opt };
    if (w <= CONFIG.MAX_WEIGHTED_LENGTH) {
      return {
        text, weighted: w, count: opt.n,
        degraded: !(opt.n === maxN && opt.showDecks && opt.nameMax === 0),
        degradeNote: (opt.n < maxN ? '件数' + maxN + '→' + opt.n : '')
          + (!opt.showDecks ? ' デッキ数省略' : '')
          + (opt.nameMax ? ' カード名' + opt.nameMax + '字に短縮' : '')
      };
    }
  }
  return Object.assign({}, last, { degraded: true, overLimit: true, degradeNote: '全縮退でも超過' });
}

// ===================================================================
// 計画（読み取りのみ・副作用なし）
// ===================================================================
function planDaily(ctx) {
  const today = ctx.today;
  const key = 'daily:' + today;
  if (ctx.state.entries[key]) {
    return { kind: 'daily', key, skip: true, reason: '当日キーが既に存在（status=' + (ctx.state.entries[key].status || '?') + '）→ at-most-once によりスキップ' };
  }
  const { pool, excluded } = buildDailyPool(ctx.aggDefault, ctx.cardsMaster, ctx.cardsPreview);
  if (pool.length === 0) {
    return { kind: 'daily', key, skip: true, reason: 'プールが空（既定レンジ ' + ctx.range.start + '〜' + ctx.range.end + ' に条件を満たすカードなし）', excluded };
  }
  const lastPosted = lastPostedDateByCard(ctx.state);
  const startIdx = hash32('gcg-daily:' + today) % pool.length;
  let chosen = null;
  let guardSkipped = 0;
  for (let i = 0; i < pool.length; i++) {
    const c = pool[(startIdx + i) % pool.length];
    const last = lastPosted[c.card_id];
    if (last && diffDays(today, last) < CONFIG.REPOST_GUARD_DAYS) { guardSkipped++; continue; }
    chosen = c;
    break;
  }
  let exhausted = false;
  if (!chosen) {
    exhausted = true;
    // プール枯渇: プール内で最終投稿日が最も古いカード（同点は card_id 昇順）
    const ranked = pool.slice().sort((a, b) => {
      const la = lastPosted[a.card_id] || '';
      const lb = lastPosted[b.card_id] || '';
      if (la !== lb) return la < lb ? -1 : 1;
      return a.card_id < b.card_id ? -1 : a.card_id > b.card_id ? 1 : 0;
    });
    chosen = ranked[0];
  }
  const built = buildDailyText(chosen, ctx.range, ctx.aggDefault.totalDecks);
  return {
    kind: 'daily', key, skip: false,
    card: chosen, poolSize: pool.length, startIdx, guardSkipped, exhausted, excluded,
    text: built.text, weighted: built.weighted, dropped: built.dropped,
    nameTruncated: !!built.nameTruncated,
    media: resolveMediaPlan([chosen.card_id], CONFIG.DAILY_MAX_MEDIA)
  };
}

function planMover(ctx) {
  const today = ctx.today;
  const weekMonday = mondayOf(today);
  const key = 'mover:' + weekMonday;
  if (dayOfWeek(today) !== CONFIG.MOVER_WEEKDAY) {
    return { kind: 'mover', key, skip: true, reason: '月曜ではない（JST ' + today + ' / dow=' + dayOfWeek(today) + '）' };
  }
  if (ctx.state.entries[key]) {
    return { kind: 'mover', key, skip: true, reason: '当週キーが既に存在（status=' + (ctx.state.entries[key].status || '?') + '）→ at-most-once によりスキップ' };
  }
  // 窓: 前週月〜日 / 前々週月〜日（実行日当日は含めない）
  const win = {
    prev: { start: addDays(today, -7), end: addDays(today, -1) },
    prev2: { start: addDays(today, -14), end: addDays(today, -8) }
  };
  const aggPrev = aggregateUsage(ctx.eventsObj, ctx.isNtcTypeFn, win.prev.start, win.prev.end);
  const aggPrev2 = aggregateUsage(ctx.eventsObj, ctx.isNtcTypeFn, win.prev2.start, win.prev2.end);

  let mode;
  if (aggPrev2.totalDecks >= CONFIG.MOVER_MIN_WINDOW_DECKS) mode = 'mover';
  else if (aggPrev.totalDecks >= CONFIG.MOVER_MIN_WINDOW_DECKS) mode = 'top';
  else {
    return {
      kind: 'mover', key, skip: true, win,
      reason: '両窓ともデッキ総数が ' + CONFIG.MOVER_MIN_WINDOW_DECKS + ' 未満'
        + '（前週 ' + aggPrev.totalDecks + ' / 前々週 ' + aggPrev2.totalDecks + '）→ ムーバーをスキップ',
      windowDecks: { prev: aggPrev.totalDecks, prev2: aggPrev2.totalDecks }
    };
  }

  const previewIds = new Set(Object.keys(ctx.cardsPreview || {}));
  // 同じ夜に「今日のカード」で投稿するカードは重複を避けて除外する
  const sameNightIds = new Set(ctx.sameNightCardIds || []);
  const all = [];
  for (const u of Object.values(aggPrev.usage)) {
    if (previewIds.has(u.card_id)) continue;
    if (sameNightIds.has(u.card_id)) continue;
    if (u.decks < CONFIG.MOVER_MIN_PREV_DECKS) continue;
    const name = cardName(ctx.cardsMaster, u.card_id);
    if (!name) continue;
    const prev2 = aggPrev2.usage[u.card_id] ? aggPrev2.usage[u.card_id].decks : 0;
    all.push({
      card_id: u.card_id, name,
      prev: u.decks, prev2,
      delta: u.decks - prev2,
      rate: aggPrev.totalDecks > 0 ? Math.round(u.decks / aggPrev.totalDecks * 1000) / 10 : 0
    });
  }
  const sortBy = (list, key) => list.sort((a, b) => {
    const d = b[key] - a[key];
    if (d !== 0) return d;
    return a.card_id < b.card_id ? -1 : a.card_id > b.card_id ? 1 : 0;
  });

  let rows;
  let modeSwitchNote = '';
  if (mode === 'mover') {
    // 「伸び」と銘打つ以上、増分 0 以下は載せない。
    // 増分が正のカードが MOVER_TOP_MIN 未満しか無い週は前週の採用TOPへ自動切替。
    const positive = sortBy(all.filter((r) => r.delta > 0), 'delta');
    if (positive.length >= Math.min(CONFIG.MOVER_TOP_MIN, all.length) && positive.length > 0) {
      rows = positive;
    } else {
      modeSwitchNote = '増分が正のカードが ' + positive.length + ' 件しかないため前週の採用TOPへ切替';
      mode = 'top';
      rows = sortBy(all, 'prev');
    }
  } else {
    rows = sortBy(all, 'prev');
  }

  const top = rows.slice(0, CONFIG.MOVER_TOP_MAX);
  if (top.length === 0) {
    return {
      kind: 'mover', key, skip: true, win, mode,
      windowDecks: { prev: aggPrev.totalDecks, prev2: aggPrev2.totalDecks },
      reason: '対象カードが 0 件（モード=' + mode + ' / 前週 ' + aggPrev.totalDecks
        + 'デッキ / 前々週 ' + aggPrev2.totalDecks + 'デッキ）'
    };
  }
  const built = buildMoverText(mode, top, win);
  if (built.overLimit) {
    // 全縮退でも 280 を超える場合は投稿しない（X が 403 を返すことが確定しているため）
    return {
      kind: 'mover', key, skip: true, win, mode,
      windowDecks: { prev: aggPrev.totalDecks, prev2: aggPrev2.totalDecks },
      reason: '全縮退でも加重280を超過（' + built.weighted + '）したため投稿を見送り',
      overLimit: true, text: built.text, weighted: built.weighted
    };
  }
  const shown = top.slice(0, built.count);
  return {
    kind: 'mover', key, skip: false, mode, win, modeSwitchNote,
    windowDecks: { prev: aggPrev.totalDecks, prev2: aggPrev2.totalDecks },
    rows: shown, allRows: top,
    text: built.text, weighted: built.weighted,
    degraded: built.degraded, degradeNote: built.degradeNote,
    media: resolveMediaPlan(shown.map((r) => r.card_id), CONFIG.MOVER_MAX_MEDIA)
  };
}

// 添付予定（存在チェックのみ。変換・アップロードは投稿段階でしか行わない）
function resolveMediaPlan(cardIds, max) {
  const plan = [];
  for (const id of cardIds) {
    if (plan.length >= max) break;
    const jpg = path.join(IMAGES_CARDS_DIR, id + '.jpg');
    const webp = path.join(IMAGES_CARDS_DIR, id + '.webp');
    if (fs.existsSync(jpg)) plan.push({ card_id: id, file: jpg, format: 'jpg', convert: false });
    else if (fs.existsSync(webp)) plan.push({ card_id: id, file: webp, format: 'webp', convert: CONFIG.CONVERT_WEBP_TO_JPEG });
    else plan.push({ card_id: id, file: null, format: null, convert: false, missing: true });
  }
  return plan;
}

// ===================================================================
// X API（書き込み系。dry-run では構造的に到達しない＋先頭で二重防御）
// ===================================================================
const X_API_KEY = process.env.X_API_KEY;
const X_API_SECRET = process.env.X_API_SECRET;
const X_ACCESS_TOKEN = process.env.X_API_ACCESS_TOKEN;
const X_ACCESS_TOKEN_SECRET = process.env.X_API_ACCESS_TOKEN_SECRET;

function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/!/g, '%21').replace(/\*/g, '%2A')
    .replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29');
}
function generateOAuthSignature(method, url, params, consumerSecret, tokenSecret) {
  const sortedParams = Object.keys(params).sort()
    .map((k) => percentEncode(k) + '=' + percentEncode(params[k])).join('&');
  const baseString = method + '&' + percentEncode(url) + '&' + percentEncode(sortedParams);
  const signingKey = percentEncode(consumerSecret) + '&' + percentEncode(tokenSecret);
  return crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');
}
function buildOAuthHeader(method, url, extraParams) {
  const oauthParams = {
    oauth_consumer_key: X_API_KEY,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: X_ACCESS_TOKEN,
    oauth_version: '1.0'
  };
  const allParams = Object.assign({}, oauthParams, extraParams);
  oauthParams.oauth_signature = generateOAuthSignature(method, url, allParams, X_API_SECRET, X_ACCESS_TOKEN_SECRET);
  return 'OAuth ' + Object.keys(oauthParams).sort()
    .map((k) => percentEncode(k) + '="' + percentEncode(oauthParams[k]) + '"').join(', ');
}

// webp → jpeg 変換（sharp は package.json の既存依存）
async function prepareMediaFile(item) {
  assertNotDryRun('prepareMediaFile');
  if (!item.file) return null;
  if (!item.convert) return { file: item.file, temp: false };
  try {
    const sharp = require('sharp');
    const dir = path.join(STATE_DIR, 'x-media');
    fs.mkdirSync(dir, { recursive: true });
    const out = path.join(dir, item.card_id + '.jpg');
    await sharp(item.file).jpeg({ quality: 90 }).toFile(out);
    return { file: out, temp: true };
  } catch (e) {
    log('[media] webp→jpeg 変換に失敗（webp のまま送信します）: ' + e.message);
    return { file: item.file, temp: false };
  }
}

function uploadMediaToX(imagePath) {
  assertNotDryRun('uploadMediaToX');
  return new Promise((resolve) => {
    if (!fs.existsSync(imagePath)) { log('[media] ファイル不在: ' + imagePath); return resolve(null); }
    const url = 'https://upload.twitter.com/1.1/media/upload.json';
    const authHeader = buildOAuthHeader('POST', url, {});
    const boundary = '----GcgStatsBoundary' + crypto.randomBytes(8).toString('hex');
    const imageBuffer = fs.readFileSync(imagePath);
    const head = Buffer.from(
      '--' + boundary + '\r\n'
      + 'Content-Disposition: form-data; name="media"\r\n'
      + 'Content-Type: application/octet-stream\r\n\r\n'
    );
    const tail = Buffer.from('\r\n--' + boundary + '--\r\n');
    const body = Buffer.concat([head, imageBuffer, tail]);
    const req = https.request({
      hostname: 'upload.twitter.com', path: '/1.1/media/upload.json', method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': body.length
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode === 200 || res.statusCode === 201) {
          try {
            const parsed = JSON.parse(data);
            log('[media] up 成功: media_id=' + parsed.media_id_string + ' (' + path.basename(imagePath) + ')');
            resolve(parsed.media_id_string);
          } catch (e) { log('[media] レスポンス解析失敗: ' + e.message); resolve(null); }
        } else {
          log('[media] up 失敗 (' + res.statusCode + '): ' + data.slice(0, 200));
          resolve(null);
        }
      });
    });
    req.on('error', (e) => { log('[media] 通信エラー: ' + e.message); resolve(null); });
    req.write(body);
    req.end();
  });
}

function postTweet(text, mediaIds) {
  assertNotDryRun('postTweet');
  const url = 'https://api.x.com/2/tweets';
  const authHeader = buildOAuthHeader('POST', url, {});
  const tweetBody = { text };
  if (mediaIds && mediaIds.length > 0) tweetBody.media = { media_ids: mediaIds };
  const body = JSON.stringify(tweetBody);
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.x.com', path: '/2/tweets', method: 'POST',
      headers: {
        'Authorization': authHeader, 'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode === 201) {
          let id = null;
          try { id = JSON.parse(data).data.id; } catch (_) { /* noop */ }
          resolve(id);
        } else {
          reject(new Error('X投稿失敗 (' + res.statusCode + '): ' + data.slice(0, 300)));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ===================================================================
// 実行（dry-run ではここに到達しない）
// ===================================================================
async function executeItem(plan, state) {
  assertNotDryRun('executeItem');
  const nowIso = new Date(getNow().getTime() + 9 * 3600 * 1000).toISOString().slice(0, 19) + '+09:00';

  // 1) 投稿直前に attempting を原子的に記録
  state.entries[plan.key] = {
    kind: plan.kind,
    status: 'attempting',
    card_id: plan.kind === 'daily' ? plan.card.card_id : undefined,
    card_ids: plan.kind === 'mover' ? plan.rows.map((r) => r.card_id) : undefined,
    mode: plan.mode,
    weighted: plan.weighted,
    attempted_at: nowIso
  };
  writeStateAtomic(state);
  log('[' + plan.key + '] status=attempting を記録しました');

  // 2) メディア
  const mediaIds = [];
  const temps = [];
  for (const item of plan.media) {
    if (!item.file) { log('[media] 画像なし: ' + item.card_id); continue; }
    const prepared = await prepareMediaFile(item);
    if (!prepared) continue;
    if (prepared.temp) temps.push(prepared.file);
    const id = await uploadMediaToX(prepared.file);
    if (id) mediaIds.push(id);
    await sleep(CONFIG.MEDIA_INTERVAL_MS);
  }
  log('[' + plan.key + '] 画像 ' + mediaIds.length + ' 枚を添付します');

  // 3) 投稿（1 回リトライ）
  let tweetId = null;
  let lastErr = null;
  for (let attempt = 0; attempt <= CONFIG.POST_RETRY; attempt++) {
    try {
      tweetId = await postTweet(plan.text, mediaIds);
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      log('[' + plan.key + '] 投稿失敗（試行 ' + (attempt + 1) + '/' + (CONFIG.POST_RETRY + 1) + '）: ' + e.message);
      if (attempt < CONFIG.POST_RETRY) await sleep(3000);
    }
  }

  // 4) 結果を記録
  if (lastErr) {
    state.entries[plan.key].status = 'failed';
    state.entries[plan.key].error = String(lastErr.message).slice(0, 300);
    writeStateAtomic(state);
    logError('[' + plan.key + '] 投稿を諦めました（バッチの終了コードには伝播しません）');
  } else {
    state.entries[plan.key].status = 'posted';
    state.entries[plan.key].tweet_id = tweetId;
    state.entries[plan.key].posted_at = nowIso;
    writeStateAtomic(state);
    log('[' + plan.key + '] 投稿成功: https://x.com/gcg_stats/status/' + tweetId);
  }

  // 5) 一時ファイル掃除
  for (const f of temps) { try { fs.unlinkSync(f); } catch (_) { /* noop */ } }
  return !lastErr;
}

// ===================================================================
// 表示
// ===================================================================
function printPlan(plan) {
  if (!plan) return;
  const label = plan.kind === 'daily' ? '今日のカード' : '週次ムーバー';
  log('--- ' + label + ' (' + plan.key + ') ---');
  if (plan.skip) { log('  スキップ: ' + plan.reason); return; }
  if (plan.kind === 'daily') {
    log('  プール ' + plan.poolSize + ' 枚 / シード開始 index=' + plan.startIdx
      + ' / ガード回避 ' + plan.guardSkipped + ' 件' + (plan.exhausted ? ' / *** プール枯渇フォールバック発動 ***' : ''));
    log('  選定: ' + plan.card.card_id + ' ' + plan.card.name
      + ' (採用 ' + plan.card.decks + 'デッキ / ' + plan.card.usage_rate.toFixed(1)
      + '% / 平均' + plan.card.avg_copies.toFixed(1) + '枚)');
    if (plan.excluded && plan.excluded.preview.length) {
      log('  プレビュー除外: ' + plan.excluded.preview.join(', '));
    }
    if (plan.excluded && plan.excluded.noMaster.length) {
      log('  マスタ未登録で除外: ' + plan.excluded.noMaster.join(', '));
    }
  } else {
    log('  モード: ' + (plan.mode === 'mover' ? '増分ムーバー' : 'フォールバック(前週の採用TOP)')
      + ' / 窓 前週 ' + plan.win.prev.start + '〜' + plan.win.prev.end
      + ' (' + plan.windowDecks.prev + 'デッキ)'
      + ' / 前々週 ' + plan.win.prev2.start + '〜' + plan.win.prev2.end
      + ' (' + plan.windowDecks.prev2 + 'デッキ)');
    if (plan.modeSwitchNote) log('  モード切替理由: ' + plan.modeSwitchNote);
    log('  掲載 ' + plan.rows.length + ' 件'
      + (plan.degraded ? ' (加重280超過のため縮退: ' + (plan.degradeNote || '') + ')' : ''));
  }
  if (plan.dropped && plan.dropped.length) log('  文面縮退: ' + plan.dropped.join(', ') + ' を省略');
  if (plan.nameTruncated) log('  *** カード名を切り詰めました ***');
  if (plan.overLimit) log('  *** 警告 *** 縮退下限でも加重280を超過しています');
  log('  加重文字数: ' + plan.weighted + ' / ' + CONFIG.MAX_WEIGHTED_LENGTH
    + '（素の文字数 ' + Array.from(plan.text).length + '）');
  log('  添付予定: ' + (plan.media.length === 0 ? 'なし'
    : plan.media.map((m) => m.missing ? (m.card_id + ':画像なし')
      : (m.card_id + ':' + m.format + (m.convert ? '→jpeg変換' : ''))).join(', ')));
  log('  ----- 文面ここから -----');
  for (const line of plan.text.split('\n')) console.log('  | ' + line);
  log('  ----- 文面ここまで -----');
}

// ===================================================================
// main
// ===================================================================
async function main() {
  const today = getTodayJst();
  log('起動 (JST ' + today + ' / dow=' + dayOfWeek(today) + ')'
    + (DRY_RUN ? ' *** DRY-RUN ***' : '')
    + (FIXED_DATE ? ' *** --date 偽装 ***' : ''));

  // --- 状態ファイル（読み） ---
  const st = readState();
  if (!st.ok) {
    logError('状態ファイルの読み込みに失敗しました (' + st.reason + '): ' + st.message);
    logError('当夜の投稿を中止します（fail-close）');
    if (!DRY_RUN) quarantineCorruptState();
    else log('[DRY-RUN] 破損ファイルの退避・再作成は行いません');
    return;
  }
  if (st.isNew) log('状態ファイルは未作成です（初回実行として扱います）: ' + STATE_FILE);

  // --- 入力 ---
  const input = loadInputs();
  if (!input.events || !input.events.events) {
    logError('data/events.json を読めませんでした。投稿を中止します');
    return;
  }
  const eventsObj = input.events.events;
  const isNtcTypeFn = makeIsNtcTypeFromSeriesMap(input.seriesMap);
  const range = resolveDefaultRange(input.topStats, eventsObj, input.seriesMap);
  log('既定レンジ: ' + range.start + '〜' + range.end
    + ' (slug=' + (range.series_slug || 'なし') + ' / 出典=' + range.source + ')');

  const aggDefault = aggregateUsage(eventsObj, isNtcTypeFn, range.start, range.end);
  log('既定レンジ集計: イベント ' + aggDefault.eventCount + ' 件 / 対象デッキ ' + aggDefault.totalDecks
    + ' 件 / 出現カード ' + Object.keys(aggDefault.usage).length + ' 種');

  const ctx = {
    today, state: st.state, eventsObj, isNtcTypeFn, range, aggDefault,
    cardsMaster: input.cardsMaster, cardsPreview: input.cardsPreview
  };

  const plans = [];
  let dailyPlan = null;
  if (ONLY !== 'mover') {
    dailyPlan = planDaily(ctx);
    plans.push(dailyPlan);
  }
  if (ONLY !== 'daily') {
    // 同じ夜に「今日のカード」で投稿するカードはムーバーから除外する
    ctx.sameNightCardIds = (dailyPlan && !dailyPlan.skip) ? [dailyPlan.card.card_id] : [];
    plans.push(planMover(ctx));
  }
  for (const p of plans) printPlan(p);

  if (DRY_RUN) {
    log('[DRY-RUN] postTweet / uploadMediaToX / 状態ファイル書き込み はいずれも実行していません');
    return;
  }

  // --- ここから書き込み系 ---
  if (!X_API_KEY || !X_API_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_TOKEN_SECRET) {
    logError('X API の資格情報が .env から読めません。投稿を中止します');
    return;
  }
  let first = true;
  for (const p of plans) {
    if (p.skip) continue;
    if (!first) await sleep(CONFIG.POST_INTERVAL_MS);
    first = false;
    try {
      await executeItem(p, st.state);
    } catch (e) {
      logError('[' + p.key + '] 想定外の例外: ' + e.message);
    }
  }
}

if (require.main === module) {
  main()
    .catch((e) => { logError('想定外の例外: ' + (e && e.stack ? e.stack : e)); })
    .finally(() => {
      // 投稿の成否はバッチの終了コードへ不伝播（指示書61 §1-4）
      process.exitCode = 0;
      log('終了 (exit 0 固定)');
    });
}

module.exports = {
  main,
  CONFIG,
  weightedLength,
  hash32,
  dayOfWeek, addDays, diffDays, mondayOf,
  aggregateUsage, buildDailyPool, resolveDefaultRange, halfMonthRangeFromDate,
  planDaily, planMover, buildDailyText, buildMoverText,
  readState, writeStateAtomic, lastPostedDateByCard, executeItem,
  _internal: { STATE_FILE, DRY_RUN }
};
