#!/usr/bin/env node
/**
 * generate_cards.js
 * カード個別ページ (cards/{card_id}/index.html) を生成し、sitemap.xml を更新する
 */

const fs = require('fs');
const path = require('path');

// === NTC順位集計統合(指示書 NTC順位集計統合_最終版.md, 2026-05-18 実装、2026-05-19 type ベース対応) ===
// 64名定員NTC大会(results.length>=16)の共起カード集計を TOP4 → TOP8 拡張(松岡さん回答 質問A: 1)。
// 32名定員・他大会は no-op で素通し(R2/R5 厳守)。共起カウントは deck だけ参照するため軽量モード。
// NTC 判定は series.json の type='ntc' を参照(MISSION2/3/4... に自動対応)。
const {
  consolidateNtcRank,
  isTargetEvent: isNtcConsolidationTarget,
  makeIsNtcTypeFromSeriesMap
} = require('./shared/ntc-rank-consolidator');

let SERIES_MAP_FOR_NTC = {};
try {
  SERIES_MAP_FOR_NTC = JSON.parse(
    require('fs').readFileSync(require('path').join(__dirname, 'data', 'series.json'), 'utf-8')
  );
} catch (_) {}
const isNtcType = makeIsNtcTypeFromSeriesMap(SERIES_MAP_FOR_NTC);

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');

// 公式 Q&A データベース (homepage/data/qa_database.json)
// スキーマ: { all: [...], by_card: { cardId: [qaId, ...] }, by_category: {...} }
let qaDatabase = { all: [], by_card: {}, by_category: {} };
try {
  qaDatabase = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'qa_database.json'), 'utf-8'));
  console.log(`  Q&A データベース: ${qaDatabase.total_count || (qaDatabase.all || []).length} 件読み込み`);
} catch (e) {
  console.warn('  ⚠ qa_database.json が見つかりません。Q&A セクションは生成されません。');
}
// Q&A の id → entry 高速参照マップ
const qaById = {};
for (const qa of (qaDatabase.all || [])) {
  if (qa && qa.id) qaById[qa.id] = qa;
}

const CARDS_DIR = path.join(ROOT, 'cards');
const SITE_URL = 'https://gcg-stats.com';

// カードマスターデータ
let cardsMaster = {};
try {
  cardsMaster = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'cards_master.json'), 'utf-8'));
  console.log(`  カードマスター: ${Object.keys(cardsMaster).length} 件読み込み`);
} catch (e) {
  console.warn('  ⚠ cards_master.json が見つかりません。カード名なしで生成します。');
}

// 色の日本語変換
const COLOR_JP = {
  'Blue': '青', 'Green': '緑', 'Red': '赤', 'White': '白', 'Purple': '紫', 'Colorless': '無色'
};

// カードタイプの日本語変換
const TYPE_JP = {
  'UNIT': 'ユニット', 'PILOT': 'パイロット', 'COMMAND': 'コマンド', 'BASE': 'ベース'
};

// レアリティ表示
const RARITY_LABEL = {
  'LR': 'LR', 'R': 'R', 'U': 'U', 'C': 'C',
  'LR+': 'LR+', 'LR++': 'LR++', 'LR+++': 'LR+++',
  'R+': 'R+', 'R++': 'R++',
  'U+': 'U+', 'U++': 'U++',
  'C+': 'C+', 'C++': 'C++'
};

// デッキカラー定義
const DECK_COLORS = {
  Blue:    { hex: '#4488ff', jp: '青', cssClass: 'c-blue' },
  Red:     { hex: '#ff4444', jp: '赤', cssClass: 'c-red' },
  Green:   { hex: '#44cc64', jp: '緑', cssClass: 'c-green' },
  White:   { hex: '#cccccc', jp: '白', cssClass: 'c-white' },
  Purple:  { hex: '#b444ff', jp: '紫', cssClass: 'c-purple' },
  Unknown: { hex: '#888888', jp: '不明', cssClass: '' }
};

function escapeHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

/**
 * カードテキストを装飾付きHTMLに変換
 * XSS対策: escapeHtml 後に span タグ置換
 */
function formatEffectText(text) {
  if (!text) return '';
  let html = escapeHtml(text);
  // 【...】 タイミング → 青
  html = html.replace(/【([^】]+)】/g, '<span class="effect-timing">【$1】</span>');
  // 《...》 キーワード能力 → 緑
  html = html.replace(/《([^》]+)》/g, '<span class="effect-keyword">《$1》</span>');
  // 〔...〕 特徴/種別 → オレンジ
  html = html.replace(/〔([^〕]+)〕/g, '<span class="effect-trait">〔$1〕</span>');
  return html;
}

function renderColorTags(colors) {
  return colors.map(c => {
    const info = DECK_COLORS[c] || DECK_COLORS.Unknown;
    return `<span class="color-tag color-tag-${c.toLowerCase()}">${info.jp}</span>`;
  }).join(' ');
}

function primaryColorHex(colors) {
  if (!colors || colors.length === 0) return '#888';
  return (DECK_COLORS[colors[0]] || DECK_COLORS.Unknown).hex;
}

function rankText(rank) {
  if (rank === 1) return '優勝';
  if (rank === 2) return '準優勝';
  return `${rank}位`;
}

function rankClass(rank) {
  if (rank <= 3) return `rank-${rank}`;
  return '';
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  return dateStr.replace(/-/g, '.');
}

/**
 * linkフィールドを正規化して配列にする
 * linkフィールドは文字列/配列/空のいずれか
 */
function normalizeLink(link) {
  if (!link) return [];
  if (typeof link === 'string') {
    return [link.replace(/^「/, '').replace(/」$/, '')];
  }
  if (Array.isArray(link)) {
    return link.map(l => l.replace(/^「/, '').replace(/」$/, ''));
  }
  return [];
}

/**
 * カードがリンク条件にマッチするか判定
 */
function matchesLinkCondition(card, conditions) {
  for (const condition of conditions) {
    if (!condition.startsWith('特徴') && card.name_jp === condition) {
      return true;
    }
    if (condition.startsWith('特徴〔')) {
      const traitName = condition.replace('特徴〔', '').replace('〕', '');
      if ((card.traits || []).includes(traitName)) {
        return true;
      }
    }
  }
  return false;
}

/**
 * カードのリンク関連カードを検索する
 */
function findLinkedCards(cardId, allCards) {
  const card = allCards[cardId];
  if (!card) return [];

  const results = [];

  if (card.card_type === 'UNIT') {
    const linkConditions = normalizeLink(card.link);
    if (linkConditions.length === 0) return [];

    for (const [id, c] of Object.entries(allCards)) {
      if (id === cardId) continue;

      if (c.card_type === 'PILOT') {
        if (matchesLinkCondition(c, linkConditions)) {
          results.push(c);
        }
      }

      if (c.card_type === 'COMMAND') {
        const effect = c.effect || '';
        if (effect.includes('【パイロット】')) {
          if (matchesLinkCondition(c, linkConditions)) {
            results.push(c);
          }
        }
      }
    }

  } else if (card.card_type === 'PILOT' ||
             (card.card_type === 'COMMAND' && (card.effect || '').includes('【パイロット】'))) {
    const pilotName = card.name_jp;
    const pilotTraits = card.traits || [];

    for (const [id, c] of Object.entries(allCards)) {
      if (id === cardId) continue;
      if (c.card_type !== 'UNIT') continue;

      const unitLinks = normalizeLink(c.link);
      if (unitLinks.length === 0) continue;

      for (const condition of unitLinks) {
        if (!condition.startsWith('特徴') && condition === pilotName) {
          results.push(c);
          break;
        }
        if (condition.startsWith('特徴〔')) {
          const traitName = condition.replace('特徴〔', '').replace('〕', '');
          if (pilotTraits.includes(traitName)) {
            results.push(c);
            break;
          }
        }
      }
    }
  }

  results.sort((a, b) => a.id.localeCompare(b.id));
  // パラレル版を除外（リンク一覧は通常版のみ表示）
  return results.filter(c => !c.id.includes('_p'));
}

