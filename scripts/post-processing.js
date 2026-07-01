#!/usr/bin/env node
/**
 * post-processing.js — 認識成功カードの後処理(指示書41 Phase 3、2026-05-17)
 *
 * auto-news.js 実行後、認識成功カードに対して以下を自動実行:
 *   1. カード個別ページ作成(cards/{cn}/index.html)
 *   2. カード画像配置(images/cards/{cn}.jpg + .webp)
 *   3. index.html「ニュース・速報」セクション更新(冪等)
 *   4. 一括公開(git-push.js の pushFiles + pushBinaryFile)
 *
 * 注意:
 *   - 記事 HTML(reports/news/{date}.html)と元画像(images/news/{date}/{cn}.jpg)は
 *     auto-news.js の gitPush で既に push 済のため、本 module では push しない
 *   - 冪等性確保: 既存のカードページは上書きしない
 *   - jpg を webp 拡張子で配置(真の webp 変換は別途)
 *   - エラーが発生してもメイン処理は中断しない設計(auto-news.js 側で catch)
 *
 * エクスポート:
 *   module.exports = { postProcess };
 *
 * 関数仕様:
 *   async postProcess({ date, cardNumbers, dryRun }) => Promise<Result>
 */

const fs = require('fs');
const path = require('path');
const { pushFiles, pushBinaryFile } = require(path.resolve(__dirname, '..', 'git-push.js'));

// === 設定 ===
const HOMEPAGE_ROOT = path.resolve(__dirname, '..');
const CARDS_PREVIEW_PATH = path.join(HOMEPAGE_ROOT, 'data', 'cards_preview.json');
const CARDS_DIR = path.join(HOMEPAGE_ROOT, 'cards');
const IMAGES_CARDS_DIR = path.join(HOMEPAGE_ROOT, 'images', 'cards');
const IMAGES_NEWS_DIR = path.join(HOMEPAGE_ROOT, 'images', 'news');
const INDEX_HTML_PATH = path.join(HOMEPAGE_ROOT, 'index.html');

// === ロガー(JST タイムスタンプ)===
function log(msg) {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const pad = n => String(n).padStart(2, '0');
  const ts = `${jst.getUTCFullYear()}-${pad(jst.getUTCMonth() + 1)}-${pad(jst.getUTCDate())} ${pad(jst.getUTCHours())}:${pad(jst.getUTCMinutes())} JST`;
  console.log(`[${ts}] [post-processing] ${msg}`);
}

// === 変換ヘルパー(create-card-pages.js と同等)===
function cardTypeToJa(type) {
  const map = { UNIT: 'ユニット', PILOT: 'パイロット', COMMAND: 'コマンド', BASE: 'ベース' };
  return map[type] || type || '不明';
}

