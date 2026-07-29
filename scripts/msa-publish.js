#!/usr/bin/env node
/**
 * scripts/msa-publish.js  (2026-07-29)
 * MSA環境レポートの「記事生成 → 検証 → push → X投稿」を1コマンドで実行する。
 *
 * 【役割分担】
 *  - PDFの読解・数値抽出・日本語本文の執筆・新規デッキ名の訳語決定は Cowork(AI) が担当し、
 *    その成果物を tmp/msa-<slug>.json として書き出す。
 *  - 本スクリプトはその JSON を入力に、機械的な工程をすべて引き受ける。
 *
 * 【本スクリプトが行うこと】
 *   1. 入力JSONの検証（必須項目・使用率と試合数の整合・リスト数=試合数x2・X投稿の加重文字数）
 *   2. reports/<slug>.html の生成（既存MSA記事と同一テンプレート）
 *   3. translation-dictionary-v1.md への新規訳語追記（辞書の運用ルールに従う）
 *   4. data/articles.json への追記（冪等）
 *   5. reports/index.html と sitemap.xml の再生成
 *      ※ generate-report.js --index-only → generate-sitemap-extra.js の順は固定。
 *         2026-07-29、この順序を守らずサイトマップから記事62件が一時欠落した事故があるため。
 *   6. 生成物の検証（記事・一覧・マニフェスト・サイトマップの件数回帰チェックを含む）
 *   7. scripts/x-posts/<slug>.txt の作成
 *   8. GitHubへ push（scripts/push-cardlist-update.js を呼び出す）
 *   9. Xへ投稿し、結果を scripts/x-posts/<slug>.txt へ追記したうえで、その記録も push
 *
 * 【安全策】
 *  - 既定は DRY RUN。--build / --publish を明示しない限り一切書き込まない
 *  - 検証に1件でも失敗したら push・投稿は行わない
 *  - x-posts の「投稿状況: 投稿済み」または TWEET ID の存在を検出したら二重投稿を拒否
 *  - サイトマップのURL数が実行前より減っていたら中止（62件欠落事故の再発防止）
 *
 * 【使い方】（E:\GCGSTATS）
 *   node scripts\msa-publish.js msa-gd05-week0                    # DRY RUN（検証のみ・書き込みなし）
 *   node scripts\msa-publish.js msa-gd05-week0 --build            # 生成まで（push・投稿なし）
 *   node scripts\msa-publish.js msa-gd05-week0 --publish          # 生成 + push + X投稿
 *   node scripts\msa-publish.js msa-gd05-week0 --publish --no-post # 生成 + push のみ
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..');
require('dotenv').config({ path: path.join(ROOT, '.env') });

const DATA_DIR = path.join(ROOT, 'data');
const REPORTS_DIR = path.join(ROOT, 'reports');
const XPOST_DIR = path.join(ROOT, 'scripts', 'x-posts');
const DICT_PATH = path.join(ROOT, 'translation-dictionary-v1.md');
const SITEMAP = path.join(ROOT, 'sitemap.xml');

const args = process.argv.slice(2);
const SLUG = args.find((a) => !a.startsWith('--'));
const DO_BUILD = args.includes('--build') || args.includes('--publish');
const DO_PUBLISH = args.includes('--publish');
const NO_POST = args.includes('--no-post');

if (!SLUG) {
  console.error('使い方: node scripts/msa-publish.js <slug> [--build|--publish] [--no-post]');
  console.error('  例: node scripts/msa-publish.js msa-gd05-week0');
  process.exit(1);
}
const INPUT = path.join(ROOT, 'tmp', `${SLUG}.json`);
const HTML_PATH = path.join(REPORTS_DIR, `${SLUG}.html`);
const XPOST_PATH = path.join(XPOST_DIR, `${SLUG}.txt`);

const problems = [];
const ok = (label) => console.log('  OK  ' + label);
const ng = (label) => { problems.push(label); console.log('  NG  ' + label); };
const h = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** 使用率・勝率は小数1桁で固定（JSONの 8.0 が 8 に化けるのを防ぐ） */
const pct = (v) => Number(v).toFixed(1);

