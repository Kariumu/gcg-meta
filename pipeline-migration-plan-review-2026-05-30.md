# 第1案 点検結果（二次確認者レビュー）

対象文書: `pipeline-migration-plan-draft-2026-05-30.md`（第1案）
点検日: 2026-05-30
点検者: Claude（新セッション ＝ 第1案の作成者とは別の確認者）
点検方法: **読み取り専用**（grep / find / cat / Read のみ。ファイル変更・git操作・node実行は一切なし）
独立再確認: 別エージェント（Explore）が同じ主張をゼロから再検証 → 後述のとおり全項目で私の判定と一致

---

## 0. 結論（先に要点）

第1案の **方向性（dev側へ一本化し、段階ごとに検証ゲートを置く）は妥当**。§2の確定事実はおおむね正確で、実ファイルと一致しました。

ただし、**実行前に直すべき点が3つ**あります。これらを反映するまで実行段階（Stage 1以降）に進むべきではありません。

1. 【リスク表現の修正・重要】現状のdevは「カードページだけ静かに失敗」ではなく、**起動した瞬間にクラッシュして何も生成されない**状態。原因は `sharp`・`dotenv` 未導入。→ Stage 0-C は「念のため確認」ではなく **必須ブロッカー**。
2. 【設計の再検討・重要】devには既に **パンくず付きカードページを生成できる `generate_cards.js` が存在**する。OneDrive側の `post-processing.js` を移植して後からパンくずを足す（Stage 1→2）前に、「移植するのか／dev既存の生成器をPhase 3に繋ぐのか」を先に決める必要がある。
3. 【確定範囲の明示】dev内で確認できる事実と、OneDrive・タスクスケジューラ側でしか確認できない事実を分離。後者（日次18:00タスクの実体など）は**dev内からは確認不能**で、松岡さんの確認が必須。

---

## 1. 検証結果一覧（§2「確定事実」の照合）

凡例: ✅ 確認（実ファイルと一致） / ⚠️ 要修正・要補足 / ❓ dev内では確認不能（外部確認が必要）

| # | 第1案の主張 | 判定 | 根拠（ファイル:行） |
|---|------------|------|---------------------|
| 1 | 日次タスクが毎日18:00 JSTに**OneDrive側**バッチを実行・稼働中 | ❓ | dev内に証拠なし。タスクスケジューラ／OneDriveフォルダは本環境から見えない。**松岡さん確認必須** |
| 2 | OneDriveが `git-push.js` のGitHub API直pushで公開 | ✅(方式) | `git-push.js:16-18,40-52,132-134`（api.github.com / OWNER=kariumu / REPO=gcg-meta / BRANCH=main）。ローカル`git push`不使用。※「OneDrive側で」動いている点自体は❓ |
| 3 | OneDriveの日次カードページはミニマル版で `?set=` パンくず無し（本日EB01-001で確認） | ❓ | dev内に `cards/EB01-001` は**存在しない**。OneDrive側のページは本環境から見えない。**要外部確認** |
| 4 | post-processing.js / regenerate-article.js / create-card-pages.js は**dev側に存在しない** | ✅ | `find`で3本とも不検出（node_modules除く） |
| 5 | recognition-core.js は**dev側にも存在**（`scripts/shared/`） | ✅ | `scripts/shared/recognition-core.js` 実在 |
| 6 | dev直下 auto-news.js の Phase 3 は `require('./scripts/post-processing')` を try/catchで握りつぶす（行2479〜2491） | ✅ | `auto-news.js:2479` try開始 / `:2480` require / `:2487-2491` catchでログのみ・中断しない。行番号も一致 |
| 7 | devに auto-news.js が**2か所**（直下と homepage/） | ✅ | `auto-news.js`（直下 119,265B / 5-29）, `homepage/auto-news.js`（125,599B / 5-28） |
| 8 | dev package.json は依存が `cheerio` のみで sharp・dotenv 等が未宣言 | ✅ | `package.json` dependencies は `cheerio` のみ |
| 9 | devの確立ページ（GD04-001）はパンくず付きリッチ版 | ✅ | `cards/GD04-001/index.html` に `<nav class="breadcrumb">` と `cards.html?set=GD04` |
| 10 | 第2段階の修正はリッチ版生成器にのみ反映、日次ミニマル版（post-processing.js）には未反映 | ⚠️ | dev側では `generate_cards.js` がリッチ版（パンくつき）を生成。「ミニマル版生成器」はOneDrive側で**dev内に存在しない**ため、未反映かどうかはdev内では確認不能 |
| 11 | ディレクトリ構造差異（OneDrive=homepage/ ルート、dev=リポジトリ直下） | ✅ | dev直下に `cards/`・`index.html`。dev内 `homepage/` は `auto-news.js`・`data/`・`test-ocr-result.json` のみの**残置物**（scripts/・package.json・node_modules なし） |

