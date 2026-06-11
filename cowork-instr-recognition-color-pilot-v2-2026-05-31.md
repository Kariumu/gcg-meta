# 指示書（新カード認識 精度向上）— 色抽出／コマンド＋パイロット抽出 ＜全行番号 実Read 訂正済・第2版＞

作成: 2026-05-31 / 対象リポ: `C:\dev\gcg-meta`（dev = ライブの正系）
本書 = 松岡さん（二次確認者）の改訂版指示書 ＋ Cowork（一次作業者）の**実コード Read による裏取り**。
状態: 読み取り調査・二重確認 完了。**実装は未着手**（承認後に着手）。

> **訂正履歴（事実主義の徹底・重要）**
> 本書の前版で Cowork が `fixRecognitionErrors` 等の**行番号と「`_manualOverride` 機構」を本体未読のまま推測で記載**する誤りがあり、その誤情報のまま一部承認が行われた。以下を実 Read で訂正：
> - `fixRecognitionErrors` の ap/hp 強制 null は **「COMMAND のみ」**（L777-780 と L811-814 の2箇所）。**PILOT は null 化されない**（2026-05-24 に除去済）。前版の「PILOT/COMMAND を null」「L686-698 / L413 / L438-444」は**誤り**。
> - **`_manualOverride` 機構は存在しない**（全 .js grep で0件）。`saveCardPreview` は無条件全上書き。前版の「既存 `_manualOverride` を使う」は**誤り（捏造）**。よって「EB01-052 に付与すれば恒久保全」は**今のコードでは効かない**（§4 で代替策）。
> - `buildCardBlockHtml` の AP/HP 表示は **UNIT/BASE/PILOT**（L1684）。非表示は COMMAND のみ。前版の「PILOT は空」は**誤り**。
> 二重確認（grep 検証）が**実装前に**捕捉。以後は実 Read 済の値のみ採用。

---

## 0. 前提・分担・編集先

- 編集先（ライブの正系）＝ `scripts/shared/recognition-core.js` と root `auto-news.js` のみ。スケジューラ（`run-auto-news-daily.bat` L13 `cd /d C:\dev\gcg-meta` → L22 `node auto-news.js --no-test-mode`、毎日18:00 JST、**X投稿ON**）は root を実行（→ recognition-core を require L103）。
- `homepage\auto-news.js` は**触らない**（recognition-core 非参照の退役コピー。同じバグを別実装で持つが本番非実行・root と約5531行差）。ここを直しても効かない。整理は別タスク。
- 二重確認：Cowork（実装＋自己検証）→ 松岡さん（Read で点検）。読み取り調査→原因/計画提示→合意後に最小実装の順。
- 検証は sharp 依存のため **Windows ホストで dry-run**（§1 で実証）。
- 既存の手動修正（EB01-052=White）を再認識で潰さない（§4。**現状コードに保護機構が無い**点が要注意）。

---

## 1. 精度向上の土台：回帰・精度計測ハーネスを最初に作る

測れないと改善も退行も見えない。まず客観計測の仕組みを用意する。

- 既取得 EB01/ST10 の画像（`images/news/<_articleDate>/<cn>.jpg`）を入力に、色（`detectCardColor`）と項目（`parseVisionBlocks` 経路）を回し、`cards_preview.json` の検証済み値を正解として、フィールド別（color/card_type/level/cost/ap/hp/link/traits）の一致率と不一致リストを出力。
- 「修正前→修正後」で比較し改善・回帰を数値化。本番 `cards_preview.json` は**上書きしない隔離実行**。出力は md/JSON レポート。

### ◎ 裏取り：ハーネス実行可能性（2026-05-31 実測）

| 確認項目 | 結果（事実） | 含意 |
|---|---|---|
| 入力画像 | `images/news/` に日付フォルダ多数、**EB01・ST10 の jpg が複数日付に実在**（例 2026-05-09＝EB01-009/044/063/078, ST10-006/012） | 素材は実在、card_number で正解色に突合可 |
| 正解色分布（preview, 実機 Read 値） | **White15 / Blue14 / Green11 / Red4** | 4色は回帰検証可能 |
| **⚠ Purple 正解 0件** | preview に Purple 無し | `classifyColor` は Purple 分岐を持つが**現データで検証不可**。別カードを用意しない限り検証対象外（巻き込み回帰のみ注意） |
| **sharp が sandbox 不可** | Linux sandbox で `require('sharp')` → FAIL（`linux-x64 runtime`） | **色ステップは sandbox で動かない**（松岡さん懸念どおり） |
| cards_preview 可読性 | **実機 Read = 完全な有効 JSON**（§4）。bash mount = 切断で `JSON.parse` 失敗 | **ホストで回せば**正解データは健全 |

