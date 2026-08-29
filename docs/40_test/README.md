# テスト仕様

本ディレクトリは、`docs/00_requirements/` の要求ベースラインに対応する要求ベーステスト仕様を管理する。

## 適用方針

- 文書構成は **ISO/IEC/IEEE 29119-3:2021 (Test documentation)** の考え方を、GitHubでレビューしやすいMarkdownへ簡略化して適用する。
- IEEE 829 は廃止済みのため、新規成果物の基準には使用しない。
- 本仕様は主に **システムテスト／受入テスト** のブラックボックス観点を定義する。
- 要求の正本は `docs/00_requirements/` とし、本テスト仕様は要求を再定義しない。
- トレーサビリティは既存の `POL → BR → REQ → AC` に `TC` を追加し、`POL → BR → REQ → AC → TC` を追跡可能にする。
- POL/BRの対応は `docs/00_requirements/07_TraceabilityMatrix.md` を正本とし、本ディレクトリでは AC → TC の対応を追加管理する。

## 文書一覧

- `01_TestPlan.md` — テスト計画、範囲、環境、データ、開始／終了基準、優先度
- `02_FunctionalTestSpecification.md` — 機能要求に対するテストケース仕様
- `02a_ReservationOwnershipTestSpecification.md` — 要求v1.5で追加された生徒本人予約の所有者同一性テスト
- `03_NonFunctionalTestSpecification.md` — 非機能要求に対するテストケース仕様
- `04_RequirementsTestTraceability.md` — REQ / AC とテストケースの対応、CON / OOS の確認方法

## ID規約

- 機能テスト: `TC-F-<REQ番号>-<連番>` 例: `TC-F-003-01`
- 非機能テスト: `TC-NF-<REQ番号>-<連番>` 例: `TC-NF-911-01`
- Scope Guard / Review: `TC-SG-<CON|OOS>-<番号>`

## 更新ルール

1. 要求変更時は影響する POL / BR / REQ / AC / CON / OOS を確認する。
2. ACの追加・変更・削除時は `04_RequirementsTestTraceability.md` を同一変更で更新する。
3. 実装固有のAPI Path、画面部品名、DB物理名は詳細設計・自動テスト側へ寄せ、本要求ベーステスト仕様では期待する業務結果を正とする。
4. 未決設計に依存するテスト手順は、期待結果を変えずに詳細化する。
