#!/usr/bin/env node
/**
 * scripts/fetch-beta-token-parallels.js  (2026-07-28)
 * リミテッドBOX Ver.β 収録のトークンパラレル4種を公式から取得し、cards_master.json へ登録する。
 *
 * 背景（2026-07-28 scripts/check-official-cardlist-sync.js で検出）:
 *  - 公式「リミテッドBOX Ver.β」83種のうち、T-001_p1 / T-002_p1 / T-003_p1 / T-006_p1 が master 未登録だった。
 *  - master は β 収録のパラレルを75件収録済みだが、そのうち TOKEN は0件。トークンだけが漏れていた。
 *  - master はトークンのパラレル自体は除外していない（T-015_p1〜T-020_p1 を PROMO として収録済み）ため、
 *    本4件も収録するのが既存方針と整合する（松岡さん承認 2026-07-28）。
 *  - 原因は scripts/fetch-promos.js の classify()（100-106行）が入手情報に「β」を含むものを
 *    package_set='β' の「取得対象外（報告のみ）」に分類するため。β パラレルを取り込んだ別作業の
 *    対象からトークンが漏れたものと見られる（可能性）。
 *
 * トークンのデータ規約（master 既存エントリに合わせる。公式表記とは異なる点に注意）:
 *  - 公式は rarity="C" / タイプ="UNIT TOKEN" と表示するが、master は rarity="T" / card_type="TOKEN" に正規化する
 *  - level / cost キーは持たない。effect_text は空文字（公式の能力欄は "-"）。effect キーも持たない
 *  - キー順: id, name_jp, rarity, card_type, color, traits, stats, source_title, package_set,
 *            effect_text, terrain, acquisition_info, is_parallel, is_promo, parallel_number, base_card_id, link
 *  - package_set は収録商品基準で 'β'、is_promo=false（β は promo 扱いしない。classify() と同じ規則）
 *
 * 設計は scripts/fetch-gd05-reprint-parallels.js を踏襲（1.5秒間隔・キャッシュ再開・追記のみ・バックアップ）。
 *
 * 使い方（E:\GCGSTATS）:
 *   node scripts\fetch-beta-token-parallels.js --dry-run          # 列挙のみ
 *   node scripts\fetch-beta-token-parallels.js                    # 取得（キャッシュ済はスキップ／画像のみDL）
 *   node scripts\fetch-beta-token-parallels.js --merge --dry-run  # マージ内容の確認のみ
 *   node scripts\fetch-beta-token-parallels.js --merge            # cards_master.json へ追記
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const cheerio = require('cheerio');

const ROOT = path.resolve(__dirname, '..');
const MASTER_PATH = process.env.CARDS_MASTER_PATH || path.join(ROOT, 'data', 'cards_master.json');
const IMG_DIR = path.join(ROOT, 'images', 'cards');
const CACHE_DIR = process.env.BETA_TOKEN_CACHE || path.join(ROOT, 'tmp', 'beta-token-cache');
const BACKUP_DIR = path.join(ROOT, 'tmp', 'beta-token-backup-20260728');
const REQUEST_DELAY_MS = 1500; // 公式サーバ配慮（変更禁止）
const MIN_SIZE = 1000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const REFERER = 'https://www.gundam-gcg.com/jp/';

const IDS = ['T-001_p1', 'T-002_p1', 'T-003_p1', 'T-006_p1'];
const EXPECTED_COUNT = 4;
const TARGET_SET = 'β';

const args = process.argv.slice(2);
const DO_MERGE = args.includes('--merge');
const DRY_RUN = args.includes('--dry-run');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html' } }, (res) => {
      if (res.statusCode !== 200) { resolve(null); res.resume(); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}
function isWebp(b) { return b.length > 12 && b.slice(0, 4).toString('ascii') === 'RIFF' && b.slice(8, 12).toString('ascii') === 'WEBP'; }
function downloadImage(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 5) { resolve({ ok: false, reason: 'too-many-redirects' }); return; }
    https.get(new URL(url), { headers: { 'User-Agent': USER_AGENT, 'Referer': REFERER } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) { res.resume(); resolve(downloadImage(res.headers.location, depth + 1)); return; }
      if (res.statusCode !== 200) { res.resume(); resolve({ ok: false, reason: 'http ' + res.statusCode }); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { const b = Buffer.concat(chunks); resolve((b.length > MIN_SIZE && isWebp(b)) ? { ok: true, buf: b, size: b.length } : { ok: false, reason: 'invalid(' + b.length + ')' }); });
    }).on('error', reject);
  });
}

/** トークン専用パース。master のトークン規約（rarity=T / card_type=TOKEN / level,cost なし）に正規化する */
function parseToken(html, cardId) {
  const $ = cheerio.load(html);
  const name = $('h1.cardName').first().text().trim();
  if (!name) return null;
  const fields = {};
  $('.dataBox').each((_, el) => {
    const k = $(el).find('.dataTit').first().text().trim();
    const v = $(el).find('.dataTxt').first().text().trim();
    if (k) fields[k] = v;
  });
  const officialType = fields['タイプ'] || '';
  if (!/TOKEN/i.test(officialType)) return { __notToken: true, officialType };

  const numOrNull = (v) => { const n = parseInt(String(v).replace(/[^\d-]/g, ''), 10); return Number.isFinite(n) ? n : null; };
  const traits = (fields['特徴'] || '').match(/〔([^〕]+)〕/g);
  let effect = '';
  const ov = $('.cardDataRow.overview .dataTxt').first();
  if (ov.length) {
    effect = ov.html() ? ov.html().replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '').trim() : '';
    effect = effect.split('\n').map((l) => l.trim()).filter(Boolean).join('');
  }
  if (effect === '-') effect = ''; // 公式の「能力なし」表記 → master は空文字

  const m = cardId.match(/^(.*)_p(\d+)$/);
  const entry = {
    id: cardId,
    name_jp: name,
    rarity: 'T',            // 公式は "C" 表示だが master はトークンを T に正規化
    card_type: 'TOKEN',     // 公式は "UNIT TOKEN"
    color: fields['色'] || '-',
    traits: traits ? traits.map((t) => t.replace(/[〔〕]/g, '')) : [],
    stats: {},
    source_title: fields['出典タイトル'] || '',
    package_set: TARGET_SET,
    effect_text: effect,
    terrain: fields['地形'] || '-',
    acquisition_info: fields['入手情報'] || '',
    is_parallel: true,
    is_promo: false,        // β は promo 扱いしない（fetch-promos.js classify() と同規則）
    parallel_number: parseInt(m[2], 10),
    base_card_id: m[1],
    link: [],
  };
  const ap = numOrNull(fields['AP']); const hp = numOrNull(fields['HP']);
  if (ap !== null) entry.stats.ap = ap;
  if (hp !== null) entry.stats.hp = hp;
  return entry;
}

