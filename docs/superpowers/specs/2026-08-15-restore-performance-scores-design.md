# 演奏スコアの復帰 — 設計

- 日付: 2026-08-15
- 対象: `worker/ledgerlines_worker/`（metrics / align / confidence / preprocess）、`worker/worker_main.py`、`src/lib/real-history.ts`、`/progress` `/coach` `/share`
- 関連: `docs/poc/m4-report.md` 5章、`docs/spec/metrics.md` 3.1/3.2/7.2、`docs/design/analysis-pipeline.md` 6.4/7.1

## 1. 目的

Issue #8 のフェイルクローズ（commit `5361cbf` / `c444c8f`）以降、`overallScore` と
`pitch` / `rhythm` / `dynamics` / `pedal` が常に判定保留になっている。これを、指標ごとに
測定された頑健性に基づいて再び採点できる状態に戻す。

## 2. 現状の問題

### 2.1 フェイルクローズが指標ごとの差を無視している

`confidence.py:262` は `result["overallScore"] = None` を無条件に実行し、`pitch` /
`rhythm` / `dynamics` / `pedal` を一律 `withheld` にする。較正 artifact を配備しても
`overallScore` を数値に戻すコードパスは存在しない（artifact が影響するのは `tempo` のみ）。

一方 `m4-report.md` 5章は、同一演奏を録音条件だけ変えて測った結果を指標別に記録している
（clean を基準にした差）。

| 指標 | clean | room | phone | phone_agc |
|---|---|---|---|---|
| tempo | 92.4 | -2.7 | -1.9 | -3.2 |
| pedal | 94.9 | -4.5 | -5.0 | -13.5 |
| dynamics | 91.2 | -5.7 | -9.0 | -45.1 |
| rhythm | 87.0 | -11.8 | -6.6 | -14.7 |
| pitch | 85.2 | -37.7 | -37.6 | -50.0 |

問題は pitch にほぼ集約されており、`dynamics` の崩壊は AGC 条件に限定される。一律保留は
この測定結果を捨てている。

### 2.2 pitch 式が採譜ノイズに支配されている

```
e_pitch = (W_MISS × missed + W_EXTRA × extra) / refNotes     W_MISS=1.0, W_EXTRA=0.7
pitch   = 100 × exp(−e_pitch / TAU_PITCH)                    TAU_PITCH=0.15
```

`worker/tests/fixtures/issue8_take_diagnostic.json`（refNotes 1242 / matched 974 /
missed 268 / extra 521 / 採譜音符 1495）で分解すると:

| 条件 | e_pitch | pitch |
|---|---|---|
| 現状 | 0.509 | 約 3〜10点 |
| extra を完全に除去 | 0.216 | 23.7点 |
| W_EXTRA を 0.35 に半減 | 0.363 | 8.9点 |
| extra 完全除去 ＋ TAU_PITCH 0.30 | 0.216 | 48.7点 |

余剰音が誤りの 58% を占めるが、**それを全て消しても 24 点にしか戻らない**。`TAU_PITCH = 0.15`
が支配的である。`metrics.md:366` の「15% 外すと約 37 点」は式の意味の説明であり、測定根拠ではない。
`metrics.md:1055` は τ の較正手段を「講師3名のランク付けとの順位相関」と定め、状態を **未** と
記録している。

### 2.3 UI が null を 0 点として描画している

`src/lib/real-history.ts` が保留（null）を 0 に潰している（`:10-14` の `metricsFromDoc`、
`:136-143` の `measureScores`、`:154` の `overallScore`）。この値が `ScoreRing` に渡り、
`/progress` `/coach` `/share` で「0点」として表示される。`/takes/real/[takeId]` と
`/songs`（実データ側）は正しく「判定保留」「未算出」を出しており、扱いが不統一である。

### 2.4 ペダル参照が配線されていない

`reference.py:86-98, 199-244` は MusicXML から `pedalEvents`（拍位置と種別）と
`hasPedalMark` を抽出している。しかし `worker_main.py:290` が `ref_pedal=[]` を
ハードコードしているため、`pedal_ratio` の参照側が常に空になり、楽譜にペダル記号がある曲では
「ペダルを踏むほど減点される」計算になっている。`worker/README.md` の
「`reference.py` はMusicXMLからペダル記号を抽出していない」という記述は commit `c444c8f`
の `reference.py` 改修（+313行）以降、事実と合っていない。

## 3. 非目標

