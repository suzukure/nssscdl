# AI開発・ClaudeレビューのGitHub運用

## 目的

Codex/OpenAIを開発者、Claudeを独立レビューアーとしてGitHub上で協調させる。Issueを検討と作業の正本、Pull Requestを成果物とレビュー対話の正本にする。

GitHub上に新規投稿・表示する人間向けのIssue / PR本文・コメント・review・ラベル説明・Actions診断・Job Summaryは原則日本語とする。過去のIssue / PR / comment / review / commitは遡って書き換えない。command、label、branch名、reason code、state、schema / JSON key、exact marker、pause record、resume action valueなどの機械可読契約は翻訳しない。外部システムの原文エラーを証拠として残す場合は原文を保持し、日本語で意味と確認先を説明する。Discord通知本文と停止・再開の状態契約は各既存契約に従う。

## 通常フロー

1. 人間が実装対象Issueを作成し、対象、受入条件、上流・下流影響を記録する。
2. 通常のIssue起点開発では、Open Issueに `/codex develop` だけを単独コメントとして投稿する。前後の説明文、引用、Markdown code block、字下げ、前後空白を付けたコメントは実行要求として扱わず、Closed Issueへのコメントでも起動しない。timeout後の例外として `/codex develop extended` も正規commandとするが、利用条件と固定35分上限は「human-approved extended-run」を正本とする。入口はこれら2つのcommandとの等値比較だけを使用し、GitHub公式仕様どおり文字列の等値比較は大文字小文字を区別しないため、運用上の正規形は小文字とする。形式やIssue stateが一致しない場合は入口job自体が起動せず自動ガイダンスも返らないため、反応がない場合はIssueがOpenか、コメントがcommand単独になっているかを確認する。developer App tokenやOpenAI APIを使う前に、Issue自身と対応するopen PRの停止ラベルを事前ゲートで確認する。

3. developer Appが `ai/issue-<Issue番号>` ブランチを作成・更新し、`Closes #<Issue番号>` を含むDraft PRを作成する。同じIssueの追加修正は既存PRへ集約し、自動Ready化しない。人間が下記の準備確認を終えてReady for reviewへ変更すると、Claude reviewが起動する。
4. `PR Traceability / Linked Issue` が実在するclosing Issueを確認する。
5. ClaudeがPR、信頼済み会話、closing Issue、明示された後継Issueのsnapshot、差分を確認し、reviewer Appとして `APPROVE` または `REQUEST_CHANGES` を投稿する。仕様書レビューでは `CLAUDE.md` の重点観点を適用する。Actionへ現行5-key JSON Schemaを渡し、`structured_output` をreview内容の第一入力として、current base由来の `validate-claude-review-output.sh` を通過した結果だけを投稿する。`summary` を総評、`blocking_findings` / `non_blocking_findings` を指摘事項と改善案として記録する。native出力は厳密に1個のJSON値として読み、欠落・不正JSON・schema不一致は非機密な固定reason codeでfail-closed停止する。自由テキスト `result` やMarkdown fenceへfallbackせず、verdictを推測しない。
6. `REQUEST_CHANGES` の場合、reviewer Appを確認したtrusted workflowはreviewの`commit_id`がPRの現在headと一致するときだけPRをDraftへ戻す。一致しないstale reviewはDraft化もCodex follow-upも起動しない。Draft復帰jobの異常終了、gate停止、Codex異常終了、またはpush失敗ではReadyへ戻さず、`human-review-required` により停止する。`ai/issue-*` の通常follow-upは停止ラベルを付けずにCodexを1回だけ実行し、Codex正常完了、requirements gate、trusted diff guard、commit/pushの全成功後だけtrusted workflowがPRをReady for reviewへ戻す。そのReady eventが現在headへの再レビューを1回要求する。Codex対象外PRは人間または既存の明示操作でReadyへ戻す。停止ラベルを人間が解除する場合の順序・再レビュー起動条件・merged/closed PRのcleanupは「人間エスカレーション」節を正本とする。openかつ非Draft PRのPR `unlabeled` eventは明示的な再レビュー要求として維持する。3回目のchange request、要求変更マーカー、または人間エスカレーションマーカーではCodex修正自体を停止する。
7. Claudeが承認し、developer App作成PRが `ai/issue-<Issue番号>` ブランチで、ブランチ番号とclosing Issueが一致し、保護対象のAI指示・agent設定・GitHub自動化を変更せず、IssueとPRのどちらにも `human-review-required` ラベルがない場合だけreviewer Appがsquash mergeする。

通常commandのworkflow入口はevent snapshotでcommand、actor、Issueのopen状態を早期判定する。Issue単位のwriter concurrency待機後はtrusted GitHub APIで対象番号・non-PR identity・現在のopen状態と停止ラベルを再取得し、関連open PRの停止ラベルと併せて判定する。取得失敗、metadata欠損・不一致、closed状態ではbranch操作やpaid Codexへ進まない。event snapshotのIssue stateだけを待機後の現在状態の証拠としない。

人間や任意ブランチから作成したPRはClaudeレビューの対象にはできるが、自動マージしない。

## Issue起点AI Developerへ渡すtrusted conversationの選択

trusted human（`OWNER` / `MEMBER` / `COLLABORATOR`）が `/codex context-checkpoint` と完全一致する単独Issue commentを投稿した場合、その時点までのAI Developerに必要な確定判断・要求・再開条件・未解決事項がcurrent Issue本文へ集約済みであることを人間が保証する。未反映の判断、未解決の上流決定、本文にないpause解除条件や過去の安全判断が残る場合は投稿しない。checkpointはpause解除や要求承認を意味せず、既存のIssue-entry、`human-review-required`、requirements、diff guardの各gateを変更しない。

有効なcheckpointがなければ従来どおりIssue本文とtrusted comment全文をtimestamp順に渡す。有効なcheckpointがあれば最新の一意なtimestampを境界とし、current Issue本文全文と、その後のtrusted comment本文をtimestamp順に渡す。同一timestampはcanonicalなcomment表現で決定的にtie-breakする。checkpoint comment自体とそれ以前のcomment本文は省略し、model-facing contextにも省略境界を明示する。untrusted comment本文は含めない。timestampやboundary選択の異常でもtrusted comment集合を安全に確定できる場合は全文へfallbackし、その理由をcontextに示す。timestamp自体が不正なfallbackではchronological orderを保証できないこともmodel-facing contextへ明示する。metadata / identity破損により完全なtrusted comment集合自体を安全に確定できない場合は、partial historyをfull fallbackと偽らずmodel call前にfail-closed停止する。選択規則と非機密な文字数・byte数telemetryは `.github/scripts/build-development-context.py` を正本とする。Claude Review側の選択は次節を正本とする。

## Claude Reviewへ渡すtrusted conversationの選択

Claude Reviewのreview contextでは、reviewer Appによる最新のformal review（`APPROVED` または `CHANGES_REQUESTED`）を会話履歴の境界とする。境界より古いreviewer App reviewは本文を含めず、author、state、submittedAt、structured review summaryで単独行完全一致した `[REQUIREMENTS_CHANGE_REQUIRED]` と `[HUMAN_ESCALATION_RECOMMENDED]` の有無だけを保持する。境界より古いtrusted comment本文は含めない。一方、trusted humanまたはdeveloper Appによるreview本文と、最新formal review以後に必要なtrusted conversationは保持する。

formal Claude reviewがまだない初回reviewでは、trusted conversation全文を保持する。identity、metadata、timestampなどから安全に選択できない場合も、黙って一部を省略せずtrusted conversation全文へfallbackし、その事実をreview contextに明記する。過去reviewのstateとmarker情報は、`REQUEST_CHANGES`後の復旧および停止判定に使うため、本文を短縮した場合も保持する。具体的な選択条件と実装は `build-review-context.sh` を正本とする。

## Work Admission Control

問題・改善点は無制限に発見してよい。発見（Discovery）と着手（Execution）を分離し、現在Issueを完了するために必要でないものは現在scopeへ取り込まず、同一の自律実行チェーンから新たに着手しない。AI Developer、Claude Review、ChatGPT上の開発補助、横断監査等に共通して本節を適用する。

