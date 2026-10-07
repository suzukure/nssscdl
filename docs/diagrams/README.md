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

`.puml` は通常の PR 差分として Claude / 人間がレビューする。PR ブランチへの push では `.github/workflows/render-plantuml.yml` は起動せず、生成 SVG を PR ブランチへ自動コミットしない。

変更を main へ merge した後、同 Workflow が main push の `plantuml/**/*.puml` の変更を検出し、SVG を `rendered/` へ生成する。生成物に差分がある場合だけ main へコミットし、最新なら何もしない。Workflow 自身の変更も main push で生成対象となる。

`workflow_dispatch` による手動生成も main 限定とし、main 以外を指定した実行は job 条件でスキップする。生成中に main が進んで push が競合した場合は失敗とし、force push や自動 retry は行わない。PR レビュー時の SVG は merge 前の生成物であり、変更内容の確認には正本の `.puml` を用いる。

PlantUML のバージョンは Workflow 内で固定し、更新は意図的に行う。

## 命名例

- `plantuml/c4-context.puml`
- `plantuml/c4-container.puml`
- `plantuml/booking-sequence.puml`
- `rendered/c4-context.svg`
- `rendered/c4-container.svg`
- `rendered/booking-sequence.svg`
