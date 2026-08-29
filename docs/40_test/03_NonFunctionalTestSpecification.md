# 非機能テスト仕様
## 1. 位置づけ

本書は非機能要求 `REQ-901`〜`REQ-952` に対するTest Case / Test Procedure Specificationである。
性能、復旧、監視、Privacy等は単一画面の合否ではなく、測定値・復旧結果・設定・Log等の証跡で判定する。

## 2. テストケース

### REQ-901 対応Browser
| TC ID | 対応AC | P | 技法 | Setup / Procedure | 期待結果 | 必須証跡 | 自動化 |
|---|---|:---:|---|---|---|---|---|
| `TC-NF-901-01` | AC-901-001 | P1 | Browser matrix / Pairwise | 実行時点のChrome/Edge/Safari/Firefox 現行Major＋1つ前を確定。S1/A1標準データ。 各BrowserでLogin、Schedule閲覧、予約、キャンセル、管理者主要操作の代表Happy pathを実行する。 | 各対象BrowserでMust業務を完了でき、Browser固有のBlockerがない。 | Browser/Version別実行結果、Screenshot | 自動化候補 |

### REQ-902 Responsive
| TC ID | 対応AC | P | 技法 | Setup / Procedure | 期待結果 | 必須証跡 | 自動化 |
|---|---|:---:|---|---|---|---|---|
| `TC-NF-902-01` | AC-902-001 | P1 | Responsive / Use-case | Viewport幅320px以上のSmartphone縦。 S1がLogin→Schedule確認→予約→キャンセルを完了する。 | 主要生徒業務がSmartphoneだけで完結する。 | E2E結果、主要画面Screenshot | 自動化候補 |
| `TC-NF-902-02` | AC-902-002, AC-902-003 | P1 | Responsive inspection | 320px、Tablet、PC代表幅。 主要Pageで横Overflowを検査し、Table/Calendar内部も確認する。 | 通常Page全体にはHorizontal Scrollが発生しない。Table/Calendar内部の局所Scrollは許容。 | Layout計測、Screenshot | 自動＋手動 |

### REQ-903 Accessibility
| TC ID | 対応AC | P | 技法 | Setup / Procedure | 期待結果 | 必須証跡 | 自動化 |
|---|---|:---:|---|---|---|---|---|
| `TC-NF-903-01` | AC-903-001 | P1 | Accessibility review | 主要画面一式。 Keyboardのみ操作、Focus可視性、Contrast、Form Label、Error関連付け等を自動Scanner＋人手で確認する。 | 主要AA観点で重大な利用阻害がなく、設計Review結果が記録される。 | Accessibility report、手動Review記録 | 自動＋手動 |

### REQ-904 Performance
| TC ID | 対応AC | P | 技法 | Setup / Procedure | 期待結果 | 必須証跡 | 自動化 |
|---|---|:---:|---|---|---|---|---|
| `TC-NF-904-01` | AC-904-001, AC-904-002, AC-904-003 | P1 | Performance percentile | Production相当の通常規模データ。代表操作: Login後Schedule表示、予約Preview/Confirm、キャンセル、管理者Schedule確定。 利用者操作開始から成功/失敗表示までを各操作で十分なサンプル数計測する。Email実到達時間は除外。 | 主要業務のUser認知E2Eがp95 3秒以内。 | Raw timings、p50/p75/p95、Build/環境情報 | 自動化候補 |
| `TC-NF-904-02` | AC-904-004 | P2 | Performance measurement | 主要PageをProduction相当条件で計測。 LCP/INP/CLSを複数回収集する。 | 目標としてp75 LCP<=2.5s、INP<=200ms、CLS<=0.1を評価し、逸脱を記録する。 | Web Vitals report | 自動化候補 |

