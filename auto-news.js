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
require('dotenv').config({ override: true });

// === 設定 ===
const SITE_URL = 'https://gcg-stats.com';
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const NEWS_DIR = path.join(ROOT, 'reports', 'news');
const LAST_CHECK_FILE = path.join(DATA_DIR, 'last-check.json');
const LOG_FILE = path.join(DATA_DIR, 'auto-news-log.txt');
const CARD_IMAGE_BASE = 'https://www.gundam-gcg.com/jp/images/cards/card';

const OFFICIAL_USER_ID = '1837069552842330114'; // @GUNDAM_GCG_JP
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL_SONNET = 'claude-sonnet-4-20250514';
const ANTHROPIC_MODEL_OPUS = 'claude-opus-4-20250514';
const RECOGNITION_LOG_FILE = path.join(DATA_DIR, 'card-recognition-log.json');

const X_API_KEY = process.env.X_API_KEY;
const X_API_SECRET = process.env.X_API_SECRET;
const X_ACCESS_TOKEN = process.env.X_API_ACCESS_TOKEN;
const X_ACCESS_TOKEN_SECRET = process.env.X_API_ACCESS_TOKEN_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const DRY_RUN = process.argv.includes('--dry-run');
const TEST_MODE = true; // 松岡さんのOKが出たらfalseに変更

const COLOR_JP = { Blue: '青', Red: '赤', Green: '緑', White: '白', Purple: '紫' };
const VALID_CARD_TYPES = ['UNIT', 'PILOT', 'COMMAND', 'BASE'];

// === ユーティリティ ===
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function now() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function todayStr() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}

function dateLabel(dateStr) {
  // "2026-03-27" → "3/27"
  const m = dateStr.match(/(\d+)-(\d+)-(\d+)/);
  if (!m) return dateStr;
  return `${parseInt(m[2])}/${parseInt(m[3])}`;
}

function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function stripTags(s) { return s.replace(/<[^>]*>/g, ''); }

function log(msg) {
  const line = `[${now()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n', { encoding: 'utf-8' });
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

// === Claude API ===
function callClaude(messages, maxTokens, model) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY が設定されていません');
  maxTokens = maxTokens || 2000;
  model = model || ANTHROPIC_MODEL_SONNET;
  const body = JSON.stringify({
    model: model,
    max_tokens: maxTokens,
    messages: messages
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com', path: '/v1/messages', method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const data = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode === 200) {
          const parsed = JSON.parse(data);
          const text = parsed.content.find(c => c.type === 'text');
          resolve(text ? text.text : '');
        } else {
          reject(new Error(`Claude API ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

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

// === 前回チェック日時 ===
function getLastCheck() {
  try {
    const data = JSON.parse(fs.readFileSync(LAST_CHECK_FILE, 'utf-8'));
    return data.last_check;
  } catch (e) {
    return new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
  }
}

function saveLastCheck() {
  fs.writeFileSync(LAST_CHECK_FILE, JSON.stringify({ last_check: new Date().toISOString() }, null, 2), { encoding: 'utf-8' });
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
async function fetchOfficialTweets(sinceTime) {
  log(`公式X投稿を取得中... (since: ${sinceTime})`);
  const params = {
    'start_time': sinceTime,
    'tweet.fields': 'created_at,text,attachments',
    'expansions': 'attachments.media_keys',
    'media.fields': 'url,type,preview_image_url',
    'max_results': '10'
  };

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
  // PILOTとCOMMANDはAP/HPを持たない
  if (result.card_type === 'PILOT' || result.card_type === 'COMMAND') {
    result.ap = null;
    result.hp = null;
  }
  // BASEはAPを持たない（HPのみ）
  if (result.card_type === 'BASE') {
    result.ap = null;
  }

  // === 色の正規化 ===
  const colorMap = { '青': 'Blue', '赤': 'Red', '緑': 'Green', '白': 'White', '紫': 'Purple' };
  if (colorMap[result.color]) result.color = colorMap[result.color];

  // === X投稿画像対応: card_numberベースのデータベース補正 ===
  // X投稿画像では背景色によりcolor誤認識が多発する（White正解率32%等）。
  // card_numberが認識できており、cards_masterにデータがある場合は
  // データベースの値で色・タイプ・特徴等を上書きする。
  // ※effectは画像読み取り値を維持（新カードの効果テキスト取得が主目的のため）
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
      // AP/HP再修正（card_typeをDB値で補正した後）
      if (result.card_type === 'PILOT' || result.card_type === 'COMMAND') {
        result.ap = null;
        result.hp = null;
      }
      if (result.card_type === 'BASE') {
        result.ap = null;
      }
    }
  }

  return result;
}

