#!/usr/bin/env node
/**
 * GCG STATS 自動ニュース生成スクリプト
 * 公式X(@GUNDAM_GCG_JP)の投稿を監視し、新カード情報・重要なお知らせを記事化してX投稿する
 *
 * Usage:
 *   node auto-news.js              # 通常実行（前回チェック以降の投稿を処理）
 *   node auto-news.js --dry-run    # 記事生成のみ（X投稿・git pushしない）
 *   node auto-news.js --since 2h   # 直近2時間の投稿を対象
 */
const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { pushFiles, pushBinaryFile } = require('./git-push');
const sharp = require('sharp');
// 指示書37c 後の緊急修正(2026-05-17): schtasks 経由起動時の cwd 問題対策
// __dirname を path に明示することで、cwd 関係なく homepage/.env を読込
require('dotenv').config({ path: require('path').join(__dirname, '.env'), override: true });

// === manual-card-news.js から試作改善関数を import(指示書32 で追加)===
// 指示書22-25 + 28-Rev1 の試作改善を本番運用に統合
// 注: manual-card-news.js は指示書30 で module.exports + require.main === module ガード追加済
const {
  callVisionAIv2,
  postProcessVisionResultV2,
  structureCardWithClaude,
} = require('./scripts/manual-card-news.js');

// === 共通モジュールから関数・定数を import(指示書34 で追加、循環依存解消、2026-05-16)===
// 利用者: auto-news.js / scripts/manual-card-news.js / scripts/batch-recognize.js
const {
  // 環境変数・定数
  ANTHROPIC_API_KEY,
  GOOGLE_CLOUD_API_KEY,
  ROOT,
  DATA_DIR,
  LOG_FILE,
  CARDS_PREVIEW_FILE,
  VISION_USAGE_FILE,
  VISION_MONTHLY_LIMIT,
  ANTHROPIC_API_URL,
  ANTHROPIC_MODEL_SONNET,
  ANTHROPIC_MODEL_OPUS,
  COLOR_JP,
  VALID_CARD_TYPES,
  COLOR_CROP,
  CARD_ZONES,
  // JST ユーティリティ
  toJST,
  nowJST,
  formatJST,
  dateStrJST,
  now,
  // ユーティリティ
  log,
  escapeHtml,
  stripTags,
  // Vision API 使用量
  getVisionUsage,
  incrementVisionUsage,
  isVisionQuotaAvailable,
  // API
  callClaude,
  callVisionAI,
  // パース補助
  fixCardId,
  cleanRarity,
  getBounds,
  flattenWords,
  wordsInZone,
  zoneText,
  zoneTextSpaced,
  // 画像処理
  classifyColor,
  detectCardColor,
  parseVisionBlocks,
  // Step 1-A/B/C
  step1A_visionOCR,
  step1B_pixelColorDetection,
  step1C_merge,
  fixBrackets,
  autoAddBrackets,
  // データ管理
  loadCardsMaster,
  loadSummary,
  loadCardsPreview,
  buildUnifiedCardDB,
  // 記事生成
  generateIntroText,
  generateCardAnalyses,
} = require('./scripts/shared/recognition-core.js');

// === セルフチェック: ファイル末尾の // EOF マーカーを確認 ===
{
  const selfSrc = fs.readFileSync(__filename, 'utf-8');
  if (!selfSrc.trimEnd().endsWith('// EOF')) {
    console.error('[FATAL] auto-news.js のファイル末尾が切断されています（// EOF が見つかりません）。実行を中止します。');
    process.exit(2);
  }
}

// === 設定 ===
// 注: ROOT, DATA_DIR, LOG_FILE, ANTHROPIC_API_URL, ANTHROPIC_MODEL_SONNET, ANTHROPIC_MODEL_OPUS,
//     CARDS_PREVIEW_FILE, ANTHROPIC_API_KEY, GOOGLE_CLOUD_API_KEY は指示書34 で
//     scripts/shared/recognition-core.js に移動 → 冒頭 require で取得済
const SITE_URL = 'https://gcg-stats.com';
const NEWS_DIR = path.join(ROOT, 'reports', 'news');
const LAST_CHECK_FILE = path.join(DATA_DIR, 'last-check.json');
const CARD_IMAGE_BASE = '../../images/cards'; // ローカル画像パス（記事HTMLからの相対パス）

const OFFICIAL_USER_ID = '1837069552842330114'; // @GUNDAM_GCG_JP
const RECOGNITION_LOG_FILE = path.join(DATA_DIR, 'card-recognition-log.json');

const NEWS_IMAGE_DIR = path.join(ROOT, 'images', 'news'); // 新カード画像保存先

const X_API_KEY = process.env.X_API_KEY;
const X_API_SECRET = process.env.X_API_SECRET;
const X_ACCESS_TOKEN = process.env.X_API_ACCESS_TOKEN;
const X_ACCESS_TOKEN_SECRET = process.env.X_API_ACCESS_TOKEN_SECRET;

const DRY_RUN = process.argv.includes('--dry-run');
// === TEST_MODE 制御(指示書32 で環境変数化、2026-05-17)===
// 優先順位: --no-test-mode > --test-mode > 環境変数 > デフォルト(true、安全側 = X 投稿スキップ)
const TEST_MODE = (
  process.argv.includes('--no-test-mode') ? false :
  process.argv.includes('--test-mode') ? true :
  process.env.AUTO_NEWS_TEST_MODE === 'false' ? false :
  process.env.AUTO_NEWS_TEST_MODE === 'true' ? true :
  true  // デフォルト = X 投稿スキップ(安全側)
);
// === postSurvey 制御(指示書32 で追加、デフォルト無効)===
// --enable-survey 指定時のみアンケート投稿を実行
const ENABLE_SURVEY = process.argv.includes('--enable-survey');

// === 時刻範囲指定(指示書33 で追加、2026-05-17)===
// --start-time YYYY-MM-DDTHH:MM (JST想定): X 投稿取得の開始時刻
// --end-time YYYY-MM-DDTHH:MM (JST想定): X 投稿取得の終了時刻
// --auto-window: 起動時刻から「前日18:00 JST → 当日18:00 JST」を自動計算(指示書35、schtasks 翌日 18:00 起動想定)
// 優先順位: --start-time/--end-time(明示指定) > --auto-window > last-check.json(従来)
function parseCliTimeArg(flagName) {
  const idx = process.argv.indexOf(flagName);
  if (idx === -1 || idx + 1 >= process.argv.length) return null;
  const raw = process.argv[idx + 1];
  // YYYY-MM-DDTHH:MM 形式 (JST想定)
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/);
  if (!m) {
    console.error(`[FATAL] ${flagName} の形式が不正です: ${raw}`);
    console.error('  期待形式: YYYY-MM-DDTHH:MM (JST想定、例: 2026-05-14T17:50)');
    process.exit(2);
  }
  const [, ymd, hh, mm] = m;
  // JST → UTC 変換(JST は UTC+9、+09:00 タイムゾーン付き ISO を Date でパース)
  const jstDate = new Date(`${ymd}T${hh}:${mm}:00+09:00`);
  if (isNaN(jstDate.getTime())) {
    console.error(`[FATAL] ${flagName} の値が無効です: ${raw}`);
    process.exit(2);
  }
  return jstDate.toISOString();
}

const CLI_START_TIME = parseCliTimeArg('--start-time');
const CLI_END_TIME = parseCliTimeArg('--end-time');
const AUTO_WINDOW = process.argv.includes('--auto-window');

// 引数の論理的整合性チェック
if (CLI_END_TIME && !CLI_START_TIME) {
  console.error('[FATAL] --end-time は --start-time と同時に指定してください(単独指定不可)');
  process.exit(2);
}
if (CLI_START_TIME && CLI_END_TIME) {
  if (new Date(CLI_START_TIME) >= new Date(CLI_END_TIME)) {
    console.error('[FATAL] --start-time は --end-time より前である必要があります');
    process.exit(2);
  }
}
if (AUTO_WINDOW && (CLI_START_TIME || CLI_END_TIME)) {
  console.error('[FATAL] --auto-window と --start-time/--end-time は同時指定できません');
  process.exit(2);
}

const USE_VISION_PIPELINE = process.env.USE_VISION_PIPELINE !== 'false'; // 新パイプライン有効化（デフォルトON）

// 注: COLOR_JP, VALID_CARD_TYPES は指示書34 で shared/recognition-core.js に移動

// === 拡張パック名マップ(指示書32 で追加、2026-05-17)===
// 拡張コードから「コード + コードネーム」表記を生成
// 確認済の2つのみ初期登録、未確認の拡張(GD01-03, ST01-09 等)はコードのみ表示
const EXPANSION_NAMES = {
  'GD04': 'GD04 Phantom Aria',
  'EB01': 'EB01 Eternal Nexus',
  // 将来追加対象: GD01/02/03(コードネーム未確認)、ST10(Generation Pulse の可能性)、ST01-09(未確認)
};

/**
 * 拡張コードから「拡張コード + コードネーム」表記を取得
 * @param {string} expansionCode 例: 'EB01', 'GD04'
 * @returns {string} 例: 'EB01 Eternal Nexus' / 未登録なら 'EB01' のみ / null/未定義なら空文字
 */
function formatExpansionName(expansionCode) {
  if (!expansionCode) return '';
  return EXPANSION_NAMES[expansionCode] || expansionCode;
}

// 注: VISION_USAGE_FILE, VISION_MONTHLY_LIMIT は指示書34 で shared/recognition-core.js に移動

// 注: toJST, nowJST, formatJST, dateStrJST, getVisionUsage,
//     incrementVisionUsage, isVisionQuotaAvailable は指示書34 で
//     shared/recognition-core.js に移動 → 冒頭 require で取得済

// === ユーティリティ ===
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 注: now, escapeHtml, stripTags, log は指示書34 で
//     shared/recognition-core.js に移動 → 冒頭 require で取得済

function todayStr() {
  return dateStrJST(new Date());
}

function dateLabel(dateStr) {
  // "2026-03-27" → "3/27"
  const m = dateStr.match(/(\d+)-(\d+)-(\d+)/);
  if (!m) return dateStr;
  return `${parseInt(m[2])}/${parseInt(m[3])}`;
}

function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/!/g, '%21').replace(/\*/g, '%2A')
    .replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29');
}

// === X API: OAuth 1.0a ===
function generateOAuthSignature(method, url, params, consumerSecret, tokenSecret) {
  const sortedParams = Object.keys(params).sort()
    .map(k => `${percentEncode(k)}=${percentEncode(params[k])}`).join('&');
  const baseString = `${method}&${percentEncode(url)}&${percentEncode(sortedParams)}`;
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');
}

function buildOAuthHeader(method, url, extraParams) {
  const oauthParams = {
    oauth_consumer_key: X_API_KEY,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: X_ACCESS_TOKEN,
    oauth_version: '1.0'
  };
  const allParams = { ...oauthParams, ...extraParams };
  oauthParams.oauth_signature = generateOAuthSignature(method, url, allParams, X_API_SECRET, X_ACCESS_TOKEN_SECRET);
  return 'OAuth ' + Object.keys(oauthParams).sort()
    .map(k => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`).join(', ');
}

// === X API: GET ===
function xGet(endpoint, params) {
  const baseUrl = `https://api.x.com${endpoint}`;
  const qs = Object.entries(params).map(([k,v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const fullUrl = `${baseUrl}?${qs}`;
  const authHeader = buildOAuthHeader('GET', baseUrl, params);

  return new Promise((resolve, reject) => {
    const urlObj = new URL(fullUrl);
    const req = https.request({
      hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: { 'Authorization': authHeader }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode === 200) resolve(JSON.parse(data));
        else reject(new Error(`X API GET ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// === X API: POST tweet ===
function postTweet(text) {
  if (DRY_RUN) { log(`[DRY-RUN] X投稿スキップ: ${text.substring(0, 60)}...`); return Promise.resolve(null); }
  const url = 'https://api.x.com/2/tweets';
  const authHeader = buildOAuthHeader('POST', url, {});
  const body = JSON.stringify({ text });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.x.com', path: '/2/tweets', method: 'POST',
      headers: { 'Authorization': authHeader, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode === 201) { log('X投稿成功'); resolve(JSON.parse(data)); }
        else { log(`X投稿失敗 (${res.statusCode}): ${data}`); reject(new Error(data)); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * 収録カード紹介検知時のアンケート投稿
 * poll + 公式ポストURL をテキストに含めて投稿
 */
function postSurvey(cardName, officialPostUrl) {
  if (DRY_RUN) {
    log(`[SKIP] アンケート投稿スキップ: ${cardName} / ${officialPostUrl}`);
    return Promise.resolve(null);
  }
  const url = 'https://api.x.com/2/tweets';
  const authHeader = buildOAuthHeader('POST', url, {});
  const body = JSON.stringify({
    text: `【アンケート】${cardName}の収録が発表されました！\nあなたはGCG STATSをどの程度利用していますか？\n${officialPostUrl}\n#ガンダムカードゲーム #GCG`,
    poll: {
      options: ['3日に1回程度', '週に1回程度', '1度だけ', '使ったことが無い・知らない'],
      duration_minutes: 1440
    }
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.x.com', path: '/2/tweets', method: 'POST',
      headers: { 'Authorization': authHeader, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode === 201) {
          const parsed = JSON.parse(data);
          log(`アンケート投稿成功: https://x.com/gcg_stats/status/${parsed.data.id}`);
          resolve(parsed.data.id);
        } else {
          log(`アンケート投稿失敗 (${res.statusCode}): ${data}`);
          resolve(null); // エラーでも後続処理を止めない
        }
      });
    });
    req.on('error', err => { log(`アンケート投稿エラー: ${err.message}`); resolve(null); });
    req.write(body);
    req.end();
  });
}

// 注: callClaude は指示書34 で shared/recognition-core.js に移動 → 冒頭 require で取得済

// === 画像取得 → base64 ===
function fetchImageBase64(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'GCG-STATS/1.0' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchImageBase64(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        const contentType = res.headers['content-type'] || 'image/jpeg';
        const mediaType = contentType.split(';')[0].trim();
        resolve({ base64: buf.toString('base64'), mediaType });
      });
    }).on('error', reject);
  });
}

