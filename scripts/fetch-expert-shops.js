#!/usr/bin/env node
/**
 * エキスパートショップ一覧 取得・生成スクリプト
 *
 * 公式サイト（gundam-gcg.com/jp/shoplist/list.php?pref=XXX）から
 * 47都道府県のエキスパートショップ名を収集し、data/expert-shops.json を生成する。
 * 認証不要。BANDAI TCG+ API は使わない（公式サイトのサーバーレンダリングHTMLをパース）。
 *
 * 使い方:
 *   node scripts/fetch-expert-shops.js            取得して expert-shops.json を生成
 *   node scripts/fetch-expert-shops.js --dry-run   取得するが書き込まない（件数表示のみ）
 *
 * 出力 data/expert-shops.json の構造:
 *   {
 *     "generatedAt": "ISO日時",
 *     "source": "https://www.gundam-gcg.com/jp/shoplist/",
 *     "totalExpertShops": 322,           // 公式エキスパート総数（ユニーク店名）
 *     "matchedToSchedule": 304,          // schedule.json と紐付いた数
 *     "expertShopNames": [ "店名", ... ], // 公式エキスパート店名（正規化前の表示名）
 *     "expertStoreIds": [ 2746, ... ],    // schedule.json で一致した店舗id（フィルタ判定用）
 *     "byPref": { "東京都": ["店名",...], ... } // 都道府県別（参考・将来の一覧ページ用）
 *   }
 *
 * stores.html はこの expertStoreIds を読み、各店の id が含まれるかで
 * 「エキスパートショップ」フィルタ/バッジ判定を行う。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const DRY_RUN = process.argv.includes('--dry-run');
const OUT = path.join(ROOT, 'data', 'expert-shops.json');
const SCHEDULE = path.join(ROOT, 'data', 'schedule.json');
const BASE = 'https://www.gundam-gcg.com/jp/shoplist/list.php?pref=';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36';

const PREFS = ['北海道','青森県','岩手県','宮城県','秋田県','山形県','福島県','茨城県','栃木県','群馬県','埼玉県','千葉県','東京都','神奈川県','新潟県','富山県','石川県','福井県','山梨県','長野県','岐阜県','静岡県','愛知県','三重県','滋賀県','京都府','大阪府','兵庫県','奈良県','和歌山県','鳥取県','島根県','岡山県','広島県','山口県','徳島県','香川県','愛媛県','高知県','福岡県','佐賀県','長崎県','熊本県','大分県','宮崎県','鹿児島県','沖縄県'];

function fetchPref(pref) {
  return new Promise((resolve, reject) => {
    const url = BASE + encodeURIComponent(pref);
    https.get(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html' } }, (res) => {
      if (res.statusCode !== 200) { reject(new Error(`${pref}: HTTP ${res.statusCode}`)); return; }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// HTMLから店舗名を抽出（aria-label="店名、住所" の「、」前を取る）
function extractShopNames(html) {
  const names = [];
  const re = /class="shopListColLink"[^>]*aria-label="([^"]+)"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const name = m[1].split('、')[0].trim();
    if (name) names.push(name);
  }
  return names;
}

// 店舗名の正規化（NFKC・空白除去・小文字化）— schedule.json との照合用
function normName(s) {
  return s.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  console.log(`エキスパートショップ取得 ${DRY_RUN ? '(DRY RUN)' : ''}`);
  const byPref = {};
  const allNames = new Set();

  for (const pref of PREFS) {
    try {
      const html = await fetchPref(pref);
      const names = extractShopNames(html);
      byPref[pref] = names;
      names.forEach(n => allNames.add(n));
      process.stdout.write(`  ${pref}: ${names.length}  `);
    } catch (e) {
      console.error(`\n  ${pref} 取得失敗: ${e.message}`);
      byPref[pref] = [];
    }
    await sleep(1500); // 公式サーバーへの配慮
  }
  console.log('\n');

  // schedule.json と照合して店舗idを確定
  const schedule = JSON.parse(fs.readFileSync(SCHEDULE, 'utf-8'));
  const schedStores = schedule.stores || {};
  const normToId = new Map();
  for (const [id, s] of Object.entries(schedStores)) {
    if (s && s.name) normToId.set(normName(s.name), s.id != null ? s.id : Number(id));
  }

  const expertStoreIds = [];
  const matchedNames = [];
  for (const name of allNames) {
    const id = normToId.get(normName(name));
    if (id != null) { expertStoreIds.push(id); matchedNames.push(name); }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    source: 'https://www.gundam-gcg.com/jp/shoplist/',
    totalExpertShops: allNames.size,
    matchedToSchedule: expertStoreIds.length,
    expertShopNames: [...allNames].sort(),
    expertStoreIds: [...new Set(expertStoreIds)].sort((a, b) => a - b),
    byPref
  };

  console.log(`公式エキスパート総数: ${out.totalExpertShops}`);
  console.log(`schedule.json と一致(フィルタ対象id): ${out.matchedToSchedule}`);
  console.log(`schedule.json 全店舗数に対する割合: ${(out.matchedToSchedule / Object.keys(schedStores).length * 100).toFixed(1)}%`);

  if (DRY_RUN) {
    console.log('\nDRY RUN のため書き込みません。');
    return;
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log(`\n書き込み完了: ${path.relative(ROOT, OUT)}`);
}

main().catch(e => { console.error('エラー:', e.message); process.exit(1); });