### ハーネス実行方式 → **(a) Windows ホストで実行（松岡さん承認・確定）**
sharp・.env キー・健全な cards_preview が揃う。
（参考：(b) sandbox に linux-x64 sharp 導入 / (c) jpeg-js 等で sharp 非依存に再実装、は今回不採用。）
補足：`parseVisionBlocks` は sharp 不要だが、生 OCR が保存されていない（`card-recognition-log.json` はパース済みのみ）ため、パース精度計測には画像の**再 OCR**が要る（Vision 無料枠内）。色とは独立。

---

## 2. 問題1：色抽出の精度向上（根因＝しきい値、副因＝サンプリング箇所）

### 確定事実（実 Read）

- 白判定 `recognition-core.js` **L543**：`r > 180 && g > 180 && b > 180 && Math.max-Math.min < 30`。**コメントは「180以上」だが実装は厳密 `> 180`＝不一致**。
- 実ログ `data/color-classification-log.jsonl`：`RGB(180,181,181)→Unknown`（r=180 が `>180` 偽で White 不成立、他色も優勢チャンネル条件を満たさず不成立）、`RGB(197,193,192)→White`。
- サンプリング＝ `COLOR_CROP = {left:550, top:130, width:40, height:50}`（**L537**、コスト丸アイコン）の平均RGB。White カードはここで低彩度グレー（180〜197）に出て境界的。

### 方針
1. **しきい値是正**：コメント意図に合わせ `>=180`（または `>=175`）。単独の閾値いじりは脆いので、HSV 分類（低彩度＋高明度→White、彩度あり→色相）への置換も比較検討。
2. **サンプリング箇所の頑健化**：既知色データで「サンプル色→正解色」の一致率を最大化する座標/領域を探索（固定相対座標・複数領域の投票等）。`color-classification-log.jsonl` も入力に。
3. §1 ハーネスで全既知カードの色一致率を測り最大化。
4. （補強）`step1B_pixelColorDetection`（**L615-628**）は `detectCardColor(imageBuffer)` を**context 無し**（L620）で呼ぶため、ログに card_number が残らない。`{card_number, source}` を渡せば校正精度向上（`detectCardColor` は既に `...context` 保存実装 L599-606）。

### 受け入れ基準
- 既知 EB01/ST10 の色：Unknown=0・誤判定=0（特に **EB01-052=White**）。
- 現在正しいカード（EB01-084=White、各 Blue/Green/Red）に回帰なし。
- 一致率（前→後）＋不一致一覧をレポート。Purple は現データで未検証（巻き込み注意）。

---

## 3. 問題2：コマンド＋パイロット要素カードの抽出（修正は複数箇所に跨る）

### 確定事実（全行番号 実 Read 済）

1. **`recognition-core.js` `parseVisionBlocks`**：AP/HP は **UNIT/PILOT/BASE のみ分岐**（L456/L464/L472）、**COMMAND 分岐なし**（ap/hp=null のまま）。COMMAND のパイロット情報は `result.link = '【パイロット】「…」'` の**文字列に詰めるだけ**で、構造化 pilot フィールドは無い（**L502-506**）。

2. **root `auto-news.js` `fixRecognitionErrors`（定義 L667、実行経路 L1349・L2216）**：COMMAND の ap/hp を**強制 null**（**2箇所**）。
   - **L777-780**：`if (result.card_type === 'COMMAND') { result.ap = null; result.hp = null; }`
   - **L811-814**：master 上書きブロック内。L804-805 で master の ap/hp を採用した直後に、COMMAND なら再び null。
   - **PILOT は null 化されない**（L771-776 コメント：2026-05-24 に PILOT 強制 null を除去、補正AP/HP を保持）。
   - → **`parseVisionBlocks` を直しても、COMMAND はこの2箇所のトップレベル ap/hp で消える。修正は parseVisionBlocks と fixRecognitionErrors の両方が必要。**

