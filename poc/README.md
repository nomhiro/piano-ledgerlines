# 分析エンジン PoC（M4）

Ledger Lines の分析パイプラインの前提を、実音源で検証するためのスクリプト群です。

**検証結果とそこから導いた設計判断は [M4 検証レポート](../docs/poc/m4-report.md) にまとまっています。
このディレクトリは再現用のコードだけを置いています。**

## 何を検証したか

| 問い | 結果 |
|---|---|
| CPU だけで採譜できるか | できるが RTF 1.25。3分の曲に約4分 |
| マイク録音（残響・スマホ・AGC）で精度はどこまで落ちるか | note F1 0.98 → 0.83 |
| ペダルはマイク録音から検出できるか | できる。劣化条件でも F1 0.81 |
| 楽譜とのアライメントは実用精度に達するか | F1 0.962、弾き逃しの誤検出 0.4% |
| 指標は狙った演奏の劣化にだけ反応するか | する（5指標の直交性を確認） |
| 絶対スコアは環境をまたいで比較できるか | **できない**（総合 89 → 61） |

## セットアップ

```powershell
# Windows のパス長制限（260文字）を避けるため、venv はリポジトリ外に作る
python -m venv C:\llpoc\venv
C:\llpoc\venv\Scripts\pip install torch librosa mir_eval pretty_midi soundfile piano_transcription_inference

# 採譜モデルは wget で自動取得しようとするため Windows では失敗する。手動で配置する
curl -L -o "$env:USERPROFILE\piano_transcription_inference_data\note_F1=0.9677_pedal_F1=0.9186.pth" `
  "https://zenodo.org/record/4034264/files/CRNN_note_F1%3D0.9677_pedal_F1%3D0.9186.pth?download=1"
```

`ffmpeg` が PATH に必要です。

## 実行

```powershell
cd poc
python scripts\extract_maestro.py      # MAESTRO の TFRecord から音声を取り出す
python scripts\prepare_dataset.py      # 90秒に切り出し、ground truth MIDI と対応付ける
python scripts\degrade.py              # 録音条件を模擬（残響・ノイズ・帯域制限・AGC）
python scripts\transcribe.py           # 採譜（RTF 計測込み）
python scripts\evaluate_transcription.py
python scripts\analyze_offsets.py      # offset バイアスの分析
python scripts\analyze_legato.py       # アーティキュレーション代替案の検証
python scripts\make_reference.py       # 参照譜（楽譜相当）の合成
python scripts\perturb.py              # 12種類の摂動演奏を生成
python scripts\align.py --window 1.0   # 楽譜アライメント
python scripts\evaluate_alignment.py
python scripts\compute_metrics.py      # 5指標の算出
python scripts\summarize_metrics.py    # 条件別の集計
python scripts\estimate_quality.py     # 録音品質と採譜精度の相関
```

出力は `out/`、データは `data/` に置かれます。どちらも `.gitignore` 済みです。

## スクリプトの役割

| スクリプト | 役割 |
|---|---|
| `extract_maestro.py` | MAESTRO v3 の TFRecord を標準ライブラリだけでパースし、音声を取り出す。全体 zip は 108GB あるため HTTP Range で先頭だけ取得する |
| `prepare_dataset.py` | 評価用に 90 秒へ切り出し、ground truth MIDI を同じ区間で切る |
| `degrade.py` | `room` / `phone` / `phone_agc` の3条件を音声処理で模擬する |
| `transcribe.py` | ByteDance のモデルで採譜する。RTF も測る |
| `evaluate_transcription.py` | `mir_eval` で note F1 / onset MAE / velocity 相関 / pedal F1 を出す |
| `analyze_offsets.py` | offset の誤差構造を調べる。`articulation` を諦めた根拠 |
| `analyze_legato.py` | 「レガートが断絶したか」の1ビット判定で代替できないかの検証。不成立 |
| `make_reference.py` | ground truth MIDI を拍の格子に量子化し、楽譜相当の参照譜を作る |
| `perturb.py` | 音符欠落・余分な音・タイミング揺れ・テンポ揺れ・強弱圧縮・ペダル除去を MIDI レベルで適用する。**採譜を通さないので指標そのものの挙動を測れる** |
| `align.py` | イベント列 DTW（Jaccard距離）→ イベント内マッチング → 秒ベース近傍探索 |
| `evaluate_alignment.py` | 参照譜→ground truth→採譜結果の連鎖から正解対応を作り、アライメント精度を測る |
| `compute_metrics.py` | pitch / rhythm / tempo / dynamics / pedal の5指標を算出する |
| `summarize_metrics.py` | 録音条件・摂動条件ごとに集計する |
| `estimate_quality.py` | 音声の音響特徴から採譜精度を予測できるかを調べる。AGC は確実に検出できる |

## 注意

- **MAESTRO は研究用データセットです。** 検証目的でのみ使用しています
- 曲数が4曲と少なく、すべて Yamaha Disklavier で収録されたコンクール演奏です。
  初中級者の演奏（止まる・弾き直す）は含まれていません。制約は
  [レポート 7章](../docs/poc/m4-report.md#7-制約と未検証事項) を参照してください
