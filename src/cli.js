import fs from 'node:fs';
import {
  DEFAULT_PROJECTS_DIR,
  auditForks,
  syncForks,
  pruneRepoBranches
} from './index.js';

const pkgUrl = new URL('../package.json', import.meta.url);
const pkg = JSON.parse(fs.readFileSync(pkgUrl, 'utf8'));

export const HELP_TEXT = `forksync v${pkg.version}
Zero-dependency GitHub fork auditor, upstream sync runner, and merged branch pruner.

Usage:
  forksync audit [--owner @me] [--projects-dir ${DEFAULT_PROJECTS_DIR}] [--json]
  forksync sync [--owner @me] [--repo <name>] [--apply] [--json]
  forksync prune-branches <repoDir> [--base <ref>] [--branch <name>] [--apply] [--force] [--json]
  forksync --help | --version

Options:
  --owner <handle>       GitHub owner handle or @me (default: @me)
  --projects-dir <dir>   Local projects root for clone mapping (default: ${DEFAULT_PROJECTS_DIR})
  --repo <name>          Filter sync to a single fork name or owner/name
  --base <ref>           Explicit base ref for prune-branches (auto-detected if omitted)
  --branch <name>        Target a single local branch in prune-branches
  --apply                Execute sync or branch deletion (dry-run by default)
  --force                Allow deleting current or unmerged branches in prune-branches
  --json                 Emit structured JSON output
  -h, --help             Show this help text
  -v, --version          Show package version
`;

function parseCliArgs(argv) {
  const positionals = [];
  const flags = {
    help: false,
    version: false,
    json: false,
    apply: false,
    force: false,
    owner: undefined,
    projectsDir: undefined,
    repo: undefined,
    base: undefined,
    branch: undefined
  };

  const takeValue = (flagName, idx) => {
    if (idx + 1 >= argv.length) {
      throw new Error(`Missing value for ${flagName}`);
    }
    return argv[idx + 1];
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') {
      flags.help = true;
    } else if (arg === '-v' || arg === '--version') {
      flags.version = true;
    } else if (arg === '--json') {
      flags.json = true;
    } else if (arg === '--apply') {
      flags.apply = true;
    } else if (arg === '--force') {
      flags.force = true;
    } else if (arg === '--owner') {
      flags.owner = takeValue('--owner', i);
      i += 1;
    } else if (arg.startsWith('--owner=')) {
      flags.owner = arg.slice('--owner='.length);
    } else if (arg === '--projects-dir') {
      flags.projectsDir = takeValue('--projects-dir', i);
      i += 1;
    } else if (arg.startsWith('--projects-dir=')) {
      flags.projectsDir = arg.slice('--projects-dir='.length);
    } else if (arg === '--repo') {
      flags.repo = takeValue('--repo', i);
      i += 1;
    } else if (arg.startsWith('--repo=')) {
      flags.repo = arg.slice('--repo='.length);
    } else if (arg === '--base') {
      flags.base = takeValue('--base', i);
      i += 1;
    } else if (arg.startsWith('--base=')) {
      flags.base = arg.slice('--base='.length);
    } else if (arg === '--branch') {
      flags.branch = takeValue('--branch', i);
      i += 1;
    } else if (arg.startsWith('--branch=')) {
      flags.branch = arg.slice('--branch='.length);
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positionals.push(arg);
    }
  }

  return { positionals, flags };
}

function formatAuditReport(report) {
  const lines = [
    `Audited ${report.totalForks} fork(s) (owner=${report.owner}, localMapped=${report.mappedLocalCount}, behind=${report.behindCount})`
  ];
  for (const fork of report.forks) {
    const parentInfo = fork.parent ? `<- ${fork.parent.nameWithOwner}:${fork.parent.defaultBranch}` : '(no parent)';
    const clonePaths = fork.localClones.map((c) => c.path).join(', ') || 'none';
    const mergedNames = fork.mergedBranches.map((m) => m.branch).join(', ') || 'none';
    lines.push(
      `- ${fork.nameWithOwner} ${parentInfo} [${fork.status}: behind=${fork.behind}, ahead=${fork.ahead}]`,
      `    local: ${clonePaths}`,
      `    merged branches: ${mergedNames}`
    );
  }
  return `${lines.join('\n')}\n`;
}

