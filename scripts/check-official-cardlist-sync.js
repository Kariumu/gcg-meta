#!/usr/bin/env node
/**
 * scripts/check-official-cardlist-sync.js  (2026-07-28)
 * 公式カードリストと cards_master.json / 生成済みページの整合性を検査する（検査のみ・書き込みなし）。
 *
 * 背景:
 *  - 2026-07-28、公式「Freedom Ascension [GD05]」に過去弾型番のまま再録されたパラレル8種が
 *    cards_master.json 未登録のまま放置されていたことが判明した。既存の取得スクリプトは
 *    「弾コード連番」または「master の基本カード + _pN」しか照会IDを組み立てないため、
 *    どちらの担当範囲にも入らない“隙間”が生じていた。
 *  - 同日、cards/ 配下のディスク上の全ディレクトリを push 候補にした結果、マスタ未登録の
 *    残骸ページ9件（OCR誤認識由来の不正ID）を公開してしまった（commit 8dfbcd3 → deb7f08 で削除）。
 *  - 本スクリプトは、この2種類の事故を公開前に検出することを目的とする。
 *
 * 検査内容:
 *  [L1] cards/ 配下の各ディレクトリが master または許可リストに存在するか（不正ページ検出）
 *       許可リストは data/cards_preview.json（自動蓄積）と data/preview_card_pages.json（手動例外）の和集合
 *  [L2] master の各IDに cards/<id>/index.html が存在するか（ページ生成漏れ）
 *  [L3] master の各IDに images/cards/<id>.webp が存在するか（画像欠落）
 *  [O1] 公式のカテゴリ一覧が既知のものと一致するか（新弾追加の検知）
 *  [O2] 公式各カテゴリの掲載件数とID一覧を取得し、master と突合
 *        - 公式にあって master に無い
 *            · リソース/ベース系プレフィックス（R- / EXB- / EXR- / RP- / EXBP- / EXRP-）→ 方針により除外（情報）
 *            · data/preview_card_pages.json の excluded_ids に載っている → 承認済み除外（情報）
 *            · それ以外 → ★要対応
 *        - master にあって公式に無い → ★要確認（掲載終了 or 誤登録）
 *
 * 終了コード: 0=問題なし / 1=要対応あり / 2=実行エラー
 *
 * 公式サーバ配慮: 1リクエスト 1.5 秒間隔（他スクリプトと同値、変更禁止）。全22リクエスト＝約35秒。
 *
 * 使い方（E:\GCGSTATS）:
 *   node scripts\check-official-cardlist-sync.js             # 全検査
 *   node scripts\check-official-cardlist-sync.js --offline   # 公式アクセスなし（L1〜L3 のみ、即時）
 *   node scripts\check-official-cardlist-sync.js --quiet     # 問題のみ表示
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const cheerio = require('cheerio');

const ROOT = path.resolve(__dirname, '..');
const MASTER_PATH = process.env.CARDS_MASTER_PATH || path.join(ROOT, 'data', 'cards_master.json');
const ALLOW_PATH = path.join(ROOT, 'data', 'preview_card_pages.json');
const PREVIEW_DATA_PATH = path.join(ROOT, 'data', 'cards_preview.json');
const REPORT_PATH = path.join(ROOT, 'tmp', 'cardlist-sync-report.json');
const REQUEST_DELAY_MS = 1500; // 公式サーバ配慮（変更禁止）
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const LIST_URL = 'https://www.gundam-gcg.com/jp/cards/';

/** リソース/ベース系（松岡さん方針により cards_master.json へ取り込まない） */
const RESOURCE_LIKE = /^(R|EXB|EXR|RP|EXBP|EXRP)-\d/;

