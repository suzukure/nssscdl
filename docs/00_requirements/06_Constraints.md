# 制約・対象外・確定済み論点

## 1. 技術・運用制約

### CON-001 Cloudflare基盤
Web/APIはCloudflare Workers、Main DBはD1、長期Backup保管はR2を基本構成とする。Cron Trigger等をScheduled Processingに利用できる。

### CON-002 メールProvider
初期ProviderはResend Freeを使用し、WorkersからHTTPS APIで送信する。独自送信DomainでSPF/DKIM/DMARCを設定し、Open/Click Trackingは原則無効とする。

### CON-003 認証
Google認証とEmail Magic Linkを提供する。Google Accountは必須としない。

### CON-004 祝日Source
内閣府の公式祝日情報をSource of Truthとする。URLはConfig化し、公式Domain、Parse、日付・名称、対象年Coverage等を検証して内部Masterへ反映する。

### CON-005 日本時間
業務TimezoneはAsia/Tokyo固定とする。

### CON-006 初期規模
スクール管理者1名、生徒約20名を想定する。

### CON-007 初期管理者
公開管理者登録は設けず、System Setup時に1つのスクール管理者Accountを作成する。技術保守権限はCloudflare等のInfrastructure側で管理する。

### CON-008 予約枠
任意時刻枠は初期リリースでは提供しない。将来拡張を妨げないようSlot開始・終了時刻を表現可能なData Modelとすることは許容する。

### CON-009 Backup方式
RPOを満たす限りTime Travel、PITR、Snapshot、Backup等の具体方式を固定しない。

### CON-010 通知Channel
利用者通知はEmailとSystem内表示を用いる。LINE、Facebook、SMS、Push Notificationは初期対象外。

## 2. Out of Scope

### OOS-001 決済・請求・会計
レッスン料金計算、請求、決済、Accountingは対象外。

### OOS-002 管理者代理予約
旧検討上のREQ-306相当はMustから除外する。管理者が生徒本人に代わって新規個人レッスン予約を作成する機能は対象外。将来拡張のためActor/Target/Booking Sourceを分離できる設計余地は残してよい。

### OOS-003 専用振替
Atomicな予約変更・振替機能は対象外。

### OOS-004 任意時刻枠
管理者による任意開始・終了時刻の個人レッスン枠作成は対象外。

### OOS-005 グループレッスン内容管理
グループレッスンの参加者、定員、申込み、出欠、料金、内容、参加者向け通知は対象外。

### OOS-006 複数管理者管理UI
複数管理者の招待、一覧、詳細RBAC管理UIは対象外。ただしRoleをEmailへHardcodeしない。

### OOS-007 過去データ移行
旧運用の過去予約、キャンセル、欠席、標準／追加区分等のImport・参照機能は対象外。

### OOS-008 長期Analytics
統計目的だけの長期匿名データStoreは対象外。

### OOS-009 休会・在籍状態管理
休会・在籍中／退会等のMembership State管理は対象外。Security Suspensionは別概念。

## 3. Closed Open Issues / Topic Memo

以下は要求判断済みであり、本版では未決事項ではない。

| ID | 状態 | 要旨 |
|---|---|---|
| OI-TM-011 | Closed | 対応Browserは現行＋1 Major前。 |
| OI-TM-012 | Closed | WCAG 2.2 AA参照目標。 |
| OI-TM-013 | Closed | 主要業務E2E p95 3秒。 |
| OI-TM-014 | Closed | 月間Availability 99.5%以上。 |
| OI-TM-016 | Closed | 重大Incident通知とAlert集約。 |
| OI-TM-017 | Closed | Backup保持・Restore Test。高頻度方式は後にOI-TM-050で抽象化。 |
| OI-TM-018 | Closed | 重大障害RTO 4h。有人保守時間はOI-TM-051/POL-012で補足。 |
| OI-TM-019 | Closed | 繁忙時間RPO 3h、その他24h。 |
| OI-TM-022 | Closed | Email ProviderはResend Free。 |
| OI-TM-024 | Closed | 320 CSS px以上のResponsive。 |
| OI-TM-025 | Closed | 外部APIのTransient Retry Policy。 |
| OI-TM-026 | Closed | 初期管理者1名、複数管理者UIなし。 |
| OI-TM-027 | Closed | Cloudflare Workers + D1 + R2。 |
| OI-TM-028 | Closed | 管理者代理予約は初期リリース対象外。 |
| OI-TM-029 | Closed | Analytics目的の長期匿名履歴を持たない。 |
| OI-TM-030 | Closed | Backup内の個人情報のRetention例外と復旧時Purge。 |
| OI-TM-031 | Closed | 管理者Account Bootstrap/Recovery。 |
| OI-TM-032 | Closed | Turnstile、Rate Limit、Enumeration防止。 |
| OI-TM-033 | Closed | 無料枠圧迫時は自動整理優先、自動有料化なし。 |
| OI-TM-034 | Closed | 監査Log 1年、技術Log約30日、個人情報削除優先。 |
| OI-TM-035 | Closed | 連絡先Email変更と所有確認・旧Email Security Notice。 |
| OI-TM-036 | Closed | 予約済み枠を休業化する場合のCancel/警告。 |
| OI-TM-037 | Closed | 祝日Sourceは内閣府公式情報、Last Known Good。 |
| OI-TM-038 | Closed | 標準回数/区分設定変更時の再分類・通知。 |
| OI-TM-039 | Closed | 公開後Schedule変更。将来枠変更可、予約済み日時直接変更不可、Commit時再検証。 |
| OI-TM-040 | Closed | 生徒Cancelは終了時刻まで。開始後Cancelは枠再開放なし。 |
| OI-TM-041 | Closed | 全業務時刻Asia/Tokyo、Server Commit時刻を正とする。 |
| OI-TM-042 | Closed | Active生徒の連絡先Email一意。 |
| OI-TM-043 | Closed | 専用振替なし。Cancel＋新規予約。 |
| OI-TM-044 | Closed | 最小Profileと管理者代理支援。 |
| OI-TM-045 | Closed | 過去Data移行なし。新月予約からCutover。 |
| OI-TM-046 | Closed | スクール都合Cancel理由Category。 |
| OI-TM-047 | Closed | Security Suspensionと解除。用途・影響を管理者へ説明。 |
| OI-TM-048 | Closed | 任意時刻枠なし、固定枠の管理者確保／Group Lesson表示。 |
| OI-TM-049 | Closed | Group Lesson定期設定。変更は既生成月へ非遡及。 |
| OI-TM-050 | Closed | Backup要求をRPO中心に方式非依存化。 |
| OI-TM-051 | Closed | 24h Serviceと有人保守6:00-24:00の分離、RTO整理。 |

## 4. 初期リリースで未決の業務論点
なし。
