# pitch の弁別力測定（段3 フェーズ1 / 脚1）— 測定結果

測定日: 2026-08-17
対象: 設計 §5.1 の合格条件4項目
Issue: #40（pitch が未検証のため総合スコアが常に `null`）
設計: `docs/superpowers/specs/2026-08-15-restore-performance-scores-design.md` §5.1 / §9.1 / §9.2 / §9.3
計画: `docs/superpowers/plans/2026-08-17-pitch-formula-stage3.md` Task 7

**この文書は測定の記録であり、値の決定ではない。** `TAU_PITCH` / `W_EXTRA` の確定は
Task 9 が担う（理由は後述の「§5 τ が選べない」）。

---

## 1. 何を測ったか / 測っていないか

測った: `(TAU_PITCH, W_EXTRA)` の18候補（τ 6点 × W_EXTRA 3点）について、ground truth MIDI に
既知の摂動を与えたときの pitch の応答。設計 §5.1 の4条件を判定した。

**測っていない（測れない）:**

- **extra 分類が実在の採譜アーティファクトを除去できるか。** フェーズ1 は `perturb.py` が
  ground truth MIDI を直接加工するだけで**採譜器を通さない**ため、二重検出・倍音ゴースト・
  スプリアス・ペダル残響という分類対象のアーティファクトが1件も存在しない（設計 §9.3）。
  ここで測れるのは**偽陰性方向だけ**、すなわち「分類器が実際の弾き間違いを `extraNoise` に
  誤分類しないこと」である。
- **rhythm / tempo の指標。** 参照譜のグリッドは摂動元と同じ MIDI のオンセットから作った
  等間隔グリッドであり（設計 §9.2、`gridSource: "midi"`）、音楽的な拍ではない。
  **この harness で rhythm / tempo の数値は意味を持たない。** 判定に使っていない。
- **録音条件不変性**（設計 §5.2）。フェーズ2 に属する。

---

## 2. 実行したコマンド列

コード: `feat/pitch-formula-stage3` の `1ebbe7d`（`feat: derive the poc reference grid from
MIDI so phase 1 needs no audio`）に、本コミットの `poc/scripts/sweep_pitch_tau.py` を加えた状態。

入力は `poc/data/maestro-midi.zip`（MAESTRO v3.0.0 の MIDI zip、約 56 MiB）のみ。
音声・librosa・採譜チェックポイントはいずれも不要。

```bash
cd poc
python scripts/prepare_dataset.py --midi-only   # data/dataset/ を作る（設計 9.2）
python scripts/make_reference.py --midi-only    # out/reference/ を作る（MIDI 由来の等間隔グリッド）
python scripts/perturb.py                       # out/transcribed/ に 5曲 × 12条件 = 60 ファイル
python scripts/sweep_pitch_tau.py               # out/metrics/pitch-sweep.json
```

`make_reference.py` に `--midi-only` を付けないと `piece00.clean.wav` を読もうとして
`LibsndfileError` で落ちる（フェーズ1 は音声を持たない）。

`poc/out/` と `poc/data/` は `poc/.gitignore` で除外されているため、`pitch-sweep.json` は
リポジトリに入らない。**本文書がその内容の記録である。**

**再現性について**: `perturb.py` は摂動ごとに `RNG_SEED = 20260725` で乱数を初期化するので、
摂動 MIDI は決定的である。掃引を一度破棄して上記4コマンドを頭から再実行し、18候補 × 12条件の
216 セル全部で**前回値との最大絶対差 0.0** を確認した（詳細は §7）。

---

## 3. 使用したデータ

MAESTRO v3.0.0 の MIDI から先頭 90 秒を切り出した5曲。すべて `audio: false`（MIDI のみ）。

