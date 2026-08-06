#!/usr/bin/env node
/**
 * generate-events.js
 * イベント個別ページ (events/{event_id}.html) を静的生成し、sitemap.xml を更新する
 */

const fs = require('fs');
const path = require('path');
const { pushFiles } = require('./git-push');

// === NTC順位集計統合(指示書 NTC順位集計統合_最終版.md, 2026-05-18 実装、2026-05-19 type ベース対応) ===
// 64名定員NTC大会(results.length>=16)を「ベスト8(各順位2名)」表記に変換。
// 32名定員大会・他大会には一切影響を与えない(R2/R5 厳守)。
// SEO HTML/個別ページは表記のみ参照のため軽量モード(getDeckColors 注入なし)で十分。
// NTC 判定は series.json の type='ntc' を参照(MISSION2/3/4... に自動対応)。
const {
  consolidateNtcRank,
  isTargetEvent,
  makeIsNtcTypeFromSeriesMap
} = require('./shared/ntc-rank-consolidator');

let SERIES_MAP_FOR_NTC = {};
try {
  SERIES_MAP_FOR_NTC = JSON.parse(
    require('fs').readFileSync(require('path').join(__dirname, 'data', 'series.json'), 'utf-8')
  );
} catch (_) {}
const isNtcType = makeIsNtcTypeFromSeriesMap(SERIES_MAP_FOR_NTC);

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const EVENTS_DIR = path.join(ROOT, 'events');
const SITE_URL = 'https://gcg-stats.com';

// カードマスターデータ（カード名表示用）
let cardsMaster = {};
try {
  cardsMaster = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'cards_master.json'), 'utf-8'));
} catch (e) {
  console.warn('  ⚠ cards_master.json が見つかりません。カードIDのみで生成します。');
}

function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  return dateStr.replace(/-/g, '.');
}

function rankText(rank) {
  if (rank === 1) return '優勝';
  if (rank === 2) return '準優勝';
  return rank + '位';
}

function deckToText(deck) {
  if (!deck || deck.length === 0) return 'デッキ情報なし';
  return deck.map(c => {
    const name = cardsMaster[c.card_id] ? cardsMaster[c.card_id].name_jp : '';
    return name ? (c.card_id + '(' + name + ') x' + c.count) : (c.card_id + ' x' + c.count);
  }).join(', ');
}

function deckToLinkedHtml(deck) {
  if (!deck || deck.length === 0) return 'デッキ情報なし';
  return deck.map(c => {
    const name = cardsMaster[c.card_id] ? escapeHtml(cardsMaster[c.card_id].name_jp) : '';
    const label = name ? (escapeHtml(c.card_id) + '(' + name + ') x' + c.count) : (escapeHtml(c.card_id) + ' x' + c.count);
    return '<a href="../cards/' + c.card_id + '/" style="color:var(--text-muted)">' + label + '</a>';
  }).join(', ');
}

function generateSeoContent(ev, seriesName, { linkCards = false } = {}) {
  const results = (ev.results || []).sort((a, b) => a.rank - b.rank);
  let h = '<h2>' + escapeHtml(ev.store) + ' 大会結果</h2>';
  h += '<p>開催日: ' + formatDate(ev.date) + '</p>';
  if (ev.region) h += '<p>地域: ' + escapeHtml(ev.region) + '</p>';
  if (seriesName) h += '<p>シリーズ: ' + escapeHtml(seriesName) + '</p>';
  h += '<h3>順位一覧</h3><ol>';
  for (const r of results) {
    // Top 3 finishers get linked cards (noscript only), rest plain text
    const deckHtml = (linkCards && r.rank <= 3) ? deckToLinkedHtml(r.deck) : escapeHtml(deckToText(r.deck));
    // 選手名を持たないデータ(デッキログ由来・指示書63)では名前欄を出さない
    const nameText = r.player ? ': ' + escapeHtml(r.player) : '';
    h += '<li>' + rankText(r.rank) + nameText + ' - デッキ: ' + deckHtml + '</li>';
  }
  h += '</ol>';
  // Internal links section
  h += '<h3>関連リンク</h3><ul>';
  h += '<li><a href="index.html">大会結果一覧</a></li>';
  h += '<li><a href="../index.html">GCG STATS トップ</a></li>';
  h += '<li><a href="../cards.html">カード一覧</a></li>';
  h += '<li><a href="../reports/">レポート・分析</a></li>';
  h += '</ul>';
  return h;
}

