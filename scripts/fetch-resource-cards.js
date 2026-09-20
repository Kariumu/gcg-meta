#!/usr/bin/env node
/**
 * scripts/fetch-resource-cards.js  (指示書113 2026-09-20)
 * リソース／EXベース系カード（R- / RP- / EXR- / EXRP- / EXB- / EXBP-、パラレル _pN を含む）を
 * 公式カードリストから取得し、cards_master.json へ「追記だけ」する。
 *
 * 手順:
 *  (1) 一覧: 公式カードリスト top から全カテゴリ(parsePackages)を取り、各カテゴリの一覧から
 *      RESOURCE_LIKE に合う ID を集める（check-official-cardlist-sync.js と同じ取り方）。
 *      結果は tmp/resource-fetch/list.json に保存し、再実行では取り直さない（--refresh-list で取り直す）
 *  (2) 詳細: detail.php?detailSearch=<ID> を取得し、<CACHE_DIR>/<ID>.json にキャッシュ
 *      （既存 tmp/official-cards と同じ場所・同じ形 = fetch-official-cardlist.js の parseCard() の出力そのまま）。
 *      公式一覧に通常版が無い番号（R-001 など）は通常版の詳細を 1 回だけ照会し、302（未掲載）を記録する
 *  (3) 画像: https://www.gundam-gcg.com/jp/images/cards/card/<ID>.webp → images/cards/<ID>.webp
 *      （1,000 バイト以下や webp 署名でないものは失敗扱い。既存の有効な画像は取り直さない）
 *  (4) --merge: cards_master.json の末尾に追加分を追記する（既存エントリは 1 件も変えない。機械検証）。
 *      追加分だけを --additions-out（既定 tmp/resource-fetch/cards_master.additions.json）にも書き出す
 *
 * 公式サーバ配慮: 1 リクエスト 1.5 秒間隔（REQUEST_DELAY_MS、他スクリプトと同値・変更禁止）。
 * .env は読まない。Claude API・X・GitHub には一切アクセスしない。
 *
 * 使い方:
 *   node scripts/fetch-resource-cards.js --dry-run                  # 通信なし。キャッシュの状況と計画だけ表示
 *   node scripts/fetch-resource-cards.js --budget-ms 150000         # 取得（細切れ実行。再実行で続きから）
 *   node scripts/fetch-resource-cards.js --merge --dry-run          # マージ内容の確認のみ（書き込みなし）
 *   node scripts/fetch-resource-cards.js --merge                    # cards_master.json へ追記
 *   OFFICIAL_CARDS_CACHE=<dir>  詳細キャッシュの場所を差し替え（既定 tmp/official-cards）
 *   CARDS_MASTER_PATH=<file>    マスターの場所を差し替え
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const cheerio = require('cheerio');

const ROOT = path.resolve(__dirname, '..');
const MASTER_PATH = process.env.CARDS_MASTER_PATH || path.join(ROOT, 'data', 'cards_master.json');
const CACHE_DIR = process.env.OFFICIAL_CARDS_CACHE || path.join(ROOT, 'tmp', 'official-cards');
const WORK_DIR = path.join(ROOT, 'tmp', 'resource-fetch');
const LIST_PATH = path.join(WORK_DIR, 'list.json');
const PROBE_PATH = path.join(WORK_DIR, 'probe-base.json');
const REQ_LOG = path.join(WORK_DIR, 'requests.log');
const IMG_DIR = path.join(ROOT, 'images', 'cards');
const REQUEST_DELAY_MS = 1500; // 公式サーバ配慮（他スクリプトと同値、変更禁止）
const MIN_SIZE = 1000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REFERER = 'https://www.gundam-gcg.com/jp/';
const LIST_URL = 'https://www.gundam-gcg.com/jp/cards/';

/** リソース／EXベース系（check-official-cardlist-sync.js の旧 RESOURCE_LIKE と同じ式） */
const RESOURCE_LIKE = /^(R|EXB|EXR|RP|EXBP|EXRP)-\d/;
/** package_set: EXB-/EXBP- = EXBASE、R-/RP-/EXR-/EXRP- = RESOURCE（指示書113 §2-1・松岡さん決定 9/19） */
function packageSetFor(id) {
  return /^EXBP?-/.test(id) ? 'EXBASE' : 'RESOURCE';
}

