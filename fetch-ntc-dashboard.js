#!/usr/bin/env node
/**
 * fetch-ntc-dashboard.js — NTC公式集計(BANDAI TCG+ デッキログ)の取得・蓄積
 * 指示書63 Step 1-N §2。Step 0/0b の実測に基づく。
 *
 * 取得対象:
 *   一覧   : https://d.bandai-tcg-plus.com/gcgja/tournament
 *            → sanctionedTournamentList のうち title に「ニュータイプチャレンジ」を含むもの
 *   シリーズ: https://d.bandai-tcg-plus.com/gcgja/tournament/sanctioned/<ULID>
 *
 * 方針(Step 0b 裁定):
 *   - RSCヘッダ取得(約37KB)。HTML(約14MB)は取らない
 *   - 集計値(usages/winCounts)は累積値なので1日1回で常に完全
 *   - 店舗行は最新20件窓のベストエフォート。複合キーで累積マージし既存キーは不変
 *   - ページングは存在しない(再探索禁止)。JSチャンク解析は禁止
 *   - 一覧から消えても既知IDの直接取得を継続。404になったら fetch_stopped=true でスキップ
 *   - **対象は手動オプトイン**(松岡さん指示 2026-08-03)。一覧で新しいシリーズを見つけても自動では
 *     取り込まず、ログで通知するだけ。取り込むときは --add <ULID> を1回実行する
 *     (例: 9月シリーズは結果が出るまで取得しない)
 *
 * 使い方:
 *   node fetch-ntc-dashboard.js
 *   node fetch-ntc-dashboard.js --dry-run          # 取得・解析のみ。書き込み0件
 *   node fetch-ntc-dashboard.js --once <ULID>      # 登録済みシリーズを1件だけ取得(一覧取得もスキップ)
 *   node fetch-ntc-dashboard.js --add  <ULID>      # 新しいシリーズを対象に追加して取得(手動オプトイン)
 *   NTC_DASHBOARD_ROOT=/path/to/site node fetch-ntc-dashboard.js   # 隔離検証用
 *
 * 終了コードは常に 0(指示書63 §2 / post-x-daily.js と同じ方式)。異常はログで判別する。
 */
'use strict';

const https = require('https');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.NTC_DASHBOARD_ROOT || __dirname;
const DATA_PATH = path.join(ROOT, 'data', 'ntc_dashboard.json');

const BASE = 'https://d.bandai-tcg-plus.com/gcgja';
const LIST_URL = BASE + '/tournament';
const seriesUrl = (id) => BASE + '/tournament/sanctioned/' + id;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const TIMEOUT_MS = 30000;
const RETRY_WAIT_MS = 30000;   // リトライは1回のみ・30秒後
const REQUEST_GAP_MS = 2000;   // 同時1接続・リクエスト間隔
const SERIES_TITLE_PATTERN = /ニュータイプチャレンジ/;
const SHOP_WINDOW_HINT = 20;   // 先方が返す店舗行の窓サイズ(Step 0b 実測)。取りこぼし検知の閾値
const MAX_DENOMINATOR = 200000; // usageRate 分母の探索上限。
                               // 実測: 2026-08-02 時点(開催2日)で既に N=1294。1シリーズは月239イベント×平均37デッキ
                               // ≒ 1万弱まで伸びるため、4000では月内に必ず不足して denominator_n=null に劣化する。
                               // 探索は O(N×行数)=180万回程度で数十msのため余裕を持って20万に取る。
const RATE_EPS = 1e-9;         // 分母逆算の整数判定。
                               // 先方の率は倍精度の有効桁ほぼ全部(相対誤差~1e-16)で来るため、真のNでは
                               // N=20万でも誤差は~2e-11に収まる。1e-6だと探索上限を上げたときに
                               // 偶然整数に見えるNを拾う確率が無視できなくなるため1e-9に絞る。
const SUM_EPS = 0.5;           // usageRate 合計の 100% 判定(ポイント)。
                               // 実測は誤差1e-13だが、先方が丸め表記に変わった場合の誤検知を避けるため0.5に取る。
                               // 行の欠落・重複(最小行でも5.28pt)は確実に検出できる幅。分子合計=N の検査が主防御。

