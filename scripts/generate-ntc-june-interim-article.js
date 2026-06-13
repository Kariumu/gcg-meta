#!/usr/bin/env node
/**
 * scripts/generate-ntc-june-interim-article.js (指示書v8 A-3)
 * 「NTC 2026 MISSION3(6月開催)中間レポート」記事を生成する。
 *
 * 設計:
 *  - 数値(統計カード・デッキタイプ表・5月比較表・入賞分布・地域表)は
 *    data/analysis/ntc-2026-06-interim.json から機械生成
 *    → 記事数値 = interim.json 完全一致を構造的に保証
 *  - 文章(はじめに・考察)のみ generate-report.js の callClaudeAPI で生成
 *  - 生成後: articles.json 冪等追記(category='tournament')→ reports/index.html
 *    再生成 → sitemap 更新
 *
 * 使い方:
 *   node scripts/generate-ntc-june-interim-article.js            # 本生成(API使用)
 *   node scripts/generate-ntc-june-interim-article.js --no-api   # 文章プレースホルダ(レイアウト確認)
 *   node scripts/generate-ntc-june-interim-article.js --article-only  # index/sitemap/manifest を触らない
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env'), override: true });
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const {
  callClaudeAPI, updateReportIndex, updateSitemap, appendToArticlesManifest
} = require(path.join(ROOT, 'generate-report.js'));

const NO_API = process.argv.includes('--no-api');
const ARTICLE_ONLY = process.argv.includes('--article-only');

const interim = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'analysis', 'ntc-2026-06-interim.json'), 'utf-8'));
const J = interim.june;
const M = interim.may_baseline;
const CMP = interim.share_comparison;

const PAGE_ID = 'ntc-2026-mission3-june-interim';
const SITE_URL = 'https://gcg-stats.com';
const TITLE = 'NTC 2026 MISSION3（6月開催）中間レポート — 全国108店舗・998デッキの分布と5月比較';
const DESC = `ニュータイプチャレンジ 2026 MISSION3（6月開催）の中間集計。${fmtDate(interim.period.from)}〜${fmtDate(interim.period.to)}の${J.events}イベント・入賞${num(J.decks)}デッキのデッキタイプ分布・優勝率（64名定員大会は優勝2名換算）・5月との比較。`;

function num(n) { return Number(n).toLocaleString('en-US'); }
function fmtDate(d) { const [y, m, dd] = d.split('-'); return `${Number(m)}/${Number(dd)}`; }
function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function deltaCell(d) {
  if (d > 0) return `<span class="delta-up">+${d}pt</span>`;
  if (d < 0) return `<span class="delta-down">${d}pt</span>`;
  return '±0pt';
}

// === 数値セクション(機械生成) ===
function buildStatCards() {
  return `
      <div class="stat-grid">
        <div class="stat-card"><div class="stat-label">対象イベント</div><div class="stat-value">${J.events}</div><div class="stat-sub">うち64名定員 ${J.consolidated_events} 大会</div></div>
        <div class="stat-card"><div class="stat-label">入賞デッキ(ベスト8換算)</div><div class="stat-value">${num(J.decks)}</div><div class="stat-sub">デッキデータあり・rank8位以内</div></div>
        <div class="stat-card"><div class="stat-label">優勝数</div><div class="stat-value">${J.winners}</div><div class="stat-sub">64名定員大会は各2名で換算</div></div>
        <div class="stat-card"><div class="stat-label">集計期間</div><div class="stat-value">${fmtDate(interim.period.from)}〜${fmtDate(interim.period.to)}</div><div class="stat-sub">公式掲載 6/12 時点</div></div>
      </div>`;
}

function buildTypeTable() {
  const rows = J.deck_types.map((t, i) => `
        <tr${i === 0 ? ' class="highlight"' : ''}>
          <td>${esc(t.label)}</td>
          <td class="num">${num(t.count)}</td>
          <td class="num">${t.share}%</td>
          <td class="num">${t.wins}</td>
          <td class="num">${t.win_rate}%</td>
          <td class="num">${t.win_share}%</td>
        </tr>`).join('');
  return `
      <table class="recap-table">
        <thead><tr><th>デッキタイプ(色)</th><th class="num">使用数</th><th class="num">シェア</th><th class="num">優勝数</th><th class="num">優勝率</th><th class="num">優勝シェア</th></tr></thead>
        <tbody>${rows}
        </tbody>
      </table>`;
}

function buildCompareTable() {
  const rows = CMP.map(c => `
        <tr>
          <td>${esc(c.label)}</td>
          <td class="num">${c.june_share}%</td>
          <td class="num">${c.may_share}%</td>
          <td class="num">${deltaCell(c.diff)}</td>
        </tr>`).join('');
  return `
      <table class="recap-table">
        <thead><tr><th>デッキタイプ</th><th class="num">6月シェア</th><th class="num">5月シェア</th><th class="num">増減</th></tr></thead>
        <tbody>${rows}
        </tbody>
      </table>`;
}

function buildRegionTable() {
  const labelOf = {};
  for (const t of J.deck_types) labelOf[t.type_key] = t.label;
  const rows = J.regions.map(r => `
        <tr>
          <td>${esc(r.region)}</td>
          <td class="num">${r.events}</td>
          <td class="num">${num(r.decks)}</td>
          <td>${r.top_types.map(t => `${esc(labelOf[t.type_key] || t.type_key)}(${t.count})`).join(' / ')}</td>
        </tr>`).join('');
  return `
      <table class="recap-table">
        <thead><tr><th>地域</th><th class="num">イベント</th><th class="num">入賞デッキ</th><th>上位タイプ(件数)</th></tr></thead>
        <tbody>${rows}
        </tbody>
      </table>`;
}

function buildRankTable() {
  const ranks = Object.keys(J.rank_distribution).sort((a, b) => Number(a) - Number(b));
  return `
      <table class="recap-table">
        <thead><tr>${ranks.map(r => `<th class="num">${r}位</th>`).join('')}</tr></thead>
        <tbody><tr>${ranks.map(r => `<td class="num">${J.rank_distribution[r]}</td>`).join('')}</tr></tbody>
      </table>`;
}

// === 文章セクション(Claude API。数値の捏造を防ぐため使用可能数値を明示) ===
function buildPrompt() {
  const top5 = J.deck_types.slice(0, 5).map(t =>
    `${t.label}: シェア${t.share}%(${t.count}デッキ)、優勝${t.wins}回、優勝率${t.win_rate}%`).join('\n');
  const movers = CMP.filter(c => Math.abs(c.diff) >= 1).map(c =>
    `${c.label}: 6月${c.june_share}% / 5月${c.may_share}%(${c.diff > 0 ? '+' : ''}${c.diff}pt)`).join('\n');
  return `あなたはガンダムカードゲーム(GCG)の大会データ分析サイト「GCG STATS」の記事ライターです。
ニュータイプチャレンジ(NTC)2026 MISSION3 6月開催の中間レポート記事の「導入」と「考察」の文章を書いてください。

# 集計データ(これ以外の数値を文章に書かないこと。新しい数値の計算・推定も禁止)
- 期間: 2026年6月1日〜6月7日(公式掲載は6月12日時点、月の前半のみの中間集計)
- 対象: ${J.events}イベント(うち64名定員大会${J.consolidated_events})、入賞デッキ${J.decks}件、優勝${J.winners}回
- 集計規則: 64名定員大会(入賞16名公開)は「ベスト8・各順位2名」に換算し、優勝も2名とカウント
- デッキタイプ上位5(6月):
${top5}
- 5月からのシェア増減(±1pt以上):
${movers}
- 環境背景(事実): GD04「Phantom Aria」は4月25日発売。6月27日に新弾 GD05・EB01・ST10 が発売予定で、本大会は GD04 環境後期にあたる。

# 出力形式(厳守)
<INTRO>タグ内に導入(2〜3段落、<p>タグ)、<ANALYSIS>タグ内に考察(3〜4段落、<p>タグ、<strong>を適度に使用)を出力。
<INTRO>...</INTRO>
<ANALYSIS>...</ANALYSIS>

# 文体・内容の指針
- である調ではなく「です・ます」調
- 導入: 大会の位置づけ(GD04環境後期・新弾前最後のNTC)と中間集計である旨
- 考察: 青/紫の首位維持とシェア微減、赤/白の伸長、青/緑の減少、優勝率から見える各タイプの強さを、与えた数値に基づいて論じる
- 断定しすぎず、中間データである留保を添える
- 数値は上記の集計データに含まれるものだけを使う`;
}

const PLACEHOLDER = {
  intro: '<p>(プレースホルダ: --no-api 実行のため導入文は未生成です)</p>',
  analysis: '<p>(プレースホルダ: --no-api 実行のため考察文は未生成です)</p>'
};

// 文章中の数値が interim.json 由来かを確認する簡易チェック(警告のみ)
function validateNumbers(text) {
  const allowed = new Set(['2026', '108', '20', '998', '125', '1', '2', '3', '4', '5', '6', '7', '8', '12', '16', '25', '27', '64']);
  const collect = (o) => {
    if (typeof o === 'number') {
      allowed.add(String(o));
      allowed.add(o.toLocaleString('en-US'));
      if (!Number.isInteger(o)) allowed.add(o.toFixed(1));
    } else if (Array.isArray(o)) o.forEach(collect);
    else if (o && typeof o === 'object') Object.values(o).forEach(collect);
  };
  collect(interim);
  const nums = String(text).replace(/<[^>]*>/g, '').match(/\d[\d,.]*/g) || [];
  const unknown = nums.filter(n => !allowed.has(n.replace(/[.,]$/, '')));
  return [...new Set(unknown)];
}

