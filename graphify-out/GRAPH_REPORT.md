# Graph Report - .  (2026-08-06)

## Corpus Check
- 143 files · ~81,475 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 1140 nodes · 2315 edges · 82 communities (69 shown, 13 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 22 edges (avg confidence: 0.89)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Song API Routes
- Azure System Architecture
- Alignment PoC Pipeline
- Coach Progress Pages
- TypeScript Build Configuration
- Song Upload Results
- Score Visualization Components
- AI Coaching Services
- Recording Analysis Flow
- Azure Local Smoke Tests
- Application Dependencies
- Audio Degradation Pipeline
- Graphify Core Concepts
- Production AI Coach
- Replay Perturbation Validation
- Frontend Development Tooling
- Alignment Evaluation Tools
- Application Views
- Repository Service Interface
- Performance Metric Computation
- Infrastructure Main Parameters
- Development Environment Parameters
- Production Environment Parameters
- Staging Environment Parameters
- Azure Package Scripts
- Azure Cloud Bootstrap
- Mock Take Generation
- Audio Preprocessing
- ONNX Model Export
- MIDI Perturbation Tools
- Azure Identity Queue
- Telemetry Observability
- Worker Alignment Engine
- Worker Metrics Engine
- Analysis Pipeline Stages
- Cosmos Repository
- Worker CLI Orchestration
- Transcription Evaluation
- Dataset Preparation
- Progress Chart Components
- Local Blob Storage
- Legato Analysis
- Note Offset Analysis
- MAESTRO Dataset Extraction
- Local Azure Management
- Worker Path Resolution
- Analysis Product Decisions
- Metric Scoring Framework
- Reference MIDI Generation
- Azure Blob Storage
- Domain IDs and States
- M5 Validation Scenarios
- Non Piano Noise Tests
- ONNX Transcription Runtime
- Measurement Confidence UX
- Server Domain Types
- Reference Score Builder
- Transcription Alignment Model
- Blob Store Interface
- Graphify Update Workflows
- Recording Quality Estimation
- Score Stability Analysis
- Transcription PoC Script
- Application Shell Layout
- M5 Vertical Slice
- Score Fixture Generator
- Practice Issue Generation
- Package Metadata
- Worker Transcription Adapter
- Metric Report Summary
- Document File Icon
- Application Window Icon
- Next.js Agent Instructions
- Azure Blob Dependency
- ESLint Configuration
- JWT Library Dependency
- Next.js Configuration
- PostCSS Configuration
- Globe Icon Asset
- Next.js Logo Asset
- Vercel Logo Asset
- Worker Package Overview

## God Nodes (most connected - your core abstractions)
1. `getConfig()` - 45 edges
2. `getAuthenticatedUser()` - 30 edges
3. `errorResponse()` - 29 edges
4. `jsonResponse()` - 27 edges
5. `assertResourceId()` - 25 edges
6. `getSong()` - 20 edges
7. `SongDoc` - 19 edges
8. `getBlobStore()` - 18 edges
9. `TakeDoc` - 18 edges
10. `getTake()` - 17 edges

## Surprising Connections (you probably didn't know these)
- `Azurite Emulator` --semantically_similar_to--> `azd Bicep Provisioning`  [INFERRED] [semantically similar]
  docker-compose.azure-local.yml → azure.yaml
- `M4.5 Script Suite` --references--> `M4.5 Validation`  [EXTRACTED]
  poc/README.md → docs/poc/m45-report.md
- `ScoreView()` --references--> `opensheetmusicdisplay`  [EXTRACTED]
  src/components/ScoreView.tsx → package.json
- `assertCloudProfile()` --calls--> `getConfig()`  [EXTRACTED]
  scripts/azure-cloud.ts → src/lib/server/config.ts
- `main()` --calls--> `createAzureCredential()`  [EXTRACTED]
  scripts/azure-cloud.ts → src/lib/server/azure-credential.ts

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Graphify Extraction and Build Flow** — _copilot_skills_graphify_skill_structural_extraction, _copilot_skills_graphify_skill_semantic_extraction, _copilot_skills_graphify_skill_graph_build, _copilot_skills_graphify_skill_graph_health_check [EXTRACTED 1.00]
- **Ledger Lines Product Pillars** — readme_deep_analysis, readme_longitudinal_growth, readme_ai_coach [EXTRACTED 1.00]
- **AI Coaching Safety Pipeline** — docs_design_ai_prompts_structured_coaching_context, docs_design_ai_prompts_take_review_prompt, docs_design_ai_prompts_output_validation, docs_design_ai_prompts_prompt_evaluation [EXTRACTED 1.00]
- **Analysis Stages** — docs_design_analysis_pipeline_s0_preprocessing, docs_design_analysis_pipeline_s1_reference_score_expansion, docs_design_analysis_pipeline_s2a_audio_transcription, docs_design_analysis_pipeline_s3_two_stage_alignment, docs_design_analysis_pipeline_s4_metric_scoring, docs_design_analysis_pipeline_s5_issue_generation, docs_design_analysis_pipeline_s6_ai_review [EXTRACTED 1.00]
- **Productionization Phases** — docs_productionization_task_list_p0_configuration_sdk_secrets, docs_productionization_task_list_p1_entra_authentication, docs_productionization_task_list_p2_cosmos_repositories, docs_productionization_task_list_p3_blob_uploads, docs_productionization_task_list_p4_async_worker_reliability, docs_productionization_task_list_p5_api_resilience, docs_productionization_task_list_p6_foundry_ai_coach, docs_productionization_task_list_p7_observability_security_quality [EXTRACTED 1.00]
- **MVP Metric Suite** — docs_spec_metrics_pitch_metric, docs_spec_metrics_rhythm_metric, docs_spec_metrics_tempo_metric, docs_spec_metrics_dynamics_metric, docs_spec_metrics_pedal_metric [EXTRACTED 1.00]
- **Window Icon Composition** — public_window_application_window_icon, public_window_rounded_window_frame, public_window_three_circular_indicators [EXTRACTED 1.00]

## Communities (82 total, 13 thin omitted)

### Community 0 - "Song API Routes"
Cohesion: 0.07
Nodes (86): GET(), POST(), runtime, DELETE(), GET(), PATCH(), runtime, POST() (+78 more)

### Community 1 - "Azure System Architecture"
Cohesion: 0.05
Nodes (47): Idempotent Analysis Jobs, Azure System Architecture, Bicep and azd Infrastructure as Code, Azure Container Apps, Cosmos DB Serverless, Distributed Observability, Managed Identity RBAC, Recording Data Durability (+39 more)

### Community 2 - "Alignment PoC Pipeline"
Cohesion: 0.10
Nodes (29): align(), cost_matrix(), dtw_path(), dtw_path_jump(), group_events(), load_est(), main(), _match_path() (+21 more)

### Community 3 - "Coach Progress Pages"
Cohesion: 0.14
Nodes (22): CoachPage(), ProgressPage(), SharePage(), SongDetailPage(), TakePage(), assignments, chopinLatestReview, coachChatSeed (+14 more)

### Community 4 - "TypeScript Build Configuration"
Cohesion: 0.07
Nodes (28): dom, dom.iterable, esnext, **/*.mts, .next/dev/types/**/*.ts, next-env.d.ts, .next/types/**/*.ts, node_modules (+20 more)

### Community 5 - "Song Upload Results"
Cohesion: 0.12
Nodes (19): Phase, STEPS, SEVERITY_COLOR, CoachView(), SUGGESTIONS, STATUS_META, SongSelector(), Badge() (+11 more)

### Community 6 - "Score Visualization Components"
Cohesion: 0.15
Nodes (19): MeasureHeatmap(), PianoRoll(), STATUS_STYLE, Overlay, ScoreView(), severityColor, severityLabel, ISSUE_LABELS (+11 more)

### Community 7 - "AI Coaching Services"
Cohesion: 0.10
Nodes (26): Deferred Application Services, azd Bicep Provisioning, Azurite Emulator, Cosmos DB Emulator, Coach Chat Prompt, Constrained LLM Coaching Role, Nonblocking AI Generation, AI Output Validation V1-V9 (+18 more)

### Community 8 - "Recording Analysis Flow"
Cohesion: 0.13
Nodes (21): RecordPage(), toRecordSong(), ANALYSIS_STEPS, MOCK_ANALYSIS_STEPS, Phase, RecordView(), STATUS_STEP_INDEX, SongManagementControls() (+13 more)

### Community 9 - "Azure Local Smoke Tests"
Cohesion: 0.14
Nodes (15): deterministicSmoke(), httpSmoke(), input, main(), SmokeBody, songDocPath(), takeDocPath(), takesDir() (+7 more)

### Community 10 - "Application Dependencies"
Cohesion: 0.10
Nodes (21): @azure/cosmos, @azure/identity, @azure/storage-queue, lucide-react, next, opensheetmusicdisplay, dependencies, @azure/cosmos (+13 more)

### Community 11 - "Audio Degradation Pipeline"
Cohesion: 0.18
Nodes (19): add_noise(), apply_agc(), build_conditions(), main(), make_room_ir(), mic_response(), normalize(), opus_roundtrip() (+11 more)

### Community 12 - "Graphify Core Concepts"
Cohesion: 0.11
Nodes (20): Optional Graph Exports, Confidence Provenance, Deterministic Node IDs, Semantic Hyperedges, Semantic Similarity Edges, Cross-repository Graph Merge, CLAUDE.md Graph Integration, BFS and DFS Graph Traversal (+12 more)

### Community 13 - "Production AI Coach"
Cohesion: 0.15
Nodes (14): input, Coach, CoachMetadata, CoachResult, CoachReview, coachReviewSchema, FallbackCoach, fallbackReview() (+6 more)

### Community 14 - "Replay Perturbation Validation"
Cohesion: 0.20
Nodes (17): ControlChange, main(), ndarray, 実録音を使った弾き直しの検証（M5 持ち越し課題3）。 perturb_replay.py は ground truth MIDI…, プランのセグメントに従って実音声を切り出し・結合する。, slice_audio(), load_gt(), main() (+9 more)

### Community 15 - "Frontend Development Tooling"
Cohesion: 0.11
Nodes (19): eslint, eslint-config-next, devDependencies, eslint, eslint-config-next, tailwindcss, @tailwindcss/postcss, tsx (+11 more)

### Community 16 - "Alignment Evaluation Tools"
Cohesion: 0.15
Nodes (16): load_notes(), main(), ndarray, Note, Path, アライメントの精度を測る。 正解対応は ground truth MIDI と採譜結果の照合から作る。 ref 音符 --(gtIndex)-->…, to_arrays(), truth_pairs() (+8 more)

### Community 17 - "Application Views"
Cohesion: 0.26
Nodes (16): DashboardPage(), SongsPage(), ProgressView(), ShareView(), SongDetailView(), TakeAnalysisView(), PageHeader(), daysUntil() (+8 more)

### Community 18 - "Repository Service Interface"
Cohesion: 0.14
Nodes (5): songsDir(), Repository, CreateSongInput, SongDoc, TakeDoc

### Community 19 - "Performance Metric Computation"
Cohesion: 0.23
Nodes (16): compute(), decay(), estimate_beat_map(), load_est(), main(), measure_seconds(), pedal_intervals(), pedal_ratio() (+8 more)

### Community 20 - "Infrastructure Main Parameters"
Cohesion: 0.12
Nodes (15): contentVersion, value, value, value, value, value, parameters, enableFoundry (+7 more)

### Community 21 - "Development Environment Parameters"
Cohesion: 0.12
Nodes (15): contentVersion, value, value, value, value, value, parameters, enableFoundry (+7 more)

### Community 22 - "Production Environment Parameters"
Cohesion: 0.12
Nodes (15): contentVersion, value, value, value, value, value, parameters, enableFoundry (+7 more)

### Community 23 - "Staging Environment Parameters"
Cohesion: 0.12
Nodes (15): contentVersion, value, value, value, value, value, parameters, enableFoundry (+7 more)

### Community 24 - "Azure Package Scripts"
Cohesion: 0.12
Nodes (16): scripts, azure:check, azure:cloud:check, azure:cloud:init, azure:cloud:start, azure:down, azure:health, azure:init (+8 more)

### Community 25 - "Azure Cloud Bootstrap"
Cohesion: 0.23
Nodes (15): assertCloudProfile(), checkDataPlane(), collectDeploymentOutputs(), initializeResources(), loadAzdOutputs(), loadDotEnv(), main(), normalized() (+7 more)

### Community 26 - "Mock Take Generation"
Cohesion: 0.24
Nodes (14): buildDynamicsCurve(), buildIssues(), buildRoll(), buildTake(), buildTempoCurve(), clamp(), ISSUE_TEMPLATES, makeRng() (+6 more)

### Community 27 - "Audio Preprocessing"
Cohesion: 0.19
Nodes (13): Exception, _dbfs(), decode_to_wav(), preprocess(), PreprocessError, Any, ndarray, Path (+5 more)

### Community 28 - "ONNX Model Export"
Cohesion: 0.28
Nodes (12): Module, compare(), export(), load_model(), main(), make_session(), Path, Tensor (+4 more)

### Community 29 - "MIDI Perturbation Tools"
Cohesion: 0.29
Nodes (14): add_notes(), apply(), clone(), drift_tempo(), drop_notes(), drop_pedal(), flatten_dynamics(), jitter_timing() (+6 more)

### Community 30 - "Azure Identity Queue"
Cohesion: 0.21
Nodes (7): createAzureCredential(), getTelemetry(), AnalysisJob, AnalysisQueue, AzureAnalysisQueue, LocalAnalysisQueue, runDeterministicAnalysis()

### Community 31 - "Telemetry Observability"
Cohesion: 0.20
Nodes (7): ConsoleTelemetry, NoopTelemetry, redactTelemetry(), redactValue(), TelemetryEvent, TelemetrySink, withTelemetry()

### Community 32 - "Worker Alignment Engine"
Cohesion: 0.21
Nodes (14): align(), cost_matrix(), dtw_path(), dtw_path_jump(), group_events(), load_est(), _match_path(), match_within() (+6 more)

### Community 33 - "Worker Metrics Engine"
Cohesion: 0.23
Nodes (14): compute(), decay(), estimate_beat_map(), load_est(), measure_seconds(), pedal_intervals(), pedal_ratio(), ndarray (+6 more)

### Community 34 - "Analysis Pipeline Stages"
Cohesion: 0.20
Nodes (14): Asynchronous Analysis Pipeline, S0 Preprocessing, S2b MIDI Passthrough, S4 Metric Scoring, S5 Rule-based Issue Generation, S6 AI Review Generation, Articulation Metric Rejection, AI Practice Coach (+6 more)

### Community 35 - "Cosmos Repository"
Cohesion: 0.29
Nodes (3): CosmosRepository, notFound(), timestamp()

### Community 36 - "Worker CLI Orchestration"
Cohesion: 0.37
Nodes (13): main(), mask_unavailable_pedal(), now_iso(), Path, 解析ワーカー CLI エントリポイント。 Next.js API (child_process.spawn) から2つのモードで呼ばれる。 --mode…, reference.py は現状MusicXMLからペダル記号を抽出していないため、 pedal指標は「測定不能(N/A)」として扱い、加重平均から除外する。…, read_json(), run_analyze() (+5 more)

### Community 37 - "Transcription Evaluation"
Cohesion: 0.27
Nodes (12): binary_prf(), evaluate_pair(), main(), match_notes(), notes_of(), pedal_frames(), ndarray, Path (+4 more)

### Community 38 - "Dataset Preparation"
Cohesion: 0.23
Nodes (12): find_onset_start(), load_manifest_entries(), main(), midi_name_from_id(), ndarray, Path, PrettyMIDI, MAESTRO の抽出済み音声と MIDI zip から、PoC 用データセットを組み立てる。 各曲について - 冒頭の無音を避けた位置から一定秒数を切り出す… (+4 more)

### Community 39 - "Progress Chart Components"
Cohesion: 0.21
Nodes (11): AXIS, DynamicsChart(), MeasureDeltaBar(), MetricRadar(), MultiMetricTrend(), PracticeBar(), ScoreTrend(), TempoCurveChart() (+3 more)

### Community 40 - "Local Blob Storage"
Cohesion: 0.23
Nodes (4): BlobUploadOptions, LocalBlobStore, localPath(), UploadGrant

### Community 41 - "Legato Analysis"
Cohesion: 0.31
Nodes (10): evaluate(), find_successor_pairs(), main(), notes_of(), pedal_intervals(), ndarray, Path, PrettyMIDI (+2 more)

### Community 42 - "Note Offset Analysis"
Cohesion: 0.31
Nodes (9): analyse(), main(), notes_of(), overlaps_pedal(), pedal_intervals(), Path, PrettyMIDI, offset（離鍵）の推定精度を掘り下げ、articulation 指標が成立するかを判定する。 note_off_f1… (+1 more)

### Community 43 - "MAESTRO Dataset Extraction"
Cohesion: 0.25
Nodes (10): iter_fields(), iter_records(), main(), parse_example(), Path, MAESTRO の TFRecord シャードから音声と ID を取り出す。 標準ライブラリのみで動く。TFRecord のレコード枠と…, (field_number, wire_type, payload) を順に返す。, tf.train.Example を {key: [values]} に展開する。 (+2 more)

### Community 44 - "Local Azure Management"
Cohesion: 0.36
Nodes (10): checkConfig(), checkHttp(), checkPort(), envFile, health(), init(), loadEnv(), main() (+2 more)

### Community 45 - "Worker Path Resolution"
Cohesion: 0.25
Nodes (8): DATA_DIR, REPO_ROOT, WORKER_DIR, WORKER_MAIN, resolvePythonPath(), runAnalyzeWorkerAsync(), RunResult, runWorker()

### Community 46 - "Analysis Product Decisions"
Cohesion: 0.20
Nodes (10): AGC Detection, Asynchronous Processing Decision, M4 Analysis Engine PoC, Relative-score-first UI, Microphone Transcription Accuracy, Browser Recording, Absolute Score Caveat, M4.5 Script Suite (+2 more)

### Community 47 - "Metric Scoring Framework"
Cohesion: 0.20
Nodes (10): Dynamics Metric, Exponential Penalty Function, Five Metric Weights, Not-applicable Metric Handling, Pedal Metric, Perceptual Dead Zone, Performance Metrics Framework, Pitch Accuracy Metric (+2 more)

### Community 48 - "Reference MIDI Generation"
Cohesion: 0.31
Nodes (9): assign_measures(), build_reference(), estimate_beat_grid(), main(), ndarray, PrettyMIDI, ground truth の演奏 MIDI から「楽譜相当」の参照譜を作る。 MAESTRO…, 音声からビート時刻を推定し、拍内を細分した格子時刻を返す。 (+1 more)

### Community 50 - "Domain IDs and States"
Cohesion: 0.31
Nodes (6): newSongId(), newTakeId(), shortId(), assertTakeTransition(), transitions, TakeStatus

### Community 51 - "M5 Validation Scenarios"
Cohesion: 0.31
Nodes (9): Jump-enabled DTW, Jump DTW Validation, M5 Preparation Validation, MusicXML Reference Validation, MusicXML Tie Merging, Non-piano Noise Degradation, Real-audio Retry Validation, Repeated Practice Validation (+1 more)

### Community 52 - "Non Piano Noise Tests"
Cohesion: 0.36
Nodes (8): main(), metronome_track(), normalize(), ndarray, ピアノ以外の音（メトロノーム・話し声）を混ぜた場合の採譜への影響を見る（M5 持ち越し課題5）。 本アプリの利用者は自宅で練習しながら録音するため、…, 一定テンポのクリック音（減衰する短いトーンバースト）。, 話し声を模したバースト雑音。300-3400Hz に帯域制限し、断続的に鳴らす。, voice_like_track()

### Community 53 - "ONNX Transcription Runtime"
Cohesion: 0.28
Nodes (6): main(), OnnxModel, Path, Tensor, ONNX Runtime で採譜し、PyTorch 版との速度・出力一致を実測する。 export_onnx.py が作った ONNX を使い、前後処理は…, PianoTranscription が期待するインターフェースを ONNX セッションで満たす。

### Community 54 - "Measurement Confidence UX"
Cohesion: 0.36
Nodes (8): Confidence-interval Difference UI, int8 Quantization Rejection, M4.5 Validation, Minimum Detectable Difference, ONNX fp32 Transcription, Score Measurement Noise, Relative-change-first Results, Minimum Detectable Difference

### Community 55 - "Server Domain Types"
Cohesion: 0.36
Nodes (7): MetricKey, CoachInput, IssueDoc, MeasureScoreDoc, ScoreWarning, SongDocStatus, TakeFailure

### Community 56 - "Reference Score Builder"
Cohesion: 0.29
Nodes (7): build_reference(), merge_ties(), Any, Path, S1: MusicXML → 参照譜(reference.json)。 poc/scripts/musicxml_reference.py の…, タイで結ばれた音符を1つの音符（開始拍・合計長）に統合する。, MusicXML ファイルから reference.json 相当の辞書を作る。

### Community 57 - "Transcription Alignment Model"
Cohesion: 0.29
Nodes (7): BeatMap, S2a Audio-to-MIDI Transcription, S3 Two-stage Score Alignment, Two-stage Alignment Validation, Alignment Result, BeatMap, Performance Notes

### Community 59 - "Graphify Update Workflows"
Cohesion: 0.33
Nodes (6): Folder Watcher, URL Ingestion, Post-commit Graph Hook, Cluster-only Refresh, Incremental Graph Update, Replace on Re-extract

### Community 60 - "Recording Quality Estimation"
Cohesion: 0.53
Nodes (5): features(), frame_rms(), main(), ndarray, 録音そのものから品質を推定し、採譜精度を予測できるかを検証する。 指標のデッドゾーンは「その録音でどれだけ採譜が外れるか」に応じて決めたい。 しかし実運用では…

### Community 61 - "Score Stability Analysis"
Cohesion: 0.47
Nodes (5): collect(), main(), Path, スコアの測定ノイズと、差分として検出できる最小の変化量を求める。 同じ演奏を同じ条件で録り直したときにスコアがどれだけ揺れるかが σ。 「前回より 3…, (piece, level) -> スコアの列。

### Community 62 - "Transcription PoC Script"
Cohesion: 0.47
Nodes (5): load_audio(), main(), ndarray, Path, ByteDance の高解像度ピアノ採譜モデルを CPU で走らせ、速度と出力を記録する。 M4 の最重要検証項目は「CPU…

### Community 63 - "Application Shell Layout"
Cohesion: 0.40
Nodes (3): metadata, AppShell(), NAV

### Community 64 - "M5 Vertical Slice"
Cohesion: 0.40
Nodes (5): S1 Reference Score Expansion, Reference Score, M5 Analysis Worker, M5 API Vertical Slice, M5 Known Limitations

### Community 65 - "Score Fixture Generator"
Cohesion: 0.40
Nodes (3): bass, melody, scale

### Community 66 - "Practice Issue Generation"
Cohesion: 0.50
Nodes (4): generate_issues(), Any, S5: 指摘生成。 metrics.md の設計思想（誤り/揺らぎ/表現を区別し、行動につながる粒度で出す）に…, _severity()

### Community 67 - "Package Metadata"
Cohesion: 0.50
Nodes (3): name, private, version

### Community 68 - "Worker Transcription Adapter"
Cohesion: 0.50
Nodes (3): Path, S2: 採譜（Audio → MIDI）。 poc/scripts/transcribe.py と同じ…, transcribe()

### Community 70 - "Document File Icon"
Cohesion: 0.67
Nodes (3): Document File Icon, Document Text Lines, Folded Page Corner

### Community 71 - "Application Window Icon"
Cohesion: 0.67
Nodes (3): Application Window Icon, Rounded Window Frame, Three Circular Indicators

## Knowledge Gaps
- **219 isolated node(s):** `eslintConfig`, `$schema`, `contentVersion`, `value`, `value` (+214 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **13 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `ScoreView()` connect `Score Visualization Components` to `Application Dependencies`, `Song Upload Results`?**
  _High betweenness centrality (0.044) - this node is a cross-community bridge._
- **Why does `opensheetmusicdisplay` connect `Application Dependencies` to `Score Visualization Components`?**
  _High betweenness centrality (0.044) - this node is a cross-community bridge._
- **Why does `dependencies` connect `Application Dependencies` to `Azure Blob Dependency`, `JWT Library Dependency`, `Package Metadata`?**
  _High betweenness centrality (0.041) - this node is a cross-community bridge._
- **What connects `eslintConfig`, `$schema`, `contentVersion` to the rest of the system?**
  _219 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Song API Routes` be split into smaller, more focused modules?**
  _Cohesion score 0.07108927108927109 - nodes in this community are weakly interconnected._
- **Should `Azure System Architecture` be split into smaller, more focused modules?**
  _Cohesion score 0.05365402405180388 - nodes in this community are weakly interconnected._
- **Should `Alignment PoC Pipeline` be split into smaller, more focused modules?**
  _Cohesion score 0.10080645161290322 - nodes in this community are weakly interconnected._