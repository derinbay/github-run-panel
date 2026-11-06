#!/usr/bin/env node
// GitHub Run Panel: live view of running and queued GitHub Actions jobs plus open pull requests and issues.
// No dependencies. Signs in with the account from `gh auth token`; the token stays in this process and is
// never sent to the browser. The server listens on 127.0.0.1 only and rejects foreign Host headers.

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { format } from 'node:util';
import path from 'node:path';
import { appDir, loadConfig, logFile, pidFile, stateDir } from './config.mjs';
import { demoSnapshot } from './demo.mjs';

const args = process.argv.slice(2);
const DEMO = args.includes('--demo');
const SERVICE = args.includes('--service');

// ---------- Background mode: no console, so log to a file and leave a PID ----------

if (SERVICE) {
  mkdirSync(stateDir(), { recursive: true });
  const log = logFile();
  try {
    if (statSync(log).size > 1_000_000) renameSync(log, log + '.1');
  } catch { /* no log yet */ }
  const write = (level) => (...a) => {
    try {
      appendFileSync(log, `${new Date().toISOString()} ${level} ${format(...a)}\n`);
    } catch { /* logging must never stop the server */ }
  };
  console.log = write('info');
  console.warn = write('warn');
  console.error = write('error');
  process.on('uncaughtException', (e) => {
    console.error(e);
    process.exit(1);
  });
}

const config = await loadConfig();
const API = (process.env.GITHUB_API || 'https://api.github.com').replace(/\/+$/, '');
const API_VERSION = '2026-03-10';
const USER_AGENT = 'github-run-panel';
const stamp = () => new Date().toISOString().slice(11, 19);

// ---------- GitHub API ----------

class ApiError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let token = null;
const etags = new Map(); // url -> { etag, body }: 304 responses do not count against the rate limit
const rate = { limit: null, remaining: null, reset: null };

// A login session (Startup folder, launchd) may not have Homebrew or Program Files on PATH.
const GH_CANDIDATES =
  process.platform === 'win32'
    ? [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'GitHub CLI', 'gh.exe'), path.join(process.env.LOCALAPPDATA || '', 'Programs', 'GitHub CLI', 'gh.exe')]
    : ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh', '/home/linuxbrew/.linuxbrew/bin/gh'];

function ghToken(bin) {
  return new Promise((resolve) => {
    execFile(bin, ['auth', 'token'], { timeout: 10000, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout).trim()));
  });
}

async function readToken() {
  if (process.env.DASHBOARD_TOKEN) return process.env.DASHBOARD_TOKEN;
  let t = await ghToken('gh');
  for (const bin of GH_CANDIDATES) {
    if (t) break;
    if (existsSync(bin)) t = await ghToken(bin);
  }
  return t || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || null;
}

function noteRate(headers) {
  const n = (k) => {
    const v = headers.get(k);
    return v == null ? null : Number(v);
  };
  const remaining = n('x-ratelimit-remaining');
  if (remaining == null) return;
  rate.limit = n('x-ratelimit-limit');
  rate.remaining = remaining;
  rate.reset = n('x-ratelimit-reset');
}

async function api(pathname, retried = false) {
  if (!token) token = await readToken();
  if (!token) throw new ApiError(0, 'No GitHub session found (run gh auth login)', 'no_token');

  const url = API + pathname;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': API_VERSION,
    'User-Agent': USER_AGENT,
  };
  const cached = etags.get(url);
  if (cached) headers['If-None-Match'] = cached.etag;

  let res;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  } catch {
    throw new ApiError(0, 'Cannot reach GitHub', 'network');
  }
  noteRate(res.headers);

  if (res.status === 304 && cached) return cached.body;
  if (res.status === 401) {
    if (!retried) {
      token = null; // the user may have signed in again with gh
      return api(pathname, true);
    }
    throw new ApiError(401, 'Token rejected', 'bad_token');
  }
  if (res.status === 403 || res.status === 429) {
    if (res.status === 429 || res.headers.get('x-ratelimit-remaining') === '0') {
      throw new ApiError(res.status, 'API rate limit reached', 'rate_limited');
    }
    throw new ApiError(403, `No access: ${pathname}`, 'forbidden');
  }
  if (!res.ok) throw new ApiError(res.status, `${res.status}: ${pathname}`, res.status === 404 ? 'not_found' : 'http');

  const body = await res.json();
  const etag = res.headers.get('etag');
  if (etag) {
    etags.set(url, { etag, body });
    if (etags.size > 3000) {
      for (const k of [...etags.keys()].slice(0, 1000)) etags.delete(k);
    }
  }
  return body;
}

