# 非機能要求

## REQ-901 対応Browser
Chrome、Edge、Safari、Firefoxの現行Majorおよび1つ前のMajorを対象とする。厳密な最低Versionは基本設計で定義する。
- AC-901-001 対象BrowserでMust業務操作を完了できる。

## REQ-902 Responsive
320 CSS px以上を対象とし、スマートフォン縦、Tablet、PCで利用可能とする。
- AC-902-001 生徒のLogin、予約、キャンセルはSmartphoneで完結できる。
- AC-902-002 通常Page全体にHorizontal Scrollを発生させない。
- AC-902-003 Table/Calendar内部の局所Scrollは許容する。

## REQ-903 Accessibility
WCAG 2.2 AAを参照目標とし、初期リリースでは正式Certificationを要求しない。
- AC-903-001 Keyboard、Focus、Contrast、Form Label等の主要AA要件を設計Review対象とする。

## REQ-904 Performance
主要業務操作のUser認知E2E Performanceをp95 3秒以内とする。
- AC-904-001 計測開始は利用者操作、終了は成功／失敗表示時点とする。
- AC-904-002 実メール到達時間を除外する。
- AC-904-003 Production相当の通常規模で評価する。
- AC-904-004 補助指標としてp75 LCP<=2.5s、INP<=200ms、CLS<=0.1を目標とする。

## REQ-905 Availability
月間Availability 99.5%以上を目標とする。
- AC-905-001 計画保守のみ計算除外できる。
- AC-905-002 0:00-6:00の未計画障害は有人対応時間外でもAvailability停止として算入する。

## REQ-906 計画保守
計画保守は原則0:00-6:00 JSTに行う。
- AC-906-001 可能な場合は事前に管理者へ知らせる。
- AC-906-002 緊急保守は時間帯制約を受けない。

## REQ-907 業務Timezone
全業務時刻をAsia/Tokyo固定とする。
- AC-907-001 海外アクセスでもJST表示・判定を基本とする。
- AC-907-002 Client時刻ではなくServer Commit時刻を予約・キャンセル期限判定に使う。

## REQ-908 RTO・有人保守
重大なサービス停止の人的保守対応時間は6:00-24:00 JSTとする。
- AC-908-001 この時間帯に検知した重大停止は原則4時間以内の復旧を目標とする。
- AC-908-002 0:00-6:00は夜間On-callを必須とせず自動監視・自動復旧を継続する。
- AC-908-003 夜間に未復旧の重大障害が残る場合、6:00から人的対応を開始し原則10:00までの復旧を目標とする。
- AC-908-004 Backup失敗等、即時Service停止を伴わない事象は重大度別手順を適用し、4時間RTOを機械的に適用しない。

## REQ-909 RPO
繁忙時間帯7:00-24:00 JSTはRPO 3時間以内、それ以外はRPO 24時間以内とする。
- AC-909-001 Time Travel、PITR、Snapshot、Backup等の方式は問わず、要求以上の復旧可能性を満たす。

## REQ-910 長期Backup保持
長期保全として日次15世代、週次4世代、月次3世代を保持する。
- AC-910-001 Production Storeと独立した復旧可能な保管を行う。
- AC-910-002 Periodic Restore Testを行う。
- AC-910-003 Backup失敗を保守担当者が検知できる。

## REQ-911 競合整合性
二重予約、Lost Update、確定状態の暗黙上書きを防止する。
- AC-911-001 Commit直前に業務条件を再検証する。
- AC-911-002 競合操作は先行Commitを優先し後続へConflictを返す。

## REQ-912 外部API Retry
一時的外部API障害のみ、安全かつ冪等にRetry可能な処理は最大3回、Exponential Backoffで再試行する。
- AC-912-001 429ではRetry-Afterを優先する。
- AC-912-002 Timeout、Temporary Network、502/503/504等を候補とする。
- AC-912-003 認証・権限・入力不正・Bad Recipient等Permanent Errorは自動Retryしない。
- AC-912-004 Google Login自体は自動Retryせず利用者再操作とする。
- AC-912-005 Provider受理後のメール配信RetryはREQ-105の通知固有ルールを優先し、アプリから盲目的に重複再送しない。

## REQ-913 無料枠運用
通常規模で無料枠を優先する。
- AC-913-001 Expired Token、Rate Limit一時データ、期限切れLog/Backup等を自動削除する。
- AC-913-002 無料枠逼迫だけを理由にMust業務機能を停止しない。
- AC-913-003 継続超過時に保守担当者へ知らせ、人がPaid/Provider/構成変更を判断する。
- AC-913-004 自動的に有料PlanへUpgradeしない。

## REQ-914 障害時利用者表示
計画保守・障害・部分障害時に利用者へ理解可能な状態を表示する。
- AC-914-001 計画保守時は可能ならLogin後画面へ告知する。
- AC-914-002 全体利用不能時は専用Maintenance画面を表示できる。
- AC-914-003 部分障害は該当機能付近へ再試行Guidanceを表示し、内部技術情報を露出しない。

## REQ-934 PII削除
生徒削除後、Active System直接管理PIIを24時間以内に削除・匿名化する。
- AC-934-001 氏名、連絡先メール、認証紐付け、直接・間接識別子を対象とする。
- AC-934-002 外部メールProviderの処理保持はProvider Policyに従う例外とする。

## REQ-935 認証可用性
GoogleとMagic Linkを代替認証として提供し、共通基盤障害は重大Incidentとして扱う。
- AC-935-001 共通基盤障害時に「代替認証があるため正常」とみなさない。

## REQ-940 監査Logging
重要業務操作を必要最小限で監査可能にする。
- AC-940-001 時刻、操作種別、Actor ID、対象種別、最小限のBefore/After、結果を基本項目とする。
- AC-940-002 氏名・メールを必要なく複製しない。
- AC-940-003 業務監査Logは1年保持後自動削除する。
- AC-940-004 技術・Error・Securityの一時Logは原則30日程度で自動削除する。
- AC-940-005 PII削除要求がLog保持期間より優先する。

## REQ-942 監視・重大Incident
DB接続不能、広範な予約API失敗、Reminder Job停止、認証全体障害、Backup失敗等を検知可能にする。
- AC-942-001 重大Incidentは保守担当者へ集約通知する。
- AC-942-002 Mail Platform障害時も可能な範囲でLog/Monitoringに記録を残す。

## REQ-951 Provider分離
外部Provider固有処理をAdapter等に局所化する。
- AC-951-001 Resend、Google認証等の交換が業務Domain全体の書換えを要求しない構造とする。

## REQ-952 Backup Privacy
Backup内PIIを通常業務で検索・参照せず、Retention終了で削除する。
- AC-952-001 旧Backupから復旧する場合、削除済み生徒のPurge/匿名化を通常Service復旧前または同時に再適用する。