| piece | 元 MIDI | 窓 [s] | 長さ [s] | 音符数 | ペダル CC 数 | 小節数 | グリッド由来 |
|---|---|---|---|---|---|---|---|
| piece00 | 2004/MIDI-Unprocessed_SMF_02_R1_2004_01-05_ORIG_MID--AUDIO_02_R1_2004_05_Track05_wav.midi | 1.093–91.093 | 90.0 | 753 | 1388 | 45 | midi |
| piece01 | 2004/MIDI-Unprocessed_SMF_02_R1_2004_01-05_ORIG_MID--AUDIO_02_R1_2004_06_Track06_wav.midi | 1.032–91.032 | 90.0 | 362 | 640 | 45 | midi |
| piece02 | 2004/MIDI-Unprocessed_SMF_02_R1_2004_01-05_ORIG_MID--AUDIO_02_R1_2004_08_Track08_wav.midi | 1.023–91.023 | 90.0 | 1131 | 911 | 45 | midi |
| piece03 | 2004/MIDI-Unprocessed_SMF_02_R1_2004_01-05_ORIG_MID--AUDIO_02_R1_2004_10_Track10_wav.midi | 1.058–91.058 | 90.0 | 1782 | 1631 | 45 | midi |
| piece04 | 2004/MIDI-Unprocessed_SMF_05_R1_2004_01_ORIG_MID--AUDIO_05_R1_2004_02_Track02_wav.midi | 0.986–90.986 | 90.0 | 1446 | 632 | 45 | midi |

参照音符 合計 **5474**。全曲 `estimatedTempo` = 120.0 BPM、`beatsPerMeasure` = 4、45 小節。
MAESTRO の MIDI は 120 BPM / 4-4 固定のプレースホルダなので、この 120 は楽譜のテンポではない
（設計 §9.2）。グリッドは MIDI オンセットからの等間隔16分割。

`prepare_dataset.py` のログは piece00 を `notes=754` と表示するが、書き出された
`piece00.ref.mid` と参照譜 JSON はいずれも 753 音である（ログ表示側の1音のずれ。
参照譜・摂動 MIDI・掃引はすべて 753 で一貫しており、測定には影響しない）。

摂動は `perturb.py` の 12 条件（`none` / `drop05` / `drop15` / `add05` / `add15` /
`jitter30` / `jitter80` / `tempo05` / `tempo15` / `flat50` / `flat90` / `nopedal`）。
ファイル名は `pieceNN.p_<condition>.mid` で、掃引側は先頭の `p_` を剥がして設計 §5.1 の
条件名に正規化する（`normalize_condition()`）。

**設計 §5.1 の条件2は「`drop 5%` と `drop 10%`」と書いているが `drop10` は存在しない**
（`drop` は 5% と 15% の2点）。条件2 の趣旨は「摂動率が低いほど点が高い」なので、
率で並べた最小（`drop05`）と最大（`drop15`）を比較して判定した。

---

## 4. 掃引の結果

pitch は5曲の値の単純平均（掃引ハーネスが曲ごとの pitch を条件単位に畳んだもの）。
判定は設計 §5.1 の4条件。

- c1 = `none` で pitch ≥ 90
- c2 = `drop05` > `drop15`
- c3 = `add05` < `none`
- c4 = 摂動率で並べて単調非増加（`drop` 系・`add` 系それぞれ）

