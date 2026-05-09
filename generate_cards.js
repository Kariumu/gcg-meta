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

  // --- 5. A2拡張: 独自分析セクション ---
  let effectAnalysis = '';
  let usageHints = '';
  let similarCards = '';

  // パラレル版向け拡張テキスト
  if (isParallel) {
    const baseCard = cardsMaster[masterCard.base_card_id];
    effectAnalysis = `${escapeHtml(cardName)}はイラスト違いのパラレル版カードです。通常版と同じ効果・ステータスを持ちながら、コレクション性の高い特別なイラストが魅力です。パラレル版はパック開封やキャンペーンなどで入手でき、同じ性能でありながらプレミアム感のある一枚です。`;
    usageHints = `デッキ構築においては通常版と同一のカードとして扱われるため、性能面での違いはありません。お気に入りのイラストで対戦を楽しめるのがパラレル版の醍醐味です。大会でもパラレル版は通常版と同様に使用可能で、コレクションとしての価値も高いカードです。`;
    if (baseCard) {
      const baseColorJp = COLOR_JP[baseCard.color] || baseCard.color || '';
      const baseTypeJp = TYPE_JP[baseCard.card_type] || baseCard.card_type || '';
      similarCards = `通常版の${escapeHtml(baseCard.name_jp || masterCard.base_card_id)}（${escapeHtml(masterCard.base_card_id)}）と完全に同一の効果・ステータスを持ちます。${escapeHtml(baseColorJp)}${escapeHtml(baseTypeJp)}カードとしてデッキに最大4枚まで投入でき、通常版とパラレル版を混在させることも可能です。`;
    }
  }

  if (!isParallel && masterCard.effect_text) {
    // 効果テキスト解説
    const effectText = masterCard.effect_text;
    const effectParts = [];

    // キーワード検出による効果分析
    const keywords = {
      'ドロー': 'ドロー効果によりハンドアドバンテージを得ることができます',
      'ダメージ': '相手にダメージを与える攻撃的な効果を持ちます',
      'リペア': '回復能力により長期戦での粘り強さが光ります',
      '破壊': '除去効果を持ち、相手の盤面に干渉できます',
      '配備': '配備時に効果が発動し、テンポよく展開できます',
      'セット時': 'セット時に効果が発動するため、タイミングを計った運用が重要です',
      '覚醒': '覚醒条件を満たすことで真価を発揮するカードです',
      '指定攻撃': '指定攻撃により、狙った相手ユニットを処理できます',
      '貫通': '貫通能力により、ユニットを超えてダメージを通すことができます',
      '速攻': '速攻を持つため配備直後から攻撃に参加でき、奇襲性が高いです',
      '強襲': '強襲による追加攻撃で、1ターンでの大ダメージが狙えます',
      '高機動': '高機動により攻防両面で柔軟な立ち回りが可能です',
      'コスト軽減': 'コスト軽減効果により、効率的なカード展開を支援します',
      'サーチ': 'デッキからカードを探す効果で、安定したゲームプランを実現します',
      'バウンス': '相手カードを手札に戻す効果で、テンポアドバンテージを得られます',
      'ガード': '防御的な効果により、重要なユニットやベースを守ることができます',
    };

    for (const [kw, desc] of Object.entries(keywords)) {
      if (effectText.includes(kw)) {
        effectParts.push(desc);
      }
    }

    if (effectParts.length > 0) {
      effectAnalysis = `${escapeHtml(cardName)}は${effectParts.slice(0, 3).join('。また、')}。`;
      if (effectParts.length === 1) {
        effectAnalysis += `このカード固有の能力を活かした戦術を組み立てることで、デッキの勝率向上に貢献します。`;
      }
    } else {
      // 効果テキストが短い/キーワードなしカード向けの充実テキスト
      if (ct === 'UNIT') {
        effectAnalysis = `${escapeHtml(cardName)}はバニラ（効果なし）に近いシンプルなユニットですが、コストに対して安定したステータスを持つことが強みです。効果持ちユニットに比べてカウンターされにくく、純粋な戦闘力で盤面に貢献します。特にリミテッド環境やシールド戦では、こうした堅実なステータスを持つカードが活躍する場面が多くあります。`;
      } else if (ct === 'PILOT') {
        effectAnalysis = `${escapeHtml(cardName)}はシンプルな能力を持つパイロットカードです。対応するユニットに搭乗させることで戦闘力を底上げし、バトルでの優位を確保します。派手な効果はありませんが、安定した補正値は構築の土台として頼りになります。`;
      } else if (ct === 'COMMAND') {
        effectAnalysis = `${escapeHtml(cardName)}はシンプルながら確実な効果を持つコマンドカードです。使い所を見極めて発動することで、戦況を有利に運ぶ一手となります。コマンドカードはタイミングが重要なため、相手の動きを読んで使うことが勝利への鍵です。`;
      } else {
        effectAnalysis = `${escapeHtml(cardName)}は独自の効果を持つカードで、特定の戦略において活躍が期待されます。使いこなすことで対戦相手の意表を突く戦術が可能になります。`;
      }
    }

    // タイプ別の運用ヒント
    const hintParts = [];
    if (ct === 'UNIT') {
      if (ap >= 4 && hp >= 4) {
        hintParts.push(`AP${ap}/HP${hp}という高いステータスを誇り、攻守のバランスに優れています`);
      } else if (ap >= 4) {
        hintParts.push(`AP${ap}の高い攻撃力を持ち、アタッカーとして優秀です`);
      } else if (hp >= 4) {
        hintParts.push(`HP${hp}の高い耐久力を持ち、壁役として機能します`);
      } else if (cost <= 2) {
        hintParts.push(`コスト${cost}と軽量なため、序盤の展開を支えるカードです`);
      } else {
        hintParts.push(`Lv.${level}・コスト${cost}のユニットとして、デッキのカーブを構成する中堅カードです`);
      }

      if (traits.length > 0) {
        hintParts.push(`「${escapeHtml(traits[0])}」特徴を持つため、同特徴のカードとシナジーが期待できます`);
      }
    } else if (ct === 'PILOT') {
      hintParts.push(`Lv.${level}のパイロットとして、対応するユニットの戦闘力を引き上げます`);
      if (ap >= 3) {
        hintParts.push(`AP${ap}の高い補正値により、搭乗ユニットの火力が大幅に向上します`);
      }
      if (traits.length > 0) {
        hintParts.push(`「${escapeHtml(traits[0])}」特徴を持つため、同作品のユニットとの組み合わせが自然です`);
      }
    } else if (ct === 'COMMAND') {
      if (cost <= 2) {
        hintParts.push(`コスト${cost}と軽量なコマンドのため、余ったリソースで柔軟に発動できます`);
      } else {
        hintParts.push(`コスト${cost}のコマンドカードとして、ゲーム中盤以降に真価を発揮します`);
      }
      hintParts.push(`${escapeHtml(colorJp)}デッキであればどのアーキタイプにも採用を検討できる汎用性があります`);
    } else if (ct === 'BASE') {
      hintParts.push(`ベースカードとして、ゲームを通じて継続的なアドバンテージを提供します`);
      hintParts.push(`HP${hp}を持つため、ベース攻撃に対する耐久ラインを考慮してデッキを構築しましょう`);
    }

    if (hintParts.length > 0) {
      usageHints = hintParts.join('。') + '。';
    }

    // 類似カード比較: 同色・同タイプ・同コスト帯のカードを検索
    const similarList = [];
    for (const [sid, sc] of Object.entries(cardsMaster)) {
      if (sid === cardId || sid.includes('_p')) continue;
      if (sc.color !== masterCard.color || sc.card_type !== ct) continue;
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
        similarCards = `${escapeHtml(colorJp)}のLv.${level}帯${escapeHtml(typeJp)}カードとしては${names.join('、')}などが存在します。それぞれ異なる効果を持つため、デッキのコンセプトに合わせた選択が重要です。環境やプレイスタイルに応じて使い分けることで、デッキの対応力を高められます。`;
      } else {
        similarCards = `${escapeHtml(colorJp)}のコスト${cost}帯${escapeHtml(typeJp)}カードとしては${names.join('、')}などが存在します。それぞれ異なる効果を持つため、デッキのコンセプトに合わせた選択が重要です。環境やプレイスタイルに応じて使い分けることで、デッキの対応力を高められます。`;
      }
    } else if (similarList.length === 1) {
      similarCards = `${escapeHtml(colorJp)}の同レベル帯で近い役割を持つカードとして${escapeHtml(similarList[0].name_jp)}があります。効果やステータスの違いを比較し、デッキに合った方を選択しましょう。`;
    }

    // デッキ構築アドバイス（追加テキスト確保）
    const deckAdviceParts = [];
    if (source) {
      deckAdviceParts.push(`「${escapeHtml(source)}」シリーズのカードと組み合わせることで、テーマデッキとしての一体感が生まれます`);
    }
    if (traits.length > 0) {
      deckAdviceParts.push(`「${escapeHtml(traits[0])}」特徴を持つ他のカードとの組み合わせにより、特徴シナジーを活かした戦術が可能です`);
      if (traits.length >= 2) {
        deckAdviceParts.push(`また「${escapeHtml(traits[1])}」特徴も持つため、複数の特徴軸でのデッキ構築に柔軟性があります`);
      }
    }
    if (ct === 'UNIT' && level >= 5) {
      deckAdviceParts.push(`高レベルユニットとして、序盤を支える低コストカードとの配分バランスに注意が必要です`);
    } else if (ct === 'UNIT' && level <= 2) {
      deckAdviceParts.push(`序盤から展開できる低レベルユニットとして、ゲームの主導権を握る役割を担います`);
    }
    if (masterCard.link && masterCard.link.length > 0) {
      deckAdviceParts.push(`リンク対象として「${escapeHtml(masterCard.link[0])}」が設定されており、リンク成功時のボーナスを狙えます`);
    }
    // コマンドカード特徴なし向け補完
    if (ct === 'COMMAND' && traits.length === 0 && !masterCard.link) {
      deckAdviceParts.push(`${escapeHtml(colorJp)}カードを使うデッキであれば色条件を満たせるため、メインデッキやサイドボードへの投入を検討できます`);
      if (cost <= 3) {
        deckAdviceParts.push(`低コストコマンドはゲーム序盤から中盤にかけてテンポよく使用でき、盤面の優位を築く手助けとなります`);
      } else {
        deckAdviceParts.push(`高コストコマンドは発動タイミングが限られるものの、効果が強力で試合の流れを変える一枚になり得ます`);
      }
      deckAdviceParts.push(`対戦相手のデッキタイプに応じて採用枚数を調整することで、環境への対応力が上がります`);
    }
    // ベースカード向け補完
    if (ct === 'BASE' && traits.length === 0) {
      deckAdviceParts.push(`ベースカードはゲーム開始時に配置するカードで、試合全体を通じて効果が持続します`);
      deckAdviceParts.push(`デッキの戦略に合ったベースを選ぶことで、ゲームプランの安定性が大きく向上します`);
    }
    // 汎用の追加テキスト（データが少ないカードの底上げ）
    if (deckAdviceParts.length === 0) {
      deckAdviceParts.push(`${escapeHtml(setPrefix)}収録のカードとして、同弾のカードとの組み合わせを意識したデッキ構築がおすすめです`);
      deckAdviceParts.push(`今後のカードプールの拡張により、新たなシナジーが生まれる可能性もあります`);
    }
    if (deckAdviceParts.length > 0) {
      usageHints += ' ' + deckAdviceParts.join('。') + '。';
    }

    // 収録パック情報テキスト（全カード共通でテキスト量を確保）
    const setNames = {
      'GD01': 'ガンダムカードゲーム ブースターパック01「機動戦士ガンダム ～戦場の絆～」',
      'GD02': 'ガンダムカードゲーム ブースターパック02「宇宙世紀の鼓動」',
      'GD03': 'ガンダムカードゲーム ブースターパック03「英雄の共鳴」',
      'GD04': 'ガンダムカードゲーム ブースターパック04「運命の加速」',
      'ST01': 'スターターデッキ01「地球連邦軍」',
      'ST02': 'スターターデッキ02「ジオン公国軍」',
      'ST03': 'スターターデッキ03「ティターンズ」',
      'ST04': 'スターターデッキ04「エゥーゴ」',
      'ST05': 'スターターデッキ05「ザフト」',
      'ST06': 'スターターデッキ06「地球連合」',
      'ST07': 'スターターデッキ07「ソレスタルビーイング」',
      'ST08': 'スターターデッキ08「ガンダムマイスターズ」',
      'ST09': 'スターターデッキ09「ネオ・ジオン」',
    };
    const setFullName = setNames[setPrefix] || `${escapeHtml(setPrefix)}パック`;
    let packInfo = `${escapeHtml(cardName)}は「${escapeHtml(setFullName)}」に収録されています。`;
    if (setPrefix.startsWith('ST')) {
      packInfo += `スターターデッキは構築済みのカードセットとして手軽にゲームを始められる商品で、初心者にもおすすめです。スターターのカードを基盤にブースターパックのカードを加えることで、より強力なデッキへと進化させることができます。`;
    } else {
      packInfo += `ブースターパックはランダム封入のため、目当てのカードを手に入れるにはトレーディングやシングル購入も有効です。同パックの他カードとの相性も考慮してコレクションを進めましょう。`;
    }
    usageHints += ' ' + packInfo;
  }

  // HTMLセクション組み立て
  let html = `
    <section class="seo-text-section" style="margin-top:32px;padding:24px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius-lg)">
      <h2 style="font-size:16px;font-weight:700;margin:0 0 12px;color:var(--text-primary)">${escapeHtml(cardName)}について</h2>
      <p style="font-size:14px;line-height:1.8;color:var(--text-secondary);margin:0 0 16px">${overviewText}</p>
      <h3 style="font-size:14px;font-weight:600;margin:0 0 8px;color:var(--text-primary)">大会での採用状況</h3>
      <p style="font-size:14px;line-height:1.8;color:var(--text-secondary);margin:0 0 16px">${analysisText}</p>`;

  if (synergyText) {
    html += `
      <h3 style="font-size:14px;font-weight:600;margin:0 0 8px;color:var(--text-primary)">相性の良いカード</h3>
      <p style="font-size:14px;line-height:1.8;color:var(--text-secondary);margin:0 0 16px">${synergyText}</p>`;
  }

  // A2拡張セクション（採用0カード向け）
  if (effectAnalysis) {
    html += `
      <h3 style="font-size:14px;font-weight:600;margin:0 0 8px;color:var(--text-primary)">カードの強み</h3>
      <p style="font-size:14px;line-height:1.8;color:var(--text-secondary);margin:0 0 16px">${effectAnalysis}</p>`;
  }

  if (usageHints) {
    html += `
      <h3 style="font-size:14px;font-weight:600;margin:0 0 8px;color:var(--text-primary)">運用のヒント</h3>
      <p style="font-size:14px;line-height:1.8;color:var(--text-secondary);margin:0 0 16px">${usageHints}</p>`;
  }

  if (similarCards) {
    html += `
      <h3 style="font-size:14px;font-weight:600;margin:0 0 8px;color:var(--text-primary)">類似カード</h3>
      <p style="font-size:14px;line-height:1.8;color:var(--text-secondary);margin:0 0 16px">${similarCards}</p>`;
  }

  // 全カード共通: GCGゲーム情報セクション
  const colorTip = {
    '赤': '赤は攻撃的なカードが多く、速攻や高APを活かした積極的な攻めが得意なカラーです。',
    '青': '青はドローやサーチなどの手札補充に優れ、安定したゲーム展開が可能なカラーです。',
    '緑': '緑は耐久力やリペアに優れ、長期戦で真価を発揮する防御的なカラーです。',
    '黄': '黄は多彩な効果を持つカードが揃い、柔軟な戦術を取れるバランス型のカラーです。',
    '紫': '紫はトリッキーな効果や強力なコマンドを持ち、相手の戦略を崩す妨害に長けたカラーです。',
    '黒': '黒は高コストながら強力な効果を持つカードが多く、終盤の逆転力が魅力のカラーです。',
  };
  const colorInfo = colorTip[colorJp] || `${escapeHtml(colorJp)}カラーは独自の戦略性を持ちます。`;
  const gameInfo = `${colorInfo}ガンダムカードゲームでは最大4枚まで同名カードをデッキに入れることができ、デッキ枚数は50枚で構成します。大会ではニュータイプチャレンジ形式が主流で、全国の店舗で定期的に開催されています。`;

  html += `
      <h3 style="font-size:14px;font-weight:600;margin:0 0 8px;color:var(--text-primary)">ガンダムカードゲームについて</h3>
      <p style="font-size:14px;line-height:1.8;color:var(--text-secondary);margin:0 0 16px">${gameInfo}</p>
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
      {"@type": "ListItem", "position": 3, "name": "${escapeHtml(setPrefix)}", "item": "${SITE_URL}/cards.html#${setPrefix}"},
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
      <a href="../../cards.html#${setPrefix}" style="color:var(--text-muted);text-decoration:none" onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--text-muted)'">${escapeHtml(setPrefix)}</a>
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
