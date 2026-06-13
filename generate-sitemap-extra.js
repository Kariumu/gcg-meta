#!/usr/bin/env node
/**
 * generate-sitemap-extra.js
 * sitemap.xml に series/ ・ sets/ ・ reports/news/ の URL を追記する補助スクリプト。
 * 指示書 v7-フェーズ2 Task 2-3(c)。
 *
 * 【重要・実行順序】
 *   - sitemap.xml を全再生成する generate_cards.js の「後」に実行すること
 *     (generate_cards.js は main + cards/ のみで sitemap を作り直すため、
 *      先に実行しないと本スクリプトの追記が消える)。
 *   - generate-report.js は reports/ 配下を正規表現で削除→再追記するため、
 *     本スクリプトは sitemap を触る一連の処理の「最後」に実行すること
 *     (順序を誤ると reports/news/ 分が generate-report.js に消される)。
 *
 * 冪等: 既存の series/ ・ sets/ ・ reports/news/ ブロックを一旦削除してから再追記。
 *
 * 検証メモ: Cowork サンドボックスの mount は大きい sitemap.xml を NUL 切断するため、
 *   本スクリプトの動作確認は松岡さんのローカル実 FS で行うこと。
 *
 * Usage:
 *   node generate-sitemap-extra.js
 *   NEWS_OUTPUT_ROOT=/path/to/site node generate-sitemap-extra.js   # 隔離検証用
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.env.NEWS_OUTPUT_ROOT || __dirname;
const SITE_URL = 'https://gcg-stats.com';
const sitemapPath = path.join(ROOT, 'sitemap.xml');

function htmlFiles(relDir) {
  const abs = path.join(ROOT, relDir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs).filter(f => f.endsWith('.html')).sort();
}

function urlBlock(loc, changefreq, priority, lastmod) {
  return '\n  <url>\n' +
    '    <loc>' + loc + '</loc>\n' +
    '    <changefreq>' + changefreq + '</changefreq>\n' +
    '    <priority>' + priority + '</priority>\n' +
    '    <lastmod>' + lastmod + '</lastmod>\n' +
    '  </url>';
}

function main() {
  if (!fs.existsSync(sitemapPath)) {
    console.error('sitemap.xml が見つかりません: ' + sitemapPath);
    process.exit(1);
  }
  let xml = fs.readFileSync(sitemapPath, 'utf-8');
  if (xml.indexOf('</urlset>') === -1) {
    console.error('sitemap.xml に </urlset> がありません。中断します。');
    process.exit(1);
  }
  const now = new Date().toISOString().split('T')[0];

  // 既存の series/ ・ sets/ ・ reports/news/ ブロックを削除(冪等)
  xml = xml.replace(/\s*<url>\s*<loc>https:\/\/gcg-stats\.com\/(series|sets)\/[^<]*<\/loc>[\s\S]*?<\/url>/g, '');
  xml = xml.replace(/\s*<url>\s*<loc>https:\/\/gcg-stats\.com\/reports\/news\/[^<]*<\/loc>[\s\S]*?<\/url>/g, '');

  let blocks = '';
  let counts = { series: 0, sets: 0, news: 0 };

  // series/ (ディレクトリ + 各シリーズページ)
  blocks += urlBlock(SITE_URL + '/series/', 'weekly', '0.6', now);
  for (const f of htmlFiles('series')) {
    if (f === 'index.html') continue;
    blocks += urlBlock(SITE_URL + '/series/' + f, 'weekly', '0.5', now);
    counts.series++;
  }

  // sets/ (ディレクトリ + 各セットページ。毎日自動再生成のため changefreq=daily)
  blocks += urlBlock(SITE_URL + '/sets/', 'daily', '0.7', now);
  for (const f of htmlFiles('sets')) {
    if (f === 'index.html') continue;
    blocks += urlBlock(SITE_URL + '/sets/' + f, 'daily', '0.6', now);
    counts.sets++;
  }

  // reports/news/ (各ニュース記事)
  for (const f of htmlFiles('reports/news')) {
    if (f === 'index.html') continue;
    blocks += urlBlock(SITE_URL + '/reports/news/' + f, 'monthly', '0.4', now);
    counts.news++;
  }

  xml = xml.replace('</urlset>', blocks + '\n</urlset>');
  fs.writeFileSync(sitemapPath, xml, 'utf-8');

  console.log('  → sitemap.xml 追記完了: series ' + counts.series +
    ' / sets ' + counts.sets + ' / reports-news ' + counts.news + ' 件');
}

main();
