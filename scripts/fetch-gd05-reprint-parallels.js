#!/usr/bin/env node
/**
 * scripts/fetch-gd05-reprint-parallels.js  (2026-07-28)
 * Freedom Ascension [GD05] に「過去弾の型番のまま」再録されたパラレル8種を
 * 公式カードリストから取得し、cards_master.json へ登録する。
 *
 * 背景（機械確認 2026-07-28）:
 *  - 公式カード検索 package=615105（Freedom Ascension [GD05]）は197種を返す。
 *    このうち下記8種は型番の頭が GD05 ではなく ST01/ST02/ST03/ST04/ST07/GD01 である。
 *  - scripts/fetch-parallels.js は BASE_SETS の弾コード連番（GD05-001.._p9 等）しか
 *    照会IDを組み立てないため（43行・158-162行）、これら8種には照会が届かない。
 *  - scripts/fetch-promos.js は全基本カードを走査するが、入手情報に [GD05] があると
 *    classify() が「弾内パラレル＝取得対象外（報告のみ）」と判定する（100-106行・138-140行）。
 *  - 結果として両スクリプトの担当範囲の隙間に落ち、8種が cards_master.json 未登録だった。
 *
 * 設計は scripts/fetch-sc01-parallels.js (2026-07-11 承認済) を踏襲:
 *  - detail.php?detailSearch={id} を 1.5 秒間隔で取得（公式サーバ配慮、変更禁止）
 *  - tmp/gd05-reprint-cache/{id}.json にキャッシュ（再実行で続きから）
 *  - 画像は images/cards/{id}.webp へ保存。公式に無ければ通常版({base}.webp)を流用
 *  - --merge は追記のみ（既存エントリ変更を検知したら中止）。マージ前にバックアップ
 *  - package_set は 'GD05'（収録商品基準。SC01 / β / EB01(ST10-006_p2) と同じ規則）
 *
 * SC01版からの変更点（1点のみ・意図的）:
 *  - AP/HP が "+2" のように符号付きで返る場合は stats.ap_mod / stats.hp_mod に格納する。
 *    cards_master.json の PILOT 237件中235件が ap_mod/hp_mod 形式であり、
 *    generate_cardlist.js 228行 / generate_cards.js 1046行 もこの形式を参照するため。
 *    （SC01版は ap/hp 固定で取り込み後に手直しが必要だった）
 *    符号なし（UNIT等の絶対値）は従来どおり stats.ap / stats.hp に格納する。
 *
 * 使い方:
 *   node scripts/fetch-gd05-reprint-parallels.js --dry-run          # 列挙のみ
 *   node scripts/fetch-gd05-reprint-parallels.js                    # 取得（キャッシュ済はスキップ）
 *   node scripts/fetch-gd05-reprint-parallels.js --merge --dry-run  # マージ内容の確認のみ
 *   node scripts/fetch-gd05-reprint-parallels.js --merge            # cards_master.json へ追記
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const cheerio = require('cheerio');

const ROOT = path.resolve(__dirname, '..');
const MASTER_PATH = process.env.CARDS_MASTER_PATH || path.join(ROOT, 'data', 'cards_master.json');
const IMG_DIR = path.join(ROOT, 'images', 'cards');
const CACHE_DIR = process.env.GD05_REPRINT_CACHE || path.join(ROOT, 'tmp', 'gd05-reprint-cache');
const BACKUP_DIR = path.join(ROOT, 'tmp', 'gd05-reprint-backup-20260728');
const REQUEST_DELAY_MS = 1500; // 公式サーバ配慮（fetch-official-cardlist.js と同値、変更禁止）
const MIN_SIZE = 1000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REFERER = 'https://www.gundam-gcg.com/jp/';

// 公式 package=615105 の197種のうち、型番の頭が GD05 でない8種（2026-07-28 取得）
const IDS = [
  'ST01-010_p4', // アムロ・レイ
  'ST01-011_p5', // スレッタ・マーキュリー
  'ST02-010_p5', // ヒイロ・ユイ
  'ST03-010_p2', // フル・フロンタル
  'ST03-011_p4', // シャア・アズナブル
  'ST04-010_p6', // キラ・ヤマト
  'ST07-009_p3', // 刹那・F・セイエイ
  'GD01-093_p2', // マリーダ・クルス
];
const EXPECTED_COUNT = 8;
const TARGET_SET = 'GD05';

const args = process.argv.slice(2);
const DO_MERGE = args.includes('--merge');
const DRY_RUN = args.includes('--dry-run');
const budgetArg = args.find((a) => a.startsWith('--budget-ms'));
const BUDGET_MS = budgetArg ? parseInt(budgetArg.split('=')[1] || args[args.indexOf(budgetArg) + 1], 10) : 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html' } }, (res) => {
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
    if (depth > 5) { resolve({ ok: false, reason: 'too-many-redirects' }); return; }
    https.get(new URL(url), { headers: { 'User-Agent': USER_AGENT, 'Referer': REFERER } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        res.resume();
        resolve(downloadImage(res.headers.location, depth + 1));
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

// fetch-sc01-parallels.js parseCard と同じ（AP/HP の符号付き判定のみ追加）
function parseCard(html, cardId) {
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
    rarity: (text('.cardNoCol .rarity') || '').replace(/\s+/g, ''), // "C +" -> "C+"
    card_type: fields['タイプ'] || '',
    color: fields['色'] || '',
    level: numOrNull(fields['Lv.']),
    cost: numOrNull(fields['COST']),
    traits: traits ? traits.map((t) => t.replace(/[〔〕]/g, '')) : [],
    stats: {},
    source_title: fields['出典タイトル'] || '',
    link: links ? links.map((l) => l.replace(/[「」]/g, '')) : [],
    package_set: TARGET_SET, // 収録商品基準（SC01 / β と同じ規則）
    effect_text: effect,
    effect: effect,
  };
  if (fields['地形']) entry.terrain = fields['地形'];
  if (fields['入手情報']) entry.acquisition_info = fields['入手情報'];
  // AP/HP: "+2" のような符号付きは補正値(ap_mod/hp_mod)、符号なしは絶対値(ap/hp)
  const apRaw = fields['AP']; const hpRaw = fields['HP'];
  const ap = numOrNull(apRaw); const hp = numOrNull(hpRaw);
  if (ap !== null) { if (/^\s*[+＋]/.test(String(apRaw))) entry.stats.ap_mod = ap; else entry.stats.ap = ap; }
  if (hp !== null) { if (/^\s*[+＋]/.test(String(hpRaw))) entry.stats.hp_mod = hp; else entry.stats.hp = hp; }
  return entry;
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
  const started = Date.now();
  let fetched = 0, cached = 0, imaged = 0;
  const failed = [];
  const warns = [];
  for (const id of IDS) {
    const base = id.replace(/_p\d+$/, '');
    const pn = parseInt(id.match(/_p(\d+)$/)[1], 10);
    const cacheFile = path.join(CACHE_DIR, id + '.json');
    if (BUDGET_MS && Date.now() - started > BUDGET_MS) {
      console.log(`[時間予算] ${BUDGET_MS}ms 到達。処理済 ${cached + fetched}/${IDS.length} で中断(再実行で続きから)`);
      return { fetched, cached, imaged, failed, warns, done: false };
    }
    if (fs.existsSync(cacheFile)) {
      cached++;
      // データはキャッシュ済でも画像が未取得なら取りに行く
      if (!DRY_RUN) {
        const img = await saveImage(id, base);
        if (img.status !== 'exists') imaged++;
        console.log(`  = ${id}: データはキャッシュ済 / 画像:${img.status}${img.reason ? '(' + img.reason + ')' : ''}`);
      } else {
        console.log(`  = ${id}: データはキャッシュ済（dry-run のため画像は未取得）`);
      }
      continue;
    }
    if (DRY_RUN) { console.log(`  [dry] ${id} (base=${base}, p=${pn})`); continue; }
    await sleep(REQUEST_DELAY_MS);
    const html = await fetchHtml(`https://www.gundam-gcg.com/jp/cards/detail.php?detailSearch=${id}`);
    if (!html) { failed.push(id); console.warn(`  ✗ ${id}: 未掲載(302)or取得失敗`); continue; }
    const entry = parseCard(html, id);
    if (!entry) { failed.push(id); console.warn(`  ✗ ${id}: パース失敗`); continue; }
    entry.is_parallel = true;
    entry.is_promo = false;
    entry.parallel_number = pn;
    entry.base_card_id = base;
    if (!entry.acquisition_info || !/GD05/.test(entry.acquisition_info)) {
      warns.push(`${id}: 入手情報が想定外「${entry.acquisition_info || '(なし)'}」`);
    }
    const img = await saveImage(id, base);
    if (img.status !== 'exists') imaged++;
    fs.writeFileSync(cacheFile, JSON.stringify(entry, null, 2), 'utf-8');
    fetched++;
    console.log(`  ✓ ${id}: ${entry.name_jp} [${entry.rarity}/${entry.color}/${entry.card_type}] 画像:${img.status}${img.reason ? '(' + img.reason + ')' : ''}`);
  }
  return { fetched, cached, imaged, failed, warns, done: true };
}

function merge() {
  const master = JSON.parse(fs.readFileSync(MASTER_PATH, 'utf-8'));
  const before = JSON.parse(JSON.stringify(master));

  // キャッシュ全件チェック
  const entries = [];
  for (const id of IDS) {
    const cacheFile = path.join(CACHE_DIR, id + '.json');
    if (!fs.existsSync(cacheFile)) {
      console.error(`マージ中止: ${id} が未取得です（全件取得後に --merge してください）`);
      process.exit(1);
    }
    entries.push(JSON.parse(fs.readFileSync(cacheFile, 'utf-8')));
  }
  if (entries.length !== EXPECTED_COUNT) {
    console.error(`マージ中止: 件数 ${entries.length} ≠ 期待 ${EXPECTED_COUNT}`);
    process.exit(1);
  }

  // 事前検証: 追加キーが master に未存在であること／base が存在すること／規約どおりであること
  const beforeGd05 = Object.values(before).filter((v) => v.package_set === TARGET_SET).length;
  for (const e of entries) {
    if (master[e.id]) { console.error(`マージ中止: ${e.id} は既に master に存在します`); process.exit(1); }
    if (!master[e.base_card_id]) { console.error(`マージ中止: ベースカード ${e.base_card_id} が master にありません`); process.exit(1); }
    if (!e.is_parallel || e.is_promo !== false || !/_p\d+$/.test(e.id) || e.package_set !== TARGET_SET) {
      console.error(`マージ中止: 不正エントリ ${e.id}`); process.exit(1);
    }
    if (!e.name_jp || !e.card_type || !e.rarity) {
      console.error(`マージ中止: 必須項目欠損 ${e.id}`); process.exit(1);
    }
    const st = e.stats || {};
    if (e.card_type === 'PILOT' && !('ap_mod' in st) && !('hp_mod' in st)) {
      console.error(`マージ中止: PILOT なのに補正値が無い ${e.id}`); process.exit(1);
    }
  }

  if (DRY_RUN) {
    console.log(`[dry] 追加予定 ${entries.length} 件（master 未書込）:`);
    for (const e of entries) {
      console.log(`  + ${e.id} ${e.name_jp} [${e.rarity}/${e.color}/${e.card_type}] stats=${JSON.stringify(e.stats)} ← ${e.acquisition_info || ''}`);
    }
    console.log(`  GD05 件数: ${beforeGd05} → ${beforeGd05 + entries.length}（予定）`);
    console.log(`  総数: ${Object.keys(before).length} → ${Object.keys(before).length + entries.length}（予定）`);
    return;
  }

  // バックアップ
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.copyFileSync(MASTER_PATH, path.join(BACKUP_DIR, 'cards_master.json.bak'));

  for (const e of entries) master[e.id] = e;

  // キー順を ID 昇順に整列（fetch-sc01-parallels.js / merge-gd04.js と同じ流儀）
  const sorted = {};
  Object.keys(master).sort((a, b) => a.localeCompare(b)).forEach((k) => { sorted[k] = master[k]; });

  // 安全検証: 既存エントリが1件も変化していないこと（追記のみ）
  for (const [id, card] of Object.entries(before)) {
    if (JSON.stringify(sorted[id]) !== JSON.stringify(card)) {
      console.error(`マージ中止: 既存エントリ ${id} が変化（追記のみのはず）`);
      process.exit(1);
    }
  }
  // 安全検証: 増えたキーが今回の8件のみであること
  const added = Object.keys(sorted).filter((k) => !(k in before));
  if (added.length !== EXPECTED_COUNT || added.some((k) => !IDS.includes(k))) {
    console.error(`マージ中止: 想定外の追加キー ${added.join(',')}`);
    process.exit(1);
  }
  const gd05Count = Object.values(sorted).filter((v) => v.package_set === TARGET_SET).length;
  if (gd05Count !== beforeGd05 + EXPECTED_COUNT) {
    console.error(`マージ中止: GD05 件数 ${gd05Count} ≠ 期待 ${beforeGd05 + EXPECTED_COUNT}`);
    process.exit(1);
  }

  fs.writeFileSync(MASTER_PATH, JSON.stringify(sorted, null, 2), 'utf-8');
  console.log(`マージ完了: +${entries.length} 件 / 総数 ${Object.keys(before).length} → ${Object.keys(sorted).length}`);
  console.log(`  GD05 件数: ${beforeGd05} → ${gd05Count}`);
  console.log(`  バックアップ: ${path.join(BACKUP_DIR, 'cards_master.json.bak')}`);
  console.log('  → 次に node generate_cards.js / node generate_cardlist.js / node generate_deckbuilder.js / node generate-sitemap-extra.js を実行してください。');
}

async function main() {
  if (DO_MERGE) { merge(); return; }
  const r = await fetchAll();
  console.log('\n--- 取得結果 ---');
  console.log(`新規取得 ${r.fetched} / キャッシュ済 ${r.cached} / 画像取得 ${r.imaged} / 失敗 ${r.failed.length} / 完了=${r.done}`);
  if (r.warns && r.warns.length) { console.log('警告:'); r.warns.forEach((w) => console.log('  ! ' + w)); }
  if (r.failed.length) console.log('失敗一覧:', r.failed.join(','));
  if (r.done && !r.failed.length && !DRY_RUN) console.log(`全 ${IDS.length} 件取得済み。--merge でマージできます`);
}

main().catch((e) => { console.error('致命的エラー:', e.message); process.exit(1); });
// EOF