/**
 * 同じ base_card_id を持つ他のバージョンを検索
 */
function findOtherVersions(cardId, allCards) {
  const card = allCards[cardId];
  if (!card) return [];

  const baseId = card.base_card_id || cardId;

  const versions = [];
  for (const [id, c] of Object.entries(allCards)) {
    if (id === cardId) continue;
    const otherBaseId = c.base_card_id || id;
    if (otherBaseId === baseId) {
      versions.push({
        id: id,
        name_jp: c.name_jp || id,
        rarity: c.rarity,
        is_parallel: c.is_parallel || false,
        parallel_number: c.parallel_number || null
      });
    }
  }

  // 並び順: 通常版 → _p1 → _p2 ...
  versions.sort((a, b) => {
    if (!a.is_parallel && b.is_parallel) return -1;
    if (a.is_parallel && !b.is_parallel) return 1;
    return (a.parallel_number || 0) - (b.parallel_number || 0);
  });

  return versions;
}

/**
 * 別バージョンセクションのHTML生成
 */
function generateOtherVersionsHtml(cardId, allCards) {
  const versions = findOtherVersions(cardId, allCards);
  if (versions.length === 0) return '';

  const versionsHtml = versions.map(v => {
    const altText = v.is_parallel
      ? `${escapeHtml(v.name_jp)}（パラレル版${v.parallel_number || ''}）`
      : `${escapeHtml(v.name_jp)}（通常版）`;
    return `<a href="../${v.id}/" style="display:flex;flex-direction:column;align-items:center;gap:4px;text-decoration:none;padding:6px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:6px;transition:border-color 0.15s"
                   onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'">
                  <img src="/images/cards/${v.id}.webp" alt="${altText}"
                       style="width:60px;height:84px;border-radius:3px;object-fit:cover;border:1px solid var(--border)"
                       onerror="this.style.display='none'">
                  <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono);text-align:center">${escapeHtml(v.rarity)}</div>
                </a>`;
  }).join('\n');

  return `
        <div style="margin-top:16px;padding:14px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg)">
          <h3 style="font-size:13px;font-family:var(--font-mono);color:var(--text-muted);margin:0 0 10px;text-transform:uppercase;letter-spacing:1px">別バージョン</h3>
          <div style="display:flex;flex-wrap:wrap;gap:10px">
            ${versionsHtml}
          </div>
        </div>`;
}

/**
 * 全カードの共起データを一括計算する（O(N)のデッキ走査で全カード分を計算）
 */
function calcAllCoUsed(eventsData, topN = 8) {
  // decksByCard[cardId] = [deckIndex, deckIndex, ...] — そのカードを含むデッキのインデックス
  const allDecks = [];
  for (const evRaw of Object.values(eventsData.events)) {
    // 64名NTC大会(results.length>=16)のみ「ベスト8(各順位2名)」表記に変換、
    // 集計対象を TOP4→TOP8 に拡張(松岡さん回答 質問A: 1)
    const ev = consolidateNtcRank(evRaw, { isNtcType });
    const rankThreshold = isNtcConsolidationTarget(evRaw, { isNtcType }) ? 8 : 4;
    for (const result of (ev.results || [])) {
      if (result.rank > rankThreshold) continue;
      const cardIds = (result.deck || []).map(c => c.card_id);
      if (cardIds.length > 0) allDecks.push(cardIds);
    }
  }

  // cardId → { coCardId → count }
  const coMap = {};
  const deckCounts = {};

  for (const cardIds of allDecks) {
    for (const cid of cardIds) {
      deckCounts[cid] = (deckCounts[cid] || 0) + 1;
    }
    // 共起カウント
    for (let i = 0; i < cardIds.length; i++) {
      const a = cardIds[i];
      if (!coMap[a]) coMap[a] = {};
      for (let j = 0; j < cardIds.length; j++) {
        if (i === j) continue;
        const b = cardIds[j];
        coMap[a][b] = (coMap[a][b] || 0) + 1;
      }
    }
  }

  // 結果をまとめる
  const result = {};
  for (const [cardId, coCards] of Object.entries(coMap)) {
    const total = deckCounts[cardId] || 1;
    result[cardId] = Object.entries(coCards)
      .map(([cid, count]) => ({
        card_id: cid,
        co_count: count,
        co_rate: parseFloat((count / total * 100).toFixed(1))
      }))
      .sort((a, b) => b.co_count - a.co_count)
      .slice(0, topN);
  }
  return result;
}

function main() {
  console.log('[generate_cards] カード個別ページ生成を開始...');

  const summary = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'summary.json'), 'utf-8'));
  const eventsData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'events.json'), 'utf-8'));

  const cardRanking = summary.card_ranking || [];
  const deckTypes = summary.deck_type_ranking || [];

  // card_ranking をマップ化
  const cardRankingMap = {};
  for (const card of cardRanking) {
    cardRankingMap[card.card_id] = card;
  }

  // 共起データを一括計算
  console.log('  共起データを計算中...');
  const allCoUsed = calcAllCoUsed(eventsData);
  console.log(`  → ${Object.keys(allCoUsed).length} 枚のカードの共起データを計算完了`);

  // 全カードIDリスト: card_ranking + cards_master の和集合
  const allCardIds = new Set([
    ...cardRanking.map(c => c.card_id),
    ...Object.keys(cardsMaster)
  ]);

  console.log(`  大会データあり: ${cardRanking.length} 枚 / マスター: ${Object.keys(cardsMaster).length} 枚 / 合計: ${allCardIds.size} 枚`);

  const generatedCardIds = [];

  // DEBUG mode: 4枚のみ生成（テスト用）
  const DEBUG_IDS = ['GD04-001', 'GD04-001_p1', 'GD04-017_p2', 'GD01-002_p2'];
  const targetCardIds = process.env.DEBUG ? DEBUG_IDS : [...allCardIds];

  for (const cardId of targetCardIds) {
    generatedCardIds.push(cardId);
    const masterCard = cardsMaster[cardId] || null;

    // パラレル版なら base_card_id のデータを参照
    const dataKey = masterCard?.base_card_id || cardId;

    const card = cardRankingMap[dataKey] || null;
    const coUsed = allCoUsed[dataKey] || [];

    // デッキタイプ別採用状況
    const typeUsage = [];
    if (card) {
      for (const dt of deckTypes) {
        const c = (dt.card_ranking || []).find(x => x.card_id === dataKey);
        if (c) {
          typeUsage.push({
            label: dt.label,
            colors: dt.colors,
            deckCount: dt.count,
            adoptionCount: c.decks,
            usageRate: c.usage_rate,
            avgCount: c.avg_count
          });
        }
      }
    }

    // TOP4採用実績(64名NTC大会のみ TOP8 拡張、松岡さん回答 質問A: 1)
    const adoptions = [];
    for (const evRaw of Object.values(eventsData.events)) {
      const ev = consolidateNtcRank(evRaw);
      const rankThreshold = isNtcConsolidationTarget(evRaw) ? 8 : 4;
      for (const result of (ev.results || [])) {
        if (result.rank > rankThreshold) continue;
        const c = (result.deck || []).find(x => x.card_id === dataKey);
        if (c) {
          adoptions.push({
            eventId: ev.event_id,
            date: ev.date,
            store: ev.store,
            player: result.player,
            rank: result.rank,
            count: c.count
          });
        }
      }
    }
    adoptions.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

    const html = generateCardPage(cardId, card, typeUsage, adoptions, summary, masterCard, coUsed);

    const cardDir = path.join(CARDS_DIR, cardId);
    fs.mkdirSync(cardDir, { recursive: true });
    fs.writeFileSync(path.join(cardDir, 'index.html'), html, 'utf-8');
  }

  console.log(`  → ${generatedCardIds.length} ページ生成完了`);

  // sitemap.xml 更新
  updateSitemap(generatedCardIds);
  console.log('  → sitemap.xml 更新完了');
}

