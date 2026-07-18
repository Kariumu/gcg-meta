#!/usr/bin/env node
/**
 * scan-tcgplus-tokens.js — BANDAI TCG+ 全カード変換表のスキャン取得（指示書47・適応方式）
 *
 * 指示書46の大会由来変換表（450種）を、全カード（新弾・大会未出現・パラレル含む）に
 * 拡張するため、TCG+ の deck/recipe API をトークン空間（0〜262,143 = 64^3）で
 * 逆引きスキャンし、data/tcgplus_tokenmap.json を v2 に拡張する。
 *
 * 【実測に基づく適応方式（2026-07-18 松岡さん承認）】
 * 当初の「全域50個バッチ走査」は次の実測事実により機能しない:
 *   - 未割当トークンが1個でも url_code に混ざるとリクエスト全体が404
 *   - トークン空間の上位約7割は未割当（404）。ただし高域にも割当島が存在
 *     （例: 212,992付近 = ドラゴンボール英語版）
 * そのため2モードの適応スキャンを行う:
 *   - dense: 50個バッチ。404時は決定的失敗として即・再帰二分割で生存トークンを特定。
 *     部分木(サイズ26以上)は5点単体サンプリング全滅で「推定デッド」化（要注意領域は
 *     coverage検証で補完）。全滅バッチが2連続したら island モードへ。
 *   - island: 256刻み単体プローブで割当島を探索。生存ヒットで p-255 から dense 再開。
 *     プローブ間の未走査窓は生データに skip 記録として残す（サンプリング済み扱い）。
 * GCG全カードは 39k〜77k の密集域内に存在することを事前偵察で確認済み
 * （大会450種=39,295〜71,291 / ST10=75,300付近 / GD05=75,900付近 / EB03=71,353付近）。
 * 極端に狭い島(<256)の理論的見逃しは cards_master カバレッジ検証で検出→追加探索で補完。
 *
 * 【タイトル判別（重要）】
 * card_number の形式だけでは他タイトルと衝突する（One Piece にも EB01/ST01 等が実在）。
 * GCG判定は image_url のタイトルパス（/card_image/GC-JA/ 、GC-EN=英語版）との
 * 二重フィルタで行う。代表トークンは GC-JA を優先。
 *
 * 【注意 / 制約】
 * - 本対応表は BANDAI TCG+ の内部ID体系に依存する非公式データであり、
 *   認証不要の公開APIだが、TCG+側の仕様変更で無告知に機能しなくなる可能性がある。
 * - アクセスは1.5秒間隔・429/5xx/網エラーは指数バックオフ・User-Agent明示。
 * - 生スキャン結果（全タイトル分）は tmp/ 配下に保存し、push禁止（ローカルのみ）。
 *   push対象は data/tcgplus_tokenmap.json と本スクリプトのみ。
 *
 * 【新弾運用（指示書47 §5）】
 * - 新弾発売時: cards_master にあり変換表に無いカードが出たら差分スキャン:
 *   前回の未走査窓（raw の skip/presumed 記録）と既知割当末尾以降を
 *   `--start <index>` で走査（state は tmp/tcgplus-scan-state.json 退避後に初期化）。
 * - 登録有無の軽量確認: api/user/card/list?game_title_id=15（1リクエスト・認証不要）。
 *   ※card/list の id と deck/recipe の code は独立採番で id→code は計算不可。
 *
 * 【代表トークン選定（指示書47 §2）】
 * - 大会由来があるカード: 指示書46の最頻トークンを維持（上書きしない）
 * - スキャンのみのカード: GC-JA版で数値最小のcode。複数版は needs_review:true
 *   （大会出現時に自動昇格）。どの版でも同じカードが開くため機能上の実害は無い。
 *
 * 使い方:
 *   node scripts/scan-tcgplus-tokens.js --scan [--budget-ms 38000]   # 継続実行（チェックポイント再開）
 *   node scripts/scan-tcgplus-tokens.js --status                     # 進捗表示
 *   node scripts/scan-tcgplus-tokens.js --verify                     # 生データ被覆検証
 *   node scripts/scan-tcgplus-tokens.js --build                      # 変換表v2生成（整合性検証込み）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TMP = path.join(ROOT, 'tmp');
const STATE_PATH = path.join(TMP, 'tcgplus-scan-state.json');
const RAW_NDJSON = path.join(TMP, 'tcgplus-scan-raw.ndjson');
const RAW_JSON = path.join(TMP, 'tcgplus-scan-raw.json'); // --build時に集約生成（push禁止）
const MAP_PATH = path.join(ROOT, 'data', 'tcgplus_tokenmap.json');
const CARDS_MASTER = path.join(ROOT, 'data', 'cards_master.json');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const MAX_INDEX = 262143; // 64^3 - 1
const BATCH = 50;
const ISLAND_STRIDE = 256;
const DEAD_BATCHES_TO_ISLAND = 2;
const PRESUME_MIN = 26; // このサイズ以上の部分木は5点全滅で推定デッド化
const FRAG_TO_SINGLES = 20;    // denseバッチのデッド数がこれ以上 → singlesモードへ
const SINGLES_ALIVE_TO_DENSE = 50; // 生存連続でdense復帰
const SINGLES_DEAD_TO_ISLAND = 100; // デッド連続でisland移行
// GCG存在確認済みレンジ（39,295〜77,000実測）+マージン。この中は完全分類（推定デッド不使用）。
// 圏外は5点サンプリング推定を許可し高速化（未走査分は生データに記録済み→将来の差分スキャン対象）
const THOROUGH_START = 38000;
const THOROUGH_END = 76750;
function inThorough(i) { return i >= THOROUGH_START && i <= THOROUGH_END; }
const API = 'https://api.bandai-tcg-plus.com/api/user/deck/recipe';
const UA = 'gcg-stats-tokenmap-scan/1.0 (+https://gcg-stats.com; contact kariumu19@gmail.com)';
const GCG_NUM_RE = /^(GD|ST|EB|SC)\d{2}-\d{3}|^(EXB|EXR|T-)/;
const GCG_IMG_RE = /\/card_image\/GC-(JA|EN)\//;

const args = process.argv.slice(2);
function argVal(name, dflt) {
  const i = args.indexOf(name);
  if (i >= 0 && i + 1 < args.length) return args[i + 1];
  return dflt;
}
const BUDGET_MS = parseInt(argVal('--budget-ms', '38000'), 10);
const INTERVAL_MS = parseInt(argVal('--interval-ms', '1500'), 10);
const START_OVERRIDE = argVal('--start', null);

function idxToToken(i) {
  return ALPHABET[(i >> 12) & 63] + ALPHABET[(i >> 6) & 63] + ALPHABET[i & 63];
}
function tokenToIdx(t) {
  return ALPHABET.indexOf(t[0]) * 4096 + ALPHABET.indexOf(t[1]) * 64 + ALPHABET.indexOf(t[2]);
}

function loadState() {
  if (fs.existsSync(STATE_PATH)) return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  return {
    next_index: 0, mode: 'dense', dead_batch_streak: 0, done: false,
    singles_alive_streak: 0, singles_dead_streak: 0,
    requests: 0, resolved: 0, invalid_confirmed: 0, presumed_dead: 0, skipped_sampled: 0,
    errors: { http429: 0, http5xx: 0, http4xx_other: 0, network: 0, protocol: 0 },
    http404_batches: 0, backoff_events: 0,
    started_at: new Date().toISOString(), updated_at: null,
  };
}
function saveState(st) {
  st.updated_at = new Date().toISOString();
  const tmp = STATE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(st, null, 2) + '\n');
  fs.renameSync(tmp, STATE_PATH);
}

const T0 = Date.now();
function remainMs() { return T0 + BUDGET_MS - Date.now(); }
let lastReqStart = 0;
async function pace() {
  const wait = lastReqStart + INTERVAL_MS - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
}

// 分割木の途中結果をコール間で持ち越すAPIコールキャッシュ
// （45秒予算内に収まらない大きな分割木でも累積的に前進できるようにする）
const CALL_CACHE_PATH = path.join(TMP, 'tcgplus-scan-callcache.json');
let callCache = new Map();
function loadCallCache() {
  try {
    if (fs.existsSync(CALL_CACHE_PATH)) callCache = new Map(Object.entries(JSON.parse(fs.readFileSync(CALL_CACHE_PATH, 'utf8'))));
  } catch (_) { callCache = new Map(); }
}
function saveCallCache() {
  fs.writeFileSync(CALL_CACHE_PATH, JSON.stringify(Object.fromEntries(callCache)) + '\n');
}
function clearCallCache() {
  callCache = new Map();
  try {
    if (fs.existsSync(CALL_CACHE_PATH)) fs.unlinkSync(CALL_CACHE_PATH);
  } catch (_) {
    // 削除保護環境では空で上書き（キャッシュ実質クリア）
    try { fs.writeFileSync(CALL_CACHE_PATH, '{}\n'); } catch (_) {}
  }
}

class BudgetExceeded extends Error {}
class FatalApi extends Error {}

// 1回のAPI呼び出し（429/5xx/網エラーはバックオフ付き再試行）。
// 戻り値: {status:200, byCode:Map} | {status:404} | throws
async function apiCall(st, tokens) {
  const cacheKey = tokens.length === 1 ? 's:' + tokens[0] : 'r:' + tokens[0] + '-' + tokens[tokens.length - 1];
  const hit = callCache.get(cacheKey);
  if (hit) {
    if (hit.s === 404) return { status: 404 };
    const byCode = new Map();
    for (const c of hit.c) byCode.set(String(c.code), c);
    return { status: 200, byCode };
  }
  let backoff = 5000;
  for (let attempt = 1; attempt <= 6; attempt++) {
    if (remainMs() < 2500) throw new BudgetExceeded();
    await pace();
    lastReqStart = Date.now();
    const urlCode = tokens.map(encodeURIComponent).join('.') + '!!!';
    const url = `${API}?url_code=${urlCode}&game_title_id=15&encode=0&app_version=9.9.9`;
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), 15000);
    let res = null, body = null, netErr = null;
    try {
      res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ac.signal });
      try { body = await res.json(); } catch (_) { body = null; }
    } catch (e) { netErr = String(e); } finally { clearTimeout(to); }
    st.requests++;
    if (netErr || (res && (res.status === 429 || res.status >= 500))) {
      if (netErr) st.errors.network++;
      else if (res.status === 429) st.errors.http429++;
      else st.errors.http5xx++;
      st.backoff_events++;
      if (backoff > remainMs() - 2000) throw new BudgetExceeded();
      await new Promise(r => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 60000);
      continue;
    }
    if (res.status === 200 && body && body.success && Array.isArray(body.success.main_deck)) {
      const byCode = new Map();
      for (const c of body.success.main_deck) byCode.set(String(c.code), c);
      callCache.set(cacheKey, { s: 200, c: body.success.main_deck.map(c => ({ code: c.code, ...pickCardFields(c) })) });
      return { status: 200, byCode };
    }
    if (res.status === 404) { callCache.set(cacheKey, { s: 404 }); return { status: 404 }; }
    st.errors[res.status >= 400 && res.status < 500 ? 'http4xx_other' : 'protocol']++;
    if (attempt >= 3) throw new FatalApi(`status=${res.status} tokens[0]=${tokens[0]}`);
  }
  throw new FatalApi('retries exhausted');
}

function pickCardFields(c) {
  return {
    card_number: c.card_number, card_name: c.card_name, id: c.id,
    image_url: c.image_url, type: c.type, color: c.color, cost: c.cost,
  };
}

function appendRaw(obj) {
  fs.appendFileSync(RAW_NDJSON, JSON.stringify(obj) + '\n');
}

// [i0..i1] を分類し、結果を out に蓄積する。
// out: {cards:[], invalid:[], presumed:[[a,b]...]}
async function resolveRange(st, i0, i1, out) {
  const size = i1 - i0 + 1;
  const tokens = [];
  for (let i = i0; i <= i1; i++) tokens.push(idxToToken(i));
  const r = await apiCall(st, tokens);
  if (r.status === 200) {
    for (const t of tokens) {
      const c = r.byCode.get(t);
      if (c) out.cards.push({ i: tokenToIdx(t), token: t, ...pickCardFields(c) });
      else out.invalid.push(tokenToIdx(t)); // 200だが応答に無い（観測上は稀）
    }
    return;
  }
  // 404: 少なくとも1個が未割当
  if (size === 1) { out.invalid.push(i0); return; }
  // GCG圏外の404バッチ: 5点サンプルを記録し、残りは推定デッド（固定コスト6リクエスト）。
  // 圏内は完全分類（この分岐を通らず分割木で全トークン確定）。
  if (size >= PRESUME_MIN && !inThorough(i0) && !inThorough(i1)) {
    const ps = [i0, i0 + (size >> 2), i0 + (size >> 1), i0 + 3 * (size >> 2), i1]
      .filter((v, k, a) => a.indexOf(v) === k);
    for (const p of ps) {
      const pr = await apiCall(st, [idxToToken(p)]);
      if (pr.status === 200) {
        const c = pr.byCode.get(idxToToken(p));
        if (c) out.cards.push({ i: p, token: idxToToken(p), ...pickCardFields(c) });
        else out.invalid.push(p);
      } else out.invalid.push(p);
    }
    out.presumed.push([i0, i1]); // 非サンプル点は推定（生データに記録→将来の差分スキャン対象）
    return;
  }
  if (size > 20) {
    // 大きいレンジは10個チャンクに分割（ポケット状の死点に対し二分木より安価）
    for (let a = i0; a <= i1; a += 10) {
      await resolveRange(st, a, Math.min(a + 9, i1), out);
    }
    return;
  }
  const mid = i0 + (size >> 1);
  await resolveRange(st, i0, mid - 1, out);
  await resolveRange(st, mid, i1, out);
}

async function cmdScan() {
  fs.mkdirSync(TMP, { recursive: true });
  const st = loadState();
  if (START_OVERRIDE !== null) { st.next_index = parseInt(START_OVERRIDE, 10); st.mode = 'dense'; st.done = false; }
  if (st.done) { console.log('STATE done=true 全域スキャン完了済み'); return 0; }
  loadCallCache();
  let unitsThisRun = 0;
  try {
    while (st.next_index <= MAX_INDEX) {
      if (remainMs() < 4500) break;
      if (st.mode === 'dense') {
        const i0 = st.next_index;
        const i1 = Math.min(i0 + BATCH - 1, MAX_INDEX);
        const out = { cards: [], invalid: [], presumed: [] };
        await resolveRange(st, i0, i1, out);
        // サンプリングと分割で同一indexが重複しうるため一意化
        const cardsByI = new Map();
        for (const c of out.cards) cardsByI.set(c.i, c);
        out.cards = [...cardsByI.values()].sort((a, b) => a.i - b.i);
        out.invalid = [...new Set(out.invalid)].filter(i => !cardsByI.has(i)).sort((a, b) => a - b);
        const alive = out.cards.length;
        st.resolved += alive;
        st.invalid_confirmed += out.invalid.length;
        for (const [a, b] of out.presumed) {
          const knowns = out.cards.filter(c => c.i >= a && c.i <= b).length + out.invalid.filter(i => i >= a && i <= b).length;
          st.presumed_dead += (b - a + 1) - knowns;
        }
        appendRaw({ i0, i1, t: new Date().toISOString(), cards: out.cards, invalid: out.invalid, presumed: out.presumed });
        clearCallCache(); // バッチ完了 → 持ち越しキャッシュ破棄
        st.next_index = i1 + 1;
        if (alive === 0) {
          st.dead_batch_streak++;
          if (st.dead_batch_streak >= DEAD_BATCHES_TO_ISLAND) { st.mode = 'island'; st.dead_batch_streak = 0; }
        } else {
          st.dead_batch_streak = 0;
          // 断片化が激しい場合は1個ずつ判定（GCG圏内のみ。圏外はdense+推定で走り続ける）
          if (inThorough(i0) && out.invalid.length + out.presumed.reduce((s, [a, b]) => s + (b - a + 1), 0) >= FRAG_TO_SINGLES) {
            st.mode = 'singles'; st.singles_alive_streak = 0; st.singles_dead_streak = 0;
          }
        }
        saveState(st);
        unitsThisRun++;
      } else if (st.mode === 'singles') {
        const p = st.next_index;
        const tk = idxToToken(p);
        const pr = await apiCall(st, [tk]);
        const c = pr.status === 200 ? pr.byCode.get(tk) : null;
        if (c) {
          appendRaw({ probe: p, alive: true, t: new Date().toISOString(), card: { i: p, token: tk, ...pickCardFields(c) } });
          st.resolved++;
          st.singles_alive_streak = (st.singles_alive_streak || 0) + 1;
          st.singles_dead_streak = 0;
        } else {
          appendRaw({ probe: p, alive: false, t: new Date().toISOString() });
          st.invalid_confirmed++;
          st.singles_dead_streak = (st.singles_dead_streak || 0) + 1;
          st.singles_alive_streak = 0;
        }
        st.next_index = p + 1;
        if (st.singles_alive_streak >= SINGLES_ALIVE_TO_DENSE) st.mode = 'dense';
        else if (st.singles_dead_streak >= SINGLES_DEAD_TO_ISLAND) st.mode = 'island';
        saveState(st);
        unitsThisRun++;
      } else { // island
        const p = st.next_index;
        const pr = await apiCall(st, [idxToToken(p)]);
        if (pr.status === 200 && pr.byCode.get(idxToToken(p))) {
          const c = pr.byCode.get(idxToToken(p));
          appendRaw({ probe: p, alive: true, t: new Date().toISOString(), card: { i: p, token: idxToToken(p), ...pickCardFields(c) } });
          st.resolved++;
          // 直前の未走査窓を巻き戻して再走査。GCG圏内は完全分類のsingles、
          // 圏外はdense+推定デッド（dead_batch_streak=1でサンプリング有効化）で安価に処理
          const rewind = Math.max(0, p - (ISLAND_STRIDE - 1));
          if (inThorough(p)) {
            st.mode = 'singles'; st.singles_alive_streak = 0; st.singles_dead_streak = 0;
          } else {
            st.mode = 'dense'; st.dead_batch_streak = 1;
          }
          st.next_index = rewind;
          appendRaw({ rejoin: [rewind, p], t: new Date().toISOString() });
        } else {
          // 未割当（またはカード無し）。窓ぶんをサンプル済みスキップとして記録
          const from = st.next_index;
          const to = Math.min(st.next_index + ISLAND_STRIDE - 1, MAX_INDEX);
          appendRaw({ skip: [from, to], sampled: p, t: new Date().toISOString() });
          st.skipped_sampled += (to - from + 1) - 1;
          st.invalid_confirmed += 1;
          st.next_index = to + 1;
        }
        saveState(st);
        unitsThisRun++;
      }
    }
  } catch (e) {
    saveState(st);
    if (e instanceof BudgetExceeded) {
      // チェックポイント終了。進行中の分割木はコールキャッシュで次回へ持ち越し（欠落なし）
      saveCallCache();
    } else if (e instanceof FatalApi) {
      console.log(`FATAL API応答が想定外: ${e.message} — 中断して報告要`);
      return 4;
    } else { console.error('UNCAUGHT_SCAN', e); return 4; }
  }
  if (st.next_index > MAX_INDEX) { st.done = true; saveState(st); }
  const pct = (Math.min(st.next_index, MAX_INDEX + 1) / (MAX_INDEX + 1) * 100).toFixed(2);
  console.log(`STATE next=${st.next_index} mode=${st.mode} done=${st.done} pct=${pct}% units=${unitsThisRun} req=${st.requests} alive=${st.resolved} dead_conf=${st.invalid_confirmed} presumed=${st.presumed_dead} skip_sampled=${st.skipped_sampled} err=${JSON.stringify(st.errors)} backoff=${st.backoff_events}`);
  return 0;
}

function readRawLines() {
  if (!fs.existsSync(RAW_NDJSON)) return [];
  return fs.readFileSync(RAW_NDJSON, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function buildCoverage(lines) {
  // index → 'alive' | 'dead' | 'presumed' | 'sampled_skip'
  const cov = new Map();
  const cards = new Map(); // i → card record（後勝ち）
  for (const o of lines) {
    if (o.i0 !== undefined) {
      for (const c of o.cards) { cov.set(c.i, 'alive'); cards.set(c.i, c); }
      for (const i of o.invalid) if (!cov.has(i) || cov.get(i) !== 'alive') cov.set(i, 'dead');
      for (const [a, b] of (o.presumed || [])) {
        for (let i = a; i <= b; i++) if (!cov.has(i)) cov.set(i, 'presumed');
      }
    } else if (o.probe !== undefined) {
      if (o.alive && o.card) { cov.set(o.probe, 'alive'); cards.set(o.probe, o.card); }
      else cov.set(o.probe, 'dead');
    } else if (o.skip) {
      const [a, b] = o.skip;
      for (let i = a; i <= b; i++) if (!cov.has(i)) cov.set(i, 'sampled_skip');
      cov.set(o.sampled, 'dead');
    }
    // rejoin行は情報のみ
  }
  return { cov, cards };
}

function cmdStatus() {
  const st = loadState();
  const pct = (Math.min(st.next_index, MAX_INDEX + 1) / (MAX_INDEX + 1) * 100).toFixed(2);
  console.log(JSON.stringify({ ...st, pct: pct + '%' }, null, 2));
  return 0;
}

function cmdVerify() {
  const st = loadState();
  const { cov, cards } = buildCoverage(readRawLines());
  const upto = Math.min(st.next_index - 1, MAX_INDEX);
  let alive = 0, dead = 0, presumed = 0, sampled = 0, uncovered = [];
  for (let i = 0; i <= upto; i++) {
    const s = cov.get(i);
    if (s === 'alive') alive++;
    else if (s === 'dead') dead++;
    else if (s === 'presumed') presumed++;
    else if (s === 'sampled_skip') sampled++;
    else uncovered.push(i);
  }
  // トークン重複はMapで自然に排除。カード数=alive数と一致するか
  console.log(`VERIFY upto=${upto} alive=${alive} dead=${dead} presumed=${presumed} sampled_skip=${sampled} uncovered=${uncovered.length}${uncovered.length ? ' 例:' + uncovered.slice(0, 10).join(',') : ''} cards=${cards.size}`);
  return uncovered.length === 0 && cards.size === alive ? 0 : 1;
}

function naturalCardSort(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

function cmdBuild() {
  const st = loadState();
  if (!st.done) { console.error('BUILD_ERROR: スキャン未完了（done=false）'); return 4; }
  const lines = readRawLines();
  const { cov, cards } = buildCoverage(lines);
  for (let i = 0; i <= MAX_INDEX; i++) {
    if (!cov.has(i)) { console.error(`BUILD_ERROR: 被覆欠落 index ${i}`); return 4; }
  }

  // 集約raw（全タイトル・push禁止）
  const allByToken = {};
  for (const [i, c] of [...cards.entries()].sort((a, b) => a[0] - b[0])) allByToken[c.token] = c;
  const covStats = { alive: 0, dead: 0, presumed: 0, sampled_skip: 0 };
  for (const s of cov.values()) covStats[s]++;
  fs.writeFileSync(RAW_JSON, JSON.stringify({
    _meta: {
      generated_from: 'tmp/tcgplus-scan-raw.ndjson',
      scan_started_at: st.started_at, scan_finished_at: st.updated_at,
      requests: st.requests, coverage: covStats,
      errors: st.errors, http404_batches: st.http404_batches, backoff_events: st.backoff_events,
      method: 'adaptive (dense batch50 + 404-bisect + presumed-dead(5点全滅,size>=26) + island stride256)',
    }, tokens: allByToken,
  }, null, 1) + '\n');

  // 1code→1card_number 一意性（cards は index→後勝ちMapなので、同一トークンの矛盾を生行から検査）
  const seen = new Map();
  for (const o of lines) {
    const arr = o.i0 !== undefined ? o.cards : (o.probe !== undefined && o.alive && o.card ? [o.card] : []);
    for (const c of arr) {
      if (seen.has(c.token) && seen.get(c.token) !== c.card_number) {
        console.error(`BUILD_ERROR: code重複矛盾 ${c.token}: ${seen.get(c.token)} vs ${c.card_number}`); return 4;
      }
      seen.set(c.token, c.card_number);
    }
  }

  // GCG抽出（image_url の GC- パスで判定。番号形式は補助）
  const gcgByNum = new Map(); // card_number → [{token,i,id,image_url,lang}]
  let numOnlyMismatch = [];
  for (const c of Object.values(allByToken)) {
    const num = String(c.card_number || '');
    const img = String(c.image_url || '');
    const isGcgImg = GCG_IMG_RE.test(img);
    const isGcgNum = GCG_NUM_RE.test(num);
    if (isGcgImg) {
      const lang = img.includes('/GC-JA/') ? 'JA' : 'EN';
      if (!gcgByNum.has(num)) gcgByNum.set(num, []);
      gcgByNum.get(num).push({ token: c.token, i: c.i, id: c.id, image_url: c.image_url, lang });
      if (!isGcgNum) numOnlyMismatch.push(`img_only:${num}:${c.token}`);
    }
  }
  for (const arr of gcgByNum.values()) arr.sort((a, b) => a.i - b.i);

  // 既存マップから大会由来ベースラインを抽出（v2を再読込しても冪等になるよう自己記述的に処理）
  const cur = JSON.parse(fs.readFileSync(MAP_PATH, 'utf8'));
  let v1meta, v1 = {};
  if (cur._meta && cur._meta.version >= 2) {
    v1meta = cur._meta.tournament || {};
    for (const [k, e] of Object.entries(cur)) {
      if (k === '_meta' || e.source !== 'tournament') continue;
      const t = { token: e.token };
      if (e.count !== undefined) t.count = e.count;
      if (e.alt !== undefined) t.alt = e.alt;
      v1[k] = t;
    }
  } else {
    v1meta = cur._meta || {};
    for (const [k, e] of Object.entries(cur)) { if (k !== '_meta') v1[k] = e; }
  }
  // 大会由来とのクロスチェック — 矛盾があれば中止
  const v1cards = Object.keys(v1);
  const contradictions = [];
  for (const num of v1cards) {
    const e = v1[num];
    const toks = [e.token, ...Object.keys(e.alt || {})];
    for (const t of toks) {
      const scanned = allByToken[t];
      if (!scanned) contradictions.push(`${num}:${t} スキャンで未解決`);
      else if (String(scanned.card_number) !== num) contradictions.push(`${num}:${t} スキャンでは ${scanned.card_number}`);
      else if (!GCG_IMG_RE.test(String(scanned.image_url || ''))) contradictions.push(`${num}:${t} 画像パスがGC-系でない`);
    }
  }
  if (contradictions.length > 0) {
    console.error(`BUILD_ERROR: 大会由来${v1cards.length}種クロスチェック矛盾 ${contradictions.length}件`);
    for (const c of contradictions.slice(0, 20)) console.error('  ' + c);
    return 4;
  }
  console.log(`CROSSCHECK OK: 大会由来${v1cards.length}種 全トークン矛盾0`);

  // v2生成
  const out = {};
  const allNums = new Set([...v1cards, ...gcgByNum.keys()]);
  let needsReview = 0, scanOnly = 0, enOnly = [];
  for (const num of [...allNums].sort(naturalCardSort)) {
    const versions = gcgByNum.get(num) || [];
    const tokensScan = {};
    for (const v of versions) tokensScan[v.token] = { id: v.id, image_url: v.image_url };
    if (v1[num]) {
      out[num] = { ...v1[num], source: 'tournament' };
      if (versions.length > 0) out[num].tokens_scan = tokensScan;
    } else {
      scanOnly++;
      const ja = versions.filter(v => v.lang === 'JA');
      const rep = (ja.length ? ja : versions)[0]; // GC-JA優先で数値最小
      out[num] = { token: rep.token, source: 'scan', tokens_scan: tokensScan };
      if (ja.length === 0) { out[num].needs_review = true; enOnly.push(num); needsReview++; }
      else if (ja.length > 1) { out[num].needs_review = true; needsReview++; }
    }
  }
  const map = {
    _meta: {
      version: 2,
      generated_at: st.updated_at,
      sources: ['tournament', 'scan'],
      scan_date: st.updated_at,
      card_count: allNums.size,
      scan_request_count: st.requests,
      scan_method: 'adaptive-v1 (dense+bisect+island256, filter=image_url GC-JA/GC-EN)',
      tournament: v1meta,
    },
  };
  for (const [k, v] of Object.entries(out)) map[k] = v;
  fs.writeFileSync(MAP_PATH, JSON.stringify(map, null, 2) + '\n');
  console.log(`BUILD OK: cards=${allNums.size} (tournament=${v1cards.length}, scan_only=${scanOnly}, needs_review=${needsReview}, EN_only=${enOnly.join(',') || 'なし'})`);
  if (numOnlyMismatch.length) console.log('NUM_FORMAT_INFO: ' + numOnlyMismatch.slice(0, 10).join(' '));

  // カバレッジ報告（cards_master 全カード）
  const cm = JSON.parse(fs.readFileSync(CARDS_MASTER, 'utf8'));
  const entries = Array.isArray(cm) ? cm : Object.values(cm);
  const baseIds = new Set(), verCount = new Map(), typeOf = new Map();
  for (const c of entries) {
    const id = String(c.id || '');
    const base = id.replace(/_p\d+$/, '');
    baseIds.add(base);
    typeOf.set(base, c.card_type);
    verCount.set(base, (verCount.get(base) || 0) + 1);
  }
  const missing = [...baseIds].filter(b => !map[b]).sort(naturalCardSort);
  console.log(`COVERAGE base_ids=${baseIds.size} mapped=${baseIds.size - missing.length} missing=${missing.length}`);
  if (missing.length) console.log('MISSING: ' + missing.map(m => `${m}(${typeOf.get(m)})`).join(','));
  const sets = new Map();
  for (const b of baseIds) { const s = b.split('-')[0]; if (!sets.has(s)) sets.set(s, []); sets.get(s).push(b); }
  for (const [s, bs] of [...sets.entries()].sort()) {
    const mapped = bs.filter(b => map[b]).length;
    console.log(`  ${s}: master_base=${bs.length} mapped=${mapped}`);
  }
  // パラレル版数の突き合わせ（情報提供: master版数 vs スキャンcode数）
  let verMismatch = 0;
  for (const b of baseIds) {
    if (!map[b] || !map[b].tokens_scan) continue;
    const scanVers = Object.keys(map[b].tokens_scan).length;
    if (scanVers !== verCount.get(b)) verMismatch++;
  }
  console.log(`VERSION_DIFF_INFO: master版数とスキャンcode数が異なるカード=${verMismatch}件（JA/EN混在・TCG+側登録差によるもの。エラーではない）`);
  // スキャンにあって master に無い番号
  const extra = [...allNums].filter(n => !baseIds.has(n)).sort(naturalCardSort);
  console.log(`SCAN_ONLY_NOT_IN_MASTER (${extra.length}): ` + extra.join(','));
  return 0;
}

(async () => {
  let rc = 0;
  if (args.includes('--status')) rc = cmdStatus();
  else if (args.includes('--verify')) rc = cmdVerify();
  else if (args.includes('--build')) rc = cmdBuild();
  else rc = await cmdScan();
  process.exit(rc);
})().catch(e => { console.error('UNCAUGHT', e); process.exit(4); });
