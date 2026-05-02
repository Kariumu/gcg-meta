#!/usr/bin/env node
/**
 * card_texts.json の内容を cards_master.json にマージ
 * パラレル版は base_card_id のテキストを使う
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const MASTER_PATH = path.join(ROOT, 'data', 'cards_master.json');
const TEXTS_PATH = path.join(ROOT, 'data', 'card_texts.json');

const master = JSON.parse(fs.readFileSync(MASTER_PATH));
const texts = JSON.parse(fs.readFileSync(TEXTS_PATH));

let updated = 0;
let missing = 0;

for (const [id, card] of Object.entries(master)) {
  // パラレル版はベースカードのテキストを使用
  const lookupId = card.is_parallel && card.base_card_id ? card.base_card_id : id;
  const text = texts[lookupId];

  if (text !== undefined) {
    card.effect_text = text;
    updated++;
  } else {
    missing++;
  }
}

fs.writeFileSync(MASTER_PATH, JSON.stringify(master, null, 2));

console.log(`✅ マージ完了`);
console.log(`  更新: ${updated}件`);
console.log(`  テキストなし: ${missing}件`);
