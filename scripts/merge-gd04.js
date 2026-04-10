const fs = require('fs');

const master = JSON.parse(fs.readFileSync('data/cards_master.json', 'utf8'));
const gd04raw = JSON.parse(fs.readFileSync('data/gd04_cards.json', 'utf8'));

function convertToMasterFormat(card) {
  const result = {
    id: card.id,
    name_jp: card.name_jp,
    rarity: card.rarity,
    card_type: card.card_type,
    color: card.color,
    level: card.level,
    cost: card.cost,
    traits: card.traits || [],
    stats: { ap: card.ap, hp: card.hp },
  };
  if (card.source_title) result.source_title = card.source_title;
  if (card.link_condition && card.link_condition.trim()) {
    const matches = card.link_condition.match(/\u300c([^\u300d]+)\u300d/g);
    if (matches) result.link = matches.map(m => m.replace(/[\u300c\u300d]/g, ''));
  }
  if (card.effect && card.effect.trim()) {
    result.effect = card.effect;
    const tagMatches = card.effect.match(/\u3010([^\u3011]+)\u3011/g);
    if (tagMatches) result.effect_tags = [...new Set(tagMatches.map(t => t.replace(/[\u3010\u3011]/g, '')))];
  }
  if (card.burst && card.burst.trim()) result.burst = card.burst;
  if (card.terrain && card.terrain.trim()) result.terrain = card.terrain;
  return result;
}

const nonGD04 = {};
for (const [k, v] of Object.entries(master)) {
  if (!k.startsWith('GD04')) nonGD04[k] = v;
}

const gd04Entries = {};
for (const card of gd04raw) {
  gd04Entries[card.id] = convertToMasterFormat(card);
}

const merged = { ...nonGD04, ...gd04Entries };
const sorted = {};
Object.keys(merged).sort((a, b) => a.localeCompare(b)).forEach(k => { sorted[k] = merged[k]; });

const totalBefore = Object.keys(master).length;
const gd04Before = Object.keys(master).filter(k => k.startsWith('GD04')).length;
const totalAfter = Object.keys(sorted).length;
const gd04After = Object.keys(sorted).filter(k => k.startsWith('GD04')).length;

fs.writeFileSync('data/cards_master.json', JSON.stringify(sorted, null, 2), 'utf8');
console.log('Before: ' + totalBefore + ' cards (GD04: ' + gd04Before + ')');
console.log('After:  ' + totalAfter + ' cards (GD04: ' + gd04After + ')');
if (totalAfter !== 614) console.error('Warning: Expected 614 total, got ' + totalAfter);
else console.log('OK: 614 cards total');
if (gd04After !== 88) console.error('Warning: Expected 88 GD04, got ' + gd04After);
else console.log('OK: 88 GD04 cards (GD04-001~088)');
