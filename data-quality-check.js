#!/usr/bin/env node
/**
 * GCG STATS データ品質チェック
 * scraper.js 実行後に実行し、データの欠損・不整合を検出する
 *
 * Usage:
 *   node data-quality-check.js              # チェックのみ
 *   node data-quality-check.js --refetch    # 欠損データの再取得も実行
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const DATA_DIR = path.join(__dirname, 'data');
const BASE_URL = 'https://www.gundam-gcg.com/jp';
const TOURNAMENT_URL = `${BASE_URL}/tournament-results/`;
const USER_AGENT = 'GCG-META-FanSite/1.0 (非公式ファンサイト)';
const DELAY_MS = 3000; // 公式サイトへのアクセス間隔（3秒以上）
const LOG_FILE = path.join(DATA_DIR, 'quality-check-log.txt');

const doRefetch = process.argv.includes('--refetch');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function fetchHTML(url) {
  try {
    return execSync(
      `curl -s -L --max-time 30 -H "User-Agent: ${USER_AGENT}" "${url}"`,
      { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    );
  } catch (e) {
    console.error(`  [ERROR] fetch failed: ${url}`, e.message);
    return null;
  }
}

function now() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ============================
// チェック結果の収集
// ============================
const results = [];
const warnings = [];

function ok(label, msg) {
  const line = `[OK] ${label}: ${msg}`;
  console.log(line);
  results.push(line);
}

function warn(label, msg, details) {
  const line = `[WARNING] ${label}: ${msg}`;
  console.warn('\x1b[33m' + line + '\x1b[0m');
  results.push(line);
  warnings.push(line);
  if (details && details.length > 0) {
    details.forEach(d => {
      console.warn('  ' + d);
      results.push('  ' + d);
      warnings.push('  ' + d);
    });
  }
}

// ============================
// メイン処理
// ============================
async function main() {
  console.log('=== GCG STATS データ品質チェック ===');
  console.log(`実行日時: ${now()}\n`);

  // データ読み込み
  const eventsData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'events.json'), 'utf-8'));
  const summaryData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'summary.json'), 'utf-8'));
  const allEvents = Object.values(eventsData.events);
  const eventIds = Object.keys(eventsData.events);

  // ① イベント数の一致確認（公式サイト vs events.json）
  console.log('--- ① イベント数の一致確認 ---');
  let officialEventIds = [];
  try {
    const html = fetchHTML(TOURNAMENT_URL);
    if (html) {
      const cheerio = require('cheerio');
      const $ = cheerio.load(html);
      $('a.shopListDetailInner').each((_, el) => {
        const href = $(el).attr('href') || '';
        const eventMatch = href.match(/event=(\d+)/);
        if (eventMatch) officialEventIds.push(eventMatch[1]);
      });

      if (officialEventIds.length === eventIds.length) {
        ok('イベント数', `一致（公式${officialEventIds.length}件 = events.json ${eventIds.length}件）`);
      } else {
        const missing = officialEventIds.filter(id => !eventIds.includes(id));
        const extra = eventIds.filter(id => !officialEventIds.includes(id));
        const details = [];
        if (missing.length > 0) details.push(`未取得: ${missing.join(', ')}`);
        if (extra.length > 0) details.push(`公式に存在しない: ${extra.join(', ')}`);
        warn('イベント数', `不一致（公式${officialEventIds.length}件 ≠ events.json ${eventIds.length}件、差分: ${Math.abs(officialEventIds.length - eventIds.length)}件）`, details);
      }
    } else {
      warn('イベント数', '公式サイトの取得に失敗しました');
    }
  } catch (e) {
    warn('イベント数', `チェック中にエラー: ${e.message}`);
  }

  await sleep(DELAY_MS);

  // ② デッキ数0のイベント検出
  console.log('\n--- ② デッキデータなしのイベント検出 ---');
  const noResults = allEvents.filter(ev => !ev.results || ev.results.length === 0);
  const noDeck = [];
  allEvents.forEach(ev => {
    (ev.results || []).filter(r => r.rank <= 4).forEach(r => {
      if (!r.deck || r.deck.length === 0) {
        noDeck.push({ event_id: ev.event_id, date: ev.date, store: ev.store, rank: r.rank, player: r.player });
      }
    });
  });

  if (noResults.length === 0) {
    ok('結果データなし', '0件');
  } else {
    warn('結果データなし', `${noResults.length}件`, noResults.map(ev =>
      `${ev.event_id} (${ev.date} ${ev.store})`
    ));
  }

  if (noDeck.length === 0) {
    ok('デッキデータなし', '0件');
  } else {
    warn('デッキデータなし', `${noDeck.length}件`, noDeck.map(d =>
      `${d.event_id} (${d.date} ${d.store}) rank:${d.rank} ${d.player}`
    ));
  }

  // ③ デッキ枚数の異常検出（GCGは50枚固定）
  console.log('\n--- ③ デッキ枚数の異常検出 ---');
  const abnormalDecks = [];
  allEvents.forEach(ev => {
    (ev.results || []).forEach(r => {
      if (!r.deck || r.deck.length === 0) return;
      const total = r.deck.reduce((sum, c) => sum + c.count, 0);
      if (total !== 50) {
        abnormalDecks.push({
          event_id: ev.event_id, date: ev.date, store: ev.store,
          rank: r.rank, player: r.player, total
        });
      }
    });
  });

  if (abnormalDecks.length === 0) {
    ok('カード枚数異常', '0件');
  } else {
    warn('カード枚数異常', `${abnormalDecks.length}件`, abnormalDecks.map(d =>
      `イベント${d.event_id} プレイヤー「${d.player}」: ${d.total}枚（${d.total < 50 ? (50 - d.total) + '枚不足' : (d.total - 50) + '枚超過'}）`
    ));
  }

  // ④ summary.jsonとevents.jsonの整合性
  console.log('\n--- ④ summary.json整合性チェック ---');
  const calcTotalEvents = allEvents.length;
  let calcTotalDecks = 0;
  allEvents.forEach(ev => {
    (ev.results || []).filter(r => r.rank <= 4).forEach(r => {
      if (r.deck && r.deck.length > 0) calcTotalDecks++;
    });
  });

  if (summaryData.total_events === calcTotalEvents) {
    ok('総イベント数', `一致（${calcTotalEvents}件）`);
  } else {
    warn('総イベント数', `不一致（summary.json=${summaryData.total_events} ≠ 計算値=${calcTotalEvents}）`);
  }

  if (summaryData.total_decks === calcTotalDecks) {
    ok('総デッキ数', `一致（${calcTotalDecks}件）`);
  } else {
    warn('総デッキ数', `不一致（summary.json=${summaryData.total_decks} ≠ 計算値=${calcTotalDecks}）`);
  }

  // ⑤ 公式サイトでの結果更新確認（欠損イベントの再チェック）
  console.log('\n--- ⑤ 公式サイトでの結果更新確認 ---');
  const missingEvents = [
    ...noResults.map(ev => ({ event_id: ev.event_id, series_id: ev.series_id, date: ev.date, store: ev.store, type: 'no_results' })),
    ...noDeck.map(d => {
      const ev = eventsData.events[d.event_id];
      return { event_id: d.event_id, series_id: ev.series_id, date: d.date, store: d.store, type: 'no_deck', rank: d.rank, player: d.player };
    })
  ];
  // 重複排除(event_id単位)
  const checkedIds = new Set();
  const toCheck = missingEvents.filter(m => {
    if (checkedIds.has(m.event_id)) return false;
    checkedIds.add(m.event_id);
    return true;
  });

  if (toCheck.length === 0) {
    ok('結果更新確認', '欠損イベントなし');
  } else {
    console.log(`  欠損${toCheck.length}件を公式サイトで再確認中...`);
    let refetched = 0;
    const refetchedList = [];

    for (const item of toCheck) {
      await sleep(DELAY_MS);
      const url = `${BASE_URL}/tournament-results/event.php?series=${item.series_id}&event=${item.event_id}`;
      console.log(`  チェック中: ${item.event_id} (${item.store})...`);

      try {
        const html = fetchHTML(url);
        if (!html) continue;

        const cheerio = require('cheerio');
        const $ = cheerio.load(html);
        const playerItems = $('li.userListDetail');

        if (playerItems.length > 0) {
          // 結果が追加されている
          if (item.type === 'no_results') {
            console.log(`    → 結果が追加されています！（${playerItems.length}名）`);

            if (doRefetch) {
              // 再取得して更新
              const results = [];
              playerItems.each((idx, el) => {
                const rankText = $(el).find('span').first().text();
                const rank = parseInt(rankText.replace(/[^\d]/g, ''), 10) || (idx + 1);
                const player = $(el).find('h4.userInfoName').text().trim();
                const deckLink = $(el).find('a[href*="players_deck"]').attr('href') || '';
                const noMatch = deckLink.match(/no=(\d+)/);
                const deckNo = noMatch ? parseInt(noMatch[1], 10) : idx;
                results.push({ rank, player, deck_no: deckNo, deck: [] });
              });

              // デッキ取得
              for (let i = 0; i < results.length; i++) {
                await sleep(DELAY_MS);
                const deckUrl = `${BASE_URL}/tournament-results/players_deck.php?series=${item.series_id}&event=${item.event_id}&no=${results[i].deck_no}`;
                const deckHtml = fetchHTML(deckUrl);
                if (deckHtml) {
                  const $d = cheerio.load(deckHtml);
                  const cards = [];
                  $d('li').each((_, el2) => {
                    const img = $d(el2).find('img[src*="/cards/card/"]');
                    const countEl = $d(el2).find('span.useCardsNum');
                    if (img.length > 0) {
                      const cardId = img.attr('alt') || '';
                      const count = parseInt(countEl.text().trim(), 10) || 1;
                      if (cardId) cards.push({ card_id: cardId, count });
                    }
                  });
                  results[i].deck = cards;
                  const tcgplus = $d('a[href*="bandai-tcg-plus.com"]').attr('href') || '';
                  if (tcgplus) results[i].tcgplus_url = tcgplus;
                }
              }

              eventsData.events[item.event_id].results = results;
              refetched++;
              refetchedList.push(item.event_id);
              console.log(`    → 再取得完了 (${results.length}名, デッキ${results.filter(r => r.deck.length > 0).length}件)`);
            } else {
              refetchedList.push(item.event_id);
              console.log(`    → --refetch オプションで再取得可能`);
            }
          } else if (item.type === 'no_deck') {
            // デッキなしの場合、該当ランクのデッキリンクを確認
            let found = false;
            playerItems.each((idx, el) => {
              const deckLink = $(el).find('a[href*="players_deck"]').attr('href') || '';
              if (deckLink && !found) {
                const rankText = $(el).find('span').first().text();
                const rank = parseInt(rankText.replace(/[^\d]/g, ''), 10) || (idx + 1);
                if (rank === item.rank) {
                  found = true;
                }
              }
            });
            if (found) {
              console.log(`    → rank ${item.rank} (${item.player}) のデッキリンクが存在`);

              if (doRefetch) {
                await sleep(DELAY_MS);
                const targetResult = (eventsData.events[item.event_id].results || []).find(r => r.rank === item.rank);
                if (targetResult) {
                  const deckUrl = `${BASE_URL}/tournament-results/players_deck.php?series=${item.series_id}&event=${item.event_id}&no=${targetResult.deck_no}`;
                  const deckHtml = fetchHTML(deckUrl);
                  if (deckHtml) {
                    const $d = cheerio.load(deckHtml);
                    const cards = [];
                    $d('li').each((_, el2) => {
                      const img = $d(el2).find('img[src*="/cards/card/"]');
                      const countEl = $d(el2).find('span.useCardsNum');
                      if (img.length > 0) {
                        const cardId = img.attr('alt') || '';
                        const count = parseInt(countEl.text().trim(), 10) || 1;
                        if (cardId) cards.push({ card_id: cardId, count });
                      }
                    });
                    if (cards.length > 0) {
                      targetResult.deck = cards;
                      refetched++;
                      refetchedList.push(`${item.event_id}:rank${item.rank}`);
                      console.log(`    → デッキ再取得完了 (${cards.length}種)`);
                    } else {
                      console.log(`    → デッキデータはまだ空`);
                    }
                  }
                }
              } else {
                console.log(`    → --refetch オプションで再取得可能`);
              }
            } else {
              console.log(`    → まだデータなし`);
            }
          }
        } else {
          console.log(`    → まだ結果なし`);
        }
      } catch (e) {
        console.error(`    → エラー: ${e.message}`);
      }
    }

    if (doRefetch && refetched > 0) {
      ok('結果更新', `${refetched}件再取得 (${refetchedList.join(', ')})`);
      // events.jsonを更新保存
      fs.writeFileSync(path.join(DATA_DIR, 'events.json'), JSON.stringify(eventsData, null, 2), 'utf-8');
      console.log('  → events.json を更新保存しました');
    } else if (refetchedList.length > 0) {
      warn('結果更新可能', `${refetchedList.length}件に更新あり`, [
        `対象: ${refetchedList.join(', ')}`,
        '再取得するには: node data-quality-check.js --refetch'
      ]);
    } else {
      ok('結果更新確認', `${toCheck.length}件チェック済み、更新なし`);
    }
  }

  // ============================
  // missing_data.json 更新
  // ============================
  console.log('\n--- missing_data.json 更新 ---');
  const missing = [];
  for (const ev of Object.values(eventsData.events)) {
    const evResults = ev.results || [];
    if (evResults.length === 0) {
      missing.push({
        event_id: ev.event_id, date: ev.date, store: ev.store,
        region: ev.region || '', type: 'no_results', detail: '結果データ未取得'
      });
      continue;
    }
    for (const r of evResults) {
      if (r.rank > 4) continue;
      if (!r.deck || r.deck.length === 0) {
        missing.push({
          event_id: ev.event_id, date: ev.date, store: ev.store,
          region: ev.region || '', type: 'no_deck',
          detail: `rank ${r.rank} (${r.player || '不明'}) のデッキデータ未取得`
        });
      }
    }
  }
  missing.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  fs.writeFileSync(path.join(DATA_DIR, 'missing_data.json'), JSON.stringify(missing, null, 2), 'utf-8');
  console.log(`  → ${missing.length}件を記録`);

  // ============================
  // ログ出力
  // ============================
  console.log('\n=== チェック完了 ===');
  const summaryLine = warnings.length === 0
    ? `全チェックOK`
    : `WARNING ${warnings.length}件あり`;
  console.log(summaryLine);

  // ログファイルに追記
  const logEntry = [
    `[${now()}] チェック完了`,
    ...results.map(r => '  ' + r),
    ''
  ].join('\n');

  fs.appendFileSync(LOG_FILE, logEntry + '\n', 'utf-8');
  console.log(`\nログ: ${LOG_FILE}`);

  // 終了コード（WARNINGがあっても0で返す = 後続処理は止めない）
  process.exit(0);
}

main().catch(e => {
  console.error('致命的エラー:', e);
  process.exit(1);
});
