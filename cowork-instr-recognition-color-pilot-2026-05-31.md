# Cowork 指示書（事実反映版）— 新カード認識「色抽出」「コマンド＋パイロット」修正

作成: 2026-05-31 / 対象リポ: `C:\dev\gcg-meta`（dev = 正系）
状態: 一次調査（読み取り専用）完了。実装は未着手。本書は承認後に着手するための指示書。

---

## 0. 進め方・二重確認体制

- 編集先は **dev（`C:\dev\gcg-meta`）のみ**。OneDrive 版は退役済み。
- **一次（作業者）= Cowork**、**二次（確認者）= 松岡さん**（原因特定＋修正計画の段階で方針承認 → 実装 → 差分・一致率・回帰を Read で点検）。
- 手順は厳守: **読み取り専用で原因特定 → 計画提示 → 承認 → 最小修正 → 隔離検証**。いきなり書き換えない。
- sharp 依存のため、動作検証は **Windows ホスト**で `--dry-run`（Linux sandbox では sharp 不可）。

---

## 1. 確定事実（コードの所在・単一ソース）

| 項目 | 事実（ファイル:行） |
|---|---|
| 本番実行 | `run-auto-news-daily.bat` L13 `cd /d C:\dev\gcg-meta` → L22 `node auto-news.js --no-test-mode`（**X投稿ON**、毎日18:00 JST） |
| 色・解析ロジックの実体 | **`scripts/shared/recognition-core.js`**。root `auto-news.js` が L103 `require('./scripts/shared/recognition-core.js')` で取り込む（**単一ソース**） |
| 旧版（非実行・乖離） | `homepage/auto-news.js` は旧 OneDrive 版。L722 に**独自 `classifyColor` を保持**（root と約5531行差）。今回は触らない。将来削除推奨 |
| 色サンプリング箇所 | recognition-core.js L537 `COLOR_CROP = { left:550, top:130, width:40, height:50 }`（公式X画像1040x720 の**コスト丸アイコン**位置） |
| 色判定本体 | L541 `classifyColor(r,g,b)` / L570 `detectCardColor()`（`sharp.extract(COLOR_CROP).raw()` で平均RGB→classifyColor） |
| RGBログ | **`data/color-classification-log.jsonl`**（L606 で追記）。※指示書旧版の「card-recognition-log.json」は誤り |
| 色の格納形式 | preview では**英語**（White/Blue/Green/Red）。表示時に `COLOR_JP`（recognition-core L29）で日本語化 |

> **修正点はこの1ファイル（recognition-core.js）で足りる。** root auto-news.js は再エクスポートのみ。

---

## 2. 問題1：色抽出（White が Unknown になる）

### 2-1. 根本原因（確定）

`classifyColor` の白判定（recognition-core.js **L543**）:

```js
// 白: R,G,B全て180以上かつ差が30以内
if (r > 180 && g > 180 && b > 180 && Math.max(r,g,b) - Math.min(r,g,b) < 30) {
  return 'White';
}
```

- EB01-052（ヒルドルブ）のサンプル値 **RGB(180,181,181)** は、`r=180` が **`> 180` を満たさない**ため白にならない。緑/青/赤/紫はいずれも「特定チャンネルが優勢」を要求するが、ほぼ無彩色なので全て不成立 → **Unknown**。
- EB01-084 等の **RGB(197,193,192)** は全channel>180・差5<30 → White。
- 裏付け = `data/color-classification-log.jsonl` 実データ:
  - `{"rgb":{"r":197,"g":193,"b":192},"color":"White"}`
  - `{"rgb":{"r":180,"g":181,"b":181},"color":"Unknown"}`

**結論**: 白/銀枠はコスト丸で低彩度・中間調(~180)になり、**閾値 `>180` に余裕が無いため 180/181 の1差で結果が反転する「崖」**が主因。サンプリング箇所そのものは White(197,193,192) を正しく拾えており、第一の誤りは閾値側。

