#!/usr/bin/env node
/**
 * scripts/fetch-qa-database.js
 * 公式FAQ(https://www.gundam-gcg.com/jp/rules/faqs/)を巡回し、data/qa_database.json を
 * インクリメンタル更新する。指示書v9 Task2。
 *
 * 設計(2026-06-13 調査に基づく):
 *  - FAQは2系統: カテゴリ別 list.php?sub_category=… / 商品別 list.php?series=…
 *  - 各Q&Aは公式Q番号(例 Q310)を持ち、これを id として使用(既存 Q001… とユニオン可能)。
 *  - series ページのQ&Aは見出しにカード番号(例 EB01-002)を含む → card_ids 確定、category=セット略号。
 *  - sub_category ページのQ&Aは一般ルール → category=カテゴリ名、source_type=rule_category。
 *
 * 既存作法(fetch-card-texts.js)踏襲: https / 1.5秒間隔 / リトライ / User-Agent。
 *
 * インクリメンタル原則(必須): 既存 qa_database.json を読み、id でユニオン。
 *  既存Q&A・by_card は減らさない。新規のみ追加。実行前後の件数を比較出力。
 *
 * 使い方:
 *   node scripts/fetch-qa-database.js --dry-run   # 取得して結果表示のみ(書き込まない)
 *   node scripts/fetch-qa-database.js --debug      # パース結果サンプルを表示(parser検証用)
 *   node scripts/fetch-qa-database.js              # 取得して qa_database.json を更新
 *
 * ⚠ パーサ(parseQaList)のセレクタは実HTMLでの初回検証・微調整を前提とする。
 *    まず --debug / --dry-run で抽出件数とサンプルを確認してから本書き込みすること。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const cheerio = require('cheerio');

const BASE = 'https://www.gundam-gcg.com';
const FAQ_INDEX = `${BASE}/jp/rules/faqs/`;
const REQUEST_DELAY_MS = 1500;          // 1.5秒間隔(公式サーバー配慮)
const MAX_RETRIES = 3;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const ROOT = process.env.MANIFEST_ROOT || path.join(__dirname, '..');
const QA_PATH = path.join(ROOT, 'data', 'qa_database.json');
const BACKUP_PATH = QA_PATH + '.bak-20260613-v9';
const SOURCE_URL = 'https://www.gundam-gcg.com/jp/rules/faqs/';

const DRY_RUN = process.argv.includes('--dry-run');
const DEBUG = process.argv.includes('--debug');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchHtml(url, retries = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const next = res.headers.location.startsWith('http') ? res.headers.location : BASE + res.headers.location;
        res.resume();
        return resolve(fetchHtml(next, retries));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode} @ ${url}`)); }
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', async (err) => {
      if (retries < MAX_RETRIES) { await sleep(5000); resolve(await fetchHtml(url, retries + 1)); }
      else reject(err);
    });
  });
}

function cleanText(s) {
  return (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * FAQインデックスから sub_category / series のURL一覧を抽出。
 */
function parseIndex(html) {
  const $ = cheerio.load(html);
  const subCategories = new Set();
  const seriesList = new Set();
  $('a[href*="list.php"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    const abs = href.startsWith('http') ? href : BASE + (href.startsWith('/') ? href : '/jp/rules/faqs/' + href.replace(/^\.?\//, ''));
    if (/[?&]sub_category=/.test(abs)) subCategories.add(abs.split('#')[0]);
    if (/[?&]series=/.test(abs)) seriesList.add(abs.split('#')[0]);
  });
  return { subCategories: [...subCategories], seriesList: [...seriesList] };
}

/**
 * list.php ページから Q&A 配列を抽出(2026-06-13 view-source で実HTML構造確定)。
 * 各Q&A = <li class="faqResult_listItem">:
 *   Q番号 .faqResult_number / 見出し .faqResult_title(カード番号＋名) /
 *   カードリンク a.faqResult_nextLink(freeword=カード番号) / 更新日 .faqResult_date > time[datetime] /
 *   質問 .faqResult_question > .faqResult_text / 回答 .faqResult_answer > .faqResult_text
 */
