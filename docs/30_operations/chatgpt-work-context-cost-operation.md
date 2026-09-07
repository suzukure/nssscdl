# ChatGPT Workのコンテキスト・コスト管理

## 目的

ChatGPT WorkをGitHub作業の対話窓口として使いながら、長大な会話、Actionsログ全文の反復取得、過剰なモデル選択、同一証跡の再調査によるコンテキスト消費を抑える。

GitHub上のIssue、Pull Request、Actions、リポジトリを要求・決定・実行結果の正本とする。本書はChatGPT Work側の会話構成と調査方法を定め、[AI開発・ClaudeレビューのGitHub運用](ai-development-workflow.md)を補完する。

## ChatGPT Projectの設定

継続作業には専用のChatGPT Projectを使用する。

### SourcesとGitHub接続

Project Sourcesは次の最小構成とする。

- AI開発・レビュー基盤の概要資料
- 必要な場合だけ、100行程度を目安とする最新状態の要約1件

GitHubの最新状態は、接続済みGitHubツールから都度取得する。利用中のChatGPT Work環境でGitHubリポジトリを継続的に参照できるProject Sourceとして追加可能であることを実際に確認できた場合は、`suzukure/nssscdl`をSourcesに加えてよい。追加可否を確認できない場合は必須構成に含めない。

アップロードしたリポジトリファイルや状態要約は、その時点のsnapshotであり、最新Issue、PR、Actions、SHA確認の代替にしない。過去IssueごとのActionsログ、レビュー全文、チャットごとのhandoffをSourcesへ累積しない。確定事項はGitHubのIssue本文、PR本文、レビュー、リポジトリへ記録する。

### Project instructions

Project instructionsへ次を設定する。リポジトリの運用正本と矛盾した場合は、GitHub上の最新の正本を優先する。

```text
## GitHub作業のコンテキスト・コスト管理

### チャットの単位

- 原則として、1つのGitHub Issueを1つのチャットで扱う。
- 別Issueへ移る場合は、現在のIssueの状態、関連PR、未完了事項、次の一手を短く記録して、新しいチャットを開始する。
- 親Issueと複数の子Issueを同じチャットで並行実装しない。
- 同一Issueの修正・レビュー・マージ確認は、コンテキストが過大でない限り同じチャットで継続する。
- チャット名は「Issue #番号 - 短い目的」とする。

### GitHub状態の取得

- 各チャットの開始時に、対象Issue、関連PR、main SHA、PRのbase/head SHA、ラベル、最新レビュー、最新Actions結果をGitHubから読み取りで確認する。
- 前チャットの記憶だけで現在状態を断定しない。
- 一度取得した同じSHA・同じActions runの情報は、状態が変わっていない限り再取得しない。
- GitHubのIssue本文、PR本文、レビュー、Actions Job Summary、およびClaude review usage step logの集計済みJSONを一次情報として扱う。
- 過去のチャット内容は、GitHubへ記録されていない限り仕様・決定の正本にしない。

### Actionsログの取得

- Actions失敗時は、最初にrun、job、失敗step、conclusion、head SHAを確認する。
- Claude review失敗では、Job Summaryの`Claude review result`にある`Reason code`を最初に確認する。usage JSONは費用・利用量の補助証跡であり、失敗原因やverdictの判定には使わない。
- ログ全文を最初から取得しない。
- 失敗stepのログと、その直前の原因判定に必要な範囲だけを取得する。
- エラーメッセージ、exit code、該当script、入力状態で原因を特定できない場合に限り、取得範囲を段階的に広げる。
- 既にユーザーが提示したログは再取得せず、現在のrunと一致するかだけ確認する。
- 1万行を超えるログは全文表示せず、反復箇所、最初の異常、最後の異常、進捗の有無を要約する。
- raw execution file、raw model/API output（promptおよびraw model出力中のreview本文を含む）を取得・転載しない。HTTP 429、log文言、利用量だけから支出上限到達と推定しない。

### Claude review失敗時の再実行

- `RUN_BUDGET_LIMIT_REACHED`、`ACCOUNT_SPEND_LIMIT_REACHED`、`TRANSIENT_RATE_LIMIT`、`CLAUDE_EXECUTION_FAILED`、review出力検証失敗、または`CLASSIFIER_INTERNAL_ERROR`では、`ai-development-workflow.md`の固定reason code表と復旧手順に従う。上限到達・分類不能失敗では自動再試行しない。
- 再実行前にIssue番号、closing Issue、PR番号、現在のPR head SHA、失敗run ID、失敗runのhead SHAを照合する。Job Summaryを優先し、必要な非機密情報だけを追加確認する。
- PR差分を変えない再実行はGitHub Actions UIで当該reviewを人が再実行し、完了後のrun IDとhead SHAを記録・照合する。head SHAが変われば新しいreviewとして扱う。
- `human-review-required`による停止中は、明示許可と再開判断の後にclosing Issue、PRの順でラベルを外す。このPRラベル解除eventが同じheadのClaude再review要求となる。

### 既存証跡の再利用

- Actions Job SummaryまたはClaude review usage step logの集計済みJSONに費用、turn数、duration、token数があれば、その値を再計算しない。
- PR本文に検証結果が記載されていれば、同じhead SHAに対して同じ検証を繰り返さない。
- 最新head SHAが変わった場合だけ、変更の影響を受ける確認をやり直す。
- mainへマージ済みのIssueについては、PR、merge commit、Issue stateの確認をもって完了判定し、過去レビュー全件を再調査しない。
- 前回までの調査結果を再利用する場合は、根拠となるIssue番号、PR番号、run ID、head SHAを明示する。

### モデルの使い分け

- 状況確認、状態一覧、既存情報の要約、定型的なActions確認では、利用可能な低コストモデルを選ぶ。
- 要求・設計判断、Claude指摘の妥当性検証、複数文書の整合性確認、セキュリティ境界、原因が不明な障害解析では、高性能モデルを選ぶ。
- 低コストモデルで判断根拠が不足した場合は推測せず、高性能モデルへ切り替える必要性を説明する。
- 単純な状態確認では複数agentや最高のreasoning effortを使用しない。

### 報告形式

状況確認は原則として、現在地点、成功・失敗・停止の別、対象Issue・PR・head SHA、人間判断が必要な事項、推奨する次の一手の順に簡潔に報告する。
詳細ログや過去経緯は、原因説明に必要な場合だけ追加する。

### 安全規則

- mainへ直接書き込まない。
- force pushしない。
- protected pathsを含むPRを自動マージしない。
- human-review-requiredがある場合は、明示許可なしに解除・再実行しない。
- Secrets、Repository Variables、Ruleset、権限変更は実行直前に明示許可を得る。
- Secret値を表示しない。
- PR review IDをIssue comment APIで扱わない。
- PR head由来のuntrusted scriptを安易に実行せず、base由来の信頼境界を維持する。
```

