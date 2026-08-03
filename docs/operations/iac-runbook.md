# IaC運用手順書（Bicep + Azure Developer CLI）

## 1. 対象と前提

本手順は、`infra/main.bicep` を正として Azure リソースを初期構築し、
以後の変更・差分確認・障害対応・削除までを継続的に管理するための手順です。

現在 IaC で管理する対象は次のとおりです。

- Storage Account、Blob コンテナ、Storage Queue
- Cosmos DB for NoSQL（Serverless）とコンテナ
- Log Analytics、Application Insights
- Key Vault（RBAC方式）
- Web/Worker 用 Managed Identity と Azure RBAC
- オプションの Azure OpenAI 互換 Foundry アカウントとモデルデプロイ

アプリケーションと Python ワーカーの Container Apps は、イメージ公開後に追加します。
本番で `azd down` を実行する場合はデータ削除を伴うため、必ず承認を得てください。

## 2. リポジトリの構成

```text
azure.yaml
infra/
├── main.bicep
├── main.parameters.json
├── main.parameters.dev.json
├── main.parameters.stg.json
├── main.parameters.prod.json
└── modules/
    ├── cosmos.bicep
    ├── foundry.bicep
    ├── identity.bicep
    ├── key-vault.bicep
    ├── monitoring.bicep
    ├── rbac.bicep
    └── storage.bicep
```

`main.bicep` とモジュールが変更されると、次回の `azd provision` または
`az deployment group create` で差分が適用されます。Azure Portalでの手動変更を
正規の変更方法にしないでください。

## 3. 初回セットアップ

### 3.1 ツールと権限を確認する

```powershell
az version
azd version
az login
az account set --subscription <subscription-id>
az account show
```

必要な権限は、対象サブスクリプションでのリソースグループ作成権限と、
リソース作成時の RBAC ロール割り当て権限です。運用者の個人キーや接続文字列を
リポジトリへ保存しません。

### 3.2 環境を作成する

環境ごとに `azd` 環境を作成します。dev/stg/prod は別リソースグループにし、
可能なら別サブスクリプションへ分離します。

```powershell
azd auth login
azd env new ledgerlines-dev
azd env set AZURE_SUBSCRIPTION_ID <subscription-id>
azd env set AZURE_LOCATION japaneast
azd env set AZURE_RESOURCE_GROUP ledgerlines-dev-rg
azd env set AZURE_ENV_NAME dev
azd env get-values
```

stg/prod でも同じ手順を繰り返し、環境名とリソースグループを混同しないようにします。

### 3.3 パラメータを確認する

`infra/main.parameters.dev.json`、`main.parameters.stg.json`、
`main.parameters.prod.json` は値の例です。実環境のリージョン、命名規約、
Foundryの提供状況、Key Vaultの削除保護を確認してから使用します。

本番では次を満たしてください。

- `environmentName` は `prod`
- `enablePurgeProtection` は `true`
- Log Analytics の保持期間を組織のポリシーに合わせる
- `enableFoundry` はリージョンのモデル提供状況とクォータ確認後だけ `true`
- シークレット、APIキー、SAS、接続文字列をパラメータに記載しない

## 4. 初回Provision

### 4.1 What-ifを実行する

作成前に必ず差分を確認します。

```powershell
az deployment group what-if `
  --resource-group ledgerlines-dev-rg `
  --template-file infra/main.bicep `
  --parameters @infra/main.parameters.dev.json