/** X の加重文字数（URL=23固定、CJK等=2、その他=1） */
function weightedLength(text) {
  const urls = text.match(/https?:\/\/\S+/g) || [];
  const rest = text.replace(/https?:\/\/\S+/g, '');
  let w = 0;
  for (const ch of rest) {
    const cp = ch.codePointAt(0);
    const wide = (cp >= 0x2E80 && cp <= 0xA4CF) || (cp >= 0xAC00 && cp <= 0xD7FF)
      || (cp >= 0xF900 && cp <= 0xFAFF) || (cp >= 0xFE30 && cp <= 0xFE6F)
      || (cp >= 0xFF00 && cp <= 0xFF60) || (cp >= 0xFFE0 && cp <= 0xFFE6)
      || (cp >= 0x1F300 && cp <= 0x1FAFF);
    w += wide ? 2 : 1;
  }
  return w + 23 * urls.length;
}

// ────────────────────────────── 1. 入力の検証 ──────────────────────────────
function loadAndValidate() {
  if (!fs.existsSync(INPUT)) {
    console.error(`入力が見つかりません: ${INPUT}`);
    console.error('  Cowork に PDF を渡して、この JSON を作成してもらってください。');
    process.exit(1);
  }
  const d = JSON.parse(fs.readFileSync(INPUT, 'utf-8'));
  console.log(`\n[1] 入力の検証: tmp/${SLUG}.json`);

  const required = ['slug', 'title', 'weekLabel', 'setLabel', 'periodText', 'periodShort', 'mode',
    'matches', 'lists', 'publishDate', 'sourcePostTitle', 'sourcePostUrl',
    'description', 'ogDescription', 'leadHtml', 'decks', 'xPost'];
  const missing = required.filter((k) => d[k] === undefined || d[k] === null || d[k] === '');
  missing.length ? ng('必須項目の欠落: ' + missing.join(', ')) : ok('必須項目');

  d.slug === SLUG ? ok('slug の一致') : ng(`slug 不一致: JSON=${d.slug} / 引数=${SLUG}`);
  d.lists === d.matches * 2 ? ok(`リスト数 = 試合数x2 (${d.lists})`) : ng(`リスト数 ${d.lists} ≠ 試合数x2 ${d.matches * 2}`);

  // 使用率 = 試合数 / リスト数 の検算（許容 0.1pt）
  let shareOk = true;
  for (const k of d.decks) {
    const calc = (k.games / d.lists) * 100;
    if (Math.abs(calc - k.share) > 0.1) { shareOk = false; ng(`使用率の検算不一致 ${k.ja}: 記載${k.share}% / 計算${calc.toFixed(2)}%`); }
  }
  if (shareOk) ok(`使用率と試合数の整合（${d.decks.length}デッキ、許容0.1pt）`);

  const ranks = d.decks.map((x) => x.rank).sort((a, b) => a - b);
  ranks.every((r, i) => r === i + 1) ? ok('順位の連番') : ng('順位が 1..N の連番ではありません: ' + ranks.join(','));

  const w = weightedLength(d.xPost);
  w <= 280 ? ok(`X投稿の加重文字数 ${w}/280`) : ng(`X投稿の加重文字数 ${w} が280を超過`);
  d.xPost.includes(`/reports/${SLUG}.html`) ? ok('X投稿に正しい記事URL') : ng('X投稿のURLが記事と不一致');

  return d;
}