### 2-2. 最小修正案（承認後に実装。コードはまだ変えない）

**案1（推奨・最小）— 白の明度閾値を緩和**
recognition-core.js L543 を、`> 180` → `>= 175`（または `>= 178`）に変更し、無彩色ガード `(max-min)<30` は維持。

```js
// 変更案
if (r >= 175 && g >= 175 && b >= 175 && Math.max(r,g,b) - Math.min(r,g,b) < 30) {
  return 'White';
}
```

- 効果: RGB(180,181,181)=White、RGB(197,193,192)=White（維持）。
- 安全性: 緑/青/赤/紫は「優勢チャンネル＋彩度差」を要求するため、無彩色ガードに阻まれ巻き込みは起きにくい。
- **必須の回帰確認**: 既知の非白サンプル（preview の Blue 14 / Green 11 / Red 4 件）で、全channel≥175 かつ spread<30 に該当する誤White化が**0件**であることを確認してから採用。

**案2（補強・キャリブレーション前提）— ログに card_number を付与**
現状 `step1B_pixelColorDetection`（L615-628）は `detectCardColor(imageBuffer)` を **context 無し**（L620）で呼ぶため、`color-classification-log.jsonl` に **card_number/source が残らない**（RGB+color+timestamp のみ）。
→ 呼び出し側で `detectCardColor(buf, { card_number, source })` を渡す小改修を入れると「どのカードのRGBか」が紐づき、閾値校正の精度が上がる。`detectCardColor` 側は既に `...context` を保存する実装（L599-604）なので**呼び出しの引数追加のみ**。

**案3（任意・高コスト）— サンプリング箇所の変更**
COLOR_CROP をコスト丸からカード枠の高彩度部へ移す案。White の判別余裕は増えるが、現在正しく取れている全色での回帰検証コストが大きい。案1で解消するため**今回は非推奨／保留**。

---

## 3. 問題2：コマンド＋パイロット要素カード

### 3-1. 根本原因（確定）

`parseVisionBlocks`（recognition-core.js）:

- **AP/HP 抽出は UNIT / PILOT / BASE のみ分岐**（L456 / L464 / L472）。**COMMAND の分岐が無い** → COMMAND の `ap/hp` は **null のまま**（EB01-084 はこれで正常＝単純コマンド）。
- COMMAND のときだけ、パイロット欄ゾーン `{x1:550,y1:575,x2:835,y2:615}` のOCRテキストを **`result.link = '【パイロット】「…」'` という文字列**に格納（**L502-506**）。
- すなわち **構造化されたパイロット用フィールド（pilot の ap/hp/level/trait）は存在せず、すべて `link` 文字列に潰れている**。これが「データが不適切」の正体。

### 3-2. 前提事実

- **EB01-048 は現状 `cards_preview.json` に未登録**（grep 0件＝指示書の前提どおり）。
- よって期待値は **実カード（公式ソース）を正**として定義する（本書 §7 参照）。

### 3-3. データモデル選択肢（松岡さんと一緒に決定。実カード確認後）

| 案 | 内容 | 影響範囲 |
|---|---|---|
| **A**（最小） | COMMAND 維持。pilot は `link` 文字列のみ。OCRゾーン/整形だけ改善 | 最小（consumer 変更なし） |
| **B**（推奨候補） | COMMAND 維持＋`pilot:{ ap, hp, level, traits }` を**追加抽出**。COMMAND 用 AP/HP 分岐＋pilotゾーンの構造化 | 中（追加フィールド＝後方互換。記事で pilot 数値を出せる） |
| **C** | 複合型/フラグ（`has_pilot` / `card_type:"COMMAND/PILOT"` 等） | 大（記事生成・cards.html・summary・link判定 `matchesLinkCondition` に波及） |

→ **EB01-048 の実仕様（実際に pilot の数値/特徴があるか）を先に確定**してから A/B/C を選定。

---

