# 新カード自動生成パイプライン dev側移植・一本化 実行runbook【第4案】

作成日: 2026-05-30 / 改訂: 二次確認者（別セッションのClaude）
ステータス: **Stage 1・Stage 2 実施済(二重確認済)。Stage 3 が次。Stage 4(本番切替)は Stage 0-A 完了＋Stage 3 合格＋点検後。**
位置づけ: 第3案点検の3指摘と、独立検証・Stage 1/2 実施結果を反映し **第3案を置換**。

---

## 0. 第3案からの変更点

- **指摘①反映**: Stage 0-D の理由を訂正。「preview に `_pendingReview` が実在するため regenerate-article.js が必要」は不正確（フィールドは29件に在るが **`_pendingReview===true` は現在0件**）。正しい根拠＝「auto-news.js の保留時フロー（保留検知→停止→手動補完→`regenerate-article.js` で再生成）が前提にしている手動ツール。ただし `require` ではないため auto-news.js の起動には不要」。
- **指摘②反映（解消済）**: Stage 1 のコピー元アクセス前提を満たし、**OneDrive 出典を取り込んで Stage 1 を実施済**（§4 Stage 1）。
- **指摘③反映（実装済）**: Stage 2 の `?set=` 値仕様を確定し **実装済**（URL値=package_set/接頭辞、`PROMO→プロモ`は表示ラベルのみ、href=`../../cards.html?set=<SET>`、JSON-LDは絶対URL）。
- 追加で確定した事実: `cards.html` は `?set=` を URLSearchParams で処理（`cards.html:2015`）＝パンくずリンクは機能する。`git-push.js` のトークンは**呼び出し時**取得（require時不要）。

## 1. ゴール

日次パイプラインを dev側（`C:\dev\gcg-meta`）に一本化し、新カードページにも `?set=` パンくずが入る状態にする。

## 2A. dev リポジトリで確認済みの事実（file:line・二重確認済）

- `generate_cards.js`: 対象カード = `summary.card_ranking`(`:356`) ∪ `cards_master` キー(`:371-374`)。`cards_preview.json` 非読込、単票引数なし（DEBUG時のみ固定4枚 `:381-382`）。→ master未収録の当日新カードは生成不能。
- `data/cards_preview.json`: `card_number` キーの42件。フィールドに `set/package_set/series/expansion` 無し（`_pendingReview` は29件に在るが true は0件、`_pendingReviewIssues` 29件、`_articleDate` 41件）。
- 新カードの preview 保存 = ルート `auto-news.js` `saveCardPreview()`（`:822,:850,:852`、呼出 `:2239`）。dev で既に機能。
- Phase 3: ルート `auto-news.js:2479-2491` が `require('./scripts/post-processing')` を try/catch で呼ぶ。署名 `postProcess({date,cardNumbers,dryRun})` 一致。
- ルート `auto-news.js` 冒頭で `sharp`(`:17`)・`dotenv`(`:20`) を require。外部npm = sharp + dotenv。
- `git-push.js`: GitHub REST API（`kariumu`/`gcg-meta`/`main`）。ローカルgit不使用。トークンは `getToken()` を**呼び出し時**（`githubAPI` 内 `:42`）に取得＝require時は不要。
- `generate_cards.js` パンくず: setLinkValue は `package_set` 優先・無ければ接頭辞 `setPrefix`(`:899-902`)、表示名 `SET_DISPLAY_NAMES={'PROMO':'プロモ'}`(`:904`)、href はテンプレ側で `../../${setLinkHref}`(`:1102`)、BreadcrumbList は絶対URL(`:1080`)。**確立ページは BreadcrumbList のみで Article JSON-LD は無い**（EB01-028 で確認）。
- `cards.html` は `?set=` を URLSearchParams+location.search で処理（`:2015`）。

## 2B. OneDrive側で確認済み → Stage 1 で dev に取込済（出典: `OneDrive\GCGSimulator\homepage\scripts\post-processing.js`）

- require は `fs`/`path`/`../git-push.js` のみ、**sharp/dotenv 不要**（`:25-27`）。
- `cards_preview.json` 読込(`:31,:280-281`)、`cards/{cn}/index.html` 出力(`:148-165`)、webp は jpg コピー(`:195`)。
- パスは `HOMEPAGE_ROOT = path.resolve(__dirname,'..')`(`:30`)基準。dev `scripts/` 配置時はリポジトリ直下に解決（実在確認済）。
- 直接実行サポートあり(`:385`)、DRY_RUN 分岐あり（ファイルは書かずログのみ）。

