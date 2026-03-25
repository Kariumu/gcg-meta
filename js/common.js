/**
 * GCG META - 共通モジュール
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

  // ページのベースパスを自動検出
  getBasePath() {
    const path = window.location.pathname;
    if (path.includes('/events/') || path.includes('/meta/') || path.includes('/cards/')) {
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

  // 共通ヘッダーHTML生成
  renderHeader(activePage) {
    const basePath = this.getBasePath();
    return `
      <header class="site-header">
        <div class="header-inner">
          <a href="${basePath}index.html" class="site-logo">
            <span class="logo-icon">G</span>
            <div>
              <span class="logo-text">GCG META</span>
              <span class="logo-sub">Tournament Analytics</span>
            </div>
          </a>
          <nav>
            <a href="${basePath}index.html" class="${activePage === 'home' ? 'active' : ''}">ダッシュボード</a>
            <a href="${basePath}events.html" class="${activePage === 'events' ? 'active' : ''}">イベント</a>
            <a href="${basePath}meta.html" class="${activePage === 'meta' ? 'active' : ''}">環境分析</a>
          </nav>
        </div>
      </header>`;
  },

  // 共通フッターHTML生成
  renderFooter() {
    return `
      <footer class="site-footer">
        <div class="footer-disclaimer">
          本サイトはガンダムカードゲームの非公式ファンサイトです。<br>
          バンダイ・サンライズの認可・許諾は得ていません。<br>
          掲載情報は公式大会結果を基に自動集計しています。<br>
          ©SOTSU・SUNRISE ©BANDAI
        </div>
      </footer>`;
  }
};