// クライアントサイドJSテンプレート（event.htmlからコピーし、パスを ../に調整）
// ${EVENT_ID} は生成時に置換される
//
// === 入賞デッキ → デッキビルダー導線（2026-08-06 追加・指示書66 §4） ===
// 「🛠 デッキビルダーで開く」ボタンを全デッキに描画する（TCG+リンクがある場合は併記）。
// 実装本体は js/common.js の GCG.loadShareDb() / GCG.openDeckInBuilder() 側にあり、
// ここに置くのは最小のスタブ（デッキのレジストリと onclick の受け口）だけ。
// 理由: このテンプレートは 833 ページすべてにインライン展開されるため、ここに実装を
//       書くとページ数ぶん初期転送量が増える。common.js は全ページ共通で1回だけ
//       取得・キャッシュされるので、実装はそちらに置く。
// 依存の取得は「初回クリック時のみ」（deckbuilder-core.js / cards_master.json /
// cards_preview.json）。初期表示では一切取得しない。
// 旧い common.js がキャッシュされている環境では GCG.openDeckInBuilder が未定義に
// なるため、その場合は従来の「デッキリストをコピー」動作へ静かに退避する
// （common.js の ?v= はバンプしない方針のため。指示書66 §7）。
const CLIENT_JS_TEMPLATE = `
    GCG.init();

    var currentEventStore = '';

    // shijisho-66: deck -> builder. Logic lives in common.js (see generate-events.js).
    var _deckReg = [];
    function openInBuilder(i, btn) {
      var d = _deckReg[i];
      if (!d || !d.length) return;
      if (typeof GCG.openDeckInBuilder !== 'function') {
        btn.textContent = '\\u{1F4CB} \\u30C7\\u30C3\\u30AD\\u30EA\\u30B9\\u30C8\\u3092\\u30B3\\u30D4\\u30FC';
        return GCG.copyToClipboard(GCG.deckToText(d), btn);
      }
      GCG.openDeckInBuilder(d, btn, currentEventStore);
    }

    function renderPlayerCard(player, animDelay) {
      const hasDeck = player.deck && player.deck.length > 0;
      const tagClass = player.rank === 1 ? 'tag-win' : 'tag-rate';
      const delayStyle = animDelay !== undefined
        ? 'animation:fadeIn 0.4s ease-out backwards;animation-delay:' + animDelay + 's'
        : 'animation:fadeIn 0.4s ease-out backwards';

      let linkHtml = '';
      if (player.tcgplus_url) {
        linkHtml = '<a href="' + GCG.escapeHtml(player.tcgplus_url) + '" target="_blank" rel="noopener" class="btn-link">' +
          '\\u{1F517} BANDAI TCG+ \\u3067\\u898B\\u308B' +
          '<span style="font-size:10px;color:var(--text-muted);margin-left:2px">\\u203BTCG+\\u306B\\u9077\\u79FB\\u3057\\u307E\\u3059</span>' +
          '</a>';
      }
      if (hasDeck) {
        var deckIdx = _deckReg.push(player.deck) - 1;
        linkHtml += '<button class="btn-copy" onclick="openInBuilder(' + deckIdx + ', this)">' +
          '\\u{1F6E0}\\uFE0F \\u30C7\\u30C3\\u30AD\\u30D3\\u30EB\\u30C0\\u30FC\\u3067\\u958B\\u304F</button>';
      }

      let deckHtml = '';
      if (hasDeck) {
        deckHtml = '<div class="deck-grid">' +
          player.deck.map(function(card) {
            return '<a href="' + GCG.getBasePath() + 'cards/' + card.card_id + '/?from=event&name=' + encodeURIComponent(currentEventStore) + '" class="deck-card" title="' + card.card_id + '">' +
              '<img src="' + GCG.cardImageUrl(card.card_id) + '" alt="' + card.card_id + '"' +
              ' onerror="this.onerror=null;this.style.display=\\'none\\';this.parentElement.insertAdjacentHTML(\\'afterbegin\\',\\'<div style=&quot;aspect-ratio:63/88;background:var(--bg-elevated);display:flex;align-items:center;justify-content:center;font-size:10px;color:var(--text-muted);font-family:var(--font-mono);padding:4px;text-align:center&quot;>' + card.card_id + '</div>\\')">' +
              '<span class="card-count">\\u00D7' + card.count + '</span>' +
              '</a>';
          }).join('') +
          '</div>';
      } else {
        deckHtml = '<div style="color:var(--text-muted);font-size:13px;padding:16px 0">\\u30C7\\u30C3\\u30AD\\u60C5\\u5831\\u306A\\u3057</div>';
      }

      return '<div style="margin-bottom:36px;' + delayStyle + '">' +
        '<div style="display:flex;align-items:center;gap:14px;margin-bottom:14px;flex-wrap:wrap">' +
        '<span class="tag ' + tagClass + '" style="font-size:13px;min-width:52px;text-align:center">' +
        GCG.rankText(player.rank) + '</span>' +
        '<span style="font-size:16px;font-weight:600">' + GCG.escapeHtml(player.player) + '</span>' +
        linkHtml +
        '</div>' +
        deckHtml +
        '</div>';
    }

    async function renderEvent() {
      const data = await GCG.loadEvents();
      // series データを事前ロード(NTC順位集計の type ベース判定に使用)
      if (GCG.loadSeries) await GCG.loadSeries();
      var eventId = '{{EVENT_ID}}';
      // 64名NTC大会のみ「ベスト8(各順位2名)」表記に変換(クライアント側軽量モード)
      // 32名・他大会は no-op(R2/R5 厳守)
      const ev = GCG.consolidateNtcRank
        ? GCG.consolidateNtcRank(data.events[eventId])
        : data.events[eventId];
      if (!ev) {
        document.getElementById('event-content').innerHTML = '<p>\\u30A4\\u30D9\\u30F3\\u30C8\\u304C\\u898B\\u3064\\u304B\\u308A\\u307E\\u305B\\u3093\\u3002</p>';
        return;
      }

      document.title = ev.store + ' ' + GCG.formatDate(ev.date) + ' - GCG STATS';
      currentEventStore = ev.store;

      // schedule.json\u304B\u3089organizer_id\u3092\u691C\u7D22
      var organizerId = null;
      try {
        var schedRes = await fetch(GCG.getBasePath() + 'data/schedule.json');
        var schedData = await schedRes.json();
        var stores = schedData.stores || {};
        Object.keys(stores).some(function(storeId) {
          if (stores[storeId].name === ev.store) {
            organizerId = storeId;
            return true;
          }
          return false;
        });
      } catch(e) {}

      var storeDisplay = GCG.escapeHtml(ev.store);

      const seriesName = data.series[ev.series_id] || '';

      // パンくずリスト
      let breadcrumbHtml = '';
      if (typeof GCG.renderBreadcrumb === 'function') {
        var bcItems = [
          { name: 'トップ', href: GCG.getBasePath() },
          { name: 'イベント', href: GCG.getBasePath() + 'events.html' }
        ];
        if (seriesName && ev.series_id) {
          bcItems.push({ name: seriesName, href: GCG.getBasePath() + 'series/' });
        }
        bcItems.push({ name: ev.store + ' ' + GCG.formatDate(ev.date) });
        breadcrumbHtml = GCG.renderBreadcrumb(bcItems);
      }

      let html = breadcrumbHtml +
        '<div class="section-header"><div>' +
        '<h1 class="section-title" style="margin-bottom:6px;font-size:16px">' + storeDisplay + '</h1>' +
        '<div style="font-size:13px;color:var(--text-secondary);display:flex;align-items:center;gap:8px;flex-wrap:wrap">' +
        '<span class="text-mono" style="color:var(--accent)">' + GCG.formatDate(ev.date) + '</span>' +
        (seriesName ? '<span style="opacity:0.3">|</span> <span>' + GCG.escapeHtml(seriesName) + '</span>' : '') +
        '</div></div>' +
        '<span class="section-badge">' + (ev.results || []).length + '\\u540D\\u53C2\\u52A0</span></div>';

      const results = (ev.results || []).sort(function(a, b) { return a.rank - b.rank; });

      for (var i = 0; i < results.length; i++) {
        html += renderPlayerCard(results[i], i * 0.06);
      }

      // 関連大会セクションを構築
      try {
        var allEvs = Object.values(data.events || {});

        // 同店舗の過去大会（最大 5 件）
        var sameStore = allEvs
          .filter(function(e){ return e.event_id !== ev.event_id && e.store === ev.store; })
          .sort(function(a, b){ return (b.date || '').localeCompare(a.date || ''); })
          .slice(0, 5);

        // 同シリーズ±3日の大会（最大 10 件）
        var sameSeriesNearDate = [];
        if (ev.date) {
          var baseMs = Date.parse(ev.date);
          if (!isNaN(baseMs)) {
            var THREE_DAYS = 3 * 24 * 60 * 60 * 1000;
            sameSeriesNearDate = allEvs
              .filter(function(e){
                if (e.event_id === ev.event_id) return false;
                if (String(e.series_id) !== String(ev.series_id)) return false;
                if (!e.date) return false;
                var dMs = Date.parse(e.date);
                if (isNaN(dMs)) return false;
                return Math.abs(dMs - baseMs) <= THREE_DAYS;
              })
              .sort(function(a, b){
                var da = Math.abs(Date.parse(a.date) - baseMs);
                var db = Math.abs(Date.parse(b.date) - baseMs);
                return da - db;
              })
              .slice(0, 10);
          }
        }

        function relatedCard(e) {
          return '<a href="' + GCG.getBasePath() + 'events/' + encodeURIComponent(e.event_id) + '.html" class="event-card">' +
                 '<span class="event-date">' + GCG.formatDate(e.date) + '</span>' +
                 '<span class="event-store">' + GCG.escapeHtml(e.store) + '</span>' +
                 '</a>';
        }

        var relatedHtml = '';
        if (sameStore.length > 0) {
          relatedHtml += '<section style="margin:24px 0">' +
                         '<h2 style="font-size:15px;color:var(--text-primary);margin:16px 0 10px">同店舗の過去大会（' + sameStore.length + '件）</h2>' +
                         sameStore.map(relatedCard).join('') +
                         '</section>';
        }
        if (sameSeriesNearDate.length > 0) {
          relatedHtml += '<section style="margin:24px 0">' +
                         '<h2 style="font-size:15px;color:var(--text-primary);margin:16px 0 10px">同シリーズ±3日の大会（' + sameSeriesNearDate.length + '件）</h2>' +
                         sameSeriesNearDate.map(relatedCard).join('') +
                         '</section>';
        }
        html += relatedHtml;
      } catch(e) { /* 無視 */ }

      html += '<div id="share-buttons" style="margin-top:16px"></div>';
      document.getElementById('event-content').innerHTML = html;
      GCG.renderShareButtons('share-buttons', ev.store + ' ' + GCG.formatDate(ev.date) + ' \\u5927\\u4F1A\\u7D50\\u679C | GCG STATS');
    }

    document.getElementById('header').innerHTML = GCG.renderHeader('events');
    document.getElementById('footer').innerHTML = GCG.renderFooter();

    renderEvent();
`;

