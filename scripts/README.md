# Scripts

Maintenance, backup, validation, and project utility scripts live here.

## 人間管理のCodex Local受け渡し（#1086）

Windows PowerShellでリポジトリルートに移動し、既存Git・GitHub CLI認証・Python 3・Git Bashを使用する。
Windowsでは、Git for Windowsの`git.exe`が通常のPATHで使えれば、同じインストール先の`bin/bash.exe`をCLIが直接検出する。PowerShell profileやユーザー/システムPATHを補正する必要はない。検出に失敗した場合は停止し、`git.exe`がGit for Windowsの`cmd/`または`bin/`から解決できることを確認する。WSLの`bash.exe`で代用しない。

```powershell
python scripts/local_development.py prepare 1086
```

開始前にIssueの未決事項・停止record・writer重複・scopeをGitHubで確認し、画面に出る `YES <Issue番号>` で承認する。成功すると `human/issue-N-local` とignored `.ai-context/` の必須3ファイルができる。**Codex Localには編集・有限検証のみ**を依頼し、branch/commit/push/PR/Issueの操作は禁止のまま。

開発後は実差分・対応Issue・検証結果・秘密値を目視で確認してから同じターミナルで実行する。

```powershell
python scripts/local_development.py submit
```

対象ファイル一覧を確認してstage承認、既存 `evaluate-codex-diff-gate.sh` の `pass` 確認後にcommit / non-force push / Draft PRの最終承認を行う。`submit` は **初回Draft提出専用**。途中でcommit、push、PRだけが成立した場合は再実行せずGitHubの実状態を確認する。自動Ready、Claude review起動、merge、human pause解消は行わない。独立レビュー・最新HEADのLinked Issue/Product CI・手動squash mergeは既存規約の別Gateで実施。

この補助CLIはGitHub Actionsの正式developer App/writer/pause保証を再現しない。`human-review-required`、active pause record、他writer、未決要求、protected path、変更されたmainやコードオーナー承認が必要なら停止し、通常のIssue判断に戻す。実Windowsでの確認・操作削減量は#995で評価する。

Python標準ライブラリのテスト（GitHubへの書込みなし）：

```powershell
python -m unittest discover -s scripts -p test_local_development.py
```