- 教師評価データセットの作成。`poc/evaluation/manifest.json` は全項目 `missing` /
  `pending_external_annotation` のままとし、`metrics.md:1055`（τ の教師較正）は **未** で残す。
- 教師視点の高度評価（演奏順位、worst-5 一致、意図的表現の判定）の公開。
  `calibration.py` の artifact 経路と `advancedEvaluationPassed` ゲートは現状のまま維持する。
- `articulation` 指標の追加（M4 で offset が信頼できないと結論済み）。
- モック UI（`src/lib/mock/`）側の変更。

## 4. 設計

### 4.1 指標ごとの扱い

`confidence.py` に、式の頑健性が本設計のハーネスで検証された指標の集合を持たせる。
較正 artifact（教師評価由来）とは独立した概念として扱い、両者を混同しない。

| 指標 | 新しい status | 条件 |
|---|---|---|
| tempo | `scored` | `tempoExcluded` でない小節が存在する。現状の `reference` から昇格 |
| rhythm | `scored` | 劣化録音時のデッドゾーン緩和（4.4）を適用 |
| dynamics | `scored` / `unavailable` | `capabilities.dynamics` が真かつ AGC 未検出。AGC 検出時は `unavailable` |
| pedal | `scored` / `unavailable` | `capabilities.pedal` が真かつ `ref_pedal` を構築できた場合（4.6） |
| pitch | `scored` | extra 分類（4.2）と τ 再校正（4.3）の適用後 |

いずれの指標も、テイク全体が 4.7 のアライメント下限を満たさない場合は採点しない。

この表は最終状態（5.4 の段3 完了時）である。段2 完了時点での pitch の扱いは 5.4 を参照。

### 4.2 pitch — extra 音符の分類

`align.py` の `extra` は「マッチしなかった採譜音符」を単一の集合として返している。これを
2つに分割し、`alignment` に別キーで格納する。

`extraNoise`（採譜アーティファクト。誤りに計上しない）— 以下のいずれかに該当するもの:

1. マッチ済み音符と同一ピッチで、onset 差が 50 ms 以内（二重検出）
2. マッチ済み音符の ±12 半音で、onset 差が 50 ms 以内かつ velocity がその音符の 50% 未満（倍音ゴースト）
3. duration が 60 ms 未満かつ velocity が 40 未満（スプリアス）
4. 採譜側のペダル区間内にあり、同一ペダル区間内でそれより前にマッチした音符と同ピッチで、velocity がその音符の 50% 未満（残響）

`extraPlayed` — 上記に該当しないもの。実際の弾き間違いはここに残る。

`metrics.py` の `e_pitch` は `extraPlayed` のみを計上する。`extraNoise` は件数と分類内訳を
`diagnostics` に保存し、監査可能性を維持する。

**閾値（50 ms / 60 ms / velocity 50% / velocity 40）は暫定値である。** フェーズ1では
弁別力を壊さないことの確認のみに使い、フェーズ2で MAESTRO の clean と room を比較して
「clean には存在せず room で増える extra」の特徴分布から確定する。フェーズ2完了までは
コード内に暫定値であることをコメントで明示する。

判定 1 と 2 は「マッチ済み音符」を参照するため、`align()` が `final` を確定した後に実行する。

### 4.3 pitch — τ の再校正と根拠の限界

`TAU_PITCH` と `W_EXTRA` を、`poc/scripts/perturb.py` が生成する既知の摂動に対する応答と、
`poc/scripts/degrade.py` による録音条件不変性から決める。合格条件は 5.1 / 5.2 に定める。

**この根拠は教師較正の代替ではない。** 摂動応答は「音符を N% 落としたら点が下がる」ことを
保証するが、「人が良い演奏と感じるか」は測っていない。`metrics.md` には根拠が摂動応答と
録音条件不変性であることを明記し、教師較正の項目は未のまま残す。

### 4.4 rhythm — 劣化録音時のデッドゾーン

`metrics.md:860` は劣化録音時に `d_r` を 0.03 → 0.045 拍に緩めると定めているが、
`metrics.py:16` は `DEAD_RHYTHM = 0.03` の固定値で未実装である。

`preprocess` が返す品質指標で切り替える。判定条件は `metrics.md:860` の
`dynamicRangeDb < 14` を用いる。

### 4.5 dynamics — AGC ゲート

