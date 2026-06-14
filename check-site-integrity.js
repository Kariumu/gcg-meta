#!/usr/bin/env node
/**
 * GCG STATS サイト健全性 一括検査ツール
 *
 * 生成済みサイト（HTML / sitemap / articles.json）の構造的な健全性を検査する。
 * データ取得の品質を見る data-quality-check.js とは目的が異なり、
 * こちらは「公開する成果物が壊れていないか」を見る。
 *
 * 使い方:
 *   node check-site-integrity.js            検査のみ（何も書き換えない・デフォルト）
 *   node check-site-integrity.js --fix      機械的に安全な項目だけ自動修復（バックアップ付き）
 *   node check-site-integrity.js --json      結果をJSONでも出力（CI連携用）
 *
 * 検査項目:
 *   [1] HTML終端の健全性     … </html> で正常終了しているか（切断検出）
 *   [2] 内部リンク切れ        … href/src が指すローカルファイルの実在
 *   [3] articles.json 整合    … マニフェストと reports/ 実ファイルの双方向一致
 *   [4] sitemap 網羅性        … sitemap内URLの実ファイル存在 / 主要ページの登録漏れ
 *   [5] ?v= バージョン分布    … カテゴリ別の集計と想定外バージョンの警告
 *
 * 自動修復(--fix)の対象は「機械的に安全に直せるもの」だけに限定する:
 *   - 修復する : articles.json の幽霊エントリ削除（実ファイルが無い登録の除去）
 *   - 報告のみ : 終端切断・リンク切れ・sitemap・?v=（誤修復が危険なため人間が判断）
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const args = process.argv.slice(2);
const DO_FIX = args.includes('--fix');
const OUT_JSON = args.includes('--json');

// ===== 出力ヘルパー =====
const C = { reset: '\x1b[0m', red: '\x1b[31m', yellow: '\x1b[33m', green: '\x1b[32m', cyan: '\x1b[36m', gray: '\x1b[90m' };
const report = { checkedAt: new Date().toISOString(), errors: [], warnings: [], info: [], fixes: [] };

function err(section, msg, detail) {
  console.log(`${C.red}[ERROR]${C.reset} ${section}: ${msg}`);
  if (detail) console.log(`${C.gray}        ${detail}${C.reset}`);
  report.errors.push({ section, msg, detail: detail || null });
}
function warn(section, msg, detail) {
  console.log(`${C.yellow}[WARN]${C.reset}  ${section}: ${msg}`);
  if (detail) console.log(`${C.gray}        ${detail}${C.reset}`);
  report.warnings.push({ section, msg, detail: detail || null });
}
function ok(section, msg) {
  console.log(`${C.green}[OK]${C.reset}    ${section}: ${msg}`);
  report.info.push({ section, msg });
}
function fixed(section, msg) {
  console.log(`${C.cyan}[FIX]${C.reset}   ${section}: ${msg}`);
  report.fixes.push({ section, msg });
}
function head(title) {
  console.log(`\n${C.cyan}===== ${title} =====${C.reset}`);
}

// ===== HTMLファイルを再帰的に収集 =====
// node_modules / .git / バックアップ(.bak) / data / images は対象外
const SKIP_DIRS = new Set(['node_modules', '.git', '.sched-run-tmp', 'data', 'images', 'tmp', 'homepage', 'recognition-test']);
function collectHtml(dir, acc) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      collectHtml(path.join(dir, entry.name), acc);
    } else if (entry.isFile() && entry.name.endsWith('.html') && !entry.name.includes('.bak')) {
      acc.push(path.join(dir, entry.name));
    }
  }
  return acc;
}

// ============================================================
// [1] HTML終端の健全性
// ============================================================
// </html> を持たないのが正当なファイル（Google認証用htmlなど）は終端チェック対象外
const TERMINATION_EXEMPT = /^google[0-9a-f]+\.html$/;
function checkTermination(htmlFiles) {
  head('[1] HTML終端の健全性（切断検出）');
  let bad = 0;
  for (const f of htmlFiles) {
    const rel = path.relative(ROOT, f);
    if (TERMINATION_EXEMPT.test(path.basename(f))) continue;
    const content = fs.readFileSync(f, 'utf-8');
    // 末尾のNULバイト・各種空白を除去してから </html> を探す
    // （ファイル末尾にNULや全角空白のパディングが付くことがあるため）
    const cleanedTail = content.replace(/[\u0000\s\uFEFF\u3000]+$/g, '').slice(-30).toLowerCase();
    if (!cleanedTail.includes('</html>')) {
      err('終端', `${rel} が </html> で終わっていない（切断の疑い）`, `末尾: ${JSON.stringify(content.replace(/[\u0000]+$/g,'').trimEnd().slice(-40))}`);
      bad++;
    }
  }
  if (bad === 0) ok('終端', `${htmlFiles.length}ファイルすべて </html> で正常終了（認証用htmlを除く）`);
}

// ============================================================
// [2] 内部リンク切れ
// ============================================================
function resolveLink(link, fromFile) {
  // JavaScript式による動的URL構築は静的リンクではないので除外
  //   例: href="' + card.id + '/"  href="${base}/x"  src="' + GCG.cardImageUrl(id) + '"
  if (/['"`]\s*\+|\+\s*['"`]|\$\{|\+ |GCG\.|encodeURIComponent|\.result|\.target/.test(link)) return null;
  // クエリ・フラグメントを除去
  let p = link.split('#')[0].split('?')[0];
  if (!p) return null; // 純粋な#や?のみ
  if (/^(https?:|mailto:|tel:|javascript:|data:)/i.test(p)) return null; // 外部
  let target;
  if (p.startsWith('/')) {
    target = path.join(ROOT, p.slice(1)); // ルート絶対
  } else {
    target = path.resolve(path.dirname(fromFile), p); // 相対
  }
  // ディレクトリ参照（末尾/ や 拡張子なし）は index.html を見る
  if (p.endsWith('/')) target = path.join(target, 'index.html');
  return target;
}
function checkLinks(htmlFiles) {
  head('[2] 内部リンク切れ');
  let checked = 0;
  const linkRe = /(?:href|src)="([^"]+)"/g;
  // 壊れたリンクを「リンク文字列」ごとに集約（同一パターンの大量発生を1行にまとめる）
  const brokenByLink = {}; // link -> { count, examples: [rel,...] }
  for (const f of htmlFiles) {
    const rel = path.relative(ROOT, f);
    const content = fs.readFileSync(f, 'utf-8');
    let m;
    const seen = new Set();
    while ((m = linkRe.exec(content)) !== null) {
      const link = m[1];
      if (seen.has(link)) continue;
      seen.add(link);
      const target = resolveLink(link, f);
      if (!target) continue;
      checked++;
      let exists = fs.existsSync(target);
      if (!exists && !path.extname(target)) {
        exists = fs.existsSync(target + '.html') || fs.existsSync(path.join(target, 'index.html'));
      }
      if (!exists) {
        if (!brokenByLink[link]) brokenByLink[link] = { count: 0, examples: [] };
        brokenByLink[link].count++;
        if (brokenByLink[link].examples.length < 3) brokenByLink[link].examples.push(rel);
      }
    }
  }
  const brokenLinks = Object.keys(brokenByLink);
  if (brokenLinks.length === 0) {
    ok('リンク', `${checked}本の内部リンクすべて解決先が存在`);
  } else {
    for (const link of brokenLinks) {
      const info = brokenByLink[link];
      const where = info.count === 1 ? info.examples[0] : `${info.count}ファイル（例: ${info.examples.join(', ')}）`;
      err('リンク', `壊れたリンク "${link}"`, `${where} から参照`);
    }
  }
}

// ============================================================
// [3] articles.json 整合
// ============================================================
function checkArticles() {
  head('[3] articles.json と reports/ 実ファイルの整合');
  const apath = path.join(ROOT, 'data', 'articles.json');
  if (!fs.existsSync(apath)) { warn('articles', 'data/articles.json が見つからない'); return; }
  let articles;
  try { articles = JSON.parse(fs.readFileSync(apath, 'utf-8')); }
  catch (e) { err('articles', `articles.json のJSONパース失敗`, e.message); return; }
  if (!Array.isArray(articles)) { err('articles', 'articles.json が配列ではない'); return; }

  // (a) マニフェスト→実ファイル: 登録されているpathが実在するか（幽霊エントリ検出）
  const ghosts = [];
  for (const a of articles) {
    if (!a.path) { warn('articles', `path欠落のエントリ: ${JSON.stringify(a).slice(0,80)}`); continue; }
    if (!fs.existsSync(path.join(ROOT, a.path))) {
      ghosts.push(a);
      err('articles', `幽霊エントリ（実ファイルなし）: ${a.path}`, a.title || '');
    }
  }

  // (b) 実ファイル→マニフェスト: reports/直下の記事HTMLが登録されているか（登録漏れ検出）
  const registered = new Set(articles.map(a => a.path));
  const reportsDir = path.join(ROOT, 'reports');
  const orphanCandidates = [];
  if (fs.existsSync(reportsDir)) {
    for (const name of fs.readdirSync(reportsDir)) {
      if (!name.endsWith('.html') || name.includes('.bak')) continue;
      if (name === 'index.html') continue; // 一覧ページ自体は記事ではない
      const relPath = `reports/${name}`;
      if (!registered.has(relPath)) {
        orphanCandidates.push(relPath);
        warn('articles', `reports/に存在するが articles.json 未登録: ${relPath}`,
          'rebuild-site.bat（build-articles-manifest）の実行漏れの可能性');
      }
    }
  }

  // --fix: 幽霊エントリの削除（実ファイルが無い登録を除去）。これは安全に機械修復できる。
  if (DO_FIX && ghosts.length > 0) {
    const bak = apath + '.bak-' + tsLabel();
    fs.copyFileSync(apath, bak);
    const cleaned = articles.filter(a => a.path && fs.existsSync(path.join(ROOT, a.path)));
    fs.writeFileSync(apath, JSON.stringify(cleaned, null, 2));
    fixed('articles', `幽霊エントリ ${ghosts.length}件を削除（バックアップ: ${path.basename(bak)}）`);
  } else if (ghosts.length > 0) {
    console.log(`${C.gray}        （--fix で幽霊エントリを自動削除できます）${C.reset}`);
  }

  if (ghosts.length === 0 && orphanCandidates.length === 0) {
    ok('articles', `${articles.length}件のエントリと reports/ 実ファイルが双方向に一致`);
  }
}

// ============================================================
// [4] sitemap 網羅性
// ============================================================
function checkSitemap() {
  head('[4] sitemap 網羅性');
  const spath = path.join(ROOT, 'sitemap.xml');
  if (!fs.existsSync(spath)) { warn('sitemap', 'sitemap.xml が見つからない'); return; }
  const xml = fs.readFileSync(spath, 'utf-8');
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1].trim());
  if (locs.length === 0) { err('sitemap', '<loc> が1件もない'); return; }

  // ドメインを剥がしてローカルパスに変換
  let missing = 0;
  const SITE = /^https?:\/\/[^/]+\//;
  for (const loc of locs) {
    const rel = loc.replace(SITE, '');
    if (rel === '' || rel === '/') continue; // ルート
    let target = path.join(ROOT, rel.endsWith('/') ? rel + 'index.html' : rel);
    let exists = fs.existsSync(target);
    if (!exists && !path.extname(target)) {
      exists = fs.existsSync(target + '.html') || fs.existsSync(path.join(target, 'index.html'));
    }
    if (!exists) {
      err('sitemap', `sitemapに記載されたURLの実ファイルが無い: ${rel}`);
      missing++;
    }
  }

  // 主要ページの登録漏れ（最低限あるべきトップレベル）
  const mustHave = ['cards.html', 'events.html', 'stores.html', 'reports/', 'series/', 'sets/'];
  const locSet = locs.map(l => l.replace(SITE, ''));
  const notListed = mustHave.filter(p => !locSet.some(l => l === p || l === p.replace(/\/$/, '')));
  if (notListed.length > 0) {
    warn('sitemap', `主要ページがsitemap未掲載の可能性: ${notListed.join(', ')}`);
  }

  if (missing === 0) ok('sitemap', `${locs.length}件のURLすべて実ファイルが存在`);
}

// ============================================================
// [5] ?v= バージョン分布
// ============================================================
function checkVersions(htmlFiles) {
  head('[5] ?v= バージョン分布（common.js / style.css）');
  // カテゴリ判定: トップレベル / cards/ / events/ / reports-news / reports直下 / series / sets
  function category(rel) {
    if (rel.startsWith('cards/')) return 'cards/個別';
    if (rel.startsWith('events/')) return 'events/個別';
    if (rel.startsWith('reports/news/')) return 'reports/news';
    if (rel.startsWith('reports/')) return 'reports/記事';
    if (rel.startsWith('series/')) return 'series/';
    if (rel.startsWith('sets/')) return 'sets/';
    if (rel.startsWith('msa/')) return 'msa/';
    if (!rel.includes('/')) return 'トップレベル';
    return 'その他';
  }
  const dist = {}; // category -> { version -> count }
  const vRe = /common\.js\?v=(\d+)/;
  for (const f of htmlFiles) {
    const rel = path.relative(ROOT, f);
    const content = fs.readFileSync(f, 'utf-8');
    const m = content.match(vRe);
    const v = m ? `v${m[1]}` : '(なし)';
    const cat = category(rel);
    dist[cat] = dist[cat] || {};
    dist[cat][v] = (dist[cat][v] || 0) + 1;
  }
  // 表示: カテゴリ内でバージョンが複数混在していたら警告
  for (const cat of Object.keys(dist).sort()) {
    const versions = dist[cat];
    const vlist = Object.entries(versions).map(([v, n]) => `${v}×${n}`).join(', ');
    const distinct = Object.keys(versions).filter(v => v !== '(なし)');
    if (distinct.length > 1) {
      warn('version', `${cat}: common.js のバージョンが混在 → ${vlist}`,
        '同一カテゴリ内でバージョンが揃っていない。再生成漏れの可能性');
    } else {
      ok('version', `${cat}: ${vlist}`);
    }
  }
  console.log(`${C.gray}        （?v= はカテゴリごとに生成元が異なるため、カテゴリ内で揃っていれば正常）${C.reset}`);
}

function tsLabel() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

// ===== メイン =====
function main() {
  console.log(`${C.cyan}GCG STATS サイト健全性チェック${C.reset}  (${DO_FIX ? '--fix 有効' : '検査のみ'})`);
  const htmlFiles = collectHtml(ROOT, []);
  console.log(`対象HTML: ${htmlFiles.length} ファイル（.bak・data・images等は除外）`);

  checkTermination(htmlFiles);
  checkLinks(htmlFiles);
  checkArticles();
  checkSitemap();
  checkVersions(htmlFiles);

  // ===== サマリー =====
  head('サマリー');
  console.log(`  エラー : ${report.errors.length}`);
  console.log(`  警告   : ${report.warnings.length}`);
  if (report.fixes.length) console.log(`  自動修復: ${report.fixes.length}`);

  if (OUT_JSON) {
    const jpath = path.join(ROOT, 'data', 'site-integrity-report.json');
    fs.writeFileSync(jpath, JSON.stringify(report, null, 2));
    console.log(`\nJSONレポート: ${path.relative(ROOT, jpath)}`);
  }

  // 終了コード: エラーがあれば1（CIで検知できるように）
  process.exit(report.errors.length > 0 ? 1 : 0);
}

main();