Project instructionsは会話上の方針であり、GitHubのRuleset、App権限、Actions gateの代替ではない。

## チャットの単位

### 基本単位

1 Issueにつき1チャットを基本とし、次の一連の作業を扱う。

1. Issueと関連状態の確認
2. 実装または文書修正
3. PRとActionsの確認
4. Claude指摘の検証と修正
5. マージとIssue完了の確認

親Issueを扱うチャットは、子Issueの進捗集計と親Issueの完了判断に使用する。親Issueへ `/codex develop` を投稿して複数の子Issueを一括実装しない。

### 新しいチャットへ分ける条件

次のいずれかに該当する場合は、同じProject内で新しいチャットを開始する。

- 別Issueの実装または判断へ移る。
- 元Issueの作業と後継Issueの作業が混在し始めた。
- 要求・設計判断と、その判断後の実装を分ける必要がある。
- Actionsの長時間実行や大量ログの原因調査を独立させる。
- 過去経緯の再説明や誤った参照が増え、現在のIssueに必要な情報を短く保てない。

チャット名は `Issue #<番号> - <短い目的>` とする。単一Issue内で調査チャットを分ける場合は、`Issue #<番号> - Actions障害調査` のように目的を付ける。

## モデルの選択

モデルはProject instructionsだけでは自動的に切り替わらないため、チャット開始時または作業内容が変わった時に人間が選択する。利用可能なモデル名はChatGPT Workのmodel selectorを正本とする。

| 作業 | モデルの区分 | reasoning effort |
|---|---|---|
| Issue・PRの状態確認 | 低コスト | Low〜Medium |
| 既存証跡の要約 | 低コストまたは標準 | Medium |
| 原因が明確なActions失敗の確認 | 低コストまたは標準 | Medium |
| 定型的なIssue・PR本文補正 | 標準 | Medium |
| Claude指摘の妥当性検証 | 高性能 | High |
| 要求・基本設計の判断 | 高性能 | High |
| 複数文書の整合性レビュー | 高性能 | High〜Extra High |
| 明確に並列化できる大規模調査 | 高性能、必要時のみ複数agent | 作業に応じて選択 |

簡単な確認から開始し、必要な根拠を得られない場合にだけモデルまたはreasoning effortを上げる。同一Issueで作業の性質が大きく変わる場合は、モデルを切り替えるか、別チャットに分ける。

## GitHub状態の確認範囲

新しいIssueチャットの開始時は、まず次を読み取りで確認する。

- Issueのstate、本文、ラベル
- 関連するopen PR
- main SHA、PRのbase SHAとhead SHA
- 最新のClaude review
- 最新Actions runのjob、conclusion、失敗step
- closing Issueと明示された後継Issue

状態が変わっていない同一SHA・同一runについて、全レビュー・全コメント・全ログを再取得しない。前回の報告を使う場合も、現在のstate・SHA・runとの一致を確認する。

## Actionsログの段階的取得

Actions障害は次の順序で調査する。

