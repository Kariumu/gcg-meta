#!/usr/bin/env node
/**
 * scripts/batch-recognize.js
 *
 * GD04 130枚一括認識検証スクリプト(指示書30、2026-05-14 作成)
 *
 * 目的:
 *   GD04 130枚(基本形のみ、_p バリアント除外)を一括認識し、
 *   cards_master.json の正解データと比較して達成率を統計的に評価する。
 *
 * 使い方:
 *   node scripts/batch-recognize.js                    # フル実行(130枚、課金 $1.50)
 *   node scripts/batch-recognize.js --limit 3          # 最初の3枚のみ(テスト用)
 *   node scripts/batch-recognize.js --dry-run          # ファイル一覧確認のみ(課金なし)
 *   node scripts/batch-recognize.js --skip-step3       # Step 3 (Claude) スキップ
 *   node scripts/batch-recognize.js --filter EB01-     # 別拡張で実行
 *
 * 設計原則:
 *   - 既存ファイル無変更: auto-news.js / cards_master.json
 *   - 既存関数再利用: manual-card-news.js から callVisionAIv2 / postProcessVisionResultV2 / structureCardWithClaude
 *   - エラーで全停止しない(1枚失敗で次へ)
 *   - レート制限対策(500ms sleep)
 */

require('dotenv').config({ override: true });
const fs = require('fs');
const path = require('path');

// === auto-news.js から色判定関数を再利用 ===
const { step1B_pixelColorDetection, step1C_merge } = require('../auto-news.js');

// === manual-card-news.js から認識3関数を再利用(指示書30 で module.exports 追加) ===
const {
  callVisionAIv2,
  postProcessVisionResultV2,
  structureCardWithClaude,
} = require('./manual-card-news.js');

// === 引数解析 ===
const args = process.argv.slice(2);
const getArg = (name) => {
  const idx = args.indexOf(name);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
};
const hasFlag = (name) => args.includes(name);

const imageDir =
  getArg('--image-dir') || path.resolve(__dirname, '..', 'images', 'cards');
const filter = getArg('--filter') || 'GD04-'; // デフォルト: GD04 (前方一致)
const masterPath =
  getArg('--master') || path.resolve(__dirname, '..', 'data', 'cards_master.json');
const outputPath =
  getArg('--output') ||
  path.resolve(__dirname, '..', 'tmp', 'batch-recognize', 'gd04-results.json');
const isDryRun = hasFlag('--dry-run');
const skipStep3 = hasFlag('--skip-step3');
const limitArg = getArg('--limit');
const limit = limitArg ? parseInt(limitArg, 10) : null;

// === ユーティリティ ===
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function logSection(title) {
  console.log(`\n[${title}]`);
}

/**
 * traits 正規化: ["〔ジージェネ〕"] → ["ジージェネ"]
 */
function normalizeTraits(traits) {
  if (!Array.isArray(traits)) return [];
  return traits.map((t) => String(t).replace(/^〔|〕$/g, '').trim()).filter(Boolean);
}

/**
 * link 正規化: "「アムロ・レイ」" → ["アムロ・レイ"]
 *              "特徴(耐久型)" → ["特徴(耐久型)"](特徴指定はそのまま)
 *              [] や null → []
 *              array → そのまま
 */
function normalizeLink(link) {
  if (!link) return [];
  if (Array.isArray(link)) return link.map((s) => String(s).trim()).filter(Boolean);
  const s = String(link);
  const m = s.match(/^「(.+)」$/);
  if (m) return [m[1].trim()];
  return [s.trim()];
}

/**
 * 認識データを比較可能な形式に正規化
 */
function normalizeRecognized(recognized) {
  return {
    card_number: recognized.card_number ?? null,
    card_name: recognized.card_name ?? null,
    rarity: recognized.rarity ?? null,
    card_type: recognized.card_type ?? null,
    color: recognized.color ?? null,
    level: recognized.level ?? null,
    cost: recognized.cost ?? null,
    ap: recognized.ap ?? null,
    hp: recognized.hp ?? null,
    traits: normalizeTraits(recognized.traits),
    link: normalizeLink(recognized.link),
    expansion: recognized.expansion ?? null,
    effect: recognized.effect ?? null,
  };
}

