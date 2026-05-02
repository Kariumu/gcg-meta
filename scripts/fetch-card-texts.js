#!/usr/bin/env node
/**
 * 全カードのテキストを公式サイトから取得
 *
 * 使い方:
 *   node scripts/fetch-card-texts.js
 *   node scripts/fetch-card-texts.js --start GD04-001
 *   node scripts/fetch-card-texts.js --only GD01-001,GD01-002
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const REQUEST_DELAY_MS = 1500;  // 1.5秒間隔（公式サーバー配慮）
const MAX_RETRIES = 3;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// パス設定
const ROOT = path.join(__dirname, '..');
const MASTER_PATH = path.join(ROOT, 'data', 'cards_master.json');
const TEXTS_PATH = path.join(ROOT, 'data', 'card_texts.json');  // 中間ファイル

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function fetchHtml(url, retries = 0) {
  try {
    return await new Promise((resolve, reject) => {
      https.get(url, {
        headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html' }
      }, (res) => {
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      }).on('error', reject);
    });
  } catch (err) {
    if (retries < MAX_RETRIES) {
      await sleep(5000);
      return fetchHtml(url, retries + 1);
    }
    throw err;
  }
}

function extractCardText(html) {
  // <div class="dataTxt isRegular">...</div> を抽出
  const match = html.match(/<div class="dataTxt isRegular">([\s\S]*?)<\/div>/);
  if (!match) return '';

  let text = match[1];
  // <br> を改行に
  text = text.replace(/<br\s*\/?>/gi, '\n');
  // 残りのHTMLタグ除去
  text = text.replace(/<[^>]+>/g, '');
  // HTMLエンティティ
  text = text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  // 空白整理
  text = text.split('\n').map(l => l.trim()).filter(l => l).join(' ');

  return text;
}

async function main() {
  const args = process.argv.slice(2);
  let startId = null, onlyIds = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--start') startId = args[i + 1];
    if (args[i] === '--only') onlyIds = args[i + 1].split(',');
  }

  // cards_master.json から全カードIDを取得
  const master = JSON.parse(fs.readFileSync(MASTER_PATH));

  // パラレル除外（ベースカードのみ取得）
  const baseIds = new Set();
  for (const [id, card] of Object.entries(master)) {
    if (!card.is_parallel) {
      baseIds.add(id);
    } else if (card.base_card_id) {
      baseIds.add(card.base_card_id);
    } else {
      baseIds.add(id);
    }
  }

  let targetIds = Array.from(baseIds).sort();

  // フィルタ
  if (onlyIds) {
    targetIds = targetIds.filter(id => onlyIds.includes(id));
  } else if (startId) {
    const startIdx = targetIds.indexOf(startId);
    if (startIdx >= 0) targetIds = targetIds.slice(startIdx);
  }

  console.log(`📋 対象カード数: ${targetIds.length}（パラレル除外、ベースカードのみ）`);
  console.log(`想定時間: 約 ${Math.round(targetIds.length * REQUEST_DELAY_MS / 60000)} 分`);

  // 既存データ読み込み（差分取得対応）
  let existingTexts = {};
  if (fs.existsSync(TEXTS_PATH)) {
    existingTexts = JSON.parse(fs.readFileSync(TEXTS_PATH));
    console.log(`📂 既存データ ${Object.keys(existingTexts).length}件 を読み込み`);
  }

  // 取得済みはスキップ
  targetIds = targetIds.filter(id => !existingTexts[id] && existingTexts[id] !== '');
  console.log(`🎯 新規取得対象: ${targetIds.length}件`);

  if (targetIds.length === 0) {
    console.log('全カード取得済みです');
    return;
  }

  let success = 0, error = 0, empty = 0;
  let saveCounter = 0;

  for (let i = 0; i < targetIds.length; i++) {
    const cardId = targetIds[i];
    const url = `https://www.gundam-gcg.com/jp/cards/detail.php?detailSearch=${cardId}`;

    try {
      const html = await fetchHtml(url);
      const text = extractCardText(html);

      existingTexts[cardId] = text;
      if (text) {
        success++;
      } else {
        empty++;
      }

      if ((i + 1) % 10 === 0 || i === targetIds.length - 1) {
        console.log(`  進捗 ${i + 1}/${targetIds.length}: 成功${success}, 空${empty}, エラー${error}`);
      }

      // 50件ごとに中間保存
      saveCounter++;
      if (saveCounter >= 50) {
        fs.writeFileSync(TEXTS_PATH, JSON.stringify(existingTexts, null, 2));
        console.log(`  💾 中間保存 (${Object.keys(existingTexts).length}件)`);
        saveCounter = 0;
      }
    } catch (err) {
      console.warn(`  ${cardId}: ${err.message}`);
      error++;
    }

    await sleep(REQUEST_DELAY_MS);
  }

  // 最終保存
  fs.writeFileSync(TEXTS_PATH, JSON.stringify(existingTexts, null, 2));

  console.log(`\n✅ 取得完了`);
  console.log(`  成功: ${success}件`);
  console.log(`  空テキスト: ${empty}件`);
  console.log(`  エラー: ${error}件`);
  console.log(`  総保存件数: ${Object.keys(existingTexts).length}件`);
  console.log(`\n保存先: ${TEXTS_PATH}`);
}

main().catch(console.error);
