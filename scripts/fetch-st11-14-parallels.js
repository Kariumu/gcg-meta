#!/usr/bin/env node
/**
 * scripts/fetch-st11-14-parallels.js  (2026-09-25)
 * スタートデッキ ST11〜ST14 のパラレル 64 種（各弾 16 種 × 4 弾、すべて _p1）を
 * 公式カードリストから取得し、cards_master.json へ登録する。
 *
 * 出典（機械確認 2026-09-25 19:05 JST）:
 *  - 公式カード検索 package=615011〜615014（Aquatic Assault [ST11] / Raging Onslaught [ST12] /
 *    Silent Barrage [ST13] / Heavy Dominion [ST14]）が、通常版 16 種＋トークンに加えて
 *    ST1x-001_p1〜ST1x-016_p1 の 16 種ずつを返すようになった（2026-09-24 20:00 の
 *    check-official-cardlist-sync.js では ST11 17 件＝パラレルなしだった）。
 *  - スタートデッキの一覧には、トークン（T-028 / T-029）のパラレルと _p2 以降は無い。
 *    （プロモーションカードの一覧にある ST11-002_p2・ST11-011_p2・ST12-009_p2・ST12-012_p2・
 *      T-029_p1・T-029_p2 はイベントの景品で、この 64 種には含めない。2026-09-25 二次確認で確認）
 *
 * 設計は scripts/fetch-gd05-reprint-parallels.js（2026-07-28）を踏襲:
 *  - detail.php?detailSearch={id} を 1.5 秒間隔で取得（公式サーバ配慮、変更禁止）
 *  - tmp/st11-14-parallels-cache/{id}.json にキャッシュ（再実行で続きから）
 *  - 画像は images/cards/{id}.webp へ保存。公式に無ければ通常版({base}.webp)を流用
 *  - AP/HP が "+2" のように符号付きなら stats.ap_mod / stats.hp_mod（PILOT の既存の形）
 *  - package_set は通常版と同じ（ST11〜ST14。ST10 のパラレルと同じ規則）、is_promo:false
 *
 * gd05 版からの変更点（意図的）:
 *  1. 通常版の公式ページ（detail.php?detailSearch={base}）も同じ parseCard で読み、パラレルと、共通である
 *     はずの項目（名前・タイプ・色・Lv・COST・特徴・AP/HP・出典・リンク・効果・地形）が同じかを確かめる。
 *     1 項目でも違えば --merge しない（別のカードの可能性があるため）。
 *  2. 同じなら、共通の項目は master の通常版の値をそのまま写す。master の通常版は 2026-09-11 に公式の表示
 *     から取り、二次確認で公式と照合済みの値で、parseCard では取れない物（効果のかっこ書きの説明・
 *     「特徴〔…〕」のリンク条件）を含むため（2026-09-25 に parseCard の結果と比べて確かめた）。
 *     パラレル固有の項目（id・rarity・acquisition_info・パラレルの印）だけを公式のパラレルのページから取る。
 *  3. --merge は、各パラレルを通常版の直後に差し込む（既存の並びを変えない。ST10 のパラレルと同じ並び）。
 *     gd05 版のような全体の並べ替えはしない（master は全体では昇順に並んでいないため）。
 *
 * 使い方（E:\GCGSTATS）:
 *   node scripts\fetch-st11-14-parallels.js --dry-run          # 列挙のみ
 *   node scripts\fetch-st11-14-parallels.js                    # 取得（キャッシュ済はスキップ）
 *   node scripts\fetch-st11-14-parallels.js --merge --dry-run  # マージ内容の確認のみ
 *   node scripts\fetch-st11-14-parallels.js --merge            # cards_master.json へ追記
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const cheerio = require('cheerio');

const ROOT = process.env.STPAR_ROOT || path.resolve(__dirname, '..');   // STPAR_ROOT は発行元の作業用
const MASTER_PATH = process.env.CARDS_MASTER_PATH || path.join(ROOT, 'data', 'cards_master.json');
const IMG_DIR = process.env.STPAR_IMG_DIR || path.join(ROOT, 'images', 'cards');
const CACHE_DIR = process.env.STPAR_CACHE || path.join(ROOT, 'tmp', 'st11-14-parallels-cache');
const BASE_CACHE_DIR = path.join(CACHE_DIR, 'base');   // 通常版の公式ページを parseCard で読んだ結果（突き合わせ用）
const BACKUP_DIR = path.join(ROOT, 'tmp', 'st11-14-parallels-backup-20260925');
const REQUEST_DELAY_MS = 1500; // 公式サーバ配慮（fetch-official-cardlist.js と同値、変更禁止）
const MIN_SIZE = 1000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REFERER = 'https://www.gundam-gcg.com/jp/';

// 公式 package=615011〜615014 の一覧に載ったパラレル（2026-09-25 19:05 JST 取得）
const SETS = ['ST11', 'ST12', 'ST13', 'ST14'];
const IDS = [];
for (const s of SETS) for (let n = 1; n <= 16; n++) IDS.push(`${s}-${String(n).padStart(3, '0')}_p1`);
const EXPECTED_COUNT = 64;

// 通常版と同じはずの項目
const SHARED = ['name_jp', 'card_type', 'color', 'level', 'cost', 'traits', 'stats', 'source_title', 'link', 'effect_text', 'terrain'];

const args = process.argv.slice(2);
const DO_MERGE = args.includes('--merge');
const DRY_RUN = args.includes('--dry-run');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html', 'Referer': REFERER } }, (res) => {
      if (res.statusCode !== 200) { resolve(null); res.resume(); return; } // 302=未掲載
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}

function isWebp(buf) {
  return buf.length > 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP';
}

function downloadImage(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 3) { resolve({ ok: false, reason: 'too-many-redirects' }); return; }
    const u = new URL(url);
    if (u.hostname !== 'www.gundam-gcg.com') { resolve({ ok: false, reason: 'redirect to other host ' + u.hostname }); return; }
    https.get(u, { headers: { 'User-Agent': USER_AGENT, 'Referer': REFERER } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        res.resume();
        resolve(downloadImage(new URL(res.headers.location, u).toString(), depth + 1));
        return;
      }
      if (res.statusCode !== 200) { res.resume(); resolve({ ok: false, reason: 'http ' + res.statusCode }); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (buf.length < MIN_SIZE || !isWebp(buf)) { resolve({ ok: false, reason: 'invalid (size=' + buf.length + ')' }); return; }
        resolve({ ok: true, buf, size: buf.length });
      });
    }).on('error', reject);
  });
}

// fetch-gd05-reprint-parallels.js の parseCard と同じ（package_set だけ引数で受ける）
function parseCard(html, cardId, packageSet) {
  const $ = cheerio.load(html);
  const text = (sel) => $(sel).first().text().trim();
  const name = text('h1.cardName');
  if (!name) return null;
  const fields = {};
  $('.dataBox').each((_, el) => {
    const k = $(el).find('.dataTit').first().text().trim();
    const v = $(el).find('.dataTxt').first().text().trim();
    if (k) fields[k] = v;
  });
  let effect = '';
  const ov = $('.cardDataRow.overview .dataTxt').first();
  if (ov.length) {
    effect = ov.html() ? ov.html().replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '').trim() : '';
    effect = effect.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'");
    effect = effect.split('\n').map((l) => l.trim()).filter(Boolean).join('');
  }
  const numOrNull = (v) => { const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10); return Number.isFinite(n) ? n : null; };
  const traits = (fields['特徴'] || '').match(/〔([^〕]+)〕/g);
  const links = (fields['リンク'] || '').match(/「([^」]+)」/g);
  const entry = {
    id: cardId,
    name_jp: name,
    rarity: (text('.cardNoCol .rarity') || '').replace(/\s+/g, ''), // "LR  +" -> "LR+"
    card_type: fields['タイプ'] || '',
    color: fields['色'] || '',
    level: numOrNull(fields['Lv.']),
    cost: numOrNull(fields['COST']),
    traits: traits ? traits.map((t) => t.replace(/[〔〕]/g, '')) : [],
    stats: {},
    source_title: fields['出典タイトル'] || '',
    link: links ? links.map((l) => l.replace(/[「」]/g, '')) : [],
    package_set: packageSet,
    effect_text: effect,
    effect: effect,
  };
  if (fields['地形']) entry.terrain = fields['地形'];
  if (fields['入手情報']) entry.acquisition_info = fields['入手情報'];
  const apRaw = fields['AP']; const hpRaw = fields['HP'];
  const ap = numOrNull(apRaw); const hp = numOrNull(hpRaw);
  if (ap !== null) { if (/^\s*[+＋]/.test(String(apRaw))) entry.stats.ap_mod = ap; else entry.stats.ap = ap; }
  if (hp !== null) { if (/^\s*[+＋]/.test(String(hpRaw))) entry.stats.hp_mod = hp; else entry.stats.hp = hp; }
  return entry;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// かっこ書き（半角の丸かっこ。入れ子も含めて）を取り除く
function stripParens(t) {
  let out = ''; let depth = 0;
  for (const ch of String(t || '')) {
    if (ch === '(') { depth++; continue; }
    if (ch === ')' && depth > 0) { depth--; continue; }
    if (depth === 0) out += ch;
  }
  return out;
}

// パラレルと通常版の公式ページ（同じ parseCard の結果）で、共通の項目が同じか。違う項目と、注記を返す
//   公式のパラレルのページは、効果の「(…)」のかっこ書き（キーワードの説明など）を載せないことがある
//   （2026-09-25 に ST11〜14 の 15 種で確認）。効果はかっこ書きを除いて比べ、違いがそれだけなら注記にする。
//   master の既存のパラレル 744 件は、効果とリンクを通常版と同じ形で持っている（701 件は効果が完全に同じ・
//   リンクは 744 件すべて同じ）ので、登録する値は通常版の値にそろえる（buildEntry）。
function compareOfficial(par, base) {
  const diffs = []; const notes = [];
  for (const k of SHARED) {
    if (same(par[k], base[k])) continue;
    if (k === 'effect_text' && stripParens(par[k]) === stripParens(base[k])) { notes.push('公式のパラレルのページには効果のかっこ書きが無い（通常版の効果をそのまま使う）'); continue; }
    diffs.push(`${k}: パラレル ${JSON.stringify(par[k])} / 通常版 ${JSON.stringify(base[k])}`);
  }
  return { diffs, notes };
}

// master の通常版から、登録するパラレルのエントリを作る（キーの並びは既存のパラレルと同じ）
function buildEntry(par, masterBase) {
  const e = { id: par.id, name_jp: masterBase.name_jp, rarity: par.rarity, card_type: masterBase.card_type, color: masterBase.color };
  if ('level' in masterBase) e.level = masterBase.level;
  if ('cost' in masterBase) e.cost = masterBase.cost;
  e.traits = JSON.parse(JSON.stringify(masterBase.traits || []));
  e.stats = JSON.parse(JSON.stringify(masterBase.stats || {}));
  e.source_title = masterBase.source_title;
  e.link = JSON.parse(JSON.stringify(masterBase.link || []));
  e.package_set = masterBase.package_set;
  e.effect_text = masterBase.effect_text;
  e.effect = masterBase.effect_text;
  if ('terrain' in masterBase) e.terrain = masterBase.terrain;
  e.acquisition_info = par.acquisition_info;
  e.is_parallel = true;
  e.is_promo = false;
  e.parallel_number = par.parallel_number;
  e.base_card_id = par.base_card_id;
  return e;
}

async function saveImage(id, base) {
  const dest = path.join(IMG_DIR, `${id}.webp`);
  if (fs.existsSync(dest)) {
    try { if (isWebp(fs.readFileSync(dest))) return { status: 'exists' }; } catch (e) { /* re-download */ }
  }
  const url = `https://www.gundam-gcg.com/jp/images/cards/card/${id}.webp`;
  await sleep(REQUEST_DELAY_MS);
  const r = await downloadImage(url);
  if (r.ok) {
    if (!DRY_RUN) fs.writeFileSync(dest, r.buf);
    return { status: 'downloaded', size: r.size };
  }
  const baseImg = path.join(IMG_DIR, `${base}.webp`);
  if (fs.existsSync(baseImg)) {
    if (!DRY_RUN) fs.copyFileSync(baseImg, dest);
    return { status: 'fallback-base', reason: r.reason };
  }
  return { status: 'image-failed', reason: r.reason };
}

