import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const SKIP_DIRS = new Set(['.git', '.cache', 'node_modules', '$RECYCLE.BIN', 'System Volume Information']);

export function parseGitHubSlug(remoteUrl) {
  if (typeof remoteUrl !== 'string' || !remoteUrl.trim()) {
    return null;
  }
  const trimmed = remoteUrl.trim();
  const httpsMatch = /^https?:\/\/github\.com\/([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (httpsMatch) {
    return `${httpsMatch[1]}/${httpsMatch[2]}`.toLowerCase();
  }
  const sshMatch = /^(?:ssh:\/\/)?git@github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (sshMatch) {
    return `${sshMatch[1]}/${sshMatch[2]}`.toLowerCase();
  }
  return null;
}

export function runGit(repoDir, args, options = {}) {
  const res = spawnSync('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
    windowsHide: true
  });
  const stdout = String(res.stdout ?? '');
  const stderr = String(res.stderr ?? '');
  const exitCode = typeof res.status === 'number' ? res.status : 1;

  if (exitCode !== 0 && !options.allowFailure) {
    throw new Error(`git ${args.join(' ')} failed in ${repoDir}: ${(stderr || stdout).trim()}`);
  }
  return { exitCode, stdout, stderr };
}

export function isGitRepo(repoDir) {
  if (!repoDir || !fs.existsSync(repoDir)) {
    return false;
  }
  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    const check = runGit(repoDir, ['rev-parse', '--is-inside-work-tree'], { allowFailure: true });
    return check.exitCode === 0 && check.stdout.trim() === 'true';
  }
  return true;
}

export function getRepoRemotes(repoDir) {
  const res = runGit(repoDir, ['remote', '-v'], { allowFailure: true });
  if (res.exitCode !== 0) {
    return [];
  }
  const byName = new Map();
  for (const line of res.stdout.split(/\r?\n/)) {
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim());
    if (!match) {
      continue;
    }
    const [, name, url, kind] = match;
    if (!byName.has(name) || kind === 'fetch') {
      byName.set(name, {
        name,
        url,
        slug: parseGitHubSlug(url)
      });
    }
  }
  return [...byName.values()];
}

export function scanLocalClones(projectsDir) {
  if (!projectsDir || !fs.existsSync(projectsDir)) {
    return [];
  }
  const absProjects = path.resolve(projectsDir);
  let entries;
  try {
    entries = fs.readdirSync(absProjects, { withFileTypes: true });
  } catch {
    return [];
  }

  const clones = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) {
      continue;
    }
    const candidate = path.join(absProjects, entry.name);
    if (!fs.existsSync(path.join(candidate, '.git'))) {
      continue;
    }
    const remotes = getRepoRemotes(candidate);
    clones.push({
      path: candidate,
      dirName: entry.name,
      remotes
    });
  }
  return clones;
}

function refExists(repoDir, ref) {
  const res = runGit(repoDir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
    allowFailure: true
  });
  return res.exitCode === 0;
}

export function getAheadBehind(repoDir, upstreamRef, localRef) {
  const res = runGit(repoDir, ['rev-list', '--left-right', '--count', `${upstreamRef}...${localRef}`], {
    allowFailure: true
  });
  if (res.exitCode !== 0) {
    return null;
  }
  const parts = res.stdout.trim().split(/\s+/);
  if (parts.length < 2) {
    return null;
  }
  const behind = Number.parseInt(parts[0], 10);
  const ahead = Number.parseInt(parts[1], 10);
  if (!Number.isFinite(behind) || !Number.isFinite(ahead)) {
    return null;
  }
  return { ahead, behind };
}

export function listLocalBranches(repoDir) {
  const res = runGit(repoDir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/'], {
    allowFailure: true
  });
  if (res.exitCode !== 0) {
    return [];
  }
  return res.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function getCurrentBranch(repoDir) {
  const res = runGit(repoDir, ['branch', '--show-current'], { allowFailure: true });
  if (res.exitCode !== 0) {
    return null;
  }
  const branch = res.stdout.trim();
  return branch || null;
}

export function isWorktreeDirty(repoDir) {
  const res = runGit(repoDir, ['status', '--porcelain'], { allowFailure: true });
  return res.exitCode === 0 && res.stdout.trim().length > 0;
}

export function isBranchMergedInto(repoDir, branchName, baseRef) {
  const res = runGit(repoDir, ['merge-base', '--is-ancestor', `refs/heads/${branchName}`, baseRef], {
    allowFailure: true
  });
  return res.exitCode === 0;
}

export function resolveBaseRef(repoDir, explicitBase) {
  if (explicitBase) {
    if (!refExists(repoDir, explicitBase)) {
      throw new Error(`Base ref "${explicitBase}" does not exist in ${repoDir}.`);
    }
    return explicitBase;
  }

  const candidates = [
    'upstream/main',
    'upstream/master',
    'origin/main',
    'origin/master',
    'main',
    'master'
  ];
  for (const candidate of candidates) {
    if (refExists(repoDir, candidate)) {
      return candidate;
    }
  }
  if (refExists(repoDir, 'HEAD')) {
    return getCurrentBranch(repoDir) ?? 'HEAD';
  }
  throw new Error(`Could not resolve a base branch in ${repoDir}.`);
}

