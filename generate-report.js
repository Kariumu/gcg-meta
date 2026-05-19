#!/usr/bin/env node
/**
 * generate-report.js
 * 週次環境レポート記事を Claude API で生成し、reports/ に保存する
 *
 * 使い方:
 *   ANTHROPIC_API_KEY=sk-... node generate-report.js
 *   ANTHROPIC_API_KEY=sk-... node generate-report.js --week 2026-03-09  # 特定週を指定
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { pushFiles } = require('./git-push');

// === NTC順位集計統合(指示書 NTC順位集計統合_最終版.md, 2026-05-18 実装) ===
// 64名定員NTC大会(results.length >= 16)を「ベスト8(各順位2名)」表記に変換する。
// 32名定員大会・他大会には一切影響を与えない(R2/R5 厳守)。
const { consolidateNtcRank, isTargetEvent: isNtcConsolidationTarget } =
  require('./shared/ntc-rank-consolidator');
const { getDeckColors } = require('./scraper');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const REPORTS_DIR = path.join(ROOT, 'reports');
const SITE_URL = 'https://gcg-stats.com';

// 地域マッピング（日本語名 → URLサフィックス）
const REGIONS = {
  '関東': 'kanto',
  '中部': 'chubu',
  '関西': 'kansai',
  '九州': 'kyushu',
  '東北': 'tohoku',
  '中国': 'chugoku',
  '四国': 'shikoku',
  '北海道': 'hokkaido'
};
const REGION_MIN_EVENTS = 3;

// カードマスター
let cardsMaster = {};
try {
  cardsMaster = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'cards_master.json'), 'utf-8'));
} catch (e) {}

// デッキカラー日本語
const COLOR_JP = { Blue: '青', Red: '赤', Green: '緑', White: '白', Purple: '紫', Black: '黒' };

/**
 * デッキタイプ英語 → 日本語変換  "Blue+Purple" → "青/紫"
 */
function deckTypeToJP(deckType) {
  return deckType.split('+').map(c => COLOR_JP[c.trim()] || c).join('/');
}

/**
 * カードの詳細情報文字列を生成（プロンプト用）
 */
