#!/usr/bin/env node
/**
 * post-x-ntc-flash.js  ―  NTC入賞デッキ速報の自動X投稿（指示書72 §2-B）
 *
 * run-ntc-flash.bat から 15 分ごとに 1 tick だけ呼ばれる。1 tick でやることは
 *   1) 稼働窓の確認（09:00〜23:30 / 19:20〜20:40 は無条件スキップ）
 *   2) due（開始+3h 経過）の算出 … アーカイブ由来 + ローカル取込済みのフォールバック
 *   3) 未取込 due があり、かつ毎時 :00 tick のときだけ公式一覧へアクセス
 *   4) 新規掲載があれば既存チェーン（collect → import → 再生成 → deploy）を実行
 *   5) 投稿キューの先頭から 1 件だけ X へ速報投稿（画像最大4枚）
 *
 * Usage:
 *   node post-x-ntc-flash.js                        本番（バッチから）
 *   node post-x-ntc-flash.js --dry-run              真の dry-run（投稿・メディアup・state書込に到達しない）
 *   node post-x-ntc-flash.js --now 2026-08-15T10:00:00+09:00   現在時刻を注入（CLI のみ）
 *   node post-x-ntc-flash.js --fixture <dir>        公式一覧を fixture から読む（実アクセスしない）
 *   node post-x-ntc-flash.js --seed-state           登録直後の初期化。既存の due を投稿せず対象外として記録
 *   node post-x-ntc-flash.js --root <dir>           データ一式の場所（既定 = このファイルの場所）
 *   node post-x-ntc-flash.js --site <url>           ビルダー/イベントページの起点（既定 https://gcg-stats.com）
 *   node post-x-ntc-flash.js --state-file <path>    state の差し替え（検証用）
 *   node post-x-ntc-flash.js --no-chain             チェーンを実行しない（検証用）
 *   node post-x-ntc-flash.js --force-list           :00 tick 以外でも一覧アクセスを許可（検証用）
 *   node post-x-ntc-flash.js --chrome <path>        Chrome/Edge の場所
 *
 * 鉄則（指示書72 §1-7 / §3）:
 *   - 既存スクリプト（post-x-daily.js / collect-ntc-daily.js 等）は 1 バイトも変更しない。
 *     必要な処理はこのファイル内に複製する（OAuth・加重文字数・共有コード生成）。
 *   - 終了コードは常に 0。バッチの最終 exit にも伝播させない。
 *   - dry-run では書き込み系 3 種（postTweet / uploadMediaToX / state 書込）へ構造的に到達せず、
 *     各関数の先頭の assertNotDryRun() が二重に防御する。
 *   - at-most-once の対象は投稿段。attempting / posted は理由を問わず永久に再投稿しない。
 *
 * 作成: 2026-08-14（指示書72 実装セッション）
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

// ===================================================================
// 0. CLI 引数
// ===================================================================
function argValue(name) {
  const argv = process.argv;
  const i = argv.indexOf('--' + name);
  if (i >= 0 && i + 1 < argv.length && !argv[i + 1].startsWith('--')) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith('--' + name + '='));
  if (eq) return eq.slice(('--' + name + '=').length);
  return null;
}
function argFlag(name) {
  return process.argv.some((a) => a === '--' + name || a.startsWith('--' + name + '='));
}

const DRY_RUN = argFlag('dry-run');
const SEED_STATE = argFlag('seed-state');
const NO_CHAIN = argFlag('no-chain');
const FORCE_LIST = argFlag('force-list');
const FIXTURE_DIR = argValue('fixture');
const NOW_ARG = argValue('now');
const CHROME_ARG = argValue('chrome');
const SHOW_BROWSER = argFlag('show');

const PLAN_ONLY = argFlag('plan-only');
// --stub-images は検証専用の差し替え口。dry-run 以外では起動時に停止する（本番で効かせない）。
const STUB_IMAGES = argFlag('stub-images');
if (STUB_IMAGES && !DRY_RUN) {
  console.error('[ntc-flash] --stub-images は --dry-run と併用したときだけ使えます');
  process.exit(0);
}

const ROOT = argValue('root') || process.env.NTC_FLASH_ROOT || path.resolve(__dirname);
const DATA_DIR = path.join(ROOT, 'data');
const STATE_DIR = path.join(ROOT, '.sched-run-tmp');
const TMP_DIR = path.join(ROOT, 'tmp');
const STATE_FILE = argValue('state-file') || path.join(STATE_DIR, 'ntc-flash-state.json');
const CHAIN_FILE = path.join(STATE_DIR, 'ntc-flash-chain.json');
const SENTINEL = path.join(STATE_DIR, 'ntc-new-events.flag');
const OUT_DIR = argValue('out-dir') || path.join(TMP_DIR, 'ntc-flash-images');

// ===================================================================
// 1. 調整可能な定数
// ===================================================================
const CONFIG = {
  SITE_URL: (argValue('site') || 'https://gcg-stats.com').replace(/\/+$/, ''),
  OFFICIAL_BASE: 'https://d.bandai-tcg-plus.com/gcgja',

  // --- 稼働窓（JST・分解能は分） ---
  WINDOW_START: '09:00',
  WINDOW_END: '23:30',
  SKIP_START: '19:20',       // 夜間バッチ帯 + tick 最大所要
  SKIP_END: '20:40',

  // --- due / TTL ---
  DUE_AFTER_HOURS: 3,        // 開始 + 3時間でチェック開始
  TTL_HOURS: 96,             // 未掲載のまま96時間 → no_result
  MAX_DUE_AGE_HOURS: 96,     // 【仕様追補】開始（不明なら開催日終わり）から96時間を超えた分は速報対象外

  // --- 投稿 ---
  SERIES_GRACE_DAYS: 5,      // 【二次確認R1】シリーズ終了後もこの日数は対象に残す（月末開催の掲載遅れを拾う）

  MIN_POST_INTERVAL_MIN: 15, // 実投稿間隔の下限（state.last_posted_at で厳密保証）
  MAX_ATTEMPTS: 3,           // これに達したら gave_up
  MAX_MEDIA: 4,              // X の静止画上限
  MAX_WEIGHTED_LENGTH: 280,
  URL_WEIGHTED_LENGTH: 23,
  // 【二次確認R3】0 = 送信は1回だけ。POST が届いた後に接続が切れた場合の再送は
  // 二重投稿になりうるため、§2-C の at-most-once を優先してリトライしない。
  POST_RETRY: 0,
  MEDIA_INTERVAL_MS: 500,
  IMAGE_KEEP_DAYS: 3,        // 生成画像の保持日数（投稿後は即削除・取りこぼしをこの日数で掃除）

  // --- イベントページの公開確認 ---
  PAGE_WAIT_MAX_MS: 300000,  // 5分
  PAGE_WAIT_INTERVAL_MS: 30000,

  // --- 画像 ---
  DECK_NAME_MAX: 30,         // ビルダーの maxlength=30 / ?n= の slice(0,30) と一致させる
  IMAGE_JPEG_OVER_BYTES: 4.5 * 1024 * 1024,  // これを超えたら高品質JPEGへ縮退
  IMAGE_JPEG_QUALITY: 92,
  X_MAX_BYTES: 5 * 1024 * 1024,
  GEN_TIMEOUT_MS: 180000,    // 1枚あたりの生成上限
  NAV_TIMEOUT_MS: 120000,

  // --- チェーン ---
  CHAIN_MARK_AFTER: 3,       // 同一段が N tick 連続失敗でログに目立つマーカー
  CHAIN_STEP_TIMEOUT_MS: 7200000,

  // --- tick 全体 ---
  TICK_BUDGET_MS: 720000,    // 12分。これを超えたら新しいイベントの処理を始めない

  UA: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
};
// 待ち時間だけは CLI から詰められるようにする（検証で 5 分待たないため。本番では既定値のまま）
{
  const a = Number(argValue('page-wait-max-ms'));
  const b = Number(argValue('page-wait-interval-ms'));
  if (isFinite(a) && a > 0) CONFIG.PAGE_WAIT_MAX_MS = a;
  if (isFinite(b) && b > 0) CONFIG.PAGE_WAIT_INTERVAL_MS = b;
  const c = Number(argValue('tick-budget-ms'));
  if (isFinite(c) && c > 0) CONFIG.TICK_BUDGET_MS = c;
  const d = Number(argValue('jpeg-over-bytes'));   // JPEG 縮退の閾値（境界検証用）
  if (isFinite(d) && d > 0) CONFIG.IMAGE_JPEG_OVER_BYTES = d;
}

const RANK_LABEL = { 1: '優勝', 2: '2位', 3: '3位', 4: '4位' };
const COLOR_SORT_ORDER = ['Blue', 'Red', 'Green', 'White', 'Purple'];   // generate-events.js L427 と同一
const DECK_COLORS_JP = { Blue: '青', Red: '赤', Green: '緑', White: '白', Purple: '紫', Unknown: '不明' };
const SET_COLORS = { ST01: 'Blue', ST02: 'Red', ST03: 'Green', ST04: 'White', ST05: 'Green', ST06: 'Red', ST07: 'Purple', ST08: 'Blue', ST09: 'White' };
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

// ===================================================================
// 2. ログ
// ===================================================================
const LOGLINES = [];
function log(msg) {
  const line = '[' + jstStamp(getNow()) + ' JST][ntc-flash] ' + msg;
  LOGLINES.push(line);
  console.log(line);
}
function logErr(msg) { log('*** ERROR *** ' + msg); }
function logMark(msg) { log('★★★ ' + msg + ' ★★★'); }

// ===================================================================
// 3. 時刻（すべて JST。参照はこの単一経路のみ）
// ===================================================================
let FIXED_NOW = null;
if (NOW_ARG) {
  const t = Date.parse(NOW_ARG);
  if (!isFinite(t)) {
    console.error('[ntc-flash] --now の形式が不正です（ISO 8601）: ' + NOW_ARG);
    process.exit(0);
  }
  FIXED_NOW = new Date(t);
}
function getNow() { return FIXED_NOW ? new Date(FIXED_NOW.getTime()) : new Date(); }
/** JST の Date パーツ */
function jstOf(d) { return new Date(d.getTime() + 9 * 3600 * 1000); }
function jstStamp(d) { return jstOf(d).toISOString().replace('T', ' ').slice(0, 19); }
function jstIso(d) { return jstOf(d).toISOString().slice(0, 19) + '+09:00'; }
function jstDateStr(d) { return jstOf(d).toISOString().slice(0, 10); }
function jstHHMM(d) { return jstOf(d).toISOString().slice(11, 16); }
function jstMinuteOfHour(d) { return Number(jstOf(d).toISOString().slice(14, 16)); }
/** 'YYYY-MM-DDTHH:MM:SS'（タイムゾーン無し = JST）を Date へ */
function parseJstNaive(s) {
  if (!s || typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s);
  if (!m) {
    const t = Date.parse(s);
    return isFinite(t) ? new Date(t) : null;
  }
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4] - 9, +m[5], +(m[6] || 0));
  return new Date(t);
}
/** 'YYYY-MM-DD' の 23:59:59 JST */
function jstEndOfDay(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 23 - 9, 59, 59));
}
function hhmmToMinutes(s) { const m = /^(\d{2}):(\d{2})$/.exec(s); return m ? +m[1] * 60 + +m[2] : null; }

/** 稼働窓の判定: 'ok' | 'closed' | 'skip' */
function windowState(now) {
  const cur = hhmmToMinutes(jstHHMM(now));
  if (cur < hhmmToMinutes(CONFIG.WINDOW_START)) return 'closed';
  if (cur > hhmmToMinutes(CONFIG.WINDOW_END)) return 'closed';
  if (cur >= hhmmToMinutes(CONFIG.SKIP_START) && cur <= hhmmToMinutes(CONFIG.SKIP_END)) return 'skip';
  return 'ok';
}