## 2C. 未確認・ゲート項目

- **Stage 0-A（硬いゲート）**: dev の node_modules に `sharp`・`dotenv` が**未導入**（確認済）。→ 松岡さんが `npm install`（Stage 4 前）。post-processing.js 単体は不要なので Stage 3 はブロックしない。
- **Stage 0-C残**: `PROMO`/`β` 等で接頭辞≠package_set の正規化。`cards.html` の `?set=` 対応は確認済(`:2015`)だが、β/PROMO の `data-value` 実値との突合は Cowork が確認。
- **Stage 0-D**: `regenerate-article.js` は auto-news.js から require されず（コメント/ログのみ `:846,:2281,:2286,:2299,:2514`）＝**手動リカバリ用ツール**で起動には不要。保留カード発生時に必要。`create-card-pages.js` は dev パイプラインから無参照＝不要寄り。移植要否は運用方針で判断（先行移植 or 初回保留時）。
- **外部確認（松岡さん）**: 日次18:00タスクの実体、実行される auto-news.js の実パス。

## 3. 責任分担

- **Cowork（一次）**: Stage 1/2 のファイル移植・テンプレ改修・検証・dry-run。git操作/スケジューラ/.env/依存導入/切替/旧タスク停止は行わない。
- **松岡さん（PowerShell）**: Stage 0-A の `npm install`、`.env`、スケジューラ更新・旧タスク無効化、Stage 4 の最終トリガ、必要なら新スクリプトの git commit。
- **Claude（チャット＝二次）**: 各段階の点検・合格基準確認。dev は変更しない（点検のみ）。

## 4. 実行手順と状態

### Stage 0（ゲート）— A:未了 / C・D:一部判明
A: 依存（松岡さん・未導入）／C: PROMO・β 正規化（Cowork、cards.html対応は確認済）／D: regenerate・create-card-pages 要否（Cowork、理由は§2C訂正済）。

### Stage 1 — post-processing.js 移植 … ✅ 実施済（二重確認済）
- OneDrive `scripts/post-processing.js`(17,272B) を dev `scripts/post-processing.js` に**バイト完全一致**でコピー（md5 `056a386…`、diff差分ゼロ、作業者＋独立確認者で確認）。
- 合格基準すべて達成: require=fs/path/../git-push.js のみ／`__dirname/..` 解決先（git-push.js・data/cards_preview.json・cards/・images/cards/・images/news/・index.html）が dev に実在。

### Stage 2 — `?set=` パンくず追加 … ✅ 実施済（二重確認済）
- dev `scripts/post-processing.js` の `generateCardPageHtml` に、JSON-LD BreadcrumbList（絶対URL）と可視 `<nav class="breadcrumb">`（href=`../../cards.html?set=<SET>`）を追加。`<SET>` は `card_number` 接頭辞から導出（`_pN`・末尾連番除去）、表示名は `SET_DISPLAY_NAMES`。
- 検証（隔離レンダリング＋独立確認者）: 構文OK、EB01-072→set=EB01 / GD04-045→GD04 / ST10-006→ST10 で nav・BreadcrumbList とも生成、href形式は既存 EB01-028 と同形、Article JSON-LD は1個のまま、「← トップに戻る」残存（回帰なし）。
- **要判断（JSON-LD整合）**: post-processing.js のページは **Article＋BreadcrumbList の二重**（Article は原本テンプレ由来）。一方 generate_cards.js の確立ページは **BreadcrumbList のみ**。新カードが後日 generate_cards.js で再生成されると Article が消える非対称が生じる。許容（valid SEO）か、parity のため post-processing.js から Article を外すかを松岡さん判断。
- **注（dev マウント既知事象）**: 本セッションの bash dev マウントはホスト書込み直後の本ファイルを末尾切断ビューで返したが、**ホスト実体は440行で完全**（Read で確認）。本番 Windows の `node` はホスト実体を読むため影響なし。