### REQ-905 Availability
| TC ID | 対応AC | P | 技法 | Setup / Procedure | 期待結果 | 必須証跡 | 自動化 |
|---|---|:---:|---|---|---|---|---|
| `TC-NF-905-01` | AC-905-001, AC-905-002 | P1 | Operational calculation | 監視ログに計画保守、未計画障害、0:00-6:00障害を含むサンプル月。 Availability算式へ各停止区間を投入する。 | 計画保守のみ除外可能。0:00-6:00の未計画障害も停止時間として算入し、月間99.5%以上目標を評価できる。 | Availability計算表、監視Event | 自動化候補 |

### REQ-906 計画保守
| TC ID | 対応AC | P | 技法 | Setup / Procedure | 期待結果 | 必須証跡 | 自動化 |
|---|---|:---:|---|---|---|---|---|
| `TC-NF-906-01` | AC-906-001, AC-906-002 | P2 | Operational review | 計画保守Runbook/告知機能。 通常計画保守と緊急保守の手順をReviewし、可能なら告知を実施する。 | 通常は原則0:00-6:00 JST。可能な場合管理者へ事前通知。緊急保守は時間帯制約を受けない。 | Runbook、告知証跡 | 手動Review |

### REQ-907 業務Timezone
| TC ID | 対応AC | P | 技法 | Setup / Procedure | 期待結果 | 必須証跡 | 自動化 |
|---|---|:---:|---|---|---|---|---|
| `TC-NF-907-01` | AC-907-001 | P0 | Timezone equivalence | Client timezoneをUTC、US等へ変更。 同じSchedule/予約を表示・操作する。 | 業務時刻はAsia/Tokyoで表示・判定され、Client timezoneで意味が変わらない。 | Browser timezone別Screenshot/response | 自動化候補 |
| `TC-NF-907-02` | AC-907-002 | P0 | Boundary / Clock tampering | Client時計を進める/戻す。Server Commit時刻をTstart/Tend境界へ設定。 予約・キャンセルを実施する。 | Client時計ではなくServer Commit時刻で期限判定される。 | Server時刻、結果、Audit/Response | 自動化候補 |

### REQ-908 RTO・有人保守
| TC ID | 対応AC | P | 技法 | Setup / Procedure | 期待結果 | 必須証跡 | 自動化 |
|---|---|:---:|---|---|---|---|---|
| `TC-NF-908-01` | AC-908-001 | P0 | Recovery exercise | 6:00-24:00 JST内に重大Service停止を模擬。 検知→有人対応開始→復旧までを演習・計測する。 | 原則4時間以内復旧目標を評価できる。 | Incident timeline、復旧証跡 | 手動＋半自動 |
| `TC-NF-908-02` | AC-908-002, AC-908-003 | P1 | Operational simulation | 0:00-6:00に重大障害を発生。 自動監視/復旧を継続し、未復旧なら6:00から人的対応を開始する演習を行う。 | 夜間On-callを必須とせず自動監視/復旧継続。未復旧なら6:00対応開始、原則10:00まで復旧目標。 | Monitoring timeline、Runbook記録 | 自動化候補 |
| `TC-NF-908-03` | AC-908-004 | P2 | Operational review | Backup失敗等、即時Service停止なしのIncident例。 重大度分類と対応SLA適用をReviewする。 | Service停止4h RTOを機械的に適用せず、重大度別手順が選択される。 | Incident classification record | 手動Review |

### REQ-909 RPO
| TC ID | 対応AC | P | 技法 | Setup / Procedure | 期待結果 | 必須証跡 | 自動化 |
|---|---|:---:|---|---|---|---|---|
| `TC-NF-909-01` | AC-909-001 | P0 | Restore / RPO measurement | 7:00-24:00 JSTに既知時刻の業務更新を連続投入し、障害点を作る。 利用可能なPITR/Backup等から復旧し、最終復元可能時点を測定する。 | データ損失窓が3時間以内。 | 復旧DB、更新時刻比較、Restore log | 自動化候補 |
| `TC-NF-909-02` | AC-909-001 | P0 | Restore / RPO measurement | 0:00-7:00 JSTに既知時刻の更新と障害点。 復旧可能時点を測定する。 | データ損失窓が24時間以内。 | 復旧DB、更新時刻比較、Restore log | 自動化候補 |

