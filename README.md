# Ledger Lines — AI Piano Practice Coach

> **「弾きっぱなしにしない。1曲を仕上げるためのAI練習コーチ。」**

自分の楽譜と、アコースティックでも電子でもいいピアノ。
**録音するだけ**で、どの小節が弱いか・前回からどう良くなったかを可視化し、
今日やるべき練習メニューを提示します。

MIDI出力のある電子ピアノは不要です（マイク録音 → AI採譜）。

---

## このリポジトリの現状

**PoV（Proof of Value）モック**です。
全画面が動きますが、**分析結果はすべてダミーデータ**（決定的な擬似乱数で生成）で、
バックエンド・AI推論・録音の実処理は含まれていません。
「この体験に価値があるか」を通しで確認するためのものです。

## コンセプト / 差別化の3本柱

| | 内容 |
|---|---|
| **Deep Analysis** | リアルタイム採点ではなく、録音後にオフラインでじっくり分析。音程 / リズム / テンポ安定 / ダイナミクス / ペダル / アーティキュレーションを**小節単位**でスコア化 |
| **Longitudinal Growth** | テイク履歴、小節別ヒートマップの推移、A/B比較。**改善していない「停滞小節」を自動検出** |
| **AI Coach** | Azure AI Foundry のモデルに構造化指標＋楽曲コンテキストを渡し、自然言語の講評と**今日の練習メニュー**を生成。チャットで質問も可能 |

補助機能として**先生との共有**（分析レポート共有リンク、小節ピン留めコメント、課題管理）を持ちます。

## 画面一覧

| パス | 画面 | 内容 |
|---|---|---|
| `/` | ダッシュボード | 練習中の曲、スコア推移、連続練習日数、今日のおすすめ練習 |
| `/songs` | 曲ライブラリ | 登録曲の一覧と進捗 |
| `/songs/new` | 曲を追加 | MusicXML/MIDIアップロード（PDF→OMRは将来対応） |
| `/songs/[id]` | 曲詳細 | 楽譜＋小節ヒートマップ、テイク一覧、停滞小節 |
| `/record` | 録音 | カウントイン → 録音 → アップロード → 解析ステップの体験 |
| `/takes/[id]` | 分析結果 | AI講評、指標レーダー、楽譜ヒートマップ、ピアノロール、テンポ/ダイナミクス、指摘一覧 |
| `/coach` | AIコーチ | 講評、練習メニュー、チャット |
| `/progress` | 履歴・比較 | 指標の時系列、テイクA/B比較、小節別改善ヒートマップ |
| `/share` | 先生と共有 | 共有リンク、先生コメントスレッド、課題管理 |

## 起動方法

```bash
npm install
npm run dev
# http://localhost:3000
```

その他:

```bash
npm run build   # 本番ビルド
npm run lint    # ESLint
npx tsc --noEmit
```

ローカルで Azure データ層を使う場合の推奨は、Bicep/azd で分離した dev/stg
リソースを作成し、Next.js だけをローカル起動する Cloud-backed プロファイルです。
`az login` の Azure CLI 資格情報と RBAC を使い、実データが保存されるため環境を
分離してください。手順と Preflight は [Cloud-backed ローカル Azure 開発](./docs/operations/local-azure-cloud.md)、
オフラインの Azurite/Cosmos エミュレーター fallback は
[エミュレーター ローカル開発](./docs/operations/local-azure.md)を参照してください。

## Azure リソース（Bicep + azd）

Azure のデータ・監視・シークレット基盤は `infra/main.bicep` とモジュールで実装済みです。
`azure.yaml` から `azd provision` を実行すると、環境ごとの Storage、Cosmos DB
Serverless、Log Analytics / Application Insights、Key Vault、Managed Identity / RBAC
をリソースグループ単位で管理できます。シークレットはコミットせず、アプリは
Managed Identity と Key Vault RBAC を使用します。

```powershell
azd auth login
azd env new ledgerlines-dev
azd env set AZURE_SUBSCRIPTION_ID <subscription-id>
azd env set AZURE_LOCATION japaneast
azd env set AZURE_RESOURCE_GROUP ledgerlines-dev-rg
azd provision
```

変更前の確認は `az deployment group what-if` を使います。stg / prod のパラメータ例、
環境切り替え、Foundry の任意有効化、削除手順は
[Azure リソース管理](./docs/operations/azure-iac.md) を参照してください。
Next.js と Python ワーカーのイメージは未作成のため、Container Apps のホスティングと
アプリデプロイは別作業です。`azure.yaml` に追加位置をコメントで明示しています。

## 技術スタック（モック）