// =============================================
// === Step1 新パイプライン: Vision AI + Claude 分離 ===
// =============================================

// 注: callVisionAI は指示書34 で shared/recognition-core.js に移動 → 冒頭 require で取得済

// 注: fixCardId, cleanRarity, getBounds, flattenWords, wordsInZone, zoneText, zoneTextSpaced,
//     CARD_ZONES は指示書34 で shared/recognition-core.js に移動 → 冒頭 require で取得済

// 注: parseVisionBlocks は指示書34 で shared/recognition-core.js に移動 → 冒頭 require で取得済

// 注: step1A_visionOCR, COLOR_CROP, classifyColor, detectCardColor, step1B_pixelColorDetection,
//     fixBrackets, autoAddBrackets, step1C_merge は指示書34 で
//     shared/recognition-core.js に移動 → 冒頭 require で取得済
// 注: extractLinkFromEffect は使用箇所なし(未使用関数)のため移動せず削除

// 新パイプラインのメインエントリ(指示書32 で試作改善を統合)
//   Step 1-A v2: callVisionAIv2 (DOCUMENT_TEXT_DETECTION + 日本語ヒント)
//   Step 1-B:    step1B_pixelColorDetection (既存)
//   Step 1-C:    step1C_merge (既存)
//   Step 2:      postProcessVisionResultV2 (effectKeywords 17要素 + 改善A-E)
//   Step 3:      structureCardWithClaude (System Prompt 強化、GCG 公式ルール準拠)
// 引数: imageBase64List = [{ base64: string }, ...]、戻り値: カード配列(現状維持)
async function extractCardDataVisionPipeline(imageBase64List) {
  // Vision API クォータチェック
  if (!isVisionQuotaAvailable(imageBase64List.length)) {
    return null; // 呼び出し元で従来パイプラインにフォールバック
  }

  // Step 1-B: ピクセル色判定(全画像まとめて並列)
  const colors = await step1B_pixelColorDetection(imageBase64List);

  // 各画像を順次処理(callVisionAIv2 → 初期 visionResult → step1C_merge → 後処理 → Claude 構造化)
  const cards = [];
  let visionSuccessCount = 0;
  for (let i = 0; i < imageBase64List.length; i++) {
    const item = imageBase64List[i];
    const color = colors[i] || null;
    try {
      // Step 1-A v2: Vision API (DOCUMENT_TEXT_DETECTION + 日本語ヒント)
      const visionResponse = await callVisionAIv2(item.base64, true);
      const fta = visionResponse.responses?.[0]?.fullTextAnnotation;
      if (!fta) {
        log(`  [Pipeline] 画像 ${i + 1}: fullTextAnnotation が空、スキップ`);
        continue;
      }
      visionSuccessCount++;
      const fullText = fta.text || '';
      const blockCount = fta.pages?.[0]?.blocks?.length || 0;
      log(`  [Step1-A v2] 画像 ${i + 1}: 認識テキスト ${fullText.length}文字 / ブロック ${blockCount}`);

      // 初期 visionResult(batch-recognize.js / manual-card-news.js と同形)
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

      // Step 1-C: マージ(color を統合 + 既存の effect/traits/rarity 修正)
      const merged = step1C_merge(visionResult, color);
      if (!merged) continue;

      // Step 2: 正規表現後処理(effectKeywords 17要素 + 改善A-E)
      const postProcessed = postProcessVisionResultV2(fullText, merged);

      // Step 3: Claude API による構造化(System Prompt 強化版)
      // 2026-05-24 マルチモーダル化(認識精度改修 案件1): 画像も渡して Lv 等の OCR 読取漏れを補完
      const final = await structureCardWithClaude(fullText, postProcessed, item.base64);

      cards.push(final);
    } catch (e) {
      log(`  [Pipeline] 画像 ${i + 1} 処理エラー: ${e.message}`);
    }
  }

  // Vision API 使用量を記録(Step1-A v2 で実際に成功した分)
  if (visionSuccessCount > 0) {
    const usage = incrementVisionUsage(visionSuccessCount);
    log(`  [Vision API] 使用量: ${usage.count}/${VISION_MONTHLY_LIMIT}`);
  }

  log(`  [Pipeline] 統合完了: ${cards.map((c) => c.card_number).filter(Boolean).join(', ') || '(card_number なし)'}`);
  return cards;
}

// === 前回チェック日時 ===
// last-check.json の手動補正について(指示書32 メモ、2026-05-17)
//   月次運用本格化開始時、以下の手順で last-check.json を補正:
//     1. homepage/data/last-check.json を直接編集
//     2. last_check の値を運用開始希望日時に補正
//        例: "last_check": "2026-05-09T00:00:00.000Z"
//     3. auto-news.js を起動すれば、その時刻以降のツイートを処理
//   自動補正は実装しない(意図しない再処理を回避するため)
function getLastCheck() {
  try {
    const data = JSON.parse(fs.readFileSync(LAST_CHECK_FILE, 'utf-8'));
    return data.last_check;
  } catch (e) {
    return new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
  }
}

// 指示書33: timestamp 引数(ISO 8601 文字列)対応、未指定なら現在時刻(従来通り)
function saveLastCheck(timestamp) {
  const value = timestamp || new Date().toISOString();
  fs.writeFileSync(LAST_CHECK_FILE, JSON.stringify({ last_check: value }, null, 2), { encoding: 'utf-8' });
}

/**
 * --auto-window 用の時刻範囲を自動計算(指示書33 で追加、指示書35 で時刻改修、2026-05-16)
 * 仕様: 「前日18:00 JST → 当日18:00 JST」(24時間きっかり)
 * 起動時刻が当日 18:00 JST 以降の想定(schtasks で 18:00 起動)
 * 公式X 運用: 17:00 + 17:30 JST 完全固定(5日連続実証、2026-05-10〜14)
 * 配信日特例(20:30 延期): 翌日記事で許容
 * @returns {{ startTime: string, endTime: string }} UTC ISO 8601 形式
 */
function calculateAutoWindow() {
  const now = new Date();
  // 現在時刻の JST 日付を取得(UTC + 9 hours)
  const jstNow = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const jstYear = jstNow.getUTCFullYear();
  const jstMonth = jstNow.getUTCMonth();
  const jstDay = jstNow.getUTCDate();
  // 当日 18:00 JST = UTC 09:00(指示書35 で改修)
  const endTime = new Date(Date.UTC(jstYear, jstMonth, jstDay, 9, 0, 0));
  // 前日 18:00 JST = UTC 09:00(前日、JS Date は jstDay - 1 で月またぎ自動処理)
  const startTime = new Date(Date.UTC(jstYear, jstMonth, jstDay - 1, 9, 0, 0));
  return {
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
  };
}

// --since パース
function parseSince() {
  const idx = process.argv.indexOf('--since');
  if (idx < 0) return null;
  const val = process.argv[idx + 1];
  if (!val) return null;
  const match = val.match(/^(\d+)([hmd])$/);
  if (!match) return null;
  const num = parseInt(match[1]);
  const unit = match[2];
  const ms = unit === 'h' ? num * 3600000 : unit === 'd' ? num * 86400000 : num * 60000;
  return new Date(Date.now() - ms).toISOString();
}

// === 公式ツイート取得 ===
// 指示書33: endTime オプション引数追加(未指定なら従来通り start_time のみ)
async function fetchOfficialTweets(sinceTime, endTime = null) {
  log(`公式X投稿を取得中... (since: ${sinceTime}${endTime ? `, until: ${endTime}` : ''})`);
  const params = {
    'start_time': sinceTime,
    'tweet.fields': 'created_at,text,attachments',
    'expansions': 'attachments.media_keys',
    'media.fields': 'url,type,preview_image_url',
    'max_results': '10'
  };
  // 指示書33: end_time 指定(--end-time / --auto-window 経由)
  // X API v2 制約: start_time/end_time は 10 秒以上前であること
  if (endTime) {
    params['end_time'] = endTime;
  }

  const data = await xGet(`/2/users/${OFFICIAL_USER_ID}/tweets`, params);

  const mediaMap = {};
  if (data.includes && data.includes.media) {
    data.includes.media.forEach(m => { mediaMap[m.media_key] = m; });
  }

  const tweets = (data.data || []).map(tw => {
    const mediaKeys = tw.attachments?.media_keys || [];
    const images = mediaKeys.map(mk => mediaMap[mk]).filter(m => m && m.type === 'photo').map(m => m.url);
    return { id: tw.id, text: tw.text, created_at: tw.created_at, images };
  });

  log(`  取得: ${tweets.length}件`);
  return tweets;
}

// === 記事タイプ判定 ===
function classifyTweet(tweet) {
  if (tweet.text.includes('【収録カード紹介】')) return 'new_card';
  if (tweet.text.includes('【重要なお知らせ】')) return 'notice';
  return null;
}

// === 画像認識結果の自動修正 ===
// 526枚テスト＋191枚X投稿画像テストから発見された誤読パターンを後処理で修正する
// cardsMaster: cards_master.jsonのデータ（card_idをキーとしたオブジェクト）。
//              card_numberに一致するカードがあれば、色・タイプ等をデータベース値で補正する。
function fixRecognitionErrors(result, cardsMaster) {
  if (!result) return result;

  // === 効果テキストの修正 ===
  if (result.effect) {
    // バースト括弧修正: 《バースト》→【バースト】
    result.effect = result.effect.replace(/《バースト》/g, '【バースト】');

    // EXリソースの誤読修正
    result.effect = result.effect.replace(/EEXリソース/g, 'EXリソース');
    result.effect = result.effect.replace(/(?<!E)Xリソース/g, 'EXリソース');
    result.effect = result.effect.replace(/Xソリュース/g, 'EXリソース');
    result.effect = result.effect.replace(/EXソリューズ/g, 'EXリソース');

    // 全角カッコ→半角カッコ（トークン仕様部分）
    // 「カード名」（〔trait〕... の形式を (〔trait〕... に変換
    result.effect = result.effect.replace(/」（〔/g, '」(〔');
    result.effect = result.effect.replace(/》）の/g, '》)の');
    result.effect = result.effect.replace(/([0-9])）の/g, '$1)の');

    // 存在しない効果タイミングの修正
    result.effect = result.effect.replace(/【起動時】/g, '【配備時】');

    // LINK条件の誤読修正: LINK欄の「特徴(XXX)」をeffectと誤認識するケースがある
    // effectが「《高機動》（XXX）」「特徴(XXX)」等のLINK条件のみの場合はeffect空にしてlinkに移動
    const linkMisread = result.effect.match(/^《?高機動》?[（(]([^）)]+)[）)]$/);
    const linkMisread2 = result.effect.match(/^特徴[（(〔]([^）)〕]+)[）)〕]$/);
    if (linkMisread) {
      result.link = `特徴に${linkMisread[1]}を持つPILOT`;
      result.effect = '';
    } else if (linkMisread2) {
      result.link = `特徴に${linkMisread2[1]}を持つPILOT`;
      result.effect = '';
    }

    // === 「が」→「か、」のOR条件修正 ===
    // 「このユニットが〔○○〕の自分のユニットが配備されたとき」→
    // 「このユニットか、〔○○〕の自分のユニットが配備されたとき」
    result.effect = result.effect.replace(
      /このユニットが(〔[^〕]+〕の自分のユニットが)/g,
      'このユニットか、$1'
    );

    // === カッコ種類の自動修正（プログラム的後処理） ===
    // キーワード効果が【】や〔〕で囲まれている場合 → 《》に修正
    const keywordEffects = ['制圧', '突破', '援護', 'ブロッカー', '先制攻撃', '高機動', 'リペア', 'クイック'];
    for (const kw of keywordEffects) {
      result.effect = result.effect.replace(new RegExp(`【${kw}(\\d*)】`, 'g'), `《${kw}$1》`);
      result.effect = result.effect.replace(new RegExp(`〔${kw}(\\d*)〕`, 'g'), `《${kw}$1》`);
    }
    // 効果タイミングが〔〕や《》で囲まれている場合 → 【】に修正
    const timings = ['配備時', 'アタック時', '破壊時', 'セット時', 'セット中',
                     'リンク時', 'リンク中', '起動・メイン', '起動・アクション',
                     'メイン', 'アクション', 'バースト', 'ターン1回', 'パイロット'];
    for (const t of timings) {
      result.effect = result.effect.replace(new RegExp(`〔${t}〕`, 'g'), `【${t}】`);
      result.effect = result.effect.replace(new RegExp(`《${t}》`, 'g'), `【${t}】`);
    }

    // === 《制圧》の注釈文テンプレート適用 ===
    // 《制圧》の後に誤った注釈文がある場合、定型テンプレートで置換
    result.effect = result.effect.replace(
      /《制圧》[（(][^）)]*[）)]/,
      '《制圧》（アタックでシールドに与えるダメージは、先頭から2つに同時に与えられる）'
    );

    // === 【リンク時】→【リンク中】の自動修正 ===
    // 「〜を得る」「〜になる」が続く場合は常時効果なので【リンク中】が正しい
    result.effect = result.effect.replace(
      /【リンク時】([^【]*(?:を得る|になる|AP\+|HP\+))/g,
      '【リンク中】$1'
    );

    // === 「アクション」の誤読修正 ===
    result.effect = result.effect.replace(/[ブフプ]クション/g, 'アクション');

    // === 数値なしダメージの警告フラグ ===
    if (result.effect.match(/[^0-9]ダメージを与える/) && !result.effect.match(/\dダメージを与える/)) {
      result._warning_no_damage_value = true;
    }
  }

  // === LINK条件テキストの正規化 ===
  // Opusが「特徴（ティターンズ）」「特徴(ザフト)」等の生テキストを返す場合があるため
  // findLinkTargets()で解析可能な標準形式「特徴にXXXを持つPILOT」に正規化する
  if (result.link) {
    const linkNorm = result.link.match(/^特徴[（(〔]([^）)〕]+)[）)〕]$/);
    if (linkNorm) {
      result.link = `特徴に${linkNorm[1]}を持つPILOT`;
    }
  }

  // === カードタイプの修正 ===
  const typeMap = {
    'キャラクター': 'PILOT',
    'モビルスーツ': 'UNIT',
    '機動ユニット': 'UNIT',
    'コマンド': 'COMMAND',
    'ベース': 'BASE'
  };
  if (typeMap[result.card_type]) {
    result.card_type = typeMap[result.card_type];
  }

  // === AP/HP修正 ===
  // 2026-05-24 PILOT認識改修: 指示書37e(2026-05-17) で PILOT も補正 AP/HP 必須化されたため
  // PILOT を強制 null 化する旧コードを除去。PILOT は補正値(+X+Y)を保持する。
  // 2026-05-24 BASE認識改修: 指示書37c(2026-05-17、松岡さん視認 EB01-090: AP=0,HP=4)で
  // BASE も AP 必須化されたため BASE 強制 null 化を除去。BASE は AP/HP 両方持つ。
  // COMMANDはAP/HPを持たない(従来通り)
  if (result.card_type === 'COMMAND') {
    result.ap = null;
    result.hp = null;
  }

  // === 色の正規化 ===
  const colorMap = { '青': 'Blue', '赤': 'Red', '緑': 'Green', '白': 'White', '紫': 'Purple' };
  if (colorMap[result.color]) result.color = colorMap[result.color];

  // === X投稿画像対応: card_numberベースのデータベース補正 ===
  // X投稿画像では背景色によりcolor誤認識が多発する（White正解率32%等）。
  // card_numberが認識できており、cards_masterにデータがある場合は
  // データベースの値で色・タイプ・特徴等を上書きする。
  // 既存カード（DB登録済み）のeffectもDB値で上書きする（長文誤読防止）。
  // 新カード（DB未登録）のeffectのみ画像認識値を使用する。
  if (cardsMaster && result.card_number) {
    const masterCard = cardsMaster[result.card_number];
    if (masterCard) {
      // 色: X投稿画像での誤認識が最も深刻（全体74%、White32%）なのでDB値を優先
      if (masterCard.color) result.color = masterCard.color;
      // カードタイプ: PILOT/COMMAND混同対策
      if (masterCard.card_type) result.card_type = masterCard.card_type;
      // 特徴: 画像からの読み取りが困難な場合が多い
      if (masterCard.traits) result.traits = masterCard.traits;
      // 数値フィールド: DB値があれば補正
      if (masterCard.level !== undefined) result.level = masterCard.level;
      if (masterCard.cost !== undefined) result.cost = masterCard.cost;
      if (masterCard.ap !== undefined) result.ap = masterCard.ap;
      if (masterCard.hp !== undefined) result.hp = masterCard.hp;
      // 効果テキスト: 既存カードはDB値で上書き（長文の誤読防止）
      if (masterCard.effect) result.effect = masterCard.effect;
      // AP/HP再修正（card_typeをDB値で補正した後）
      // 2026-05-24 PILOT認識改修: PILOT は補正 AP/HP 必須化(指示書37e)のため強制 null から除外
      // 2026-05-24 BASE認識改修: BASE は AP/HP 両方持つ(指示書37c)ため強制 null 化を除去
      if (result.card_type === 'COMMAND') {
        result.ap = null;
        result.hp = null;
      }
    }
  }

  return result;
}