## 4. 検証手順（隔離・安全策）

1. バックアップ: `data/cards_preview.json` を退避（再認識は上書きするため）。
2. 隔離出力: `NEWS_OUTPUT_ROOT=<一時>` ＋ `--dry-run --test-mode` で実行（**push/X投稿なし**）。本番 `.bat` は `--no-test-mode`（投稿ON）なので検証では使わない。
3. 問題1: EB01 紹介画像で `classifyColor`/`detectCardColor` を再実行し、`color-classification-log.jsonl` の RGB→色が正解（手動修正後の色）と一致するか。**特に EB01-052 が White** になること。既存の正答（EB01-084=White ほか）が壊れないこと。
4. 問題2: EB01-048（実仕様確定後）で抽出データに pilot 要素が（選定案に応じて）反映されること。単純コマンド（EB01-084 等）が従来どおり（回帰なし）。
5. 手動修正の保全: 再認識が `cards_preview.json` を上書きするため、既存の手動修正値を潰さない設計か確認。必要なら手当て。

---

## 5. 周辺の既知事実・注意

- **`cards_preview.json` の末尾切断（要・実機確認）**: mount 上では末尾が `"hp": ` で途切れ JSON 不正に見える（python `json.load` 失敗）。ただし CLAUDE.md 既知の「OneDrive sparse mount による**末尾切断の誤検出**」に合致するため、**Windows 実機で実ファイルを確認**。実機で本当に壊れていれば最優先修復、誤検出なら無視。
- **色の対応域**: `classifyColor` の出力は White/Green/Blue/Red/Purple/Unknown。preview の実色も White/Blue/Green/Red のみ（現状問題なし）。
- **二重管理**: `homepage/auto-news.js`（旧版）に独自 `classifyColor`（L722）が残存。本番非実行だが、将来の混乱源。整理は別タスク。

---

## 6. 受け入れ基準

- 問題1: 既知 EB01 色サンプルで色判定が正解一致（**EB01-052=White**、回帰0）。不一致カード一覧と一致率を自己検証レポートに記載。
- 問題2: EB01-048 の抽出に（選定案の表現で）コマンド＋パイロット要素が反映。単純コマンドは回帰なし。
- 変更は recognition-core.js の該当関数に限定・最小。色しきい値変更で他色を巻き込まない。

---

## 7. 未確定事項（要・事実確定）

### EB01-048 の実カード仕様 — 取得試行の結果（2026-05-31 時点・確定事実）

- **EB01-048 は未発売弾 EB01『Eternal Nexus』のカード**（公式の次期弾。Web検索では発売 2026-06-26 とされる）。
- 取得試行の結果:
  - 公式カード検索DB（`gundam-gcg.com/jp/cards/`）の収録弾リストは **GD01〜GD04 / ST01〜ST09 ＋ 限定・基本・プロモのみ**で、**EB01 は未収録**。
  - 公式カードページは **JavaScript 描画**のため raw fetch では検索フォームのみ返り、カード明細は取れない。
  - ローカル全データにも無し: `cards_master.json`(1216件) / `summary.json` / `card_colors.json` / `cards_preview.json` いずれも **EB01-048 = 0件**。
- 結論: **EB01-048 の実仕様は、公式スポイラー（@GUNDAM_GCG_JP の該当X投稿/画像）が公開されている場合のみ取得可能。** 公開前なら現時点では事実確定できない。
- 対応:
  - 松岡さんが EB01-048 のスポイラー（X投稿URL / 画像）をお持ちなら共有 → それを正として §3-3 の案を選定。
  - 無い場合でも、**問題2の一般機構（COMMAND のパイロット欄→`link` 文字列化, recognition-core.js L501-506）と案A/B/C は EB01-048 に非依存**で検討・実装可能。個別の受け入れ検証（§6）のみ公開後に実施。
  - **記憶からの推測でEB01-048の数値を埋めることは禁止**（事実主義）。
