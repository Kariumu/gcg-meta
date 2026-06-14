// EB01 LR考察記事 X即時投稿スクリプト
// 使い方: node scripts/post-eb01-lr.js          (DRY RUN: 投稿せず内容表示のみ)
//         node scripts/post-eb01-lr.js --post   (本投稿)
// 既存 post-lr-today.js のOAuth実装を踏襲。EB01 LRは1記事にまとめたため投稿は1回。

const crypto = require('crypto');
const https = require('https');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const API_KEY = process.env.X_API_KEY;
const API_SECRET = process.env.X_API_SECRET;
const ACCESS_TOKEN = process.env.X_API_ACCESS_TOKEN;
const ACCESS_TOKEN_SECRET = process.env.X_API_ACCESS_TOKEN_SECRET;

const post = {
  label: 'EB01 LR',
  text: `新カード記事紹介\nEB01「Eternal Nexus」LR全6種 徹底考察\n〔ジージェネ〕デッキのシナジーと使い方を、初心者向け解説と競技視点でまとめました。\n\nhttps://gcg-stats.com/reports/eb01-lr-review.html\n\n記事内容に誤りがある場合はDMにてお知らせください\n#ガンダムカードゲーム\n#GCG`
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
      res.on('end', () => {
        console.log(`Status: ${res.statusCode}`);
        console.log(`Response: ${data}`);
        if (res.statusCode === 201) resolve(JSON.parse(data));
        else reject(new Error(data));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const doPost = process.argv.includes('--post');

console.log('=== 投稿文プレビュー ===');
console.log(post.text);
console.log('========================');
console.log(`文字数(URL23字換算): ${[...post.text.replace(/https:\/\/\S+/g, 'x'.repeat(23))].length} 字`);
console.log('');

if (!doPost) {
  console.log('DRY RUN（投稿していません）。本投稿するには --post を付けて再実行してください。');
  process.exit(0);
}

if (!API_KEY || !API_SECRET || !ACCESS_TOKEN || !ACCESS_TOKEN_SECRET) {
  console.error('❌ .env に X_API_KEY / X_API_SECRET / X_API_ACCESS_TOKEN / X_API_ACCESS_TOKEN_SECRET を設定してください');
  process.exit(1);
}

console.log(`[${post.label}] 投稿中...`);
postTweet(post.text)
  .then(() => console.log(`✅ ${post.label} 投稿完了`))
  .catch(err => { console.error(`❌ ${post.label} 失敗:`, err.message); process.exit(1); });
