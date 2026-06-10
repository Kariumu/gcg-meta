#!/usr/bin/env node
/**
 * backfill-preview-images.js
 * プレビューカード画像のバックフィル(一回限りのメンテナンススクリプト)
 *
 * 指示書: cowork-instr-v3-cardfix-images-ui-2026-06-10.md Task C
 * 対象: サイトに画像が表示されていない9枚。各カードの source_url(公式Xポスト)から
 *       画像を取得し、images/news/{_articleDate}/{card_number}.jpg として保存する。
 *
 * 仕組みは auto-news.js を流用:
 *  - 認証: .env の X_API_KEY / X_API_SECRET / X_API_ACCESS_TOKEN / X_API_ACCESS_TOKEN_SECRET
 *    (OAuth 1.0a。auto-news.js generateOAuthSignature/buildOAuthHeader/xGet と同方式)
 *  - 取得: GET /2/tweets?ids=...(ツイートIDルックアップ、1リクエストで9件)
 *  - 保存: auto-news.js の downloadCardImage と同方式(既存ファイルはスキップ=上書き禁止)
 *
 * 使い方: node scripts/backfill-preview-images.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });

const X_API_KEY = process.env.X_API_KEY;
const X_API_SECRET = process.env.X_API_SECRET;
const X_ACCESS_TOKEN = process.env.X_API_ACCESS_TOKEN;
const X_ACCESS_TOKEN_SECRET = process.env.X_API_ACCESS_TOKEN_SECRET;

const NEWS_IMAGE_DIR = path.join(__dirname, '..', 'images', 'news');

// 対象9枚(card_number / ツイートID(source_urlより) / 保存先日付(_articleDateより))
const TARGETS = [
  { card: 'EB01-045', tweetId: '2055249332526285051', date: '2026-05-15' },
  { card: 'EB01-025', tweetId: '2056646041399873754', date: '2026-05-19' },
  { card: 'EB01-065', tweetId: '2056653585899790603', date: '2026-05-19' },
  { card: 'EB01-046', tweetId: '2057008423401902537', date: '2026-05-20' },
  { card: 'EB01-071', tweetId: '2057015973195202879', date: '2026-05-20' },
  { card: 'ST10-007', tweetId: '2058103138683441230', date: '2026-05-22' },
  { card: 'ST10-015', tweetId: '2058095592392266197', date: '2026-05-22' },
  { card: 'EB01-028', tweetId: '2057786048676262125', date: '2026-05-22' },
  { card: 'EB01-068', tweetId: '2057787306203832447', date: '2026-05-22' },
];

// === OAuth 1.0a(auto-news.js と同方式)===
function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/!/g, '%21').replace(/\*/g, '%2A')
    .replace(/'/g, '%27').replace(/\(/g, '%28').replace(/\)/g, '%29');
}

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

function xGet(endpoint, params) {
  const baseUrl = `https://api.x.com${endpoint}`;
  const qs = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
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

// === 画像ダウンロード(auto-news.js downloadCardImage と同方式、上書き禁止)===
function downloadImage(imageUrl, cardNumber, date) {
  const dir = path.join(NEWS_IMAGE_DIR, date);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`  フォルダ作成: images/news/${date}/`);
  }
  const ext = imageUrl.includes('.png') ? '.png' : '.jpg';
  const filename = `${cardNumber}${ext}`;
  const filepath = path.join(dir, filename);

  // NEVER: 既存画像の上書き禁止
  if (fs.existsSync(filepath)) {
    console.log(`  スキップ(既存): images/news/${date}/${filename}`);
    return Promise.resolve({ status: 'skipped', filename });
  }

  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filepath);
    https.get(new URL(imageUrl), (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        file.close();
        fs.unlink(filepath, () => {});
        downloadImage(response.headers.location, cardNumber, date).then(resolve).catch(reject);
        return;
      }
      if (response.statusCode !== 200) {
        file.close();
        fs.unlink(filepath, () => {});
        reject(new Error(`画像取得 HTTP ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        const size = fs.statSync(filepath).size;
        console.log(`  保存: images/news/${date}/${filename} (${size} bytes)`);
        resolve({ status: 'saved', filename, size });
      });
    }).on('error', (err) => {
      fs.unlink(filepath, () => {});
      reject(err);
    });
  });
}

// === メイン ===
async function main() {
  if (!X_API_KEY || !X_API_SECRET || !X_ACCESS_TOKEN || !X_ACCESS_TOKEN_SECRET) {
    console.error('✖ .env の X API 認証情報が不足しています');
    process.exit(1);
  }

  console.log(`[backfill] 対象 ${TARGETS.length} 枚のツイートをルックアップ...`);
  const ids = TARGETS.map(t => t.tweetId).join(',');
  const data = await xGet('/2/tweets', {
    ids,
    expansions: 'attachments.media_keys',
    'media.fields': 'url,type',
  });

  // media_key -> photo url(auto-news.js line 648 と同パターン)
  const mediaMap = {};
  for (const m of (data.includes && data.includes.media) || []) {
    mediaMap[m.media_key] = m;
  }
  const tweetMap = {};
  for (const t of data.data || []) {
    const keys = (t.attachments && t.attachments.media_keys) || [];
    tweetMap[t.id] = keys.map(mk => mediaMap[mk]).filter(m => m && m.type === 'photo').map(m => m.url);
  }
  if (data.errors) {
    for (const e of data.errors) console.warn(`  ⚠ ツイート取得エラー: ${e.resource_id || ''} ${e.title || e.detail || ''}`);
  }

  const results = { saved: [], skipped: [], failed: [] };
  for (const t of TARGETS) {
    const photos = tweetMap[t.tweetId] || [];
    if (photos.length === 0) {
      console.warn(`  ✖ ${t.card}: ツイート ${t.tweetId} に photo メディアが見つかりません`);
      results.failed.push(t.card);
      continue;
    }
    try {
      const r = await downloadImage(photos[0], t.card, t.date);
      results[r.status === 'saved' ? 'saved' : 'skipped'].push(t.card);
    } catch (e) {
      console.warn(`  ✖ ${t.card}: ${e.message}`);
      results.failed.push(t.card);
    }
  }

  console.log('--- 結果 ---');
  console.log(`  保存: ${results.saved.length} 件 ${results.saved.join(', ')}`);
  console.log(`  既存スキップ: ${results.skipped.length} 件 ${results.skipped.join(', ')}`);
  console.log(`  失敗: ${results.failed.length} 件 ${results.failed.join(', ')}`);
  if (results.failed.length > 0) process.exitCode = 2;
}

main().catch((e) => {
  console.error('致命的エラー:', e.message);
  process.exit(1);
});