`preprocess.py` の戻り値に `dynamicRangeDb` を追加する（現在は `rmsDbfs` / `peakDbfs` /
`clippingRate` のみ）。`m4-report.md` 5.1 は clean/room/phone が 16 dB 以上、phone_agc が
7 dB 以下で明確に分離し、「ダイナミックレンジが 10 dB を下回れば AGC とみなしてよい」と
実測している。

閾値は用途ごとに分ける。**混同しないこと。**

| 判定 | 閾値 | 用途 | 根拠 |
|---|---|---|---|
| AGC 検出 | `dynamicRangeDb < 10` | `dynamics` を `unavailable`（`AGC_DETECTED`）にする | `m4-report.md` 5.1 の実測（7 dB 以下 vs 16 dB 以上で分離） |
| 劣化録音 | `dynamicRangeDb < 14` | `rhythm` のデッドゾーンを緩める（4.4） | `metrics.md:860` |

`dynamicRangeDb` の算出は、フレーム RMS の 95 パーセンタイルと 5 パーセンタイルの差
（dB）とする。`peakDbfs − rmsDbfs`（クレストファクタ）は単発のピークに左右されるため使わない。

### 4.6 pedal — 参照区間の構築

`reference.py` の `pedalEvents`（拍位置と種別）から参照ペダル区間を構築し、
`worker_main.py:290` の `ref_pedal=[]` を置き換える。

`pedalEvents` の位置は拍単位、`pedal_ratio` は秒単位を期待するため、`metrics.py` が
既に持つ `measure_seconds(beats, secs, beat)` で変換する。ビートマップが確定するのは
`compute()` の内部なので、`compute()` が拍単位の参照ペダルイベントを受け取り、内部で
秒に変換する形に引数を変更する。

`capabilities.pedal` が偽（楽譜にペダル記号がない）場合は従来どおり `unavailable`
（`NO_SCORE_PEDAL`）を維持する。

### 4.7 overallScore の再計算規則

`confidence.py` の無条件 `None` 代入を廃止し、次の規則で算出する。

- `unavailable` な指標は加重平均から除外し、残りの重みを再配分する
- `withheld` な指標が1つでも残っている場合、`overallScore` は `null`
- 全指標が `scored` または `unavailable` の場合、`scored` な指標の加重平均を `overallScore` とする

`unavailable`（測る対象が楽譜に無い＝欠測）と `withheld`（測れるが信頼できない）を区別する
のがこの規則の要点である。`analysis-pipeline.md:541-545` は「低信頼な指標を除外して残りの
重みで総合点を再計算しない」と両者を区別せず禁じているため、この区別を導入する形で改訂する。

本設計の適用後、通常の解析経路では `withheld` は発生しない（4.1 の全指標が `scored` か
`unavailable` に落ち、アライメント不足は `failed` になる）。`withheld` は次の2つのために
残す規定であり、死んだ分岐ではない。

- 教師較正を要する高度評価（演奏順位、worst-5 一致など。`calibration.py` の artifact 経路）
- 今後追加され、まだ頑健性を検証していない指標

**アライメント下限**: `diagnostics.matchRate < 0.30` の場合、テイクを
`failed (ALIGN_FAILED)` として扱い、いずれの指標も採点しない。別の曲の音声が投稿された場合に
スコアを出さないための安全網である。`metrics.md:830-833` は `takeConfidence < 0.5` で
`failed` とする規定を持つが未実装で、その 0.5 は未較正の設計仮説である。ここでは
より保守的な 0.30 を採り、値の妥当性はフェーズ2で確認する（issue8 のテイクは 0.784 で通過する）。

### 4.8 UI / API

`src/lib/real-history.ts` の `?? 0` を廃止し、`Take` 型の該当フィールドを nullable にする。
`/progress` `/coach` `/share` は `/takes/real/[takeId]` と同じ扱いに揃える。

- `overallScore` が null かつ `evaluation.status === "withheld"` → 「判定保留」＋理由文
- 指標が null → `metricEvaluations[key].status` に応じて「判定保留」/「算出不可」＋理由文
- 小節ヒートマップの null → グレー＋斜線ハッチング（`/takes/real/[takeId]:176-181` と同じ表現）

`/coach` はスコアが出ない場合に AI 講評を要求しない（現状の
`/api/takes/[takeId]/coach` の 400 応答をユーザーに露出させない）。

前回比の差分表示は、両テイクの `overallScore` がともに数値のときだけ出す。片方が保留の
場合は「比較できません」とする。異なる `pipelineVersion` 間の差分を改善量として表示しない
（`calibration-runbook.md` 46-51行の規定）。