// The GraphQL quota is separate from REST: its headers are not fed to noteRate, the query reports its own points.
async function gql(query, variables, retried = false) {
  if (!token) token = await readToken();
  if (!token) throw new ApiError(0, 'No GitHub session found (run gh auth login)', 'no_token');
  let res;
  try {
    res = await fetch(API + '/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30000),
    });
  } catch {
    throw new ApiError(0, 'Cannot reach GitHub', 'network');
  }
  if (res.status === 401) {
    if (!retried) {
      token = null;
      return gql(query, variables, true);
    }
    throw new ApiError(401, 'Token rejected', 'bad_token');
  }
  if (res.status === 403 || res.status === 429) {
    if (res.status === 429 || res.headers.get('x-ratelimit-remaining') === '0') throw new ApiError(res.status, 'GraphQL rate limit reached', 'rate_limited');
    throw new ApiError(403, 'No GraphQL access', 'forbidden');
  }
  if (!res.ok) throw new ApiError(res.status, `${res.status}: graphql`, 'http');
  const body = await res.json();
  // Errors arrive with HTTP 200; when data is present, partial errors (one inaccessible repo) are ignored.
  if (body.errors?.some((e) => e.type === 'RATE_LIMITED')) throw new ApiError(200, 'GraphQL rate limit reached', 'rate_limited');
  if (!body.data) throw new ApiError(200, body.errors?.[0]?.message || 'Empty GraphQL response', 'http');
  return body.data;
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------- Accounts and repositories ----------

let viewer = null; // login of the account behind the token

async function viewerLogin() {
  viewer ??= (await api('/user')).login;
  return viewer;
}

// With no owners configured, the panel scans the signed-in account.
async function owners() {
  if (!config.owners.length) {
    config.owners = [await viewerLogin()];
    state.owners = config.owners;
  }
  return config.owners;
}

let repoCache = { at: 0, repos: [] };

async function listRepos() {
  if (repoCache.repos.length && Date.now() - repoCache.at < 10 * 60 * 1000) return repoCache.repos;
  const found = [];
  for (const owner of await owners()) {
    let base = `/orgs/${encodeURIComponent(owner)}/repos?type=all`;
    for (let page = 1; page <= 10; page++) {
      let list;
      try {
        list = await api(`${base}&per_page=100&page=${page}`);
      } catch (e) {
        if (e.code === 'not_found' && base.startsWith('/orgs/')) {
          // Not an organisation. Your own account lists private repos only through /user/repos.
          const self = owner.toLowerCase() === (await viewerLogin()).toLowerCase();
          base = self ? '/user/repos?affiliation=owner' : `/users/${encodeURIComponent(owner)}/repos?type=owner`;
          page--;
          continue;
        }
        throw e;
      }
      found.push(...list);
      if (list.length < 100) break;
    }
  }
  const repos = found
    .filter((r) => !r.disabled && (config.includeArchived || !r.archived))
    .filter((r) => !config.excludeRepos.includes(r.full_name.toLowerCase()))
    .map((r) => ({ full_name: r.full_name, html_url: r.html_url }));
  repoCache = { at: Date.now(), repos };
  return repos;
}

// ---------- Actions sweep ----------

const HARD_ERRORS = new Set(['no_token', 'bad_token', 'network', 'rate_limited']);

const ACTIVE_RUN_STATUSES = ['in_progress', 'queued', 'pending', 'waiting', 'requested'];