/** 2026-07-28 時点で確認済みのカテゴリ。公式から自動取得した一覧と突合し、増減を検知する */
const KNOWN_PACKAGES = {
  '615000': 'リミテッドBOX Ver.β', '615001': 'Heroic Beginnings [ST01]', '615002': 'Wings of Advance [ST02]',
  '615003': "Zeon's Rush [ST03]", '615004': 'SEED Strike [ST04]', '615005': 'Iron Bloom [ST05]',
  '615006': 'Clan Unity [ST06]', '615007': 'Celestial Drive [ST07]', '615008': 'Flash of Radiance [ST08]',
  '615009': 'Destiny Ignition [ST09]', '615010': 'Generation Pulse [ST10]', '615101': 'Newtype Rising [GD01]',
  '615102': 'Dual Impact [GD02]', '615103': 'Steel Requiem [GD03]', '615104': 'Phantom Aria [GD04]',
  '615105': 'Freedom Ascension [GD05]', '615201': 'Eternal Nexus [EB01]',
  '615301': 'カスタムデッキボックス Freedom Ascension [SC01]',
  '615701': '限定商品収録カード', '615801': '基本カード', '615901': 'プロモーションカード',
};

const args = process.argv.slice(2);
const OFFLINE = args.includes('--offline');
const QUIET = args.includes('--quiet');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => { if (!QUIET) console.log(s); };

function fetchHtml(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html' } }, (res) => {
      if (res.statusCode !== 200) { resolve(null); res.resume(); return; }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    }).on('error', reject);
  });
}

/** カードリスト top から package の値とラベルを抽出（サーバー描画、2026-07-28 確認） */
function parsePackages(html) {
  const $ = cheerio.load(html);
  const map = {};
  $('a[class*="js-selectBtn-package"]').each((_, el) => {
    const v = $(el).attr('data-val');
    if (v) map[v] = $(el).text().trim();
  });
  return map;
}

/** 検索結果から 掲載件数 と カードID一覧 を抽出 */
function parseList(html) {
  const $ = cheerio.load(html);
  const numText = $('.num').first().text().trim();
  const reported = /^\d+$/.test(numText) ? parseInt(numText, 10) : null;
  const ids = [];
  $('li.cardItem').each((_, el) => {
    const img = $(el).find('img').first();
    const src = img.attr('data-src') || img.attr('src') || '';
    const m = src.match(/([A-Za-z0-9]+-\d{3}(?:_p\d+)?)\.webp/);
    if (m) ids.push(m[1]);
  });
  return { reported, ids };
}

/**
 * 意図的な公開ページの許可リストを2系統から読む。
 *  (1) data/cards_preview.json … 毎日のニュース生成（auto-news.js）が公式Xの新カード紹介から蓄積し、
 *      scripts/post-processing.js がこれを元に cards/<id>/index.html を生成する。自動・追記不要。
 *  (2) data/preview_card_pages.json … 手動の例外リスト。(1) から古いエントリが整理された後も
 *      ページが残っている場合の受け皿（cards_preview.json は過去に大きく削減された実績がある）。
 * どちらかに載っていれば正当なページとして扱う。
 */
function loadAllow() {
  const preview = new Set();
  const sources = [];
  let excluded = new Set();
  let missingFile = false;

  if (fs.existsSync(PREVIEW_DATA_PATH)) {
    try {
      const pv = JSON.parse(fs.readFileSync(PREVIEW_DATA_PATH, 'utf-8'));
      const ids = Object.keys(pv);
      ids.forEach((id) => preview.add(id));
      sources.push('cards_preview.json ' + ids.length + '件');
    } catch (e) {
      sources.push('cards_preview.json 読込失敗(' + e.message + ')');
    }
  } else {
    sources.push('cards_preview.json なし');
  }

  if (fs.existsSync(ALLOW_PATH)) {
    const j = JSON.parse(fs.readFileSync(ALLOW_PATH, 'utf-8'));
    const ids = (j.preview_pages || []).map((p) => p.id);
    ids.forEach((id) => preview.add(id));
    excluded = new Set(j.excluded_ids || []);
    sources.push('preview_card_pages.json ' + ids.length + '件');
  } else {
    missingFile = true;
    sources.push('preview_card_pages.json なし');
  }

  return { preview, excluded, missingFile, sources };
}

