// === GCG STATS 認識・記事生成 共通モジュール ===
// 指示書34 で auto-news.js から切り出し、循環依存を解消(2026-05-16)
// 利用者: auto-news.js / scripts/manual-card-news.js / scripts/batch-recognize.js
//
// 移植元: auto-news.js
// 移植原則: 関数本体は 1 行も変更しない(完全コピー)
//
// 注意: dotenv は呼び出し元(auto-news.js / manual-card-news.js)で
//       require('dotenv').config({...}) 済みの前提

const fs = require('fs');
const path = require('path');
const https = require('https');
const sharp = require('sharp');

// === パス・定数 ===
const ROOT = process.env.NEWS_OUTPUT_ROOT || path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(ROOT, 'data');
const LOG_FILE = path.join(DATA_DIR, 'auto-news-log.txt');
const CARDS_PREVIEW_FILE = path.join(DATA_DIR, 'cards_preview.json');

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_MODEL_SONNET = 'claude-sonnet-4-20250514';
const ANTHROPIC_MODEL_OPUS = 'claude-opus-4-20250514';

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const GOOGLE_CLOUD_API_KEY = process.env.GOOGLE_CLOUD_API_KEY;

const COLOR_JP = { Blue: '青', Red: '赤', Green: '緑', White: '白', Purple: '紫' };
const VALID_CARD_TYPES = ['UNIT', 'PILOT', 'COMMAND', 'BASE'];

// === Vision API 使用量管理 ===
const VISION_USAGE_FILE = path.join(DATA_DIR, 'vision-api-usage.json');
const VISION_MONTHLY_LIMIT = 1000; // 無料枠上限

// === JST ユーティリティ ===
function toJST(date) {
  const d = date instanceof Date ? date : new Date(date);
  return new Date(d.getTime() + 9 * 60 * 60 * 1000);
}
function nowJST() {
  return toJST(new Date());
}
function formatJST(date) {
  const d = toJST(date);
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' JST';
}
function dateStrJST(date) {
  const d = toJST(date);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

function getVisionUsage() {
  try {
    const data = JSON.parse(fs.readFileSync(VISION_USAGE_FILE, 'utf-8'));
    const currentMonth = dateStrJST(new Date()).slice(0, 7); // "2026-04" (JST)
    if (data.month === currentMonth) return data;
    // 月が変わったらリセット
    return { month: currentMonth, count: 0 };
  } catch (e) {
    return { month: dateStrJST(new Date()).slice(0, 7), count: 0 };
  }
}

function incrementVisionUsage(n = 1) {
  const usage = getVisionUsage();
  usage.count += n;
  fs.writeFileSync(VISION_USAGE_FILE, JSON.stringify(usage, null, 2), 'utf-8');
  return usage;
}

function isVisionQuotaAvailable(needed = 1) {
  const usage = getVisionUsage();
  if (usage.count + needed > VISION_MONTHLY_LIMIT) {
    log(`  [Vision API] 月間上限に達しています (${usage.count}/${VISION_MONTHLY_LIMIT})。従来パイプラインにフォールバックします。`);
    return false;
  }
  return true;
}

// === ユーティリティ ===
function now() {
  const d = nowJST();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} JST`;
}

function escapeHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function stripTags(s) { return s.replace(/<[^>]*>/g, ''); }

function log(msg) {
  const line = `[${now()}] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n', { encoding: 'utf-8' });
}