const args = process.argv.slice(2);
const DO_MERGE = args.includes('--merge');
const DRY_RUN = args.includes('--dry-run');
const REFRESH_LIST = args.includes('--refresh-list');
const budgetArg = args.find((a) => a.startsWith('--budget-ms'));
const BUDGET_MS = budgetArg ? parseInt(budgetArg.split('=')[1] || args[args.indexOf(budgetArg) + 1], 10) : 0;
const addArg = args.find((a) => a.startsWith('--additions-out'));
const ADDITIONS_OUT = addArg ? (addArg.split('=')[1] || args[args.indexOf(addArg) + 1]) : path.join(WORK_DIR, 'cards_master.additions.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let requestCount = 0;
function logRequest(kind, url, status) {
  requestCount++;
  try {
    fs.mkdirSync(WORK_DIR, { recursive: true });
    fs.appendFileSync(REQ_LOG, new Date().toISOString() + '\t' + kind + '\t' + status + '\t' + url + '\n');
  } catch (_) { /* ログ失敗は致命ではない */ }
}

/** 1.5 秒待ってから GET（リダイレクトは追わない）。{status, location, body} を返す */
async function get(kind, url, binary) {
  if (DRY_RUN) throw new Error('dry-run 中に通信しようとした（バグ）: ' + url);
  await sleep(REQUEST_DELAY_MS);
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': USER_AGENT, 'Accept': binary ? 'image/webp,*/*' : 'text/html' };
    if (binary) headers.Referer = REFERER;
    https.get(url, { headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        logRequest(kind, url, res.statusCode);
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, location: res.headers.location || '', body: binary ? buf : buf.toString('utf8') });
      });
    }).on('error', (e) => { logRequest(kind, url, 'ERR ' + e.code); reject(e); });
  });
}

function isWebp(buf) {
  return buf.length > 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP';
}

/** check-official-cardlist-sync.js と同じ（カードリスト top から package の値とラベル） */
function parsePackages(html) {
  const $ = cheerio.load(html);
  const map = {};
  $('a[class*="js-selectBtn-package"]').each((_, el) => {
    const v = $(el).attr('data-val');
    if (v) map[v] = $(el).text().trim();
  });
  return map;
}

/** check-official-cardlist-sync.js と同じ（掲載件数 と カードID一覧） */
function parseList(html) {
  const $ = cheerio.load(html);
  const numText = $('.num').first().text().trim();
  const reported = /^\d+$/.test(numText) ? parseInt(numText, 10) : null;
  const ids = [];
  $('li.cardItem').each((_, el) => {
    const img = $(el).find('img').first();
    const src = img.attr('data-src') || img.attr('src') || '';
    const m = src.match(/([A-Za-z0-9]+-\d{3}(?:_p\d+)?)\.webp/);
    if (m) ids.push(m[1]);
  });
  return { reported, ids };
}

// ---- ここから scripts/fetch-official-cardlist.js 64〜117 行の parseCard() をそのまま写したもの（1 文字も変えていない）----
// 同ファイルは require すると取得処理が走る（module.exports が無い）ため、関数を写して使う。
/** detail.php の HTML を cards_master スキーマにパース */
function parseCard(html, cardId) {
  const $ = cheerio.load(html);
  const text = (sel) => $(sel).first().text().trim();
  const name = text('h1.cardName');
  if (!name) return null;

  // dataBox の dt/dd を辞書化
  const fields = {};
  $('.dataBox').each((_, el) => {
    const k = $(el).find('.dataTit').first().text().trim();
    const v = $(el).find('.dataTxt').first().text().trim();
    if (k) fields[k] = v;
  });

  // 効果テキスト(overview 行、<br> を改行に)
  let effect = '';
  const ov = $('.cardDataRow.overview .dataTxt').first();
  if (ov.length) {
    effect = ov.html() ? ov.html().replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '').trim() : '';
    effect = effect.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'");
    effect = effect.split('\n').map(l => l.trim()).filter(Boolean).join('');
  }

  const numOrNull = (v) => {
    const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  };
  const traits = (fields['特徴'] || '').match(/〔([^〕]+)〕/g);
  const links = (fields['リンク'] || '').match(/「([^」]+)」/g);

  const entry = {
    id: cardId,
    name_jp: name,
    rarity: text('.cardNoCol .rarity') || '',
    card_type: fields['タイプ'] || '',
    color: fields['色'] || '',
    level: numOrNull(fields['Lv.']),
    cost: numOrNull(fields['COST']),
    traits: traits ? traits.map(t => t.replace(/[〔〕]/g, '')) : [],
    stats: {},
    source_title: fields['出典タイトル'] || '',
    link: links ? links.map(l => l.replace(/[「」]/g, '')) : [],
    package_set: cardId.split('-')[0],
    effect_text: effect
  };
  if (fields['地形']) entry.terrain = fields['地形'];
  if (fields['入手情報']) entry.acquisition_info = fields['入手情報'];
  const ap = numOrNull(fields['AP']);
  const hp = numOrNull(fields['HP']);
  if (ap !== null) entry.stats.ap = ap;
  if (hp !== null) entry.stats.hp = hp;
  return entry;
}
// ---- 写しここまで ----

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (_) { return fallback; }
}
function writeJsonAtomic(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p + '.tmp113', JSON.stringify(obj, null, 2), 'utf-8');
  fs.renameSync(p + '.tmp113', p);
}
const baseIdOf = (id) => id.replace(/_p\d+$/, '');
const pNumOf = (id) => { const m = id.match(/_p(\d+)$/); return m ? parseInt(m[1], 10) : 0; };