function generateEventPage(eventId, evRaw, seriesName) {
  // 64名NTC大会(results.length>=16)のみ「ベスト8(各順位2名)」表記に変換、
  // それ以外は no-op で素通し。以後の処理は変換後の ev で行う。
  const ev = consolidateNtcRank(evRaw, { isNtcType });
  const storeName = escapeHtml(ev.store);
  const dateFormatted = formatDate(ev.date);
  // 64名NTC大会では新rank=1 が2名いるが、find は先頭1件のみ取得(OG/twitter card 用途のため許容)
  const winnerResult = (ev.results || []).find(r => r.rank === 1);
  const winnerName = winnerResult ? escapeHtml(winnerResult.player) : '';
  // 選手名が無いデータ(デッキログ由来・指示書63)では「優勝: 」を出さない
  const winnerText = winnerName ? '優勝: ' + winnerName : '';
  const noscriptContent = generateSeoContent(ev, seriesName, { linkCards: true });
  const seoContent = generateSeoContent(ev, seriesName, { linkCards: false });

  // クライアントJSのイベントIDを置換
  const clientJs = CLIENT_JS_TEMPLATE.replace('{{EVENT_ID}}', eventId);

  // JSON-LD BreadcrumbList
  const jsonLd = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      {"@type": "ListItem", "position": 1, "name": "ホーム", "item": SITE_URL + "/"},
      {"@type": "ListItem", "position": 2, "name": "大会結果", "item": SITE_URL + "/events/"},
      {"@type": "ListItem", "position": 3, "name": storeName + ' ' + dateFormatted}
    ]
  });

  // Breadcrumb nav (static, for crawlers)
  const breadcrumbNav =