function buildPage(introHtml, analysisHtml) {
  const today = '2026.06.13';
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
  <title>${esc(TITLE)} | GCG STATS</title>
  <meta name="description" content="${esc(DESC)}">
  <!-- OGP -->
  <meta property="og:site_name" content="GCG STATS">
  <meta property="og:locale" content="ja_JP">
  <meta property="og:title" content="${esc(TITLE)} | GCG STATS">
  <meta property="og:description" content="${esc(DESC)}">
  <meta property="og:type" content="article">
  <meta property="og:url" content="${SITE_URL}/reports/${PAGE_ID}.html">
  <meta property="og:image" content="${SITE_URL}/images/ogp-default.png">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="${SITE_URL}/images/ogp-default.png">
  <meta name="twitter:site" content="@gcg_stats">
  <link rel="canonical" href="${SITE_URL}/reports/${PAGE_ID}.html">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="../css/style.css">
  <style>
    .recap-table { width:100%; border-collapse:collapse; margin:16px 0; font-size:13px; }
    .recap-table th, .recap-table td { padding:8px 10px; border-bottom:1px solid var(--border); text-align:left; }
    .recap-table th { background:var(--bg-elevated); color:var(--text-muted); font-weight:600; font-size:12px; }
    .recap-table td.num { font-family:var(--font-mono); text-align:right; }
    .recap-table th.num { text-align:right; }
    .recap-table tr.highlight td { background:rgba(255,200,0,0.05); }
    .delta-up { color:#7cd99c; font-weight:600; }
    .delta-down { color:#ff7b7b; font-weight:600; }
    .stat-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(160px, 1fr)); gap:12px; margin:16px 0; }
    .stat-card { padding:14px 16px; background:var(--bg-card); border:1px solid var(--border); border-radius:var(--radius); }
    .stat-card .stat-label { font-size:12px; color:var(--text-muted); margin-bottom:4px; }
    .stat-card .stat-value { font-family:var(--font-mono); font-size:22px; font-weight:700; color:var(--text-primary); }
    .stat-card .stat-sub { font-size:11px; color:var(--text-muted); margin-top:2px; }
    .method-note { margin:16px 0; padding:12px 16px; background:var(--bg-elevated); border:1px solid var(--border); border-radius:var(--radius); font-size:12px; color:var(--text-muted); line-height:1.7; }
    @media (max-width: 640px) {
      .recap-table { font-size:12px; }
      .recap-table th, .recap-table td { padding:6px 8px; }
    }
  </style>
</head>
<body>
  <div id="header"></div>

  <main class="container">
    <a href="../reports/" style="color:var(--text-muted);text-decoration:none;font-size:13px">← レポート一覧に戻る</a>

    <div class="section-header" style="margin-top:16px">
      <h1 class="section-title">NTC 2026 MISSION3（6月開催）中間レポート</h1>
      <p style="color:var(--text-muted);font-size:14px;margin-top:4px">
        全国${J.events}店舗・入賞${num(J.decks)}デッキ(ベスト8換算)の分布と5月比較
      </p>
      <p style="color:var(--text-muted);font-size:12px;margin-top:4px">
        対象大会: NTC 2026 MISSION3（series=6791、${fmtDate(interim.period.from)}〜${fmtDate(interim.period.to)}開催・公式掲載6/12時点）｜ 公開: ${today}
      </p>
    </div>

    <article class="report-article" style="margin-top:24px;line-height:1.8;font-size:14px">

      <h2>はじめに</h2>
${introHtml}

      <h2>集計サマリー</h2>
${buildStatCards()}
      <div class="method-note">
        <strong>集計規則:</strong> 入賞16名が公開される64名定員大会は、松岡さん指定ルールに基づき「ベスト8・各順位2名」に換算しています(優勝も2名としてカウント)。集計対象は8位以内かつデッキデータが公開されている入賞のみです。デッキタイプは使用カードの色構成による分類です。
      </div>

      <h2>デッキタイプ別の使用数と優勝率</h2>
${buildTypeTable()}

      <h2>5月(MISSION3 5月開催)とのシェア比較</h2>
${buildCompareTable()}

      <h2>ベスト8換算の入賞分布</h2>
${buildRankTable()}

      <h2>地域別の傾向</h2>
${buildRegionTable()}

      <h2>考察</h2>
${analysisHtml}

      <p style="color:var(--text-muted);font-size:12px;margin-top:24px">
        ※本記事は${fmtDate(interim.period.to)}開催分まで(公式掲載6/12時点)の中間集計です。月末の最終集計で数値は変動します。<br>
        ※データソース: <a href="${SITE_URL}/series/ntc-2026-mission3-june.html">NTC 2026 MISSION3(6月開催)イベント一覧</a>
      </p>

    </article>
  </main>

  <div id="footer"></div>

  <script src="../js/common.js?v=13"></script>
  <script>
    GCG.init();
    document.getElementById('header').innerHTML = GCG.renderHeader('reports');
    document.getElementById('footer').innerHTML = GCG.renderFooter();
  </script>
</body>
</html>
`;
}

async function main() {
  let intro = PLACEHOLDER.intro, analysis = PLACEHOLDER.analysis;
  if (!NO_API) {
    const res = await callClaudeAPI(buildPrompt());
    const im = res.match(/<INTRO>([\s\S]*?)<\/INTRO>/);
    const am = res.match(/<ANALYSIS>([\s\S]*?)<\/ANALYSIS>/);
    if (!im || !am) throw new Error('APIレスポンスの形式が不正です(INTRO/ANALYSISタグ欠落)');
    intro = im[1].trim();
    analysis = am[1].trim();
    const unknown = validateNumbers(intro + analysis);
    if (unknown.length) {
      console.warn('⚠ 文章中に interim.json 由来でない可能性のある数値があります(要レビュー):', unknown.join(', '));
    }
  }
  const html = buildPage(intro, analysis);
  const outPath = path.join(ROOT, 'reports', PAGE_ID + '.html');
  fs.writeFileSync(outPath, html, 'utf-8');
  console.log('記事保存:', outPath);

  if (!ARTICLE_ONLY) {
    appendToArticlesManifest([{ path: `reports/${PAGE_ID}.html`, category: 'tournament', date: '2026-06-13' }]);
    updateReportIndex();
    console.log('  → reports/index.html を更新しました');
    updateSitemap();
    console.log('  → sitemap.xml を更新しました');
  }
}

main().catch(e => { console.error('エラー:', e.message); process.exit(1); });
// EOF
