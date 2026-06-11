# コマンドパイロット認識 — 案B実装差分【修正版v2】＋White閾値是正（ホスト確定用）

作成: 2026-06-01 / 対象リポ: `C:\dev\gcg-meta`（dev=正系）
進め方: Cowork（一次）が差分作成・PIL同等検証 → 松岡さん（二次）がホストで dry-run 確定＋点検。
**v2 の変更点**: 松岡さん点検を反映し、C-2 の「COMMAND traits 一律 null 化」を **hasPilotFace 分岐**に修正（ST10-014 回帰を解消）。判定を **PILOT 縦ラベル主体**に強化（C-0 新設）。白閾値は **`>=180`** 採用。

---

## A. 検証で確定した事実

### A-1. White閾値（問題1）
- `classifyColor`（recognition-core.js **L543**）は `r>180 && g>180 && b>180 && (max-min)<30`。コメント「180以上」と不一致（厳密 `>180`）。
- 実ログ `color-classification-log.jsonl`：`RGB(197,193,192)→White` / `RGB(180,181,181)→Unknown`。
- EB01-084 実ファイル COLOR_CROP 実測 = **RGB(197,193,191)**：旧White / 新(>=180)White（回帰なし）。
- EB01-052（手動White）= RGB(180,181,181)：**旧Unknown → 新(>=180)White**（是正効果。min=180 を救うのに必要十分）。
- **採用＝`>180`→`>=180`**（松岡さん推奨。コメント「180以上」と一致・最小変更。178 は179/178灰色も White 化し誤検出余地が増えるため不採用）。
- **巻き込み未検証**：preview に Purple 0件、リポ画像も少数。→ ホスト dry-run で**全色サンプルの非White→White化0件**を要確認。

### A-2. コマンドパイロットのレイアウト（問題2）
- 3枚（ST10-015 / EB01-076 / EB01-084）とも **左端 COMMAND ／ 右端 PILOT の縦ラベル＋最下部パイロット帯** の同一テンプレート（目視確認）。フレーム色のみ差（ST10=黒灰, EB01=青）。
- EB01-084 実ピクセルで確定したゾーン（1040×720 空間）：名前帯 y≈560–600 / 特徴帯 y≈602–628 / 補正+AP/+HP x≈828–935,y≈575–662 / 右端 PILOT 縦ラベル x≈950–1000。
- **未確定**：ST10-015/EB01-076 のピクセル座標（ファイルが sandbox 未到達）。ホスト dry-run で同座標成立を確認、破綻時は弾別ゾーン分岐。

### A-3. 現行コードの取りこぼし（実Read確定）
- `flattenWords`（L202-216）：word は `{text, left, right, top, ...}`。`cardWords` フィルタ L296 = `w.left>=480 || w.right>=520`。→ **cmdPilotLabel（x≈950-1000）は left≥480 を満たし落ちない**（松岡さん指摘①の確認結果）。
- card_type は L323 で**左端縦ラベルを zoneText で読めている**実績（同方式で右端 PILOT も可。指摘②）。
- traits 抽出は **L437-453（ステップ9）**、COMMAND は `traitZone=CARD_ZONES.link`(y615-645)。pilot 処理は **L501-507（ステップ11）**で `link='【パイロット】「…」'` 文字列化のみ。**link(y615-645) と cmdPilotTraits(y602-628) はゾーン重複**するため、hasPilotFace で排他必須（指摘③）。
- `fixRecognitionErrors`（auto-news.js L777-780, L811-814）：COMMAND の ap/hp を null 化（pilot サブ構造には非干渉）。
- `saveCardPreview`（auto-news.js L836-858）：固定キーのみ（pilot 未対応＝要追加）。
- `buildUnifiedCardDB`（recognition-core.js L741-781）：pilot 未伝播（要追加）。
- `buildCardBlockHtml`（auto-news.js L1684）：AP/HP 表示は UNIT/BASE/PILOT のみ（COMMAND pilot 表示要追加）。

