# 要求－テスト トレーサビリティ

## 1. 方針

要求側の正本トレーサビリティは `docs/00_requirements/07_TraceabilityMatrix.md` とする。
本書では **AC → TC** を追加し、両文書を結合することで次を追跡できる。

`POL → BR → REQ → AC → TC`

POL/BRを本書へ重複転記しないことで、要求変更時の二重管理によるDriftを避ける。

## 2. Coverage Summary

| 指標 | 値 |
|---|---:|
| 対象REQ | 63 |
| 対象AC | 196 |
| 機能TC | 104 |
| 非機能TC | 41 |
| AC Coverage | 100% |
| AC未対応 | 0 |

## 3. REQ / AC → Test Case

### REQ-001 初期画面・スケジュール確認
| AC | Test Case |
|---|---|
| AC-001-001 | `TC-F-001-01` |
| AC-001-002 | `TC-F-001-02` |
| AC-001-003 | `TC-F-001-02` |
| AC-001-004 | `TC-F-001-01` |

### REQ-002 予約可能枠表示
| AC | Test Case |
|---|---|
| AC-002-001 | `TC-F-002-01` |
| AC-002-002 | `TC-F-002-02` |

### REQ-003 予約
| AC | Test Case |
|---|---|
| AC-003-001 | `TC-F-003-01` |
| AC-003-002 | `TC-F-003-02` |
| AC-003-003 | `TC-F-003-02` |
| AC-003-004 | `TC-F-003-01` |
| AC-003-008 | `TC-F-003-02` |
| AC-003-005 | `TC-F-003-01` |
| AC-003-006 | `TC-F-003-03` |
| AC-003-007 | `TC-F-003-04` |
| AC-003-016 | `TC-F-003-05` |
| AC-003-017 | `TC-F-003-05` |
| AC-003-018 | `TC-F-003-05` |
| AC-003-019 | `TC-F-003-06` |
| AC-003-020 | `TC-F-003-07` |

### REQ-004 生徒キャンセル
| AC | Test Case |
|---|---|
| AC-004-001 | `TC-F-004-01` |
| AC-004-002 | `TC-F-004-02` |
| AC-004-003 | `TC-F-004-03` |
| AC-004-004 | `TC-F-004-04` |
| AC-004-005 | `TC-F-004-01`, `TC-F-004-05` |

### REQ-005 予約履歴
| AC | Test Case |
|---|---|
| AC-005-001 | `TC-F-005-01` |
| AC-005-002 | `TC-F-005-01` |

### REQ-006 グループレッスン表示
| AC | Test Case |
|---|---|
| AC-006-001 | `TC-F-006-01` |
| AC-006-002 | `TC-F-006-02` |

### REQ-007 プロフィール変更
| AC | Test Case |
|---|---|
| AC-007-001 | `TC-F-007-01` |
| AC-007-002 | `TC-F-007-02` |
| AC-007-003 | `TC-F-007-02` |
| AC-007-004 | `TC-F-007-02` |

### REQ-101 予約確認メール
| AC | Test Case |
|---|---|
| AC-101-001 | `TC-F-101-01` |
| AC-101-002 | `TC-F-101-01` |

### REQ-102 24時間Reminder
| AC | Test Case |
|---|---|
| AC-102-001 | `TC-F-102-01` |

### REQ-103 スクール都合キャンセル通知
| AC | Test Case |
|---|---|
| AC-103-001 | `TC-F-103-01` |
| AC-103-002 | `TC-F-103-01` |
| AC-103-003 | `TC-F-103-02` |

### REQ-104 標準／追加区分変更通知
| AC | Test Case |
|---|---|
| AC-104-001 | `TC-F-104-01` |
| AC-104-002 | `TC-F-104-01` |
| AC-104-003 | `TC-F-104-02` |

### REQ-105 通知失敗管理
| AC | Test Case |
|---|---|
| AC-105-001 | `TC-F-105-01` |
| AC-105-002 | `TC-F-105-01` |
| AC-105-003 | `TC-F-105-02` |
| AC-105-004 | `TC-F-105-03` |

### REQ-109 重大システム障害通知
| AC | Test Case |
|---|---|
| AC-109-001 | `TC-F-109-01` |
| AC-109-002 | `TC-F-109-02` |

### REQ-110 重要業務状態のシステム表示
| AC | Test Case |
|---|---|
| AC-110-001 | `TC-F-110-01` |