1. workflow runのstatus、conclusion、event、head SHAを確認する。
2. job一覧から失敗jobを特定する。
3. job step一覧から最初に失敗したstepを特定する。
4. Claude reviewならJob Summaryの`Claude review result`から`Reason code`を確認する。usage JSONは補助証跡であり、reason codeを置き換えない。
5. 失敗stepのログと、必要なら直前stepの末尾を取得する。raw execution fileとraw model/API output（promptおよびraw model出力中のreview本文を含む）は取得・転載しない。
6. ログが同じ出力を反復している場合は、最初と最後の代表範囲、反復回数または傾向、差分の進展を調べる。
7. 原因を区別できない場合に限り、関連stepまたはjob全体へ取得範囲を広げる。

「ログが1万行ある」「30分動いている」だけでは失敗と断定しない。過去の1時間停止事例と、同じstep・同じ反復・同じ終了条件かを比較する。一方、進捗のない反復と時間上限到達が再現している場合は、同じrunを繰り返さず、Issueの論点・対象節・文書サイズ・検証範囲の分割を検討する。

Secret、token、Webhook URL、private key、未公開のVariable値をログから抽出・再掲しない。

Claude reviewの固定reason codeと復旧手順は[AI開発・ClaudeレビューのGitHub運用](ai-development-workflow.md#claude-review失敗の分類と再実行)を正本とする。HTTP 429、Action logの文言、またはusageだけから`ACCOUNT_SPEND_LIMIT_REACHED`と判断しない。上限到達または分類不能な失敗では自動再試行せず、再実行前にIssue番号、closing Issue、PR番号、現在PR head SHA、失敗run ID、失敗runのhead SHAを照合する。PR差分を変えない場合は人間がGitHub Actions UIで当該reviewを再実行し、完了後のrun IDとhead SHAを照合する。停止ラベルがある場合は、人間が再開可能と判断した後、closing Issue、PRの順に外し、PRのラベル解除eventで同じheadの再reviewを要求する。

## 既存証跡の再利用

再利用できる証跡と再確認条件は次のとおり。

| 証跡 | 再利用条件 | 再確認が必要な変化 |
|---|---|---|
| PR本文のvalidation | head SHAが同じ | 関連ファイルまたはhead SHAの変更 |
| Claude review | review対象head SHAが同じ | 新しいpush、reviewのdismiss、要求・Issue本文の重大変更 |
| Actions Job Summary / Claude review usage step log | run IDとhead SHAが同じ | rerun、新run、新head |
| Issue本文の決定 | 本文の更新時刻・内容が同じ | 決定、範囲、完了条件の更新 |
| main上の文書 | main SHAが同じ | mainの新しいcommit |
| 過去のhandoff | 記載したIssue・PR・SHAを現在状態と照合済み | state、label、head、review、runの変更 |

Claudeの費用、turn数、duration、input/output token、cache creation/read tokenはJob SummaryまたはClaude review usage step logの集計済みJSONに記録済みならその値を使う。execution fileやraw logから重複集計しない。

## チャット開始テンプレート

### 状況確認

```text
GitHubリポジトリ suzukure/nssscdl のIssue #<番号>を読み取りで確認してください。

最初に確認する範囲:
- Issueのstate、本文、ラベル
- 関連するopen PR
- main SHAとPRのbase/head SHA
- 最新レビュー
- 最新Actions runのjobと失敗step

ログ全文は取得せず、失敗stepと必要な範囲だけ確認してください。
同じSHA・runについて既存のJob SummaryやPR本文に証跡があれば再利用してください。
現在地点、問題、次の1手を簡潔に報告してください。
書き込みは行わないでください。
```

### 設計・レビュー指摘の検証

```text
GitHubリポジトリ suzukure/nssscdl のIssue #<番号> / PR #<番号>について検討してください。

Issue本文、PR差分、最新Claude review、関連する正本文書を確認し、
指摘の妥当性、影響するPOL / BR / REQ / AC / TC / CON / OOS、
スコープ内で修正可能か、要求変更や人間判断が必要かを検証してください。

Actionsログは必要な失敗stepだけ取得し、既存の検証証跡を再利用してください。
最初は読み取りのみとし、結論と推奨対応を報告してください。
```

## チャット完了時のhandoff

Issue完了時または別チャットへ移る時は、次を短く記録する。

```markdown
## Completion handoff

- Issue:
- Related PR:
- Final head / merge commit:
- Final review:
- Actions:
- Decisions recorded in:
- Follow-up Issues:
- Remaining human action:
- Exact next step:
```

handoffは接続情報であり、確定済み仕様や判断の正本ではない。確定事項とスコープ外影響・後継Issueは、先にGitHubのclosing Issue本文とPR本文へ反映する。

## 運用の確認

月単位、または長時間失敗が再発した時に次を確認する。

- 1つのチャットで複数Issueを実装していないか。
- Actionsログ全文を原因特定前に取得していないか。
- 状況確認に過剰なモデル・reasoning effortを使っていないか。
- 同一head SHA・run IDの証跡を繰り返し取得していないか。
- handoffよりGitHub上の古い情報を優先していないか。
- Project Sourcesへ一時ログや古いhandoffが累積していないか。

見直し結果によってProject instructionsを変える場合は、本書も同時に更新する。