// === Claude API ===
function callClaude(messages, maxTokens, model, systemPrompt) {
  if (!ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY が設定されていません');
  maxTokens = maxTokens || 2000;
  model = model || ANTHROPIC_MODEL_SONNET;
  const payload = {
    model: model,
    max_tokens: maxTokens,
    messages: messages
  };
  if (systemPrompt) payload.system = systemPrompt;
  const body = JSON.stringify(payload);

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

// === Vision API (Step1-A: TEXT_DETECTION 旧版、auto-news.js 由来) ===
function callVisionAI(base64Image) {
  if (!GOOGLE_CLOUD_API_KEY) throw new Error('GOOGLE_CLOUD_API_KEY が設定されていません');
  const url = `https://vision.googleapis.com/v1/images:annotate?key=${GOOGLE_CLOUD_API_KEY}`;
  const payload = {
    requests: [{
      image: { content: base64Image },
      features: [{ type: 'TEXT_DETECTION', maxResults: 1 }]
    }]
  };
  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const req = https.request({
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        if (res.statusCode === 200) resolve(data);
        else reject(new Error(`Vision API ${res.statusCode}: ${JSON.stringify(data)}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// カードID後処理: Vision AIが GD04 を G004 と誤読するケースを修正
function fixCardId(rawId) {
  if (!rawId) return rawId;
  return rawId.replace(/^G0(\d{2})-/, 'GD$1-');
}

// レアリティ後処理: アイコン誤認識の「O」や末尾数字を除去
function cleanRarity(raw) {
  if (!raw) return null;
  let cleaned = raw.replace(/O$/i, '');
  cleaned = cleaned.replace(/\d+$/, '');
  const valid = ['LR', 'SR', 'R', 'U', 'C'];
  return valid.includes(cleaned) ? cleaned : (valid.includes(raw) ? raw : null);
}

// === 座標ベース Vision AI パーサー ===
// 公式X画像（1040x720）のカード領域レイアウトに基づく

// boundingBox → {left, top, right, bottom, centerX, centerY}
function getBounds(boundingBox) {
  const vs = boundingBox.vertices;
  const xs = vs.map(v => v.x || 0);
  const ys = vs.map(v => v.y || 0);
  const left = Math.min(...xs), top = Math.min(...ys);
  const right = Math.max(...xs), bottom = Math.max(...ys);
  return { left, top, right, bottom, centerX: (left + right) / 2, centerY: (top + bottom) / 2 };
}

// fullTextAnnotation の全ワードをフラット化（座標付き）
function flattenWords(fullTextAnnotation) {
  const words = [];
  const page = fullTextAnnotation?.pages?.[0];
  if (!page) return words;
  for (const block of (page.blocks || [])) {
    for (const para of (block.paragraphs || [])) {
      for (const word of (para.words || [])) {
        const text = word.symbols.map(s => s.text).join('');
        const b = getBounds(word.boundingBox);
        words.push({ text, ...b });
      }
    }
  }
  return words;
}

// ゾーン内のワードを収集してテキスト結合
function wordsInZone(words, zone) {
  return words.filter(w =>
    w.centerX >= zone.x1 && w.centerX <= zone.x2 &&
    w.centerY >= zone.y1 && w.centerY <= zone.y2
  );
}

function zoneText(words, zone) {
  const zw = wordsInZone(words, zone);
  // y座標→x座標でソート（行優先）
  zw.sort((a, b) => {
    const dy = a.top - b.top;
    return Math.abs(dy) < 8 ? a.left - b.left : dy;
  });
  return zw.map(w => w.text).join('');
}

function zoneTextSpaced(words, zone) {
  const zw = wordsInZone(words, zone);
  zw.sort((a, b) => {
    const dy = a.top - b.top;
    return Math.abs(dy) < 8 ? a.left - b.left : dy;
  });
  // 行ごとにグループ化
  const lines = [];
  let currentLine = [];
  let lastY = -100;
  for (const w of zw) {
    if (Math.abs(w.top - lastY) > 8) {
      if (currentLine.length > 0) lines.push(currentLine.map(w => w.text).join(''));
      currentLine = [];
    }
    currentLine.push(w);
    lastY = w.top;
  }
  if (currentLine.length > 0) lines.push(currentLine.map(w => w.text).join(''));
  return lines.join('\n');
}

// カード領域のゾーン定義（公式X画像 1040x720 基準）
const CARD_ZONES = {
  // カードID + レアリティ: 右上
  cardId:   { x1: 800, y1: 85, x2: 930, y2: 130 },
  // Lv: 左上のLv表示（"Lv" ワードを検索して数値を取得）
  lv:       { x1: 535, y1: 85, x2: 600, y2: 135 },
  // Cost: Lvの下〜COSTラベルの間
  cost:     { x1: 535, y1: 130, x2: 600, y2: 190 },
  // カードタイプ: 縦書き（UNIT/PILOT/COMMAND）
  cardType: { x1: 530, y1: 270, x2: 560, y2: 345 },
  // カード名: UNIT系（y430-465）
  nameUnit: { x1: 555, y1: 420, x2: 860, y2: 475 },
  // カード名: PILOT/COMMAND系（y505-535, x835未満で+1+1を除外）
  namePilot:{ x1: 555, y1: 495, x2: 835, y2: 535 },
  // 効果テキスト: カード名の下の広い範囲
  effectUnit:  { x1: 550, y1: 470, x2: 895, y2: 570 },
  effectPilot: { x1: 550, y1: 445, x2: 895, y2: 595 },
  // 地形: 宇宙/地球アイコン
  terrain:  { x1: 560, y1: 565, x2: 680, y2: 600 },
  // 特徴: (CB)(トリニティ) 等
  traits:   { x1: 550, y1: 590, x2: 835, y2: 620 },
  // AP/HP（UNIT用）: 右下の大きな数字
  apHp:     { x1: 835, y1: 590, x2: 920, y2: 645 },
  // AP/HP（PILOT用）: カード名の右横（+1+1 等）
  apHpPilot:{ x1: 835, y1: 505, x2: 920, y2: 545 },
  // リンク条件: 最下部
  link:     { x1: 555, y1: 615, x2: 835, y2: 645 },
  // PILOT特徴: カード名の下（UNIT系とは位置が異なる）
  traitsPilot: { x1: 550, y1: 530, x2: 835, y2: 555 },
};

// fullTextAnnotation から座標ベースでカード情報を抽出
function parseVisionBlocks(visionResponse) {
  const fta = visionResponse.responses?.[0]?.fullTextAnnotation;
  if (!fta) return null;

  const words = flattenWords(fta);
  // カード領域外（x < 480）のワードを除外（左半分はバナー情報）
  const cardWords = words.filter(w => w.left >= 480 || w.right >= 520);

  const result = {
    card_number: null, card_name: null, rarity: null, card_type: null,
    level: null, cost: null, ap: null, hp: null,
    terrain: [], traits: [], link: '', effect: ''
  };

  // --- カードID + レアリティ ---
  const idZoneWords = wordsInZone(words, CARD_ZONES.cardId);
  idZoneWords.sort((a, b) => a.left - b.left);
  for (const w of idZoneWords) {
    // "GD04-108C" のようにID+レアリティが1ワードに結合されるケースに対応
    const mergedM = w.text.match(/(G[D0]?\d{2}-\d{3})([A-Z]{1,3}\d?)$/);
    if (mergedM) {
      result.card_number = fixCardId(mergedM[1]);
      result.rarity = cleanRarity(mergedM[2]);
    } else {
      const idM = w.text.match(/G[D0]?\d{2}-\d{3}/);
      if (idM) result.card_number = fixCardId(idM[0]);
      else if (result.card_number && /^[A-Z]{1,3}\d?$/.test(w.text)) {
        result.rarity = cleanRarity(w.text);
      }
    }
  }

  // --- カードタイプ ---
  const typeText = zoneText(cardWords, CARD_ZONES.cardType);
  const typeMatch = typeText.match(/(UNIT|PILOT|COMMAND|BASE)/i);
  if (typeMatch) result.card_type = typeMatch[1].toUpperCase();

  // --- Lv ---
  const lvZoneWords = wordsInZone(cardWords, CARD_ZONES.lv);
  for (const w of lvZoneWords) {
    // "Lv.9" のように結合されているケース
    const lvMatch = w.text.match(/Lv\.?(\d+)/i);
    if (lvMatch) { result.level = parseInt(lvMatch[1]); break; }
  }
  if (result.level === null) {
    // "Lv" と数字が別ワードのケース: "Lv" "." "4"
    const hasLv = lvZoneWords.some(w => /^Lv/i.test(w.text));
    if (hasLv) {
      const numWords = lvZoneWords.filter(w => /^\d+$/.test(w.text) && w.text.length === 1);
      if (numWords.length > 0) result.level = parseInt(numWords[0].text);
    }
  }

  // --- Cost ---
  // COSTラベルの近傍（y130-190）で数字ワードを探す
  // Vision AIがLv+Costを結合した2桁数字を出力するケースに対応
  const costZoneWords = wordsInZone(cardWords, CARD_ZONES.cost);
  const costDigitWords = costZoneWords.filter(w => /^\d+$/.test(w.text));
  if (costDigitWords.length > 0) {
    // 単独の数字ワードがあればそれがCost
    const singleDigit = costDigitWords.find(w => w.text.length === 1);
    if (singleDigit) {
      result.cost = parseInt(singleDigit.text);
    } else {
      // 2桁以上の場合: Lvが既知なら先頭を除去
      const merged = costDigitWords[0].text;
      if (result.level !== null && merged.startsWith(String(result.level))) {
        const costStr = merged.slice(String(result.level).length);
        if (costStr.length > 0) result.cost = parseInt(costStr);
      } else {
        // Lv不明 or 先頭不一致 → 最後の文字をCostとして試行
        result.cost = parseInt(merged.slice(-1));
      }
    }
  }
  // Lv+Costが1つのワードとして lv ゾーンに入っている場合のフォールバック
  if (result.cost === null && result.level !== null) {
    const lvAllDigits = wordsInZone(cardWords, { x1: 535, y1: 85, x2: 600, y2: 190 })
      .filter(w => /^\d{2,}$/.test(w.text));
    for (const w of lvAllDigits) {
      if (w.text.startsWith(String(result.level))) {
        const costStr = w.text.slice(String(result.level).length);
        if (costStr.length > 0) { result.cost = parseInt(costStr); break; }
      }
    }
  }

  // --- カード名 ---
  // UNIT: nameUnit ゾーン（y420-475）
  // PILOT: namePilot ゾーン（y495-535）
  // COMMAND: 拡張ゾーン（y420-490, COMMANDカード名はy=478付近）
  // BASE: nameUnit ゾーンと同じ（y420-475）
  const nameZone = result.card_type === 'PILOT' ? CARD_ZONES.namePilot
    : result.card_type === 'COMMAND' ? { x1: 555, y1: 420, x2: 860, y2: 490 }
    : result.card_type === 'BASE' ? CARD_ZONES.nameUnit
    : CARD_ZONES.nameUnit;
  let nameText = zoneText(cardWords, nameZone);
  // 「」で囲まれたカード名から「」を除去（COMMANDカードの「地球の魔女」等）
  if (nameText) nameText = nameText.replace(/^「/, '').replace(/」$/, '');
  // 型番（NW-002等）やノイズを除外
  if (nameText && !/^[A-Z]{2,3}-\d+$/.test(nameText)) {
    result.card_name = nameText.replace(/[A-Z]{2,3}-\d{3}$/, '').trim();
  }
  // PILOTでユニット名ゾーンにもフォールバック
  if (!result.card_name && result.card_type === 'PILOT') {
    const fallback = zoneText(cardWords, CARD_ZONES.nameUnit);
    if (fallback && !/^[A-Z]{2,3}-\d+$/.test(fallback)) {
      result.card_name = fallback.replace(/[A-Z]{2,3}-\d{3}$/, '').trim();
    }
  }

  // --- 効果テキスト ---
  // UNIT: effectUnit（y470-570）
  // PILOT: effectPilot（y445-595）
  // COMMAND: effectCommand（y490-570, カード名の下から）
  // BASE: effectUnit（y470-570, UNITと同ゾーン）
  let effectZone;
  if (result.card_type === 'PILOT') effectZone = CARD_ZONES.effectPilot;
  else if (result.card_type === 'COMMAND') effectZone = { x1: 550, y1: 490, x2: 895, y2: 570 };
  else if (result.card_type === 'BASE') effectZone = CARD_ZONES.effectUnit;
  else effectZone = CARD_ZONES.effectUnit;
  const effectLines = zoneTextSpaced(cardWords, effectZone);
  if (effectLines) {
    // カード名と同じテキストが含まれていたら除去
    let cleaned = effectLines;
    if (result.card_name) {
      cleaned = cleaned.split('\n')
        .filter(line => !line.includes(result.card_name.replace(/\s/g, '')))
        .join('\n');
    }
    // 型番行を除去
    cleaned = cleaned.split('\n')
      .filter(line => !/^[A-Z]{2,3}-\d{3}$/.test(line.trim()))
      .join('\n');
    result.effect = cleaned.trim();
  }

  // --- 地形 ---
  const terrainText = zoneText(cardWords, CARD_ZONES.terrain);
  if (/宇宙/.test(terrainText)) result.terrain.push('宇宙');
  if (/地球/.test(terrainText)) result.terrain.push('地球');

  // --- 特徴 ---
  // UNIT: traits ゾーン（y590-620）
  // PILOT: traitsPilot ゾーン（y530-555）
  // COMMAND: link ゾーン付近（y615-640, パイロット欄の下に特徴がある）
  // BASE: traits ゾーン（y590-620, UNITと同ゾーン）
  let traitZone;
  if (result.card_type === 'PILOT') traitZone = CARD_ZONES.traitsPilot;
  else if (result.card_type === 'COMMAND') traitZone = CARD_ZONES.link; // COMMANDの特徴はlinkゾーン位置
  else if (result.card_type === 'BASE') traitZone = CARD_ZONES.traits;
  else traitZone = CARD_ZONES.traits;
  const traitZoneWords = wordsInZone(cardWords, traitZone);
  // フォールバック: 通常のtraitsゾーンも検索
  if (traitZoneWords.length === 0) {
    traitZoneWords.push(...wordsInZone(cardWords, CARD_ZONES.traits));
  }
  traitZoneWords.sort((a, b) => a.left - b.left);
  const traitText = traitZoneWords.map(w => w.text).join('');
  // ()や〔〕で囲まれた特徴名を抽出
  const traitMatches = traitText.match(/[〔(]([^〕)]+)[〕)]/g);
  if (traitMatches) {
    result.traits = [...new Set(traitMatches.map(m => m.replace(/^\((.+)\)$/, '〔$1〕')))];
  }

  // --- AP/HP ---
  if (result.card_type === 'UNIT') {
    // UNIT: 右下の大きな数字 "34" → AP=3, HP=4
    const apHpText = zoneText(cardWords, CARD_ZONES.apHp);
    const digits = apHpText.replace(/[^0-9]/g, '');
    if (digits.length >= 2) {
      result.ap = parseInt(digits.slice(0, -1)) || parseInt(digits[0]);
      result.hp = parseInt(digits.slice(-1));
    }
  } else if (result.card_type === 'PILOT') {
    // PILOT: カード名の右横 "+1+1" 等（専用ゾーン）
    const pilotStatText = zoneText(cardWords, CARD_ZONES.apHpPilot);
    const plusMatch = pilotStatText.match(/\+(\d+).*\+(\d+)/);
    if (plusMatch) {
      result.ap = parseInt(plusMatch[1]);
      result.hp = parseInt(plusMatch[2]);
    }
  } else if (result.card_type === 'BASE') {
    // BASE: 指示書37c(2026-05-17、松岡さん視認 EB01-090: AP=0, HP=4)で AP 必須化。
    //       UNIT と同じパターンで AP/HP 抽出。AP は基本 0 だが値として保持する
    //       (null ではなく 0 を出力)。
    //       例: EB01-090 "04" → AP=0, HP=4 / ST10-016 "05" → AP=0, HP=5
    //       2026-05-24 旧仕様「BASE: HPのみ（APなし）」から修正
    //       (auto-news.js / manual-card-news.js は 2026-05-24 commit 4cd3b40 で対応済)
    const apHpText = zoneText(cardWords, CARD_ZONES.apHp);
    const digits = apHpText.replace(/[^0-9]/g, '');
    if (digits.length >= 2) {
      // 2桁以上: UNIT と同パターン (slice(0,-1) で AP, slice(-1) で HP)
      // "04" の場合 parseInt("0")=0、0 || parseInt(digits[0])=0 で AP=0 として正しく動作
      result.ap = parseInt(digits.slice(0, -1)) || parseInt(digits[0]);
      result.hp = parseInt(digits.slice(-1));
    } else if (digits.length === 1) {
      // 1桁のみ取得: HP のみとして扱う(AP は null のまま、Step 3 マルチモーダル等で補完)
      result.hp = parseInt(digits);
    }
  }

  // --- リンク条件 ---
  if (result.card_type !== 'COMMAND') {
    // UNIT/PILOT: linkゾーンからリンク条件を取得
    const linkText = zoneTextSpaced(cardWords, CARD_ZONES.link);
    if (linkText) {
      const linkContent = linkText.replace(/^特徴/, '').trim();
      result.link = linkContent;
    }
  }
  // COMMANDカード: パイロット欄（y575-615）から【パイロット】情報を取得
  if (result.card_type === 'COMMAND') {
    const pilotZoneText = zoneTextSpaced(cardWords, { x1: 550, y1: 575, x2: 835, y2: 615 });
    if (pilotZoneText) {
      result.link = '【パイロット】「' + pilotZoneText + '」';
    }
  }

  return result;
}

async function step1A_visionOCR(imageBase64List) {
  const results = [];
  for (const { base64 } of imageBase64List) {
    try {
      const visionResponse = await callVisionAI(base64);
      const fta = visionResponse.responses?.[0]?.fullTextAnnotation;
      if (fta) {
        const textLen = fta.text?.length || 0;
        log(`  [Step1-A] Vision AI OCR完了 (${textLen}文字, 座標ベースパース)`);
        results.push(parseVisionBlocks(visionResponse));
      } else {
        log('  [Step1-A] Vision AI: テキスト検出なし');
        results.push(null);
      }
    } catch (e) {
      log(`  [Step1-A] Vision AI エラー: ${e.message}`);
      results.push(null);
    }
  }
  return results;
}

// --- Step1-B: ピクセルベース色判定（sharpのみ、コスト0円） ---

// 公式X画像（1040x720）のコスト丸アイコン位置（固定座標）
const COLOR_CROP = { left: 550, top: 130, width: 40, height: 50 };

// RGB値から属性色を判定
// 判定順序が重要: 白→緑→青→赤→紫→Unknown
function classifyColor(r, g, b) {
  // 白: R,G,B全て180以上かつ差が30以内
  if (r > 180 && g > 180 && b > 180 && Math.max(r, g, b) - Math.min(r, g, b) < 30) {
    return 'White';
  }
  // 緑: Gが最大 & G > 130 & Rより30以上大きい
  if (g > r && g > b && g > 130 && (g - r) > 30) {
    return 'Green';
  }
  // 青: Bが最大 & B > 130 & R < 120
  if (b > r && b > g && b > 130 && r < 120) {
    return 'Blue';
  }
  // 赤: Rが最大 & R > 150（紫より先に判定。赤はRが圧倒的に大きい）
  if (r > g && r > b && r > 150) {
    return 'Red';
  }
  // 紫: Bが最大 & R > 100 & G < R（赤の後に判定）
  if (b > g && b > 100 && r > 100 && g < r) {
    return 'Purple';
  }
  // フォールバック: 判定不能
  return 'Unknown';
}

// 画像バッファからコスト丸アイコンの平均RGB値を取得して色判定
// 2026-05-24 追加: context (card_number, source 等) を受け取り、
// data/color-classification-log.jsonl に永続化する(将来の classifyColor 閾値調整用)。
// context は省略可能。書込み失敗は警告のみで認識処理は続行(品質保証)。
async function detectCardColor(imageBuffer, context = {}) {
  const { data, info } = await sharp(imageBuffer)
    .extract(COLOR_CROP)
    .raw()
    .toBuffer({ resolveWithObject: true });

  let r = 0, g = 0, b = 0;
  const pixels = info.width * info.height;
  for (let i = 0; i < data.length; i += info.channels) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
  }
  r = Math.round(r / pixels);
  g = Math.round(g / pixels);
  b = Math.round(b / pixels);

  const color = classifyColor(r, g, b);
  log(`  [Step1-B] ピクセル色判定: RGB(${r},${g},${b}) → ${color}`);
  if (color === 'Unknown') {
    log(`  [Step1-B] ⚠ 色判定不能: RGB(${r},${g},${b}) — 要手動確認`);
  }

  // RGB ログ JSONL 永続化 (2026-05-24 追加)
  // 目的: 将来の classifyColor 閾値調整のため、全色判定結果を data/ に蓄積。
  // Unknown だけでなく成功例も保存して、誤判定検出時の前後比較を可能にする。
  try {
    // spread 順序: context を先に置き、timestamp/rgb/color を後で書く。
    // これにより context 側のキーが timestamp/rgb/color を誤上書きできない(防衛的)。
    const logEntry = {
      ...context, // card_number, source 等(呼び出し側が渡せば付与)
      timestamp: new Date().toISOString(),
      rgb: { r, g, b },
      color,
    };
    const logPath = path.join(DATA_DIR, 'color-classification-log.jsonl');
    fs.appendFileSync(logPath, JSON.stringify(logEntry) + '\n', 'utf-8');
  } catch (e) {
    log(`  [Step1-B] ⚠ color-classification-log.jsonl 書込み失敗: ${e.message}`);
  }

  return { color, rgb: { r, g, b } };
}

// 複数画像の色判定（base64リストから）
async function step1B_pixelColorDetection(imageBase64List) {
  const results = [];
  for (const { base64 } of imageBase64List) {
    try {
      const imageBuffer = Buffer.from(base64, 'base64');
      const { color } = await detectCardColor(imageBuffer);
      results.push(color);
    } catch (e) {
      log(`  [Step1-B] ピクセル色判定エラー: ${e.message}`);
      results.push('Unknown');
    }
  }
  return results;
}

// --- Step1-C: マージ＋後処理 ---

// カッコ修正: ルールベースで自動修正
function fixBrackets(text) {
  if (!text) return text;

  // キーワード能力 → 《》
  const keywords = ['制圧', '突破\\d?', '援護\\d?', 'ブロッカー', '先制攻撃', '高機動', 'リペア\\d?', 'クイック'];
  for (const kw of keywords) {
    text = text.replace(new RegExp(`[【〔「]\\s*(${kw})\\s*[】〕」]`, 'g'), '《$1》');
  }

  // 効果タイミング → 【】
  const timings = [
    '配備時', 'アタック時', '破壊時', 'セット時', 'セット中',
    'リンク時', 'リンク中', '起動', 'メイン', 'アクション',
    'バースト', 'ターン1回', 'パイロット'
  ];
  for (const tm of timings) {
    text = text.replace(new RegExp(`[《〔「]\\s*(${tm})\\s*[》〕」]`, 'g'), '【$1】');
  }

  // 所属・特徴名 → 〔〕（「」【】《》()からの変換）
  const traits = [
    'CB', 'トリニティ', '鉄華団', 'ソレスタルビーイング', 'ネオ・ジオン',
    '地球連邦', 'ティターンズ', 'エゥーゴ', 'ジオン', 'デラーズ・フリート',
    'ザフト', 'オーブ', 'ロンド・ベル', 'アーガマ隊', 'WB隊',
    'リガ・ミリティア', 'シャッフル同盟', 'Gの鉄血', 'Gのレコンギスタ',
    'SEED', '超大国群', '国連', 'シャングリラの少年',
    'ミネルバ隊', '学園', 'フォルドの夜明け',
    'ミリシャ', '艦船'
  ];
  for (const tr of traits) {
    text = text.replace(new RegExp(`[「【《]\\s*(${tr})\\s*[」】》]`, 'g'), '〔$1〕');
    // ()で囲まれている場合もある（Vision AIがカッコを丸カッコで読むケース）
    text = text.replace(new RegExp(`\\(${tr}\\)`, 'g'), `〔${tr}〕`);
  }

  // 「バースト」は必ず【バースト】（《バースト》は誤り）
  text = text.replace(/《バースト》/g, '【バースト】');

  return text;
}

// 【】を持たないタイミングキーワードに自動付与
function autoAddBrackets(text) {
  if (!text) return text;
  const keywords = ['バースト', '配備時', 'ターン1回', '起動', 'メイン', 'アタック時', 'リンク時'];
  let result = text;
  for (const kw of keywords) {
    // 既に【】があれば無視、なければ付与
    const re = new RegExp(`(?<!【[^】]{0,20})${kw}(?![^【]*】)`, 'g');
    result = result.replace(re, `【${kw}】`);
  }
  return result;
}

// Step1-C: Vision AIの文字 + ピクセルの色 → 完成JSON
function step1C_merge(visionResult, color) {
  if (!visionResult) return null;

  // 色を設定
  visionResult.color = color || visionResult.color || null;

  // カッコ修正
  visionResult.effect = fixBrackets(visionResult.effect);
  visionResult.effect = autoAddBrackets(visionResult.effect);

  // 特徴のカッコ修正
  if (visionResult.traits) {
    visionResult.traits = visionResult.traits.map(t => {
      // 「トリニティ」→ 〔トリニティ〕
      return t.replace(/^「(.+)」$/, '〔$1〕');
    });
  }

  // レアリティ修正
  if (visionResult.rarity) {
    visionResult.rarity = cleanRarity(visionResult.rarity);
  }

  return visionResult;
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

// === cards_preview.json: 仮データ管理 ===

function loadCardsPreview() {
  try {
    return JSON.parse(fs.readFileSync(CARDS_PREVIEW_FILE, 'utf-8'));
  } catch (e) { return {}; }
}

/**
 * cards_master.json と cards_preview.json を統合した検索用DBを構築
 * cards_master のエントリを正規化して cards_preview と同じフィールド構造にする
 * 同じIDがある場合は cards_master を優先（正式データ優先）
 * @returns {Object} card_number → { card_number, card_name, color, card_type, level, cost, ap, hp, traits, link, preview }
 */
function buildUnifiedCardDB(cardsMaster) {
  const db = {};

  // 1. cards_preview.json（仮データ）を先に読み込み
  const preview = loadCardsPreview();
  for (const [id, p] of Object.entries(preview)) {
    db[id] = {
      card_number: p.card_number,
      name_jp: p.card_name,
      color: p.color,
      card_type: p.card_type,
      level: p.level,
      cost: p.cost,
      traits: p.traits || [],
      stats: { ap: p.ap, hp: p.hp },
      link: p.link,
      preview: true
    };
  }

  // 2. cards_master.json（正式データ）で上書き → 正式データ優先
  for (const [id, m] of Object.entries(cardsMaster || {})) {
    db[id] = {
      card_number: id,
      name_jp: m.name_jp,
      color: m.color,
      card_type: m.card_type,
      level: m.level,
      cost: m.cost,
      traits: m.traits || [],
      stats: m.stats || {},
      link: m.link,
      source_title: m.source_title,
      preview: false
    };
  }

  return db;
}

// === 記事生成: 導入文 ===
async function generateIntroText(cardInfoList, relatedCards, articleDate) {
  const cardsDesc = cardInfoList.map(c => {
    const colorJp = COLOR_JP[c.color] || c.color;
    // expansion フィールドと release_date と link を含める(改造指示書29 で追加)
    const expansionInfo = c.expansion ? ` [${c.expansion}]` : '';
    const releaseInfo = c.release_date ? ` 発売: ${c.release_date}` : '';
    const linkInfo = c.link ? ` リンク: ${c.link}` : '';
    return `- ${c.card_name} (${c.card_number})${expansionInfo}: ${colorJp}/${c.card_type}${linkInfo}${releaseInfo}`;
  }).join('\n');

  const prompt = `あなたはガンダムカードゲーム（GCG）の環境分析レポーターです。
以下の新カード情報に基づいて、カード紹介記事の「導入文」だけを書いてください。

【出力形式】
- HTML形式で <p> タグ1つだけ
- 2〜3行程度。カード枚数と収録パック名に触れる
- 日付は不要

【セット名・拡張パック名のルール(2026-05-14 改造指示書29 で追加)】
- セット名は認識データの【expansion】フィールド(例: EB01, ST10, GD04)を使用すること
- 公式拡張名との対応例:
  * EB01 → Eternal Nexus(エターナル ネクサス)
  * ST10 → Generation Pulse(ジェネレーション パルス)
  * GD04 → Phantom Aria(ファントム アリア)
- **重要**: カード名内の括弧表記(EX, 能力解放, サンダーボルト版, ジージェネ等)は
  カードのバリアント情報であり、拡張パック名として使用しないこと
- 認識データに含まれない情報(機体の世界観背景、原作設定等)を記事に含めないこと

【「EX」サフィックスのルール(2026-05-14 改造指示書29 で追加)】
- カード名末尾の「(EX)」「(LR)」「(能力解放)」「(サンダーボルト版)」等はバリアント表記
- 「EX」を「EXリソース」と混同しないこと
- 「EX」は単純にカードのバリエーション識別子であり、特定の効果や戦術を示すものではない

【link / release_date の必須記載(2026-05-14 改造指示書29 で追加)】
- 認識データに【link】フィールドが含まれる場合、導入文または記事内で必ず言及すること
- 認識データに【release_date】が含まれる場合、導入文または記事内で必ず言及すること

【推測の厳格禁止(2026-05-14 改造指示書29 で追加)】
- 認識データに含まれない情報(機体の世界観、効果連携、デッキ構築論、色属性ベースの戦術論)を
  記事に含めないこと
- 「青色らしいコントロール向け」「赤色らしいアグロ向け」等の色属性ベースの戦術論は禁止
- 「既存の○○との連携」「○○系デッキへの影響」等の推測は、認識データに根拠がない場合は禁止
- 「サンダーボルト宙域」「重武装機体」等の原作世界観の補足は禁止
- 不明な点は無理に補完せず、認識データに基づく事実のみを記事化すること

【GCG用語ルール - 厳守】
- カードタイプは UNIT / PILOT / COMMAND / BASE の4種のみ
  「キャラクター」「モビルスーツ」「機動ユニット」は存在しない
- 以下の用語はGCGに存在しない。絶対に使わないこと:
  合体、アップグレード、エース効果、エースパーツ、機動ユニット、Xソリューズ、重大損傷コマンド、
  クイック(2026-05-11 削除)、ペアリング(2026-05-11 削除)、ターン1回(タイミング扱い禁止)
- EXリソースを「Xソリューズ」に変換しないこと
- カードタイプ「PILOT」を「キャラクター」に変換しないこと
- 「捨て札にする」→ GCGでは「トラッシュに置く」が正しい
- 「シールドゾーン」→ 正しくは「シールドエリア」

【GCG キーワード効果(7種類、2026-05-11 松岡さん教示で確定)】
- 《ブロッカー》《制圧》《突破》《援護》《リペア》《先制攻撃》《高機動》のみ
- 上記7種類以外のキーワード効果は存在しない
- 「クイック」「ペアリング」は GCG に存在しないため使用禁止

【GCG タイミングキーワード(10種類、2026-05-11 松岡さん教示で確定)】
- 【配備時】【起動】【アタック時】【アタック中】【破壊時】【セット時】【セット中】
  【リンク時】【リンク中】【バースト】の10種類のみ
- 「ターン1回」「ターン2回」は発動回数指定(タイミングキーワードではない)
- 「配備」(時なし)は存在しない、「配備時」のみが正式

【GCG 戦闘フォーマット(4種類)】
- 通常戦(2人): 標準的な対戦
- チーム戦(2対2): シールドはチーム共有
- バトルロワイヤル(3人以上): 全員が対戦相手
- シールド戦(2人): パック開封のみの特殊フォーマット
- **重要**: 「相手プレイヤーすべて」は多人数戦を想定した表現、1対1限定で解釈しないこと

【禁止表現 - 使用厳禁】
注目すべき、最も注目すべきは、徹底解析、一挙公開、秘めています、秘めた、バラエティ豊かな、
洗練させつつ、新しい風を吹き込む、待ち遠しいですね、爆発力を秘めています、幅広い可能性、
徹底、必見、一挙、速報レビュー

【記事生成の追加ルール】
- 「GUNDAM DYNASTY」という表現は使わない。セット名(認識データから取得)を使うこと
- 「属性」という表現は使わない。GCGでは「色」が正しい表現

【文体】
- プレイヤーが読んで「なるほど」と思える分析を書く
- データに基づいた具体的な表現を使う
- 感想文ではなく分析記事を書く

【新カード情報】
${cardsDesc}

<p>タグのみ出力してください。`;

  log('  導入文生成中 (Claude API, Opus)...');
  // 2026-05-14 改造指示書29: Sonnet → Opus 変更
  return await callClaude([{ role: 'user', content: prompt }], 1000, ANTHROPIC_MODEL_OPUS);
}

// === 記事生成: カードごとの考察 ===
async function generateCardAnalyses(cardInfoList, relatedCards) {
  const analyses = {};

  for (const card of cardInfoList) {
    const colorJp = COLOR_JP[card.color] || card.color;
    const relatedDesc = relatedCards
      .filter(r => r.color === colorJp || r.reason.includes('リンク先') || r.reason.includes('リンク対象') || r.reason.includes('同色'))
      .slice(0, 5)
      .map(r => {
        const previewTag = r.preview ? '【新カード】' : '';
        return `${previewTag}${r.name}(${r.card_id}): ${r.color}系${r.usage_rate > 0 ? 'デッキ内採用率' + r.usage_rate + '%' : '（新カード・採用率未集計）'} — ${r.reason}`;
      })
      .join('\n');

    // expansion, release_date, link を追加(改造指示書29 で追加)
    const expansionInfo = card.expansion ? `(${card.expansion})` : '';
    const releaseInfo = card.release_date ? `発売: ${card.release_date}` : '';
    const linkInfo = card.link ? `リンク: ${card.link}` : 'リンク: なし';

    const prompt = `あなたはガンダムカードゲーム（GCG）の環境分析レポーターです。
以下のカード1枚について、2〜3行の簡潔な考察を書いてください。プレーンテキストのみで出力（HTMLタグ不要）。

【カード情報】
- カード名: ${card.card_name} (${card.card_number}) ${expansionInfo}
- 色: ${colorJp} / タイプ: ${card.card_type}
- Lv.${card.level||'?'}, COST${card.cost||'?'}, AP${card.ap||'?'}/HP${card.hp||'?'}
- 特徴: ${(card.traits||[]).join('、')}
- ${linkInfo}
- ${releaseInfo}
- 効果テキスト(原文): ${card.effect||'効果なし(バニラ)'}

【関連カード(現環境データ)】
${relatedDesc || 'データなし'}

【セット名・拡張パック名のルール(2026-05-14 改造指示書29 で追加)】
- セット名は認識データの【expansion】フィールド(例: EB01, ST10, GD04)を使用
- 公式拡張名対応: EB01→Eternal Nexus, ST10→Generation Pulse, GD04→Phantom Aria
- カード名内の括弧表記(EX, 能力解放, サンダーボルト版等)はバリアント情報、拡張パック名ではない

【「EX」サフィックスのルール】
- カード名末尾の「(EX)」「(LR)」等はバリアント表記、「EXリソース」とは無関係
- 単純にカードのバリエーション識別子であり、特定の効果や戦術を示すものではない

【link / release_date の記載】
- 上記カード情報にリンク情報がある場合、考察文で言及すること
- release_date がある場合、可能なら考察文で言及

【推測の厳格禁止(2026-05-14 改造指示書29 で追加)】
- カード情報に含まれない情報を考察文に含めないこと
- 「青色らしいコントロール向け」等の色属性ベースの戦術論は禁止
- 「既存の○○との連携」「○○系デッキへの影響」等の推測は、関連カードデータに根拠がない場合は禁止
- 原作世界観の補足(機体性能、機体設定等)は禁止

【GCG用語ルール - 厳守】
- カードタイプは UNIT / PILOT / COMMAND / BASE の4種のみ
  「キャラクター」「モビルスーツ」「機動ユニット」は存在しない
- 効果テキストは提供された原文をそのまま引用すること。言い換え・要約・解釈をしない
- 以下の用語はGCGに存在しない。絶対に使わないこと:
  合体、アップグレード、エース効果、エースパーツ、機動ユニット、Xソリューズ、重大損傷コマンド、
  クイック(2026-05-11 削除)、ペアリング(2026-05-11 削除)
- EXリソースを「Xソリューズ」に変換しないこと
- COMMANDカードがPILOT的な役割を持つ場合がある。カードタイプは認識結果のまま使い、考察文でその特性に言及する
- 「捨て札にする」→ GCGでは「トラッシュに置く」が正しい
- 「シールドゾーン」→ 正しくは「シールドエリア」

【GCG キーワード効果(7種類、2026-05-11 松岡さん教示で確定)】
- 《ブロッカー》: アタック対象を自身に変更可能(身代わり)
- 《制圧》: シールドエリアアタック時、通常1枚破壊のところを2枚破壊。ベースがある場合はベースのみ通常アタック
- 《突破(数値)》: バトル勝利時に相手シールドへ数値分ダメージ
- 《援護(数値)》: アクティブのこのユニットをレストにすることで、自分のターン中に指定ユニットのAPを数値分上昇
- 《リペア(数値)》: 自分のターン終了時にユニットを数値分回復
- 《先制攻撃》: 相手より先にダメージ計算
- 《高機動》: シールドエリアアタック時に相手のブロッカー発動を無効化
- **重要**: 上記7種類以外のキーワード効果は存在しない
- 「クイック」「ペアリング」は GCG に存在しないため使用禁止

【GCG タイミングキーワード(10種類)】
- 【配備時】【起動】【アタック時】【アタック中】【破壊時】【セット時】【セット中】
  【リンク時】【リンク中】【バースト】の10種類のみ
- 「ターン1回」「ターン2回」は発動回数指定(タイミングキーワードではない)
- 「配備」(時なし)は存在しない、「配備時」のみが正式

【GCG 戦闘フォーマット(4種類)】
- 通常戦(2人)、チーム戦(2対2)、バトルロワイヤル(3人以上)、シールド戦(2人)
- **重要**: 「相手プレイヤーすべて」は多人数戦想定の表現、1対1限定で解釈しないこと
- 効果テキストの「それぞれ」「すべて」は多人数戦での各プレイヤーごとの処理を想定

【禁止表現 - 使用厳禁】
注目すべき、最も注目すべきは、徹底解析、一挙公開、秘めています、秘めた、バラエティ豊かな、
洗練させつつ、新しい風を吹き込む、待ち遠しいですね、爆発力を秘めています、幅広い可能性、
徹底、必見、一挙、速報レビュー

【記事生成の追加ルール】
- 「GUNDAM DYNASTY」という表現は使わない。セット名(認識データから取得)を使うこと
- 「属性」という表現は使わない。GCGでは「色」が正しい表現
- 効果テキストが空の場合は「効果なし(バニラ)」カードとして扱い、
  ステータスとコスト効率で評価すること。「不明」「評価できない」とは書かない

【考察文の整合性ルール(最重要)】
考察文は効果テキストの内容のみに基づいて書くこと。
効果テキストに記載されていない能力を考察文に含めることは禁止。

禁止パターンの例:
- 効果テキストに「ドロー」がないのに「ドローによるアドバンテージ」と書く
- 効果テキストに「+2000」がないのに「+2000パンプ」と書く
- 効果テキストに「サーチ」がないのに「デッキからサーチ」と書く
- 効果テキストに「破壊」がないのに「破壊する」と書く
- 効果テキストに「EXリソース」がないのに「EXリソース活用」と書く
- 関連カードデータがないのに「○○との連携」「○○系デッキ」と書く

考察文を書いた後、必ず以下の検証を行うこと:
1. 考察文に含まれるすべての能力・効果が、効果テキストに記載されているか確認
2. 効果テキストにない能力が考察文に含まれていたら削除して書き直す
3. 「?」や「不明」がステータス表に含まれていないか確認
4. 「青色らしい」「赤色らしい」等の色属性ベースの戦術論が含まれていないか確認
5. 「サンダーボルト宙域」等の世界観補足が含まれていないか確認

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
- 2〜3行で簡潔に。プレーンテキストのみ出力。

【表記ルール】
記事内で以下の表記を統一すること:
- UNIT → ユニット
- PILOT → パイロット
- COMMAND → コマンド
- BASE → ベース
- COST → コスト
- ただし、カードのステータス表(テーブル内)では英語表記のまま`;

    try {
      log(`  考察生成中 (Opus): ${card.card_name}...`);
      // 2026-05-14 改造指示書29: Sonnet → Opus 変更
      const analysis = await callClaude([{ role: 'user', content: prompt }], 500, ANTHROPIC_MODEL_OPUS);
      analyses[card.card_number] = analysis.replace(/<[^>]*>/g, '').trim();
    } catch (e) {
      log(`  考察生成失敗: ${card.card_name} - ${e.message}`);
      analyses[card.card_number] = '';
    }
    await new Promise(r => setTimeout(r, 500));
  }

  return analyses;
}

// === エクスポート ===
module.exports = {
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
};