async function sweepRepo(repo) {
  const runsPath = `/repos/${repo.full_name}/actions/runs`;
  // A run with a job held by a concurrency group reports `pending`, and one held by an
  // environment approval reports `waiting`; both still have running and queued jobs.
  const pages = await Promise.all(
    ACTIVE_RUN_STATUSES.map((status) => api(`${runsPath}?status=${status}&per_page=50`)),
  );
  const runs = new Map();
  for (const r of pages.flatMap((p) => p.workflow_runs || [])) runs.set(r.id, r);

  const items = [];
  await pool([...runs.values()], 6, async (run) => {
    const data = await api(`/repos/${repo.full_name}/actions/runs/${run.id}/jobs?per_page=100`);
    const jobs = data.jobs || [];
    const done = jobs.filter((j) => j.status === 'completed').length;
    const common = {
      repo: repo.full_name,
      repoUrl: `${repo.html_url}/actions`,
      runId: run.id,
      runUrl: run.html_url,
      workflow: run.name || run.display_title || 'workflow',
      runNumber: run.run_number,
      branch: run.head_branch || null,
      event: run.event || null,
      runDone: done,
      runTotal: data.total_count ?? jobs.length,
      runCreatedAt: run.created_at,
      runStartedAt: run.run_started_at || run.created_at,
    };

    let open = 0;
    for (const j of jobs) {
      if (j.status === 'completed') continue;
      open++;
      const running = j.status === 'in_progress';
      const labels = Array.isArray(j.labels) ? j.labels : [];
      items.push({
        ...common,
        id: `${run.id}/${j.id}`,
        kind: running ? 'running' : 'queued',
        job: j.name,
        jobUrl: j.html_url,
        runner: j.runner_name || null,
        runnerGroup: j.runner_group_name || null,
        labels,
        selfHosted: labels.includes('self-hosted'),
        waitingApproval: j.status === 'waiting',
        since: (running ? j.started_at : j.created_at) || run.created_at,
      });
    }
    if (!open && run.status !== 'in_progress') {
      // The run is queued but its jobs do not exist yet
      items.push({
        ...common,
        id: `${run.id}/-`,
        kind: 'queued',
        job: null,
        jobUrl: null,
        runner: null,
        runnerGroup: null,
        labels: [],
        selfHosted: false,
        waitingApproval: false,
        since: run.created_at,
      });
    }
  });
  return items;
}

const byTime = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const state = {
  loading: true,
  updatedAt: null, // last successful sweep
  checkedAt: null,
  tookMs: null,
  owners: config.owners,
  repoCount: 0,
  skipped: 0,
  intervalSeconds: config.intervalSeconds,
  rate: null,
  error: null,
  running: [],
  queued: [],
};

let inflight = null;
let lastFinished = 0;
let lastErrorCode = null;

function refresh() {
  inflight ??= doSweep().finally(() => {
    inflight = null;
    lastFinished = Date.now();
  });
  return inflight;
}

async function doSweep() {
  const t0 = Date.now();
  try {
    const repos = await listRepos();
    let skipped = 0;
    const perRepo = await pool(repos, 8, async (repo) => {
      try {
        return await sweepRepo(repo);
      } catch (e) {
        if (HARD_ERRORS.has(e.code)) throw e;
        skipped++; // Actions disabled or no access: skip this repo
        return [];
      }
    });
    const all = perRepo.flat();
    state.running = all
      .filter((i) => i.kind === 'running')
      .sort((a, b) => byTime(a.runStartedAt, b.runStartedAt) || byTime(a.since, b.since) || byTime(a.id, b.id));
    state.queued = all
      .filter((i) => i.kind === 'queued')
      .sort((a, b) => byTime(a.runCreatedAt, b.runCreatedAt) || byTime(a.since, b.since) || byTime(a.id, b.id));
    state.repoCount = repos.length;
    state.skipped = skipped;
    state.updatedAt = new Date().toISOString();
    state.error = null;
    lastErrorCode = null;
  } catch (e) {
    const code = e.code || 'unknown';
    state.error = { code, message: e.message, resetAt: code === 'rate_limited' && rate.reset ? new Date(rate.reset * 1000).toISOString() : null };
    if (code === 'bad_token' || code === 'no_token') token = null;
    if (lastErrorCode !== code) console.warn(`[${stamp()}] Actions: ${e.message}`);
    lastErrorCode = code;
  }
  state.loading = false;
  state.checkedAt = new Date().toISOString();
  state.tookMs = Date.now() - t0;
  state.rate = rate.remaining == null ? null : { ...rate };
}

