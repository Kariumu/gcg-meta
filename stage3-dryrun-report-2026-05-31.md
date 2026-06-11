# Stage 3 dry-run 報告（post-processing.js）

実施日: 2026-05-31 JST
作業者（一次）: Claude（Cowork・本セッション）
点検（二次）: 松岡さん（ホスト権威ビュー／本ログのレビュー）
対象: dev `scripts/post-processing.js`（Stage 1 移植＋Stage 2 パンくず＋①修正済）

## 1. 実行方法（なぜこの形か）

本セッションの bash の dev マウントは、ホスト書込み直後の `post-processing.js` を末尾切断ビューで返す既知事象がある（CLAUDE.md 記載）。そのため dev 実体を sandbox で直接 `node` 実行できない。代替として:

- dev 実体とバイト等価の**再構成版**（OneDrive 原本＋同一の3挿入＋①修正）を sandbox に作成（`node --check` OK）。※本ランの再構成はコメント4行を省略したが挙動は同一。
- それを **dev の実データへ symlink**（`data`・`images`・`index.html`＝dev 実、`cards` は create 経路用に空ディレクトリ／skip 経路用に dev 実）。
- `git-push.js` は**スタブ（呼ばれたら throw）**に差し替え、push を物理的に遮断。
- `postProcess({date, cardNumbers, dryRun:true})` を実行。

> バイト厳密の最終確認は、ホスト（松岡さん）側で本物の `node scripts/post-processing.js --date … --cards … --dry-run` を実行するのが最確。

## 2. 対象カードの選定理由

- preview 全42件は**すべて dev に既存ページあり**（未生成の preview カードが無い）。そこで生成（create）経路を見るため CARDS_DIR を空にして実行（dev の cards/ は不変更）。
- カードは `EB01-045R`（①修正の対象カード）・`GD04-045`・`ST10-006`（GD/EB/ST 3セットの代表）を選定。`date=2026-05-15`（EB01-045R の `_articleDate`）。

## 3. ログ

### レンダリング証跡（①修正の set 値）
```
EB01-045R → set= EB01 | nav href ../../cards.html?set= 有: true
GD04-045  → set= GD04 | nav href ../../cards.html?set= 有: true
ST10-006  → set= ST10 | nav href ../../cards.html?set= 有: true
```

### [A] CREATE 経路（CARDS_DIR=空, dryRun=true）
```
[post-processing] 日付: 2026-05-15, 対象カード: 3 件, DRY_RUN: true
  [DRY_RUN] create: cards/EB01-045R/index.html
  [DRY_RUN] copy: images/news/2026-05-15/EB01-045R.jpg → images/cards/EB01-045R.jpg + .webp
  [DRY_RUN] create: cards/GD04-045/index.html
  ★ 警告: 元画像不在、スキップ: images/news/2026-05-15/GD04-045.jpg
  [DRY_RUN] create: cards/ST10-006/index.html
  ★ 警告: 元画像不在、スキップ: images/news/2026-05-15/ST10-006.jpg
  index.html: 2026-05-15 のリンク既存、更新スキップ
  [DRY_RUN] HTML files: 3  (cards/EB01-045R, cards/GD04-045, cards/ST10-006)
  [DRY_RUN] binary files: 5
  === 完了: pages=3(+既存0) / imgs=2(skip 2) / pushed text=3 bin=5 ===
result: pageCreated:3, pageExisting:0, imgsPlaced:2, imgsSkipped:2, indexHtmlChanged:false, dryRun:true
```

### [B] SKIP 経路（CARDS_DIR=dev 実, dryRun=true）
```
  （create ログなし＝全て既存）
  [DRY_RUN] HTML files: 3  (cards/EB01-045R (既存), cards/GD04-045 (既存), cards/ST10-006 (既存))
  === 完了: pages=0(+既存3) / imgs=2(skip 2) / pushed text=3 bin=5 ===
result: pageCreated:0, pageExisting:3, dryRun:true
```

## 4. 合格判定（Stage 3 基準との対応）

- **正しいパスにページ生成予定**: ✅ `[DRY_RUN] create: cards/{cn}/index.html` を3枚とも正しいパスで出力。
- **パンくず正常**: ✅ レンダリングで set 値＝`EB01`/`GD04`/`ST10`、可視 nav href＝`../../cards.html?set=…`。①修正で EB01-045R が `EB01` に解消されていることも end-to-end で確認。
- **push 副作用なし**: ✅ push スタブの throw が**一度も発火せず**両 run 完走（`dryRun:true`、HTML/画像は push リスト化のみで送信なし）。
- **冪等性**: ✅ skip 経路で既存ページは create されず「(既存)」。index.html もリンク既存で更新スキップ。
- **画像**: EB01-045R は news 画像(2026-05-15)があり jpg+webp コピー予定、他2枚は元画像不在でスキップ（`binary` 件数は既存 images/cards 画像を反映、0でも異常でない）。

**判定: Stage 3 dry-run 合格。**

## 5. 次工程（残作業）

1. `regenerate-article.js` 移植（Cowork→点検）— auto-news.js の保留時手動復旧フローが前提（require ではない）。
2. cards.html 反映方針の決定（あなた／松岡さん）— 新セット（EB01/ST10）は master 取込＋`generate_cardlist.js` 再実行までは `?set=` が一時空表示（GD04 は既に機能）。
3. Stage 4 切替（松岡さん・PowerShell）— Stage 0-A 済。スケジューラを dev 直下 `auto-news.js` へ、homepage 旧版を指さない、OneDrive 旧タスクは無効化（削除しない）。
4. Stage 5 初回監視（翌18:00）。
