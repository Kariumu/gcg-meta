// GD05 LR色別考察記事 X投稿スクリプト (2026-07-11)
// 使い方: node scripts/post-gd05-lr.js --color=blue          (DRY RUN: 投稿せず内容表示のみ)
//         node scripts/post-gd05-lr.js --color=blue --post   (本投稿)
// 色: blue / green / red / purple / white
// post-eb01-lr.js のOAuth実装を踏襲。1日1色ずつ投稿する運用（GD04と同じ）。
// 予定: blue=7/11(即時), green=7/12, red=7/13, purple=7/14, white=7/15 (各12:30 JST)

const crypto = require('crypto');
const https = require('https');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const API_KEY = process.env.X_API_KEY;
const API_SECRET = process.env.X_API_SECRET;
const ACCESS_TOKEN = process.env.X_API_ACCESS_TOKEN;
const ACCESS_TOKEN_SECRET = process.env.X_API_ACCESS_TOKEN_SECRET;

const POSTS = {
  blue: {
    label: 'GD05 青LR',
    text: `新カード記事紹介\nGD05 青LR考察 — 光の翼と自由の帰還\nV2ガンダムとストライクフリーダムガンダム、青LR2枚の性能と環境予想をまとめました。\n\nhttps://gcg-stats.com/reports/gd05-lr-blue.html\n\n記事内容に誤りがある場合はDMにてお知らせください\n#ガンダムカードゲーム\n#GCG`
  },
  green: {
    label: 'GD05 緑LR',
    text: `新カード記事紹介\nGD05 緑LR考察 — νガンダム参戦とキャリバーンの障壁\n逆シャア参戦のνガンダムとガンダム・キャリバーン、緑LR2枚を考察しました。\n\nhttps://gcg-stats.com/reports/gd05-lr-green.html\n\n記事内容に誤りがある場合はDMにてお知らせください\n#ガンダムカードゲーム\n#GCG`
  },
  red: {
    label: 'GD05 赤LR',
    text: `新カード記事紹介\nGD05 赤LR考察 — 東方不敗の拳とファントムペインの牙\nマスターガンダム・ガイアガンダム・マスター・アジア、赤LR3枚を考察しました。\n\nhttps://gcg-stats.com/reports/gd05-lr-red.html\n\n記事内容に誤りがある場合はDMにてお知らせください\n#ガンダムカードゲーム\n#GCG`
  },
  purple: {
    label: 'GD05 紫LR',
    text: `新カード記事紹介\nGD05 紫LR考察 — 逆襲のサザビーと厄祭の王\nサザビー・エクシアリペア・バルバトスルプスレクス、紫LR3枚を考察しました。\n\nhttps://gcg-stats.com/reports/gd05-lr-purple.html\n\n記事内容に誤りがある場合はDMにてお知らせください\n#ガンダムカードゲーム\n#GCG`
  },
  white: {
    label: 'GD05 白LR',
    text: `新カード記事紹介\nGD05 白LR考察 — シャイニングの闘気とゼロの制圧\nシャイニングガンダムとウイングガンダムゼロ（EW版）、白LR2枚を考察しました。\n\nhttps://gcg-stats.com/reports/gd05-lr-white.html\n\n記事内容に誤りがある場合はDMにてお知らせください\n#ガンダムカードゲーム\n#GCG`
  }
};

function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/!/g, '%21').replace(/\*/g, '%2A').replace(/'/g, '%27')
    .replace(/\(/g, '%28').replace(/\)/g, '%29');
}

function generateOAuthSignature(method, url, params, consumerSecret, tokenSecret) {
  const sortedParams = Object.keys(params).sort()
    .map(k => `${percentEncode(k)}=${percentEncode(params[k])}`).join('&');
  const baseString = `${method}&${percentEncode(url)}&${percentEncode(sortedParams)}`;
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');
}

function postTweet(text) {
  const url = 'https://api.x.com/2/tweets';
  const oauthParams = {
    oauth_consumer_key: API_KEY,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: ACCESS_TOKEN,
    oauth_version: '1.0'
  };
  oauthParams.oauth_signature = generateOAuthSignature('POST', url, oauthParams, API_SECRET, ACCESS_TOKEN_SECRET);
  const authHeader = 'OAuth ' + Object.keys(oauthParams).sort()
    .map(k => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`).join(', ');
  const body = JSON.stringify({ text });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.x.com', path: '/2/tweets', method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function main() {
  const colorArg = process.argv.find(a => a.startsWith('--color='));
  const DO_POST = process.argv.includes('--post');
  const color = colorArg ? colorArg.replace('--color=', '') : null;
  if (!color || !POSTS[color]) {
    console.error('使い方: node scripts/post-gd05-lr.js --color=<blue|green|red|purple|white> [--post]');
    process.exit(1);
  }
  const post = POSTS[color];
  const urlLess = post.text.replace(/https:\/\/\S+/g, '');
  console.log(`[${post.label}] 本文（URL除く ${urlLess.length} 文字）:\n---\n${post.text}\n---`);
  if (!DO_POST) { console.log('DRY RUN: 投稿していません（--post で本投稿）'); return; }
  if (!API_KEY || !API_SECRET || !ACCESS_TOKEN || !ACCESS_TOKEN_SECRET) {
    console.error('エラー: .env の X API 認証情報が不足しています');
    process.exit(1);
  }
  const r = await postTweet(post.text);
  console.log(`HTTP ${r.status}: ${r.body}`);
  if (r.status !== 201) process.exit(1);
  console.log(`✓ ${post.label} 投稿完了`);
}

main().catch(e => { console.error('致命的エラー:', e.message); process.exit(1); });
// EOF
