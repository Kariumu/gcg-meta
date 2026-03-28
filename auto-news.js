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
const ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';

const X_API_KEY = process.env.X_API_KEY;
const X_API_SECRET = process.env.X_API_SECRET;
const X_ACCESS_TOKEN = process.env.X_API_ACCESS_TOKEN;
const X_ACCESS_TOKEN_SECRET = process.env.X_API_ACCESS_TOKEN_SECRET;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const DRY_RUN = process.argv.includes('--dry-run');

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
画像からカード情報を正確に読み取り、以下のJSON形式のみで出力してください。
他の文章は一切不要です。JSONのみ出力してください。

【重要ルール】
- card_type は UNIT / PILOT / COMMAND / BASE の4種のみ。「キャラクター」「モビルスーツ」等は使わない
- カード名は画像に表示されている通りに正確に転記すること
- 効果テキストは画像に表示されている通りに一字一句正確に転記すること。要約・言い換え・解釈をしない
- GCGのキーワード能力: 《リペア》《突破》《ブロッカー》《クイック》《バースト》のみ。これ以外のキーワードを捏造しない
- 「EXリソース」を「Xソリューズ」等に誤変換しない
- 色はBlue/Red/Green/White/Purpleのいずれか

{
  "card_number": "GD04-009",
  "card_name": "ガンキャノン（108）＆ガンキャノン（109）",
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
  "effect": "【リンク時】このユニット以外の、Lv.4以上の〔WB隊〕の自分のユニット1つを選ぶ。それをアクティブにする。"
}` });

  log('  カード画像認識中...');
  const result = await callClaude([{ role: 'user', content }], 2000);

  try {
    const jsonMatch = result.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const cards = Array.isArray(parsed) ? parsed : [parsed];
      // バリデーション
      return cards.map(c => validateCardInfo(c));
    }
  } catch (e) {
    log(`  画像認識JSON解析失敗: ${e.message}`);
  }
  return null;
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

  // 3. リンク先カード
  if (cardInfo.link) {
    const linkNames = cardInfo.link.match(/「([^」]+)」/g) || [];
    for (const name of linkNames) {
      const cleanName = name.replace(/[「」]/g, '');
      for (const [id, master] of Object.entries(cardsMaster)) {
        if (master.name_jp && master.name_jp.includes(cleanName)) {
          const cr = cardRanking.find(c => c.card_id === id);
          if (cr && !seen.has(id)) {
            seen.add(id);
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

// === カードブロックHTML（画像+ステータス+考察をセット表示） ===
function buildCardBlockHtml(card, analysis) {
  const num = escapeHtml(card.card_number);
  const name = escapeHtml(card.card_name);
  const imgUrl = getCardImageUrl(card);
  const colorJp = COLOR_JP[card.color] || card.color;
  const traitsStr = (card.traits || []).join('、');

  let html = '<div style="background:var(--bg-card);border:1px solid var(--border);border-radius:8px;padding:16px;margin-bottom:16px">\n';
  html += '  <div style="display:flex;gap:16px;align-items:flex-start">\n';
  // カード画像
  html += '    <div style="flex-shrink:0;width:120px">\n';
  html += `      <img src="${imgUrl}" alt="${name}" style="width:120px;border-radius:6px;border:1px solid var(--border)" onerror="this.style.display=\'none\'">\n`;
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
- 効果テキスト（原文）: ${card.effect||'不明'}

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

【禁止表現 - 使用厳禁】
注目すべき、最も注目すべきは、徹底解析、一挙公開、秘めています、秘めた、バラエティ豊かな、
洗練させつつ、新しい風を吹き込む、待ち遠しいですね、爆発力を秘めています、幅広い可能性、
徹底、必見、一挙、速報レビュー

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

// === 新カード記事の完全なHTML組み立て ===
function assembleCardArticleHtml(introHtml, cardInfoList, cardAnalyses, relatedCards, tweetUrls) {
  let html = '';

  // 1. 導入文（Claude生成パート）
  html += introHtml + '\n';

  // 2. カードブロック × N枚（画像+ステータス+考察をセットで表示）
  for (const card of cardInfoList) {
    const analysis = cardAnalyses[card.card_number] || '';
    html += buildCardBlockHtml(card, analysis);
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
          cardInfoList = await recognizeCard(tweet.images);
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
      introHtml = await generateIntroText(allCardInfos, uniqueRelated.slice(0, 5), articleDate);
    } catch (e) {
      log(`導入文生成失敗: ${e.message}`);
      introHtml = `<p>GD04 Phantom Ariaから新カード${cardCount}枚が公開されました。</p>`;
    }

    // Claude APIでカードごとの考察を生成
    let cardAnalyses = {};
    try {
      cardAnalyses = await generateCardAnalyses(allCardInfos, uniqueRelated.slice(0, 5));
    } catch (e) {
      log(`考察生成失敗: ${e.message}`);
    }

    // 完全なHTML組み立て（カードブロック+関連カードリンクは自動生成）
    const articleHtml = assembleCardArticleHtml(introHtml, allCardInfos, cardAnalyses, uniqueRelated.slice(0, 5), tweetUrls);

    const title = `【${dateLbl}公開】GD04 Phantom Aria 新カード${cardCount}枚まとめ`;
    const desc = `ガンダムカードゲームGD04 Phantom Ariaから公開された新カード${cardCount}枚の紹介と環境考察。`;
    const pageHtml = generateNewsPage(date, title, desc, articleHtml, { displayDate: articleDate.replace(/-/g, '.') });
    const filePath = path.join(NEWS_DIR, `${date}.html`);
    fs.writeFileSync(filePath, pageHtml, { encoding: 'utf-8' });
    log(`記事保存: ${filePath}`);

    // X投稿
    const articleUrl = `${SITE_URL}/reports/news/${date}.html`;
    const cardNames = allCardInfos.map(c => c.card_name).join('、');
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

  saveLastCheck();
  log('=== auto-news 完了 ===');
}

main().catch(e => {
  log(`致命的エラー: ${e.message}`);
  console.error(e);
  process.exit(1);
});
