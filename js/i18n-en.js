/**
 * GCG STATS - 英語ページ(/en/)の文字列と表示の小道具(指示書148)
 *
 * ・英語ページで使う画面の文字列はこのファイル 1 本に置く(日本語の文字列を英語へ直に書き換えて散らさない)。
 *   次の段(/en/events/・/en/cards/<id>/)でも同じ辞書を使う。
 * ・Node とブラウザの両方で読める:
 *     生成器: const EN = require('./js/i18n-en.js');
 *     ページ: <script src="../js/i18n-en.js"></script>(js/common.js より前に読む) → window.GCG_I18N_EN
 * ・語の決まり(指示書148 §1-4): デッキカラー = Deck Color(「色ペア」「デッキタイプ」に当たる英語は使わない)。
 *   色の並びは既存の固定順(青・赤・緑・白・紫)のまま英語にし、区切りは「/」(前後に空白なし)。単色は "Blue"。
 * ・日付は ISO(2026-10-13)。月単位は 2026-10。
 * ・公式の英語表記の出どころ:
 *     Banned and Restricted Cards … https://www.gundam-gcg.com/en/news/01_277.html (2026-10-16 確認)
 *     Newtype Challenge           … https://www.gundam-gcg.com/en/events/regionalchampionships.html (2026-10-16 確認)
 *   Serial Card Challenge / Shop Battle は公式の英語表記を確認できていない(仮訳)。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.GCG_I18N_EN = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  'use strict';

  // ---- デッキカラー(色) ----
  var COLOR_ORDER = ['Blue', 'Red', 'Green', 'White', 'Purple'];
  var COLORS = {
    Blue: 'Blue', Red: 'Red', Green: 'Green', White: 'White', Purple: 'Purple',
    Colorless: 'Colorless', Unknown: 'Unknown'
  };

  // ---- 地域(データの値は日本語のまま。表示だけ英語) ----
  var REGIONS = {
    '北海道': 'Hokkaido', '東北': 'Tohoku', '関東': 'Kanto', '中部': 'Chubu',
    '関西': 'Kansai', '中国': 'Chugoku', '四国': 'Shikoku', '九州': 'Kyushu',
    'その他': 'Other'
  };

  // ---- シリーズ(大会の種類) ----
  // ntc は公式英語サイトに "Newtype Challenge" の表記あり。serial / shopbattle は仮訳(公式の英語表記は未確認)。
  var SERIES_TYPES = {
    ntc: 'Newtype Challenge',
    serial: 'Serial Card Challenge',
    shopbattle: 'Shop Battle'
  };

  // ---- 共通ヘッダー・フッター・パンくず(js/common.js が lang:'en' のときに読む) ----
  var NAV = {
    main: {
      home: 'Home',
      event: 'Events',
      analysis: 'Metagame',
      cards: 'Card List',
      'deck-builder': 'Deck Builder',
      mypage: 'My Page'
    },
    sub: {
      schedule: 'Schedule',
      stores: 'Stores',
      meta: 'Meta Overview',
      events: 'Tournament Results',
      series: 'Series',
      'ntc-official': 'Official Stats',
      reports: 'Reports',
      cards: 'Card Search',
      sets: 'New Sets',
      restrictions: 'Banned and Restricted'
    },
    // フッターのサイトマップ(js/common.js の _FOOTER_SITEMAP と同じ並び・同じ href をキーにする)
    footerSitemap: {
      '': 'Home',
      'schedule.html': 'Schedule',
      'stores.html': 'Stores',
      'meta.html': 'Meta Overview',
      'meta.html#events': 'Tournament Results',
      'series/': 'Series',
      'ntc-official.html': 'Official Stats',
      'reports/': 'Reports',
      'cards.html': 'Card Search',
      'sets/': 'New Sets',
      'restrictions.html': 'Banned and Restricted',
      'deck-builder.html': 'Deck Builder',
      'mypage.html': 'My Page'
    },
    subToggleAria: 'Open the {label} menu',
    breadcrumbAria: 'Breadcrumb',
    sitemapAria: 'Site map'
    // 言語の入口の文言(JA / EN の title・aria-label)は js/common.js の _LANG_ENTRY が持つ(日本語ページは このファイルを読まないため)
  };

  var FOOTER = {
    // 権利表記(©SOTSU・SUNRISE・BANDAI)は日本語ページと同じ文字のまま lang="ja" で出す(js/common.js 側)
    lines: [
      'This is an unofficial Gundam Card Game fan site run by an individual.',
      'It is not authorized or endorsed by BANDAI or SUNRISE.',
      'The information on this site is compiled automatically from official tournament results.',
      'Card images and card text are quoted from the {officialSite}.',
      'All names, designs and trademarks related to Gundam and the Gundam Card Game belong to {copyright}.',
      '',
      'This site is not intended to replace the official game.',
      'Please use and support the official Gundam Card Game website ({officialDomain}).',
      'This site participates in affiliate programs (Suruga-ya Affiliate Program and A8.net); sections that contain ads are labeled as ads.',
      ''
    ],
    officialSite: 'official website',
    takedown: 'For removal or correction requests from rights holders, please use the {contact} form; we will respond promptly.',
    contact: 'Contact',
    links: {
      privacy: 'Privacy Policy',
      contact: 'Contact',
      about: 'About This Site',
      dataUsage: 'Data Usage'
    }
  };

  // ---- 環境分析ページ(en/meta.html) ----
  var META = {
    pageTitle: 'Gundam Card Game Metagame and Tournament Results (Deck Colors, Card Adoption Rates) | GCG STATS',
    // {events} {decks} は generate.js が数字を入れる(日本語の meta.html と同じ数字)
    metaDesc: 'Metagame analysis and tournament results for the Gundam Card Game. Deck color shares, card adoption rates and regional metagame, compiled daily from {events} tournaments and {decks} top-4 decks across Japan.',
    breadcrumbHome: 'Home',
    breadcrumbSelf: 'Metagame',
    shareTitle: 'Metagame and Tournament Results | GCG STATS',
    shareHashtags: '#GCG #GundamCardGame',
    shareOnX: 'Share on X',
    copyUrl: 'Copy URL',
    copied: 'Copied',
    allSeries: 'All Series',
    regionLabel: 'Region:',
    allRegions: 'All Regions',
    filterWin: 'Wins Only',
    filterTop4: 'Top 4',
    filterAll: 'All',
    decksLabelWin: 'Winning Decks',
    decksLabelTop4: 'Top-4 Decks',
    decksLabelAll: 'All Decks',
    metaInfo: '{events} events / {decks} decks ({filter}{region})',
    chipHint: 'Click a row in the deck color table or an entry in the share legend to show only the tournaments where that deck color placed.',
    chipActive: 'Tournaments with a top-finishing {label} deck',
    chipClearAria: 'Clear the deck color filter',
    chipNote: 'Note: the figures above are not affected by this filter (they stay unfiltered so you can see the overall distribution).',
    rowTitle: 'Click to show only the tournaments for this deck color',
    noData: 'No matching data',
    pieTooltip: ' {label}: {count} decks ({pct}%)',
    noTypes: 'No matching deck colors',
    selectType: 'Select a deck color from the tabs above',
    aggregating: 'Calculating card adoption rates for these filters…',
    aggregatingSub: '(Loading the tournament data takes a few seconds the first time)',
    cardRateError: 'Could not load card adoption rates',
    noCards: 'No card data',
    cardTitleWin: 'winning decks',
    cardTitleTop4: 'top-4 decks',
    cardTitleAll: 'decks',
    cardTableTitle: '{label} card adoption rates (out of {count} {filter})',
    colCard: 'Card',
    colAdoptDecks: 'Decks Using',
    colAdoptRate: 'Adoption Rate',
    colWins: 'Wins',
    colWinRate: 'Win Rate',
    colMax: 'Max Copies',
    colMin: 'Min Copies',
    colMedian: 'Median Copies',
    noRegion: 'No regional data',
    regionCard: '{events} events / {decks} decks',
    regionDecks: '{count} decks',
    eventCount: '{count} events',
    leadFiltered: 'Showing only tournaments where a {label} deck placed in the top finishes.',
    leadDefault: 'The series, period, region and deck color filters above apply to this list.',
    noEvents: 'No matching events',
    noResultData: 'No data',
    // 日付フィルター
    periodLabel: 'Period:',
    periodSep: 'to',
    periodReset: 'All Time',
    periodResetTitle: 'Clear the date filter',
    // SEO ブロック(noscript。generate.js が使う)
    seoHeading: 'Metagame Data',
    seoShares: 'Deck Color Shares',
    seoShareItem: '{label}: {count} decks (share {share}%, {wins} wins, win rate {win_rate}%, average placing {avg_rank})',
    seoCards: 'Card Adoption Rate Ranking (Top 30)',
    seoCardItem: 'adoption rate {usage_rate}% ({decks} decks, {wins} wins, {avg_count} copies on average)',
    seoRegions: 'Regional Metagame (north to south)',
    seoRegionItem: '{region}: {events} events, {decks} decks (top: {top})',
    seoEvents: 'Tournament Results ({shown} most recent of {total})',
    seoEventWinner: ' Winner: ',
    seoEventsNote: 'Pages for all {total} tournaments are listed in sitemap.xml.'
  };

  // ---- カードリスト(en/cards.html。指示書148-R1。generate_cardlist.js が使う) ----
  var CARDS = {
    // {total} はカードの枚数(generate_cardlist.js が入れる)
    pageTitle: 'Gundam Card Game Card List (All {total} Cards, with Tournament Adoption Rates) | GCG STATS',
    metaDesc: 'The complete Gundam Card Game (GCG) card list. Filter all {total} cards by color, type, rarity, trait and set, and search by card name, effect text or English card name. Tournament adoption rates included.',
    ogDesc: 'The complete Gundam Card Game card list with all {total} cards. Filter by color, type and trait, and check tournament adoption rates.',
    h1: 'Card List',
    restrictionsLink: 'See the banned and restricted card list',
    statTotal: 'Total Cards',
    statRecent: 'Used in Recent Season',
    statNotRecent: 'Not Used in Recent Season',
    statEvents: 'Events Analyzed',
    groupColor: 'Color',
    groupSet: 'Set',
    groupType: 'Type',
    groupRarity: 'Rarity',
    groupVersion: 'Version',
    groupTournament: 'Tournament',
    groupRestriction: 'Restriction',
    all: 'All',
    versionNormal: 'Standard Only',
    versionParallel: 'Parallel Only',
    recentYes: 'Used in Recent Season',
    recentNo: 'Not Used in Recent Season',
    // {season} は直近シーズンの名前(seriesLabel など)
    recentYesTitle: 'Used in a top-finishing deck in {season} (parallel versions included)',
    recentNoTitle: 'Not used in any top-finishing deck in {season}',
    regBanned: 'Banned',
    regRestricted: 'Restricted',
    regPair: 'Banned Pair',
    advToggle: 'Advanced Search',
    advActive: '{count} active',
    lvMin: 'Lv. minimum', lvMax: 'Lv. maximum',
    cost: 'Cost', costMin: 'Cost minimum', costMax: 'Cost maximum',
    apMin: 'AP minimum', apMax: 'AP maximum',
    hpMin: 'HP minimum', hpMax: 'HP maximum',
    rangeSep: ' – ',
    advSource: 'Source Work (release order, multiple choice)',
    advTraits: 'Traits (multiple choice)',
    advTraitPlaceholder: 'Filter traits by name',
    advKeywords: 'Keyword Effects (multiple choice)',
    advNoParallel: 'Hide parallel cards',
    advClear: 'Clear advanced filters',
    searchPlaceholder: 'Search by card name, ID or effect text...',
    sortId: 'Card ID',
    sortUsage: 'Adoption Rate (high to low)',
    sortRarity: 'Rarity',
    sortName: 'Name (A–Z)',
    // 件数の表示(「<span>N</span> / 2154 件表示」の「件表示」の所)
    resultsSuffix: 'shown',
    setCount: '{count} cards',
    noResults: 'No matching cards found',
    noResultsHint: 'Try changing the filters or search terms',
    backToTop: 'Back to top',
    notApplicable: 'N/A',
    notUsed: 'Not used',
    adoptionRate: 'Adoption',
    // 弾チップ: 日本語ページと同じくコードだけ。日本語で別名を出していた 3 つだけ英語の別名
    setDisplayNames: { PROMO: 'Promo', RESOURCE: 'Resource', EXBASE: 'EX Base' },
    // 弾ごとの見出しの説明(日本語は「第1弾ブースターパック」等。英語の商品名は範囲外なので、この 3 つだけ)
    setLabels: { TOKEN: 'Token Cards', RESOURCE: 'Resource', EXBASE: 'EX Base' },
    types: {
      UNIT: 'Unit', PILOT: 'Pilot', COMMAND: 'Command', BASE: 'Base', TOKEN: 'Token',
      RESOURCE: 'Resource', 'EX RESOURCE': 'EX Resource', 'EX BASE': 'EX Base'
    },
    // noscript(JS が動かないとき)の一覧
    noscriptHeading: 'Gundam Card Game Card List',
    noscriptLead: 'This page lists all {total} cards.'
  };

  // ---- 小道具 ----
  // 数が 1 のときの単数形(二次確認 L-1)。「1 decks」→「1 deck」。前後が数字・小数点の 1(11・0.1・1.5)は触らない
  var SINGULAR = { decks: 'deck', events: 'event', wins: 'win', tournaments: 'tournament', copies: 'copy', cards: 'card' };
  function singularize(s) {
    return String(s).replace(/(^|[^0-9.,])1 (decks|events|wins|tournaments|copies|cards)\b/g, function (m, pre, w) { return pre + '1 ' + SINGULAR[w]; });
  }
  function fill(tpl, vars) {
    return singularize(String(tpl).replace(/\{(\w+)\}/g, function (m, k) {
      return (vars && Object.prototype.hasOwnProperty.call(vars, k)) ? String(vars[k]) : m;
    }));
  }
  function colorName(c) {
    return Object.prototype.hasOwnProperty.call(COLORS, c) ? COLORS[c] : COLORS.Unknown;
  }
  // 色の配列 → "Blue/White"(並びは渡された順。type_key は既に固定順)
  function deckColorLabel(colors) {
    return (colors || []).map(colorName).join('/');
  }
  function regionName(jp) {
    return Object.prototype.hasOwnProperty.call(REGIONS, jp) ? REGIONS[jp] : '';
  }
  function isAscii(s) { return /^[\x20-\x7e]+$/.test(String(s || '')); }
  // series.json の 1 件 → 英語の短い名前(タブ・バッジ用)
  function seriesLabel(s) {
    if (!s) return '';
    var shortName = String(s.short_name || '');
    if (s.type === 'ntc' && isAscii(shortName)) return shortName;                 // 例: NTC MISSION5
    var base = SERIES_TYPES[s.type] || '';
    var month = String(s.start_date || '').slice(0, 7);                             // 例: 2026-09
    if (base) return month ? base + ' ' + month : base;
    if (isAscii(shortName)) return shortName;
    return 'Series ' + String(s.id || '');
  }
  function formatDate(d) {
    // データは YYYY-MM-DD。そのまま ISO で出す
    return String(d || '');
  }
  function ordinal(n) {
    n = Number(n);
    var v = n % 100;
    if (v >= 11 && v <= 13) return n + 'th';
    switch (n % 10) { case 1: return n + 'st'; case 2: return n + 'nd'; case 3: return n + 'rd'; default: return n + 'th'; }
  }
  function rankLabel(rank) { return ordinal(rank); }
  function escapeHtml(str) {
    return String(str == null ? '' : str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // 色タグ・色ドット(js/common.js の renderColorTags / renderColorDots と同じ HTML で文字だけ英語)
  var COLOR_CSS = { Blue: 'c-blue', Red: 'c-red', Green: 'c-green', White: 'c-white', Purple: 'c-purple' };
  function colorTagsHtml(colors) {
    return (colors || []).map(function (c) {
      return '<span class="color-tag color-tag-' + String(c).toLowerCase() + '">' + colorName(c) + '</span>';
    }).join(' ');
  }
  function colorDotsHtml(colors) {
    return (colors || []).map(function (c) {
      return '<span class="color-dot ' + (COLOR_CSS[c] || '') + '" title="' + colorName(c) + '"></span>';
    }).join('');
  }
  // 日本語のまま出す文字(店舗名・英語名の無いカード名 等)を lang="ja" で包む
  function jaSpan(text) {
    return '<span lang="ja">' + escapeHtml(text) + '</span>';
  }
  // 英語のカード名(型番 → 名前)。パラレル(_pN)は基本の型番で引く。無ければ ''
  function cardNameEn(map, cardId) {
    if (!map) return '';
    var id = String(cardId || '');
    var v = map[id];
    if (typeof v === 'string' && v) return v;
    var b = id.replace(/_p\d+$/, '');
    v = map[b];
    return (typeof v === 'string' && v) ? v : '';
  }

  return {
    COLOR_ORDER: COLOR_ORDER,
    COLORS: COLORS,
    REGIONS: REGIONS,
    SERIES_TYPES: SERIES_TYPES,
    NAV: NAV,
    FOOTER: FOOTER,
    META: META,
    CARDS: CARDS,
    fill: fill,
    colorName: colorName,
    deckColorLabel: deckColorLabel,
    regionName: regionName,
    seriesLabel: seriesLabel,
    formatDate: formatDate,
    ordinal: ordinal,
    rankLabel: rankLabel,
    escapeHtml: escapeHtml,
    colorTagsHtml: colorTagsHtml,
    colorDotsHtml: colorDotsHtml,
    jaSpan: jaSpan,
    cardNameEn: cardNameEn
  };
});