---

## B. 確定データモデル（松岡さん合意）

```jsonc
{
  "card_type": "COMMAND",
  "level": 4, "cost": 1, "color": "White",
  "ap": null, "hp": null,          // コマンド本体は AP/HP を持たない（維持）
  "traits": [],                    // ★コマンドパイロットでは空（下帯特徴は pilot 側）
  "effect": "...",
  "pilot": {                       // ★追加：パイロット面（純コマンドには付けない）
    "name": "デメジエール・ソンネン",
    "traits": ["〔ジージェネ〕","〔攻撃型〕"],
    "ap": 1, "hp": 1               // 券面 "+N/+N" の +N 値。Lv は持たせない
  }
}
```

### 受け入れ正解表
**コマンドパイロット（pilot あり・command.traits 空）**
| card | color | pilot.name | pilot.traits | pilot.ap/hp |
|---|---|---|---|---|
| ST10-015 拡散ビーム砲 | Red | クレア・ヒースロー | 〔ジージェネ〕〔耐久型〕 | 1 / 0 |
| EB01-076 ガーベラ・ストレート | Blue | ロウ・ギュール | 〔ジージェネ〕〔耐久型〕 | 1 / 1 |
| EB01-084 30cm砲(APFSDS弾) | White | デメジエール・ソンネン | 〔ジージェネ〕〔攻撃型〕 | 1 / 1 |

**純コマンド（pilot なし・traits 従来どおり＝回帰チェック）**
| card | traits 維持値 |
|---|---|
| ST10-014 開発経路図の解放 | `["〔ジージェネ〕"]` ← 一律null化なら壊れる箇所 |
| EB01-078 プレミアムガシャ | `[]` |
| EB01-075 強敵襲来 | `[]` |
| ST10-013 戦術訓練 | `[]` |

---

## C. 実装差分（最小・該当関数限定）

### C-1. recognition-core.js — CARD_ZONES に pilot 帯ゾーン追加（L286 traitsPilot の後）
```js
  traitsPilot: { x1: 550, y1: 530, x2: 835, y2: 555 },
  // ▼追加（コマンドパイロット下部帯。EB01-084実測・ST10/EB01の共通性はホスト確定）
  cmdPilotName:   { x1: 600, y1: 560, x2: 830, y2: 600 },
  cmdPilotTraits: { x1: 600, y1: 602, x2: 830, y2: 628 },
  cmdPilotApHp:   { x1: 828, y1: 575, x2: 935, y2: 662 },
  cmdPilotLabel:  { x1: 950, y1: 560, x2: 1000, y2: 660 }, // 右端PILOT縦ラベル
```

### ★C-0（最重要）. recognition-core.js — hasPilotFace を card_type 確定直後に算出（L325 直後）
```js
  // === コマンドパイロット二面判定 ===（traits抽出 L437 より前で確定させる）
  // 主: 右端 PILOT 縦ラベル / 補強: 下帯の "+N…+N"。名前ゾーン有無は使わない（誤検出回避）。
  let hasPilotFace = false;
  if (result.card_type === 'COMMAND') {
    const labelText = zoneText(cardWords, CARD_ZONES.cmdPilotLabel).replace(/\s/g, '');
    const apHpProbe = zoneText(cardWords, CARD_ZONES.cmdPilotApHp);
    hasPilotFace = /PILOT/i.test(labelText) || /\+\s*\d+.*\+\s*\d+/.test(apHpProbe);
  }
```

