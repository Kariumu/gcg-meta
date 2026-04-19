/**
 * MSA Steel Requiem .2 Royal Battle - English analysis page generator
 *
 * Output: msa/rb-20260412-k7f3a9d2.html
 *
 * Rules (strictly enforced):
 *   - English only (card names keep Japanese from cards_master.name_jp)
 *   - Fully anonymized: no player names / countries / individual records / placings
 *   - Top 16 lists are shuffled (Fisher-Yates) and labeled A..P (not by rank)
 *   - <meta name="robots" content="noindex, nofollow">
 *   - No OGP, no canonical, no sitemap/robots entry, no cross-links
 */

const fs = require('fs');
const path = require('path');

// ------------------------------------------------------------------
// Paths
// ------------------------------------------------------------------
const ROOT = path.join(__dirname, '..');
const OUT_PATH = path.join(ROOT, 'msa', 'rb-20260412-k7f3a9d2.html');

// ------------------------------------------------------------------
// Data load
// ------------------------------------------------------------------
const master     = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'cards_master.json'), 'utf8'));
const standings  = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'msa', 'royal-battle-standings.json'), 'utf8'));
const adoption   = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'msa', 'royal-battle-adoption-by-deck-type.json'), 'utf8'));
const enriched   = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'msa', 'royal-battle-decks-enriched.json'), 'utf8'));

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
const COLOR_JA_TO_EN_DISPLAY = {
  Blue: 'Blue',
  Red: 'Red',
  Green: 'Green',
  White: 'White',
  Purple: 'Purple',
};