3. **表示 `buildCardBlockHtml`（定義 L1658）**：AP/HP 行は **UNIT/BASE/PILOT で表示**（**L1684**、PILOT は「補正 AP/補正 HP」ラベル L1685-1686）、**COMMAND のみ非表示**。

4. **保存 `saveCardPreview`（root 定義 L832-863。recognition-core には無い）**：`loadCardsPreview()` で全件読み込み（L834）→ 列挙フィールドを組み立て（L836-858）→ **`writeFileSync` で全上書き**（L860）。**手動保護のロジックは無い**。永続化されるキーは固定：card_number/name/color/type/level/cost/ap/hp/terrain/traits/link/rarity/effect/source_url/created_at/preview/_pendingReview/_pendingReviewIssues/_articleDate（**列挙外のフィールドは保存時に消える**）。

5. **統合 `buildUnifiedCardDB`（recognition-core L741）**：cards_master＋cards_preview を統合。pilot 新フィールド対応はここにも要。

> **設計示唆（事実ベース）**：COMMAND のトップレベル `ap`/`hp` は L777-780・L811-814 で必ず null 化される。よって二要素カードの数値を**トップレベル ap/hp にフラット格納すると必ず衝突**。**`pilot:{ap,hp,level,traits}` サブ構造（案B）が構造的に整合**（null 化対象のトップレベルを触らず保持できる）。→ 松岡さん **案B 選択（確定）**。最終フィールド確定は EB01-048 実物で検証。

### 方針（多点・最小限）— 案B 前提
1. `recognition-core.js` `parseVisionBlocks`（L502-506）に COMMAND のパイロット要素抽出を追加し、`pilot:{ap,hp,level,traits}` に格納（既存 link/trait ゾーンと非衝突にゾーン整理）。
2. root `fixRecognitionErrors`：COMMAND の**トップレベル** ap/hp は現状維持（null）でよいが、**`pilot.*` を消さない**ことを保証（L777-780・L811-814 は pilot サブ構造に触れないため衝突しない。要・実装時に確認）。
3. 表示 `buildCardBlockHtml`：COMMAND かつ `pilot` がある場合に pilot 値を表示する分岐を追加（L1684 付近）。
4. 保存 `saveCardPreview`：永続化キー列挙（L836-858）に **`pilot` を追加**（追加しないと保存時に消える）。
5. 統合 `buildUnifiedCardDB`（recognition-core L741）も `pilot` を通す。
6. 期待値：**EB01-048 の実カード（紹介画像/source_url）を正**として定義（§7）。

### 受け入れ基準
- EB01-048 の抽出にコマンド情報＋パイロット要素（実カード記載の ap/hp/level/trait 等）が両方入り、記事表示に反映。
- 単純コマンド（EB01-078/084/ST10-014）は従来どおり（回帰なし）。

---

## 4. 手動修正の保全・検証 ＜要・再決定＞

### ◎ 重大訂正：`_manualOverride` 機構は存在しない
- 全 .js を grep して **0件**。`saveCardPreview` は固定キーを**無条件で全上書き**（L860）。前版の「`_manualOverride` を付与すれば恒久保全」は**誤りで、今のコードでは効かない**（読む側が無く、付与しても列挙外フィールドとして保存時に消える）。
- かつ **EB01-052 は cards_master に未登録**のため、master 上書き経路（L792-816、L796 で color を master 採用）でも**復元されない**。
- 結論：**現状、再認識を本番保存まで走らせると EB01-052 の手動 White は失われる**（`color-classification-log` の実値どおり、現行 classifyColor は EB01-052 を Unknown と判定 → §1ハーネスで色を直すまでは特に危険）。