### REQ-910 長期Backup保持
| TC ID | 対応AC | P | 技法 | Setup / Procedure | 期待結果 | 必須証跡 | 自動化 |
|---|---|:---:|---|---|---|---|---|
| `TC-NF-910-01` | AC-910-001 | P0 | Configuration / Retention inspection | Backup保管設定と実世代。 日次/週次/月次の世代数とProduction Storeからの独立性を確認する。 | 日次15、週次4、月次3世代を保持し、Production Storeと独立して復旧可能。 | Backup inventory、storage configuration | 自動化候補 |
| `TC-NF-910-02` | AC-910-002 | P0 | Restore exercise | 代表BackupをRestore専用環境へ復旧可能。 定期Restoreを実施し、主要整合性チェックを行う。 | Backupから実際に復旧でき、定期試験記録が残る。 | Restore log、整合性Check結果 | 自動化候補 |
| `TC-NF-910-03` | AC-910-003 | P1 | Fault injection | Backup Jobを意図的に失敗させる。 Monitoring/Alertを確認する。 | 保守担当者が失敗を検知できる。 | Alert、Monitoring event | 自動化候補 |

### REQ-911 競合整合性
| TC ID | 対応AC | P | 技法 | Setup / Procedure | 期待結果 | 必須証跡 | 自動化 |
|---|---|:---:|---|---|---|---|---|
| `TC-NF-911-01` | AC-911-001, AC-911-002 | P0 | Concurrency / Race | 同一空き枠へS1/S2をBarrier同期。 ほぼ同時に予約Confirmを送る。 | Commit直前再検証により1件のみ成功。先行Commit優先、後続はConflict。二重予約なし。 | 両Response、DB/Business state、Audit | 自動化候補 |
| `TC-NF-911-02` | AC-911-001, AC-911-002 | P0 | Concurrency / Atomicity | A1 Schedule変更とS1予約を同一枠へ競合。 先行Commitを交互に変えて反復する。 | どちらの順序でも先行確定状態を後続が暗黙上書きせず、最新状態再検証・Conflictが機能する。 | Response、最終State、Audit | 自動化候補 |

### REQ-912 外部API Retry
| TC ID | 対応AC | P | 技法 | Setup / Procedure | 期待結果 | 必須証跡 | 自動化 |
|---|---|:---:|---|---|---|---|---|
| `TC-NF-912-01` | AC-912-001, AC-912-002 | P1 | Fault injection / Retry | 外部API StubをTimeout/Network/502/503/504/429へ制御。 Retry可能な冪等処理を実行する。 | Transient Errorのみ最大3回、Exponential Backoff。429はRetry-Afterを優先。 | Call timestamps、Retry count | 自動化候補 |
| `TC-NF-912-02` | AC-912-003 | P1 | Fault injection | 401/403/入力不正/Bad Recipient等を返すStub。 対象処理を実行する。 | Permanent Errorは自動Retryしない。 | Provider call count、Application result | 自動化候補 |
| `TC-NF-912-03` | AC-912-004 | P1 | Fault injection | Google Loginで一時失敗を返す。 Loginフローを実行する。 | Login自体をアプリが自動反復せず、利用者再操作へ案内する。 | Google call count、UI/response | 自動化候補 |
| `TC-NF-912-04` | AC-912-005 | P0 | Idempotency / Fault injection | Provider accepted後に配信失敗Eventを発生。 Application retry機構を動作させる。 | Provider固有配信Retryルールを優先し、アプリから盲目的な重複再送をしない。 | Message IDs、Provider call count | 自動化候補 |