async function saveImage(id, base) {
  const dest = path.join(IMG_DIR, `${id}.webp`);
  if (fs.existsSync(dest)) { try { if (isWebp(fs.readFileSync(dest))) return { status: 'exists' }; } catch (e) {} }
  await sleep(REQUEST_DELAY_MS);
  const r = await downloadImage(`https://www.gundam-gcg.com/jp/images/cards/card/${id}.webp`);
  if (r.ok) { if (!DRY_RUN) fs.writeFileSync(dest, r.buf); return { status: 'downloaded', size: r.size }; }
  const bi = path.join(IMG_DIR, `${base}.webp`);
  if (fs.existsSync(bi)) { if (!DRY_RUN) fs.copyFileSync(bi, dest); return { status: 'fallback-base', reason: r.reason }; }
  return { status: 'image-failed', reason: r.reason };
}

async function fetchAll() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  let fetched = 0, cached = 0, imaged = 0;
  const failed = [], warns = [];
  for (const id of IDS) {
    const base = id.replace(/_p\d+$/, '');
    const cacheFile = path.join(CACHE_DIR, id + '.json');
    if (fs.existsSync(cacheFile)) {
      cached++;
      if (DRY_RUN) { console.log(`  = ${id}: データはキャッシュ済（dry-run のため画像は未取得）`); continue; }
      const img = await saveImage(id, base);
      if (img.status !== 'exists') imaged++;
      console.log(`  = ${id}: データはキャッシュ済 / 画像:${img.status}${img.reason ? '(' + img.reason + ')' : ''}`);
      continue;
    }
    if (DRY_RUN) { console.log(`  [dry] ${id} (base=${base})`); continue; }
    await sleep(REQUEST_DELAY_MS);
    const html = await fetchHtml(`https://www.gundam-gcg.com/jp/cards/detail.php?detailSearch=${id}`);
    if (!html) { failed.push(id); console.warn(`  ✗ ${id}: 未掲載(302)or取得失敗`); continue; }
    const entry = parseToken(html, id);
    if (!entry) { failed.push(id); console.warn(`  ✗ ${id}: パース失敗`); continue; }
    if (entry.__notToken) { failed.push(id); console.warn(`  ✗ ${id}: TOKEN ではありません（タイプ=${entry.officialType}）。本スクリプトの対象外`); continue; }
    if (!/β/.test(entry.acquisition_info)) warns.push(`${id}: 入手情報が想定外「${entry.acquisition_info || '(なし)'}」`);
    const img = await saveImage(id, base);
    if (img.status !== 'exists') imaged++;
    fs.writeFileSync(cacheFile, JSON.stringify(entry, null, 2), 'utf-8');
    fetched++;
    console.log(`  ✓ ${id}: ${entry.name_jp} [${entry.rarity}/${entry.card_type}] AP${entry.stats.ap}/HP${entry.stats.hp} 画像:${img.status}`);
  }
  return { fetched, cached, imaged, failed, warns };
}