// ────────────────────────────── 2. HTML生成 ──────────────────────────────
function buildHtml(d) {
  const canonical = `https://gcg-stats.com/reports/${SLUG}.html`;
  const ogImage = d.ogImage || 'https://gcg-stats.com/images/ogp-default.png';
  const deckCards = d.decks.map((k) => `
      <!-- 使用率${k.rank}位 -->
      <div style="margin:20px 0;padding:16px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius)">
        <h3 style="margin:0 0 8px">
          <span style="font-size:12px;color:var(--text-muted);font-weight:400;margin-right:8px">${k.rank}位</span>
          ${k.ja}
          <span style="font-size:12px;color:var(--text-muted);font-weight:400;margin-left:8px">(${h(k.en)})</span>
        </h3>
        <div style="font-size:13px;color:var(--text-secondary);margin-bottom:8px;font-family:var(--font-mono)">
          使用率 <strong>${pct(k.share)}%</strong>
          　/
          勝率 <strong>${pct(k.winRate)}%</strong>
          　/
          試合数 ${k.games.toLocaleString('en-US')}
        </div>
${k.bodyHtml}
      </div>`).join('\n');

  const highlights = (d.highlights || []).map((x) => `        <li>${x}</li>`).join('\n');
  const backs = (d.backNumbers || []).map((b) =>
    `        <a href="${b.href}" class="btn-link" style="font-size:13px;padding:6px 14px${b.accent ? ';color:var(--accent)' : ''}">${b.label}</a>`).join('\n');

  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-3MY17P4E7F"></script>
  <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag("js",new Date());gtag("config","G-3MY17P4E7F");</script>
  <!-- Google AdSense -->
  <script async src="https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js?client=ca-pub-6912628791259344"
       crossorigin="anonymous"></script>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
  <title>${d.title}| GCG STATS</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png">
  <link rel="icon" type="image/png" sizes="16x16" href="/favicon-16x16.png">
  <link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png">
  <link rel="shortcut icon" href="/favicon.ico">
  <meta name="theme-color" content="#d4a029">
  <meta name="description" content="${d.description}">
  <meta property="og:site_name" content="GCG STATS"><meta property="og:locale" content="ja_JP">
  <meta property="og:title" content="${d.title}| GCG STATS">
  <meta property="og:description" content="${d.ogDescription}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="${canonical}">
  <meta property="og:image" content="${ogImage}">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="${ogImage}">
  <link rel="canonical" href="${canonical}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="../css/style.css">
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      {"@type": "ListItem", "position": 1, "name": "ホーム", "item": "https://gcg-stats.com/"},
      {"@type": "ListItem", "position": 2, "name": "レポート", "item": "https://gcg-stats.com/reports/"},
      {"@type": "ListItem", "position": 3, "name": "${d.breadcrumb}"}
    ]
  }
  </script>
</head>
<body>
  <div id="header"></div>

  <main class="container">
    <nav class="breadcrumb" style="margin-bottom:12px;font-size:12px;color:var(--text-muted);font-family:var(--font-mono)">
      <a href="../index.html" style="color:var(--text-muted);text-decoration:none" onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--text-muted)'">ホーム</a>
      <span style="margin:0 6px">›</span>
      <a href="index.html" style="color:var(--text-muted);text-decoration:none" onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--text-muted)'">レポート</a>
      <span style="margin:0 6px">›</span>
      <span style="color:var(--text-secondary)">${d.breadcrumb}</span>
    </nav>
    <div class="section-header"><div>
        <h1 class="section-title" style="margin-bottom:6px;font-size:16px">${d.title}</h1>
        <div style="font-size:13px;color:var(--text-secondary)"><span class="text-mono" style="color:var(--accent)">Mobile Suit Arena ${d.mode} ${d.matches.toLocaleString('en-US')}試合の集計</span></div>
    </div></div>

    <section style="margin-top:16px;padding:14px 16px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius)">
      <p style="margin:0;font-size:13px;line-height:1.8;color:var(--text-secondary)">
        本記事は <a href="https://www.patreon.com/DougGodinho" target="_blank" rel="noopener" style="color:var(--accent)">Doug Godinho氏のPatreon</a> にて公開された <a href="${d.sourcePostUrl}" target="_blank" rel="noopener" style="color:var(--accent)">${h(d.sourcePostTitle)}</a> のデータを、Doug Godinho氏の許諾のもと部分要約したものです。完全な分析・全デッキの詳細データは Doug氏のPatreon Supporter特典としてご確認ください。
      </p>
      <p style="margin:8px 0 0;font-size:12px;line-height:1.8;color:var(--text-muted)">
        分析対象は <a href="https://mobilesuitarena.com/" target="_blank" rel="noopener" style="color:var(--accent)">Mobile Suit Arena (MSA)</a> 上の ${d.modeJa || d.mode}のデータであり、Mobile Suit Arenaは <a href="https://www.gundam-gcg.com/ja/" target="_blank" rel="noopener" style="color:var(--accent)">公式ガンダムカードゲーム</a> の練習環境としてご活用ください。
      </p>
      <p style="margin:8px 0 0;font-size:12px;line-height:1.8;color:var(--text-muted)">
        Mobile Suit Arenaについて詳しくは<a href="msa-introduction.html" style="color:var(--accent)">こちらの紹介記事</a>もご覧ください。
      </p>
    </section>


    <article class="report-article" style="margin-top:24px;line-height:1.8;font-size:14px">

      <!-- 概要 -->
      <h2>今週のオンライン環境サマリ</h2>