// === カードデータ読み込み ===
function loadCardsMaster() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'cards_master.json'), 'utf-8'));
  } catch (e) { return {}; }
}

function loadSummary() {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'summary.json'), 'utf-8'));
  } catch (e) { return { card_ranking: [], deck_type_ranking: [] }; }
}

// === 新カード: 画像認識 ===
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
- PILOT: ap=null, hp=null
- COMMAND: ap=null, hp=null
- BASE: ap=null, hp=数値（画像に0と表示されていてもAPはnullとする）

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

■ 特徴の例
地球連邦 / ジオン / ザフト / ティターンズ / エゥーゴ / 鉄華団 / 国連 /
学園 / ベネリットグループ / WB隊 / ミネルバ隊 / オーブ /
クロスボーン・バンガード / ネオ・ジオン / ソレスタルビーイング / CB / GNドライヴ

■ よくある認識ミス（必ず修正すること）
「EEXリソース」→「EXリソース」
「Xリソース」→「EXリソース」
《バースト》→【バースト】

■ 存在しない用語（絶対に使わないこと）
合体 / アップグレード / エース効果 / エースパーツ / 機動ユニット / Xソリューズ / 重大損傷コマンド / モビルパック` });

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
    effect: c.effect || '',
    image_url: c._xImageUrl || null,
    confidence: 'medium'
  }));

  // 既存カードとマージ（同一card_numberは上書き）
  const mergedMap = {};
  for (const card of existingCards) mergedMap[card.card_number] = card;
  for (const card of newCards) mergedMap[card.card_number] = card;
  const mergedCards = Object.values(mergedMap);

  logData[date] = {
    recognized_at: new Date().toISOString(),
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
function findRelatedCards(cardInfo, cardsMaster, summary) {
  const traits = cardInfo.traits || [];
  const cardRanking = summary.card_ranking || [];
  const cardColor = cardInfo.color;

  const related = [];
  const seen = new Set();

  // 1. 同色 + 同特徴のカード（最優先）
  for (const cr of cardRanking) {
    if (related.length >= 5) break;
    const master = cardsMaster[cr.card_id];
    if (!master || seen.has(cr.card_id)) continue;
    const masterTraits = master.traits || [];
    const commonTraits = traits.filter(t => masterTraits.includes(t));
    if (commonTraits.length > 0 && master.color === cardColor) {
      seen.add(cr.card_id);
      related.push({
        card_id: cr.card_id, name: master.name_jp,
        color: COLOR_JP[master.color] || master.color,
        usage_rate: cr.usage_rate, decks: cr.decks,
        reason: `同色・共通特徴: ${commonTraits.join('、')}`
      });
    }
  }

  // 2. 同色カード（特徴不一致でもOK）
  if (related.length < 3) {
    for (const cr of cardRanking) {
      if (related.length >= 5) break;
      const master = cardsMaster[cr.card_id];
      if (!master || seen.has(cr.card_id)) continue;
      if (master.color === cardColor) {
        seen.add(cr.card_id);
        related.push({
          card_id: cr.card_id, name: master.name_jp,
          color: COLOR_JP[master.color] || master.color,
          usage_rate: cr.usage_rate, decks: cr.decks,
          reason: '同色デッキ内で採用率上位'
        });
      }
    }
  }

  // 3. リンク先カード（カード名指定）
  if (cardInfo.link) {
    const linkNames = cardInfo.link.match(/「([^」]+)」/g) || [];
    for (const name of linkNames) {
      const cleanName = name.replace(/[「」]/g, '');
      // リンク条件のテキストの一部（例: 「特徴にティターンズを持つPILOT」）かカード名か判定
      const isCondition = /特徴|を持つ|PILOT|COMMAND/.test(cleanName);
      if (isCondition) continue; // 条件テキストはカード名検索しない（4で処理）
      for (const [id, master] of Object.entries(cardsMaster)) {
        if (master.name_jp && master.name_jp.includes(cleanName)) {
          const cr = cardRanking.find(c => c.card_id === id);
          if (!seen.has(id)) {
            seen.add(id);
            related.push({
              card_id: id, name: master.name_jp,
              color: COLOR_JP[master.color] || master.color,
              usage_rate: cr ? cr.usage_rate : 0, decks: cr ? cr.decks : 0,
              reason: 'リンク先'
            });
          }
        }
      }
    }
  }

  // 4. リンク条件（特徴指定のPILOT/COMMAND検索）
  if (cardInfo.link) {
    const linkText = cardInfo.link;
    // 「特徴に〇〇を持つPILOT」パターンの抽出
    const traitMatch = linkText.match(/特徴[にが]?〔?([^〕を]+)〕?を持つ(PILOT|COMMAND)?/i)
      || linkText.match(/〔([^〕]+)〕.*(PILOT|COMMAND)/i)
      || linkText.match(/(ティターンズ|ジオン|地球連邦|エゥーゴ|CB|鉄華団|WB隊|ザフト|ミネルバ隊|フォルドの夜明け|学園|ネオ・ジオン|アナハイム).*(PILOT|パイロット)/i);
    if (traitMatch) {
      const targetTrait = traitMatch[1];
      const targetType = (traitMatch[2] || 'PILOT').toUpperCase();
      for (const [id, master] of Object.entries(cardsMaster)) {
        if (seen.has(id)) continue;
        const masterTraits = master.traits || [];
        const masterType = (master.card_type || '').toUpperCase();
        if (masterTraits.includes(targetTrait) && (masterType === targetType || masterType === 'PILOT' || masterType === 'COMMAND')) {
          seen.add(id);
          const cr = cardRanking.find(c => c.card_id === id);
          related.push({
            card_id: id, name: master.name_jp,
            color: COLOR_JP[master.color] || master.color,
            usage_rate: cr ? cr.usage_rate : 0, decks: cr ? cr.decks : 0,
            reason: `リンク対象（${targetTrait} ${targetType}）`
          });
        }
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

// === カード画像URL判定 ===
function getCardImageUrl(card) {
  // X投稿画像がある場合はそちらを優先（未発売カード対策）
  if (card._xImageUrl) return card._xImageUrl;
  // 既存カード（ST/GD01-03）は公式カードリストから
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
  html += `      <img src="${imgUrl}" alt="${name}" style="width:250px;border-radius:6px;border:1px solid var(--border);cursor:pointer" onclick="showCardModal(this.src)" onerror="this.onerror=null;this.style.display='none'">\n`;
  html += '    </div>\n';
  // カード情報
  html += '    <div style="flex:1">\n';
  html += `      <h3 style="margin:0 0 8px 0;font-size:16px">${name} (${num})</h3>\n`;
  html += '      <table style="font-size:13px;margin-bottom:8px">\n';
  html += `        <tr><td style="padding-right:12px;color:var(--text-muted)">色</td><td>${escapeHtml(colorJp)}</td>`;
  html += `<td style="padding-left:16px;padding-right:12px;color:var(--text-muted)">タイプ</td><td>${escapeHtml(card.card_type)}</td></tr>\n`;
  html += `        <tr><td style="padding-right:12px;color:var(--text-muted)">Lv</td><td>${card.level != null ? card.level : '-'}</td>`;
  html += `<td style="padding-left:16px;padding-right:12px;color:var(--text-muted)">COST</td><td>${card.cost != null ? card.cost : '-'}</td></tr>\n`;
  html += `        <tr><td style="padding-right:12px;color:var(--text-muted)">AP</td><td>${card.ap != null ? card.ap : '-'}</td>`;
  html += `<td style="padding-left:16px;padding-right:12px;color:var(--text-muted)">HP</td><td>${card.hp != null ? card.hp : '-'}</td></tr>\n`;
  html += `        <tr><td style="padding-right:12px;color:var(--text-muted)">特徴</td><td colspan="3">${escapeHtml(traitsStr)}</td></tr>\n`;
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
function buildRelatedCardsHtml(relatedCards) {
  if (!relatedCards || relatedCards.length === 0) return '';

  let html = '<h2 style="font-size:15px;margin-top:28px">関連カード</h2>\n';
  html += '<ul style="list-style:none;padding:0;margin:12px 0">\n';

  for (const r of relatedCards) {
    const imgUrl = `${CARD_IMAGE_BASE}/${r.card_id}.webp`;
    html += '<li style="display:flex;align-items:center;gap:10px;margin-bottom:8px">\n';
    html += `  <a href="../../cards/${r.card_id}/" style="flex-shrink:0">\n`;
    html += `    <img src="${imgUrl}" alt="${escapeHtml(r.name)}" style="width:40px;height:56px;border-radius:3px;object-fit:cover;border:1px solid var(--border)" onerror="this.style.display='none'">\n`;
    html += '  </a>\n';
    html += '  <div>\n';
    html += `    <a href="../../cards/${r.card_id}/" style="color:var(--text-primary);text-decoration:none;font-weight:600">${escapeHtml(r.name)}<span style="color:var(--text-muted);font-weight:400;margin-left:4px">(${escapeHtml(r.card_id)})</span></a>\n`;
    html += `    <div style="font-size:12px;color:var(--text-secondary)">${escapeHtml(r.color)}系デッキ内採用率${r.usage_rate}% (${r.decks}デッキ)</div>\n`;
    html += '  </div>\n';
    html += '</li>\n';
  }

  html += '</ul>\n';
  return html;
}

// === 記事生成: 導入文 ===
async function generateIntroText(cardInfoList, relatedCards, articleDate) {
  const cardsDesc = cardInfoList.map(c => {
    const colorJp = COLOR_JP[c.color] || c.color;
    return `- ${c.card_name} (${c.card_number}): ${colorJp}/${c.card_type}`;
  }).join('\n');

  const prompt = `あなたはガンダムカードゲーム（GCG）の環境分析レポーターです。
