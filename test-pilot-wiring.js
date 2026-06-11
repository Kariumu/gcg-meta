// test-pilot-wiring.js — コマンドパイロット「配線」の実走テスト（ホスト用・使い捨て）
// 目的: 認識出力の pilot が本番中間経路 verifyWithMaster→fixRecognitionErrors→validateCardInfo を
//       生き残り、buildCardBlockHtml(C-7) で「パイロット」行＋「HP+0」が描画されるかを実走で確認する。
// 安全性: スクレイプ無し / Vision 無し / Anthropic API 無し / push 無し / 本番 cards_preview.json 非書込。
//         NEWS_OUTPUT_ROOT を一時フォルダに固定し、log() の書込先も隔離する。
// 実行: PS C:\dev\gcg-meta> node test-pilot-wiring.js
// 後始末: 確認後このファイルは削除して構いません。

// ── require より前に隔離 ROOT を設定し data フォルダを作る（log() の ENOENT を防止）──
process.env.NEWS_OUTPUT_ROOT = process.env.NEWS_OUTPUT_ROOT || 'C:/temp/an-pilot-test';
require('fs').mkdirSync(process.env.NEWS_OUTPUT_ROOT + '/data', { recursive: true });

const AN = require('./auto-news.js'); // require.main ガードにより main() は起動しない
const { verifyWithMaster, fixRecognitionErrors, validateCardInfo, buildCardBlockHtml } = AN;

let fails = 0;
function assert(cond, msg, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + msg + (extra !== undefined ? ' [' + JSON.stringify(extra) + ']' : ''));
  if (!cond) fails++;
}

assert(typeof verifyWithMaster === 'function', 'verifyWithMaster 取得');
assert(typeof fixRecognitionErrors === 'function', 'fixRecognitionErrors 取得');
assert(typeof validateCardInfo === 'function', 'validateCardInfo 取得');
assert(typeof buildCardBlockHtml === 'function', 'buildCardBlockHtml 取得');

// 検証済み recognition.json と同形（structureCardWithClaude の出力相当）
const recognized = {
  card_number: 'ST10-015', card_name: '拡散ビーム砲', rarity: 'C',
  card_type: 'COMMAND', level: 3, cost: 1, ap: null, hp: null,
  terrain: [], traits: [], link: null, effect: 'テスト効果',
  color: 'Red', expansion: 'ST10', release_date: '2026-06-27',
  pilot: { name: 'クレア・ヒースロー', traits: ['〔ジージェネ〕', '〔耐久型〕'], ap: 1, hp: 0 }
};

// 本番経路と同じ順序（auto-news.js L2223-2224）
const cardsMaster = {}; // 未発売カード = master 不在
const verified = verifyWithMaster(recognized, cardsMaster);
const fixed = fixRecognitionErrors(verified, cardsMaster);
const validated = validateCardInfo(fixed);

assert(validated.pilot && typeof validated.pilot === 'object', 'pilot が verify→fix→validate を生存');
assert(validated.pilot && validated.pilot.hp === 0, 'pilot.hp===0 を保持（null に落ちない）', validated.pilot && validated.pilot.hp);
assert(validated.pilot && validated.pilot.ap === 1, 'pilot.ap===1', validated.pilot && validated.pilot.ap);
assert(validated.pilot && validated.pilot.name === 'クレア・ヒースロー', 'pilot.name 保持');
assert(validated.pilot && Array.isArray(validated.pilot.traits) && validated.pilot.traits.length === 2, 'pilot.traits 2件', validated.pilot && validated.pilot.traits);
assert(Array.isArray(validated.traits) && validated.traits.length === 0, 'command.traits は [] のまま', validated.traits);
assert(validated.card_type === 'COMMAND', 'card_type=COMMAND');
assert(validated.ap === null && validated.hp === null, 'コマンド本体 ap/hp=null');

// C-7 レンダリング（pilot 行と HP+0 表示）
let html = '';
try {
  html = buildCardBlockHtml(validated, '', [], []);
} catch (e) {
  console.log('NOTE buildCardBlockHtml 例外: ' + e.message);
}
assert(/パイロット/.test(html), 'C-7: HTML に「パイロット」行');
assert(/クレア・ヒースロー/.test(html), 'C-7: HTML に pilot 名');
assert(/HP\+0/.test(html), 'C-7: HTML に「HP+0」（hp=0 が ? にならず描画）');

console.log('\n--- validated.pilot ---');
console.log(JSON.stringify(validated.pilot));
const m = html.match(/<tr><td class="news-card-stat-label">パイロット[\s\S]*?<\/tr>/);
console.log('--- pilot HTML 行 ---');
console.log(m ? m[0].trim() : '(なし)');
console.log('\nRESULT: ' + (fails === 0 ? 'ALL PASS' : fails + ' FAIL(S)'));
process.exit(fails === 0 ? 0 : 1);
