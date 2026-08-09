# 教師評価較正・再解析ランブック

## 安全原則

- `LEDGERLINES_ENABLE_CALIBRATED_SCORES` の既定は無効。無効時は承認済みartifactが
  配置されていてもフェイルクローズになる。
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

終了コード `0` の場合だけ候補にできる。`2` は教師数、相関、worst-5一致、
対象テイク回帰、指標別false-passのいずれかが未達である。

## 配備

1. artifactの`datasetHash`と評価レポートをレビューする。
2. artifactを読み取り専用Secret/Volumeへ配備する。
3. `LEDGERLINES_CALIBRATION_FILE`をそのパスへ設定する。
4. stagingで対象テイク回帰と保留率を確認する。
5. `LEDGERLINES_ENABLE_CALIBRATED_SCORES=true`をstaging、その後productionで設定する。

## 監視

workerログの次を集計する。

- `evaluation.status`別件数
- `reasonCode`別保留率
- `calibrationVersion`別件数
- 録音条件・入力種別別の保留率
- 教師再評価との不一致率

特定条件だけ保留率が急変した場合、閾値を手修正せずデータセットを追加して再較正する。

## 旧テイク再解析

新しいreference schemaは`2.0`、pipelineは`0.2.0-m5-confidence-guard`以降を使う。
旧テイクは元音声とMusicXMLが保持されているものだけ再解析する。再解析前の結果を上書きせず、
pipeline/calibration versionを持つ新しい解析結果として保存する。異なるversion間の差分は
改善量として表示しない。

## ロールバック

異常時は最初に`LEDGERLINES_ENABLE_CALIBRATED_SCORES=false`へ戻す。artifactを削除したり
未較正閾値へ置換しない。workerは総合点と高度評価を保留し、tempo参考値だけを返す。