'    <nav class="breadcrumb" style="margin-bottom:12px;font-size:12px;color:var(--text-muted);font-family:var(--font-mono)">\n' +
'      <a href="../index.html" style="color:var(--text-muted);text-decoration:none" onmouseover="this.style.color=\'var(--accent)\'" onmouseout="this.style.color=\'var(--text-muted)\'">ホーム</a>\n' +
'      <span style="margin:0 6px">›</span>\n' +
'      <a href="index.html" style="color:var(--text-muted);text-decoration:none" onmouseover="this.style.color=\'var(--accent)\'" onmouseout="this.style.color=\'var(--text-muted)\'">大会結果</a>\n' +
'      <span style="margin:0 6px">›</span>\n' +
'      <span style="color:var(--text-secondary)">' + storeName + ' ' + dateFormatted + '</span>\n' +
'    </nav>\n';

  return '<!DOCTYPE html>\n' +
'<html lang="ja">\n' +
'<head>\n' +
'  <!-- Google Analytics -->\n' +
'  <script async src="https://www.googletagmanager.com/gtag/js?id=G-3MY17P4E7F"></script>\n' +
'  <script>\n' +
'    window.dataLayer = window.dataLayer || [];\n' +
'    function gtag(){dataLayer.push(arguments);}\n' +
'    gtag(\'js\', new Date());\n' +
'    gtag(\'config\', \'G-3MY17P4E7F\');\n' +
'  </script>\n' +
'  <meta charset="UTF-8">\n' +
'  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n' +
'  <title>' + storeName + ' ' + dateFormatted + ' GCG大会結果 | GCG STATS</title>\n' +
'  <meta name="description" content="' + dateFormatted + ' ' + storeName + 'で開催されたガンダムカードゲーム ニュータイプチャレンジの大会結果。' + winnerText + '">\n' +
'  <!-- OGP -->\n' +
'  <meta property="og:site_name" content="GCG STATS">\n' +
'  <meta property="og:locale" content="ja_JP">\n' +
'  <meta property="og:title" content="' + storeName + ' ' + dateFormatted + ' GCG大会結果 | GCG STATS">\n' +
'  <meta property="og:description" content="' + (winnerText ? winnerText + ' - ' : '') + 'ガンダムカードゲーム大会結果">\n' +
'  <meta property="og:type" content="article">\n' +
'  <meta property="og:url" content="' + SITE_URL + '/events/' + eventId + '.html">\n' +
'  <meta property="og:image" content="' + SITE_URL + '/images/ogp-default.png">\n' +
'  <meta name="twitter:card" content="summary_large_image">\n' +
'  <meta name="twitter:image" content="' + SITE_URL + '/images/ogp-default.png">\n' +
'  <link rel="canonical" href="' + SITE_URL + '/events/' + eventId + '.html">\n' +
'  <script type="application/ld+json">' + jsonLd + '</script>\n' +
'  <link rel="preconnect" href="https://fonts.googleapis.com">\n' +
'  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600;700&display=swap" rel="stylesheet">\n' +
'  <link rel="stylesheet" href="../css/style.css">\n' +
'  <style>.section-title a:hover { text-decoration: underline; }</style>\n' +
'</head>\n' +
'<body>\n' +
'  <div id="header"></div>\n' +
'\n' +
'  <main class="container">\n' +
breadcrumbNav +
'    <div id="event-content">\n' +
'      <div class="loading">データを読み込み中</div>\n' +
'    </div>\n' +
'  </main>\n' +
'\n' +
'  <noscript>' + noscriptContent + '</noscript>\n' +
'  <div class="seo-content" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap">' + seoContent + '</div>\n' +
'\n' +
'  <div id="footer"></div>\n' +
'\n' +
'  <script src="../shared/ntc-rank-consolidator.js?v=3"></script>\n' +
'  <script src="../js/common.js?v=11"></script>\n' +
'  <script>\n' +
clientJs +
'  </script>\n' +
'</body>\n' +
'</html>';
}

