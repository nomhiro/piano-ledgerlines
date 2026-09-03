# 教師評価較正・再解析ランブック

## 安全原則

- `LEDGERLINES_ENABLE_CALIBRATED_SCORES` の既定は無効。無効時は`calibration.py`がartifactを
  読み込まず、`evaluation.calibrationVersion`は`null`になる。**このフラグとartifactの有無は
  どの指標が`scored`/`withheld`/`unavailable`になるかに一切影響しない。** `pitch`は
  常に`withheld`（`PITCH_FORMULA_UNVALIDATED`）、`rhythm`/`tempo`/`dynamics`/`pedal`の
  採点可否は録音条件への頑健性（M4 5章の実測）とアライメント/AGC/参照ペダルの有無だけで決まる
  （`worker/ledgerlines_worker/confidence.py`）。`calibration.py`とそのrelease gateは
  artifactの検証（`approved`/gate合格/`datasetHash`/`calibrationVersion`の整合性）を
  今も行うが、その結果は診断情報にのみ記録される。フェイルクローズという言葉が指すのは
  `pitch`が式未検証のため保留され続けることであり、artifactの有無で切り替わる挙動ではない。
- **`releasedMetrics`に指標を追加しても、それだけで採点対象（`scored`/`withheld`/`unavailable`）が
  変わることはない**——それを決めるのは録音条件への頑健性とコード定数であり、artifactの
  内容ではない。**しかし、artifactが検証に失敗すると「劣化」ではなく「全滅」する。**
  `releasedMetrics`が空・重複・`tempo`を含まない、または`thresholds.tempo.minimumConfidence`が
  `[0,1]`の数値でない場合、`calibration.py`（`load_calibration()`）は`CalibrationError`を
  投げる（`releasedMetrics`検証・`tempo`必須チェックは`calibration.py:39-49`）。**これは
  `LEDGERLINES_ENABLE_CALIBRATED_SCORES=true`のときだけ起こる。** `load_calibration()`は
  明示`path`が無く、かつこのフラグが`true`でなければ、artifactを一切開かずに`None`を返す
  （`calibration.py:19`）——フラグが無効なら`CalibrationError`も`INTERNAL`も発生しない。
  フラグが有効な状態で不正なartifactを設定すると、この例外は`run_analyze`のどこでも捕捉
  されず、汎用の`except Exception`（`worker_main.py:375-378`）まで伝播し、**そのartifactが
  設定されフラグが有効な間に解析される全テイクが`failed`（コード`INTERNAL`）になる**——
  一部の指標が採点されないのではなく、解析そのものが止まる。原因がartifactだと示すヒントは
  ログの例外メッセージ（`str(exc)`）だけで、`reasonCode`のような専用コードは付かない。
  配備前に必ず`calibration.py`の検証をローカルで（下記「配備」手順2のように、明示`path`を
  渡して）通してから、フラグを有効化すること。
- 音声・MIDI・教師の自由記述はGitに置かない。
- `approved: true`、release gate合格、dataset hash、calibration versionが揃わない
  artifactをworkerは拒否する。
- artifact更新とアプリコード更新を同じレビューで混ぜない。

## artifact生成

```powershell
python poc\scripts\calibrate_teacher_evaluation.py `
  --dataset C:\secure-ledgerlines-evaluation\dataset.json `
  --out C:\secure-ledgerlines-evaluation\calibration.json
```

終了コード `0` の場合だけtempo較正artifactの候補にできる。`2` はデータ件数、
対象テイク回帰、tempoの未知test false-passのいずれかが未達である。
artifact schemaは`1.1`。`releasedMetrics` にない指標は公開しない。
`advancedEvaluationPassed: false` の場合、
教師順位相関やworst-5一致が未達なので高度評価は引き続き非公開にする。

## 配備

1. artifactの`datasetHash`と評価レポートをレビューする。
2. **配備前に`calibration.py`の`load_calibration(path)`を、明示`path`引数を渡して
   ローカルで実行し、`CalibrationError`が出ないことを確認する。** 明示`path`を渡すと
   `LEDGERLINES_ENABLE_CALIBRATED_SCORES`フラグの状態に関わらず検証が走る
   （`calibration.py:19`）ため、フラグをまだ有効化していないこの時点でも検証できる。
   ここで失敗するartifactをこの後の手順に進めてはならない。
3. artifactを読み取り専用Secret/Volumeへ配備する。
4. `LEDGERLINES_CALIBRATION_FILE`をそのパスへ設定する。
5. **`LEDGERLINES_ENABLE_CALIBRATED_SCORES=true`をstagingで設定する。**
   （フラグが無効なままでは`calibration.py`がartifactを一切読まないため、次の手順6の
   検証はフラグを有効にした状態で行わないと意味がない。）
6. stagingで`--mode analyze`を1件以上流し、`failed`/`INTERNAL`が出ないこと、対象テイクの
   `evaluation.calibrationVersion`が期待どおり記録されることを確認する。
   指標の`scored`/`withheld`/`unavailable`判定はこのartifactに依存しないため、
   フラグ有効化の前後で保留率が変化しないことも確認する（変化した場合は本ランブックの
   前提—安全原則を参照—が崩れているので配備を止める）。
7. 手順6の確認が終わったら、`LEDGERLINES_ENABLE_CALIBRATED_SCORES=true`をproductionで設定する。

## 監視

workerログの次を集計する。

- `evaluation.status`別件数
- `reasonCode`別保留率
- `calibrationVersion`別件数
- 録音条件・入力種別別の保留率
- 教師再評価との不一致率

特定条件（録音条件・入力種別）だけ保留率が急変した場合、まず`AGC_DYNAMIC_RANGE_DB`や
`MIN_MATCH_RATE`等の判定がその条件で誤検出していないかを疑う。**これらは
calibration artifactの値ではなく`worker/ledgerlines_worker/scoring_constants.py`の
コード定数であり、artifactを追加・再較正しても変わらない。** 閾値そのものを見直す場合は
M4のような録音条件別の再測定を経て`scoring_constants.py`を更新し、通常のコードレビューを
通す（このランブックの範囲外）。`教師再評価との不一致率`のような較正artifact側の
指標が悪化した場合にのみ、データセットを追加して再較正する。

## 旧テイク再解析

新しいreference schemaは`2.0`、pipelineは`0.3.0-m5-metric-policy`以降を使う。
旧テイクは元音声とMusicXMLが保持されているものだけ再解析する。履歴画面の
「過去の演奏を再採点」から曲単位で完了済みテイクを再解析キューへ投入する。再解析中は
旧結果を表示せず、完了後に新しいpipeline/calibration versionの結果へ置き換える。
異なるversion間の差分は改善量として表示しない。

## ロールバック

異常時は最初に`LEDGERLINES_ENABLE_CALIBRATED_SCORES=false`へ戻す。artifactを削除したり
未較正閾値へ置換しない。フラグを戻すと`evaluation.calibrationVersion`が`null`に戻るだけで、
`rhythm`/`tempo`/`dynamics`/`pedal`の採点可否には影響しない。`overallScore`はロールバック
前後どちらでも`null`のままである（`pitch`が常に`withheld`のため、artifactの有無に関わらず
総合点は段3まで復帰しない）。
