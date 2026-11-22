import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runCli } from '../src/cli.js';
import { runGit, listLocalBranches } from '../src/git.js';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN_PATH = path.join(PROJECT_ROOT, 'bin', 'forksync.js');

function gitInitCommit(repoDir, fileName, content, message) {
  fs.writeFileSync(path.join(repoDir, fileName), content, 'utf8');
  runGit(repoDir, ['add', fileName]);
  runGit(repoDir, ['commit', '-m', message]);
}

function createTempGitWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forksync-test-'));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  const projectsDir = path.join(root, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });

  const cloneDir = path.join(projectsDir, 'widget');
  fs.mkdirSync(cloneDir, { recursive: true });

  runGit(cloneDir, ['init', '-b', 'main']);
  runGit(cloneDir, ['config', 'user.email', 'test@example.com']);
  runGit(cloneDir, ['config', 'user.name', 'Test User']);
  runGit(cloneDir, ['remote', 'add', 'origin', 'https://github.com/epbal/widget.git']);
  runGit(cloneDir, ['remote', 'add', 'upstream', 'https://github.com/upstream-org/widget.git']);

  gitInitCommit(cloneDir, 'README.md', '# Widget\n', 'Initial commit');

  // Create a merged feature branch
  runGit(cloneDir, ['checkout', '-b', 'feat-merged']);
  gitInitCommit(cloneDir, 'merged.txt', 'merged feature\n', 'Add merged feature');
  runGit(cloneDir, ['checkout', 'main']);
  runGit(cloneDir, ['merge', '--no-ff', 'feat-merged', '-m', 'Merge feat-merged']);

  // Record upstream/main remote-tracking ref and advance it 2 commits ahead of local main
  const mainSha = runGit(cloneDir, ['rev-parse', 'HEAD']).stdout.trim();
  runGit(cloneDir, ['checkout', '--detach', mainSha]);
  gitInitCommit(cloneDir, 'upstream1.txt', 'u1\n', 'Upstream commit 1');
  gitInitCommit(cloneDir, 'upstream2.txt', 'u2\n', 'Upstream commit 2');
  const upstreamSha = runGit(cloneDir, ['rev-parse', 'HEAD']).stdout.trim();
  runGit(cloneDir, ['update-ref', 'refs/remotes/upstream/main', upstreamSha]);
  runGit(cloneDir, ['checkout', 'main']);

  // Create an unmerged local branch with unique work
  runGit(cloneDir, ['checkout', '-b', 'feat-wip']);
  gitInitCommit(cloneDir, 'wip.txt', 'work in progress\n', 'WIP commit');
  runGit(cloneDir, ['checkout', 'main']);

  return { root, projectsDir, cloneDir };
}

function collectProjectFiles(dir) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectProjectFiles(full));
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