/**
 * cards_master.json のデータを比較可能な形式に正規化
 * フィールド名マッピング: id→card_number, name_jp→card_name, package_set→expansion, stats.ap/hp→ap/hp
 */
function normalizeMasterCard(master) {
  return {
    card_number: master.id ?? null,
    card_name: master.name_jp ?? null,
    rarity: master.rarity ?? null,
    card_type: master.card_type ?? null,
    color: master.color ?? null,
    level: master.level ?? null,
    cost: master.cost ?? null,
    ap: master.stats?.ap ?? null,
    hp: master.stats?.hp ?? null,
    traits: Array.isArray(master.traits) ? master.traits : [],
    link: Array.isArray(master.link) ? master.link : master.link ? [master.link] : [],
    expansion: master.package_set ?? null,
    effect: master.effect ?? null,
    effect_text: master.effect_text ?? null, // 比較で両方使う
  };
}

/**
 * 配列を集合として比較(順序無視、重複無視)
 */
function arraysEqualAsSet(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const item of setA) {
    if (!setB.has(item)) return false;
  }
  return true;
}

/**
 * 1枚のカードについて 13項目の完全一致判定 + 達成率算出
 */
function compareCard(recognized, master) {
  const r = normalizeRecognized(recognized);
  const m = normalizeMasterCard(master);

  const results = {};

  // 1. card_number (完全一致)
  results.card_number = r.card_number === m.card_number;
  // 2. card_name (完全一致)
  results.card_name = r.card_name === m.card_name;
  // 3. rarity (完全一致)
  results.rarity = r.rarity === m.rarity;
  // 4. card_type (完全一致)
  results.card_type = r.card_type === m.card_type;
  // 5. color (完全一致)
  results.color = r.color === m.color;
  // 6. level (完全一致)
  results.level = r.level === m.level;
  // 7. cost (完全一致)
  results.cost = r.cost === m.cost;
  // 8. ap (UNIT/PILOT のみ判定、COMMAND は対象外)
  if (m.card_type === 'UNIT' || m.card_type === 'PILOT') {
    results.ap = r.ap === m.ap;
  } else {
    results.ap = null;
  }
  // 9. hp (UNIT/PILOT/BASE のみ判定、COMMAND は対象外)
  if (m.card_type !== 'COMMAND') {
    results.hp = r.hp === m.hp;
  } else {
    results.hp = null;
  }
  // 10. traits (集合一致、〔〕除去後)
  results.traits = arraysEqualAsSet(r.traits, m.traits);
  // 11. link (集合一致、「」除去・array変換後)
  results.link = arraysEqualAsSet(r.link, m.link);
  // 12. expansion (完全一致)
  results.expansion = r.expansion === m.expansion;
  // 13. effect (effect または effect_text のいずれかと完全一致)
  results.effect = r.effect === m.effect || r.effect === m.effect_text;

  // 達成率(対象外項目を除く)
  const validEntries = Object.entries(results).filter(([, v]) => v !== null);
  const matchedCount = validEntries.filter(([, v]) => v === true).length;
  const totalCount = validEntries.length;
  return {
    achievements: results,
    matchedCount,
    totalCount,
    achievementRate: totalCount > 0 ? matchedCount / totalCount : 0,
    isPerfect: matchedCount === totalCount && totalCount > 0,
  };
}

/**
 * ファイル名からカード番号を抽出
 * 例: "GD04-001.webp" → "GD04-001"
 */
function extractCardId(filename) {
  return filename.replace(/\.(webp|png|jpg|jpeg)$/i, '');
}

/**
 * 1枚のカードを認識し、比較する
 */