function parseQaList(html, ctx) {
  const $ = cheerio.load(html);
  const out = [];
  $('li.faqResult_listItem').each((_, li) => {
    const $li = $(li);
    const numText = cleanText($li.find('.faqResult_number').first().text());
    const m = numText.match(/^Q(\d{1,5})$/);
    if (!m) return;                          // Q番号が無いブロックは対象外
    const id = 'Q' + m[1];
    const heading = cleanText($li.find('.faqResult_title').first().text());
    // card_ids: 見出しのカード番号 + nextLink の freeword
    const cardIds = [];
    const hM = heading.match(/^([A-Z]{2,4}\d{2}-\d+)/);
    if (hM) cardIds.push(hM[1]);
    $li.find('a.faqResult_nextLink[href*="freeword="]').each((__, a) => {
      const mm = ($(a).attr('href') || '').match(/freeword=([A-Z0-9-]+)/);
      if (mm && /^[A-Z]{2,4}\d{2}-\d+/.test(mm[1]) && !cardIds.includes(mm[1])) cardIds.push(mm[1]);
    });
    // 更新日: <time datetime=YYYY-MM-DD> を優先、無ければテキストから
    let updated = cleanText($li.find('.faqResult_date time').attr('datetime') || '');
    if (!updated) {
      const dM = cleanText($li.find('.faqResult_date').text()).match(/(\d{4})\.(\d{2})\.(\d{2})/);
      updated = dM ? `${dM[1]}-${dM[2]}-${dM[3]}` : '';
    }
    // 質問= .faqResult_question 配下の .faqResult_text / 回答= .faqResult_answer 配下の .faqResult_text
    const question = cleanText($li.find('.faqResult_question .faqResult_text').first().text());
    const answer   = cleanText($li.find('.faqResult_answer .faqResult_text').first().text());
    out.push({
      id, category: ctx.category, source_type: ctx.source_type,
      title: ctx.source_type === 'product' ? heading : ctx.category,
      question, answer, card_ids: cardIds,
      source_url: ctx.source_url, updated_at: updated
    });
  });
  return out;
}