### 手動値を守る実際の選択肢（実装前に決定）
- **(i) 隔離検証（保存しない）**：バックアップ＋別ファイル/ドライランで検証。本番 `cards_preview.json` に触れない。**当面の安全策**。コード変更不要。
- **(ii) 保護機構を新規実装（恒久・コード変更）**：`saveCardPreview` に「既存エントリの手動指定フィールドを残す」ロジックを追加（例：エントリに `_manualOverride:["color"]` を持たせ、保存時に既存値をマージ＋**永続化キー列挙に `_manualOverride` を追加**）。松岡さんが望む「恒久」はこれに当たるが、**新規コードのため設計＋承認が必要**（実装フェーズで実施）。
- (iii) EB01-052 を cards_master に White で登録：master 上書きで color 復元できるが、**未発売カードを master に入れる**ことになり master の意味が変わる（基本的に非推奨）。

→ **当面 (i) で検証**。恒久保全が必要なら (ii) を実装フェーズで設計・承認。前版で私が勝手に付与した `_manualOverride` フィールドは**差し戻し済**（機能しないため）。

### 検証手順
- Windows ホストで dry-run（sharp）。§1 ハーネス＋ EB01-048 実カードで確認。
- **`loadCardsPreview` の catch→`{}`（recognition-core L729-735）に注意**：cards_preview が読めない状態で `saveCardPreview` が走ると**他の全 preview を巻き込んで消す**。検証では健全なファイルを掴ませる（ホスト実行）。
- Cowork が自己検証レポート（色一致率の前後・EB01-048 抽出・回帰確認）を提出 → 松岡さんが点検（変更が該当箇所限定か、ハーネス結果の妥当性、回帰なし、homepage を触っていないか）。

### ◎ cards_preview.json の「末尾切断」= マウント由来の誤検出（松岡さんの見立て＝確定）
- **実機 Read では完全な有効 JSON**：最後のエントリ EB01-052 が hp:2・traits・link・effect・source_url まで揃い **L1006-1007 の `}` `}` で正しく閉じる**。
- **bash（Linux sandbox mount）でのみ** L992 `"hp": ` 手前で切断＝`JSON.parse` 失敗。CLAUDE.md 既知の「OneDrive sparse mount による末尾切断の誤検出」に合致。**実体は健全**。前版の「両経路で切断」は誤りで訂正。

---

## 5. 注意
- 変更は `recognition-core.js` / root `auto-news.js` のみ・最小限。**homepage は触らない**。
- 色しきい値変更で他色を巻き込まない（4色＋無色の分離維持。Purple は現データ未検証）。
- 問題2のデータモデル（案B）でも、保存（L836-858）・表示（L1684）・統合（L741）への波及があるため、各箇所の最小対応を実装時に確認。

---

## 6. claim 4 closure（単一ソースの確認）
- root `auto-news.js` は色・解析の中核を `require('./scripts/shared/recognition-core.js')`（L103）で取り込む（`classifyColor` L76・`detectCardColor` L77・`parseVisionBlocks` L78・`buildUnifiedCardDB` L89 等）＝ライブ経路の単一ソース＝`recognition-core.js`。
- **ただし `fixRecognitionErrors`（L667）・`saveCardPreview`（L832）・`buildCardBlockHtml`（L1658）は root に残置**（recognition-core 未移管）。問題2の修正がこの3つ＋recognition-core に跨るのはこのため。
- `homepage\auto-news.js` は recognition-core 非参照の退役コピー（独自 `classifyColor` L722・独自 `fixRecognitionErrors` L981 等、root と約5531行差）。**本番非実行・今回対象外**。

---

## 7. 対象カードの実仕様 — コマンドパイロット3枚（2026-05-31 実画像確認済）

> 当初の例示「EB01-048」は松岡さん訂正により **EB01-084 ほか**。対象は GCG の正式機構「**コマンドパイロット**」＝1枚で COMMAND と PILOT の二面を持つカード（公式 総合ルール Ver.1.6.0／Q&A で規定。セット中は PILOT、それ以外は COMMAND として扱う。プレイ時にコマンド効果発動 or ユニットへパイロットセットを選択。パイロット帯に補正AP/HP と特徴・パイロット名を表記）。

### 7-1. カード上のパイロット情報の位置（EB01-084 で実測。1040×720 紹介画像・カードは右側）
- **下部パイロット帯（暗バー）**：縦走査で **y≈578–660** が連続して暗色（RGB平均<90）と確認。
  - パイロット名：帯の上段（例 デメジエール・ソンネン）
  - 特徴：帯の下段（例 〔ジージェネ〕〔攻撃型〕）
  - **補正 +AP/+HP：帯の右側 x≈828–935**（例 +1 +1）