function nextDelayMs() {
  const base = config.intervalSeconds * 1000;
  if (state.error?.code === 'rate_limited' && rate.reset) {
    return Math.min(Math.max(rate.reset * 1000 - Date.now() + 2000, 30000), 15 * 60 * 1000);
  }
  if (state.error) return Math.max(base, 30000);
  if (rate.remaining != null && rate.remaining < 300) return Math.max(base, 60000);
  return base;
}

async function loop() {
  await refresh();
  setTimeout(loop, nextDelayMs());
}

// ---------- Open pull requests and issues ----------
// One search query across all owners (100 per page, at most 3 pages). Runs in its own loop with its own
// error state, separate from the Actions sweep: if one breaks, the other's data stays on screen.

const WORK_INTERVAL_MS = 60 * 1000;
const WORK_PAGES = 3;

const PR_FIELDS = `... on PullRequest {
  number title url createdAt updatedAt isDraft headRefName headRefOid
  author { login }
  repository { nameWithOwner url }
  labels(first: 8) { nodes { name } }
  reviewRequests(first: 1) { totalCount }
  latestReviews(first: 10) { nodes { state author { login } commit { oid } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 1) {
    totalCount
    checkRunCountsByState { state count }
    statusContextCountsByState { state count }
  } } } } }
}`;

const ISSUE_FIELDS = `... on Issue {
  number title url createdAt updatedAt
  author { login }
  repository { nameWithOwner url }
  labels(first: 8) { nodes { name } }
  assignees(first: 3) { nodes { login } }
  comments { totalCount }
}`;

const searchQuery = (fields) => `query($q: String!, $after: String) {
  rateLimit { remaining limit resetAt }
  search(query: $q, type: ISSUE, first: 100, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ${fields} }
  }
}`;

async function searchScope(kind) {
  const parts = (await owners()).map((o) => `user:${o}`);
  parts.push('is:open', `is:${kind}`);
  if (!config.includeArchived) parts.push('archived:false');
  for (const r of config.excludeRepos) parts.push(`-repo:${r}`);
  return parts.join(' ');
}

async function searchAll(kind, fields) {
  const nodes = [];
  const q = await searchScope(kind);
  let after = null;
  let total = 0;
  let rateLimit = null;
  for (let page = 0; page < WORK_PAGES; page++) {
    const data = await gql(searchQuery(fields), { q, after });
    rateLimit = data.rateLimit;
    total = data.search.issueCount;
    nodes.push(...data.search.nodes.filter((n) => n && n.number));
    if (!data.search.pageInfo.hasNextPage) break;
    after = data.search.pageInfo.endCursor;
  }
  return { nodes, total, rateLimit };
}

