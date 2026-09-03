# 一括予約機能テスト仕様

## 1. 位置づけ

本書は、`REQ-008 / AC-008-001〜009` および `BR-069` に対する要求ベースの System / Acceptance Test Case Specification である。

一括予約は `REQ-003` の単一予約を置き換えない。本書は既存の `02_FunctionalTestSpecification.md`、`02a_ReservationOwnershipTestSpecification.md`、および `02b_RequirementsV1.6V1.7TestSpecification.md` を補完し、テストケースIDは `TC-F-008-*` 系列とする。

期待結果は要求仕様および基本設計の業務結果を正とする。API Path、JSON Field、Expected State の表現方式、操作識別子の具体Field、HTTP Response Schema、SQL、Lock、Constraint その他の詳細設計事項をOracleとして固定しない。

## 2. テストケース

### REQ-008 生徒一括予約

| TC ID | 対応AC | P | 技法 | 前提・手順 | 期待結果 | 自動化 |
|---|---|:---:|---|---|---|---|
| `TC-F-008-01` | AC-008-001 | P0 | Use-case / 同値分割 | S1の公開済み将来同月に、予約可能な複数Slotを用意する。選択集合全体を追加するとstandardとadditionalが混在する状態で、S1が一括Previewする。続けて、同一選択へ翌月のSlotを1件加えた一括Previewを試みる。 | 同月の複数Slotについて、全対象のLesson日時およびPreview時のstandard / additionalを最終確定前に確認でき、additional対象を明瞭に識別できる。複数月にまたがる選択は一括予約として受け付けられず、予約状態を変更しない。 | 自動化候補 |
| `TC-F-008-02` | AC-008-002, AC-008-003 | P0 | 境界値分析 / Decision Table | S1の対象月で最新Nを3とし、既存予約を含めた当月の予約件数をNより多くできる状態を用意する。選択数がN件およびN+1件となる一括Previewをそれぞれ試みる。N件の選択にはadditionalとなる対象を含める。 | 選択数が最新N以下の一括Previewは、additional対象を含んでも継続できる。N+1件の選択は受け付けられず、状態を変更しない。Nを月全体の予約件数上限として扱わず、既存予約を含めた件数だけを理由に拒否しない。 | 自動化候補 |
| `TC-F-008-03` | AC-008-004 | P0 | State validation / 境界値分析 | S1が複数の将来空きSlotを選択する。Preview実行時点で、最新N、公開状態、各Slotの予約可能状態、現在占有、およびServer時刻で開始前であることを個別に成立／不成立へ制御して一括Previewする。 | ServerはPreview時の最新確定状態から、選択全体のN上限および各対象Slotの予約可否・予約期限その他の確定に必要な状態を検証する。不成立の選択はPreviewから確定へ進めず、Preview自体は予約、占有、classification等の確定業務状態を変更しない。 | 自動化候補 |
| `TC-F-008-04` | AC-008-005, AC-008-006, AC-008-007 | P0 | Concurrency / Atomicity / Error abstraction | S1が複数Slotの一括Previewを取得する。Preview後に、(a) S2が選択Slotの一部を先行予約、(b) A1が最新Nまたは対象Slotの公開・予約可能状態を変更、(c) Server Commit時刻が対象Slotの開始時刻に到達、(d) 同月の状態変更により新規または選択対象外既存未開始Reservationのclassification影響が変化、の各条件を個別に作る。S1が元の確認内容で一括Confirmする。 | Confirm時に選択全体の最新N、対象月、各Slotの予約可否・予約期限・現在占有、classificationおよび選択対象外の既存未開始Reservationへの区分影響を再検証する。いずれかが不成立またはPreview時の重要状態と不一致なら、全対象を未適用として再確認へ戻す。選択の一部だけのReservation、占有、再分類、監査記録、通知義務を正常結果として残さない。競合Responseは、安全に検出できた問題対象、業務上の理由、最新状態または再Previewのための情報を示し、他生徒の氏名・内部生徒ID・Reservation ID等の個人情報、およびDatabase / SQL / Constraint / 内部Table・Column名を表示しない。全競合の完全列挙は要求しない。 | 自動化候補 |
| `TC-F-008-05` | AC-008-005, AC-008-006 | P0 | Expected State / Stale Preview | S1が複数Slotを一括Previewし、選択Slot集合、対象月、最新N、予約可能状態、新規Reservationのclassification、選択対象外の既存未開始Reservationへの区分影響を確認する。Preview後にこれらの業務上の意味のいずれかが変化するよう先行Commitさせ、S1がPreviewで得た確認情報を用いてConfirmする。 | Clientの確認情報を更新値・正本として扱わず、Serverが最新確定状態から再計算した結果との一致を確認する。不一致時は一括Confirmを全体未適用とし、再Preview／再確認を要求する。Expected State相当情報のRevision、Fingerprint、Token等の具体表現は合否条件としない。 | 自動化候補 |
| `TC-F-008-06` | AC-008-008 | P0 | Authorization / Tampering | S1で認証し、同月の複数予約可能Slotの一括Confirmを行う。Confirm時のクライアント入力にS2の生徒ID・氏名・メール・Google ID、または存在しない生徒識別情報を個別に混入・差し替えて試みる。 | 一括確定した各Reservationの予約者は、認証済みS1の内部生徒IDとなる。クライアント入力によってS2または存在しない生徒を予約者として確定できず、他生徒・架空生徒のReservationは生成されない。 | 自動化候補 |
| `TC-F-008-07` | AC-008-009 | P0 | Decision Table / Preview | S1の同月に、既存未開始Reservation `R3 < R4 < R5` をstandardで用意する。選択全体を追加すると、選択対象外のR5が `standard → additional` となる、より早い複数の将来空きSlotをS1が一括Previewする。 | 最終確定前に、選択対象外で影響するR5のLesson日時、変更前classification、変更後classificationを明瞭に確認できる。新規Reservationのclassification表示だけで代替しない。影響がない場合の空集合表現や文言は合否条件としない。 | 自動化候補 |
| `TC-F-008-08` | AC-008-005, AC-008-006 | P0 | Idempotency / Retry | S1が有効な一括Preview後、同一の選択Slot集合および確認情報で一括Confirmする。通信結果が利用者へ届かない状況を模擬し、同一操作を識別する情報で同一内容のConfirmを再送する。続けて、同じ操作識別子を選択Slot集合または確認情報が異なるConfirmへ再利用する。 | 同一内容の再送では、先に確定した同一操作の結果を取得でき、新たなReservation、占有、再分類、監査記録または通知義務を重複して作成しない。異なる内容での同一操作識別子再利用は、別操作として実行されずRejectされる。操作識別子のField名、保存期間、同一性比較方法、および成功／RejectのWire表現は合否条件としない。 | 自動化候補 |