function formatSyncReport(report) {
  const modeLabel = report.dryRun ? 'DRY-RUN (pass --apply to sync)' : 'APPLIED';
  const lines = [`Fork sync [${modeLabel}]: checked=${report.checkedCount}, behind=${report.behindCount}, synced=${report.syncedCount}`];
  for (const item of report.results) {
    lines.push(`- ${item.repo}: ${item.action} (behind=${item.behind}, ahead=${item.ahead})`);
  }
  return `${lines.join('\n')}\n`;
}

function formatPruneReport(report) {
  const modeLabel = report.dryRun ? 'DRY-RUN (pass --apply to delete)' : 'APPLIED';
  const lines = [
    `Prune branches in ${report.repoDir} [${modeLabel}] (base=${report.baseRef}, current=${report.currentBranch ?? 'detached'})`,
    `  Merged into base: ${report.mergedBranches.join(', ') || 'none'}`
  ];
  if (report.dryRun) {
    lines.push(`  Would delete:     ${report.wouldDelete.join(', ') || 'none'}`);
  } else {
    lines.push(`  Deleted:          ${report.deleted.join(', ') || 'none'}`);
  }
  if (report.refused.length > 0) {
    const refusedDesc = report.refused.map((r) => `${r.branch} (${r.reason})`).join(', ');
    lines.push(`  Refused/kept:     ${refusedDesc}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function runCli(argv, options = {}) {
  const writeOut = options.stdout ?? ((msg) => process.stdout.write(msg));
  const writeErr = options.stderr ?? ((msg) => process.stderr.write(msg));

  let parsed;
  try {
    parsed = parseCliArgs(argv);
  } catch (err) {
    writeErr(`Error: ${err.message}\n`);
    return 2;
  }

  const { positionals, flags } = parsed;
  if (flags.version) {
    writeOut(`${pkg.version}\n`);
    return 0;
  }
  if (flags.help || positionals.length === 0) {
    writeOut(HELP_TEXT);
    return 0;
  }

  const subcommand = positionals[0];

  try {
    if (subcommand === 'audit') {
      const report = await auditForks({
        owner: flags.owner ?? '@me',
        projectsDir: flags.projectsDir ?? DEFAULT_PROJECTS_DIR,
        runner: options.runner,
        cwd: options.cwd
      });
      if (flags.json) {
        writeOut(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        writeOut(formatAuditReport(report));
      }
      return 0;
    }

    if (subcommand === 'sync') {
      const report = await syncForks({
        owner: flags.owner ?? '@me',
        repo: flags.repo,
        apply: flags.apply,
        projectsDir: flags.projectsDir,
        runner: options.runner,
        cwd: options.cwd
      });
      if (flags.json) {
        writeOut(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        writeOut(formatSyncReport(report));
      }
      return 0;
    }

    if (subcommand === 'prune-branches') {
      const repoDir = positionals[1];
      if (!repoDir) {
        writeErr('Error: Missing <repoDir> for "forksync prune-branches".\n');
        return 2;
      }
      const report = pruneRepoBranches(repoDir, {
        base: flags.base,
        branch: flags.branch,
        apply: flags.apply,
        force: flags.force
      });
      if (flags.json) {
        writeOut(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        writeOut(formatPruneReport(report));
      }
      return report.blockedTarget ? 1 : 0;
    }

    writeErr(`Error: Unknown command "${subcommand}". Run "forksync --help" for usage.\n`);
    return 2;
  } catch (err) {
    writeErr(`Error: ${err.message}\n`);
    return 2;
  }
}