### REQ-201 生徒登録
| AC | Test Case |
|---|---|
| AC-201-001 | `TC-F-201-01` |
| AC-201-002 | `TC-F-201-01` |
| AC-201-003 | `TC-F-201-02` |

### REQ-202 Google認証
| AC | Test Case |
|---|---|
| AC-202-001 | `TC-F-202-01` |
| AC-202-002 | `TC-F-202-02` |

### REQ-203 メールマジックリンク認証
| AC | Test Case |
|---|---|
| AC-203-001 | `TC-F-203-01` |
| AC-203-002 | `TC-F-203-01` |
| AC-203-003 | `TC-F-203-02` |

### REQ-204 招待
| AC | Test Case |
|---|---|
| AC-204-001 | `TC-F-204-01` |
| AC-204-002 | `TC-F-204-02` |

### REQ-205 アカウント紐付け
| AC | Test Case |
|---|---|
| AC-205-001 | `TC-F-205-01` |
| AC-205-002 | `TC-F-205-02` |

### REQ-206 連絡先メール変更
| AC | Test Case |
|---|---|
| AC-206-001 | `TC-F-206-01` |
| AC-206-002 | `TC-F-206-01` |
| AC-206-003 | `TC-F-206-01` |
| AC-206-004 | `TC-F-206-02` |

### REQ-207 Session管理
| AC | Test Case |
|---|---|
| AC-207-001 | `TC-F-207-01` |
| AC-207-002 | `TC-F-207-02` |
| AC-207-003 | `TC-F-207-03` |

### REQ-209 代替認証経路
| AC | Test Case |
|---|---|
| AC-209-001 | `TC-F-209-01` |
| AC-209-002 | `TC-F-209-02` |

### REQ-210 認証悪用防止
| AC | Test Case |
|---|---|
| AC-210-001 | `TC-F-210-01` |
| AC-210-002 | `TC-F-210-02` |
| AC-210-003 | `TC-F-210-03` |
| AC-210-004 | `TC-F-210-04` |
| AC-210-005 | `TC-F-210-05` |
| AC-210-006 | `TC-F-210-01` |
| AC-210-007 | `TC-F-210-06` |

### REQ-211 セキュリティ利用停止
| AC | Test Case |
|---|---|
| AC-211-001 | `TC-F-211-02` |
| AC-211-002 | `TC-F-211-02` |
| AC-211-003 | `TC-F-211-02` |
| AC-211-004 | `TC-F-211-02` |
| AC-211-005 | `TC-F-211-03` |
| AC-211-006 | `TC-F-211-01` |

### REQ-301 月間スケジュール管理
| AC | Test Case |
|---|---|
| AC-301-001 | `TC-F-301-01` |
| AC-301-002 | `TC-F-301-01` |
| AC-301-003 | `TC-F-301-02` |
| AC-301-004 | `TC-F-301-02` |
| AC-301-005 | `TC-F-301-03` |
| AC-301-006 | `TC-F-301-01` |
| AC-301-007 | `TC-F-301-04` |
| AC-301-008 | `TC-F-301-01` |

### REQ-302 臨時休業
| AC | Test Case |
|---|---|
| AC-302-001 | `TC-F-302-01` |
| AC-302-002 | `TC-F-302-02` |
| AC-302-003 | `TC-F-302-03` |

### REQ-303 月曜営業Override
| AC | Test Case |
|---|---|
| AC-303-001 | `TC-F-303-01` |
| AC-303-002 | `TC-F-303-02` |

### REQ-304 管理者確保枠
| AC | Test Case |
|---|---|
| AC-304-001 | `TC-F-304-01` |
| AC-304-002 | `TC-F-304-01` |
| AC-304-003 | `TC-F-304-02` |
| AC-304-004 | `TC-F-304-02` |
| AC-304-005 | `TC-F-304-03` |
| AC-304-006 | `TC-F-304-04` |

### REQ-305 定期グループレッスン設定
| AC | Test Case |
|---|---|
| AC-305-001 | `TC-F-305-01` |
| AC-305-002 | `TC-F-305-02` |
| AC-305-003 | `TC-F-305-02` |
| AC-305-004 | `TC-F-305-02` |
| AC-305-005 | `TC-F-305-02` |

### REQ-307 月間標準回数設定
| AC | Test Case |
|---|---|
| AC-307-001 | `TC-F-307-01` |
| AC-307-002 | `TC-F-307-02` |