const FAILED_RUNS = new Set(['FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'ACTION_REQUIRED', 'CANCELLED']);
const FAILED_STATUSES = new Set(['FAILURE', 'ERROR']);
const sumOf = (list, set) => (list || []).filter((x) => set.has(x.state)).reduce((n, x) => n + x.count, 0);

function ciOf(pr) {
  const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  if (!rollup) return { state: 'none', failed: 0, total: 0 };
  const c = rollup.contexts || {};
  const failed = sumOf(c.checkRunCountsByState, FAILED_RUNS) + sumOf(c.statusContextCountsByState, FAILED_STATUSES);
  const state = { SUCCESS: 'pass', FAILURE: 'fail', ERROR: 'fail', PENDING: 'running', EXPECTED: 'running' }[rollup.state] || 'none';
  return { state, failed, total: c.totalCount || 0 };
}

// reviewDecision is empty without branch protection, so the state is derived from the latest reviews.
// An approval on an older commit counts as stale: a new commit needs another review.
function reviewOf(pr) {
  const reviews = (pr.latestReviews?.nodes || []).filter((r) => r.state === 'APPROVED' || r.state === 'CHANGES_REQUESTED');
  const changes = reviews.filter((r) => r.state === 'CHANGES_REQUESTED');
  if (changes.length) return { state: 'changes', by: changes.map((r) => r.author?.login).filter(Boolean) };
  const approvals = reviews.filter((r) => r.state === 'APPROVED');
  if (approvals.length) {
    const current = approvals.some((r) => r.commit?.oid && r.commit.oid === pr.headRefOid);
    return { state: current ? 'approved' : 'stale', by: approvals.map((r) => r.author?.login).filter(Boolean) };
  }
  return { state: pr.reviewRequests?.totalCount ? 'requested' : 'pending', by: [] };
}

const labelsOf = (n) => (n.labels?.nodes || []).map((l) => l.name);

function toPr(n) {
  const ci = ciOf(n);
  const review = reviewOf(n);
  // A seal carries one meaning: broken CI first, then requested changes, then a current approval.
  const seal = ci.state === 'fail' ? 'ci' : review.state === 'changes' ? 'changes' : review.state === 'approved' ? 'approved' : null;
  return {
    repo: n.repository.nameWithOwner,
    repoUrl: n.repository.url,
    number: n.number,
    title: n.title,
    url: n.url,
    author: n.author?.login || null,
    branch: n.headRefName,
    draft: n.isDraft,
    labels: labelsOf(n),
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    ci,
    review,
    seal,
  };
}

function toIssue(n) {
  const labels = labelsOf(n);
  const lower = labels.map((l) => l.toLowerCase());
  return {
    repo: n.repository.nameWithOwner,
    repoUrl: n.repository.url,
    number: n.number,
    title: n.title,
    url: n.url,
    author: n.author?.login || null,
    labels,
    assignees: (n.assignees?.nodes || []).map((a) => a.login),
    comments: n.comments?.totalCount || 0,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    seal: config.sealLabels.find((s) => lower.includes(s)) || null, // the first configured label it carries
  };
}

// Attention first: broken CI, requested changes, waiting, approved; drafts last.
// Issues: sealed labels in configured order, then bugs, then the rest.
const PR_RANK = { ci: 0, changes: 1, null: 2, approved: 3 };
const issueRank = (i) => {
  if (i.seal) return config.sealLabels.indexOf(i.seal);
  return config.sealLabels.length + (i.labels.some((l) => l.toLowerCase() === 'bug') ? 0 : 1);
};
const byUpdated = (a, b) => byTime(b.updatedAt, a.updatedAt);

const work = {
  loading: true,
  updatedAt: null,
  checkedAt: null,
  tookMs: null,
  error: null,
  rate: null,
  prTotal: 0,
  issueTotal: 0,
  prs: [],
  issues: [],
};
let workInflight = null;
let workLastFinished = 0;
let workErrorCode = null;

function refreshWork() {
  workInflight ??= doWork().finally(() => {
    workInflight = null;
    workLastFinished = Date.now();
  });
  return workInflight;
}

async function doWork() {
  const t0 = Date.now();
  try {
    const [prs, issues] = await Promise.all([searchAll('pr', PR_FIELDS), searchAll('issue', ISSUE_FIELDS)]);
    work.prs = prs.nodes
      .map(toPr)
      .sort((a, b) => a.draft - b.draft || PR_RANK[a.seal] - PR_RANK[b.seal] || byUpdated(a, b));
    work.issues = issues.nodes.map(toIssue).sort((a, b) => issueRank(a) - issueRank(b) || byUpdated(a, b));
    work.prTotal = prs.total;
    work.issueTotal = issues.total;
    const rl = issues.rateLimit || prs.rateLimit;
    work.rate = rl ? { remaining: rl.remaining, limit: rl.limit, resetAt: rl.resetAt } : null;
    work.updatedAt = new Date().toISOString();
    work.error = null;
    workErrorCode = null;
  } catch (e) {
    const code = e.code || 'unknown';
    work.error = { code, message: e.message, resetAt: code === 'rate_limited' ? work.rate?.resetAt || null : null };
    if (code === 'bad_token' || code === 'no_token') token = null;
    if (workErrorCode !== code) console.warn(`[${stamp()}] Pull requests and issues: ${e.message}`);
    workErrorCode = code;
  }
  work.loading = false;
  work.checkedAt = new Date().toISOString();
  work.tookMs = Date.now() - t0;
}

function nextWorkDelayMs() {
  if (work.error?.code === 'rate_limited' && work.error.resetAt) {
    return Math.min(Math.max(Date.parse(work.error.resetAt) - Date.now() + 2000, 60000), 15 * 60 * 1000);
  }
  return work.error ? 2 * WORK_INTERVAL_MS : WORK_INTERVAL_MS;
}

async function workLoop() {
  await refreshWork();
  setTimeout(workLoop, nextWorkDelayMs());
}

// ---------- HTTP ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Only this machine's own names are accepted. Without this check a web page could use DNS rebinding to
// point its own host name at 127.0.0.1 and read /api/runs (private repo names and titles) from the browser.
const ALLOWED_HOSTS = new Set([`localhost:${config.port}`, `127.0.0.1:${config.port}`, `[::1]:${config.port}`]);

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
};

function send(res, status, type, body, headers = {}) {
  res.writeHead(status, { ...SECURITY_HEADERS, ...(type ? { 'Content-Type': type } : {}), ...headers });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  try {
    if (!ALLOWED_HOSTS.has(String(req.headers.host || '').toLowerCase())) {
      send(res, 403, 'text/plain; charset=utf-8', 'Forbidden host');
      return;
    }
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/runs') {
      let body;
      if (DEMO) {
        body = demoSnapshot();
      } else {
        const waits = [];
        if (url.searchParams.has('fresh')) {
          if (Date.now() - lastFinished > 2000) waits.push(refresh());
          if (Date.now() - workLastFinished > 15000) waits.push(refreshWork());
        } else {
          if (state.loading) waits.push(refresh());
          if (work.loading) waits.push(refreshWork());
        }
        if (waits.length) await Promise.race([Promise.all(waits), sleep(25000)]);
        body = { ...state, work, now: new Date().toISOString() };
      }
      send(res, 200, 'application/json; charset=utf-8', JSON.stringify(body), { 'Cache-Control': 'no-store' });
      return;
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      send(res, 200, 'text/html; charset=utf-8', await readFile(path.join(appDir, 'index.html')), { 'Cache-Control': 'no-store' });
      return;
    }
    const font = url.pathname.match(/^\/fonts\/([a-z0-9-]+\.woff2)$/);
    if (font) {
      let file;
      try {
        file = await readFile(path.join(appDir, 'fonts', font[1]));
      } catch {
        send(res, 404, null, '');
        return;
      }
      send(res, 200, 'font/woff2', file, { 'Cache-Control': 'max-age=31536000, immutable' });
      return;
    }
    if (url.pathname === '/favicon.ico') {
      send(res, 204, null, '');
      return;
    }
    send(res, 404, 'text/plain; charset=utf-8', 'Not found');
  } catch (e) {
    send(res, 500, 'text/plain; charset=utf-8', 'Server error');
    console.error(e);
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`Port ${config.port} is in use. The panel may already be running: http://localhost:${config.port}`);
    // In background mode another copy is already serving; exit cleanly so launchd/systemd do not restart in a loop.
    process.exit(SERVICE ? 0 : 1);
  }
  throw e;
});

server.listen(config.port, '127.0.0.1', () => {
  const url = `http://localhost:${config.port}`;
  console.log(`GitHub Run Panel ready: ${url}${DEMO ? '  (demo data)' : ''}`);
  if (SERVICE) {
    writeFileSync(pidFile(), String(process.pid));
    process.on('exit', () => {
      try {
        if (readFileSync(pidFile(), 'utf8').trim() === String(process.pid)) unlinkSync(pidFile());
      } catch { /* already gone */ }
    });
  }
  if (args.includes('--open')) {
    const [cmd, cmdArgs] =
      process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    execFile(cmd, cmdArgs, { windowsHide: true }, () => {});
  }
  if (DEMO) return;
  console.log(`Scanning: ${config.owners.join(', ') || 'the signed-in gh account'}  |  refresh: Actions every ${config.intervalSeconds} s, pull requests and issues every 60 s`);
  loop();
  workLoop();
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