// ===================================================================
// 指示書60 Task3: data/top_stats.json 出力
//
// 目的: トップページ(index.html)の初期表示から events.json(14.0MB) を外す。
//       初期表示に必要な集計結果だけを事前計算して静的JSONに落とす。
//
// 重要な前提:
//  - 出力は決定性が必須（同一 events.json に対して2回生成するとバイト一致すること）。
//    そのため実行時刻（new Date() / Date.now()）は一切含めない・使わない。
//  - 集計ロジックは index.html の refreshDashboard() と1対1で対応させている。
//    どちらかを直したら必ず両方直し、パリティ照合をやり直すこと。
//  - card_colors.json / series.json を手で更新した場合は、本スクリプトを手動で
//    再実行して top_stats.json を追随させること（CLAUDE.md 参照）。
// ===================================================================

// index.html のインライン定義 SET_COLORS と同一内容（index.html 側を変えたらここも変える）
const SET_COLORS = { ST01: 'Blue', ST02: 'Red', ST03: 'Green', ST04: 'White', ST05: 'Green', ST06: 'Red', ST07: 'Purple', ST08: 'Blue', ST09: 'White' };
// js/common.js の GCG.DECK_COLORS の jp 部分と同一
const DECK_COLORS_JP = { Blue: '青', Red: '赤', Green: '緑', White: '白', Purple: '紫', Unknown: '不明' };
// index.html refreshDashboard() の色ソート順と同一
const COLOR_SORT_ORDER = ['Blue', 'Red', 'Green', 'White', 'Purple'];

// js/common.js の GCG.pickDefaultSeries と同一ロジック
function pickDefaultSeries(seriesInput) {
  let list;
  if (Array.isArray(seriesInput)) list = seriesInput.slice();
  else if (seriesInput && typeof seriesInput === 'object') list = Object.values(seriesInput);
  else return null;
  list = list.filter((s) => s && s.id);
  if (list.length === 0) return null;
  const actives = list.filter((s) => s.status === 'active')
    .sort((a, b) => (a.start_date || '').localeCompare(b.start_date || ''));
  if (actives.length > 0) return actives[0];
  const upcoming = list.filter((s) => s.status === 'upcoming')
    .sort((a, b) => (a.start_date || '').localeCompare(b.start_date || ''));
  if (upcoming.length > 0) return upcoming[0];
  const completed = list.filter((s) => s.status === 'completed')
    .sort((a, b) => (b.start_date || '').localeCompare(a.start_date || ''));
  if (completed.length > 0) return completed[0];
  return list[0];
}

// js/common.js の GCG.pickDefaultSeriesWithData と同一ロジック
function pickDefaultSeriesWithData(seriesInput, eventsObj) {
  let list;
  if (Array.isArray(seriesInput)) list = seriesInput.slice();
  else if (seriesInput && typeof seriesInput === 'object') list = Object.values(seriesInput);
  else return null;
  list = list.filter((s) => s && s.id);
  if (list.length === 0) return null;

  const byStartAsc = (a, b) => (a.start_date || '').localeCompare(b.start_date || '');
  const byStartDesc = (a, b) => (b.start_date || '').localeCompare(a.start_date || '');
  const candidates = []
    .concat(list.filter((s) => s.status === 'active').sort(byStartAsc))
    .concat(list.filter((s) => s.status === 'upcoming').sort(byStartAsc))
    .concat(list.filter((s) => s.status === 'completed').sort(byStartDesc));

  const evMap = (eventsObj && eventsObj.events && typeof eventsObj.events === 'object')
    ? eventsObj.events
    : (eventsObj && typeof eventsObj === 'object' ? eventsObj : {});

  for (let i = 0; i < candidates.length; i++) {
    const s = candidates[i];
    const start = s.start_date || '';
    const end = s.end_date || '';
    let hasData = false;
    for (const key in evMap) {
      if (!Object.prototype.hasOwnProperty.call(evMap, key)) continue;
      const ev = evMap[key];
      if (!ev || !ev.date) continue;
      if (start && ev.date < start) continue;
      if (end && ev.date > end) continue;
      hasData = true;
      break;
    }
    if (hasData) return s;
  }
  return pickDefaultSeries(seriesInput);
}

