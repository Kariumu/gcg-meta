#!/usr/bin/env node
/**
 * scripts/build-articles-manifest.js
 * 記事マニフェスト data/articles.json のバックフィル/再構築スクリプト(指示書v7 Task 1-1)
 *
 * reports/*.html と reports/news/*.html を走査し、<title> と日付から
 * エントリを生成して data/articles.json に書き出す。既存HTMLは一切変更しない。
 *
 * カテゴリ分類(ファイル名パターン):
 *   - reports/news/*           → news       (新カード速報)
 *   - msa-*                    → msa        (環境レポート)
 *   - YYYY-MM-(report|restriction|week*) / ntc-* → tournament (大会分析)
 *   - gd04-lr-* / *-lr-*       → cards      (カード・デッキ考察)
 *   - 上記以外                 → other      (実行時に一覧を報告、松岡さん確認用)
 *
 * 日付の優先順位:
 *   1. ファイル名の日付(news/YYYY-MM-DD.html)
 *   2. 既存 data/articles.json の同 path エントリ(再実行時の冪等性)
 *   3. 現行 reports/index.html に表示中の日付(初回バックフィル用ハーベスト)
 *   4. git のファイル追加日(git log --diff-filter=A、利用できる環境のみ)
 *   5. ファイル mtime(最終フォールバック。レポートに警告として出力)
 *
 * 使い方:
 *   node scripts/build-articles-manifest.js            # 生成
 *   node scripts/build-articles-manifest.js --dry-run  # 書き込みなしで結果表示
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// MANIFEST_ROOT: 検証時にリポジトリルートを差し替えるための環境変数(NEWS_OUTPUT_ROOT と同じ流儀)
const ROOT = process.env.MANIFEST_ROOT || path.resolve(__dirname, '..');
const REPORTS_DIR = path.join(ROOT, 'reports');
const NEWS_DIR = path.join(REPORTS_DIR, 'news');
// MANIFEST_OUT: 出力先ファイルの差し替え(検証用)。未指定なら data/articles.json
const MANIFEST_PATH = process.env.MANIFEST_OUT || path.join(ROOT, 'data', 'articles.json');
const DRY_RUN = process.argv.includes('--dry-run');

/** <title>タグから記事タイトルを抽出(" | GCG STATS" サフィックス除去) */
function extractTitle(html, fallback) {
  const m = html.match(/<title>([^<]*)<\/title>/);
  if (!m) return fallback;
  return m[1].replace(/\s*[|｜]\s*GCG STATS\s*$/, '').trim() || fallback;
}

/** meta description を抽出 */
function extractDescription(html) {
  const m = html.match(/<meta\s+name="description"\s+content="([^"]*)"/);
  return m ? m[1].trim() : '';
}

/** ファイル名からカテゴリを判定。判定不能は null */
function classify(relPath) {
  const base = path.basename(relPath, '.html');
  if (relPath.startsWith('reports/news/')) return 'news';
  if (/^msa-/.test(base)) return 'msa';
  if (/^\d{4}-\d{2}-(report|restriction|week)/.test(base)) return 'tournament';
  if (/^ntc-/.test(base)) return 'tournament'; // NTC大会分析
  if (/-lr-/.test(base)) return 'cards';       // gd04-lr-* 等のLR考察
  return null;
}

/** 既存 articles.json を path → entry のマップで読む(無ければ空) */
function loadExistingManifest() {
  const map = {};
  try {
    const arr = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
    if (Array.isArray(arr)) for (const e of arr) if (e && e.path) map[e.path] = e;
  } catch (_) { /* 初回は存在しない */ }
  return map;
}

/** 現行 reports/index.html から href → YYYY-MM-DD のマップをハーベスト */
function harvestDatesFromIndex() {
  const map = {};
  try {
    const html = fs.readFileSync(path.join(REPORTS_DIR, 'index.html'), 'utf-8');
    // <a href="...">〜</a> ブロックごとに、ブロック内の「最後の」YYYY.MM.DD を公開日とみなす
    // (タイトル内の期間表記「2026.03.16〜2026.03.22」を誤認しないため。日付スパンは末尾にある)
    const re = /<a href="([^"]+\.html)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const dates = m[2].match(/\d{4}\.\d{2}\.\d{2}/g);
      if (dates && dates.length) {
        map[m[1]] = dates[dates.length - 1].replace(/\./g, '-');
      }
    }
  } catch (_) { /* index.html が無くても続行 */ }
  return map;
}

/** git からファイル追加日(YYYY-MM-DD)を取得。失敗時は null */
function gitAddedDate(relPath) {
  try {
    const out = execFileSync(
      'git',
      ['log', '--format=%as', '--diff-filter=A', '--', relPath],
      { cwd: ROOT, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim().split('\n').filter(Boolean);
    return out.length ? out[out.length - 1] : null; // 最古=追加コミット
  } catch (_) {
    return null;
  }
}

function listHtmlFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.html') && f !== 'index.html');
}

function main() {
  const existing = loadExistingManifest();
  const harvested = harvestDatesFromIndex();
  const articles = [];
  const otherList = [];
  const mtimeFallbacks = [];

  const targets = [
    ...listHtmlFiles(REPORTS_DIR).map(f => ({ rel: 'reports/' + f, abs: path.join(REPORTS_DIR, f) })),
    ...listHtmlFiles(NEWS_DIR).map(f => ({ rel: 'reports/news/' + f, abs: path.join(NEWS_DIR, f) }))
  ];

  for (const t of targets) {
    const html = fs.readFileSync(t.abs, 'utf-8');
    const base = path.basename(t.rel, '.html');

    // 日付決定(優先順位どおり)
    let date = null;
    const fnameDate = base.match(/^(\d{4}-\d{2}-\d{2})$/);
    if (fnameDate) date = fnameDate[1];
    if (!date && existing[t.rel] && existing[t.rel].date) date = existing[t.rel].date;
    if (!date && harvested[path.basename(t.rel)]) date = harvested[path.basename(t.rel)];
    if (!date) date = gitAddedDate(t.rel);
    if (!date) {
      const d = fs.statSync(t.abs).mtime;
      date = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      mtimeFallbacks.push(t.rel);
    }

    let category = classify(t.rel);
    if (!category) { category = 'other'; otherList.push(t.rel); }

    articles.push({
      path: t.rel,
      title: extractTitle(html, base),
      category,
      date,
      description: extractDescription(html)
    });
  }

  // 日付降順、同日は path 昇順で安定ソート
  articles.sort((a, b) => (b.date.localeCompare(a.date)) || a.path.localeCompare(b.path));

  // レポート出力
  const counts = {};
  for (const a of articles) counts[a.category] = (counts[a.category] || 0) + 1;
  console.log('=== build-articles-manifest 結果 ===');
  console.log('総記事数:', articles.length);
  console.log('カテゴリ内訳:', JSON.stringify(counts));
  if (otherList.length) {
    console.log('\n[要確認] カテゴリ自動分類できず other にした記事:');
    otherList.forEach(p => console.log('  -', p));
  }
  if (mtimeFallbacks.length) {
    console.log('\n[警告] 日付を mtime フォールバックで決定した記事(要目視確認):');
    mtimeFallbacks.forEach(p => console.log('  -', p));
  }

  if (DRY_RUN) {
    console.log('\n--dry-run のため書き込みなし');
    return;
  }
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(articles, null, 2) + '\n', 'utf-8');
  console.log('\n書き込み完了:', MANIFEST_PATH);
}

main();
// EOF