## 5. 検証

合格条件は**頑健性と弁別力の両方**である。片方だけなら自明に達成できてしまう（τ を無限に
広げれば録音条件不変だが全ての演奏が満点になる）。

### 5.1 フェーズ1 — 弁別力（音声不要）

`poc/scripts/perturb.py` は ground truth MIDI を直接加工し、採譜を経由しない。MAESTRO の
MIDI zip のみで実行でき、torch も採譜チェックポイントも不要である。

必要な入力: MAESTRO MIDI zip（約 84 MB）、`prepare_dataset.py` / `make_reference.py` /
`align.py` / `compute_metrics.py` / `summarize_metrics.py`。

合格条件:

1. `perturbation=none`（完璧な演奏）で pitch ≥ 90。ここで満点にならない分は参照譜の量子化など
   指標側の系統誤差であり、`perturb.py` の docstring が明示している検査項目である
2. `drop 5%` と `drop 10%` が分離する（前者の方が高い）
3. `add 5%`（隣接半音の誤打）で pitch が低下する。すなわち extra 分類が実際の弾き間違いを
   `extraNoise` に誤分類しない
4. 摂動率を上げるほど pitch が下がる（`drop` と `add` それぞれについて、摂動率で並べたとき
   pitch が単調非増加）

条件 3 が本フェーズの主眼である。extra 分類は採譜アーティファクトのみを除外すべきで、
弾き間違いを許してはならない。

**フェーズ1が通らない限りフェーズ2に進まない。**

### 5.2 フェーズ2 — 頑健性（音声必要、ゲート付き）

必要な入力: MAESTRO 音声（TFRecord シャード）、採譜チェックポイント
（Zenodo、約 170 MB）、ffmpeg、torch。`m4-report.md` 8章の再現手順に従う。採譜は RTF 1.2
のため相当の実行時間がかかる。

合格条件:

1. 同一演奏の clean と room / phone の pitch 差が 10 点以内（現状 -37.7 / -37.6）
2. phone_agc では `dynamics` が `unavailable` に落ちる
3. `rhythm` の clean と劣化条件の差が 10 点以内
4. フェーズ1の合格条件が引き続き成立する
5. extra 分類の閾値を、clean と room の extra 特徴分布から確定する
6. `matchRate` 下限 0.30 の妥当性を、別曲の音声を投稿した場合の `matchRate` 分布で確認する

phone_agc の pitch は対象外とする（M4 で -50.0、AGC は dynamics だけでなく採譜自体を
壊すため）。AGC 検出時の pitch の扱いはフェーズ2の測定結果を見て決める。

### 5.3 既存テストへの影響

`worker/tests/test_confidence.py` は「較正なしなら保留」を assert しており、本設計で
前提が変わる。issue8 のフィクスチャ（`issue8_take_diagnostic.json`）は残し、期待値を
次の2段階で更新する。

1. フェーズ1完了時 — `pitch` の status が `scored` になり、`overallScore` が数値になること、
   および pitch が変更前の 9.99 より高いことを assert する。具体値は τ が確定していないため
   固定しない
2. τ 確定後 — フィクスチャに確定値を記録し、回帰テストとして固定値で assert する

`test_metrics.py` / `test_calibration.py` / `test_teacher_metrics.py` は較正 artifact
経路のテストなので変更しない。

`npm run test:production` と `scripts/azure-local-smoke.ts` がスコアの null を前提に
していないか確認する。

### 5.4 実装の段階分け

MAESTRO への依存度が異なるため、3段に分ける。各段は独立して価値を出し、前段だけで
マージ可能な状態にする。

| 段 | 内容 | MAESTRO 依存 |
|---|---|---|
| 1 | UI の null 処理（4.8）。保留・算出不可を全画面で正しく表示する。スコアの値は変えない | なし |
| 2 | 指標別 status（4.1）、rhythm デッドゾーン（4.4）、AGC ゲート（4.5）、ペダル配線（4.6）、`overallScore` 算出（4.7）、`matchRate` 下限 | なし（M4 の既存測定に基づく） |
| 3 | pitch の extra 分類（4.2）と τ 再校正（4.3） | フェーズ1で MIDI、フェーズ2で音声 |

段2 の時点で pitch は `withheld`（理由コード `PITCH_FORMULA_UNVALIDATED`）のままとする。
pitch は測定可能だが式が未検証という状態であり、`unavailable`（測る対象が楽譜に無い）では
ないためである。

