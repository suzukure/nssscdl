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

`.puml` は通常の text diff として Claude / 人間がレビューする。`rendered/**/*.svg`（直下を含む）は root の `.gitattributes` で Git 標準の `-diff` を指定し、ローカル Git では binary diff として扱う。ただし #848 / PR #849 で、GitHub raw PR diff はこの指定があっても SVG XML を text 展開することを確認した。#850 の review context では、[生成SVG差分の縮約契約](../30_operations/ai-development-workflow.md#claude-reviewの生成svg差分)に従って provenance を証明できた生成物だけを要約する。attribute を review trust の根拠にはせず、正本と renderer workflow の差分は全文保持する。

`.github/workflows/render-plantuml.yml` は非 main ブランチへの push で `plantuml/**/*.puml`、Workflow 自身、`.gitattributes` の変更を検出し、SVG を `rendered/` へ全件再生成する。差分がある場合だけ checkout と同じブランチへコミットし、最新なら何もしない。生成コミットに `[skip ci]` は付けず、SVG だけの変更は trigger path 外なので renderer の self-loop を起こさない。正本と生成物を一つの通常 PR で merge し、main へ直接書き込まない。

`workflow_dispatch` による手動生成も非 main ブランチ限定とし、main / tag 等は job 条件でスキップする。checkout が detached HEAD または対象ブランチと不一致なら書込み前に失敗する。生成中にブランチが進んで push が競合した場合は失敗とし、force push や自動 retry は行わない。

checkout / push には ephemeral な `GITHUB_TOKEN` だけを、Workflow の `contents: write` 権限内で使用する。Render workflow は `DEV_APP_PRIVATE_KEY` / `DEV_APP_CLIENT_ID` / Developer App token を使用しない。App 権限・Ruleset・Secrets / Variables は変更しない。

`GITHUB_TOKEN` による生成 push は後続 workflow の trigger を期待しない。人間は PlantUML / renderer contract 変更 PR を Ready にする前に、Render workflow の成功、生成コミット反映済みの current head、取得した raw PR diff と review context の内容・サイズを確認する。Render failure 中は Ready / merge しない。3 SVG 変更を含む場合も、provenance 成立時には path・生成commit SHA・変更ありの要約が残り、正本と renderer の差分が全文保持され、縮約後の review diff が Claude Review の 400,000-byte 上限以内であることを確認する。provenance が証明できなければ raw diff を保持し、上限超過時は停止する。

生成コミットが current head になった後の人間の `ready_for_review` event を、同 head の Product CI / AI Workflow Regression / PR Traceability / Claude Review の明示的な開始点とする。Ready 後に各 check / review の対象 head と結果を確認してから、既存の merge 条件に従う。ローカル fixture は GitHub 上の表示・diff 取得・Ready event による current-head checks 起動を実証するものではない。#845 の移行時に残った SVG 同期と、#850 の main 反映後の review context 縮約 / Ready lifecycle の自然実証は、latest main から再実施する #848 で確認する。成功後に stale SVG を通常 PR lifecycle で同期し、親 #562 へ結果を返す。

PlantUML のバージョンは Workflow 内で固定し、更新は意図的に行う。

## 命名例

- `plantuml/c4-context.puml`
- `plantuml/c4-container.puml`
- `plantuml/booking-sequence.puml`
- `rendered/c4-context.svg`
- `rendered/c4-container.svg`
- `rendered/booking-sequence.svg`