// 注: loadCardsMaster, loadSummary, loadCardsPreview は指示書34 で
//     shared/recognition-core.js に移動 → 冒頭 require で取得済

// === cards_preview.json: 仮データ管理(auto-news.js 専用 saveCardPreview のみ残置)===

/**
 * Step1-C マージ後のカードデータを cards_preview.json に追記保存
 * 同じcard_numberが既存なら上書き更新
 * @param {Object} cardInfo - マージ済みカードデータ
 * @param {string} sourceUrl - 出典XポストURL
 */
function saveCardPreview(cardInfo, sourceUrl) {
  if (!cardInfo || !cardInfo.card_number) return;
  const preview = loadCardsPreview();

  preview[cardInfo.card_number] = {
    card_number: cardInfo.card_number,
    card_name: cardInfo.card_name,
    color: cardInfo.color,
    card_type: cardInfo.card_type,
    level: cardInfo.level,
    cost: cardInfo.cost,
    ap: cardInfo.ap,
    hp: cardInfo.hp,
    terrain: cardInfo.terrain || [],
    traits: cardInfo.traits || [],
    link: cardInfo.link || '',
    rarity: cardInfo.rarity,
    effect: cardInfo.effect || '',
    source_url: sourceUrl || '',
    created_at: formatJST(new Date()),
    preview: true,
    // 指示書37: 認識精度問題フラグ(手動補完用)
    _pendingReview: cardInfo._pendingReview === true,
    _pendingReviewIssues: cardInfo._pendingReviewIssues || [],
    // 指示書37: 再生成用の記事日付保持(regenerate-article.js から参照)
    _articleDate: cardInfo._articleDate || null
  };

  fs.writeFileSync(CARDS_PREVIEW_FILE, JSON.stringify(preview, null, 2), 'utf-8');
  const flag = cardInfo._pendingReview === true ? ' [PENDING_REVIEW]' : '';
  log(`  [Preview] ${cardInfo.card_number} を cards_preview.json に保存${flag}`);
}

/**
 * 認識精度問題の判定(指示書37、2026-05-17)
 * 松岡さん戦略: 認識精度問題発生時には記事生成を停止 → 手動補完 → 再生成
 *
 * 判定条件:
 * 1. color が "Unknown" / null / 空 ← 色判定不能
 * 2. card_number が null / 空 ← 必須
 * 3. card_name が null / 空 ← 必須
 * 4. カードタイプ別の必須フィールド未取得:
 *    - UNIT: level, cost, ap, hp のいずれかが - or null
 *    - PILOT: level, cost, ap(補正), hp(補正) のいずれかが - or null（指示書37e 2026-05-17 で補正AP/HP必須化）
 *    - COMMAND: level, cost のいずれかが - or null(ap/hp は許容)（指示書37b 2026-05-17）
 *    - BASE: level, cost, ap, hp のいずれかが - or null（指示書37b/37c 2026-05-17、BASE も AP 必須化）
 *
 * @param {Object} cardData - 構造化済みのカードデータ
 * @returns {{hasIssue: boolean, issues: string[]}}
 */
function checkRecognitionIssues(cardData) {
  const issues = [];

  // 共通必須フィールド
  if (!cardData.color || cardData.color === 'Unknown' || cardData.color === '') {
    issues.push(`color が ${cardData.color || 'null'} (色判定不能)`);
  }
  if (!cardData.card_number || cardData.card_number === '不明') {
    issues.push('card_number が空');
  }
  if (!cardData.card_name) {
    issues.push('card_name が空');
  }

  // カードタイプ別必須フィールド
  const isEmpty = v => v === null || v === undefined || v === '-' || v === '';
  const cardType = cardData.card_type;
  if (cardType === 'UNIT') {
    if (isEmpty(cardData.level)) issues.push('UNIT の level が空');
    if (isEmpty(cardData.cost)) issues.push('UNIT の cost が空');
    if (isEmpty(cardData.ap)) issues.push('UNIT の ap が空');
    if (isEmpty(cardData.hp)) issues.push('UNIT の hp が空');
  } else if (cardType === 'PILOT') {
    // 指示書37e(2026-05-17): PILOT も補正 AP/HP 必須(松岡さんドメイン専門知識による訂正)
    // PILOT カードに記載された補正値(UNIT にセット時の AP/HP 増分、0 含む)
    if (isEmpty(cardData.level)) issues.push('PILOT の level が空');
    if (isEmpty(cardData.cost)) issues.push('PILOT の cost が空');
    if (isEmpty(cardData.ap)) issues.push('PILOT の ap(補正) が空');
    if (isEmpty(cardData.hp)) issues.push('PILOT の hp(補正) が空');
  } else if (cardType === 'COMMAND') {
    // 指示書37b(2026-05-17): COMMAND もレベル・コスト必須(松岡さんドメイン専門知識による訂正)
    if (isEmpty(cardData.level)) issues.push('COMMAND の level が空');
    if (isEmpty(cardData.cost)) issues.push('COMMAND の cost が空');
  } else if (cardType === 'BASE') {
    // 指示書37b 更新版(2026-05-17): BASE もレベル必須(松岡さんドメイン専門知識による訂正)
    // 指示書37c(2026-05-17): BASE も AP 必須化(松岡さん視認結果 EB01-090: AP=0 でも値として存在)
    if (isEmpty(cardData.level)) issues.push('BASE の level が空');
    if (isEmpty(cardData.cost)) issues.push('BASE の cost が空');
    if (isEmpty(cardData.ap)) issues.push('BASE の ap が空');
    if (isEmpty(cardData.hp)) issues.push('BASE の hp が空');
  } else {
    issues.push(`card_type が ${cardType || 'null'} (UNIT/PILOT/COMMAND/BASE のいずれでもない)`);
  }

  return {
    hasIssue: issues.length > 0,
    issues: issues,
  };
}

// 注: buildUnifiedCardDB は指示書34 で shared/recognition-core.js に移動 → 冒頭 require で取得済

// === Step 1: カードデータ抽出（画像→JSON） ===
const STEP1_SYSTEM_PROMPT = `あなたはガンダムカードゲーム（GCG）のカード画像からデータを抽出する専門ツールです。
画像に写っているカードの情報を正確に読み取り、JSON形式で出力してください。
JSON以外のテキストは一切出力しないこと。考察や評価も一切不要。

=== 最重要: 出力前に必ず適用する自動置換ルール ===

効果テキストを出力する前に、以下の置換を必ず適用すること。

■ 《制圧》の定型出力（必須置換）
「制圧」というキーワードを認識したら、注釈文を含めて以下の定型テキストをそのまま使うこと:
《制圧》（アタックでシールドに与えるダメージは、先頭から2つに同時に与えられる）
※【制圧】は誤り → 《制圧》に置換
※注釈文は画像を読まず上記テンプレートをそのまま使うこと

■ カッコ種類の自動修正
出力前に以下をチェックし、誤りがあれば置換する:
- 制圧・突破・援護・ブロッカー・先制攻撃・高機動・リペア・クイック → 必ず《》で囲む
  例: 【制圧】→《制圧》、〔制圧〕→《制圧》
- 配備時・アタック時・破壊時・セット時・セット中・リンク時・リンク中・起動・メイン・アクション・バースト・ターン1回・パイロット → 必ず【】で囲む
  例: 〔メイン〕→【メイン】、《アクション》→【アクション】
- ネオ・ジオン・地球連邦・CB・WB隊・ティターンズ等の組織・所属名 → 必ず〔〕で囲む
  例: 《ネオ・ジオン》→〔ネオ・ジオン〕

■ 「が」→「か、」の文法チェック（必須）
「このユニットが〔○○〕の自分のユニットが配備されたとき」のように「が」が2回続く文は日本語として不正。
正しくは「このユニットか、〔○○〕の自分のユニットが配備されたとき」（OR条件）。
出力前に「が」が2回続いていないかチェックし、最初の「が」を「か、」に修正すること。

■ 効果タイミングの頻出パターン
COMMANDカードの効果は「【メイン】」または「【アクション】」で始まることが多い。
「【メイン】・【アクション】」は非常に頻出する組み合わせ。
【ターン1回】はこれとは別の制限表記で、単独で使われるか、他のタイミングと併記される。
【バースト】も別の効果タイミング。画像の文字をよく見て正確に判別すること。

■ 数値は絶対に省略禁止
- ✗「ダメージを与える」 → ✓「3ダメージを与える」
- ✗「AP-する」 → ✓「AP-2する」
数値なしの「ダメージを与える」は出力エラー。必ず数字を含めること。

■ GCG専用用語（一般語に置き換え禁止）
配備（✗配置）、発動（✗実行）、選ぶ（✗選択する）、トラッシュ（✗捨て札）、
シールドエリア（✗シールドゾーン）、アクティブ（✗起動状態）、レスト（✗休息状態）

■ 「アクション」の誤読修正
「〜クション」と読めたら「アクション」に修正。「ブクション」「フクション」はGCGに存在しない。

■ よくある認識ミス
「EEXリソース」「Xリソース」→「EXリソース」
《バースト》→【バースト】

=== カードの構造 ===

カード右上: カード番号（例: GD04-066）とレアリティ
カード左上: Lv（レベル）とCOST（コスト）の数値
カード右側縦書き: カードタイプ（UNIT/PILOT/COMMAND/BASE）
カード中央下: カード名
カード名の下: 効果テキスト
カード下部: 地形アイコン（宇宙/地球）、特徴、LINK欄
カード右下: AP（左）とHP（右）※UNIT/BASEは通常値、PILOTはカード名右横の "+X+Y" 形式（補正値）

=== 色の判定 ===

カードのフレーム（枠）の色で判定する。イラストの色や背景色は無視すること。
青: 青色のフレーム / 赤: 赤色・朱色のフレーム / 緑: 緑色のフレーム / 白: 白〜銀色のフレーム / 紫: 青紫〜マゼンタのフレーム

【赤と紫の判定手順（頻出ミス）】
赤と紫を間違えやすい。以下の手順で慎重に判定すること:
1. カード左上のLv/COST表示エリアの背景色を確認
   赤カード: 明るい赤・朱色・暖色系の赤
   紫カード: 暗い紫・青紫・冷色系の紫
2. カードの枠全体の色調を確認
   赤カード: 暖色系（赤・朱・橙寄り）
   紫カード: 冷色系（青紫・マゼンタ寄り）
3. 判定基準: Lv/COSTの背景が暖色（赤・朱・橙）なら Red、冷色（青紫・マゼンタ）なら Purple
※イラストのエフェクト色（炎、ビーム等）に惑わされないこと

=== 【リンク時】と【リンク中】の区別 ===

画像の文字をよく見て「時」か「中」かを判別すること。
- 【リンク時】= 1回だけ発動する効果（「〜する」「〜を与える」等の動作）
- 【リンク中】= ずっと有効な常時効果（「〜を得る」「〜になる」等の状態付与）
例: 「自分のユニットすべては〔ネオ・ジオン〕を得る」→ 状態付与なので【リンク中】

=== AP/HPの扱い ===
UNIT: AP/HPの数値を読み取る / PILOT: 補正AP/HPの数値を読み取る（カード名右横の "+X+Y" 形式、0 含む整数 0-9） / COMMAND: ap=null, hp=null / BASE: AP/HPの数値を読み取る（指示書37cにより BASE も AP 必須化、0 含む整数 0-9。例: EB01-090 は AP=0, HP=4）

=== Level (Lv) の扱い (2026-05-24 案件3 改修) ===
カード左上の "Lv.X" 表示を**カードタイプに関わらず**(UNIT/PILOT/COMMAND/BASE 全て)読み取ること。
- PILOT カードでも level は必須項目(GD/EB シリーズで Lv 表示位置が薄く OCR で見落とされやすいので注意)
- 効果テキスト内の "Lv.X 以下" 表記はそのカード自身の Lv ではない(対象指定)。混同禁止
- 1-12 の整数。読み取れない場合のみ null

=== color の扱い (2026-05-24 案件4 改修) ===
- 値は必ず英語のみ: "Blue" / "Red" / "Green" / "White" / "Purple"
- 日本語表記("赤"/"青"/"緑"/"白"/"紫")は禁止
- 判定不能時のみ "Unknown"

=== 読み取りルール ===
- 画像から読み取れる情報のみを出力。推測や補完をしない
- 読み取れない部分は null
- 効果テキストはそのまま転記（要約・省略禁止）
- 「選ぶ」と「破壊する」は別のゲームアクション。混同しない`;

