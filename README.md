# nssscdl

Net Shogi School向けのスケジュールシステムです。

このリポジトリを、プロジェクトの要求仕様、設計文書、ソースコード、データベースマイグレーション、テスト、運用文書の正本とします。

## リポジトリ構成

- `docs/00_requirements/` — 要求仕様ベースライン
- `docs/10_basic_design/` — 基本設計 / C4 Level 2
- `docs/20_detailed_design/` — 詳細設計 / C4 Level 3
- `docs/30_operations/` — 運用・復旧手順
- `docs/adr/` — Architecture Decision Record（ADR）
- `docs/diagrams/` — 共通図表
- `src/` — アプリケーションソースコード
- `migrations/` — データベースマイグレーション
- `tests/` — 自動テスト
- `scripts/` — 保守・検証スクリプト
- `config/` — プロジェクト設定
- `.github/` — CI/CDおよびGitHub関連設定

## 文書のライフサイクル

ChatGPTやローカルワークスペースは作業領域として利用できるが、このリポジトリへCommitされた内容をプロジェクトの正式な記録とする。

要求仕様のベースラインは `docs/00_requirements/` に格納する。