以下の新カード情報に基づいて、カード紹介記事の「導入文」だけを書いてください。

【出力形式】
- HTML形式で <p> タグ1つだけ
- 2〜3行程度。カード枚数と収録パック名に触れる
- 日付は不要

【GCG用語ルール - 厳守】
- カードタイプは UNIT / PILOT / COMMAND / BASE の4種のみ
  「キャラクター」「モビルスーツ」「機動ユニット」は存在しない
- 以下の用語はGCGに存在しない。絶対に使わないこと:
  合体、アップグレード、エース効果、エースパーツ、高機動、機動ユニット、Xソリューズ、重大損傷コマンド
- EXリソースを「Xソリューズ」に変換しないこと
- カードタイプ「PILOT」を「キャラクター」に変換しないこと

【禁止表現 - 使用厳禁】
注目すべき、最も注目すべきは、徹底解析、一挙公開、秘めています、秘めた、バラエティ豊かな、
洗練させつつ、新しい風を吹き込む、待ち遠しいですね、爆発力を秘めています、幅広い可能性、
徹底、必見、一挙、速報レビュー

【記事生成の追加ルール】
- 「GUNDAM DYNASTY」という表現は使わない。セット名（例: GD04 Phantom Aria）を使うこと
- 「属性」という表現は使わない。GCGでは「色」が正しい表現

