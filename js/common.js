/**
 * GCG STATS - 共通モジュール
 */

const GCG = {
  // データキャッシュ
  _eventsData: null,
  _summaryData: null,

  // データパス
  DATA_PATH: './data/',

  // デッキカラーマッピング
  DECK_COLORS: {
    Blue: { hex: '#4488ff', jp: '青', cssClass: 'c-blue' },
    Red: { hex: '#ff4444', jp: '赤', cssClass: 'c-red' },
    Green: { hex: '#44cc64', jp: '緑', cssClass: 'c-green' },
    White: { hex: '#cccccc', jp: '白', cssClass: 'c-white' },
    Purple: { hex: '#b444ff', jp: '紫', cssClass: 'c-purple' },
    Unknown: { hex: '#888888', jp: '不明', cssClass: '' }
  },

  // カード画像URL（ローカル保存済み画像を優先、なければ公式サーバー）
  cardImageUrl(cardId) {
    return `${this.getBasePath()}images/cards/${cardId}.webp`;
  },

  // 公式カード詳細URL
  cardSearchUrl(cardId) {
    return `https://www.gundam-gcg.com/jp/cards/detail.php?detailSearch=${cardId}`;
  },

  // データ読み込み
  async loadEvents() {
    if (this._eventsData) return this._eventsData;
    try {
      const res = await fetch(this.DATA_PATH + 'events.json');
      this._eventsData = await res.json();
      return this._eventsData;
    } catch (e) {
      console.error('events.json の読み込みに失敗:', e);
      return { series: {}, events: {} };
    }
  },

  async loadSummary() {
    if (this._summaryData) return this._summaryData;
    try {
      const res = await fetch(this.DATA_PATH + 'summary.json');
      this._summaryData = await res.json();
      return this._summaryData;
    } catch (e) {
      console.error('summary.json の読み込みに失敗:', e);
      return { total_events: 0, total_decks: 0, card_ranking: [], deck_type_ranking: [] };
    }
  },

  // === series データ(series.json)を読み込み、NTC順位集計の type 判定に使用 ===
  // 指示書 NTC順位集計統合(2026-05-19 type ベース対応)
  _seriesData: null,
  async loadSeries() {
    if (this._seriesData) return this._seriesData;
    try {
      const res = await fetch(this.DATA_PATH + 'series.json');
      this._seriesData = await res.json();
      return this._seriesData;
    } catch (e) {
      console.error('series.json の読み込みに失敗:', e);
      this._seriesData = {};
      return this._seriesData;
    }
  },

  // ページのベースパスを自動検出
  getBasePath() {
    const path = window.location.pathname;
    // 2 階層深いページ（サイトルートまで戻るには ../../）
    if (path.includes('/reports/news/')) {
      return '../../';
    }
    // /cards/{id}/ はディレクトリ構造として 2 階層深い（/cards/{id}/index.html）
    if (/\/cards\/[^/]+\//.test(path)) {
      return '../../';
    }
    // 1 階層深いページ
    if (path.includes('/reports/') || path.includes('/events/') || path.includes('/meta/') || path.includes('/cards/') || path.includes('/series/') || path.includes('/sets/')) {
      return '../';
    }
    return './';
  },

  // 初期化時にパスを設定
  init() {
    this.DATA_PATH = this.getBasePath() + 'data/';
  },

  // 順位テキスト
  rankText(rank) {
    if (rank === 1) return '優勝';
    if (rank === 2) return '準優勝';
    return `${rank}位`;
  },

  // === NTC順位集計統合(指示書 NTC順位集計統合_最終版.md, 2026-05-18 実装) ===
  // 64名定員NTC大会(results.length>=16)を「ベスト8(各順位2名)」表記に変換する。
  // 32名定員大会・他大会は no-op で素通し(R2/R5 厳守)。
  // 詳細仕様: /shared/ntc-rank-consolidator.js
  //
  // 前提: HTML 側で <script src="shared/ntc-rank-consolidator.js"> を common.js より先にロードする。
  // 未ロード時は元 event をそのまま返す(フェイルセーフ)。
  consolidateNtcRank(event) {
    if (typeof window !== 'undefined' && window.NtcRankConsolidator
        && typeof window.NtcRankConsolidator.consolidateNtcRank === 'function') {
      // クライアント側は表示のみのため軽量モード(getDeckColors 注入なし)で十分。
      // GCG.loadSeries() で series.json が事前にキャッシュされていれば type ベース判定を有効化。
      // 未ロード時は consolidator 内のハードコードフォールバック (NTC_SERIES_IDS) で判定。
      const opts = {};
      if (this._seriesData && typeof window.NtcRankConsolidator.makeIsNtcTypeFromSeriesMap === 'function') {
        opts.isNtcType = window.NtcRankConsolidator.makeIsNtcTypeFromSeriesMap(this._seriesData);
      }
      return window.NtcRankConsolidator.consolidateNtcRank(event, opts);
    }
    return event;
  },

  // 順位CSSクラス
  rankClass(rank) {
    if (rank <= 3) return `rank-${rank}`;
    return '';
  },

  // 日付フォーマット
  formatDate(dateStr) {
    if (!dateStr) return '';
    return dateStr.replace(/-/g, '.');
  },

  // 色配列からカラータグHTMLを生成
  renderColorTags(colors) {
    return colors.map(c => {
      const info = this.DECK_COLORS[c] || this.DECK_COLORS.Unknown;
      return `<span class="color-tag color-tag-${c.toLowerCase()}">${info.jp}</span>`;
    }).join(' ');
  },

  // 色配列からドットHTMLを生成
  renderColorDots(colors) {
    return colors.map(c => {
      const info = this.DECK_COLORS[c] || this.DECK_COLORS.Unknown;
      return `<span class="color-dot ${info.cssClass}" title="${info.jp}"></span>`;
    }).join('');
  },

  // 色配列からprimary colorのhexを返す
  primaryColorHex(colors) {
    if (!colors || colors.length === 0) return '#888';
    return (this.DECK_COLORS[colors[0]] || this.DECK_COLORS.Unknown).hex;
  },

  // デッキタイプラベル
  deckTypeLabel(colors) {
    return colors.map(c => (this.DECK_COLORS[c] || this.DECK_COLORS.Unknown).jp).join('/');
  },

  // デッキリストをテキストに変換（コピー用）
  deckToText(deck) {
    return deck.map(c => `${c.card_id} x${c.count}`).join('\n');
  },

  // クリップボードにコピー
  async copyToClipboard(text, btn) {
    try {
      await navigator.clipboard.writeText(text);
      if (btn) {
        const orig = btn.innerHTML;
        btn.innerHTML = '✓ コピー済み';
        btn.classList.add('copied');
        setTimeout(() => {
          btn.innerHTML = orig;
          btn.classList.remove('copied');
        }, 2000);
      }
    } catch (e) {
      console.error('コピーに失敗:', e);
    }
  },

  // URLパラメータ取得
  getParam(name) {
    return new URLSearchParams(window.location.search).get(name);
  },

  // イベント一覧を日付降順でソート
  sortedEvents(eventsObj) {
    return Object.values(eventsObj)
      .sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  },

  // HTMLエスケープ
  escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  },

  // 数値アニメーション
  animateNumber(el, target, duration = 600) {
    const start = parseInt(el.textContent) || 0;
    const diff = target - start;
    if (diff === 0) { el.textContent = target.toLocaleString(); return; }
    const startTime = performance.now();
    function step(now) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3); // easeOutCubic
      el.textContent = Math.round(start + diff * eased).toLocaleString();
      if (progress < 1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  },

  // === 共通ヘッダー(2段ナビ構成、2026-05-24 修正版) ===
  // 変更履歴:
  //   2026-05-24 案B採用(主タブ4つ + サブナビ)
  //   2026-05-24 主タブ再編 → カードリスト/レポートを独立タブに昇格、検索欄削除
  // activePage は既存呼び出し互換のため文字列キーを維持
  // ('home','series','events','meta','cards','stores','regions','schedule','reports','')
  _PAGE_MAP: {
    home:     { main: 'home',        sub: null       },
    events:   { main: 'tournaments', sub: 'events'   },
    series:   { main: 'tournaments', sub: 'series'   },
    schedule: { main: 'tournaments', sub: 'schedule' },
    meta:     { main: 'analysis',    sub: null       },
    cards:    { main: 'cards',       sub: null       },
    sets:     { main: 'sets',        sub: null       },
    reports:  { main: 'reports',     sub: null       },
    stores:   { main: 'venues',      sub: 'stores'   },
    regions:  { main: 'venues',      sub: 'regions'  }
    // '' (contact/privacy/about 等) は主タブもサブもアクティブ無し
  },

  _MAIN_TABS: [
    { key: 'home',        href: '',             label: 'ホーム'     },
    { key: 'tournaments', href: 'events.html',  label: '大会データ'  },
    { key: 'analysis',    href: 'meta.html',    label: '環境分析'   },
    { key: 'cards',       href: 'cards.html',   label: 'カードリスト' },
    { key: 'sets',        href: 'sets/',        label: '新弾プレビュー' },
    { key: 'reports',     href: 'reports/',     label: 'レポート'   },
    { key: 'venues',      href: 'stores.html',  label: '店舗・地域'  }
  ],

  _SUB_NAV: {
    tournaments: [
      { key: 'events',   href: 'events.html',   label: 'イベント'    },
      { key: 'series',   href: 'series/',       label: 'シリーズ'    },
      { key: 'schedule', href: 'schedule.html', label: 'スケジュール' }
    ],
    venues: [
      { key: 'stores',  href: 'stores.html',  label: '店舗一覧' },
      { key: 'regions', href: 'regions.html', label: '地域別'  }
    ]
    // analysis / cards / reports / home はサブナビ無し
  },

  _MAIN_LABEL: {
    home:        'ホーム',
    tournaments: '大会データ',
    analysis:    '環境分析',
    cards:       'カードリスト',
    reports:     'レポート',
    venues:      '店舗・地域'
  },

  // 共通ヘッダーHTML生成
  renderHeader(activePage) {
    const basePath = this.getBasePath();
    const map = this._PAGE_MAP[activePage] || { main: null, sub: null };
    const activeMain = map.main;
    const activeSub  = map.sub;

    // 主タブ
    const mainTabsHtml = this._MAIN_TABS.map(t => {
      const cls = (t.key === activeMain) ? 'active' : '';
      return `<a href="${basePath}${t.href}" class="${cls}">${t.label}</a>`;
    }).join('');

    // サブナビ（_SUB_NAV に定義のあるカテゴリのみ表示。home/cards/reports/analysis等は非表示）
    let subNavHtml = '';
    if (activeMain && this._SUB_NAV[activeMain]) {
      const items = this._SUB_NAV[activeMain].map(s => {
        const cls = (s.key === activeSub) ? 'active' : '';
        return `<a href="${basePath}${s.href}" class="${cls}">${s.label}</a>`;
      }).join('');
      const label = this._MAIN_LABEL[activeMain] || '';
      subNavHtml = `
        <div class="sub-nav">
          <div class="sub-nav-inner">
            <span class="sub-nav-label">${label} ›</span>
            ${items}
          </div>
        </div>`;
    }

    // 検索欄は 2026-05-24 のヘッダー再修正で撤去
    return `
      <header class="site-header site-header-v2">
        <div class="header-inner">
          <a href="${basePath}" class="site-logo">
            <span class="logo-icon">G</span>
            <div>
              <span class="logo-text">GCG STATS</span>
              <span class="logo-sub">Tournament Analytics</span>
            </div>
          </a>
          <nav class="main-tabs">${mainTabsHtml}</nav>
        </div>
        ${subNavHtml}
      </header>`;
  },

  // 共通フッターHTML生成
  renderFooter() {
    const basePath = this.getBasePath();
    return `
      <footer class="site-footer">
        <div class="footer-disclaimer">
          本サイトはガンダムカードゲームの非公式ファンサイトです。<br>
          バンダイ・サンライズの認可・許諾は得ていません。<br>
          掲載情報は公式大会結果を基に自動集計しています。<br>
          カード画像・テキスト等は<a href="https://www.gundam-gcg.com/" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none">公式サイト</a>より引用しています。<br>
          ガンダムおよびガンダムカードゲームに関連するすべての名称・デザイン・商標は、©SOTSU・SUNRISE・BANDAIに帰属します。<br>
          <br>
          本サイトは公式ゲームの代替を意図したものではありません。<br>
          ガンダムカードゲーム公式サイト(<a href="https://www.gundam-gcg.com/" target="_blank" rel="noopener" style="color:var(--accent);text-decoration:none">gundam-gcg.com</a>)をご利用・ご支援ください。<br>
          <br>
          <span style="font-size:10px;color:var(--text-muted);">権利者からの削除・修正のご要請には<a href="${basePath}contact.html" style="color:var(--accent);text-decoration:none;">お問い合わせ</a>より速やかに対応いたします。</span>
        </div>
        <div class="footer-links" style="margin-top:16px;display:flex;justify-content:center;gap:20px;font-size:11px;font-family:var(--font-mono)">
          <a href="${basePath}privacy.html" style="color:var(--text-muted);text-decoration:none;transition:color 0.15s" onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--text-muted)'">プライバシーポリシー</a>
          <a href="${basePath}contact.html" style="color:var(--text-muted);text-decoration:none;transition:color 0.15s" onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--text-muted)'">お問い合わせ</a>
          <a href="${basePath}about.html" style="color:var(--text-muted);text-decoration:none;transition:color 0.15s" onmouseover="this.style.color='var(--accent)'" onmouseout="this.style.color='var(--text-muted)'">サイトについて</a>
        </div>
      </footer>`;
  },

  // シェアボタンを指定コンテナに描画
  renderShareButtons: function(containerId, title) {
    var el = document.getElementById(containerId);
    if (!el) return;
    var url = window.location.href.split('#')[0];
    var tweetText = encodeURIComponent(title + '\n' + url + '\n#GCG #ガンダムカードゲーム');
    var tweetUrl = 'https://twitter.com/intent/tweet?text=' + tweetText;
    el.innerHTML =
      '<div class="share-section">' +
        '<span class="share-label">SHARE</span>' +
        '<a class="share-btn share-x" href="' + tweetUrl + '" target="_blank" rel="noopener">' +
          '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.401 6.231H2.742l7.731-8.835L1.254 2.25H8.08l4.253 5.622zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>' +
          'X\u3067\u30b7\u30a7\u30a2' +
        '</a>' +
        '<button class="share-btn share-copy" onclick="GCG.copyShareUrl(this)">' +
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>' +
          '<span class="copy-label">URL\u3092\u30b3\u30d4\u30fc</span>' +
        '</button>' +
      '</div>';
  },

  // 日付フィルター: 半月単位のデフォルト範囲を計算
  // ルール: 半月期間の最初の1週間以内 → 前の半月を表示
  getDefaultDateRange() {
    const today = new Date();
    const y = today.getFullYear();
    const m = today.getMonth(); // 0-indexed
    const d = today.getDate();

    let startDate, endDate;

    if (d <= 7) {
      // 月前半の最初の1週間 → 前月16日〜前月末
      const prevMonth = m === 0 ? 11 : m - 1;
      const prevYear = m === 0 ? y - 1 : y;
      startDate = new Date(prevYear, prevMonth, 16);
      endDate = new Date(prevYear, prevMonth + 1, 0); // 前月末日
    } else if (d <= 15) {
      // 月前半の後半(8〜15日) → 当月1日〜15日
      startDate = new Date(y, m, 1);
      endDate = new Date(y, m, 15);
    } else if (d <= 22) {
      // 月後半の最初の1週間(16〜22日) → 当月1日〜15日
      startDate = new Date(y, m, 1);
      endDate = new Date(y, m, 15);
    } else {
      // 月後半の後半(23日〜) → 当月16日〜当月末
      startDate = new Date(y, m, 16);
      endDate = new Date(y, m + 1, 0); // 当月末日
    }

    const fmt = (dt) => {
      const yy = dt.getFullYear();
      const mm = String(dt.getMonth() + 1).padStart(2, '0');
      const dd = String(dt.getDate()).padStart(2, '0');
      return `${yy}-${mm}-${dd}`;
    };

    return { start: fmt(startDate), end: fmt(endDate) };
  },

  // 日付フィルターUIを生成して返す
  renderDateFilterHTML(startVal, endVal) {
    return `
      <div class="date-filter-container">
        <span class="date-filter-label">期間:</span>
        <input type="date" class="date-filter-input" id="date-start" value="${startVal}">
        <span class="date-filter-sep">〜</span>
        <input type="date" class="date-filter-input" id="date-end" value="${endVal}">
        <button class="date-filter-reset" id="date-reset-btn" title="フィルター解除">全期間</button>
      </div>`;
  },

  // イベント配列を日付範囲でフィルター
  filterEventsByDate(events, startDate, endDate) {
    if (!startDate && !endDate) return events;
    return events.filter(ev => {
      if (!ev.date) return false;
      if (startDate && ev.date < startDate) return false;
      if (endDate && ev.date > endDate) return false;
      return true;
    });
  },

  // イベントオブジェクト(events.json形式)を日付範囲でフィルター
  filterEventsObjByDate(eventsObj, startDate, endDate) {
    if (!startDate && !endDate) return eventsObj;
    const filtered = {};
    for (const [key, ev] of Object.entries(eventsObj)) {
      if (!ev.date) continue;
      if (startDate && ev.date < startDate) continue;
      if (endDate && ev.date > endDate) continue;
      filtered[key] = ev;
    }
    return filtered;
  },

  // data/series.json の配列/マップから「デフォルトで選ぶべきシリーズ」を返す
  // 優先順位: active（start昇順の最初）> upcoming（start昇順の最初）> completed（start降順の最初/最新）
  pickDefaultSeries: function(seriesInput) {
    var list;
    if (Array.isArray(seriesInput)) list = seriesInput.slice();
    else if (seriesInput && typeof seriesInput === 'object') list = Object.values(seriesInput);
    else return null;
    list = list.filter(function(s) { return s && s.id; });
    if (list.length === 0) return null;
    var actives = list.filter(function(s) { return s.status === 'active'; })
      .sort(function(a,b) { return (a.start_date||'').localeCompare(b.start_date||''); });
    if (actives.length > 0) return actives[0];
    var upcoming = list.filter(function(s) { return s.status === 'upcoming'; })
      .sort(function(a,b) { return (a.start_date||'').localeCompare(b.start_date||''); });
    if (upcoming.length > 0) return upcoming[0];
    var completed = list.filter(function(s) { return s.status === 'completed'; })
      .sort(function(a,b) { return (b.start_date||'').localeCompare(a.start_date||''); });
    if (completed.length > 0) return completed[0];
    return list[0];
  },

  // data/series.json から「イベントデータが存在するデフォルトシリーズ」を返す(2026-06-11 指示書v5 Task1)
  // 既存 pickDefaultSeries は変更せず、新メソッドとして追加。
  // 候補順序は pickDefaultSeries と同思想: active(start昇順) → upcoming(start昇順) → completed(start降順)。
  // 各候補の start_date〜end_date 範囲内のイベントを eventsObj から探し、1件以上ある最初の候補を返す。
  // 全候補が0件なら pickDefaultSeries と同じ結果を返す(現行挙動へフォールバック)。
  // eventsObj は events.json の .events マップ(key→{date,...})。
  // events.json 全体({events:{...}})を渡された場合も .events を解決して動作する。
  pickDefaultSeriesWithData: function(seriesInput, eventsObj) {
    var list;
    if (Array.isArray(seriesInput)) list = seriesInput.slice();
    else if (seriesInput && typeof seriesInput === 'object') list = Object.values(seriesInput);
    else return null;
    list = list.filter(function(s) { return s && s.id; });
    if (list.length === 0) return null;

    var byStartAsc  = function(a, b) { return (a.start_date || '').localeCompare(b.start_date || ''); };
    var byStartDesc = function(a, b) { return (b.start_date || '').localeCompare(a.start_date || ''); };
    var candidates = []
      .concat(list.filter(function(s) { return s.status === 'active'; }).sort(byStartAsc))
      .concat(list.filter(function(s) { return s.status === 'upcoming'; }).sort(byStartAsc))
      .concat(list.filter(function(s) { return s.status === 'completed'; }).sort(byStartDesc));

    // events.json 全体と .events マップのどちらを渡されても動くよう解決
    var evMap = (eventsObj && eventsObj.events && typeof eventsObj.events === 'object')
      ? eventsObj.events
      : (eventsObj && typeof eventsObj === 'object' ? eventsObj : {});

    for (var i = 0; i < candidates.length; i++) {
      var s = candidates[i];
      var start = s.start_date || '';
      var end = s.end_date || '';
      var hasData = false;
      for (var key in evMap) {
        if (!Object.prototype.hasOwnProperty.call(evMap, key)) continue;
        var ev = evMap[key];
        if (!ev || !ev.date) continue;
        if (start && ev.date < start) continue;
        if (end && ev.date > end) continue;
        hasData = true;
        break; // 1件あれば十分
      }
      if (hasData) return s;
    }
    // 全候補にデータなし → 既存ロジックの結果へフォールバック
    return this.pickDefaultSeries(seriesInput);
  },

  // シリーズから {start, end} を返す。指定がなければ空文字
  getSeriesDateRange: function(series) {
    if (!series) return { start: '', end: '' };
    return {
      start: series.start_date || '',
      end: series.end_date || ''
    };
  },

  copyShareUrl: function(btn) {
    var url = window.location.href.split('#')[0];
    var label = btn.querySelector('.copy-label');
    if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(function() {
        btn.classList.add('copied');
        label.textContent = '\u30b3\u30d4\u30fc\u3057\u307e\u3057\u305f';
        setTimeout(function() { btn.classList.remove('copied'); label.textContent = 'URL\u3092\u30b3\u30d4\u30fc'; }, 2000);
      });
    } else {
      var ta = document.createElement('textarea');
      ta.value = url; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
      btn.classList.add('copied');
      label.textContent = '\u30b3\u30d4\u30fc\u3057\u307e\u3057\u305f';
      setTimeout(function() { btn.classList.remove('copied'); label.textContent = 'URL\u3092\u30b3\u30d4\u30fc'; }, 2000);
    }
  }
};