- Next.js 16 (App Router) / React 19 / TypeScript
- Tailwind CSS v4
- [OpenSheetMusicDisplay](https://opensheetmusicdisplay.org/) — MusicXML 楽譜描画
- Recharts — グラフ
- lucide-react — アイコン

データ層は `src/lib/mock/` に集約しています。

- `types.ts` — 全型定義と6評価指標
- `generate.ts` — 習熟度から分析結果を決定的に生成（SSR/CSRで一致させるためシード固定LCG）
- `data.ts` — 4曲・10テイク・先生コメント・課題・練習ログとセレクタ

サンプル楽譜 `public/scores/etude-in-a-minor.musicxml` は著作権回避のため
`scripts/gen-score.mjs` で自作した16小節の練習曲です。

## 本実装の想定アーキテクチャ

```
Browser (Next.js / MediaRecorder)
   └─ 音声アップロード → Azure Blob Storage
        └─ 解析ワーカー (Azure Container Apps, Python)
             1. 採譜: piano_transcription_inference (ByteDance) / Basic Pitch
             2. 楽譜アライメント: DTW による audio(MIDI)-to-score alignment
             3. 指標算出: 音程 / リズム / テンポ安定 / ダイナミクス / ペダル / アーティキュレーション
             4. Azure AI Foundry → 講評 + 練習メニュー生成
        └─ 結果 → Cosmos DB（演奏履歴・指標・コメント）
   └─ 認証: Microsoft Entra ID
```

## ロードマップ

- [x] M1: コンセプト確定（競合調査・差別化定義）
- [x] M2: PoVモック実装
- [x] M3: 仕様・設計（機能仕様、指標定義、分析パイプライン、データモデル、AIプロンプト、API、Azureアーキテクチャ）
- [x] M4: 分析エンジンPoC（実音源での採譜＋アライメント精度検証）
- [x] M4.5: 未検証課題の解消（弾き直し対応・ONNX 化・差分の安定性）← **いまここ**
- [ ] M5: 本実装

### M4 でわかったこと

MAESTRO データセットの実録音を使い、設計の前提を検証しました。
詳細は [M4 検証レポート](./docs/poc/m4-report.md)。

| 検証項目 | 結果 |
|---|---|
| CPU での採譜 | **可能だが遅い**。RTF 1.25。3分の曲に約4.3分 → **解析は非同期・完了通知の設計に変更** |
| マイク録音でのペダル検出 | **想定より良い**。劣化条件でも F1 0.81 → **MVP に採用** |
| 楽譜アライメント | F1 0.962、弾き逃しの誤検出 **0.4%** |
| アーティキュレーション | **不可能**。消音時刻に +300ms のバイアス → **MVP から削除（6指標 → 5指標）** |
| 絶対スコアの安定性 | **不安定**。録音環境だけで総合 89 → 61 → **UI は前回比を主役にする設計に変更** |

### M4.5 でわかったこと

M4 が「M5 の最優先課題」として残した3件を、実装に入る前に片付けました。
詳細は [M4.5 検証レポート](./docs/poc/m45-report.md)。

| 検証項目 | 結果 |
|---|---|
| 弾き直し・部分練習 | DTW に**跳躍**を導入して解決。最悪ケースで **F1 0.400 → 0.959**。通常演奏の劣化は −0.004 以内 |
| 途中で止まる演奏 | **元から問題なかった**（単調性が保たれるため） |
| ONNX 化 | **約2倍速・出力ビット一致**。RTF 1.25 → 0.63、コスト 16.15万 → **11.88万円** |
| int8 量子化 | **逆効果**。Conv 主体のモデルで最大9倍遅い → **不採用** |
| 差分の安定性 | 同一演奏の再録音で総合スコアの σ ≒ 2.2〜3.0、**最小検出差 6〜8点**。`pedal` が最も安定、`pitch` が最も不安定（MDD 11〜20点） → **UI に「横ばい」判定と信頼区間を追加** |

## 設計ドキュメント

M3・M4・M4.5 の成果物は [`docs/`](./docs/README.md) にあります。

| ドキュメント | 内容 |
|---|---|
| [機能仕様](./docs/spec/functional.md) | 設計原則、ユーザーストーリー、機能要件、受け入れ条件 |
| [評価指標定義](./docs/spec/metrics.md) | 5指標の算出式、N/A 判定、停滞小節検出、較正計画 |
| [API仕様](./docs/spec/api.md) | REST エンドポイント、エラー体系、認証、レート制限 |
| [分析パイプライン設計](./docs/design/analysis-pipeline.md) | 採譜モデル選定、2段階アライメント、BeatMap |
| [データモデル設計](./docs/design/data-model.md) | Cosmos DB のコンテナ・パーティション設計 |
| [AIプロンプト設計](./docs/design/ai-prompts.md) | プロンプト、Structured Outputs、出力検証、評価 |
| [Azureアーキテクチャ設計](./docs/design/architecture.md) | サービス選定、スケーリング、セキュリティ、コスト試算 |
| [**M4 検証レポート**](./docs/poc/m4-report.md) | 実音源での検証結果と、それによる設計変更 |
| [**M4.5 検証レポート**](./docs/poc/m45-report.md) | 弾き直し対応・ONNX 化・差分の安定性 |

## 分析エンジン PoC

`poc/` に M4 / M4.5 の検証スクリプト一式があります。実行手順は
[M4 検証レポート 8章](./docs/poc/m4-report.md#8-再現手順) と
[M4.5 検証レポート 5章](./docs/poc/m45-report.md#5-再現手順) を参照してください。

| スクリプト | 役割 |
|---|---|
| `extract_maestro.py` / `prepare_dataset.py` | MAESTRO から評価用データセットを構築 |
| `degrade.py` | 録音条件の劣化シミュレーション（残響・ノイズ・帯域制限・AGC） |
| `transcribe.py` / `evaluate_transcription.py` | 採譜と精度評価 |
| `make_reference.py` / `align.py` / `evaluate_alignment.py` | 参照譜生成・楽譜アライメント・精度評価 |
| `perturb.py` | 12種類の摂動演奏を生成（指標の感度検証用） |
| `compute_metrics.py` / `summarize_metrics.py` | 指標算出と集計 |
| `estimate_quality.py` | 録音品質から採譜精度を予測できるかの検証 |
| `perturb_replay.py` / `evaluate_replay.py` | 弾き直し・停止・部分練習の摂動生成とアライメント評価（M4.5） |
| `sweep_jump.py` | 跳躍ペナルティの掃引（M4.5） |
| `export_onnx.py` / `transcribe_onnx.py` | ONNX エクスポート・量子化比較と ONNX Runtime での採譜（M4.5） |
| `stability_gen.py` / `stability_report.py` | 差分の測定ノイズ（σ・最小検出差）の推定（M4.5） |