### REQ-913 無料枠運用
| TC ID | 対応AC | P | 技法 | Setup / Procedure | 期待結果 | 必須証跡 | 自動化 |
|---|---|:---:|---|---|---|---|---|
| `TC-NF-913-01` | AC-913-001 | P2 | Retention test | 期限切れToken、Rate Limit一時データ、期限切れLog/Backupを用意。 Retention Jobを実行する。 | 対象の期限切れデータが自動削除される。 | Before/After件数、Job log | 自動化候補 |
| `TC-NF-913-02` | AC-913-002, AC-913-003, AC-913-004 | P1 | Operational / Configuration review | 無料枠逼迫を模擬または閾値警告を発生。 自動処理・Alert・Plan変更動作を確認する。 | Must業務を停止せず、継続超過は保守担当者へ通知し人が判断。自動有料Upgradeしない。 | Alert、Billing/Plan設定、業務継続結果 | 自動化候補 |

### REQ-914 障害・エラー時利用者表示
| TC ID | 対応AC | P | 技法 | Setup / Procedure | 期待結果 | 必須証跡 | 自動化 |
|---|---|:---:|---|---|---|---|---|
| `TC-NF-914-01` | AC-914-001 | P2 | UI/Operational | 計画保守状態を設定。 Login後画面を確認する。 | 可能な場合、利用者へ計画保守を告知できる。 | Screenshot | 手動Review |
| `TC-NF-914-02` | AC-914-002 | P1 | Fault injection | Application本体を利用不能にするがMaintenance表示経路は利用可能な構成。 利用者Accessを行う。 | 専用Maintenance画面を表示できる。 | Screenshot、HTTP response | 自動化候補 |
| `TC-NF-914-03` | AC-914-003, AC-914-005 | P1 | Fault injection / UX | 予約API等の部分障害と業務Conflictを発生。 利用者操作を行う。 | 該当機能付近に理解可能な状態、再確認/再操作/対応案内、安定したApplication Error表現を提示する。 | UI/response sample | 自動化候補 |
| `TC-NF-914-04` | AC-914-004 | P0 | Security error injection | DB/SQL/Provider/Exception/Stack Traceを含む内部Errorを故意に発生。 画面と公開API responseを確認する。 | 内部技術文字列を直接露出しない。詳細は技術Log/Monitoring側にのみ残す。 | 公開Responseと内部Logの対比 | 自動化候補 |

### REQ-934 PII削除
| TC ID | 対応AC | P | 技法 | Setup / Procedure | 期待結果 | 必須証跡 | 自動化 |
|---|---|:---:|---|---|---|---|---|
| `TC-NF-934-01` | AC-934-001 | P0 | Privacy deletion audit | S4に氏名、連絡先メール、認証紐付け、直接/間接識別子を投入。 削除後24時間以内のActive System全対象Storeを検査する。 | 対象PIIが削除/匿名化され、再識別可能な業務用参照が残らない。 | Store別Before/After、Deletion log | 自動化候補 |
| `TC-NF-934-02` | AC-934-002 | P1 | Policy / Integration review | 削除対象S4に送信済みメール履歴あり。 Active System削除とProvider側Retentionを区別して確認する。 | Active Systemの削除責務を満たし、Provider処理保持はProvider Policy上の例外として扱われる。 | Data inventory、Provider policy mapping | 手動Review |

### REQ-935 認証可用性
| TC ID | 対応AC | P | 技法 | Setup / Procedure | 期待結果 | 必須証跡 | 自動化 |
|---|---|:---:|---|---|---|---|---|
| `TC-NF-935-01` | AC-935-001 | P0 | Fault injection | Google/Magic Link Providerは正常だがD1/Session等共通基盤を停止。 両認証方式を試しMonitoringを確認する。 | 代替認証があるため正常とはみなさず重大Incidentとして扱う。 | Auth results、Incident alert | 自動化候補 |