function cardInfoString(cardId) {
  const info = cardsMaster[cardId];
  if (!info) return '';
  const color = COLOR_JP[info.color] || info.color || '?';
  const parts = [color, info.card_type || '?'];
  if (info.level != null) parts.push('Lv' + info.level);
  if (info.cost != null) parts.push('COST' + info.cost);
  if (info.traits && info.traits.length > 0) parts.push('特徴:' + info.traits.join(','));
  return '[' + parts.join('/') + ']';
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(d) {
  return d.replace(/-/g, '.');
}

function cardName(id) {
  const m = cardsMaster[id];
  return m ? m.name_jp + '(' + id + ')' : id;
}

/**
 * 月曜始まりの週を計算
 */
function getWeekMonday(dateStr) {
  const dt = new Date(dateStr + 'T00:00:00');
  const day = dt.getDay(); // 0=Sun
  const diff = (day + 6) % 7; // Mon=0, Tue=1, ... Sun=6
  const mon = new Date(dt);
  mon.setDate(mon.getDate() - diff);
  return mon.toISOString().split('T')[0];
}

function getSunday(mondayStr) {
  const dt = new Date(mondayStr + 'T00:00:00');
  dt.setDate(dt.getDate() + 6);
  return dt.toISOString().split('T')[0];
}

/**
 * 対象週のイベントを抽出
 */
function extractWeeklyEvents(eventsData, mondayStr) {
  const sunday = getSunday(mondayStr);
  const result = [];
  for (const ev of Object.values(eventsData.events)) {
    if (ev.date >= mondayStr && ev.date <= sunday) {
      result.push(ev);
    }
  }
  return result;
}

/**
 * 週次データを集計
 */
function computeWeeklyStats(weekEvents) {
  const deckTypeMap = {};
  const cardCountMap = {};
  const winnerDecks = [];
  let totalDecks = 0;

  for (const evRaw of weekEvents) {
    // NTC 64名定員大会(results.length>=16)のみ順位を「ベスト8(各順位2名)」表記に変換し、
    // top4_colors も新rank=1〜8 用に完全再生成する(getDeckColors を注入)。
    // 32名大会・他大会・他 series_id は no-op で素通し(R2/R5 充足)。
    const ev = consolidateNtcRank(evRaw, { getDeckColors });
    // 64名NTC大会のみ集計対象を TOP4 → TOP8 に拡張(松岡さん回答 追加確認1: B案)
    const rankThreshold = isNtcConsolidationTarget(evRaw) ? 8 : 4;
    for (const r of (ev.results || [])) {
      if (r.rank > rankThreshold) continue;
      totalDecks++;

      // デッキタイプ集計
      const colorEntry = (ev.top4_colors || []).find(tc => tc.rank === r.rank);
      const colors = colorEntry ? colorEntry.colors : null;
      if (colors) {
        const typeKey = colors.map(c => COLOR_JP[c] || c).join('/');
        if (!deckTypeMap[typeKey]) deckTypeMap[typeKey] = { count: 0, wins: 0 };
        deckTypeMap[typeKey].count++;
        if (r.rank === 1) deckTypeMap[typeKey].wins++;
      }

      // カード採用率
      for (const card of (r.deck || [])) {
        if (!cardCountMap[card.card_id]) cardCountMap[card.card_id] = { decks: 0, totalCount: 0 };
        cardCountMap[card.card_id].decks++;
        cardCountMap[card.card_id].totalCount += card.count;
      }

      // 優勝デッキ
      if (r.rank === 1 && r.deck && r.deck.length > 0) {
        winnerDecks.push({
          store: ev.store,
          date: ev.date,
          player: r.player,
          deck: r.deck,
          region: ev.region || ''
        });
      }
    }
  }

  // デッキタイプランキング
  const deckTypeRanking = Object.entries(deckTypeMap)
    .map(([type, d]) => ({
      type,
      count: d.count,
      wins: d.wins,
      share: (d.count / totalDecks * 100).toFixed(1),
      winRate: d.count > 0 ? (d.wins / d.count * 100).toFixed(1) : '0'
    }))
    .sort((a, b) => b.count - a.count);

  // 色別デッキ数を集計（カードの色を含むデッキの母数計算用）
  // NTC順位集計統合(指示書 NTC順位集計統合): 64名NTC のみ変換 + TOP8 拡張
  const colorDeckCount = {};  // { 'Blue': 数, 'Red': 数, ... }
  for (const evRaw of weekEvents) {
    const ev = consolidateNtcRank(evRaw, { getDeckColors });
    const rankThreshold = isNtcConsolidationTarget(evRaw) ? 8 : 4;
    for (const r of (ev.results || [])) {
      if (r.rank > rankThreshold) continue;
      const colorEntry = (ev.top4_colors || []).find(tc => tc.rank === r.rank);
      if (colorEntry && colorEntry.colors) {
        for (const col of colorEntry.colors) {
          colorDeckCount[col] = (colorDeckCount[col] || 0) + 1;
        }
      }
    }
  }

  // カードごとの色別採用数を集計
  // NTC順位集計統合(指示書 NTC順位集計統合): 64名NTC のみ変換 + TOP8 拡張
  const cardColorUsage = {};  // { cardId: { colorDecks: 数 } }
  for (const evRaw of weekEvents) {
    const ev = consolidateNtcRank(evRaw, { getDeckColors });
    const rankThreshold = isNtcConsolidationTarget(evRaw) ? 8 : 4;
    for (const r of (ev.results || [])) {
      if (r.rank > rankThreshold) continue;
      const colorEntry = (ev.top4_colors || []).find(tc => tc.rank === r.rank);
      const deckColors = colorEntry ? colorEntry.colors : [];
      for (const card of (r.deck || [])) {
        if (!cardColorUsage[card.card_id]) cardColorUsage[card.card_id] = { colorDecks: 0 };
        // このカードの色がデッキの色に含まれているか
        const cardColor = cardsMaster[card.card_id] ? cardsMaster[card.card_id].color : null;
        if (cardColor && deckColors.includes(cardColor)) {
          cardColorUsage[card.card_id].colorDecks++;
        }
      }
    }
  }

  // カード採用率ランキング（色別採用率付き）
  const cardRanking = Object.entries(cardCountMap)
    .map(([id, d]) => {
      const cardColor = cardsMaster[id] ? cardsMaster[id].color : null;
      const colorJP = cardColor ? (COLOR_JP[cardColor] || cardColor) : null;
      const colorTotal = cardColor ? (colorDeckCount[cardColor] || 0) : 0;
      const colorUsage = cardColorUsage[id] ? cardColorUsage[id].colorDecks : 0;
      const colorRate = colorTotal > 0 ? (colorUsage / colorTotal * 100).toFixed(1) : null;
      return {
        card_id: id,
        name: cardName(id),
        decks: d.decks,
        rate: (d.decks / totalDecks * 100).toFixed(1),
        avg: (d.totalCount / d.decks).toFixed(1),
        cardColor: colorJP,
        colorRate: colorRate,
        colorTotal: colorTotal,
        colorUsage: colorUsage,
        info: cardInfoString(id)
      };
    })
    .sort((a, b) => b.decks - a.decks)
    .slice(0, 20);

  return { totalDecks, deckTypeRanking, cardRanking, winnerDecks, colorDeckCount };
}

/**
 * Claude API プロンプトを構築
 */
function buildPrompt(mondayStr, sundayStr, weekEvents, stats) {
  let deckTypeText = '';
  for (const dt of stats.deckTypeRanking) {
    deckTypeText += dt.type + ': ' + dt.count + 'デッキ（シェア' + dt.share + '%、優勝' + dt.wins + '回、優勝率' + dt.winRate + '%）\n';
  }

  let winnerText = '';
  for (const w of stats.winnerDecks.slice(0, 10)) {
    winnerText += w.date + ' ' + w.store + '（' + w.region + '）優勝: ' + w.player + '\n';
    winnerText += '  デッキ: ' + w.deck.map(c => cardName(c.card_id) + ' x' + c.count).join(', ') + '\n';
  }

  let cardText = '';
  for (const c of stats.cardRanking) {
    cardText += c.name + ' ' + c.info + '\n';
    cardText += '   全体採用率: ' + c.rate + '%（' + stats.totalDecks + 'デッキ中' + c.decks + 'デッキ）\n';
    if (c.cardColor && c.colorRate) {
      cardText += '   ' + c.cardColor + '系デッキ内採用率: ' + c.colorRate + '%（' + c.colorTotal + '件中' + c.colorUsage + '件）\n';
    }
    cardText += '   平均枚数: ' + c.avg + '枚\n';
  }

  return 'あなたはガンダムカードゲーム（GCG）の環境分析レポーターです。\n' +
    '以下の大会データに基づいて、今週の環境レポート記事を日本語で書いてください。\n\n' +
    '【記事の構成】\n' +
    '1. 今週のサマリー（3〜4行）\n' +
    '   - 開催イベント数、地域の傾向\n' +
    '2. デッキタイプ分布\n' +
    '   - 上位3〜5タイプの特徴と注目ポイント\n' +
    '3. 注目カード\n' +
    '   - 採用率が高いカード、環境を定義するカード\n' +
    '   - 各カードの色情報と色別採用率を正確に反映すること\n' +
    '4. 今週の優勝デッキ紹介（2〜3デッキ）\n' +
    '   - 特徴的な構築やメタ読みがあれば解説\n' +
    '5. 来週に向けて（1〜2行）\n' +
    '   - メタの予想や注目ポイント\n\n' +
    '【厳守ルール】\n' +
    '- デッキタイプ名はすべて日本語で表記すること（例: 青/紫、緑/白、赤/白）\n' +
    '  英語表記（Blue+Purple等）は絶対に使わないこと\n' +
    '- カードの色情報を必ず確認し、そのカードの色に基づいた正確な表現をすること\n' +
    '  例: 青のカード → 「青系デッキの汎用カード」（○） 「色を問わない汎用カード」（×）\n' +
    '  例: 緑のカード → 「緑系デッキのキーカード」（○） 「緑白・赤白系のキーカード」（×、赤白に緑は入らない）\n' +
    '- カードの役割はそのカードの色とデッキタイプ別採用率から判断すること\n' +
    '  「青系デッキ内採用率93%」→ 青系デッキの必須カード\n' +
    '  「全体採用率30%だが赤系デッキ内採用率85%」→ 赤系デッキの核\n' +
    '- 「汎用カード」と表現する場合は「○○系デッキの汎用カード」のように必ず色を付けること\n' +
    '  本当に複数の色のデッキで高い採用率（各色デッキ内50%以上）がある場合のみ「幅広いデッキで採用される」と表現してよい\n' +
    '- 採用率データは「そのカードの色を含むデッキ内での採用率」を優先的に使用すること\n' +
    '- カードIDだけでなくカード名を併記すること\n' +
    '- 数値データ（採用率・優勝率）は正確に引用すること、推測で数値を作らないこと\n' +
    '- 堅すぎず、TCGプレイヤーが読んで面白い文体にすること\n' +
    '- 全体で800〜1200文字程度\n' +
    '- HTML形式で出力すること（<h2>、<p>、<ul>タグを使用）\n' +
    '- <h2>から始めること（<h1>は不要）\n\n' +
    '【記事の文体のお手本】\n' +
    '以下は良い記事の例です。この品質・文体に合わせて書いてください。\n\n' +
    '---\n' +
    '<h2>今週のサマリー</h2>\n' +
    '<p>3/8〜3/15の期間、全国で52件のニュータイプチャレンジが開催されました。\n' +
    '青/紫デッキが依然として最多の31.7%を占め、続いて緑/白（15.9%）、赤/白（12.4%）という順位は先週から変わりません。</p>\n\n' +
    '<h2>注目カード</h2>\n' +
    '<ul>\n' +
    '<li>ガンダム(ST01-001) [青/UNIT] — 青系デッキ内採用率93.4%。青を使うならほぼ必須。先週比+1.2%とじわじわ上昇中。</li>\n' +
    '<li>覚悟の表れ(GD01-100) [青/COMMAND] — 青系デッキの汎用コマンド。採用率は青系内で78.2%と安定。低コストで手札を整えられる堅実な1枚。</li>\n' +
    '</ul>\n' +
    '---\n\n' +
    '【今週のデータ】\n' +
    '期間: ' + formatDate(mondayStr) + ' 〜 ' + formatDate(sundayStr) + '\n' +
    'イベント数: ' + weekEvents.length + '件\n' +
    'TOP4デッキ数: ' + stats.totalDecks + '件\n\n' +
    '【デッキタイプ別集計（今週分）】\n' + deckTypeText + '\n' +
    '【今週の優勝デッキ一覧】\n' + winnerText + '\n' +
    '【カード採用率TOP20（今週分） ※カード属性・色別採用率付き】\n' + cardText;
}

/**
 * Claude API を呼び出す
 */
function callClaudeAPI(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('環境変数 ANTHROPIC_API_KEY が設定されていません。');
  }

  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }]
    });

    const options = {
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'Content-Length': Buffer.byteLength(body)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error('API error ' + res.statusCode + ': ' + data));
          return;
        }
        try {
          const json = JSON.parse(data);
          const text = json.content && json.content[0] && json.content[0].text;
          if (!text) reject(new Error('APIレスポンスにテキストがありません: ' + data));
          else resolve(text);
        } catch (e) {
          reject(new Error('JSONパースエラー: ' + e.message));
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * weekId を生成 (例: "2026-03-week2")
 */
function weekId(mondayStr) {
  const dt = new Date(mondayStr + 'T00:00:00');
  const month = dt.getMonth() + 1;
  const year = dt.getFullYear();
  // 月内の週番号を計算
  const firstOfMonth = new Date(year, dt.getMonth(), 1);
  const firstMonday = new Date(firstOfMonth);
  const dayOfWeek = firstOfMonth.getDay();
  const daysToMonday = (dayOfWeek === 0 ? 1 : (8 - dayOfWeek)) % 7;
  firstMonday.setDate(firstOfMonth.getDate() + daysToMonday);
  if (firstMonday > dt) {
    // この月曜は前月にある
    return year + '-' + String(month).padStart(2, '0') + '-week1';
  }
  const weekNum = Math.floor((dt.getDate() - firstMonday.getDate()) / 7) + 1 + (daysToMonday === 0 ? 0 : 1);
  return year + '-' + String(month).padStart(2, '0') + '-week' + weekNum;
}

/**
 * テキストからHTMLタグを除去
 */
function stripTags(html) {
  return html.replace(/<[^>]+>/g, '').trim();
}

/**
 * カードサムネイルHTML生成（注目カード用）
 */
function renderCardThumbnailHtml(cardId, extraText) {
  const name = cardsMaster[cardId] ? cardsMaster[cardId].name_jp : cardId;
  return '<div style="display:flex;align-items:center;gap:12px;margin:10px 0">' +
    '<a href="../cards/' + cardId + '/" style="flex-shrink:0">' +
    '<img src="../images/cards/' + cardId + '.webp" alt="' + escapeHtml(name) + '"' +
    ' style="width:60px;border-radius:4px;border:1px solid var(--border)"' +
    ' onerror="this.style.display=\'none\'">' +
    '</a>' +
    '<div>' +
    '<a href="../cards/' + cardId + '/" style="font-weight:600;color:var(--text-primary);text-decoration:none">' +
    escapeHtml(name) + '<span style="color:var(--text-muted);font-size:12px;margin-left:4px">' + cardId + '</span></a>' +
    (extraText ? '<div style="font-size:13px;color:var(--text-secondary);margin-top:2px">' + extraText + '</div>' : '') +
    '</div>' +
    '</div>';
}

/**
 * 記事HTML内の注目カードセクションをサムネイル付きに後処理
 * Claude APIの出力やDRY-RUN出力の<li>タグからカードIDを抽出してサムネイル化
 */
function postProcessArticleCards(html, stats) {
  // 注目カードセクション（<h2>注目カード</h2>の後の<ul>...</ul>）を検出
  const regex = /(<h2>[^<]*注目カード[^<]*<\/h2>\s*)<ul>([\s\S]*?)<\/ul>/i;
  const match = html.match(regex);
  if (!match) return html;

  const headerPart = match[1];
  const listContent = match[2];

  // <li>タグ内のカード情報を抽出
  const liRegex = /<li>([\s\S]*?)<\/li>/gi;
  let liMatch;
  const items = [];
  while ((liMatch = liRegex.exec(listContent)) !== null) {
    items.push(liMatch[1]);
  }

  // 各アイテムからカードIDを探してサムネイルHTML化
  let thumbnailHtml = '';
  for (const item of items) {
    // カードIDパターン: GD01-001, ST01-001 など
    const idMatch = item.match(/((?:GD|ST)\d{2}-\d{3}[A-Z]?)/);
    if (idMatch) {
      const cardId = idMatch[1];
      // 元テキストからカードID/名前部分を除いた説明テキストを抽出
      const plainText = stripTags(item);
      // カード名（全角括弧含む）とIDを除去して残りを説明として使う
      let descText = plainText;
      // まずカードマスターから正式名を取得して除去
      const masterName = cardsMaster[cardId] ? cardsMaster[cardId].name_jp : null;
      if (masterName) {
        descText = descText.replace(masterName, '');
      }
      // カードID部分を除去（半角/全角括弧で囲まれている場合も対応）
      descText = descText
        .replace(/[（(]?(?:GD|ST)\d{2}-\d{3}[A-Z]?[）)]?/g, '')
        .replace(/^\s*[:：\-\s]+/, '')
        .trim();
      thumbnailHtml += renderCardThumbnailHtml(cardId, descText);
    } else {
      // カードIDが見つからない場合はそのまま
      thumbnailHtml += '<div style="margin:8px 0;font-size:14px">' + item + '</div>';
    }
  }

  return html.replace(match[0], headerPart + '<div class="card-highlights">' + thumbnailHtml + '</div>');
}

/**
 * レポートHTMLページを生成
 */
function generateReportPage(wId, mondayStr, sundayStr, articleHtml, weekEvents, stats, options) {
  options = options || {};
  const regionLabel = options.regionLabel || '';  // 例: '関東'
  const regionalLinksHtml = options.regionalLinksHtml || '';  // 全国版に追加する地域リンク
  const dateRange = formatDate(mondayStr) + '〜' + formatDate(sundayStr);
  const regionPrefix = regionLabel ? regionLabel + '地域 ' : '';
  const titleText = 'GCG環境レポート ' + regionPrefix + dateRange + ' | GCG STATS';
  const descText = formatDate(mondayStr) + '〜' + formatDate(sundayStr) + 'のガンダムカードゲーム' + regionPrefix + '環境レポート。' + weekEvents.length + 'イベント・' + stats.totalDecks + 'デッキのデータを分析。';
  const seoText = stripTags(articleHtml);

  return '<!DOCTYPE html>\n' +
'<html lang="ja">\n' +
'<head>\n' +
'  <!-- Google Analytics -->\n' +
'  <script async src="https://www.googletagmanager.com/gtag/js?id=G-3MY17P4E7F"></script>\n' +
'  <script>\n' +
'    window.dataLayer = window.dataLayer || [];\n' +
'    function gtag(){dataLayer.push(arguments);}\n' +
'    gtag(\'js\', new Date());\n' +
'    gtag(\'config\', \'G-3MY17P4E7F\');\n' +
'  </script>\n' +
'  <meta charset="UTF-8">\n' +
'  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
'  <title>' + escapeHtml(titleText) + '</title>\n' +
'  <meta name="description" content="' + escapeHtml(descText) + '">\n' +
'  <!-- OGP -->\n' +
'  <meta property="og:site_name" content="GCG STATS">\n' +
'  <meta property="og:locale" content="ja_JP">\n' +
'  <meta property="og:title" content="' + escapeHtml(titleText) + '">\n' +
'  <meta property="og:description" content="' + escapeHtml(descText) + '">\n' +
'  <meta property="og:type" content="article">\n' +
'  <meta property="og:url" content="' + SITE_URL + '/reports/' + wId + '.html">\n' +
'  <meta property="og:image" content="' + SITE_URL + '/images/ogp-default.png">\n' +
'  <meta name="twitter:card" content="summary_large_image">\n' +
'  <meta name="twitter:image" content="' + SITE_URL + '/images/ogp-default.png">\n' +
'  <link rel="canonical" href="' + SITE_URL + '/reports/' + wId + '.html">\n' +
'  <link rel="preconnect" href="https://fonts.googleapis.com">\n' +
'  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">\n' +
'  <link rel="stylesheet" href="../css/style.css">\n' +
'</head>\n' +
'<body>\n' +
'  <div id="header"></div>\n' +
'\n' +
'  <main class="container">\n' +
'    <div style="margin-bottom:12px">\n' +
'      <a href="index.html" style="color:var(--text-muted);text-decoration:none;font-size:13px;transition:color 0.15s"\n' +
'       onmouseover="this.style.color=\'var(--accent)\'" onmouseout="this.style.color=\'var(--text-muted)\'">\n' +
'        \u2190 \u30EC\u30DD\u30FC\u30C8\u4E00\u89A7\u306B\u623B\u308B</a>\n' +
'    </div>\n' +
'    <div class="section-header">\n' +
'      <div>\n' +
'        <h1 class="section-title" style="margin-bottom:6px;font-size:16px">' + (regionLabel ? escapeHtml(regionLabel) + '\u5730\u57DF ' : '') + '\u74B0\u5883\u30EC\u30DD\u30FC\u30C8 ' + dateRange + '</h1>\n' +
'        <div style="font-size:13px;color:var(--text-secondary)">\n' +
'          <span class="text-mono" style="color:var(--accent)">' + weekEvents.length + '\u30A4\u30D9\u30F3\u30C8 / ' + stats.totalDecks + '\u30C7\u30C3\u30AD</span>\n' +
'        </div>\n' +
'      </div>\n' +
'    </div>\n' +
'\n' +
'    <article class="report-article" style="margin-top:24px;line-height:1.8;font-size:14px">\n' +
articleHtml + '\n' +
'    </article>\n' +
(regionalLinksHtml ? '\n' + regionalLinksHtml + '\n' : '') +
'\n' +
'    <div id="share-buttons" style="margin-top:32px"></div>\n' +
'  </main>\n' +
'\n' +
'  <noscript>' + escapeHtml(seoText) + '</noscript>\n' +
'  <div class="seo-content" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap">' + escapeHtml(seoText) + '</div>\n' +
'\n' +
'  <div id="footer"></div>\n' +
'\n' +
'  <script src="../js/common.js?v=5"></script>\n' +
'  <script>\n' +
'    GCG.init();\n' +
'    document.getElementById(\'header\').innerHTML = GCG.renderHeader(\'reports\');\n' +
'    document.getElementById(\'footer\').innerHTML = GCG.renderFooter();\n' +
'    GCG.renderShareButtons(\'share-buttons\', \'' + escapeHtml(titleText).replace(/'/g, "\\'") + '\');\n' +
'  </script>\n' +
'</body>\n' +
'</html>';
}

/**
 * レポート一覧ページを更新
 */
function updateReportIndex() {
  if (!fs.existsSync(REPORTS_DIR)) return;

  // 地域別レポートのサフィックス一覧
  const regionSuffixes = Object.values(REGIONS);
  const files = fs.readdirSync(REPORTS_DIR)
    .filter(f => {
      if (!f.endsWith('.html') || f === 'index.html') return false;
      // 地域別レポート（例: 2026-03-week2-kanto.html）は除外
      const base = f.replace('.html', '');
      for (const suffix of regionSuffixes) {
        if (base.endsWith('-' + suffix)) return false;
      }
      return true;
    })
    .map(f => {
      const filePath = path.join(REPORTS_DIR, f);
      const stat = fs.statSync(filePath);
      return { name: f, mtime: stat.mtime };
    })
    .sort((a, b) => b.mtime - a.mtime) // 更新日時の新しい順
    .map(item => item.name);

  let listHtml = '';
  for (const f of files) {
    const wId = f.replace('.html', '');
    const filePath = path.join(REPORTS_DIR, f);
    const content = fs.readFileSync(filePath, 'utf-8');
    const titleMatch = content.match(/<h1[^>]*>(.*?)<\/h1>/);
    const title = titleMatch ? titleMatch[1] : wId;
    // ファイルの更新日時から投稿日時を取得
    const stat = fs.statSync(filePath);
    const d = stat.mtime;
    const dateStr = d.getFullYear() + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + String(d.getDate()).padStart(2, '0');
    listHtml += '      <a href="' + f + '" class="event-card" style="display:flex;align-items:center;justify-content:space-between;padding:16px 20px">\n' +
      '        <span style="font-size:15px;font-weight:600">' + title + '</span>\n' +
      '        <span style="font-size:12px;color:var(--text-muted);white-space:nowrap;margin-left:16px">' + dateStr + '</span>\n' +
      '      </a>\n';
  }

  if (files.length === 0) {
    listHtml = '      <div style="text-align:center;padding:48px;color:var(--text-muted);font-size:13px">\u30EC\u30DD\u30FC\u30C8\u306F\u307E\u3060\u3042\u308A\u307E\u305B\u3093</div>\n';
  }

  const noscriptLinks = files.map(f => {
    const wId = f.replace('.html', '');
    return '<li><a href="' + f + '">' + wId + '</a></li>';
  }).join('');

  const html = '<!DOCTYPE html>\n' +
'<html lang="ja">\n' +
'<head>\n' +
'  <!-- Google Analytics -->\n' +
'  <script async src="https://www.googletagmanager.com/gtag/js?id=G-3MY17P4E7F"></script>\n' +
'  <script>\n' +
'    window.dataLayer = window.dataLayer || [];\n' +
'    function gtag(){dataLayer.push(arguments);}\n' +
'    gtag(\'js\', new Date());\n' +
'    gtag(\'config\', \'G-3MY17P4E7F\');\n' +
'  </script>\n' +
'  <meta charset="UTF-8">\n' +
'  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
'  <title>\u74B0\u5883\u30EC\u30DD\u30FC\u30C8\u4E00\u89A7 | GCG STATS</title>\n' +
'  <meta name="description" content="\u30AC\u30F3\u30C0\u30E0\u30AB\u30FC\u30C9\u30B2\u30FC\u30E0\u306E\u9031\u6B21\u74B0\u5883\u30EC\u30DD\u30FC\u30C8\u4E00\u89A7\u3002\u30C7\u30C3\u30AD\u30BF\u30A4\u30D7\u5206\u5E03\u3084\u6CE8\u76EE\u30AB\u30FC\u30C9\u306E\u5206\u6790\u3092\u6BCE\u9031\u304A\u5C4A\u3051\u3002">\n' +
'  <!-- OGP -->\n' +
'  <meta property="og:site_name" content="GCG STATS">\n' +
'  <meta property="og:locale" content="ja_JP">\n' +
'  <meta property="og:title" content="\u74B0\u5883\u30EC\u30DD\u30FC\u30C8\u4E00\u89A7 | GCG STATS">\n' +
'  <meta property="og:description" content="\u30AC\u30F3\u30C0\u30E0\u30AB\u30FC\u30C9\u30B2\u30FC\u30E0\u306E\u9031\u6B21\u74B0\u5883\u30EC\u30DD\u30FC\u30C8\u4E00\u89A7">\n' +
'  <meta property="og:type" content="website">\n' +
'  <meta property="og:url" content="' + SITE_URL + '/reports/">\n' +
'  <meta property="og:image" content="' + SITE_URL + '/images/ogp-default.png">\n' +
'  <meta name="twitter:card" content="summary_large_image">\n' +
'  <meta name="twitter:image" content="' + SITE_URL + '/images/ogp-default.png">\n' +
'  <link rel="canonical" href="' + SITE_URL + '/reports/">\n' +
'  <link rel="preconnect" href="https://fonts.googleapis.com">\n' +
'  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">\n' +
'  <link rel="stylesheet" href="../css/style.css">\n' +
'</head>\n' +
'<body>\n' +
'  <div id="header"></div>\n' +
'\n' +
'  <main class="container">\n' +
'    <div class="section-header">\n' +
'      <h1 class="section-title">\u74B0\u5883\u30EC\u30DD\u30FC\u30C8</h1>\n' +
'      <span class="section-badge">' + files.length + '\u4EF6</span>\n' +
'    </div>\n' +
'\n' +
'    <div class="event-list" style="margin-top:20px">\n' +
listHtml +
'    </div>\n' +
'  </main>\n' +
'\n' +
'  <noscript><h2>\u74B0\u5883\u30EC\u30DD\u30FC\u30C8\u4E00\u89A7</h2><ul>' + noscriptLinks + '</ul></noscript>\n' +
'\n' +
'  <div id="footer"></div>\n' +
'\n' +
'  <script src="../js/common.js?v=5"></script>\n' +
'  <script>\n' +
'    GCG.init();\n' +
'    document.getElementById(\'header\').innerHTML = GCG.renderHeader(\'reports\');\n' +
'    document.getElementById(\'footer\').innerHTML = GCG.renderFooter();\n' +
'  </script>\n' +
'</body>\n' +
'</html>';

  fs.writeFileSync(path.join(REPORTS_DIR, 'index.html'), html, 'utf-8');
}

/**
 * sitemap.xml にレポートURLを追加
 */
function updateSitemap() {
  const sitemapPath = path.join(ROOT, 'sitemap.xml');
  if (!fs.existsSync(sitemapPath)) return;

  let xml = fs.readFileSync(sitemapPath, 'utf-8');
  const now = new Date().toISOString().split('T')[0];

  // 既存のレポートURLを削除
  xml = xml.replace(/\s*<url>\s*<loc>https:\/\/gcg-stats\.com\/reports\/[^<]*<\/loc>[\s\S]*?<\/url>/g, '');

  // reports/ のファイル一覧
  const files = fs.readdirSync(REPORTS_DIR)
    .filter(f => f.endsWith('.html'))
    .sort();

  let reportUrls = '';
  for (const f of files) {
    const name = f === 'index.html' ? '' : f;
    const loc = name ? SITE_URL + '/reports/' + name : SITE_URL + '/reports/';
    const priority = name ? '0.5' : '0.7';
    reportUrls += '\n  <url>\n' +
      '    <loc>' + loc + '</loc>\n' +
      '    <changefreq>' + (name ? 'monthly' : 'weekly') + '</changefreq>\n' +
      '    <priority>' + priority + '</priority>\n' +
      '    <lastmod>' + now + '</lastmod>\n' +
      '  </url>';
  }

  // </urlset> の前に挿入
  xml = xml.replace('</urlset>', reportUrls + '\n</urlset>');
  fs.writeFileSync(sitemapPath, xml, 'utf-8');
}

/**
 * DRY-RUN用サンプル記事を生成
 * @param {Array} weekEvents
 * @param {Object} stats
 * @param {string} [regionName] - 地域名（省略時は全国版）
 * @param {Object} [nationalStats] - 全国統計（地域版比較用）
 */
function generateDryRunArticle(weekEvents, stats, regionName, nationalStats) {
  const regionLabel = regionName ? regionName + '地域 ' : '';
  let html = '<h2>今週のサマリー</h2>\n' +
    '<p>' + regionLabel + '今週は' + weekEvents.length + '件のイベントが開催されました。' +
    'TOP4デッキ数は' + stats.totalDecks + '件で、' +
    (stats.deckTypeRanking[0] ? stats.deckTypeRanking[0].type + 'が引き続きトップシェア' : '') +
    'を維持しています。</p>\n';

  if (regionName && nationalStats) {
    html += '<p>全国平均と比較すると、' + regionName + '地域では' +
      (stats.deckTypeRanking[0] ? stats.deckTypeRanking[0].type + 'のシェアが' + stats.deckTypeRanking[0].share + '%' : '') +
      'となっています。</p>\n';
  }

  html += '<h2>デッキタイプ分布</h2>\n' +
    '<ul>\n' +
    stats.deckTypeRanking.slice(0, 5).map(dt =>
      '<li>' + dt.type + ': ' + dt.count + 'デッキ（シェア' + dt.share + '%、優勝率' + dt.winRate + '%）</li>\n'
    ).join('') +
    '</ul>\n' +
    '<h2>注目カード</h2>\n' +
    '<ul>\n' +
    stats.cardRanking.slice(0, 5).map(c => {
      const colorInfo = c.cardColor ? c.cardColor + '系デッキ内採用率' + (c.colorRate || '?') + '%、' : '';
      return '<li>' + c.name + ' ' + c.info + ' — ' + colorInfo + '全体採用率' + c.rate + '%（平均' + c.avg + '枚）</li>\n';
    }).join('') +
    '</ul>\n' +
    '<h2>来週に向けて</h2>\n' +
    '<p>※この記事はDRY-RUNモードで生成されたサンプルです。実際のレポートはClaude APIで生成されます。</p>';

  return html;
}

/**
 * 地域別レポート用のClaude APIプロンプトを構築
 */
function buildRegionalPrompt(mondayStr, sundayStr, regionEvents, regionStats, regionName, nationalStats) {
  let deckTypeText = '';
  for (const dt of regionStats.deckTypeRanking) {
    deckTypeText += dt.type + ': ' + dt.count + 'デッキ（シェア' + dt.share + '%、優勝' + dt.wins + '回、優勝率' + dt.winRate + '%）\n';
  }

  let winnerText = '';
  for (const w of regionStats.winnerDecks.slice(0, 10)) {
    winnerText += w.date + ' ' + w.store + ' 優勝: ' + w.player + '\n';
    winnerText += '  デッキ: ' + w.deck.map(c => cardName(c.card_id) + ' x' + c.count).join(', ') + '\n';
  }

  let cardText = '';
  for (const c of regionStats.cardRanking) {
    cardText += c.name + ' ' + c.info + '\n';
    cardText += '   全体採用率: ' + c.rate + '%（' + regionStats.totalDecks + 'デッキ中' + c.decks + 'デッキ）\n';
    if (c.cardColor && c.colorRate) {
      cardText += '   ' + c.cardColor + '系デッキ内採用率: ' + c.colorRate + '%（' + c.colorTotal + '件中' + c.colorUsage + '件）\n';
    }
    cardText += '   平均枚数: ' + c.avg + '枚\n';
  }

  // 全国統計との比較データ
  let nationalCompare = '';
  for (const dt of nationalStats.deckTypeRanking.slice(0, 5)) {
    nationalCompare += dt.type + ': 全国シェア' + dt.share + '%、優勝率' + dt.winRate + '%\n';
  }

  return 'あなたはガンダムカードゲーム（GCG）の環境分析レポーターです。\n' +
    '以下の大会データに基づいて、' + regionName + '地域の今週の環境レポート記事を日本語で書いてください。\n\n' +
    '【記事の構成】\n' +
    '1. ' + regionName + '地域のサマリー（3〜4行）\n' +
    '   - 開催イベント数、全国との違い\n' +
    '2. デッキタイプ分布\n' +
    '   - 上位3〜5タイプの特徴、全国平均との比較\n' +
    '3. 注目カード\n' +
    '   - ' + regionName + '地域で特に採用率が高いカード\n' +
    '   - 各カードの色情報と色別採用率を正確に反映すること\n' +
    '4. ' + regionName + 'の優勝デッキ紹介（2〜3デッキ）\n' +
    '   - 特徴的な構築やメタ読みがあれば解説\n' +
    '5. 来週に向けて（1〜2行）\n\n' +
    '【厳守ルール】\n' +
    '- デッキタイプ名はすべて日本語で表記すること（例: 青/紫、緑/白、赤/白）\n' +
    '  英語表記（Blue+Purple等）は絶対に使わないこと\n' +
    '- カードの色情報を必ず確認し、そのカードの色に基づいた正確な表現をすること\n' +
    '  例: 青のカード → 「青系デッキの汎用カード」（○） 「色を問わない汎用カード」（×）\n' +
    '  例: 紫のカード → 「紫系デッキのキーカード」（○） 「緑白系のキーカード」（×、紫を含まないデッキに紫カードは属さない）\n' +
    '- カードの役割はそのカードの色とデッキタイプ別採用率から判断すること\n' +
    '- 「汎用カード」と表現する場合は「○○系デッキの汎用カード」のように必ず色を付けること\n' +
    '- 採用率データは「そのカードの色を含むデッキ内での採用率」を優先的に使用すること\n' +
    '- カードIDだけでなくカード名を併記すること\n' +
    '- 全国統計との比較を適宜入れること\n' +
    '- 数値データ（採用率・優勝率）は正確に引用すること、推測で数値を作らないこと\n' +
    '- 堅すぎず、TCGプレイヤーが読んで面白い文体にすること\n' +
    '- HTML形式で出力すること（<h2>、<p>、<ul>タグを使用）\n' +
    '- 全体で600〜900文字程度\n' +
    '- <h2>から始めること（<h1>は不要）\n\n' +
    '【記事の文体のお手本】\n' +
    '以下は良い記事の例です。この品質・文体に合わせて書いてください。\n\n' +
    '---\n' +
    '<h2>関東地域のサマリー</h2>\n' +
    '<p>今週の関東は22件のイベントが開催され、全国71件の約3割を占めました。\n' +
    '青/紫がシェア33.7%でトップですが、全国平均（36.3%）を下回っており、赤/白・緑/白が健闘する多様な環境です。</p>\n\n' +
    '<h2>注目カード</h2>\n' +
    '<ul>\n' +
    '<li>アムロ・レイ(ST01-010) [青/PILOT] — 青系デッキ内採用率89.3%。青を使うならほぼ必須の1枚。</li>\n' +
    '<li>溢れる慈愛(GD01-118) [青/COMMAND] — 青系デッキの汎用コマンド。関東では全国平均を上回る採用率45.8%。</li>\n' +
    '</ul>\n' +
    '---\n\n' +
    '【' + regionName + '地域 今週のデータ】\n' +
    '期間: ' + formatDate(mondayStr) + ' 〜 ' + formatDate(sundayStr) + '\n' +
    'イベント数: ' + regionEvents.length + '件\n' +
    'TOP4デッキ数: ' + regionStats.totalDecks + '件\n\n' +
    '【' + regionName + '地域 デッキタイプ別集計】\n' + deckTypeText + '\n' +
    '【全国 デッキタイプ上位（比較用）】\n' + nationalCompare + '\n' +
    '【' + regionName + '地域 優勝デッキ一覧】\n' + winnerText + '\n' +
    '【' + regionName + '地域 カード採用率TOP20】\n' + cardText;
}

async function main() {
  console.log('=== 環境レポート生成 ===');

  const eventsData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'events.json'), 'utf-8'));

  // 対象週を決定
  let targetMonday;
  const weekArg = process.argv.find((a, i) => process.argv[i - 1] === '--week');
  if (weekArg) {
    targetMonday = getWeekMonday(weekArg);
  } else {
    // 直近の完了した週（前週の月曜日）
    const today = new Date();
    const dayOfWeek = today.getDay();
    const daysBack = ((dayOfWeek + 6) % 7) + 7; // 前週の月曜日まで
    const lastMonday = new Date(today);
    lastMonday.setDate(today.getDate() - daysBack);
    targetMonday = lastMonday.toISOString().split('T')[0];
  }

  const targetSunday = getSunday(targetMonday);
  const wId = weekId(targetMonday);

  console.log('  対象期間: ' + targetMonday + ' 〜 ' + targetSunday);
  console.log('  レポートID: ' + wId);

  // 既存チェック
  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }

  const outputPath = path.join(REPORTS_DIR, wId + '.html');
  if (fs.existsSync(outputPath)) {
    console.log('  ⚠ ' + wId + '.html は既に存在します。スキップします。');
    console.log('  → 上書きする場合は先にファイルを削除してください。');
    return;
  }

  // 週のイベントを抽出
  const weekEvents = extractWeeklyEvents(eventsData, targetMonday);
  if (weekEvents.length === 0) {
    console.log('  ⚠ 対象週のイベントが0件です。レポートを生成しません。');
    return;
  }

  console.log('  イベント数: ' + weekEvents.length + '件');

  // 集計
  const stats = computeWeeklyStats(weekEvents);
  console.log('  TOP4デッキ数: ' + stats.totalDecks + '件');
  console.log('  優勝デッキ数: ' + stats.winnerDecks.length + '件');

  // Claude API でレポート生成
  const prompt = buildPrompt(targetMonday, targetSunday, weekEvents, stats);
  const isDryRun = process.argv.includes('--dry-run');
  let articleHtml;

  if (isDryRun) {
    console.log('  [DRY-RUN] API呼び出しをスキップ。サンプル記事を使用します。');
    articleHtml = generateDryRunArticle(weekEvents, stats);
  } else {
    console.log('  Claude API を呼び出し中...');
    articleHtml = await callClaudeAPI(prompt);
    console.log('  → 記事生成完了（' + articleHtml.length + '文字）');
  }

  // 注目カードセクションをサムネイル付きに後処理
  articleHtml = postProcessArticleCards(articleHtml, stats);

  // --- 地域別レポート生成 ---
  const regionalLinks = [];
  for (const [regionName, regionSuffix] of Object.entries(REGIONS)) {
    const regionEvents = weekEvents.filter(ev => ev.region === regionName);
    if (regionEvents.length < REGION_MIN_EVENTS) continue;

    const regionWId = wId + '-' + regionSuffix;
    const regionOutputPath = path.join(REPORTS_DIR, regionWId + '.html');
    if (fs.existsSync(regionOutputPath)) {
      console.log('  ⚠ ' + regionWId + '.html は既に存在します。スキップ。');
      regionalLinks.push({ name: regionName, suffix: regionSuffix, wId: regionWId });
      continue;
    }

    console.log('  地域別レポート: ' + regionName + '（' + regionEvents.length + 'イベント）');
    const regionStats = computeWeeklyStats(regionEvents);

    let regionArticle;
    if (isDryRun) {
      regionArticle = generateDryRunArticle(regionEvents, regionStats, regionName, stats);
    } else {
      const regionPrompt = buildRegionalPrompt(targetMonday, targetSunday, regionEvents, regionStats, regionName, stats);
      regionArticle = await callClaudeAPI(regionPrompt);
    }
    regionArticle = postProcessArticleCards(regionArticle, regionStats);

    const regionPageHtml = generateReportPage(regionWId, targetMonday, targetSunday, regionArticle, regionEvents, regionStats, { regionLabel: regionName });
    fs.writeFileSync(regionOutputPath, regionPageHtml, 'utf-8');
    console.log('  → ' + regionWId + '.html を保存しました');
    regionalLinks.push({ name: regionName, suffix: regionSuffix, wId: regionWId });
  }

  // 全国レポートに地域別リンクを追加
  let regionalLinksHtml = '';
  if (regionalLinks.length > 0) {
    regionalLinksHtml = '    <div style="margin-top:32px;padding:20px;background:var(--bg-elevated);border-radius:8px;border:1px solid var(--border)">\n' +
      '      <h2 style="font-size:15px;margin:0 0 12px 0">\u5730\u57DF\u5225\u30EC\u30DD\u30FC\u30C8</h2>\n' +
      '      <div style="display:flex;flex-wrap:wrap;gap:8px">\n' +
      regionalLinks.map(r =>
        '        <a href="' + r.wId + '.html" class="btn-link" style="font-size:13px;padding:6px 14px">' + escapeHtml(r.name) + '</a>'
      ).join('\n') + '\n' +
      '      </div>\n' +
      '    </div>';
  }

  // HTMLページを生成（全国版）
  const pageHtml = generateReportPage(wId, targetMonday, targetSunday, articleHtml, weekEvents, stats, { regionalLinksHtml: regionalLinksHtml });
  fs.writeFileSync(outputPath, pageHtml, 'utf-8');
  console.log('  → ' + wId + '.html を保存しました');

  // 一覧ページ更新
  updateReportIndex();
  console.log('  → reports/index.html を更新しました');

  // サイトマップ更新
  updateSitemap();
  console.log('  → sitemap.xml を更新しました');

  // GitHub API経由でpush
  const filesToPush = [
    { path: `reports/${wId}.html`, content: fs.readFileSync(outputPath, 'utf-8') },
    { path: 'reports/index.html', content: fs.readFileSync(path.join(ROOT, 'reports', 'index.html'), 'utf-8') },
    { path: 'sitemap.xml', content: fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf-8') }
  ];
  await pushFiles(filesToPush, `Add weekly report ${wId}`);
}

main().catch(err => {
  console.error('エラー:', err.message);
  process.exit(1);
});
