# 教師評価・採譜正解データ

`manifest.json` はデータの所在と注釈状態だけを管理する。音声、MIDI、氏名、自由記述の
原文は Git に保存しない。

## 2種類の正解

- `technicalGroundTruth`: 同時収録 MIDI または人手修正 MIDI。採譜・アライメントの
  confidence を較正する。
- `teacherAnnotations`: 3名以上の独立した教師評価。演奏順位、指標別順位、
  ワースト小節、意図的表現、練習提案を較正する。

教師の演奏評価を採譜 confidence の正解として流用してはならない。

## 手順

1. 同意・保持期限・匿名化を確認し、外部のアクセス制御された保存先へ音声/MIDIを置く。
2. `teacher-dataset.schema.json` に従うレコードを作る。教師IDは不可逆な匿名IDにする。
3. 教師は他の教師やシステム点を見ずに注釈する。
4. 演奏者・曲単位で `train` / `calibration` / `test` を分割する。
5. `python poc/scripts/calibrate_teacher_evaluation.py --dataset <json> --out <artifact>`
   を実行する。
6. `approved: true` かつ release gate を満たした artifact だけを本番へ配備する。
   `releasedMetrics` にない指標は公開せず、`advancedEvaluationPassed: false` の場合は
   教師視点の高度評価を公開しない。現在のworkerが本番公開できるのはtempoだけである。

対象テイク `take_980da1b96a3d4bcc9c6c` は manifest に登録済みで、音声は外部提供済み。
リポジトリには保存せず、`assetStatus.audio = available_external` だけを記録する。
対象曲のMusicXML、同時収録または人手修正した正解MIDI、教師注釈は未提供のため
`pending_external_annotation` である。音声から自動採譜したMIDIを技術的正解として
流用してはならない。この状態では較正artifactを承認できず、本番はフェイルクローズを維持する。