const STEP1_USER_PROMPT = `この画像に写っているカードの情報をJSON形式で出力してください。
背景に商品パッケージ、ロゴ、セット名、発売日等が含まれていますが、それらは無視してください。
カード枠内の情報のみを読み取ってください。

出力形式（カードが複数枚ある場合は配列で出力）:
{
  "card_number": "GD04-XXX",
  "card_name": "カード名",
  "color": "Blue/Red/Green/White/Purple",
  "card_type": "UNIT/PILOT/COMMAND/BASE",
  "level": 数値またはnull,
  "cost": 数値またはnull,
  "ap": 数値またはnull,
  "hp": 数値またはnull,
  "terrain": ["宇宙", "地球"],
  "traits": ["特徴名"],
  "link": "リンク条件テキスト（あれば）",
  "rarity": "LR/SR/R/U/C",
  "effect": "効果テキスト全文（改行は\\nで表現）"
}`;

async function extractCardData(imageBase64List) {
  const content = [];
  for (const { base64, mediaType } of imageBase64List) {
    content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } });
  }
  content.push({ type: 'text', text: STEP1_USER_PROMPT });

  log('  [Step1] カードデータ抽出中 (Sonnet)...');
  const result = await callClaude(
    [{ role: 'user', content }],
    1500,
    ANTHROPIC_MODEL_SONNET,
    STEP1_SYSTEM_PROMPT
  );

  // JSONを抽出
  const jsonStr = result.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
  try {
    const parsed = JSON.parse(jsonStr);
    const cards = Array.isArray(parsed) ? parsed : [parsed];
    log(`  [Step1] 抽出完了: ${cards.map(c => c.card_number).join(', ')}`);
    return cards;
  } catch (e) {
    // フォールバック: JSON部分だけ抽出
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return Array.isArray(parsed) ? parsed : [parsed];
    }
    throw new Error(`Step1 JSON解析失敗: ${e.message}`);
  }
}

// === Step 1.5: cards_master.json照合 ===
function verifyWithMaster(extractedData, cardsMaster) {
  if (!cardsMaster || !extractedData.card_number) return extractedData;

  const masterCard = cardsMaster[extractedData.card_number];
  if (masterCard) {
    log(`  [Step1.5] ${extractedData.card_number} found in master, using DB values`);
    return {
      ...extractedData,
      card_name: masterCard.name_jp || extractedData.card_name,
      color: masterCard.color || extractedData.color,
      card_type: masterCard.card_type || extractedData.card_type,
      level: masterCard.level !== undefined ? masterCard.level : extractedData.level,
      cost: masterCard.cost !== undefined ? masterCard.cost : extractedData.cost,
      ap: masterCard.stats ? masterCard.stats.ap : extractedData.ap,
      hp: masterCard.stats ? masterCard.stats.hp : extractedData.hp,
      traits: masterCard.traits || extractedData.traits,
      link: masterCard.link ? masterCard.link.join('、') : extractedData.link,
      effect: masterCard.effect || extractedData.effect,
      _ocr_original: extractedData  // デバッグ用: 元の画像認識結果を保存
    };
  }

  log(`  [Step1.5] ${extractedData.card_number} NOT in master, using OCR values`);
  return extractedData;
}

// === 新カード: 画像認識（レガシー: 1段階方式） ===
async function recognizeCard(imageUrls, cardsMaster) {
  if (!imageUrls || imageUrls.length === 0) return null;

  const content = [];
  for (const url of imageUrls.slice(0, 2)) {
    try {
      const { base64, mediaType } = await fetchImageBase64(url);
      content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } });
    } catch (e) {
      log(`  画像取得失敗: ${url} - ${e.message}`);
    }
  }

  if (content.length === 0) return null;

  content.push({ type: 'text', text: `この画像はガンダムカードゲーム（GCG）の公式X投稿のカード紹介画像です。
背景に商品パッケージ、ロゴ、セット名、発売日等が含まれていますが、それらは無視してください。
カード枠内の情報のみを読み取り、以下のJSON形式で出力してください。
JSON以外の文章は一切出力しないでください。

{
  "card_number": "GD04-XXX",
  "card_name": "カード名",
  "rarity": "R/SR/LR等",
  "color": "青/赤/緑/白/紫",
  "card_type": "UNIT/PILOT/COMMAND/BASE",
  "level": 数値,
  "cost": 数値,
  "ap": 数値またはnull,
  "hp": 数値またはnull,
  "zone": "宇宙/地球/両方/なし",
  "traits": ["特徴1", "特徴2"],
  "link": "リンク条件テキスト（あれば。例: 「特徴にティターンズを持つPILOT」「シャア・アズナブル」等）",
  "effect": "効果テキスト全文（画像の文字をそのまま転記）",
  "source_title": "作品名（あれば）"
}

【リンク条件の読み取り（必須）】
UNITカードにはリンク条件が設定されている場合がある。
カード下部の「LINK」と縦書きされた黒枠内にリンク条件が記載されている。
リンク条件は必ず読み取ること。読み取れない場合は「[リンク条件判読不能]」と明記すること。

リンク条件がある場合:
1. リンク条件のテキストを出力に含めること
2. cards_master.jsonからリンク条件に該当するPILOTを抽出して関連カードに含めること

=== 重要な読み取りルール ===

■ カッコの使い分け（最重要）
GCGでは以下の4種類のカッコが使い分けられている。混同しないこと。

1. 【】（黒カッコ）= ゲームメカニクス・効果タイミング
   【バースト】【配備時】【セット時】【セット中】【リンク時】【リンク中】
   【アタック時】【起動・メイン】【起動・アクション】【ターン1回】
   【メイン】【アクション】【パイロット】
   ※特に「バースト」は必ず【バースト】と書く。《バースト》は誤り。

2. 《》（二重山カッコ）= キーワード能力のみ
   《リペア1》《リペア2》《突破1》《突破2》《突破3》《突破4》
   《ブロッカー》《クイック》《高機動》《制圧》《先制攻撃》《援護1》《援護2》
   ※バーストは【】で書く。《バースト》は存在しない。

3. 〔〕（亀甲カッコ）= 所属・特徴の参照
   〔ジオン〕〔地球連邦〕〔ティターンズ〕〔CB〕〔鉄華団〕等

4. 「」（カギカッコ）= カード名・トークン名の参照

■ 効果タイミングの正確な読み取り
- 【セット時】= パイロットセット時に1回発動 ≠ 【セット中】= セット中ずっと有効
- 【リンク時】= リンク時に1回発動 ≠ 【リンク中】= リンク中ずっと有効
- 【配備時】= 配備時に1回発動
- 【起動・メイン】/【起動・アクション】は存在するが「起動時」は存在しない
- 条件付き: 【セット中・〔ネオ・ジオン〕のパイロット】のように「・」の後に条件

■ AP/HPの扱い
- UNIT: AP/HPの数値を読み取る
- PILOT: 補正AP/HPの数値を読み取る（カード名右横の "+X+Y" 形式、0 含む整数 0-9）
- COMMAND: ap=null, hp=null
- BASE: AP/HPの数値を読み取る（指示書37cにより BASE も AP 必須化、0 含む整数 0-9。例: EB01-090 は AP=0, HP=4。AP=0 でも null ではなく 0 として保持）

■ 【パイロット】指定
COMMANDカードの効果テキスト末尾に【パイロット】「カード名」がある場合、
効果テキストの一部として必ず含めること。

■ トークン仕様
半角カッコ()で記述: (〔trait〕・AP数・HP数・能力)

【GCG用語辞書】

■ カードタイプ（4種のみ。カード右上の英語表記を確認すること）
UNIT / PILOT / COMMAND / BASE
※「キャラクター」「モビルスーツ」「機動ユニット」は存在しない
※COMMANDカードに【パイロット】指定があるとイラストがキャラクターに見えるが、右上の表記がCOMMANDならCOMMAND

■ リソース関連
「EXリソース」 ← 正しい表記。「Xリソース」「EEXリソース」「EXソリューズ」等は誤読

■ 色（カード枠の色で判定。背景色は絶対に参照しない）
青(Blue) / 赤(Red) / 緑(Green) / 白(White) / 紫(Purple)
※White(白)カードは銀色/灰白色の枠で、背景色の影響を受けやすい。彩度が低いフレームはWhiteを疑う

【新カードの色判定（重要）】
X投稿画像では背景色がカードの色と異なる場合がある。
色の判定は必ずカードフレーム（枠）の色で行うこと。背景は無視すること。

各色のフレーム特徴:
- 青: 青色のフレーム、左上のLv/COST表記エリアが青系
- 赤: 赤色のフレーム、左上のLv/COST表記エリアが赤系
- 緑: 緑色のフレーム、左上のLv/COST表記エリアが緑系
- 白: 白〜銀色のフレーム、他色より明るい
- 紫: 紫色のフレーム、左上のLv/COST表記エリアが紫系

色の判定に自信がない場合は「[色判定不確実]」と明記すること。

【記事に必ず含める要素（省略不可）】

1. カード画像
   - X投稿画像をダウンロードして /images/news/{date}/ にローカル保存した画像を表示
   - 画像が存在しない場合は記事生成を中断してエラーログを出力すること

2. ステータス表（テーブル）
   以下の項目をすべて含むこと:
   - 色 / タイプ（UNIT/PILOT/COMMAND/BASE）/ Lv / コスト（COST）
   - AP・HP（UNITの場合）/ 特徴 / リンク条件（ある場合）

3. 効果テキスト
   - 画像認識で読み取った効果テキストを「効果:」として表示すること
   - 効果なし（バニラ）の場合は「効果なし（バニラ）」と明記

4. 考察文
   - 効果テキストの内容に基づいた具体的な評価を書くこと
   - ステータス（Lv/コスト/AP/HP）と効果の両面から評価すること
   - 「高機動ユニット」「注目される」等の抽象的な表現だけで終わらせないこと
   - 最低3文以上の考察を書くこと

5. 関連カード（同色・同特徴の既存カード）
   - cards_master.jsonから同色デッキ内で採用率が高いカードを5枚程度抽出
   - 各カードにローカル画像（/images/cards/{card_id}.webp）を表示
   - カード詳細ページ（/cards/{card_id}/）へのリンクを設定

6. リンク対象カード（リンク条件がある場合）
   - cards_master.jsonからリンク条件に該当するPILOTを抽出
   - 各カードにローカル画像（/images/cards/{card_id}.webp）を表示
   - カード詳細ページへのリンクを設定
   - 「公式サイトをご確認ください」のような表現は使わないこと

7. 出典
   - 公式Xの具体的な投稿URL（https://x.com/GUNDAM_GCG_JP/status/数字）を記載
   - アカウントURLだけの記載は不可

【表記の追加ルール】
- 「GUNDAM DYNASTY」は使わない。セット名（例: GD04 Phantom Aria）を使う
- 「属性」は使わない。「色」が正しい
- 「捨て札にする」は使わない。「トラッシュに置く」が正しい
- 「突破時」は存在しない。「【破壊時】」の誤読
- 「シールドゾーン」は使わない。「シールドエリア」が正しい

【効果テキストの読み取り】
- 【破壊時】と「突破時」を混同しないこと（別物）
- 長文でも推測で補完しないこと。読めない部分は「[判読不能]」と明記

【効果テキストが空の場合】
- 「効果なし（バニラ）」として扱い、ステータスとコスト効率で評価する
- 「効果が不明」「評価できない」とは書かない

■ 特徴の例
地球連邦 / ジオン / ザフト / ティターンズ / エゥーゴ / 鉄華団 / 国連 /
学園 / ベネリットグループ / WB隊 / ミネルバ隊 / オーブ /
クロスボーン・バンガード / ネオ・ジオン / ソレスタルビーイング / CB / GNドライヴ

■ よくある認識ミス（必ず修正すること）
「EEXリソース」→「EXリソース」
「Xリソース」→「EXリソース」
《バースト》→【バースト】

■ 【破壊時】と《突破》の区別（重要）
- 《突破》はキーワード効果（数値付き）。「《突破3》」のように記載される
- 【破壊時】はキーワード（効果タイミング）。「【破壊時】〜する」のように記載される
- この2つは全く別物。「突破時」という表記はGCGに存在しない
- 画像内に「【破壊時】」と書かれているものを「突破時」と読み替えないこと

■ 長文効果テキストの注意
- 効果テキストが長い場合でも、推測で補完しないこと
- 読めない文字がある場合は「[判読不能]」と明示すること
- 特に以下の部分を正確に読むこと:
  - 対象の条件（「Lv.5以下の〔CB〕の」等）
  - 処理の結果（「手札に加える」「デッキの下に戻す」「トラッシュに置く」等）
  - 選択の有無（「〜してもよい」「〜する」の違い）

■ 存在しない用語（絶対に使わないこと）
合体 / アップグレード / エース効果 / エースパーツ / 機動ユニット / Xソリューズ / 重大損傷コマンド / モビルパック
「捨て札にする」→ GCGでは「トラッシュに置く」が正しい
「突破時」→ GCGに存在しない。「【破壊時】」の誤読
「シールドゾーン」→ 正しくは「シールドエリア」

■ 《制圧》の注釈文に注意
《制圧》の注釈文は以下の形式:
「(アタックでシールドに与えるダメージは、先頭から2つに同時に与えられる)」
これを正確に読み取ること。「マールド」「5クラ」等の誤読は発生してはならない。
読み取れない場合は「[判読不能]」とし、推測で文章を生成しないこと。

■ 「コマンド」と「コスト」の混同防止
- 「コマンドのメイン/アクション」= コマンドカードのメイン/アクション効果
- 「コスト0のメイン/アクション」= 全く別の意味
この2つを混同しないこと。

■ 特徴とキーワード効果の区別
- 〔ネオ・ジオン〕= 特徴（カードが持つ所属・属性）、〔〕で囲む
- 《高機動》= キーワード効果（ゲーム上の能力）、《》で囲む
「〔○○〕を得る」は特徴を得る効果。「《○○》を得る」はキーワード効果を得る効果。
この2つは全く別物なので混同しないこと。

■ 効果テキストの幻覚防止（重要）
画像から読み取れない効果を推測で追加しないこと。
特に以下のパターンに注意:
- 存在しない「ドロー効果」を追加しない
- 存在しない「【ターン1回】」を追加しない
- 「ダメージを与える」を「破壊する」に変換しない
- 効果が読めない場合は「[判読不能]」とすること` });

  log('  カード画像認識中 (Opus)...');
  const result = await callClaude([{ role: 'user', content }], 2000, ANTHROPIC_MODEL_OPUS);

  try {
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const cards = Array.isArray(parsed) ? parsed : [parsed];
      // 自動修正（card_numberベースのDB補正含む） → バリデーション
      return cards.map(c => validateCardInfo(fixRecognitionErrors(c, cardsMaster)));
    }
  } catch (e) {
    log(`  画像認識JSON解析失敗: ${e.message}`);
  }
  return null;
}