【文体】
- プレイヤーが読んで「なるほど」と思える分析を書く
- データに基づいた具体的な表現を使う
- 感想文ではなく分析記事を書く

【新カード情報】
${cardsDesc}

<p>タグのみ出力してください。`;

  log('  導入文生成中 (Claude API)...');
  return await callClaude([{ role: 'user', content: prompt }], 1000);
}

// === 記事生成: カードごとの考察 ===
async function generateCardAnalyses(cardInfoList, relatedCards) {
  const analyses = {};

  for (const card of cardInfoList) {
    const colorJp = COLOR_JP[card.color] || card.color;
    const relatedDesc = relatedCards.filter(r => r.color === colorJp || r.reason.includes('リンク先'))
      .slice(0, 3)
      .map(r => `${r.name}(${r.card_id}): ${r.color}系デッキ内採用率${r.usage_rate}%`)
      .join('、');

    const prompt = `あなたはガンダムカードゲーム（GCG）の環境分析レポーターです。
以下のカード1枚について、2〜3行の簡潔な考察を書いてください。プレーンテキストのみで出力（HTMLタグ不要）。

【カード情報】
- カード名: ${card.card_name} (${card.card_number})
- 色: ${colorJp} / タイプ: ${card.card_type}
- Lv.${card.level||'?'}, COST${card.cost||'?'}, AP${card.ap||'?'}/HP${card.hp||'?'}
- 特徴: ${(card.traits||[]).join('、')}
- 効果テキスト（原文）: ${card.effect||'効果なし（バニラ）'}

