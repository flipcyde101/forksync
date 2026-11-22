import { execFileSync } from 'node:child_process';

export function defaultGhRunner(args, options = {}) {
  const stdout = execFileSync('gh', args, {
    cwd: options.cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 10 * 1024 * 1024
  });
  return { exitCode: 0, stdout, stderr: '' };
}

function parseRunnerJson(raw) {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed ? JSON.parse(trimmed) : null;
  }
  if (typeof raw === 'object' && typeof raw.stdout === 'string') {
    const trimmed = raw.stdout.trim();
    return trimmed ? JSON.parse(trimmed) : null;
  }
  if (typeof raw === 'object') {
    return raw;
  }
  return null;
}

function normalizeForkRecord(raw) {
  const owner =
    typeof raw.owner === 'string'
      ? raw.owner
      : raw.owner?.login ?? (raw.nameWithOwner ? raw.nameWithOwner.split('/')[0] : 'unknown');
  const name = String(raw.name ?? (raw.nameWithOwner ? raw.nameWithOwner.split('/')[1] : ''));
  const nameWithOwner = String(raw.nameWithOwner ?? `${owner}/${name}`);
  const defaultBranch = String(raw.defaultBranchRef?.name ?? raw.defaultBranch ?? 'main');

  let parent = null;
  if (raw.parent && typeof raw.parent === 'object') {
    const parentOwner =
      typeof raw.parent.owner === 'string'
        ? raw.parent.owner
        : raw.parent.owner?.login ??
          (raw.parent.nameWithOwner ? raw.parent.nameWithOwner.split('/')[0] : 'unknown');
    const parentName = String(
      raw.parent.name ?? (raw.parent.nameWithOwner ? raw.parent.nameWithOwner.split('/')[1] : name)
    );
    const parentSlug = String(raw.parent.nameWithOwner ?? `${parentOwner}/${parentName}`);
    const parentDefaultBranch = String(
      raw.parent.defaultBranchRef?.name ?? raw.parent.defaultBranch ?? defaultBranch
    );
    parent = {
      owner: parentOwner,
      name: parentName,
      nameWithOwner: parentSlug,
      defaultBranch: parentDefaultBranch
    };
  }

  return {
    name,
    owner,
    nameWithOwner,
    url: String(raw.url ?? `https://github.com/${nameWithOwner}`),
    sshUrl: raw.sshUrl ? String(raw.sshUrl) : null,
    defaultBranch,
    isArchived: Boolean(raw.isArchived),
    pushedAt: raw.pushedAt ?? null,
    parent,
    aheadBy: typeof raw.aheadBy === 'number' ? raw.aheadBy : null,
    behindBy: typeof raw.behindBy === 'number' ? raw.behindBy : null
  };
}

export async function listForks(options = {}) {
  const runner = options.runner ?? defaultGhRunner;
  const owner = options.owner ?? '@me';
  const args = ['repo', 'list'];
  if (owner && owner !== '@me') {
    args.push(owner);
  }
  args.push(
    '--fork',
    '--limit',
    '200',
    '--json',
    'name,nameWithOwner,owner,url,sshUrl,defaultBranchRef,parent,isArchived,pushedAt'
  );

  const raw = await runner(args, { cwd: options.cwd });
  const parsed = parseRunnerJson(raw);
  if (!Array.isArray(parsed)) {
    throw new Error('Expected array response from "gh repo list --fork".');
  }
  return parsed.map(normalizeForkRecord);
}

export async function fetchCompareStatus(fork, options = {}) {
  if (!fork.parent) {
    return null;
  }
  const runner = options.runner ?? defaultGhRunner;
  const compareEndpoint = `repos/${fork.nameWithOwner}/compare/${fork.parent.owner}:${fork.parent.defaultBranch}...${fork.owner}:${fork.defaultBranch}`;
  try {
    const raw = await runner(['api', compareEndpoint], { cwd: options.cwd });
    const data = parseRunnerJson(raw);
    if (data && (typeof data.behind_by === 'number' || typeof data.ahead_by === 'number')) {
      return {
        ahead: Number(data.ahead_by ?? 0),
        behind: Number(data.behind_by ?? 0),
        status: String(data.status ?? 'unknown'),
        source: 'github-api'
      };
    }
  } catch {
    // Fall back to pre-populated fields or local clone comparison
  }

  if (typeof fork.behindBy === 'number' || typeof fork.aheadBy === 'number') {
    return {
      ahead: Number(fork.aheadBy ?? 0),
      behind: Number(fork.behindBy ?? 0),
      status: (fork.behindBy ?? 0) > 0 ? 'behind' : 'identical',
      source: 'repo-metadata'
    };
  }
  return null;
}

export async function fetchMergedUpstreamPrs(fork, options = {}) {
  if (!fork.parent) {
    return [];
  }
  const runner = options.runner ?? defaultGhRunner;
  const author = options.owner && options.owner !== '@me' ? options.owner : fork.owner || '@me';
  try {
    const raw = await runner(
      [
        'pr',
        'list',
        '--repo',
        fork.parent.nameWithOwner,
        '--author',
        author,
        '--state',
        'merged',
        '--limit',
        '100',
        '--json',
        'number,title,headRefName,mergedAt,url'
      ],
      { cwd: options.cwd }
    );
    const list = parseRunnerJson(raw);
    if (!Array.isArray(list)) {
      return [];
    }
    return list
      .filter((pr) => pr && pr.headRefName)
      .map((pr) => ({
        number: Number(pr.number),
        title: String(pr.title ?? ''),
        branch: String(pr.headRefName),
        mergedAt: pr.mergedAt ?? null,
        url: pr.url ?? null
      }));
  } catch {
    return [];
  }
}

export async function syncForkWithUpstream(fork, options = {}) {
  const runner = options.runner ?? defaultGhRunner;
  await runner(['repo', 'sync', fork.nameWithOwner, '--branch', fork.defaultBranch], {
    cwd: options.cwd
  });
}