// === 効果テキスト信頼度判定 ===
function getEffectConfidence(effectText) {
  if (!effectText) return 'high'; // バニラ
  if (effectText.length <= 50) return 'high';
  if (effectText.length <= 100) return 'medium';
  return 'low'; // 長文は誤読リスクが高い
}

// === 認識結果ログ保存 ===
function saveRecognitionLog(date, cardInfoList, sourceTweets) {
  let logData = {};
  if (fs.existsSync(RECOGNITION_LOG_FILE)) {
    try {
      logData = JSON.parse(fs.readFileSync(RECOGNITION_LOG_FILE, 'utf-8'));
    } catch (e) {
      log(`  認識ログ読み込み失敗（新規作成します）: ${e.message}`);
    }
  }

  const existingCards = (logData[date] && logData[date].cards) || [];

  const newCards = cardInfoList.map(c => ({
    card_number: c.card_number || '不明',
    card_name: c.card_name || '不明',
    color: c.color || '不明',
    card_type: c.card_type || '不明',
    level: c.level || null,
    cost: c.cost || null,
    ap: c.ap || null,
    hp: c.hp || null,
    traits: c.traits || [],
    link: c.link || '',
    effect: c.effect || '',
    effect_confidence: getEffectConfidence(c.effect),
    effect_length: (c.effect || '').length,
    image_url: c._xImageUrl || null,
    confidence: 'medium'
  }));

  // 既存カードとマージ（同一card_numberは上書き、ただしlinkは前回値を保持）
  const mergedMap = {};
  for (const card of existingCards) mergedMap[card.card_number] = card;
  for (const card of newCards) {
    const prev = mergedMap[card.card_number];
    // 新認識でlinkが空だが前回認識にlinkがあれば復元
    if (!card.link && prev && prev.link) {
      card.link = prev.link;
    }
    mergedMap[card.card_number] = card;
  }
  const mergedCards = Object.values(mergedMap);

  logData[date] = {
    recognized_at: formatJST(new Date()),
    source_tweets: [...new Set([
      ...((logData[date] && logData[date].source_tweets) || []),
      ...sourceTweets
    ])],
    cards: mergedCards,
    status: 'pending_review'
  };

  fs.writeFileSync(RECOGNITION_LOG_FILE, JSON.stringify(logData, null, 2), 'utf-8');
  log(`  認識ログ保存: ${RECOGNITION_LOG_FILE} (${mergedCards.length}枚)`);
}

// === カード情報バリデーション ===
function validateCardInfo(card) {
  // card_type を正規化
  if (card.card_type && !VALID_CARD_TYPES.includes(card.card_type)) {
    const typeMap = { 'キャラクター': 'PILOT', 'CHARACTER': 'PILOT', 'パイロット': 'PILOT',
                      'モビルスーツ': 'UNIT', 'ユニット': 'UNIT', 'コマンド': 'COMMAND',
                      'ACTION': 'COMMAND', 'アクション': 'COMMAND', 'OPERATION': 'COMMAND',
                      'ベース': 'BASE' };
    card.card_type = typeMap[card.card_type] || card.card_type;
  }
  // color を正規化
  const colorMap = { '青': 'Blue', '赤': 'Red', '緑': 'Green', '白': 'White', '紫': 'Purple' };
  if (colorMap[card.color]) card.color = colorMap[card.color];
  return card;
}

// === 関連カード抽出（同色優先） ===
/**
 * 関連カード検索（cards_master + cards_preview 統合対応）
 * @param {Object} cardInfo - 新カードの情報
 * @param {Object} unifiedDB - buildUnifiedCardDB() の返り値
 * @param {Object} summary - summary.json のデータ
 * @returns {Array} 関連カードの配列（最大10件）
 */
function findRelatedCards(cardInfo, unifiedDB, summary) {
  const traits = (cardInfo.traits || []).map(t => t.replace(/[〔〕]/g, '')); // 〔CB〕 → CB に正規化
  const cardRanking = summary.card_ranking || [];
  const cardColor = cardInfo.color;

  const related = [];
  const seen = new Set();
  // 検索対象の自身のカードを除外
  if (cardInfo.card_number) seen.add(cardInfo.card_number);

  // ヘルパー: unifiedDB のエントリから関連カード情報を作る
  function toRelated(id, entry, reason) {
    const cr = cardRanking.find(c => c.card_id === id);
    return {
      card_id: id, name: entry.name_jp,
      color: COLOR_JP[entry.color] || entry.color,
      usage_rate: cr ? cr.usage_rate : 0, decks: cr ? cr.decks : 0,
      preview: entry.preview || false,
      reason
    };
  }

  // 1. 同色 + 同特徴のカード（採用率データありを最優先）
  for (const cr of cardRanking) {
    if (related.length >= 5) break;
    const entry = unifiedDB[cr.card_id];
    if (!entry || seen.has(cr.card_id)) continue;
    const entryTraits = (entry.traits || []).map(t => String(t).replace(/[〔〕]/g, ''));
    const commonTraits = traits.filter(t => entryTraits.includes(t));
    if (commonTraits.length > 0 && entry.color === cardColor) {
      seen.add(cr.card_id);
      related.push(toRelated(cr.card_id, entry, `同色・共通特徴: ${commonTraits.join('、')}`));
    }
  }

  // 1b. preview カードからも同色+同特徴を検索（採用率データがないためランキング外）
  for (const [id, entry] of Object.entries(unifiedDB)) {
    if (related.length >= 5) break;
    if (seen.has(id) || !entry.preview) continue;
    const entryTraits = (entry.traits || []).map(t => String(t).replace(/[〔〕]/g, ''));
    const commonTraits = traits.filter(t => entryTraits.includes(t));
    if (commonTraits.length > 0 && entry.color === cardColor) {
      seen.add(id);
      related.push(toRelated(id, entry, `同色・共通特徴: ${commonTraits.join('、')}（新カード）`));
    }
  }

  // 2. 同色カード（特徴不一致でもOK）
  if (related.length < 3) {
    for (const cr of cardRanking) {
      if (related.length >= 5) break;
      const entry = unifiedDB[cr.card_id];
      if (!entry || seen.has(cr.card_id)) continue;
      if (entry.color === cardColor) {
        seen.add(cr.card_id);
        related.push(toRelated(cr.card_id, entry, '同色デッキ内で採用率上位'));
      }
    }
  }

  // 3. リンク先カード（カード名指定）— unifiedDB 全体を検索
  if (cardInfo.link) {
    const linkNames = cardInfo.link.match(/「([^」]+)」/g) || [];
    for (const name of linkNames) {
      const cleanName = name.replace(/[「」]/g, '');
      const isCondition = /特徴|を持つ|PILOT|COMMAND/.test(cleanName);
      if (isCondition) continue;
      for (const [id, entry] of Object.entries(unifiedDB)) {
        if (entry.name_jp && entry.name_jp.includes(cleanName) && !seen.has(id)) {
          seen.add(id);
          related.push(toRelated(id, entry, entry.preview ? 'リンク先（新カード）' : 'リンク先'));
        }
      }
    }
  }

  // 4. リンク条件（特徴指定のPILOT/COMMAND検索）— unifiedDB 全体を検索
  if (cardInfo.link) {
    const linkText = cardInfo.link;
    const traitMatch = linkText.match(/特徴[にが]?〔?([^〕を]+)〕?を持つ(PILOT|COMMAND)?/i)
      || linkText.match(/〔([^〕]+)〕.*(PILOT|COMMAND)/i)
      || linkText.match(/(ティターンズ|ジオン|地球連邦|エゥーゴ|CB|鉄華団|WB隊|ザフト|ミネルバ隊|フォルドの夜明け|学園|ネオ・ジオン|アナハイム).*(PILOT|パイロット)/i);
    if (traitMatch) {
      const targetTrait = traitMatch[1];
      const targetType = (traitMatch[2] || 'PILOT').toUpperCase();
      for (const [id, entry] of Object.entries(unifiedDB)) {
        if (seen.has(id)) continue;
        const entryTraits = (entry.traits || []).map(t => String(t).replace(/[〔〕]/g, ''));
        const entryType = (entry.card_type || '').toUpperCase();
        if (entryTraits.includes(targetTrait) && (entryType === targetType || entryType === 'PILOT' || entryType === 'COMMAND')) {
          seen.add(id);
          related.push(toRelated(id, entry, `リンク対象（${targetTrait} ${targetType}）${entry.preview ? '（新カード）' : ''}`));
        }
      }
    }
  }

  // 5. 同作品所属（source_title一致）— preview含む
  if (related.length < 8) {
    const cardTraitsNorm = traits; // 既に正規化済み
    for (const [id, entry] of Object.entries(unifiedDB)) {
      if (related.length >= 10) break;
      if (seen.has(id)) continue;
      // source_title が一致（cards_master のみ持つフィールド）
      if (entry.source_title && cardInfo._source_title && entry.source_title === cardInfo._source_title) {
        seen.add(id);
        related.push(toRelated(id, entry, `同作品: ${entry.source_title}`));
      }
    }
  }

  return related.slice(0, 10);
}

// === カード一覧テーブルHTML生成 ===
function buildCardTableHtml(cardInfoList) {
  let html = '<div style="overflow-x:auto;margin:16px 0">\n';
  html += '<table style="width:100%;border-collapse:collapse;font-size:13px">\n';
  html += '<thead><tr style="border-bottom:2px solid var(--border);text-align:left">';
  html += '<th style="padding:6px 8px">カード名</th>';
  html += '<th style="padding:6px 8px">番号</th>';
  html += '<th style="padding:6px 8px">色</th>';
  html += '<th style="padding:6px 8px">タイプ</th>';
  html += '<th style="padding:6px 8px">Lv</th>';
  html += '<th style="padding:6px 8px">COST</th>';
  html += '<th style="padding:6px 8px">AP</th>';
  html += '<th style="padding:6px 8px">HP</th>';
  html += '</tr></thead>\n<tbody>\n';

  for (const c of cardInfoList) {
    const colorJp = COLOR_JP[c.color] || c.color;
    html += '<tr style="border-bottom:1px solid var(--border)">';
    html += `<td style="padding:6px 8px;font-weight:600">${escapeHtml(c.card_name)}</td>`;
    html += `<td style="padding:6px 8px">${escapeHtml(c.card_number)}</td>`;
    html += `<td style="padding:6px 8px">${escapeHtml(colorJp)}</td>`;
    html += `<td style="padding:6px 8px">${escapeHtml(c.card_type)}</td>`;
    html += `<td style="padding:6px 8px">${c.level != null ? c.level : '-'}</td>`;
    html += `<td style="padding:6px 8px">${c.cost != null ? c.cost : '-'}</td>`;
    html += `<td style="padding:6px 8px">${c.ap != null ? c.ap : '-'}</td>`;
    html += `<td style="padding:6px 8px">${c.hp != null ? c.hp : '-'}</td>`;
    html += '</tr>\n';
  }

  html += '</tbody></table>\n</div>\n';
  return html;
}

// === X投稿画像のローカルダウンロード ===
async function downloadCardImage(imageUrl, cardNumber, date) {
  const dir = path.join(NEWS_IMAGE_DIR, date);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const ext = imageUrl.includes('.png') ? '.png' : '.jpg';
  const filename = `${cardNumber}${ext}`;
  const filepath = path.join(dir, filename);

  // 既にダウンロード済みならスキップ
  if (fs.existsSync(filepath)) {
    log(`    画像キャッシュ使用: ${filename}`);
    return `../../images/news/${date}/${filename}`;
  }

  return new Promise((resolve, reject) => {
    const urlObj = new URL(imageUrl);
    const file = fs.createWriteStream(filepath);
    https.get(urlObj, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        // リダイレクト対応
        file.close();
        fs.unlink(filepath, () => {});
        downloadCardImage(response.headers.location, cardNumber, date).then(resolve).catch(reject);
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        log(`    画像保存: ${filename} (${fs.statSync(filepath).size} bytes)`);
        resolve(`../../images/news/${date}/${filename}`);
      });
    }).on('error', (err) => {
      fs.unlink(filepath, () => {});
      log(`    画像ダウンロード失敗: ${err.message}`);
      reject(err);
    });
  });
}

