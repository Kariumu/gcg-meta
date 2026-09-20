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
// 指示書113: リソース／EXベース系はデッキの 50 枚に含まれないため、デッキビルダーに埋め込まない
const RESOURCE_TYPES = ['RESOURCE', 'EX RESOURCE', 'EX BASE'];

const ROOT = __dirname;
const read = (p) => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf-8'));

function main() {
  // --- master ---
  const masterRaw = read('data/cards_master.json');
  const masterArr = Array.isArray(masterRaw) ? masterRaw : Object.values(masterRaw);
  const slim = masterArr
    .filter((c) => c && typeof c === 'object' && c.id && !RESOURCE_TYPES.includes(c.card_type))
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

  // --- シリーズ別カード採用率（指示書79）。無くても・古くても落とさない（§7 MUST） ---
  // scripts/build-series-summary.js が data/series/card-adoption.json に出力する。
  // 同スクリプトは .sched-run-tmp\ntc-new-events.flag の内側でしか走らない（＝大会イベントが
  // 増えた夜だけ更新される）ので、ここは「読めなければ採用率なしで続行」を厳守すること。
  // cards_preview.json と同じ扱い。
  let adoption = null;
  try {
    const ad = read('data/series/card-adoption.json');
    if (ad && ad.series_name && ad.cards && typeof ad.cards === 'object' && ad.total_decks > 0) {
      adoption = {
        name: ad.series_name,          // 画面に出すのはこれだけ（裁定⑥）
        decks: ad.total_decks,         // 分母。画面には出さない（裁定④）が検証用に持つ
        wins: ad.total_wins || 0,
        asOf: ad.as_of || '',          // 対象シリーズの最新イベント日（データ由来。実行時刻ではない）
        // { 型番: [採用デッキ数, 採用率, 優勝回数] }
        // 形が壊れたレコードは落とす（テンプレート側で NaN% を描かせないため）
        cards: Object.fromEntries(
          Object.entries(ad.cards).filter(([, v]) =>
            Array.isArray(v) && v.length >= 3 &&
            Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2])
          )
        )
      };
    }
  } catch (e) {
    adoption = null;
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

  // builtAt は意図的に持たない（指示書77 §5-1 案A・2026-08-23）。
  // 実行時刻を埋めると同一入力でも出力が毎回変わり、git blob SHA 差分方式の
  // push（deploy-results.js / scripts/push-deckbuilder.js）が毎晩「変更あり」と
  // 判定して 1.2MB の blob と無意味なコミットを積み続けるため。
  // ビルド日時は git のコミット日時と deck-builder.html の更新日時で追える。
  // ※ ここに時刻や乱数を足すと no-op 保証（毎晩 push ゼロ）が壊れます。
  const data = {
    cards: slim,
    preview: previewArr,
    restrictions,
    tokenmap,
    adoption,
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
  console.log('  adoption:           ' + (adoption
    ? adoption.name + ' / ' + Object.keys(adoption.cards).length + '種 / 分母' + adoption.decks + 'デッキ (as_of ' + adoption.asOf + ')'
    : '(なし・採用率は表示されません)'));
  console.log('  restrictions:       banned=' + (restrictions.banned || []).length +
    ' restricted=' + (restrictions.restricted || []).length +
    ' pairs=' + ((restrictions.banned_pairs || {}).specific || []).length +
    ' group=' + (((restrictions.banned_pairs || {}).group || {}).members || []).length);
}

main();
