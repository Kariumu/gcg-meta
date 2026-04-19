const fs = require('fs');
const path = require('path');

// Rule: any card of color C (count >= 1) -> include C
// Order: fixed official color order (Blue > Red > Green > White > Purple)
//        This ensures "Red Blue" and "Blue Red" collapse into the same bucket.

const OFFICIAL_COLOR_ORDER = ['Blue', 'Red', 'Green', 'White', 'Purple'];
const COLOR_RANK = Object.fromEntries(OFFICIAL_COLOR_ORDER.map((c, i) => [c, i]));

function classifyDeck(decklist, master) {
  const colorCounts = {};
  const missing = [];
  ['unit', 'pilot', 'command', 'base'].forEach(cat => {
    (decklist?.[cat] || []).forEach(c => {
      const id = `${c.set}-${c.number}`;
      const entry = master[id];
      if (!entry || !entry.color) {
        missing.push({ id, name: c.name, count: c.count });
        return;
      }
      colorCounts[entry.color] = (colorCounts[entry.color] || 0) + c.count;
    });
  });

  const colors = Object.keys(colorCounts).sort(
    (a, b) => (COLOR_RANK[a] ?? 99) - (COLOR_RANK[b] ?? 99)
  );
  const colorLabel = colors.join(' ');
  return { colorCounts, colors, colorLabel, missing };
}

function extractArchetype(name) {
  if (!name || name === 'Unknown' || name === 'Other') return null;
  const tokens = name.split(' ');
  const archetypeTokens = tokens.filter(t => !OFFICIAL_COLOR_ORDER.includes(t));
  return archetypeTokens.length > 0 ? archetypeTokens.join(' ') : null;
}

function main() {
  const root = path.join(__dirname, '..');
  const master = require(path.join(root, 'data', 'cards_master.json'));
  const standingsPath = path.join(root, 'data', 'msa', 'royal-battle-standings.json');
  const standings = require(standingsPath);

  console.log('=== Deck color classification (fixed order) ===');
  console.log('Master cards: ' + Object.keys(master).length);
  console.log('Standings entries: ' + standings.length + '\n');

  const enriched = [];
  const globalMissing = new Set();
  const newDeckTypes = {};
  const colorComboTypes = {};
  let otherReclassified = 0;

  for (const player of standings) {
    const result = classifyDeck(player.decklist, master);
    result.missing.forEach(m => globalMissing.add(m.id + '|' + m.name));

    const limitlessName = player.deck?.name || 'Unknown';
    const limitlessArchetype = extractArchetype(limitlessName);
    const enrichedName = limitlessArchetype
      ? result.colorLabel + ' ' + limitlessArchetype
      : result.colorLabel;

    enriched.push({
      name: player.name,
      player: player.player,
      country: player.country,
      placing: player.placing,
      record: player.record,
      drop: player.drop,
      limitless_deck_name: limitlessName,
      color_counts: result.colorCounts,
      colors: result.colors,
      color_label: result.colorLabel,
      enriched_deck_name: enrichedName,
    });

    colorComboTypes[result.colorLabel] = (colorComboTypes[result.colorLabel] || 0) + 1;
    newDeckTypes[enrichedName] = (newDeckTypes[enrichedName] || 0) + 1;
    if (limitlessName === 'Other') otherReclassified++;
  }

  const outputDir = path.join(root, 'data', 'msa');
  const outPath = path.join(outputDir, 'royal-battle-decks-enriched.json');
  fs.writeFileSync(outPath, JSON.stringify(enriched, null, 2), 'utf8');

  const summary = {
    generated_at: new Date().toISOString(),
    rule: 'any card of color C (count >= 1) -> include C',
    color_order: 'fixed: Blue > Red > Green > White > Purple',
    total_decks: standings.length,
    other_decks_reclassified: otherReclassified,
    missing_master_entries: Array.from(globalMissing),
    color_combinations: Object.fromEntries(
      Object.entries(colorComboTypes).sort((a, b) => b[1] - a[1])
    ),
    enriched_deck_types: Object.fromEntries(
      Object.entries(newDeckTypes).sort((a, b) => b[1] - a[1])
    ),
  };
  const summaryPath = path.join(outputDir, 'royal-battle-summary-enriched.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');

  console.log('=== Results ===');
  console.log('Reclassified from Other: ' + otherReclassified);
  console.log('Missing master entries: ' + globalMissing.size);
  console.log('\nColor combinations:');
  Object.entries(summary.color_combinations).forEach(function(e) {
    var k = e[0], v = e[1];
    console.log('  ' + String(v).padStart(3) + ' (' + ((v / standings.length) * 100).toFixed(1) + '%)  ' + k);
  });
  console.log('\nEnriched deck types:');
  Object.entries(summary.enriched_deck_types).forEach(function(e) {
    var k = e[0], v = e[1];
    console.log('  ' + String(v).padStart(3) + ' (' + ((v / standings.length) * 100).toFixed(1) + '%)  ' + k);
  });
  console.log('\nSaved:');
  console.log('  ' + outPath);
  console.log('  ' + summaryPath);
}

main();