### C-2（修正版）. recognition-core.js — traits を hasPilotFace で分岐（L437-453）
```js
  let traitZone;
  if (result.card_type === 'PILOT') traitZone = CARD_ZONES.traitsPilot;
  else if (result.card_type === 'COMMAND') {
    // 純コマンド: 従来どおり link ゾーンから自身の所属特徴を抽出
    // コマンドパイロット: 下帯特徴は pilot.traits 側 → command.traits は空に
    traitZone = hasPilotFace ? null : CARD_ZONES.link;
  }
  else if (result.card_type === 'BASE') traitZone = CARD_ZONES.traits;
  else traitZone = CARD_ZONES.traits;

  if (traitZone) {                              // ← 既存 L442-453 をこのガードで包む
    const traitZoneWords = wordsInZone(cardWords, traitZone);
    if (traitZoneWords.length === 0) {
      traitZoneWords.push(...wordsInZone(cardWords, CARD_ZONES.traits));
    }
    traitZoneWords.sort((a, b) => a.left - b.left);
    const traitText = traitZoneWords.map(w => w.text).join('');
    const traitMatches = traitText.match(/[〔(]([^〕)]+)[〕)]/g);
    if (traitMatches) {
      result.traits = [...new Set(traitMatches.map(m => m.replace(/^\((.+)\)$/, '〔$1〕')))];
    }
  }
  // traitZone===null（コマンドパイロット）は result.traits=[] のまま
```
> ST10-014（hasPilotFace=false）→ `〔ジージェネ〕` 維持／ST10-015（=true）→ command.traits 空、が両立。

### C-3（修正版）. recognition-core.js — COMMAND パイロット面の構造化（L501-507 を置換）
```js
  // COMMANDカード: コマンドパイロットなら下部パイロット帯を pilot サブ構造へ
  if (result.card_type === 'COMMAND' && hasPilotFace) {
    const pilot = { name: null, traits: [], ap: null, hp: null };
    const nameText = zoneTextSpaced(cardWords, CARD_ZONES.cmdPilotName);
    if (nameText) pilot.name = nameText.split('\n')[0].replace(/[「」]/g, '').trim() || null;
    const ptWords = wordsInZone(cardWords, CARD_ZONES.cmdPilotTraits).sort((a, b) => a.left - b.left);
    const ptText = ptWords.map(w => w.text).join('');
    const ptM = ptText.match(/[〔(]([^〕)]+)[〕)]/g);
    if (ptM) pilot.traits = [...new Set(ptM.map(m => m.replace(/^\((.+)\)$/, '〔$1〕')))];
    const apHpText = zoneText(cardWords, CARD_ZONES.cmdPilotApHp);
    const plusM = apHpText.match(/\+?(\d+).*?\+?(\d+)/);
    if (plusM) { pilot.ap = parseInt(plusM[1]); pilot.hp = parseInt(plusM[2]); }
    result.pilot = pilot;
  }
  // 旧 link 文字列詰め（'【パイロット】「…」'）は廃止。COMMAND の link は空のまま。
```
> ST10-015 は pilot.traits が**〔ジージェネ〕〔耐久型〕の2つ**揃う（現 command.traits の耐久型取りこぼしを改善）、ap/hp=**1/0**（hp=0 を `0` として保持）を確認。

### C-4. auto-news.js — fixRecognitionErrors（L777-780, L811-814）
既存の COMMAND `ap=null;hp=null;` は**そのまま維持**（トップレベルのみ、pilot 非干渉＝衝突なし）。master 上書きブロックで master に pilot があれば優先採用する場合のみ `if (masterCard.pilot) result.pilot = masterCard.pilot;` を L807 付近に追加（未発売は master 不在で当面 no-op）。

### C-5. auto-news.js — saveCardPreview に pilot 保存（L857 `_articleDate` 行の後）
```js
    _articleDate: cardInfo._articleDate || null,
    ...(cardInfo.pilot ? { pilot: cardInfo.pilot } : {})   // ▼追加（無ければ出力されない）
```

### C-6. recognition-core.js — buildUnifiedCardDB に pilot 伝播（L747-759 preview側 / L764-777 master側）
各オブジェクトに `pilot: p.pilot || null`（preview側）/ `pilot: m.pilot || null`（master側）を1行追加。