async function processCard(filepath, filename, cardsMaster) {
  const cardId = extractCardId(filename);
  const masterCard = cardsMaster[cardId];

  if (!masterCard) {
    return {
      filename,
      cardId,
      success: false,
      error: `cards_master.json に ${cardId} が見つかりません`,
    };
  }

  try {
    // 画像を base64 化
    const imageBuffer = fs.readFileSync(filepath);
    const imageBase64 = imageBuffer.toString('base64');
    const imageBase64List = [{ base64: imageBase64 }];

    // Step 1-A v2: Vision API (DOCUMENT_TEXT_DETECTION + 日本語ヒント)
    const visionResponse = await callVisionAIv2(imageBase64, true);
    const fta = visionResponse.responses?.[0]?.fullTextAnnotation;
    if (!fta) {
      return {
        filename,
        cardId,
        success: false,
        error: 'Vision API: fullTextAnnotation が空',
      };
    }
    const fullText = fta.text || '';
    const blockCount = fta.pages?.[0]?.blocks?.length || 0;

    // 認識結果の初期オブジェクト(manual-card-news.js Step 1-A v2 と同形)
    const visionResult = {
      _rawText: fullText,
      _blocks: blockCount,
      card_number: null,
      card_name: null,
      rarity: null,
      card_type: null,
      level: null,
      cost: null,
      ap: null,
      hp: null,
      terrain: [],
      traits: [],
      link: null,
      effect: null,
    };

    // Step 1-B: 色判定(auto-news.js の関数を再利用)
    const colorResults = await step1B_pixelColorDetection(imageBase64List);

    // Step 1-C: マージ(auto-news.js の関数を再利用、色を乗せる)
    const merged = step1C_merge(visionResult, colorResults[0]);

    // Step 2: 後処理(正規表現抽出)
    const postProcessed = postProcessVisionResultV2(fullText, merged);

    // Step 3: Claude API 構造化(--skip-step3 でスキップ可)
    // 2026-05-24 マルチモーダル化(認識精度改修 案件1): 画像も渡して Lv 等の OCR 読取漏れを補完
    let final = postProcessed;
    if (!skipStep3) {
      final = await structureCardWithClaude(fullText, postProcessed, imageBase64);
    }

    // 比較
    const comparison = compareCard(final, masterCard);

    return {
      filename,
      cardId,
      success: true,
      matchedCount: comparison.matchedCount,
      totalCount: comparison.totalCount,
      achievementRate: comparison.achievementRate,
      isPerfect: comparison.isPerfect,
      achievements: comparison.achievements,
      recognized: final,
      expected: normalizeMasterCard(masterCard),
    };
  } catch (e) {
    return {
      filename,
      cardId,
      success: false,
      error: e.message,
    };
  }
}

/**
 * 統計サマリーを構築
 */