| τ | W_EXTRA | none | drop05 | drop15 | add05 | add15 | c1 | c2 | c3 | c4 | 判定 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 0.15 | 0.3 | 99.90 | 77.20 | 42.33 | 91.63 | 76.23 | ✅ | ✅ | ✅ | ✅ | **PASS** |
| 0.15 | 0.5 | 99.85 | 77.14 | 42.27 | 87.03 | 64.43 | ✅ | ✅ | ✅ | ✅ | **PASS** |
| 0.15 | 0.7 | 99.80 | 77.10 | 42.22 | 82.96 | 54.90 | ✅ | ✅ | ✅ | ✅ | **PASS** |
| 0.20 | 0.3 | 99.92 | 81.72 | 51.34 | 93.54 | 81.40 | ✅ | ✅ | ✅ | ✅ | **PASS** |
| 0.20 | 0.5 | 99.88 | 81.68 | 51.29 | 89.86 | 71.52 | ✅ | ✅ | ✅ | ✅ | **PASS** |
| 0.20 | 0.7 | 99.84 | 81.64 | 51.24 | 86.51 | 63.14 | ✅ | ✅ | ✅ | ✅ | **PASS** |
| 0.25 | 0.3 | 99.94 | 84.75 | 58.04 | 94.74 | 84.73 | ✅ | ✅ | ✅ | ✅ | **PASS** |
| 0.25 | 0.5 | 99.90 | 84.72 | 58.00 | 91.67 | 76.27 | ✅ | ✅ | ✅ | ✅ | **PASS** |
| 0.25 | 0.7 | 99.87 | 84.68 | 57.95 | 88.84 | 68.88 | ✅ | ✅ | ✅ | ✅ | **PASS** |
| 0.30 | 0.3 | 99.95 | 86.93 | 63.17 | 95.56 | 87.04 | ✅ | ✅ | ✅ | ✅ | **PASS** |
| 0.30 | 0.5 | 99.92 | 86.89 | 63.13 | 92.94 | 79.67 | ✅ | ✅ | ✅ | ✅ | **PASS** |
| 0.30 | 0.7 | 99.89 | 86.86 | 63.10 | 90.47 | 73.09 | ✅ | ✅ | ✅ | ✅ | **PASS** |
| 0.35 | 0.3 | 99.95 | 88.56 | 67.21 | 96.16 | 88.75 | ✅ | ✅ | ✅ | ✅ | **PASS** |
| 0.35 | 0.5 | 99.93 | 88.53 | 67.17 | 93.87 | 82.22 | ✅ | ✅ | ✅ | ✅ | **PASS** |
| 0.35 | 0.7 | 99.90 | 88.50 | 67.14 | 91.70 | 76.30 | ✅ | ✅ | ✅ | ✅ | **PASS** |
| 0.40 | 0.3 | 99.96 | 89.83 | 70.46 | 96.62 | 90.06 | ✅ | ✅ | ✅ | ✅ | **PASS** |
| 0.40 | 0.5 | 99.94 | 89.80 | 70.43 | 94.58 | 84.20 | ✅ | ✅ | ✅ | ✅ | **PASS** |
| 0.40 | 0.7 | 99.91 | 89.78 | 70.40 | 92.64 | 78.83 | ✅ | ✅ | ✅ | ✅ | **PASS** |

### 合格した候補

**18 / 18 すべて**が4条件に合格した。すなわち合格した候補は掃引したグリッド全体である。

```
tau ∈ {0.15, 0.20, 0.25, 0.30, 0.35, 0.40} × W_EXTRA ∈ {0.3, 0.5, 0.7}
```

**これは「どの候補も良い」という結果ではなく、「この4条件では候補を区別できない」という
結果である**（§5）。

### pitch 以外の摂動条件（判定外・参考）

判定には使っていないが、pitch が pitch 以外の摂動にどう反応するかの記録。

| condition | pitch (τ=0.15, W=0.7) | pitch (τ=0.25, W=0.5) |
|---|---|---|
| none | 99.80 | 99.90 |
| jitter30 | 99.61 | 99.74 |
| jitter80 | 98.41 | 98.99 |
| tempo05 | 99.80 | 99.90 |
| tempo15 | 99.80 | 99.90 |
| flat50 | 99.80 | 99.90 |
| flat90 | 99.80 | 99.90 |
| nopedal | 99.80 | 99.90 |

`tempo` / `flat` / `nopedal` は pitch を `none` と完全に一致させる（音高の集合を変えないため）。
`jitter` はわずかに下げる（オンセットのゆらぎでアライメント窓を外れる音が出る）。
**繰り返すが、この harness の rhythm / tempo 指標は意味を持たないため、これらの条件は
リズム系指標の検証には使えない。** 上の表は pitch の直交性の参考値にすぎない。

---

## 5. τ が選べない — 4条件は τ に依存しない

**18通り全部が合格したのは偶然ではなく、条件の作り方の必然である。**

pitch は `100 · exp(−e_pitch / τ)` であり、τ > 0 のもとで `e_pitch` に対して**厳密減少**する。
したがって τ をどう変えても `e_pitch` の順序は pitch の順序にそのまま保存される。

- **条件2・3・4 は順序の比較しかしていない**（`drop05` > `drop15`、`add05` < `none`、単調性）。
  小節単位で見れば `e_pitch` の順序は τ に依存しないので、これらの条件は **τ を一切
  制約しない**。実測でも、6つの τ すべてで条件2〜4 の判定が同一だった（§4 の表）。
  なお集計 pitch は小節ごとの pitch を `refNotes` で重み付け平均した量なので、
  τ 非依存が厳密に言えるのは小節単位である。集計値での順序保存は上記のとおり実測で確認した。
- **条件1 も τ を制約しない。** `none` の `e_pitch` はほぼ 0（後述のとおり誤差は5曲 5474 音で
  missed 0 / extraPlayed 1）なので、どの τ でも pitch は 100 近傍になる。実測 99.80〜99.96。