/** 公式一覧に通常版が無いパラレルの番号（例 R-001_p4 → R-001） */
function missingBases(ids, master) {
  const set = new Set(ids);
  const out = [];
  for (const id of ids) {
    const b = baseIdOf(id);
    if (b !== id && !set.has(b) && !master[b] && !out.includes(b)) out.push(b);
  }
  return out;
}
/** 通常版を手作りするときの写し元 = 同じ番号の最小パラレル */
function sourceParallelFor(base, ids) {
  const ps = ids.filter((x) => baseIdOf(x) === base && x !== base).sort((a, b) => pNumOf(a) - pNumOf(b));
  return ps[0] || null;
}

async function stepList() {
  const cached = readJson(LIST_PATH, null);
  if (cached && !REFRESH_LIST) { console.log(`[一覧] キャッシュを使用（${cached.fetchedAt} 取得・${cached.ids.length} 件）`); return cached; }
  if (DRY_RUN) { console.log('[一覧] 未取得（dry-run のため取得しない）'); return null; }
  console.log('[一覧] 公式カードリストのカテゴリを取得');
  const top = await get('list-top', LIST_URL, false);
  if (top.status !== 200) throw new Error('カードリスト top が HTTP ' + top.status);
  const packages = parsePackages(top.body);
  const pk = Object.keys(packages);
  if (pk.length === 0) throw new Error('カテゴリを 1 件も抽出できない（公式の HTML 構造変更の可能性）');
  const ids = []; const cats = {}; const counts = {};
  for (const v of pk) {
    const r = await get('list', 'https://www.gundam-gcg.com/jp/cards/index.php?package=' + encodeURIComponent(v), false);
    if (r.status !== 200) throw new Error('カテゴリ ' + v + ' が HTTP ' + r.status);
    const { reported, ids: all } = parseList(r.body);
    const hit = all.filter((id) => RESOURCE_LIKE.test(id));
    counts[v] = { label: packages[v], reported, parsed: all.length, resource: hit.length };
    if (reported !== null && reported !== all.length) throw new Error(packages[v] + ': 公式表示 ' + reported + ' 件に対し抽出 ' + all.length + ' 件');
    for (const id of hit) { if (!cats[id]) { cats[id] = []; ids.push(id); } cats[id].push(packages[v]); }
    console.log(`  ${packages[v]}: 全 ${all.length} 件 / リソース系 ${hit.length} 件`);
  }
  const list = { fetchedAt: new Date().toISOString(), packages, counts, ids, categories: cats };
  writeJsonAtomic(LIST_PATH, list);
  console.log(`[一覧] カテゴリ ${pk.length} 件・リソース系ユニーク ${ids.length} 件`);
  return list;
}