// js/common.js の GCG.getDefaultDateRange（半月単位）と同一ルール。
// ただし基準日は「実行日(new Date())」ではなく events.json の最新イベント日付を使う。
// 実行時刻を混ぜると生成の決定性（2回生成でバイト一致）が壊れるため。
function halfMonthRangeFromDate(baseDateStr) {
  const parts = String(baseDateStr || '').split('-');
  if (parts.length !== 3) return { start: '', end: '' };
  const y = parseInt(parts[0], 10);
  const m = parseInt(parts[1], 10) - 1; // 0-indexed
  const d = parseInt(parts[2], 10);
  if (isNaN(y) || isNaN(m) || isNaN(d)) return { start: '', end: '' };

  let startDate, endDate;
  if (d <= 7) {
    const prevMonth = m === 0 ? 11 : m - 1;
    const prevYear = m === 0 ? y - 1 : y;
    startDate = new Date(prevYear, prevMonth, 16);
    endDate = new Date(prevYear, prevMonth + 1, 0);
  } else if (d <= 15) {
    startDate = new Date(y, m, 1);
    endDate = new Date(y, m, 15);
  } else if (d <= 22) {
    startDate = new Date(y, m, 1);
    endDate = new Date(y, m, 15);
  } else {
    startDate = new Date(y, m, 16);
    endDate = new Date(y, m + 1, 0);
  }
  const fmt = (dt) => dt.getFullYear() + '-'
    + String(dt.getMonth() + 1).padStart(2, '0') + '-'
    + String(dt.getDate()).padStart(2, '0');
  return { start: fmt(startDate), end: fmt(endDate) };
}

// js/common.js の GCG.filterEventsObjByDate と同一ロジック
function filterEventsObjByDate(eventsObj, startDate, endDate) {
  if (!startDate && !endDate) return eventsObj;
  const filtered = {};
  for (const [key, ev] of Object.entries(eventsObj)) {
    if (!ev.date) continue;
    if (startDate && ev.date < startDate) continue;
    if (endDate && ev.date > endDate) continue;
    filtered[key] = ev;
  }
  return filtered;
}