したがって 4.7 の規則により、**段2 完了時点では `overallScore` は null のまま**である。
pitch の重みは 0.28 で5指標中最大なので、これを除いた加重平均を「総合点」として提示すると
別の数字を同じ名前で見せることになる。総合点の復帰は段3 の完了条件とする。

段2 が出す価値は、`tempo` / `rhythm` / `dynamics` / `pedal` が個別に採点され、pitch の
保留理由が正しく表示されることである。段1 と合わせて「0点」表示は段2 の時点で解消する。

## 6. 文書の改訂

| 文書 | 箇所 | 内容 |
|---|---|---|
| `docs/spec/metrics.md` | 3.1 pitch | extra の分類と `W_EXTRA` / `TAU_PITCH` の新しい値、根拠が摂動応答であること |
| `docs/spec/metrics.md` | 3.2 rhythm | 劣化録音時デッドゾーンの実装と判定条件 |
| `docs/spec/metrics.md` | 3.4 dynamics | AGC 検出の実装と `dynamicRangeDb` の定義 |
| `docs/spec/metrics.md` | 7.2 | Issue #8 の安全策を、指標別の扱いに置き換え |
| `docs/spec/metrics.md` | 7.3 | `matchRate` 下限 0.30 の実装。0.5 は未較正仮説として据え置き |
| `docs/spec/metrics.md` | 9 / 922行 | τ の教師較正は **未** のまま維持することを明記 |
| `docs/spec/api.md` | 1章 | `unavailable` と `withheld` の区別と総合点への影響 |
| `docs/design/analysis-pipeline.md` | 6.4 / 7.1 | 総合点の再計算禁止条項を、`unavailable` / `withheld` の区別を含む形に改訂 |
| `worker/README.md` | 制約一覧 | ペダル抽出済みという事実に更新。フェイルクローズの記述を差し替え |
| `docs/poc/m4-report.md` | — | 変更しない（実験記録） |

## 7. 影響ファイル

worker:
- `ledgerlines_worker/align.py` — extra の分類
- `ledgerlines_worker/metrics.py` — `e_pitch` の入力変更、`TAU_PITCH` / `W_EXTRA`、`DEAD_RHYTHM` の切り替え、参照ペダル区間の受け取り
- `ledgerlines_worker/preprocess.py` — `dynamicRangeDb`
- `ledgerlines_worker/confidence.py` — 指標別 status 判定、`overallScore` 算出、`matchRate` 下限
- `worker_main.py` — `ref_pedal` の構築、品質指標の受け渡し
- `cloud_worker.py` — 同期するフィールドの確認
- `tests/test_confidence.py` — 期待値の更新

Next.js:
- `src/lib/server/types.ts`、`src/lib/api/client.ts` — 型（`AGC_DETECTED` 理由コードの追加）
- `src/lib/real-history.ts` — `?? 0` の廃止、nullable 化
- `src/app/progress/page.tsx`、`src/app/coach/page.tsx`、`src/app/share/page.tsx`
- `src/components/ProgressView.tsx`、`src/components/SongDetailView.tsx`、`src/components/TakeAnalysisView.tsx`、`src/components/ShareView.tsx`

## 8. リスクと未解決事項

- **τ の根拠が摂動応答に留まる。** 教師評価との順位相関は測れないため、「この点数が妥当か」は
  依然として未検証である。spec に明記し、教師データが揃った時点で再較正する。
- **extra 分類の閾値がフェーズ2まで暫定。** フェーズ1完了時点でマージする場合、閾値に
  実測根拠がない状態が一時的に残る。コード内にその旨を明記する。
- **MAESTRO は初中級者の演奏を含まない。** `m4-report.md` 7章が「最も重要な未検証項目」と
  している。止まる・弾き直す演奏での挙動は本設計の検証範囲外である。
- **phone_agc での pitch の扱いが未定。** フェーズ2の測定後に決める。
- `pedal` の参照区間構築は `pedalEvents` の種別（`start` / `stop` 等、music21 の
  `PedalMark` に依存）の解釈に依存する。実装時に MusicXML サンプル
  （`worker/tests/fixtures/semantic-score.musicxml`）で確認する。

## 9. 段3 着手時の設計修正（2026-08-17、Issue #40）

段3（4.2 の extra 分類と 4.3 の τ 再校正）に着手する際、4〜5章の記述に3つの穴が見つかった。
本節はその修正である。**4〜8章の記述と衝突する場合は本節が優先する。**