function generateCoUsedSection(cardId, coUsed) {
  if (!coUsed || coUsed.length === 0) return '';

  const items = coUsed.map(co => {
    const master = cardsMaster[co.card_id] || {};
    const name = escapeHtml(master.name_jp || co.card_id);
    const rateLevel = co.co_rate >= 80 ? 'high' : co.co_rate >= 50 ? 'mid' : 'low';

    return `
          <a href="../../cards/${co.card_id}/" class="co-card-item" title="${name}" data-rate="${rateLevel}">
            <div class="co-card-image-wrap">
              <img src="../../images/cards/${co.card_id}.webp" alt="${name}" class="co-card-image" loading="lazy"
                onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
              <div class="co-card-fallback" style="display:none"><span>${co.card_id}</span></div>
            </div>
            <div class="co-card-info">
              <div class="co-card-name">${name}</div>
              <div class="co-card-rate"><span class="co-rate-value">${co.co_rate}</span><span class="co-rate-unit">%</span></div>
            </div>
          </a>`;
  }).join('');

  // noscript用テキスト
  const noscriptItems = coUsed.map(co => {
    const master = cardsMaster[co.card_id] || {};
    const name = escapeHtml(master.name_jp || co.card_id);
    return `<li><a href="/cards/${co.card_id}/">${name}（${co.card_id}）- ${co.co_rate}%</a></li>`;
  }).join('\n            ');

  return `
        <details class="collapsible-section mb-32" open>
          <summary class="section-header collapsible-toggle">
            <h2 class="section-title">一緒によく使われるカード</h2>
            <div style="display:flex;align-items:center;gap:8px"><span class="section-badge">TOP${coUsed.length}</span><span class="toggle-icon"></span></div>
          </summary>
          <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px">このカードを採用したデッキで一緒に使われることが多いカードです。</p>
          <div class="co-cards-grid">${items}
          </div>
          <noscript>
            <h3>一緒によく使われるカード</h3>
            <ul>
            ${noscriptItems}
            </ul>
          </noscript>
        </details>`;
}

// SEOテキストセクション生成（A1: カードページ300文字以上確保）
const FEATURE_ICONS = {
  draw: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="13" height="18" rx="2"/><path d="M8 7h5M8 11h5M8 15h3"/></svg>',
  heart: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.29 1.51 4.04 3 5.5l7 7Z"/></svg>',
  destroy: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m6 6 12 12M18 6 6 18"/></svg>',
  bolt: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m13 2-10 12h7v8l10-12h-7z"/></svg>',
  puzzle: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M19.439 7.85c-.049.322.059.648.289.878l1.568 1.568c.47.47.706 1.087.706 1.704s-.235 1.233-.706 1.704l-1.611 1.611a.98.98 0 0 1-.837.276c-.47-.07-.802-.48-.802-.954v-1.74a1.5 1.5 0 0 0-1.5-1.5h-1.5v-1.5a1.5 1.5 0 0 0-1.5-1.5h-1.74c-.474 0-.884-.331-.954-.802a.98.98 0 0 1 .276-.837l1.611-1.611c.471-.471 1.087-.706 1.704-.706s1.233.235 1.704.706l1.568 1.568c.23.23.556.338.878.289l.347-.053c.95-.144 1.86.527 1.86 1.487z"/><path d="M11.25 14.5h-1.5a1.5 1.5 0 0 0-1.5 1.5v1.74c0 .474-.331.884-.802.954a.98.98 0 0 1-.837-.276L5 16.808a2.41 2.41 0 0 1-.706-1.704c0-.617.235-1.233.706-1.704l1.568-1.568a1 1 0 0 0 .289-.878l-.053-.347c-.144-.95.527-1.86 1.487-1.86h1.74"/></svg>',
  flame: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 17c1.5 0 3-1.5 3-3.5 0-2-2-3.5-3.5-3.5C9 10 8 8.5 8 7c0-1.5 1.5-3 1.5-3S15 5 15 11c0 5-4 9-7 9-3 0-7-2-7-7 0-3 1-5 2-7 0 1.5 1.5 4.5 5.5 4.5Z"/></svg>',
  shield: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/></svg>',
  sword: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5"/><line x1="13" y1="19" x2="19" y2="13"/><line x1="16" y1="16" x2="20" y2="20"/></svg>',
  link: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
  tag: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2H2v10l9.29 9.29c.94.94 2.48.94 3.42 0l6.58-6.58c.94-.94.94-2.48 0-3.42L12 2Z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>',
  arrowUp: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 7-7 7 7M12 19V5"/></svg>',
  sparkle: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3-1.91 5.82L4 10.91l5.09 1.09L11.18 18 13 12l5.82-1.91L13 8.09Z"/></svg>',
  flash: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 9-12h-7l1-8z"/></svg>',
  arrows: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 7-4 4 4 4M3 11h12M17 17l4-4-4-4M21 13H9"/></svg>',
};

/**
 * カードの特徴(キーワード能力 + ステータス特性 + 構築上の特性)を抽出する。
 * 案 B(アイコン+短文形式)の特徴サマリーセクションに使用。
 * 返り値: Array<{ icon, color, title, desc }>
 *
 * 検出ソース:
 *  - effect_text 内のキーワード(実データに存在するキーワードのみ採用)
 *  - リンク条件(masterCard.link)
 *  - ステータス値(AP/HP/コスト/レベル)
 *  - 特徴(traits)
 */