function buildTopStats(eventsData, cardColors, seriesMap) {
  const eventsObj = eventsData.events || {};

  // --- 既定レンジ（index.html renderDashboard() と同一の決め方） ---
  const defaultSeries = pickDefaultSeriesWithData(seriesMap, eventsObj);
  let range = defaultSeries
    ? { start: defaultSeries.start_date || '', end: defaultSeries.end_date || '' }
    : { start: '', end: '' };
  let rangeFallbackUsed = false;
  // events.json の最新イベント日付（フォールバック基準・source メタ用）
  let latestEventDate = '';
  for (const key in eventsObj) {
    if (!Object.prototype.hasOwnProperty.call(eventsObj, key)) continue;
    const ev = eventsObj[key];
    if (ev && ev.date && ev.date > latestEventDate) latestEventDate = ev.date;
  }
  if (!range.start && !range.end) {
    range = halfMonthRangeFromDate(latestEventDate);
    rangeFallbackUsed = true;
  }

  // --- 集計（index.html refreshDashboard() と1対1対応） ---
  // card_colors.json → cards_master.json の color → セット推定 の順に引く(2026-08-03)。
  // card_colors.json は新弾が反映されない静的ファイルなので、cards_master を必ず挟む。
  const masterColor = (id) => (cardsMaster[id] && cardsMaster[id].color) || null;
  const getColor = (id) => cardColors[id] || masterColor(id) || SET_COLORS[String(id).split('-')[0]] || 'Unknown';
  const isNtcTypeFn = makeIsNtcTypeFromSeriesMap(seriesMap);

  const filteredEventsObj = filterEventsObjByDate(eventsObj, range.start, range.end);
  const allEvents = Object.values(filteredEventsObj);

  let totalResults = 0;
  const allTypeKeys = {};
  const deckTypeMap = {};
  const cardUsageMap = {};

  for (let i = 0; i < allEvents.length; i++) {
    const evRaw_i = allEvents[i];
    const ev_i = consolidateNtcRank(evRaw_i, { isNtcType: isNtcTypeFn });
    const isNtc64 = isTargetEvent(evRaw_i, { isNtcType: isNtcTypeFn });
    const rankThreshold = isNtc64 ? 8 : 4;
    const results = ev_i.results || [];
    for (let j = 0; j < results.length; j++) {
      const r = results[j];
      if (r.rank > rankThreshold) continue;
      const deck = r.deck;
      if (!deck || deck.length === 0) continue;
      totalResults++;
      const cc = {};
      for (let k = 0; k < deck.length; k++) {
        const col = getColor(deck[k].card_id);
        if (col !== 'Unknown' && col !== 'Colorless') cc[col] = (cc[col] || 0) + deck[k].count;
        if (!cardUsageMap[deck[k].card_id]) cardUsageMap[deck[k].card_id] = { card_id: deck[k].card_id, decks: 0 };
        cardUsageMap[deck[k].card_id].decks++;
      }
      const sorted = Object.entries(cc).sort((a, b) => b[1] - a[1]);
      const colors = sorted.length >= 2
        ? [sorted[0][0], sorted[1][0]].sort((a, b) => COLOR_SORT_ORDER.indexOf(a) - COLOR_SORT_ORDER.indexOf(b))
        : sorted.length === 1 ? [sorted[0][0]] : ['Unknown'];
      const typeKey = colors.join('+');
      allTypeKeys[typeKey] = 1;

      if (!deckTypeMap[typeKey]) {
        deckTypeMap[typeKey] = {
          type_key: typeKey,
          colors: colors,
          label: colors.map((c) => DECK_COLORS_JP[c] || DECK_COLORS_JP.Unknown).join('/'),
          count: 0, wins: 0, totalRank: 0
        };
      }
      deckTypeMap[typeKey].count++;
      if (r.rank === 1) deckTypeMap[typeKey].wins++;
      deckTypeMap[typeKey].totalRank += r.rank;
    }
  }

  // デッキタイプランキング（全件。トップは上位3件ではなく全件表示のため）
  const deckTypeRanking = Object.values(deckTypeMap).map((t) => {
    const share = totalResults > 0 ? Math.round(t.count / totalResults * 1000) / 10 : 0;
    const winRate = t.count > 0 ? Math.round(t.wins / t.count * 1000) / 10 : 0;
    const avgRank = t.count > 0 ? Math.round(t.totalRank / t.count * 10) / 10 : 0;
    return {
      type_key: t.type_key, colors: t.colors, label: t.label,
      count: t.count, share: share, win_rate: winRate, avg_rank: avgRank, wins: t.wins
    };
  }).sort((a, b) => b.count - a.count);

  // カード使用率（表示はTOP10。分母は totals.decks と同値）
  const cardRanking = Object.values(cardUsageMap).map((c) => ({
    card_id: c.card_id,
    decks: c.decks,
    usage_rate: totalResults > 0 ? Math.round(c.decks / totalResults * 1000) / 10 : 0
  })).sort((a, b) => b.usage_rate - a.usage_rate || b.decks - a.decks);

  // 最新の大会結果（10件）
  const recentEvents = allEvents
    .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
    .slice(0, 10)
    .map((evRaw) => {
      const ev = consolidateNtcRank(evRaw, { isNtcType: isNtcTypeFn });
      return {
        event_id: ev.event_id,
        date: ev.date,
        store: ev.store,
        top4_colors: (ev.top4_colors || []).map((t) => ({ rank: t.rank, colors: t.colors }))
      };
    });

  return {
    stats: {
      default_range: {
        start: range.start,
        end: range.end,
        series_slug: (defaultSeries && defaultSeries.slug) ? defaultSeries.slug : ''
      },
      totals: {
        events: allEvents.length,
        decks: totalResults,
        types: Object.keys(allTypeKeys).length
      },
      deck_type_ranking: deckTypeRanking,
      card_ranking: cardRanking.slice(0, 10),
      card_ranking_denominator: totalResults,
      recent_events: recentEvents,
      source: {
        latest_event_date: latestEventDate,
        event_count: Object.keys(eventsObj).length
      }
    },
    rangeFallbackUsed: rangeFallbackUsed
  };
}

function generateTopStats(eventsData) {
  // card_colors.json と series.json は集計の必須入力。
  // 読めないまま空オブジェクトで続行すると「デッキタイプ分布が壊れた top_stats.json」を
  // 黙って生成し、そのまま deploy-results.js が本番へ配信してしまう。
  // 欠損時は生成をスキップして既存ファイルを温存し、終了コードで気づけるようにする。
  let cardColors, seriesMap;
  try {
    cardColors = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'card_colors.json'), 'utf-8'));
    seriesMap = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'series.json'), 'utf-8'));
  } catch (e) {
    console.error('  *** 警告 *** top_stats.json の生成をスキップしました: ' + e.message);
    console.error('      card_colors.json / series.json は集計の必須入力です。既存の data/top_stats.json はそのまま残します。');
    process.exitCode = 1;
    return null;
  }
  const built = buildTopStats(eventsData, cardColors, seriesMap);
  const out = built.stats;
  fs.writeFileSync(path.join(DATA_DIR, 'top_stats.json'), JSON.stringify(out, null, 2) + '\n', 'utf-8');
  console.log('  → data/top_stats.json 生成完了'
    + ' (range ' + (out.default_range.start || '(なし)') + '〜' + (out.default_range.end || '(なし)')
    + ' / slug ' + (out.default_range.series_slug || '(なし)')
    + ' / events ' + out.totals.events + ' / decks ' + out.totals.decks + ' / types ' + out.totals.types
    + ' / deck_types ' + out.deck_type_ranking.length + ' 件)');
  if (built.rangeFallbackUsed) {
    console.log('  ※ 既定レンジはシリーズ走査で決まらず、最新イベント日付からの半月フォールバックを使用しました');
  }
  return out;
}