export function cloneMatchesFork(clone, fork) {
  const forkSlug = fork.nameWithOwner.toLowerCase();
  const parentSlug = fork.parent?.nameWithOwner?.toLowerCase() ?? null;
  const forkNameLower = fork.name.toLowerCase();
  const dirLower = clone.dirName.toLowerCase();

  for (const remote of clone.remotes) {
    if (remote.slug === forkSlug) {
      return true;
    }
  }
  if (dirLower === forkNameLower || dirLower.endsWith(`-${forkNameLower}`)) {
    if (parentSlug && clone.remotes.some((r) => r.slug === parentSlug)) {
      return true;
    }
    if (
      clone.remotes.some((r) => {
        const cleanUrl = r.url.replace(/\\/g, '/').replace(/\.git\/?$/i, '').toLowerCase();
        return cleanUrl.endsWith(`/${forkNameLower}`) || cleanUrl.endsWith(`/${forkSlug}`);
      })
    ) {
      return true;
    }
  }
  return false;
}

export function inspectMappedClone(clone, fork) {
  const parentSlug = fork.parent?.nameWithOwner?.toLowerCase() ?? null;
  const parentBranch = fork.parent?.defaultBranch ?? fork.defaultBranch ?? 'main';
  const forkBranch = fork.defaultBranch ?? 'main';

  let upstreamRemoteName = null;
  for (const remote of clone.remotes) {
    if (parentSlug && remote.slug === parentSlug) {
      upstreamRemoteName = remote.name;
      break;
    }
  }
  if (!upstreamRemoteName && clone.remotes.some((r) => r.name === 'upstream')) {
    upstreamRemoteName = 'upstream';
  }

  let upstreamRef = null;
  if (upstreamRemoteName && refExists(clone.path, `${upstreamRemoteName}/${parentBranch}`)) {
    upstreamRef = `${upstreamRemoteName}/${parentBranch}`;
  } else if (refExists(clone.path, `upstream/${parentBranch}`)) {
    upstreamRef = `upstream/${parentBranch}`;
  } else if (refExists(clone.path, `origin/${forkBranch}`)) {
    upstreamRef = `origin/${forkBranch}`;
  } else if (refExists(clone.path, forkBranch)) {
    upstreamRef = forkBranch;
  }

  const localRef = refExists(clone.path, forkBranch) ? forkBranch : 'HEAD';
  const divergence = upstreamRef ? getAheadBehind(clone.path, upstreamRef, localRef) : null;

  const protectedNames = new Set(['main', 'master', forkBranch, parentBranch]);
  const allBranches = listLocalBranches(clone.path);
  const mergedLocalBranches = [];
  if (upstreamRef) {
    for (const branch of allBranches) {
      if (!protectedNames.has(branch) && isBranchMergedInto(clone.path, branch, upstreamRef)) {
        mergedLocalBranches.push(branch);
      }
    }
  }

  return {
    path: clone.path,
    currentBranch: getCurrentBranch(clone.path),
    dirty: isWorktreeDirty(clone.path),
    upstreamRef,
    localRef,
    ahead: divergence?.ahead ?? null,
    behind: divergence?.behind ?? null,
    mergedLocalBranches
  };
}

export function pruneRepoBranches(repoDir, options = {}) {
  const absRepo = path.resolve(repoDir);
  if (!isGitRepo(absRepo)) {
    throw new Error(`Not a git repository: ${absRepo}`);
  }

  const apply = Boolean(options.apply);
  const force = Boolean(options.force);
  const targetBranch = options.branch ? String(options.branch) : null;

  const baseRef = resolveBaseRef(absRepo, options.base);
  const baseShort = baseRef.includes('/') ? baseRef.split('/').slice(1).join('/') : baseRef;
  const protectedBranches = new Set(['main', 'master', baseRef, baseShort]);

  const currentBranch = getCurrentBranch(absRepo);
  const allBranches = listLocalBranches(absRepo);

  if (targetBranch && !allBranches.includes(targetBranch)) {
    throw new Error(`Branch "${targetBranch}" does not exist in ${absRepo}.`);
  }

  const mergedBranches = [];
  for (const branch of allBranches) {
    if (!protectedBranches.has(branch) && isBranchMergedInto(absRepo, branch, baseRef)) {
      mergedBranches.push(branch);
    }
  }
  const mergedSet = new Set(mergedBranches);

  const candidatesToInspect = targetBranch
    ? [targetBranch]
    : allBranches.filter((b) => !protectedBranches.has(b));

  const wouldDelete = [];
  const deleted = [];
  const refused = [];
  let switchedToBase = null;

  for (const branch of candidatesToInspect) {
    if (protectedBranches.has(branch)) {
      refused.push({ branch, reason: 'protected-base', merged: true });
      continue;
    }

    const isCurrent = branch === currentBranch;
    const isMerged = mergedSet.has(branch);

    if (isCurrent && !force) {
      refused.push({ branch, reason: 'current-branch', merged: isMerged });
      continue;
    }

    if (!isMerged && !force) {
      refused.push({ branch, reason: 'unmerged', merged: false });
      continue;
    }

    if (!apply) {
      wouldDelete.push(branch);
      continue;
    }

    if (isCurrent && force) {
      const fallbackLocalBase = [baseShort, 'main', 'master'].find(
        (candidate) => candidate !== branch && allBranches.includes(candidate)
      );
      if (!fallbackLocalBase || isWorktreeDirty(absRepo)) {
        refused.push({ branch, reason: 'current-branch-dirty-or-no-base', merged: isMerged });
        continue;
      }
      runGit(absRepo, ['checkout', fallbackLocalBase]);
      switchedToBase = fallbackLocalBase;
    }

    // Use -D when force is enabled or when merged against a remote-tracking base ref (already verified via merge-base --is-ancestor)
    runGit(absRepo, ['branch', '-D', branch]);
    deleted.push(branch);
  }

  return {
    repoDir: absRepo,
    dryRun: !apply,
    force,
    baseRef,
    currentBranch,
    switchedToBase,
    mergedBranches,
    wouldDelete,
    deleted,
    refused,
    blockedTarget: Boolean(targetBranch && refused.length > 0)
  };
}