### Stage 0 の各設問への回答（読み取り専用で判明した範囲）

- **Stage 0-A（dev .git は kariumu/gcg-meta・main追跡か）** → ✅ **はい**。`origin = https://github.com/kariumu/gcg-meta.git`、`main` が `origin/main` を追跡、`.git/HEAD = refs/heads/main`。
  - 補足: ただし公開は #2 のとおりGitHub API経由で、**ローカルgitの状態に依存しない**。dev .gitの追跡先は主に `git pull` 同期のためで、公開経路の判断材料としては副次的。
- **Stage 0-B（dev 2つの auto-news.js のどちらが正か）** → 部分判明。**直下が新（5-29、Phase 3あり・recognition-core import あり・TEST_MODEを環境変数制御）、homepage/が旧（5-28、Phase 3なし・TEST_MODEハードコード）**。ただし「日次タスクが実際にどちらを実行するか」はバッチ／スケジューラ設定（OneDrive側）依存で **dev内からは確認不能 → 松岡さん確認必須**。
- **Stage 0-C（sharp・dotenv 等の有無）** → ✅ 確認。**未導入**。`node_modules` に `sharp`=なし / `dotenv`=なし（`cheerio`=あり）。依存チェーン（auto-news.js → manual-card-news.js → recognition-core.js）全体で必要な外部npmは **最低 `sharp` と `dotenv`**。
- **Stage 0-E（git-push.js の公開方式）** → ✅ 確認。GitHub REST API直push（ローカルpushではない）。トークンは `GITHUB_TOKEN` 環境変数または `.env` から取得（`git-push.js:20-38`）。リポジトリ直下 `.env` にキー（`GITHUB_TOKEN` 他）は存在を確認済み（値は閲覧せず）。

---

## 2. 重要な指摘（実行可否に関わる）

### 指摘① リスク「静かな失敗」は表現を修正すべき（深刻度↑）

第1案 §7 は「post-processing.js 未移植のまま dev 実行 → Phase3が握りつぶされ**記事だけ出る**」としています。これは **依存（sharp・dotenv）が導入済みの状態を前提にした場合のみ正しい**説明です。

**現状のdevはそれ以前の段階**です。直下 auto-news.js は冒頭の `require('sharp')`（17行目）・`require('dotenv')`（20行目）を**トップレベル**で実行します。両モジュールは未導入なので、**起動直後に `Cannot find module 'sharp'` で落ち、記事もX投稿も生成されません**（Phase 3 まで到達しない）。

つまり挙動は2段階に分かれます（初心者向け説明）。

- 今の状態（sharp・dotenv なし）: **起動した瞬間に全部止まる**（何も作られない）。
- 依存だけ入れて post-processing.js は無いまま: **このとき初めて**第1案が言う「記事・X投稿は出るがカードページだけ静かに作られない」が起こる。

→ **対応**: Stage 0-C を「確認すれば良い項目」から **必須ブロッカー（未了なら起動不可）** に格上げ。さらに Stage 3 の dry-run の前に「**直下 auto-news.js が require を全て通過して起動できること**」を確認する最初のゲートを置くことを推奨。

### 指摘② devには既にパンくず生成器 `generate_cards.js` がある（Stage 1・2の前提を再検討）

第1案は「OneDriveの post-processing.js（ミニマル）を移植 → Stage 2でパンくずを追加」という流れです。しかし dev には既に **`generate_cards.js`** があり、

- `cards/<id>/index.html` を出力（`generate_cards.js:438`）
- `cards.html?set=` のパンくず（`<nav class="breadcrumb">`）を生成（`generate_cards.js:1097-1105` 付近）
- require は `fs`・`path`・`./shared/ntc-rank-consolidator` のみで、**sharp・dotenv 不要**＝単独で動く

