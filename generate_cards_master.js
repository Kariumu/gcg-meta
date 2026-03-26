#!/usr/bin/env node
/**
 * generate_cards_master.js
 * cards_data.js の GALLERY_ALL から cards_master.json を生成する
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const CARDS_DATA_PATH = path.resolve(__dirname, '..', 'GCGSimulator', 'simulator', 'data', 'cards_data.js');
const OUTPUT_PATH = path.join(__dirname, 'data', 'cards_master.json');

// cards_data.js を読み込んで GALLERY_ALL を抽出
let src = fs.readFileSync(CARDS_DATA_PATH, 'utf-8');

// const/let → var に変換してサンドボックスのグローバルに露出させる
src = src.replace(/^const /gm, 'var ').replace(/^let /gm, 'var ');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const gallery = sandbox.GALLERY_ALL;
if (!gallery) {
  console.error('GALLERY_ALL が見つかりません');
  process.exit(1);
}

// 必要なフィールドのみ抽出
const master = {};
for (const [id, card] of Object.entries(gallery)) {
  master[id] = {
    id: card.id,
    name_jp: card.name_jp,
    rarity: card.rarity,
    card_type: card.card_type,
    color: card.color,
    level: card.level,
    cost: card.cost,
    traits: card.traits || [],
    stats: card.stats || {},
    source_title: card.source_title || ''
  };
}

fs.writeFileSync(OUTPUT_PATH, JSON.stringify(master, null, 2), 'utf-8');
console.log(`cards_master.json 生成完了: ${Object.keys(master).length} 件`);