// ===================================================================
// 4. state（.sched-run-tmp/ntc-flash-state.json）
// ===================================================================
function assertNotDryRun(what) {
  if (DRY_RUN) throw new Error('[BUG] dry-run 中に書き込み系処理へ到達しました: ' + what);
}
function emptyState() { return { version: 1, last_posted_at: null, entries: {} }; }
function readState() {
  if (!fs.existsSync(STATE_FILE)) return { ok: true, isNew: true, state: emptyState() };
  let raw;
  try { raw = fs.readFileSync(STATE_FILE, 'utf-8'); }
  catch (e) { return { ok: false, reason: 'read-failed', message: e.message }; }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.entries || typeof parsed.entries !== 'object') {
      return { ok: false, reason: 'shape-invalid', message: 'entries オブジェクトがありません' };
    }
    if (parsed.last_posted_at === undefined) parsed.last_posted_at = null;
    return { ok: true, isNew: false, state: parsed };
  } catch (e) { return { ok: false, reason: 'parse-failed', message: e.message }; }
}
function writeStateAtomic(state) {
  assertNotDryRun('writeStateAtomic');
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = STATE_FILE + '.tmp-' + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (_) { /* noop */ }
    throw e;
  }
}
function quarantineCorruptState() {
  assertNotDryRun('quarantineCorruptState');
  const stamp = jstOf(getNow()).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const dest = STATE_FILE + '.corrupt-' + stamp;
  try { fs.renameSync(STATE_FILE, dest); }
  catch (e) { logErr('state の退避に失敗: ' + e.message); return false; }
  logErr('state を退避しました: ' + path.basename(dest) + '（投稿履歴が失われます = 再投稿の恐れがあるため、この tick は投稿しません）');
  writeStateAtomic(emptyState());
  return true;
}
/** 状態の読み書きヘルパ */
function entryOf(state, key) { return state.entries[key] || null; }
function statusOf(state, key) { const e = entryOf(state, key); return e ? e.status : null; }
const TERMINAL = new Set(['posted', 'attempting', 'gave_up', 'no_result']);

// ===================================================================
// 5. データ読み込み（すべて読み取りのみ）
// ===================================================================
function readJsonSafe(file, fallback, label) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); }
  catch (e) { log('  ⚠ ' + (label || file) + ' を読めませんでした: ' + e.message); return fallback; }
}
function loadData() {
  const eventsRaw = readJsonSafe(path.join(DATA_DIR, 'events.json'), null, 'data/events.json');
  return {
    // 「読めなかった」と「読めたが0件」を区別する（0件は正当な状態で、TTL の記録などは続ける）
    eventsOk: eventsRaw !== null,
    events: eventsRaw && (eventsRaw.events || eventsRaw) || {},
    seriesMap: readJsonSafe(path.join(DATA_DIR, 'series.json'), {}, 'data/series.json'),
    archive: readJsonSafe(path.join(DATA_DIR, 'schedule_archive.json'), { events: {}, stores: {} }, 'data/schedule_archive.json'),
    dashboard: readJsonSafe(path.join(DATA_DIR, 'ntc_dashboard.json'), { series: {} }, 'data/ntc_dashboard.json'),
    cardColors: readJsonSafe(path.join(DATA_DIR, 'card_colors.json'), {}, 'data/card_colors.json'),
    cardsMaster: readJsonSafe(path.join(DATA_DIR, 'cards_master.json'), {}, 'data/cards_master.json'),
    cardsPreview: readJsonSafe(path.join(DATA_DIR, 'cards_preview.json'), {}, 'data/cards_preview.json')
  };
}

function addDaysStr(dateStr, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
/**
 * series.json の type='ntc' かつ開催期間内。
 * 【二次確認R1】終了日ちょうどで切ると、月末開催で掲載が翌日以降になった分（実データで86%が翌日以降）が
 * 月替わりの瞬間に対象から外れ、ログにも残らず落ちる。§0-3「全イベント投稿」を満たすため
 * 終了日 + SERIES_GRACE_DAYS まで対象に残す（TTL/年齢上限 96h より長い猶予）。
 */
function activeNtcSeriesIds(seriesMap, today, graceDays) {
  const g = (graceDays == null) ? CONFIG.SERIES_GRACE_DAYS : graceDays;
  const out = [];
  for (const [id, s] of Object.entries(seriesMap || {})) {
    if (!s || s.type !== 'ntc') continue;
    const st = s.start_date || s.start || null;
    const en = s.end_date || s.end || null;
    if (st && en && st <= today && today <= (addDaysStr(en, g) || en)) out.push(String(id));
  }
  return out;
}
function allNtcSeriesIds(seriesMap) {
  return Object.entries(seriesMap || {}).filter(([, s]) => s && s.type === 'ntc').map(([id]) => String(id));
}
/** ntc_dashboard.json の期間内シリーズ（公式一覧の ULID シリーズ）。猶予は series.json 側と揃える */
function activeOfficialSeries(dashboard, today, graceDays) {
  const g = (graceDays == null) ? CONFIG.SERIES_GRACE_DAYS : graceDays;
  const norm = (s) => {
    const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})$/.exec(String(s || ''));
    return m ? `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}` : null;
  };
  const out = [];
  for (const [id, s] of Object.entries((dashboard && dashboard.series) || {})) {
    if (!s || s.fetch_stopped) continue;
    const st = norm(s.start), en = norm(s.end);
    if (st && en && st <= today && today <= (addDaysStr(en, g) || en)) out.push(id);
  }
  return out;
}

// ===================================================================
// 6. 色（generate-events.js / js/common.js と同一規則）
// ===================================================================
function makeGetColor(cardColors, cardsMaster) {
  const master = {};
  const arr = Array.isArray(cardsMaster) ? cardsMaster : Object.values(cardsMaster || {});
  for (const c of arr) { if (c && c.id && c.color) master[c.id] = c.color; }
  return (id) => cardColors[id] || master[id] || SET_COLORS[String(id).split('-')[0]] || 'Unknown';
}
/** デッキ → 上位2色（COLOR_SORT_ORDER 順）。generate-events.js の deckTypeColorsOf と同一 */
function deckTypeColorsOf(deck, getColor) {
  const cc = {};
  for (const c of deck || []) {
    const col = getColor(c.card_id);
    if (col === 'Unknown' || col === 'Colorless') continue;
    cc[col] = (cc[col] || 0) + c.count;
  }
  const sorted = Object.entries(cc).sort((a, b) => b[1] - a[1]);
  if (sorted.length >= 2) {
    return [sorted[0][0], sorted[1][0]].sort((a, b) => COLOR_SORT_ORDER.indexOf(a) - COLOR_SORT_ORDER.indexOf(b));
  }
  if (sorted.length === 1) return [sorted[0][0]];
  return ['Unknown'];
}
function colorsToJa(colors) { return (colors || []).map((c) => DECK_COLORS_JP[c] || DECK_COLORS_JP.Unknown).join(''); }
/** 「青緑×2・青白×1・赤×1」（件数降順・同数は COLOR_SORT_ORDER 順） */
function buildColorDistribution(rows, getColor) {
  const counts = new Map();
  for (const r of rows) {
    const colors = (r.deck && r.deck.length) ? deckTypeColorsOf(r.deck, getColor) : ['Unknown'];
    const key = colors.join('+');
    const cur = counts.get(key) || { colors, n: 0 };
    cur.n++;
    counts.set(key, cur);
  }
  const rankOf = (colors) => colors.map((c) => {
    const i = COLOR_SORT_ORDER.indexOf(c);
    return i < 0 ? 99 : i;
  });
  const arr = [...counts.values()].sort((a, b) => {
    if (b.n !== a.n) return b.n - a.n;
    const ra = rankOf(a.colors), rb = rankOf(b.colors);
    for (let i = 0; i < Math.max(ra.length, rb.length); i++) {
      const x = ra[i] === undefined ? 99 : ra[i];
      const y = rb[i] === undefined ? 99 : rb[i];
      if (x !== y) return x - y;
    }
    return 0;
  });
  return arr.map((x) => colorsToJa(x.colors) + '×' + x.n).join('・');
}

// ===================================================================
// 7. TOP4 の抽出（§0-1 §1-2 §2-B-5b）
// ===================================================================
/**
 * 生 rank <= 4（タイ含む）を入賞とみなす。
 * 順位ラベルは 64名大会（results.length >= 16）だけ ceil(rank/2) を適用する
 * （shared/ntc-rank-consolidator.js の isTargetEvent / consolidateNtcRank と同じ規則）。
 * 画像は rank 昇順 → deck_no 昇順 → 元の並び順 の先頭4件。分布は入賞全員分。
 */
function extractTop(event) {
  const results = Array.isArray(event.results) ? event.results : [];
  const isBig = results.length >= 16;
  const rows = results
    .map((r, i) => Object.assign({}, r, { _i: i }))
    .filter((r) => Number.isFinite(r.rank) && r.rank <= 4);
  rows.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    const an = Number.isFinite(a.deck_no) ? a.deck_no : 1e9;
    const bn = Number.isFinite(b.deck_no) ? b.deck_no : 1e9;
    if (an !== bn) return an - bn;
    return a._i - b._i;
  });
  const labeled = rows.map((r) => {
    const shown = isBig ? Math.ceil(r.rank / 2) : r.rank;
    return Object.assign({}, r, { shownRank: shown, label: RANK_LABEL[shown] || (shown + '位') });
  });
  return { all: labeled, forImages: labeled.filter((r) => r.deck && r.deck.length).slice(0, CONFIG.MAX_MEDIA), isBig };
}

// ===================================================================
// 8. 共有コード（js/deckbuilder-core.js をそのまま使う）
// ===================================================================
function loadDeckCore(dir) {
  const tried = [];
  for (const p of [path.join(dir || ROOT, 'js', 'deckbuilder-core.js'), path.join(__dirname, 'js', 'deckbuilder-core.js')]) {
    try { return { mod: require(p), from: p }; } catch (e) { tried.push(p + ' (' + e.message + ')'); }
  }
  return { mod: null, tried };
}
/** js/common.js の loadShareDb と同一の byId（master 全件 + master に無い型番だけ preview から） */
function buildShareDb(cardsMaster, cardsPreview) {
  const mArr = Array.isArray(cardsMaster) ? cardsMaster : Object.values(cardsMaster || {});
  const pArr = Array.isArray(cardsPreview) ? cardsPreview : Object.values(cardsPreview || {});
  const byId = new Map();
  mArr.forEach((c) => { if (c && c.id) byId.set(c.id, { id: c.id, pv: 0 }); });
  pArr.forEach((c) => { const id = c && c.card_number; if (id && !byId.has(id)) byId.set(id, { id, pv: 1 }); });
  return byId;
}
function deckToCounts(deck) {
  const counts = {};
  for (const c of deck || []) counts[c.card_id] = (counts[c.card_id] || 0) + c.count;
  return counts;
}

// ===================================================================
// 9. デッキ名（「<順位>：<店舗名>」・30文字上限）
// ===================================================================
/** 孤立サロゲートを作らずに n 文字へ切る */
function safeSlice(s, n) {
  let out = String(s).slice(0, n);
  if (out.length && /[\uD800-\uDBFF]/.test(out[out.length - 1])) out = out.slice(0, -1);
  return out;
}
function buildDeckName(label, store) {
  const full = label + '：' + store;
  if (full.length <= CONFIG.DECK_NAME_MAX) return { name: full, truncated: false };
  const room = CONFIG.DECK_NAME_MAX - (label + '：').length - 1;   // 1 = 省略記号
  const cut = safeSlice(store, Math.max(0, room));
  return { name: label + '：' + cut + '…', truncated: true };
}

// ===================================================================
// 10. 投稿文（§2-B-5e）
// ===================================================================
const URL_REGEX = /https?:\/\/[^\s]+/g;
function isLightWeightCodePoint(cp) {
  return (cp >= 0x0000 && cp <= 0x10ff) || (cp >= 0x2000 && cp <= 0x200d)
    || (cp >= 0x2010 && cp <= 0x201f) || (cp >= 0x2032 && cp <= 0x2037);
}
function weightedLength(text) {
  const PH = '\u0000';
  const replaced = String(text).replace(URL_REGEX, PH);
  let total = 0;
  for (const ch of replaced) {
    if (ch === PH) { total += CONFIG.URL_WEIGHTED_LENGTH; continue; }
    total += isLightWeightCodePoint(ch.codePointAt(0)) ? 1 : 2;
  }
  return total;
}
function mdOf(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  return m ? `${Number(m[2])}/${Number(m[3])}` : String(dateStr || '');
}
/**
 * ISO 3166-2:JP → 都道府県の正式名（指示書72-C §1-2）。
 * 出典: リポジトリ内 generate-ntc-dashboard.js の PREF_BY_CODE（同一の表が scraper.js にもある）。
 * schedule_archive.json 側は pref_code（例 "JP-13"）しか持たないため、和名はここで持つ。
 * ※投稿用の表示名は prefLabelOf() が末尾の「都」「府」「県」だけを落とす。
 *   「道」は落とさないので JP-01 は自動的に「北海道」のまま残る（特例分岐を書かない）。
 */
