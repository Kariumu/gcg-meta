// GD04 LR考察記事 X予約投稿スクリプト
// 使い方:
//   DRY RUN: node scripts/schedule-lr-posts.js
//   本実行:  DRY_RUN=false node scripts/schedule-lr-posts.js
//
// scheduled_at は X API の上位プランでのみサポートされます。
// Free/Basic の pay-per-use で 403 が返った場合、方法A/B のフォールバック運用が必要です。

const crypto = require('crypto');
const https = require('https');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });

const API_KEY = process.env.X_API_KEY;
const API_SECRET = process.env.X_API_SECRET;
const ACCESS_TOKEN = process.env.X_API_ACCESS_TOKEN;
const ACCESS_TOKEN_SECRET = process.env.X_API_ACCESS_TOKEN_SECRET;

// 12:30 JST = 03:30 UTC
const posts = [
  {
    label: '青LR',
    text: `新カード記事紹介\nGD04 青LR考察 — 地球連邦の新たな切り札たち\nhttps://gcg-stats.com/reports/gd04-lr-blue.html\n\n記事内容に誤りがある場合はDMにてお知らせください\n#ガンダムカードゲーム\n#GCG`,
    scheduled_at: '2026-04-12T03:30:00Z'
  },
  {
    label: '緑LR',
    text: `新カード記事紹介\nGD04 緑LR考察 — ジオングの脅威と学園の新鋭\nhttps://gcg-stats.com/reports/gd04-lr-green.html\n\n記事内容に誤りがある場合はDMにてお知らせください\n#ガンダムカードゲーム\n#GCG`,
    scheduled_at: '2026-04-13T03:30:00Z'
  },
  {
    label: '赤LR',
    text: `新カード記事紹介\nGD04 赤LR考察 — 圧倒のネオ・ジオングと超兵キュリオス\nhttps://gcg-stats.com/reports/gd04-lr-red.html\n\n記事内容に誤りがある場合はDMにてお知らせください\n#ガンダムカードゲーム\n#GCG`,
    scheduled_at: '2026-04-14T03:30:00Z'
  },
  {
    label: '紫LR',
    text: `新カード記事紹介\nGD04 紫LR考察 — サテライトキャノンの衝撃とデスティニーの疾走\nhttps://gcg-stats.com/reports/gd04-lr-purple.html\n\n記事内容に誤りがある場合はDMにてお知らせください\n#ガンダムカードゲーム\n#GCG`,
    scheduled_at: '2026-04-15T03:30:00Z'
  },
  {
    label: '白LR',
    text: `新カード記事紹介\nGD04 白LR考察 — UC決戦と∀の可能性\nhttps://gcg-stats.com/reports/gd04-lr-white.html\n\n記事内容に誤りがある場合はDMにてお知らせください\n#ガンダムカードゲーム\n#GCG`,
    scheduled_at: '2026-04-16T03:30:00Z'
  }
];

function percentEncode(str) {
  return encodeURIComponent(str)
    .replace(/!/g, '%21')
    .replace(/\*/g, '%2A')
    .replace(/'/g, '%27')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29');
}

function generateOAuthSignature(method, url, params, consumerSecret, tokenSecret) {
  const sortedParams = Object.keys(params).sort()
    .map(k => `${percentEncode(k)}=${percentEncode(params[k])}`).join('&');
  const baseString = `${method}&${percentEncode(url)}&${percentEncode(sortedParams)}`;
  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');
}

function generateOAuthHeader(method, url) {
  const oauthParams = {
    oauth_consumer_key: API_KEY,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: ACCESS_TOKEN,
    oauth_version: '1.0'
  };
  oauthParams.oauth_signature = generateOAuthSignature(
    method, url, oauthParams, API_SECRET, ACCESS_TOKEN_SECRET
  );
  return 'OAuth ' + Object.keys(oauthParams).sort()
    .map(k => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`).join(', ');
}

function postTweet(tweetData) {
  const url = 'https://api.x.com/2/tweets';
  const authHeader = generateOAuthHeader('POST', url);
  const body = { text: tweetData.text };
  if (tweetData.scheduled_at) body.scheduled_at = tweetData.scheduled_at;
  const bodyStr = JSON.stringify(body);

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.x.com',
      path: '/2/tweets',
      method: 'POST',
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(bodyStr)
      }
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(data); } catch { parsed = data; }
        resolve({ status: res.statusCode, data: parsed });
      });
    });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

function toJstString(isoUtc) {
  const d = new Date(isoUtc);
  const jst = new Date(d.getTime() + 9 * 3600 * 1000);
  return jst.toISOString().replace('T', ' ').slice(0, 16) + ' JST';
}

async function main() {
  console.log('=== GD04 LR記事 X予約投稿 ===\n');
  console.log('投稿予定:');
  for (const p of posts) {
    console.log(`  [${p.label}] ${toJstString(p.scheduled_at)}`);
    console.log(`    ${p.text.split('\n')[1]}`);
  }
  console.log();

  const DRY_RUN = process.env.DRY_RUN !== 'false';
  if (DRY_RUN) {
    console.log('DRY RUN モード: 実際の投稿は行いません。');
    console.log('本実行: DRY_RUN=false node scripts/schedule-lr-posts.js');
    return;
  }

  if (!API_KEY || !API_SECRET || !ACCESS_TOKEN || !ACCESS_TOKEN_SECRET) {
    console.error('❌ X_API_KEY / X_API_SECRET / X_API_ACCESS_TOKEN / X_API_ACCESS_TOKEN_SECRET が未設定です (.env を確認)');
    process.exit(1);
  }

  let scheduledSupportChecked = false;
  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    console.log(`[${i + 1}/${posts.length}] ${post.label} 予約投稿中...`);
    try {
      const result = await postTweet(post);
      const body = typeof result.data === 'object' ? JSON.stringify(result.data) : String(result.data);

      if (result.status === 201 || result.status === 200) {
        console.log(`  ✅ 成功: id=${result.data?.data?.id || '(unknown)'}`);
        scheduledSupportChecked = true;
      } else if (!scheduledSupportChecked && (result.status === 403 || result.status === 400) && /scheduled/i.test(body)) {
        console.log(`  ⚠️  scheduled_at 非対応の可能性: ${result.status} ${body}`);
        console.log('     フォールバック運用（方法A/B）に切り替えてください。以降の予約は中止します。');
        break;
      } else {
        console.log(`  ❌ 失敗: ${result.status} ${body}`);
      }
    } catch (e) {
      console.log(`  ❌ エラー: ${e.message}`);
    }
    if (i < posts.length - 1) await new Promise(r => setTimeout(r, 2000));
  }
  console.log('\n完了');
}

main().catch(e => { console.error(e); process.exit(1); });
