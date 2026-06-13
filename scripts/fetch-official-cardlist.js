#!/usr/bin/env node
/**
 * scripts/fetch-official-cardlist.js (指示書v8 B-2)
 * 公式カードリスト(detail.php)から ST10/EB01 の正式カードデータを取得し、
 * cards_master.json へインクリメンタルにマージする。
 *
 * 設計:
 *  - 公式サーバー配慮の 1.5 秒間隔(REQUEST_DELAY_MS、fetch-card-texts.js と同値)を厳守
 *  - 取得結果はカード単位でキャッシュ(再実行時はキャッシュ再利用 → 細切れ実行で完走可能)
 *  - マージは対象セット(--sets で指定)のみ追加/上書きし、他セットには一切触れない
 *    (マージ後に「他セットの全エントリが変更前と完全一致」を検証、違反時は書き込まない)
 *
 * 使い方:
 *   node scripts/fetch-official-cardlist.js                       # 取得のみ(EB01=90, ST10=16)
 *   node scripts/fetch-official-cardlist.js --merge               # 全取得済みならマージ実行
 *   node scripts/fetch-official-cardlist.js --budget-ms 30000     # 1回の実行時間予算(細切れ用)
 *   OFFICIAL_CARDS_CACHE=/tmp/cache node scripts/...              # キャッシュ先の差替え
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const cheerio = require('cheerio');

const ROOT = path.resolve(__dirname, '..');
const MASTER_PATH = process.env.CARDS_MASTER_PATH || path.join(ROOT, 'data', 'cards_master.json');
const CACHE_DIR = process.env.OFFICIAL_CARDS_CACHE || path.join(ROOT, 'tmp', 'official-cards');
const REQUEST_DELAY_MS = 1500; // 公式サーバー配慮(fetch-card-texts.js と同じ。変更禁止)
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// 対象セットと公開種類数(2026-06-13 に detail.php の 200/302 境界で機械確認)
const DEFAULT_SETS = { EB01: 90, ST10: 16 };

const args = process.argv.slice(2);
const DO_MERGE = args.includes('--merge');
const budgetArg = args.find(a => a.startsWith('--budget-ms'));
const BUDGET_MS = budgetArg ? parseInt(budgetArg.split('=')[1] || args[args.indexOf(budgetArg) + 1], 10) : 0;
// --drop=ID1,ID2 : マージ時に明示削除する不正エントリ(例: プレビュー認識ミス由来の EB01-045R)
const dropArg = args.find(a => a.startsWith('--drop='));
const DROP_IDS = dropArg ? dropArg.replace('--drop=', '').split(',').filter(Boolean) : [];
const setsArg = args.find(a => a.startsWith('--sets='));
const SETS = {};
if (setsArg) {
  for (const part of setsArg.replace('--sets=', '').split(',')) {
    const [s, n] = part.split('=');
    SETS[s] = parseInt(n, 10);
  }
} else {
  Object.assign(SETS, DEFAULT_SETS);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html' } }, (res) => {
      if (res.statusCode !== 200) { resolve(null); res.resume(); return; } // 302=未掲載
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}

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

async function fetchAll() {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const started = Date.now();
  let fetched = 0, cached = 0, failed = [];
  for (const [set, count] of Object.entries(SETS)) {
    for (let i = 1; i <= count; i++) {
      const cardId = `${set}-${String(i).padStart(3, '0')}`;
      const cacheFile = path.join(CACHE_DIR, cardId + '.json');
      if (fs.existsSync(cacheFile)) { cached++; continue; }
      if (BUDGET_MS && Date.now() - started > BUDGET_MS) {
        console.log(`[時間予算] ${BUDGET_MS}ms 到達。取得済 ${cached + fetched}/${totalCount()} で中断(再実行で続きから)`);
        return { fetched, cached, failed, done: false };
      }
      await sleep(REQUEST_DELAY_MS);
      const html = await fetchHtml(`https://www.gundam-gcg.com/jp/cards/detail.php?detailSearch=${cardId}`);
      if (!html) { failed.push(cardId); console.warn(`  ✗ ${cardId}: 未掲載(302)or取得失敗`); continue; }
      const entry = parseCard(html, cardId);
      if (!entry) { failed.push(cardId); console.warn(`  ✗ ${cardId}: パース失敗`); continue; }
      fs.writeFileSync(cacheFile, JSON.stringify(entry, null, 2), 'utf-8');
      fetched++;
      console.log(`  ✓ ${cardId}: ${entry.name_jp} [${entry.rarity}/${entry.color}/${entry.card_type}]`);
    }
  }
  return { fetched, cached, failed, done: true };
}

function totalCount() {
  return Object.values(SETS).reduce((a, b) => a + b, 0);
}

function merge() {
  const master = JSON.parse(fs.readFileSync(MASTER_PATH, 'utf-8'));
  const before = JSON.parse(JSON.stringify(master));
  const targetSets = Object.keys(SETS);

  // キャッシュ全件チェック
  const entries = [];
  for (const [set, count] of Object.entries(SETS)) {
    for (let i = 1; i <= count; i++) {
      const cardId = `${set}-${String(i).padStart(3, '0')}`;
      const cacheFile = path.join(CACHE_DIR, cardId + '.json');
      if (!fs.existsSync(cacheFile)) {
        console.error(`マージ中止: ${cardId} が未取得です(全件取得後に --merge してください)`);
        process.exit(1);
      }
      entries.push(JSON.parse(fs.readFileSync(cacheFile, 'utf-8')));
    }
  }

  // 明示指定された不正エントリの削除(対象セット内のみ許可)
  for (const id of DROP_IDS) {
    if (!targetSets.includes(id.split('-')[0])) {
      console.error(`マージ中止: --drop ${id} は対象セット外のため削除できません`);
      process.exit(1);
    }
    if (master[id]) { delete master[id]; console.log(`  - 削除: ${id}(明示指定)`); }
  }

  // マージ(対象セットのみ追加/上書き)
  for (const e of entries) master[e.id] = e;

  // インクリメンタル検証: 対象外セットのエントリが1件も変わっていないこと
  for (const [id, card] of Object.entries(before)) {
    if (targetSets.includes(id.split('-')[0])) continue;
    if (JSON.stringify(master[id]) !== JSON.stringify(card)) {
      console.error(`マージ中止: 対象外カード ${id} が変更されました(バグ)`);
      process.exit(1);
    }
  }
  const counts = {};
  for (const id of Object.keys(master)) { const s = id.split('-')[0]; counts[s] = (counts[s] || 0) + 1; }
  for (const [set, expect] of Object.entries(SETS)) {
    if (counts[set] !== expect) {
      console.error(`マージ中止: ${set} の件数 ${counts[set]} ≠ 期待 ${expect}`);
      process.exit(1);
    }
  }

  fs.writeFileSync(MASTER_PATH, JSON.stringify(master, null, 2), 'utf-8');
  console.log('マージ完了:', MASTER_PATH);
  console.log('総数:', Object.keys(before).length, '→', Object.keys(master).length);
  console.log('セット別:', JSON.stringify(counts));
}

async function main() {
  if (DO_MERGE) { merge(); return; }
  const r = await fetchAll();
  console.log(`取得 ${r.fetched} / キャッシュ済 ${r.cached} / 失敗 ${r.failed.length} / 完了=${r.done}`);
  if (r.failed.length) console.log('失敗一覧:', r.failed.join(','));
  if (r.done && !r.failed.length) console.log(`全 ${totalCount()} 件取得済み。--merge でマージできます`);
}

main().catch(e => { console.error('エラー:', e.message); process.exit(1); });
// EOF