const PREF_FULL_BY_CODE = {
  'JP-01': '北海道', 'JP-02': '青森県', 'JP-03': '岩手県', 'JP-04': '宮城県', 'JP-05': '秋田県',
  'JP-06': '山形県', 'JP-07': '福島県', 'JP-08': '茨城県', 'JP-09': '栃木県', 'JP-10': '群馬県',
  'JP-11': '埼玉県', 'JP-12': '千葉県', 'JP-13': '東京都', 'JP-14': '神奈川県', 'JP-15': '新潟県',
  'JP-16': '富山県', 'JP-17': '石川県', 'JP-18': '福井県', 'JP-19': '山梨県', 'JP-20': '長野県',
  'JP-21': '岐阜県', 'JP-22': '静岡県', 'JP-23': '愛知県', 'JP-24': '三重県', 'JP-25': '滋賀県',
  'JP-26': '京都府', 'JP-27': '大阪府', 'JP-28': '兵庫県', 'JP-29': '奈良県', 'JP-30': '和歌山県',
  'JP-31': '鳥取県', 'JP-32': '島根県', 'JP-33': '岡山県', 'JP-34': '広島県', 'JP-35': '山口県',
  'JP-36': '徳島県', 'JP-37': '香川県', 'JP-38': '愛媛県', 'JP-39': '高知県', 'JP-40': '福岡県',
  'JP-41': '佐賀県', 'JP-42': '長崎県', 'JP-43': '熊本県', 'JP-44': '大分県', 'JP-45': '宮崎県',
  'JP-46': '鹿児島県', 'JP-47': '沖縄県'
};
/** 表示名（接尾辞なし・北海道はそのまま）。コードが空でも表に無くても null を返す */
function prefLabelOfCode(code) {
  const full = PREF_FULL_BY_CODE[String(code || '')];
  return full ? full.replace(/[都府県]$/, '') : null;
}
/**
 * 【指示書72-C §1-1】events.json の store_id を schedule_archive.json の stores[store_id].pref_code へ
 * 引き当てる。(a) 時刻due・(b) フォールバックdue のどちらの経路でも同じ方法で引けるのが要点で、
 * archive.events[].pref_code を使うと (b) は対応する予定レコードを持たないため地域が落ちる。
 * 実測（2026-08-15）: 実データ132件すべてで解決（132/132・欠損0。archive.events 側との不一致も0）。
 * 【§1-3】pref_code が空・未取得・47件表に無いコード（schedule_archive には MY-/ID-/TH-/TW-/SG-/PH-/CN-HK が実在）
 * の場合は null を返し、呼び出し側は店舗名のみの行にする。
 */
function prefLabelOf(data, event) {
  const stores = (data && data.archive && data.archive.stores) || {};
  const s = stores[String((event && event.store_id) != null ? event.store_id : '')];
  return prefLabelOfCode(s && s.pref_code);
}
/** 【指示書72-C §1】投稿文のヘッダ行。「【」直後の半角スペースは意図的（松岡さん指定） */
const POST_HEADER = '【 #ガンダムカードゲーム ニュータイプチャレンジ結果速報】';
/**
 * 縮退は指示書どおり ① 分布を「上位4デッキ掲載」へ置換 → ② 店舗名を省略記号で切る。
 * ヘッダ行・開催日・都道府県・URL は削らない。
 * @param {string|null} pref 表示名（prefLabelOf の戻り値）。null なら店舗名のみの行にする（§1-3）
 */
function buildPostText(event, dist, url, pref) {
  const md = mdOf(event.date);
  // 【指示書72-D】区切りは全角コロン（半角は視認しにくいという松岡さんの指摘・2026-08-16）。
  // 「上位入賞：」の後ろの半角スペースは削除する（全角コロンは字幅に余白を含むため）。
  // ※ URL 中の「:」と、画像内デッキ名「順位：店舗名」は対象外。後者は元から全角。
  const place = (store) => (pref ? pref + '：' + store : store);
  const mk = (store, useDist) => POST_HEADER + '\n' + md + ' 開催\n' + place(store) + '\n'
    + '上位入賞：' + (useDist ? dist : '上位4デッキ掲載') + '\n' + url;
  let store = String(event.store || '');
  let text = mk(store, true);
  const degrade = [];
  if (weightedLength(text) > CONFIG.MAX_WEIGHTED_LENGTH) {
    degrade.push('分布→固定文言');
    text = mk(store, false);
  }
  // 【二次確認B §3-1】回数ではなく長さで回す。回数ガード（200回）だと全角297字以上の店舗名で
  // 280 を超えたまま投稿へ進んでしまう。store.length が単調減少するので終端は保証される。
  let cut = 0;
  while (weightedLength(text) > CONFIG.MAX_WEIGHTED_LENGTH && store.length > 0) {
    store = safeSlice(store, store.length - 1);
    text = mk(store + '…', degrade.length === 0);
    cut++;
  }
  if (cut > 0) degrade.push('店舗名を切り詰め');
  return { text, weighted: weightedLength(text), degrade, over: weightedLength(text) > CONFIG.MAX_WEIGHTED_LENGTH };
}

