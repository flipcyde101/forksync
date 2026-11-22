import path from 'node:path';
import {
  defaultGhRunner,
  listForks,
  fetchCompareStatus,
  fetchMergedUpstreamPrs,
  syncForkWithUpstream
} from './gh.js';
import {
  parseGitHubSlug,
  scanLocalClones,
  cloneMatchesFork,
  inspectMappedClone,
  pruneRepoBranches
} from './git.js';

export const DEFAULT_PROJECTS_DIR = 'D:\\Codex\\Projects';

export {
  defaultGhRunner,
  listForks,
  fetchCompareStatus,
  fetchMergedUpstreamPrs,
  syncForkWithUpstream,
  parseGitHubSlug,
  scanLocalClones,
  cloneMatchesFork,
  inspectMappedClone,
  pruneRepoBranches
};

export async function auditForks(options = {}) {
  const owner = options.owner ?? '@me';
  const projectsDir = path.resolve(options.projectsDir ?? DEFAULT_PROJECTS_DIR);
  const runner = options.runner ?? defaultGhRunner;

  const forks = await listForks({ owner, runner, cwd: options.cwd });
  const localClones = scanLocalClones(projectsDir);

  const audited = [];
  for (const fork of forks) {
    const matchedClones = localClones
      .filter((clone) => cloneMatchesFork(clone, fork))
      .map((clone) => inspectMappedClone(clone, fork));

    const remoteCompare = await fetchCompareStatus(fork, { runner, cwd: options.cwd });
    const mergedPrs = await fetchMergedUpstreamPrs(fork, { owner, runner, cwd: options.cwd });

    const primaryClone = matchedClones[0] ?? null;
    const behind = remoteCompare?.behind ?? primaryClone?.behind ?? 0;
    const ahead = remoteCompare?.ahead ?? primaryClone?.ahead ?? 0;

    const mergedBranchMap = new Map();
    for (const pr of mergedPrs) {
      mergedBranchMap.set(pr.branch, {
        branch: pr.branch,
        source: 'upstream-pr',
        prNumber: pr.number,
        title: pr.title,
        url: pr.url
      });
    }
    for (const clone of matchedClones) {
      for (const localBranch of clone.mergedLocalBranches) {
        const existing = mergedBranchMap.get(localBranch);
        if (existing) {
          existing.source = 'both';
          existing.localClonePath = clone.path;
        } else {
          mergedBranchMap.set(localBranch, {
            branch: localBranch,
            source: 'local-clone',
            prNumber: null,
            localClonePath: clone.path
          });
        }
      }
    }

    audited.push({
      name: fork.name,
      nameWithOwner: fork.nameWithOwner,
      defaultBranch: fork.defaultBranch,
      parent: fork.parent,
      behind,
      ahead,
      status: behind > 0 && ahead > 0 ? 'diverged' : behind > 0 ? 'behind' : ahead > 0 ? 'ahead' : 'up-to-date',
      statusSource: remoteCompare?.source ?? (primaryClone?.ahead !== null ? 'local-git' : 'unknown'),
      localClones: matchedClones,
      mergedUpstreamPrs: mergedPrs,
      mergedBranches: [...mergedBranchMap.values()]
    });
  }

  return {
    owner,
    projectsDir,
    totalForks: audited.length,
    mappedLocalCount: audited.filter((item) => item.localClones.length > 0).length,
    behindCount: audited.filter((item) => item.behind > 0).length,
    forks: audited
  };
}

function matchesRepoFilter(fork, repoFilter) {
  if (!repoFilter) {
    return true;
  }
  const needle = repoFilter.trim().toLowerCase();
  return fork.name.toLowerCase() === needle || fork.nameWithOwner.toLowerCase() === needle;
}

export async function syncForks(options = {}) {
  const owner = options.owner ?? '@me';
  const repoFilter = options.repo ?? null;
  const apply = Boolean(options.apply);
  const runner = options.runner ?? defaultGhRunner;
  const projectsDir = options.projectsDir ? path.resolve(options.projectsDir) : null;

  const allForks = await listForks({ owner, runner, cwd: options.cwd });
  const selected = allForks.filter((fork) => matchesRepoFilter(fork, repoFilter));

  if (repoFilter && selected.length === 0) {
    throw new Error(`No matching fork found for --repo "${repoFilter}".`);
  }

  const localClones = projectsDir ? scanLocalClones(projectsDir) : [];
  const results = [];

  for (const fork of selected) {
    if (!fork.parent) {
      results.push({
        repo: fork.nameWithOwner,
        parent: null,
        branch: fork.defaultBranch,
        behind: 0,
        ahead: 0,
        action: 'skipped-no-parent',
        synced: false
      });
      continue;
    }

    const remoteCompare = await fetchCompareStatus(fork, { runner, cwd: options.cwd });
    let behind = remoteCompare?.behind ?? null;
    let ahead = remoteCompare?.ahead ?? 0;

    if (behind === null && localClones.length > 0) {
      const matched = localClones.find((clone) => cloneMatchesFork(clone, fork));
      if (matched) {
        const inspected = inspectMappedClone(matched, fork);
        behind = inspected.behind ?? 0;
        ahead = inspected.ahead ?? 0;
      }
    }
    behind = behind ?? 0;

    if (behind <= 0) {
      results.push({
        repo: fork.nameWithOwner,
        parent: fork.parent.nameWithOwner,
        branch: fork.defaultBranch,
        behind: 0,
        ahead,
        action: 'up-to-date',
        synced: false
      });
      continue;
    }

    if (!apply) {
      results.push({
        repo: fork.nameWithOwner,
        parent: fork.parent.nameWithOwner,
        branch: fork.defaultBranch,
        behind,
        ahead,
        action: 'would-sync',
        synced: false
      });
      continue;
    }

    await syncForkWithUpstream(fork, { runner, cwd: options.cwd });
    results.push({
      repo: fork.nameWithOwner,
      parent: fork.parent.nameWithOwner,
      branch: fork.defaultBranch,
      behind,
      ahead,
      action: 'synced',
      synced: true
    });
  }

  return {
    owner,
    dryRun: !apply,
    checkedCount: results.length,
    behindCount: results.filter((r) => r.behind > 0).length,
    syncedCount: results.filter((r) => r.synced).length,
    results
  };
}