### 9.1 実装の置き場 — poc スクリプトを worker のモジュールに寄せる

7章は影響ファイルとして worker のみを挙げているが、フェーズ1の検証が実際に走らせるのは
`poc/scripts/align.py` と `poc/scripts/compute_metrics.py` であり、これらは
`worker/ledgerlines_worker/` を import しない**独立した複製**である（`align.py` は
worker 版と 82% 一致し、差は docstring と CLI のみ）。

このまま 4.2 を worker だけに実装すると、**検証は旧式を測る**ことになる。両方に実装すれば
検証対象が複製になる。どちらも受け入れられない。

したがって `poc/scripts/align.py` と `poc/scripts/compute_metrics.py` を
**`ledgerlines_worker` を呼ぶ CLI に置き換える**。差分の実体は worker 側の1つだけになり、
フェーズ1は本番コードそのものを測る。7章の影響ファイルに以下を追加する。

- `poc/scripts/align.py`、`poc/scripts/compute_metrics.py` — worker のモジュールを呼ぶ形へ
- `poc/scripts/prepare_dataset.py`、`poc/scripts/make_reference.py` — MIDI 専用経路（9.2）
- `poc/README.md` — 段3 の実行手順

### 9.2 フェーズ1 の参照譜は MIDI 由来の等間隔グリッドで作る

5.1 は「MAESTRO の MIDI zip のみで実行できる」と述べているが、`make_reference.py` の
`estimate_beat_grid()` は `librosa.beat.beat_track` で**音声から**拍を推定する。librosa は
ホストにもワーカーイメージにも入っておらず、音声は 108GB zip からの取得が必要である。
MAESTRO の MIDI 自体は 120 BPM / 4-4 固定のプレースホルダで（Disklavier の演奏 MIDI、実測）、
楽譜由来のテンポマップを持たない。

フェーズ1 の合格条件は missed / extra の**個数**で決まり、拍の音楽的正しさに依存しない。
音声の拍トラッキングはそこに推定誤差だけを持ち込む。よって MIDI のオンセットから
**等間隔グリッド**を作る経路を追加する（音声・librosa 不要）。

グリッドの分割数は **16 分割**とする。MAESTRO 5曲の先頭90秒で同一ピッチ音符の最小オンセット
間隔を実測したところ、8分割（0.0625秒）では1曲でトリルが同一格子に潰れた（最小 0.0604秒）。
16分割（0.03125秒）なら 5曲すべてで潰れない。

**この経路では rhythm / tempo の数値は意味を持たない**（拍が音楽的な拍ではないため）。
フェーズ1 が判定するのは pitch の弁別力のみであり、rhythm の劣化耐性（5.2 の条件3）は
フェーズ2 に属する。ハーネスの出力にその旨を明記する。

### 9.3 フェーズ1 は τ を確定できない — 実録音による測定を追加する

5.1 のフェーズ1 は ground truth MIDI を直接摂動させ、**採譜を通さない**。一方 4.2 の
extra 分類が除外対象とするのは、二重検出・倍音ゴースト・スプリアス・ペダル残響という
**すべて採譜アーティファクト**である。採譜器が介在しないフェーズ1 には、これらが1件も
存在しない。

したがってフェーズ1 で検証できるのは「分類器が実際の弾き間違いを `extraNoise` に
誤分類しないこと」（5.1 条件3、偽陰性方向）だけである。**「実在のアーティファクトを
除去できるか」と「実データで τ をどこに置くべきか」はフェーズ1 では測れない。**
2.2 が引いている数字（参照 1242 音に対して extra 521 音、extra を全除去しても 24 点）は
実採譜の診断値であり、そこが問題の本体である。

そこで段3 の検証を次の3脚に分ける。

| 脚 | 測るもの | データ | 段3 での扱い |
|---|---|---|---|
| 1 | 弁別力（5.1 の条件1〜4） | MAESTRO MIDI zip | 実施する |
| 2 | アーティファクト実在性と τ の位置 | 実録音（`.data/audio/` の 168 秒）を、採譜モデル同梱のワーカーコンテナで採譜 | **実施する（本節で追加）** |
| 3 | 録音条件不変性（5.2 の条件1〜3） | MAESTRO 音声（108GB zip からのシャード取得） | フェーズ2 へ後回し |

