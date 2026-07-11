#!/usr/bin/env node
/**
 * scripts/fetch-sc01-parallels.js  (2026-07-11)
 * カスタムデッキボックス Freedom Ascension [SC01] 収録のパラレル45種を
 * 公式カードリストから取得し、cards_master.json へ登録する。
 *
 * 出典（機械確認 2026-07-11）:
 *  - 公式カード検索 package=615301（カスタムデッキボックス Freedom Ascension [SC01]）は48種を返す。
 *  - うち R-001_p7 / EXB-001_p7 / EXR-001_p7 の3種は RESOURCE / EX BASE / EX RESOURCE で、
 *    cards_master.json の収載対象外（β・EB01パラレル追加時と同じ前例。松岡さん承認 2026-07-11）。
 *  - 残り45種（下記 IDS）を登録対象とする。
 *
 * 設計は scripts/fetch-parallels.js (作業②-2b) を踏襲:
 *  - detail.php?detailSearch={id} を 1.5 秒間隔で取得（公式サーバ配慮、変更禁止）
 *  - tmp/sc01-parallels-cache/{id}.json にキャッシュ（再実行で続きから）
 *  - 画像は images/cards/{id}.webp へ保存。公式に無ければ通常版を流用
 *  - --merge は追記のみ（既存エントリ変更を検知したら中止）。マージ前にバックアップ
 *  - package_set は 'SC01'（収録商品基準。β / EB01(ST10-006_p2修正) と同じ規則）
 *
 * 使い方:
 *   node scripts/fetch-sc01-parallels.js --dry-run          # 列挙のみ
 *   node scripts/fetch-sc01-parallels.js --budget-ms 35000  # 取得（時間予算・再実行で続き）
 *   node scripts/fetch-sc01-parallels.js --merge            # cards_master.json へ追記
 *   node scripts/fetch-sc01-parallels.js --merge --dry-run  # マージ内容の確認のみ
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const cheerio = require('cheerio');

const ROOT = path.resolve(__dirname, '..');
const MASTER_PATH = process.env.CARDS_MASTER_PATH || path.join(ROOT, 'data', 'cards_master.json');
const IMG_DIR = path.join(ROOT, 'images', 'cards');
const CACHE_DIR = process.env.SC01_CACHE || path.join(ROOT, 'tmp', 'sc01-parallels-cache');
const BACKUP_DIR = path.join(ROOT, 'tmp', 'sc01-backup-20260711');
const REQUEST_DELAY_MS = 1500; // 公式サーバ配慮（fetch-official-cardlist.js と同値、変更禁止）
const MIN_SIZE = 1000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REFERER = 'https://www.gundam-gcg.com/jp/';

// 公式 package=615301 の48種から R-001_p7 / EXB-001_p7 / EXR-001_p7 を除いた45種（2026-07-11 取得）
const IDS = [
  'ST01-001_p8', 'ST01-010_p5', 'ST01-014_p8',
  'ST02-001_p4', 'ST02-010_p6',
  'ST03-001_p2', 'ST03-010_p3', 'ST03-013_p5', 'ST03-015_p2',
  'ST04-001_p5', 'ST04-010_p7', 'ST04-015_p6',
  'ST05-001_p3', 'ST05-010_p5', 'ST05-014_p5',
  'ST08-015_p2',
  'GD01-002_p3', 'GD01-004_p3', 'GD01-005_p4', 'GD01-008_p3',
  'GD01-025_p2', 'GD01-029_p2', 'GD01-030_p2', 'GD01-035_p1',
  'GD01-051_p3', 'GD01-052_p1', 'GD01-065_p3', 'GD01-069_p2',
  'GD01-086_p3', 'GD01-088_p4', 'GD01-090_p4', 'GD01-093_p3',
  'GD01-096_p3', 'GD01-100_p6', 'GD01-107_p4', 'GD01-111_p4',
  'GD01-118_p7', 'GD01-126_p1',
  'GD02-037_p2', 'GD02-055_p2', 'GD02-058_p2',
  'GD03-055_p2', 'GD03-068_p1', 'GD03-097_p1', 'GD03-129_p1',
];
const EXPECTED_COUNT = 45;

const args = process.argv.slice(2);
const DO_MERGE = args.includes('--merge');
const DRY_RUN = args.includes('--dry-run');
const budgetArg = args.find(a => a.startsWith('--budget-ms'));
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

// fetch-parallels.js parseCard と同じ
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
    rarity: (text('.cardNoCol .rarity') || '').replace(/\s+/g, ''),
    card_type: fields['タイプ'] || '',
    color: fields['色'] || '',
    level: numOrNull(fields['Lv.']),
    cost: numOrNull(fields['COST']),
    traits: traits ? traits.map((t) => t.replace(/[〔〕]/g, '')) : [],
    stats: {},
    source_title: fields['出典タイトル'] || '',
    link: links ? links.map((l) => l.replace(/[「」]/g, '')) : [],
    package_set: 'SC01', // 収録商品基準（βと同じ規則）
    effect_text: effect,
    effect: effect,
  };
  if (fields['地形']) entry.terrain = fields['地形'];
  if (fields['入手情報']) entry.acquisition_info = fields['入手情報'];
  const ap = numOrNull(fields['AP']); const hp = numOrNull(fields['HP']);
  if (ap !== null) entry.stats.ap = ap;
  if (hp !== null) entry.stats.hp = hp;
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
  let fetched = 0, cached = 0;
  const failed = [];
  const warns = [];
  for (const id of IDS) {
    const base = id.replace(/_p\d+$/, '');
    const pn = parseInt(id.match(/_p(\d+)$/)[1], 10);
    const cacheFile = path.join(CACHE_DIR, id + '.json');
    if (fs.existsSync(cacheFile)) { cached++; continue; }
    if (BUDGET_MS && Date.now() - started > BUDGET_MS) {
      console.log(`[時間予算] ${BUDGET_MS}ms 到達。取得済 ${cached + fetched}/${IDS.length} で中断(再実行で続きから)`);
      return { fetched, cached, failed, warns, done: false };
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
    if (!entry.acquisition_info || !/SC01/.test(entry.acquisition_info)) {
      warns.push(`${id}: 入手情報が想定外「${entry.acquisition_info || '(なし)'}」`);
    }
    const img = await saveImage(id, base);
    fs.writeFileSync(cacheFile, JSON.stringify(entry, null, 2), 'utf-8');
    fetched++;
    console.log(`  ✓ ${id}: ${entry.name_jp} [${entry.rarity}/${entry.color}] 画像:${img.status}${img.reason ? '(' + img.reason + ')' : ''}`);
  }
  return { fetched, cached, failed, warns, done: true };
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

  // 事前検証: 追加キーが master に未存在であること／base が存在すること
  for (const e of entries) {
    if (master[e.id]) { console.error(`マージ中止: ${e.id} は既に master に存在します`); process.exit(1); }
    if (!master[e.base_card_id]) { console.error(`マージ中止: ベースカード ${e.base_card_id} が master にありません`); process.exit(1); }
    if (!e.is_parallel || !/_p\d+$/.test(e.id) || e.package_set !== 'SC01') {
      console.error(`マージ中止: 不正エントリ ${e.id}`); process.exit(1);
    }
  }

  if (DRY_RUN) {
    console.log(`[dry] 追加予定 ${entries.length} 件（master 未書込）:`);
    for (const e of entries) console.log(`  + ${e.id} ${e.name_jp} [${e.rarity}/${e.color}] ${e.acquisition_info || ''}`);
    return;
  }

  // バックアップ
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.copyFileSync(MASTER_PATH, path.join(BACKUP_DIR, 'cards_master.json.bak'));

  for (const e of entries) master[e.id] = e;

  // キー順を ID 昇順に整列（merge-gd04.js と同じ流儀）
  const sorted = {};
  Object.keys(master).sort((a, b) => a.localeCompare(b)).forEach((k) => { sorted[k] = master[k]; });

  // 安全検証: 既存エントリが1件も変化していないこと（追記のみ）
  for (const [id, card] of Object.entries(before)) {
    if (JSON.stringify(sorted[id]) !== JSON.stringify(card)) {
      console.error(`マージ中止: 既存エントリ ${id} が変化（追記のみのはず）`);
      process.exit(1);
    }
  }
  const scCount = Object.values(sorted).filter((v) => v.package_set === 'SC01').length;
  if (scCount !== EXPECTED_COUNT) {
    console.error(`マージ中止: SC01 件数 ${scCount} ≠ 期待 ${EXPECTED_COUNT}`);
    process.exit(1);
  }

  fs.writeFileSync(MASTER_PATH, JSON.stringify(sorted, null, 2), 'utf-8');
  console.log(`マージ完了: +${entries.length} 件 / 総数 ${Object.keys(before).length} → ${Object.keys(sorted).length}`);
  console.log(`  バックアップ: ${path.join(BACKUP_DIR, 'cards_master.json.bak')}`);
  console.log('  → 次に node generate_cards.js / node generate_cardlist.js で再生成してください。');
}

async function main() {
  if (DO_MERGE) { merge(); return; }
  const r = await fetchAll();
  console.log(`取得 ${r.fetched} / キャッシュ済 ${r.cached} / 失敗 ${r.failed.length} / 完了=${r.done}`);
  if (r.warns && r.warns.length) { console.log('警告:'); r.warns.forEach((w) => console.log('  ! ' + w)); }
  if (r.failed.length) console.log('失敗一覧:', r.failed.join(','));
  if (r.done && !r.failed.length && !DRY_RUN) console.log(`全 ${IDS.length} 件取得済み。--merge でマージできます`);
}

main().catch((e) => { console.error('致命的エラー:', e.message); process.exit(1); });
// EOF
