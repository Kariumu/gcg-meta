const fs = require('fs');
const path = require('path');

// ==============================================================
// デッキタイプ(固定色順カラーラベル)別 カード採用率・採用中央値 算出
// --------------------------------------------------------------
// 仕様:
//   A-2: 採用中央値は「採用デッキのみ」を対象に算出
//   B-3: 全デッキタイプを表示し、サンプル数(N)を併記
//   C-1: 母集団は全体 72 名（Top16 ではない）
// --------------------------------------------------------------
// 入力:
//   data/cards_master.json                    : カードマスタ
//   data/msa/royal-battle-standings.json      : 元デッキリスト
//   data/msa/royal-battle-decks-enriched.json : 色分類済み
// 出力:
//   data/msa/royal-battle-adoption-by-deck-type.json
// ==============================================================

const COLOR_JA = {
  Blue: '青',
  Red: '赤',
  Green: '緑',
  White: '白',
  Purple: '紫',
};

function toColorLabelJa(colorLabelEn) {
  // "Blue Purple" -> "青/紫"
  if (!colorLabelEn) return '';
  return colorLabelEn
    .split(' ')
    .map(c => COLOR_JA[c] || c)
    .join('/');
}

function median(nums) {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

function main() {
  const root = path.join(__dirname, '..');
  const master = require(path.join(root, 'data', 'cards_master.json'));
  const standings = require(path.join(root, 'data', 'msa', 'royal-battle-standings.json'));
  const enriched = require(path.join(root, 'data', 'msa', 'royal-battle-decks-enriched.json'));

  // ---- プレイヤー名 -> color_label マップ ----
  // standings と enriched は同順で生成されているが、安全のため名前一致で紐付け
  const labelByPlayer = new Map();
  enriched.forEach(e => {
    labelByPlayer.set(e.player, e.color_label);
  });

  // ---- デッキタイプ別にデッキを仕分け ----
  // group: { [color_label]: Array<{ player, cardCounts: Map<id, count> }> }
  const groups = {};
  for (const entry of standings) {
    const label = labelByPlayer.get(entry.player);
    if (!label) continue;

    const cardCounts = new Map();
    ['unit', 'pilot', 'command', 'base'].forEach(cat => {
      (entry.decklist?.[cat] || []).forEach(c => {
        const id = `${c.set}-${c.number}`;
        cardCounts.set(id, (cardCounts.get(id) || 0) + c.count);
      });
    });

    if (!groups[label]) groups[label] = [];
    groups[label].push({ player: entry.player, cardCounts });
  }

  // ---- デッキタイプごとに採用率・中央値を算出 ----
  const totalDecks = standings.length;
  const deckTypes = {};

  // 出現順は件数降順、同数は固定色順ラベルで安定化
  const orderedLabels = Object.keys(groups).sort((a, b) => {
    const da = groups[a].length;
    const db = groups[b].length;
    if (db !== da) return db - da;
    return a.localeCompare(b);
  });

  for (const label of orderedLabels) {
    const decksInGroup = groups[label];
    const N = decksInGroup.length;

    // そのデッキタイプで 1枚以上採用された全カード ID を収集
    const cardIds = new Set();
    for (const d of decksInGroup) {
      for (const id of d.cardCounts.keys()) cardIds.add(id);
    }

    const cards = [];
    for (const id of cardIds) {
      const counts = [];           // 採用デッキの採用枚数
      let adoptionDecks = 0;
      for (const d of decksInGroup) {
        const c = d.cardCounts.get(id);
        if (c && c > 0) {
          adoptionDecks++;
          counts.push(c);
        }
      }

      const adoptionRate = (adoptionDecks / N) * 100;
      const med = median(counts);                      // A-2: 採用デッキのみ
      const avg = counts.reduce((s, v) => s + v, 0) / counts.length;
      const maxCopies = Math.max(...counts);
      const totalCopies = counts.reduce((s, v) => s + v, 0);

      const m = master[id] || {};
      cards.push({
        id,
        name_jp: m.name_jp || null,
        card_type: m.card_type || null,
        color: m.color || null,
        level: m.level ?? null,
        cost: m.cost ?? null,
        adoption_decks: adoptionDecks,
        non_adoption_decks: N - adoptionDecks,
        adoption_rate_pct: Math.round(adoptionRate * 10) / 10,
        median_copies: med,                            // 採用デッキのみ中央値
        avg_copies: Math.round(avg * 100) / 100,       // 採用デッキのみ平均
        max_copies: maxCopies,
        total_copies: totalCopies,
      });
    }

    // 採用率降順 → 同率は採用枚数平均降順 → さらに同値は ID 昇順
    cards.sort((a, b) => {
      if (b.adoption_rate_pct !== a.adoption_rate_pct)
        return b.adoption_rate_pct - a.adoption_rate_pct;
      if (b.avg_copies !== a.avg_copies)
        return b.avg_copies - a.avg_copies;
      return a.id.localeCompare(b.id);
    });

    deckTypes[label] = {
      label_en: label,
      label_ja: toColorLabelJa(label),
      deck_count: N,
      share_pct: Math.round((N / totalDecks) * 1000) / 10,
      cards,
    };
  }

  // ---- 出力 ----
  const output = {
    generated_at: new Date().toISOString(),
    source: {
      tournament: 'MSA Steel Requiem .2 Royal Battle',
      tournament_id: '69ce86dbd478313a15a39b9b',
    },
    rule: {
      median: 'A-2: 採用中央値は「採用デッキのみ」を対象に算出',
      coverage: 'B-3: 全デッキタイプを表示し N を併記',
      population: 'C-1: 母集団は全体 ' + totalDecks + ' 名',
      color_order: '固定: Blue > Red > Green > White > Purple',
      color_label_ja: 'Blue=青, Red=赤, Green=緑, White=白, Purple=紫 ("/" 区切り)',
    },
    total_decks: totalDecks,
    deck_types: deckTypes,
  };

  const outDir = path.join(root, 'data', 'msa');
  const outPath = path.join(outDir, 'royal-battle-adoption-by-deck-type.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');

  // ---- コンソール要約 ----
  console.log('=== デッキタイプ別 採用率・採用中央値 ===');
  console.log('母集団: ' + totalDecks + ' 名');
  console.log('デッキタイプ数: ' + Object.keys(deckTypes).length);
  console.log('');
  orderedLabels.forEach(label => {
    const t = deckTypes[label];
    console.log(
      '[' + t.label_ja + '] (' + t.label_en + ')  N=' + t.deck_count +
      '  share=' + t.share_pct.toFixed(1) + '%  cards=' + t.cards.length
    );
    t.cards.slice(0, 3).forEach(c => {
      console.log(
        '    ' + c.id + ' ' + (c.name_jp || '(name?)') +
        '  採用' + c.adoption_decks + '/' + t.deck_count +
        '(' + c.adoption_rate_pct.toFixed(1) + '%)' +
        '  中央値=' + c.median_copies +
        '  平均=' + c.avg_copies.toFixed(2)
      );
    });
  });

  console.log('\nSaved: ' + outPath);
}

main();
