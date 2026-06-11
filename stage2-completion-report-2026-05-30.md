# Stage 2 完了報告（`?set=` パンくず追加）

実施日: 2026-05-30
作業者（一次）: Claude（本セッション）
確認者（二次）: 独立エージェント（別） — 全項目 VERIFIED
対象: dev `scripts/post-processing.js`（Stage 1 で移植済の dev コピー）

## 1. 変更内容（追加のみ・3箇所、原本との差分で確認）

1. **set 値導出ブロック**（`generateCardPageHtml` 内、return 直前）: `card_number` 接頭辞から `setPrefix = rawCn.replace(/_p\d+$/,'').replace(/-\d+$/,'')`、`SET_DISPLAY_NAMES={'PROMO':'プロモ'}`、`setLinkValue/setLinkLabel/setLinkHref`。generate_cards.js(`:877,:899-907`) と同一規則。
2. **JSON-LD BreadcrumbList**（`<head>`、既存 Article JSON-LD の直後）: position 1..4＝ホーム/カード一覧/`${escapeHtml(setLinkLabel)}`/`${name}`、item は絶対URL `https://gcg-stats.com/...`（position3 = `https://gcg-stats.com/${setLinkHref}`）。
3. **可視パンくず `<nav class="breadcrumb">`**（`<main>` 冒頭、`<h1>` 直前）: `../../index.html` › `../../cards.html` › `../../${setLinkHref}` › `<span>${name}</span>`。

原本（OneDrive）との `diff` は上記3ブロックの**追加のみ**。既存部分の変更・削除なし。

## 2. 検証結果（合格）

- **構文**: `node --check` OK（テンプレートリテラルのバックティック/波括弧の整合を確認）。
- **機能（隔離レンダリング、純関数・push無し）**: 3カードで `generateCardPageHtml` を実行。

  | カード | 可視nav | BreadcrumbLD | Article LD | set値 | nav href |
  |--------|--------|--------------|-----------|-------|----------|
  | EB01-072 | ✓ | ✓ | 1(温存) | EB01 | `../../cards.html?set=EB01` |
  | GD04-045 | ✓ | ✓ | 1(温存) | GD04 | `../../cards.html?set=GD04` |
  | ST10-006 | ✓ | ✓ | 1(温存) | ST10 | `../../cards.html?set=ST10` |

- **既存リッチ版との整合**: 生成 nav/JSON-LD の href 形式・項目構成が `cards/EB01-028/index.html`（generate_cards.js 生成）と同形。
- **回帰なし**: 「← トップに戻る」リンク・画像・stats・effect 等は保持。
- **frontend 対応**: `cards.html` は `?set=` を URLSearchParams で処理（`cards.html:2015`）＝リンクは機能する。
- **ファイル完全性**: dev 実体は440行で完全（`module.exports`・直接実行ブロック・`// EOF` まで、Read で確認）。
  - ※ 本セッションの bash dev マウントはホスト書込み直後に末尾切断ビューを返したが、これは CLAUDE.md 記載の既知事象。ホスト実体は完全で、本番 Windows の `node` はホスト実体を読むため影響なし。

## 3. 要判断事項（松岡さん）

- **JSON-LD の非対称**: post-processing.js の新カードページは **Article＋BreadcrumbList の二重**（Article は原本テンプレ由来で温存）。一方 generate_cards.js の確立ページは **BreadcrumbList のみ**。新カードが後日 generate_cards.js で再生成されると Article が消える非対称が生じる。
  - 選択肢A（現状・推奨度中）: 維持（双方 valid SEO、Stage 2 範囲＝追加のみを厳守）。
  - 選択肢B: parity のため post-processing.js から Article JSON-LD を削除（要追加改修・スコープ拡大）。
- **PROMO/β**: 接頭辞≠package_set の恐れ。現データ42件は GD/EB/ST のみで影響なし。将来の PROMO/β は Stage 0-C の正規化マップで個別対応（コードにも注記済）。

## 4. 次工程

Stage 3（dry-run）。`node scripts/post-processing.js --date <日付> --cards <未生成のpreviewカード> --dry-run` をトークン無しで実行可（dry-runはpushせず getToken も走らない）。DRY_RUN はファイルを書かないため、確認はログ行で行う。合格後、Stage 0-A（sharp/dotenv 導入・松岡さん）→ Stage 4 切替。

二重確認の結果、**Stage 2 は合格基準を満たして完了**。Stage 3 に進める状態です。

## 5. 追記（2026-05-31 JST）— ①修正と Stage 3 dry-run

- **①修正（line 86・二重確認済）**: set 値導出を `setPrefix`（`_pN`・末尾連番除去のみ）から
  `(rawCn.match(/^([A-Z]+\d+)-/) || [])[1] || setPrefix` に変更（フォールバック維持）。
  `EB01-045R` が旧方式では `EB01-045R` のままだった取りこぼしを `EB01` に解消。全42件で変化は EB01-045R の1件のみ、他41件不変。差分は1行のみ。
- **Stage 3 dry-run（合格）**: create 経路で `EB01-045R`/`GD04-045`/`ST10-006` を `[DRY_RUN] create: cards/{cn}/index.html` の正しいパスで生成予定と確認。set 値は `EB01`/`GD04`/`ST10`。skip 経路（dev 実 cards）では既存のため冪等にスキップ。**push は一度も呼ばれず副作用なし**（dryRun）。
- **Stage 0-A**: sharp/dotenv 導入済み（松岡さん）でクリア。
- 次工程: regenerate-article.js 移植、cards.html 反映方針の判断、Stage 4 切替（松岡さん）。