// === カード画像URL判定 ===
function getCardImageUrl(card) {
  // ダウンロード済みローカル画像がある場合はそちらを使用
  if (card._localImagePath) return card._localImagePath;
  // 既存カード画像
  return `${CARD_IMAGE_BASE}/${card.card_number}.webp`;
}

function isUnreleasedCard(cardNumber) {
  // GD04以降は未発売の可能性あり（公式画像が404になる）
  const m = cardNumber.match(/^(ST|GD)(\d+)/);
  if (!m) return true;
  const prefix = m[1];
  const num = parseInt(m[2]);
  if (prefix === 'GD' && num >= 4) return true;
  if (prefix === 'ST' && num >= 9) return true;
  return false;
}

// === カードブロックHTML（画像+ステータス+考察+インライン関連カードをセット表示） ===
function buildCardBlockHtml(card, analysis, inlineRelated, linkTargets) {
  const num = escapeHtml(card.card_number);
  const name = escapeHtml(card.card_name);
  const imgUrl = getCardImageUrl(card);
  const colorJp = COLOR_JP[card.color] || card.color;
  const traitsStr = (card.traits || []).join('、');

  let html = '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:16px">\n';
  html += '  <div style="display:flex;gap:16px;align-items:flex-start">\n';
  // カード画像（250px, クリックで拡大）
  html += '    <div style="flex-shrink:0;width:250px">\n';
  html += `      <img src="${imgUrl}" alt="${name}" style="width:250px;border-radius:6px;border:1px solid var(--border);cursor:zoom-in" onclick="openLightbox(this.src)" onerror="this.onerror=null;this.style.display='none'">\n`;
  html += '    </div>\n';
  // カード情報
  html += '    <div style="flex:1">\n';
  html += `      <h3 style="margin:0 0 8px 0;font-size:16px">${name} (${num})</h3>\n`;
  html += '      <table style="font-size:13px;margin-bottom:8px">\n';
  html += `        <tr><td style="padding-right:12px;color:var(--text-muted)">色</td><td>${escapeHtml(colorJp)}</td>`;
  html += `<td style="padding-left:16px;padding-right:12px;color:var(--text-muted)">タイプ</td><td>${escapeHtml(card.card_type)}</td></tr>\n`;
  html += `        <tr><td style="padding-right:12px;color:var(--text-muted)">Lv</td><td>${card.level != null ? card.level : '-'}</td>`;
  html += `<td style="padding-left:16px;padding-right:12px;color:var(--text-muted)">コスト</td><td>${card.cost != null ? card.cost : '-'}</td></tr>\n`;
  // 指示書37d/37e(2026-05-17): UNIT/BASE は戦闘 AP/HP、PILOT は補正 AP/HP を表示。COMMAND のみ非表示。
  // GCG ルール上、PILOT カードの AP/HP は UNIT にセット時の補正値 → ラベルで明示
  if (card.card_type === 'UNIT' || card.card_type === 'BASE' || card.card_type === 'PILOT') {
    const apLabel = card.card_type === 'PILOT' ? '補正 AP' : 'AP';
    const hpLabel = card.card_type === 'PILOT' ? '補正 HP' : 'HP';
    html += `        <tr><td style="padding-right:12px;color:var(--text-muted)">${apLabel}</td><td>${card.ap != null ? card.ap : '-'}</td>`;
    html += `<td style="padding-left:16px;padding-right:12px;color:var(--text-muted)">${hpLabel}</td><td>${card.hp != null ? card.hp : '-'}</td></tr>\n`;
  }
  if (traitsStr) {
    html += `        <tr><td style="padding-right:12px;color:var(--text-muted)">特徴</td><td colspan="3">${escapeHtml(traitsStr)}</td></tr>\n`;
  }
  if (card.link) {
    html += `        <tr><td style="padding-right:12px;color:var(--text-muted)">リンク条件</td><td colspan="3">${escapeHtml(card.link)}</td></tr>\n`;
  }
  html += '      </table>\n';
  if (card.effect) {
    html += `      <p style="font-size:13px;color:var(--text-secondary);margin:0 0 8px 0"><strong>効果:</strong> ${escapeHtml(card.effect)}</p>\n`;
  }
  if (analysis) {
    html += `      <p style="font-size:14px;margin:0">${analysis}</p>\n`;
  }
  html += '    </div>\n';
  html += '  </div>\n';
  // インライン関連カード（同色・同特徴 1〜2枚）
  if (inlineRelated && inlineRelated.length > 0) {
    html += '  <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">\n';
    html += '    <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">関連カード</div>\n';
    for (const r of inlineRelated) {
      const rImgUrl = `${CARD_IMAGE_BASE}/${r.card_id}.webp`;
      html += '    <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">\n';
      html += `      <a href="../../cards/${r.card_id}/"><img src="${rImgUrl}" alt="${escapeHtml(r.name)}" style="width:36px;border-radius:2px" onerror="this.style.display=\'none\'"></a>\n`;
      html += `      <a href="../../cards/${r.card_id}/" style="font-size:12px;color:var(--text-primary);text-decoration:none">${escapeHtml(r.name)} (${r.card_id}) — ${escapeHtml(r.color)}系${r.usage_rate}%</a>\n`;
      html += '    </div>\n';
    }
    html += '  </div>\n';
  }
  // リンク対象カード（特徴指定PILOTなど）
  if (linkTargets && linkTargets.length > 0) {
    const linkReason = linkTargets[0].reason || 'リンク対象';
    const labelMatch = linkReason.match(/リンク対象（(.+)）/);
    const linkLabel = labelMatch ? `リンク対象カード（${labelMatch[1]}）` : 'リンク対象カード';
    html += '  <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border)">\n';
    html += `    <div style="font-size:12px;color:var(--text-muted);margin-bottom:4px">${escapeHtml(linkLabel)}</div>\n`;
    for (const r of linkTargets) {
      const rImgUrl = `${CARD_IMAGE_BASE}/${r.card_id}.webp`;
      html += '    <div style="display:flex;align-items:center;gap:8px;margin-bottom:4px">\n';
      html += `      <a href="../../cards/${r.card_id}/"><img src="${rImgUrl}" alt="${escapeHtml(r.name)}" style="width:36px;border-radius:2px" onerror="this.style.display=\'none\'"></a>\n`;
      html += `      <a href="../../cards/${r.card_id}/" style="font-size:12px;color:var(--text-primary);text-decoration:none">${escapeHtml(r.name)} (${r.card_id})</a>\n`;
      html += '    </div>\n';
    }
    html += '  </div>\n';
  }
  html += '</div>\n';
  return html;
}

// === 関連カードHTML（サムネイル+リンク付き） ===
// 指示書36: articleDate 引数を追加し、preview カードの _imageDate 未設定時のフォールバックに使用
function buildRelatedCardsHtml(relatedCards, articleDate) {
  if (!relatedCards || relatedCards.length === 0) return '';

  let html = '<h2 style="font-size:15px;margin-top:28px">関連カード</h2>\n';
  html += '<ul style="list-style:none;padding:0;margin:12px 0">\n';

  for (const r of relatedCards) {
    // preview カード（GD04未発売）はニュース画像を使用、既存カードは公式画像
    // 指示書36: _imageDate 未設定時は引数 articleDate にフォールバック(スラッシュ2連続防止)
    const imgUrl = r.preview
      ? `../../images/news/${r._imageDate || articleDate || ''}/${r.card_id}.jpg`
      : `${CARD_IMAGE_BASE}/${r.card_id}.webp`;
    const previewBadge = r.preview
      ? '<span style="display:inline-block;background:var(--accent);color:#fff;font-size:10px;padding:1px 5px;border-radius:3px;margin-left:6px;vertical-align:middle">NEW</span>'
      : '';
    const statsText = r.preview
      ? `${escapeHtml(r.color)}系 — ${escapeHtml(r.reason || '新カード')}`
      : `${escapeHtml(r.color)}系デッキ内採用率${r.usage_rate}% (${r.decks}デッキ)`;

    html += '<li style="display:flex;align-items:center;gap:10px;margin-bottom:8px">\n';
    html += `  <a href="../../cards/${r.card_id}/" style="flex-shrink:0">\n`;
    html += `    <img src="${imgUrl}" alt="${escapeHtml(r.name)}" style="width:40px;height:56px;border-radius:3px;object-fit:cover;border:1px solid var(--border)" onerror="this.style.display='none'">\n`;
    html += '  </a>\n';
    html += '  <div>\n';
    html += `    <a href="../../cards/${r.card_id}/" style="color:var(--text-primary);text-decoration:none;font-weight:600">${escapeHtml(r.name)}<span style="color:var(--text-muted);font-weight:400;margin-left:4px">(${escapeHtml(r.card_id)})</span>${previewBadge}</a>\n`;
    html += `    <div style="font-size:12px;color:var(--text-secondary)">${statsText}</div>\n`;
    html += '  </div>\n';
    html += '</li>\n';
  }

  html += '</ul>\n';
  return html;
}

// 注: generateIntroText, generateCardAnalyses は指示書34 で
//     shared/recognition-core.js に移動 → 冒頭 require で取得済

// === 記事生成: 速報 ===
async function generateNoticeArticle(tweetText, tweetUrl, summary) {
  let dataContext = '';
  const cardRanking = summary.card_ranking || [];
  if (cardRanking.length > 0) {
    dataContext = '\n【参考: 現在の採用率TOP5】\n' +
      cardRanking.slice(0, 5).map(c => `- ${c.card_id}: 採用率${c.usage_rate}% (${c.decks}デッキ)`).join('\n');
  }

  const prompt = `あなたはガンダムカードゲーム（GCG）の環境分析レポーターです。
以下の公式アナウンスに基づいて、速報記事を日本語で書いてください。

【厳守ルール】
- 公式の発表内容を正確に伝えること
- GCG STATSのデータがある場合は、影響分析を加えること
- AI臭い表現を避け、自然な文体にすること
- HTML形式で出力（<h2>、<p>タグを使用）
- 全体で300〜600文字程度

【禁止表現】
「注目すべき」「特筆すべき」「徹底」「一挙」「秘めて」「バラエティ豊かな」「待ち遠しい」

【公式アナウンス内容】
${tweetText}

【出典】
公式XポストURL: ${tweetUrl}
${dataContext}`;

  log('  速報記事生成中 (Claude API)...');
  return await callClaude([{ role: 'user', content: prompt }], 2000);
}

// === X投稿文生成 ===
// 新カード投稿: ステータス情報はOCR精度の問題があるため含めず、
// カード名+記事リンク+ハッシュタグのシンプルな固定フォーマットを使用する。
async function generateTweetText(type, articleInfo) {
  if (type === 'new_card') {
    // 固定フォーマット: カード名と出典リンクのみ
    return `【新カード】${articleInfo.cardNames}\n\n記事はこちら👇\n${articleInfo.url}\n\n#GCG #ガンダムカードゲーム`;
  }

  // 速報はClaude APIで生成（従来通り）
  const prompt = `以下の速報情報に基づいて、Xの投稿文を書いてください。

【ルール】
- 280文字以内
- 絵文字の箇条書きは使わない
- 自然な文体
- 記事URLとハッシュタグを含める

【内容】
${articleInfo.summary}

【記事URL】
${articleInfo.url}

【ハッシュタグ】
#ガンダムカードゲーム #GCG

投稿文のみを出力してください。`;

  const result = await callClaude([{ role: 'user', content: prompt }], 500);
  return result.replace(/^["']|["']$/g, '').trim();
}

// === HTMLページ生成 ===
function generateNewsPage(pageId, title, description, articleHtml, options) {
  options = options || {};
  const canonical = options.canonical || `${SITE_URL}/reports/news/${pageId}.html`;
  const displayDate = options.displayDate || todayStr().replace(/-/g, '.');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <!-- Google Analytics -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-3MY17P4E7F"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', 'G-3MY17P4E7F');
  </script>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)} | GCG STATS</title>
  <meta name="description" content="${escapeHtml(description)}">
  <!-- OGP -->
  <meta property="og:site_name" content="GCG STATS">
  <meta property="og:locale" content="ja_JP">
  <meta property="og:title" content="${escapeHtml(title)} | GCG STATS">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="${canonical}">
  <meta property="og:image" content="${SITE_URL}/images/ogp-default.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="${SITE_URL}/images/ogp-default.png">
  <link rel="canonical" href="${canonical}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="../../css/style.css">
</head>
<body>
  <div id="header"></div>

  <main class="container">
    <div style="margin-bottom:12px">
      <a href="../index.html" style="color:var(--text-muted);text-decoration:none;font-size:13px;transition:color 0.15s"
       onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--text-muted)'">
        ← レポート一覧に戻る</a>
    </div>
    <div class="section-header">
      <h1 class="section-title" style="margin-bottom:6px;font-size:16px">${escapeHtml(title)}</h1>
      <span class="section-badge">${displayDate}</span>
    </div>

    <article class="report-article" style="margin-top:24px;line-height:1.8;font-size:14px">
${articleHtml}
    </article>

    <div id="share-buttons" style="margin-top:32px"></div>
  </main>

  <noscript>${escapeHtml(stripTags(articleHtml))}</noscript>
  <div class="seo-content" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap">${escapeHtml(stripTags(articleHtml))}</div>

  <div id="footer"></div>

  <script src="../../js/common.js?v=7"></script>
  <script>
    GCG.init();
    document.getElementById('header').innerHTML = GCG.renderHeader('reports');
    document.getElementById('footer').innerHTML = GCG.renderFooter();
    GCG.renderShareButtons('share-buttons', '${escapeHtml(title).replace(/'/g, "\\'")} | GCG STATS');
  </script>