async function fetchAll() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  if (!DRY_RUN) fs.mkdirSync(IMG_DIR, { recursive: true });
  let fetched = 0, cached = 0, imaged = 0;
  const failed = []; const warns = []; const imgNotes = [];
  for (const id of IDS) {
    const base = id.replace(/_p\d+$/, '');
    const pn = parseInt(id.match(/_p(\d+)$/)[1], 10);
    const set = base.slice(0, 4);
    const cacheFile = path.join(CACHE_DIR, id + '.json');
    if (fs.existsSync(cacheFile)) {
      cached++;
      if (!DRY_RUN) {
        const img = await saveImage(id, base);
        if (img.status !== 'exists') imaged++;
        if (img.status !== 'exists' && img.status !== 'downloaded') imgNotes.push(`${id}: 画像 ${img.status}${img.reason ? '(' + img.reason + ')' : ''}`);
        console.log(`  = ${id}: データはキャッシュ済 / 画像:${img.status}${img.reason ? '(' + img.reason + ')' : ''}`);
      } else console.log(`  = ${id}: データはキャッシュ済`);
      continue;
    }
    if (DRY_RUN) { console.log(`  [dry] ${id} (base=${base}, p=${pn}, package_set=${set})`); continue; }
    await sleep(REQUEST_DELAY_MS);
    const html = await fetchHtml(`https://www.gundam-gcg.com/jp/cards/detail.php?detailSearch=${id}`);
    if (!html) { failed.push(id); console.warn(`  ✗ ${id}: 未掲載(302)or取得失敗`); continue; }
    const entry = parseCard(html, id, set);
    if (!entry) { failed.push(id); console.warn(`  ✗ ${id}: パース失敗`); continue; }
    entry.is_parallel = true;
    entry.is_promo = false;
    entry.parallel_number = pn;
    entry.base_card_id = base;
    if (!entry.acquisition_info || entry.acquisition_info.indexOf(`[${set}]`) < 0) warns.push(`${id}: 入手情報が想定外「${entry.acquisition_info || '(なし)'}」`);
    const img = await saveImage(id, base);
    if (img.status !== 'exists') imaged++;
    if (img.status !== 'exists' && img.status !== 'downloaded') imgNotes.push(`${id}: 画像 ${img.status}${img.reason ? '(' + img.reason + ')' : ''}`);
    fs.writeFileSync(cacheFile, JSON.stringify(entry, null, 2), 'utf-8');
    fetched++;
    console.log(`  ✓ ${id}: ${entry.name_jp} [${entry.rarity}/${entry.color}/${entry.card_type}] 画像:${img.status}${img.reason ? '(' + img.reason + ')' : ''}`);
  }
  // 通常版の公式ページ（突き合わせ用。master は変えない）
  fs.mkdirSync(BASE_CACHE_DIR, { recursive: true });
  for (const id of IDS) {
    const base = id.replace(/_p\d+$/, '');
    const f = path.join(BASE_CACHE_DIR, base + '.json');
    if (fs.existsSync(f)) continue;
    if (DRY_RUN) { console.log(`  [dry] 通常版 ${base}`); continue; }
    await sleep(REQUEST_DELAY_MS);
    const html = await fetchHtml(`https://www.gundam-gcg.com/jp/cards/detail.php?detailSearch=${base}`);
    const e = html ? parseCard(html, base, base.slice(0, 4)) : null;
    if (!e) { failed.push(base); console.warn(`  ✗ 通常版 ${base}: 取得・パース失敗`); continue; }
    fs.writeFileSync(f, JSON.stringify(e, null, 2), 'utf-8');
    console.log(`  ✓ 通常版 ${base}: ${e.name_jp} [${e.rarity}]`);
  }
  return { fetched, cached, imaged, failed, warns, imgNotes };
}