## 3. 合否判定上の注意

- 一括ConfirmのAll-or-Nothingは、選択SlotのReservationだけでなく、現在占有、必要な再分類、監査記録および通知義務を含む一括操作の確定業務状態について判定する。ただし、外部通知の配信成功そのものを一括予約Transactionの成功条件にしない。
- Conflictの合格条件は、安全に検出できた範囲の説明と再確認可能性であり、競合またはclassification影響の完全列挙ではない。
- Expected State相当情報は、Preview後の業務状態変化を検出するための確認情報であり、再送時の二重確定防止を代替しない。操作識別子も、Confirm時の最新状態再検証を省略させない。
- 一括予約の確定後に選択対象外Reservationのclassificationが変化した場合の通知・画面更新は、既存の `REQ-104` テストで確認する。本書では `AC-008-009` に従う確定前表示を判定する。

## 4. 回帰セット

本追補の変更時は、少なくとも以下を回帰対象とする。

- `TC-F-003-01`, `TC-F-003-02`, `TC-F-003-04`, `TC-F-003-05` — 単一予約、additional表示、開始時刻境界、Confirm時競合再検証
- `TC-F-003-06`, `TC-F-003-07` — 単一予約の所有者同一性とクライアント入力改ざん防止
- `TC-F-003-08`, `TC-F-003-09` — 既存未開始Reservationへの区分影響表示とStale Preview
- `TC-F-104-01`, `TC-F-104-02` — 確定後の区分変更通知・画面表示
- `TC-NF-911-01`, `TC-NF-911-02` — 競合整合性
- `TC-NF-914-03`, `TC-NF-914-04` — 利用者向けエラー表現・内部情報非露出