```

対象リソースグループ、リージョン、削除・置換予定のリソース、RBAC変更を確認します。
意図しない削除または置換があれば中止し、Bicepとパラメータを修正します。

### 4.2 Provisionする

```powershell
azd env select ledgerlines-dev
azd provision
azd show
```

初回はリソースグループと各リソースが作成されます。出力された Endpoint、
Queue名、Key Vault URI、Managed IdentityのPrincipal IDは、アプリ設定へ反映する
ために記録します。ただし、値をログやコミットへ貼り付けません。

### 4.3 作成結果を確認する

```powershell
az resource list --resource-group ledgerlines-dev-rg --output table
az deployment group list --resource-group ledgerlines-dev-rg --output table
azd show
```

確認項目は、タグ、ストレージの匿名公開無効、Cosmosのローカル認証無効、
Key VaultのRBAC、Managed Identityのロール割り当て、監視リソースの存在です。

## 5. 日常の変更フロー

1. 変更理由と対象環境を決める。
2. Bicepモジュールまたは環境パラメータを変更する。
3. `az bicep build` と `az bicep lint` を実行する。
4. 対象環境に対して `what-if` を実行する。
5. Pull Requestでレビューする。
6. devへ適用し、アプリの疎通と監視を確認する。
7. stgへ適用し、契約/E2Eテストとコスト影響を確認する。
8. 承認後にprodへ適用する。

```powershell
az bicep build --file infra/main.bicep --stdout
az bicep lint --file infra/main.bicep
azd env select ledgerlines-dev
azd provision --preview
azd provision
```

`azd provision` は同じ環境へ再実行でき、宣言との差分だけを適用します。
リソースを手動変更した場合も、次回の what-if で差分を検出し、Bicepへ取り込むか
手動変更をやめて宣言へ戻します。

## 6. 環境昇格とロールバック

devで確認した同一コミットをstg、prodへ昇格します。環境ごとにパラメータだけを
変え、Bicep本体を直接環境別に複製しません。

適用前:

```powershell
git rev-parse HEAD
az deployment group what-if `
  --resource-group ledgerlines-prod-rg `
  --template-file infra/main.bicep `
  --parameters @infra/main.parameters.prod.json
```

適用後に異常が出た場合は、まずアプリのリビジョンや設定を戻します。リソース変更の
ロールバックは、原因を修正したコミットでBicepを戻し、what-ifで削除・置換を確認して
から再度Provisionします。Cosmos、Blob、Key Vaultの削除を伴う変更は、バックアップと
保持ポリシーを確認するまで自動ロールバックしません。

## 7. シークレットとアクセス管理

- Managed Identity と `DefaultAzureCredential` を優先する。
- Key Vaultの値はAzure上で登録し、アプリへはRBACで参照させる。
- パラメータJSON、`.env`、ログ、Application Insightsへシークレットを出さない。
- SASは短期・対象Blob限定で発行する。
- 運用者の権限は最小権限にし、RBAC変更はPRと監査ログを残す。
- Key Vaultのpurge protectionはprodで無効化しない。

## 8. 監視と定期運用

### 毎日

- Application InsightsでAPIエラー率、解析失敗率、Queue遅延を確認する。
- CosmosのRUスロットリング、Blob失敗、Foundry失敗を確認する。
- Cost Managementの日次コストと予算アラートを確認する。

### 毎週

- `az deployment group what-if` で手動変更やドリフトを確認する。
- `az resource list` で不要リソースとタグ欠落を確認する。
- Queueのpoison messageと失敗テイクを確認する。

### 毎月

- コストを予算と比較し、テイク数・平均録音長・解析時間を見直す。
- RBAC、Managed Identity、Key Vaultアクセスを棚卸しする。
- バックアップからの復元手順を検証する。
- Bicep/azd/Azure SDKの更新をdevで検証してから昇格する。

## 9. 障害対応

### Provisionが失敗する

1. `azd show` とAzure Portalのデプロイ詳細で失敗リソースを特定する。
2. Bicep lintとwhat-ifを再実行する。
3. リージョンのSKU・Foundryモデルクォータ・RBAC権限を確認する。
4. 既存リソースを削除せず、原因修正後に再Provisionする。

### リソースが想定外に変更された

1. `az deployment group list` とActivity Logで変更者と時刻を確認する。
2. `what-if`で現在状態との差分を確認する。
3. 正しい状態をBicepへ反映するか、再Provisionで宣言状態へ戻す。
4. 本番データに影響する場合は復旧前にバックアップを確認する。

### `azd down` を使う場合

`azd down` は環境のリソースを削除します。prodでは通常使用せず、
廃止計画、データエクスポート、保持期間、承認記録を確認したうえで実行します。

## 10. 完了チェックリスト

- [ ] 対象サブスクリプション、リージョン、環境名を確認した
- [ ] What-ifで意図しない削除・置換がない
- [ ] Bicep build/lintが成功した
- [ ] タグとManaged Identity/RBACを確認した
- [ ] Key Vault、Cosmos、Blob、Queue、監視の疎通を確認した
- [ ] コスト予算とアラートを確認した
- [ ] 適用コミット、実行者、結果を記録した
- [ ] prodでは承認者とロールバック方針を記録した
````