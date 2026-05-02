#!/usr/bin/env node
/**
 * generate_cards.js
 * カード個別ページ (cards/{card_id}/index.html) を生成し、sitemap.xml を更新する
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
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
  for (const ev of Object.values(eventsData.events)) {
    for (const result of (ev.results || [])) {
      if (result.rank > 4) continue;
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

    // TOP4採用実績
    const adoptions = [];
    for (const ev of Object.values(eventsData.events)) {
      for (const result of (ev.results || [])) {
        if (result.rank > 4) continue;
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
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="../../css/style.css">
</head>
<body>
  <div id="header"></div>

  <main class="container">
    <div style="margin-bottom:12px">
      <a id="back-link" href="../../meta.html" style="color:var(--text-muted);text-decoration:none;font-size:13px;transition:color 0.15s;cursor:pointer"
         onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--text-muted)'">
        ← 戻る
      </a>
    </div>
    <script>
      (function() {
        var params = new URLSearchParams(window.location.search);
        var from = params.get('from');
        var name = params.get('name');
        var el = document.getElementById('back-link');
        if (from === 'event' && name) {
          el.textContent = '\\u2190 ' + decodeURIComponent(name) + 'の結果に戻る';
          el.removeAttribute('href');
          el.onclick = function() { history.back(); };
        } else if (from === 'meta') {
          el.textContent = '\\u2190 環境分析に戻る';
          el.href = '../../meta.html';
        } else if (from === 'top') {
          el.textContent = '\\u2190 トップに戻る';
          el.href = '../../index.html';
        } else if (document.referrer) {
          var ref = document.referrer;
          if (ref.indexOf('/meta.html') !== -1) {
            el.textContent = '\\u2190 環境分析に戻る';
            el.removeAttribute('href');
            el.onclick = function() { history.back(); };
          } else if (ref.indexOf('/event.html') !== -1) {
            el.textContent = '\\u2190 イベント結果に戻る';
            el.removeAttribute('href');
            el.onclick = function() { history.back(); };
          } else if (ref.indexOf('gcg-stats.com') !== -1 && (ref.endsWith('/') || ref.indexOf('/index.html') !== -1)) {
            el.textContent = '\\u2190 トップに戻る';
            el.removeAttribute('href');
            el.onclick = function() { history.back(); };
          } else {
            el.textContent = '\\u2190 戻る';
            el.removeAttribute('href');
            el.onclick = function() { history.back(); };
          }
        } else {
          el.textContent = '\\u2190 戻る';
          el.href = '../../index.html';
        }
      })();
    </script>

    <div style="display:flex;gap:24px;margin-bottom:32px;flex-wrap:wrap">
      <div style="flex-shrink:0">
        <img id="card-img" src="/images/cards/${cardId}.webp" alt="${escapeHtml(cardName)}${isParallel ? '（パラレル版）' : ''}"
             style="width:180px;border-radius:var(--radius-lg);border:1px solid var(--border);box-shadow:var(--shadow-md);cursor:zoom-in"
             onclick="openLightbox(this.src)"
             onerror="if(!this.dataset.retried){this.dataset.retried='1';this.src='/images/cards/${cardId}.webp?t='+Date.now();}else{this.onerror=null;this.style.display='none';}">
      </div>
      <div style="flex:1;min-width:300px">
        <h1 style="font-family:var(--font-mono);font-size:22px;margin-bottom:4px">${masterCard ? escapeHtml(cardName) : escapeHtml(cardId)}</h1>
        ${masterCard ? `<p style="font-family:var(--font-mono);font-size:13px;color:var(--text-muted);margin:0 0 8px">${escapeHtml(cardId)}</p>` : ''}
        ${masterCard ? `<div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">
          <span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-family:var(--font-mono);background:${(DECK_COLORS[masterCard.color] || DECK_COLORS.Unknown).hex}22;color:${(DECK_COLORS[masterCard.color] || DECK_COLORS.Unknown).hex};border:1px solid ${(DECK_COLORS[masterCard.color] || DECK_COLORS.Unknown).hex}44">${escapeHtml(colorJp)}</span>
          <span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-family:var(--font-mono);background:var(--bg-card);color:var(--text-secondary);border:1px solid var(--border)">${escapeHtml(typeJp)}</span>
          <span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-family:var(--font-mono);background:var(--bg-card);color:var(--text-secondary);border:1px solid var(--border)">${escapeHtml(RARITY_LABEL[masterCard.rarity] || masterCard.rarity)}</span>
          ${masterCard.card_type === 'UNIT' ? `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-family:var(--font-mono);background:var(--bg-card);color:var(--text-secondary);border:1px solid var(--border)">Lv.${masterCard.level} / コスト${masterCard.cost}</span>
          <span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-family:var(--font-mono);background:var(--bg-card);color:var(--text-secondary);border:1px solid var(--border)">AP${masterCard.stats.ap || 0} / HP${masterCard.stats.hp || 0}</span>` : ''}
          ${masterCard.card_type === 'PILOT' ? `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-family:var(--font-mono);background:var(--bg-card);color:var(--text-secondary);border:1px solid var(--border)">Lv.${masterCard.level} / コスト${masterCard.cost}</span>` : ''}
          ${masterCard.card_type === 'COMMAND' ? `<span style="display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-family:var(--font-mono);background:var(--bg-card);color:var(--text-secondary);border:1px solid var(--border)">コスト${masterCard.cost}</span>` : ''}
        </div>
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