つまり**フェーズ1 の4条件が検証しているのは τ の値ではなく、分類の向き**である
（弾き間違いを `extraNoise` に飲み込まないこと ＝ 条件3、設計 §5.1 の主眼）。
**フェーズ1 では τ を決められない。** これは設計 §9.3 が事前に述べていたことと一致する。

W_EXTRA についても同様に、4条件は「`add` で下がる」という向きだけを要求しており、
0.3 / 0.5 / 0.7 のどれを選ぶかは決めない。

**`TAU_PITCH` / `W_EXTRA` の確定は脚2（実録音の採譜、設計 §9.3 / Task 8）と
Task 9 が担う。** 実データでの `noiseShare` と pitch の水準が実質的な選択基準になる。

---

## 6. 条件3 の実体 — 分類の内訳

条件3（`add` で pitch が下がる）が成立した理由を、pitch の値ではなく分類の実数で記録する。
以下は τ / W_EXTRA に依存しない量である（アライメントと分類だけで決まる）。5曲の合計。

| condition | 参照音符 | matched | missed | unplayed | extraPlayed | extraNoise | 摂動 MIDI の音符数（増減） |
|---|---|---|---|---|---|---|---|
| none | 5474 | 5473 | 0 | 1 | 1 | 0 | 5474 (±0) |
| drop05 | 5474 | 5212 | 261 | 1 | 1 | 0 | 5213 (−261) |
| drop15 | 5474 | 4663 | 808 | 3 | 2 | 0 | 4665 (−809) |
| add05 | 5474 | 5472 | 1 | 1 | 251 | 14 | 5737 (+263) |
| add15 | 5474 | 5472 | 1 | 1 | 753 | 56 | 6281 (+807) |

**`add` で注入した誤打がどれだけ計上されたか:**

「飲まれた率」は `extraNoise / (extraPlayed + extraNoise)`。

| condition | 注入した音符 | extraPlayed に残った | extraNoise に飲まれた | 飲まれた率 |
|---|---|---|---|---|
| add05 | 263 | 251 | 14 | 14/265 = 5.3% |
| add15 | 807 | 753 | 56 | 56/809 = 6.9% |

（extraPlayed + extraNoise が注入数を 2 上回るのは、`none` にもある境界由来の 1 音と、
注入音に押し出されて一致を失った実音 1 音の分。`add` で `missed` が 0 → 1 に増えているのが
後者にあたる。）

**`extraNoise` の理由別内訳:**

| condition | duplicate | harmonic | spurious | reverb |
|---|---|---|---|---|
| add05 | 2 | 0 | 11 | 1 |
| add15 | 4 | 0 | 51 | 1 |

**`harmonic` が両条件で 0 件**であることは重要である。ブリーフが警告していたのは
「隣接半音の誤打（`abs(diff) == 1`）が規則2 のオクターブ判定（`abs(diff) == 12`）に
誤って該当する」バグだが、それは起きていない。

飲まれた分の大半は `spurious`（`duration < 60ms` かつ `velocity < 40`、`align.py` の
`NOISE_SPURIOUS_DURATION_SEC` / `NOISE_SPURIOUS_VELOCITY`）である。`perturb.py` の
`add_notes()` は元の音符の `start` / `end` をそのまま複製し velocity を 10 下げるので、
**元が短くて弱い音の誤打はスプリアス閾値に落ちる**。これは分類規則の設計どおりの挙動で、
バグではない。ただし **5〜7% の弾き間違いは計上されない**という定量的な限界であり、
記録に残す。これらの閾値自体は設計 §4.2 / §9.3 のとおり**暫定値でフェーズ2 で確定する**。

**条件1 が満点にならない分の内訳**（設計 §5.1 条件1 が「参照譜の量子化などの系統誤差」
として認めている分）: 5曲 5474 音のうち piece01 の最終音（pitch 52、`startBeat` 178.6875、
第45小節、est 側 89.336–90.000 秒）1音のみ。DTW のどの run にも覆われず `unplayed` になり、
est 側の対応音が `extraPlayed` に落ちる。90 秒窓の末尾の境界効果である。
これが `none` の pitch を 100 から 0.04〜0.20 点下げている唯一の原因。

---

## 7. 再実行による突き合わせ

