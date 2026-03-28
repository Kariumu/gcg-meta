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
require('dotenv').config();

// === 設定 ===
const SITE_URL = 'https://gcg-stats.com';
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const NEWS_DIR = path.join(ROOT, 'reports', 'news');
const LAST_CHECK_FILE = path.join(DATA_DIR, 'last-check.json');
const LOG_FILE = path.join(DATA_DIR, 'auto-news-log.txt');

const OFFICIAL_USER_ID = '1837069552842330114'; // @GUNDAM_GCG_JP
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';

const X_API_KEY = process.env.X_API_KEY;
const X_API_SECRET = process.env.X_API_SECRET;
const X_ACCESS_TOKEN = process.env.X_API_ACCESS_TOKEN;
const X_ACCESS_TOKEN_SECRET = process.env.X_API_ACCESS_TOKEN_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const DRY_RUN = process.argv.includes('--dry-run');

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

function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function stripTags(s) { return s.replace(/<[^>]*>/g, ''); }

function log(msg) {
  const line = `[${now()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n', 'utf-8');
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
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
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
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
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
function callClaude(messages, maxTokens) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY が設定されていません');
  maxTokens = maxTokens || 2000;
  const body = JSON.stringify({
    model: ANTHROPIC_MODEL,
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
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
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
    // デフォルト: 12時間前
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

  // メディアマップ作成
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
async function recognizeCard(imageUrls) {
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

  content.push({ type: 'text', text: `この画像はガンダムカードゲーム（GCG）のカード紹介画像です。
画像からカード情報を読み取り、以下のJSON形式で出力してください。
他の文章は一切不要です。JSONのみ出力してください。
複数カードがある場合はJSON配列で出力してください。

{
  "card_number": "GD04-009",
  "card_name": "ガンキャノン（108）&ガンキャノン（109）",
  "rarity": "R",
  "color": "Blue",
  "level": 5,
  "cost": 4,
  "ap": 3,
  "hp": 4,
  "card_type": "UNIT",
  "zone": "宇宙 地球",
  "traits": ["地球連邦", "WB隊"],
  "link": "「カイ・シデン」/「ハヤト・コバヤシ」",
  "effect": "【リンク時】このユニット以外の、Lv.4以上の〔WB隊〕の自分のユニット1つを選ぶ。それをアクティブにする。",
  "model_number": "RX-77"
}` });

  log('  カード画像認識中...');
  const result = await callClaude([{ role: 'user', content }], 2000);

  try {
    // JSON部分を抽出
    const jsonMatch = result.match(/\[[\s\S]*\]/) || result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return Array.isArray(parsed) ? parsed : [parsed];
    }
  } catch (e) {
    log(`  画像認識JSON解析失敗: ${e.message}`);
  }
  return null;
}

// === 関連カード抽出 ===
function findRelatedCards(cardInfo, cardsMaster, summary) {
  const COLOR_JP = { Blue: '青', Red: '赤', Green: '緑', White: '白', Purple: '紫' };
  const colorJp = COLOR_JP[cardInfo.color] || cardInfo.color;
  const traits = cardInfo.traits || [];
  const cardRanking = summary.card_ranking || [];

  const related = [];

  // 同じ特徴を持つカード（採用率上位）
  for (const cr of cardRanking) {
    if (related.length >= 5) break;
    const master = cardsMaster[cr.card_id];
    if (!master) continue;
    const masterTraits = master.traits || [];
    const hasCommonTrait = traits.some(t => masterTraits.includes(t));
    if (hasCommonTrait) {
      related.push({
        card_id: cr.card_id,
        name: master.name_jp,
        color: COLOR_JP[master.color] || master.color,
        usage_rate: cr.usage_rate,
        decks: cr.decks,
        reason: `共通特徴: ${traits.filter(t => masterTraits.includes(t)).join('、')}`
      });
    }
  }

  // リンク先カード
  if (cardInfo.link) {
    const linkNames = cardInfo.link.match(/「([^」]+)」/g) || [];
    for (const name of linkNames) {
      const cleanName = name.replace(/[「」]/g, '');
      for (const [id, master] of Object.entries(cardsMaster)) {
        if (master.name_jp && master.name_jp.includes(cleanName)) {
          const cr = cardRanking.find(c => c.card_id === id);
          if (cr && !related.find(r => r.card_id === id)) {
            related.push({
              card_id: id, name: master.name_jp,
              color: COLOR_JP[master.color] || master.color,
              usage_rate: cr.usage_rate, decks: cr.decks,
              reason: 'リンク先'
            });
          }
        }
      }
    }
  }

  return related.slice(0, 5);
}

// === 記事生成: 新カード ===
async function generateCardArticle(cardInfoList, relatedCards, tweetUrl) {
  const COLOR_JP = { Blue: '青', Red: '赤', Green: '緑', White: '白', Purple: '紫' };
  const cardsDesc = cardInfoList.map(c => {
    const colorJp = COLOR_JP[c.color] || c.color;
    return `- ${c.card_name} (${c.card_number}): ${colorJp}/${c.card_type}, Lv.${c.level||'?'}, COST${c.cost||'?'}, AP${c.ap||'?'}/HP${c.hp||'?'}, 特徴: ${(c.traits||[]).join('、')}, 効果: ${c.effect||'不明'}`;
  }).join('\n');

  const relatedDesc = relatedCards.map(r =>
    `- ${r.name} (${r.card_id}) [${r.color}] — 採用率${r.usage_rate}% (${r.decks}デッキ) — ${r.reason}`
  ).join('\n');

  const prompt = `あなたはガンダムカードゲーム（GCG）の環境分析レポーターです。
以下の新カード情報と関連カードデータに基づいて、新カード紹介記事を日本語で書いてください。

【厳守ルール】
- デッキタイプ名はすべて日本語表記（青/紫、赤/白等）
- カードの色情報を必ず確認し、そのカードの色に基づいた正確な表現をすること
- 採用率は「○○系デッキ内採用率」を使用すること
- 数値データは正確に引用し、推測で数値を作らないこと
- 堅すぎず、TCGプレイヤーが読んで面白い文体にすること
- AI臭い表現（「注目すべき」「特筆すべき」等）を避けること
- HTML形式で出力（<h2>、<p>、<ul>タグを使用）
- 全体で400〜800文字程度

【記事の構成】
1. カード紹介（名前・ステータス・効果の要約）
2. 環境への影響考察（既存の同色・同特徴カードとの比較、採用率データを活用）
3. 関連カード紹介（2〜3枚、採用率付き）

【新カード情報】
${cardsDesc}

【関連カード】
${relatedDesc || 'データなし'}

【出典】
公式XポストURL: ${tweetUrl}`;

  log('  記事生成中 (Claude API)...');
  return await callClaude([{ role: 'user', content: prompt }], 3000);
}

// === 記事生成: 速報 ===
async function generateNoticeArticle(tweetText, tweetUrl, summary) {
  // 関連する採用率データがあれば付与
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
  例: 禁止制限カードの現在の採用率データを添える
- AI臭い表現を避け、自然な文体にすること
- HTML形式で出力（<h2>、<p>タグを使用）
- 全体で300〜600文字程度

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
  // 余分な引用符や改行を除去
  return result.replace(/^["']|["']$/g, '').trim();
}

// === HTMLページ生成 ===
function generateNewsPage(pageId, title, description, articleHtml, options) {
  options = options || {};
  const canonical = options.canonical || `${SITE_URL}/reports/news/${pageId}.html`;
  const backLink = options.backLink || 'index.html';

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
      <span class="section-badge">${todayStr().replace(/-/g, '.')}</span>
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

  // news ディレクトリ確保
  if (!fs.existsSync(NEWS_DIR)) fs.mkdirSync(NEWS_DIR, { recursive: true });

  // チェック開始時刻
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

  // データ読み込み
  const cardsMaster = loadCardsMaster();
  const summary = loadSummary();
  const date = todayStr();

  // ③ 各ターゲットを処理
  const newCards = targets.filter(t => t.type === 'new_card');
  const notices = targets.filter(t => t.type === 'notice');

  // === 新カード記事 ===
  let allCardInfos = [];
  if (newCards.length > 0) {
    const allRelated = [];

    for (const { tweet } of newCards) {
      const tweetUrl = `https://x.com/GUNDAM_GCG_JP/status/${tweet.id}`;

      // 画像認識
      let cardInfoList = null;
      if (tweet.images.length > 0 && ANTHROPIC_API_KEY) {
        try {
          cardInfoList = await recognizeCard(tweet.images);
        } catch (e) {
          log(`  画像認識失敗: ${e.message}`);
        }
      }

      if (!cardInfoList) {
        // テキストから最低限の情報を抽出
        log('  画像認識なし。テキストのみで処理。');
        cardInfoList = [{ card_name: tweet.text.split('\n')[1] || '新カード', card_number: '不明', color: '不明', card_type: '不明', traits: [], effect: tweet.text }];
      }

      for (const ci of cardInfoList) {
        ci._tweetUrl = tweetUrl;
        allCardInfos.push(ci);
        const related = findRelatedCards(ci, cardsMaster, summary);
        allRelated.push(...related);
      }

      await sleep(1000);
    }

    // 日別まとめ記事生成
    const tweetUrls = [...new Set(allCardInfos.map(c => c._tweetUrl))];
    let articleHtml;
    try {
      articleHtml = await generateCardArticle(allCardInfos, allRelated, tweetUrls.join('\n'));
    } catch (e) {
      log(`記事生成失敗: ${e.message}`);
      articleHtml = `<h2>新カード公開</h2><p>${allCardInfos.map(c => escapeHtml(c.card_name)).join('、')}が公開されました。</p>`;
    }

    // 出典リンク追加
    articleHtml += '\n<div style="margin-top:24px;padding-top:16px;border-top:1px solid var(--border)">\n';
    articleHtml += '<p style="font-size:12px;color:var(--text-muted)">出典:</p>\n<ul style="font-size:12px">\n';
    tweetUrls.forEach(url => {
      articleHtml += `<li><a href="${escapeHtml(url)}" target="_blank" rel="noopener" style="color:var(--accent)">${escapeHtml(url)}</a></li>\n`;
    });
    articleHtml += '</ul>\n</div>';

    // HTML保存
    const cardNames = allCardInfos.map(c => c.card_name).join('、');
    const title = `新カード公開: ${cardNames}`;
    const desc = `ガンダムカードゲーム新カード${cardNames}の紹介と環境への影響考察。`;
    const pageHtml = generateNewsPage(date, title, desc, articleHtml);
    const filePath = path.join(NEWS_DIR, `${date}.html`);
    fs.writeFileSync(filePath, pageHtml, { encoding: 'utf-8' });
    log(`記事保存: ${filePath}`);

    // X投稿
    const articleUrl = `${SITE_URL}/reports/news/${date}.html`;
    try {
      const tweetText = await generateTweetText('new_card', { cardNames, url: articleUrl });
      await postTweet(tweetText);
    } catch (e) {
      log(`X投稿生成/送信失敗: ${e.message}`);
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

      // 出典リンク
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

      // X投稿
      const articleUrl = `${SITE_URL}/reports/news/${pageId}.html`;
      try {
        const tweetText = await generateTweetText('notice', { summary: tweet.text.substring(0, 100), url: articleUrl });
        await postTweet(tweetText);
      } catch (e) {
        log(`X投稿生成/送信失敗: ${e.message}`);
      }
    }
  }

  // ⑤ Git push
  const commitCards = newCards.length > 0 ? `新カード記事(${allCardInfos.length}枚)` : '';
  const commitNotices = notices.length > 0 ? `速報${notices.length}件` : '';
  const commitMsg = `auto-news: ${[commitCards, commitNotices].filter(Boolean).join(' + ')} (${date})`;
  gitPush(commitMsg);

  // チェック日時保存
  saveLastCheck();
  log('=== auto-news 完了 ===');
}

main().catch(e => {
  log(`致命的エラー: ${e.message}`);
  console.error(e);
  process.exit(1);
});
