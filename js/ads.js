/* GCG STATS — 広告の枠(指示書133 の枠・指示書152 で AdSense に差し替え)
 *
 * このファイルは手で書いたファイル(生成物ではない)。直すときはこのファイルを直接直す。
 *
 * 動き:
 *   ページに置かれた <div class="ad-slot" data-slot="…" data-kind="band|rect"> を探し、
 *   枠の実際の幅に収まる AdSense の固定サイズの広告ユニットを 1 つだけ選んで差し込む。
 *   収まらない幅では何も出さない(ad-slot-none)。
 *   差し込む <ins> は AdSense の管理画面が「固定サイズ」で出す形と同じ(属性と順序を変えない)。
 *   pub ID はこのファイルに持たない。ページの head にある AdSense の読み込みタグの client= から実行時に読む。
 *   読めなければ何もしない(枠は空のまま。高さの予約はページ側にあるので本文は動かない)。
 *   マイページの枠(data-slot が mypage- で始まる)は、お気に入りが 1 件以上あるときだけ埋める(指示書152 §8-1)。
 *   広告が埋まらなかったとき(unfilled)も何もしない(畳むと本文が動くため。§8-2)。
 *   枠の高さの予約はページ側の <style> が持つ。ここの <style> は中身の見た目だけ。
 */
(function () {
  'use strict';

  // 再実行ガード: 同じページで 2 回読まれても枠は 1 つ・push も 1 回
  if (window.__gcgAdsDone) return;
  window.__gcgAdsDone = true;

  // AdSense の広告ユニット(固定サイズ・2026-10-21 作成)。スロット ID は公開される値
  var SLOTS = {
    '728x90': { w: 728, h: 90, slot: '4252104100' },
    '320x50': { w: 320, h: 50, slot: '2939022430' },
    '300x250': { w: 300, h: 250, slot: '1489762280' }
  };

  // 帯の PC 用(728x90)を選ぶ画面幅の下限。ページ側の予約(@media(min-width:820px))と同じ値にすること
  var BAND_WIDE_MIN_VIEWPORT = 820;

  // お気に入りの保存先(js/favorites.js と同じキー・同じ版)
  var FAV_KEY = 'gcg_favorites';
  var FAV_VERSION = 1;

  var CSS =
    '.ad-slot-inner{display:inline-flex;flex-direction:column;align-items:flex-end;gap:4px;position:relative}' +
    '.ad-label{font-size:10px;color:var(--text-muted);border:1px solid var(--border);border-radius:3px;' +
    'padding:1px 6px;font-family:var(--font-mono);line-height:14px}';

  var warned = false;
  function warnOnce(e) {
    if (warned) return;
    warned = true;
    try { console.warn('[ads] ' + (e && e.message ? e.message : e)); } catch (_) { /* 何もしない */ }
  }

  function injectStyle() {
    if (document.getElementById('gcg-ads-style')) return;
    var st = document.createElement('style');
    st.id = 'gcg-ads-style';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  // head の AdSense の読み込みタグから pub ID を読む。読めなければ null
  function readClient() {
    var s = document.querySelector('script[src*="pagead2.googlesyndication.com/pagead/js/adsbygoogle.js"]');
    if (!s) return null;
    var m = /[?&]client=(ca-pub-\d{16})(?![0-9])/.exec(s.getAttribute('src') || '');
    return m ? m[1] : null;
  }

  // お気に入り(店舗+大会)の件数。読めない・壊れている → 0(js/favorites.js の read() と同じ読み方)
  function favoriteCount() {
    try {
      var raw = window.localStorage.getItem(FAV_KEY);
      if (!raw) return 0;
      var d = JSON.parse(raw);
      if (!d || typeof d !== 'object' || d.version !== FAV_VERSION) return 0;
      var n = 0, i;
      if (Array.isArray(d.stores)) {
        for (i = 0; i < d.stores.length; i++) { if (String(d.stores[i]) !== '') n++; }
      }
      if (Array.isArray(d.events)) {
        for (i = 0; i < d.events.length; i++) { if (isFinite(Number(d.events[i]))) n++; }
      }
      return n;
    } catch (_) {
      return 0;
    }
  }

  // 枠の実際の幅。タッチ端末だけ、横向きで開いたときに縦向きで収まらない大きさを選ばないよう縮める
  function usableWidth(slot) {
    var w = slot.clientWidth;
    var coarse = false;
    try { coarse = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches); } catch (_) { coarse = false; }
    if (coarse && window.screen) {
      var shortSide = Math.min(window.screen.width, window.screen.height);
      w = w - Math.max(0, window.innerWidth - shortSide);
    }
    return w;
  }

  // 返り値: 大きさの名前 / null(収まらないので出さない) / undefined(data-kind が不正なので何もしない)
  function pickSize(kind, w) {
    if (kind !== 'band' && kind !== 'rect') return undefined;
    if (!(w > 0)) return null;
    if (kind === 'band') {
      if (w >= 728 && window.innerWidth >= BAND_WIDE_MIN_VIEWPORT) return '728x90';
      if (w >= 320) return '320x50';
      return null;
    }
    return w >= 300 ? '300x250' : null;
  }

  function fill(slot, client, favCount) {
    if (slot.getAttribute('data-ad-filled') === '1') return;
    if (slot.className.indexOf('ad-slot-none') !== -1) return;

    // マイページはお気に入りが 0 件なら空のまま(クラスも付けない=予約の高さは残る)
    var placement = slot.getAttribute('data-slot') || '';
    if (placement.indexOf('mypage-') === 0 && favCount() < 1) return;

    var size = pickSize(slot.getAttribute('data-kind'), usableWidth(slot));
    if (size === undefined) return;
    if (size === null) { slot.classList.add('ad-slot-none'); return; }

    var u = SLOTS[size];
    slot.innerHTML =
      '<div class="ad-slot-inner"><span class="ad-label">広告</span>' +
      '<ins class="adsbygoogle" style="display:inline-block;width:' + u.w + 'px;height:' + u.h + 'px"' +
      ' data-ad-client="' + client + '" data-ad-slot="' + u.slot + '"></ins></div>';
    slot.classList.add('ad-size-' + size);
    slot.setAttribute('data-ad-filled', '1');

    // <ins> 1 つにつき 1 回だけ頼む(innerHTML の <script> は動かないのでここから呼ぶ)
    (window.adsbygoogle = window.adsbygoogle || []).push({});
  }

  function run() {
    try {
      var slots = document.querySelectorAll('.ad-slot[data-slot]');
      if (!slots.length) return;
      var client = readClient();
      if (!client) { warnOnce('AdSense の読み込みタグ(client=)が見つからないため広告を出しません'); return; }
      injectStyle();
      var cached = null;
      var favCount = function () { if (cached === null) cached = favoriteCount(); return cached; };
      // 読み込み時に 1 回だけ決める(回転・リサイズでは変えない)
      for (var i = 0; i < slots.length; i++) {
        try { fill(slots[i], client, favCount); } catch (e) { warnOnce(e); }
      }
    } catch (e) { warnOnce(e); }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