function detectCardFeatures(masterCard) {
  if (!masterCard) return [];
  const effectText = masterCard.effect_text || '';
  const ct = masterCard.card_type;
  const ap = (masterCard.stats || {}).ap || 0;
  const hp = (masterCard.stats || {}).hp || 0;
  const cost = masterCard.cost || 0;
  const level = masterCard.level || 0;
  const traits = masterCard.traits || [];
  const features = [];

  // === 1. 効果テキスト内キーワード ===
  // 件数は 2026-05-28 時点で cards_master.json をスキャンして確認済(0 件のキーワードは除外)
  const KEYWORD_MAP = [
    { kw: 'ドロー',     icon: 'draw',    color: '#4d9ff7', title: 'ハンドアドバンテージ獲得', desc: 'ドロー効果で手札を補充できる' },
    { kw: 'リペア',     icon: 'heart',   color: '#34d058', title: '長期戦適性',               desc: '《リペア》でユニットを継続的に回復' },
    { kw: '破壊',       icon: 'destroy', color: '#f44747', title: '除去効果',                 desc: '相手カードの破壊で盤面に干渉できる' },
    { kw: '配備時',     icon: 'bolt',    color: '#d4a029', title: 'テンポ展開',               desc: '【配備時】に効果が誘発し即座にアドバンテージを得る' },
    { kw: 'セット時',   icon: 'puzzle',  color: '#b87aff', title: '起動型シナジー',           desc: '【セット時】にパイロット連携で効果が誘発' },
    { kw: 'ダメージ',   icon: 'flame',   color: '#f44747', title: 'ダメージ付与',             desc: '相手プレイヤーやユニットへ直接ダメージを与えられる' },
    { kw: '高機動',     icon: 'arrows',  color: '#4d9ff7', title: '《高機動》',                desc: 'スタンド状態の相手ユニットからの防御を回避できる' },
    { kw: '制圧',       icon: 'shield',  color: '#d4a029', title: '《制圧》',                  desc: '相手ベースに対しブロックされず通せる' },
    { kw: '援護',       icon: 'shield',  color: '#34d058', title: '《援護》',                  desc: '味方ユニットを身代わりにして防御力を底上げ' },
    { kw: '先制攻撃',   icon: 'sword',   color: '#f44747', title: '《先制攻撃》',              desc: 'アタック宣言側として先にダメージ解決' },
    { kw: '突破',       icon: 'arrowUp', color: '#d4a029', title: '《突破》',                  desc: '撃破時の超過ダメージが相手プレイヤーへ届く' },
    { kw: '覚醒',       icon: 'sparkle', color: '#b87aff', title: '《覚醒》',                  desc: '条件達成で追加効果が解放される' },
    { kw: '開発',       icon: 'tag',     color: '#34d058', title: '《開発》',                  desc: 'トラッシュの〔ジージェネ〕カードを指定枚数除外して追加効果を発動できる(総合ルール13-1-8)' },
  ];
  const seenTitles = new Set();
  for (const def of KEYWORD_MAP) {
    if (effectText.includes(def.kw) && !seenTitles.has(def.title)) {
      features.push({ icon: def.icon, color: def.color, title: def.title, desc: def.desc });
      seenTitles.add(def.title);
    }
  }

  // === 2. リンク条件(UNIT/PILOT) ===
  const linkList = normalizeLink(masterCard.link);
  if (linkList.length > 0 && (ct === 'UNIT' || ct === 'PILOT')) {
    const first = linkList[0];
    let desc;
    if (first.startsWith('特徴〔') || first.startsWith('特徴')) {
      desc = `${first} を持つパイロットとリンク可能`;
    } else if (ct === 'UNIT') {
      desc = `「${first}」とリンクして追加効果を得られる`;
    } else {
      desc = `「${first}」にセットしてリンクを発動可能`;
    }
    features.push({ icon: 'link', color: '#b87aff', title: 'リンク条件あり', desc });
  }

  // === 3. ステータス特性(UNIT のみ) ===
  if (ct === 'UNIT') {
    if (ap >= 4 && hp >= 4) {
      features.push({ icon: 'shield', color: '#34d058', title: '高戦闘力', desc: `AP${ap}/HP${hp} の高水準ステータスで攻守両立` });
    } else if (ap >= 4) {
      features.push({ icon: 'sword', color: '#f44747', title: '高AP', desc: `AP${ap} の攻撃力でアタッカー適性が高い` });
    } else if (hp >= 4) {
      features.push({ icon: 'shield', color: '#34d058', title: '高HP', desc: `HP${hp} の耐久力で壁役として機能` });
    }
    if (cost <= 2 && level <= 3 && level > 0) {
      features.push({ icon: 'flash', color: '#d4a029', title: '軽量コスト', desc: `Lv.${level}・コスト${cost} で序盤から展開できる` });
    }
  }

  // === 4. 特徴シナジー ===
  if (traits.length > 0) {
    const tagText = traits.slice(0, 2).map(t => `〔${t}〕`).join('');
    const descText = traits.length >= 2
      ? `${tagText} を持つカードと組み合わせて特徴シナジーを構築可能`
      : `${tagText} 軸のデッキで採用候補になる`;
    features.push({ icon: 'tag', color: '#8b95a5', title: '特徴シナジー', desc: descText });
  }

  return features;
}

/**
 * 特徴サマリーセクションの HTML を生成する(案 B: アイコン+短文形式)。
 * features.length === 0 の場合は空文字列を返す(セクションごと非表示)。
 */
function buildFeatureSummaryHtml(features) {
  if (!features || features.length === 0) return '';
  // 上限 7 件(縦幅とのバランス)
  const list = features.slice(0, 7);
  const rows = list.map(f => `
        <div style="display:flex;align-items:flex-start;gap:12px">
          <span style="flex-shrink:0;color:${f.color};margin-top:2px;line-height:0">${FEATURE_ICONS[f.icon] || FEATURE_ICONS.sparkle}</span>
          <div style="flex:1;min-width:0">
            <p style="margin:0;font-size:14px;font-weight:600;color:var(--text-primary)">${escapeHtml(f.title)}</p>
            <p style="margin:2px 0 0;font-size:13px;line-height:1.6;color:var(--text-secondary)">${escapeHtml(f.desc)}</p>
          </div>
        </div>`).join('\n');
  return `
      <h3 style="font-size:14px;font-weight:600;margin:0 0 12px;color:var(--text-primary)">このカードの特徴</h3>
      <div style="display:grid;grid-template-columns:1fr;gap:12px;margin-bottom:16px;padding:14px 16px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius-lg)">
${rows}
      </div>`;
}

/**
 * 関連 Q&A セクションの HTML を生成する。
 * - by_card[cardId] に登録された Q&A を表示
 * - パラレル版の場合は base_card_id でも引く
 * - 一件もヒットしない場合はセクションごと非表示
 * - 末尾に公式 FAQ ハブへのリンクを付与
 */
function buildQaSectionHtml(cardId, baseCardId) {
  const byCard = qaDatabase.by_card || {};
  const ids = new Set();
  for (const id of (byCard[cardId] || [])) ids.add(id);
  if (baseCardId && baseCardId !== cardId) {
    for (const id of (byCard[baseCardId] || [])) ids.add(id);
  }
  const qas = Array.from(ids).map(id => qaById[id]).filter(Boolean);
  if (qas.length === 0) return '';

  const items = qas.map(qa => {
    const q = escapeHtml(qa.question || '');
    const a = escapeHtml(qa.answer || '');
    const rawUrl = qa.source_url || '';
    // URL スキーム検証: javascript:/data: 等を排除し https:/http:/相対パスのみ許可
    const isSafeUrl = rawUrl && /^(https?:\/\/|\/)/i.test(rawUrl);
    const linkHtml = isSafeUrl
      ? `<a href="${escapeHtml(rawUrl)}" target="_blank" rel="noopener" style="display:inline-block;margin-top:8px;font-size:12px;color:var(--blue);text-decoration:none">公式ページで確認 →</a>`
      : '';
    return `
        <div style="padding:14px 16px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:8px">
          <div style="display:flex;align-items:flex-start;gap:8px;margin-bottom:8px">
            <span style="flex-shrink:0;font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--accent);background:var(--accent-dim);padding:2px 8px;border-radius:4px;letter-spacing:0.5px">Q</span>
            <p style="margin:0;font-size:14px;line-height:1.7;color:var(--text-primary);font-weight:500">${q}</p>
          </div>
          <div style="display:flex;align-items:flex-start;gap:8px">
            <span style="flex-shrink:0;font-family:var(--font-mono);font-size:12px;font-weight:700;color:var(--blue);background:var(--blue-dim);padding:2px 8px;border-radius:4px;letter-spacing:0.5px">A</span>
            <p style="margin:0;font-size:14px;line-height:1.7;color:var(--text-secondary)">${a}</p>
          </div>
          ${linkHtml}
        </div>`;
  }).join('\n');

  return `
      <h3 style="font-size:14px;font-weight:600;margin:0 0 8px;color:var(--text-primary)">このカードに関する公式 Q&A <span style="font-size:12px;font-weight:400;color:var(--text-muted);margin-left:6px">${qas.length}件</span></h3>
      <p style="font-size:12px;color:var(--text-muted);margin:0 0 12px">バンダイ公式サイトに掲載されている裁定情報です。</p>
      <div style="display:grid;grid-template-columns:1fr;gap:10px;margin-bottom:12px">
${items}
      </div>
      <p style="font-size:13px;margin:0 0 16px"><a href="https://www.gundam-gcg.com/jp/rules/faqs/" target="_blank" rel="noopener" style="color:var(--blue);text-decoration:none">公式 FAQ 一覧を見る →</a></p>`;
}