- **二面の判別**：左端の縦ラベル `COMMAND` に加え、**右端の縦ラベル `PILOT`** が併記。両方の存在（またはパイロット帯の存在）で「コマンドパイロット」と判定可能。
- 既存コードの取りこぼし：`parseVisionBlocks`（L502-506）は COMMAND 時に**名前ゾーン {550,575→835,615} だけ**を読み `link` 文字列化。**+AP/+HP（x>835）・特徴・二面判定は未取得**。さらに `fixRecognitionErrors`（L777-780/811-814）が ap/hp を null 化。

### 7-2. ハーネス／受け入れの正解値（カード画像から直接確認）
| card_number | color | type | Lv/COST | pilot名 | pilot特徴 | +AP/+HP | 備考 |
|---|---|---|---|---|---|---|---|
| ST10-015 拡散ビーム砲 | Red | COMMAND＋PILOT | 3/1 | クレア・ヒースロー | 〔ジージェネ〕〔耐久型〕 | +1/+0 | preview に COMMAND で登録済・pilot欠落 |
| EB01-076 ガーベラ・ストレート | Blue | COMMAND＋PILOT | 4/1 | ロウ・ギュール | 〔ジージェネ〕〔耐久型〕 | +1/+1 | **preview 未登録（0件）** |
| EB01-084 30cm砲(APFSDS弾) | White | COMMAND＋PILOT | 4/1 | デメジエール・ソンネン | 〔ジージェネ〕〔攻撃型〕 | +1/+1 | preview に COMMAND で登録済・pilot欠落 |

### 7-3. 認識の実装方針（案B＝pilot サブ構造）
1. **二面判定**：`parseVisionBlocks` で右端 `PILOT` 縦ラベル（または下部パイロット帯）を検出し、COMMAND かつ pilot 面ありをマーク。
2. **パイロット帯の構造化抽出**：name / traits / 補正AP / 補正HP を読み、`pilot:{ name, traits, ap, hp }` に格納（**トップレベル ap/hp は COMMAND の null のまま**＝L777-780 と非衝突）。+AP/+HP は帯右側 x≈828–935 を新ゾーンとして読む（既存 apHpPilot{835,505,920,545} は PILOT単体カード用で y が異なるため流用不可）。
3. **保持の貫通**：`fixRecognitionErrors`（pilot.* を消さない）／`saveCardPreview`（L836-858 のキー列挙に `pilot` 追加。**追加しないと保存時に消える**）／`buildUnifiedCardDB`（L741）／`buildCardBlockHtml`（L1684 付近で COMMAND 時も pilot を表示）。
4. 色（問題1）は §2 のしきい値是正と同時に。EB01-084 実測 `COLOR_CROP→RGB(172,178,184)→Unknown`（白枠が低彩度グレー）で崖を再現。

---

## 8. 決定事項と次のアクション

### 決定済み（松岡さん承認 2026-05-31）
1. **データモデル＝案B（pilot サブ構造）**。COMMAND のトップレベル ap/hp 強制 null（L777-780・L811-814）と非衝突。最終フィールドは EB01-048 実物で検証。
2. **ハーネス実行方式＝(a) Windows ホスト実行**。
3. **EB01-052 の手動値保全**：前版で承認された「`_manualOverride` 付与」は**機構が存在せず無効と判明**（§4）。→ **再決定が必要**：当面 (i) 隔離検証、恒久が必要なら (ii) `saveCardPreview` に保護機構を新規実装（設計＋承認）。

### 次のアクション
1. **EB01-048 画像受領 → 実仕様読取**（card_type / pilot 要素の有無 / ap・hp・level・traits / 効果 / 色）。読めない項目は推測せず「不明」と明記。
2. 実仕様に基づき **案B の pilot フィールド定義を確定 → 松岡さん承認**。
3. **手動保全方式 (i)/(ii) を決定**。
4. 承認後、Cowork が **§1 ハーネス作成（ホスト）→ 問題1 しきい値是正 → 問題2 多点修正（parseVisionBlocks / fixRecognitionErrors / buildCardBlockHtml / saveCardPreview / buildUnifiedCardDB）** の順で最小実装。各段で自己検証レポート → 松岡さん点検。