test('audit maps forks to local clones, reports behind/ahead status, and lists merged upstream PR branches', async (t) => {
  const { projectsDir, cloneDir } = createTempGitWorkspace(t);

  const mockRunner = async (args) => {
    if (args[0] === 'repo' && args[1] === 'list') {
      return JSON.stringify([
        {
          name: 'widget',
          nameWithOwner: 'epbal/widget',
          owner: { login: 'epbal' },
          url: 'https://github.com/epbal/widget',
          defaultBranchRef: { name: 'main' },
          parent: {
            name: 'widget',
            nameWithOwner: 'upstream-org/widget',
            owner: { login: 'upstream-org' },
            defaultBranchRef: { name: 'main' }
          }
        },
        {
          name: 'remote-only',
          nameWithOwner: 'epbal/remote-only',
          owner: { login: 'epbal' },
          url: 'https://github.com/epbal/remote-only',
          defaultBranchRef: { name: 'main' },
          parent: {
            name: 'remote-only',
            nameWithOwner: 'upstream-org/remote-only',
            owner: { login: 'upstream-org' },
            defaultBranchRef: { name: 'main' }
          }
        }
      ]);
    }
    if (args[0] === 'api' && args[1].includes('epbal/widget/compare/')) {
      return JSON.stringify({ status: 'behind', ahead_by: 0, behind_by: 2 });
    }
    if (args[0] === 'api' && args[1].includes('epbal/remote-only/compare/')) {
      return JSON.stringify({ status: 'identical', ahead_by: 0, behind_by: 0 });
    }
    if (args[0] === 'pr' && args[1] === 'list' && args.includes('upstream-org/widget')) {
      return JSON.stringify([
        {
          number: 105,
          title: 'Add merged feature',
          headRefName: 'feat-merged',
          mergedAt: '2026-11-20T00:00:00Z',
          url: 'https://github.com/upstream-org/widget/pull/105'
        },
        {
          number: 109,
          title: 'Fix remote typo',
          headRefName: 'fix-typo-pr',
          mergedAt: '2026-11-21T00:00:00Z',
          url: 'https://github.com/upstream-org/widget/pull/109'
        }
      ]);
    }
    return '[]';
  };

  let out = '';
  const exitCode = await runCli(['audit', '--projects-dir', projectsDir, '--json'], {
    runner: mockRunner,
    stdout: (s) => {
      out += s;
    },
    stderr: () => {}
  });

  assert.equal(exitCode, 0);
  const report = JSON.parse(out);
  assert.equal(report.totalForks, 2);
  assert.equal(report.mappedLocalCount, 1);
  assert.equal(report.behindCount, 1);

  const widget = report.forks.find((f) => f.name === 'widget');
  assert.ok(widget);
  assert.equal(widget.behind, 2);
  assert.equal(widget.ahead, 0);
  assert.equal(widget.localClones.length, 1);
  assert.equal(widget.localClones[0].path, cloneDir);
  assert.equal(widget.localClones[0].behind, 2);

  const branchNames = widget.mergedBranches.map((b) => b.branch).sort();
  assert.deepEqual(branchNames, ['feat-merged', 'fix-typo-pr']);
  const bothEntry = widget.mergedBranches.find((b) => b.branch === 'feat-merged');
  assert.equal(bothEntry.source, 'both');
});

test('sync is dry-run by default and runs gh repo sync only on behind forks with --apply', async () => {
  const syncCalls = [];
  const mockRunner = async (args) => {
    if (args[0] === 'repo' && args[1] === 'list') {
      return JSON.stringify([
        {
          name: 'behind-fork',
          nameWithOwner: 'epbal/behind-fork',
          owner: { login: 'epbal' },
          defaultBranchRef: { name: 'main' },
          parent: {
            name: 'behind-fork',
            nameWithOwner: 'org/behind-fork',
            owner: { login: 'org' },
            defaultBranchRef: { name: 'main' }
          }
        },
        {
          name: 'fresh-fork',
          nameWithOwner: 'epbal/fresh-fork',
          owner: { login: 'epbal' },
          defaultBranchRef: { name: 'main' },
          parent: {
            name: 'fresh-fork',
            nameWithOwner: 'org/fresh-fork',
            owner: { login: 'org' },
            defaultBranchRef: { name: 'main' }
          }
        }
      ]);
    }
    if (args[0] === 'api' && args[1].includes('epbal/behind-fork/compare/')) {
      return JSON.stringify({ status: 'behind', ahead_by: 0, behind_by: 4 });
    }
    if (args[0] === 'api' && args[1].includes('epbal/fresh-fork/compare/')) {
      return JSON.stringify({ status: 'identical', ahead_by: 0, behind_by: 0 });
    }
    if (args[0] === 'repo' && args[1] === 'sync') {
      syncCalls.push(args);
      return '';
    }
    throw new Error(`Unexpected gh args: ${args.join(' ')}`);
  };

  // Dry run (no --apply)
  let dryOut = '';
  const dryExit = await runCli(['sync', '--json'], {
    runner: mockRunner,
    stdout: (s) => {
      dryOut += s;
    },
    stderr: () => {}
  });
  assert.equal(dryExit, 0);
  assert.equal(syncCalls.length, 0, 'Dry-run sync must never invoke gh repo sync');
  const dryParsed = JSON.parse(dryOut);
  assert.equal(dryParsed.dryRun, true);
  assert.equal(dryParsed.behindCount, 1);
  assert.equal(dryParsed.syncedCount, 0);
  assert.equal(dryParsed.results[0].action, 'would-sync');
  assert.equal(dryParsed.results[1].action, 'up-to-date');

  // Apply (--apply)
  let applyOut = '';
  const applyExit = await runCli(['sync', '--apply', '--json'], {
    runner: mockRunner,
    stdout: (s) => {
      applyOut += s;
    },
    stderr: () => {}
  });
  assert.equal(applyExit, 0);
  assert.equal(syncCalls.length, 1, 'Apply sync must only sync forks that are behind upstream');
  assert.deepEqual(syncCalls[0], ['repo', 'sync', 'epbal/behind-fork', '--branch', 'main']);
  const applyParsed = JSON.parse(applyOut);
  assert.equal(applyParsed.dryRun, false);
  assert.equal(applyParsed.syncedCount, 1);
});