先行の測定は掃引スクリプトの最終編集より古い出力だったため、**成果物とコードの対応を
保証するために掃引を破棄して頭から再実行した**（`poc/data/dataset` / `poc/out/reference` /
`poc/out/transcribed` / `poc/out/metrics/pitch-sweep.json` を消してから §2 の4コマンド）。

- 参照譜は完全に再現（音符数 753 / 362 / 1131 / 1782 / 1446、45 小節、120.0 BPM）
- 掃引は 18候補 × 12条件 = 216 セルすべてで**前回値との最大絶対差 0.0**
- 18候補の `passed` も全一致

差分は条件ラベルだけだった。旧 JSON は `rows` に `p_none` / `p_drop05` のような生の
条件名を持っており、正規化を `normalize_condition()` に切り出す前の版の出力であることが
確認できた。**数値は変わっていない。**

掃引の標準出力（再実行分、18行）:

```
tau=0.15 w_extra=0.3 none=99.9 c1=True c2=True c3=True c4=True => PASS
tau=0.15 w_extra=0.5 none=99.846 c1=True c2=True c3=True c4=True => PASS
tau=0.15 w_extra=0.7 none=99.798 c1=True c2=True c3=True c4=True => PASS
tau=0.2 w_extra=0.3 none=99.924 c1=True c2=True c3=True c4=True => PASS
tau=0.2 w_extra=0.5 none=99.88 c1=True c2=True c3=True c4=True => PASS
tau=0.2 w_extra=0.7 none=99.84 c1=True c2=True c3=True c4=True => PASS
tau=0.25 w_extra=0.3 none=99.938 c1=True c2=True c3=True c4=True => PASS
tau=0.25 w_extra=0.5 none=99.9 c1=True c2=True c3=True c4=True => PASS
tau=0.25 w_extra=0.7 none=99.86800000000001 c1=True c2=True c3=True c4=True => PASS
tau=0.3 w_extra=0.3 none=99.94800000000001 c1=True c2=True c3=True c4=True => PASS
tau=0.3 w_extra=0.5 none=99.916 c1=True c2=True c3=True c4=True => PASS
tau=0.3 w_extra=0.7 none=99.886 c1=True c2=True c3=True c4=True => PASS
tau=0.35 w_extra=0.3 none=99.954 c1=True c2=True c3=True c4=True => PASS
tau=0.35 w_extra=0.5 none=99.928 c1=True c2=True c3=True c4=True => PASS
tau=0.35 w_extra=0.7 none=99.9 c1=True c2=True c3=True c4=True => PASS
tau=0.4 w_extra=0.3 none=99.96000000000001 c1=True c2=True c3=True c4=True => PASS
tau=0.4 w_extra=0.5 none=99.936 c1=True c2=True c3=True c4=True => PASS
tau=0.4 w_extra=0.7 none=99.912 c1=True c2=True c3=True c4=True => PASS

18/18 candidate(s) passed all four criteria
NOTE: phase 1 does not exercise transcription, so it cannot show whether the
      extra classifier removes real artifacts (design 9.3). That is leg 2.
```

---

## 8. 結論と次の一手

**フェーズ1（脚1）は通った。** 設計 §5.1 の4条件が18候補すべてで成立し、とくに主眼の条件3
について、注入した隣接半音の誤打の 93〜95% が `extraPlayed` に残り `harmonic` 誤分類は
0 件だった。**extra 分類は弾き間違いを飲み込んでいない。**

**ただしフェーズ1 は `TAU_PITCH` / `W_EXTRA` を決めない。** 4条件は τ に依存しない順序比較で
構成されており、18通り全部が合格するのは想定どおりである（§5）。

未解決のまま次に渡すもの:

1. **`TAU_PITCH` / `W_EXTRA` の値** → 脚2（Task 8、実録音の採譜）と Task 9
2. **extra 分類が実在の採譜アーティファクトを除去できるか** → 脚2。フェーズ1 には
   アーティファクトが存在しないため原理的に測れない（設計 §9.3）
3. **分類閾値（`NOISE_*`）の確定** → フェーズ2（設計 §4.2 / §5.2 条件5）。現在の値は
   実測根拠のない暫定値であり、上記の「誤打 5〜7% がスプリアスに落ちる」もこの暫定値の下での数字
4. **rhythm / tempo の検証と録音条件不変性** → フェーズ2（設計 §5.2）
