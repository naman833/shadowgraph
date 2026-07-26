/**
 * Typed analysis view model for the ShadowGraph UI.
 *
 * React components depend on this interface, never on raw GitHub API responses.
 */

export type DataSourceLabel =
  | "live_github"
  | "live_datahub"
  | "commit_scoped_evidence"
  | "demo";

export type RiskLevel = "none" | "low" | "medium" | "high" | "critical";

export type CheckConclusion = "success" | "failure" | "neutral";

export interface DiffHunk {
  path: string;
  patch: string;
  additions: number;
  deletions: number;
}

export interface ChangedDataset {
  urn: string;
  name: string;
  platform: string;
  columns: string[];
}

export interface LineageNode {
  urn: string;
  name: string;
  type: string;
  platform?: string;
  degree: number;
}

export interface LineageEdge {
  from: string;
  to: string;
}

export interface Consumer {
  urn: string;
  name: string;
  type: string;
  affected: boolean;
  owners: AssetOwner[];
  classification: "true_consumer" | "lineage_only" | "excluded";
}

export interface AssetOwner {
  name: string;
  urn?: string;
  type?: string;
}

export interface ReplayMeasurement {
  model: string;
  metric: string;
  category: string;
  before: number | string;
  after: number | string;
  breached: boolean;
  threshold?: number | string;
}

export interface BreachedCheck {
  model: string;
  metric: string;
  category: string;
  before: number | string;
  after: number | string;
  threshold?: number | string;
  magnitude?: number;
}

export interface GitHubCheckResult {
  name: string;
  status: string;
  conclusion: CheckConclusion;
  title: string;
  summary: string;
  text?: string;
}

export interface WorkflowLinks {
  runUrl?: string;
  jobUrl?: string;
}

export interface SourceStatus {
  github: DataSourceLabel;
  datahub: "live" | "unavailable" | "not_configured";
  evidence: "commit_scoped_evidence" | "missing" | "stale";
}

export interface AnalysisViewModel {
  // Repository & PR identity
  owner: string;
  repo: string;
  prNumber: number;
  prUrl: string;
  prTitle: string;
  prAuthor: string;
  baseBranch: string;
  headBranch: string;
  baseSha: string;
  headSha: string;

  // Changes
  changedFiles: DiffHunk[];
  changedDatasets: ChangedDataset[];

  // DataHub context
  datahubConnected: boolean;
  resolvedUrns: string[];

  // Lineage
  lineageNodes: LineageNode[];
  lineageEdges: LineageEdge[];

  // Consumers
  trueConsumers: Consumer[];
  excludedFalsePositives: Consumer[];
  assetOwners: AssetOwner[];

  // Replay
  replayMeasurements: ReplayMeasurement[];
  breachedChecks: BreachedCheck[];

  // Decision
  riskLevel: RiskLevel;
  checkResult: GitHubCheckResult;
  workflowLinks: WorkflowLinks;

  // Source & metadata
  sources: SourceStatus;
  evidenceSource: DataSourceLabel;
  analysisTimestamp: string;
}

/** Error response from API routes. */
export interface ApiError {
  error: true;
  code: string;
  message: string;
  details?: string;
}

/** Discriminated response type for the evidence API. */
export type EvidenceResponse =
  | { ok: true; data: AnalysisViewModel }
  | { ok: false; error: ApiError };