</body>
</html>`;
}

// === リンク対象カード抽出（特徴指定のPILOT/COMMAND） ===
function findLinkTargets(cardInfo, unifiedDB, summary) {
  if (!cardInfo.link) return [];
  const linkText = cardInfo.link;
  const cardRanking = (summary.card_ranking || []);
  const result = [];
  const seen = new Set();

  // 「特徴に〇〇を持つPILOT」パターンの抽出
  const traitMatch = linkText.match(/特徴[にが]?〔?([^〕を]+)〕?を持つ(PILOT|COMMAND)?/i)
    || linkText.match(/〔([^〕]+)〕.*(PILOT|COMMAND)/i)
    || linkText.match(/(ティターンズ|ジオン|地球連邦|エゥーゴ|CB|鉄華団|WB隊|ザフト|ミネルバ隊|フォルドの夜明け|学園|ネオ・ジオン|アナハイム).*(PILOT|パイロット)/i);

  if (traitMatch) {
    const targetTrait = traitMatch[1];
    const targetType = (traitMatch[2] || 'PILOT').toUpperCase();
    for (const [id, entry] of Object.entries(unifiedDB)) {
      if (seen.has(id)) continue;
      const entryTraits = (entry.traits || []).map(t => String(t).replace(/[〔〕]/g, ''));
      const entryType = (entry.card_type || '').toUpperCase();
      if (entryTraits.includes(targetTrait) && (entryType === targetType || entryType === 'PILOT' || entryType === 'COMMAND')) {
        seen.add(id);
        const cr = cardRanking.find(c => c.card_id === id);
        result.push({
          card_id: id, name: entry.name_jp,
          color: COLOR_JP[entry.color] || entry.color,
          usage_rate: cr ? cr.usage_rate : 0, decks: cr ? cr.decks : 0,
          preview: entry.preview || false,
          reason: `リンク対象（${targetTrait} ${targetType}）`
        });
      }
    }
  }

  // カード名指定のリンク先
  const linkNames = linkText.match(/「([^」]+)」/g) || [];
  for (const name of linkNames) {
    const cleanName = name.replace(/[「」]/g, '');
    if (/特徴|を持つ|PILOT|COMMAND/.test(cleanName)) continue;
    for (const [id, entry] of Object.entries(unifiedDB)) {
      if (seen.has(id)) continue;
      if (entry.name_jp && entry.name_jp.includes(cleanName)) {
        seen.add(id);
        const cr = cardRanking.find(c => c.card_id === id);
        result.push({
          card_id: id, name: entry.name_jp,
          color: COLOR_JP[entry.color] || entry.color,
          usage_rate: cr ? cr.usage_rate : 0, decks: cr ? cr.decks : 0,
          preview: entry.preview || false,
          reason: 'リンク先'
        });
      }
    }
  }

  return result;
}

// === カードごとのインライン関連カード抽出（同色・同特徴、1〜2枚） ===
function findInlineRelated(cardInfo, unifiedDB, summary) {
  const traits = (cardInfo.traits || []).map(t => String(t).replace(/[〔〕]/g, ''));
  const cardColor = cardInfo.color;
  const cardRanking = summary.card_ranking || [];
  const result = [];
  const seen = new Set();

  // 同色+同特徴 優先（採用率データあり）
  for (const cr of cardRanking) {
    if (result.length >= 2) break;
    const entry = unifiedDB[cr.card_id];
    if (!entry || seen.has(cr.card_id)) continue;
    const entryTraits = (entry.traits || []).map(t => String(t).replace(/[〔〕]/g, ''));
    const common = traits.filter(t => entryTraits.includes(t));
    if (common.length > 0 && entry.color === cardColor) {
      seen.add(cr.card_id);
      result.push({ card_id: cr.card_id, name: entry.name_jp, color: COLOR_JP[entry.color] || entry.color, usage_rate: cr.usage_rate, preview: entry.preview || false });
    }
  }
  // preview カードからも同色+同特徴を検索
  if (result.length < 2) {
    for (const [id, entry] of Object.entries(unifiedDB)) {
      if (result.length >= 2) break;
      if (seen.has(id) || !entry.preview || id === cardInfo.card_number) continue;
      const entryTraits = (entry.traits || []).map(t => String(t).replace(/[〔〕]/g, ''));
      const common = traits.filter(t => entryTraits.includes(t));
      if (common.length > 0 && entry.color === cardColor) {
        seen.add(id);
        result.push({ card_id: id, name: entry.name_jp, color: COLOR_JP[entry.color] || entry.color, usage_rate: 0, preview: true });
      }
    }
  }
  // 同特徴（色不問）で補完
  if (result.length < 1) {
    for (const cr of cardRanking) {
      if (result.length >= 2) break;
      const entry = unifiedDB[cr.card_id];
      if (!entry || seen.has(cr.card_id)) continue;
      const entryTraits = (entry.traits || []).map(t => String(t).replace(/[〔〕]/g, ''));
      const common = traits.filter(t => entryTraits.includes(t));
      if (common.length > 0) {
        seen.add(cr.card_id);
        result.push({ card_id: cr.card_id, name: entry.name_jp, color: COLOR_JP[entry.color] || entry.color, usage_rate: cr.usage_rate, preview: entry.preview || false });
      }
    }
  }
  return result;
}

// === 新カード記事の完全なHTML組み立て ===
function assembleCardArticleHtml(introHtml, cardInfoList, cardAnalyses, relatedCards, tweetUrls, unifiedDB, summary, articleDate) {
  let html = '';

  // 1. 導入文（Claude生成パート）
  html += introHtml + '\n';

  // 2. カードブロック × N枚（画像+ステータス+考察+インライン関連カード+リンク対象をセットで表示）
  for (const card of cardInfoList) {
    const analysis = cardAnalyses[card.card_number] || '';
    const inlineRelated = findInlineRelated(card, unifiedDB, summary);
    // リンク対象カード抽出
    const linkTargets = findLinkTargets(card, unifiedDB, summary);
    html += buildCardBlockHtml(card, analysis, inlineRelated, linkTargets);
  }

  // 3. 関連カード（サムネイル+リンク付き）
  // 指示書36: articleDate を渡してスラッシュ2連続を防止
  html += buildRelatedCardsHtml(relatedCards, articleDate);

  // 4. 出典
  html += '\n<div style="margin-top:24px;padding-top:16px;border-top:1px solid var(--border)">\n';
  html += '<p style="font-size:12px;color:var(--text-muted)">出典:</p>\n<ul style="font-size:12px">\n';
  tweetUrls.forEach(url => {
    html += `<li><a href="${escapeHtml(url)}" target="_blank" rel="noopener" style="color:var(--accent)">${escapeHtml(url)}</a></li>\n`;
  });
  html += '</ul>\n</div>';

  // 5. ライトボックスはcommon.jsで提供されるため、インライン定義は不要

  return html;
}

// === Git操作（GitHub API経由） ===
async function gitPush(message, generatedFiles) {
  if (DRY_RUN) { log(`[DRY-RUN] git push スキップ: ${message}`); return; }
  try {
    // テキストファイルをまとめてpush
    const textFiles = (generatedFiles || []).filter(f => !f.binary);
    const binaryFiles = (generatedFiles || []).filter(f => f.binary);

    if (textFiles.length > 0) {
      const filesToPush = textFiles.map(f => ({
        path: f.repoPath,
        content: fs.readFileSync(path.join(ROOT, f.repoPath), 'utf-8')
      }));
      await pushFiles(filesToPush, message);
    }

    // バイナリファイル（画像）を個別にpush
    for (const f of binaryFiles) {
      await pushBinaryFile(f.repoPath, path.join(ROOT, f.repoPath), `Add ${path.basename(f.repoPath)}`);
    }

    log('GitHub API push 完了');
  } catch (e) {
    log(`GitHub API push 失敗: ${e.message}`);
  }
}

// === メイン処理 ===
async function main() {
  log('=== auto-news 開始 ===');

  // 指示書33: 起動時ログ強化(各モード明示)
  log(`DRY_RUN: ${DRY_RUN}`);
  log(`TEST_MODE: ${TEST_MODE} (X 投稿は ${TEST_MODE ? 'スキップ' : '実行'})`);
  log(`ENABLE_SURVEY: ${ENABLE_SURVEY}`);
  log(`USE_VISION_PIPELINE: ${USE_VISION_PIPELINE}`);

  if (!X_API_KEY || !X_ACCESS_TOKEN) {
    log('エラー: X API キーが設定されていません');
    process.exit(1);
  }

  if (!fs.existsSync(NEWS_DIR)) fs.mkdirSync(NEWS_DIR, { recursive: true });

  // === 時刻範囲モード決定(指示書33 で追加、2026-05-17)===
  // 優先順位: --start-time/--end-time(明示) > --auto-window > parseSince(--since) > last-check.json(従来)
  let effectiveStartTime;
  let effectiveEndTime = null;
  if (CLI_START_TIME) {
    effectiveStartTime = CLI_START_TIME;
    effectiveEndTime = CLI_END_TIME; // null なら現在時刻まで
    log(`時刻範囲モード: 明示指定 (--start-time / --end-time)`);
    log(`  範囲: ${effectiveStartTime} 〜 ${effectiveEndTime || '現在'}`);
  } else if (AUTO_WINDOW) {
    const window = calculateAutoWindow();
    effectiveStartTime = window.startTime;
    effectiveEndTime = window.endTime;
    log(`時刻範囲モード: --auto-window(前日18:00 JST → 当日18:00 JST)`);
    log(`  範囲: ${effectiveStartTime} 〜 ${effectiveEndTime}`);
  } else {
    effectiveStartTime = parseSince() || getLastCheck();
    log(`時刻範囲モード: last-check.json ベース(従来)`);
    log(`  範囲: ${effectiveStartTime} 〜 現在`);
  }

  // ① 公式ツイート取得
  let tweets;
  try {
    tweets = await fetchOfficialTweets(effectiveStartTime, effectiveEndTime);
  } catch (e) {
    log(`公式ツイート取得失敗: ${e.message}`);
    process.exit(1);
  }

  // ② 分類
  const targets = tweets.map(tw => ({ tweet: tw, type: classifyTweet(tw) })).filter(t => t.type !== null);

  if (targets.length === 0) {
    log('対象投稿なし。終了します。');
    // 指示書33: 対象なしでも last-check.json の更新制御は同じ規則
    if (CLI_START_TIME) {
      log('--start-time 明示指定のため last-check.json を更新しません');
    } else if (AUTO_WINDOW) {
      saveLastCheck(effectiveEndTime);
      log(`auto-window 完了: last-check.json を ${effectiveEndTime} に更新`);
    } else {
      saveLastCheck();
    }
    return;
  }

  log(`対象投稿: ${targets.length}件 (新カード: ${targets.filter(t=>t.type==='new_card').length}, 速報: ${targets.filter(t=>t.type==='notice').length})`);

  const cardsMaster = loadCardsMaster();
  const summary = loadSummary();
  let unifiedDB = buildUnifiedCardDB(cardsMaster); // cards_master + cards_preview 統合DB
  const date = todayStr();
  const generatedFiles = []; // GitHub API push用ファイルリスト

  const newCards = targets.filter(t => t.type === 'new_card');
  const notices = targets.filter(t => t.type === 'notice');

  // === 新カード記事 ===
  let allCardInfos = [];
  if (newCards.length > 0) {
    const allRelated = [];

    // 最も古い投稿の日付を記事日付にする
    const tweetDates = newCards.map(t => t.tweet.created_at).filter(Boolean).sort();
    const articleDate = tweetDates.length > 0 ? tweetDates[0].split('T')[0] : date;

    for (const { tweet } of newCards) {
      const tweetUrl = `https://x.com/GUNDAM_GCG_JP/status/${tweet.id}`;

      // アンケート投稿（OCRパイプライン前、指示書32 で ENABLE_SURVEY ガード追加)
      if (ENABLE_SURVEY) {
        const nameMatchSurvey = tweet.text.match(/「([^」]+)」/);
        const surveyCardName = nameMatchSurvey ? nameMatchSurvey[1] : (tweet.text.split('\n')[2] || '新カード');
        await postSurvey(surveyCardName, tweetUrl);
      } else {
        log('  postSurvey スキップ(--enable-survey 指定なし)');
      }

      let cardInfoList = null;
      if (tweet.images.length > 0 && ANTHROPIC_API_KEY) {
        try {
          // Step 1: 画像からカードデータをJSON抽出（Sonnet）
          const imageBase64List = [];
          for (const url of tweet.images.slice(0, 2)) {
            try {
              const imgData = await fetchImageBase64(url);
              imageBase64List.push(imgData);
            } catch (e) {
              log(`  画像取得失敗: ${url} - ${e.message}`);
            }
          }
          if (imageBase64List.length > 0) {
            let extractedCards;
            if (USE_VISION_PIPELINE && GOOGLE_CLOUD_API_KEY) {
              // 新パイプライン: Vision AI + Claude色判定
              log('  [Pipeline] Vision AI + Claude 分離パイプライン使用');
              try {
                extractedCards = await extractCardDataVisionPipeline(imageBase64List);
                if (!extractedCards) {
                  // クォータ超過でnull返却 → 従来パイプラインにフォールバック
                  log('  [Pipeline] Vision API クォータ超過、従来方式にフォールバック');
                  extractedCards = await extractCardData(imageBase64List);
                }
              } catch (e) {
                log(`  [Pipeline] 新パイプライン失敗、従来方式にフォールバック: ${e.message}`);
                extractedCards = await extractCardData(imageBase64List);
              }
            } else {
              // 従来パイプライン: Claude 1回で全て処理
              extractedCards = await extractCardData(imageBase64List);
            }
            // Step 1.5: cards_master.json照合 + 既存の修正・バリデーション
            cardInfoList = extractedCards.map(c => {
              const verified = verifyWithMaster(c, cardsMaster);
              return validateCardInfo(fixRecognitionErrors(verified, cardsMaster));
            });
          }
        } catch (e) {
          log(`  画像認識失敗: ${e.message}`);
        }
      }

      if (!cardInfoList) {
        log('  画像認識なし。テキストのみで処理。');
        const nameMatch = tweet.text.match(/「([^」]+)」/);
        const cardName = nameMatch ? nameMatch[1] : (tweet.text.split('\n')[2] || '新カード');
        cardInfoList = [{ card_name: cardName, card_number: '不明', color: '不明', card_type: '不明', traits: [], effect: '' }];
      }

      for (const ci of cardInfoList) {
        ci._tweetUrl = tweetUrl;
        ci._articleDate = articleDate; // 指示書37: 再生成用の記事日付
        // 指示書37: 認識精度問題判定(手動補完戦略)
        const recognitionCheck = checkRecognitionIssues(ci);
        ci._pendingReview = recognitionCheck.hasIssue;
        ci._pendingReviewIssues = recognitionCheck.hasIssue ? recognitionCheck.issues : [];
        if (recognitionCheck.hasIssue) {
          log(`  ⚠ 認識精度問題: ${ci.card_number || 'NO_NUMBER'} — ${recognitionCheck.issues.join(', ')}`);
        }
        // X投稿画像をダウンロードしてローカル保存
        if (tweet.images.length > 0) {
          try {
            ci._localImagePath = await downloadCardImage(tweet.images[0], ci.card_number || 'unknown', articleDate);
          } catch (e) {
            log(`  画像ダウンロード失敗（記事は画像なしで生成）: ${e.message}`);
          }
          await sleep(1000); // ダウンロード間隔
        }
        // cards_preview.json に仮データ保存(_pendingReview フラグ含む)
        saveCardPreview(ci, tweetUrl);
        // 統合DBを再構築（新カード追加分を後続の検索に反映）
        unifiedDB = buildUnifiedCardDB(cardsMaster);
        allCardInfos.push(ci);
        const related = findRelatedCards(ci, unifiedDB, summary);
        allRelated.push(...related);
      }

      await sleep(1000);
    }

    // 認識ログから前回のlink情報を復元（Opusが再認識時にLINKを読み飛ばす場合の対策）
    let prevLogData = {};
    if (fs.existsSync(RECOGNITION_LOG_FILE)) {
      try { prevLogData = JSON.parse(fs.readFileSync(RECOGNITION_LOG_FILE, 'utf-8')); } catch (e) {}
    }
    const prevCards = (prevLogData[articleDate] && prevLogData[articleDate].cards) || [];
    for (const ci of allCardInfos) {
      if (!ci.link && ci.card_number) {
        const prev = prevCards.find(p => p.card_number === ci.card_number);
        if (prev && prev.link) {
          ci.link = prev.link;
          log(`  前回認識ログからlink復元: ${ci.card_number} → ${prev.link}`);
        }
      }
      // 復元/認識されたlinkテキストを正規化（findLinkTargetsで解析可能な形式に）
      if (ci.link) {
        const linkNorm = ci.link.match(/^特徴[（(〔]([^）)〕]+)[）)〕]$/);
        if (linkNorm) {
          ci.link = `特徴に${linkNorm[1]}を持つPILOT`;
          log(`  link正規化: ${ci.card_number} → ${ci.link}`);
        }
      }
    }

    // 認識結果をログに保存（松岡さんの確認用、_pendingReview を含む全カード)
    const tweetUrlsForLog = [...new Set(allCardInfos.map(c => c._tweetUrl))];
    saveRecognitionLog(articleDate, allCardInfos, tweetUrlsForLog);
    generatedFiles.push({ repoPath: 'data/card-recognition-log.json', binary: false });

    // === 指示書37: 認識精度問題による停止メカニズム ===
    // _pendingReview = true のカードを記事生成から除外。
    // 全カードが pending なら process.exit(1) で停止し、手動補完 → regenerate-article.js で再生成。
    const pendingCards = allCardInfos.filter(c => c._pendingReview === true);
    const validCards = allCardInfos.filter(c => c._pendingReview !== true);

    // 指示書37c(2026-05-17): 松岡さん戦略「すべて含めて記事作成」
    // 一部でも保留があれば全体停止(部分生成廃止)→ 手動補完 → regenerate-article.js
    if (pendingCards.length > 0) {
      log('');
      log('========================================');
      log('⚠ 認識精度問題のため記事生成を全体停止します:');
      log('以下のカードを手動補完してください:');
      pendingCards.forEach(c => {
        const issues = (c._pendingReviewIssues || []).join(', ');
        log(`  - ${c.card_number || 'NO_NUMBER'} (${c.card_name || 'NO_NAME'}): ${issues}`);
      });
      log('手動補完手順:');
      log('  1. data/cards_preview.json を編集し、対象カードを修正');
      log('     (color/cost/ap/hp 等を補完、_pendingReview を false に変更)');
      log(`  2. node scripts/regenerate-article.js --date ${articleDate} で再生成`);
      log('  ※ 全カード認識成功 + 補完済の状態で記事生成されます');
      log('========================================');
      log('');
      log(`記事生成スキップ: 認識精度問題により全体停止`);
      log(`  - 認識成功: ${validCards.length} 件`);
      log(`  - 保留: ${pendingCards.length} 件`);
      log('=== auto-news 終了(認識精度問題、全体停止) ===');
      // git push なし、X 投稿なし、last-check.json 更新なしで終了
      process.exit(1);
    }

    // 全カード認識成功時のみ通常の記事生成へ
    log(`記事生成: 認識成功 ${validCards.length} 件(全カード認識成功)`);
    allCardInfos = validCards; // 念のため明示

    // 関連カードの重複排除
    const uniqueRelated = [];
    const seenIds = new Set();
    for (const r of allRelated) {
      if (!seenIds.has(r.card_id)) { seenIds.add(r.card_id); uniqueRelated.push(r); }
    }

    const tweetUrls = [...new Set(allCardInfos.map(c => c._tweetUrl))];
    const dateLbl = dateLabel(articleDate);
    const cardCount = allCardInfos.length;

    // === 拡張コードの動的決定(指示書32 で追加、2026-05-17)===
    // allCardInfos から最も多い expansion を選択(混在時の dominant)、空なら空文字フォールバック
    const expansionCounts = {};
    allCardInfos.forEach((c) => {
      if (c && c.expansion) {
        expansionCounts[c.expansion] = (expansionCounts[c.expansion] || 0) + 1;
      }
    });
    const dominantExpansion = Object.keys(expansionCounts).length > 0
      ? Object.keys(expansionCounts).sort((a, b) => expansionCounts[b] - expansionCounts[a])[0]
      : null;
    const expansionName = formatExpansionName(dominantExpansion);

    // Claude APIで導入文を生成
    let introHtml;
    try {
      introHtml = await generateIntroText(allCardInfos, uniqueRelated.slice(0, 10), articleDate);
    } catch (e) {
      log(`導入文生成失敗: ${e.message}`);
      introHtml = `<p>${expansionName}から新カード${cardCount}枚が公開されました。</p>`;
    }

    // Claude APIでカードごとの考察を生成
    let cardAnalyses = {};
    try {
      cardAnalyses = await generateCardAnalyses(allCardInfos, uniqueRelated.slice(0, 10));
    } catch (e) {
      log(`考察生成失敗: ${e.message}`);
    }

    // 完全なHTML組み立て（カードブロック+関連カードリンクは自動生成）
    const articleHtml = assembleCardArticleHtml(introHtml, allCardInfos, cardAnalyses, uniqueRelated.slice(0, 10), tweetUrls, unifiedDB, summary, articleDate);
    generatedFiles.push({ repoPath: 'data/cards_preview.json', binary: false });

    // 指示書32: 拡張コードを動的に取得(EXPANSION_NAMES マップ経由)
    const title = `【${dateLbl}公開】${expansionName} 新カード${cardCount}枚まとめ`;
    const desc = `ガンダムカードゲーム${expansionName}から公開された新カード${cardCount}枚の紹介と環境考察。`;
    const pageHtml = generateNewsPage(articleDate, title, desc, articleHtml, { displayDate: articleDate.replace(/-/g, '.') });
    const filePath = path.join(NEWS_DIR, `${articleDate}.html`);
    fs.writeFileSync(filePath, pageHtml, { encoding: 'utf-8' });
    generatedFiles.push({ repoPath: `reports/news/${articleDate}.html`, binary: false });
    // 画像ファイルも追跡
    for (const ci of allCardInfos) {
      if (ci._localImagePath) {
        const imgRepoPath = path.relative(ROOT, path.resolve(NEWS_DIR, ci._localImagePath));
        generatedFiles.push({ repoPath: imgRepoPath, binary: true });
      }
    }
    log(`記事保存: ${filePath}`);

    // X投稿（テストモードではスキップ）
    const articleUrl = `${SITE_URL}/reports/news/${articleDate}.html`;
    if (TEST_MODE) {
      log(`[TEST_MODE] X投稿スキップ。記事URL: ${articleUrl}`);
    } else {
      const cardNames = allCardInfos.map(c => c.card_name).join('、');
      try {
        const tweetText = await generateTweetText('new_card', { cardNames, url: articleUrl });
        await postTweet(tweetText);
      } catch (e) {
        log(`X投稿生成/送信失敗: ${e.message}`);
      }
    }
  }

  // === 速報記事 ===
  if (notices.length > 0) {
    for (const { tweet } of notices) {
      const tweetUrl = `https://x.com/GUNDAM_GCG_JP/status/${tweet.id}`;
      let articleHtml;

      try {
        articleHtml = await generateNoticeArticle(tweet.text, tweetUrl, summary);
      } catch (e) {
        log(`速報記事生成失敗: ${e.message}`);
        const safeText = escapeHtml(tweet.text).replace(/\n/g, '<br>');
        articleHtml = `<h2>公式アナウンス</h2>\n<p>${safeText}</p>\n<p><a href="${tweetUrl}" target="_blank" rel="noopener">元の投稿を見る</a></p>`;
      }

      const tweetDate = (tweet.created_at || '').split('T')[0] || date;
      const pageId = `notice-${tweet.id}`;
      const firstLine = (tweet.text.split('\n').find(l => l.trim()) || '速報').trim().slice(0, 40);
      const title = `【速報】${firstLine}`;
      const desc = firstLine;
      const pageHtml = generateNewsPage(pageId, title, desc, articleHtml, { displayDate: tweetDate.replace(/-/g, '.') });
      const filePath = path.join(NEWS_DIR, `${pageId}.html`);
      fs.writeFileSync(filePath, pageHtml, { encoding: 'utf-8' });
      generatedFiles.push({ repoPath: `reports/news/${pageId}.html`, binary: false });
      log(`速報記事保存: ${filePath}`);

      // X投稿（テストモードではスキップ）
      const articleUrl = `${SITE_URL}/reports/news/${pageId}.html`;
      if (TEST_MODE) {
        log(`[TEST_MODE] X投稿スキップ。記事URL: ${articleUrl}`);
      } else {
        try {
          const tweetText = await generateTweetText('notice', { summary: firstLine, url: articleUrl });
          await postTweet(tweetText);
        } catch (e) {
          log(`X投稿生成/送信失敗: ${e.message}`);
        }
      }

      await sleep(1000);
    }
  }

  // === Git push ===
  if (generatedFiles.length > 0) {
    try {
      await gitPush(`auto-news: ${date}`, generatedFiles);
    } catch (e) {
      log(`git push 失敗: ${e.message}`);
    }
  }

  // === Phase 3: post-processing 呼び出し(指示書41、2026-05-19)===
  // 認識成功かつ _articleDate が一致するカードのみ後処理
  // Option A: articleDate は新カードブロック内のブロックスコープ const のため、
  //           ここからは直接参照不可。allCardInfos[0]._articleDate から取得する。
  try {
    const phase3ArticleDate = (allCardInfos.length > 0)
      ? (allCardInfos[0]._articleDate || null)
      : null;

    if (!phase3ArticleDate) {
      log(`[Phase 3] post-processing スキップ: articleDate 取得不可(allCardInfos 空 or _articleDate 未設定)`);
    } else {
      const successCardNumbers = allCardInfos
        .filter(c => c && c._pendingReview !== true)
        .filter(c => c && c._articleDate === phase3ArticleDate)
        .map(c => c.card_number)
        .filter(cn => typeof cn === 'string' && cn.length > 0);

      if (successCardNumbers.length > 0) {
        log(`[Phase 3] post-processing 開始: ${successCardNumbers.length} 件 (${successCardNumbers.join(', ')})`);
        try {
          const { postProcess } = require('./scripts/post-processing');
          const result = await postProcess({
            date: phase3ArticleDate,
            cardNumbers: successCardNumbers,
            dryRun: DRY_RUN,
          });
          log(`[Phase 3] post-processing 完了: ${JSON.stringify(result)}`);
        } catch (err) {
          // ★ post-processing エラーはメイン処理を中断しない(翌朝の松岡さん確認で対処)★
          log(`[Phase 3] post-processing エラー: ${err.message}`);
          if (err.stack) console.error(err.stack);
        }
      } else {
        log(`[Phase 3] post-processing スキップ: 認識成功カード 0 件`);
      }
    }
  } catch (outerErr) {
    log(`[Phase 3] post-processing 前処理エラー: ${outerErr.message}`);
  }

  // 最終チェック時刻を保存
  if (CLI_START_TIME) {
    log('--start-time 明示指定のため last-check.json を更新しません');
  } else if (AUTO_WINDOW) {
    saveLastCheck(effectiveEndTime);
    log(`auto-window 完了: last-check.json を ${effectiveEndTime} に更新`);
  } else {
    saveLastCheck();
  }
  log('=== auto-news 完了 ===');
}