### Stage 3 — dry-run 検証（Cowork）… ▶ 次
- 作業: まだページの無い preview カードを選び、`node scripts/post-processing.js --date <YYYY-MM-DD> --cards <CN> --dry-run`（単体）で実行。**トークン不要**（dry-runは push せず、getToken も走らない）。
- 重要: **DRY_RUN はファイルを書かない**（`:156-159,:187-189,:251-253`）。確認はログ行（`[DRY_RUN] create: cards/{cn}/index.html` 等）で行う。生成HTMLの実体を見たい場合は、push を伴わない形でローカル生成（例: 隔離環境で `generateCardPageHtml` を呼ぶ）か、トークン未設定で `dryRun=false` を避ける。
- 合格基準（Claude点検）: 想定パスに生成され、パンくず（`?set=`）が正しく入り、push 等の副作用が無い。**合格まで Stage 4 に進まない。**

### Stage 4 — 切替（松岡さん・PowerShell、Stage 0-A＋Stage 3合格＋二次確認後）… ⏸ ゲート
- dev に `sharp`/`dotenv` と `.env`（GITHUB_TOKEN 等）を整備。スケジューラ実行対象を **dev リポジトリ直下のルート `auto-news.js`** に変更（**homepage 旧版を指さない**）。旧（OneDrive）タスクは**削除せず無効化**。

### Stage 5 — 切替後の初回監視
- 翌18:00 dev側ログで記事・X投稿・Phase 3（カードページ生成）・push 全成功、新カードにパンくず確認。異常時は即ロールバック。

## 5. ロールバック

旧OneDriveタスクは無効化のみ。問題時は「devタスク無効化 → OneDriveタスク再有効化」で即時復帰。

## 6. 主なリスク

- 依存未導入で起動不能（Stage 0-A・未導入確認済）→ Stage 4 前に `npm install`。
- 静かな失敗（post-processing 未移植でカードページ欠落）→ Stage 1 完了済・Stage 3 で担保。
- 二重公開（新旧タスク同時）→ 切替と同時に旧タスク無効化。
- homepage 旧 auto-news.js を指す事故 → Stage 4 で実行対象を固定。
- パンくず set 値不整合（PROMO/β）→ Stage 0-C で個別確定。
- JSON-LD 非対称（§4 Stage 2）→ 許容/parity を判断。

## 7. この文書の二次確認

Stage 1・Stage 2 はいずれも「作業者（Cowork）→ 独立確認者（別エージェント）」の二重確認を通過済。本 v4 は第3案点検結果を反映。Stage 0-A 未了のまま Stage 4 に進まない。

## 8. 追記（2026-05-31 JST）— ①修正・Stage 0-A・Stage 3 反映

- **①修正（適用・二重確認済）**: `scripts/post-processing.js` line 86 を
  `const setLinkValue = (rawCn.match(/^([A-Z]+\d+)-/) || [])[1] || setPrefix;` に変更（`setPrefix` はフォールバック維持）。
  差分はこの1行のみ。`EB01-045R` の取りこぼし（旧 `setPrefix` では `EB01-045R` のまま）を解消し `EB01` に。
  全42件中 set 値が変わるのは EB01-045R の1件のみ、他41件は不変。Cowork 自己検証＋松岡さん側ホスト Read で二重確認済。
  （注: コメント 80-82 は接頭辞導出の説明のままで regex 優先化に未言及。挙動は正しく、後日の任意整理対象。）
- **Stage 0-A（クリア済み）**: dev に `sharp`・`dotenv` 導入済み（松岡さん）。Stage 4 の硬いゲートを通過。
- **Stage 3 dry-run（合格）**: 隔離環境（dev 実体とバイト等価の再構成版を dev 実データへ symlink、push はスタブで遮断）で `postProcess(dryRun:true)` を実行。
  - create 経路（CARDS_DIR 空）: `EB01-045R`/`GD04-045`/`ST10-006` とも `[DRY_RUN] create: cards/{cn}/index.html` を正しいパスで出力。レンダリングで set 値＝`EB01`/`GD04`/`ST10`、可視 nav href＝`../../cards.html?set=…`。
  - skip 経路（CARDS_DIR=dev 実）: 3枚とも既存のため create されず「(既存)」＝冪等。
  - push 副作用なし（スタブの throw が一度も発火せず両 run 完走、`dryRun:true`）。index.html もリンク既存で更新スキップ。
  - ※ バイト厳密確認はホスト（松岡さん）側で本物 `node` 実行が最確（本セッション bash の dev マウントは末尾切断ビューのため）。
- **残作業**: regenerate-article.js 移植（Cowork→点検）／cards.html 反映方針の決定（master 取込＋`generate_cardlist.js` 再実行までは新セット `?set=` が一時空表示）／Stage 4 切替（松岡さん）／Stage 5 監視。
