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

`.puml` は通常の text diff として Claude / 人間がレビューする。`rendered/**/*.svg`（直下を含む）は root の `.gitattributes` で Git 標準の `-diff` を指定し、XML 本文を展開せず binary diff として扱う。filter / textconv や review-context の SVG 例外は使用しない。

`.github/workflows/render-plantuml.yml` は非 main ブランチへの push で `plantuml/**/*.puml`、Workflow 自身、`.gitattributes` の変更を検出し、SVG を `rendered/` へ全件再生成する。差分がある場合だけ checkout と同じブランチへコミットし、最新なら何もしない。生成コミットに `[skip ci]` は付けず、SVG だけの変更は trigger path 外なので renderer の self-loop を起こさない。正本と生成物を一つの通常 PR で merge し、main へ直接書き込まない。

`workflow_dispatch` による手動生成も非 main ブランチ限定とし、main / tag 等は job 条件でスキップする。checkout が detached HEAD または対象ブランチと不一致なら書込み前に失敗する。生成中にブランチが進んで push が競合した場合は失敗とし、force push や自動 retry は行わない。

checkout / push には既存 developer App の token 発行方式を再利用し、発行 token の権限は Contents write に限定する。既定の `GITHUB_TOKEN` による生成 push へ依存せず、生成後の PR 検証につなげる。App 権限・Ruleset・Secrets / Variables は変更しない。

人間は PlantUML / renderer contract 変更 PR を Ready にする前に、Render workflow の成功、生成コミット反映済みの current head、同 head の AI Workflow Regression / Product CI / Traceability 等を確認する。Render failure 中は Ready / merge しない。実 PR diff で SVG XML 本文が展開されず、3 SVG 変更を含む場合も Claude Review の 400,000-byte 上限を十分下回ることを確認する。GitHub の実 PR diff が `-diff` を反映しない場合は停止し、review-context の例外追加へ拡張しない。ローカル fixture は GitHub 上の表示・diff 取得・生成 push 後の checks 起動を実証するものではない。

PlantUML のバージョンは Workflow 内で固定し、更新は意図的に行う。

## 命名例

- `plantuml/c4-context.puml`
- `plantuml/c4-container.puml`
- `plantuml/booking-sequence.puml`
- `rendered/c4-context.svg`
- `rendered/c4-container.svg`
- `rendered/booking-sequence.svg`