${d.leadHtml}${d.noteHtml ? '\n' + d.noteHtml : ''}${d.summaryHtml ? '\n' + d.summaryHtml : ''}

      <div style="margin:20px 0;padding:16px;background:var(--bg-card);border:1px solid var(--border);border-radius:var(--radius)">
        <table style="width:100%;font-size:13px">
          <tr>
            <td style="padding:4px 8px;color:var(--text-muted)">対象期間</td>
            <td style="padding:4px 8px">${d.periodText}</td>
          </tr>
          <tr>
            <td style="padding:4px 8px;color:var(--text-muted)">対象モード</td>
            <td style="padding:4px 8px">${d.mode}</td>
          </tr>
          <tr>
            <td style="padding:4px 8px;color:var(--text-muted)">分析試合数</td>
            <td style="padding:4px 8px">${d.matches.toLocaleString('en-US')}試合</td>
          </tr>
          <tr>
            <td style="padding:4px 8px;color:var(--text-muted)">デッキリスト数</td>
            <td style="padding:4px 8px">${d.lists.toLocaleString('en-US')}</td>
          </tr>
          <tr>
            <td style="padding:4px 8px;color:var(--text-muted)">対象拡張</td>
            <td style="padding:4px 8px">${d.setLabel}</td>
          </tr>
        </table>
      </div>
${highlights ? `
      <!-- 今回の環境の要点 -->
      <h2>今回の環境の要点</h2>
      <ul style="line-height:1.8">
${highlights}
      </ul>
` : ''}
      <!-- 使用率Top ${d.decks.length}デッキ -->
      <h2>使用率Top ${d.decks.length}デッキ</h2>
      <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">
        ${d.decksNote}
      </p>