// SEOテキストセクション生成（A1: カードページ300文字以上確保）
function generateSeoTextSections(cardId, masterCard, cardName, colorJp, typeJp, usageRate, totalAdoptions, wins, avgCount, typeUsage, coUsed, isParallel) {
  if (!masterCard) return '';

  const ct = masterCard.card_type;
  const rarity = masterCard.rarity || '';
  const level = masterCard.level || 0;
  const cost = masterCard.cost || 0;
  const ap = (masterCard.stats && masterCard.stats.ap) || 0;
  const hp = (masterCard.stats && masterCard.stats.hp) || 0;
  const traits = masterCard.traits || [];
  const source = masterCard.source_title || '';
  const setPrefix = cardId.replace(/_p\d+$/, '').replace(/-\d+$/, '');

  // --- 1. このカードの概要 ---
  let overviewParts = [];
  overviewParts.push(`${escapeHtml(cardName)}は${escapeHtml(source ? '「' + source + '」に登場する' : '')}${escapeHtml(colorJp)}の${escapeHtml(typeJp)}カードです。`);

  if (ct === 'UNIT') {
    overviewParts.push(`Lv.${level}・コスト${cost}で、AP${ap}/HP${hp}のステータスを持ちます。`);
    if (traits.length > 0) {
      overviewParts.push(`特徴は「${escapeHtml(traits.join('」「'))}」です。`);
    }
  } else if (ct === 'PILOT') {
    overviewParts.push(`Lv.${level}のパイロットで、AP${ap}を持ちます。`);
    if (traits.length > 0) {
      overviewParts.push(`特徴は「${escapeHtml(traits.join('」「'))}」です。`);
    }
  } else if (ct === 'COMMAND') {
    overviewParts.push(`コスト${cost}のコマンドカードです。`);
  } else if (ct === 'BASE') {
    overviewParts.push(`HP${hp}を持つベースカードです。`);
  }

  if (rarity) {
    overviewParts.push(`レアリティは${escapeHtml(rarity)}で、${escapeHtml(setPrefix)}に収録されています。`);
  }

  const overviewText = overviewParts.join('');

  // --- 2. 採用データからの分析 ---
  let analysisParts = [];
  const rate = parseFloat(usageRate);

  if (isParallel) {
    analysisParts.push(`パラレル版のため、採用率データは通常版と共通で集計されています。`);
  }

  if (rate >= 30) {
    analysisParts.push(`ニュータイプチャレンジ大会での採用率は${usageRate}%と非常に高く、環境を代表するカードの一つです。`);
  } else if (rate >= 10) {
    analysisParts.push(`ニュータイプチャレンジ大会での採用率は${usageRate}%で、多くのプレイヤーに支持されているカードです。`);
  } else if (rate > 0) {
    analysisParts.push(`ニュータイプチャレンジ大会での採用率は${usageRate}%で、特定のデッキタイプで活躍しています。`);
  } else {
    analysisParts.push(`現時点でのニュータイプチャレンジ大会での採用は確認されていません。今後の環境変化で評価が変わる可能性があります。`);
  }

  if (totalAdoptions > 0) {
    analysisParts.push(`合計${totalAdoptions}デッキで採用されており、平均${avgCount}枚で投入されています。`);
  }

  if (wins > 0) {
    analysisParts.push(`優勝デッキでの採用実績が${wins}件あり、トーナメントシーンでの実力が証明されています。`);
  }

  // デッキタイプ別の情報を追加
  if (typeUsage.length > 0) {
    const topType = typeUsage[0];
    const topColors = topType.colors || [];
    const topColorNames = topColors.map(c => (DECK_COLORS[c] || DECK_COLORS.Unknown).jp).join('');
    if (topColorNames) {
      analysisParts.push(`最も採用率が高いデッキタイプは${escapeHtml(topColorNames)}系（${topType.usageRate}%）です。`);
    }
  }

  const analysisText = analysisParts.join('');

  // --- 3. 相性の良いカード ---
  let synergyText = '';
  if (coUsed && coUsed.length > 0) {
    const topCards = coUsed.slice(0, 3);
    const cardNames = topCards.map(co => {
      const m = cardsMaster[co.card_id] || {};
      return escapeHtml(m.name_jp || co.card_id) + '（同時採用率' + co.co_rate + '%）';
    });
    synergyText = `このカードと相性が良く、よく一緒に採用されるカードとして${cardNames.join('、')}などがあります。デッキ構築の参考にしてください。`;
  }

  // --- 4. 公式情報リンクテキスト ---
  const officialText = `${escapeHtml(cardName)}の公式カード情報やルール詳細はBANDAI公式サイトをご確認ください。`;

  // --- 5. 特徴サマリー(案 B) と 関連 Q&A 用データ準備(2026-05-28 改修) ---
  // パラレル版(_pN)は親カードと効果完全同一(memory: gcg-card-id-conventions)のため、
  // 特徴検出・Q&A 抽出は親カード(base_card_id)を参照する。
  const baseCardId = (isParallel && masterCard.base_card_id) ? masterCard.base_card_id : cardId;
  const baseCard = (isParallel && cardsMaster[masterCard.base_card_id]) ? cardsMaster[masterCard.base_card_id] : masterCard;

  // 特徴サマリー(常に親カード基準で検出)
  const features = detectCardFeatures(baseCard);
  const featureSummaryHtml = buildFeatureSummaryHtml(features);

  // Q&A セクション(by_card は通常版 ID で登録されているケースが多いため両方引く)
  const qaHtml = buildQaSectionHtml(cardId, baseCardId);

  // パラレル版バナー(冒頭に明示)
  // base_card_id が undefined のときはバナー自体を表示しない(リンク先 ../undefined/ への遷移を防止)
  let parallelBannerHtml = '';
  if (isParallel && masterCard.base_card_id) {
    const baseName = baseCard.name_jp || masterCard.base_card_id;
    parallelBannerHtml = `
      <div style="display:flex;align-items:center;gap:10px;margin:0 0 16px;padding:10px 14px;background:var(--accent-dim);border:1px solid var(--border-accent);border-radius:8px">
        <span style="font-family:var(--font-mono);font-size:11px;font-weight:700;color:var(--accent);background:var(--bg-card);padding:2px 8px;border-radius:4px;letter-spacing:0.5px">PARALLEL</span>
        <p style="margin:0;font-size:13px;color:var(--text-secondary);line-height:1.6">本カードは <a href="../${escapeHtml(masterCard.base_card_id)}/" style="color:var(--blue);text-decoration:none">${escapeHtml(baseName)}（${escapeHtml(masterCard.base_card_id)}）</a> のパラレル(イラスト違い)版です。効果・ステータス・特徴は完全に同一で、デッキでは合算 4 枚まで投入できます。</p>
      </div>`;
  }

  // 類似カード比較(従来ロジック踏襲。同色・同タイプ・近いコスト/Lv 帯のカードを検索)
  let similarCardsText = '';
  {
    const similarList = [];
    for (const [sid, sc] of Object.entries(cardsMaster)) {
      if (sid === cardId || sid.includes('_p')) continue;
      if (!sc || sc.color !== baseCard.color || sc.card_type !== ct) continue;
      if (ct === 'UNIT' || ct === 'PILOT') {
        if (Math.abs((sc.level || 0) - level) > 1) continue;
      } else {
        if (Math.abs((sc.cost || 0) - cost) > 1) continue;
      }
      similarList.push(sc);
      if (similarList.length >= 5) break;
    }
    if (similarList.length >= 2) {
      const names = similarList.slice(0, 3).map(s => escapeHtml(s.name_jp));
      if (ct === 'UNIT' || ct === 'PILOT') {
        similarCardsText = `${escapeHtml(colorJp)}のLv.${level}帯${escapeHtml(typeJp)}カードとしては${names.join('、')}などが存在します。それぞれ異なる効果を持つため、デッキのコンセプトに合わせた選択が重要です。`;
      } else {
        similarCardsText = `${escapeHtml(colorJp)}のコスト${cost}帯${escapeHtml(typeJp)}カードとしては${names.join('、')}などが存在します。それぞれ異なる効果を持つため、デッキのコンセプトに合わせた選択が重要です。`;
      }
    } else if (similarList.length === 1) {
      similarCardsText = `${escapeHtml(colorJp)}の同レベル帯で近い役割を持つカードとして${escapeHtml(similarList[0].name_jp)}があります。効果やステータスの違いを比較し、デッキに合った方を選択しましょう。`;
    }
  }

  // HTMLセクション組み立て(新構成: 概要 / 大会採用 / 相性 / 特徴サマリー / Q&A / 類似カード)
  // 旧「カードの強み」「運用のヒント」「ガンダムカードゲームについて」は廃止(2026-05-28)
  let html = `
    <section class="seo-text-section" style="margin-top:32px;padding:24px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg)">
      <h2 style="font-size:16px;font-weight:700;margin:0 0 12px;color:var(--text-primary)">${escapeHtml(cardName)}について</h2>${parallelBannerHtml}
      <p style="font-size:14px;line-height:1.8;color:var(--text-secondary);margin:0 0 16px">${overviewText}</p>
      <h3 style="font-size:14px;font-weight:600;margin:0 0 8px;color:var(--text-primary)">大会での採用状況</h3>
      <p style="font-size:14px;line-height:1.8;color:var(--text-secondary);margin:0 0 16px">${analysisText}</p>`;

  if (synergyText) {
    html += `
      <h3 style="font-size:14px;font-weight:600;margin:0 0 8px;color:var(--text-primary)">相性の良いカード</h3>
      <p style="font-size:14px;line-height:1.8;color:var(--text-secondary);margin:0 0 16px">${synergyText}</p>`;
  }

  // 特徴サマリー(案 B: アイコン+短文)
  if (featureSummaryHtml) {
    html += featureSummaryHtml;
  }

  // 関連公式 Q&A
  if (qaHtml) {
    html += qaHtml;
  }

  if (similarCardsText) {
    html += `
      <h3 style="font-size:14px;font-weight:600;margin:0 0 8px;color:var(--text-primary)">類似カード</h3>
      <p style="font-size:14px;line-height:1.8;color:var(--text-secondary);margin:0 0 16px">${similarCardsText}</p>`;
  }

  html += `
      <p style="font-size:13px;line-height:1.6;color:var(--text-muted);margin:0">${officialText}</p>
    </section>`;

  return html;
}

