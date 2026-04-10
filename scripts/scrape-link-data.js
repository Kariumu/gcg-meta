// scripts/scrape-link-data.js
// 旧カード（GD04以外）のlink情報を公式サイトdetail.phpから取得
// GD04スクレイピング時のパーサーをベースに、複数リンク条件に対応した配列パースに拡張

const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const https = require('https');

const master = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'cards_master.json'), 'utf8'));
const OUT_PATH = path.join(__dirname, '..', 'data', 'old_cards_link_data.json');

// 既に取得済みのデータがあれば読み込んでスキップ（再実行対応）
let existing = {};
if (fs.existsSync(OUT_PATH)) {
  try { existing = JSON.parse(fs.readFileSync(OUT_PATH, 'utf8')); } catch (e) {}
}

// 対象: GD04以外 + link未設定または文字列型のカード
const targetIds = Object.keys(master)
  .filter(id => {
    if (id.startsWith('GD04')) {
      // GD04は既に配列化されたものはスキップ、文字列型のみ再取得
      return typeof master[id].link === 'string';
    }
    return true;
  })
  .filter(id => !(id in existing))
  .sort();

console.log(`対象: ${targetIds.length}枚 (既取得: ${Object.keys(existing).length}枚)`);

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * リンクフィールドの生テキストを配列条件に変換
 * 例:
 *   "「アムロ・レイ」" → ["アムロ・レイ"]
 *   "特徴〔リガ・ミリティア〕" → ["特徴〔リガ・ミリティア〕"]
 *   "特徴〔トリニティ〕 「アリー・アル・サーシェス」" → ["特徴〔トリニティ〕", "アリー・アル・サーシェス"]
 *   "「カイ・シデン」「ハヤト・コバヤシ」" → ["カイ・シデン", "ハヤト・コバヤシ"]
 */
function parseLinkField(rawText) {
  if (!rawText || rawText === '-') return [];
  const conditions = [];
  // 特徴〔...〕パターン
  const traitRegex = /特徴〔[^〕]+〕/g;
  let m;
  while ((m = traitRegex.exec(rawText)) !== null) {
    conditions.push(m[0]);
  }
  // 「...」パターン（カード名）
  const nameRegex = /「([^」]+)」/g;
  while ((m = nameRegex.exec(rawText)) !== null) {
    conditions.push(m[1]);
  }
  // 特殊ケース: 「」がないがテキストがある場合（単独の名前）
  if (conditions.length === 0 && !rawText.startsWith('特徴')) {
    const t = rawText.trim();
    if (t) conditions.push(t);
  }
  return conditions;
}

/**
 * detail.php の HTML から link 生テキストを取得
 */
function extractLinkRaw(html) {
  const $ = cheerio.load(html);
  let raw = null;
  $('dl.dataBox').each((i, el) => {
    const key = $(el).find('.dataTit').text().trim();
    if (key === 'リンク') {
      raw = $(el).find('.dataTxt').text().trim();
    }
  });
  return raw;
}

(async () => {
  const results = { ...existing };
  let count = 0;
  const errors = [];

  for (const cardId of targetIds) {
    count++;
    const url = `https://www.gundam-gcg.com/jp/cards/detail.php?detailSearch=${cardId}`;
    try {
      const html = await fetchUrl(url);
      const raw = extractLinkRaw(html);
      const linkArr = parseLinkField(raw);
      results[cardId] = linkArr;
      if (linkArr.length > 0) {
        console.log(`[${count}/${targetIds.length}] ${cardId}: ${JSON.stringify(linkArr)}`);
      } else {
        // no-linkカードも記録 (空配列)
        if (count % 20 === 0) console.log(`[${count}/${targetIds.length}] ${cardId}: (no link)`);
      }
    } catch (e) {
      console.error(`[${count}/${targetIds.length}] ${cardId}: ERROR ${e.message}`);
      errors.push(cardId);
    }

    // 定期保存（50件ごと）
    if (count % 50 === 0) {
      fs.writeFileSync(OUT_PATH, JSON.stringify(results, null, 2), 'utf8');
    }

    await sleep(1200);
  }

  fs.writeFileSync(OUT_PATH, JSON.stringify(results, null, 2), 'utf8');
  const withLink = Object.values(results).filter(v => v.length > 0).length;
  console.log(`\n完了: 全${Object.keys(results).length}枚, うちlink情報あり: ${withLink}枚`);
  if (errors.length) console.log(`エラー: ${errors.length}枚 → ${errors.join(', ')}`);
})();