// ===================================================================
// 11. HTTP（イベントページの公開確認・読み取り系のみ）
// ===================================================================
function headOk(url, timeoutMs) {
  return new Promise((resolve) => {
    let mod = https, opts;
    try {
      const u = new URL(url);
      mod = u.protocol === 'http:' ? http : https;
      opts = { hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method: 'GET', headers: { 'User-Agent': CONFIG.UA } };
    } catch (e) { return resolve({ ok: false, status: 'BAD_URL' }); }
    const req = mod.request(opts, (res) => {
      res.resume();
      resolve({ ok: res.statusCode === 200, status: res.statusCode });
    });
    req.setTimeout(timeoutMs || 30000, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => resolve({ ok: false, status: 'ERROR', error: e.message }));
    req.end();
  });
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/** 200 になるまで最大 PAGE_WAIT_MAX_MS 待つ */
async function waitPagePublished(url) {
  const t0 = Date.now();
  let last = null;
  for (;;) {
    last = await headOk(url);
    if (last.ok) return { ok: true, waitedMs: Date.now() - t0, status: 200 };
    if (Date.now() - t0 + CONFIG.PAGE_WAIT_INTERVAL_MS > CONFIG.PAGE_WAIT_MAX_MS) break;
    await sleep(CONFIG.PAGE_WAIT_INTERVAL_MS);
  }
  return { ok: false, waitedMs: Date.now() - t0, status: last ? last.status : 'NONE' };
}

// ===================================================================
// 12. ブラウザ（puppeteer-core。collect とは別の専用 user-data-dir）
// ===================================================================
function loadPuppeteer() {
  const tried = [];
  for (const p of ['puppeteer-core',
    path.join(ROOT, 'tmp', 'node_modules', 'puppeteer-core'),
    path.join(ROOT, 'node_modules', 'puppeteer-core')]) {
    try { return { mod: require(p), from: p }; } catch (e) { tried.push(p); }
  }
  return { mod: null, tried };
}
function findBrowser() {
  const env = process.env;
  const cands = [
    env.NTC_FLASH_CHROME,
    path.join(env['PROGRAMFILES'] || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(env['LOCALAPPDATA'] || '', 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(env['PROGRAMFILES'] || 'C:\\Program Files', 'Microsoft\\Edge\\Application\\msedge.exe'),
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/opt/pw-browsers/chromium/chrome'
  ];
  for (const p of cands) { try { if (p && fs.existsSync(p)) return p; } catch (e) { /* 無視 */ } }
  return null;
}
async function openBrowser() {
  const pup = loadPuppeteer();
  if (!pup.mod) return { ok: false, reason: 'puppeteer-core が見つかりません（探した場所: ' + pup.tried.join(' / ') + '）' };
  const exe = CHROME_ARG || findBrowser();
  if (!exe) return { ok: false, reason: 'Chrome / Edge が見つかりません（--chrome で指定してください）' };
  const udd = path.join(TMP_DIR, 'ntc-flash-chrome');     // collect とは別の専用プロファイル
  try { fs.mkdirSync(udd, { recursive: true }); } catch (e) { /* 続行 */ }
  try {
    const browser = await pup.mod.launch({
      executablePath: exe,
      headless: SHOW_BROWSER ? false : 'new',
      userDataDir: udd,
      args: ['--no-first-run', '--no-default-browser-check', '--disable-features=Translate']
        .concat(process.platform !== 'win32' && process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : [])
    });
    return { ok: true, browser, exe, udd };
  } catch (e) { return { ok: false, reason: 'ブラウザを起動できませんでした: ' + (e && e.message) }; }
}
async function closeBrowser(browser) {
  if (!browser) return;
  let proc = null;
  try { proc = browser.process ? browser.process() : null; } catch (e) { proc = null; }
  try {
    await Promise.race([browser.close(), new Promise((_, rej) => setTimeout(() => rej(new Error('close timeout')), 20000))]);
  } catch (e) {
    try { if (proc && !proc.killed) proc.kill('SIGKILL'); } catch (e2) { /* 無視 */ }
  }
}

// ===================================================================
// 13. 公式一覧（掲載検知）― collect-ntc-daily.js と同じ流儀
// ===================================================================
const seriesUrl = (id) => CONFIG.OFFICIAL_BASE + '/tournament/sanctioned/' + id;

async function readOfficialList(browser, url) {
  let page = null;
  try {
    page = await browser.newPage();
    await page.setUserAgent(CONFIG.UA);
    await page.setViewport({ width: 1280, height: 900 });
    page.setDefaultNavigationTimeout(CONFIG.NAV_TIMEOUT_MS);
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    const t0 = Date.now();
    let initial = 0;
    while (Date.now() - t0 < 40000) {
      initial = await page.evaluate(() => document.querySelectorAll('a[href*="/single"]').length);
      if (initial > 0) break;
      await sleep(2000);
    }
    if (initial === 0) return { ok: false, reason: '一覧が表示されませんでした（' + Math.round((Date.now() - t0) / 1000) + '秒待機）' };
    let prev = initial, stall = 0, loops = 0;
    const tS = Date.now();
    while (loops < 150 && stall < 2) {
      if (Date.now() - tS > 600000) break;
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await sleep(2100);                                  // 取り決めの「2秒以上」
      const c = await page.evaluate(() => document.querySelectorAll('a[href*="/single"]').length);
      if (c === prev) stall++; else { stall = 0; prev = c; }
      loops++;
    }
    const rows = await page.evaluate(() => [...document.querySelectorAll('a[href*="/single"]')].map((a) => {
      const href = a.getAttribute('href') || '';
      const id = (href.match(/\/([0-9A-HJKMNP-TV-Z]{26})\/single/) || [])[1] || null;
      const t = (a.innerText || '').replace(/\s+/g, ' ').trim();
      const date = (t.match(/(\d{4}\/\d{1,2}\/\d{1,2})/) || [])[1] || '';
      const cap = (t.match(/定員(\d+)名/) || [])[1] || '';
      const place = t.replace(/定員\d+名/, '').replace(/\d{4}\/\d{1,2}\/\d{1,2}/, '').trim();
      return { shop_id: id, place, date, capacity: cap ? Number(cap) : null };
    }));
    return { ok: true, rows, initial, loops, hitLimit: stall < 2 };
  } catch (e) {
    return { ok: false, reason: 'ブラウザ操作に失敗: ' + (e && e.message) };
  } finally {
    if (page) { try { await page.close(); } catch (e) { /* 無視 */ } }
  }
}

/** fixture から読む（クラウド検証用。実アクセスしない） */
function readOfficialListFixture(seriesId) {
  const cands = [
    path.join(FIXTURE_DIR, 'official-list-' + seriesId + '.json'),
    path.join(FIXTURE_DIR, 'official-list.json')
  ];
  for (const f of cands) {
    if (fs.existsSync(f)) {
      try {
        const j = JSON.parse(fs.readFileSync(f, 'utf-8'));
        return { ok: true, rows: Array.isArray(j) ? j : (j.rows || []), fixture: f, hitLimit: false };
      } catch (e) { return { ok: false, reason: 'fixture を読めません: ' + e.message }; }
    }
  }
  return { ok: false, reason: 'fixture が見つかりません: ' + cands.join(' / ') };
}

// ===================================================================
// 14. 既存チェーン（collect → import → 再生成 → deploy）
// ===================================================================
const CHAIN_STEPS = [
  { name: 'collect-ntc-daily', args: ['collect-ntc-daily.js'], softRc: [8, 9], collect: true },
  { name: 'import-ntc-decks', args: ['import-ntc-decks.js'] },
  { name: 'build-series-summary', args: [path.join('scripts', 'build-series-summary.js')], gated: true },
  { name: 'build-series-pages', args: [path.join('scripts', 'build-series-pages.js')], gated: true },
  { name: 'generate-events', args: ['generate-events.js'], gated: true },
  { name: 'generate', args: ['generate.js'], gated: true },
  { name: 'generate_cards', args: ['generate_cards.js'], gated: true },
  { name: 'generate_cardlist', args: ['generate_cardlist.js'], gated: true },
  { name: 'generate-report', args: ['generate-report.js', '--index-only'], gated: true },
  { name: 'generate-sitemap-extra', args: ['generate-sitemap-extra.js'], gated: true },
  { name: 'deploy-results', args: ['deploy-results.js'], gated: true, deploy: true },
  { name: 'generate-ntc-dashboard', args: ['generate-ntc-dashboard.js'], gated: true },
  { name: 'deploy-ntc-dashboard', args: ['deploy-ntc-dashboard.js'], gated: true, deploy: true }
];

function readChainState() {
  try { return JSON.parse(fs.readFileSync(CHAIN_FILE, 'utf-8')); } catch (e) { return { stage: null, count: 0 }; }
}
function writeChainState(obj) {
  // state（ntc-flash-state.json）とは別ファイル。§2-B-3 の「state書込なし」を守るための連続失敗カウンタ。
  if (DRY_RUN) return;
  try {
    fs.mkdirSync(path.dirname(CHAIN_FILE), { recursive: true });
    fs.writeFileSync(CHAIN_FILE, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
  } catch (e) { logErr('チェーン連続失敗カウンタを書けませんでした: ' + e.message); }
}
function noteChainFailure(stage) {
  const cur = readChainState();
  const next = (cur.stage === stage) ? { stage, count: (cur.count || 0) + 1 } : { stage, count: 1 };
  writeChainState(next);
  if (next.count >= CONFIG.CHAIN_MARK_AFTER) {
    logMark('チェーンの「' + stage + '」が ' + next.count + ' tick 連続で失敗しています。手当てが必要です');
  }
  return next.count;
}
function clearChainFailure() { const cur = readChainState(); if (cur.stage) writeChainState({ stage: null, count: 0 }); }

function runNode(args, label) {
  const r = spawnSync(process.execPath, args, {
    cwd: ROOT, encoding: 'utf-8', timeout: CONFIG.CHAIN_STEP_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  const rc = (r.error || r.status === null) ? -1 : r.status;
  log('  chain[' + label + '] exit ' + rc + (r.error ? ' (' + r.error.message + ')' : ''));
  return rc;
}
function gitStatusClean() {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf-8', timeout: 120000 });
  if (r.error || r.status !== 0) return { known: false, clean: null, out: (r.stderr || '').slice(0, 300) };
  const out = String(r.stdout || '').trim();
  return { known: true, clean: out.length === 0, out: out.split('\n').slice(0, 10).join(' | ') };
}

/**
 * 戻り値: { ok, stage, rc, ran, skipped }
 * @param {string[]} [explicitSeries] collect-ntc-daily.js へ `--series` で明示指定するシリーズ（猶予期間中に必要）
 */
function runChain(explicitSeries) {
  if (NO_CHAIN) { log('チェーンは --no-chain のため実行しません'); return { ok: true, ran: false, skipped: 'no-chain' }; }
  // 【二次確認R2】dry-run では既存チェーンも動かさない。
  // チェーンには collect（公式への実アクセス）と deploy（GitHub への実 push）が含まれるため、
  // ここにガードが無いと「真の dry-run」（§2-D）にならず、§3 の「GO前push禁止」にも触れる。
  if (DRY_RUN) {
    log('[dry-run] 既存チェーン（collect → import → 再生成 → deploy）は実行しません');
    return { ok: true, ran: false, skipped: 'dry-run' };
  }
  log('既存チェーンを実行します（collect → import → 再生成 → deploy）');
  try { if (fs.existsSync(SENTINEL)) fs.unlinkSync(SENTINEL); } catch (e) { logErr('sentinel を消せませんでした: ' + e.message); }

  let gateOpen = false;
  for (const step of CHAIN_STEPS) {
    if (step.gated && !gateOpen) continue;
    // 時刻の再評価（§2-B-0 の2点目: deploy 直前）。窓を出ていたら deploy せずに中断する。
    // 再生成済みで未 deploy の作業ツリーが残るが、次 tick か夜間バッチが配信する（自動修復はしない）。
    if (step.deploy) {
      const wd = windowState(getNow());
      if (wd !== 'ok') {
        log('  deploy 直前の時刻再評価で窓外（' + wd + '）。「' + step.name + '」以降は行わず中断します');
        return { ok: true, ran: true, aborted: 'window-' + wd, regenerated: gateOpen };
      }
    }
    // 【二次確認N3】collect-ntc-daily.js の pickTargetSeries は「今日が期間内」でシリーズを選ぶため、
    // こちらの猶予期間（終了日+3日）に入ると対象を選べず空振りする。その場合だけ --series で明示指定する。
    // 通常時は引数なし＝これまでの挙動と1バイトも変わらない。
    let rc;
    if (step.collect) {
      // 【二次確認O1】通常実行は必ず行い、猶予中のシリーズはそれに「追加」する。
      // 置き換えにすると、猶予期間（毎月1〜3日）に当月分が collect されなくなる。
      const runs = [{ args: step.args, label: step.name }];
      for (const sid of (explicitSeries || [])) {
        runs.push({ args: step.args.concat(['--series', sid]), label: step.name + ' --series ' + sid });
      }
      const rcs = [];
      rc = 0;
      for (const one of runs) {
        const r2 = runNode(one.args, one.label);
        rcs.push(r2);
        // 【二次確認O3】exit 9 = 別の run が collect の lock を持っている。
        // ここで進むと import〜deploy が並走しうるので、即座にチェーンを打ち切る。
        if (r2 === 9) {
          log('  collect が別 run のロックに阻まれました（exit 9）。この tick はチェーンを打ち切ります');
          return { ok: true, ran: true, skipped: 'collect-9' };
        }
        if (r2 !== 0 && step.softRc.indexOf(r2) < 0) { rc = r2; break; }
      }
      // 【二次確認O3】すべてが「何もしなかった」なら、通常時と同じくチェーンを打ち切る
      if (rc === 0 && rcs.length && rcs.every((x) => step.softRc.indexOf(x) >= 0)) {
        log('  collect が何もしませんでした（exit ' + rcs.join(',') + '）。この tick はチェーンを打ち切ります');
        return { ok: true, ran: true, skipped: 'collect-' + rcs.join(',') };
      }
    } else {
      rc = runNode(step.args, step.name);
    }
    if (rc !== 0) {
      if (step.deploy) {
        const g = gitStatusClean();
        if (g.known && !g.clean) logErr('  deploy 失敗後の git 作業ツリーが汚れています（自動修復はしません）: ' + g.out);
        else if (g.known) log('  deploy 失敗後の git 作業ツリーはクリーンです');
        else logErr('  git status を確認できませんでした: ' + g.out);
      }
      const n = noteChainFailure(step.name);
      logErr('チェーンの「' + step.name + '」が RC=' + rc + ' で失敗しました。この tick は全体見送りです（連続 ' + n + ' 回）');
      return { ok: false, stage: step.name, rc, ran: true };
    }
    if (step.name === 'import-ntc-decks') {
      gateOpen = fs.existsSync(SENTINEL);
      log('  新規イベント sentinel: ' + (gateOpen ? 'あり（再生成・deploy へ進みます）' : 'なし（再生成・deploy は行いません）'));
    }
  }
  clearChainFailure();
  return { ok: true, ran: true, regenerated: gateOpen };
}

// ===================================================================
// 15. 画像生成（本番ビルダーを headless Chrome で操作）
// ===================================================================
/**
 * 1件のデッキから共有画像を1枚作る。
 * 戻り値: { ok, file, bytes, mime, ext, url, verify:{cells, unique, failedImages}, reason }
 */
async function generateShareImage(browser, deck, deckName, shareCode, outFile) {
  const url = CONFIG.SITE_URL + '/deck-builder.html?d=' + encodeURIComponent(shareCode)
    + '&n=' + encodeURIComponent(deckName);
  let page = null;
  // ビルダーの内部変数（state / siState / siCells）は IIFE の中にあり外から触れない。
  // 検証はすべて「観測できる DOM とネットワーク」だけで行う。
  const imgFail = [];
  try {
    page = await browser.newPage();
    await page.setUserAgent(CONFIG.UA);
    await page.setViewport({ width: 1440, height: 1200 });
    page.setDefaultNavigationTimeout(CONFIG.NAV_TIMEOUT_MS);
    // カード画像の取得失敗を拾う（プレースホルダ描画の検知に使う）
    page.on('response', (res) => {
      const u = res.url();
      if (/\/images\/cards\/.+\.(webp|png|jpg)$/i.test(u) && res.status() >= 400) imgFail.push(u.split('/').pop() + ' (' + res.status() + ')');
    });
    page.on('requestfailed', (req) => {
      const u = req.url();
      if (/\/images\/cards\//.test(u)) imgFail.push(u.split('/').pop() + ' (' + ((req.failure() && req.failure().errorText) || 'failed') + ')');
    });
    // トースト（「N件のカード画像を読み込めませんでした」等）は数秒で消えるので、出た瞬間に記録する
    await page.evaluateOnNewDocument(() => {
      window.__toasts = [];
      const start = () => {
        const t = document.getElementById('toast');
        if (!t) return false;
        new MutationObserver(() => {
          if (/\bshow\b/.test(t.className)) window.__toasts.push(t.textContent || '');
        }).observe(t, { attributes: true, childList: true, subtree: true, characterData: true });
        return true;
      };
      document.addEventListener('DOMContentLoaded', () => { if (!start()) setTimeout(start, 500); });
    });
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // 共有デッキ読み込みの確認モーダル → OK
    await page.waitForFunction(() => {
      const m = document.getElementById('confirmModal');
      return m && m.classList.contains('open');
    }, { timeout: CONFIG.NAV_TIMEOUT_MS });
    await page.click('#cfYes');

    // 読み込み完了（[共有画像]が押せるようになる）まで待つ
    await page.waitForFunction(() => {
      const b = document.getElementById('btnShareImg');
      return b && !b.disabled;
    }, { timeout: CONFIG.NAV_TIMEOUT_MS });

    // 載ったデッキ（種類数・枚数・デッキ名）を DOM から読む。
    // #deckGrid の [data-deckid] は state.cards の1種につき1要素 ＝ siCells() の件数と同じ。
    const loaded = await page.evaluate(() => ({
      unique: document.querySelectorAll('#deckGrid [data-deckid]').length,
      total: Number((document.getElementById('tabNum') || {}).textContent || 0),
      name: (document.getElementById('deckName') || {}).value || null,
      toasts: (window.__toasts || []).slice()
    }));

    await page.click('#btnShareImg');
    // 生成完了 = [画像を保存] が押せるようになる。失敗時は状態テキストに出る。
    await page.waitForFunction(() => {
      const save = document.getElementById('siSave');
      const st = (document.getElementById('siStatusText') || {}).textContent || '';
      return (save && !save.disabled) || /失敗|できませんでした/.test(st);
    }, { timeout: CONFIG.GEN_TIMEOUT_MS, polling: 500 });

    const info = await page.evaluate(() => {
      const img = document.getElementById('siImg');
      return {
        statusText: (document.getElementById('siStatusText') || {}).textContent || '',
        saveEnabled: !!(document.getElementById('siSave') && !document.getElementById('siSave').disabled),
        shareUrl: (document.getElementById('siUrl') || {}).textContent || '',
        warn: (document.getElementById('siWarn') || {}).textContent || '',
        src: img ? img.getAttribute('src') : null,
        toasts: (window.__toasts || []).slice(),
        cells: document.querySelectorAll('#deckGrid [data-deckid]').length
      };
    });
    if (!info.saveEnabled) return { ok: false, reason: 'ビルダーが画像を生成できませんでした: ' + info.statusText, url, info };

    const got = await page.evaluate(() => {
      const src = document.getElementById('siImg').getAttribute('src');
      return fetch(src).then((r) => r.blob()).then((b) => new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve({ b64: String(fr.result).split(',')[1], type: b.type, size: b.size });
        fr.onerror = () => reject(new Error('blob-read'));
        fr.readAsDataURL(b);
      }));
    });
    const buf = Buffer.from(got.b64, 'base64');
    const ext = /jpeg|jpg/.test(got.type) ? 'jpg' : 'png';
    const file = outFile.replace(/\.[a-z0-9]+$/i, '') + '.' + ext;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, buf);

    // 「N件のカード画像を読み込めませんでした（型番のみで描画しています）」＝ プレースホルダ描画
    const placeholderToast = (info.toasts || []).find((t) => /カード画像を読み込めませんでした/.test(t)) || null;

    return {
      ok: true, file, bytes: buf.length, mime: got.type, ext, url,
      verify: {
        cells: info.cells, unique: loaded.unique, total: loaded.total,
        expectUnique: Object.keys(deckToCounts(deck)).length,
        expectTotal: (deck || []).reduce((s, c) => s + c.count, 0),
        placeholderToast, imgFail: [...new Set(imgFail)]
      },
      info: { mime: got.type, bytes: buf.length, shareUrl: info.shareUrl, warn: info.warn, name: loaded.name },
      loaded
    };
  } catch (e) {
    return { ok: false, reason: (e && e.message) || String(e), url, imgFail: [...new Set(imgFail)] };
  } finally {
    if (page) { try { await page.close(); } catch (e) { /* 無視 */ } }
  }
}

/** DOM 検証（§2-B-5c）: 描画カード種数 = デッキ種数 かつ 未知カードのプレースホルダ非存在 */
function verifyImage(r) {
  if (!r.ok) return { ok: false, reason: r.reason };
  const v = r.verify || {};
  if (!v.cells) return { ok: false, reason: 'デッキが描画されていません（cells=' + v.cells + '）' };
  if (v.cells !== v.expectUnique) return { ok: false, reason: '描画カード種数 ' + v.cells + ' ≠ デッキ種数 ' + v.expectUnique };
  if (v.total !== v.expectTotal) return { ok: false, reason: '読み込まれた枚数 ' + v.total + ' ≠ デッキ枚数 ' + v.expectTotal };
  if (v.placeholderToast) {
    return { ok: false, reason: 'カード画像を読み込めませんでした（型番のみのプレースホルダ描画）: ' + v.placeholderToast
      + (v.imgFail && v.imgFail.length ? ' / 失敗した取得: ' + v.imgFail.slice(0, 6).join(', ') : '') };
  }
  if (v.imgFail && v.imgFail.length) {
    return { ok: false, reason: 'カード画像の取得に失敗しています: ' + v.imgFail.slice(0, 8).join(', ') };
  }
  return { ok: true };
}

/** 4.5MB 超は高品質JPEGへ縮退（ビルダー側の4MBゲートに対する二重の保険） */
async function degradeIfHuge(file) {
  const st = fs.statSync(file);
  if (st.size <= CONFIG.IMAGE_JPEG_OVER_BYTES) return { file, bytes: st.size, degraded: false };
  let sharp = null;
  try { sharp = require('sharp'); } catch (e) { sharp = null; }
  if (!sharp) { logErr('  sharp が無いため JPEG 縮退できません（' + st.size + 'B のまま送ります）'); return { file, bytes: st.size, degraded: false, failed: true }; }
  const out = file.replace(/\.[a-z0-9]+$/i, '') + '.jpg';
  await sharp(file).jpeg({ quality: CONFIG.IMAGE_JPEG_QUALITY }).toFile(out);
  const st2 = fs.statSync(out);
  log('  画像が ' + st.size + 'B と大きいため JPEG へ縮退しました → ' + st2.size + 'B');
  // 【二次確認N8】縮退したら元の PNG は残さない（dry-run のときだけ照合用に残す）
  if (!DRY_RUN) { try { fs.unlinkSync(file); } catch (e) { /* 無視 */ } }
  return { file: out, bytes: st2.size, degraded: true };
}

// ===================================================================
// 16. X API（書き込み系。dry-run では構造的に到達しない + 先頭で二重防御）
// ===================================================================
try { require('dotenv').config({ path: path.join(ROOT, '.env'), override: true, quiet: true }); } catch (e) { /* 任意 */ }
const X_API_KEY = process.env.X_API_KEY;
const X_API_SECRET = process.env.X_API_SECRET;
const X_ACCESS_TOKEN = process.env.X_API_ACCESS_TOKEN;
const X_ACCESS_TOKEN_SECRET = process.env.X_API_ACCESS_TOKEN_SECRET;

function percentEncode(str) {
  return encodeURIComponent(str).replace(/!/g, '%21').replace(/\*/g, '%2A')
    .replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29');
}
function generateOAuthSignature(method, url, params, consumerSecret, tokenSecret) {
  const sorted = Object.keys(params).sort().map((k) => percentEncode(k) + '=' + percentEncode(params[k])).join('&');
  const base = method + '&' + percentEncode(url) + '&' + percentEncode(sorted);
  const key = percentEncode(consumerSecret) + '&' + percentEncode(tokenSecret);
  return crypto.createHmac('sha1', key).update(base).digest('base64');
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
  const all = Object.assign({}, oauthParams, extraParams);
  oauthParams.oauth_signature = generateOAuthSignature(method, url, all, X_API_SECRET, X_ACCESS_TOKEN_SECRET);
  return 'OAuth ' + Object.keys(oauthParams).sort()
    .map((k) => percentEncode(k) + '="' + percentEncode(oauthParams[k]) + '"').join(', ');
}
function uploadMediaToX(imagePath) {
  assertNotDryRun('uploadMediaToX');
  return new Promise((resolve) => {
    if (!fs.existsSync(imagePath)) { log('  [media] ファイル不在: ' + imagePath); return resolve({ id: null, status: 'NOFILE' }); }
    const url = 'https://upload.twitter.com/1.1/media/upload.json';
    const authHeader = buildOAuthHeader('POST', url, {});
    const boundary = '----GcgStatsBoundary' + crypto.randomBytes(8).toString('hex');
    const imageBuffer = fs.readFileSync(imagePath);
    const head = Buffer.from('--' + boundary + '\r\n'
      + 'Content-Disposition: form-data; name="media"\r\n'
      + 'Content-Type: application/octet-stream\r\n\r\n');
    const tail = Buffer.from('\r\n--' + boundary + '--\r\n');
    const body = Buffer.concat([head, imageBuffer, tail]);
    const req = https.request({
      hostname: 'upload.twitter.com', path: '/1.1/media/upload.json', method: 'POST',
      headers: { 'Authorization': authHeader, 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode === 200 || res.statusCode === 201) {
          try {
            const parsed = JSON.parse(data);
            log('  [media] up 成功: media_id=' + parsed.media_id_string + ' (' + path.basename(imagePath) + ')');
            resolve({ id: parsed.media_id_string, status: res.statusCode });
          } catch (e) { log('  [media] レスポンス解析失敗: ' + e.message); resolve({ id: null, status: res.statusCode }); }
        } else { log('  [media] up 失敗 (' + res.statusCode + '): ' + data.slice(0, 200)); resolve({ id: null, status: res.statusCode }); }
      });
    });
    req.on('error', (e) => { log('  [media] 通信エラー: ' + e.message); resolve({ id: null, status: 'ERROR' }); });
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
      headers: { 'Authorization': authHeader, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode === 201) {
          let id = null;
          try { id = JSON.parse(data).data.id; } catch (_) { /* noop */ }
          resolve(id);
        } else reject(new Error('X投稿失敗 (' + res.statusCode + '): ' + data.slice(0, 300)));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ===================================================================
// 17. due の算出
// ===================================================================
/**
 * 戻り値:
 *   queue        … 掲載済み・未投稿のイベント（ULID キー）
 *   pendingSched … 未取込の due（sched-<数値ID> キー。公式一覧アクセスの要否を決める）
 *   expired      … TTL / 対象外年齢で落としたもの（state へ no_result を書く候補）
 */
function computeDue(data, state, now) {
  const today = jstDateStr(now);
  const activeNum = new Set(activeNtcSeriesIds(data.seriesMap, today));
  const allNum = new Set(allNtcSeriesIds(data.seriesMap));
  const dueMs = CONFIG.DUE_AFTER_HOURS * 3600 * 1000;
  const ttlMs = CONFIG.TTL_HOURS * 3600 * 1000;
  const ageMs = CONFIG.MAX_DUE_AGE_HOURS * 3600 * 1000;

  // ローカル取込済み（ntcd-<ULID>）の索引
  const local = [];
  const localByStoreDate = new Map();
  for (const [id, e] of Object.entries(data.events || {})) {
    if (!/^ntcd-/.test(id)) continue;
    if (!allNum.has(String(e.series_id))) continue;
    local.push([id, e]);
    const k = String(e.store_id) + '|' + e.date;
    if (!localByStoreDate.has(k)) localByStoreDate.set(k, []);
    localByStoreDate.get(k).push(id);
  }

  // アーカイブ（期間内NTCシリーズ）を organizer_id|開始日 で索引。
  // 突合は due 判定より先に行う ― due 前のイベントを(b)のフォールバックへ落とすと
  // 「開始+3h」の条件を素通りしてしまうため。
  const arcByOrgDate = new Map();
  for (const a of Object.values((data.archive && data.archive.events) || {})) {
    if (!activeNum.has(String(a.series_id))) continue;
    const start = parseJstNaive(a.start_datetime);
    if (!start) continue;
    const k = String(a.organizer_id) + '|' + jstDateStr(start);
    if (!arcByOrgDate.has(k)) arcByOrgDate.set(k, []);
    arcByOrgDate.get(k).push({ a, start });
  }
  const queue = [];
  const seenKey = new Set();
  const pendingSched = [];
  const expired = [];
  const pairedUlid = new Set();
  const ambiguous = [];

  const pushQueue = (q) => { if (!seenKey.has(q.key)) { seenKey.add(q.key); queue.push(q); } };

  // --- (a) アーカイブ由来: 予定と掲載済みを1対1で割り当ててから due 判定する ---
  // 【二次確認M1/M2】同一店舗・同日に複数ある場合、以前は「グループに1件でも ULID があれば
  // 全 ULID を全予定に紐づける」実装だった。そのため
  //   ・+3h 前の回まで due になる      ・片方だけ取込済みだと残りの未取込が検知されない
  // という穴があった。予定を開始時刻の昇順、ULID を昇順（ULID は生成時刻順）に並べて
  // 順番に対応付ける ＝ §2-B-2 の「開始時刻の近いものへ割当」の近似。
  // 余った予定は未取込 due、余った ULID はフォールバック due に回す。
  // 【二次確認N4】ULID は結果掲載時（毎時:48）に採番されるため、ULID 昇順は「掲載順」であって
  // 「大会開始順」ではない（実データの同日ペア768組で一致率76.6%）。そこで
  //   ① まず定員で仕分ける（アーカイブの max_join_count==64 ⟺ results.length>=16。実データ132件で完全一致）
  //   ② 同じ定員の中では 予定=開始時刻昇順 × 掲載=ULID昇順 で1対1
  //   ③ それでも両側が複数で決まらない組は、§2-B-2 のフォールバックどおり
  //      「両方due扱い」＝その組の最早開始を全 ULID の基準にする（取り違えても内容は常に正しい。
  //        キューはイベント実体を持ち、state キーも ULID なので二重投稿は起きない）
  const cap64Arc = (a) => Number(a.max_join_count) === 64;
  const cap64Ev = (e) => Array.isArray(e.results) && e.results.length >= 16;
  const addPending = (a, start) => {
    if (now.getTime() < start.getTime() + dueMs) return;
    const key = 'sched-' + a.id;
    if (TERMINAL.has(statusOf(state, key))) return;
    if (now.getTime() > start.getTime() + ttlMs) {
      expired.push({ key, reason: 'ttl', detail: '開始 ' + jstIso(start) + ' から ' + CONFIG.TTL_HOURS + 'h 掲載を確認できず', schedId: a.id });
      return;
    }
    pendingSched.push({ key, schedId: a.id, startAt: start, organizerId: a.organizer_id, date: jstDateStr(start) });
  };
  const assign = (arcs, ulids, groupKey, bucketName) => {
    arcs = arcs.slice().sort((x, y) => x.start - y.start);
    ulids = ulids.slice().sort();
    if (arcs.length > 1 && ulids.length > 1) {
      // 曖昧: 両方due扱い（最早開始を基準にする）
      ambiguous.push(groupKey + (bucketName ? '/' + bucketName : '') + '（予定' + arcs.length + '件 / 掲載' + ulids.length + '件・最早開始を基準に両方due扱い）');
      const earliest = arcs[0];
      for (const u of ulids) {
        pairedUlid.add(u);
        if (now.getTime() < earliest.start.getTime() + dueMs) continue;
        pushQueue({ key: u, ulid: u.slice('ntcd-'.length), event: data.events[u], startAt: earliest.start, basis: earliest.start, source: 'time', schedId: earliest.a.id, ambiguous: true });
      }
      for (let i = ulids.length; i < arcs.length; i++) addPending(arcs[i].a, arcs[i].start);
      return;
    }
    const n = Math.min(arcs.length, ulids.length);
    for (let i = 0; i < n; i++) {
      const { a, start } = arcs[i];
      const u = ulids[i];
      pairedUlid.add(u);
      if (now.getTime() < start.getTime() + dueMs) continue;        // まだ due ではない
      pushQueue({ key: u, ulid: u.slice('ntcd-'.length), event: data.events[u], startAt: start, basis: start, source: 'time', schedId: a.id });
    }
    for (let i = n; i < arcs.length; i++) addPending(arcs[i].a, arcs[i].start);
    // 【二次確認N5】掲載のほうが多い＝予定に無い回が載っている。余りは (b) のフォールバックへ回る
    if (ulids.length > arcs.length) {
      ambiguous.push(groupKey + (bucketName ? '/' + bucketName : '') + '（予定' + arcs.length + '件 < 掲載' + ulids.length + '件・余りは開始時刻不明として扱う）');
    }
  };
  for (const [k, list] of arcByOrgDate) {
    const ulidsAll = (localByStoreDate.get(k) || []).slice();
    if (list.length <= 1 || ulidsAll.length <= 1) { assign(list, ulidsAll, k, null); continue; }
    // 定員で仕分けてから割り当てる
    const a64 = list.filter((x) => cap64Arc(x.a)), a32 = list.filter((x) => !cap64Arc(x.a));
    const u64 = ulidsAll.filter((u) => cap64Ev(data.events[u])), u32 = ulidsAll.filter((u) => !cap64Ev(data.events[u]));
    if ((a64.length && u64.length) || (a32.length && u32.length)) {
      if (a64.length || u64.length) assign(a64, u64, k, '64名');
      if (a32.length || u32.length) assign(a32, u32, k, '32名系');
    } else {
      assign(list, ulidsAll, k, null);   // 定員で仕分けても対応が付かない → まとめて処理
    }
  }

  // --- (b) フォールバック: 予定と対応づかなかった掲載済み（開始時刻が引けない） ---
  for (const [id, e] of local) {
    if (!activeNum.has(String(e.series_id))) continue;              // 期間外シリーズは対象外
    if (pairedUlid.has(id)) continue;                               // 開始時刻が引けた → (a) の管轄
    const detected = e.fetched_at ? parseJstNaive(e.fetched_at) : null;
    pushQueue({ key: id, ulid: id.slice('ntcd-'.length), event: e, startAt: null, basis: jstEndOfDay(e.date), source: 'fallback', detectedAt: detected });
  }

  // --- 年齢の上限（仕様追補）と state による除外 ---
  const kept = [];
  for (const q of queue) {
    const st = statusOf(state, q.key);
    if (TERMINAL.has(st)) continue;
    const basis = q.basis || (q.startAt || null);
    if (basis && now.getTime() > basis.getTime() + ageMs) {
      expired.push({ key: q.key, reason: 'too-old', detail: '基準 ' + jstIso(basis) + ' から ' + CONFIG.MAX_DUE_AGE_HOURS + 'h 超過', ulid: q.ulid });
      continue;
    }
    kept.push(q);
  }

  // --- 並び: 開始時刻の新しい順（不明は掲載検知の新しい順）。同点は ULID 昇順 ---
  kept.sort((a, b) => {
    const ta = (a.startAt || a.detectedAt || a.basis || new Date(0)).getTime();
    const tb = (b.startAt || b.detectedAt || b.basis || new Date(0)).getTime();
    if (tb !== ta) return tb - ta;
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });

  return {
    queue: kept, pendingSched, expired, ambiguous,
    published: local.filter(([, e]) => activeNum.has(String(e.series_id))).length,   // 掲載=M（対象シリーズで掲載を確認できている総数）
    counts: { time: kept.filter((q) => q.source === 'time').length, fallback: kept.filter((q) => q.source === 'fallback').length }
  };
}

// ===================================================================
// 18. 1件の処理
// ===================================================================
async function processOne(item, ctx) {
  const { state, data, getColor, deckCore, byId } = ctx;
  const ev = item.event;
  const pageUrl = CONFIG.SITE_URL + '/events/' + item.key + '.html';
  log('対象: ' + item.key + ' ' + ev.date + ' ' + ev.store + '（' + (item.source === 'time' ? '時刻due' : 'フォールバックdue') + '）');

  // --- a. イベントページ公開確認（先） ---
  const pub = await waitPagePublished(pageUrl);
  if (!pub.ok) {
    bumpRetry(state, item.key, 'イベントページが 200 になりません（' + pub.status + ' / ' + Math.round(pub.waitedMs / 1000) + '秒待機）');
    return { result: 'retry', reason: 'page-' + pub.status };
  }
  log('  イベントページ 200 を確認（' + Math.round(pub.waitedMs / 1000) + '秒）');

  // --- b. TOP4 抽出 ---
  const top = extractTop(ev);
  if (!top.forImages.length) {
    bumpRetry(state, item.key, '入賞デッキが1件もありません（results=' + (ev.results || []).length + '）');
    return { result: 'retry', reason: 'no-deck' };
  }
  const dist = buildColorDistribution(top.all, getColor);
  log('  入賞 ' + top.all.length + '件（' + (top.isBig ? '64名: 連結順位' : '32名系: 生順位') + '） 画像 ' + top.forImages.length + '枚 / 分布: ' + dist);

  // --- c. 画像生成 ---
  if (STUB_IMAGES) {
    const stub = top.forImages.map((r, i) => {
      const nm = buildDeckName(r.label, String(ev.store || ''));
      const counts = deckToCounts(r.deck);
      const enc = deckCore.encodeShareCode(counts, byId);
      return { file: '(stub)' + item.key + '-' + (i + 1) + '.png', bytes: 0, label: r.label, name: nm.name, truncated: nm.truncated, codeOk: enc.ok, code: enc.ok ? enc.code : null, reason: enc.reason };
    });
    const bad = stub.find((s) => !s.codeOk);
    if (bad) { bumpRetry(state, item.key, '共有コードを作れません（' + bad.reason + '）'); return { result: 'retry', reason: 'sharecode' }; }
    log('  [stub-images] 画像 ' + stub.length + '枚ぶんの共有コードのみ生成しました: '
      + stub.map((s) => s.label + '=' + s.code.length + '字' + (s.truncated ? '/名切詰' : '')).join(' , '));
    const built0 = buildPostText(ev, dist, pageUrl, prefLabelOf(ctx.data, ev));
    log('  加重文字数 ' + built0.weighted + ' / ' + CONFIG.MAX_WEIGHTED_LENGTH
      + (built0.degrade.length ? '（縮退: ' + built0.degrade.join(' → ') + '）' : ''));
    for (const line of built0.text.split('\n')) console.log('    | ' + line);
    const gate0 = intervalGate(state, getNow());
    if (!gate0.ok) {
      log('  投稿間隔ゲート: 前回投稿から ' + gate0.elapsedMin + '分（' + CONFIG.MIN_POST_INTERVAL_MIN + '分未満）のため投稿しません（attempts は加算しません）');
      return { result: 'hold', reason: 'interval' };
    }
    const w0 = windowState(getNow());
    if (w0 !== 'ok') { log('  投稿直前の時刻再評価で窓外（' + w0 + '）。中断します'); return { result: 'abort', reason: 'window-' + w0 }; }
    log('  [dry-run/stub] ここで X へ投稿します（画像 ' + stub.length + '枚）');
    return { result: 'dry-post', files: stub, text: built0.text };
  }
  const opened = await openBrowser();
  if (!opened.ok) {
    bumpRetry(state, item.key, '画像生成のブラウザを開けません: ' + opened.reason);
    return { result: 'retry', reason: 'browser' };
  }
  const files = [];
  let genFail = null;
  try {
    for (let i = 0; i < top.forImages.length; i++) {
      const r = top.forImages[i];
      const nm = buildDeckName(r.label, String(ev.store || ''));
      const counts = deckToCounts(r.deck);
      const enc = deckCore.encodeShareCode(counts, byId);
      if (!enc.ok) { genFail = '共有コードを作れません（' + enc.reason + '）: rank=' + r.rank; break; }
      const out = path.join(OUT_DIR, item.key + '-' + (i + 1) + '-' + r.label + '.png');
      const g = await generateShareImage(opened.browser, r.deck, nm.name, enc.code, out);
      const v = verifyImage(g);
      if (!v.ok) { genFail = '画像 ' + (i + 1) + '/' + top.forImages.length + ' の検証に失敗: ' + v.reason; break; }
      const d = await degradeIfHuge(g.file);
      if (d.bytes > CONFIG.X_MAX_BYTES) { genFail = '画像が X の上限 5MB を超えています: ' + d.bytes + 'B'; break; }
      files.push({ file: d.file, bytes: d.bytes, label: r.label, name: nm.name, truncated: nm.truncated, shareUrl: g.info && g.info.shareUrl, pageUrl: g.url, info: g.info });
      log('  画像 ' + (i + 1) + '/' + top.forImages.length + ' 生成: ' + path.basename(d.file)
        + ' ' + d.bytes + 'B ' + (g.info ? '(' + g.info.mime + ')' : '')
        + ' 種数' + (g.verify ? g.verify.cells : '?') + '/枚数' + (g.verify ? g.verify.total : '?')
        + (nm.truncated ? ' ※デッキ名を切り詰め' : ''));
    }
  } finally {
    await closeBrowser(opened.browser);
  }
  if (genFail) {
    bumpRetry(state, item.key, genFail);
    return { result: 'retry', reason: 'image' };
  }

  // --- e. 投稿文 ---
  const built = buildPostText(ev, dist, pageUrl, prefLabelOf(ctx.data, ev));
  log('  加重文字数 ' + built.weighted + ' / ' + CONFIG.MAX_WEIGHTED_LENGTH
    + (built.degrade.length ? '（縮退: ' + built.degrade.join(' → ') + '）' : ''));
  for (const line of built.text.split('\n')) console.log('    | ' + line);
  if (built.over) logErr('  縮退下限でも加重280を超過しています');

  // --- d. 投稿間隔ゲート（投稿直前） ---
  const gate = intervalGate(state, getNow());
  if (!gate.ok) {
    log('  投稿間隔ゲート: 前回投稿から ' + gate.elapsedMin + '分（' + CONFIG.MIN_POST_INTERVAL_MIN + '分未満）のため投稿しません（attempts は加算しません）');
    return { result: 'hold', reason: 'interval' };
  }
  // --- 時刻の再評価（投稿直前） ---
  const w = windowState(getNow());
  if (w !== 'ok') { log('  投稿直前の時刻再評価で窓外（' + w + '）。中断します'); return { result: 'abort', reason: 'window-' + w }; }

  if (DRY_RUN) {
    log('  [dry-run] ここで X へ投稿します（画像 ' + files.length + '枚）。実際には投稿・メディアup・state書込のいずれも行いません');
    return { result: 'dry-post', files, text: built.text };
  }

  // --- f. 投稿 ---
  // 資格情報が無い環境（検証用のコピー等）では、X へ 1 リクエストも出さずに止める。
  // 「本番のつもりで無資格のまま叩く」事故と、テスト環境からの実アクセスの両方を防ぐ。
  if (!X_API_KEY || !X_API_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_TOKEN_SECRET) {
    logErr('  X の資格情報が揃っていません（.env を確認してください）。投稿せずに終了します（state も書きません）');
    return { result: 'abort', reason: 'no-credentials' };
  }
  const nowIso = jstIso(getNow());

  // 【二次確認M6】メディアの up は attempting を記録する「前」に行う。
  // ここはまだ投稿していないので at-most-once を壊さない。1枚も上がらなかった場合に
  // 本文だけ投稿して posted にしてしまう（＝画像付きで出し直せない）のを防ぐ。
  const mediaIds = [];
  const mediaStatus = [];
  for (const f of files) {
    const r = await uploadMediaToX(f.file);
    mediaStatus.push(r.status);
    if (r && r.id) mediaIds.push(r.id);
    await sleep(CONFIG.MEDIA_INTERVAL_MS);
  }
  if (files.length && !mediaIds.length) {
    // 【二次確認N2/O2】一時障害（5xx・429・通信断）で attempts を積むと数十分の障害で gave_up＝永久未投稿になる。
    // 逆に 4xx（画像そのものが受け付けられない＝こちら側の問題）は attempts を積まないと永久に居座る。
    // ステータスで振り分ける: 4xx かつ 429 以外が1つでもあれば「こちら側の問題」とみなす。
    // 【二次確認P1】401/403 は「この画像の問題」ではなく資格情報・アカウント側の問題。
    // retry にすると全イベントが順に gave_up＝永久未投稿になるので、hold にして目立つマーカーを出す。
    const authNg = mediaStatus.some((s) => s === 401 || s === 403);
    const ourFault = !authNg
      && (mediaStatus.some((s) => typeof s === 'number' && s >= 400 && s < 500 && s !== 429)
        || mediaStatus.every((s) => s === 'NOFILE'));
    cleanupImages(files);
    if (authNg) {
      logMark('X のメディアアップロードが ' + mediaStatus.join(',') + ' を返しました。'
        + '資格情報の失効・権限・アカウント制限が疑われます。投稿を止めて待機します（.env と X アカウントを確認してください）');
      return { result: 'hold', reason: 'media-auth' };
    }
    if (ourFault) {
      bumpRetry(state, item.key, '画像がアップロードできませんでした（' + mediaStatus.join(',') + '）。本文だけの投稿はしません');
      logMark('画像のアップロードが ' + mediaStatus.join(',') + ' で拒否されました（' + item.key + '）');
      return { result: 'retry', reason: 'media-4xx' };
    }
    logErr('  画像 ' + files.length + '枚のアップロードが一時的に失敗しました（' + mediaStatus.join(',')
      + '）。本文だけの投稿はせず延期します（attempts は加算しません）');
    return { result: 'hold', reason: 'media-transient' };
  }
  if (mediaIds.length !== files.length) {
    logErr('  画像 ' + files.length + '枚のうち ' + mediaIds.length + '枚しか up できませんでした（上がった分で投稿します）');
  }

  state.entries[item.key] = Object.assign({}, state.entries[item.key], {
    status: 'attempting',
    attempts: (state.entries[item.key] && state.entries[item.key].attempts) || 0,
    last_attempt: nowIso,
    store: ev.store, date: ev.date, weighted: built.weighted, media: mediaIds.length
  });
  writeStateAtomic(state);
  log('  status=attempting を記録しました');

  let tweetId = null, lastErr = null;
  for (let attempt = 0; attempt <= CONFIG.POST_RETRY; attempt++) {
    try { tweetId = await postTweet(built.text, mediaIds); lastErr = null; break; }
    catch (e) {
      lastErr = e;
      log('  投稿失敗（試行 ' + (attempt + 1) + '/' + (CONFIG.POST_RETRY + 1) + '）: ' + e.message);
      if (attempt < CONFIG.POST_RETRY) await sleep(3000);
    }
  }
  if (lastErr) {
    // attempting のまま残す = at-most-once（再投稿しない）。§2-C
    state.entries[item.key].error = String(lastErr.message).slice(0, 300);
    writeStateAtomic(state);
    logErr('  投稿を諦めました（status=attempting のまま = 再投稿しません）: ' + lastErr.message);
    cleanupImages(files);
    return { result: 'failed', reason: 'post' };
  }
  state.entries[item.key].status = 'posted';
  state.entries[item.key].tweet_id = tweetId;
  state.entries[item.key].posted_at = nowIso;
  state.last_posted_at = nowIso;
  writeStateAtomic(state);
  log('  投稿成功: https://x.com/gcg_stats/status/' + tweetId);
  cleanupImages(files);
  return { result: 'posted', tweetId, files };
}

/** 【二次確認M3】投稿・失敗が確定した画像は残さない（1件あたり約15MB・週末18件で日 250MB 超になるため） */
function cleanupImages(files) {
  if (DRY_RUN) return;                                   // 検証時は残す（目視・照合のため）
  for (const f of (files || [])) {
    try { if (f.file && fs.existsSync(f.file)) fs.unlinkSync(f.file); } catch (e) { /* 無視 */ }
  }
}
/** 取りこぼした画像を日数で掃除する（tick の最後に呼ぶ） */
function sweepImages() {
  if (DRY_RUN) return;
  // 【二次確認N9】--out-dir で外を指されたときに、そこにある無関係なファイルまで消さない
  if (OUT_DIR !== path.join(TMP_DIR, 'ntc-flash-images')) return;
  const limit = Date.now() - CONFIG.IMAGE_KEEP_DAYS * 86400000;
  let n = 0;
  try {
    for (const f of fs.readdirSync(OUT_DIR)) {
      const p = path.join(OUT_DIR, f);
      try { if (fs.statSync(p).mtimeMs < limit) { fs.unlinkSync(p); n++; } } catch (e) { /* 無視 */ }
    }
  } catch (e) { return; }                                 // ディレクトリが無ければ何もしない
  if (n) log('古い生成画像 ' + n + ' 件を削除しました（' + CONFIG.IMAGE_KEEP_DAYS + '日より前）');
}

function bumpRetry(state, key, why) {
  const cur = state.entries[key] || { attempts: 0 };
  // 【二次確認N1】attempting / posted を retry へ巻き戻さない。
  // 巻き戻すと「投稿した（かもしれない）のに次 tick でもう一度投稿する」＝ at-most-once が壊れる。
  // 例外が attempting 記録の後に出た場合（writeStateAtomic の失敗など）にここへ来る。
  if (cur.status === 'attempting' || cur.status === 'posted') {
    logErr('  ' + key + ' は status=' + cur.status + ' のため retry へ戻しません（再投稿しない）: ' + String(why).slice(0, 200));
    return;
  }
  const attempts = (cur.attempts || 0) + 1;
  const gaveUp = attempts >= CONFIG.MAX_ATTEMPTS;
  const next = Object.assign({}, cur, {
    status: gaveUp ? 'gave_up' : 'retry',
    attempts,
    last_attempt: jstIso(getNow()),
    reason: String(why).slice(0, 300)
  });
  if (DRY_RUN) { log('  [dry-run] ' + key + ' → ' + next.status + '（attempts=' + attempts + '）: ' + why); return; }
  state.entries[key] = next;
  writeStateAtomic(state);
  log('  ' + key + ' → ' + next.status + '（attempts=' + attempts + '/' + CONFIG.MAX_ATTEMPTS + '）: ' + why);
  if (gaveUp) logErr('  ' + key + ' は ' + CONFIG.MAX_ATTEMPTS + ' 回失敗したため諦めました（サイト掲載は通常フローが担保します）');
}

function intervalGate(state, now) {
  if (!state.last_posted_at) return { ok: true, elapsedMin: null };
  const t = parseJstNaive(state.last_posted_at);
  if (!t) return { ok: true, elapsedMin: null };
  const elapsedMin = Math.floor((now.getTime() - t.getTime()) / 60000);
  return { ok: elapsedMin >= CONFIG.MIN_POST_INTERVAL_MIN, elapsedMin };
}

// ===================================================================
// 18-b. 多重起動ガードと他タスク排他（bat から --preflight / --release で呼ぶ）
//   終了コード: 0=進んでよい / 10=run-ntc-collect 実行中 / 11=別の tick が実行中 / 12=内部エラー
//   ここを bat の中で日付計算せずに済ませるため、時効判定は node 側に置く
//   （%TIME% の書式はロケール依存で、bat だけでの時効判定は環境差に弱いため）
// ===================================================================
const FLASH_LOCK = path.join(TMP_DIR, 'ntc-flash.lock');
const COLLECT_LOCK = path.join(TMP_DIR, 'ntc-collect.lock');
const FLASH_LOCK_STALE_MS = 2 * 3600 * 1000;      // 2時間超の古い lock は無効化（§2-A-3）
const COLLECT_LOCK_STALE_MS = 3 * 3600 * 1000;    // collect 側の時効と同じ（collect-ntc-daily.js LOCK_STALE_MS）

function ageMsOf(file) {
  try { return Date.now() - fs.statSync(file).mtimeMs; } catch (e) { return null; }
}
function preflight() {
  // 0) 稼働窓（§2-A-2）
  // 【二次確認M7】bat 側で %TIME% を数値化して比較していたが、%TIME% の書式はロケール依存で、
  // 12時間表記の環境では午後の tick を取りこぼす。時刻の判定は windowState() 1か所に集約する。
  const w = windowState(getNow());
  if (w === 'closed') {
    log('稼働窓の外です（' + jstHHMM(getNow()) + ' / ' + CONFIG.WINDOW_START + '〜' + CONFIG.WINDOW_END + ' のみ稼働）。何もしません');
    return 13;
  }
  if (w === 'skip') {
    log('スキップ窓です（' + jstHHMM(getNow()) + ' / ' + CONFIG.SKIP_START + '〜' + CONFIG.SKIP_END + ' は無条件スキップ）。何もしません');
    return 14;
  }

  // 1) run-ntc-collect が動いていたら即終了（次 tick へ）
  const cAge = ageMsOf(COLLECT_LOCK);
  if (cAge !== null) {
    if (cAge <= COLLECT_LOCK_STALE_MS) {
      log('run-ntc-collect が実行中です（lock ' + Math.round(cAge / 60000) + '分前）。この tick は何もしません');
      return 10;
    }
    log('run-ntc-collect の lock が時効（' + Math.round(cAge / 60000) + '分前 > ' + (COLLECT_LOCK_STALE_MS / 60000) + '分）のため実行中とはみなしません'
      + '（lock の掃除は collect 側の責務。02:00 / 08:00 の collect が引き取ります）');
    }

  // 2) 自分の lock（多重起動ガード）
  const fAge = ageMsOf(FLASH_LOCK);
  if (fAge !== null && fAge <= FLASH_LOCK_STALE_MS) {
    let started = '';
    try { started = String(fs.readFileSync(FLASH_LOCK, 'utf-8')).trim().slice(0, 40); } catch (e) { /* 無視 */ }
    log('別の tick が実行中です（lock ' + Math.round(fAge / 60000) + '分前 ' + started + '）。この tick は何もしません');
    return 11;
  }
  if (fAge !== null) log('置き忘れの lock を引き取ります（' + Math.round(fAge / 60000) + '分前 > ' + (FLASH_LOCK_STALE_MS / 60000) + '分）');
  try {
    fs.mkdirSync(TMP_DIR, { recursive: true });
    fs.writeFileSync(FLASH_LOCK, jstIso(getNow()) + '\n', 'utf-8');
  } catch (e) { logErr('lock を作れませんでした: ' + e.message); return 12; }
  log('preflight OK（lock を取得しました）');
  return 0;
}
function releaseLock() {
  try { if (fs.existsSync(FLASH_LOCK)) fs.unlinkSync(FLASH_LOCK); log('lock を解放しました'); }
  catch (e) { logErr('lock を解放できませんでした: ' + e.message); }
  return 0;
}

// ===================================================================
// 19. main
// ===================================================================
async function main() {
  const t0 = Date.now();
  const now0 = getNow();
  log('=== tick 開始 ' + jstStamp(now0) + ' JST'
    + (DRY_RUN ? ' [dry-run]' : '') + (FIXTURE_DIR ? ' [fixture]' : '') + (FIXED_NOW ? ' [--now]' : '')
    + (SEED_STATE ? ' [seed-state]' : '') + ' root=' + ROOT + ' ===');

  // --- 稼働窓（1点目） ---
  const w0 = windowState(now0);
  if (w0 !== 'ok') {
    log('稼働窓の外です（' + jstHHMM(now0) + ' / ' + (w0 === 'skip' ? CONFIG.SKIP_START + '〜' + CONFIG.SKIP_END + ' は無条件スキップ' : CONFIG.WINDOW_START + '〜' + CONFIG.WINDOW_END + ' のみ稼働') + '）。何もしません');
    return;
  }

  // --- state ---
  const sr = readState();
  if (!sr.ok) {
    logErr('state を読めません（' + sr.reason + ': ' + sr.message + '）');
    if (DRY_RUN) { log('[dry-run] 退避は行いません'); return; }
    quarantineCorruptState();
    log('この tick は投稿しません（次回から通常運用へ戻ります）');
    return;
  }
  const state = sr.state;
  if (sr.isNew) log('state は新規です: ' + STATE_FILE);
  sweepImages();   // 取りこぼした生成画像の掃除は、どの経路で tick が終わっても必ず1回通るここで行う

  // --- データ ---
  const data = loadData();
  if (!data.eventsOk) { logErr('events.json を読めません。中断します'); return; }
  if (!Object.keys(data.events).length) log('events.json にイベントがありません（0件）。due の算出は続けます');
  const today = jstDateStr(now0);
  const activeNum = activeNtcSeriesIds(data.seriesMap, today);
  const officialSeries = activeOfficialSeries(data.dashboard, today);
  log('対象NTCシリーズ: series.json=' + (activeNum.join(',') || 'なし') + ' / 公式一覧=' + (officialSeries.join(',') || 'なし'));
  if (!activeNum.length) { log('期間内のNTCシリーズがありません。何もしません'); return; }

  const getColor = makeGetColor(data.cardColors, data.cardsMaster);
  const dc = loadDeckCore();
  if (!dc.mod || typeof dc.mod.encodeShareCode !== 'function') {
    logErr('js/deckbuilder-core.js を読み込めません: ' + (dc.tried || []).join(' / '));
    return;
  }
  const byId = buildShareDb(data.cardsMaster, data.cardsPreview);
  const ctx = { state, data, getColor, deckCore: dc.mod, byId };

  // --- due ---
  let due = computeDue(data, state, getNow());
  // §2-B-6 のログ項目: due=N（内訳）・掲載=M・未取込・期限切れ
  log('due=' + due.queue.length + '（時刻due ' + due.counts.time + ' / フォールバックdue ' + due.counts.fallback + '）'
    + ' 掲載=' + due.published + '(対象シリーズの掲載総数)'
    + ' 未取込due=' + due.pendingSched.length + ' 期限切れ=' + due.expired.length);
  if (due.ambiguous && due.ambiguous.length) {
    log('同一店舗・同日に複数の予定があります（開始時刻の昇順とULID昇順で1対1に割当）: ' + due.ambiguous.slice(0, 5).join(' , '));
  }

  // --- 期限切れ（TTL / 年齢上限）を記録 ---
  if (due.expired.length) {
    for (const x of due.expired) {
      if (DRY_RUN) { log('  [dry-run] ' + x.key + ' → no_result（' + x.reason + '）: ' + x.detail); continue; }
      state.entries[x.key] = Object.assign({}, state.entries[x.key], {
        status: 'no_result', reason: x.reason, detail: x.detail, last_attempt: jstIso(getNow())
      });
    }
    if (!DRY_RUN) writeStateAtomic(state);
    log('  期限切れ ' + due.expired.length + ' 件を no_result にしました（内訳: TTL ' + due.expired.filter((x) => x.reason === 'ttl').length
      + ' / 年齢上限 ' + due.expired.filter((x) => x.reason === 'too-old').length + '）');
  }

  // --- --seed-state: 現在の due を投稿せず対象外として記録して終了 ---
  if (SEED_STATE) {
    log('【seed-state】現在 due のイベントを「速報対象外」として記録します（投稿はしません）');
    let n = 0;
    for (const q of due.queue) {
      if (DRY_RUN) { log('  [dry-run] seed: ' + q.key + ' ' + q.event.date + ' ' + q.event.store); n++; continue; }
      state.entries[q.key] = { status: 'no_result', reason: 'seeded', detail: '登録時シード（既に掲載済みのため速報しない）', store: q.event.store, date: q.event.date, last_attempt: jstIso(getNow()) };
      n++;
    }
    for (const p of due.pendingSched) {
      if (DRY_RUN) { log('  [dry-run] seed: ' + p.key + ' ' + p.date); n++; continue; }
      state.entries[p.key] = { status: 'no_result', reason: 'seeded', detail: '登録時シード（未取込の過去分）', date: p.date, last_attempt: jstIso(getNow()) };
      n++;
    }
    if (!DRY_RUN) writeStateAtomic(state);
    log('【seed-state】' + n + ' 件を記録しました。以降は「これより後に掲載を検知した分」だけを速報します');
    return;
  }

  // --- 掲載判定（節度アクセス）: 未取込 due があり、かつ毎時 :00 tick のときだけ ---
  const minute = jstMinuteOfHour(getNow());
  const isTopTick = minute < 15;
  if (due.pendingSched.length && (isTopTick || FORCE_LIST)) {
    log('未取込 due が ' + due.pendingSched.length + ' 件あるため公式一覧を確認します（分=' + minute + (FORCE_LIST ? ' / --force-list' : '') + '）');
    const known = new Set(Object.keys(data.events).filter((k) => /^ntcd-/.test(k)).map((k) => k.slice('ntcd-'.length)));
    let newIds = [];
    let listOk = true;
    // 【二次確認M4】見に行く先が1つも無いのに「新規なし」と結論づけると、
    // ntc_dashboard.json の登録漏れ（新シリーズを --add し忘れた等）に永久に気づけない。
    if (!officialSeries.length) {
      logMark('公式一覧の対象シリーズが ntc_dashboard.json にありません。未取込 due ' + due.pendingSched.length
        + ' 件を確認できません（collect-ntc-daily.js --add でシリーズを登録してください）');
      listOk = false;
    }
    for (const sid of officialSeries) {
      let r;
      if (FIXTURE_DIR) { r = readOfficialListFixture(sid); }
      else {
        const o = await openBrowser();
        if (!o.ok) { logErr('  一覧アクセスのブラウザを開けません: ' + o.reason); listOk = false; break; }
        try { r = await readOfficialList(o.browser, seriesUrl(sid)); } finally { await closeBrowser(o.browser); }
      }
      if (!r.ok) { logErr('  一覧を読めませんでした（' + sid + '）: ' + r.reason); listOk = false; continue; }
      const ids = (r.rows || []).map((x) => x.shop_id).filter((x) => x && ULID_RE.test(x));
      const fresh = ids.filter((x) => !known.has(x));
      log('  一覧 ' + ids.length + '件（' + (r.fixture ? 'fixture' : '実アクセス') + '）／ローカル未取込 ' + fresh.length + '件'
        + (r.hitLimit ? ' ※最後まで読み切れていない可能性' : ''));
      newIds = newIds.concat(fresh);
    }
    if (newIds.length) {
      // --- 時刻の再評価（2点目: チェーン実行直前） ---
      const w1 = windowState(getNow());
      if (w1 !== 'ok') { log('チェーン実行直前の時刻再評価で窓外（' + w1 + '）。中断します'); return; }
      // 猶予期間（シリーズ終了後）に入っているシリーズは collect 側が自力で選べないので明示指定する
      const graceOnly = activeOfficialSeries(data.dashboard, today, CONFIG.SERIES_GRACE_DAYS)
        .filter((sid) => activeOfficialSeries(data.dashboard, today, 0).indexOf(sid) < 0);
      if (graceOnly.length) log('猶予期間中のシリーズを collect へ明示指定します: ' + graceOnly.join(','));
      const chain = runChain(graceOnly);
      if (!chain.ok) { log('=== tick 終了（チェーン失敗のため見送り） ==='); return; }
      if (chain.aborted) { log('=== tick 終了（' + chain.aborted + ' により中断） ==='); return; }
      if (chain.ran && chain.regenerated !== false) {
        const re = loadData();
        if (re.eventsOk) { data.events = re.events; ctx.data = data; }
        due = computeDue(data, state, getNow());
        log('チェーン後に再計算: due=' + due.queue.length + '（時刻due ' + due.counts.time + ' / フォールバックdue ' + due.counts.fallback + '）');
      }
    } else if (listOk) {
      log('  公式一覧に新規の掲載はありません');
    }
  } else if (due.pendingSched.length) {
    log('未取込 due が ' + due.pendingSched.length + ' 件ありますが、毎時 :00 tick ではないため公式一覧へはアクセスしません（分=' + minute + '）');
  } else {
    log('未取込 due はありません（公式一覧へのアクセスなし）');
  }

  // --- 投稿キュー ---
  if (!due.queue.length) { log('投稿対象はありません'); log('=== tick 終了 ==='); return; }
  const g0 = intervalGate(state, getNow());
  if (!g0.ok) {
    log('前回投稿から ' + g0.elapsedMin + '分（' + CONFIG.MIN_POST_INTERVAL_MIN + '分未満）のため、この tick は投稿しません（待ち ' + due.queue.length + '件）');
    log('=== tick 終了 ===');
    return;
  }
  log('投稿キュー ' + due.queue.length + '件（新しい順）: '
    + due.queue.slice(0, 5).map((q) => q.key.slice(0, 16) + '…/' + q.event.date + '/' + q.event.store).join(' , ')
    + (due.queue.length > 5 ? ' …' : ''));

  if (PLAN_ONLY) {
    log('--plan-only: 実処理は行いません。キュー全件は次のとおり');
    due.queue.forEach((q, i) => {
      const top = extractTop(q.event);
      console.log('    ' + String(i + 1).padStart(3, ' ') + '. ' + q.key + ' ' + q.event.date + ' ' + q.event.store
        + ' [' + (q.source === 'time' ? '時刻due ' + jstIso(q.startAt) : 'フォールバック 検知' + (q.detectedAt ? jstIso(q.detectedAt) : '不明')) + ']'
        + ' 入賞' + top.all.length + '件(' + top.all.map((r) => r.label).join('/') + ') 画像' + top.forImages.length + '枚'
        + ' 分布=' + buildColorDistribution(top.all, getColor));
    });
    log('=== tick 終了（plan-only） ===');
    return;
  }

  let posted = 0, skipped = 0;
  for (const item of due.queue) {
    if (Date.now() - t0 > CONFIG.TICK_BUDGET_MS) {
      log('tick の時間上限（' + Math.round(CONFIG.TICK_BUDGET_MS / 60000) + '分）に達しました。残りは次の tick へ回します');
      break;
    }
    const wN = windowState(getNow());
    if (wN !== 'ok') { log('時刻再評価で窓外（' + wN + '）。中断します'); break; }
    let r;
    try { r = await processOne(item, ctx); }
    catch (e) {
      // 【二次確認M5】例外も attempts に数える。数えないと、同じイベントで毎 tick 例外が出続けても
      // gave_up にならず、キューの先頭に居座って後続を止めてしまう。
      logErr('処理中に例外: ' + (e && e.stack || e));
      try { bumpRetry(state, item.key, '処理中に例外: ' + String(e && e.message || e).slice(0, 200)); }
      catch (e2) { logErr('例外時の state 記録に失敗: ' + e2.message); }
      r = { result: 'error' };
    }
    if (r.result === 'posted' || r.result === 'dry-post') { posted++; break; }   // 15分ゲートがあるため1 tick 1投稿
    if (r.result === 'hold' || r.result === 'abort') break;
    skipped++;
  }
  log('結果: 投稿 ' + posted + ' 件 / 見送り ' + skipped + ' 件 / 残り ' + Math.max(0, due.queue.length - posted - skipped) + ' 件');
  log('=== tick 終了（所要 ' + Math.round((Date.now() - t0) / 1000) + '秒） ===');
}

// --- 入口 ---
// require された場合は実行せず、純粋関数だけを公開する（二次確認・単体テスト用）
if (require.main !== module) {
  module.exports = {
    CONFIG, RANK_LABEL, COLOR_SORT_ORDER, DECK_COLORS_JP,
    weightedLength, buildPostText, POST_HEADER, PREF_FULL_BY_CODE, prefLabelOfCode, prefLabelOf,
    buildColorDistribution, deckTypeColorsOf, makeGetColor,
    extractTop, buildDeckName, safeSlice, mdOf, windowState, computeDue,
    parseJstNaive, jstIso, jstDateStr, jstHHMM, jstEndOfDay,
    buildShareDb, deckToCounts, loadDeckCore, activeNtcSeriesIds, activeOfficialSeries, intervalGate,
    bumpRetry, addDaysStr, verifyImage
  };
}
// --preflight / --release は終了コードで bat に返す（本体は常に 0）
else if (argFlag('preflight')) {
  let rc = 12;
  try { rc = preflight(); } catch (e) { logErr('preflight で例外: ' + (e && e.message)); rc = 12; }
  process.exit(rc);
} else if (argFlag('release')) {
  try { releaseLock(); } catch (e) { /* 無視 */ }
  process.exit(0);
} else {
  main()
    .catch((e) => { try { logErr('未処理の例外: ' + (e && e.stack || e)); } catch (_) { console.error(e); } })
    .then(() => { process.exitCode = 0; });
}
