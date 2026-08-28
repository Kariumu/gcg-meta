#!/usr/bin/env node
/**
 * regenerate-article.js — 手動補完後の記事再生成スクリプト(指示書37、2026-05-17)
 *
 * 使用シナリオ:
 *   1. auto-news.js が認識精度問題で停止(process.exit(1))
 *   2. 松岡さんが data/cards_preview.json を手動修正
 *      - 問題カードの color / cost / ap / hp 等を補完
 *      - _pendingReview を false に変更
 *   3. 本スクリプト実行 → 記事再生成 → git push → (TEST_MODE=false なら) X 投稿
 *
 * 起動例:
 *   node scripts/regenerate-article.js --date 2026-05-09
 *     → 記事生成 + git push + X 投稿(.env の TEST_MODE 参照、デフォルト true で X 投稿スキップ)
 *
 *   node scripts/regenerate-article.js --date 2026-05-09 --dry-run
 *     → 記事生成のみ(ローカル保存)、git push + X 投稿スキップ
 *
 *   node scripts/regenerate-article.js --date 2026-05-09 --no-test-mode
 *     → 記事生成 + git push + X 投稿(本番)
 *
 * 関数の再利用:
 *   auto-news.js の module.exports(指示書37 で公開された関数群)を require して再利用
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const fs = require('fs');
const path = require('path');

// auto-news.js から関数を import(指示書37 で module.exports 拡張済)
const autoNews = require(path.resolve(__dirname, '..', 'auto-news.js'));
const {
  loadCardsMaster,
  loadSummary,
  loadCardsPreview,
  buildUnifiedCardDB,
  generateIntroText,
  generateCardAnalyses,
  findRelatedCards,
  assembleCardArticleHtml,
  generateNewsPage,
  generateTweetText,
  gitPush,
  postTweet,
  formatExpansionName,
  log,
  // 同日リンク組合せ検出(2026-05-24 追加)
  detectSameDayLinkPairs,
  // コンボ評価(2026-05-25 追加 / §6 Step 5)
  // 注: loadCardsMaster は既に上で import 済(行 34 付近)
  findComboCandidates,
  evaluateComboCandidates,
  writeComboCandidatesReport,
  ANTHROPIC_MODEL_OPUS,
  // ルール解説評価(2026-05-26 追加 / 新機能 Phase 5)
  evaluateRuleClarifications,
  writeRuleClarificationsReport,
} = autoNews;

const ROOT = path.resolve(__dirname, '..');
const NEWS_DIR = path.join(ROOT, 'reports', 'news');
const SITE_URL = 'https://gcg-stats.com';

// === 引数解析 ===
function parseArgs() {
  const args = process.argv.slice(2);
  const dateIdx = args.indexOf('--date');
  if (dateIdx === -1 || dateIdx + 1 >= args.length) {
    console.error('Usage: node scripts/regenerate-article.js --date YYYY-MM-DD [--dry-run] [--no-test-mode] [--test-mode]');
    process.exit(2);
  }
  const date = args[dateIdx + 1];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(`[FATAL] --date の形式が不正: ${date}`);
    console.error('  期待形式: YYYY-MM-DD');
    process.exit(2);
  }
  const isDryRun = args.includes('--dry-run');
  // TEST_MODE 優先順位(auto-news.js と同じ):
  //   --no-test-mode > --test-mode > 環境変数 > デフォルト(true、安全側 = X 投稿スキップ)
  const testMode = (
    args.includes('--no-test-mode') ? false :
    args.includes('--test-mode') ? true :
    process.env.AUTO_NEWS_TEST_MODE === 'false' ? false :
    process.env.AUTO_NEWS_TEST_MODE === 'true' ? true :
    true
  );
  return { date, isDryRun, testMode };
}

async function main() {
  const { date: articleDate, isDryRun, testMode } = parseArgs();

  log('=== regenerate-article 開始 ===');
  log(`DRY_RUN: ${isDryRun}`);
  log(`TEST_MODE: ${testMode} (X 投稿は ${testMode ? 'スキップ' : '実行'})`);
  log(`対象日付: ${articleDate}`);

  // === 1. cards_preview.json を読み込み ===
  const allPreviewCards = loadCardsPreview();
  const allEntries = Object.values(allPreviewCards);
  log(`cards_preview.json: ${allEntries.length} エントリ`);

  // === 2. 対象日付のカードを抽出 ===
  const targetCards = allEntries.filter(c =>
    c._articleDate === articleDate && c._pendingReview !== true
  );
  const pendingCards = allEntries.filter(c =>
    c._articleDate === articleDate && c._pendingReview === true
  );

  log(`対象カード(認識成功・補完済): ${targetCards.length} 件`);
  if (pendingCards.length > 0) {
    log(`保留カード(_pendingReview = true、再生成から除外): ${pendingCards.length} 件`);
    pendingCards.forEach(c => {
      const issues = (c._pendingReviewIssues || []).join(', ');
      log(`  - ${c.card_number || 'NO_NUMBER'} (${c.card_name || 'NO_NAME'}): ${issues}`);
    });
    log('  → これらのカードは記事に含まれません。補完が必要なら cards_preview.json を編集してください。');
  }

  if (targetCards.length === 0) {
    log('対象カードなし。終了します。');
    log('対象なしの場合の確認事項:');
    log('  1. cards_preview.json のエントリに _articleDate が ' + articleDate + ' と一致するか');
    log('  2. _pendingReview が false(または未設定)であるか');
    process.exit(1);
  }

  // === 3. cards_preview の構造を cardInfo 形式に変換 ===
  const cardInfoList = targetCards.map(c => ({
    card_number: c.card_number,
    card_name: c.card_name,
    color: c.color,
    card_type: c.card_type,
    level: c.level,
    cost: c.cost,
    ap: c.ap,
    hp: c.hp,
    terrain: c.terrain || [],
    traits: c.traits || [],
    link: c.link || '',
    rarity: c.rarity,
    effect: c.effect || '',
    // 2026-08-28: cards_preview.json の既存エントリには expansion が保存されていないため、
    // card_number の接頭辞(例 GD06-130 → GD06)からフォールバックで復元する。
    // トークン(T-029 等)はセット名に含めない扱いのため、意図的に対象外(null のまま)。
    expansion: c.expansion || (String(c.card_number || '').match(/^([A-Z]{2}\d{2})-/) || [])[1] || null,
    release_date: c.release_date || null,
    _tweetUrl: c.source_url || '',
    _localImagePath: c._localImagePath || null,
  }));

  // === 4. 関連カード検索用 DB 構築 ===
  const cardsMaster = loadCardsMaster();
  const summary = loadSummary();
  const unifiedDB = buildUnifiedCardDB(cardsMaster);

  // === 5. 関連カードを集約 ===
  const allRelated = [];
  for (const ci of cardInfoList) {
    const related = findRelatedCards(ci, unifiedDB, summary);
    allRelated.push(...related);
  }
  const uniqueRelated = [];
  const seenIds = new Set();
  for (const r of allRelated) {
    if (!seenIds.has(r.card_id)) {
      seenIds.add(r.card_id);
      uniqueRelated.push(r);
    }
  }

  // === 6. 拡張コードの動的決定 ===
  const expansionCounts = {};
  cardInfoList.forEach(c => {
    // 2026-08-28: auto-news.js と同様、集計前にパック名へ正規化する
    // (formatExpansionName が sets_meta.json を参照する正規化関数になっている)。
    const label = formatExpansionName(c && c.expansion);
    if (label) {
      expansionCounts[label] = (expansionCounts[label] || 0) + 1;
    }
  });
  const dominantExpansion = Object.keys(expansionCounts).length > 0
    ? Object.keys(expansionCounts).sort((a, b) => expansionCounts[b] - expansionCounts[a])[0]
    : null;
  const expansionName = formatExpansionName(dominantExpansion);

  // === 6b. タイトル/desc 用セット表記(2026-08-28: auto-news.js と形式を統一)===
  // auto-news.js:2468 の titleExpansionLabel と同一ロジック。
  // セットが1種のみ → formatExpansionName の長い名称
  // 2種以上の混在日 → セットコードを「+」連結(枚数降順、同数はコード昇順)
  // これが無いと同じ日でも夜間バッチと再生成でタイトル形式が食い違う。
  const titleExpansionLabel = Object.keys(expansionCounts).length >= 2
    ? Object.keys(expansionCounts)
        .sort((a, b) => expansionCounts[b] - expansionCounts[a] || a.localeCompare(b))
        .join('+')
    : expansionName;

  // === 7. 導入文 + 考察生成(Claude API、Opus)===
  // 同日公開でリンク条件成立した UNIT×PILOT 組合せを検出(2026-05-24 追加)
  const sameDayLinkPairs = detectSameDayLinkPairs(cardInfoList);
  if (sameDayLinkPairs.length > 0) {
    log(`同日リンク組合せ検出: ${sameDayLinkPairs.length} 組`);
    sameDayLinkPairs.forEach(p => {
      const pilotNames = p.pilots.map(pi => pi.card_number).join(', ');
      log(`  - UNIT ${p.unit.card_number} ⇔ PILOT ${pilotNames}`);
    });
  }

  let introHtml;
  try {
    introHtml = await generateIntroText(cardInfoList, uniqueRelated.slice(0, 10), articleDate, sameDayLinkPairs);
  } catch (e) {
    log(`導入文生成失敗: ${e.message}`);
    introHtml = `<p>${expansionName || ''}から新カード${cardInfoList.length}枚が公開されました。</p>`;
  }

  let cardAnalyses = {};
  try {
    cardAnalyses = await generateCardAnalyses(cardInfoList, uniqueRelated.slice(0, 10), sameDayLinkPairs);
  } catch (e) {
    log(`考察生成失敗: ${e.message}`);
  }

  // === 8. HTML 組立 ===
  const tweetUrls = [...new Set(cardInfoList.map(c => c._tweetUrl).filter(Boolean))];
  const articleHtml = assembleCardArticleHtml(
    introHtml,
    cardInfoList,
    cardAnalyses,
    uniqueRelated.slice(0, 10),
    tweetUrls,
    unifiedDB,
    summary,
    articleDate
  );

  // === 9. ページ全体 HTML 生成 + ファイル保存 ===
  const cardCount = cardInfoList.length;
  // YYYY-MM-DD → 「M/D」(dateLabel 相当)
  const m = articleDate.match(/^\d{4}-(\d{2})-(\d{2})$/);
  const dateLbl = m ? `${parseInt(m[1])}/${parseInt(m[2])}` : articleDate;
  const title = `【${dateLbl}公開】${titleExpansionLabel || ''} 新カード${cardCount}枚まとめ`;
  const desc = `ガンダムカードゲーム${titleExpansionLabel || ''}から公開された新カード${cardCount}枚の紹介と環境考察。`;
  const pageHtml = generateNewsPage(articleDate, title, desc, articleHtml, {
    displayDate: articleDate.replace(/-/g, '.')
  });

  if (!fs.existsSync(NEWS_DIR)) fs.mkdirSync(NEWS_DIR, { recursive: true });
  const filePath = path.join(NEWS_DIR, `${articleDate}.html`);
  fs.writeFileSync(filePath, pageHtml, { encoding: 'utf-8' });
  log(`記事保存: ${filePath}`);

  // === 9.5. Phase 3: post-processing 呼び出し ===
  // auto-news.js Phase 3(指示書41、2026-05-19)と同等の処理を実行
  // カード個別ページ作成 + 画像配置 + index.html「ニュース・速報」更新を行う
  // cardInfoList は既に _pendingReview !== true のカードのみ(line 96-97 で除外済)
  try {
    const successCardNumbers = cardInfoList
      .map(c => c.card_number)
      .filter(cn => typeof cn === 'string' && cn.length > 0);

    if (successCardNumbers.length > 0) {
      log(`[Phase 3] post-processing 開始: ${successCardNumbers.length} 件 (${successCardNumbers.join(', ')})`);
      try {
        const { postProcess } = require('./post-processing');
        const result = await postProcess({
          date: articleDate,
          cardNumbers: successCardNumbers,
          dryRun: isDryRun,
        });
        log(`[Phase 3] post-processing 完了: ${JSON.stringify(result)}`);
      } catch (err) {
        // ★ post-processing エラーは記事生成本体を中断しない(auto-news.js と同方針)★
        log(`[Phase 3] post-processing エラー: ${err.message}`);
        if (err.stack) console.error(err.stack);
      }
    } else {
      log(`[Phase 3] post-processing スキップ: 対象カード 0 件`);
    }
  } catch (outerErr) {
    log(`[Phase 3] post-processing 前処理エラー: ${outerErr.message}`);
  }

  // === Phase 4: コンボ候補評価 + レポート出力(2026-05-25 追加 / §6 Step 5)===
  // auto-news.js Phase 4 と同等の処理。安全装置:
  //   1. デフォルト無効(API コスト保護)。--enable-combo-eval / ENABLE_COMBO_EVAL=true で有効化
  //   2. 評価対象カード数の上限ガード(--combo-eval-max-cards N、デフォルト 5)
  //   3. Phase 4 内のエラーは catch して記事生成本体を中断しない
  try {
    const enableComboEval =
      process.argv.includes('--enable-combo-eval') ||
      process.env.ENABLE_COMBO_EVAL === 'true';

    // 注: 0 や負数を指定した場合はデフォルト 5 にフォールバック
    let comboEvalMaxCards = 5;
    const maxCardsIdx = process.argv.indexOf('--combo-eval-max-cards');
    if (maxCardsIdx !== -1 && process.argv[maxCardsIdx + 1]) {
      const n = parseInt(process.argv[maxCardsIdx + 1], 10);
      if (!isNaN(n) && n > 0) comboEvalMaxCards = n;
    } else if (process.env.COMBO_EVAL_MAX_CARDS) {
      const n = parseInt(process.env.COMBO_EVAL_MAX_CARDS, 10);
      if (!isNaN(n) && n > 0) comboEvalMaxCards = n;
    }

    if (!enableComboEval) {
      log('[Phase 4] コンボ評価スキップ(--enable-combo-eval または ENABLE_COMBO_EVAL=true で有効化)');
    } else if (!Array.isArray(cardInfoList) || cardInfoList.length === 0) {
      log('[Phase 4] コンボ評価スキップ: 対象カード 0 件');
    } else {
      // dry-run + コンボ評価併用時の課金注意喚起
      if (isDryRun) {
        log('[Phase 4] ⚠️ --dry-run と --enable-combo-eval 併用: git push と X 投稿はスキップされますが、Claude API への課金は発生します');
      }

      const evalTargets = cardInfoList.slice(0, comboEvalMaxCards);
      const skipped = cardInfoList.length - evalTargets.length;
      log(`[Phase 4] コンボ評価開始: 評価対象 ${evalTargets.length} 件${skipped > 0 ? ` (上限 ${comboEvalMaxCards} のため ${skipped} 件スキップ・残カードは sameDayCards として参照のみ)` : ''}`);

      const cardsMasterLocal = loadCardsMaster();
      const comboResultsMap = {};
      for (const card of evalTargets) {
        try {
          // sameDayCards は cardInfoList 全体から自身を除いたものを使用(独立レビュー推奨修正 2)
          const candidates = findComboCandidates(card, cardsMasterLocal, {
            maxCandidates: 80,
            sameDayCards: cardInfoList.filter(c => c.card_number !== card.card_number)
          });
          const evalResult = await evaluateComboCandidates(card, candidates, {
            model: ANTHROPIC_MODEL_OPUS,
            topN: 30
          });
          comboResultsMap[card.card_number] = evalResult;
          log(`[Phase 4]   ${card.card_number}: combos=${evalResult.combos.length}, uncertain=${evalResult.uncertain.length}${evalResult.parseError ? ', error=' + evalResult.parseError : ''}`);
        } catch (e) {
          log(`[Phase 4]   ${card.card_number} 評価失敗(処理続行): ${e.message}`);
          comboResultsMap[card.card_number] = { combos: [], uncertain: [], rawResponse: '', parseError: e.message };
        }
      }

      try {
        const result = writeComboCandidatesReport(articleDate, comboResultsMap, evalTargets);
        log(`[Phase 4] レポート出力: ${result.mdPath}${result.logPath ? ' (+ ' + result.logPath + ')' : ''}`);
      } catch (writeErr) {
        log(`[Phase 4] レポート書き出しエラー(処理続行): ${writeErr.message}`);
      }
    }
  } catch (outerErr) {
    log(`[Phase 4] コンボ評価エラー(処理続行): ${outerErr.message}`);
  }

  // === Phase 5: ルール解説評価 + レポート出力(2026-05-26 追加 / 新機能)===
  // auto-news.js Phase 5 と同等。安全装置:
  //   1. デフォルト無効(--enable-rule-clarification / ENABLE_RULE_CLARIFICATION=true で有効化)
  //   2. 上限ガード(--rule-clarification-max-cards N、デフォルト 5)
  //   3. Phase 5 内のエラーは catch して記事生成本体を中断しない
  try {
    const enableRuleClar =
      process.argv.includes('--enable-rule-clarification') ||
      process.env.ENABLE_RULE_CLARIFICATION === 'true';

    let ruleClarMaxCards = 5;
    const maxIdx = process.argv.indexOf('--rule-clarification-max-cards');
    if (maxIdx !== -1 && process.argv[maxIdx + 1]) {
      const n = parseInt(process.argv[maxIdx + 1], 10);
      if (!isNaN(n) && n > 0) ruleClarMaxCards = n;
    } else if (process.env.RULE_CLARIFICATION_MAX_CARDS) {
      const n = parseInt(process.env.RULE_CLARIFICATION_MAX_CARDS, 10);
      if (!isNaN(n) && n > 0) ruleClarMaxCards = n;
    }

    if (!enableRuleClar) {
      log('[Phase 5] ルール解説評価スキップ(--enable-rule-clarification または ENABLE_RULE_CLARIFICATION=true で有効化)');
    } else if (!Array.isArray(cardInfoList) || cardInfoList.length === 0) {
      log('[Phase 5] ルール解説評価スキップ: 対象カード 0 件');
    } else {
      if (isDryRun) {
        log('[Phase 5] ⚠️ --dry-run と --enable-rule-clarification 併用: git push と X 投稿はスキップされますが、Claude API への課金は発生します');
      }

      const targets = cardInfoList.slice(0, ruleClarMaxCards);
      const skipped = cardInfoList.length - targets.length;
      log(`[Phase 5] ルール解説評価開始: 評価対象 ${targets.length} 件${skipped > 0 ? ` (上限 ${ruleClarMaxCards} のため ${skipped} 件スキップ)` : ''}`);

      let qaDb = null;
      try {
        const qaPath = path.join(ROOT, 'data', 'qa_database.json');
        if (fs.existsSync(qaPath)) {
          qaDb = JSON.parse(fs.readFileSync(qaPath, 'utf-8'));
          log(`[Phase 5] qa_database.json ロード成功 (${qaDb.total_count || 0} 件)`);
        } else {
          log('[Phase 5] qa_database.json 未存在(関連 Q&A 参照なしで進行)');
        }
      } catch (e) {
        log(`[Phase 5] qa_database.json ロード失敗: ${e.message}`);
      }

      const clarMap = {};
      for (const card of targets) {
        try {
          const result = await evaluateRuleClarifications(card, qaDb, {
            model: ANTHROPIC_MODEL_OPUS
          });
          clarMap[card.card_number] = result;
          log(`[Phase 5]   ${card.card_number}: clarifications=${result.clarifications.length}${result.parseError ? ', error=' + result.parseError : ''}`);
        } catch (e) {
          log(`[Phase 5]   ${card.card_number} 評価失敗(処理続行): ${e.message}`);
          clarMap[card.card_number] = { clarifications: [], rawResponse: '', parseError: e.message };
        }
      }

      try {
        const r = writeRuleClarificationsReport(articleDate, clarMap, targets);
        log(`[Phase 5] レポート出力: ${r.mdPath}${r.logPath ? ' (+ ' + r.logPath + ')' : ''}`);
      } catch (writeErr) {
        log(`[Phase 5] レポート書き出しエラー(処理続行): ${writeErr.message}`);
      }
    }
  } catch (outerErr) {
    log(`[Phase 5] ルール解説評価エラー(処理続行): ${outerErr.message}`);
  }

  // === 10. git push + X 投稿(DRY_RUN ガード付き)===
  if (isDryRun) {
    log('[DRY_RUN] git push スキップ');
    log(`[DRY_RUN] X 投稿スキップ。記事URL: ${SITE_URL}/reports/news/${articleDate}.html`);
  } else {
    // git push
    const generatedFiles = [
      { repoPath: `reports/news/${articleDate}.html`, binary: false },
      { repoPath: 'data/cards_preview.json', binary: false },
    ];
    // 画像ファイルも追跡(_localImagePath が設定されている場合)
    for (const ci of cardInfoList) {
      if (ci._localImagePath) {
        const imgAbs = path.resolve(NEWS_DIR, ci._localImagePath);
        if (fs.existsSync(imgAbs)) {
          const imgRepoPath = path.relative(ROOT, imgAbs).replace(/\\/g, '/');
          generatedFiles.push({ repoPath: imgRepoPath, binary: true });
        }
      }
    }
    try {
      await gitPush(`regenerate-article: ${articleDate}`, generatedFiles);
    } catch (e) {
      log(`git push 失敗: ${e.message}`);
    }

    // X 投稿
    const articleUrl = `${SITE_URL}/reports/news/${articleDate}.html`;
    if (testMode) {
      log(`[TEST_MODE] X 投稿スキップ。記事URL: ${articleUrl}`);
    } else {
      try {
        const cardNames = cardInfoList.map(c => c.card_name).join('、');
        const tweetText = await generateTweetText('new_card', { cardNames, url: articleUrl });
        await postTweet(tweetText);
        log(`X 投稿成功(または送信完了): ${articleUrl}`);
      } catch (e) {
        log(`X 投稿失敗: ${e.message}`);
      }
    }
  }

  log('=== regenerate-article 完了 ===');
}

main().catch(e => {
  console.error(`[regenerate-article] 致命的エラー: ${e.message}`);
  console.error(e);
  process.exit(1);
});