test('prune-branches enforces dry-run default, protects current and unmerged branches unless --force', async (t) => {
  const { cloneDir } = createTempGitWorkspace(t);

  // Create another merged branch and check it out to verify current-branch protection
  runGit(cloneDir, ['checkout', 'main']);
  runGit(cloneDir, ['branch', 'feat-current-merged']);
  runGit(cloneDir, ['checkout', 'feat-current-merged']);

  // 1. Dry-run: nothing deleted
  let dryOut = '';
  const dryCode = await runCli(['prune-branches', cloneDir, '--json'], {
    stdout: (s) => {
      dryOut += s;
    },
    stderr: () => {}
  });
  assert.equal(dryCode, 0);
  const dryReport = JSON.parse(dryOut);
  assert.equal(dryReport.dryRun, true);
  assert.deepEqual(dryReport.wouldDelete, ['feat-merged']);
  assert.ok(listLocalBranches(cloneDir).includes('feat-merged'));

  // 2. --apply without --force: deletes feat-merged, refuses current (feat-current-merged) and unmerged (feat-wip)
  let applyOut = '';
  const applyCode = await runCli(['prune-branches', cloneDir, '--apply', '--json'], {
    stdout: (s) => {
      applyOut += s;
    },
    stderr: () => {}
  });
  assert.equal(applyCode, 0);
  const applyReport = JSON.parse(applyOut);
  assert.deepEqual(applyReport.deleted, ['feat-merged']);
  const refusedReasons = Object.fromEntries(applyReport.refused.map((r) => [r.branch, r.reason]));
  assert.equal(refusedReasons['feat-current-merged'], 'current-branch');
  assert.equal(refusedReasons['feat-wip'], 'unmerged');

  const remainingAfterSafeApply = listLocalBranches(cloneDir);
  assert.equal(remainingAfterSafeApply.includes('feat-merged'), false);
  assert.equal(remainingAfterSafeApply.includes('feat-current-merged'), true);
  assert.equal(remainingAfterSafeApply.includes('feat-wip'), true);
  assert.equal(remainingAfterSafeApply.includes('main'), true);

  // Explicit --branch on unmerged without --force exits 1
  const blockedCode = await runCli(['prune-branches', cloneDir, '--branch', 'feat-wip', '--apply'], {
    stdout: () => {},
    stderr: () => {}
  });
  assert.equal(blockedCode, 1);
  assert.equal(listLocalBranches(cloneDir).includes('feat-wip'), true);

  // 3. --apply --force: switches off current non-base branch to main, deletes both feat-current-merged and feat-wip, keeps main
  let forceOut = '';
  const forceCode = await runCli(['prune-branches', cloneDir, '--apply', '--force', '--json'], {
    stdout: (s) => {
      forceOut += s;
    },
    stderr: () => {}
  });
  assert.equal(forceCode, 0);
  const forceReport = JSON.parse(forceOut);
  assert.deepEqual(forceReport.deleted.sort(), ['feat-current-merged', 'feat-wip']);
  assert.deepEqual(listLocalBranches(cloneDir), ['main']);
});

test('CLI --help and --version exit 0 via binary entrypoint', () => {
  const helpOut = execFileSync(process.execPath, [BIN_PATH, '--help'], { encoding: 'utf8' });
  assert.match(helpOut, /forksync audit/);
  assert.match(helpOut, /forksync sync/);
  assert.match(helpOut, /forksync prune-branches/);

  const versionOut = execFileSync(process.execPath, [BIN_PATH, '--version'], { encoding: 'utf8' });
  assert.equal(versionOut.trim(), '0.1.0');
});

test('repository contains zero U+2014 em dashes across all files', () => {
  const files = collectProjectFiles(PROJECT_ROOT);
  assert.ok(files.length >= 7);
  for (const file of files) {
    const content = fs.readFileSync(file, 'utf8');
    assert.equal(
      content.includes('\u2014'),
      false,
      `Found forbidden U+2014 em dash in ${path.relative(PROJECT_ROOT, file)}`
    );
  }
});