function htmlEscape(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Color label: internal is "Blue Purple"; displayed as "Blue/Purple"
function toDisplayLabel(colorLabel) {
  if (!colorLabel) return '';
  const parts = colorLabel.split(' ').map(c => COLOR_JA_TO_EN_DISPLAY[c] || c);
  if (parts.length === 1) return `${parts[0]} (Mono)`;
  return parts.join('/');
}

function cardKey(setCode, number) {
  return `${setCode}-${number}`;
}

function cardInfo(id) {
  const m = master[id] || {};
  return {
    id,
    name_jp: m.name_jp || '(unknown)',
    color: m.color || null,
    card_type: m.card_type || null,
  };
}

// Sort card_type for deck list order: UNIT -> PILOT -> COMMAND -> BASE
const CARD_TYPE_ORDER = ['UNIT', 'PILOT', 'COMMAND', 'BASE'];

// ------------------------------------------------------------------
// Deck Type Distribution
// ------------------------------------------------------------------
const distributionRows = Object.values(adoption.deck_types)
  .map(dt => ({
    label: toDisplayLabel(dt.label_en),
    N: dt.deck_count,
    share: dt.share_pct,
  }))
  .sort((a, b) => b.N - a.N || a.label.localeCompare(b.label));

// ------------------------------------------------------------------
// Top 8 by deck type (placing-sorted)
// ------------------------------------------------------------------
const placedSorted = standings
  .filter(p => p.placing != null)
  .sort((a, b) => a.placing - b.placing);

// Build enriched lookup: player -> color_label
const enrichedByPlayer = new Map();
enriched.forEach(e => enrichedByPlayer.set(e.player, e.color_label));

const top8ByDeckType = placedSorted.slice(0, 8).map(p => {
  const label = enrichedByPlayer.get(p.player) || '(unknown)';
  return {
    placing: p.placing,
    deck_type_display: toDisplayLabel(label),
  };
});

// ------------------------------------------------------------------
// Deck Type Details: per type top 30 cards
// ------------------------------------------------------------------
const deckTypeBlocks = Object.entries(adoption.deck_types)
  .sort((a, b) => b[1].deck_count - a[1].deck_count || a[1].label_en.localeCompare(b[1].label_en))
  .map(([label_en, dt]) => {
    const top30 = dt.cards.slice(0, 30).map(c => {
      const info = cardInfo(c.id);
      return {
        name_jp: info.name_jp,
        id: c.id,
        adoption_rate_pct: c.adoption_rate_pct,
        avg_copies: c.avg_copies,
        median_copies: c.median_copies,
      };
    });
    return {
      display: toDisplayLabel(label_en),
      N: dt.deck_count,
      share_pct: dt.share_pct,
      top30,
    };
  });

// ------------------------------------------------------------------
// Overall Card Adoption Ranking (Top 50 across all 72 decks)
// ------------------------------------------------------------------
const TOTAL_DECKS = standings.length;
const overallAdoption = new Map(); // id -> { decks:Set<player>, totalCopies:number }
for (const p of standings) {
  const perDeckSeen = new Set();
  const perDeckCopies = new Map();
  ['unit', 'pilot', 'command', 'base'].forEach(cat => {
    (p.decklist?.[cat] || []).forEach(c => {
      const id = cardKey(c.set, c.number);
      perDeckCopies.set(id, (perDeckCopies.get(id) || 0) + c.count);
      perDeckSeen.add(id);
    });
  });
  for (const id of perDeckSeen) {
    if (!overallAdoption.has(id)) overallAdoption.set(id, { decks: 0, copies: [] });
    const rec = overallAdoption.get(id);
    rec.decks += 1;
    rec.copies.push(perDeckCopies.get(id));
  }
}

const overallTop50 = Array.from(overallAdoption.entries())
  .map(([id, v]) => {
    const info = cardInfo(id);
    const rate = (v.decks / TOTAL_DECKS) * 100;
    const avg = v.copies.reduce((s, x) => s + x, 0) / v.copies.length;
    return {
      id,
      name_jp: info.name_jp,
      color: info.color,
      adoption_rate_pct: Math.round(rate * 10) / 10,
      avg_copies: Math.round(avg * 100) / 100,
      decks: v.decks,
    };
  })
  .sort((a, b) =>
    b.adoption_rate_pct - a.adoption_rate_pct ||
    b.avg_copies - a.avg_copies ||
    a.id.localeCompare(b.id)
  )
  .slice(0, 50);

// ------------------------------------------------------------------
// Top 16 Deck Lists (shuffled, labeled A..P)
// ------------------------------------------------------------------
const top16 = placedSorted.slice(0, 16).map(p => {
  const label = enrichedByPlayer.get(p.player) || '(unknown)';
  const allCards = [];
  ['unit', 'pilot', 'command', 'base'].forEach(cat => {
    (p.decklist?.[cat] || []).forEach(c => {
      const id = cardKey(c.set, c.number);
      const m = master[id] || {};
      allCards.push({
        id,
        name_jp: m.name_jp || '(unknown)',
        card_type: m.card_type || 'UNKNOWN',
        color: m.color || null,
        count: c.count,
      });
    });
  });
  // Sort by type -> color order -> id
  allCards.sort((a, b) => {
    const ta = CARD_TYPE_ORDER.indexOf(a.card_type);
    const tb = CARD_TYPE_ORDER.indexOf(b.card_type);
    if (ta !== tb) return (ta === -1 ? 99 : ta) - (tb === -1 ? 99 : tb);
    return a.id.localeCompare(b.id);
  });
  return {
    deck_type_display: toDisplayLabel(label),
    cards: allCards,
  };
});

// Fisher-Yates shuffle (intentional: destroys rank-to-deck linkage)
for (let i = top16.length - 1; i > 0; i--) {
  const j = Math.floor(Math.random() * (i + 1));
  [top16[i], top16[j]] = [top16[j], top16[i]];
}

const DECK_LETTERS = 'ABCDEFGHIJKLMNOP'.split('');

// ------------------------------------------------------------------
// HTML builders
// ------------------------------------------------------------------
function buildDistributionTable() {
  const rows = distributionRows.map(r => `
      <tr>
        <td>${htmlEscape(r.label)}</td>
        <td class="num">${r.N}</td>
        <td class="num">${r.share.toFixed(1)}%</td>
      </tr>`).join('');
  return `
  <table class="dist-table">
    <thead>
      <tr><th>Deck Type</th><th class="num">Players</th><th class="num">Share</th></tr>
    </thead>
    <tbody>${rows}
    </tbody>
  </table>`;
}

function buildTop8List() {
  const items = top8ByDeckType.map((r, i) => {
    const suffix = (r.placing === 1) ? 'st'
                 : (r.placing === 2) ? 'nd'
                 : (r.placing === 3) ? 'rd' : 'th';
    return `    <li><strong>${r.placing}${suffix}</strong>: ${htmlEscape(r.deck_type_display)}</li>`;
  }).join('\n');
  return `<ol class="top8-list">\n${items}\n  </ol>`;
}

function buildDeckTypeDetails() {
  return deckTypeBlocks.map(block => {
    const rows = block.top30.map(c => `
          <tr>
            <td>${htmlEscape(c.name_jp)}</td>
            <td class="mono">${htmlEscape(c.id)}</td>
            <td class="num">${c.adoption_rate_pct.toFixed(1)}%</td>
            <td class="num">${c.avg_copies.toFixed(2)}</td>
            <td class="num">${c.median_copies}</td>
          </tr>`).join('');
    return `
  <details class="deck-type-block">
    <summary>${htmlEscape(block.display)} &mdash; ${block.N} players (${block.share_pct.toFixed(1)}%)</summary>
    <h4>Top Adopted Cards (up to 30)</h4>
    <table class="card-table">
      <thead>
        <tr>
          <th>Card</th>
          <th>Card ID</th>
          <th class="num">Adoption</th>
          <th class="num">Avg Copies</th>
          <th class="num">Median Copies</th>
        </tr>
      </thead>
      <tbody>${rows}
      </tbody>
    </table>
  </details>`;
  }).join('\n');
}

function buildOverallTop50() {
  const rows = overallTop50.map((c, i) => `
      <tr>
        <td class="num">${i + 1}</td>
        <td>${htmlEscape(c.name_jp)}</td>
        <td class="mono">${htmlEscape(c.id)}</td>
        <td>${htmlEscape(c.color || '-')}</td>
        <td class="num">${c.adoption_rate_pct.toFixed(1)}%</td>
        <td class="num">${c.avg_copies.toFixed(2)}</td>
      </tr>`).join('');
  return `
  <details class="overall-block">
    <summary>Overall Card Adoption Rankings (all ${TOTAL_DECKS} decks)</summary>
    <p class="note-p">Top 50 most adopted cards across all decks, regardless of deck type.</p>
    <table class="card-table">
      <thead>
        <tr>
          <th class="num">Rank</th>
          <th>Card</th>
          <th>Card ID</th>
          <th>Color</th>
          <th class="num">Adoption</th>
          <th class="num">Avg Copies</th>
        </tr>
      </thead>
      <tbody>${rows}
      </tbody>
    </table>
  </details>`;
}

function buildTop16Lists() {
  const blocks = top16.map((d, i) => {
    const letter = DECK_LETTERS[i];
    const rows = d.cards.map(c => `
          <tr>
            <td class="num">${c.count}</td>
            <td>${htmlEscape(c.name_jp)}</td>
            <td class="mono">${htmlEscape(c.id)}</td>
            <td>${htmlEscape(c.card_type || '-')}</td>
          </tr>`).join('');
    return `
    <details class="deck-list-block">
      <summary>Deck ${letter} &mdash; ${htmlEscape(d.deck_type_display)}</summary>
      <table class="decklist-table">
        <thead>
          <tr><th class="num">Count</th><th>Card</th><th>Card ID</th><th>Type</th></tr>
        </thead>
        <tbody>${rows}
        </tbody>
      </table>
    </details>`;
  }).join('\n');
  return `
  <details class="top16-block">
    <summary>Top 16 Deck Lists (anonymized, randomized order)</summary>
    <p class="note-p">The following 16 deck lists are from the top placings, but presented in randomized order without ranking numbers or player identifiers. Deck labels (A&ndash;P) do not correspond to placement.</p>
${blocks}
  </details>`;
}

// ------------------------------------------------------------------
// Page assembly
// ------------------------------------------------------------------
const INLINE_STYLE = `
    main.rb-page { max-width: 960px; margin: 0 auto; padding: 24px 16px 80px; }
    main.rb-page h1 { font-size: 1.8rem; margin-bottom: 8px; }
    main.rb-page h2 { margin-top: 32px; padding-bottom: 4px; border-bottom: 1px solid rgba(255,255,255,0.15); }
    main.rb-page h4 { margin: 16px 0 8px; font-size: 1rem; }
    main.rb-page p { line-height: 1.6; }
    main.rb-page .meta-info { margin: 12px 0 16px; padding: 12px 14px; border-left: 3px solid #4aa3ff; background: rgba(74,163,255,0.08); line-height: 1.7; font-size: 0.95rem; }
    main.rb-page .privacy-notice { margin: 12px 0 24px; padding: 12px 14px; border-left: 3px solid #ffb347; background: rgba(255,179,71,0.08); font-size: 0.95rem; }
    main.rb-page table { border-collapse: collapse; width: 100%; margin: 8px 0 16px; font-size: 0.93rem; }
    main.rb-page table th, main.rb-page table td { border: 1px solid rgba(255,255,255,0.15); padding: 6px 10px; text-align: left; }
    main.rb-page table th { background: rgba(255,255,255,0.06); font-weight: 600; }
    main.rb-page table td.num, main.rb-page table th.num { text-align: right; font-variant-numeric: tabular-nums; }
    main.rb-page table td.mono { font-family: ui-monospace, "SFMono-Regular", Menlo, monospace; font-size: 0.88rem; }
    main.rb-page details { margin: 10px 0; border: 1px solid rgba(255,255,255,0.15); border-radius: 6px; background: rgba(255,255,255,0.02); }
    main.rb-page details > summary { cursor: pointer; padding: 10px 14px; font-weight: 600; list-style: none; user-select: none; }
    main.rb-page details > summary::-webkit-details-marker { display: none; }
    main.rb-page details > summary::before { content: "▶"; display: inline-block; margin-right: 8px; font-size: 0.8em; transition: transform 0.15s; }
    main.rb-page details[open] > summary::before { transform: rotate(90deg); }
    main.rb-page details > *:not(summary) { padding: 0 14px 12px; }
    main.rb-page details details { margin: 6px 0; }
    main.rb-page .top8-list { padding-left: 28px; }
    main.rb-page .top8-list li { margin: 4px 0; }
    main.rb-page .note-p { font-size: 0.9rem; color: rgba(255,255,255,0.7); margin: 6px 0 10px; }
    main.rb-page .footer-note { margin-top: 48px; padding-top: 16px; border-top: 1px solid rgba(255,255,255,0.15); font-size: 0.88rem; color: rgba(255,255,255,0.6); }
    main.rb-page .footer-note hr { display: none; }
`;

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>MSA Royal Battle Data Analysis | GCG STATS</title>
  <meta name="description" content="Anonymized tournament data analysis for MSA Steel Requiem .2 Royal Battle.">
  <link rel="stylesheet" href="../css/style.css">
  <style>${INLINE_STYLE}</style>
</head>
<body>
<main class="rb-page">

  <h1>MSA Steel Requiem .2 Royal Battle - Data Analysis</h1>
  <p>Unofficial data aggregation from Limitless TCG public tournament data.</p>

  <div class="meta-info">
    Tournament Date: April 12, 2026<br>
    Format: 6 Swiss Rounds + TOP 8 (Best of 1)<br>
    Participants: ${TOTAL_DECKS}<br>
    Data Source: <a href="https://mobilesuitarena.com/" target="_blank" rel="noopener">Mobile Suit Arena</a> &times; <a href="https://play.limitlesstcg.com/tournament/69ce86dbd478313a15a39b9b/standings" target="_blank" rel="noopener">Limitless TCG</a>
  </div>

  <div class="privacy-notice">
    <strong>Privacy Notice:</strong> All data on this page is anonymized.
    Player names, countries, individual records, and final placements are not displayed.
  </div>

  <h2>Deck Type Distribution</h2>
  ${buildDistributionTable()}

  <h4>Top 8 by Deck Type</h4>
  ${buildTop8List()}

  <h2>Deck Type Details</h2>
  <p class="note-p">All ${deckTypeBlocks.length} deck types. Click to expand. Card names remain in Japanese as-is from the card master. Adoption rate uses the deck type's sample (N) as denominator; Avg / Median copies are computed over adopting decks only.</p>
${buildDeckTypeDetails()}

  <h2>Overall Card Adoption Ranking</h2>
${buildOverallTop50()}

  <h2>Top 16 Deck Lists</h2>
${buildTop16Lists()}

  <div class="footer-note">
    <hr>
    <p>
      <strong>Note:</strong> This page is displayed in English for international readers.<br>
      Our main site content is normally in Japanese.
    </p>
    <p>
      本ページは海外読者向けに英語で表記しています。通常のサイトコンテンツは日本語で表記を行う想定です。
    </p>
  </div>

</main>
</body>
</html>
`;

// ------------------------------------------------------------------
// Write
// ------------------------------------------------------------------
fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, html, 'utf8');

// ------------------------------------------------------------------
// Console summary
// ------------------------------------------------------------------
console.log('=== MSA Royal Battle page generated ===');
console.log('Output:', OUT_PATH);
console.log('Size:  ', (html.length / 1024).toFixed(1) + ' KB');
console.log('Participants:', TOTAL_DECKS);
console.log('Deck types shown:', deckTypeBlocks.length);
console.log('Overall Top50 cards:', overallTop50.length);
console.log('Top16 decks (shuffled):', top16.length);
// Anonymization sanity: real player names must NOT appear anywhere in the HTML
const playerNames = standings.map(p => p.player).filter(Boolean);
let leakedNames = 0;
for (const name of playerNames) {
  // boundary check to avoid common-word false positives
  const re = new RegExp('(^|[^a-zA-Z0-9_])' + name.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&') + '([^a-zA-Z0-9_]|$)', 'i');
  if (re.test(html)) leakedNames++;
}
console.log('\nSanity checks:');
console.log('  Leaked player names :', leakedNames, '(must be 0)');
console.log('  robots noindex      :', /<meta\s+name=["']robots["']\s+content=["']noindex, nofollow["']/i.test(html));
console.log('  canonical absent    :', !/<link[^>]+rel=["']canonical["']/i.test(html));
console.log('  OGP absent          :', !/property=["']og:/i.test(html));
console.log('  Twitter card absent :', !/name=["']twitter:/i.test(html));
