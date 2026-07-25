/**
 * generate_deckbuilder.js — デッキビルダー生成器
 *
 * templates/deckbuilder.template.html に実データを埋め込み、
 * deck-builder.html を LF で出力する（既存慣習: 生成器→LF出力）。
 *
 * データ源（§3・§13）:
 *  - data/cards_master.json   … カードマスター（id→card の辞書）
 *  - data/cards_preview.json  … 公式X先行カード（§4.5。読めなければ空扱い）
 *  - data/restrictions.json   … 禁止・制限（2026-07-25 新レギュ・常時適用）
 *  - data/tcgplus_tokenmap.json … TCG＋変換表 v2（id→token の薄いマップに縮約）
 *
 * 使い方: node generate_deckbuilder.js
 * ※公開（push）はしない。ローカル検証用ビルド。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const core = require('./js/deckbuilder-core.js');

const ROOT = __dirname;
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf-8'));

function main() {
  // --- master ---
  const masterRaw = read('data/cards_master.json');
  const masterArr = Array.isArray(masterRaw) ? masterRaw : Object.values(masterRaw);
  const slim = masterArr
    .filter((c) => c && typeof c === 'object' && c.id)
    .map(core.slimFromMaster);

  // --- preview（無くても落とさない・§13） ---
  let previewArr = [];
  try {
    const pv = read('data/cards_preview.json');
    previewArr = Array.isArray(pv) ? pv : Object.values(pv);
    previewArr = previewArr.filter((p) => p && typeof p === 'object' && p.card_number);
  } catch (e) {
    previewArr = [];
  }

  // --- restrictions ---
  const restrictions = read('data/restrictions.json');

  // --- tokenmap（id→token に縮約） ---
  const tmRaw = read('data/tcgplus_tokenmap.json');
  const tokenmap = {};
  for (const [k, v] of Object.entries(tmRaw)) {
    if (k === '_meta' || !v || typeof v !== 'object') continue;
    if (v.token) tokenmap[k] = v.token;
  }

  // --- パラレル固有トークンの取り込み（指示書54/GD05パラレル対応。無ければ従来どおり） ---
  try {
    const parRaw = read('data/tcgplus_parallel_tokens.json');
    for (const [k, v] of Object.entries(parRaw)) {
      if (k === '_meta') continue;
      if (typeof v === 'string' && v) tokenmap[k] = v;
    }
  } catch (e) { /* パラレル表が無ければスキップ */ }

  const data = {
    builtAt: new Date().toISOString(),
    cards: slim,
    preview: previewArr,
    restrictions,
    tokenmap,
  };

  // --- 埋め込み（</script> 対策で < をエスケープ。$ パターン対策で関数置換） ---
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  let html = fs.readFileSync(path.join(ROOT, 'templates/deckbuilder.template.html'), 'utf-8');
  if (!html.includes('__GCG_DATA_JSON__')) throw new Error('テンプレートにプレースホルダがありません');
  html = html.replace('__GCG_DATA_JSON__', () => json);
  html = html.replace(/\r\n/g, '\n'); // LF 保証

  const out = path.join(ROOT, 'deck-builder.html');
  fs.writeFileSync(out, html, 'utf-8');

  const kb = (Buffer.byteLength(html, 'utf-8') / 1024).toFixed(0);
  console.log('[generate_deckbuilder] 出力: deck-builder.html (' + kb + ' KB)');
  console.log('  cards(master slim): ' + slim.length);
  console.log('  preview(raw):       ' + previewArr.length);
  console.log('  tokenmap:           ' + Object.keys(tokenmap).length);
  console.log('  restrictions:       banned=' + (restrictions.banned || []).length +
    ' restricted=' + (restrictions.restricted || []).length +
    ' pairs=' + ((restrictions.banned_pairs || {}).specific || []).length +
    ' group=' + (((restrictions.banned_pairs || {}).group || {}).members || []).length);
}

main();