【関連カード（現環境データ）】
${relatedDesc || 'データなし'}

【GCG用語ルール - 厳守】
- カードタイプは UNIT / PILOT / COMMAND / BASE の4種のみ
  「キャラクター」「モビルスーツ」「機動ユニット」は存在しない
- 効果テキストは提供された原文をそのまま引用すること。言い換え・要約・解釈をしない
- 以下の用語はGCGに存在しない。絶対に使わないこと:
  合体、アップグレード、エース効果、エースパーツ、高機動、機動ユニット、Xソリューズ、重大損傷コマンド
- GCGの正しいキーワード能力: 《リペア》《突破》《ブロッカー》《クイック》《バースト》
  上記以外のキーワードを作らないこと
- EXリソースを「Xソリューズ」に変換しないこと
- COMMANDカードがPILOT的な役割を持つ場合がある。カードタイプは認識結果のまま使い、考察文でその特性に言及する

【禁止表現 - 使用厳禁】
注目すべき、最も注目すべきは、徹底解析、一挙公開、秘めています、秘めた、バラエティ豊かな、
洗練させつつ、新しい風を吹き込む、待ち遠しいですね、爆発力を秘めています、幅広い可能性、
徹底、必見、一挙、速報レビュー

【記事生成の追加ルール】
- 「GUNDAM DYNASTY」という表現は使わない。セット名（例: GD04 Phantom Aria）を使うこと
- 「属性」という表現は使わない。GCGでは「色」が正しい表現
- 効果テキストが空の場合は「効果なし（バニラ）」カードとして扱い、
  ステータスとコスト効率で評価すること。「不明」「評価できない」とは書かない

【考察文のルール】
- 効果テキストから読み取れる事実のみに基づいて考察すること
- カードの効果を勝手に解釈・推測して存在しない相互作用を書かないこと
- 既存カードとの相性を書く場合は、そのカードの効果テキストを確認してから書くこと
- 「中核を担う」「環境を変える」等の過大評価は避ける。新カードは実績がないため控えめに
- データに基づかない推測は避け、ステータスと効果の事実を中心に書く

【文体】
- プレイヤーが読んで「なるほど」と思える分析を書く
- 「このカード強そう」「使いたい」程度のカジュアルな感想はOK
- データに基づいた具体的な表現を使う
- 2〜3行で簡潔に。プレーンテキストのみ出力。`;

    try {
      log(`  考察生成中: ${card.card_name}...`);
      const analysis = await callClaude([{ role: 'user', content: prompt }], 500);
      analyses[card.card_number] = analysis.replace(/<[^>]*>/g, '').trim();
    } catch (e) {
      log(`  考察生成失敗: ${card.card_name} - ${e.message}`);
      analyses[card.card_number] = '';
    }
    await sleep(500);
  }

  return analyses;
}

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
async function generateTweetText(type, articleInfo) {
  let prompt;
  if (type === 'new_card') {
    prompt = `以下の新カード情報に基づいて、Xの投稿文を書いてください。

