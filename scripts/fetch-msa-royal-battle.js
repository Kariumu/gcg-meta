const https = require('https');
const fs = require('fs');
const path = require('path');

const TOURNAMENT_ID = '69ce86dbd478313a15a39b9b';
const BASE_URL = 'https://play.limitlesstcg.com/api';

// 取得エンドポイント一覧
const endpoints = [
  { name: 'details', path: `/tournaments/${TOURNAMENT_ID}/details` },
  { name: 'standings', path: `/tournaments/${TOURNAMENT_ID}/standings` },
  { name: 'pairings', path: `/tournaments/${TOURNAMENT_ID}/pairings` },
];

function fetchJson(urlPath) {
  return new Promise((resolve, reject) => {
    https.get(BASE_URL + urlPath, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve({ status: res.statusCode, data: json, headers: res.headers });
        } catch (e) {
          resolve({ status: res.statusCode, data: data, headers: res.headers });
        }
      });
    }).on('error', reject);
  });
}

async function main() {
  const outputDir = path.join(__dirname, '..', 'data', 'msa');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  console.log(`=== MSA Royal Battle データ取得 ===`);
  console.log(`Tournament ID: ${TOURNAMENT_ID}`);
  console.log(`Output: ${outputDir}\n`);

  const results = {};

  for (const endpoint of endpoints) {
    console.log(`Fetching ${endpoint.name}...`);
    const result = await fetchJson(endpoint.path);

    if (result.status !== 200) {
      console.log(`  ⚠️ Status ${result.status}`);
      console.log(`  Response: ${JSON.stringify(result.data).slice(0, 200)}`);
      continue;
    }

    // レスポンスヘッダーからレート制限情報
    const rateLimit = {
      remaining: result.headers['x-ratelimit-remaining'],
      reset: result.headers['x-ratelimit-reset'],
    };
    console.log(`  ✅ Success (${Array.isArray(result.data) ? result.data.length + ' items' : 'object'})`);
    console.log(`  Rate limit remaining: ${rateLimit.remaining || 'N/A'}`);

    // ファイル保存
    const filename = `royal-battle-${endpoint.name}.json`;
    const filepath = path.join(outputDir, filename);
    fs.writeFileSync(filepath, JSON.stringify(result.data, null, 2), 'utf8');
    console.log(`  Saved: ${filepath}\n`);

    results[endpoint.name] = result.data;

    // API負荷を考慮して次のリクエストまで1秒待機
    await new Promise(r => setTimeout(r, 1000));
  }

  // サマリレポートを生成
  const summary = {
    fetched_at: new Date().toISOString(),
    tournament_id: TOURNAMENT_ID,
    details: null,
    standings_count: 0,
    pairings_count: 0,
    has_decklists: false,
    deck_types: {},
    players_by_country: {},
  };

  if (results.details) {
    summary.details = {
      name: results.details.name,
      date: results.details.date,
      players: results.details.players,
      organizer: results.details.organizer?.name,
      decklists_enabled: results.details.decklists,
      is_online: results.details.isOnline,
      phases: results.details.phases,
    };
  }

  if (results.standings && Array.isArray(results.standings)) {
    summary.standings_count = results.standings.length;

    // デッキタイプ別集計
    for (const player of results.standings) {
      const deckName = player.deck?.name || 'Unknown';
      summary.deck_types[deckName] = (summary.deck_types[deckName] || 0) + 1;

      // 国別集計
      const country = player.country || 'Unknown';
      summary.players_by_country[country] = (summary.players_by_country[country] || 0) + 1;

      // デッキリスト有無
      if (player.decklist) summary.has_decklists = true;
    }

    // 上位10名
    summary.top10 = results.standings.slice(0, 10).map(p => ({
      placing: p.placing,
      name: p.name,
      country: p.country,
      record: p.record,
      deck: p.deck?.name,
    }));
  }

  if (results.pairings && Array.isArray(results.pairings)) {
    summary.pairings_count = results.pairings.length;

    // ラウンド別マッチ数
    const roundMatches = {};
    for (const match of results.pairings) {
      const key = `phase${match.phase}_round${match.round}`;
      roundMatches[key] = (roundMatches[key] || 0) + 1;
    }
    summary.matches_by_round = roundMatches;
  }

  const summaryPath = path.join(outputDir, 'royal-battle-summary.json');
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`\n=== サマリ ===`);
  console.log(JSON.stringify(summary, null, 2));
  console.log(`\nSummary saved: ${summaryPath}`);
}

main().catch(console.error);