function merge() {
  const master = JSON.parse(fs.readFileSync(MASTER_PATH, 'utf-8'));
  const before = JSON.parse(JSON.stringify(master));
  const entries = [];
  for (const id of IDS) {
    const f = path.join(CACHE_DIR, id + '.json');
    if (!fs.existsSync(f)) { console.error(`マージ中止: ${id} が未取得です`); process.exit(1); }
    entries.push(JSON.parse(fs.readFileSync(f, 'utf-8')));
  }
  if (entries.length !== EXPECTED_COUNT) { console.error(`マージ中止: 件数 ${entries.length} ≠ 期待 ${EXPECTED_COUNT}`); process.exit(1); }

  const beforeBeta = Object.values(before).filter((v) => v.package_set === TARGET_SET).length;
  for (const e of entries) {
    if (master[e.id]) { console.error(`マージ中止: ${e.id} は既に存在します`); process.exit(1); }
    if (!master[e.base_card_id]) { console.error(`マージ中止: ベースカード ${e.base_card_id} が master にありません`); process.exit(1); }
    if (e.card_type !== 'TOKEN' || e.rarity !== 'T') { console.error(`マージ中止: トークン規約違反 ${e.id}`); process.exit(1); }
    if (e.package_set !== TARGET_SET || e.is_promo !== false || !e.is_parallel) { console.error(`マージ中止: 不正エントリ ${e.id}`); process.exit(1); }
    if ('level' in e || 'cost' in e || 'effect' in e) { console.error(`マージ中止: トークンに不要なキーがあります ${e.id}`); process.exit(1); }
    const b = master[e.base_card_id];
    if (b.name_jp !== e.name_jp || JSON.stringify(b.stats) !== JSON.stringify(e.stats)) {
      console.error(`マージ中止: ベースカードと内容が一致しません ${e.id}（名称/AP/HP）`); process.exit(1);
    }
  }

  if (DRY_RUN) {
    console.log(`[dry] 追加予定 ${entries.length} 件（master 未書込）:`);
    for (const e of entries) console.log(`  + ${e.id} ${e.name_jp} [${e.rarity}/${e.card_type}] AP${e.stats.ap}/HP${e.stats.hp} ← ${e.acquisition_info}`);
    console.log(`  β 件数: ${beforeBeta} → ${beforeBeta + entries.length}（予定）`);
    console.log(`  総数: ${Object.keys(before).length} → ${Object.keys(before).length + entries.length}（予定）`);
    return;
  }

  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  fs.copyFileSync(MASTER_PATH, path.join(BACKUP_DIR, 'cards_master.json.bak'));

  for (const e of entries) master[e.id] = e;
  const sorted = {};
  Object.keys(master).sort((a, b) => a.localeCompare(b)).forEach((k) => { sorted[k] = master[k]; });

  for (const [id, card] of Object.entries(before)) {
    if (JSON.stringify(sorted[id]) !== JSON.stringify(card)) { console.error(`マージ中止: 既存エントリ ${id} が変化`); process.exit(1); }
  }
  const added = Object.keys(sorted).filter((k) => !(k in before));
  if (added.length !== EXPECTED_COUNT || added.some((k) => !IDS.includes(k))) {
    console.error(`マージ中止: 想定外の追加キー ${added.join(',')}`); process.exit(1);
  }

  fs.writeFileSync(MASTER_PATH, JSON.stringify(sorted, null, 2), 'utf-8');
  console.log(`マージ完了: +${entries.length} 件 / 総数 ${Object.keys(before).length} → ${Object.keys(sorted).length}`);
  console.log(`  β 件数: ${beforeBeta} → ${beforeBeta + entries.length}`);
  console.log(`  バックアップ: ${path.join(BACKUP_DIR, 'cards_master.json.bak')}`);
  console.log('  → 次に generate_cards.js / generate_cardlist.js / generate_deckbuilder.js / generate-sitemap-extra.js');
}

(async () => {
  if (DO_MERGE) { merge(); return; }
  const r = await fetchAll();
  console.log('\n--- 取得結果 ---');
  console.log(`新規取得 ${r.fetched} / キャッシュ済 ${r.cached} / 画像取得 ${r.imaged} / 失敗 ${r.failed.length}`);
  if (r.warns.length) { console.log('警告:'); r.warns.forEach((w) => console.log('  ! ' + w)); }
  if (r.failed.length) console.log('失敗一覧: ' + r.failed.join(','));
  if (!r.failed.length && !DRY_RUN) console.log(`全 ${IDS.length} 件取得済み。--merge でマージできます`);
})().catch((e) => { console.error('致命的エラー:', e.message); process.exit(1); });
// EOF