### REQ-308 月間回数除外
| AC | Test Case |
|---|---|
| AC-308-001 | `TC-F-308-01` |

### REQ-309 標準／追加再分類
| AC | Test Case |
|---|---|
| AC-309-001 | `TC-F-309-01` |
| AC-309-002 | `TC-F-309-02` |
| AC-309-003 | `TC-F-309-03` |

### REQ-310 区分Override
| AC | Test Case |
|---|---|
| AC-310-001 | `TC-F-310-01` |

### REQ-311 生徒削除
| AC | Test Case |
|---|---|
| AC-311-001 | `TC-F-311-01` |
| AC-311-002 | `TC-F-311-02` |
| AC-311-003 | `TC-F-311-03` |

### REQ-312 削除時予約処理
| AC | Test Case |
|---|---|
| AC-312-001 | `TC-F-312-01` |
| AC-312-002 | `TC-F-312-01` |

### REQ-313 スクール都合キャンセル
| AC | Test Case |
|---|---|
| AC-313-001 | `TC-F-313-01` |
| AC-313-002 | `TC-F-313-01` |
| AC-313-003 | `TC-F-313-01` |
| AC-313-004 | `TC-F-313-02` |

### REQ-314 通知失敗Dashboard
| AC | Test Case |
|---|---|
| AC-314-001 | `TC-F-314-01` |
| AC-314-002 | `TC-F-314-01` |

### REQ-315 欠席記録
| AC | Test Case |
|---|---|
| AC-315-001 | `TC-F-315-01` |
| AC-315-002 | `TC-F-315-02` |
| AC-315-003 | `TC-F-315-03` |
| AC-315-004 | `TC-F-315-03` |

### REQ-316 セキュリティ利用停止管理
| AC | Test Case |
|---|---|
| AC-316-001 | `TC-F-316-01` |
| AC-316-002 | `TC-F-316-01` |
| AC-316-003 | `TC-F-316-01` |
| AC-316-004 | `TC-F-316-02` |

### REQ-317 プロフィール代理支援
| AC | Test Case |
|---|---|
| AC-317-001 | `TC-F-317-01` |
| AC-317-002 | `TC-F-317-02` |
| AC-317-003 | `TC-F-317-01` |

### REQ-319 登録モード管理
| AC | Test Case |
|---|---|
| AC-319-001 | `TC-F-319-01` |

### REQ-320 管理者認証方法管理
| AC | Test Case |
|---|---|
| AC-320-001 | `TC-F-320-01` |
| AC-320-002 | `TC-F-320-02` |
| AC-320-003 | `TC-F-320-03` |

### REQ-321 祝日マスタ更新
| AC | Test Case |
|---|---|
| AC-321-001 | `TC-F-321-01` |
| AC-321-002 | `TC-F-321-02`, `TC-F-321-03` |
| AC-321-003 | `TC-F-321-02` |
| AC-321-004 | `TC-F-321-03` |
| AC-321-005 | `TC-F-321-04` |
| AC-321-006 | `TC-F-321-05` |

### REQ-901 対応Browser
| AC | Test Case |
|---|---|
| AC-901-001 | `TC-NF-901-01` |

### REQ-902 Responsive
| AC | Test Case |
|---|---|
| AC-902-001 | `TC-NF-902-01` |
| AC-902-002 | `TC-NF-902-02` |
| AC-902-003 | `TC-NF-902-02` |

### REQ-903 Accessibility
| AC | Test Case |
|---|---|
| AC-903-001 | `TC-NF-903-01` |

### REQ-904 Performance
| AC | Test Case |
|---|---|
| AC-904-001 | `TC-NF-904-01` |
| AC-904-002 | `TC-NF-904-01` |
| AC-904-003 | `TC-NF-904-01` |
| AC-904-004 | `TC-NF-904-02` |

### REQ-905 Availability
| AC | Test Case |
|---|---|
| AC-905-001 | `TC-NF-905-01` |
| AC-905-002 | `TC-NF-905-01` |

### REQ-906 計画保守
| AC | Test Case |
|---|---|
| AC-906-001 | `TC-NF-906-01` |
| AC-906-002 | `TC-NF-906-01` |

### REQ-907 業務Timezone
| AC | Test Case |
|---|---|
| AC-907-001 | `TC-NF-907-01` |
| AC-907-002 | `TC-NF-907-02` |

