# Diagrams

設計図は Diagram as Code として PlantUML で管理する。

## 正本と生成物

- `plantuml/` — **正本**。編集対象となる `.puml` ファイルを置く。
- `rendered/` — **閲覧用生成物**。対応する SVG を置く。SVG は原則として直接編集しない。

GitHub 上の `.puml` を設計図の正本とし、SVG はレビュー・Markdown 埋め込み・チャット上での確認に使用する。

## C4 Model

C4 図では PlantUML 同梱の C4 Standard Library を使用する。外部 URL への実行時依存を避けるため、原則として以下の形式を使用する。

```plantuml
!include <C4/C4_Context>
!include <C4/C4_Container>
!include <C4/C4_Component>
```

要求定義では C4 Level 1、基本設計では Level 2、詳細設計では Level 3 を扱う。

## レンダリング

`.puml` は全文レビューする唯一の正本。Rendererはsame-repo PRのopened / synchronize / reopened / ready_for_reviewで、PUMLまたはWorkflow変更時にeventのexact HEADをcheckoutして照合する。手動workflow_dispatchはmainのrun確定SHAだけを対象にする。contents: read、checkout credential非保存とし、repositoryへadd / commit / pushしない。Java 21・Graphviz・checksum検証済PlantUML v1.2026.6と同梱C4 includeで全PUMLを毎回生成し、失敗・空出力は停止する。

Actionsの該当Render runから単一Artifact `plantuml-<source SHA>` をダウンロード・展開し、SVGをブラウザで開く。`renderer-info.txt`でsource SHA、run、version/checksumを確認する。保存期限は7日。期限切れはmainで手動再生成する。Artifact内SVGはGitHub Markdown相対画像として表示できない。チャットでの取得・表示は未実証。

Ready にする前に、Render workflow の成功とcurrent head一致、Artifact全件・C4/Sequence表示、raw diffの400,000-byte gate適合を確認する。stale headのArtifactや成功はcurrent headの証拠に使わない。Ready 後に各 check / review の対象 head と結果を確認し、Product CI / AI Workflow Regression / PR Traceability / Claude Reviewと人間Code Owner承認を維持する。ローカルfixtureは正式Actions成功を代替しない。

#1134 / PR1ではA群4 SVGの追跡を解除し、C4のB群3 SVGはPR2まで暫定保持する（更新しない）。生成SVGはignoreし再追跡しない。旧 #850 provenance縮約は[既存契約](../30_operations/ai-development-workflow.md#claude-reviewの生成svg差分)を維持し、PR2で退役する。削除差分を隠さずraw diffを計測する。

移行時は旧Rendererのpush runとwriterが稼働していないことを提出直前に再確認する。旧branch上のpushは旧Workflowを実行し得るため、旧runが残る間は提出・Readyに進めない。workflow停止等が必要なら人間Goを得る。新Rendererはpush triggerを持たない。

## 命名例

- `plantuml/c4-context.puml`
- `plantuml/c4-container.puml`
- `plantuml/booking-sequence.puml`
- `rendered/c4-context.svg`
- `rendered/c4-container.svg`
- `rendered/booking-sequence.svg`