${deckCards}
${d.closingHtml ? '\n' + d.closingHtml + '\n' : ''}
      <p style="margin-top:24px;padding:12px 16px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);font-size:13px;line-height:1.8;color:var(--text-secondary)">
        より詳細な分析（全デッキの完全データ、各デッキのリスト）は Doug Godinho氏のPatreon でSupporterになることでご覧いただけます。元記事は <a href="${d.sourcePostUrl}" target="_blank" rel="noopener" style="color:var(--accent)">${h(d.sourcePostTitle)}</a>。
      </p>
      <p style="margin:8px 0 0;padding:12px 16px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);font-size:12px;line-height:1.8;color:var(--text-muted)">
        MSAはあくまで <a href="https://www.gundam-gcg.com/ja/" target="_blank" rel="noopener" style="color:var(--accent)">公式ガンダムカードゲーム</a> の練習環境です。正式な競技体験は公式ガンダムカードゲームの店舗予選・チャンピオンシップ等でお楽しみください。<br>
        Mobile Suit Arena: <a href="https://mobilesuitarena.com/" target="_blank" rel="noopener" style="color:var(--accent)">mobilesuitarena.com</a>　/　Doug Godinho氏 Patreon: <a href="https://www.patreon.com/DougGodinho" target="_blank" rel="noopener" style="color:var(--accent)">patreon.com/DougGodinho</a>　/　ガンダムカードゲーム公式サイト: <a href="https://www.gundam-gcg.com/jp/" target="_blank" rel="noopener" style="color:var(--accent)">gundam-gcg.com</a>
      </p>

      <p style="margin-top:16px;padding:12px 16px;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);font-size:12px;color:var(--text-muted);line-height:1.7">
        ※本記事で扱う数値は、オンライン対戦プラットフォーム上での集計データであり、公式の店舗予選・大会結果とは異なります。<br>
        ※本記事はAIによって記述されている文章を含みます。記事内容に誤りがある場合には<a href="https://x.com/gcg_stats" target="_blank" rel="noopener" style="color:var(--accent)">Xアカウント（@gcg_stats）</a>のDMへご報告ください。
      </p>

    </article>

    <div style="margin-top:32px;padding:16px;background:var(--bg-card);border-radius:var(--radius-lg);border:1px solid var(--border)">
      <h3 style="font-size:14px;margin-bottom:12px;color:var(--text-secondary)">MSA環境レポート バックナンバー</h3>
      <div style="display:flex;flex-wrap:wrap;gap:8px">
${backs}
      </div>
    </div>

    <div id="share-buttons" style="margin-top:32px"></div>
  </main>

  <div id="footer"></div>

  <script src="../js/common.js?v=13"></script>
  <script>GCG.init();document.getElementById("header").innerHTML=GCG.renderHeader("reports");document.getElementById("footer").innerHTML=GCG.renderFooter();GCG.renderShareButtons("share-buttons","${d.title}| GCG STATS");</script>