実際、本日（5-30 04:18）生成された `cards/EB01-028/index.html` も `cards.html?set=EB01` パンくつき（＝dev側の既存生成器はリッチ版を出している）。

→ **可能性（要確定）**: 「OneDriveの post-processing.js を移植して後からパンくずを足す」必要はなく、**dev既存の `generate_cards.js` を Phase 3 に繋ぐ方が簡潔**かもしれません。ただし、`post-processing.js`（OneDrive側、未見）が **sharp を使う画像処理（カード画像の切り出し・webp化など）も担っている可能性**があり、その場合 `generate_cards.js`（画像処理なし）とは役割が異なり、単純置換はできません。
→ **対応**: Stage 0 に「**D-2: post-processing.js と generate_cards.js の機能差（特に画像処理の有無）を確定し、Phase 3 の結線先を決める**」を追加。これを決めずに Stage 1（移植）に入ると、不要な移植や二重実装になる恐れ。

### 指摘③ dev内で確認できない事実の明示（＝可能性として扱う）

以下は **dev内からは事実確認できませんでした**。第1案では確定事実として §2 に並んでいますが、根拠はdev外（タスクスケジューラ・OneDriveフォルダ）にあります。**松岡さんの確認が必須**です（現状は「可能性」扱いが妥当）。

- 日次18:00タスクがOneDrive側バッチを実行している、という稼働実体（#1）
- OneDrive側 EB01-001 がミニマル版・パンくず無し、という現物（#3）
- 「日次タスクが実行する auto-news.js」が直下／homepage/ のどちらか（Stage 0-B の最終確定）
- OneDriveローカルの `.git` が remote無しの残骸である、という点

---

## 3. 計画への具体的な修正提案（最小限）

1. **§7 の文言修正**: 「静かな失敗」の前に「**現状は依存未導入で起動時クラッシュ**」を明記し、2段階に分けて記述する（指摘①）。
2. **Stage 0-C を必須ブロッカーに格上げ**: 必要依存は最低 `sharp`・`dotenv`。移植する `post-processing.js` 次第で追加の可能性あり（その確定は下記D-2）。導入は松岡さん（`npm install`）。
3. **Stage 0 に「D-2」を追加**: `post-processing.js`（OneDrive）と `generate_cards.js`（dev既存）の機能差を確定し、Phase 3 の結線先（移植 or 既存流用）を決定（指摘②）。
4. **Stage 3 の前に起動ゲートを追加**: 「直下 auto-news.js が require を全通過して起動できる」ことを最初に確認（指摘①）。
5. **Stage 0-B の確定方法を具体化**: dev内コードからは「直下が新・Phase3あり」まで判明済み。残るは「タスク／バッチが実行する実パス」の特定で、これは松岡さんがバッチ・スケジューラ設定を提示することで確定。
6. **dev内 `homepage/` 残置物の扱いを明記**: 旧 `auto-news.js` 等が残っているため、移植・切替時に混同しないよう「dev Webルート＝リポジトリ直下、`homepage/` は使わない」を計画に明文化。

---

## 4. この文書自体の二次確認（独立再検証の結果）

作成者（私）とは別のエージェントが、上記の主要7主張を**結論を渡さずゼロから**再検証しました。結果は **全項目で私の判定と一致**（相違・反証なし）。独立確認者も次の3点を独自に重大指摘として挙げており、本レビューの指摘①②と整合します。

- 直下 auto-news.js は `sharp`/`dotenv` 未導入で起動不可（Phase 3 到達不可）
- `require('./scripts/post-processing')` は対象ファイル不在で必ず失敗 → catchで握りつぶし（実質無機能）
- `generate_cards.js` は単独動作可能なパンくず生成器で、役割が auto-news.js と分離している

---

## 5. 進行可否の判断

**現時点では実行段階（Stage 1以降）に進めません。** 理由は、(a) 指摘③の事実がdev内で未確定（外部確認待ち）、(b) 指摘②の設計分岐（移植 or 既存流用）が未決、のためです。Stage 0 を上記 1〜6 を反映した形で完了させ、本レビューを松岡さん（作成者・確認者とは別の最終確認）が承認してから、Stage 1 に進むことを推奨します。