(async () => {
  const master = JSON.parse(fs.readFileSync(MASTER_PATH, 'utf-8'));
  const masterIds = new Set(Object.keys(master));
  const allow = loadAllow();
  const problems = [];   // ★要対応
  const notices = [];    // 情報・要確認
  const report = { checkedAt: null, master: masterIds.size, local: {}, official: {} };

  log('GCG STATS カードリスト整合性チェック' + (OFFLINE ? '（--offline: ローカルのみ）' : ''));
  log('  master: ' + masterIds.size + ' 件');
  if (allow.missingFile && allow.preview.size === 0) notices.push('許可リストが1件も読めません（data/cards_preview.json と data/preview_card_pages.json の両方が不在）');
  log('  許可リスト: プレビュー ' + allow.preview.size + ' 件 / 承認済み除外 ' + allow.excluded.size + ' 件'
    + '（出典: ' + allow.sources.join(' + ') + '）');

  // ---- [L1] cards/ 配下にマスタ未登録・許可リスト外のページが無いか ----
  log('\n[L1] cards/ 配下の不正ページ検査');
  const cardsDir = path.join(ROOT, 'cards');
  const dirs = fs.existsSync(cardsDir)
    ? fs.readdirSync(cardsDir).filter((n) => fs.existsSync(path.join(cardsDir, n, 'index.html')))
    : [];
  const junk = dirs.filter((n) => !masterIds.has(n) && !allow.preview.has(n));
  const previewOk = dirs.filter((n) => !masterIds.has(n) && allow.preview.has(n));
  log('  ページ総数 ' + dirs.length + ' / マスタ登録 ' + (dirs.length - junk.length - previewOk.length) + ' / プレビュー許可 ' + previewOk.length + ' / 不正 ' + junk.length);
  for (const n of previewOk) log('    (許可) ' + n);
  for (const n of junk) problems.push('[L1] マスタ未登録かつ許可リスト外のページ: cards/' + n + '/index.html');
  report.local.pages = dirs.length; report.local.junk = junk; report.local.preview = previewOk;

  // ---- [L2] master のページ生成漏れ ----
  log('\n[L2] ページ生成漏れ検査');
  const noPage = [...masterIds].filter((id) => !fs.existsSync(path.join(cardsDir, id, 'index.html')));
  log('  欠落 ' + noPage.length + ' 件');
  for (const id of noPage) problems.push('[L2] ページ未生成: ' + id);
  report.local.missingPages = noPage;

  // ---- [L3] 画像欠落 ----
  log('\n[L3] カード画像の欠落検査');
  const noImg = [...masterIds].filter((id) => !fs.existsSync(path.join(ROOT, 'images', 'cards', id + '.webp')));
  log('  欠落 ' + noImg.length + ' 件');
  for (const id of noImg) problems.push('[L3] 画像未取得: images/cards/' + id + '.webp');
  report.local.missingImages = noImg;

  if (OFFLINE) {
    finish();
    return;
  }

  // ---- [O1] 公式カテゴリ一覧 ----
  log('\n[O1] 公式カテゴリ一覧の検査');
  const topHtml = await fetchHtml(LIST_URL);
  if (!topHtml) { console.error('中止: 公式カードリスト top を取得できませんでした'); process.exit(2); }
  const packages = parsePackages(topHtml);
  const found = Object.keys(packages);
  if (found.length === 0) { console.error('中止: カテゴリを1件も抽出できませんでした（公式のHTML構造変更の可能性）'); process.exit(2); }
  const added = found.filter((v) => !KNOWN_PACKAGES[v]);
  const removed = Object.keys(KNOWN_PACKAGES).filter((v) => !packages[v]);
  log('  公式 ' + found.length + ' カテゴリ / 既知 ' + Object.keys(KNOWN_PACKAGES).length + ' カテゴリ');
  for (const v of added) problems.push('[O1] 未知のカテゴリが追加されています: ' + v + ' 「' + packages[v] + '」→ 新弾の可能性。取り込み要否を判断し KNOWN_PACKAGES に追記してください');
  for (const v of removed) notices.push('[O1] 既知カテゴリが公式から消えています: ' + v + ' 「' + KNOWN_PACKAGES[v] + '」');
  report.official.packages = packages;

  // ---- [O2] カテゴリごとの突合 ----
  log('\n[O2] 公式カードリストとの突合（1.5秒間隔・' + found.length + 'カテゴリ）');
  const officialAll = new Map(); // id -> [カテゴリ名]
  const counts = {};
  for (const v of found) {
    await sleep(REQUEST_DELAY_MS);
    const html = await fetchHtml('https://www.gundam-gcg.com/jp/cards/index.php?package=' + encodeURIComponent(v));
    if (!html) { problems.push('[O2] カテゴリ ' + v + '「' + packages[v] + '」の取得に失敗'); continue; }
    const { reported, ids } = parseList(html);
    counts[packages[v]] = { reported, parsed: ids.length };
    if (reported !== null && reported !== ids.length) {
      problems.push('[O2] ' + packages[v] + ': 公式表示 ' + reported + ' 件に対し抽出 ' + ids.length + ' 件（HTML構造変更またはページング未対応の可能性）');
    }
    for (const id of ids) {
      if (!officialAll.has(id)) officialAll.set(id, []);
      officialAll.get(id).push(packages[v]);
    }
    log('  ' + packages[v] + ': ' + ids.length + ' 件');
  }

  const missing = [...officialAll.keys()].filter((id) => !masterIds.has(id));
  const byPolicy = missing.filter((id) => RESOURCE_LIKE.test(id));
  const approved = missing.filter((id) => !RESOURCE_LIKE.test(id) && allow.excluded.has(id));
  const actionable = missing.filter((id) => !RESOURCE_LIKE.test(id) && !allow.excluded.has(id));
  const extra = [...masterIds].filter((id) => !officialAll.has(id));

  log('\n  公式ユニーク ' + officialAll.size + ' 件 / master ' + masterIds.size + ' 件');
  log('  公式にあって master に無い: ' + missing.length + ' 件');
  log('    · リソース/ベース系（方針により除外）: ' + byPolicy.length + ' 件');
  log('    · 承認済み除外: ' + approved.length + ' 件');
  log('    · ★要対応: ' + actionable.length + ' 件');
  for (const id of actionable) {
    problems.push('[O2] 公式に存在するが master 未登録: ' + id + '（収録: ' + officialAll.get(id).join(' / ') + '）');
  }
  // master 側にしか無いIDは件数が多くなりうるため、先頭15件のみ表示（全件はレポートJSONに出力）
  if (extra.length) {
    const head = extra.slice(0, 15);
    notices.push('[O2] master にあるが公式カードリストに無い: ' + extra.length + ' 件 → ' + head.join(', ') + (extra.length > head.length ? ' ...他 ' + (extra.length - head.length) + ' 件（全件は ' + REPORT_PATH + '）' : ''));
  }
  report.official.uniqueIds = officialAll.size;
  report.official.counts = counts;
  report.official.missing = { byPolicy, approved, actionable };
  report.official.extra = extra;

  finish();

  function finish() {
    report.checkedAt = new Date().toISOString();
    report.problems = problems;
    report.notices = notices;
    try {
      fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
      fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf-8');
    } catch (e) { /* レポート保存失敗は致命ではない */ }

    console.log('\n===== 結果 =====');
    if (notices.length) {
      console.log('要確認・情報 ' + notices.length + ' 件:');
      for (const n of notices) console.log('  · ' + n);
    }
    if (problems.length) {
      console.log('★要対応 ' + problems.length + ' 件:');
      for (const p of problems) console.log('  ! ' + p);
      console.log('\nレポート: ' + REPORT_PATH);
      process.exit(1);
    }
    console.log('問題なし。');
    console.log('レポート: ' + REPORT_PATH);
    process.exit(0);
  }
})().catch((e) => { console.error('致命的エラー:', e.message); process.exit(2); });
// EOF
