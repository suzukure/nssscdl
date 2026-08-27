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

`.github/workflows/render-plantuml.yml` が `plantuml/**/*.puml` の変更を検出し、SVG を `rendered/` へ生成して同じブランチへコミットする。

PlantUML のバージョンは Workflow 内で固定し、更新は意図的に行う。

## 命名例

- `plantuml/c4-context.puml`
- `plantuml/c4-container.puml`
- `plantuml/booking-sequence.puml`
- `rendered/c4-context.svg`
- `rendered/c4-container.svg`
- `rendered/booking-sequence.svg`
