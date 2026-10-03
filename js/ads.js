/* GCG STATS — 遊々亭バナーの枠(指示書133)
 *
 * このファイルは js/ads.js の本体(テンプレ)。js/ads.js は生成物なので直接編集しない。
 * 直すときはこのテンプレを直して `node scripts/build-ads-js.js` を流す。
 *
 * 動き:
 *   ページに置かれた <div class="ad-slot" data-slot="…" data-kind="band|rect"> を探し、
 *   枠の実際の幅に収まる素材を 1 つだけ選んで差し込む。収まらない幅では何も出さない。
 *   広告コードは A8.net の管理画面の物をそのまま(一字も変えずに)使う。
 *   枠の高さの予約はページ側の <style> が持つ。ここの <style> は中身の見た目だけ。
 */
(function () {
  'use strict';

  // 再実行ガード: 同じページで 2 回読まれても枠は 1 つ
  if (window.__gcgAdsDone) return;
  window.__gcgAdsDone = true;

  // 広告コード(生成器が置き換える。A8.net の「通常広告用」のコードそのまま)
  var ADS = {
    '728x90': "<a href=\"https://px.a8.net/svt/ejp?a8mat=4BC4QT+CJW0XE+49ZW+5Z6WX\" rel=\"nofollow\">\r\n<img border=\"0\" width=\"728\" height=\"90\" alt=\"\" src=\"https://www28.a8.net/svt/bgt?aid=260906501759&wid=001&eno=01&mid=s00000019958001004000&mc=1\"></a>\r\n<img border=\"0\" width=\"1\" height=\"1\" src=\"https://www19.a8.net/0.gif?a8mat=4BC4QT+CJW0XE+49ZW+5Z6WX\" alt=\"\">",
    '320x50': "<a href=\"https://px.a8.net/svt/ejp?a8mat=4BC4QT+CJW0XE+49ZW+5ZMCH\" rel=\"nofollow\">\r\n<img border=\"0\" width=\"320\" height=\"50\" alt=\"\" src=\"https://www25.a8.net/svt/bgt?aid=260906501759&wid=001&eno=01&mid=s00000019958001006000&mc=1\"></a>\r\n<img border=\"0\" width=\"1\" height=\"1\" src=\"https://www15.a8.net/0.gif?a8mat=4BC4QT+CJW0XE+49ZW+5ZMCH\" alt=\"\">",
    '300x250': "<a href=\"https://px.a8.net/svt/ejp?a8mat=4BC4QT+CJW0XE+49ZW+5ZU29\" rel=\"nofollow\">\r\n<img border=\"0\" width=\"300\" height=\"250\" alt=\"\" src=\"https://www21.a8.net/svt/bgt?aid=260906501759&wid=001&eno=01&mid=s00000019958001007000&mc=1\"></a>\r\n<img border=\"0\" width=\"1\" height=\"1\" src=\"https://www19.a8.net/0.gif?a8mat=4BC4QT+CJW0XE+49ZW+5ZU29\" alt=\"\">"
  };

  // 帯の PC 用素材(728x90)を選ぶ画面幅の下限。ページ側の予約(@media(min-width:820px))と同じ値にすること
  var BAND_WIDE_MIN_VIEWPORT = 820;

  var CSS =
    '.ad-slot-inner{display:inline-flex;flex-direction:column;align-items:flex-end;gap:4px;position:relative}' +
    '.ad-label{font-size:10px;color:var(--text-muted);border:1px solid var(--border);border-radius:3px;' +
    'padding:1px 6px;font-family:var(--font-mono);line-height:14px}' +
    '.ad-slot-inner a>img{display:block}' +
    '.ad-slot-inner>img{position:absolute;width:1px;height:1px;left:0;bottom:0}';

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

  // 枠の実際の幅。タッチ端末だけ、横向きで開いたときに縦向きで収まらない素材を選ばないよう縮める
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

  // 返り値: 素材の名前 / null(収まらないので出さない) / undefined(data-kind が不正なので何もしない)
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

  function fill(slot) {
    if (slot.getAttribute('data-ad-filled') === '1') return;
    if (slot.className.indexOf('ad-slot-none') !== -1) return;

    var size = pickSize(slot.getAttribute('data-kind'), usableWidth(slot));
    if (size === undefined) return;
    if (size === null) { slot.classList.add('ad-slot-none'); return; }

    slot.innerHTML = '<div class="ad-slot-inner"><span class="ad-label">広告</span>' + ADS[size] + '</div>';
    slot.classList.add('ad-size-' + size);
    slot.setAttribute('data-ad-filled', '1');

    var a = slot.querySelector('a[href^="https://px.a8.net/"]');
    if (!a) return;

    // 属性の追加だけ(rel の値は変えない)
    if (!a.hasAttribute('target')) a.setAttribute('target', '_blank');

    // バナーの画像が来なかったら枠を畳む(1x1 の計測画像は対象外)
    var banner = a.querySelector('img');
    if (banner) {
      banner.addEventListener('error', function () {
        try { slot.classList.add('ad-slot-failed'); } catch (e) { warnOnce(e); }
      });
    }

    // クリック計測(送信を待たない・遷移を止めない)
    var placement = slot.getAttribute('data-slot');
    a.addEventListener('click', function () {
      try {
        if (typeof window.gtag === 'function') {
          window.gtag('event', 'affiliate_click', { shop: 'yuyutei', placement: placement, size: size });
        }
      } catch (e) { warnOnce(e); }
    });
  }

  function run() {
    try {
      var slots = document.querySelectorAll('.ad-slot[data-slot]');
      if (!slots.length) return;
      injectStyle();
      // 読み込み時に 1 回だけ決める(回転・リサイズでは変えない)
      for (var i = 0; i < slots.length; i++) {
        try { fill(slots[i]); } catch (e) { warnOnce(e); }
      }
    } catch (e) { warnOnce(e); }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', run);
  } else {
    run();
  }
})();
