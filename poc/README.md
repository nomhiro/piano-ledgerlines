# 分析エンジン PoC（M4 / M4.5）

Ledger Lines の分析パイプラインの前提を、実音源で検証するためのスクリプト群です。

**検証結果とそこから導いた設計判断は
[M4 検証レポート](../docs/poc/m4-report.md) と
[M4.5 検証レポート](../docs/poc/m45-report.md) にまとまっています。
このディレクトリは再現用のコードだけを置いています。**

## 何を検証したか

### M4

| 問い | 結果 |
|---|---|
| CPU だけで採譜できるか | できるが RTF 1.25。3分の曲に約4分 |
| マイク録音（残響・スマホ・AGC）で精度はどこまで落ちるか | note F1 0.98 → 0.83 |
| ペダルはマイク録音から検出できるか | できる。劣化条件でも F1 0.81 |
| 楽譜とのアライメントは実用精度に達するか | F1 0.962、弾き逃しの誤検出 0.4% |
| 指標は狙った演奏の劣化にだけ反応するか | する（5指標の直交性を確認） |
| 絶対スコアは環境をまたいで比較できるか | **できない**（総合 89 → 61） |

### M4.5

| 問い | 結果 |
|---|---|
| 弾き直し・途中停止・部分練習をアライメントできるか | 跳躍付き DTW で解決。最悪ケース F1 0.400 → 0.959 |
| ONNX 化で速くなるか | **約2倍速・出力ビット一致** |
| int8 量子化で更に速くなるか | **逆効果**。Conv 主体のモデルで最大9倍遅い |
| 同じ演奏を録り直すとスコアはどれだけぶれるか | 総合 σ ≒ 2.2〜3.0、**最小検出差 6〜8点** |

## セットアップ

```powershell
# Windows のパス長制限（260文字）を避けるため、venv はリポジトリ外に作る
python -m venv C:\llpoc\venv
C:\llpoc\venv\Scripts\pip install torch librosa mir_eval pretty_midi soundfile piano_transcription_inference
C:\llpoc\venv\Scripts\pip install onnx onnxruntime   # M4.5 で追加

# 採譜モデルは wget で自動取得しようとするため Windows では失敗する。手動で配置する
curl -L -o "$env:USERPROFILE\piano_transcription_inference_data\note_F1=0.9677_pedal_F1=0.9186.pth" `
  "https://zenodo.org/record/4034264/files/CRNN_note_F1%3D0.9677_pedal_F1%3D0.9186.pth?download=1"
```

`ffmpeg` が PATH に必要です。

## 実行

### M4（データ準備〜指標算出）

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
python scripts\align.py                # 楽譜アライメント（既定: 跳躍付き / window 1.0秒）
python scripts\evaluate_alignment.py
python scripts\compute_metrics.py      # 5指標の算出
python scripts\summarize_metrics.py    # 条件別の集計
python scripts\estimate_quality.py     # 録音品質と採譜精度の相関
```

### M4.5（弾き直し・ONNX・安定性）

M4 の `make_reference.py` までを実行済みであることが前提です。

```powershell
# 1. 弾き直し・停止・部分練習の摂動を生成
python scripts\perturb_replay.py

# 2. 単調 DTW の破綻を計測（M4 時点の挙動）
python scripts\align.py --mode strict --conditions r_none r_retry1 r_retry3 r_retry_long r_stop r_partial r_partial_retry r_skip --tag strict
python scripts\evaluate_replay.py --align-tag strict

# 3. 跳躍付き DTW で再計測
python scripts\align.py --conditions r_none r_retry1 r_retry3 r_retry_long r_stop r_partial r_partial_retry r_skip
python scripts\evaluate_replay.py

# 4. JUMP_PENALTY の掃引（実録音条件との両立を確認）
python scripts\sweep_jump.py

# 5. ONNX エクスポートと量子化の比較
python scripts\export_onnx.py
python scripts\transcribe_onnx.py
python scripts\evaluate_transcription.py

# 6. 差分の安定性（σ と最小検出差）
python scripts\stability_gen.py
python scripts\transcribe_onnx.py --conditions st_noise0 st_noise1 ... st_session4
python scripts\align.py --conditions st_noise0 ... st_session4
python scripts\compute_metrics.py
python scripts\stability_report.py
```

出力は `out/`、データは `data/` に置かれます。どちらも `.gitignore` 済みです。

## スクリプトの役割

### M4

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
| `align.py` | イベント列 DTW（Jaccard距離）→ イベント内マッチング → 秒ベース近傍探索。M4.5 で跳躍遷移を追加 |
| `evaluate_alignment.py` | 参照譜→ground truth→採譜結果の連鎖から正解対応を作り、アライメント精度を測る |
| `compute_metrics.py` | pitch / rhythm / tempo / dynamics / pedal の5指標を算出する |
| `summarize_metrics.py` | 録音条件・摂動条件ごとに集計する |
| `estimate_quality.py` | 音声の音響特徴から採譜精度を予測できるかを調べる。AGC は確実に検出できる |

### M4.5

| スクリプト | 役割 |
|---|---|
| `perturb_replay.py` | ground truth の時間軸を組み替えて弾き直し・停止・部分練習を模擬する（8条件）。**正解対応を摂動生成側で直接記録する**（時間軸が非単調になると `evaluate_alignment.py` の連鎖方式が使えないため） |
| `evaluate_replay.py` | 弾き直し条件でのアライメント評価。**最後のテイクを正解**とし、弾いていない箇所への誤対応（spurious）と、前のテイクへの誤対応（stale）を分けて測る |
| `sweep_jump.py` | コスト行列を1回だけ計算して JUMP_PENALTY を振る。実録音条件と弾き直し条件を同時に評価し、両立点を探す |
| `export_onnx.py` | ONNX エクスポート、int8 動的量子化の3バリアント（matmul / conv / all）、カーネル単位のベンチ |
| `transcribe_onnx.py` | `PianoTranscription.model` を ONNX セッションに差し替えて採譜する。前後処理はライブラリのものをそのまま使う |
| `stability_gen.py` | 同じ音源に対し劣化条件の乱数だけを振り直したバリアントを作る。`noise`（雑音の実現値のみ）と `session`（残響・マイク位置・SNR も振る）の2水準 |
| `stability_report.py` | 指標ごとの σ と最小検出差（MDD = 1.96·√2·σ）を出す |

## 注意

- **MAESTRO は研究用データセットです。** 検証目的でのみ使用しています
- 曲数が4曲と少なく、すべて Yamaha Disklavier で収録されたコンクール演奏です。
  初中級者の演奏（止まる・弾き直す）は含まれていません。制約は
  [M4 レポート 7章](../docs/poc/m4-report.md#7-制約と未検証事項) を参照してください
- M4.5 の弾き直し検証は **MIDI レベルの合成**です。採譜ノイズと弾き直しが同時に起きる
  実録音での評価はできていません（[M4.5 レポート 1.6](../docs/poc/m45-report.md#16-残る問題)）
- ONNX の RTF 絶対値は測定マシンの負荷で大きくぶれます。信頼できるのは PyTorch との比だけです