### C-7. auto-news.js — buildCardBlockHtml に pilot 表示（L1689 `if (traitsStr)` の前）
```js
  if (card.pilot) {
    const p = card.pilot;
    const ptr = (p.traits || []).join('、');
    html += `        <tr><td class="news-card-stat-label">パイロット</td><td colspan="3">${escapeHtml(p.name || '')}（補正 AP+${p.ap ?? '?'} / HP+${p.hp ?? '?'}）${ptr ? '　' + escapeHtml(ptr) : ''}</td></tr>\n`;
  }
```
> クラス名 `news-card-stat-label` は root（class版 L1677-1694）に準拠。homepage（inline版）と取り違えないこと。

### C-8. recognition-core.js — classifyColor 白閾値是正（L543）
```js
  // 変更前: if (r > 180 && g > 180 && b > 180 && Math.max(r,g,b)-Math.min(r,g,b) < 30)
  // 変更後: コメント「180以上」と一致させ >= に
  if (r >= 180 && g >= 180 && b >= 180 && Math.max(r, g, b) - Math.min(r, g, b) < 30) {
    return 'White';
  }
```

---

## D. ホストでの確定・検証手順（松岡さん）

> sharp と .env が揃う Windows ホストで実施。本番 cards_preview.json はバックアップして上書きさせない。

1. **画像保存**：ST10-015 / EB01-076 を `C:\dev\gcg-meta\images\news\2026-05-31\` に保存（EB01-084.jpg は既存）。
2. **ゾーン座標のピクセル確認**：3枚で cmdPilotName/Traits/ApHp/Label が正解表を返すか。ずれれば座標微調整 or 弾別分岐。**特に右端 PILOT 縦ラベルが zoneText で "PILOT" と読めるか**（読めない場合は hasPlus 補強で救えるか）。
3. **White閾値の巻き込み確認**：色既知 preview 全色（White/Blue/Green/Red）で `>=180` 適用時に非White→White化が**0件**。
4. **dry-run**：`NEWS_OUTPUT_ROOT=<一時> node auto-news.js --dry-run --test-mode`（push/X なし）で：
   - コマンドパイロット3枚＝正解表どおり（command.traits 空＋pilot 完全、ST10-015 は traits 2つ・ap/hp=1/0）。
   - 純コマンド4枚＝**回帰なし**（ST10-014→`["〔ジージェネ〕"]`/pilot なし、他3枚→`[]`/pilot なし）。
5. 結果（座標OK/要調整・全色一致率・回帰・3枚pilot）を Cowork に共有 → 差分確定。

---

## E. 未確定・リスク
- ST10-015/EB01-076 のピクセル座標（ホスト確定）。ST10(黒灰)とEB01(青)でずれる場合は CARD_ZONES を弾別テーブル化。
- White `>=180` は Purple 不在のため Purple 巻き込み未検証。Purple カード入手後に再確認。
- `+AP/+HP` OCR：低コントラスト帯で Vision が誤読し得る。正規表現 `+?` で吸収済だが実OCRをホストで確認。
- 縦ラベル "PILOT" の OCR 読取：Vision が縦書きをどう返すかに依存。読めなければ hasPlus 補強が主判定になる（その妥当性もホストで確認）。

---

## F. 点検サマリ（松岡さん指摘の反映状況）
- C-2 一律null化の ST10-014 回帰 → **hasPilotFace 分岐に修正（C-0新設＋C-2改）**。
- C-3 hasPilotFace を名前ゾーン依存 → **PILOT 縦ラベル主体＋"+N+N"補強に強化**。
- 白閾値 → **`>=180` 採用**（178不採用）。
- cardWords フィルタ／縦ラベル結合／ゾーン排他（指摘①②③）→ **A-3 で確認済み・C-0/C-2 に反映**。
- 変更は recognition-core.js / root auto-news.js のみ・該当箇所限定、homepage 不変。