async function stepFetch() {
  if (!DRY_RUN) { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.mkdirSync(IMG_DIR, { recursive: true }); }  // dry-run では何も作らない（二次確認 軽微3）
  const started = Date.now();
  const overBudget = () => BUDGET_MS && Date.now() - started > BUDGET_MS;
  const master = readJson(MASTER_PATH, {});
  const list = await stepList();
  if (!list) { console.log('dry-run: 一覧が無いので計画を出せません'); return; }
  const status = readJson(path.join(WORK_DIR, 'status.json'), { detail: {}, image: {} });
  const save = () => { if (!DRY_RUN) writeJsonAtomic(path.join(WORK_DIR, 'status.json'), status); };

  // (2a) 公式一覧に無い通常版の照会（1 番号 1 回だけ。結果を記録して再照会しない）
  const probe = readJson(PROBE_PATH, {});
  for (const b of missingBases(list.ids, master)) {
    if (probe[b]) continue;
    if (DRY_RUN) { console.log(`  [dry] 通常版 ${b} の詳細を照会する予定`); continue; }
    if (overBudget()) { console.log('[時間予算] 到達。再実行で続きから'); save(); return; }
    const r = await get('probe', 'https://www.gundam-gcg.com/jp/cards/detail.php?detailSearch=' + b, false);
    probe[b] = { status: r.status, location: r.location, at: new Date().toISOString() };
    if (r.status === 200) {
      const e = parseCard(r.body, b);
      if (e) { fs.writeFileSync(path.join(CACHE_DIR, b + '.json'), JSON.stringify(e, null, 2), 'utf-8'); probe[b].parsed = true; }
    }
    writeJsonAtomic(PROBE_PATH, probe);
    console.log(`  照会 ${b}: HTTP ${r.status}${r.location ? ' → ' + r.location : ''}`);
  }

  // (2b) 詳細
  let fetched = 0, cached = 0; const failed = [];
  for (const id of list.ids) {
    const cf = path.join(CACHE_DIR, id + '.json');
    if (fs.existsSync(cf)) { cached++; continue; }
    if (DRY_RUN) { console.log(`  [dry] 詳細 ${id}`); continue; }
    if (overBudget()) { console.log(`[時間予算] 到達。詳細 取得 ${fetched}（キャッシュ済 ${cached}）で中断。再実行で続きから`); save(); return; }
    const r = await get('detail', 'https://www.gundam-gcg.com/jp/cards/detail.php?detailSearch=' + id, false);
    if (r.status !== 200) { status.detail[id] = 'http ' + r.status; failed.push(id); console.warn(`  ✗ ${id}: HTTP ${r.status}`); continue; }
    const e = parseCard(r.body, id);
    if (!e) { status.detail[id] = 'parse-failed'; failed.push(id); console.warn(`  ✗ ${id}: パース失敗`); continue; }
    fs.writeFileSync(cf, JSON.stringify(e, null, 2), 'utf-8');
    status.detail[id] = 'ok'; fetched++;
    console.log(`  ✓ ${id}: ${e.name_jp} [${e.rarity}/${e.color}/${e.card_type}]`);
  }
  save();
  console.log(`[詳細] 新規 ${fetched} / キャッシュ済 ${cached} / 失敗 ${failed.length}`);

  // (3) 画像（一覧の全 ID ＋ 手作りする通常版）
  const bases = Object.keys(probe).filter((b) => probe[b].status !== 200);
  const want = [...list.ids, ...bases];
  let got = 0, have = 0; const imgFailed = [];
  for (const id of want) {
    const dest = path.join(IMG_DIR, id + '.webp');
    try { if (fs.existsSync(dest) && isWebp(fs.readFileSync(dest)) && fs.statSync(dest).size > MIN_SIZE) { have++; continue; } } catch (_) { /* 取り直す */ }
    if (DRY_RUN) { console.log(`  [dry] 画像 ${id}`); continue; }
    if (status.image[id] && status.image[id].startsWith('fail') && !bases.includes(id)) { imgFailed.push(id); continue; } // 失敗記録済みは再要求しない
    if (overBudget()) { console.log(`[時間予算] 到達。画像 取得 ${got}（既存 ${have}）で中断。再実行で続きから`); save(); return; }
    if (!(bases.includes(id) && status.image[id])) {
      let url = 'https://www.gundam-gcg.com/jp/images/cards/card/' + id + '.webp';
      let r = await get('image', url, true);
      for (let d = 0; d < 3 && (r.status === 301 || r.status === 302) && r.location; d++) {
        const next = new URL(r.location, url);
        if (next.protocol !== 'https:' || next.hostname !== 'www.gundam-gcg.com') { console.warn(`  ! ${id}: 公式以外への転送は追わない（${next.href}）`); break; }  // 二次確認 軽微3
        url = next.href; r = await get('image-redirect', url, true);
      }
      if (r.status === 200 && r.body.length > MIN_SIZE && isWebp(r.body)) {
        fs.writeFileSync(dest, r.body); status.image[id] = 'ok ' + r.body.length; got++; save(); continue;
      }
      status.image[id] = `fail http ${r.status} size=${r.body.length} webp=${isWebp(r.body)}`;
    }
    // 手作りの通常版だけは、公式に画像が無ければ写し元パラレルの画像を流用する（要裁定・完了報告に記載）
    const src = bases.includes(id) ? sourceParallelFor(id, list.ids) : null;
    const srcPath = src && path.join(IMG_DIR, src + '.webp');
    if (src && fs.existsSync(srcPath) && isWebp(fs.readFileSync(srcPath))) {
      fs.copyFileSync(srcPath, dest); status.image[id] += ` → copied-from ${src}`; got++;
    } else { imgFailed.push(id); }
    save();
  }
  save();
  console.log(`[画像] 新規 ${got} / 既存 ${have} / 失敗 ${imgFailed.length}${imgFailed.length ? ' → ' + imgFailed.join(',') : ''}`);
  console.log(`今回の公式リクエスト数: ${requestCount}（累計は ${REQ_LOG}）`);
}