function generateCardPage(cardId, card, typeUsage, adoptions, summary, masterCard, coUsed) {
  const hasData = !!card;
  const decks = hasData ? card.decks : 0;
  const wins = hasData ? card.wins : 0;
  const avgCount = hasData ? card.avg_count : 0;
  const totalDecks = summary.total_decks;

  // パラレル版判定
  const isParallel = masterCard?.is_parallel || false;
  const baseCardId = masterCard?.base_card_id || cardId;

  // デッキタイプ別採用数の合計・総デッキ数の合計
  const totalAdoptions = typeUsage.reduce((sum, tu) => sum + tu.adoptionCount, 0);
  const totalDeckCount = typeUsage.reduce((sum, tu) => sum + tu.deckCount, 0);
  // 全体採用率 = 採用デッキ数合計 ÷ 総デッキ数合計 × 100
  const usageRate = totalDeckCount > 0 ? (totalAdoptions / totalDeckCount * 100).toFixed(1) : '0.0';

  // カード名（マスターデータがあれば使用、なければカードID）
  const cardName = masterCard ? masterCard.name_jp : cardId;
  const colorJp = masterCard ? (COLOR_JP[masterCard.color] || masterCard.color) : '';
  const typeJp = masterCard ? (TYPE_JP[masterCard.card_type] || masterCard.card_type) : '';

  // セット名（パンくず・JSON-LD用）
  const setPrefix = cardId.replace(/_p\d+$/, '').replace(/-\d+$/, '');
  const SET_NAMES = {
    'GD01': 'GD01 機動戦士ガンダム',
    'GD02': 'GD02 交錯する戦場',
    'GD03': 'GD03 覚醒する力',
    'GD04': 'GD04 Phantom Aria',
    'ST01': 'ST01 地球連邦デッキ',
    'ST02': 'ST02 ジオンデッキ',
    'ST03': 'ST03 ラクス・クラインデッキ',
    'ST04': 'ST04 アスラン・ザラデッキ',
    'ST05': 'ST05 ソレスタルビーイングデッキ',
    'ST06': 'ST06 鉄華団デッキ',
    'ST07': 'ST07 アムロ・レイデッキ',
    'ST08': 'ST08 シャア・アズナブルデッキ',
    'ST09': 'ST09 キラ・ヤマトデッキ',
  };
  const setName = SET_NAMES[setPrefix] || setPrefix;

  // 収録弾リンク（パンくず・JSON-LD用）— 第1段階 generate_cardlist.js の getCardSet と同一規則。
  // 正 = masterCard.package_set（取り得る値: GD01-04 / ST01-09 / β / PROMO の15種）。
  // package_set が欠落/空のときのみ ID 由来 setPrefix へフォールバック（_pN・末尾連番除去済み）。
  // cards.html は ?set=<値> を読み、フィルタ箱の data-value（=package_set）と突き合わせる。
  const _packageSet = masterCard && masterCard.package_set;
  const setLinkValue = (_packageSet !== undefined && _packageSet !== null && String(_packageSet).trim() !== '')
    ? String(_packageSet).trim()
    : setPrefix;
  // 表示名対応表（第1段階 SET_DISPLAY_NAMES と同一。現状 PROMO のみ日本語表示「プロモ」）
  const SET_DISPLAY_NAMES = { 'PROMO': 'プロモ' };
  const setLinkLabel = SET_DISPLAY_NAMES[setLinkValue] || setLinkValue;
  // URL は旧 #<set> ではなく ?set=<set>（cards.html の URL パラメータ仕様に一致）。βは encodeURIComponent で安全化。
  const setLinkHref = `cards.html?set=${encodeURIComponent(setLinkValue)}`;

  // リンク関連カード（パラレル版はbase_card_idのリンク先を使う）
  let linkedHtml = '';
  if (masterCard) {
    const linkLookupId = isParallel ? baseCardId : cardId;
    const linkedCards = findLinkedCards(linkLookupId, cardsMaster);
    if (linkedCards.length > 0) {
      const sectionTitle = masterCard.card_type === 'UNIT'
        ? 'リンク対象パイロット'
        : 'リンク対象ユニット';
      const colorMap = { Blue: '#4488ff', Green: '#44cc64', Red: '#ff4444', White: '#cccccc', Purple: '#b444ff' };
      const typeMap = { UNIT: 'ユニット', PILOT: 'パイロット', COMMAND: 'コマンド', BASE: 'ベース' };
      linkedHtml = `
        <div style="margin-top:16px;padding:14px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg)">
          <h3 style="font-size:13px;font-family:var(--font-mono);color:var(--text-muted);margin:0 0 10px;text-transform:uppercase;letter-spacing:1px">${sectionTitle}</h3>
          <div style="display:flex;flex-wrap:wrap;gap:10px">
            ${linkedCards.map(lc => {
              const colorHex = colorMap[lc.color] || '#888';
              const lcTypeJp = typeMap[lc.card_type] || '';
              return `<a href="../${lc.id}/" style="display:flex;align-items:center;gap:8px;text-decoration:none;padding:6px 10px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:6px;transition:border-color 0.15s"
                   onmouseover="this.style.borderColor='var(--accent)'" onmouseout="this.style.borderColor='var(--border)'">
                  <img src="/images/cards/${lc.id}.webp" alt="${escapeHtml(lc.name_jp)}"
                       style="width:36px;height:50px;border-radius:3px;object-fit:cover;border:1px solid var(--border)"
                       onerror="this.style.display='none'">
                  <div>
                    <div style="font-size:13px;font-weight:600;color:var(--text-primary)">${escapeHtml(lc.name_jp)}</div>
                    <div style="font-size:11px;color:var(--text-muted);font-family:var(--font-mono)">${lc.id}
                      <span style="color:${colorHex};margin-left:4px">${lcTypeJp}</span>
                    </div>
                  </div>
                </a>`;
            }).join('\n')}
          </div>
        </div>`;
    }
  }

  // SEO用 description
  let description;
  if (masterCard && isParallel) {
    // 他弾再録パラレルの場合
    if (!cardId.startsWith('GD04-') && masterCard.acquisition_info) {
      description = `${cardName}（${cardId}）は${baseCardId}のパラレル版で、${masterCard.acquisition_info}に再録されました。色:${colorJp} タイプ:${typeJp} レアリティ:${masterCard.rarity} 採用率データは通常版と共通です。`;
    } else {
      description = `${cardName}（${cardId}）は${baseCardId}のパラレル版です。色:${colorJp} タイプ:${typeJp} レアリティ:${masterCard.rarity} 採用率データは通常版と共通です。`;
    }
  } else if (masterCard) {
    description = `${cardName}（${cardId}）のニュータイプチャレンジ大会での採用率は${usageRate}%。${totalAdoptions}デッキで採用されています。色:${colorJp} タイプ:${typeJp}`;
  } else {
    description = `${cardId}のニュータイプチャレンジ大会での採用率は${usageRate}%。${totalAdoptions}デッキで採用されています。`;
  }
  // SEO用 title
  const pageTitle = masterCard
    ? (isParallel
        ? `${cardName}（${cardId}）パラレル版の大会採用率 | GCG STATS`
        : `${cardName}（${cardId}）の大会採用率 | GCG STATS`)
    : `${cardId} の大会採用率・使用デッキ | GCG STATS`;

  // デッキタイプ別テーブル
  let typeTableHtml = '';
  if (typeUsage.length > 0) {
    const rows = typeUsage.map(tu => `
              <tr>
                <td>${renderColorTags(tu.colors)}</td>
                <td class="text-mono">${tu.adoptionCount} / ${tu.deckCount}</td>
                <td>
                  <div class="flex items-center gap-8">
                    <div class="usage-bar-container">
                      <div class="usage-bar" style="width:${tu.usageRate}%;background:${primaryColorHex(tu.colors)}"></div>
                    </div>
                    <span class="usage-rate">${tu.usageRate}%</span>
                  </div>
                </td>
                <td class="text-mono">${tu.avgCount}</td>
              </tr>`).join('');

    typeTableHtml = `
        <details class="collapsible-section mb-32" open>
          <summary class="section-header collapsible-toggle">
            <h2 class="section-title">デッキタイプ別採用状況</h2>
            <span class="toggle-icon"></span>
          </summary>
          <table class="data-table">
            <thead>
              <tr>
                <th>デッキタイプ</th>
                <th style="width:90px">採用数</th>
                <th style="width:180px">採用率</th>
                <th style="width:60px">平均枚数</th>
              </tr>
            </thead>
            <tbody>${rows}
            </tbody>
          </table>
        </details>`;
  }

  // TOP4採用実績テーブル
  let adoptionTableHtml = '';
  const displayAdoptions = adoptions.slice(0, 100);
  if (displayAdoptions.length > 0) {
    const rows = displayAdoptions.map(a => `
              <tr>
                <td class="text-mono" style="color:var(--accent)">${formatDate(a.date)}</td>
                <td><a href="../../events/${a.eventId}.html" style="color:var(--text-primary);text-decoration:none">${escapeHtml(a.store)}</a></td>
                <td>${escapeHtml(a.player)}</td>
                <td class="rank-cell ${rankClass(a.rank)}">${rankText(a.rank)}</td>
                <td class="text-mono">×${a.count}</td>
              </tr>`).join('');

    adoptionTableHtml = `
        <details class="collapsible-section">
          <summary class="section-header collapsible-toggle">
            <h2 class="section-title">TOP4 採用実績</h2>
            <div style="display:flex;align-items:center;gap:8px"><span class="section-badge">${adoptions.length}件</span><span class="toggle-icon"></span></div>
          </summary>
          <table class="data-table">
            <thead>
              <tr>
                <th>日付</th>
                <th>店舗</th>
                <th>プレイヤー</th>
                <th style="width:60px">順位</th>
                <th style="width:60px">枚数</th>
              </tr>
            </thead>
            <tbody>${rows}
            </tbody>
          </table>
          ${adoptions.length > 100 ? '<p style="text-align:center;margin-top:16px;color:var(--text-muted);font-size:13px">最新100件を表示</p>' : ''}
        </details>`;
  } else {
    adoptionTableHtml = `
        <details class="collapsible-section">
          <summary class="section-header collapsible-toggle">
            <h2 class="section-title">TOP4 採用実績</h2>
            <div style="display:flex;align-items:center;gap:8px"><span class="section-badge">0件</span><span class="toggle-icon"></span></div>
          </summary>
          <div style="text-align:center;padding:32px;color:var(--text-muted)">TOP4での採用実績がありません</div>
        </details>`;
  }

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
  <title>${escapeHtml(pageTitle)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <meta property="og:site_name" content="GCG STATS">
  <meta property="og:locale" content="ja_JP">
  <meta property="og:title" content="${escapeHtml(pageTitle)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="${SITE_URL}/cards/${cardId}/">
  <meta property="og:image" content="https://gcg-stats.com/images/cards/${cardId}.webp">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeHtml(pageTitle)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="https://gcg-stats.com/images/cards/${cardId}.webp">
  <link rel="canonical" href="${SITE_URL}/cards/${cardId}/">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      {"@type": "ListItem", "position": 1, "name": "ホーム", "item": "${SITE_URL}/"},
      {"@type": "ListItem", "position": 2, "name": "カード一覧", "item": "${SITE_URL}/cards.html"},
      {"@type": "ListItem", "position": 3, "name": "${escapeHtml(setLinkLabel)}", "item": "${SITE_URL}/${setLinkHref}"},
      {"@type": "ListItem", "position": 4, "name": "${escapeHtml(cardName)}"}
    ]
  }
  </script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="../../css/style.css">