// === Module exports for manual scripts ===
// 指示書34: 共通モジュールから再エクスポート(他スクリプトからの後方互換性)
// 指示書37(2026-05-17): regenerate-article.js から再利用するため auto-news.js 独自関数も追加
module.exports = {
  // 共通モジュール(指示書34: 認識・記事生成の基盤関数)
  ...require('./scripts/shared/recognition-core.js'),
  // auto-news.js 独自関数(指示書37 で公開)
  formatExpansionName,
  classifyTweet,
  fetchOfficialTweets,
  fetchImageBase64,
  downloadCardImage,
  verifyWithMaster,
  fixRecognitionErrors,
  validateCardInfo,
  saveRecognitionLog,
  saveCardPreview,
  checkRecognitionIssues,
  findRelatedCards,
  findInlineRelated,
  findLinkTargets,
  buildCardBlockHtml,
  buildRelatedCardsHtml,
  assembleCardArticleHtml,
  generateNewsPage,
  generateTweetText,
  gitPush,
  postTweet,
  postSurvey,
  extractCardData,
  extractCardDataVisionPipeline,
};

// 直接実行時のみ main を起動(require 時は実行しない)
if (require.main === module) {
  main().catch(e => {
    log(`致命的エラー: ${e.message}`);
    console.error(e);
    process.exit(1);
  });
}
// EOF