本節は新しい仕事をActiveへ入れるかを判断する上流の運用契約である。admissionしたIssueには、既存の[Issueの分割単位](#issueの分割単位)と、AI開発環境Issueの場合は #549 由来の[semantic/runtime scope確認](#ai開発環境issueのruntime-scope確認)を適用する。これらの分割基準を置き換えない。

### findingの分類とBlocking判定

作業中に新しいfindingを発見したら、現在契約と未対応の影響を照合し、少なくとも次のQ1〜Q3を確認する。

- **Q1**: 対応しないと、現在Issueの既存Acceptance Criteria / Done / current implementation contractを満たせないか。
- **Q2**: 対応せず現在PRをmainへ反映すると、安全性・正確性・要求／設計整合性が壊れるか。
- **Q3**: 現在Issueを成立させるために新たに判明した必須前提か。

| 分類 | 境界 | 現在作業での扱い |
|---|---|---|
| In-scope required | 現在Issueの既存Acceptance Criteria / Done / current implementation contractを満たすために不可欠で、元Issueの責務と不可分。 | 現Issue内で対応し、同じ判断に不可分な関連修正・検証を揃える。 |
| Blocker | 現Issueとは独立した責務だが、未解決のままmainへ反映すると安全性・正確性・要求／設計整合性を維持できない、または現在Issue成立の必須前提が欠ける。 | 現Issueを停止し、「Issueの分割単位」と既存の人間判断・停止／再開契約に従って扱う。 |
| Follow-up | 対応価値はあるが、未対応でも現在Issueを安全かつ整合した状態で完了・main反映できる。 | 現在scopeへ取り込まず、[スコープ外影響と後継Issue](#スコープ外影響と後継issue)の契約に従って記録し、現在Issueへ復帰する。 |
| Idea / Improvement | 将来改善の可能性はあるが、問題・scope・Doneが独立Issueとして十分具体化していない。 | 現Issueへ取り込まず、既存のIssue / review等へ必要最小限の記録に留める。発見時点で独立Issueを必ず生成する必要はない。 |

Q1のみが該当し、責務が元Issueに不可分ならIn-scope requiredとする。Q2またはQ3が該当し、独立責務として分離可能ならBlocker候補とする。すべて該当しないfindingは現在scopeへ取り込まず、Follow-upまたはIdea / Improvementへ送る。重要性、改善効果、将来の堅牢性向上だけを理由にBlockingへ昇格させない。

Q2 / Q3の影響を、後継Issueの存在やIdeaという名称で回避してはならない。不可分な関連修正は既存契約内で揃え、分類・責務境界を確定できない場合や現在契約の変更が必要な場合は人間判断へ送る。要求変更または未決の上流判断が必要なら既存の要求変更エスカレーションに従い、推測した変更を残さない。

### current implementation contractとDoDの維持

`/codex develop` 投入時点の[current implementation contract](#issue本文におけるcurrent-implementation-contract)を作業scopeの基準とする。AIは実装中に発見した改善候補を理由として、新しいAcceptance Criteria / Done条件 / 検証義務を自律的に追加しない。既存契約を満たすために必要な修正・検証と、新しい完了条件の追加を区別する。

現在契約そのものを変更する必要が判明した場合は、要求変更・scope変更・人間判断等の既存契約に従って停止し、人間の必要な判断をIssue本文へ反映してから再開する。本節は #219 の人間判断待ち・pause/resume状態モデルを再設計せず、新しい停止reasonや自動再開経路を追加しない。

### Issue起点開発中のdynamic scope decision

#720のstatic pre-admissionは[AI開発環境Issueのruntime scope確認](#ai開発環境issueのruntime-scope確認)のR/C/P/Bで判断する。#718 / #729のin-development dynamic stopは、着手後に現在Issue authority外の必須cross-boundary Contract判断が判明した場合に適用する。producer指示は `.github/workflows/ai-developer.yml` のIssue-origin fixed Codex promptだけに置き、AGENTSのglobal ruleやClaude Blocking follow-up prompt/pathへ広げない。

停止対象は、current implementation contract自体の変更、current Issue/mainにないnew prerequisite cross-boundary Contract、synthetic/dormant/narrower Contractのtarget-mode昇格、new proof infrastructure Contractの必須化、fresh R/C/P/BのRed / split-firstへの遷移、new cross-boundary Contract定義とdownstream consumerを同一Issueへ入れないと進めない場合、またはIssue authority外のtrust / ownership / failure semanticsの新boundary判断とする。existing C0の単純利用、current Issueが明示scope化したContract definition/proof、local bug fix、existing fail-closed fixture、docs同期、P1 fixture/assertion、current Issueを先に整合的に完了できるsafe Follow-up / Ideaだけでは停止しない。ただし、新たなauthority外の必須判断をこれらの例外で回避しない。

scope判断が必要なら、Codexはnew Contractを推測で確定せず、downstream integrationを継続せず、未決Contractに依存するspeculative partial changeをworking treeへ残さない。final reportへ判断に必要な最小限のobserved fact、missing/new Contract category、current contractでDone不可な理由、R/C/P/Bの変化、proposed split/prerequisite、Product impact、未検証事項を記録し、exact `[SCOPE_DECISION_REQUIRED]` をplain textの単独行で出力する。検出規約とfail-closedは[人間エスカレーション](#人間エスカレーション)を正本とし、free textをmachine controlへ使用しない。Product要求変更・未決の上流判断には既存 `[REQUIREMENTS_CHANGE_REQUIRED]` を優先し、両markerを同時に出力しない。

scope markerは既存reason `scope_decision` のhuman pauseへ接続し、repository writeへ進まない。人間が判断をIssue本文へ更新してから既存 `/ai resume develop` で再開する。本文fingerprintが未更新ならresumeを拒否する。automatic Issue split / parent化 / retryは行わず、新しいreasonやschema fieldを追加しない。

### 記録、Active work、次のadmission

findingを独立Issueへ昇格するのは、少なくとも次を満たす場合を基本とする。

- 問題または変更目的が具体化している。
- 独立したscopeを説明できる。
- Doneを定義できる。
- 実施候補として追跡する合理的な価値がある。

低確度の可能性、一般的改善案、将来あると便利というだけの項目は、直ちにIssue化する必要はない。ただし、後継対応へ分離するスコープ外影響の人間による安全判断・closing Issue本文とPRへの記録・後継Issue確認は「スコープ外影響と後継Issue」に従い、本節によって省略しない。AI Developer自身のGitHub書込み禁止等、各担当の責務境界も維持する。

Follow-up Issueの作成・記録は次の着手許可を意味しない。そのIssueを同一の自律実行チェーンから自動で `/codex develop` しない。原則フローは次のとおりとする。

```text
現在Issue -> finding発見 -> 分類 -> Follow-upなら記録 -> 現在Issueへ復帰
         -> Done / review / merge -> 次の着手判断
```

Blockerのみ、現在Issueを停止した上で例外的に先行対応できる。これは既存の人間判断・scope確定・停止／再開契約を迂回する自動着手許可ではない。

プロジェクト全体を機械的にWIP=1とはしない。同一の目的・価値単位・依存チェーンについては、原則として現在完了へ向けて進めるActive開発チェーンを1本に保つ。レビュー待ちや明示的Blocker等で独立作業を進める場合も、新しいIssueを発見したことだけを理由にActive workを枝分かれさせない。

Follow-upやIdeaは発見時点で優先順位を深掘りせず、現在Issueの完了へ復帰する。現在のIssue / 価値単位 / milestone等の区切りで、未着手候補の必要性・価値・依存・scope・Doneをfresh評価し、次にadmissionする対象を選ぶ。発見順、Issue番号順、Claude / Astra等の指摘順を着手順の根拠にしない。

### Claude Reviewと横断監査への適用

Claudeの `blocking_findings` は現PRのmerge gateであり、既存契約どおり対応する。対応の責務境界は本節の分類で確認し、独立したBlockerを無断で現Issueへ取り込まない。`non_blocking_findings` は現PRのDoneへ自動追加せず、Follow-up / Idea候補として人間判断または既存契約に従って扱う。非Blockingという理由だけで必ずIssue化せず、指摘されたことを同じPRで直す自動拡張の根拠にしない。承認後の延期判断・記録・再レビュー条件は[承認後の非Blocking改善](#承認後の非blocking改善)を維持する。

横断監査では、少なくとも意味上、現在の監査対象の完了条件を満たさず次工程へ進めない **Gate finding** と、現在の完了条件を満たしたまま後続へ送れる **System improvement finding** を区別する。System improvement findingが存在するだけでは現在のGateを閉じず、現在scopeへ自動追加しない。監査の目的を「問題ゼロになるまで改善」へ暗黙に変更しない。

本契約は運用規約として導入する。GitHub Project列・label体系・新state machine・workflow/runtime behavior・Secrets / Variables / permissions・paid AI pathは追加または変更しない。実運用で逸脱や誤分類が観測された場合にのみ、後続Issueでfixture / lint / machine gateの必要性を判断する。自動化の導入は別Issueでsecurity / trust boundary、fail-closed、cost、retry、observability、human escalationをfresh評価する。

## Issueの分割単位

Issueは、独立して判断・実施・検証・完了判定でき、単独でmainへ反映しても安全性・正確性・要求および設計の整合性を維持できる「意味のある最小単位」とする。Issue作成時だけでなく、検討・実装・reviewによって責務境界が明らかになった時点でも、この単位を維持しているか再評価する。

1つの確定判断と、その判断に伴って整合性を維持するため不可分な関連修正は、1つのcoherent changeとして同一Issueで扱う。POL / BR / REQ / AC / TC / CON / OOS、関連する仕様・設計・実装・test・図・追跡表等を、ファイル数、識別子数、行数その他の機械的な単位で別Issueへ分割してはならない。

一方、独立して判断・実施・検証・完了できる変更を、同じ上位目的、機能、発見契機または作業時期に属することだけを理由に同一Issueへまとめてはならない。Issue境界は、少なくとも次を確認して判断する。

- 他の変更と独立して人間が判断できること。
- Issue単独で完了条件を定義し、必要な検証を実施できること。
- Issueだけをmainへ反映し、後続Issueを実施しなくても安全性・正確性・要求／設計整合性を維持できること。
- 分割によって、要求・設計・実装・test等の正本間に一時的な矛盾を発生させないこと。

これらを満たす変更は分割候補とする。逆に、分割すると正本が不整合になる変更、または1つの確定判断を成立させるために不可分な関連修正は、同一Issueで扱う。前段Issueの成果を後続Issueが利用する場合も、各Issueの完了時点でrepositoryが安全かつ整合した状態を維持できるなら、依存順序を明示して分割してよい。

複数の独立変更に共通する全体方針、共通契約、状態モデルまたは実施順序を先に検討する必要がある場合は、親Issueを検討・統括単位として使用してよい。親Issueで確定した方針に基づく具体的変更は、独立して判断・実施・検証・完了できる実施Issueへ分割する。親Issueを分割可能な実装をまとめて実施する巨大な作業Issueとして使用してはならず、単一のcoherent changeで完結する場合は不要な親Issueを新設しない。

作業開始後に独立したスコープ外責務が判明した場合も、本節の基準で分割可否を再評価する。後継Issueへ分離する場合は「スコープ外影響と後継Issue」の契約に従い、後続Issueが未実施であることを理由に不完全または不整合な状態をmainへ反映してはならない。

### AI開発環境Issueのruntime scope確認

[Work Admission Control](#work-admission-control)で着手対象を判断した後に、本節のruntime scope確認を行う。

#719で確定したstatic admissionの再校正に基づき、#549由来のheavy runtime responsibility（R）に、Consumed Contract readiness（C）、Proof topology readiness（P）、Boundary span（B）を組み合わせる。本節はpre-developmentの事前判定を正本とする。AI Develop中のnew Contract discoveryに伴うdynamic pause / re-evaluationは #718 の別責務であり、本節ではmarker / reason / resume契約やworkflow/runtime behaviorを追加・変更しない。

AI開発環境Issueを通常の `/codex develop` へ投入する前に、上記の「意味のある最小単位」を満たす候補について、inner `RuntimeMaxSec=700s` 内に実装・検証・報告まで収まるscopeかを見積もる。これはIssue境界の下位に置く事前確認であり、責務数や差分量を理由に、安全性・正確性・要求／設計整合性に不可分な変更を機械的に分割しない。

**R — Heavy runtime responsibility**: 次のproduction runtime責務を各1つのheavy responsibilityとして数える。

1. 新しいproduction event、`repository_dispatch`、workflow entryの接続。
2. accepted record、label、machine state、Ready/Draft等の不可逆または外部状態遷移。
3. paid AI callへの新規接続、または既存paid pathのownership変更。
4. timeout、cancellation、runner lossを扱う独立failure recovery。
5. workflow間handoff、producer-consumer ownership transfer。
6. concurrency、polling、deadline、retry suppression等のruntime orchestration。
7. App tokenまたはtrust boundaryを跨ぐ新しい権限境界。
8. 既存normal pathを維持した新path追加に伴う対称性・重複抑止。

単なるfixture追加、既存helperへの局所的なpure判定追加、docs同期は原則として数えない。ただしproduction ownershipやstate transitionを実際に変更する場合は数える。

**C — Consumed Contract readiness**: 評価対象はIssue自身が新規定義するContractではなく、そのIssueがprerequisiteとして消費するcritical cross-boundary Contractとする。

| 区分 | 消費するprerequisite Contractの状態 |
|---|---|
| C0 | same target mode / same trust boundaryでlatest main上formal proof済み。 |
| C1 | pure / dormant / synthetic / prepared等のnarrower modeではproof済みだが、target modeでは未実証。 |
| C2 | prerequisite Contract自体が未定義、または着手前に新しいcontract decisionが必要。 |

Issue自身がContractだけを定義/proofする独立単位は、その新規Contractを理由にC2扱いにしない。消費するcritical cross-boundary prerequisite Contractがなければ、Green条件上はC0相当とする。そのContractを同じIssueで即downstream consumerまで消費する場合は、下記の強制分割候補として扱う。

**P — Proof topology readiness**: Doneを証明するformal proofの構成を確認する。

| 区分 | Proof topologyの状態 |
|---|---|
| P0 | current formal proof topologyでDoneを証明可能。 |
| P1 | existing formal workflowへのfixture/assertion追加だけで証明可能。 |
| P2 | new runner / runtime supply / staging / observer / handoff等、proof infrastructure自体を先に成立させる必要がある。 |

P2 infrastructureそのものをdormant/preparedに作る独立Issueはadmit可能であり、P2だけで自動的にRed扱いにしない。他のriskと安全な独立単位の条件も確認する。P2 infrastructureと、そのproof対象integrationを同じIssueで完成させる場合はsplit-firstとする。

**B — Boundary span**: 次のcross-boundary categoryのうち、Issue内で新規導入またはmaterially変更するものだけを各1つ数える。

1. trusted source identity
2. runtime / staging
3. service / isolation
4. workspace / cache handoff
5. paid AI boundary
6. post gate / validation ownership
7. repository write / external machine state
8. workflow-to-workflow handoff

加算条件は、少なくともownershipを跨ぐ、trusted/untrusted authorityを跨ぐ、activation/reachabilityを開く、failure/cleanup ownershipを移す、durable identity/stateを境界越しに受け渡す場合を含む。既存main上の確定Contractをcallerがそのまま利用するだけならBへ加算しない。

R/C/P/Bを次の事前scope riskへ統合する。Red条件と強制分割候補を先に確認し、YellowはRed条件がない場合に限る。

| Risk | 条件 | 投入前の判断 |
|---|---|---|
| Green | R <= 3、C0、P0 / P1、B <= 3、既存/追加の強制分割条件なしを全て満たす。 | 通常投入可。 |
| Yellow | Red条件なしで、R = 4–5、C1だがdormant/proof-only、B = 4のいずれか。 | 分割を優先検討し、pure/prepared/proofとdownstream integration（prepared/helperとproduction wiringを含む）を分離できないかfresh確認する。 |
| Red / split-first | R >= 6、B >= 5、B = 4 + C1、B = 4 + R >= 4、または下記の強制分割候補のいずれか。 | 原則として投入前に分割する。 |

次の組合せはR/Bの個数にかかわらず強制分割候補とする。#549由来の既存4条件を維持し、#719のContract / Proof / Boundary条件を追加する。

- 新しいproduction pathと独立runner-loss recoveryを同じIssueで初めて実装する。
- producerとconsumerを同時に初めてproduction接続する。
- paid AI boundary、accepted/state lifecycle、独立failure recoveryを同時に実装する。
- 新しいproduction workflowを2本以上追加する。
- C1 Contractをproduction / paid / repository-write targetへ初めて昇格させながらconsumer wiringも行う。
- C2 prerequisiteを決めながらdownstream consumer/integrationも同じIssueで閉じる。
- P2 proof infrastructureを作りながら、そのproof対象integrationも同じIssueで完成させる。
- new cross-boundary Contractを定義し、その次boundaryのconsumerまで同じIssueで接続する。

強制分割候補は、各段階を安全性・正確性・要求／設計整合性を保つ独立単位へ分けられる場合に分割必須とする。分割自体が正本不整合を生む場合はIssue本文に不可分な理由を明示して人間が判断し、extended-runへ安易に切り替えない。runtime-heavyなworkflow変更は、可能なら (1) pure helper / trusted gate / prepared lifecycle、(2) production wiring / event connection、(3) independent failure recovery / cancellation recovery の順に分ける。各段階は単独でmainへ反映しても安全で、後続未実装の間にproductionが不完全状態へ到達しないことを必須とする。prepared/dormant codeを先行反映する場合は、default production runtimeから到達不能であることをfixtureで固定する。

通常Codex runの実績は次回同種Issueの判断へ反映する。5分以下は粒度が概ね適切、5分超〜8分は次回同種scopeを一段細かく分割することを優先、8分超〜10分は同一Issueへの大きな追加責務を避ける危険域、10分超はsuccessでも分割不足の実績として扱う。700秒上限に到達した場合は同scopeを単純retryせず、「Issue本文におけるcurrent implementation contract」と「Codex timeout・runner異常終了時の診断と再開」で現行契約とfailure categoryを確認し、scope再分割を第一選択にする。timeoutだけでscope過大と断定せず、host/runtime障害、契約矛盾、non-convergence等を切り分けた後に本基準を適用する。

elapsed単独でscope適否を決めず、`time-to-first-result + result category` をセットで扱う。短時間のrequirements/contract pauseはGreen evidenceと解釈せず、10分超のsuccessは引き続きundersplit warningとする。correction/Regression回数は現時点ではadmission thresholdへ使わない。new Contract discovery / proof topology discovery / split decisionはscope feedbackとして記録し、次回のfresh事前判定へ反映する。このelapsed feedbackはdynamic gateではなく、開発中の停止は[Issue起点開発中のdynamic scope decision](#issue起点開発中のdynamic-scope-decision)を正本とする。

変更行数とファイル数は補助指標であり、Issue境界の主指標にしない。概算のchanged lines（追加＋削除）は400以下を通常、400超〜700を注意、700超を分割優先検討の警告とする。小差分でもheavy responsibilityが多ければtimeoutし得るためR/C/P/Bを主指標とし、1つの確定判断と整合性維持に不可分な変更を行数だけで分割しない。

## 基本設計後の価値単位の開発

基本設計を現行方針で完了させた後、利用者が完了できる業務とその効果・優先理由を価値単位として選び、UI / API / DB / Job等の必要な範囲を横断して反復・漸進的に完成させる。Issueを優先順に選び、完成・評価の結果から次を決める。固定Sprint、役割、会議を追加するScrum一式は導入しない。必要になった時に再評価する。初回本番提供範囲を変更する判断は #534 に委ねる。

価値単位の親Issueには、利用者と完了する業務、効果・優先理由、対象POL / BR / REQ / AC / TCとCON / OOS、前提・依存・対象外、統合したシナリオのDone条件と操作評価条件を記録する。大きい単位は上記「Issueの分割単位」の基準で、安全に単独でmainへ反映できる実施Issueへ分け、親Issueに依存順序と統合評価を残す。Issue、PR、1回のAI実行を機械的に一対一対応させない。実施Issueの標準記録欄は `.github/ISSUE_TEMPLATE/value-unit.yml` を使用し、独立した設計判断には既存のdecision templateを使用する。

1. **着手を判断する**：対象IDと既存基本設計、前提・依存、対象外、実装 / DB / テスト / 運用範囲、検証方法、Done条件を実施Issueに記録する。上位仕様に未決または変更が必要ならその判断を先行させ、下流実装を止める。
2. **具体例と必要な詳細設計を確定する**：既存REQ / AC / TCを正として、正常時・境界・競合・失敗時の入力と期待結果を実装前に確認する。BDDの具体例を合意形成に用いるが、専用ツールや全TCのGiven / When / Then化は必須としない。選定シナリオの詳細設計は `docs/20_detailed_design/README.md` に従い必要範囲で確定する。
3. **小さく実装・検証する**：予約可否、月間標準 / 追加区分、時刻境界、状態遷移等、入力と期待結果が明確で重要な業務ロジックにはTDDを適用し、整理した項目ごとに失敗確認→通る最小実装→構造改善を反復して、改善後もテストを再実行する。DB / API結合、競合、Provider失敗は適切なテスト層で確認する。期待結果は要求・設計から導出し、実装出力を正解として写さない。全コードへのTDD義務化は現時点では決めず、最初の価値単位で基盤、作業量、検出した問題を評価して見直す。TDD対象外も必要な検証を省略しない。
4. **実施Issueと価値単位の完了を分けて判断する**：実施Issueごとに変更内容に応じた設計整合・AC→TC対応を確認し、実装を含むIssueでは実装テスト・結果と関連する既存機能の回帰を確認する。現在PR headの独立したCI証跡も確認する。既存のDraft / Ready / Claude Review手順は「関連修正の集約とレビュー準備」を正本とし、自己申告や未実施をCI成功と扱わない。統合後は実際の画面で業務シナリオを探索的に操作し、利用者が目的を達成できたか、分かりにくい手順や新たな問題がないかを確認する。観察、証跡、不具合、改善判断、残課題を親Issueに記録し、複数PRでも統合シナリオのDoneを判定する。開発単位と初期リリース全体の判定は `docs/40_test/01_TestPlan.md` を正本とする。CI / テスト基盤の具体化は #536、操作評価環境・手順は #537、AI実行環境への適合は #538 の責務とする。

**追跡例（最初の開発対象の決定ではない）**：生徒が同月の空き枠を一括Previewし、確定した予約を本人の一覧で確認する価値単位を仮定する。親Issueには `REQ-008 / AC-008-001〜010 / TC-F-008-01〜08` と、一覧の `REQ-005 / AC-005-001〜002 / TC-F-005-01`、通知の `REQ-101 / AC-101-001〜002 / TC-F-101-01` 等の関連追跡・回帰を `docs/40_test/04b_BulkReservationTraceability.md` と `04_RequirementsTestTraceability.md` に照合して記録する。認証済み生徒・公開済み将来枠・月間標準回数N・通知等の依存、統合操作での成功・競合後の再確認・送信失敗・再送の評価、Doneを残す。実施Issueは例えば「一括Preview / Confirmの具体例と必要な詳細設計の確定」と「確定設計に基づく一括操作の実装・AC / TC検証」を依存順に置き、各Issueの単独完了条件とmain反映時の安全性を上記分割基準で確認する。再送は `AC-008-010 / TC-F-008-08`、競合は `AC-008-005〜007 / TC-F-008-04〜05` に照合して確認する。具体的期待結果は対象要求・基本設計・TCを照合して確定し、この例だけで固定しない。

## 関連修正の集約とレビュー準備

Issue #125で、細かな関連修正ごとのClaude呼び出しを減らすため、新規のIssue起点PRをDraftで作成する方式を採用した。本節は、確定済みIssueのcoherent changeをDraft PRへ集約しreviewを準備する手順を定める。Issueの境界と再評価は「Issueの分割単位」を正本とする。

Issueを確定する際は、対象ファイル・節・IDに加え、同じ判断に伴う参照、用語、追跡表、図、検証範囲を洗い出して本文へ記録する。既存の別Issueを無断で取り込まず、範囲を広げる場合は人間の決定を先にIssue本文へ反映する。

### Issue本文におけるcurrent implementation contract

[Work Admission Control](#work-admission-control)に従い、投入後のDoD拡張と新規findingの着手を制御する。

Open Issueへ `/codex develop` を投稿する前に、Issue本文がその時点で有効な実装契約、すなわちscope、責務境界、入出力interface、完了条件および検証範囲を表していることを確認する。trusted conversationでこれらの実装判断が更新され、本文の記述が古くなった場合は、実行前にcurrent contractをIssue本文へ同期する。

本文と矛盾する過去のtrusted commentの技術契約は履歴として残してよいが、削除ではなく、Issue本文からcurrent contractが一意に判断でき、過去契約が置き換えられたことが分かる状態にする。本文と矛盾しない補足説明や進捗コメントまで機械的に複製する必要はない。

この実行前規約は、`develop-from-issue` がIssue本文とtrusted commentをDevelopment requestへ連結するIssue起点経路へ直接適用する。Claude review follow-upは既存のPR、review、closing Issueに基づくfollow-up gateと再開契約を維持し、本規約による本文同期手順またはcontext選択方式を追加しない。

Draft中はClaude Reviewのjob条件がレビューを抑止する。Draftをpushで更新しても自動Ready化はしない。必要な追加開発だけを同じIssueへ依頼し、変更が揃うまで同じPRへ集約する。AI Developerが生成するPR本文の`レビュー準備`欄と、通常PRテンプレートの`レビュー準備`欄は人間の確認記録であり、チェックボックス自体を機械的な認可・検証ゲートとは扱わない。

### 検証結果の出所

AI Developerが掲載する`Codexの報告`内のvalidation記述はCodexの自己申告であり、formal GitHub Actions evidenceではない。repository changeをpushした投稿ではworkflowが取得した`pushしたcommit` SHAを、そのrunが行ったrepository writeの識別子として表示する。このSHAはCodexが同一内容をvalidation済みであることを意味しない。formal current-head validationはGitHub Actions/checks側の別証拠を正本とし、AI Developerはそのstatus/resultを取得・判定しない。repository changeのないfollow-up投稿ではpush SHAを表示しない。

AI Developerの投稿またはjob successだけでは、別のmachine-generated evidenceが明示的に証明しない限り、少なくとも`Codexの報告`に記載されたcommand・条件での実行、その報告が最後の変更後かつ表示SHAと同一内容に対する実行、各validationのexit statusまたは出力の独立確認、GitHub Actions/checksの開始・完了・status/result、job successが報告内の各validation成功を意味することを保証しない。

人間は次を確認してからPR画面の **Ready for review** を実行する。

- 同じ判断に伴う関連修正がIssueの許可範囲内で揃っている。
- 影響するPOL / BR / REQ / AC / TC / CON / OOS、関連文書・図との整合を確認している。
- Codex-reported validationを自己申告の証拠として確認し、current headに適用されるGitHub Actions/checksをformal evidenceとして別に確認している。failure、未実施、未確認事項を隠さず、PR本文または最新コメントに`passed`とあることだけをformal evidenceとして扱わない。
- 未解決のBlockingや上流判断がなく、延期する影響はclosing Issue本文に既存の後継Issue契約どおり記録されている。
- PRとclosing Issueが停止中でなく、追加開発やpushが進行中でない。

`ready_for_review`後は既存のClaudeレビュー・停止・マージ条件を適用する。Claude ReviewはReady eventのheadを対象とする。trusted Codex follow-upはpush後に期待SHAを固定し、GitHub上のPR headがそのSHAへ反映されたことをboundedに確認してからReady化する。反映待ちの上限内に一致しない場合、または別SHAが観測された場合はReady化せず停止する。通常のClaude Reviewはpaid実行前とverdict投稿直前に、trusted APIから取得したPRのopen/Ready状態、current head、停止ラベルを確認し、event headと一致しない場合は実行・投稿・人間エスカレーションを抑止する。取得不能時も停止し、診断を残す。競合を完全には排除できないためmerge時の`--match-head-commit`は維持する。Ready後にheadが変わったreviewの`REQUEST_CHANGES`はfollow-up対象にせず、そのheadを人間または明示的なtrusted経路で再びReady化してレビュー要求する。Draftはマージできず、Ready化は承認やマージを意味しない。新規PR作成の`--draft`は[GitHub CLI仕様](https://cli.github.com/manual/gh_pr_create)、DraftとReadyの扱いは[GitHub公式説明](https://docs.github.com/en/pull-requests/reference/pull-requests#draft-pull-requests)を参照する。

Claudeの`REQUEST_CHANGES`後、reviewer Appを確認したtrusted workflowはreviewの`commit_id`がPRの現在headと一致するときだけPRをDraftへ戻す。一致しないstale reviewはDraft化もCodex follow-upも起動しない。通常の追加作業をレビュー前にまとめ直す場合も、人間が追加pushより前にDraftへ戻す。Draftへ戻す操作だけで開始済みのAPI呼び出しを取り消せるとは扱わない。Draftか非Draftかを問わず、単なるpushの`synchronize`はClaude Reviewを起動しない。

旧`pull_request_review` follow-upはcanonical PR writer待機後、trusted baseの`check-claude-followup-target.sh`でreview ID・review commit、PR番号・open状態・head・branch、canonical closing Issueのopen状態、両者の停止ラベルを再取得する。checkoutしたHEADもreview commitと照合し、実際のpaid Codex起動直前に同じtargetを再照合する。stale・closed・停止中・取得不能なら正常skipし、Codex、post-Codex gate、repository writeへ進まない。人間エスカレーションのpause/comment直前とCodex後のrepository write直前にも再照合し、対象が変わった場合はwriteと通知をskipする。#498の後継producerへ切り替える際は、その経路で同等のcurrent review・PR・closing Issue・checkout HEADとpaid call / target write直前の再照合を確認してから旧producerを停止する。新経路が確認されるまで旧経路の開始前提を撤去しない。

#498の`prepare-claude-followup-producer.sh`は後継producerの準備済み判定器であり、#227 / #229のactivation gateが完了してlatest mainで再評価するまでproduction workflowから呼び出さない。`claude-auto-rereview`専用consumerは#530のtrusted gateでcurrent HEADとrelationを確認し、accepted identityをrun / attemptとともにartifactへ保存してからmachine labelを消費する。通常Claude Reviewは`ai-followup-in-progress`付きPRのReady・停止解除を含むnormal paid reviewを抑止し、normal / auto reviewは同じPR単位のconcurrencyを使う。auto consumerはpaid開始境界もartifactへ保存してからmachine labelを消費し、verdict直前のcurrent HEAD・terminal状態・closing Issue pauseを再確認する。独立failure handlerはaccepted identityとpaid境界、fresh PR / HEAD / labelsを照合する。paid前にmachine labelが残る失敗は停止し、label消費後のpaid前失敗はcommon `state_inconsistent` pause、paid後の失敗・timeout・cancellationは投稿済みverdictと完了済みpauseを確認してからcommon `claude_execution_failed` pauseへ接続する。skipped normal Review runは後続reviewへの引継ぎとみなさない。producer未有効の間は、この準備済み経路からmachine label・専用Ready・dispatchを生成せず、旧follow-upの復旧は上記の現行契約に従う。

有効化後のproducerは同じIssue writer ownershipの中で、trusted gate後、machine label付与後のpaid Codex直前、およびrepository write直前にcanonical target helperとcheckout HEADを再照合する。後二者ではmachine labelの存続も確認する。machine label付与をpaid Codexより先に確認し、write/no-diff確定時刻を固定してReadyへ戻し、Ready以降のcurrent HEAD checkだけを10分以内に評価する。helperが`wait`を返す間だけpollし、`ready/success`のvalidated HEADだけ固定3-field payloadで一度dispatchする。失敗時はcommon human pause recordがactiveになったことを確認してからmachine labelを除去し、dispatch成功時はconsumer acceptedまで保持する。中断・重複・stale dispatchでは既存のvalidated HEADを再利用せず、current PR / Issue / HEADとReady以降の検証を再取得する。consumer未受理のmachine labelまたはReady状態が残った場合は自動再送せず、人間がpause recordと現状態を確認して正式な復旧経路で処理する。

`human-review-required`は要求・レビュー判断の停止であり、Draftによる作業準備とは別である。停止ラベルをDraft化で代替せず、追加開発や再レビューのために無断解除しない。停止中のopen PRに対する解除順序と再レビュー起動条件、merged/closed PRのstale label cleanupは「人間エスカレーション」節を正本とする。Draft PRではラベル解除だけでClaudeは起動せず、準備完了後のReady化がレビュー要求になる。

### 承認後の非Blocking改善

[Work Admission Control](#work-admission-control)でFollow-up / Idea候補を扱い、後継対応へ分離する場合は次の契約を適用する。

承認後の非Blocking改善は、先行マージが安全性・正確性・要求整合性を損なわないことを人間が確認した場合だけ、次の関連保守Issueへまとめてよい。closing Issue本文へ残る影響、先行マージ可能な理由、後継Issue、範囲・完了条件・時期または順序を記録し、PR本文へ要約とリンクを反映する。詳細は「スコープ外影響と後継Issue」を正本とする。非Blockingという分類だけで延期せず、要求や判断を実質的に変更した場合は古い承認を流用せず再レビューする。不要な微修正pushで承認済みheadを変更しない。

## ChatGPT Workのコンテキスト・コスト管理

ChatGPT WorkをGitHub作業の対話窓口として使う場合は、Issue単位でチャットを分け、Actionsログを失敗stepから段階的に取得し、作業内容に応じてモデルを選択する。同一head SHA・run IDのPR本文、review、Actions Job Summaryを再利用し、状態が変わっていない証跡を繰り返し調査しない。

Project Sources、Project instructions、チャット分割条件、モデル選択基準、開始テンプレート、チャット終了時と再開の正本は [`chatgpt-work-context-cost-operation.md`](chatgpt-work-context-cost-operation.md) とする。確定仕様はGitHub main上の正本文書、未決事項・検討状態はIssueを正本とし、チャットだけに決定を残さない。

## スコープ外影響と後継Issue

[Work Admission Control](#work-admission-control)で新規findingを分類し、本節は後継対応へ分離する影響の安全判断・記録・確認を定める。

Codexはスコープ外影響を発見した場合、その安全性・正確性・要求整合性への影響を調査して報告する。Claudeは、対応を後継Issueへ分離する妥当性と、その後継Issueを確認する。後継Issueの存在だけでblockingを解除してはならない。

後継対応へ分離できるのは、元PRを先にマージしても安全性・正確性・要求整合性を損なわない場合に限る。確定した決定はclosing Issue本文を正本とし、残るスコープ外影響、今回のPRを先にマージできる理由、後継Issue番号、後継Issueの変更範囲・完了条件、および対応時期または順序を記録する。PR本文にはその要約と元Issue・後継Issueへのリンクを記載する。Issueコメントで決定した内容も、確定後はclosing Issue本文へ反映する。

IssueとPRの新規記録では `## スコープ外影響と後継Issue` 見出しを使用する。各same-repository後継Issueは `- 後継Issue: #<number>` の1行で明示し、対象がなければ `none` とする。review context生成はPR本文とclosing Issue本文のこの定型欄と、既存の英語形式 `## Scope-out impact and follow-up` / `- Follow-up Issue: #<number>` だけを読み、closing Issueと重複しない後継Issueを再帰せずに取得する。PRとclosing Issueから抽出した異なる後継Issueの合計に適用する上限値の正本は `build-review-context.sh` の `follow_up_issue_limit` であり、現在は5件である。6件以上が抽出された場合は切り捨てずreview context生成をfail-closedで停止する。後継Issueを整理・分割するか、人間レビューへ切り替えて復旧する。後継Issueの番号・タイトル・state・本文はuntrusted data境界内のsnapshotとしてClaudeへ渡す。定型欄外の通常の番号参照は後継Issueとして扱わない。明示された後継Issueを取得できない場合も、存在しないと推測せずreview context生成をfail-closedで停止する。

見出しと後継Issue行の言語が混在する場合は定型欄として抽出しない。`## スコープ外影響と後継Issue` など上記の定型見出しに文言が完全一致する欄だけを抽出し、`## 追加のスコープ外影響と後継Issue` のような派生見出しは対象外とする。これは過去データとの互換のためであり、新規記録には日本語形式を使う。

## 必要なGitHub Actions設定

Repository secrets:

- `DEV_APP_PRIVATE_KEY`
- `REVIEW_APP_PRIVATE_KEY`
- `OPENAI_API_KEY`
- `DEEPINFRA_API_KEY`（DeepInfra Investigator専用。read-only調査workflowのDeepInfra API call stepだけで使用し、Issue・PR・ログ・artifactへ値を出力しない）
- `NOTIFICATION_WEBHOOK_URL`（人間通知用のDiscord Webhook URL。未設定でもGitHub上の停止・ラベル付与は行う）

Repository variables:

- `DEV_APP_CLIENT_ID`
- `REVIEW_APP_CLIENT_ID`
- `ANTHROPIC_FEDERATION_RULE_ID`
- `ANTHROPIC_ORGANIZATION_ID`
- `ANTHROPIC_SERVICE_ACCOUNT_ID`
- `ANTHROPIC_WORKSPACE_ID`
- `CLAUDE_MODEL`（protected pathsを含む高リスクClaudeレビューで使用するモデルを指定する）
- `CLAUDE_MODEL_STANDARD`（protected pathsを含まない通常Claudeレビューで使用するモデルを指定する）
- `CODEX_MODEL`（Issue開発とClaudeレビュー追従の通常モデルを指定する。Issue単位の選択は次節を参照）

EnvironmentではなくRepositoryスコープに設定する。Repository variableの値は既定でIssue、PR、ログ、文書へ貼り付けない。ただし `CLAUDE_MODEL` / `CLAUDE_MODEL_STANDARD` / `CODEX_MODEL` のモデルIDは機微情報ではないため、変更履歴と検証証跡を残す目的でIssueやPRへ記録してよい。

通常のAIモデルを変更する場合はworkflowへモデルIDを直書きせず、`CLAUDE_MODEL`、`CLAUDE_MODEL_STANDARD`、または `CODEX_MODEL` のRepository variableを更新する。これにより通常のモデル切替では `.github/**` のCode Owner保護対象workflowを変更しない。Claude reviewは自動マージゲートと同じprotected-path判定を使い、protected pathsを含む場合は `CLAUDE_MODEL`、それ以外は `CLAUDE_MODEL_STANDARD` を選ぶ。モデルvariableを未設定または空白のみの状態はサポートせず、workflowはモデル実行前のpreflightで実値を確認して該当時は失敗させる。Claude側のpreflightは、PR headをcheckoutした作業ツリーを信頼せず、通常は信頼済みcurrent base commit由来の`classify-claude-review-risk.sh`を個別に`$RUNNER_TEMP`へ取得して実行する。base commitにこのscriptがない、scriptを初めて導入するPRだけは、workflow内の固定コピーへfallbackする。このfallbackはbootstrap専用であり、PR head由来のscriptは実行しない。workflow内固定コピーと正本scriptの一致は`test-claude-review-workflow.sh`の`RISK_CLASSIFIER` fixtureで維持・検証する。これに対しmerge gateは、同じ信頼済みbase commitをcheckoutした作業ツリーから`verify-pr-gates.sh`を実行し、その兄弟scriptとして`classify-claude-review-risk.sh`を解決する。この作業ツリー依存を保つため、merge gateでclassifierの単体取得方式を使ってはならない。Codex側は次節のtrusted selectorを使い、通常モデル値の形式検証も同helperのContractを正本とする。

例外として、DeepInfra Investigatorは任意モデルIDをIssue入力やRepository variableから実行させないことをsecurity boundaryとするため、許可するDeepSeekモデルを `.github/scripts/deepinfra-investigator.py` の `ALLOWED_MODELS` で固定する。workflow側のcommand→model対応とpreflight allowlistはentry boundaryでの多層防御として同じ許可集合を意図的に重複保持し、`test-deepinfra-investigator.sh` で一致を回帰検証する。DeepInfra Investigatorのモデル変更は通常のモデル切替ではなくsecurity allowlist変更として扱い、Issueで範囲を確定しCode Owner review対象の差分として反映する。

### Issue単位のCodexモデル選択（#745 / #759）

機械正本は `.github/scripts/select-codex-issue-model.py` と同責務の `.github/scripts/codex-issue-model-policy.json` とする。policyの `entries` は空を維持し、#759で `.github/workflows/ai-developer.yml` の初回・正式resume develop・Claude follow-upへ接続する。空policyでは `CODEX_MODEL` 値を保持する。paid Luna自然試行・policy entry activationは未開始で、stream producerは下記#772、Issue-origin persistenceは下記#797、Claude follow-up persistenceは下記#798に限定し、通常Issueのvariable運用と既存 `medium` 固定を維持する。

helperはcallerが明示的に渡す `--policy PATH` とstdinの単一request JSON（`repository`、`issue`、`normal_model`）を読む。`normal_model` はtrusted normal `CODEX_MODEL` 値であり、Issue/PR/comment由来のoverrideではない。callerがhelperとpolicyをtrusted base/mainから取得する責務を持ち、PR head、model生成file、Issue/PR本文、commentをpolicy正本にしない。helper自身はnetwork / git / GitHub write・open-state検査・永続stateを持たず、policy取得失敗やidentity不明を未登録扱いへfallbackしない。

policy/requestのclosed schema、exact repository / positive integer Issue、重複Issue / JSON key拒否、model allowlist、入力byte / entry数上限、canonical出力のexact fieldはhelperを唯一の正本とする。正常未登録Issueはnormal model、exact opt-inだけはpolicyの `gpt-6-luna` を返し、variable変更はopt-inへ影響しない。正常時は `schema/version/issue/model/selection` の単一bounded JSONとexit 0、拒否時はstdoutなし・固定診断と非0を返し、raw入力・prompt・秘密値を反射しない。effort入力や任意model overrideは受理しない。

opt-in entryは初回実行前に人間Code Owner reviewを経てmainへ反映する。対象IssueとPRがopenの間はentryの変更・削除をしない。変更・削除が必要なら停止して別の人間判断を行う。この固定ownershipはopt-in対象に限定し、default Issueのvariable変更運用には広げない。

初回/resume callerは既存entry/resume gateが確定した `ISSUE_NUMBER` と、既存context stepがcurrent mainとして固定した `base_sha` を使う。follow-up callerは既存current review/head・closing Issue/open・停止label gateとcheckout照合の成功後だけ、照合済みexact `ai/issue-N` のNを使い、PR番号をIssue番号としない。既存trusted `BASE_SHA` を維持し、任意PR本文/model出力をauthorityにしない。各callerはそのbaseからselector/policyを `RUNNER_TEMP` へ `git show` で抽出し、base blobと `git hash-object --no-filters` を照合する。PR/worktreeの同名fileは使わない。immutable運用と対象再評価は親 #744の対象とする。

選択結果は4096 byte以内のcanonical JSONを、取得済みselectorのpure APIが返すexact schema / type / identity / selectionとbyte単位で照合し、検証後だけstep outputへmodelを渡す。native execのmodel引数だけを切り替え、Repository variableは変更しない。取得不能・hash不一致・selector非0・結果不正・identity不明はpaid前でfail-closedとし、defaultへfallbackせず既存failure/pause handlerへ接続する。診断は固定 `default` / `opt_in` 分類だけとし、model IDの新規公開診断、telemetry / artifact / 台帳を追加しない。selector/policy/resultの一時fileは選択step終了時に削除する。

検証は `test-ai-developer-workflow.sh` のsecretless caller fixture、`test-select-codex-issue-model.sh`、`test-production-unreachable.sh`、selector fixtureおよびAI Workflow Regressionのcurrent-head fixtureで行う。guardはhash照合済みの上記exact model callerと下記#772のexact stream producerだけを許可し、不正callerの負例を維持する。Product POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの影響はない。

### fresh Codex exec usage抽出（#753 / #772）

機械正本は `.github/scripts/extract-codex-exec-usage.py` とする。pure API `extract(jsonl_bytes, context_bytes)` はcaller供給のbounded JSONL bytesと単一context JSON bytesからcanonical JSON bytesを返し、file I/Oを行わない。CLIは `--context PATH` の明示contextとstdinだけをbounded readし、正常時は単一canonical JSON行とexit 0、不正入力時はstdoutなし・固定非反射診断と非0を返す。contextは `schema/version/mode/process_outcome` だけで、`mode=fresh_exec` に限定する。callerによるprovenance取得は別責務であり、contextをtrusted authorityとして証明しない。

対象は新規thread・単一exec invocationに限る。thread/turn開始は各1件必須で、唯一のcompleted terminalのexact 5-field usageを累積snapshotとして1回だけ返し、加算・delta計算・欠落fieldの0補完をしない。UTF-8 / JSONのstrict検査、closed source fields、順序・矛盾拒否、入力byte / line / record上限、整数・内数制約、exact schemaの詳細はhelperを唯一の正本とする。item payloadはopaque JSONとしてのみ検査し、token偽装・prompt・command・thread ID・raw errorを結果へ採用しない。

出力は `schema/version/source/availability/reason/usage` だけで、sourceは常に `codex_exec_jsonl_workload_reported`。成功process・唯一completed terminal・非zero valid usageだけが `reported / terminal_cumulative` となる。全5値zeroは `unavailable / zero_unverified`、process非success・error/failed terminal・terminal欠落も固定reasonと `usage:null` で返す。reasonはprocess cancelled→failed→unknown→error/failed terminal→missing terminalの順を優先する。完全なJSON行でterminalが欠けた場合は取得不能として有効だが、壊れた/truncated行は不正入力として拒否する。取得不能・zero_unverifiedを費用0・課金なし・provider明示zeroと扱わない。

#772では下記trusted supervisor経由でproductionへ接続し、extractorのpure API / schemaを維持する。`test-production-unreachable.sh` はexact selector inventory、supervisor内の唯一の明示extractor loader、#781のexact pure validator loader、AI Developerのexact approved producerと下記#797 / #798のexact caller以外の参照を拒否する。検証は `test-extract-codex-exec-usage.sh` のsecretless synthetic fixture、caller fixture / guard、および既存AI Workflow Regressionのcurrent-head fixtureで行う。raw JSONLはfixture内のmemory/stdinとsupervisorのmemoryだけで扱い、保存・公開しない。このproofはCodex 0.159.3の実取得provenance、provider billing、actual USD、hard cap、complete all-request coverageを証明しない。merge後のactual native証跡とdownstream persistenceは下記#772および親 #744・調査 #746で扱う。exec resume thread、料金計算、Luna paid試行は追加しない。Product POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの影響はない。

### usage evidence実行identityのpure検証（#780）

機械正本は `.github/scripts/validate-codex-usage-identity.py`。pure API `validate_identity(identity_bytes)` はcaller供給の単一JSON object bytesをclosed schemaで検証し、全fieldを保持した新しいdictを返す。schema / version、repository、workflow job ID、整数範囲、SHA、model、CLI version、medium / fresh_exec固定、4096 byte上限とstrict JSON拒否の詳細はhelperを唯一の正本とする。非canonical JSONも受理し、不正入力は生入力・例外chainを含まない固定 `ValueError("invalid_identity")` で拒否する。型検証はtrusted authorityの証明ではなく、identity確定は下記#797 / #798のtrusted caller責務とする。

identity helper自身にはCLI・stream解釈・evidence組み立て・取得・永続化・費用計算・production callerを追加しない。`test-validate-codex-usage-identity.sh` のfinite secretless fixtureと既存selector / guard / Regressionで検証し、guardはexact inventory literalと下記#782 / #796のexact loaderと#797 / #798のexact callerだけを許可し、その他のproduction caller・未知caller・copy・追加loaderを拒否する。#780 → #781（stream）→ #782（結合 / CLI）の依存順を維持する。R0 / C0相当 / P1 / B1、Greenの独立pure Contractであり、Product POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの影響はない。

### usage stream recordのpure検証（#781）

機械正本は `.github/scripts/validate-codex-usage-stream.py`。pure API `validate_stream(stream_bytes)` は#761のcanonical `codex-exec-stream` v1 recordを検証し、`evidence_status: recorded / missing / invalid` と `stream_result: dict / null` だけを返す。空bytesだけをmissing、不正・非canonical・上限超過をinvalidとし、いずれもstream_result=nullでunknownへ渡す。closed fields、status / rc整合、reported時のrc=0、strict JSON、末尾LF高々1個を含む4096 byte上限の詳細はhelperを唯一の正本とする。妥当なunavailable・非成功statusはrecordedのままrc / reason / nullを保持し、usage 0へ補完しない。

usage内部schema・数値・availability / reasonの正本は既存extractorの `validate_result`。固定同一directoryのextractor sourceだけを明示loaderで読み、canonical usage bytesを渡して返却dictを使用する。loader欠落・import失敗はrecord invalidへ隠さず、生path・例外chainを含まない固定 `ValueError("validator_unavailable")` で停止する。loaded codeはtrusted repository前提であり、runtime provenanceを証明しない。CLI、identityの利用、最終evidence組み立て、journal取得、永続化、費用計算、production callerは追加しない。

`test-validate-codex-usage-stream.sh` のfinite secretless fixture、既存extractor / supervisor / selector、横断guard / Regressionで検証する。guardは当該helperのexact loader / API sourceとinventory、および下記#782 / #789のexact pure loaderを許可し、既存supervisor例外と下記#797 / #798のexact callerを維持し、その他のproduction caller・未知caller・copy・追加loaderを拒否する。R0 / C0相当 / P1 / B1、Greenの独立pure Contractであり、Product POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの影響はない。

### usage evidence recordのpure結合とCLI（#782）

機械正本は `.github/scripts/build-codex-usage-evidence.py`。pure API `build(identity_bytes, stream_bytes)` は固定同一directoryの#780 / #781 validatorをidentity → streamの順で呼び、実返却objectを `codex-usage-evidence` v1のcanonical ASCII JSON bytesへ結合する。identity / stream / usageの入力schemaを複製しない。closed output、8192 byte上限（LF除外）、固定非反射例外の詳細はhelperを唯一の正本とする。identity不正はrecordなし、validatorロード・出力契約失敗は `validator_unavailable`、出力上限超過は `invalid_evidence` として停止する。

`billing_status=unverified` とworkload-reported sourceを固定し、missing / invalidはstream_result=nullのunknown recordにする。妥当なunavailable・capture_limit_exceeded・execution_not_started等はrecordedのまま、元のstatus / reason / rc / nullを保持する。rc0 + process_failedも#781の結果を維持し、recordedは正常終了・producer由来・課金検証済みを意味しない。identityの型検証はGitHub authorityを証明せず、journal値やPIDも改ざん不能な課金証明としない。usageの0補完・加算・USD変換を行わない。

CLI `python3 -B .github/scripts/build-codex-usage-evidence.py --identity FILE` は明示identity fileとstdinだけを各4096+1 byteでbounded readし、成功時にcanonical+LFの単一行とexit0を返す。stream欠落・不正もunknown recordとexit0、引数不正はexit2、入力I/O・identity不正・依存／出力失敗は固定診断とexit1とする。moduleロード以外のfile読取はCLI入力のみで、network / subprocess / env lookup / 状態書込を行わない。

`test-build-codex-usage-evidence.sh` は実validator / extractor直結、全identity field保持、recorded≠billing verified、unknown分類、canonical / closed output / 上限、CLI / 固定診断 / canary非反射を確認する。各上流専用fixtureで詳細schemaを回帰し、selector / guard / 既存Regressionで検証する。guardは2つのexact loader・inventoryと下記#797 / #798のexact callerだけを許可し、その他のproduction caller・未知caller・copy・追加loaderの拒否を維持する。#778のpure record結合を下記#797が消費する。ledger / GITHUB_OUTPUTへのusage本文保存・課金照合・Luna試行は未接続とする。R0 / C0 / P1 / B1、Greenであり、Product POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの影響はない。

### bounded unit journalのpure単一stream選択（#789）

機械正本は `.github/scripts/select-codex-usage-journal.py`。pure API `select_stream(journal_bytes)->bytes` はLF区切りのjournalから単一 `codex-exec-stream` 候補を選び、元の行bytesを固定同一directoryの#781 `validate_stream` へ渡す。stream / usage schemaを複製せず、canonical条件を緩めない。CLI、network / subprocess / env lookup / 状態書込はなく、exact loaderは#782と同じget_source / compile / exec方式でcacheを書かない。依存失敗は生入力・path・例外chainを含まない固定 `ValueError("validator_unavailable")` とする。

bytesのみ・16 MiB上限で、空行・非JSON診断行を無視する。先頭ASCII空白を除いて `{` で始まる行はstrict UTF-8 / 単一JSON / duplicate key・NaN・Infinity拒否でparseし、破損は選択全体をinvalidにする。他schemaは無視し、対象候補が複数なら同一内容でもinvalid。単一候補の#781検証成功時はcanonical bytes（末尾LFなし）、対象なしは `b""`、入力型・上限・JSON破損・重複・#781不正は固定 `b"invalid"` を返す。このsentinelは#781でinvalidとなり、missingへ隠さず、journal内容を反射しない。validなunavailable / rc / statusは保持し、recordedを正常実行・由来・課金証明へ昇格しない。

APIの受理上限はproduction取得がboundedで切り詰め無しである証明ではない。trusted journal authority・同unit性も確定せず、後続callerがunique unit・取得成否・上限・非切り詰めを確認する。first / last選択、raw journal保存、自由文reason、0補完、retry / fallbackは追加しない。production persistence・journalctl・systemd lifecycle・artifact / upload・GITHUB_OUTPUT・台帳 / 価格 / 課金照合・Luna policy / provider / Secrets / Variablesは変更せず、#785のhelperへ依存しない。

`test-select-codex-usage-journal.sh` は実extractor / #781へ直結したfinite secretless fixtureで、reported / unavailable、診断・他schema混在、候補0 / 1 / 2・同一重複、strict parse拒否、noncanonical、4096 byte stream / 16 MiB journal境界、入力型、非反射、依存固定エラーを確認する。selector / inventory・横断fixture・guardも同期し、guardはexact source / loaderだけを追加許可して未知caller・copy・追加loader・下記#797 / #798以外のproduction接続拒否を維持する。selector変更時はcurrent-head正式full Regressionを確認する。R0 / C0相当 / P1 / B1、Greenの独立pure Contractで、Product POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの影響はない。Issue-origin persistenceは下記#797へ接続し、Claude follow-up persistenceは下記#798とする。job cancel / runner lossでartifact回収を保証しない。Luna未開始・試行全体10 USD・まず1成果・逐次費用確認・unknown非0・自動retry / fallback禁止を維持する。

### bounded unit journal収集とsanitized evidence（#796）

機械正本は `.github/scripts/collect-codex-usage-evidence.py`。API `collect(identity_bytes)` は#780でidentityを検証し、job / run_id / run_attemptからexact unitを内部生成する。CLIは引数なしでstdinのidentityをbounded readする。任意unit / path / commandを受けず、固定同一directoryの#789 selector・#782 builder・#780 validatorと既存の推移的dependencyだけをロードし、schemaを複製しない。

固定 `/usr/bin/journalctl` をshellなし・exact unit・`--no-pager --output=cat --quiet`で1回だけ起動する。正常EOFとexit0のbytesだけをselectorへ渡し、16 MiB + 1 byteでoverflowを検出して切り詰めない。取得deadline / cleanup boundの詳細はhelperを正本とし、timeout / exec error / nonzero / overflowはinvalid、正常取得で候補なしはmissingとする。出力はbuilderのcanonical evidence + LFだけで、unknownをusage 0へ変換せず、stderr / raw journal / raw JSONL / 自由文例外を保存・公開しない。

`test-collect-codex-usage-evidence.sh` のfinite secretless pipe fixtureと既存selector / guard / Regressionで検証する。guardはcollectorのexact source・3つのfixed sibling loaderと下記#797 / #798のexact callerだけを許可し、#792のexact bootstrap例外と未知caller・copy・その他のproduction接続拒否を維持する。fixture inventory変更はcurrent-head正式full AI Workflow Regression対象とする。actual transient-unitでの取得・trusted caller authority・課金はこのsynthetic fixtureで実証しない。Product POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの影響はない。

### Issue起点usage evidenceの収集・artifact保存（#797）

機械正本は `.github/workflows/ai-developer.yml` の `develop-from-issue` とする。initial `/codex develop` と正式 `/ai resume develop` が同じpost-Codex callerを通る。`issue_context` はmodel実行前にcollectorを含む固定6 helperのbase blob identityをstep outputへ記録する。callerはpost-Codexにfresh専用temp directoryへ同baseから通常blobを再materializeし、全identity照合後だけ実行する。worktree版・pre-model copy・RUNNER_TEMPのleftoverをauthorityにせず、未知dependency / loader / search pathは追加しない。

identityは#780を型正本とし、repository / run / attemptはGitHub context、Issue番号は既存entry / resume gate、base SHAは `issue_context`、modelはtrusted selectorから構成する。`job=develop-from-issue`、`pr_number=null`、`cli_version=0.159.3`、`reasoning_effort=medium`、`invocation_mode=fresh_exec` を固定する。collectorはexisting `systemd-run --wait --collect` 復帰後のroot journal authorityを `sudo -n -- /usr/bin/env -i` とisolated Pythonで再利用し、identityからexact `codex-developer-<run>-<attempt>` を生成する。helper取得・分類契約を変更せず、raw journal / JSONLをshell変数・file・artifactへ保存せず、sleep / retry / sync / flush frameworkを追加しない。

collector成功時だけcanonical evidence 1 object + LFを `RUNNER_TEMP/codex-usage-evidence.json` へ移し、pinned upload actionでdevelop / run / attemptを含むartifact名・7日保持・sanitized file 1つだけを保存する。pin / path / conditionの詳細はworkflowを正本とする。identity中間file・prompt・command output・raw journalをartifact化せず、usage本文をGITHUB_OUTPUT / Issue comment / #665 ledger / repositoryへ保存しない。収集・upload・outcome summaryだけをnon-fatalとし、failureをstep outcome / Job Summaryで可視化する。既存Codex result・host integrity・requirements / scope pause・diff guard・repository-write gateを維持し、artifact欠損 / invalid / missing / usage unavailableをunknownとして扱い、0補完しない。

`test-ai-developer-workflow.sh` は実run blockで6 base blobの記録・復元、worktree / leftover非採用、root caller固定argv、identity・分類・失敗時非保存、success-only pinned upload、lifecycle隔離を検証する。guardは上記exact caller bytes / metadataだけを例外とし、改変・未知callerを拒否し、follow-upの許可は下記#798のexact callerだけとする。開始前checkpointのR2 / C0 / P1 / B2、Yellow bounded admitを維持する。既存root journal readとsuccessful natural runの即時visibility証拠を再利用し、merge後最初のIssue起点natural runのsanitized artifactとrecorded / missing / invalid分類をactual transient-unit integration proofとして確認する。local fixtureは実runner journal権限・反映順序・artifact転送・課金を証明せず、job cancellation / runner lossで回収を保証しない。Claude follow-upは下記#798を正本とし、Luna paid trialは未開始。Product POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの影響はない。

### Claude follow-up usage evidenceの収集・artifact保存（#798）

機械正本は `.github/workflows/ai-developer.yml` の `respond-to-claude` とする。既存current review / checkout / paid直前target gateを維持し、Codex実行へ進んだsuccess / failureだけを収集対象とする。`followup_context` で固定6 helperのPR base blob identityをmodel前に記録し、post-Codexでfresh専用tempへ再materializeする。復元・root collector transport・sanitized single-file upload・7日保持・non-fatal outcome summaryは上記#797のpatternを再利用し、collector / schema / ledger契約を変更しない。

identityは#780を唯一の型正本とし、Issue番号はtrusted exact `HEAD_REF=ai/issue-<n>`、PR番号はtrusted pull_request event、base SHAは `github.event.pull_request.base.sha`、modelはtrusted selectorから構成する。repository / run / attemptはGitHub contextを使い、`job=respond-to-claude` と既存 `0.159.3 / medium / fresh_exec` を固定する。collectorが生成するexact unitは `codex-followup-<run>-<attempt>`、artifact名はfollowup / run / attemptでIssue起点と区別する。raw journal / JSONL / identity中間物を保存・公開せず、unknown非0と既存Codex result / requirements gate / diff guard / repository-write semanticsを維持する。

`test-ai-developer-workflow.sh` は上記#797と同じ実run block fixtureでidentity・6 blob復元・root transport・sanitized-only保存・収集失敗・lifecycle隔離を検証し、exact branch拒否・event PR番号・PR base authority・exact follow-up unitを追加確認する。`test-production-unreachable.sh` は#792 / #796 / #797の例外を維持してexact follow-up callerだけを追加許可し、改変・copy・未知callerを拒否する。開始前checkpointのR1–2 / C0 / P1 / B1–2、Yellow bounded admitの範囲とし、新規prerequisite Contractは追加しない。current-head正式AI Workflow Regression / PR Traceabilityと、自然なClaude follow-up runのsanitized artifactを確認する。local fixtureはactual journal / artifact転送・課金の証明ではなく、cancellation / runner lossで回収を保証しない。自然run evidenceの統合は親 #794、price / cost / first Luna opt-in判断は#746で扱い、paid diagnostic / blind retry / Luna trialを追加しない。Product POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの影響はない。

### bounded native stream supervisor（#761 / #764 / #772）

機械正本は `.github/scripts/supervise-codex-exec-stream.py`。API `supervise(argv, parser, result_validator)` は明示argvと既存extractorの `extract` / `validate_result` callableからcanonical JSON bytesを返す。結果schema・usage判定はextractor側の `validate_result` で共有し、pure parserの入出力契約を変更しない。CLIは `--extractor SOURCE_PATH -- ABSOLUTE_EXECUTABLE [ARG ...]` の明示sourceだけをimportし、暗黙探索・model選択をしない。argvは最大128件・UTF-8合計64 KiB、NULなしのstringで先頭はabsolute executable pathに限定する。不正invocationはchild起動前に固定stderrとexit 2で拒否する。helperは `shell=False` でchildを1回だけ起動し、stdin / cwd / envをcallerから継承する。credential取得・環境追加・git / network / GitHub writeは行わない。

stdoutを64 KiB以下のchunkで読み、16 MiB以内をmemoryに保持する。超過時は保持bufferを破棄して `capture_limit_exceeded` とし、その後もEOFまでdrainする。stderrはDEVNULL。raw bytesをdisk / journal / stdoutへ保存・反射せず、child outputをJSONLと断定して転送しない。stdout EOFとwait完了後、上限内のbytesを既存parserへ渡す。新規thread・単一exec contextのprocess outcomeはrc 0だけsuccess、positive / negative signal rcはfailedとし、cancelledを推測しない。parser例外・不正resultは `invalid_input`。usage unavailableとcollector failureを区別し、usage 0へ補完しない。

出力は `schema/version/process_returncode/collection_status/usage_result` の単一canonical JSON行、LF込み最大4096 bytes。signed process returncode（未開始null）とcollector statusを分離し、statusは `collected / invalid_input / capture_limit_exceeded / execution_not_started` のみ。collected時だけ既存parserのcanonical resultを保持し、他はusage_result=null。開始失敗は固定JSONとexit 2、child開始後のCLI exitはrc 0→0、positive rc→その値（1..255）、negative rc→128+signalとする。collector invalid / limitでchild成功を失敗へ変更しない。raw traceback / path / argv / error / body / thread_id / modelを反射しない。

#772では `.github/workflows/ai-developer.yml` のinitial `/codex develop`・正式 `/ai resume develop` の共通 `Run Codex developer` とClaudeの `Run Codex follow-up` だけをproducerとして接続する。各callerは既存trusted base SHA（Issue側 `steps.issue_context.outputs.base_sha`、follow-up側PR base SHA）からsupervisor / extractorのblob identityを取得し、tree entryが通常blobであることを確認してfresh `RUNNER_TEMP` directoryへ抽出する。`git hash-object --no-filters` の照合完了前にpaid execへ進まず、取得不能・type不正・hash不一致は固定非反射診断でfail-closedとする。PR/worktree版helper・Issue/PR/comment由来path/model overrideはauthorityにしない。service launcherへsource pathを明示argvで渡し、既存preflight後に `/usr/bin/python3 -I -B` でsupervisorを起動する。supervisor / native childは同じservice/cgroup内であり、child argvだけへ `--json` をexact once追加する。model selector、medium effort、workspace permissions、`--output-last-message "$CODEX_FINAL"` と既存final consumerを維持し、follow-upのcurrent review/head gateもpaid前に維持する。

`test-production-unreachable.sh` はexact selector inventory、review対象supervisor source内の唯一のextractor loader、上記2つのexact reviewed producer stepと上記#797 / #798のexact caller bytes / metadata / gatesだけを許可し、コピー・追加load・未知workflow caller・source/argv/hash/gate改変を拒否する。#759の既存model caller例外とProduct prepared guardのcoverageを維持する。CLI source / argvのruntime trusted provenanceはcaller責務であり、static guardやsynthetic recordは課金・actual native provenance・hard capの証拠ではない。

`test-supervise-codex-exec-stream.sh` はfake local childでcapture境界・超過後drain・大量stdout/stderr・stdin継承・終了コード・非反射を有限時間で検証する。#764では既存AI Workflow Regressionの独立systemd runnerで、productionのType=exec / control-group終了 / setpriv identity・capability除去 / NoNewPrivileges / syscall制約を照合し、有限synthetic childの同一cgroup、単一起動・stdin、rc 0/7/2と未起動null、bounded canonical journalとcanary非反射、16 MiB超過後drain、RuntimeMaxSecによるsupervisor / child / descendant収束を検証する。外側terminationでrecordが欠けた場合はunknownであり、成功やusage=0と扱わない。全unitはunique name・外側deadline・finallyのunit限定cleanupを使う。独立runnerがないlocalでは理由付きruntime SKIP、`GITHUB_ACTIONS=true`ではruntime不可・証明不成立をFAILとする。

#764 fixtureは有限stdin file・PID readiness metadata・終了後観測用RemainAfterExitを使い、productionの--collectとは異なる。API/proxy・全socket preflight・native binary・workspace permission・native schema / billing、およびproduction paid path全体の証明ではない。raw streamは永続化・公開せず、固定fixture diagnosticだけを出す。supervisor自身へのtimeout / retry / fallback / process group / session / cgroup / signal forwardingやproduction recoveryは追加しない。

#772のproduction service stdoutは既存fixed preflight diagnosticsとLF込み4096 bytes以内のsanitized canonical supervisor recordだけとし、native stdoutはpipe、stderrはDEVNULLへ送る。supervisor自身は既存unit journal以外のusage persistenceやconsumerを追加しない。Issue-originのsanitized evidence artifactだけを上記#797が保存し、follow-upは未接続とする。usage本文をStep Summary / Issue / PR / GITHUB_OUTPUT / repository file / external ledgerへ保存しない。collection invalid / limit / unavailableをusage 0やbilling成功へ変換せず、child rc preservationをprocess outcomeのauthorityとする。outer timeout / cancellationではrecord自体が欠け得るが、record存在を新たな成功条件とせず既存failure / cancellation / pause-resume / repository write / review lifecycleを維持する。

検証は既存 `test-ai-developer-workflow.sh` のtrusted source・不正type/hash・worktree差し替え拒否、3経路のexact one invocation / `--json`、raw canary非反射・canonical stdout・rc 0/nonzero/not-started・invalid/limitでもrc保持・final message / environment / hardening回帰と、parser / supervisor / guard fixtureで行う。WACは #772の明示判断どおりR2 / C1 / P1 / B2、Yellow bounded activationであり、policyは空・通常modelのまま。current-head formal Regression Successは必要だが、それだけではactual native JSONL schema / provenanceをC0としない。自然な通常AI Developer runでsanitized recordと既存behaviorを確認する責務は親 #746に残し、Issue-origin persistenceは上記#797のfresh WAC判断で接続する。Luna opt-in・paid trial・費用計算は未接続。Product POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの影響はない。

### DeepInfra Investigator

DeepInfra Investigatorは、信頼済みIssue上のコメント `/deepseek analyze` または `/deepseek analyze v4.1` で起動する。コメント投稿者とIssue作成者はいずれも `OWNER` / `MEMBER` / `COLLABORATOR` のいずれかでなければならない。通常コマンドは `DeepSeek-V4-Flash-0731`、`v4.1` 付きコマンドはallowlist済みの `DeepSeek-V4.1-Flash` を選ぶ。

調査workflowは `actions: read` / `contents: read` / `issues: read` のread-only権限だけを持ち、repository write、Issue/PR write、workflow dispatch、任意shell実行をモデルへ提供しない。結果はActions Step Summaryと7日保持artifactへ出力する。API失敗、schema不正、context取得失敗等はfail-closedとし、自動probe実行やproduction AI Developerの変更へ進めない。詳細な実行契約とtool allowlistの正本は `.github/workflows/deepinfra-investigator.yml` と `.github/scripts/deepinfra-investigator.py` とする。

### DeepInfra Review Benchmark

Claude Reviewのprovider移行評価は、production review経路と分離した手動のDeepInfra Review Benchmarkで行う。評価の検討状態と凍結済みexpected resultの正本はIssue #342とし、benchmark runnerへexpected verdictやexpected findingを渡してはならない。

Stage A runnerはdefault branch上の `workflow_dispatch` から、workflowに固定されたcase IDとmodel IDを1組だけ選んで起動する。任意PR番号、任意SHA、任意prompt、任意model IDは受理せず、自動matrix・自動retry・automatic fallbackを行わない。モデルvisible contextはcurrent mainの `CLAUDE.md` / `AGENTS.md` と、固定caseのbase→selected head差分・selected head時点の変更ファイル・current PR metadata/body snapshot・current closing/follow-up Issue snapshotから決定論的に構成する。follow-up候補はproduction reviewと同様にPR本文とclosing Issue本文の `スコープ外影響と後継Issue` 節（旧 `Scope-out impact and follow-up` 節を含む）の和集合から重複排除して取得し、closing Issue自身を除外する。PR bodyは `Closes #N`、`変更内容`、`検証`、`スコープ外影響と後継Issue`（旧 `Summary` / `Validation` / `Scope-out impact and follow-up` を含む）等のcurrent evidenceを保持する一方、historical model verdictを後付けで漏らさないため `レビュー準備` / 旧`Review readiness` / `Review response` / `Claude review` H2節を除外する。Issue #342 / #343 / #359 は評価・runner・paid実行の管理情報であり、follow-upとして記録されていてもsnapshotをmodel contextへ取り込まない。この除外はモデルvisibleなbenchmark instructionとcase metadataへ明示し、missing follow-up evidenceやblocking理由として扱わせない。historical Claude review本文、Issue #342のexpected result、selected headより後のPR commitはcontextへ含めない。Stage Aはcurrent-contract synthetic replayであり、mutableなIssue/PR情報を使用するためexact historical replayとは表現しない。

workflow権限はcontents/issues read-onlyとし、モデルへtoolやrepository write経路を公開しない。DeepInfra API callは既存 `DEEPINFRA_API_KEY` と `.github/scripts/deepinfra-investigator.py` のshared transport / secret redaction境界を再利用する。結果はproduction Claude Reviewへ投稿せず、Actions Step Summaryと7日保持artifactだけへ出力する。structured result schemaはcurrent `.github/workflows/claude-review.yml` のreview JSON schemaを読み、schema mismatch・free-form result・truncationはfail-closedとする。DeepInfra API応答受領後にschema不正・truncation・cost guard超過等でfail-closedする場合も、取得できたtoken usage、local/provider estimated cost、duration、validation status/reasonを先にJSON/Markdownへ保存し、workflowは失敗時もSummaryとartifactを回収する。API到達前またはprovider failureでusageが得られない項目は成功値を捏造せず `unavailable` と記録する。

Stage Aで許可するcase/model集合、固定SHA、context上限、単一run cost guardの正本は `.github/scripts/deepinfra-review-benchmark.py` とする。価格表は評価時点のDeepInfra公表価格をtrusted configurationとして固定し、paid run開始前に現行価格を再確認する。Issue #342で承認されたDeepInfra評価費用は全体で$10をhard ceiling、Stage Aは$2を目標上限とし、runnerは累積費用を自動で増やすfan-outを持たない。各runのprompt/completion token、provider/local estimated cost、duration、context hashを成果物へ記録する。Stage A paid execution、Stage B/C、shadow運用、production Claude Review provider変更はrunner実装Issueとは別Issueで扱う。

### DeepInfra共通usage telemetry

Investigator / Review Benchmark / Diagnostic A / Diagnostic Bは、paid stepだけに固定 `DEEPINFRA_USAGE_PATH=${{ runner.temp }}/deepinfra-usage.json` と `DEEPINFRA_USAGE_KIND`（`investigator` / `review_benchmark` / `diagnostic_a` / `diagnostic_b`）を渡す。共通producerとschemaの正本は `.github/scripts/deepinfra-investigator.py` の `UsageSidecar` / `deepinfra_request()` とする。request開始前とresponseのusage取得直後にatomic replaceで保存し、callerのprotocol / structured-output / analysis検証、budget終端、result artifact生成の失敗から独立させる。保存不能ならfail-closedとし、paid callのretryやfallbackは追加しない。

schema version 1はkind、trusted requestのmodel、request / response count、3種token数、`provider_estimated_cost_usd`、`usage_availability`、`missing_usage_response_count`、`request_error_count`、request単位の`requests`を持つ。各requestは連番、response受領有無、同じ4種usage field、固定 `error_reason_code`（`http_error` / `network_error` / `invalid_json` / `invalid_response` / `response_read_error` または `null`）だけを持つ。response countはHTTP errorを除く受領数で、不正JSONや本文読取失敗も受領後なら数える。欠落数は4種fieldのいずれかが取得不能なresponse数とする。tokenは非負整数、costは非負の有限数のみ採用し、booleanや文字列は数値に変換しない。

runのusage fieldは取得できた値だけの累積であり、全requestの確定総額とは限らない。未取得fieldは `null` とし、providerの明示的な0だけを0として保存する。全requestでresponseと4種fieldを取得しerrorもなければ `complete`、一部だけ取得済みなら `partial`、全field未取得なら `unavailable` とする。中断中のrequestも連番と未取得値を残し、error理由を推測しない。prompt、request payload、response本文、tool result、secret、header、raw provider errorは含めない。

4 workflowはpaid step後の `if: always()` でこのsidecarだけを `deepinfra-usage-<usage_kind>-<run_id>-<run_attempt>` artifactへ7日保持でuploadする。既存result artifactと分離した短期handoffであり、永続台帳へのwriteは下記consumer、横断集計は下記「DeepInfra台帳のread-only集計」で扱う。API callへ到達しない場合はsidecarがなく、uploadはwarningとなる。runner loss等でupload stepが実行できない場合の回収を保証するものではない。検証は `test-deepinfra-usage.sh` と既存DeepInfra / AI Workflow Regressionのsecretless fixtureで行い、integration evidenceは自然な次回runで確認する。

### DeepInfra永続usage台帳

#667の独立 `DeepInfra Usage Ledger` は4 producerの `workflow_run.completed` を受け、既定ブランチcommitの `.github/scripts/deepinfra-usage-ledger.py` だけを実行する。consumerの権限は `actions: read` / `contents: read` / `issues: write` とし、provider credentialは渡さない。same-repository、既定ブランチ、workflow name / path / event、eventと再取得したexact run / attempt / conclusion / HEADを照合し、artifact名とrepository / run / HEADが一致するusage artifactだけを読む。ZIPを展開・実行せず、単一 `deepinfra-usage.json` のサイズ、重複JSON key、unexpected field、model / reason allowlist、数値型・非負・有限性、requestと集計値の整合を検証する。schemaは共通producerを正本とし、consumerの厳密な入力境界・サイズ上限はhelperを正本とする。result、prompt、response、tool trace、raw errorは取得・保存しない。

paid対象外の判定基準はsource runの `conclusion == 'skipped'` とする。通常コメント等によるInvestigatorのgate skipを含め、record jobの `if` で除外し、台帳全体の固定concurrencyはworkflowではなくこのjobだけに置く。これによりskip runはwriterのpendingを置換せず、#665へ欠落recordも投稿しない。helperを直接実行した場合もexact run / attempt / workflow identity照合後に `skipped_run_ignored` で終了し、comments / artifactを読まない。gateを通過してpaid stepへ到達する前に失敗したrunは除外せず、artifactがなければ従来どおり `unavailable` / `artifact_missing` とする。non-skipped runの課金有無をconclusionだけから推測しない。

台帳正本はParent Issue #665のcomment streamとする。各commentは `deepinfra-usage-ledger:v1 / <run_id> / <run_attempt>` の単独行と、その後の単一JSON objectだけで構成する。helperのrecord schemaはrun identity / URL / conclusion / HEAD、usage集計、`telemetry_status` / `telemetry_reason_code`、UTC `recorded_at`を保持し、request配列は保存しない。validでもusage欠落は `partial` / `unavailable` のまま残す。artifact不在・期限切れは `unavailable`、不正schema / 内容・サイズは `invalid` とし、未検証の金額・token・model・countは `null` とする。run conclusionとtelemetry statusは独立であり、失敗runの取得済みusageも保存する。

identityは `run_id + run_attempt`。台帳全体の固定concurrencyでcheck-then-writeを直列化し、write直前まで#665 commentsを全ページ列挙して、`github-actions[bot]` のexact markerとrecord identityを確認する。人間の引用はrecordとして扱わず、既存recordは編集・上書きしない。POST応答喪失時は再取得で成立を確認し、確認不能なら固定reason codeをJob Summaryへ残してfail-closed停止する。API / metadata / identity異常でもwriteせず、paid runの結論変更・paid retry・自動再送を行わない。人間は原因解消後に元のconsumerだけを再実行する。Actions concurrencyはrunning 1件 / pending 1件であり、`cancel-in-progress: false` でもpending置換は起こり得る。cancel・runner loss・retention経過を含め自動回収を保証せず、未記録のsource run / attemptを照合してconsumerを手動再実行する。append済みの欠落recordは後から上書きしない。`test-deepinfra-usage-ledger.sh` がproducer追加時の接続漏れ、入力境界、重複抑止、権限・concurrencyをsecretless検証する。自然な次回runでdefault branch event / artifact取得 / #665投稿のintegration evidenceを確認し、検証目的のpaid callは追加しない。

### DeepInfra台帳のread-only集計

#668の `.github/scripts/summarize-deepinfra-usage.py` は#665 commentsだけを一次入力とする手動helperである。record schemaの検証はconsumerの `validate_record()` を共有し、exact marker、JSON identity、workflow / usage kind、model、repositoryに対応するrun URL、数値、実在するUTC日時、availability整合も確認する。`github-actions[bot]` / `Bot` の単独行exact markerだけを候補にし、人間の引用・checkpoint・その他commentは無視する。LLM、provider credential、Issue write、artifact / log取得、paid call、定期実行、通知、cost guardは追加しない。GitHubからの取得は明示的な `--fetch` だけで、既存 `gh api` の全ページGETを使い、権限は `issues: read` / `contents: read` で足りる。新しいsecretを要求しない。

```bash
python3 .github/scripts/summarize-deepinfra-usage.py --repo owner/repo --fetch \
  --since 2026-10-02T00:00:00Z --until 2026-11-01T00:00:00Z \
  --markdown /tmp/deepinfra-usage.md > /tmp/deepinfra-usage.json
```

外部取得を行わず再計算する場合は `--fetch` の代わりに `--comments /path/to/comments.json` を指定する。入力は全ページを連結したREST comments配列（各commentの `user.login` / `user.type` / `body` を保持）で、同じsnapshotとfilterから同じJSON / Markdownを生成する。snapshotには人間のcommentも入り得るため、共有する際はusage record以外の内容を確認する。MarkdownはJSON正本と同じ全項目の表示であり、再parseしない。`--workflow` / `--usage-kind` / `--model` / `--run-conclusion` / `--usage-availability` を組み合わせて絞り込める。

期間はrun開始時刻ではなく台帳の `recorded_at` とし、`--since` は含む、`--until` は含まない。UTCの秒精度ISO日時（`Z` / `+00:00`）を受け、結果にはfilterと実際の最初・最後の記録時刻を保持する。対象は#667 activation後に記録されたrun / attemptだけで、未記録run数や台帳の完全性は推測しない。historical paid rerunやbackfillは行わない。

`run_id + run_attempt` の重複判定はfilter前の全候補に適用し、不正候補を含む同一identityの全件を集計から除外する。JSONには全体のinvalid理由別件数とduplicate identity / comment件数、除外identityを診断として残す。schema-validな `telemetry_status: invalid` recordは未検証usageがnullの取得不能recordであり、不正commentとは区別する。run conclusionとusage availabilityも別々に集計する。summaryとworkflow / kind / model / conclusion / availability別groupは件数と4種usage合計を持ち、model未取得はnull groupとする。対象run ID / attempt / URLもidentity昇順で示す。

各fieldの `known_sum` は取得済み値だけの合計で、取得済み0件ならnullとする。`known_records` / `unknown_records`（fieldがnullの件数）と、取得済み値を持つ `partial_records` を併記し、partialの累積を確定総額と扱わない。complete / partial / unavailable件数も併記する。provider costは保存された数値の10進表現を丸めず加算し、JSONでは精度を保つ10進文字列（USD）として出す。providerが明示した0だけを0とする。

検証は `bash .github/scripts/test-summarize-deepinfra-usage.sh`。producer / consumer実出力との互換性、filter、重複、不正schema / 数値 / 日時、unknown / partial、小数加算、順序、JSON / Markdown、GET paginationをsecretless fixtureで確認する。既存AI Workflow Regressionの `test-*.sh` discovery以外のworkflow配線は変更せず、POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの影響はない。実recordとの照合は自然run発生後に行い、検証目的のpaid callは追加しない。

## GitHub Apps

developer Appとreviewer Appを分離し、対象リポジトリだけへインストールする。

| 権限 | developer App | reviewer App |
|---|---:|---:|
| Actions | Read | Read |
| Checks | Read | Read |
| Contents | Read and write | Read and write |
| Issues | Read and write | Read and write |
| Pull requests | Read and write | Read and write |
| Workflows | No access | No access |
| Metadata | Read | Read |

reviewer Appだけが承認後のマージを担当する。developer Appは自分のPRを承認・マージしない。どちらのAppにもWorkflows writeを付与してはならない。

GitHub CLI経由のメタデータではApp actorが `app/<slug>` に正規化される場合があるため、CLI/API由来のidentity検証では設定済みslugに対する `<slug>`、`<slug>[bot]`、`app/<slug>` の3形式だけを同一Appとして扱う。Webhook payloadを直接検証する箇所は、そのpayloadが返す `<slug>` または `<slug>[bot]` を完全一致で検証する。

## Anthropic認証

Anthropicは長期APIキーではなくGitHub OIDC / Workload Identity Federationを使う。Federation ruleはこのリポジトリの不変なowner/repository IDをsubject prefixに含め、他リポジトリからのtoken exchangeを許可しない。

## Claude API消費制御

Claude reviewのrun単位budgetはrisk classごとに設定する。protected pathsを含まないstandard review（`CLAUDE_MODEL_STANDARD`）は `--max-budget-usd 1.70`、protected pathsを含むhigh-risk review（`CLAUDE_MODEL`）は `--max-budget-usd 2.10` とする。上限到達、API失敗、出力不正をapproveへ変換せずfail-closedとし、自動retryしない。`--max-turns` は費用上限として扱わず、異常ループ検知へ別途必要になった場合だけ実測turn数以上の値を検討する。

production Claude Reviewとauto-rereview consumerは `anthropics/claude-code-action@8ce9314fa9a404564fa7e954cd84f25bcba2b829` を固定し、Claude Code 2.1.284 / Agent SDK 0.3.284を使用する。high-risk reviewはmodelやbudgetと同じrisk選択で `--effort high` を明示する。standard-risk reviewにはeffort引数を渡さず、現行の挙動を維持する。runtime更新時点のRepository variable `CLAUDE_MODEL_STANDARD` は `claude-sonnet-5` を維持する。Sonnet 5.5へのmodel切替は後続Issue #588でRepository variableを変更して行う。

利用量記録stepはverdict経路を阻害しない非致命stepとする。通常step logには、集計済みusage JSONを1行だけ出力し、Actions Job logs APIから回収可能にする。このJSONの項目はresult subtype、is error、turns、duration、estimated cost、input/output token、cache creation/read tokenだけである。Job Summaryにはそれらの利用量を表形式で記録し、workflowが付加する`リスク区分`、`Actionの結果`、`Schemaの検証結果`も含める。これらの付加項目はusage JSONには含めない。prompt本文、review本文、raw execution file、secret値はどちらにも記録しない。execution file未設定、ファイル不在、または集計失敗時はusage JSONをstep logへ出力せず、Job Summaryへ`実行時の利用量を取得できませんでした。`を記録する。集計失敗時だけはraw execution由来のstderrを通常logへ出さず、固定文言`Claudeの利用量集計に失敗しました。`を1行だけstderrへ出力する。

`modelUsage` が1件以上ある場合、token fieldはClaude Code session全体のモデル別累積値として、対象fieldが全modelで数値の場合だけ合算する。1modelでも欠落・非数値ならそのfieldは`null`とし、query call内の累積値であるtop-level `usage`へfield単位でfallbackしない。`modelUsage`が空または利用不能の場合だけ、token fieldをtop-level `usage`から取得する。`estimated_cost_usd`はquery全体のSDK見積りである数値の`total_cost_usd`を優先し、利用不能な場合のみ、全modelで数値の`modelUsage.costUSD`を合算する。一部でも欠落・非数値なら`null`とする。`modelUsage`とtop-level `usage`は集計範囲が異なり得る。

利用量が欠落・不正でも、review結果の厳密検証とverdict投稿は継続する。

Claude Codeの標準5分prompt cacheを使用し、Issue #61の高リスク2実行分と、後継Issue #63で追跡する実際の通常PR 1実行分のcache creation/read tokenを合わせて評価する。1時間cacheはwrite単価が高く、自動再レビューを停止した運用では再利用機会が限定されるため、反復利用の実測根拠が得られるまで有効化しない。

Message Batches APIは非同期処理であり、即時のreview verdictを必要とする同期PR gateへ導入しない。夜間処理など遅延を許容でき、複数の独立したreviewをまとめられる用途が生じた場合は別Issueで再検討する。

### Claude review失敗の分類と再実行

Claude Reviewの`review` jobは異常stallに対するwall-clock hard boundaryとして15分でtimeoutさせる。15分はreview品質の目標時間ではない。job timeoutまたはsuccess以外の終了では構造化verdictが成立したと扱わず、`needs.review.result == 'success'`を満たさないためmerge jobへ進まない。timeout後の自動retryは行わず、人間が失敗runを調査して再実行を判断する。

`Claude Review Failure Handler` は別runnerの `workflow_run.completed` から同一attemptの `Review` jobを確認する。source runの同一repositoryのbranchとHEADからPRを解決し、`pull_requests` の関連付けが空でも処理できるようにする。関連付けが存在する場合は解決したPRと照合する。Review成功・skip、古いHEADやrun、明示budget/spend分類はgeneric pauseを作らない。対象PRがreview workflowを変更した場合や分類signalを信頼できない場合もgeneric reasonを推測せず停止する。候補だけをtrusted default branchのhelperで `claude_execution_failed` としてpauseし、現在PR HEADを `paused_head` に記録する。primary Issueはbranch名から推測せず、既存のclosing Issue関係に従ってラベルを同期する。GitHub pause成立後のDiscord通知、重複抑止、競合時のfail-closed処理は `create-human-pause.sh` を正本とし、自動retryは行わない。

`execution_file` は実行成否・budget/spend/rate limit分類・usage計測に維持し、review内容はActionの `structured_output` を使用する。既存classifierの自由テキスト検証結果だけではnative出力を承認・棄却しない。Action successかつ最後のresultがsuccess/is_error=falseの場合だけnative検証へ進み、Action失敗や実行情報不正はvalidなnative出力があっても承認しない。native出力をenvへ渡す前に、固定版Actionと同じJSON直列化でexecution fileのnativeフィールドをマスクする。追加recovery pass・全reviewの自動retryは行わない。

生成用Schemaは `claude-review.yml` の `review-json-schema` データ行をcurrent baseから取得する。導入前base `9bf6ffcf5caa1dc8f98629851f0557653de542f7` にデータ行がない場合だけ固定生成制約をbootstrapし、既存base validatorを必須とする。他のbaseでの欠落、取得失敗、破損は停止する。workflow自体の改変は既存のCode Owner境界で保護し、PR側workflowが検証処理を削除した場合まで実行時に阻止する保証は追加しない。

Claude reviewの実行結果は、`Validate Claude review` stepがJob Summaryへ記録する `理由コード` を一次情報とする。`Record Claude review usage` の集計済みusage JSONと表は費用・利用量の補助証跡であり、失敗原因またはverdictを決めない。reason codeは信頼済みbase commit由来classifierによる実行分類と、workflowによるnative入力検査・base validatorの検証結果から決めるローカルな分類であり、Claude Providerの障害理由・復旧時刻・quotaを保証するものではない。raw execution fileとraw model/API output（promptおよびraw model出力中のreview本文を含む）は取得・転載・再集計しない。

Action successかつ最後のresultがsuccess/is_error=falseの場合、自由テキストresultの複数性は最終reasonを決めない。native出力がなければ `REVIEW_RESULT_MISSING`、あればnative検証結果を優先する。`REVIEW_RESULT_AMBIGUOUS` は下表の限定条件に残す。

例外として `Mask native review output` step自体が失敗すると、`Validate Claude review` はskipされ、Job Summaryのreasonは記録されない。この場合は `Save structured review` の固定エラー `CLASSIFIER_INTERNAL_ERROR` とmask stepの成否を診断の起点とし、raw出力を転載せずマスク処理を調査する。保存・verdict投稿はfail-closedで停止する。mask stepが成功してもreadyを出さない場合は通常の分類経路を継続し、native入力を空として扱う。

| 理由コード | 判定 | 人間の復旧手順 |
|---|---|---|
| `REVIEW_VALID` | 構造化reviewが検証済みである。 | 既存のverdict投稿を継続する。 |
| `RUN_BUDGET_LIMIT_REACHED` | result subtypeが`error_max_budget_usd`で、当該review実行の予算上限に達した。 | 当該実行の予算を利用可能にできる判断をした後、同じheadで新しいreviewを人が起動する。自動再試行しない。 |
| `ACCOUNT_SPEND_LIMIT_REACHED` | result subtype、error type、またはerror detailsのcodeが`enforced_spend_limit_reached`である。 | アカウント側の支出上限が利用可能になったことを人が確認してから、同じheadで新しいreviewを起動する。自動再試行しない。 |
| `TRANSIENT_RATE_LIMIT` | result subtypeまたはerror typeが`rate_limit_error`である。 | 制限が解消したと人が確認してから、同じheadで新しいreviewを起動する。自動再試行しない。 |
| `CLAUDE_EXECUTION_FAILED` | Actionがexecution fileを残す前に失敗した、または上記以外のerror resultが記録された。 | Action実行、認証・設定、入力状態を必要最小限の非機密証跡で調査し、原因を解消してから再実行する。 |
| `REVIEW_RESULT_MISSING` | 検証対象となる成功resultまたはnative出力がない。 | review出力の取得・検証経路を調査してから再実行する。 |
| `REVIEW_RESULT_AMBIGUOUS` | Action successだが最後のresultがsuccess/is_error=falseではなく、優先される実行失敗分類に該当せず、既存classifierの自由テキスト成功result候補が複数ある。 | review出力の検証経路を調査してから再実行する。 |
| `REVIEW_JSON_INVALID` | execution containerまたはreview JSONが不正である。 | 出力・検証経路を調査してから再実行する。 |
| `REVIEW_SCHEMA_MISMATCH` | review JSONが固定schemaに適合しない。 | 出力・検証経路を調査してから再実行する。 |
| `CLASSIFIER_INTERNAL_ERROR` | 信頼済みclassifier/validatorのbootstrapまたは内部処理を確認できない。 | 信頼済みbase commit由来のclassifier/validator bootstrapを確認してから再実行する。 |

HTTP status、特にHTTP 429、Action logの文言、または利用量だけから`ACCOUNT_SPEND_LIMIT_REACHED`と推定してはならない。構造化metadataがこのcodeを示さない失敗は、分類不能または別のreason codeとして扱う。上限到達と分類不能な失敗（少なくとも`CLASSIFIER_INTERNAL_ERROR`、不明なreason code、またはJob Summaryを取得できない場合）では自動再試行を行わず、人間が調査・判断する。

同じheadを再実行する前に、人間はIssue番号、closing Issue、PR番号、対象PR head SHA、失敗run ID、および失敗runのhead SHAを照合する。Job Summaryの`Claudeレビュー結果`でreason codeを先に確認し、必要な場合だけ該当stepの最小限の非機密情報を確認する。PR差分を変えずに再実行する場合は、GitHub Actions UIで当該runのreviewを再実行し、完了後に新しいrun IDとhead SHAが対象PRの現在head SHAに一致することを確認する。`human-review-required` による停止中の解除順序と、ラベル解除が同じheadへの再review要求になる条件は「人間エスカレーション」節を正本とする。head SHAが変わった場合は同じ実行の再試行として扱わず、新しい差分に対するreviewとして必要な確認をやり直す。

### Claude Review Cost Guard

Issue #390 のPhase 1は、`Claude Review` を `workflow_run` の `in_progress` と `completed` で監視する独立したread-only Cost Guardである。PR headをcheckout・実行せず、default branchから取得したhelperとActions metadataだけを使い、LLM、raw job log、usage telemetryの常時取得を使わない。`requested` はre-runで発生しないため、監視の根拠にしない。

監視keyはsame-repository head branchであり、workflow run IDではなくpaid execution attemptを単位にする。15分rolling windowは各attemptの`run_started_at`で集計し、同一run IDのRe-runも`run_attempt`ごとに別executionとして数える。初回runの`created_at`をRe-run時刻の代用にしない。最新attemptがcurrentから30分以内にあるsame-branchの全run IDについて、過去attemptを復元する。これはcurrentとその直前attemptの各15分窓を比較するためであり、最新attemptがその候補範囲より古いrunの復元は不要である。`completed` かつ `skipped` はpaid burstに数えず、`in_progress` はpaid-capable候補として数える。current attemptの窓が閾値以上で、直前のsame-key attemptの窓が閾値未満の場合だけ、その連続episodeの先頭として通知する。したがって4件目のnon-skipped / paid-capable attemptの`in_progress` activityでreview burst、3件目の`cancelled` attemptの`completed` activityでcancel stormを各1回通知し、rolling windowの前進で件数が閾値へ戻っても重複通知しない。APIから再取得した可変statusではなくevent activityを使うため、開始event後にattemptが完了しても起動回数の検知は失われない。review burstは`in_progress` activityだけを通知対象とし、同attemptの`completed` activityでは通知しない。永続stateは持たない。attempt取得はrunあたり最大20回、全候補で最大100回にboundedし、上限超過、取得不能、不正なmetadataでは通知判定を行わず診断に留める。2026-09-18〜21の実測では#378が15分8件・cancelled 6件、#339が7件・5件、#365/#343が各4件・3件だった一方、#387のreview-ready self-testは最大3件・cancelled 0件だったことが根拠である。

通知は既存`notify-human.sh`によるDiscordのみで、trigger、15分窓のrun数/cancelled数、head branch、取得可能ならPR番号、current run URL、および自動停止していない事実だけを含める。PR番号が安全に取得できないことは監視を無効化しない。metadataが不完全・不正なら0費用や正常とは推測せず診断を残し、通知判定を行わない。`NOTIFICATION_WEBHOOK_URL`未設定時は既存helperどおりwarning相当で正常終了する。

Cost Guardはreview verdict、merge、pause、`human-review-required`、budget、workflow有効化、自動retryを変更しない。standard `$1.70` / high-risk `$2.10` run budget値の確定は#173、budget/account spend limit到達時のpause・Discord通知配線は#160、wall-clock異常は#146の責務である。usage欠損を0 USDとして扱わない。compact usageを低コストかつ安全に渡す恒久方式が必要になれば、このmetadata burst detectorを拡張せず#390のscopeを再確認するか後継Issueで扱う。main反映後は、計測目的のpaid reviewを実行せず、自然なrun/re-runで`workflow_run` event挙動を確認する。

### merge-base/stale判定による承認dismiss時の手動復旧

GitHub内部のmetadataまたは判定実装を原因として断定しない。次のすべてを人間が確認できる異常時だけ、PR headを変更せず同じbase branchへ再設定してPR基準情報のrefreshを試みてよい。

1. GitHubが既存approvalを`The merge-base changed after approval.`などのmerge-base/stale判定理由でdismissした。
2. reviewed head SHAがapproval後も不変である。
3. current base branch tipと実merge-baseを再確認し、reviewが前提にした実差分が変化していない。
4. repository workflowによる明示的dismissや、実際のheadまたはbase branchの更新などの別原因が確認されない。
5. 同一base再設定の前後でhead SHA、実merge-base、実差分が変化していない。

refresh後も同一head・同一実差分である場合だけ、同一headで得たBlockingなしClaude reviewの**内容**を人間最終reviewの証跡として再利用できる。これはdismissされたGitHub reviewを`APPROVED`へ戻すものでも、Rulesetの承認要件を代替するものでもない。merge前に人間はPR画面で、承認1件以上と最新pushへの承認必須を含むRulesetの必須checkが充足していることを確認する。dismiss後もこの承認要件が充足していない場合は、現行headを人間が独立に最終reviewした後、GitHub上で新しい`APPROVE` reviewを投稿する。protected path PRではこのreviewと投稿を人間Code Ownerが行い、その後に手動mergeする。いずれかを満たさない場合、またはhead、実merge-base、実差分が変化した場合は古いreviewを再利用せず、通常の再review条件に従う。この手順は人間による例外的manual recoveryであり、workflowからPR baseを自動更新せず、調査目的だけでClaude reviewを繰り返さない。`Dismiss stale approvals`、最新pushへの承認必須、Code Owner保護その他の安全側rulesetは弱めない。

## Ruleset

default branchに次を適用する。

- Pull Request必須
- 承認1件以上
- Code Owner review必須（`.github/**`、任意階層の `AGENTS.md` / `AGENTS.override.md` / `CLAUDE.md` / `CLAUDE.local.md` / `CODEOWNERS`、`.claude/**`、`.codex/**`、`.mcp.json` は人間ownerのみ）
- 古い承認を新しいpushで破棄
- 最新pushへの承認必須
- 会話スレッド解決必須
- squash mergeのみ
- linear history必須
- branch deletionとforce pushを禁止
- bypass actorなし

`pull_request` runはsame-repository PR側のworkflow定義を評価し得るため、`.github/CODEOWNERS` とCode Owner reviewを防御境界とする。AI AppはCode Ownerに指定せず、Workflow・AI指示書・agent設定の変更には人間ownerの承認と手動マージを必須にする。自動マージゲートも対象パスを検出して失敗する。

`PR Traceability / Linked Issue` のcheck名はmain上で観測済みで、default branch rulesetのrequired status check `Linked Issue` として有効化済みである。自動マージ処理自身も同じclosing Issue条件を再検証するため、このrequired checkに加えてmerge gateでも条件を迂回しない。

## 人間エスカレーション

次のいずれかで `human-review-required` を付け、自動修正と自動マージを停止する。

- Codexが、plain textの単独行で完全一致する `[REQUIREMENTS_CHANGE_REQUIRED]` を返した。backtick・code block・字下げ・前後空白は付けず、CRLFは通常のplain-text行末として扱う。説明文中の言及は停止シグナルにしない。Codex最終応答が欠落または空の場合、または検出helperかtrusted bootstrapが失敗した場合も「マーカーなし」と扱わず、Issue起点とClaude review follow-upの両方で安全側に停止する。
- Issue起点Codexが `[SCOPE_DECISION_REQUIRED]` を返した。出力条件は[Issue起点開発中のdynamic scope decision](#issue起点開発中のdynamic-scope-decision)を正本とする。
- Claudeのvalidated structured review `summary` に、plain textの単独行で完全一致する `[REQUIREMENTS_CHANGE_REQUIRED]` または `[HUMAN_ESCALATION_RECOMMENDED]` がある。backtick・code block・字下げ・前後空白付きの行や説明文中の言及は停止シグナルにせず、CRLFは通常のplain-text行末として扱う。判定step自体が失敗した場合はreview jobを失敗させ、mergeへ進ませない。Claude review follow-upと過去reviewのmarker短縮記録も同じ単独行規約を使う。
- Claudeのchange requestが3回に到達した。

Codexのscope markerもCRLFを許す字下げ・前後空白のない単独行完全一致だけを検出し、backtickや説明文中の言及を検出しない。Markdown fenced code内のscope markerは無視する。一方、requirements marker primitiveはMarkdownをparseしない既存behaviorを維持し、fenced code内でも単独行が一致すれば検出し得る。上記のcode block禁止はproducerの出力規約である。この非対称は #725 / #722 系列の意図したcompatibility boundaryであり、requirements primitiveの意味を変更しない。将来揃える場合は別Issueで判断する。

`.github/scripts/classify-claude-human-escalation.sh` は、callerがtrusted境界で抽出したClaude structured reviewの`summary`本文だけをstdinからplain textとして受け取るpure helperである。行末CRだけを除いた単独行完全一致で上記2種類のmarkerを分類し、markerなしは`{"result":"none"}`、要求変更だけなら`{"result":"pause","reason":"requirements_change"}`、人間エスカレーションだけなら`{"result":"pause","reason":"explicit_human_escalation"}`、両方あれば`{"result":"state_inconsistent"}`を返す。同一markerの重複は同一signalとして扱い、review JSONやPR comment wrapper、自由文からreasonを推測しない。Claude Reviewはcurrent base SHA由来のhelperで分類し、markerなしは停止せず、それ以外の3結果はreasonを推測せず従来の `apply-human-pause.sh` によるラベル同期と通知を行う。Claude Reviewのhuman escalationではcommon pause recordを作らず、人間がclosing Issue、PRの順にラベルを解除する現行resumeを維持する。分類またはtrusted helperの失敗はreview jobを失敗させ、自動retryしない。

Issue起点のpost-Codex gateは、trusted `classify-ai-developer-decision-marker.sh` の `requirements_change` / `scope_decision` を同名の既存reasonとして `create-human-pause.sh` に渡す。`none` だけが `continue=true` となり、最終応答の欠落・空ファイル、classifier異常終了（両markerの曖昧性を含む）、不正/未知出力は `developer_execution_failed`（`failed_action=develop`）として停止する。scope pauseは `continue=false` とし、diff guard・commit・push・PR書き込みへ進まず、検出後のworking treeを公開しない。自由文からreasonを推測せず、producer条件は「Issue起点開発中のdynamic scope decision」を参照する。Claude Blocking follow-up経路は変更しない。Issue起点のdiff guardはhelper成功かつ妥当な `stop` だけを `diff_guard_exceeded`、`error`・helper失敗・不正/未知出力を `diff_guard_error` として渡す。`requirements_change` / `scope_decision` / `diff_guard_exceeded` のfingerprintはpause直前にcanonical Issueのcurrent body stringをAPIから再取得し、そのUTF-8 bytesだけをSHA-256にかけた `sha256:<64 lowercase hex>` とする。取得・形式・hashの失敗はfail-closedで停止する。両gateはCodex前にblob identityを固定したtrusted base由来のcommon helperと依存scriptをpost-Codexに再配置・照合し、developer App IDを解決して呼び出す。GitHub pause成立後の通知と重複抑止はcommon helperに委ねる。

停止時は関連IssueとPRの両方へラベルを同期する。どちらかにラベルが残っている間は、追加の `/codex develop` 指示やClaudeのchange requestが届いてもCodexを再起動しない。通常のClaude change request follow-upは停止ラベルを付けずに実行し、成功時だけReady eventで再レビューへ進む。Draft復帰jobの異常終了、3回目のchange request、要求変更、diff guard stop、Codex異常、または人間エスカレーションでは停止ラベルを付ける。ラベル・PR差分・closing Issueの取得に失敗した場合も安全側に停止する。Claude Reviewの入口は二層で保護する。workflow job条件はevent payload時点でPRがopenであり停止ラベルを持たないことを確認して早期にjobを止め、trusted base由来のentry gateはClaude API呼び出し直前にGitHubからPR stateとPR / closing Issueの停止ラベルを再取得する。entry gateはopen PRだけをreview対象とし、merged / closed PRはmodel call前に正常skipする。PR stateを安全に判定できない、または未知stateである場合はfail-closedで停止する。 workflow job条件はpull_request event payloadの小文字 `open` を判定し、trusted entry gateは `gh pr view` の `OPEN` / `CLOSED` / `MERGED` を判定するため値の語彙は異なるが、いずれもopen PRだけをpaid reviewへ進める。

人間が判断を記録し再開可能と確認した後、open PRの停止ラベルはclosing Issue側を先に、PR側を最後に外す。誤ってopen PR側を先に外した場合は、PRへラベルを再付与してからclosing Issue側、PR側の順に外し直す。openかつ非Draft PRではPR側の `human-review-required` が外れたeventが明示的なClaude再レビュー要求となり、Draft PRではラベル解除では起動せずReady for reviewが再レビュー要求となる。

manual protected-path merge等によりmerge後もstale `human-review-required` が残った場合も、cleanup順序はclosing Issue側を先に、merged/closed PR側を最後とする。ただしmerged/closed PR側のラベル解除はClaude再レビュー要求として扱わず、paid Claude Reviewを起動しない。この停止解除・cleanup順序とreview起動条件の正本は本節であり、`evaluate-followup-gate.sh`は人間向けの停止理由を、workflowはその値を変更せずに表示する。停止中に誤った順序で起動したcheckは、Job Summaryの「Claudeレビュー未実施」で未実施理由を確認する。

`NOTIFICATION_WEBHOOK_URL` が設定済みならPRまたはIssueへのリンクをDiscordへ送る。通知scriptはDiscord Webhookの `content` と自動mentionを無効にする `allowed_mentions: {parse: []}` を送り、contentが1800 byteを超える場合は送信に失敗する。Webhook URLをログ、Issue、PRへ出力しない。未設定時はActionsにwarningを残し、GitHub上のラベルとコメントによる停止は継続する。人間が判断をIssueへ記録し、必要な修正を行った後にだけラベルを外して再開する。

### scope_decisionの人間向け判断理由保存（#776）

Issue起点post-Codex gateのclassifierが `scope_decision` を返した場合だけ、最終応答の必要7項目をtrusted inline validationで抽出し、対象Issueへ別commentとして `gh issue comment --body-file` で保存する。形式の正本は `.github/workflows/ai-developer.yml` のIssue-origin fixed promptと `Gate requirement changes` である。exact label `Observed fact`、`Missing/new Contract category`、`Why Done is impossible under the current contract`、`R/C/P/B change`、`Proposed split/prerequisite`、`Product impact`、`Unverified matters` はそれぞれ行頭から1回だけ `Label: 値` のplain-text単独行とし、値は日本語の非空説明とする。markerは従来どおり別のexact standalone lineを使用する。labelや値はhuman evidenceの形式検証だけに使用し、reason分類・resume判断・repository write認可へ使わない。

最終応答は16 KiB、各fieldは1 KiB UTF-8、renderしたcommentは8 KiBを上限とする。通常fileのbounded read、strict UTF-8、CRLF以外の不正control文字、required field欠落・重複・空値・不正形式、入力／field／render上限を検証する。promptでraw tool output / JSONL、token / secret / credential / environment dump、absolute runner/toolcache path、numeric UID/GID等のrunner内部情報を禁止し、validatorでも明白なcredential prefix・private key・Bearer/JWT・webhook・機密値代入・environment dump・runner path・UID/GID・raw JSON形状を拒否する。全finalの転載やraw stream保存は行わず、検証済み7項目だけをHTML / Markdown / mentionをescapeして表示する。この形状検査は任意の未知secretの完全検出を保証せず、producerはraw値を持ち込まない責務を維持する。

順序はreport検証、既存machine pause成立、既存generic pause comment、bounded human report commentとする。既存pause recordの `reason` / fingerprint / lifecycleは変更せず、`payload.detail` へmodel free textを埋め込まない。scope分類後のreport検証・一時file保存失敗はraw内容を反射せず固定診断の `scope_decision` pauseを成立させ、step failureで停止する。human report comment API失敗・応答不明も固定診断でstep failureとし、成立済みpauseを維持する。どちらもdiff guard・commit・push・PR writeへ進まず、理由再取得のpaid retryや自動再送を行わない。最終応答欠落・空、classifier異常・両marker曖昧性は従来の `developer_execution_failed` を維持し、markerなし・requirements-only・Claude Blocking follow-upへ保存を一般化しない。一時report fileはgate終了時に削除する。

検証は既存 `test-ai-developer-workflow.sh` で実gateを抽出し、synthetic scope reportと実common pause helper・mock GitHub writeを合成する。7項目の投稿・pause先行・fingerprint/resume不変、正常／上限境界／不正UTF-8・control・field・oversize・credential/runner形状・file異常、固定診断の非反射、comment failure、後続write不達を確認する。正式current-headの証拠は自然なAI Workflow Regressionで確認し、外部サービスへ診断目的の実アクセスは行わない。Product POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの影響はない。

### human pause record のschema契約

コメントへ埋め込むversion 1のrecordは `.github/scripts/human-pause-record.sh` をschema validationの正本とする。`reason` はそのrecordが扱う有効なpause reasonであり、`kind` ごとの意味は次のとおりである。

- `pause.reason` はpause作成時の初期reasonである。
- `pause-normalization.reason` はnormalization後に有効となるreasonである。normalization前のreasonは `source_pause_id` の因果chainを辿って導出し、重複する `from_reason` fieldはrecordに保持しない。
- `ai-resume-accepted.reason` はresume受理時点で有効なreasonである。

`target` は自由文字列ではなく、文字列全体が `issue:<number>` または `pr:<number>` でなければならない。`<number>` は先頭0なしの1以上の10進整数である。`pause_id` はGitHub REST comment IDを文字列化した値であり、GraphQL `node_id` は用いない。`source_pause_id` は参照先`pause_id`と同じく、文字列全体が先頭0なしの1以上の10進整数でなければならない。独立した `pause` は `source_pause_id` を持たず、厳密形式の `source_pause_id` を持つ `pause` はreplacement pauseである。`ai-resume-accepted` と `pause-normalization` は `source_pause_id` を必須とする。厳密な形式検証はschema validatorを正本とする。schema validatorは単一recordの形式と許可済みreasonだけをfail-closedで検証し、`source_pause_id` のchain解決、chainから導出したeffective reasonと `ai-resume-accepted.reason` の一致確認、または探索対象ConversationのIssue/PR種別・番号とrecord targetの一致確認は行わない。これらの因果・探索境界の検証は後続のlifecycle reconciliationおよびConversation探索でfail-closedに行う。

`.github/scripts/list-human-pause-records.sh` はこのprimitiveを用いてtrusted Conversation recordを列挙する。trusted GitHub App IDを入力として受け、REST Issue comments APIの `performed_via_github_app.id` と一致するcommentだけを候補にする。PRがあればPR番号、なければIssue番号のConversationだけを探索し、双方を混在させない。stdoutは単一のJSON object `{target, records:[{pause_id, record}]}` とし、trustedかつschema-validで探索対象と`target`が一致するrecordが0件でも成功して `records: []` を返す。REST comment `id` を`pause_id`として返す。untrusted、schema不正、または`target`不一致のcommentはskipし、Conversation取得失敗またはAPI応答shape不正はfail-closedとする。このhelperはrecord数からactive / consumed / supersededを判定しない。

`.github/scripts/validate-human-pause-record-graph.sh` はlisting helperのstdoutをstdinで受け、構造的にvalidな場合だけ同じJSONをstdoutへ返す。`pause_id` の重複、存在しない`source_pause_id`、self reference、cycle、および一つのpredecessorへの複数successorをfail-closedで拒否する。forkを禁止するため、各chainは構造上linearであり、一つのpredecessorが持てるsuccessorは高々一つである。recordの列挙順、root数、record数は意味論に使用せず、複数の独立rootまたは過去chainを許容する。このhelperはtrusted性・schema・targetを再検証せず、`pause_id` / `source_pause_id` の厳密形式も再検証しない。これはtrusted recordのschema形式を `human-pause-record.sh` に委ね、このhelperが辺解決・重複・欠損source・cycle・forkというgraph責務だけを担う意図的な分界である。lifecycle status、effective reason、active pauseも導出しない。

`.github/scripts/decompose-human-pause-record-graph.sh` はvalidated graphのstdoutをstdinで受け、同じ`target`と`{records:[...]}`からなる`chains`を返す。各chainは`source_pause_id`を持たないrootからterminalまで因果順に並べ、全recordをちょうど1回だけ含める。複数chainはroot `pause_id`を正の10進整数として精度に依存せず比較した昇順で返すため、入力列挙順に依存しない。空の`records`は空の`chains`となる。このhelperはgraph validatorの信頼性・schema・構造検証を重複せず、機械的に読めないenvelopeまたは一意に完全分解できない入力だけをfail-closedで拒否する。lifecycle status、effective reason、active pauseは導出しない。

`.github/scripts/derive-human-pause-pre-resume-state.sh` はchain decompositionのstdoutをstdinで受け、`target`、各chain、各`records`を保持したまま各chainへ`pre_resume`を付加する。正常な`pre_resume.status`は `active` である。root `pause`を初期stateとし、replacement `pause`または`pause-normalization`は直前のeffective pauseをsupersedeして、そのrecord自身の外側`pause_id`と`reason`を新しいstateとする。最初の`ai-resume-accepted`より前だけを解釈し、acceptance自身とsuffixの意味論は扱わない。chainは独立に処理し、normalizationの前reasonはsource chainからのみ導出して自由文fieldに依存しない。pre-acceptance prefixが意味論上解釈不能な場合はfail-closedとし、Conversation全体のactive集約、acceptanceのconsumed判定、production workflow wiringは扱わない。

`.github/scripts/reconcile-human-pause-resume-acceptance.sh` はpre-resume derivationのstdoutをstdinで受け、`target`、各chain、各`records`、各`pre_resume`を保持したまま各chainへ`effective`を付加する。`ai-resume-accepted` がないchainは`pre_resume`のpause identityとreasonを持つ`active`となる。acceptanceが1件だけありchain terminalで、その`source_pause_id`と`reason`が`pre_resume`と一致するときだけ、同じpause identityとreasonを持つ`consumed`となり、acceptance自身の外側`pause_id`は`accepted_record_id`として保持する。acceptance直後に `source_pause_id` でacceptanceを参照する `resume_transition_failed` のreplacement `pause` が1件あり、acceptanceの`payload.action`とreplacementの`payload.failed_action`が同じcanonical resume action（develop / validate / review / fix / follow-up / no-action）の場合だけ、replacementを新たな`active`とする。複数acceptance、その他の非terminal acceptance、sourceまたはreasonの不一致、有効でない`pre_resume`、empty `records` chain、または`pre_resume.pause_id`が当該chainの`records[].pause_id`に属さない人工入力はfail-closedとする。このhelperはreplacement / normalizationからのpre-resume state再導出、Conversation全体の集約、production workflow wiringを扱わない。

`.github/scripts/reconcile-human-pause-active-pause.sh` はresume acceptance reconciliationのstdoutをstdinで受け、各chainの`effective`をConversation単位で集約する。`effective`のstatus、pause identity、reasonが有効な`active` / `consumed`であることだけを検証し、record graph、replacement / normalization、またはacceptance semanticsを再解釈しない。`chains` の列挙順には依存せず、active chainの件数と内容だけで結果を決定する。activeが0件なら`{target, result: "no_active_pause"}`、1件ならその`effective.pause_id`と`effective.reason`を持つ`{target, result: "active", active_pause}`、2件以上なら`{target, result: "state_inconsistent"}`を返す。未知statusまたは集約に必要なshapeが不正な入力はfail-closedとし、production workflow wiringは扱わない。

`.github/scripts/create-human-pause.sh` は上記のtrusted listingとreconciliationを使うhuman pause遷移境界である。`create REPO ISSUE PR APP_ID REASON DETAIL [--paused-head SHA] [--issue-body-fingerprint sha256:<64 lowercase hex>] [--failed-action develop|fix] [--repair-active] [--repair-head SHA]` はactive pauseがなければ選択したConversationにroot `pause` recordを投稿し、REST comment IDを`pause_id`とする。既存の末尾positional `PAUSED_HEAD` も受けるが、新規producerはnamed optionを使う。`--paused-head` はPRを指定した場合だけ40文字の小文字SHAとして受け、record schemaの `paused_head` へ渡す。`requirements_change` / `scope_decision` / `diff_guard_exceeded` は `--issue-body-fingerprint` を必須とし、`payload.issue_body_fingerprint` へ渡す。`developer_execution_failed` は `--failed-action develop|fix` を必須とし、`payload.failed_action` へ渡す。`failed_action=fix` は同一HEADでの再開を要するため、`--paused-head`（または既存のpositional `PAUSED_HEAD`）も必須とする。他のreasonへこれらのmachine fieldを付加できない。これらをDETAILから推測せず、未知・重複・値不足・形式不正のoptionをfail-closedで拒否する。Issue本文の取得とfingerprint計算はproducerが行う。IssueまたはPRの一方は`-`で省略できるが、少なくとも一方を指定する。PRがあればrecordはPR Conversationに置く。既存active pauseが同じreasonでも、指定されたpaused HEADとreason固有のmachine fieldが `active_pause.pause_id` のroot recordと完全一致する場合だけラベルを再同期して`already_active`を返し、欠落・不正・不一致ならfail-closedとする。DETAILの差はdedupeに使用しない。failure handlerが渡す `--repair-active` は `developer_execution_failed` のcreateだけで受ける。PRがあれば `--repair-head` に現在の40桁小文字HEADを必須とし、既存active pauseのtrusted record、effective reason、target、reason固有のmachine field、record内のpaused HEAD、PRのcurrent HEADを再照合し、Issue番号も指定された場合はcanonical `ai/issue-N` branch・closing Issue関係も確認してから、元recordを変更せずラベルだけを再同期し `already_active` を返す。Issue-onlyではrepair HEADを付けない。複数active、曖昧なidentity・関係、HEAD不一致、ラベル同期失敗はfail-closedとし、修復から通知しない。POST失敗または応答ID不正時もtrusted historyを再取得し、投稿予定recordと完全一致する一意なactive recordが確認できた場合だけラベル同期して `already_active` を返す。確認不能なら失敗を返す。`inspect REPO ISSUE PR APP_ID PAUSE_ID` は既存IDのactive / consumedを確認し、activeならラベルを再同期し、`already_active` / `already_consumed`を返す。resume拒否や既存pauseの再検出には`inspect`を使い、これらの経路では通知しない。新しいpause作成時は `human-review-required` を関連Issue / PRへ同期し、作成したrecordがtrusted listingで確認できてからのみ `.github/scripts/format-human-pause-notification.sh` のreason別日本語文を `.github/scripts/notify-human.sh` でbest-effort送信する。作成後のreconciliationが `state_inconsistent` ならどちらのrootも正常扱いせず、GitHubの停止を維持し、同reasonの通知をbest-effortで送ってfail-closedとする。他のラベル・record整合の失敗では通知せず停止し、Discord未設定・送信失敗ではGitHub上のpauseを維持する。自由文DETAILはrecord payloadに全文を残し、Discord向け表示だけ先頭250文字に省略する。DETAILをworkflow制御には使用しない。machine-only stateはrecord schemaと通知formatterのreason allowlistに含めない。schemaのreason集合は `human-pause-record.sh reasons` から取得し、fixtureで全reasonのformatter対応を確認する。

`--repair-active` 指定時もactive pauseがなければ通常の新規停止を作成し、PR relation / HEADの修復用再照合は新規作成の前提条件にしない。POST応答喪失後に既存recordを再利用する場合は再照合する。

親 #219 に関わるproduction producerへの配線順序は、#444 のcommon helper hardening、最初のproduction consumerとなる #146 のClaude Review非success handler、既存producer移行を追跡する #445 とする。#146 はtimeout・runner lossの可視性を担うため、広範なproducer整理より先に接続する。#444 の完了までは #146 をproductionへ接続せず、自動retryは追加しない。

`.github/scripts/parse-ai-resume-command.sh` はstdinからちょうど1個のJSON objectを受け、`body`、`actor`、`author_association` がすべてstringでなければfail-closedで拒否する。複数JSON value、object以外、必須field欠落、型不正もfail-closedとする。`OWNER`、`MEMBER`、`COLLABORATOR` 以外のassociation、または`/ai resume` commandでないcommentは`{"result":"ignore"}`を返す。trusted actorのresume系commentでは、1行全体に厳密一致する小文字の`/ai resume develop`、`validate`、`review`、`fix`、`follow-up #N`、`no-action`だけを受理し、`follow-up`の`N`は先頭0なしの1以上の10進整数とする。通常actionは`{result:"accepted", actor, action}`、follow-upは正のJSON numberの`follow_up_issue`を加えたaccepted objectを返し、その他は`{result:"reject", code:"invalid_command"}`を返す。このhelperはactive pause解決、GitHub target、allowlist、dispatch、production workflow wiringを扱わない。

`parse-ai-resume-command.sh` を変更した場合は `bash .github/scripts/test-parse-ai-resume-command.sh` を実行する。

`.github/scripts/inspect-ai-resume-target.sh <repo> <issue|pr> <number>` はstdinから#299のaccepted command objectをちょうど1個だけ受け、`owner/repo`と先頭0なしの正整数targetを検証してcurrent target metadataをfail-closedで正規化する。open non-PR Issueは`command`、`target:"issue:N"`、`issue:{number,state:"open"}`、`pull_request:null`を返す。open PRは`target:"pr:N"`、`issue:null`、およびnumber、open state、base/head ref、40桁のcurrent head SHA、branch名が`ai/issue-N`の場合だけの`branch_issue_number`、same-repository closing Issue URLだけをsort/uniqueした`closing_issue_numbers`を固定shapeで返す。入力`command`は#299 accepted shapeを維持し、`follow-up`では正の整数`follow_up_issue`も保持する。PR branchとclosing Issueのrelation、branch Issueのopen判定、canonical closing Issue、dispatch、production workflow wiringは扱わない。GitHub response、stdin、target、またはstateのshape不正・closed targetはすべて停止する。

`inspect-ai-resume-target.sh` を変更した場合は `bash .github/scripts/test-inspect-ai-resume-target.sh` を実行する。

`.github/scripts/resolve-ai-resume-target.sh <repo> <issue|pr> <number>` はstdinの#299 accepted command objectを#307 `inspect-ai-resume-target.sh`へ渡し、そのnormalized metadataからcanonical closing Issue relationだけをfail-closedで確定する。open non-PR Issue targetではtarget自身をclosing Issueとする。PR targetでは`head_ref`が`ai/issue-N`で`branch_issue_number`がN、かつNがsame-repository `closing_issue_numbers`に含まれることを要求し、REST APIでIssue Nがopen non-PR Issueであることを確認する。closing Issueが複数でもNをcanonicalとし、1件限定にはしない。出力は`{command,target,closing_issue:{number,state:"open"},pull_request}`の固定shapeで、Issue targetの`pull_request`はnull、PR targetではnumber、open state、base/head ref、head SHAだけを含む。`command`は#307のaccepted shapeを`follow_up_issue`も含めそのまま保持し、internal-onlyの`branch_issue_number`と`closing_issue_numbers`は出力しない。current metadata取得、closing Issue body / fingerprint / follow-up、dispatch、production workflow wiringは扱わない。

`resolve-ai-resume-target.sh` を変更した場合は `bash .github/scripts/test-resolve-ai-resume-target.sh` を実行する。

`.github/scripts/build-ai-resume-github-context.sh <repo> <issue|pr> <number>` はstdinの#299 accepted command objectを#308 `resolve-ai-resume-target.sh`へ渡し、そのrelation snapshotへcurrent canonical closing Issue本文由来のfactsを付加する。closing Issueの同一REST responseにある必須string `body`のUTF-8 bytesを末尾改行の追加・削除なしでSHA-256にかけ、`closing_issue.body_fingerprint`を`sha256:<64 lowercase hex>`とする。`follow-up` actionの場合だけ`command.follow_up_issue`のsame-repository current Issue API responseからnumber、Issue / PR種別、open / closed stateを取得し、同じclosing Issue bodyの`## スコープ外影響と後継Issue`節（旧`## Scope-out impact and follow-up`節を含む）に定型`- 後継Issue: #N`行（旧`- Follow-up Issue: #N`行を含む）があるかを`follow_up_issue.explicitly_recorded`へ記録する。抽出規則は`build-review-context.sh`と同じ見出し・行形式を使用し、自由形式proseや別見出しから推測しない。通常actionの`follow_up_issue`はnullとする。出力は`{command,target,closing_issue:{number,state,body_fingerprint},pull_request,follow_up_issue}`の固定shapeで、relation由来のcommand、target、closing Issue number/state、PR factsを保持する。API取得・body・response shapeが不正ならfail-closedとし、body内容の十分性、fingerprint差分、follow-upのresume可否、dispatch、production workflow wiringは判定しない。

`build-ai-resume-github-context.sh` を変更した場合は `bash .github/scripts/test-build-ai-resume-github-context.sh` を実行する。

`.github/scripts/build-ai-resume-prepare-context.sh <repo> <issue|pr> <number> <trusted-app-id>` はstdinの#299 accepted command objectをちょうど1個受け、最初に `build-ai-resume-github-context.sh` からcurrent GitHub factsを取得する。canonical closing Issue番号とPR番号（Issue targetでは `-`）を `list-human-pause-records.sh` へ渡し、listing、graph validation、chain decomposition、pre-resume derivation、resume acceptance reconciliation、active pause reconciliationを既存helperの順に直列合成する。各段の失敗、複数JSON value、target不整合、出力shape不正はfail-closedとする。`result:active` の場合だけ、元のtrusted listingから `active_pause.pause_id` と外側 `pause_id` が一致する唯一のentryを解決し、record本文をそのまま `pause:{result:"active",pause_id,reason,record}` に保持する。一致が0件または複数件なら停止する。active以外は既存の意味どおり `pause:{result:"no_active_pause"}` または `pause:{result:"state_inconsistent"}` とする。出力は#306の `command`、`target`、`closing_issue`、`pull_request`、`follow_up_issue` を保持して `pause` を追加した固定shapeである。GitHub facts、record schema、graph、chain、lifecycle、acceptanceの意味論はそれぞれ前段helperが正本とし、このhelperはresume可否policy、dispatch、production workflow wiringを扱わない。

`build-ai-resume-prepare-context.sh` を変更した場合は `bash .github/scripts/test-build-ai-resume-prepare-context.sh` を実行する。

`.github/scripts/prepare-ai-resume.sh` は#304のfinal PREPARE contextをstdinから1個だけ受け、GitHub APIを再取得せずにresume policyを判定する。schema不正はfail-closedで停止し、通常拒否は固定codeの `{result:"reject",code}` を返す。active source recordのidentity、kind、reason、target、open closing Issue、PRが必要なactionのopen / main / current HEADを確認する。`requirements_change` / `scope_decision` / `diff_guard_exceeded` の`develop`だけはpause時とcurrent Issue本文のfingerprint差分を必須とし、`fix` / `review` / `follow-up` / `no-action`だけはsource recordの`paused_head`とcurrent PR HEADの完全一致を必須とする。`validation_failed`は`validate` / `develop`を許可し、`validate` / `develop`に共通PREPAREのsame-HEAD条件を追加しない。`developer_execution_failed`、`review_disagreement_decision`、`resume_transition_failed`のactionはsource payloadの`failed_action`または`decided_action`からのみ判定し、`follow-up`は同一番号のopen Issueとclosing Issue本文の定型参照を要求する。詳細なallowlistと固定reject codeはhelperとfixtureを正本とする。

成功時は`{result:"prepared",dispatch}`の固定shapeを返す。dispatchはsource pause ID / reason、command actor / action、canonical closing Issue、PR番号とpause / current HEAD、pause / current Issue本文fingerprint、follow-up Issue番号をnull付きで保持するPREPARE時点のsnapshotである。producerはこの結果でsource pauseをconsumedにせず、`ai-resume-accepted` record、ラベル解除、consumer起動、ACK polling、Discord再通知を行わない。consumerはcurrent target / HEADとaction固有条件をtrusted gateで再取得・再確認する。

`/ai resume develop` のproduction producerはtrusted baseのparserとPREPAREをDeveloper App token / App IDで実行し、`{event_type:"ai-resume-develop",client_payload:{version:1,dispatch:<PREPARE dispatch>}}` の固定envelopeを送る。`client_payload` のtop-level keyは`version`と`dispatch`の2個で、inner dispatch snapshotは変更しない。consumerは`dispatch.closing_issue_number`でIssue DeveloperおよびClaude Blocking follow-upと同じ `codex-writer-ai/issue-N` concurrencyを取得した後、inner `dispatch` だけをuntrusted snapshotとしてcurrent GitHub factsとactive pauseを再取得する。source pauseより後の同じConversationにtrusted actorの厳密なcommand commentが存在し、PREPAREの全dispatch fieldが一致する場合、PR targetは先にDraftへ遷移させて再取得で確認し、その後App provenance付き `ai-resume-accepted` を投稿する。Draft遷移失敗では元pauseとlabelsを維持する。既存lifecycle pipelineでsourceがconsumedかつactive pause無しと確認してからclosing Issue、PRの順に `human-review-required` を解除し、同じrunで通常のIssue Developerへ進む。accepted後の解除失敗はacceptanceを巻き戻さず `resume_transition_failed` replacement pauseとラベル再同期を試みて停止する。producerとconsumerのrecord探索は最大10ページ（各100件）で打ち切り、上限到達やAPI異常は停止する。重複・stale dispatchはactive pause再検証で拒否する。resumeは通常timeoutだけを使用し、Codex後のrequirements gate、diff guard、write boundary、異常終了handlerは通常経路と共通である。

`prepare-ai-resume.sh` を変更した場合は `bash .github/scripts/test-prepare-ai-resume.sh` を実行する。

`/ai resume review` のprepared consumerは `prepare-ai-resume-review-consumer.sh` が返す `ai-resume-accepted` recordとaction sequenceを正本とする。独立復旧用の `prepare-ai-resume-review-recovery.sh` は、`AI Resume Review Consumer` の失敗run/attempt、canonical closing IssueとPR、trusted Appのrecord graph、両方のcurrent label、同一HEADのnormal `Claude Review` job/stepを別runnerから再取得してcaller actionだけを返す。source runの `display_title` は `AI Resume Review Consumer pr:<PR番号> pause:<source_pause_id>` に固定し、同一attemptの開始から終了までの間にaccepted recordが成立したことを要求する。source pauseが未consumedなら元pauseのlabelだけを維持する。accepted後の同一HEADのnormal Reviewは、`Claude Review Failure Handler` が扱うReview jobの状態を優先してownershipを判定する。Review jobの失敗・cancel・timeout・stale、またはmodel選択step開始済みならnormal Reviewへownershipを渡し、resume recoveryはpauseを指示しない。Review job自体がskip、またはReview jobが成功・実行中・待機中でmodel選択stepがcompleted/skippedの場合はhandoff未成立とし、既存replacement pauseを再利用し、なければ `resume_transition_failed` (`failed_action=review`) の作成・graph再確認、欠けたIssue/PR labelの再同期を順に指示する。runの存在だけではhandoffとしない。source/accepted/HEAD/関係の不一致や曖昧な証跡はfail-closedとし、再dispatchや自動retryは行わない。このhelperはread-onlyである。`AI Resume Review Recovery` は失敗・cancel・timeoutした `AI Resume Review Consumer` の `workflow_run` だけを受け、canonical closing Issueのwriter concurrency内でdefault branchの `recover-ai-resume-review.sh` を実行する。callerはreplacement POSTの応答喪失時を含めtrusted graphを再取得し、一意のactive replacementを確認してから欠けたIssue/PR labelだけを再同期する。normal Reviewのqueued / in-progress jobはmodel選択step開始の証跡がなければownership未確定としてfail-closedで停止する。

`/ai resume validate` のprepared consumerはtrusted default branchの `.github/scripts/prepare-ai-resume-validate-consumer.sh` をread-onlyで実行する。固定PREPARE dispatchはuntrusted snapshotとし、fresh canonical closing Issue / same-repository open PR（main base、`ai/issue-N` head）、sourceのactive pauseとaccepted graph、両方の`human-review-required`、sourceより後の同一PR Conversationにあるtrusted humanの厳密な`/ai resume validate` commentを再取得する。`validation_failed`、`validation_timeout`、または`resume_transition_failed`かつ`payload.failed_action=validate`だけを受理する。same-HEADではdispatch、sourceの`paused_head`、fresh PR HEADが一致する場合だけ、決定的なsource / command comment / HEAD identityとschema準拠の`ai-resume-accepted`候補を返す。validate source pauseの`paused_head`は必須であり、欠けたdispatchはmalformedとして停止する。#548で定義するpause producerもこの前提を満たす必要がある。DraftとReadyの両PRを受け付け、後段でvalidation中のnormal paid review抑止状態を別途確認する。stale、consumed、関係・形・provenance不正は停止する。POST応答喪失時はtrusted App recordを再列挙し、同一候補の一意性を確認するまで再送しない。accepted成立後にfresh graphでsource consumed / active pause無しを確認し、validation中のnormal paid review抑止を確認してからIssue label解除・確認、PR label解除・確認、後段のvalidation cycleへ進む順序を出力する。このhelperはrecord投稿、label変更、cycle開始、10分window開始を行わず、production workflowから到達不能である。

後段のprepared `.github/scripts/prepare-ai-resume-validate-cycle.sh` はstdinの1個のJSON snapshotだけをread-onlyで判定する。`accepted` は上記consumerのidentityと一致するtrusted Appの一意な`ai-resume-accepted` record ID・schema検証済みrecord・REST `created_at`をUnix秒へ変換した値、`cycle` はnullまたは前回返却した同一identity / record ID / window開始の組、`source_consumed`・`active_pause` はfresh trusted graph、両labelのabsentはfresh Issue/PR label response、`normal_review_suppressed` はDraftまたはmachine stateとnormal Review jobのpaid開始証跡からcallerが確認した事実を必須とする。unknownなpauseや未消費sourceはfalseへ置換せず停止する。`validation` は#222 `evaluate-current-head-validation.sh` の全fieldから`window_started_at`だけを除いたschemaとし、accepted後のtrusted Ready eventが未到着なら`ready_started_at:null`を使う。current HEAD・Ready時刻・check run ID/時刻/状態と完全列挙・branch writer run完全列挙・write provenance・requirements/diff/follow-up gate・round数・human pauseをそれぞれtrusted API/既存gate証拠から取得する。callerはAPI失敗や証拠欠落を成功値に補完しない。helperはaccepted commentのREST `created_at`を唯一のwindow開始として毎回再導出し、返却する`cycle`をcallerがdurableに保持する。POST応答喪失、同一accepted再評価、poll、HEAD変更でも開始を更新しない。

same-HEADかつaccepted後のtrusted Ready時刻がある場合だけ#222 helperを実呼出しし、その`wait`は待機、`validation_failed` / `validation_timeout` / `round_limit`はreason付きcommon pause指示に写す。Draft継続中またはaccepted以前のReadyしかない場合は固定window内で`wait`を返す。返却する`cycle`と`observation`にidentity / window開始、current HEAD / validation SHA、Ready時刻またはnull、check / writer列挙完了を機械可読で保持し、`current_validated_sha`はsuccess以外nullとする。Ready待ちやHEAD変更中も600秒到達を優先して`validation_timeout`のpause指示とし、期限を延長しない。期限前のHEAD変更はwindowを維持した`requalify`を返し、#578で未確立のcurrent HEAD gate/write証拠を得るまで評価・handoffしない。successだけがcurrent validated SHAと`normal_trusted_review`への`action:review` handoff候補を返す。これは#547の`/ai resume review` commandやvalidate accepted recordをreview resumeとして偽装するものではない。future callerは#224の`ai-followup-in-progress`等によるnormal paid Review抑止をfresh確認してからaccepted後Ready eventを成立させる。machine state付きReadyはTraceabilityを起動してもnormal paid Reviewを開始せず、Ready/Draft・label・machine stateのwriteはこのhelperが行わない。`invalid_snapshot`、`evaluator_unavailable`、抑止・label矛盾、unsupported requalification等のterminal結果ではfuture callerが`resume_transition_failed` (`failed_action=validate`) replacement pauseと両方の`human-review-required` label再同期を担う。normal Reviewのfresh source gateとpaid ownership成立を後段callerが確認する必要があり、具体的なevent/write/poll/復旧接続は#548の未決事項である。このhelper自身はstate write、dispatch、paid実行をせずproduction workflowから到達不能とする。

HEAD変更時のrequalificationには、current HEADに対するrequirements gate、trusted diff guard、repository write provenanceを同一のtrusted run ID / attempt、target relation、SHA、個別gate結果へ結び付けた完全なmachine evidenceが必要である。現行production workflowのPR commentにある`検証結果の出所`はpushしたcommitを記すが、Codex-reported結果をformal evidenceとしない旨を明記し、上記gate結果とrun / attemptの一体の証跡を公開していない。Actions run成功、PR / commit author、dispatch内booleanから各gate passを推測できない。このため現行helperはHEAD変更を`changed_head_evidence_unsupported`で安全停止し、source pauseを消費しない。mock fixtureでの判定はproduction証跡の存在証明ではない。#548でactivation前にtrusted producerと取得・検証契約を決める必要がある。

独立したprepared `.github/scripts/prepare-ai-resume-validate-recovery.sh` は、失敗・cancel・timeoutした `AI Resume Validate Consumer pr:<PR> pause:<source>` のrun/attempt、canonical open Issue/PRとcurrent HEAD、trusted App record graph、Issue/PR label、Draft/machine state、同一HEAD normal Reviewのjob/entry stepをread-onlyで再取得する。accepted未成立ならsource pauseと不足する停止labelを維持し、accepted成立は同一attempt中のtrusted commentとconsumed graphで確定する。既存active pauseを優先し、Review jobの失敗またはmodel選択step entryでnormal Failure Handler ownershipへ委譲する。queuedだけ、skip、gate decline、entry不明はhandoff成立としない。callerが別runnerで取得したdurable validation snapshotはsource run/attempt、accepted record ID、cycle、#579 validation fieldを保持し、source jobのstdoutや一時fileを引き継がない。helperはaccepted REST時刻から固定600秒windowとcurrent時刻を再導出し、freshな両labelの状態を渡して#579 cycle helperを実呼出しする。label未解除またはReview抑止未確認はvalidation cycle開始前の遷移失敗として`resume_transition_failed` replacement pauseへ写し、両label解除後のvalidation failure/timeoutとsuccess後のhandoff失敗を別actionへ写す。欠けたsnapshot、HEAD/関係/API/ownershipの不一致はwrite指示なしで停止またはmanual reconcileを返し、replacement POST応答喪失後はfresh graphのactive pauseを再利用する。pause成立確認後だけ不足するIssue/PR停止labelを順に再同期し、machine labelの除去は両停止labelのfresh確認後に限る。返却actionの実行、writer競合時のmanual reconcile、durable evidenceのtrusted取得・最新化、Ready/check/gate provenance、production entryは#548のactivation契約が必要であり、このhelperからは到達不能である。#498も未有効のままとする。

prepared validate recoveryのJSONは全resultで `result`、`actions`（配列）、`diagnostics` を返す。`diagnostics` は `{target:{repository,issue_number,pr_number},source:{run_id,attempt,pause_id,paused_head,pause_record,accepted_record_id,accepted_record},current:{head,issue_human_label,pr_human_label,draft,machine_state,active_pause_id,active_pause_record,writer_ownership},normal_review:[{run_id,attempt,ownership,review_jobs}]}` に固定し、未取得の可変factとhelperが証明しないwriter ownershipは `null`、候補Review未発見は空配列とする。`review_jobs` は取得したReview job/stepの生のownership証跡であり、`ownership` は `entered` / `skipped` / `unconfirmed` のいずれか。`manual_reconcile` は `code` と空 `actions` を返し、`head_changed_during_read`、`source_head_changed`、`pr_label_changed_during_read`、`another_active_pause`、`review_ownership_unconfirmed`、`durable_validation_evidence_missing`、cycleの未分類codeを区別する。これは自動再開・write指示ではない。入力、trusted APIのshape（jobs配列、Review job一意性、entry step重複・未知status/conclusionを含む）、record graph、accepted identity、durable snapshotの破損はexit非0のhard failureとする。shapeに適合していても、既知のstatus/conclusionの組合せからnormal Review ownershipを確定できない場合（entry step未観測、Review jobの`neutral` / `action_required`、completedでconclusionが`null`など）は、raw `review_jobs` を `diagnostics.normal_review` に残す `review_ownership_unconfirmed` と空 `actions` を返す。

`actions[].action` は `add_issue_human_label`、`add_pr_human_label`、`create_or_reconcile_replacement_pause`、`create_or_reconcile_validation_pause`、`revalidate_record_graph`、`remove_machine_label` の固定allowlistで、substring解釈しない。両label actionはsibling review recoveryと同じ `{action,number}` とし、欠けたlabelだけをIssue、PR順に返す。replacement actionはsiblingと同じ `{action,source_pause_id,reason:"resume_transition_failed",failed_action:"validate"}`（reviewでは `failed_action:"review"`）、validation pause actionは `{action,accepted_record_id,paused_head,reason}` とする。後者のreasonは `validation_failed` / `validation_timeout` / `round_limit` に限定する。pure `.github/scripts/prepare-ai-resume-validate-pause-record.sh` はPR番号とstdinの厳密な単一pause actionだけを受け、replacementを `{version:1,kind:"pause",reason:"resume_transition_failed",target:"pr:<PR>",source_pause_id:<accepted ID>,payload:{failed_action:"validate"}}`、validation pauseを独立rootの `{version:1,kind:"pause",reason, target:"pr:<PR>",paused_head,payload:{accepted_record_id:<accepted ID>}}` に変換して `human-pause-record.sh validate` を通す。rootの`payload.accepted_record_id`は診断用であり、lifecycleの`source_pause_id`ではない。未知action・余分なfield・不正値は拒否し、writeしない。既存active `validation_failed` / `validation_timeout` / `round_limit` は同一HEADのtrusted停止所有者として再利用し、originを断定せず `active_pause_id` を返す。normal Review由来の`round_limit`も新pauseやpaid再実行を指示しない。`revalidate_record_graph` と `remove_machine_label` は `{action,requires}`。`pre_acceptance`、`normal_review_owns`、`paused`、`recover`、`cycle_wait`、`manual_reconcile` のresultごとに上記共通fieldを持ち、前者は不足labelのみ、normal ownershipとcycle waitとmanual reconcileは空actions、pausedは既存pauseの不足labelと必要なmachine label除去、recoverはpause作成・graph再確認・不足label・必要なmachine label除去の順とする。pause write後のcallerはfresh graphとlabelsを再取得し、同じhelperを再評価する。caller実行は#548 activationまで禁止する。

`/ai resume review` のproduction producerは `AI Developer` の通常Issue/PR comment entryで、trusted humanの厳密なcommandだけをparserからGitHub context構築・PREPAREへ渡す。PREPAREがreview actionと許可済みreasonのPR snapshotを返した場合にだけ、inner dispatchを変更せず `{event_type:"ai-resume-review",client_payload:{version:1,dispatch:<PREPARE dispatch>}}` を1回送る。API失敗・応答不明では自動再送せず診断可能に停止し、送信成功だけではresume acceptedとしない。producerはaccepted record、label、paid Claudeを操作しない。duplicate commandはconsumerのcanonical writer concurrencyとactive pause再検証で重複acceptanceを防ぐ。`/ai resume validate` と #498 Claude Blocking follow-up producerはproduction未接続のままとする。

`AI Resume Review Consumer` は `ai-resume-review` dispatchの固定envelope/versionを検証し、default branchのtrusted helperとread-only App tokenでfresh factsを再取得する。pre-gateが `accepted_candidate` を返した場合だけtrusted `identity.closing_issue_number` をjob outputとし、後段jobはそのIssueの `codex-writer-ai/issue-N` concurrencyに入る。後段jobはwriter待機後にwrite権限を絞ったtrusted App tokenで同じdispatchをfresh revalidationし、stale/consumedならignoreする。malformed/ignoreはcanonical writer groupへ入らない。accepted recordのPOST前にcurrent HEADのPR file listを確認し、`.github/workflows/claude-review.yml` を変更するPRはwrite前に停止してsource pauseをRecoveryの `pre_acceptance` に維持する。accepted recordのPOST応答喪失時はtrusted graphで一意のrecordを再確認し、不確実なPOSTを再送しない。source consumed・active pause無しを確認してからclosing Issue、PRの順でlabelを解除し、各writeの応答喪失時にもfresh absentを確認する。PRのunlabeled eventで既存normal `Claude Review`へhandoffし、同じHEAD/PRのReview jobとmodel選択stepのentry証跡を最大9回・10秒間隔で確認する。queued / in-progressでentry未確認、またはgate declineは成功とせずfailureにして独立Recoveryへ委ねる。Review jobのearly failureはFailure Handler ownershipを優先する。run-nameのPR/source pause identityとcanonical closing IssueのconcurrencyはRecoveryと一致させる。

現行productionではconsumerのfailure / cancelled / timed_outをsourceとする `AI Resume Review Recovery` が `workflow_run: completed` から到達可能である。Recoveryは既存のIssue/PR pause invariantを修復するwriteを持つ。特に `pre_acceptance` でsource pauseが未consumedのとき、closing Issue / PR双方で欠けた `human-review-required` labelを再同期し得る。

`AI Developer` の `develop-from-issue`、`pull_request_review` のchanges_requestedを受ける `respond-to-claude`、consumerの`inspect`、Recoveryの`recover`は、canonical `ai/issue-N` branchでは同じ `codex-writer-ai/issue-N` に入る。`respond-to-claude` のgroup式は `codex-writer-${{ github.event.pull_request.head.ref }}` である。GitHub Actions concurrencyはrunning 1件とpending 1件であり、新しいpendingが古いpendingをcancelし得る。`cancel-in-progress: false` はpending相互cancelを防がない。自動retry・再dispatchはしない。cancelを検知した人間はActionsの**run ID、run attempt、display title、conclusion**を記録し、jobがpendingのままcancelされたか、step開始後にcancelされたかを確認する。developer runではeventとsource identity（通常のIssue commentか `repository_dispatch: ai-resume-develop` か）も確認する。source consumerのtitle `AI Resume Review Consumer pr:<PR> pause:<source>` とcanonical closing Issueを照合し、同じIssueのdeveloper / follow-up / consumer / recovery各runとそのattemptを並べて、後続running / pending runの完了を待つ。conclusionだけからstate writeの有無を推測しない。

| Cancelされたjob | fresh factsに基づくmanual recovery |
| --- | --- |
| consumer `inspect`（または`gate`） | current PR HEAD、source pauseのactive/consumed状態、accepted graph、Issue/PR labels、normal Review ownership、trusted command、closing Issue relationと後続runを再取得する。write前のpending cancelと確認でき、有効な同一snapshotの場合だけ元runのmanual re-runを判断する。write開始後はRecoveryの完了状態を確認し、partial writeや所有者不明なら停止する。 |
| Recovery `recover`（または`resolve`） | source consumerのrun ID/attempt/title/conclusion、current record graph、Issue/PR labels、normal Review ownershipを再取得する。後続Recoveryが修復済みなら終了する。未修復でsource identityとownershipが一意に確定するときだけ元Recovery runのmanual re-runを判断し、`prepare-ai-resume-review-recovery.sh` と `recover-ai-resume-review.sh` のfresh再照合へ委ねる。`pre_acceptance` の欠落Issue/PR labelを含め、write応答喪失時はgraph/labelsを再読してから次のwriteを判断する。 |
| AI Developer `develop-from-issue`（`issue_comment` の通常 `/codex develop`） | eventと元Issue commentを確認し、current canonical branch HEAD、open PR、closing Issue、pause/labels、同runのrepository write開始・commit/push/PR作成証跡と後続runを再取得する。pending cancelでwrite前と確認できた場合だけ「Issue起点AI Developerの異常終了」の既存手順に従い、通常Issue起点のmanual再実行を判断する。write開始後はbranch/PR/Issue stateをreconcileし、partial writeや所有者不明なら停止して人間判断へ送る。 |
| AI Developer `develop-from-issue`（`repository_dispatch: ai-resume-develop`） | eventと元PR Conversationのsource identityを確認し、active source pause、current PR HEAD、Issue/PR labels、closing Issue relation、accepted graph、branch/PR stateと後続runをfresh再取得する。resume-gate前にpending cancelされ、source pauseが未consumedと確認できた場合は既存resume契約に従い、PR側 `/ai resume develop` の再発行を判断する。通常 `/codex develop` へ切り替えない。resume acceptanceまたはrepository writeが始まった証拠があればgeneric retryせず、accepted graph、replacement pause、branch/PR stateをreconcileし、partial writeや所有者不明なら停止して人間判断へ送る。 |
| AI Developer `respond-to-claude`（`pull_request_review` のchanges_requested） | eventとreview ID、review対象HEAD、current PR HEAD / Draft状態、closing Issue、後続runを確認し、`Run Codex follow-up` の開始・push有無を照合する。`cancelled` は `handle-claude-followup-failure` のfailure条件に該当せず、新たなpause・通知は作られない。専用follow-up retry入口はないため、「Claude review follow-upの異常終了」の手動修正・再レビュー手順に従い、停止ラベルがある場合は解除契約を適用する。partial pushやwriter ownershipが曖昧ならfail-closedで停止して人間判断へ送る。 |

いずれもrun/attempt、各経路に該当するsource identity・HEAD・record graph・writer ownershipが曖昧、またはpartial writeの結果を確定できない場合はfail-closedで停止する。再実行判断は過去のdispatch snapshotやcancel結論のみで行わず、current factsを再取得する。

schema形式の正本は `human-pause-record.sh`、graph構造の正本はgraph validator、chain分解の正本はdecomposition helperである。pre-resume意味論、acceptance意味論、Conversation集約は、それぞれ後段のderive、resume-acceptance、active-pause helperが担当する。後段helperの防御的validationは、自身が安全に処理するために必要な入力境界をfail-closedで確認するものであり、上流契約を第二の正本として再実装するものではない。特に、この防御的validationをgraph validatorの第二schema正本化へ逆流させない。

### trusted diff guard

Issue起点developerとClaude review follow-upの両方で、Codex実行後かつrepository write（commit、push、PR作成・更新またはreview応答）前に、runtime-onlyの `.ai-context` をworktreeとindexから除外し、それ以外の変更をstagingしてindexを確定する。trusted diff guardはこのstaged diffを評価する。両経路ともPR headやCodexが変更した作業ツリーのhelperを実行せず、current base commit由来でpre-Codexにblob identityを固定し、post-Codex restoreで再materialize・identity再検証した `$RUNNER_TEMP/evaluate-codex-diff-gate.sh` を使用する。base helperの取得・bootstrap、post-Codex restore、blob identity検証、contract再生成またはschema検証に失敗した場合も安全側へ停止する。

引数なしの評価modeでは、helperのstdoutは1個の機械可読な評価結果JSON objectであり、呼出側は `result` と全ての非負整数metricsを検証する。helperのexit statusが0で、JSONが妥当であり、かつ `result=pass` の場合にだけrepository writeへ進む。`result=pass` 後からrepository writeまで、guardが評価したindexを維持する。再度の `git add` その他のindex更新、または `git commit -a` / `git commit -am` により、未評価のworktree変更をcommit対象へ追加してはならない。repository writeの対象は、guardが評価してpassしたstaged diffと同一でなければならない。`stop`、`error`、未知のresult、helper異常終了、出力parse失敗またはmetrics不正は、いずれもwriteを許可しないfail-closed停止とする。

hard stop閾値のproduction正本は、base-derivedの `.github/scripts/evaluate-codex-diff-gate.sh` にある3定数である。その現行参照値は、changed files / total changed lines / new filesの順に `25 / 2,000 / 10` であり、この文書は値の別正本ではない。引数なしはstaged diffを評価するmode、`--contract` はproduction contractを取得するmodeである。後者は同じ定数から `max_changed_files`、`max_changed_lines`、`max_new_files` だけを含むcontract JSON objectをstdoutへ出力し、その他の引数または複数引数はusage errorで失敗する。評価modeでは結果JSONとmetricsを、`--contract` modeでは3 keyだけからなるschemaと正の整数値を、それぞれ呼出側が検証する。

Issue起点とfollow-upのbootstrapが生成する `$RUNNER_TEMP/codex-diff-guard-contract.json` は、Codexへの早期抑止指示用 `.ai-context/diff-guard-contract.json` を作るためのdisposable inputであり、model execution前に `RUNNER_TEMP` から削除する。`.ai-context/diff-guard-contract.json` はruntime-onlyのmodel-visible worktree artifactでありCodexが変更できるため、hard-stop判定またはJob Summaryのtrusted sourceとして扱わない。hard-stop判定とJob Summaryの閾値表示は、post-Codex restore stepがtrusted baseから復元・blob identity検証した `evaluate-codex-diff-gate.sh --contract` から再生成し、schemaと値を再検証した `$RUNNER_TEMP/codex-diff-guard-contract.json` だけから導出する。PR headやCodexが変更したworktreeのcontractでこれらを上書きしてはならない。temporal rematerialization、blob identity、fail-closed orderingの詳細契約は後述「Issue起点developerのCodex実行境界」を単一正本とする。

評価対象はstaged diffである。changed files、additionsとdeletionsの合計である total changed lines、new filesの各値がcontractの対応する閾値ちょうどなら `pass`、いずれか一つでも超過すれば `stop` とする。binary変更、staged `.gitattributes` の `-diff` などでnumstatを数値化できない場合は、変更を省略したり0として扱わず `error` で停止する。bypassは設けない。正当な大規模作業または数値化不能な変更は、安全性・正確性・要求整合性を保てるIssueへ分割するか、人間実装へ切り替える。

numstatの数値化不能または不正な行では、error resultに `error` codeと `offending_paths`（staged pathのJSON配列）、`offending_paths_truncated`、`offending_paths_unknown` を記録する。pathは内容を出さず、各pathの原byte 256・JSON表現512 byte、配列10件・JSON表現合計2,048 byteを上限とし、超過時は `offending_paths_truncated=true` とする。pathを特定できない不正行は `offending_paths_unknown=true` とする。制御文字、改行、非ASCIIはJSON escapeし、Issue起点とfollow-upの診断commentおよびStep Summaryへ同じbounded JSONを渡す。これらの診断fieldはpass/stop判定を変更しない。

`stop` またはerror系の停止では、developer経路はprimary Issueと、canonical branchに一致するsame-repository open PRがちょうど1件ならそのPRをcommon helperで停止し、0件ならIssueのみ停止する。same-repository候補が複数件・API結果が不正・結果打ち切りの疑いがあればPR target解決をfail-closedとし、pause成立後にIssueへ非機密な診断commentを記録する。このPR target規則はIssue起点requirements gateと異常終了handlerにも適用する。follow-up経路は対象PRと解決できるclosing Issueを `human-review-required` により停止し、PRへ診断commentを記録する。Step Summaryにはresult、閾値、利用可能なmetricsまたは「Metrics: unavailable」、およびrepository writeをblockedした決定を記録する。developer経路の通知はcommon helperがGitHub pause成立後に試行し、follow-up経路の通知は専用stepで試行する。再開時の停止ラベル解除は「人間エスカレーション」節の停止解除・cleanup契約に従う。

`evaluate-codex-diff-gate.sh` を変更した場合は `bash .github/scripts/test-evaluate-codex-diff-gate.sh` を実行する。`human-pause-record.sh` を変更した場合は `bash .github/scripts/test-human-pause-record.sh` を実行する。`list-human-pause-records.sh` を変更した場合は `bash .github/scripts/test-list-human-pause-records.sh` を実行する。`validate-human-pause-record-graph.sh` を変更した場合は `bash .github/scripts/test-validate-human-pause-record-graph.sh` を実行する。`decompose-human-pause-record-graph.sh` を変更した場合は `bash .github/scripts/test-decompose-human-pause-record-graph.sh` を実行する。`derive-human-pause-pre-resume-state.sh` を変更した場合は `bash .github/scripts/test-derive-human-pause-pre-resume-state.sh` を実行する。`reconcile-human-pause-resume-acceptance.sh` を変更した場合は `bash .github/scripts/test-reconcile-human-pause-resume-acceptance.sh` を実行する。`reconcile-human-pause-active-pause.sh` を変更した場合は `bash .github/scripts/test-reconcile-human-pause-active-pause.sh` を実行する。`reconcile-human-pause-resume-acceptance.sh` または `reconcile-human-pause-active-pause.sh` を変更した場合は、#278 → #273 の実出力直結合成性を維持する `bash .github/scripts/test-reconcile-human-pause-resume-acceptance-active-pause.sh` も実行する。AI Developer workflowの静的契約を変更した場合は `bash .github/scripts/test-ai-developer-workflow.sh` を、diff guardを変更した場合は `bash .github/scripts/test-ai-developer-diff-guard.sh` を実行する。`build-review-context.sh` のscript挙動（trusted/untrusted conversation境界、follow-up Issue抽出・重複排除・上限・取得失敗のfail-closed、linked Issue取得失敗、diff上限）を変更した場合は `bash .github/scripts/test-build-review-context.sh` を実行する。Claude Review専用fixtureの責務（review context workflow step契約・trusted bootstrap、entry gate、risk classifier、model/budget配線、native schema準備、native output masking、native output validator、execution classifier、usage計測、structured review保存、workflow静的契約）を変更した場合は `bash .github/scripts/test-claude-review-workflow.sh` を実行する。`bash .github/scripts/test-ai-workflow.sh` は専用fixtureを置き換えない横断回帰であり、これらに加えて引き続き実行する。

`create-human-pause.sh` または `format-human-pause-notification.sh` を変更した場合は `bash .github/scripts/test-create-human-pause.sh` を実行する。

### Codex timeout・runner異常終了時の診断と再開

AI DeveloperのIssue起点Codex実行は、**systemd service cgroup内のinner timeout、GitHub step timeout、job-level timeout** の3段階で有限時間へ収束させる。

* 通常 `/codex develop` はinner `RuntimeMaxSec=700s`、developer step 12分、job 15分とする。
* 人間が明示的に `/codex develop extended` を選んだ場合だけ、inner `RuntimeMaxSec=1780s`、developer step 30分、job 35分へ固定延長する。任意timeout入力、automatic fallback、automatic retryは設けない。
* transient serviceの**timeout収束に関わるproperty**として `Type=exec`、`KillMode=control-group`、`SendSIGKILL=yes`、`TimeoutStopSec=5s` を固定する。service property全体の正本は後述「Issue起点developerのCodex実行境界」とし、inner timeoutをCodex process treeのprimary bound、GitHub step timeoutをsystemd/root-shell異常時のbackstop、job timeoutをrunner-lossを含む最終外側boundとして扱う。
* `respond-to-claude` はpin済みv1.12 Actionを `safety-strategy: unsafe` のsetup専用に限定し、prompt / prompt-file / output-fileを渡さない。actual follow-up Codexはtrusted native binaryをservice-local boundary内で実行するため、Action default `drop-sudo` に依存せず、host-global socket permission、sudoers、group membershipを変更しない。
* follow-upはinner `RuntimeMaxSec=700s`、step 12分、job 15分で有限時間に収束させる。Issue起点developerと同じtrusted Action blob / localhost Responses proxy検証、runner UID + nobody GID + clear groups + no-new-privs + capabilities zero、generic AF_UNIX許可と13 fixed socketのservice-local mask、residual `/run` writable root-owned UNIX socket fail-closed scanを使う。service終了後のunit限定journal回収、rc=0時のexact preflight success marker検証、exit 51の切り分けも「Issue起点developerのCodex実行境界」を正本として同一契約を使う。workloadの前後ではread-only socket / systemd-resolved / DNS integrity observerがrepository write前に不変を確認する。OpenAI API keyはsetup Actionだけに渡し、native serviceの`env -i` allowlistには渡さない。failure時のrequirement gate、trusted diff guard、repository-write fail-closed順序とautomatic retryなしの契約は維持する。
* timeout / failure後に同jobでrepository writeへ進む例外は設けない。developer stepがsuccessしない限り、requirement gate、diff guard、commit、push、PR作成へ進まない。

#### Issue起点developerのCodex実行境界

Issue Developer / `/ai resume develop` はIssue単位のwriter concurrency内で、Codex runtime準備前に `origin/main` を明示fetchし、そのcommitをcurrent trusted base SHAとしてhelper blob、`AGENTS.md`、diff guard contractに使用する。canonical `ai/issue-N` branchが存在しない場合だけこのSHAから作成する。既存branchはremote HEADを取得し、current mainがbranch HEADのancestorである場合だけCodexへ進む。stale branch、fetch失敗、ancestry検証失敗ではremote branchへのwriteやpaid Codexを行わずfail-closedし、remote HEADがpre-write snapshotから不変なら既存failure handlerの `developer_execution_failed`（`failed_action=develop`）pauseへ進む。branchの自動merge / rebase / resetは行わず、Codex diff guardは今回のstaged diffだけを計測する。#484 / #487のpaused PRは自動同期せずsuperseded候補として保持し、pause解除やPR normalizationは#229 / #483 / #485の正本に従う。

2026-09-18の #309 調査では、Issue起点AI Developerの長時間停止を段階的に切り分けた。

* #312ではGitHub Actionsのbackground/cancel後もcomposite内部processがjob cleanupまで残り得ることを実証し、background/cancelをprocess停止境界として不採用とした。
* #313 / Run #838ではpin済みActionをsetup-only化してnpm `codex exec` を通常 `run:` stepへ分離してもjob cancellationまで収束しなかった。
* #316 / Run #57ではliteral / expressionのstep timeout自体は正常に発火しdirect parent PIDを停止できる一方、descendant processが残り得ることを実証した。direct parentが先にexitしてdescendantだけがstdioを保持するケースではstepは約5秒で収束した。
* `@openai/codex@0.156.1` のnpm entrypointはNode launcherで、platform native Codexをspawnしsignalをforwardしてchild終了を待つ。#407で `rust-v0.156.1/codex-cli/bin/codex.js` とmanaged-install環境を確認した。`0.153.4` / #318の確認はhistorical evidenceに限定する。
* #318 / Run #58ではtrusted npm packageからnative Codexをfail-closedに解決し、npm launcher/native双方が `codex-cli 0.153.4` を返すことを実証した。
* #322 / Run #60ではpin済みActionのofficial root-phaseとupstream相当`setpriv` hardeningを再現し、runner UID、nobody GID、supplementary groups empty、`NoNewPrivs=1`、全capability zero、sudo disabledを確認したが、step timeout後もhardened childが生存した。
* #324 / Run #61では同じroot-phase + `setpriv` hardening済みprocess treeをsystemd transient service cgroupへ収容し、別sessionへ逃げたsignal-resistant childを含め `RuntimeMaxSec` + `TimeoutStopSec` + `KillMode=control-group` + `SendSIGKILL=yes` で有限時間に停止できることを実証した。
* #357 / Run #103 `35496283169` では、v1.12 root-phaseのhost-global service-socket制限を分離し、`/run/systemd/notify` 制限がsystemd-resolvedのwatchdog/restart loopを起こし、さらに `/run/dbus/system_bus_socket` をroot-only化するとlate DNS failure、artifact failure、job cancellationまで再現することを確認した。systemd v255 sourceでも、restart後の非root resolvedはDNS stub開始前にsystem bus接続へ失敗し得る。
* #363 / PR #364 / Run #137 `35500874486` ではroot-phaseを呼ばず、systemd service-localのAF_UNIX deny、native ABI固定、io_uring syscall denyと既存 `setpriv` hardeningだけでactual Codex 0.153.4のlocalhost Responses request、20秒cgroup timeout、sudo不可、AF_UNIX不可、AF_INET可を同時に実証した。host側のnotify/D-Bus socket、systemd-resolved PID/NRestarts、DNSは前後不変だった。ただしこの時点ではCodex local-tool / bubblewrap pathを未検証だった。
* #368 / Run `35505392927` ではproduction service-local境界からactual Codex model callまでは成功したが、最初のlocal commandでbubblewrapが `Failed to look up lo: Address family not supported by protocol` となり、#363 positive proofにlocal-tool互換性の穴があることを確定した。
* #371ではこのproduction local-tool blockerをsecretlessに再実証する調査単位として切り出し、#372 / #374 / #376 / #377の順に原因、一変数比較、production同型userns条件、代替service-local boundaryを実証した。positive proof完了後にCloseし、production実装を#378へ分離した。
* #372 / Run `35506216726` では一変数比較により `RestrictAddressFamilies=~AF_UNIX` が上記loopback lookup failureの直接原因であることを確定した。
* #374 / Run `35507303861` ではactual Terra Code Modeの `exec -> tools.exec_command` pathでもcurrent境界は同じlookup failure、AF_UNIX controlは次段のRTM_NEWADDRまで進むことを確認した。
* #376 / Run `35507942245` ではproduction同型official userns prerequisite下でgeneric AF_UNIXを許可し、既存setpriv / NoNewPrivs / capability / cgroup境界を維持したactual Terra local toolが `codex-exec-tool-probe-ok` まで成功した。
* #377 / Run `35508896886` では、旧root-phaseが実際にmode縮小していた13 root-owned socketを `InaccessiblePaths=` でservice-localにmaskし、AF_UNIX / AF_INET可、actual Terra local tool成功、13 socketのhost inode非露出、host socket metadata / systemd-resolved / DNS前後不変を同時に実証した。

productionのIssue起点developerは#324のcgroup positive proofを維持し、#357で判明したhost-global mutationを廃止する。#363で採用したblanket AF_UNIX denyは#368/#372/#374でlocal-tool blockerと確定したため撤回し、#376/#377でpositive proofしたgeneric AF_UNIX許可 + historical 13 socketの `InaccessiblePaths` maskを採用する。runner-image driftは同service identityから `/run` のroot-owned writable UNIX socketをread-only走査し、未知socketが残ればmodel call前にfail-closedする。

`Setup Codex developer runtime` はpin済み `openai/codex-action@86365089eb2b84e0a8fb0717b304f8bdcb13b20e` v1.12を維持し、CodexはIssue #614で0.156.1から0.159.3へ更新する。Issue #614の2026-10-01着手checkpointによると、0.159.1で`gpt-6.1-sol`がbundled catalogへ追加され、0.159.3は同じstable patch系列の最新releaseである。OpenAI API keyを受け取る唯一のstepとする。prompt / prompt-file / output-fileは渡さずmodel executionへ入らない。setup-only invocationでは `safety-strategy: unsafe` を明示するが、これは**Actionのhost-global `drop-sudo` を起動せずCLI / localhost Responses proxyを準備するsetup専用指定**であり、Codex workloadをunsafeで実行する意味ではない。pin済みv1.12の `writeProxyConfig()` は `unsafe` 時にもpermission / sandbox / approval設定を書かず、`model_provider = "codex-action-responses-proxy"` とlocalhost `base_url` / `wire_api = "responses"` だけを追加する。

setup前にはrunner temp `CODEX_HOME/config.toml` を削除し、前runや別設定の残存を許可しない。setup後のtrusted resolverはrunner PATH上のnpm entrypointを起点に `@openai/codex@0.159.3`、Linux x64 / arm64 platform package、native `vendor/<target>/bin/codex` をfail-closedに検証する。さらにrunner action cache内のpin済みAction `dist/main.js` を解決し、`git hash-object` がGit blob SHA `ce4e94e119abb91b980d23bfb4210688241f3a0a` と一致することを必須とする。workspace、Issue本文、comment由来のpathやpackage名は使用しない。runner UID / primary GID / supplementary GIDsはupstream `LinuxRunnerCredentials` shapeのcompact JSONとして取得し、developer step開始時に再照合する。resolverとfixed prompt stepは各3分timeoutでfail-closedに束縛する。

固定developer promptは `$RUNNER_TEMP` の専用fileへ書き、Issue本文とtrusted conversationは従来どおり `.ai-context/request.md` のdataとして読み込ませる。workflow shellへIssue本文を展開しない。

`RUNNER_TEMP` はCodex workloadをまたぐtrusted artifact保持境界として扱わない。native Codex serviceへ `RUNNER_TEMP` 自体をallowlistし、`CODEX_FINAL=$RUNNER_TEMP/codex-final.md` をworkload completion時に書き出すproduction経路が成立しているため、同directoryへpre-Codexに置いたhelper / contractについて「workloadから書換不能」とは推定しない。Issue Developer / Claude follow-upはそれぞれ使用するhelperとその依存scriptのbase commit blob SHA、およびbase SHAをpre-Codex runner step outputへ固定する。対象集合の正本は `.github/workflows/ai-developer.yml` の各context生成・restore step（上記#797 / #798の収集専用restoreを含む）と、`.github/scripts/test-ai-developer-workflow.sh` のsupply/restore fixtureとし、Issue Developerのdecision classifier / scope primitive / common pause依存scriptも含む。これらのstep outputはnative Codex serviceの `env -i` allowlistへ渡さない。pre-Codex helperと `codex-diff-guard-contract.json` はcontext生成後に `RUNNER_TEMP` から削除し、workspace側 `.ai-context/diff-guard-contract.json` はmodel-visible dataであってpost-Codex trusted判定の正本とはしない。Codex終了後かつhost integrity observer成功後、post-Codex decision gateより前に各経路の対象helperをexplicit base commitから再materializeし、各fileの `git hash-object --no-filters` がpre-Codexに固定したblob SHAと一致することを必須とする。missing / malformed output、`git show` failure、blob mismatchはいずれもfail-closedとし、diff guard contractは復元済み `evaluate-codex-diff-gate.sh --contract` から再生成してschemaを再検証する。その後のdecision marker判定、human pause / notify、diff guardだけがこの復元済みartifactを使用する。Issue Developer / Claude follow-upは同じ境界を使い、root-owned temporary directory、host-global permission mutation、追加secret、追加model callには依存しない。上記#797 / #798の非致命な収集専用restoreはこのidentity照合境界を再利用するが、実行失敗後も観測できるよう独立conditionとし、decision gate用restoreの成功条件・authorityを変更しない。

developer stepはtrusted Action helperのblob SHAを再確認したうえで、`sudo -n` を**transient service作成だけ**に使用する。step environment全体をrootへ継承する `sudo -E` は使用せず、pin済みActionの `drop-sudo --root-phase` は呼ばない。runner userのgroup membership、sudoers、root-owned `/run` service socketなどhost-global stateを変更しない。root shellから `systemd-run --wait --collect` で一意なtransient serviceを作成し、既存のcgroup propertiesに加えて `NoNewPrivileges=yes`、`SystemCallArchitectures=native`、`SystemCallFilter=~io_uring_setup:EPERM io_uring_enter:EPERM io_uring_register:EPERM` を固定する。Codex/bubblewrapがlocal tool sandbox初期化にAF_UNIXを必要とするためblanket `RestrictAddressFamilies=~AF_UNIX` は使用しない。代わりに、#377 / Run `35508896886` でpositive proofした旧root-phase対象13 socketを `InaccessiblePaths=` でtransient serviceのmount namespaceだけにmaskする。対象pathは `/run/dbus/system_bus_socket`、`/run/dhcpcd/eth0-4.unpriv.sock`、`/run/docker.sock`、`/run/snapd-snap.socket`、`/run/snapd.socket`、`/run/systemd/io.systemd.ManagedOOM`、`/run/systemd/journal/dev-log`、`/run/systemd/journal/socket`、`/run/systemd/journal/stdout`、`/run/systemd/journal/syslog`、`/run/systemd/notify`、`/run/systemd/userdb/io.systemd.DynamicUser`、`/run/uuidd/request` の13件である。runner imageでpathが存在しない場合だけ `-` prefixで無視し、host側permissionは変更しない。service内では `setpriv` を用いて次を固定する。

* `--reuid=<runner uid>`
* `--regid=<validated nobody gid>`
* `--clear-groups`
* `--no-new-privs`
* `--bounding-set=-all`
* `--inh-caps=-all`
* `--ambient-caps=-all`

#642では3つのio_uring syscallだけに `:EPERM` を指定し、syscallは拒否したままNode/libuvのfallbackを可能にする。globalな `SystemCallErrorNumber=` は指定せず、native ABI制限など他の拒否actionを変更しない。developer/follow-up双方の同一service preflightで3 syscallへの不正引数probeがすべて `-1 / EPERM` を返すことと、`node --version` / `npm --version` の成功を確認する。version commandは `/` をcwdとして外部network・repository package scriptを使用せず、各20秒で束縛し、失敗時はmodel call前に停止する。unit journalの `IO_URING_DENY` / `NODE_TOOLING` 行でerrno、version、exit status（負値はsignal）を確認する。静的・mock回帰と、systemd/sudo/Node 24が利用できるrunnerでproduction launcherを抽出して実行するfixtureは `.github/scripts/test-codex-node-hardening.sh` に置く。制限されたworkloadではruntime検証をskipした理由を報告し、変更後のsame-unit実証が済んだとは扱わない。依存package取得・cache/network境界は#538、Product tooling実装は#638の範囲とし、本変更ではregistryへアクセスしない。

native Codex exec前には同じservice / `setpriv` contextで、UID/GID、supplementary groups empty、`NoNewPrivs=1`、全capability zero、`sudo -n true` の失敗、AF_UNIX socket作成成功、AF_INET socket作成成功をfail-closedに確認する。さらにroot shellはservice起動直前に固定13 pathのうち存在するsocketについてowner/dev:inodeだけをread-only取得し、socket種別はshellの`-S`で確認してroot-owned socketであることを固定する。service側は同baselineを受け、固定pathが存在する場合はservice viewがsocket / mode 0000 / runner identityからR/W/X不可かつhost側dev:inodeとは異なることを確認する。host baseline取得後に新たに固定pathが出現した場合もraceを信用せずfail-closedする。その後 `/run` をread-only走査し、mask後もrunner identityからwrite可能なroot-owned UNIX socketが1件でも残れば、未知のrunner-image driftとしてnative Codex/model call前にfail-closedする。permission上traverse不能なpathとscan中に消滅したpathはworkloadから到達不能または通常のruntime raceとしてskipするが、それ以外のscan errorはfail-closedとする。directory symlinkは `os.walk(..., followlinks=False)` で辿らず、files entryのmetadata取得も `os.stat(..., follow_symlinks=False)` としてsymlink targetを解決しない。これはsymlink loopと `/run` 外へのscope escapeを避けるための意図的な境界であり、`ELOOP` をgeneric skip errorへ追加してfail-closed条件を弱めない。socketへconnectは行わず、host側permissionも変更しない。このguardの対象は、旧root-phaseが実際に制限していたsecurity intentに合わせたfilesystem path上のroot-owned service socket under `/run` である。abstract namespace socket、`/run` 外のfilesystem socket、非root所有socketは本guardの対象外であり、blanket AF_UNIX denyと同等の全AF_UNIX遮断を主張しない。現在のrunner/Codex evidenceではこれらを追加遮断する根拠はなく、別のprivileged IPC classがrunner imageまたはCodex threat modelで確認された場合は#328で再評価し、推測でscopeを拡張しない。なお固定13 pathの `InaccessiblePaths` maskはservice全期間で継続する一方、residual writable root-owned socket scanはnative Codex起動直前のpoint-in-time検査であり、preflight通過後に新規生成された別pathのsocketを継続監視しない。この時間的残存面も受容済みとし、runtime revalidationやrunner-image変化で新規privileged socket classが観測された場合は#328で再評価する。このpreflightはtransient serviceのExecStart内で実行されるため `RuntimeMaxSec` の内側に含まれる。service内preflightの失敗はunit journalへ `サービス内の保護設定の事前確認で...` diagnosticを残し、exit codeを `39=sudo検査不能 / 40=sudo保持 / 41=UID不一致 / 42=GID不一致 / 43=supplementary groups残存 / 44=NoNewPrivs不成立 / 45=capability非zero / 46=AF_UNIX拒否 / 47=AF_INET拒否 / 48=固定socket maskまたはhost baseline不成立 / 49=残存writable root-owned UNIX socketまたはscan異常` として付与する。root shellでservice起動前の固定path baseline取得・socket種別・owner確認が失敗した場合はexit 50とし、transient unit作成前なのでunit journalではなくdeveloper step logへ `root側の保護設定の事前確認で保護対象UNIX socketの基準値取得に失敗しました: ...` を残す。この場合はunit限定journal回収へ到達しない。これらのcodeはnative Codex自身のexit codeと衝突し得るため、code単独で原因を確定せず、39–49はunit journal、50はdeveloper step logの対応diagnosticと併読して判定する。service自体がrc=0でも、後段のexact preflight success markerを同一unit journalから回収・検証できない場合はdeveloper stepがexit 51でfail-closedする。一方でnative Codex自身のrc=51もそのままdeveloper stepへ伝播し得るため、51だけでは原因を確定しない。developer step logに `サービス内の保護設定の事前確認の成功markerをunit journalから取得できませんでした。` がある場合だけmarker回収failureと判定し、同diagnosticが無い51はservice/Codex側failureの可能性を維持する。

#772ではこのhardening後かつservice cgroup内で上記trusted supervisorがvalidated native binaryを1回起動する。service commandは `/usr/bin/env -i` から開始し、`HOME` / `USER` / `LOGNAME` / `PATH` / `RUNNER_TEMP` / `GITHUB_WORKSPACE` / `CODEX_HOME` / `CODEX_FINAL` / `CODEX_PROMPT_FILE` / `CODEX_MODEL` / `CODEX_NATIVE` / `CODEX_PACKAGE_ROOT` / `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` / `PROTECTED_UNIX_SOCKET_PATHS` / `PROTECTED_UNIX_SOCKET_HOST_IDS` だけを明示allowlistとして渡す。後二者は上記13件の非機密な固定path listと、service起動直前にroot shellがread-only取得した存在pathのdev:inode baselineであり、同一service preflightが `InaccessiblePaths` の実効性とhost inode非露出を検証するためだけに使用する。preflight完了後のsupervisor / native childへ渡す `exec env` では両変数を明示unsetし、Codex process / local toolへhost baselineを継承しない。API key、GitHub App token、setup stepのその他environmentも継承しない。npm launcher parityとして `CODEX_MANAGED_PACKAGE_ROOT=<validated package root>`、`CODEX_MANAGED_BY_NPM=1` をchild launcher内で付与し、Bun / pnpm / Vite+ markerはunsetする。pin済みAction sourceではResponses API endpointは追加environmentではなく `CODEX_HOME/config.toml` のlocalhost providerで渡されるため、serviceはこのallowlistだけでproxyを利用する。actual Codex + localhost request pathは#363 / Run #137でservice-local hardening下でも成立済みである。

developer stepのpreflightでは `CODEX_HOME/config.toml` をTOML parseし、top-levelが `model_provider` / `model_providers` だけであること、selected providerが `codex-action-responses-proxy` であること、`base_url` が `http://127.0.0.1:<valid-port>/v1`、`wire_api` が `responses` であることを必須とする。unexpected keyやpermission / sandbox / approval設定が混入した場合はfail-closedに停止する。CLI optionはworkflow側の固定値だけとし、native childにだけ付ける `--json`、`--skip-git-repo-check`、workspace、final output path、trusted `CODEX_MODEL`、`model_reasoning_effort="medium"`、`default_permissions=":workspace"` を固定する。0.156.1 sourceでは `default_permissions` がpermission profile選択キーで、`:` 始まりの名前はbuilt-in profile、`:workspace` はbuilt-in workspace profileとして解決される。これらの旧versionのsource確認だけでは0.159.3の実効動作を保証しない。#410 / Run `35822596587` と#328 / Run `35514293157` では0.156.1 / `:workspace` のactual local-tool pathとfinite completionを確認済みだが、任意の `$RUNNER_TEMP` pathに対するlocal-tool write可否までは推測しない。一方、native Codex workload自身が同directoryの `CODEX_FINAL` を書く設計・実績があるため、`RUNNER_TEMP` をpost-Codex trusted artifactの非書込境界としては使用しない。継続的なruntime / hardening実証は#328を正本とする。service rcがnon-zeroの場合はそのcodeをdeveloper stepへ伝播させ、timeout / Codex failure / launcher failureを既存どおりfail-closedに扱う。transient serviceのstdout/stderrは既定どおりjournalへ送られるため、service終了後にはまず対象unitだけを `journalctl --unit="$unit" --no-pager --output=cat --lines=200` でboundedに回収し、既存preflight診断 / sanitized supervisor record / timeout failureの非機密診断をephemeral runner終了前に残す。このbounded dumpはdiagnostic専用で `|| true` を維持する。service rc=0の場合だけ、同じunique unitへ2本目のread-only `journalctl --unit="$unit" --no-pager --output=cat --quiet` を実行してそのunitの出力を取得し、journalctl固有の `--grep` / `--lines` 評価順序には依存せず、取得済みtextをshell側の `grep -Fxq` でexact `Service-local hardening preflight verified AF_UNIX/AF_INET and protected UNIX socket boundary.` markerと照合する。この2本目はtail boundを掛けず同一unit journal全体をshell変数へcaptureするため、unit journal量に応じてメモリ使用量と処理時間が増える。Run `35514293157` でpreflight markerが末尾200行から押し出された実績があり、boundedな診断用1本目だけではmarkerを確認できないためである。この2本目の取得内容はjob logへ出さない。journalctl自体の失敗またはexact marker欠落はexit 51でfail-closedとし、成功時はexpected markerと日本語の確認説明をstep logへ明示出力してからservice rc=0を返す。service rcがnon-zeroの場合はこのsuccess-marker確認を実行せず、marker欠落によって元のfailure rc / diagnosticを上書きしない。2本のjournalctlはいずれも同一unit限定であり、host-wide journalや他unitをdumpせず、marker用のworkload-writable fileも作成しない。

#369以降、`Run Codex developer` の直前と直後にはread-only host integrity observerを置く。beforeでは `/run/systemd/notify` と `/run/dbus/system_bus_socket` のdev / inode / uid / gid / mode、`systemd-resolved.service` のActiveState / SubState / MainPID / NRestartsを取得し、github.com / api.github.com DNS成功を確認する。capture stepはsocket / resolved / DNS確認完了後に値と `captured=true` を `$GITHUB_OUTPUT` へ書き、runnerがstep終了時にstep outputとして回収した値だけをafter observerへ渡す。`$GITHUB_OUTPUT` のbacking fileが実装上 `$RUNNER_TEMP` 配下に置かれること自体を安全根拠にはせず、Codex workloadへbaseline outputをenvironmentとして渡さないことと、capture step終了後にworkflow context経由で参照することを境界とする。afterは `if: always() && steps.host_integrity_before.outputs.captured == 'true'` でbaseline取得済みの場合だけ実行し、developer stepがrunnerへ制御を返した場合に、socket identity / modeとresolved 4 propertyがbeforeと完全一致、resolvedがactive/running、両DNSが引き続き成功することをfail-closedに確認する。host状態の取得には `stat` / `systemctl show` / `getent ahosts` のread-only commandだけを使用し、値の整形・比較は `printf` / `tr` / `sort` / `test` / `grep` のshell text処理に限定する。`/run` write、permission変更、service lifecycle変更、secret出力は行わない。before observerが失敗またはそれ以前の失敗でskipされた場合、after observerは明示的にskipし、主failureに加えてsecondary failureを発生させない。baseline取得後のdeveloper step failureではafter observerを引き続き実行し、不一致やDNS failureはfail-closedにする。follow-upも同じcapture markerでafter observerをgateする。既知のRun #846 / #853のようにdeveloper stepが `in_progress` のままjob-level cancellationまで制御を返さない場合も、後続の`if: always()`は開始できず `HOST_INTEGRITY after` は残らない。この欠落もhost mutationの証拠とは扱わず、観測不能としてautomatic retryせず#328へ戻る。

developer stepがsuccessし、host integrity after observerもsuccessし、`codex-final.md` がnon-emptyの場合だけ既存のrequirement change gate、trusted diff guard、commit、push、Draft PRへ進む。resolver / service-local hardening preflight / systemd / setpriv / native Codex / inner timeout / host integrity observerのいずれかが失敗した場合は通常後続stepをskipし、別job failure handlerで `human-review-required` へ停止する。

Codex 0.159.3のmain反映後production runtime再検証は#615で、現行 `CODEX_MODEL=gpt-6-sol` のまま1回限定で行う。`CODEX_MODEL=gpt-6.1-sol` への切替は#615成功後の#616で扱う。過去の0.156.1固有の再検証は#410で実施した。継続的なruntime / hardening再検証と失敗時の調査は親Issue #328を正本とする。#370でread-only host integrity observerはmainへ反映済みであり、#378のAF_UNIX/socket-mask production fixもmainへ反映されるまでは#307を再開しない。両方がmainへ入った後、#307本文は対象Issue固有の停止状態・branch / PR / unexpected repository write不存在とcurrent implementation contractを同期する。通常 `/codex develop` は#328で人間判断した対象1件へ1回だけ投入し、allowlist環境下のlocalhost Responses proxy経由model call、actual local-tool path、`:workspace` の実効permission境界、service-local preflight / setpriv / systemd cgroup収束、およびhost service socket / resolver / DNS非破壊を非機密証跡で確認する。いずれかを確認できない場合はautomatic retry / extended fallbackを行わず#328へ戻る。

upstream `openai/codex-action` で公式のprocess-tree lifecycle修正が反映された場合も、security hardeningとprocess-tree boundが本方式以上に維持されることをruntimeで確認するまで、安易にcgroup方式を撤去しない。

#### Issue起点AI Developerの異常終了

`develop-from-issue` がsuccess以外で終了した場合は、対象Codex jobとは別runnerで `handle-issue-developer-failure` を実行し、安全側へ停止する。developer jobはrepository write前にcanonical `ai/issue-<Issue番号>` remote HEADを固定する。handlerはdeveloper App tokenで同branchのcurrent remote HEADを取得し、job resultが `failure` / `cancelled`、両HEADが有効かつ完全一致する場合だけ `developer_execution_failed`（`failed_action=develop`）とする。その他の結果、HEADの欠落・取得不能・差異は `state_inconsistent` とし、直接resumeしない。差異だけから、このrunが書いたとは断定しない。

handlerはtrusted default-branch checkoutの `create-human-pause.sh` をdeveloper App IDとtokenで呼び、closing Issueと同branchのopen PR（存在する場合）を停止する。`developer_execution_failed` に確定できたときはrepair optionを渡し、先行する別reasonのactive pauseがあればその停止をラベル同期で成立させる。open PRが複数またはAPI結果が不正ならfail-closedにする。pause record成立後のラベル同期、重複抑止、Discord通知はcommon helperへ委ね、helper failureを正常扱いしない。自動retry、branch rollback、branch deleteは行わない。

Issue起点のAI Developerを再実行する前に、少なくとも次を確認する。

* 対象Issueが正しいこと。
* 失敗したActions Run URLまたはrun ID。
* `develop-from-issue` のjob result。
* pause recordとラベル同期の結果。
* `ai/issue-<Issue番号>` remote branchの有無と現在のhead。
* 同じIssueに紐づくopen PRの有無とPR head。
* timeoutまたは異常終了後に、予期しないcommit、push、PR作成・更新が発生していないこと。
* 取得可能な範囲で、通常の長時間実行、runner-loss、設定不備、一時的な外部障害等のどのカテゴリが最有力か。
* 「Issue本文におけるcurrent implementation contract」に従い、Issue本文が現在有効なscope、interface、完了条件を表し、trusted commentに新旧の競合する技術契約がある場合も本文からcurrent contractを一意に判断できること。
* 契約が未決または相互に矛盾する状態なら、同一の `/codex develop` を単純retryせず、実装判断を確定してIssue本文へ同期してから再実行すること。

再実行可能と人間が判断した後、停止ラベルがある場合は「人間エスカレーション」節の停止解除契約に従う。

既存PRへ追加開発を継続する場合は、PRがDraftであることと、既に開始済みのClaude Reviewがないことを確認する。openかつ非Draft PRで `human-review-required` を解除するとClaude Reviewの再実行条件になり得るため、追加開発中に意図しないレビューを起動しない。pushの`synchronize`だけではClaude Reviewを起動しない。merged/closed PRのcleanupは「人間エスカレーション」節を正本とする。

その後、再実行が必要な場合は原則としてOpen Issueへ `/codex develop` を単独コメントとして投稿する。十分に閉じたcurrent contractでも15分timeoutが再現し、通常runの単純retryではなく人間がextended-runを明示承認した場合だけ、次節の条件で `/codex develop extended` を使用する。

#### human-approved extended-run

`/codex develop extended` は通常runの代替ではなく、十分に閉じたcurrent implementation contractでも15分job timeoutが再現した場合の人間承認付き例外とする。timeout実測がない段階から最初の実行でextendedを選ぶことは運用違反とし、automation側は過去failure reasonを推測して機械判定しない。

使用前に、Issue起点の異常終了で定めるRun / branch / PR / unexpected write / current contractの確認を完了し、再開可能と人間が判断する。Issueまたは関連PRに `human-review-required` が残っている間はextended commandも起動しないため、人間が再開可能と判断した後に「人間エスカレーション」節の停止解除契約へ従ってからcommandを投稿する。

extended-runのjob-level timeoutは35分固定とし、developer stepは30分、inner cgroup `RuntimeMaxSec` は1780秒とする。通常commandはjob-level 15分 / developer step 12分 / inner cgroup 700秒とする。job 15分とdeveloper step 12分の差3分はsetup / native resolution / prompt準備、developer step前後のhost integrity observer（各stepのtimeout上限は1分）、post-gate / repository writeを含む外側余白である。observerの通常実行は短時間だが、このstep timeout上限を追加実行時間の保証値とはみなさない。inner 700秒とstep 720秒の公称差20秒は、developer step側のconfig.toml検証・runner credentials再照合、`systemd-run` unit作成、service終了後のunit限定journal回収、およびsystemd TERM→KILL収束（`TimeoutStopSec=5s`）を含む。上記「Issue起点developerのCodex実行境界」に定義するservice-local hardening preflight一式（identity / privilege、AF_UNIX/AF_INET、固定13 socket mask、`/run` residual writable root-owned socket scan）はExecStart内で実行されるため `RuntimeMaxSec` の内側である。extended側も1780秒と1800秒の公称差20秒を同じ内側収束余白として扱う。この余白の実効性は#328のruntime再検証で確認し、15分job cap内でafter observerまたは後処理へ到達できない場合はautomatic retryせず#328へ戻り、observer timeoutを含む外側budgetとinner / step timeout値を再評価する。任意timeout入力、通常15分runからのautomatic fallback、automatic retry、fail-open、停止ラベルのbypassは設けない。extended-runではCodex完了後のrepository write途中でjob cancellationへ到達し、push済みの `ai/issue-<Issue番号>` branchに対応するopen PRが存在しない状態が残る可能性もある。この場合は再実行前にbranch head、open PR、closing Issueの対応を照合し、予期しないcommit / push / PR writeがないことを確認してから復旧判断する。

extended-runでもtimeoutまたは異常終了した場合は、同じcommandを自動または単純retryしない。failure handlerによる停止を維持し、正常長時間処理、runner-loss、model/provider差、別実行経路の必要性を再調査する。extended-runの実地検証は #307 / Run #833 `35316054357` で1回実施済みで、Codex Action wrapperが完了せず収束しなかった。#365反映後は#328の再検証手順を正本として通常 `/codex develop` を人間判断した対象1件へ1回だけ投入し、service-local preflight + setpriv + systemd cgroup + native Codex経路とhost socket / resolver / DNS非破壊を再検証する。収束しなければautomatic retryせず #328 の調査へ戻る。`/codex develop extended` を投稿してもIssueへ診断commentが付かず、`human-review-required` も付かず、developer jobの記録も見当たらない場合は、job-level timeout式を含むworkflowの評価・起動前失敗の可能性を考慮し、Actions run一覧で当該eventのworkflow状態を確認する。

#### Claude review follow-upの異常終了

Claude review follow-upでは、通常の `Gate automated follow-up` は停止ラベルを付けない。stale・closed・停止中・取得不能なtargetは前段jobが正常skipし、failure handlerを起動しない。trusted Draft復帰jobまたは `Run Codex follow-up` がtimeout、runner-loss、action failure等で異常終了した場合は、専用failure handlerがtrusted base checkoutの `create-human-pause.sh` でPRをprimary targetとして停止する。event HEADとdeveloper App tokenで再取得したcurrent PR HEADがともに有効な40文字の小文字SHAで一致する場合だけ、current HEADを `paused_head` とする `developer_execution_failed`（`failed_action=fix`）を記録する。その後のHEAD差異（同runのpush後の失敗を含む）・欠落・形式不正・取得不能は `state_inconsistent` とし、再開可能なfix failureに分類しない。common helperがclosing IssueとPRへ `human-review-required` を同期し、GitHub pause成立後に日本語Discord通知をbest-effortで試行する。通知失敗でも停止を維持し、自動retry、rollback、branch deleteは行わない。

異常終了後にCodex follow-upを自動retryしない。現行workflowには、停止状態を維持したまま同じClaude指摘に対するCodex follow-upだけを安全に再実行する専用入口はない。

人間はActions結果とPR差分を確認し、必要な修正が残る場合は手動で修正する。`Run Codex follow-up` 側の異常終了ではPRはDraftのままなので、修正と確認が完了した後、「人間エスカレーション」節の停止解除契約に従い、人間または明示的なtrusted経路がReady for reviewへ戻して再レビューを要求する。Draft復帰job自体が異常終了してopen PRが非Draftのまま停止している場合は、PR側の停止ラベルを解除する前に人間がPRをDraftへ戻し、準備完了後にReady化する。

停止ラベルの解除順序、open PRでの再レビュー起動条件、merged/closed PRのstale label cleanupは「人間エスカレーション」節を正本とする。follow-up復旧では、その契約に従って停止解除後のDraft/Ready状態を整える。

Codex follow-up専用retry入口が将来必要になった場合は、この復旧手順へ例外を追加せず、別Issueで設計・実装する。

#### timeout後の作業分割判断

timeoutや異常終了が発生したという事実だけで、作業量が大きすぎたとは判断しない。

runner-lossやGitHub Actions基盤側の異常は、小さい変更でも発生し得るため、失敗原因がrunner-lossまたはinfrastructure failureと判断できる場合は、それだけを理由にIssueを分割しない。

一方、runnerとログが正常に動作したままCodex実行が当該runのjob-level timeout値近くまで継続してtimeoutした場合、または同じscopeで長時間化を繰り返した場合は、再実行前に作業量を見直す。

分割する場合は、各IssueまたはPRが独立して実装、検証、レビューでき、安全性・正確性・要求整合性を単独で確認できる単位にする。

過去にAI Developerの長時間化を避けるため分割した作業は、新たな根拠なく再統合して大きなAI Developer jobへ戻さない。

Webhook登録、通知確認、main反映後のEnd-to-End確認はIssue #46で追跡する。

## Bootstrapと復旧

`pull_request` workflowはdefault branchにworkflowファイルが存在してから通常運用を開始する。初回導入PRは管理者が内容を確認し、reviewer Appによる一時レビューまたは手動レビューを経てマージする。通常の自動マージは `ai/issue-*` だけに限定されるため、bootstrap用ブランチは自動マージ対象外である。

`/ai resume develop` consumer自身の導入PRが `requirements_change` のactive pauseに入ると、consumer未導入のmainからは正式resumeできない。#483 / PR #484で起きたこのbootstrap deadlockでは、`human-review-required` だけを手動解除してtrusted active pause recordを孤児化させず、pauseした元Issue / PRをopenのまま維持する。Code Owner自身がbootstrap PR authorだとself-approvalではRulesetのCode Owner承認を満たせないため、Code Owner保護やRulesetを弱めない。

復旧は、停止した導入PRの実装差分を保ったまま、別のbootstrap Issueのcanonical `ai/issue-N` branchを通常のIssue起点Developer経路で更新し、Developer App authorのDraft PRとして先行反映する。#485ではsource commit `cb72d3606549ab9ec5287ff3b399425df08150b6` 由来の実装差分を変更せず、追加差分を本運用文書だけに限定する。source commit由来の実装差分、追加した運用文書差分、closing Issueと後継Issueのtraceabilityを確認し、そのPRで通常のAI Workflow Regression / PR Traceability / Claude Reviewと独立した人間Code Owner reviewを受けてから、protected-pathの手動mergeでmainへ反映する。既存reviewを新PRの承認として流用しない。main反映後に元Issue / PRのactive pauseを正式な `/ai resume develop` でconsumeして元のlifecycleを再開する。#485の後継 #483の完了条件と実施順序はclosing Issue本文の `Scope-out impact and follow-up` を正本とする。

Actionsが失敗した場合は、失敗step、Appのインストール先・権限、Repository secret/variable名、OIDC federation ruleの対象を確認する。モデルpreflightまたはモデル実行stepで失敗した場合は `CLAUDE_MODEL` / `CLAUDE_MODEL_STANDARD` / `CODEX_MODEL` の設定有無と、指定モデルが現在のAnthropic workspaceまたはOpenAI API projectで利用可能かを確認する。secret値とRepository variable値はログへ出さない。モデルIDについては前述のとおりIssue/PRの変更履歴・検証証跡へ記録してよいが、ログへは出さない。

`.github/scripts/**` を変更した場合、または認可・信頼境界・closing Issue・merge gateのロジックを変更した場合は次を実行し、fixtureを確認する。

```bash
bash .github/scripts/test-ai-workflow.sh
bash .github/scripts/test-claude-review-workflow.sh
bash .github/scripts/test-ai-developer-workflow.sh
```

`.github/workflows/**` を変更したが上記fixtureの対象外と判断した場合は、その理由をPR本文へ記録する。

#763のfull経路は、selectorのfull決定またはselection失敗によるfull fallbackの後、fixture実行前に検証済み `BASE_SHA` の `plan-ai-workflow-shards.py` blobをscratchへ取得して1回だけ実行する。独立列挙したcurrent full inventoryをNUL-framed inputとし、callerがclosed schema / duplicate JSON key拒否 / exact 2-shard coverageを再検証する。取得・実行・出力検証の失敗はRegression failureとなり、single runner実行へfallbackしない。base SHAが不正またはcommitを確認できない場合もplannerへ進めずFAILとする。機械契約は `ai-workflow-regression.yml`、実run blockの検証は `test-ai-workflow.sh` を正本とする。selected経路はplannerを取得・実行しない。planner単体の成功は実行authorityではない。#769では下記consumerがplanを再検証した後だけfullのshard実行集合へ使用し、selectedは既存 `Fixtures` job / `fixtures.nul` / sequential loop / 全結果集計後の失敗伝播を維持する。planner fixtureは `RUNTIME_HINTS` keysがcurrent inventoryに含まれることと、許可済みcaller以外からの接続拒否を確認する。job outputは下記#767でpreparedした契約を再利用する。serialized worker / output consumerは#769で導入し、#698で下記2-workerのparallel executionを有効化する。planner検証成功だけからexecution成功を主張しない。Product POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの影響はない。

#767でpreparedした既存 `Fixtures` jobの検証済みselection / full shard plan由来のjob output `execution_plan_b64` を、#769のhandoffにも使用する。機械正本は `ai-workflow-regression.yml`、selected/fullのrecord整合・決定性・失敗伝播の検証は `test-ai-workflow.sh` とする。canonical JSONはsorted keys / ASCII escape / 空白なしでstrict UTF-8 encodeし、標準Base64の単一ASCII行として `GITHUB_OUTPUT` へ書く。Base64 valueは256 KiB以内（keyと末尾LFを除く）とし、超過・不正state・生成／書込み失敗はfixture実行前にfail-closed停止する。非UTF-8 / surrogate fixture pathは独立inventory検証で `invalid_fixture_type` として拒否する。`base_sha` は検証済みBASE_SHA、`head_sha` は再検証したcurrent HEADとし、event SHAのselection fallback時も未検証値を渡さない。fullのshard ids / pathsはcanonical順へ揃える。outputだけではexecution authorityにならず、下記workerがcurrent HEAD / inventory / schema / coverageを再検証する。selectedのexecution listはoutputから読み戻さず、producer内のsequential loop / failure aggregationを維持する。Failure Evidence Collector本体、Secrets、permissions、repository write、Product識別子・traceabilityは変更しない。output内容はJob Summaryへ展開しない。


#769で導入したfullのfixture execution ownershipを持つexact `Fixture shard 1` / `Fixture shard 2` を、#698で2-runner parallelにする。`Fixtures` はfullではvalidated planのhandoffまでで終了し、fixtureを実行しない。bounded `routing_mode` outputはvalidated stateから作る起動用discriminatorであり、execution authorityではない。workerはproducer successを必須確認し、256 KiB以内のstrict standard Base64 / strict UTF-8 / duplicate-key rejecting JSON / exact schema・version・lowerhex SHA・closed reason / suites / counts / canonical pathsを再検証する。current checkout HEADとplanのhead、独立full inventoryとfixtures / counts、exact ids 1,2のnonempty sorted unique shard、disjoint unionとfull inventoryの一致を照合し、自身のfixed idのlistだけをsequential実行する。各fixture直前にregular file / non-symlinkを再確認し、failure後も同shardの残りを実行して最後にjob failureへ伝播する。両workerのneedsはproducer `fixtures` だけとし、producer success / full routingの通常conditionで起動する。worker側に `always()` を置かず、supersede cancellation後の新規worker開始を避ける。両workerは互いのsuccessを起動条件とせず、一方のfailureで他方のcoverageを失わない。各runner内はsequential実行を維持し、fixture間の共有host / global stateを受け渡さない。matrix / 3 shard以上 / retryは導入しない。

`Regression Result` は全3 jobをneedsとし、`always()` でcheckout / external callなしのbounded validationだけを行う。producer非successではpre-published outputを読まずterminalを第二failureにせず、元producerのfailure / cancellation / timeout ownershipを維持する。producer success時は同じclosed planを再decode / validateし、routingとmodeの一致を確認する。selectedは両workerがskipped、fullは両workerがsuccessの場合だけ成功とし、failure / cancellation / skipped等をsuccessへ昇格しない。terminalのfailure stepはexact `Normalize shard results`。#751のcollector exact topology / legacy single-failure契約を維持し、collector本体・permissions・triggerは変更しない。#769のRegression #509ではworker failure後の他worker coverageとterminal failure、Failure Evidence Collector #61 attempt 2ではcomplete packet / terminal bindingをactual proof済みであり、#698でも同じ契約を再利用する。

#698の検証は既存 `test-ai-workflow.sh` でjob names / producer-only needs / parallel topology / worker通常condition、selected既存set・order・failure、full producer実行0件、workerのexactly-once coverage・failure後継続、producer非success / output corruption / stale head / inventory drift / schema mismatchの拒否、routing不一致とterminal result正規化を固定する。既存collector synthetic fixtureも回帰する。current PR headのnatural full runで両workerの開始・終了時刻のoverlap、current full inventoryのexactly-once coverage、terminal Successを確認する。run ID / attempt / HEAD、各job duration、run wall-clock、全job durationの合計（runner computeの観測値）を記録し、#769のRegression #510（serialized wall-clock約638秒、producer約5秒 / shard 1約282秒 / shard 2約343秒 / terminal約2秒）と比較する。runner schedulingの影響とcompute増のトレードオフを親 #695へ記録する。natural selected runのwall-clock / compute overheadも確認し、ローカルsynthetic成功でactual overlapや時間短縮を代替しない。計測目的のartificial failure / paid AI runは追加せず、既存failure / cancellation fixtureと#509のactual failure evidenceを再利用する。Product POL / BR / REQ / AC / TC / CON / OOSとtraceabilityへの影響はない。

AI Workflow Regressionの起動対象path一覧は `.github/workflows/ai-workflow-regression.yml` の `on.pull_request.paths` を唯一の機械正本とし、この運用文書では完全な一覧を複製しない。正本の対象pathに一致するPRでは、独立した `AI Workflow Regression` が現在PR headのfixtureをselectedでは `Fixtures`、fullでは上記parallel workersで実行し、`Regression Result` を含む結果をGitHub Actionsへ残す。known local changeはtrusted event base SHA版のselectorが返すselected fixturesとcommon guardを実行する。unknown / shared boundaryで全件が必要な変更、selector失敗・出力不正、base object / selector取得不能、SHA不一致、merge-base取得不能・形式不正、diff失敗・予期しない空diffではselectionをfullへ戻し、上記planner gateへ進む。`BASE_SHA`不正・base commit確認不能はそのgateでFAILし、full fixture executionへfallbackしない。selector自身・selector fixture・regression workflowの変更もfullとする。fullではcallerがPR head上の全 `.github/scripts/test-*.sh` を再列挙し、両modeとも0件・missing・symlink・不正file型はFAILにする。producer checkoutはexact event head SHA、`persist-credentials: false`、`fetch-depth: 0`とし、shellへtokenを渡さずbase policyを取得する。changed pathsは検証済みbase/head SHAからread-onlyに `git merge-base BASE HEAD` を取得し、`git diff --no-renames --name-only -z MERGE_BASE HEAD` でPR変更集合を3-dot相当として取得する。base-only変更を混ぜず、rename両pathをNUL-safeに観測する。trusted base selectorはparse後に正本と同期したtrigger domainだけを評価し、対象外pathはselectionへ影響させず、対象内unknownはfull、filter後0件も `full / empty_selection` とする。workerもexact event head SHA / `persist-credentials: false`でcheckoutする。read-only / secretless、producer / worker各10分timeout（延長なし）、terminal 1分timeout、PR単位concurrency、retryなしを維持し、fixture failureは全実行結果の集計後にjob failureへ伝播する。Job Summaryにはmode / fixed reason / selected count（実行集合件数）/ full count / suites / 各jobのPASS・FAILだけを記録し、full producerのPASSはhandoff validation成功を意味する。fixture名はworker / selected producerのgroup logで確認する。自然なPR runで件数とActionsのwall-clockを確認する。初回導入PRはBootstrap制約に従い、このworkflowがdefault branchへ反映された後の対象PRから通常のCI証跡となる。これは専用fixtureと横断fixtureの両方を実行するrepository側の独立証跡であり、Codex自身の関連validation実行・結果報告責務を置き換えない。Codex側でvalidationを実行できない場合は理由を記録し、CI結果を確認する。対象fixtureは外部サービスへ実アクセスせず、repository内で完結する。event、実行順、timeout、concurrencyなどの詳細も同workflowを正本とする。`test-ai-workflow.sh` は正本workflowの実run blockをsynthetic fixtureで実行し、selected/fullの探索・全選択fixture実行・失敗伝播・fallbackと実行行改変の検出、およびworkflowの `on.pull_request.paths` とselectorの `TRIGGER_PATTERNS` のexact集合同期・未対応patternの拒否を含むtrigger contractを検証するfixtureであり、trigger集合全体の独立した正本ではない。`docs/00_requirements/01_Introduction.md` と `docs/diagrams/README.md` は内容をfixtureで読む対象ではないが、`test-ai-developer-workflow.sh` がAGENTS固定参照のfile existenceを機械contractとして直接assertするためexact trigger対象とする。`docs/30_operations/ai-development-workflow.md` は同fixtureが停止・Draft復帰等の運用安全契約とscope-out参照先のcanonical headingを実ファイルから直接assertするためexact trigger対象とする。その他のproduct / requirements / diagrams文書はAI workflow fixtureの直接依存ではないためtriggerへ広げない。Claude review / mergeのprotected-path classifierはCode Owner保護のため `CODEOWNERS` やその他の `.github/**` もhigh-riskに含めるが、AI Workflow RegressionはAI instruction / runtime fixtureが直接依存するsubsetだけを起動対象とし、通常のIssue templateやその他のrepository governance文書の変更だけでは起動しない。この差は意図的であり、protected-path判定そのものを弱めるものではない。PR本文で上記コードブロックの手動fixtureを対象外と記録しても、このselected/fullの自動実行は免除されない。