</head>
<body>
  <div id="header"></div>

  <main class="container">
    <nav class="breadcrumb" style="margin-bottom:12px;font-size:12px;color:var(--text-muted);font-family:var(--font-mono)">
      <a href="../../index.html" style="color:var(--text-muted);text-decoration:none" onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--text-muted)'">ホーム</a>
      <span style="margin:0 6px">›</span>
      <a href="../../cards.html" style="color:var(--text-muted);text-decoration:none" onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--text-muted)'">カード一覧</a>
      <span style="margin:0 6px">›</span>
      <a href="../../${setLinkHref}" style="color:var(--text-muted);text-decoration:none" onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--text-muted)'">${escapeHtml(setLinkLabel)}</a>
      <span style="margin:0 6px">›</span>
      <span style="color:var(--text-secondary)">${escapeHtml(cardName)}</span>
    </nav>

    <div style="display:flex;gap:24px;margin-bottom:32px;flex-wrap:wrap;align-items:flex-start">
      <div style="flex-shrink:0">
        <img id="card-img" src="/images/cards/${cardId}.webp" alt="${escapeHtml(cardName)}${isParallel ? '（パラレル版）' : ''}"
             style="width:280px;max-width:100%;border-radius:var(--radius-lg);border:1px solid var(--border);box-shadow:var(--shadow-md);cursor:zoom-in"
             onclick="openLightbox(this.src)"
             onerror="if(!this.dataset.retried){this.dataset.retried='1';this.src='/images/cards/${cardId}.webp?t='+Date.now();}else{this.onerror=null;this.style.display='none';}">
      </div>
      <div style="flex:1;min-width:280px">
        <h1 style="font-family:var(--font-mono);font-size:22px;margin-bottom:4px">${masterCard ? escapeHtml(cardName) : escapeHtml(cardId)}</h1>
        ${masterCard ? `<p style="font-family:var(--font-mono);font-size:13px;color:var(--text-muted);margin:0 0 12px">${escapeHtml(cardId)}</p>` : ''}
        ${masterCard ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">
          <span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-family:var(--font-mono);background:${(DECK_COLORS[masterCard.color] || DECK_COLORS.Unknown).hex}22;color:${(DECK_COLORS[masterCard.color] || DECK_COLORS.Unknown).hex};border:1px solid ${(DECK_COLORS[masterCard.color] || DECK_COLORS.Unknown).hex}44">${escapeHtml(colorJp)}</span>
          <span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-family:var(--font-mono);background:var(--bg-card);color:var(--text-secondary);border:1px solid var(--border)">${escapeHtml(typeJp)}</span>
          <span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-family:var(--font-mono);background:var(--bg-card);color:var(--text-secondary);border:1px solid var(--border)">${escapeHtml(RARITY_LABEL[masterCard.rarity] || masterCard.rarity)}</span>
        </div>
        ${(() => {
          const ct = masterCard.card_type;
          const showAP = ct === 'UNIT' || ct === 'PILOT';
          const showHP = ct === 'UNIT' || ct === 'BASE';
          const showLv = ct === 'UNIT' || ct === 'PILOT';
          const showCost = ct !== 'PILOT';
          const cards = [];
          if (showLv) cards.push('<div class="stat-card card-stat-card"><div class="stat-label">Lv.</div><div class="stat-value">' + (masterCard.level || 0) + '</div></div>');
          if (showCost) cards.push('<div class="stat-card card-stat-card"><div class="stat-label">コスト</div><div class="stat-value">' + (masterCard.cost || 0) + '</div></div>');
          if (showAP) cards.push('<div class="stat-card card-stat-card"><div class="stat-label">AP</div><div class="stat-value" style="color:#ff6b6b">' + ((masterCard.stats && masterCard.stats.ap) || 0) + '</div></div>');
          if (showHP) cards.push('<div class="stat-card card-stat-card"><div class="stat-label">HP</div><div class="stat-value" style="color:#66cc88">' + ((masterCard.stats && masterCard.stats.hp) || 0) + '</div></div>');
          if (cards.length === 0) return '';
          return '<div class="card-stats-grid">' + cards.join('') + '</div>';
        })()}
        ${masterCard.traits && masterCard.traits.length > 0 ? `<p style="font-size:12px;color:var(--text-muted);margin:0 0 4px">特徴: ${escapeHtml(masterCard.traits.join(', '))}</p>` : ''}
        ${masterCard.source_title ? `<p style="font-size:12px;color:var(--text-muted);margin:0 0 8px">作品: ${escapeHtml(masterCard.source_title)}</p>` : ''}
        ${masterCard.acquisition_info ? `<p style="font-size:12px;color:var(--text-muted);margin:0 0 8px">入手情報: ${escapeHtml(masterCard.acquisition_info)}</p>` : ''}
        ${masterCard.effect_text ? `<div class="card-effect-section">
          <div class="card-effect-label">カードテキスト</div>
          <div class="card-effect-text">${formatEffectText(masterCard.effect_text)}</div>
        </div>` : ''}` : ''}
        <a href="https://www.gundam-gcg.com/jp/cards/${isParallel ? 'detail.php?detailSearch=' : 'index.php?freeword='}${cardId}" target="_blank" rel="noopener"
           style="color:var(--blue);font-size:13px;text-decoration:none">
          公式カード情報を見る →
        </a>

        ${linkedHtml}
        ${generateOtherVersionsHtml(cardId, cardsMaster)}

        <div class="stats-grid" style="margin-top:16px">
          <div class="stat-card">
            <div class="stat-label">採用デッキ数</div>
            <div class="stat-value">${totalAdoptions}<span class="unit"> デッキ</span></div>
          </div>
          <div class="stat-card">
            <div class="stat-label">全体採用率</div>
            <div class="stat-value">${usageRate}<span class="unit">%</span></div>
          </div>
          <div class="stat-card">
            <div class="stat-label">優勝デッキ数</div>
            <div class="stat-value">${wins}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">平均採用枚数</div>
            <div class="stat-value">${avgCount}<span class="unit">枚</span></div>
          </div>
        </div>
        ${isParallel ? `<p style="font-size:11px;color:var(--text-muted);margin-top:8px;text-align:right">
          ※採用率データは通常版（<a href="../${baseCardId}/" style="color:var(--accent)">${baseCardId}</a>）と共通です
        </p>` : ''}
      </div>
    </div>

    ${typeTableHtml}
    ${generateCoUsedSection(cardId, coUsed)}
    ${adoptionTableHtml}
    ${generateSeoTextSections(cardId, masterCard, cardName, colorJp, typeJp, usageRate, totalAdoptions, wins, avgCount, typeUsage, coUsed, isParallel)}

    <div id="share-buttons" style="margin-top:24px"></div>
  </main>

  <div id="footer"></div>

  <!-- Lightbox Modal -->
  <div id="lightbox" style="display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:9999;cursor:zoom-out;justify-content:center;align-items:center"
       onclick="closeLightbox()">
    <img id="lightbox-img" src="" alt=""
         style="max-width:90vw;max-height:90vh;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,0.6);object-fit:contain;animation:lbFadeIn 0.2s ease">
    <button onclick="closeLightbox()" style="position:absolute;top:16px;right:20px;background:none;border:none;color:#fff;font-size:32px;cursor:pointer;opacity:0.7;transition:opacity 0.15s;line-height:1" onmouseover="this.style.opacity='1'" onmouseout="this.style.opacity='0.7'">&times;</button>
  </div>
  <style>
    @keyframes lbFadeIn { from { opacity:0; transform:scale(0.92); } to { opacity:1; transform:scale(1); } }
  </style>
  <script>
    function openLightbox(src) {
      var lb = document.getElementById('lightbox');
      document.getElementById('lightbox-img').src = src;
      lb.style.display = 'flex';
      document.body.style.overflow = 'hidden';
    }
    function closeLightbox() {
      document.getElementById('lightbox').style.display = 'none';
      document.body.style.overflow = '';
    }
    document.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') closeLightbox();
    });
  </script>

  <script src="../../js/common.js?v=8"></script>
  <script>
    GCG.init();
    document.getElementById('header').innerHTML = GCG.renderHeader('cards');
    document.getElementById("footer").innerHTML = GCG.renderFooter();
    GCG.renderShareButtons('share-buttons', '${escapeHtml(cardName || cardId)}（${cardId}）${isParallel ? 'パラレル版' : ''}採用率${usageRate}% | GCG STATS');
  </script>
</body>
</html>`;
}