/* ============================================================
 * Phase 2: 共通コンポーネント（パンくず / シリーズバッジ /
 *           ステータスバッジ / ヘッダー検索バー）
 * ============================================================ */

// ---- Task C: パンくずリスト ----
// items: [{ name, href }]（最後の要素の href は無くても良い）
GCG.renderBreadcrumb = function(items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  const escape = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const ol = items.map((item, idx) => {
    const isLast = idx === items.length - 1;
    const name = escape(item.name);
    const href = item.href ? escape(item.href) : '';
    const inner = isLast || !href ? `<span>${name}</span>` : `<a href="${href}">${name}</a>`;
    const attr = isLast ? ' aria-current="page"' : '';
    return `<li${attr}>${inner}</li>`;
  }).join('');
  return `<nav class="breadcrumb" aria-label="パンくずリスト"><ol>${ol}</ol></nav>`;
};

// JSON-LD 構造化データ（SEO 用）。最後の要素も item を付けたい場合は href を付ける。
GCG.renderBreadcrumbJsonLd = function(items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  const data = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, idx) => {
      const el = {
        '@type': 'ListItem',
        position: idx + 1,
        name: item.name
      };
      if (item.href) {
        const abs = /^https?:\/\//.test(item.href) ? item.href : ('https://gcg-stats.com' + item.href);
        el.item = abs;
      }
      return el;
    })
  };
  return `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
};

// ---- Task D: シリーズバッジ ----
// shortName: 表示文字列 / slug: /series/{slug}.html へのリンク
GCG.renderSeriesBadge = function(shortName, slug) {
  const escape = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const name = escape(shortName);
  const href = slug ? `/series/${encodeURIComponent(slug)}.html` : '#';
  return `<a href="${href}" class="series-badge">${name}</a>`;
};

// ---- Task E: ステータスバッジ ----
// status: 'active' | 'upcoming' | 'completed'
GCG.renderStatusBadge = function(status) {
  const labels = {
    active:    { emoji: '\u{1F7E2}', text: '開催中' },
    upcoming:  { emoji: '\u{1F7E1}', text: '予告' },
    completed: { emoji: '\u26AB',    text: '終了' }
  };
  const key = labels[status] ? status : 'completed';
  const l = labels[key];
  return `<span class="status-badge status-${key}">${l.emoji} ${l.text}</span>`;
};

// ---- Task S: ヘッダー検索バー ----
GCG.renderHeaderSearch = function() {
  return `
      <div class="header-search">
        <input
          type="search"
          id="header-search-input"
          placeholder="店舗を検索..."
          aria-label="店舗検索"
          autocomplete="off"
        >
        <div class="search-suggestions" id="header-search-suggestions" hidden></div>
      </div>`;
};

// 店舗データは共通キャッシュ
GCG._stores = null;
GCG._storesLoading = null;

GCG.loadStoresForSearch = function() {
  if (this._stores) return Promise.resolve(this._stores);
  if (this._storesLoading) return this._storesLoading;
  const basePath = this.getBasePath();
  this._storesLoading = fetch(basePath + 'data/schedule.json')
    .then(r => {
      if (!r.ok) throw new Error('schedule.json HTTP ' + r.status);
      return r.json();
    })
    .then(data => {
      const stores = [];
      const src = data && data.stores ? data.stores : {};
      for (const [id, s] of Object.entries(src)) {
        if (!s || !s.name) continue;
        stores.push({
          id: s.id != null ? s.id : id,
          name: String(s.name).replace(/\u3000/g, ' ').replace(/\s+/g, ' ').trim(),
          rawName: s.name,
          pref_code: s.pref_code || '',
          city: s.city || ''
        });
      }
      this._stores = stores;
      this._storesLoading = null;
      return stores;
    })
    .catch(e => {
      this._storesLoading = null;
      console.warn('loadStoresForSearch failed:', e && e.message);
      return [];
    });
  return this._storesLoading;
};

GCG.initHeaderSearch = function() {
  const input = document.getElementById('header-search-input');
  const suggestions = document.getElementById('header-search-suggestions');
  if (!input || !suggestions) return;
  if (input.dataset.gcgSearchInit === '1') return; // 二重初期化防止
  input.dataset.gcgSearchInit = '1';

  const self = this;
  const basePath = this.getBasePath();
  let storesPromise = null;
  let activeIdx = -1;

  const escape = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function render(matched) {
    if (!matched || matched.length === 0) {
      suggestions.innerHTML = '<div class="search-suggestions-empty">一致する店舗なし</div>';
      suggestions.hidden = false;
      activeIdx = -1;
      return;
    }
    suggestions.innerHTML = matched.map(s =>
      `<a href="${basePath}store.html?id=${encodeURIComponent(s.id)}" class="search-suggestion" data-id="${escape(s.id)}">` +
        `<div class="suggest-name">${escape(s.name)}</div>` +
        `<div class="suggest-sub">${escape(s.pref_code || '')}${s.city ? ' ' + escape(s.city) : ''}</div>` +
      `</a>`
    ).join('');
    suggestions.hidden = false;
    activeIdx = -1;
  }

  function doSearch() {
    const raw = input.value || '';
    const query = raw.replace(/\u3000/g, ' ').replace(/\s+/g, ' ').trim();
    if (query.length < 1) { suggestions.hidden = true; return; }
    if (!storesPromise) storesPromise = self.loadStoresForSearch();
    storesPromise.then(stores => {
      const q = query;
      const matched = stores.filter(s => s.name.indexOf(q) !== -1).slice(0, 10);
      render(matched);
    });
  }

  input.addEventListener('input', doSearch);
  input.addEventListener('focus', () => {
    if ((input.value || '').trim().length > 0) doSearch();
  });

  // 外側クリックで閉じる
  document.addEventListener('click', (e) => {
    if (!e.target.closest || !e.target.closest('.header-search')) {
      suggestions.hidden = true;
    }
  });

  // キーボード操作（↑↓Enter Esc）
  input.addEventListener('keydown', (e) => {
    if (suggestions.hidden) return;
    const items = suggestions.querySelectorAll('.search-suggestion');
    if (items.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIdx = (activeIdx + 1) % items.length;
      items.forEach((el, i) => el.classList.toggle('is-active', i === activeIdx));
      items[activeIdx].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIdx = (activeIdx - 1 + items.length) % items.length;
      items[activeIdx].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter') {
      if (activeIdx >= 0 && items[activeIdx]) {
        e.preventDefault();
        window.location.href = items[activeIdx].href;
      }
    } else if (e.key === 'Escape') {
      suggestions.hidden = true;
      input.blur();
    }
  });
};

// DOM 準備完了時に自動初期化（renderHeader が先に挿入済みの想定）
if (typeof document !== 'undefined') {
  const _gcgAutoInitSearch = function() {
    try { GCG.initHeaderSearch(); } catch (e) { /* ignore */ }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _gcgAutoInitSearch);
  } else {
    // すでに読み込み済みなら次マイクロタスクで実行
    setTimeout(_gcgAutoInitSearch, 0);
  }
}

// Lightbox（画像拡大表示）- グローバル関数
function openLightbox(src) {
  var lb = document.getElementById('lightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'lightbox';
    lb.style.cssText = 'display:none;position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:9999;cursor:zoom-out;justify-content:center;align-items:center';
    lb.onclick = closeLightbox;
    lb.innerHTML = '<img id="lightbox-img" src="" alt="" style="max-width:90vw;max-height:90vh;border-radius:8px;box-shadow:0 8px 40px rgba(0,0,0,0.6);object-fit:contain">' +
      '<button onclick="closeLightbox()" style="position:absolute;top:16px;right:20px;background:none;border:none;color:#fff;font-size:32px;cursor:pointer;opacity:0.7;line-height:1">&times;</button>';
    document.body.appendChild(lb);
  }
  document.getElementById('lightbox-img').src = src;
  lb.style.display = 'flex';
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  var lb = document.getElementById('lightbox');
  if (lb) {
    lb.style.display = 'none';
    document.body.style.overflow = '';
  }
}

// Escapeキーで閉じる
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeLightbox();
});
