// GD04 LR考察記事 X即時投稿スクリプト（フォールバック用）
// 使い方: node scripts/post-lr-today.js <1-5>   (1=青, 2=緑, 3=赤, 4=紫, 5=白)
// タスクスケジューラから各日12:30に呼び出す想定。

const crypto = require('crypto');
const https = require('https');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const API_KEY = process.env.X_API_KEY;
const API_SECRET = process.env.X_API_SECRET;
const ACCESS_TOKEN = process.env.X_API_ACCESS_TOKEN;
const ACCESS_TOKEN_SECRET = process.env.X_API_ACCESS_TOKEN_SECRET;

const posts = [
  { label: '青LR', text: `新カード記事紹介\nGD04 青LR考察 — 地球連邦の新たな切り札たち\nhttps://gcg-stats.com/reports/gd04-lr-blue.html\n\n記事内容に誤りがある場合はDMにてお知らせください\n#ガンダムカードゲーム\n#GCG` },
  { label: '緑LR', text: `新カード記事紹介\nGD04 緑LR考察 — ジオングの脅威と学園の新鋭\nhttps://gcg-stats.com/reports/gd04-lr-green.html\n\n記事内容に誤りがある場合はDMにてお知らせください\n#ガンダムカードゲーム\n#GCG` },
  { label: '赤LR', text: `新カード記事紹介\nGD04 赤LR考察 — 圧倒のネオ・ジオングと超兵キュリオス\nhttps://gcg-stats.com/reports/gd04-lr-red.html\n\n記事内容に誤りがある場合はDMにてお知らせください\n#ガンダムカードゲーム\n#GCG` },
  { label: '紫LR', text: `新カード記事紹介\nGD04 紫LR考察 — サテライトキャノンの衝撃とデスティニーの疾走\nhttps://gcg-stats.com/reports/gd04-lr-purple.html\n\n記事内容に誤りがある場合はDMにてお知らせください\n#ガンダムカードゲーム\n#GCG` },
  { label: '白LR', text: `新カード記事紹介\nGD04 白LR考察 — UC決戦と∀の可能性\nhttps://gcg-stats.com/reports/gd04-lr-white.html\n\n記事内容に誤りがある場合はDMにてお知らせください\n#ガンダムカードゲーム\n#GCG` },
];

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

const day = parseInt(process.argv[2] || '0', 10);
if (!day || day < 1 || day > 5) {
  console.error('使い方: node scripts/post-lr-today.js <1-5>');
  console.error('  1=青, 2=緑, 3=赤, 4=紫, 5=白');
  process.exit(1);
}
if (!API_KEY || !API_SECRET || !ACCESS_TOKEN || !ACCESS_TOKEN_SECRET) {
  console.error('❌ .env に X_API_KEY / X_API_SECRET / X_API_ACCESS_TOKEN / X_API_ACCESS_TOKEN_SECRET を設定してください');
  process.exit(1);
}

const p = posts[day - 1];
console.log(`[${p.label}] 投稿中...`);
postTweet(p.text)
  .then(() => console.log(`✅ ${p.label} 投稿完了`))
  .catch(err => { console.error(`❌ ${p.label} 失敗:`, err.message); process.exit(1); });