function updateSitemap(eventIds) {
  const now = new Date().toISOString().split('T')[0];

  // 既存のカードページURLを保持
  let cardIds = [];
  try {
    const existing = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf-8');
    const matches = existing.match(/\/cards\/([^/]+)\//g);
    if (matches) {
      cardIds = [...new Set(matches.map(m => m.replace('/cards/', '').replace('/', '')))];
    }
  } catch (e) {}

  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n' +
'<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
'  <url>\n' +
'    <loc>' + SITE_URL + '/</loc>\n' +
'    <changefreq>daily</changefreq>\n' +
'    <priority>1.0</priority>\n' +
'    <lastmod>' + now + '</lastmod>\n' +
'  </url>\n' +
'  <url>\n' +
'    <loc>' + SITE_URL + '/events.html</loc>\n' +
'    <changefreq>daily</changefreq>\n' +
'    <priority>0.9</priority>\n' +
'    <lastmod>' + now + '</lastmod>\n' +
'  </url>\n' +
'  <url>\n' +
'    <loc>' + SITE_URL + '/meta.html</loc>\n' +
'    <changefreq>daily</changefreq>\n' +
'    <priority>0.9</priority>\n' +
'    <lastmod>' + now + '</lastmod>\n' +
'  </url>\n' +
'  <url>\n' +
'    <loc>' + SITE_URL + '/cards.html</loc>\n' +
'    <changefreq>weekly</changefreq>\n' +
'    <priority>0.8</priority>\n' +
'    <lastmod>' + now + '</lastmod>\n' +
'  </url>\n' +
'  <url>\n' +
'    <loc>' + SITE_URL + '/deck-builder.html</loc>\n' +
'    <changefreq>weekly</changefreq>\n' +
'    <priority>0.8</priority>\n' +
'    <lastmod>' + now + '</lastmod>\n' +
'  </url>\n' +
'  <url>\n' +
'    <loc>' + SITE_URL + '/restrictions.html</loc>\n' +
'    <changefreq>weekly</changefreq>\n' +
'    <priority>0.8</priority>\n' +
'    <lastmod>' + now + '</lastmod>\n' +
'  </url>\n' +
'  <url>\n' +
'    <loc>' + SITE_URL + '/privacy.html</loc>\n' +
'    <changefreq>monthly</changefreq>\n' +
'    <priority>0.3</priority>\n' +
'  </url>\n' +
'  <url>\n' +
'    <loc>' + SITE_URL + '/contact.html</loc>\n' +
'    <changefreq>monthly</changefreq>\n' +
'    <priority>0.3</priority>\n' +
'  </url>\n';

  // イベントページ
  for (const eid of eventIds) {
    xml += '  <url>\n' +
'    <loc>' + SITE_URL + '/events/' + eid + '.html</loc>\n' +
'    <changefreq>monthly</changefreq>\n' +
'    <priority>0.6</priority>\n' +
'    <lastmod>' + now + '</lastmod>\n' +
'  </url>\n';
  }

  // カードページ
  for (const cid of cardIds) {
    xml += '  <url>\n' +
'    <loc>' + SITE_URL + '/cards/' + cid + '/</loc>\n' +
'    <changefreq>weekly</changefreq>\n' +
'    <priority>0.7</priority>\n' +
'    <lastmod>' + now + '</lastmod>\n' +
'  </url>\n';
  }

  xml += '</urlset>\n';
  fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), xml, 'utf-8');
}

function main() {
  console.log('=== イベント個別ページ生成 ===');

  const eventsData = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'events.json'), 'utf-8'));
  const events = eventsData.events;
  const series = eventsData.series || {};
  const eventIds = Object.keys(events);

  console.log('  イベント数: ' + eventIds.length + ' 件');

  if (!fs.existsSync(EVENTS_DIR)) {
    fs.mkdirSync(EVENTS_DIR, { recursive: true });
  }

  let generated = 0;
  for (const eid of eventIds) {
    const ev = events[eid];
    const seriesName = series[ev.series_id] || '';
    const html = generateEventPage(eid, ev, seriesName);
    fs.writeFileSync(path.join(EVENTS_DIR, eid + '.html'), html, 'utf-8');
    generated++;
  }

  console.log('  → ' + generated + ' ページ生成完了');

  updateSitemap(eventIds);
  console.log('  → sitemap.xml 更新完了');

  // トップページ初期表示用の事前集計（指示書60 Task3）
  generateTopStats(eventsData);

  // --push オプション付きで実行した場合、GitHub API経由でpush
  if (process.argv.includes('--push')) {
    const filesToPush = [];
    for (const eid of eventIds) {
      filesToPush.push({
        path: 'events/' + eid + '.html',
        content: fs.readFileSync(path.join(EVENTS_DIR, eid + '.html'), 'utf-8')
      });
    }
    filesToPush.push({
      path: 'sitemap.xml',
      content: fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf-8')
    });
    // 同一実行で再生成した top_stats.json も一緒に push する
    // （events ページだけ更新して top_stats.json が本番に残ると表示が食い違うため）
    const topStatsPath = path.join(DATA_DIR, 'top_stats.json');
    if (fs.existsSync(topStatsPath)) {
      filesToPush.push({ path: 'data/top_stats.json', content: fs.readFileSync(topStatsPath, 'utf-8') });
    }
    return pushFiles(filesToPush, `Update event pages (${generated} pages)`);
  }
}

main();