脚2 の位置づけ: 実録音1件は分布を語れないため、**τ の候補値を実データで裏付ける**用途に限る。
`extraNoise` / `extraPlayed` の分類内訳と、τ を動かしたときの pitch の応答を記録し、
`docs/spec/metrics.md` に根拠として残す。分類閾値の確定（5.2 の条件5）はフェーズ2 のままとする。

### 9.3b 5.1 条件2 の訂正 — `drop 10%` は存在しない

5.1 条件2「`drop 5%` と `drop 10%` が分離する」は誤りである。`perturb.py` が生成する
`drop` 条件は `drop05` / `drop15` の2点のみで、`drop10` は無い。条件2 の趣旨（摂動率が
低いほど点が高いこと）に沿って、率の最小（`drop05`）と最大（`drop15`）を比較して判定する
（結果文書 §4）。

### 9.4 変わらないこと

- **τ の根拠は教師較正ではない**（4.3、8章）。段3 完了の意味は「`overallScore` が数値になる」
  ことであり、「その点数が音楽的に妥当と証明された」ことではない
- 4.2 の分類規則と暫定閾値（50 ms / 60 ms / velocity 50% / velocity 40）
- 5.1 の合格条件4項目
- **フェーズ1 が通らない限りフェーズ2 に進まない**

### 9.5 段3 実施の結果（2026-08-17、Task 7〜9）— 完了条件は未達、pitch の保留を継続する

9.1〜9.4 は段3 着手時点の見通しである。Task 7（脚1、フェーズ1 の弁別力測定）と
Task 8（脚2、実録音1件の採譜による測定）を実施した結果、9.3 が想定していた
「脚2 で τ 候補を実データで裏付ける」という段3 の完了への道筋が成立しないことが分かった。
測定の全文は `docs/superpowers/plans/2026-08-17-pitch-formula-stage3-results.md`。

**4.2 の分類は実装されたが、実データではほとんど効かない。** `align.py` の `classify_extra` /
`_noise_reason` は4規則（duplicate / harmonic / spurious / reverb）を設計どおりに実装している。
フェーズ1（MAESTRO MIDI の摂動、採譜を経由しない）では、注入した隣接半音の誤打の 93〜95% が
`extraPlayed` に残り、`harmonic` への誤分類は0件だった（結果文書 §6〜§8）。一方、実録音1件の
採譜結果（脚2、結果文書 §9）では `extraNotes` 258 件中 `extraNoiseNotes` は **2件**
（`noiseShare` 0.78%）に留まった。規則ごとの理由は次のとおりで、いずれも「候補が無い」のではなく
「閾値が実測の velocity 分布に対して厳しすぎる」ことが原因である（結果文書 §9.3）。

- 規則1（duplicate）: 前段候補 0件。採譜器（`piano_transcription_inference`）が同一ピッチの
  二重検出を出さない構造上の性質のため、閾値をどう動かしても**構造的に発火しない**
- 規則2（harmonic）: 前段候補 69件、発火 0件。velocity 比の最小値が 0.60 で、閾値 0.50 を
  僅差で外している
- 規則3（spurious）: 前段候補は duration 65件・velocity 15件だが AND のため発火 2件のみ
- 規則4（reverb）: 前段候補 9件、発火 0件。velocity 比の最小値が 0.51 で、閾値を **0.01 差**
  で外している
- `NOISE_VELOCITY_RATIO = 0.50` を 0.90 まで緩めても `noiseShare` の上限は約 0.20 で、
  Task 9 の決定規則が要求する 0.50 には届かない。この上限は**規則3（spurious）の2件 + 規則2
  （harmonic@0.90）の43件 + 規則4（reverb@0.90）の6件 = 51件**から算出している
  （`(2+43+6)/258 ≈ 0.20`）。**この録音1件について3規則の該当 extra 集合の交差を実測したところ、
  spurious∩harmonic・spurious∩reverb・harmonic∩reverb はすべて空で、51 は既に重複のない
  union と一致する**（単純和が過大評価にはなっていない）。再現:
  `poc/scripts/analyze_real_take_extra.py` の `overlapAt090`（`pairwiseIntersections` が
  すべて `[]`、`simpleSumEqualsUnion: true`）

**5.1 のフェーズ1 は通ったが、τ を選ぶ根拠にはならなかった。** `pitch = 100 * exp(-e_pitch/τ)` は
τ > 0 で `e_pitch` に対して厳密減少するため、5.1 の条件2〜4（すべて順序比較）は τ の値に
一切依存しない。実測でも τ 6点 × W_EXTRA 3点の **18候補全部**が4条件に合格した
（結果文書 §4〜§5）。9.3 は「フェーズ1では τ を確定できない」ことを予期していたが、
実際には「4条件のどれもが τ を制約しない」という、予期より強い形で成立した。

