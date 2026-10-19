# 一括予約 要求－テスト トレーサビリティ追補

## 1. 位置づけ

本書は、`REQ-008 / AC-008-001〜010` と Issue #76 で確定した一括予約機能テストケースとの **AC → TC** 対応を管理する追補である。

要求側の正本トレーサビリティは `docs/00_requirements/07_TraceabilityMatrix.md` とする。`04_RequirementsTestTraceability.md`、`04a_RequirementsTestTraceability_v1.6_v1.7.md`、および本書を要求側Matrixと結合することで、対応済み範囲の `POL → BR → REQ → AC → TC` を追跡する。

本書はテストケース本文、要求仕様、基本設計、READMEおよびTestPlanを変更・再定義しない。各TCの手順および期待結果は `02c_BulkReservationTestSpecification.md` を正とする。

## 2. Current Coverage Summary

| 指標 | 値 |
|---|---:|
| 要求ベースライン | v1.21 |
| 対象REQ | 64（機能44 + 非機能20） |
| 対象AC | 236 |
| 対応済AC | 233 |
| AC未対応 | 3 |
| 機能TC | 137 |
| 非機能TC | 42 |
| 合計TC | 179 |
| AC Coverage | 98.7% (233/236) |

Coverageは、要求正本 `docs/00_requirements/04_FunctionalRequirements.md` と `05_NonFunctionalRequirements.md` のAC定義236件を母数とする。全追跡表（`04_RequirementsTestTraceability.md`、`04a_RequirementsTestTraceability_v1.6_v1.7.md`、本書）のAC行を合算し、全主・補足テスト仕様（`02_FunctionalTestSpecification.md`、`02a_ReservationOwnershipTestSpecification.md`、`02b_RequirementsV1.6V1.7TestSpecification.md`、`02c_BulkReservationTestSpecification.md`、`03_NonFunctionalTestSpecification.md`）に定義されたTCへの有効な対応を持つACを、ID単位で重複排除した233件を分子とする。`233 / 236 × 100 = 98.7%`（小数第1位丸め）であり、テスト実行成功率を表さない。追補中の履歴Summaryは現行集計に加算しない。

機能TCは主仕様124件＋所有者同一性追補2件＋v1.6/v1.7追補3件＋一括予約追補8件の137件、非機能TCは42件で、定義IDの重複はない。合計179件はAC対応TCの定義数であり、CON/OOSのScope Guardは含めない。Issue #1082の6 TC追加に続き、Issue #1084で月間回数除外の解除・設定に固有の2 TCを追加し、AC-308-002/003を補完した。Issue #1088で欠席設定・解除の確定前区分影響提示TC-F-315-04を1件追加し、AC-315-005を補完した。

Issue #1092では既存TC-F-004-01の拡張でAC-004-006を補完し、TC数は変更しない。未定義参照は0件である。

残る未対応3 ACはIssue #1092の対象外とし、親Issue #551で管理する。

- `AC-301-010`
- `AC-913-005`, `AC-913-006`

## 3. REQ-008 / AC → Test Case

### REQ-008 生徒一括予約

| AC | Test Case |
|---|---|
| AC-008-001 | `TC-F-008-01` |
| AC-008-002 | `TC-F-008-02` |
| AC-008-003 | `TC-F-008-02` |
| AC-008-004 | `TC-F-008-03` |
| AC-008-005 | `TC-F-008-04`, `TC-F-008-05` |
| AC-008-006 | `TC-F-008-04`, `TC-F-008-05` |
| AC-008-007 | `TC-F-008-04` |
| AC-008-008 | `TC-F-008-06` |
| AC-008-009 | `TC-F-008-07` |
| AC-008-010 | `TC-F-008-08` |

## 4. 要求階層および回帰関係

要求側Matrixにおける `REQ-008` の上位・関連識別子は次のとおりである。

- POL: `POL-004`, `POL-005`, `POL-008`, `POL-009`, `POL-011`, `POL-014`
- BR: `BR-050`, `BR-051`, `BR-052`, `BR-055`, `BR-056`, `BR-057`, `BR-058`, `BR-059`, `BR-067`, `BR-068`, `BR-069`, `BR-133`
- REQ / AC: `REQ-008 / AC-008-001〜010`
- CON / OOS: `REQ-008` に直接対応する追加・変更はない。既存Scope Guardは `04_RequirementsTestTraceability.md` を継続して参照する。

一括予約は単一予約を置き換えず、区分変更および競合整合性と同じ業務境界に影響する。このため、`02c_BulkReservationTestSpecification.md` の回帰セットに従い、少なくとも次を関連回帰対象とする。

| 観点 | 回帰Test Case |
|---|---|
| 単一予約、additional表示、開始時刻境界、Confirm時競合再検証 | `TC-F-003-01`, `TC-F-003-02`, `TC-F-003-04`, `TC-F-003-05` |
| 単一予約の所有者同一性、クライアント入力改ざん防止 | `TC-F-003-06`, `TC-F-003-07` |
| 既存未開始Reservationへの区分影響表示、Stale Preview | `TC-F-003-08`, `TC-F-003-09` |
| 確定後の区分変更通知・画面表示 | `TC-F-104-01`, `TC-F-104-02` |
| 競合整合性 | `TC-NF-911-01`, `TC-NF-911-02` |
| 利用者向けエラー表現、内部情報非露出 | `TC-NF-914-03`, `TC-NF-914-04` |

`AC-008-009` は一括確定前の選択対象外Reservationへの区分影響表示を、`TC-F-104-01` および `TC-F-104-02` は確定後の区分変更通知・画面表示をそれぞれ確認する。両者を同一の合否責務として扱わない。

## 5. 整合性確認

- `AC-008-001〜010` の全件は、Issue #76で確定した `TC-F-008-01〜08` のみへ対応付けた。
- `TC-F-008-04` および `TC-F-008-05` は、ともにConfirm時の再検証と全体未適用を検証するため、`AC-008-005` および `AC-008-006` の両方に対応付ける。
- `AC-008-007` のReject時の安全な説明と個人情報・内部情報の非露出は `TC-F-008-04` を正とし、上記の `TC-NF-914-03` および `TC-NF-914-04` を回帰対象とする。
- API Wire形式、操作識別子の具体Field、HTTP表現およびConflict分類は、`AC-008-010` と `TC-F-008-08` のとおり詳細設計へ委ねる。