### REQ-908 RTO・有人保守
| AC | Test Case |
|---|---|
| AC-908-001 | `TC-NF-908-01` |
| AC-908-002 | `TC-NF-908-02` |
| AC-908-003 | `TC-NF-908-02` |
| AC-908-004 | `TC-NF-908-03` |

### REQ-909 RPO
| AC | Test Case |
|---|---|
| AC-909-001 | `TC-NF-909-01`, `TC-NF-909-02` |

### REQ-910 長期Backup保持
| AC | Test Case |
|---|---|
| AC-910-001 | `TC-NF-910-01` |
| AC-910-002 | `TC-NF-910-02` |
| AC-910-003 | `TC-NF-910-03` |

### REQ-911 競合整合性
| AC | Test Case |
|---|---|
| AC-911-001 | `TC-NF-911-01`, `TC-NF-911-02` |
| AC-911-002 | `TC-NF-911-01`, `TC-NF-911-02` |

### REQ-912 外部API Retry
| AC | Test Case |
|---|---|
| AC-912-001 | `TC-NF-912-01` |
| AC-912-002 | `TC-NF-912-01` |
| AC-912-003 | `TC-NF-912-02` |
| AC-912-004 | `TC-NF-912-03` |
| AC-912-005 | `TC-NF-912-04` |

### REQ-913 無料枠運用
| AC | Test Case |
|---|---|
| AC-913-001 | `TC-NF-913-01` |
| AC-913-002 | `TC-NF-913-02` |
| AC-913-003 | `TC-NF-913-02` |
| AC-913-004 | `TC-NF-913-02` |

### REQ-914 障害・エラー時利用者表示
| AC | Test Case |
|---|---|
| AC-914-001 | `TC-NF-914-01` |
| AC-914-002 | `TC-NF-914-02` |
| AC-914-003 | `TC-NF-914-03` |
| AC-914-004 | `TC-NF-914-04` |
| AC-914-005 | `TC-NF-914-03` |

### REQ-934 PII削除
| AC | Test Case |
|---|---|
| AC-934-001 | `TC-NF-934-01` |
| AC-934-002 | `TC-NF-934-02` |

### REQ-935 認証可用性
| AC | Test Case |
|---|---|
| AC-935-001 | `TC-NF-935-01` |

### REQ-940 監査Logging
| AC | Test Case |
|---|---|
| AC-940-001 | `TC-NF-940-01` |
| AC-940-002 | `TC-NF-940-02` |
| AC-940-003 | `TC-NF-940-03` |
| AC-940-004 | `TC-NF-940-03` |
| AC-940-005 | `TC-NF-940-04` |

### REQ-942 監視・重大Incident
| AC | Test Case |
|---|---|
| AC-942-001 | `TC-NF-942-01` |
| AC-942-002 | `TC-NF-942-02` |

### REQ-951 Provider分離
| AC | Test Case |
|---|---|
| AC-951-001 | `TC-NF-951-01` |

### REQ-952 Backup Privacy
| AC | Test Case |
|---|---|
| AC-952-001 | `TC-NF-952-01` |

## 4. Constraints / Out of Scope Scope Guard

CON/OOSは正機能として新しい要求を作らず、Configuration/Static Review/Negative Inspectionで逸脱を検知する。