function colorToJa(color) {
  const map = { Blue: '青', Red: '赤', Green: '緑', White: '白', Purple: '紫' };
  return map[color] || color || '不明';
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// === カード個別ページ HTML 生成(create-card-pages.js のテンプレート流用)===
function generateCardPageHtml(cardData) {
  const cn = escapeHtml(cardData.card_number);
  const name = escapeHtml(cardData.card_name || cn);
  const type = escapeHtml(cardTypeToJa(cardData.card_type));
  const color = escapeHtml(colorToJa(cardData.color));
  const desc = `${name}(${cn})のニュータイプチャレンジ大会での採用率は0%。新カードのため大会データはまだありません。色:${color} タイプ:${type}`;

  const statsHtml = [];
  if (cardData.level != null) statsHtml.push(`<span style="margin-right:12px">Lv.${cardData.level}</span>`);
  if (cardData.cost != null) statsHtml.push(`<span style="margin-right:12px">コスト${cardData.cost}</span>`);
  if (cardData.ap != null) statsHtml.push(`<span style="margin-right:12px">AP${cardData.ap}</span>`);
  if (cardData.hp != null) statsHtml.push(`<span style="margin-right:12px">HP${cardData.hp}</span>`);
  const statsLine = statsHtml.join('');

  const traits = Array.isArray(cardData.traits) ? cardData.traits.join('、') : '';
  const link = cardData.link || '';
  const effect = cardData.effect || '';

  // === 収録弾リンク(パンくず用) — Stage 2: generate_cards.js と同一規則(:877,:899-907) ===
  // preview カードは package_set を持たない(cards_preview.json にセット欄なし)ため、
  // card_number 接頭辞から導出(_pN・末尾連番を除去)。GD/EB/ST 等の番号制セットは接頭辞=package_set。
  // 注意: PROMO/β 等は接頭辞≠package_set の場合あり → Stage 0-C の正規化マップで個別対応(未確定)。
  const rawCn = cardData.card_number || '';
  const setPrefix = rawCn.replace(/_p\d+$/, '').replace(/-\d+$/, '');
  const SET_DISPLAY_NAMES = { 'PROMO': 'プロモ' };
  const setLinkValue = (rawCn.match(/^([A-Z]+\d+)-/) || [])[1] || setPrefix;
  const setLinkLabel = SET_DISPLAY_NAMES[setLinkValue] || setLinkValue;
  const setLinkHref = `cards.html?set=${encodeURIComponent(setLinkValue)}`;

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
  <title>${name}(${cn})の大会採用率 | GCG STATS</title>
  <meta name="description" content="${escapeHtml(desc)}">
  <meta property="og:site_name" content="GCG STATS">
  <meta property="og:locale" content="ja_JP">
  <meta property="og:title" content="${name}(${cn})の大会採用率 | GCG STATS">
  <meta property="og:description" content="${escapeHtml(desc)}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="https://gcg-stats.com/cards/${cn}/">
  <meta property="og:image" content="https://gcg-stats.com/images/cards/${cn}.webp">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${name}(${cn})の大会採用率 | GCG STATS">
  <meta name="twitter:description" content="${escapeHtml(desc)}">
  <meta name="twitter:image" content="https://gcg-stats.com/images/cards/${cn}.webp">
  <link rel="canonical" href="https://gcg-stats.com/cards/${cn}/">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "Article",
    "headline": "${name}(${cn})の大会採用率",
    "image": "https://gcg-stats.com/images/cards/${cn}.webp",
    "author": { "@type": "Organization", "name": "GCG STATS" },
    "publisher": { "@type": "Organization", "name": "GCG STATS" }
  }
  </script>
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      {"@type": "ListItem", "position": 1, "name": "ホーム", "item": "https://gcg-stats.com/"},
      {"@type": "ListItem", "position": 2, "name": "カード一覧", "item": "https://gcg-stats.com/cards.html"},
      {"@type": "ListItem", "position": 3, "name": "${escapeHtml(setLinkLabel)}", "item": "https://gcg-stats.com/${setLinkHref}"},
      {"@type": "ListItem", "position": 4, "name": "${name}"}
    ]
  }
  </script>
  <link rel="stylesheet" href="../../css/style.css">
</head>
<body>
  <div id="header"></div>
  <main class="container" style="max-width:900px;margin:20px auto;padding:0 16px">
    <nav class="breadcrumb" style="margin-bottom:12px;font-size:12px;color:var(--text-muted);font-family:var(--font-mono)">
      <a href="../../index.html" style="color:var(--text-muted);text-decoration:none" onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--text-muted)'">ホーム</a>
      <span style="margin:0 6px">›</span>
      <a href="../../cards.html" style="color:var(--text-muted);text-decoration:none" onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--text-muted)'">カード一覧</a>
      <span style="margin:0 6px">›</span>
      <a href="../../${setLinkHref}" style="color:var(--text-muted);text-decoration:none" onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--text-muted)'">${escapeHtml(setLinkLabel)}</a>
      <span style="margin:0 6px">›</span>
      <span style="color:var(--text-secondary)">${name}</span>
    </nav>
    <h1 style="font-family:var(--font-mono);font-size:22px;margin-bottom:4px">${name}</h1>
    <p style="font-family:var(--font-mono);font-size:13px;color:var(--text-muted);margin:0 0 12px">${cn}</p>
    <p style="font-size:13px;color:var(--text-muted);margin:0 0 16px">採用率: 0%(新カードのため大会データなし)</p>
    <img src="../../images/cards/${cn}.webp" alt="${name}"
         style="max-width:280px;border-radius:6px;border:1px solid var(--border)"
         onerror="this.onerror=null;this.src='../../images/cards/${cn}.jpg';this.onerror=function(){this.style.display='none'};">
    <div style="margin-top:16px;font-size:14px">
      <p style="margin:8px 0">色: ${color} ／ タイプ: ${type}</p>
      ${statsLine ? `<p style="margin:8px 0;font-family:var(--font-mono);font-size:13px">${statsLine}</p>` : ''}
      ${traits ? `<p style="margin:8px 0;font-size:13px;color:var(--text-muted)">特徴: ${escapeHtml(traits)}</p>` : ''}
      ${link ? `<p style="margin:8px 0;font-size:13px;color:var(--text-muted)">リンク条件: ${escapeHtml(link)}</p>` : ''}
    </div>
    ${effect ? `<div style="margin-top:16px;padding:12px;background:var(--bg-card);border:1px solid var(--border);border-radius:6px">
      <div style="font-size:12px;color:var(--text-muted);font-family:var(--font-mono);margin-bottom:6px">カードテキスト</div>
      <div style="font-size:13px;line-height:1.6">${escapeHtml(effect)}</div>
    </div>` : ''}
    <p style="margin-top:24px;font-size:13px"><a href="../../" style="color:var(--accent);text-decoration:none">← トップに戻る</a></p>
  </main>
  <div id="footer"></div>
  <script src="../../js/common.js?v=10"></script>
  <script>if (typeof GCG !== 'undefined') GCG.init();</script>