### REQ-940 監査Logging
| TC ID | 対応AC | P | 技法 | Setup / Procedure | 期待結果 | 必須証跡 | 自動化 |
|---|---|:---:|---|---|---|---|---|
| `TC-NF-940-01` | AC-940-001 | P1 | Audit inspection | 予約影響管理操作、Suspension、Override等を実施。 監査Logを確認する。 | 時刻、操作種別、Actor ID、対象種別、最小限Before/After、結果を追跡できる。 | Audit sample | 自動化候補 |
| `TC-NF-940-02` | AC-940-002 | P0 | Privacy inspection | 氏名/メールを含む対象操作。 Audit Log全Fieldを確認する。 | 氏名・メール等PIIを必要なく複製せず、Actor/Targetは内部ID中心。 | Audit schema/sample | 自動化候補 |
| `TC-NF-940-03` | AC-940-003, AC-940-004 | P1 | Retention test | 1年超業務監査Log、30日程度超技術/Error/Security Logを用意。 Retention Jobを実行する。 | 業務監査Logは1年保持後自動削除。技術系一時Logは原則30日程度で自動削除。 | Before/After、Retention config | 自動化候補 |
| `TC-NF-940-04` | AC-940-005 | P0 | Privacy / Retention | 削除対象S4のPIIが監査/技術Log内に存在するテスト状態。 生徒削除処理とRetentionを実行する。 | 通常保持期間よりPII削除要求を優先し、不要PIIが残存しない。 | Log Before/After、Deletion evidence | 自動化候補 |

### REQ-942 監視・重大Incident
| TC ID | 対応AC | P | 技法 | Setup / Procedure | 期待結果 | 必須証跡 | 自動化 |
|---|---|:---:|---|---|---|---|---|
| `TC-NF-942-01` | AC-942-001 | P1 | Fault injection | DB接続不能、広範予約API失敗、Reminder Job停止、認証全体障害、Backup失敗を個別に模擬。 Monitoring/Alertを確認する。 | 重大Incidentを検知し、保守担当者へ集約通知する。 | Monitoring events、Alert | 自動化候補 |
| `TC-NF-942-02` | AC-942-002 | P1 | Fault injection | Mail Platformを利用不能にする。 通知系障害を発生させる。 | メール通知できなくても可能な範囲でLog/Monitoringに診断記録が残る。 | Log/Monitoring evidence | 自動化候補 |

### REQ-951 Provider分離
| TC ID | 対応AC | P | 技法 | Setup / Procedure | 期待結果 | 必須証跡 | 自動化 |
|---|---|:---:|---|---|---|---|---|
| `TC-NF-951-01` | AC-951-001 | P2 | Architecture static review | 実装コードとDependency構造。 Resend/Google認証のProvider固有コード参照方向をReviewする。 | Provider交換が業務Domain全体の書換えを要求しない局所化構造になっている。 | Architecture review、dependency graph | 手動Review |

### REQ-952 Backup Privacy
| TC ID | 対応AC | P | 技法 | Setup / Procedure | 期待結果 | 必須証跡 | 自動化 |
|---|---|:---:|---|---|---|---|---|
| `TC-NF-952-01` | AC-952-001 | P0 | Restore / Privacy | S4削除前に取得された旧BackupをRestore専用環境へ復旧。 Service再開前または同時に削除済み生徒Purge/匿名化を再適用する。 | 旧Backup由来のS4 PIIが通常Serviceで検索・参照可能な状態にならず、Retention終了時にBackupも削除対象となる。 | Restore/Purge log、検索結果 | 自動化候補 |

## 3. 非機能テスト実行上の注意

- Availability / RTO / RPO は「構成がそう見える」ことではなく、Monitoring記録またはRecovery Exerciseで確認する。
- Performanceは単発値ではなく要求どおりPercentileで判定する。
- Privacy / Auditの証跡に本番PIIを複製しない。
- Provider障害はProduction Providerへ故意に負荷を与えず、Stub / Sandbox / 隔離環境を用いる。
- REQ-951のProvider分離は動的試験だけでは十分でないためStatic Architecture Reviewを正式なテスト手段に含める。
