# forksync

Zero-dependency Node 24 ESM CLI for auditing GitHub forks against local clones, safely syncing behind forks with upstream, and pruning merged local branches.

## Safety Defaults

Every mutating subcommand (`sync` and `prune-branches`) runs in **dry-run mode by default** and makes zero changes unless `--apply` is explicitly passed.

> Windows PowerShell note: use `npm.cmd` (for example `npm.cmd test`) when PowerShell execution policy blocks `npm.ps1`.

## Usage

```bash
# Audit forks on GitHub, map to local clones, check behind/ahead vs upstream, and list merged PR branches
node ./bin/forksync.js audit --owner @me --projects-dir D:\Codex\Projects
node ./bin/forksync.js audit --json

# Sync forks that are behind upstream (dry-run by default; pass --apply to execute gh repo sync)
node ./bin/forksync.js sync --owner @me
node ./bin/forksync.js sync --repo my-fork --apply

# Prune local branches already merged into base (dry-run by default; pass --apply to delete)
node ./bin/forksync.js prune-branches D:\Codex\Projects\my-fork
node ./bin/forksync.js prune-branches D:\Codex\Projects\my-fork --apply
node ./bin/forksync.js prune-branches D:\Codex\Projects\my-fork --apply --force
```

## Testing

```bash
node --test
# or on Windows PowerShell:
npm.cmd test
```