**9.3 の脚2 は「τ 候補を実データで裏付ける」ことを狙って追加したが、裏付けられなかった。**
分類が実データでほぼ効かないため、`noiseShare` は18候補すべてで 0.78% に固定され、
Task 9 の決定規則（`noiseShare ≥ 0.50` を満たす候補から τ 最小を選ぶ）を適用できる候補が
1つも無い。18候補の pitch は 30.24〜71.51 の範囲に散らばり、この中から τ を選ぶことは
実データの裏付けではなく恣意的な選択になる（結果文書 §9.4）。

**2.2 の「τ が支配的」という分析は、測定した録音には当てはまらなかった。** 2.2 は issue8
診断テイク（`missed/ref` = 268/1242 = 21.6%、extra を全除去しても 24点）から
「extra を全部消しても大きく変わらず τ が支配的」と述べているが、この 21.6% は
`missedNotes` キーを持たない旧フィクスチャからの派生値であり上限値である。今回測定した
実録音（`missed/ref` = 89/1121 = 7.9%）で extra を1件も計上しない極限の pitch を実測すると
τ=0.15 で 65.13（τ=0.40 で 83.29）であり、実際に pitch を 30.24 まで押し下げているのは
τ ではなく計上された `extraPlayed` 256件である（結果文書 §9.4）。すなわち、この録音では
「τ を動かしても大差ない」という2.2 の前提は成立しない。

**したがって段3 の完了条件（4.1 の pitch が `scored` になり、`overallScore` が数値になる）は
未達である。** `TAU_PITCH` / `W_EXTRA` を動かす根拠が無い（動かしても恣意的になる）ため、
`metrics.py` の値は 0.15 / 0.7 のまま変更せず、`confidence.py` の `decide("pitch")` は
`withheld` / `PITCH_FORMULA_UNVALIDATED` を返し続ける。Issue #40 はこの段では閉じない。

**次に必要なのはフェーズ2（5.2、MAESTRO 音声による clean/room の extra 特徴分布の実測）である。**
今回の脚2 は録音1件でも「規則1 は構造的に発火しない」「規則2・4 は velocity 比が僅差で外れる」
という機構は読み取れたが、閾値をどこに置くべきかは分布が要る（結果文書 §9.6）。
分類閾値（5.2 条件5）が実データに合う値に更新されない限り、`noiseShare` が上がらず、
Task 9 の決定規則を適用できる候補は出てこない。

**フェーズ2 に申し送る構造的な論点（レビュー指摘、3件）**

1. **脚1 の合格条件は実質2事実しか検証していない。** `drop` と `add` が各2点しかないため、
   条件2（`drops[0] > drops[-1]`）と条件4（単調非増加）は**ほぼ同一の検定**である。4項目が
   独立に見えて実質2事実なので、18/18 合格は「条件が緩い」ことの証拠でもある。**τ を決めるには
   順序ではなく水準を問う条件**（例: 「missed 率 10% の演奏が 60〜80 点に入る」）が必要で、
   それは教師較正か、少なくとも「妥当な点数帯」の外部定義を要する
2. **規則2（harmonic）は `abs(pitch差) == 12` なので、マッチ音符の1オクターブ*下*の弱音も
   倍音ゴーストと判定する。** 採譜の倍音ゴーストは物理的に基音の**上**に出るもので、下側は
   下方倍音ではない。つまりカバー範囲の半分に物理的根拠が無く、「弱い低オクターブの弾き間違い」を
   取り落とす方向に働く。実測発火は脚1・脚2ともに0件なので今日の害はゼロだが、フェーズ2 で
   閾値を確定するときに方向を分けるべき論点である
3. **重複排除の要否は録音ごとに確認が必要。** この録音では規則2・3・4 の該当 extra 集合は
   互いに素で、`noiseShare` 上限 0.20 の単純和は重複のない union と一致した（上記のとおり）。
   これは実測結果であって前提ではない——録音1件からの一般化はできないため、フェーズ2 で
   MAESTRO 音声の複数録音に対して閾値を確定する際は、単純和ではなく重複排除した union で
   `noiseShare` を計算すること（`analyze_real_take_extra.py` の `overlapAt090` と同じ形で
   毎回確認する）