/** parseCard() の出力に 指示書113 §2-1 の後処理だけを当てる */
function toMasterEntry(raw) {
  const e = JSON.parse(JSON.stringify(raw));
  if (e.color === '—' || e.color === '－' || e.color === '-' || e.color === '') e.color = '-';   // 既存 TOKEN と同じ
  if (e.level === null || e.level === undefined) delete e.level;                                  // 既存 TOKEN と同じ
  if (e.cost === null || e.cost === undefined) delete e.cost;
  e.rarity = String(e.rarity || '').replace(/\s+/g, '');                                          // "C +" → "C+"（fetch-gd05-reprint-parallels.js と同じ）
  e.package_set = packageSetFor(e.id);
  if (/_p\d+$/.test(e.id)) {
    e.is_parallel = true;
    e.is_promo = false;
    e.parallel_number = pNumOf(e.id);
    e.base_card_id = baseIdOf(e.id);
  }
  return e;
}

function merge() {
  const list = readJson(LIST_PATH, null);
  if (!list) { console.error('マージ中止: 一覧(list.json)がありません。先に取得を実行してください'); process.exit(1); }
  const rawText = fs.readFileSync(MASTER_PATH, 'utf-8');
  const master = JSON.parse(rawText);
  const before = JSON.parse(rawText);
  if (JSON.stringify(before, null, 2) !== rawText) { console.error('マージ中止: 既存 cards_master.json が JSON.stringify(…, null, 2) の形と一致しない（バイト保全を保証できない）'); process.exit(1); }
  const probe = readJson(PROBE_PATH, {});

  const additions = {};
  const missing = [];
  for (const id of list.ids) {
    if (master[id]) { console.error(`マージ中止: ${id} は既に master にあります`); process.exit(1); }
    const cf = path.join(CACHE_DIR, id + '.json');
    if (!fs.existsSync(cf)) { missing.push(id); continue; }
    additions[id] = toMasterEntry(readJson(cf, null));
  }
  if (missing.length) { console.error(`マージ中止: 詳細が未取得 ${missing.length} 件: ${missing.join(',')}`); process.exit(1); }

  // 公式に無い通常版を、同じ番号の最小パラレルから作る（指示書113 §2-1・§5-1 裁定済み。_p1〜_p3 は作らない）
  for (const b of missingBases(list.ids, master)) {
    const p = probe[b];
    if (!p) { console.error(`マージ中止: 通常版 ${b} の照会結果がありません`); process.exit(1); }
    if (p.status === 200 && p.parsed) { additions[b] = toMasterEntry(readJson(path.join(CACHE_DIR, b + '.json'), null)); continue; }
    const src = sourceParallelFor(b, list.ids);
    const s = additions[src];
    const e = {
      id: b, name_jp: s.name_jp, rarity: 'C', card_type: s.card_type, color: s.color,
      traits: s.traits, stats: s.stats, source_title: s.source_title, link: s.link,
      package_set: packageSetFor(b), effect_text: s.effect_text,
    };
    if (s.terrain !== undefined) e.terrain = s.terrain;
    e.acquisition_info = '';
    e.data_source = 'manual-from-' + src;
    additions[b] = JSON.parse(JSON.stringify(e));
  }

  // 事前検証
  const ids = Object.keys(additions).sort((a, b) => a.localeCompare(b));
  const errs = [];
  for (const id of ids) {
    const e = additions[id];
    if (!RESOURCE_LIKE.test(id)) errs.push(`${id}: RESOURCE_LIKE に合わない`);
    if (!['RESOURCE', 'EXBASE'].includes(e.package_set)) errs.push(`${id}: package_set ${e.package_set}`);
    if (!e.name_jp || !e.card_type || !e.rarity) errs.push(`${id}: 必須項目欠損`);
    if (e.is_parallel && !(additions[e.base_card_id] || master[e.base_card_id])) errs.push(`${id}: base_card_id ${e.base_card_id} が存在しない`);
    if (/_p\d+$/.test(id) && !e.is_parallel) errs.push(`${id}: _pN なのに is_parallel が無い`);
  }
  if (errs.length) { console.error('マージ中止:\n  ' + errs.join('\n  ')); process.exit(1); }

  const merged = {};
  for (const k of Object.keys(before)) merged[k] = master[k];
  for (const id of ids) merged[id] = additions[id];
  // 安全検証 1: 既存エントリが 1 件も変わっていない
  for (const [id, card] of Object.entries(before)) {
    if (JSON.stringify(merged[id]) !== JSON.stringify(card)) { console.error(`マージ中止: 既存エントリ ${id} が変化`); process.exit(1); }
  }
  // 安全検証 2: 既存キーの並びが先頭にそのまま残り、増えたキーは追加分だけ
  const mk = Object.keys(merged); const bk = Object.keys(before);
  if (bk.some((k, i) => mk[i] !== k) || mk.length !== bk.length + ids.length) { console.error('マージ中止: キーの並び/件数が想定外'); process.exit(1); }
  const outText = JSON.stringify(merged, null, 2);
  // 安全検証 3: 旧ファイルの末尾 "\n}" を除いた部分が、新ファイルの先頭とバイト一致する（＝末尾に追記しただけ）
  if (!outText.startsWith(rawText.slice(0, -2) + ',\n')) { console.error('マージ中止: 追記以外の変化がある'); process.exit(1); }

  const types = {}; const sets = {};
  for (const id of ids) { const e = additions[id]; types[e.card_type] = (types[e.card_type] || 0) + 1; sets[e.package_set] = (sets[e.package_set] || 0) + 1; }
  console.log(`追加 ${ids.length} 件（一覧 ${list.ids.length} ＋ 手作りの通常版 ${ids.length - list.ids.length}）/ 総数 ${bk.length} → ${mk.length}`);
  console.log('  card_type 別: ' + JSON.stringify(types));
  console.log('  package_set 別: ' + JSON.stringify(sets));
  if (Object.keys(types).length > 3) console.log('  ！card_type が 3 種類を超えています（指示書113 §2-1: 報告対象）');
  if (DRY_RUN) { console.log('[dry-run] 書き込みなし'); return; }
  fs.writeFileSync(MASTER_PATH + '.tmp113', outText, 'utf-8');
  fs.renameSync(MASTER_PATH + '.tmp113', MASTER_PATH);
  const addOut = {}; for (const id of ids) addOut[id] = additions[id];
  fs.mkdirSync(path.dirname(ADDITIONS_OUT), { recursive: true });
  fs.writeFileSync(ADDITIONS_OUT, JSON.stringify(addOut, null, 2), 'utf-8');
  console.log('マージ完了: ' + MASTER_PATH);
  console.log('追加分: ' + ADDITIONS_OUT);
}

async function main() {
  if (DO_MERGE) { merge(); return; }
  await stepFetch();
}

main().catch((e) => { console.error('致命的エラー:', e.message); console.error(`今回の公式リクエスト数: ${requestCount}`); process.exit(1); });
// EOF