function buildSummary(results, cardsMaster, processedAt) {
  const successResults = results.filter((r) => r.success);
  const errorResults = results.filter((r) => !r.success);
  const perfectResults = successResults.filter((r) => r.isPerfect);

  // 平均達成率(成功カードのみ)
  const avgRate =
    successResults.length > 0
      ? successResults.reduce((s, r) => s + r.achievementRate, 0) / successResults.length
      : 0;

  // レアリティ別、カードタイプ別の達成率集計
  const rarityBreakdown = {};
  const cardTypeBreakdown = {};
  successResults.forEach((r) => {
    const m = cardsMaster[r.cardId];
    if (!m) return;
    // rarity
    if (!rarityBreakdown[m.rarity]) {
      rarityBreakdown[m.rarity] = { count: 0, perfectCount: 0, rateSum: 0 };
    }
    rarityBreakdown[m.rarity].count++;
    rarityBreakdown[m.rarity].rateSum += r.achievementRate;
    if (r.isPerfect) rarityBreakdown[m.rarity].perfectCount++;
    // card_type
    if (!cardTypeBreakdown[m.card_type]) {
      cardTypeBreakdown[m.card_type] = { count: 0, perfectCount: 0, rateSum: 0 };
    }
    cardTypeBreakdown[m.card_type].count++;
    cardTypeBreakdown[m.card_type].rateSum += r.achievementRate;
    if (r.isPerfect) cardTypeBreakdown[m.card_type].perfectCount++;
  });
  // averageRate を算出
  Object.keys(rarityBreakdown).forEach((k) => {
    const v = rarityBreakdown[k];
    v.averageRate = v.count > 0 ? v.rateSum / v.count : 0;
    delete v.rateSum;
  });
  Object.keys(cardTypeBreakdown).forEach((k) => {
    const v = cardTypeBreakdown[k];
    v.averageRate = v.count > 0 ? v.rateSum / v.count : 0;
    delete v.rateSum;
  });

  // 項目別の失敗率
  const fieldFailureBreakdown = {};
  const fieldNames = [
    'card_number',
    'card_name',
    'rarity',
    'card_type',
    'color',
    'level',
    'cost',
    'ap',
    'hp',
    'traits',
    'link',
    'expansion',
    'effect',
  ];
  fieldNames.forEach((f) => {
    let evaluated = 0;
    let failed = 0;
    successResults.forEach((r) => {
      const v = r.achievements?.[f];
      if (v === null || v === undefined) return; // 対象外
      evaluated++;
      if (v === false) failed++;
    });
    fieldFailureBreakdown[f] = {
      evaluatedCount: evaluated,
      failCount: failed,
      failRate: evaluated > 0 ? failed / evaluated : 0,
    };
  });

  return {
    processedAt,
    totalImages: results.length,
    successCount: successResults.length,
    errorCount: errorResults.length,
    perfectCardCount: perfectResults.length,
    perfectCardRate:
      successResults.length > 0 ? perfectResults.length / successResults.length : 0,
    averageAchievementRate: avgRate,
    rarityBreakdown,
    cardTypeBreakdown,
    fieldFailureBreakdown,
    skipStep3: !!skipStep3,
    results,
  };
}

