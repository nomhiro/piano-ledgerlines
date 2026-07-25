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
| `/takes/[id]` | 分析結果 | AI講評、6指標レーダー、楽譜ヒートマップ、ピアノロール、テンポ/ダイナミクス、指摘一覧 |
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
- [x] M3: 仕様・設計（機能仕様、指標定義、分析パイプライン、データモデル、AIプロンプト、API、Azureアーキテクチャ）← **いまここ**
- [ ] M4: 分析エンジンPoC（実音源での採譜＋アライメント精度検証）
- [ ] M5: 本実装

## 設計ドキュメント

M3 の成果物は [`docs/`](./docs/README.md) にあります。

| ドキュメント | 内容 |
|---|---|
| [機能仕様](./docs/spec/functional.md) | 設計原則、ユーザーストーリー、機能要件、受け入れ条件 |
| [評価指標定義](./docs/spec/metrics.md) | 6指標の算出式、N/A 判定、停滞小節検出、較正計画 |
| [API仕様](./docs/spec/api.md) | REST エンドポイント、エラー体系、認証、レート制限 |
| [分析パイプライン設計](./docs/design/analysis-pipeline.md) | 採譜モデル選定、2段階アライメント、BeatMap |
| [データモデル設計](./docs/design/data-model.md) | Cosmos DB のコンテナ・パーティション設計 |
| [AIプロンプト設計](./docs/design/ai-prompts.md) | プロンプト、Structured Outputs、出力検証、評価 |
| [Azureアーキテクチャ設計](./docs/design/architecture.md) | サービス選定、スケーリング、セキュリティ、コスト試算 |
