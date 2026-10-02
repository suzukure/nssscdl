<!-- #654本文相当の再構成。供給された#687修正要件のDone内Product影響表記と、repositoryの#654仕様に基づく。実Issue本文の取得copyではない。 -->
Parent: #650
Depends on: #652

## Goal

npm local file / directory / workspace sourceがhost filesystemへescapeしないことを、独立したdisposable RootDirectoryで検証する。

## Scope

- #645のmanifest policyでfile: / relative・absolute directory / traversal / symlink sourceとworkspacesをnpm開始前に拒否する。
- Node / npm / trusted probeだけをstageし、Product workspaceやhostの/usr / /lib全体をbindしない。
- arbitrary host package / tarballを同一UIDの前後controlで読めることと、restricted serviceから参照できないことを確認する。
- pure / mock fixtureと独立systemd runnerで2 fresh rootsを検証し、成功・失敗時ともcleanupする。

## Security boundary

- RootDirectory内のvisible source rootは/projectに固定する。
- nobody UID、NoNewPrivileges、capability除去、既存socket mask・io_uring filter・network propertiesを維持する。
- Secrets / GitHub write tokenを渡さず、host filesystemへのfallbackやretryを行わない。
- staged directoryの未知の可視contentと予期しない検査errorはnpm開始前にfail-closedとする。

## Non-goals

- production developer / follow-upへの配線。
- external network proofの再実行。
- lifecycle script非実行の実証、initial lock生成、Product仕様変更。

## Done

- local filesystem source policyと実効filesystem境界を独立検証できる。
- host source参照拒否と隔離外の前後control成功を確認できる。
- fresh root / unit / fixtureを成功・失敗時ともcleanupする。
- AI Workflow Regressionとgit diff --checkを確認する。
- Product影響: none。

## Scope-out impact and follow-up

- 後続の順序: #656 → #650 → #647。
- lifecycle / initial lock / production wiringは後続Issueで扱う。