const LOG = (...a) => console.log('[ntc-dashboard]', ...a);
const ERR = (...a) => console.error('[ntc-dashboard]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ 日付 */

/** UTC+9固定でJSTの YYYY-MM-DD を返す(OSローカルTZに依存しない) */
function jstDate(ms) {
  return new Date((ms === undefined ? Date.now() : ms) + 9 * 3600 * 1000)
    .toISOString().slice(0, 10);
}
/** UTC+9固定のISO風タイムスタンプ(記録用) */
function jstStamp(ms) {
  return new Date((ms === undefined ? Date.now() : ms) + 9 * 3600 * 1000)
    .toISOString().replace('Z', '+09:00');
}
/** 先方の "2026/8/2" → "2026-08-02"。解釈できない場合は null */
function normalizeDate(s) {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(String(s || '').trim());
  if (!m) return null;
  return m[1] + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[3]).padStart(2, '0');
}

/* -------------------------------------------------------------- HTTP取得 */

function httpGetOnce(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: { 'User-Agent': UA, 'RSC': '1', 'Accept': 'text/x-component' }
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('timeout after ' + TIMEOUT_MS + 'ms')));
    req.on('error', reject);
  });
}

let lastRequestAt = 0;
/** 同時1接続・間隔2秒・リトライ1回(30秒後)。404はリトライしない */
async function httpGet(url) {
  const gap = REQUEST_GAP_MS - (Date.now() - lastRequestAt);
  if (gap > 0) await sleep(gap);
  let r;
  try {
    r = await httpGetOnce(url);
  } catch (e) {
    ERR('  取得失敗(' + e.message + ')。30秒後に1回だけ再試行します: ' + url);
    await sleep(RETRY_WAIT_MS);
    r = await httpGetOnce(url);
  }
  lastRequestAt = Date.now();
  if (r.status === 404) return r;
  if (r.status !== 200) {
    ERR('  HTTP ' + r.status + '。30秒後に1回だけ再試行します: ' + url);
    await sleep(RETRY_WAIT_MS);
    r = await httpGetOnce(url);
    lastRequestAt = Date.now();
  }
  return r;
}

/* ---------------------------------------------------------------- パース */

/**
 * RSCペイロードはそのまま、HTMLで返ってきた場合は self.__next_f チャンクを連結して
 * データ本文を取り出す(RSCが主経路。HTMLはフォールバック時の保険)。
 */
function extractPayloadText(body) {
  if (typeof body !== 'string') return '';
  if (body.indexOf('self.__next_f.push') === -1) return body;
  let joined = '';
  for (const m of body.matchAll(/self\.__next_f\.push\(\[(\d+),"((?:[^"\\]|\\.)*)"\]\)/g)) {
    try { joined += JSON.parse('"' + m[2] + '"'); } catch (e) { /* 壊れたチャンクは無視 */ }
  }
  return joined || body;
}

/** s[start] の '{' または '[' から対応する閉じ括弧までを切り出す(文字列リテラル考慮) */
function sliceJson(s, start) {
  const open = s[start];
  if (open !== '{' && open !== '[') return null;
  const close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) return s.slice(start, i + 1); }
  }
  return null;
}