/** ページネーション(次のページ)URLを取得。無ければ null。 */
function nextPageUrl(html, currentUrl) {
  const $ = cheerio.load(html);
  let next = null;
  $('a').each((_, a) => {
    if (cleanText($(a).text()) === '次のページ') {
      const href = $(a).attr('href');
      if (href && !/disabled/i.test($(a).attr('class') || '')) {
        next = href.startsWith('http') ? href : BASE + (href.startsWith('/') ? href : '/jp/rules/faqs/' + href.replace(/^\.?\//, ''));
      }
    }
  });
  return (next && next !== currentUrl) ? next : null;
}

async function crawl(startUrl, ctx, all) {
  let url = startUrl, guard = 0;
  while (url && guard++ < 50) {
    const html = await fetchHtml(url);
    const items = parseQaList(html, { ...ctx, source_url: url });
    for (const it of items) all.push(it);
    if (DEBUG && items[0]) console.log(`    [debug] ${url} → ${items.length}件, 例: ${JSON.stringify(items[0]).slice(0, 160)}`);
    const next = nextPageUrl(html, url);
    await sleep(REQUEST_DELAY_MS);
    url = next;
  }
}

// 内容キー: カード紐付きは「先頭card_id＋正規化question」、ルール系は「category＋正規化question」。
// 同一ソース(公式FAQ)由来のため、正規化(全空白除去)すれば既存と新規が一致しやすい。
function normKey(e) {
  const card = (e.card_ids && e.card_ids[0]) ? e.card_ids[0] : ('cat:' + (e.category || ''));
  const q = (e.question || '').replace(/[\s　]+/g, '');
  return card + '||' + q;
}

function rebuild(existing, fetched) {
  // 内容照合方式(指示書v9レビュー反映): 既存は一切削除しない(非破壊)。
  // 既存と内容一致する取得分はスキップ(重複防止)。新規のみ既存連番の続き(Q239〜)を採番。
  const existingAll = existing.all || [];
  const existingKeys = new Set(existingAll.map(normKey));
  let maxId = 0;
  for (const e of existingAll) { const m = (e.id || '').match(/^Q(\d+)$/); if (m) maxId = Math.max(maxId, Number(m[1])); }
  const all = existingAll.slice();
  const newKeys = new Set();
  let added = 0, skipped = 0;
  for (const f of fetched) {
    const key = normKey(f);
    if (existingKeys.has(key) || newKeys.has(key)) { skipped++; continue; }
    maxId++;
    all.push({ ...f, id: 'Q' + String(maxId).padStart(3, '0') });
    newKeys.add(key);
    added++;
  }
  all.sort((a, b) => Number((a.id || 'Q0').slice(1)) - Number((b.id || 'Q0').slice(1)));
  // by_card / by_category / categories 再構築
  const by_card = {}, by_category = {};
  for (const e of all) {
    for (const cid of (e.card_ids || [])) (by_card[cid] = by_card[cid] || []).push(e.id);
    if (e.category) (by_category[e.category] = by_category[e.category] || []).push(e.id);
  }
  const categories = Object.keys(by_category).sort();
  return {
    db: {
      version: existing.version || '1.0',
      generated_at: new Date().toISOString().replace(/\.\d+Z$/, '+09:00'),
      source: existing.source || SOURCE_URL,
      total_count: all.length,
      categories,
      all,
      by_category,
      by_card
    },
    added, skipped
  };
}

async function main() {
  const existing = fs.existsSync(QA_PATH) ? JSON.parse(fs.readFileSync(QA_PATH, 'utf-8')) : { all: [], by_card: {} };
  const beforeCount = (existing.all || []).length;
  const beforeCards = Object.keys(existing.by_card || {}).length;
  console.log(`📂 既存 qa_database.json: ${beforeCount}件 / by_card ${beforeCards}カード`);

  console.log('🔎 FAQインデックス取得…');
  const indexHtml = await fetchHtml(FAQ_INDEX);
  await sleep(REQUEST_DELAY_MS);
  const { subCategories, seriesList } = parseIndex(indexHtml);
  console.log(`  カテゴリ ${subCategories.length} / 商品(series) ${seriesList.length}`);

  const fetched = [];
  for (const url of seriesList) {
    const series = (url.match(/series=([A-Za-z0-9]+)/) || [])[1] || '';
    console.log(`  [series ${series}] ${url}`);
    await crawl(url, { category: series, source_type: 'product' }, fetched);
  }
  for (const url of subCategories) {
    const cat = decodeURIComponent((url.match(/sub_category=([^&]+)/) || [])[1] || '');
    console.log(`  [category ${cat}]`);
    await crawl(url, { category: cat, source_type: 'rule_category' }, fetched);
  }

  // 重複除去は rebuild と同じ normKey 基準に統一(id非依存。parserがQ番号を取れず id 空でも全件は捨てない)
  const seenKeys = new Set();
  const fetchedUniq = fetched.filter(f => { const k = normKey(f); if (seenKeys.has(k)) return false; seenKeys.add(k); return true; });
  console.log(`📥 取得Q&A(ユニーク): ${fetchedUniq.length}件`);
  // parser未確定の波及防止: question/answer が空の取得分を検出(空だと normKey が潰れて別Q&Aが1件に誤統合される)
  const emptyQ = fetchedUniq.filter(f => !f.question || !f.answer).length;
  if (emptyQ > 0) console.warn(`⚠ 取得分のうち question/answer が空: ${emptyQ}件。parserのセレクタ要確認(--debug で中身を検証)。`);

  const { db, added, skipped } = rebuild(existing, fetchedUniq);
  console.log('—— 件数比較 ——');
  console.log(`  Q&A:   ${beforeCount} → ${db.total_count}  (新規 +${added} / 重複スキップ ${skipped})`);
  console.log(`  by_card: ${beforeCards} → ${Object.keys(db.by_card).length} カード`);
  if (db.total_count < beforeCount || Object.keys(db.by_card).length < beforeCards) {
    console.error('❌ インクリメンタル違反: 件数が減少。書き込みを中止します。'); process.exit(1);
  }

    if (DRY_RUN || DEBUG) { console.log(`— ${DRY_RUN ? '--dry-run' : '--debug'} のため書き込みなし —`); return; }
  if (emptyQ > 0) { console.error(`❌ question/answer が空の取得分が ${emptyQ} 件あります。parser未確定のため本書き込みを中止します。--debug で構造を確認し、HTMLを共有してください。`); process.exit(1); }
  if (!fs.existsSync(BACKUP_PATH)) { fs.copyFileSync(QA_PATH, BACKUP_PATH); console.log(`💾 バックアップ: ${BACKUP_PATH}`); }
  fs.writeFileSync(QA_PATH, JSON.stringify(db, null, 2) + '\n', 'utf-8');
  console.log(`✅ 書き込み完了: ${QA_PATH}`);
}

main().catch(e => { console.error('エラー:', e.message); process.exit(1); });
