# AIワークフローE2Eスモークテスト記録

本書は、bootstrap完了後に実施するEnd-to-Endスモークテストの記録である。

テストIssue #39と、その結果として作成されるPull RequestをGitHub上の監査証跡とする。

このスモークテストでは、プロダクト要求、設計、ソースコード、テスト仕様を変更しない。

本ファイルは、AI開発・Claudeレビューの運用検証記録としてリポジトリに残してよい。

## 実施結果（2026-09-01）

Issue #38の正常系E2Eでは、次を確認した。

- Issue #39の `/codex develop` を起点にdeveloper AppがPull Request #40を作成した。
- `PR Traceability / Linked Issue` が成功した。
- Claude Appが最新headを承認した。
- 初回の `Merge approved PR` は、GitHub CLIが返す `app/<slug>` actor表記をmerge gateが許容していなかったため失敗した。
- Issue #41 / Pull Request #42でGitHub CLIが返す `app/<slug>` actor表記の正規化へ対応した。
- 人間がPull Request #40の基準点を対応後の最新 `main` へ更新し、ワークフローを再実行した。
- `Merge approved PR` が成功し、reviewer AppがPull Request #40をsquash mergeした。
- Pull Request #40の `Closes #39` によりIssue #39が自動的にcloseされた。

確認時の `main` は `c98ed3f3219c6551a699ff9c7efa70e280ec5fba` である。

## 未完了の外部設定・確認

次の項目はリポジトリ外の管理操作または実通知を必要とし、本記録の時点では完了を確認していない。

- Discord Webhookを準備し、Repository secret `NOTIFICATION_WEBHOOK_URL` を登録する。
- secret値をIssue、Pull Request、Actionsログへ露出させず、要求変更マーカーまたは3回目のchange requestを使う安全なテストで、`human-review-required` による停止とDiscordへの実通知を確認する。
- default branch rulesetのrequired status checkへ、観測済みの `PR Traceability / Linked Issue` を追加し、有効になったことを確認する。

これらの完了証跡はIssue #46へ記録する。secret値そのものは記録しない。