【ルール】
- 280文字以内
- 絵文字の箇条書き（📊📈📝のような羅列）は使わない
- 個人が書いたような自然な文体
- 記事URLとハッシュタグを含める

【カード情報】
${articleInfo.cardNames}

【記事URL】
${articleInfo.url}

【ハッシュタグ】
#ガンダムカードゲーム #GCG

投稿文のみを出力してください。`;
  } else {
    prompt = `以下の速報情報に基づいて、Xの投稿文を書いてください。

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
  }

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

  <script src="../../js/common.js?v=6"></script>
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
function findLinkTargets(cardInfo, cardsMaster, summary) {
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
    for (const [id, master] of Object.entries(cardsMaster)) {
      if (seen.has(id)) continue;
      const masterTraits = master.traits || [];
      const masterType = (master.card_type || '').toUpperCase();
      if (masterTraits.includes(targetTrait) && (masterType === targetType || masterType === 'PILOT' || masterType === 'COMMAND')) {
        seen.add(id);
        const cr = cardRanking.find(c => c.card_id === id);
        result.push({
          card_id: id, name: master.name_jp,
          color: COLOR_JP[master.color] || master.color,
          usage_rate: cr ? cr.usage_rate : 0, decks: cr ? cr.decks : 0,
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
    for (const [id, master] of Object.entries(cardsMaster)) {
      if (seen.has(id)) continue;
      if (master.name_jp && master.name_jp.includes(cleanName)) {
        seen.add(id);
        const cr = cardRanking.find(c => c.card_id === id);
        result.push({
          card_id: id, name: master.name_jp,
          color: COLOR_JP[master.color] || master.color,
          usage_rate: cr ? cr.usage_rate : 0, decks: cr ? cr.decks : 0,
          reason: 'リンク先'
        });
      }
    }
  }

  return result;
}

// === カードごとのインライン関連カード抽出（同色・同特徴、1〜2枚） ===
function findInlineRelated(cardInfo, cardsMaster, summary) {
  const traits = cardInfo.traits || [];
  const cardColor = cardInfo.color;
  const cardRanking = summary.card_ranking || [];
  const result = [];
  const seen = new Set();

  // 同色+同特徴 優先
  for (const cr of cardRanking) {
    if (result.length >= 2) break;
    const master = cardsMaster[cr.card_id];
    if (!master || seen.has(cr.card_id)) continue;
    const masterTraits = master.traits || [];
    const common = traits.filter(t => masterTraits.includes(t));
    if (common.length > 0 && master.color === cardColor) {
      seen.add(cr.card_id);
      result.push({ card_id: cr.card_id, name: master.name_jp, color: COLOR_JP[master.color] || master.color, usage_rate: cr.usage_rate });
    }
  }
  // 同特徴（色不問）で補完
  if (result.length < 1) {
    for (const cr of cardRanking) {
      if (result.length >= 2) break;
      const master = cardsMaster[cr.card_id];
      if (!master || seen.has(cr.card_id)) continue;
      const masterTraits = master.traits || [];
      const common = traits.filter(t => masterTraits.includes(t));
      if (common.length > 0) {
        seen.add(cr.card_id);
        result.push({ card_id: cr.card_id, name: master.name_jp, color: COLOR_JP[master.color] || master.color, usage_rate: cr.usage_rate });
      }
    }
  }
  return result;
}

// === 新カード記事の完全なHTML組み立て ===
function assembleCardArticleHtml(introHtml, cardInfoList, cardAnalyses, relatedCards, tweetUrls, cardsMaster, summary) {
  let html = '';

  // 1. 導入文（Claude生成パート）
  html += introHtml + '\n';

  // 2. カードブロック × N枚（画像+ステータス+考察+インライン関連カード+リンク対象をセットで表示）
  for (const card of cardInfoList) {
    const analysis = cardAnalyses[card.card_number] || '';
    const inlineRelated = findInlineRelated(card, cardsMaster, summary);
    // リンク対象カード抽出
    const linkTargets = findLinkTargets(card, cardsMaster, summary);
    html += buildCardBlockHtml(card, analysis, inlineRelated, linkTargets);
  }

  // 3. 関連カード（サムネイル+リンク付き）
  html += buildRelatedCardsHtml(relatedCards);

  // 4. 出典
  html += '\n<div style="margin-top:24px;padding-top:16px;border-top:1px solid var(--border)">\n';
  html += '<p style="font-size:12px;color:var(--text-muted)">出典:</p>\n<ul style="font-size:12px">\n';
  tweetUrls.forEach(url => {
    html += `<li><a href="${escapeHtml(url)}" target="_blank" rel="noopener" style="color:var(--accent)">${escapeHtml(url)}</a></li>\n`;
  });
  html += '</ul>\n</div>';

  // 5. モーダル（カード画像拡大表示）
  html += `\n<div id="card-modal" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:1000;cursor:pointer;align-items:center;justify-content:center" onclick="this.style.display='none'">
  <img id="card-modal-img" src="" style="max-width:90%;max-height:90%;border-radius:8px">
</div>
<script>function showCardModal(src){var m=document.getElementById('card-modal');document.getElementById('card-modal-img').src=src;m.style.display='flex';}</script>`;

  return html;
}

// === Git操作 ===
function gitPush(message) {
  if (DRY_RUN) { log(`[DRY-RUN] git push スキップ: ${message}`); return; }
  try {
    execSync('git add -A', { cwd: ROOT, encoding: 'utf-8' });
    execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, { cwd: ROOT, encoding: 'utf-8' });
    execSync('git push', { cwd: ROOT, encoding: 'utf-8' });
    log('git push 完了');
  } catch (e) {
    log(`git push 失敗: ${e.message}`);
  }
}

// === メイン処理 ===
async function main() {
  log('=== auto-news 開始 ===');

  if (!X_API_KEY || !X_ACCESS_TOKEN) {
    log('エラー: X API キーが設定されていません');
    process.exit(1);
  }

  if (!fs.existsSync(NEWS_DIR)) fs.mkdirSync(NEWS_DIR, { recursive: true });

  const sinceTime = parseSince() || getLastCheck();

  // ① 公式ツイート取得
  let tweets;
  try {
    tweets = await fetchOfficialTweets(sinceTime);
  } catch (e) {
    log(`公式ツイート取得失敗: ${e.message}`);
    process.exit(1);
  }

  // ② 分類
  const targets = tweets.map(tw => ({ tweet: tw, type: classifyTweet(tw) })).filter(t => t.type !== null);

  if (targets.length === 0) {
    log('対象投稿なし。終了します。');
    saveLastCheck();
    return;
  }

  log(`対象投稿: ${targets.length}件 (新カード: ${targets.filter(t=>t.type==='new_card').length}, 速報: ${targets.filter(t=>t.type==='notice').length})`);

  const cardsMaster = loadCardsMaster();
  const summary = loadSummary();
  const date = todayStr();

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

      let cardInfoList = null;
      if (tweet.images.length > 0 && ANTHROPIC_API_KEY) {
        try {
          cardInfoList = await recognizeCard(tweet.images, cardsMaster);
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
        // X投稿画像URLを保持（未発売カードの画像表示用）
        if (tweet.images.length > 0) {
          ci._xImageUrl = tweet.images[0];
        }
        allCardInfos.push(ci);
        const related = findRelatedCards(ci, cardsMaster, summary);
        allRelated.push(...related);
      }

      await sleep(1000);
    }

    // 認識結果をログに保存（松岡さんの確認用）
    const tweetUrlsForLog = [...new Set(allCardInfos.map(c => c._tweetUrl))];
    saveRecognitionLog(articleDate, allCardInfos, tweetUrlsForLog);

    // 関連カードの重複排除
    const uniqueRelated = [];
    const seenIds = new Set();
    for (const r of allRelated) {
      if (!seenIds.has(r.card_id)) { seenIds.add(r.card_id); uniqueRelated.push(r); }
    }

    const tweetUrls = [...new Set(allCardInfos.map(c => c._tweetUrl))];
    const dateLbl = dateLabel(articleDate);
    const cardCount = allCardInfos.length;

    // Claude APIで導入文を生成
    let introHtml;
    try {
      introHtml = await generateIntroText(allCardInfos, uniqueRelated.slice(0, 10), articleDate);
    } catch (e) {
      log(`導入文生成失敗: ${e.message}`);
      introHtml = `<p>GD04 Phantom Ariaから新カード${cardCount}枚が公開されました。</p>`;
    }

    // Claude APIでカードごとの考察を生成
    let cardAnalyses = {};
    try {
      cardAnalyses = await generateCardAnalyses(allCardInfos, uniqueRelated.slice(0, 10));
    } catch (e) {
      log(`考察生成失敗: ${e.message}`);
    }

    // 完全なHTML組み立て（カードブロック+関連カードリンクは自動生成）
    const articleHtml = assembleCardArticleHtml(introHtml, allCardInfos, cardAnalyses, uniqueRelated.slice(0, 10), tweetUrls, cardsMaster, summary);

    const title = `【${dateLbl}公開】GD04 Phantom Aria 新カード${cardCount}枚まとめ`;
    const desc = `ガンダムカードゲームGD04 Phantom Ariaから公開された新カード${cardCount}枚の紹介と環境考察。`;
    const pageHtml = generateNewsPage(date, title, desc, articleHtml, { displayDate: articleDate.replace(/-/g, '.') });
    const filePath = path.join(NEWS_DIR, `${date}.html`);
    fs.writeFileSync(filePath, pageHtml, { encoding: 'utf-8' });
    log(`記事保存: ${filePath}`);

    // X投稿（テストモードではスキップ）
    const articleUrl = `${SITE_URL}/reports/news/${date}.html`;
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
        articleHtml = `<h2>公式からのお知らせ</h2><p>${escapeHtml(tweet.text)}</p>`;
      }

      articleHtml += `\n<div style="margin-top:24px;padding-top:16px;border-top:1px solid var(--border)">
<p style="font-size:12px;color:var(--text-muted)">出典: <a href="${escapeHtml(tweetUrl)}" target="_blank" rel="noopener" style="color:var(--accent)">${escapeHtml(tweetUrl)}</a></p>
</div>`;

      const title = '公式お知らせ速報';
      const desc = tweet.text.substring(0, 120);
      const pageId = `${date}-notice`;
      const pageHtml = generateNewsPage(pageId, title, desc, articleHtml);
      const filePath = path.join(NEWS_DIR, `${pageId}.html`);
      fs.writeFileSync(filePath, pageHtml, { encoding: 'utf-8' });
      log(`速報記事保存: ${filePath}`);

      const articleUrl = `${SITE_URL}/reports/news/${pageId}.html`;
      if (TEST_MODE) {
        log(`[TEST_MODE] X投稿スキップ。記事URL: ${articleUrl}`);
      } else {
        try {
          const tweetText = await generateTweetText('notice', { summary: tweet.text.substring(0, 100), url: articleUrl });
          await postTweet(tweetText);
        } catch (e) {
          log(`X投稿生成/送信失敗: ${e.message}`);
        }
      }
    }
  }

  // ⑤ Git push
  const commitCards = newCards.length > 0 ? `新カード記事(${allCardInfos.length}枚)` : '';
  const commitNotices = notices.length > 0 ? `速報${notices.length}件` : '';
  const commitMsg = `auto-news: ${[commitCards, commitNotices].filter(Boolean).join(' + ')} (${date})`;
  gitPush(commitMsg);

  saveLastCheck();
  log('=== auto-news 完了 ===');
}

main().catch(e => {
  log(`致命的エラー: ${e.message}`);
  console.error(e);
  process.exit(1);
});