function updateSitemap(cardIds) {
  const now = new Date().toISOString().split('T')[0];

  let xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${SITE_URL}/</loc>
    <changefreq>daily</changefreq>
    <priority>1.0</priority>
    <lastmod>${now}</lastmod>
  </url>
  <url>
    <loc>${SITE_URL}/events.html</loc>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
    <lastmod>${now}</lastmod>
  </url>
  <url>
    <loc>${SITE_URL}/meta.html</loc>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
    <lastmod>${now}</lastmod>
  </url>
  <url>
    <loc>${SITE_URL}/cards.html</loc>
    <changefreq>weekly</changefreq>
    <priority>0.8</priority>
    <lastmod>${now}</lastmod>
  </url>
  <url>
    <loc>${SITE_URL}/privacy.html</loc>
    <changefreq>monthly</changefreq>
    <priority>0.3</priority>
  </url>
  <url>
    <loc>${SITE_URL}/contact.html</loc>
    <changefreq>monthly</changefreq>
    <priority>0.3</priority>
  </url>
`;

  for (const cardId of cardIds) {
    xml += `  <url>
    <loc>${SITE_URL}/cards/${cardId}/</loc>
    <changefreq>weekly</changefreq>
    <priority>0.7</priority>
    <lastmod>${now}</lastmod>
  </url>
`;
  }

  xml += `</urlset>
`;

  fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), xml, 'utf-8');
}

main();