function merge() {
  const raw = fs.readFileSync(MASTER_PATH, 'utf-8');
  const master = JSON.parse(raw);
  const beforeKeys = Object.keys(master);
  const before = JSON.parse(raw);

  const entries = []; const allDiffs = []; const allNotes = [];
  for (const id of IDS) {
    const cacheFile = path.join(CACHE_DIR, id + '.json');
    const base = id.replace(/_p\d+$/, '');
    const baseFile = path.join(BASE_CACHE_DIR, base + '.json');
    if (!fs.existsSync(cacheFile) || !fs.existsSync(baseFile)) { console.error(`マージ中止: ${id} か通常版 ${base} が未取得です（全件取得後に --merge してください）`); process.exit(1); }
    const par = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    const offBase = JSON.parse(fs.readFileSync(baseFile, 'utf-8'));
    const masterBase = master[base];
    if (!masterBase) { console.error(`マージ中止: 通常版 ${base} が master にありません`); process.exit(1); }
    const cmp = compareOfficial(par, offBase);
    cmp.diffs.forEach((d) => allDiffs.push(`${id}: ${d}`));
    cmp.notes.forEach((n) => allNotes.push(`${id}: ${n}`));
    // master の通常版が、今の公式の通常版と名前・タイプ・色・Lv・COST・AP/HP で同じか（写し元の確かめ）
    for (const k of ['name_jp', 'card_type', 'color', 'level', 'cost', 'stats']) {
      if (offBase[k] === null && !(k in masterBase)) continue;
      if (!same(offBase[k], masterBase[k])) allDiffs.push(`${id}: master の通常版の ${k} ${JSON.stringify(masterBase[k])} が、今の公式の通常版 ${JSON.stringify(offBase[k])} と違う`);
    }
    entries.push(buildEntry(par, masterBase));
  }
  if (entries.length !== EXPECTED_COUNT) { console.error(`マージ中止: 件数 ${entries.length} ≠ 期待 ${EXPECTED_COUNT}`); process.exit(1); }
  for (const e of entries) {
    if (master[e.id]) { console.error(`マージ中止: ${e.id} は既に master に存在します`); process.exit(1); }
    if (!e.is_parallel || e.is_promo !== false || e.parallel_number !== 1 || !/_p1$/.test(e.id) || e.package_set !== e.base_card_id.slice(0, 4)) { console.error(`マージ中止: 不正エントリ ${e.id}`); process.exit(1); }
    if (!e.name_jp || !e.card_type || !e.rarity || !/\+$/.test(e.rarity)) { console.error(`マージ中止: 必須項目の欠け・レアリティが想定外 ${e.id}（${e.rarity}）`); process.exit(1); }
    const st = e.stats || {};
    if (e.card_type === 'PILOT' && !('ap_mod' in st) && !('hp_mod' in st)) { console.error(`マージ中止: PILOT なのに補正値が無い ${e.id}`); process.exit(1); }
  }
  if (allNotes.length) { console.log(`注記（${allNotes.length} 件）:`); allNotes.forEach((n) => console.log('  - ' + n)); }
  if (allDiffs.length) {
    console.error('マージ中止: パラレルと通常版で違う項目があります（別のカードか、公式の表記の違いの可能性。発行元が確かめる）:');
    allDiffs.forEach((d) => console.error('  ! ' + d));
    process.exit(1);
  }

  // 各パラレルを通常版の直後に差し込む（既存の並びは変えない）
  const byBase = {};
  for (const e of entries) byBase[e.base_card_id] = e;
  const out = {};
  for (const k of beforeKeys) {
    out[k] = master[k];
    if (byBase[k]) out[byBase[k].id] = byBase[k];
  }

  // 安全検証: 既存エントリが 1 件も変わっていない・並びも同じ・増えたのは 64 件だけ
  const outKeys = Object.keys(out);
  const existingOrder = outKeys.filter((k) => k in before);
  if (!same(existingOrder, beforeKeys)) { console.error('マージ中止: 既存の並びが変わった'); process.exit(1); }
  for (const k of beforeKeys) if (!same(out[k], before[k])) { console.error(`マージ中止: 既存エントリ ${k} が変化（追記のみのはず）`); process.exit(1); }
  const added = outKeys.filter((k) => !(k in before));
  if (added.length !== EXPECTED_COUNT || added.some((k) => !IDS.includes(k))) { console.error(`マージ中止: 想定外の追加キー ${added.join(',')}`); process.exit(1); }
  for (const e of entries) { const i = outKeys.indexOf(e.id); if (outKeys[i - 1] !== e.base_card_id) { console.error(`マージ中止: ${e.id} が通常版の直後にない`); process.exit(1); } }

  const text = JSON.stringify(out, null, 2);
  if (DRY_RUN) {
    console.log(`[dry] 追加予定 ${entries.length} 件（master 未書込）:`);
    for (const e of entries) console.log(`  + ${e.id} ${e.name_jp} [${e.rarity}/${e.color}/${e.card_type}] stats=${JSON.stringify(e.stats)} ← ${e.acquisition_info || ''}`);
    console.log(`  総数: ${beforeKeys.length} → ${outKeys.length}（予定）`);
    return;
  }
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.copyFileSync(MASTER_PATH, path.join(BACKUP_DIR, 'cards_master.json.bak'));
  fs.writeFileSync(MASTER_PATH, text, 'utf-8');
  console.log(`マージ完了: +${entries.length} 件 / 総数 ${beforeKeys.length} → ${outKeys.length}`);
  console.log(`  バックアップ: ${path.join(BACKUP_DIR, 'cards_master.json.bak')}`);
  console.log('  → 次に CLAUDE.md の手順（派生JSON → ページ再生成 → sitemap の順序）で作り直してください。');
}

async function main() {
  if (DO_MERGE) { merge(); return; }
  const r = await fetchAll();
  console.log('\n--- 取得結果 ---');
  console.log(`新規取得 ${r.fetched} / キャッシュ済 ${r.cached} / 画像取得 ${r.imaged} / 失敗 ${r.failed.length}`);
  if (r.warns.length) { console.log('警告:'); r.warns.forEach((w) => console.log('  ! ' + w)); }
  if (r.imgNotes.length) { console.log('画像の注意:'); r.imgNotes.forEach((w) => console.log('  ! ' + w)); }
  if (r.failed.length) console.log('失敗一覧:', r.failed.join(','));
  if (!r.failed.length && !DRY_RUN) console.log(`全 ${IDS.length} 件取得済み。--merge でマージできます`);
}

main().catch((e) => { console.error('致命的エラー:', e.message); process.exit(1); });
// EOF