</body>
</html>
`;
}

// === カード個別ページ作成(既存はスキップ、冪等)===
function createCardPage(cn, cardData, dryRun) {
  const cardDir = path.join(CARDS_DIR, cn);
  const cardIndex = path.join(cardDir, 'index.html');

  if (fs.existsSync(cardIndex)) {
    return { created: false, skipped: true, reason: 'existing' };
  }

  if (dryRun) {
    log(`  [DRY_RUN] create: cards/${cn}/index.html`);
    return { created: true, skipped: false, dryRun: true };
  }

  try {
    if (!fs.existsSync(cardDir)) fs.mkdirSync(cardDir, { recursive: true });
    const html = generateCardPageHtml(cardData);
    fs.writeFileSync(cardIndex, html, 'utf8');
    log(`  作成: cards/${cn}/index.html (${html.length} bytes)`);
    return { created: true, skipped: false };
  } catch (e) {
    log(`  ★ ERROR: ページ作成失敗 ${cn}: ${e.message}`);
    return { created: false, skipped: false, error: e.message };
  }
}

// === 画像配置(jpg + webp 両方、images/news/{date}/ → images/cards/)===
function placeImage(cn, articleDate, dryRun) {
  if (!articleDate) {
    log(`  ★ 警告: _articleDate なし、画像配置スキップ: ${cn}`);
    return { placed: 0, skipped: 1 };
  }
  const srcJpg = path.join(IMAGES_NEWS_DIR, articleDate, `${cn}.jpg`);
  if (!fs.existsSync(srcJpg)) {
    log(`  ★ 警告: 元画像不在、スキップ: images/news/${articleDate}/${cn}.jpg`);
    return { placed: 0, skipped: 1 };
  }
  const destJpg = path.join(IMAGES_CARDS_DIR, `${cn}.jpg`);
  const destWebp = path.join(IMAGES_CARDS_DIR, `${cn}.webp`);

  if (dryRun) {
    log(`  [DRY_RUN] copy: images/news/${articleDate}/${cn}.jpg → images/cards/${cn}.jpg + .webp`);
    return { placed: 2, skipped: 0, dryRun: true };
  }

  try {
    if (!fs.existsSync(IMAGES_CARDS_DIR)) fs.mkdirSync(IMAGES_CARDS_DIR, { recursive: true });
    fs.copyFileSync(srcJpg, destJpg);
    fs.copyFileSync(srcJpg, destWebp); // jpg を webp 拡張子で配置
    log(`  画像配置: ${cn}.jpg + ${cn}.webp`);
    return { placed: 2, skipped: 0 };
  } catch (e) {
    log(`  ★ ERROR: 画像配置失敗 ${cn}: ${e.message}`);
    return { placed: 0, skipped: 2, error: e.message };
  }
}

// === index.html「ニュース・速報」セクション更新(冪等)===
// 既存リンクがあればスキップ、なければ最上位に追加(日付の新しい順)
function updateIndexHtml(date, cardNumbers, cardsPreview, dryRun) {
  if (!fs.existsSync(INDEX_HTML_PATH)) {
    log('  ★ 警告: index.html 不在、更新スキップ');
    return { changed: false };
  }
  let html = fs.readFileSync(INDEX_HTML_PATH, 'utf-8');

  const linkPattern = `reports/news/${date}.html`;
  if (html.includes(linkPattern)) {
    log(`  index.html: ${date} のリンク既存、更新スキップ`);
    return { changed: false };
  }

  // 日付ラベル: "YYYY-MM-DD" → "M/D"
  const m = date.match(/^\d{4}-(\d{2})-(\d{2})$/);
  const dateLbl = m ? `${parseInt(m[1])}/${parseInt(m[2])}` : date;

  // タイトル決定
  let titleText;
  if (cardNumbers.length === 1) {
    const cn = cardNumbers[0];
    const card = cardsPreview[cn];
    const name = card ? card.card_name : cn;
    const exp = (cn.match(/^([A-Z]+\d+)-/) || [])[1] || '';
    titleText = exp ? `${exp} 新カード「${name}」` : `新カード「${name}」`;
  } else {
    const expansions = new Set();
    cardNumbers.forEach(cn => {
      const exp = (cn.match(/^([A-Z]+\d+)-/) || [])[1];
      if (exp) expansions.add(exp);
    });
    const expStr = [...expansions].sort().join('+');
    titleText = (expStr ? `${expStr} ` : '') + `新カード${cardNumbers.length}枚まとめ`;
  }

  const newLine = `            <li style="margin-bottom:6px"><a href="reports/news/${date}.html" style="color:var(--accent);text-decoration:none;font-size:14px">【${dateLbl}】${escapeHtml(titleText)}</a></li>`;

  // ニュース・速報セクションの <ul ...> 開始タグを検索 → 直後に挿入
  const sectionStartRe = /(<div class="site-nav-card-title">ニュース・速報<\/div>\s*<ul[^>]*>\s*)/;
  const match = html.match(sectionStartRe);
  if (!match) {
    // 2026-06-13 の v7-p2(commit a994e0eb6)で index.html のトップ記事は articles.json 連動の
    // 動的表示に移行し、静的「ニュース・速報」枠は廃止済み。auto-news は articles.json を更新
    // しているため新記事はホームに動的反映される。この静的更新は不要なので正常スキップ。
    log('  index.html: トップ記事は articles.json 動的表示のため静的ニュース枠の更新は不要（スキップ）');
    return { changed: false };
  }

  if (dryRun) {
    log(`  [DRY_RUN] index.html 追加予定: 【${dateLbl}】${titleText}`);
    return { changed: true, dryRun: true };
  }

  // セクション開始の直後に新リンクを挿入(最新が最上位)
  const replaced = html.replace(sectionStartRe, `${match[0]}${newLine}\n`);
  fs.writeFileSync(INDEX_HTML_PATH, replaced, 'utf-8');
  log(`  index.html 更新: 【${dateLbl}】${titleText} を追加`);
  return { changed: true };
}

// === メイン: postProcess({ date, cardNumbers, dryRun }) ===
async function postProcess({ date, cardNumbers, dryRun = false }) {
  log('=== post-processing 開始 ===');
  log(`日付: ${date}, 対象カード: ${cardNumbers ? cardNumbers.length : 0} 件, DRY_RUN: ${dryRun}`);

  // 入力検証
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    log(`★ ERROR: 不正な date: ${date}`);
    return { error: 'invalid_date', date };
  }
  if (!Array.isArray(cardNumbers) || cardNumbers.length === 0) {
    log('対象カード 0 件、早期 return');
    return { skipped: true, reason: 'no_cards' };
  }

  // cards_preview.json 読込
  let cardsPreview;
  try {
    cardsPreview = JSON.parse(fs.readFileSync(CARDS_PREVIEW_PATH, 'utf8'));
  } catch (e) {
    log(`★ ERROR: cards_preview.json 読込失敗: ${e.message}`);
    return { error: 'preview_read_failed', message: e.message };
  }

  const textFiles = []; // pushFiles 用(HTML、テキスト)
  const binaryFiles = []; // pushBinaryFile 用(画像)
  let pageCreated = 0, pageExisting = 0, imgsPlaced = 0, imgsSkipped = 0;

  // 各カードを処理
  for (const cn of cardNumbers) {
    const cardData = cardsPreview[cn];
    if (!cardData) {
      log(`  cards_preview.json に不在: ${cn}, スキップ`);
      continue;
    }

    // カードページ作成
    const pageResult = createCardPage(cn, cardData, dryRun);
    if (pageResult.created) pageCreated++;
    if (pageResult.skipped) pageExisting++;
    // 既存ファイルでも push 対象に含める(更新時の整合性)
    const cardPagePath = path.join(CARDS_DIR, cn, 'index.html');
    if (pageResult.created || fs.existsSync(cardPagePath)) {
      textFiles.push({
        repoPath: `cards/${cn}/index.html`,
        localPath: cardPagePath,
        existed: pageResult.skipped === true,
      });
    }

    // 画像配置
    const imgResult = placeImage(cn, date, dryRun);
    imgsPlaced += imgResult.placed;
    imgsSkipped += imgResult.skipped;

    for (const ext of ['jpg', 'webp']) {
      const imgPath = path.join(IMAGES_CARDS_DIR, `${cn}.${ext}`);
      if (fs.existsSync(imgPath)) {
        binaryFiles.push({
          repoPath: `images/cards/${cn}.${ext}`,
          localPath: imgPath,
        });
      }
    }
  }

  // index.html 更新
  const indexResult = updateIndexHtml(date, cardNumbers, cardsPreview, dryRun);
  if (indexResult.changed) {
    textFiles.push({ repoPath: 'index.html', localPath: INDEX_HTML_PATH });
  }

  // 一括 push
  const commitMsg = `auto-news post-process: ${date} (${cardNumbers.length} cards)`;
  if (dryRun) {
    log(`[postProcess] [DRY_RUN] commit msg: "${commitMsg}"`);
    log(`[postProcess] [DRY_RUN] HTML files: ${textFiles.length}`);
    textFiles.forEach(f => log(`    - ${f.repoPath}${f.existed ? ' (既存)' : ''}`));
    log(`[postProcess] [DRY_RUN] binary files: ${binaryFiles.length}`);
    binaryFiles.forEach(f => log(`    - ${f.repoPath}`));
  } else {
    if (textFiles.length > 0) {
      try {
        const filesToPush = textFiles.map(f => ({
          path: f.repoPath,
          content: fs.readFileSync(f.localPath, 'utf-8'),
        }));
        await pushFiles(filesToPush, commitMsg);
        log(`HTML push 完了 (${textFiles.length} 件)`);
      } catch (e) {
        log(`★ HTML push 失敗: ${e.message}`);
      }
    }
    for (const f of binaryFiles) {
      try {
        await pushBinaryFile(f.repoPath, f.localPath, `Add ${path.basename(f.repoPath)}`);
        log(`画像 push 完了: ${f.repoPath}`);
      } catch (e) {
        log(`★ 画像 push 失敗 ${f.repoPath}: ${e.message}`);
      }
    }
  }

  const result = {
    date,
    cardNumbers,
    pageCreated, pageExisting,
    imgsPlaced, imgsSkipped,
    textFilesCount: textFiles.length,
    binaryFilesCount: binaryFiles.length,
    indexHtmlChanged: indexResult.changed,
    commitMessage: commitMsg,
    dryRun,
  };
  log(`=== post-processing 完了: pages=${pageCreated}(+既存${pageExisting}) / imgs=${imgsPlaced}(skip ${imgsSkipped}) / pushed text=${textFiles.length} bin=${binaryFiles.length} ===`);
  return result;
}

module.exports = { postProcess };

// === 直接実行サポート(動作確認用)===
// 例: node scripts/post-processing.js --date 2026-05-17 --cards EB01-022 --dry-run
if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const dateIdx = args.indexOf('--date');
    const cardsIdx = args.indexOf('--cards');
    if (dateIdx < 0 || cardsIdx < 0) {
      console.error('Usage: node scripts/post-processing.js --date YYYY-MM-DD --cards CN1,CN2,... [--dry-run]');
      process.exit(2);
    }
    const date = args[dateIdx + 1];
    const cardNumbers = (args[cardsIdx + 1] || '').split(',').map(s => s.trim()).filter(Boolean);
    try {
      const result = await postProcess({ date, cardNumbers, dryRun });
      console.log('\n[Result]', JSON.stringify(result, null, 2));
    } catch (e) {
      console.error('Fatal:', e);
      process.exit(1);
    }
  })();
}

// EOF
// EOF