</body>
</html>
`;
}

// ────────────────────────────── 3. 辞書追記 ──────────────────────────────
function updateDictionary(d, write) {
  const entries = d.newDictEntries || [];
  if (!entries.length) { console.log('  新規訳語なし'); return { added: 0 }; }
  let md = fs.readFileSync(DICT_PATH, 'utf-8');
  const fresh = entries.filter((e) => !new RegExp(`^\\|\\s*${e.en.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\|`, 'm').test(md));
  if (!fresh.length) { console.log('  すべて登録済み（追記なし）'); return { added: 0 }; }
  const histRow = `| ${d.publishDate} | ${d.weekLabel} 新規訳語追加: ${fresh.map((e) => e.en).join(' / ')} | reports/${SLUG}.html |`;
  fresh.forEach((e) => console.log(`  + ${e.en} → ${e.ja}`));
  if (!write) return { added: fresh.length };
  const lines = md.split('\n');

  // (a) 訳語行は「## デッキ名・アーキタイプ訳語」セクションの表末尾に挿入する。
  //     ファイル末尾に足すと「## URL 標準」の別テーブルに紛れ込むため（2026-07-29 修正）。
  const secStart = lines.findIndex((l) => /^##\s*デッキ名・アーキタイプ訳語/.test(l));
  if (secStart < 0) throw new Error('辞書に「## デッキ名・アーキタイプ訳語」セクションが見つかりません');
  let secEnd = lines.length;
  for (let i = secStart + 1; i < lines.length; i++) { if (/^##\s/.test(lines[i])) { secEnd = i; break; } }
  let lastRow = -1;
  for (let i = secStart + 1; i < secEnd; i++) { if (/^\|/.test(lines[i])) lastRow = i; }
  if (lastRow < 0) throw new Error('デッキ名テーブルの行が見つかりません');
  lines.splice(lastRow + 1, 0, ...fresh.map((e) => `| ${e.en} | **${e.ja}** | ${e.alt || ''} | ${e.note || ''} |`));

  // (b) 改訂履歴は履歴テーブルの末尾に1行追記
  let lastHist = -1;
  for (let i = 0; i < lines.length; i++) { if (/^\| 20\d\d-\d\d-\d\d \|/.test(lines[i])) lastHist = i; }
  if (lastHist >= 0) lines.splice(lastHist + 1, 0, histRow);

  fs.writeFileSync(DICT_PATH, lines.join('\n'), 'utf-8');
  return { added: fresh.length };
}

// ────────────────────────────── 4. articles.json ──────────────────────────────
function updateManifest(d, write) {
  const p = path.join(DATA_DIR, 'articles.json');
  const arr = JSON.parse(fs.readFileSync(p, 'utf-8'));
  const rel = `reports/${SLUG}.html`;
  const entry = { path: rel, title: d.title, category: 'msa', date: d.publishDate, description: d.description };
  const idx = arr.findIndex((a) => a.path === rel);
  const action = idx >= 0 ? '更新' : '追加';
  if (!write) { console.log(`  ${action}予定: ${rel} (${d.publishDate})`); return { action }; }
  if (idx >= 0) arr[idx] = entry; else arr.push(entry);
  arr.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  fs.writeFileSync(p, JSON.stringify(arr, null, 2), 'utf-8');
  console.log(`  ${action}: ${rel} / 全${arr.length}件`);
  return { action };
}

// ────────────────────────────── 5. 再生成 ──────────────────────────────
function countSitemap() {
  if (!fs.existsSync(SITEMAP)) return 0;
  return (fs.readFileSync(SITEMAP, 'utf-8').match(/<loc>/g) || []).length;
}
function regenerate() {
  const before = countSitemap();
  // 順序は固定（--index-only が reports/*, sitemap-extra が news/series/sets を担当）
  for (const argv of [['generate-report.js', '--index-only'], ['generate-sitemap-extra.js']]) {
    console.log(`  実行: node ${argv.join(' ')}`);
    execFileSync('node', argv, { cwd: ROOT, stdio: 'pipe' });
  }
  const after = countSitemap();
  console.log(`  サイトマップURL数: ${before} → ${after}`);
  if (after < before) ng(`サイトマップのURLが ${before - after} 件減少（生成順序の異常）`);
  else ok('サイトマップの件数回帰なし');
  return { before, after };
}

// ────────────────────────────── 6. 検証 ──────────────────────────────
function verify(d) {
  const html = fs.readFileSync(HTML_PATH, 'utf-8');
  const idx = fs.readFileSync(path.join(REPORTS_DIR, 'index.html'), 'utf-8');
  const sm = fs.readFileSync(SITEMAP, 'utf-8');
  const man = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'articles.json'), 'utf-8'));
  const t = [
    ['HTML終端', /<\/html>\s*$/.test(html)],
    ['NUL混入なし', !html.includes('\0')],
    ['タイトル', html.includes(`<title>${d.title}| GCG STATS</title>`)],
    ['canonical', html.includes(`https://gcg-stats.com/reports/${SLUG}.html`)],
    ['構造化データ', html.includes('BreadcrumbList') && html.includes(d.breadcrumb)],
    ['元記事リンク2箇所', (html.match(new RegExp(d.sourcePostUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length === 2],
    ['共通CSS/JS参照', html.includes('../css/style.css') && html.includes('../js/common.js?v=13')],
    ['header/footer/share', html.includes('id="header"') && html.includes('id="footer"') && html.includes('id="share-buttons"')],
    [`デッキカード${d.decks.length}件`, (html.match(/font-weight:400;margin-right:8px">\d+位/g) || []).length === d.decks.length],
    ['一覧に掲載', idx.includes(`${SLUG}.html`)],
    ['sitemap登録', sm.includes(`reports/${SLUG}.html`)],
    ['sitemap重複なし', (() => { const a = [...sm.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]); return a.length === new Set(a).size; })()],
    ['manifest登録', man.filter((a) => a.path === `reports/${SLUG}.html`).length === 1],
  ];
  for (const [label, pass] of t) pass ? ok(label) : ng(label);
  // 全デッキの数値が本文に出ているか
  let numOk = true;
  for (const k of d.decks) {
    for (const v of [`${pct(k.share)}%`, `${pct(k.winRate)}%`, k.games.toLocaleString('en-US')]) {
      if (!html.includes(v)) { numOk = false; ng(`数値未反映 ${k.ja}: ${v}`); }
    }
  }
  if (numOk) ok('全デッキの数値がHTMLに反映');
}

// ────────────────────────────── 7. X投稿ファイル ──────────────────────────────
function ensureXPostFile(d, write) {
  if (fs.existsSync(XPOST_PATH)) { console.log(`  既存: scripts/x-posts/${SLUG}.txt`); return; }
  const w = weightedLength(d.xPost);
  const chars = d.xPost.replace(/https?:\/\/\S+/g, '').replace(/\n/g, '').length;
  const body = `${d.xPost}\n\n---\n作成日: ${d.publishDate}\n運用: 松岡さん指示「文面はおまかせ・即時投稿、以後この運用で」(week6より継続)\nX加重スコア: ${w}/280 / 文字数(URL除く): ${chars}\n投稿状況: 未投稿\n`;
  if (!write) { console.log(`  作成予定: scripts/x-posts/${SLUG}.txt`); return; }
  fs.mkdirSync(XPOST_DIR, { recursive: true });
  fs.writeFileSync(XPOST_PATH, body, 'utf-8');
  console.log(`  作成: scripts/x-posts/${SLUG}.txt`);
}
function alreadyPosted() {
  if (!fs.existsSync(XPOST_PATH)) return false;
  const s = fs.readFileSync(XPOST_PATH, 'utf-8');
  return /投稿状況:\s*投稿済み/.test(s) || /TWEET ID:\s*\d/.test(s);
}

// ────────────────────────────── 8. push ──────────────────────────────
function push(d, opts = {}) {
  const extra = (opts.files || [`reports/${SLUG}.html`, 'reports/index.html', 'data/articles.json',
    'translation-dictionary-v1.md', `scripts/x-posts/${SLUG}.txt`]).join(',');
  const msg = opts.message || d.commitMessage || `feat: ${d.title}を公開`;
  console.log('  実行: node scripts/push-cardlist-update.js --extra=... --message=...');
  const out = execFileSync('node', ['scripts/push-cardlist-update.js', `--extra=${extra}`, `--message=${msg}`],
    { cwd: ROOT, encoding: 'utf-8' });
  console.log(out.split('\n').map((l) => '    ' + l).join('\n'));
  if (!out.includes('PUSH_COMPLETE') && !out.includes('差分なし')) throw new Error('push が完了しませんでした');
}

// ────────────────────────────── 9. X投稿 ──────────────────────────────
const percentEncode = (s) => encodeURIComponent(s)
  .replace(/!/g, '%21').replace(/\*/g, '%2A').replace(/'/g, '%27')
  .replace(/\(/g, '%28').replace(/\)/g, '%29');

function oauthSignature(method, url, params, consumerSecret, tokenSecret) {
  const sorted = Object.keys(params).sort().map((k) => `${percentEncode(k)}=${percentEncode(params[k])}`).join('&');
  const base = `${method}&${percentEncode(url)}&${percentEncode(sorted)}`;
  const key = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return crypto.createHmac('sha1', key).update(base).digest('base64');
}
function postTweet(text) {
  const url = 'https://api.x.com/2/tweets';
  const p = {
    oauth_consumer_key: process.env.X_API_KEY,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: process.env.X_API_ACCESS_TOKEN,
    oauth_version: '1.0',
  };
  p.oauth_signature = oauthSignature('POST', url, p, process.env.X_API_SECRET, process.env.X_API_ACCESS_TOKEN_SECRET);
  const auth = 'OAuth ' + Object.keys(p).sort().map((k) => `${percentEncode(k)}="${percentEncode(p[k])}"`).join(', ');
  const body = JSON.stringify({ text });
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.x.com', path: '/2/tweets', method: 'POST',
      headers: { Authorization: auth, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => { let data = ''; res.on('data', (c) => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, body: data })); });
    req.on('error', reject);
    req.write(body); req.end();
  });
}
async function doPost(d) {
  if (alreadyPosted()) { console.log('  ★中止: 投稿済みの記録があります（二重投稿防止）'); return; }
  for (const k of ['X_API_KEY', 'X_API_SECRET', 'X_API_ACCESS_TOKEN', 'X_API_ACCESS_TOKEN_SECRET']) {
    if (!process.env[k]) { console.error(`  ★中止: .env に ${k} がありません`); return; }
  }
  const r = await postTweet(d.xPost);
  console.log(`  HTTP ${r.status}`);
  if (r.status !== 201) { console.error('  ★投稿失敗: ' + r.body.slice(0, 300)); process.exitCode = 1; return; }
  let id = '';
  try { id = JSON.parse(r.body).data.id; } catch (e) { /* ignore */ }
  const stamp = new Date().toISOString();
  const log = `\n投稿状況: 投稿済み\n投稿日時: ${stamp}(即時投稿)\nTWEET ID: ${id}\n投稿URL: https://x.com/gcg_stats/status/${id}\nHTTPステータス: ${r.status}\n`;
  fs.appendFileSync(XPOST_PATH, log, 'utf-8');
  console.log(`  ✓ 投稿完了: https://x.com/gcg_stats/status/${id}`);
  // 投稿記録（TWEET ID等）をリポジトリにも残す。既存 x-posts/*.txt と同じ運用。
  try {
    push(d, { files: [`scripts/x-posts/${SLUG}.txt`], message: `chore: ${d.weekLabel} のX投稿記録を追加` });
  } catch (e) {
    console.warn('  ※ 投稿記録の push に失敗しました（投稿自体は成功）: ' + e.message);
    console.warn('     後で scripts/x-posts/' + SLUG + '.txt を push してください。');
  }
}

// ────────────────────────────── main ──────────────────────────────
(async () => {
  console.log(`=== MSA環境レポート公開: ${SLUG} ===`);
  console.log(`モード: ${DO_PUBLISH ? '--publish（生成+push' + (NO_POST ? '' : '+X投稿') + '）' : DO_BUILD ? '--build（生成のみ）' : 'DRY RUN（書き込みなし）'}`);

  const d = loadAndValidate();

  console.log('\n[2] 記事HTMLの生成');
  const html = buildHtml(d);
  console.log(`  ${html.length} バイト / デッキ ${d.decks.length}件`);
  if (DO_BUILD) { fs.writeFileSync(HTML_PATH, html, 'utf-8'); console.log(`  書き込み: reports/${SLUG}.html`); }

  console.log('\n[3] 訳語辞書の更新');
  updateDictionary(d, DO_BUILD);

  console.log('\n[4] data/articles.json');
  updateManifest(d, DO_BUILD);

  console.log('\n[5] 一覧・サイトマップの再生成');
  if (DO_BUILD) regenerate(); else console.log('  DRY RUN のためスキップ');

  console.log('\n[6] 生成物の検証');
  if (DO_BUILD) verify(d); else console.log('  DRY RUN のためスキップ');

  console.log('\n[7] X投稿ファイル');
  ensureXPostFile(d, DO_BUILD);

  if (problems.length) {
    console.error(`\n★ 検証エラー ${problems.length} 件。push・投稿は行いません。`);
    problems.forEach((p) => console.error('  ! ' + p));
    process.exit(1);
  }
  console.log('\n検証: 問題なし');

  if (!DO_PUBLISH) {
    console.log(DO_BUILD
      ? '\n生成まで完了しました。公開するには --publish を付けて再実行してください。'
      : '\nDRY RUN のため何も書き込んでいません。--build で生成、--publish で公開まで行います。');
    return;
  }

  console.log('\n[8] GitHubへ push');
  push(d);

  console.log('\n[9] Xへ投稿');
  if (NO_POST) console.log('  --no-post のためスキップ');
  else await doPost(d);

  console.log('\n=== 完了 ===');
})().catch((e) => { console.error('致命的エラー:', e.message); process.exit(1); });
// EOF