| ID | Source | 観点 | 方法 | 合否基準 | 関連 |
|---|---|---|---|---|---|
| `TC-SG-CON-001` | CON-001 | Cloudflare基盤 | Static architecture review | Web/API=Workers、Main DB=D1、長期Backup=R2を基本構成としていることを基本設計・Deploy設定で確認する。 | REQ-909/910/942の動的試験と併用。 |
| `TC-SG-CON-002` | CON-002 | Resend / Email設定 | Configuration + DNS review | 初期Email ProviderがResend Free、WorkersからHTTPS API、独自送信DomainにSPF/DKIM/DMARC、Open/Click Tracking原則無効を確認する。 | TC-F-101-01, TC-NF-912-* |
| `TC-SG-CON-003` | CON-003 | Google + Magic Link | Functional coverage | Googleを必須とせず、Google/Magic Link双方が利用できることを確認する。 | TC-F-202-*, TC-F-203-*, TC-F-209-* |
| `TC-SG-CON-004` | CON-004 | 祝日Source | Functional + config | 内閣府公式情報をSource of Truthとし、URL Config化・検証・LKGを確認する。 | TC-F-321-* |
| `TC-SG-CON-005` | CON-005 | Asia/Tokyo固定 | Boundary / timezone | 海外Clientを含めJST表示・Server時刻判定を確認する。 | TC-NF-907-* |
| `TC-SG-CON-006` | CON-006 | 初期規模 | Performance dataset review | Performance/運用試験の通常規模データが管理者1名・生徒約20名を少なくとも代表することを確認する。 | TC-NF-904-* |
| `TC-SG-CON-007` | CON-007 | 初期管理者 | Scope / authorization review | 公開管理者登録が存在せず、Setup済み管理者Accountのみが管理権限を得ることを確認する。 | TC-F-202-02, TC-F-320-* |
| `TC-SG-CON-008` | CON-008 | 固定予約枠 | Scope guard | 初期リリースで任意開始・終了時刻の個人Lesson枠作成機能を提供しないことを確認する。 | OOS-004と共通 |
| `TC-SG-CON-009` | CON-009 | Backup方式非固定 | Requirements review | 方式名そのものではなくREQ-909/910のRPO・世代・Restore能力で合否判定する。 | TC-NF-909-*, TC-NF-910-* |
| `TC-SG-CON-010` | CON-010 | 通知Channel | Scope guard | 利用者通知ChannelがEmail/System内表示で、LINE/Facebook/SMS/Pushを初期機能として要求・提供していないことを確認する。 | TC-F-103-*, TC-F-110-01 |
| `TC-SG-OOS-001` | OOS-001 | 決済・請求・会計 | Negative UI/API inspection | 予約/通知で料金・請求・決済・会計機能が初期リリースの業務フローに現れないことを確認する。 | TC-F-003-01, TC-F-101-01 |
| `TC-SG-OOS-002` | OOS-002 | 管理者代理予約 | Negative authorization/UI inspection | A1が生徒本人の代理で新規個人Lesson予約を作成する機能を初期リリースで提供しないことを確認する。 | REQ-003は認証済み生徒本人の自己予約として試験し、TC-F-003-06/07で所有者同一性を確認 |
| `TC-SG-OOS-003` | OOS-003 | 専用振替 | Negative workflow inspection | Atomicな予約変更/振替機能を提供せず、Cancelと新規予約が独立操作であることを確認する。 | TC-F-004-*, TC-F-003-* |
| `TC-SG-OOS-004` | OOS-004 | 任意時刻枠 | Negative UI/API inspection | 管理者が任意開始・終了時刻の個人Lesson枠を作成できる初期機能がないことを確認する。 | TC-SG-CON-008 |
| `TC-SG-OOS-005` | OOS-005 | Group Lesson内容管理 | Negative UI/API inspection | 参加者・定員・申込・出欠・料金・内容・参加者通知の管理機能を提供しないことを確認する。 | TC-F-006-02 |
| `TC-SG-OOS-006` | OOS-006 | 複数管理者管理UI | Negative UI inspection | 複数管理者の招待・一覧・RBAC管理UIを初期リリースで提供しないことを確認する。 | TC-F-320-* |
| `TC-SG-OOS-007` | OOS-007 | 過去データ移行 | Data / workflow inspection | 旧運用の過去予約等をImport/参照するMigration機能を初期リリースで提供しないことを確認する。 | Cutover後データのみを受入対象とする |
| `TC-SG-OOS-008` | OOS-008 | 長期Analytics | Storage review | 統計目的だけの長期匿名Data Store/履歴蓄積がないことを確認する。 | TC-NF-934-*, TC-NF-940-* |
| `TC-SG-OOS-009` | OOS-009 | 休会・在籍状態 | Negative domain/UI inspection | Membership Stateとしての休会/在籍/退会を提供せず、Security Suspensionと混同しないことを確認する。 | TC-F-211-*, TC-F-316-* |

## 5. 変更影響確認

要求・設計変更時は以下を確認する。

1. 変更対象REQの上位POL/BRを要求側Matrixで確認
2. 対象ACを特定
3. 本書で対応TCを特定
4. 関連CON/OOSのScope Guardを確認
5. 競合・分類・通知・Privacy等のCross-cutting回帰セットへ影響する場合は追加実行
6. ACの意味が変わった場合はテスト仕様だけで吸収せず、要求仕様を先に更新する