// === メイン処理 ===
async function main() {
  const startTime = Date.now();
  console.log('=== batch-recognize.js 開始 ===');
  console.log(`画像フォルダ: ${imageDir}`);
  console.log(`マスターデータ: ${masterPath}`);
  console.log(`出力先: ${outputPath}`);
  console.log(`フィルタ: ${filter}*.{webp,png,jpg,jpeg} (_p バリアント除外)`);
  console.log(`Dry-run: ${isDryRun}`);
  console.log(`Skip Step 3: ${skipStep3}`);
  if (limit) console.log(`制限: ${limit} 枚のみ処理`);

  // 出力ディレクトリ準備
  const outputDir = path.dirname(outputPath);
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
    console.log(`出力ディレクトリを作成: ${outputDir}`);
  }

  // 画像フォルダの存在チェック
  if (!fs.existsSync(imageDir)) {
    console.error(`ERROR: 画像フォルダが見つかりません: ${imageDir}`);
    process.exit(1);
  }

  // ファイル一覧取得 + フィルタリング(基本形のみ、_p バリアント除外)
  const allFiles = fs.readdirSync(imageDir).filter((f) => /\.(webp|png|jpg|jpeg)$/i.test(f));
  const baseExp = filter.replace(/-$/, ''); // "GD04-" → "GD04"
  // 例: ^GD04-\d{3}\.(webp|png|jpg|jpeg)$ で _p バリアント除外
  const re = new RegExp(`^${baseExp}-\\d{3}\\.(webp|png|jpg|jpeg)$`, 'i');
  let targetFiles = allFiles.filter((f) => re.test(f));
  targetFiles.sort();

  console.log(`\n検出された対象画像: ${targetFiles.length} 枚`);
  if (targetFiles.length === 0) {
    console.error(`ERROR: 対象画像が見つかりません(filter: ${filter})`);
    process.exit(1);
  }

  // limit 適用
  if (limit && limit > 0) {
    targetFiles = targetFiles.slice(0, limit);
    console.log(`--limit ${limit} 適用、処理対象: ${targetFiles.length} 枚`);
  }

  // Dry-run の場合はここで終了
  if (isDryRun) {
    console.log('\n[Dry-run] ファイル一覧のみ表示します(認識は実行しません):');
    targetFiles.slice(0, 10).forEach((f) => console.log(`  - ${f}`));
    if (targetFiles.length > 10) {
      console.log(`  ... 他 ${targetFiles.length - 10} 件`);
    }
    console.log(`\n合計: ${targetFiles.length} 枚`);
    return;
  }

  // cards_master.json 読み込み
  if (!fs.existsSync(masterPath)) {
    console.error(`ERROR: cards_master.json が見つかりません: ${masterPath}`);
    process.exit(1);
  }
  const cardsMaster = JSON.parse(fs.readFileSync(masterPath, 'utf-8'));
  console.log(`cards_master.json 読み込み完了 (${Object.keys(cardsMaster).length} エントリ)`);

  // 各カードを順次処理
  console.log('\n=== 認識処理開始 ===');
  const results = [];
  for (let i = 0; i < targetFiles.length; i++) {
    const filename = targetFiles[i];
    const filepath = path.join(imageDir, filename);
    const tCard = Date.now();

    process.stdout.write(`[${i + 1}/${targetFiles.length}] ${filename} ...`);
    const r = await processCard(filepath, filename, cardsMaster);
    results.push(r);

    const elapsed = ((Date.now() - tCard) / 1000).toFixed(1);
    if (r.success) {
      const tag = r.isPerfect ? '✓ PERFECT' : '';
      console.log(
        ` ${r.matchedCount}/${r.totalCount} (${Math.round(r.achievementRate * 100)}%) ${tag} [${elapsed}s]`
      );
    } else {
      console.log(` ERROR: ${r.error} [${elapsed}s]`);
    }

    // レート制限対策(各カード間に 500ms)
    if (i < targetFiles.length - 1) await sleep(500);
  }

  // 統計サマリー構築 + 保存
  console.log('\n=== 統計サマリー構築 ===');
  const summary = buildSummary(results, cardsMaster, new Date().toISOString());
  fs.writeFileSync(outputPath, JSON.stringify(summary, null, 2), 'utf-8');

  // サマリー表示
  const totalSec = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n=== 処理完了 (${totalSec}秒) ===`);
  console.log(`成功: ${summary.successCount}/${summary.totalImages}`);
  console.log(`完全一致: ${summary.perfectCardCount}/${summary.successCount}`);
  console.log(`平均達成率: ${(summary.averageAchievementRate * 100).toFixed(1)}%`);
  console.log('\n[レアリティ別]');
  Object.entries(summary.rarityBreakdown).forEach(([k, v]) => {
    console.log(
      `  ${k}: ${v.count}枚 / 完全 ${v.perfectCount} / 平均 ${(v.averageRate * 100).toFixed(1)}%`
    );
  });
  console.log('\n[カードタイプ別]');
  Object.entries(summary.cardTypeBreakdown).forEach(([k, v]) => {
    console.log(
      `  ${k}: ${v.count}枚 / 完全 ${v.perfectCount} / 平均 ${(v.averageRate * 100).toFixed(1)}%`
    );
  });
  console.log('\n[項目別失敗率]');
  Object.entries(summary.fieldFailureBreakdown)
    .sort((a, b) => b[1].failRate - a[1].failRate)
    .forEach(([k, v]) => {
      console.log(
        `  ${k}: ${v.failCount}/${v.evaluatedCount} 失敗 (${(v.failRate * 100).toFixed(1)}%)`
      );
    });
  console.log(`\n結果ファイル: ${outputPath}`);
}

main().catch((e) => {
  console.error('\n致命的エラー:', e.message);
  console.error(e.stack);
  process.exit(1);
});