/** key の直後にある JSON 値(配列/オブジェクト)を1つ取り出す。無ければ null */
function pickJson(s, key, from) {
  const i = s.indexOf('"' + key + '":', from || 0);
  if (i < 0) return null;
  let j = i + key.length + 3;
  while (j < s.length && s[j] !== '{' && s[j] !== '[') {
    if (s[j] === ',' || s[j] === '}' || s[j] === ']') return null;  // 値がオブジェクト/配列でない
    j++;
  }
  const raw = sliceJson(s, j);
  if (raw === null) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

/**
 * Next.js の「存在しないID」応答を判定する。
 * この取得元は存在しないIDでも HTTP 200 を返し、ペイロード末尾に
 *   6:E{"digest":"NEXT_HTTP_ERROR_FALLBACK;404"}
 * を載せる(Step 0b で /tournament/single/<shopId> にて実測)。
 * HTTPステータスだけを見ると「パース不能」として毎晩リトライし続けることになるため、
 * この印を 404 と同じ扱いにする。
 */
function isNotFoundPayload(body) {
  if (typeof body !== 'string') return false;
  if (body.indexOf('NEXT_HTTP_ERROR_FALLBACK;404') < 0) return false;
  // 本体データが載っていれば 404 印があっても通常応答として扱う(保険)
  return body.indexOf('"deckColorUsages"') < 0;
}

/** 一覧ページ → ニュータイプチャレンジのシリーズ配列 */
function parseList(body) {
  const s = extractPayloadText(body);
  const arr = pickJson(s, 'sanctionedTournamentList');
  if (!Array.isArray(arr)) throw new Error('sanctionedTournamentList が見つかりません');
  return arr
    .filter((x) => x && typeof x.tournamentId === 'string' && SERIES_TITLE_PATTERN.test(String(x.title || '')))
    .map((x) => ({
      id: x.tournamentId,
      title: String(x.title),
      start: typeof x.startDate === 'string' ? x.startDate : '',
      end: typeof x.endDate === 'string' ? x.endDate : ''
    }));
}

/** シリーズページ → { dateRange, shops, usages, winCounts } */
function parseSeries(body) {
  const s = extractPayloadText(body);
  const dateRange = pickJson(s, 'dateRange') || {};
  const usages = pickJson(s, 'deckColorUsages');
  const winCounts = pickJson(s, 'deckColorWinCounts');
  if (!Array.isArray(usages)) throw new Error('deckColorUsages が見つかりません');
  if (!Array.isArray(winCounts)) throw new Error('deckColorWinCounts が見つかりません');

  // 店舗行: "shop":{...} を全走査(行ごとに1オブジェクト)
  const shops = [];
  let pos = 0;
  for (;;) {
    const i = s.indexOf('"shop":{', pos);
    if (i < 0) break;
    const raw = sliceJson(s, i + '"shop":'.length);
    pos = i + 8;
    if (raw === null) continue;
    let o;
    try { o = JSON.parse(raw); } catch (e) { continue; }
    if (!o || typeof o.shopId !== 'string') continue;
    shops.push(o);
  }
  return {
    dateRange: {
      start: typeof dateRange.start === 'string' ? dateRange.start : '',
      end: typeof dateRange.end === 'string' ? dateRange.end : ''
    },
    shops, usages, winCounts
  };
}

/* -------------------------------------------------------------- 集計処理 */

/**
 * usageRate の分母を逆算する(Step 0b 手法)。
 * 全行が整数になる最小 N を minN..MAX_DENOMINATOR から探す。見つからなければ null。
 *
 * minN について: 全行の件数が共通因数を持つ日は、真のNの約数(例: 1/2, 1/440)も
 * 「全行が整数」を満たしてしまい、最小Nとして拾うと件数が縮小表示される。
 * 集計は累積なので N は単調非減少 → 前回のNを下限にすると、この縮小を防げる。
 * 前回値が無い場合(初回)は 1 から探す。
 */
function inferDenominator(usages, minN) {
  if (!Array.isArray(usages) || usages.length === 0) return null;
  const start = Math.max(1, Math.floor(minN || 1));
  for (let n = start; n <= MAX_DENOMINATOR; n++) {
    let ok = true;
    for (const u of usages) {
      const v = u.usageRate / 100 * n;
      if (Math.abs(v - Math.round(v)) > RATE_EPS) { ok = false; break; }
    }
    if (ok) return n;
  }
  // 下限つきで見つからない場合(先方が集計をリセットした等)は下限なしで再探索する
  if (start > 1) {
    const again = inferDenominator(usages, 1);
    if (again !== null) ERR('  分母が前回値(' + start + ')を下回りました: N=' + again + '(集計リセットの可能性)');
    return again;
  }
  return null;
}

/** 色配列の正規化(数値のみ・昇順)。不正値は落とす */
function normColors(c) {
  if (!Array.isArray(c)) return [];
  return c.filter((x) => typeof x === 'number' && isFinite(x)).slice().sort((a, b) => a - b);
}

/**
 * サニティ検査つきで集計エントリを組み立てる。
 * 返り値 { ok, reason, entry }
 */
function buildAggregates(parsed, dateStr, prevN) {
  const usagesRaw = parsed.usages;
  const winRaw = parsed.winCounts;

  for (const u of usagesRaw) {
    if (!u || typeof u.usageRate !== 'number' || !isFinite(u.usageRate)) {
      return { ok: false, reason: 'usageRate が数値でない行があります' };
    }
  }
  for (const w of winRaw) {
    if (!w || typeof w.winCount !== 'number' || !isFinite(w.winCount)) {
      return { ok: false, reason: 'winCount が数値でない行があります' };
    }
  }

  let denominator = null;
  if (usagesRaw.length > 0) {
    const sum = usagesRaw.reduce((a, u) => a + u.usageRate, 0);
    if (Math.abs(sum - 100) > SUM_EPS) {
      return { ok: false, reason: 'usageRate の合計が100%になりません(' + sum + ')' };
    }
    denominator = inferDenominator(usagesRaw, prevN);
    if (denominator !== null) {
      const counts = usagesRaw.map((u) => Math.round(u.usageRate / 100 * denominator));
      const total = counts.reduce((a, b) => a + b, 0);
      if (total !== denominator) {
        return { ok: false, reason: '分子合計(' + total + ')が分母N(' + denominator + ')と一致しません' };
      }
    }
  }
  // usages が空(=月初でまだ集計対象なし)は正常系。denominator は null のまま。

  const usages = usagesRaw.map((u) => {
    const row = { colors: normColors(u.colors), rate: u.usageRate };
    if (denominator !== null) row.count = Math.round(u.usageRate / 100 * denominator);
    return row;
  });
  const win_counts = winRaw.map((w) => ({
    colors: normColors(w.colors),
    rank: typeof w.rank === 'number' ? w.rank : null,
    count: w.winCount
  }));

  return { ok: true, entry: { date: dateStr, denominator_n: denominator, usages, win_counts } };
}

/** 店舗行 → { key, value } の配列。日付が読めない行はスキップ(理由を返す) */
function buildShopEntries(shops, stampStr) {
  const out = [], skipped = [];
  for (const s of shops) {
    const d = normalizeDate(s.date);
    if (!d) { skipped.push(String(s.shopId)); continue; }
    const all = Array.isArray(s.winningDeckColors) ? s.winningDeckColors.map(normColors) : [];
    out.push({
      key: d + '__' + s.shopId,
      value: {
        shop_id: s.shopId,
        place: typeof s.place === 'string' ? s.place : '',
        capacity: typeof s.capacity === 'number' ? s.capacity : null,
        date: typeof s.date === 'string' ? s.date : '',
        winning_colors: all.length === 1 ? all[0] : (all[0] || []),
        winning_colors_raw: all,      // 優勝が複数ある場合に備えた無損失保存(実測は全行1件)
        first_seen: stampStr
      }
    });
  }
  return { out, skipped };
}

/* ------------------------------------------------------------ 入出力 */

function loadData() {
  if (!fs.existsSync(DATA_PATH)) {
    return { version: 1, source: LIST_URL, series: {} };
  }
  try {
    const j = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
    if (!j || typeof j !== 'object' || typeof j.series !== 'object' || j.series === null) {
      throw new Error('series がありません');
    }
    if (!j.version) j.version = 1;
    if (!j.source) j.source = LIST_URL;
    return j;
  } catch (e) {
    // 壊れている場合は「読めなかった」ことを明示して中断する(空上書き防止)
    throw new Error('既存 data/ntc_dashboard.json を読めません: ' + e.message);
  }
}

let DRY_RUN = false;

/** 原子書き込み(tmp → rename)。--dry-run のときは関数先頭で拒否する */
function writeData(obj) {
  if (DRY_RUN) {
    LOG('[dry-run] 書き込みを拒否しました(0件): ' + DATA_PATH);
    return false;
  }
  const dir = path.dirname(DATA_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = DATA_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, DATA_PATH);
  return true;
}

/* ---------------------------------------------------------------- マージ */

/**
 * 1シリーズ分をデータへ反映する(純粋関数・テスト対象)。
 * 既存 shops キーは不変。history は同一JST日付を上書き。
 * @returns {{addedShops:number, historyReplaced:boolean}}
 */
function mergeSeries(data, id, meta, aggregateEntry, shopEntries, stampStr) {
  if (!data.series[id]) {
    data.series[id] = {
      title: meta.title || '',
      start: meta.start || '',
      end: meta.end || '',
      first_seen: stampStr,
      last_fetched: stampStr,
      fetch_stopped: false,
      aggregates_latest: null,
      aggregates_history: [],
      shops: {}
    };
  }
  const S = data.series[id];
  if (meta.title) S.title = meta.title;
  if (meta.start) S.start = meta.start;
  if (meta.end) S.end = meta.end;
  S.last_fetched = stampStr;
  S.fetch_stopped = false;
  if (!S.shops || typeof S.shops !== 'object') S.shops = {};
  if (!Array.isArray(S.aggregates_history)) S.aggregates_history = [];

  S.aggregates_latest = aggregateEntry;
  const idx = S.aggregates_history.findIndex((h) => h && h.date === aggregateEntry.date);
  let historyReplaced = false;
  if (idx >= 0) { S.aggregates_history[idx] = aggregateEntry; historyReplaced = true; }
  else S.aggregates_history.push(aggregateEntry);
  S.aggregates_history.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  let addedShops = 0;
  for (const e of shopEntries) {
    if (Object.prototype.hasOwnProperty.call(S.shops, e.key)) continue;  // 既存キーは不変
    S.shops[e.key] = e.value;
    addedShops++;
  }
  return { addedShops, historyReplaced };
}

/* ------------------------------------------------------------------ main */

async function main(argv) {
  const args = argv.slice(2);
  DRY_RUN = args.includes('--dry-run');
  const onceIdx = args.indexOf('--once');
  const onceId = onceIdx >= 0 ? args[onceIdx + 1] : null;
  const addIdx = args.indexOf('--add');
  const addId = addIdx >= 0 ? args[addIdx + 1] : null;

  LOG('start' + (DRY_RUN ? ' [dry-run]' : '') + (onceId ? ' [once ' + onceId + ']' : '') +
    (addId ? ' [add ' + addId + ']' : ''));

  let data;
  try {
    data = loadData();
  } catch (e) {
    ERR('中断: ' + e.message + '(既存ファイルは変更しません)');
    return;
  }

  const stamp = jstStamp();
  const today = jstDate();

  // --- 対象シリーズの決定 ---
  // 既定は「data に登録済みのシリーズだけ」を取得する(手動オプトイン)。
  // 一覧は新シリーズの検出通知のためだけに取得し、自動では対象に加えない。
  const targets = new Map();   // id -> {title,start,end}
  let allowNew = false;
  if (addId) {
    allowNew = true;
    const known = data.series[addId];
    if (known) LOG('--add: 既に登録済みのシリーズです。取得のみ行います: ' + addId);
    else LOG('--add: 新しいシリーズを対象に追加します: ' + addId);
    targets.set(addId, { title: (known && known.title) || '', start: (known && known.start) || '', end: (known && known.end) || '' });
  } else if (onceId) {
    const known = data.series[onceId];
    if (!known) {
      ERR('--once に未登録のシリーズが指定されました: ' + onceId +
        '(取り込むには --add ' + onceId + ' を使ってください)。終了します。');
      return;
    }
    if (known.fetch_stopped) LOG('--once 指定のため fetch_stopped を無視して取得します: ' + onceId);
    targets.set(onceId, { title: known.title || '', start: known.start || '', end: known.end || '' });
  } else {
    // 一覧(新シリーズの検出通知用)
    let listed = null;
    try {
      const r = await httpGet(LIST_URL);
      if (r.status !== 200) throw new Error('HTTP ' + r.status);
      listed = parseList(r.body);
      LOG('一覧: ニュータイプチャレンジ ' + listed.length + '件');
    } catch (e) {
      ERR('一覧の取得/解析に失敗: ' + e.message + '(登録済みIDの取得は継続します)');
    }
    // 登録済みのみ対象。タイトル等は一覧の値で更新する
    const byId = new Map((listed || []).map((x) => [x.id, x]));
    for (const [id, S] of Object.entries(data.series)) {
      if (S && S.fetch_stopped) { LOG('skip(fetch_stopped): ' + id + '(再開は --once ' + id + ')'); continue; }
      const x = byId.get(id);
      targets.set(id, {
        title: (x && x.title) || (S && S.title) || '',
        start: (x && x.start) || (S && S.start) || '',
        end: (x && x.end) || (S && S.end) || ''
      });
      if (!x) LOG('一覧に無いが登録済みのため継続: ' + id);
    }
    // 未登録シリーズは「検出して通知するだけ」(自動では取り込まない)
    for (const x of (listed || [])) {
      if (data.series[x.id]) continue;
      LOG('新しいシリーズを検出(未取得): ' + x.id + ' ' + x.title + ' ' + x.start + '〜' + x.end);
      LOG('  → 取り込む場合は: node fetch-ntc-dashboard.js --add ' + x.id);
    }
    if (targets.size === 0 && (listed || []).length > 0) {
      LOG('登録済みシリーズがありません。--add <ULID> で対象を追加してください。');
    }
  }

  if (targets.size === 0) {
    LOG('対象シリーズがありません。終了(データ無変更)。');
    return;
  }

  // --- シリーズごとに取得・マージ ---
  let updated = 0, skipped = 0, gone = 0, addedShopsTotal = 0;
  for (const [id, meta] of targets) {
    let r;
    try {
      r = await httpGet(seriesUrl(id));
    } catch (e) {
      ERR('skip(取得失敗) ' + id + ': ' + e.message);
      skipped++;
      continue;
    }
    if (r.status === 404 || isNotFoundPayload(r.body)) {
      LOG((r.status === 404 ? '404' : '404相当(NEXT_HTTP_ERROR_FALLBACK)') +
        ': ' + id + ' → fetch_stopped=true(既存データは保持)');
      if (data.series[id]) { data.series[id].fetch_stopped = true; data.series[id].last_fetched = stamp; }
      gone++;
      continue;
    }
    if (r.status !== 200) { ERR('skip(HTTP ' + r.status + ') ' + id); skipped++; continue; }

    let parsed;
    try {
      parsed = parseSeries(r.body);
    } catch (e) {
      ERR('skip(パース不能) ' + id + ': ' + e.message);
      skipped++;
      continue;
    }

    const prev = data.series[id] && data.series[id].aggregates_latest;
    const prevN = prev && typeof prev.denominator_n === 'number' ? prev.denominator_n : null;
    const agg = buildAggregates(parsed, today, prevN);
    if (!agg.ok) { ERR('skip(サニティNG) ' + id + ': ' + agg.reason); skipped++; continue; }

    const m2 = {
      title: meta.title,
      start: parsed.dateRange.start || meta.start,
      end: parsed.dateRange.end || meta.end
    };
    if (!data.series[id] && !allowNew) {
      ERR('skip(未登録シリーズ) ' + id + ': 取り込むには --add ' + id + ' を実行してください');
      skipped++;
      continue;
    }
    const shopRes = buildShopEntries(parsed.shops, stamp);
    if (shopRes.skipped.length) ERR('  日付を解釈できない店舗行 ' + shopRes.skipped.length + '件をスキップ: ' + id);
    const hadShops = !!(data.series[id] && data.series[id].shops && Object.keys(data.series[id].shops).length);
    const res = mergeSeries(data, id, m2, agg.entry, shopRes.out, stamp);
    // 取りこぼし検知: 取得した店舗行が「すべて新規」かつ窓の上限(20件)に達している場合、
    // 前回取得から20件以上登録され、窓から押し出された行がある可能性が高い。
    if (hadShops && shopRes.out.length >= SHOP_WINDOW_HINT && res.addedShops === shopRes.out.length) {
      ERR('  警告: 店舗行が全件新規かつ窓の上限(' + SHOP_WINDOW_HINT + '件)に達しました。' +
        '前回取得以降に上限を超える登録があり、取りこぼした可能性があります: ' + id);
    }
    addedShopsTotal += res.addedShops;
    updated++;
    LOG('ok ' + id + ' N=' + agg.entry.denominator_n + ' usages=' + agg.entry.usages.length +
      ' wins=' + agg.entry.win_counts.length + ' 店舗行=' + parsed.shops.length +
      '(新規' + res.addedShops + ') history=' + (res.historyReplaced ? '当日分を上書き' : '追記'));
  }

  if (updated === 0 && gone === 0) {
    LOG('更新対象なし(成功0件)。既存ファイルは変更しません。skip=' + skipped);
    return;
  }

  const wrote = writeData(data);
  LOG('done: 更新' + updated + ' / 404停止' + gone + ' / スキップ' + skipped +
    ' / 店舗行新規' + addedShopsTotal + ' / 書き込み=' + (wrote ? 'あり' : 'なし'));
}

module.exports = {
  jstDate, jstStamp, normalizeDate, extractPayloadText, sliceJson, pickJson,
  parseList, parseSeries, inferDenominator, normColors, buildAggregates, isNotFoundPayload,
  buildShopEntries, mergeSeries, DATA_PATH
};

if (require.main === module) {
  main(process.argv)
    .then(() => process.exit(0))
    .catch((e) => { ERR('FATAL: ' + (e && e.message)); process.exit(0); });
}
