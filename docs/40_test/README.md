# テスト仕様

本ディレクトリは、`docs/00_requirements/` の要求ベースラインに対応する要求ベーステスト仕様を管理する。

## 現行ベースライン

- 要求仕様: v1.7
- 対象REQ: 63
- 対象AC: 198
- 機能TC: 107
- 非機能TC: 41
- 合計TC: 148
- AC Coverage: 100%
- AC未対応: 0

v1.5までのベース仕様に対し、v1.6 / v1.7の変更は `02b_RequirementsV1.6V1.7TestSpecification.md` および `04a_RequirementsTestTraceability_v1.6_v1.7.md` で追補する。

## 適用方針

- 文書構成は **ISO/IEC/IEEE 29119-3:2021 (Test documentation)** の考え方を、GitHubでレビューしやすいMarkdownへ簡略化して適用する。
- IEEE 829 は廃止済みのため、新規成果物の基準には使用しない。
- 本仕様は主に **システムテスト／受入テスト** のブラックボックス観点を定義する。
- 要求の正本は `docs/00_requirements/` とし、本テスト仕様は要求を再定義しない。
- トレーサビリティは既存の `POL → BR → REQ → AC` に `TC` を追加し、`POL → BR → REQ → AC → TC` を追跡可能にする。
- POL/BRの対応は `docs/00_requirements/07_TraceabilityMatrix.md` を正本とし、本ディレクトリでは AC → TC の対応を追加管理する。

## 文書一覧

- `01_TestPlan.md` — テスト計画、範囲、環境、データ、開始／終了基準、優先度
- `02_FunctionalTestSpecification.md` — 機能要求に対するテストケース仕様（ベース）
- `02a_ReservationOwnershipTestSpecification.md` — 要求v1.5で追加された生徒本人予約の所有者同一性テスト
- `02b_RequirementsV1.6V1.7TestSpecification.md` — 要求v1.6/v1.7で追加された予約区分影響事前表示・Schedule競合説明性テスト
- `03_NonFunctionalTestSpecification.md` — 非機能要求に対するテストケース仕様
- `04_RequirementsTestTraceability.md` — v1.5までのREQ / AC とテストケースのベース対応、CON / OOS の確認方法
- `04a_RequirementsTestTraceability_v1.6_v1.7.md` — v1.6/v1.7の追加AC・回帰拡張と現行Coverage Summary

## ID規約

- 機能テスト: `TC-F-<REQ番号>-<連番>` 例: `TC-F-003-01`
- 非機能テスト: `TC-NF-<REQ番号>-<連番>` 例: `TC-NF-911-01`
- Scope Guard / Review: `TC-SG-<CON|OOS>-<番号>`

## 更新ルール

1. 要求変更時は影響する POL / BR / REQ / AC / CON / OOS を確認する。
2. ACの追加・変更・削除時は `04_RequirementsTestTraceability.md` または現行要求への追補Traceabilityを同一変更で更新し、READMEのCurrent Coverageを一致させる。
3. 実装固有のAPI Path、画面部品名、DB物理名は詳細設計・自動テスト側へ寄せ、本要求ベーステスト仕様では期待する業務結果を正とする。
4. 未決設計に依存するテスト手順は、期待結果を変えずに詳細化する。
5. 追補を追加した場合は、次回の大規模改訂時にベース仕様へ統合するかを確認し、複数文書間のTC ID重複・Coverage Driftを検査する。
