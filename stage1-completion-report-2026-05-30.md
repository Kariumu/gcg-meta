# Stage 1 完了報告（post-processing.js 移植）

実施日: 2026-05-30
作業者（一次）: Claude（本セッション・OneDriveアクセス許可後に取込）
確認者（二次）: 独立エージェント（作業者とは別）— 全項目 VERIFIED
対象: 第3案 runbook Stage 1「OneDrive `post-processing.js` を dev `scripts/` へ移植（未改修）」

---

## 1. 実施内容

- OneDrive 出典 `C:\Users\kariu\OneDrive\GCGSimulator\homepage\scripts\post-processing.js`（17,272B / 408行 / 2026-05-19）を、dev `C:\dev\gcg-meta\scripts\post-processing.js` として**バイト完全一致でコピー**（この時点では未改修＝Stage 2 のパンくず追加は未実施）。

## 2. §2B（OneDrive側主張）の実ファイル照合 — 全て確認

| runbook §2B の主張 | 判定 | 実ファイル根拠 |
|--------------------|------|----------------|
| require は fs / path / `../git-push.js` のみ、sharp・dotenv 不要 | ✅ | `post-processing.js:25-27` |
| `cards_preview.json` を読む | ✅ | 定義 `:31`、読込 `:280-281` |
| `cards/{cn}/index.html` を出力 | ✅ | `:149-150,164`（createCardPage） |
| webp は jpg のコピー（真変換なし） | ✅ | `:195` `fs.copyFileSync(srcJpg, destWebp)` |
| カードテンプレにパンくず無し（戻り導線のみ） | ✅ | テンプレ `:61-145` に breadcrumb/`?set=` 無し。戻り導線 `:137`。JSON-LDは Article型（`:106-115`）で BreadcrumbList ではない |
| パスは `__dirname` 基準（git-push を `path.resolve(__dirname,'..','git-push.js')`） | ✅ | `:27,30`（`HOMEPAGE_ROOT = path.resolve(__dirname,'..')`） |

## 3. Stage 1 合格基準 — 全て合格

1. **差分ゼロ / md5 一致**: 両ファイル `056a386078b8f221b52d902f6dc53d13`、`diff` 差分なし。✅
2. **require は3つのみ**: `fs`(:25) / `path`(:26) / `../git-push.js`(:27)。外部npm追加なし。✅
3. **`__dirname/..` 解決先が dev 直下に実在**: `git-push.js`・`data/cards_preview.json`・`cards/`・`images/cards/`・`index.html`・`images/news/` すべて存在。✅
   - dev `scripts/post-processing.js` の場合 `HOMEPAGE_ROOT = C:\dev\gcg-meta`（リポジトリ直下＝dev Webルート）に解決。出力先・読込先が正しく dev 構成に一致。

## 4. Phase 3 結線の確認（移植により成立）

- dev ルート `auto-news.js:2480` の `require('./scripts/post-processing')` は、**移植後に解決可能**になった（従来は対象不在で必ず失敗→catch握りつぶし）。
- 呼出シグネチャ一致: auto-news.js は `postProcess({ date, cardNumbers, dryRun })`（`:2481-2485`）、post-processing.js は `module.exports = { postProcess }`（`:381`）／`postProcess({ date, cardNumbers, dryRun })`（`:264`）。✅
- ただし**実行は auto-news.js 起動が前提**で、起動には sharp/dotenv が必要（Stage 0-A・Stage 4）。post-processing.js 単体は sharp/dotenv 不要なので、Stage 3 で auto-news.js と独立に検証可能（`:385` の直接実行ブロックあり）。

## 5. 注意点（次工程前に確認）

- **git 未追跡**: 移植した `scripts/post-processing.js` は現在 git 上 Untracked（ローカル作業ツリーのみ）。公開は `git-push.js`（GitHub API・特定ファイルのみ）経由のため**自動公開されない**。
  - パイプラインの**動作**にはローカル存在で足りる（auto-news.js はローカルfsから require するため）。
  - dev リポジトリを正本にするなら `git add scripts/post-processing.js && git commit` が必要だが、**git操作は松岡さんの領域**（Cowork は実施しない）。実施要否は松岡さん判断。
- **Stage 3 の DRY_RUN 仕様**: `dryRun=true` ではファイルを書かず（ページ作成 `:156-159`／画像 `:187-189`／index更新 `:251-253`）、`[DRY_RUN]` ログのみ。→ 生成物の実体確認は「ログで確認」か「`dryRun=false` でローカル生成（push はトークン無し等で抑止）」のいずれかを Stage 3 手順に明記すべき。
- **エラーは Phase 3 で握りつぶし**（auto-news.js:2487-2490）。post-processing 側のエラー（例: cards_preview 読込失敗）はログ注視で検知。

## 6. 次工程

- **Stage 2（パンくず追加）**: post-processing.js のカードHTMLに `<nav class="breadcrumb">` ＋ `cards.html?set=<package_set>` ＋ BreadcrumbList を、`generate_cards.js:897-907,1080,1097` を流用して追加。`?set=` 値は package_set（preview はセット欄無しのため card_number 接頭辞から導出、PROMO/β は要個別処理）。
  - ※ 第3案点検で出た3指摘（Stage 0-D の理由修正・Stage 1 出典前提・Stage 2 set値仕様）の runbook 反映（v4化）を、運用ルール（二重確認）に沿って先に行うのが望ましい。
- **Stage 0-A（sharp/dotenv 導入）**: 未了。Stage 4（本番切替・auto-news.js 実行）の前に松岡さんが確認・`npm install`。
- 外部確認継続（松岡さん）: 日次18:00タスクの実体、実行される auto-news.js の実パス。

---

二重確認の結果、**Stage 1 は合格基準を満たして完了**。Stage 2 に進める状態です（上記 runbook 反映を推奨）。
