"use client";

import { useEffect, useState } from "react";

// --- Types ---

type RunState = "ready" | "loading" | "loaded" | "error";
type Mode = "selector" | "live" | "demo";
type LiveTab = "check" | "evidence";

interface ReplayEntry {
  model: string;
  metric: string;
  category: string;
  before: string | number;
  after: string | number;
  breached: boolean;
}

interface ConsumerEntry {
  urn: string;
  name: string;
  type: string;
  affected: boolean;
  owners: Array<{ name: string }>;
  classification: string;
}

interface LineageNodeEntry {
  urn: string;
  name: string;
  type: string;
  platform?: string;
  degree: number;
}

interface LineageEdgeEntry {
  from: string;
  to: string;
}

interface PrData {
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
  changedFiles: Array<{ path: string; patch: string; additions: number; deletions: number }>;
  riskLevel: string;
  checkConclusion: string;
  checkTitle: string;
  checkSummary: string;
  checkText: string;
  affectedAssets: number;
  breachedChecks: number;
  ownerRouting: string;
  workflowRunUrl: string;
  sources: { github: string; datahub: string; evidence: string };
  // Rich evidence from artifact
  consumers: ConsumerEntry[];
  replayMeasurements: ReplayEntry[];
  resolvedUrns: string[];
  lineageNodes: LineageNodeEntry[];
  lineageEdges: LineageEdgeEntry[];
  evidenceNote: string;
  analysisTimestamp: string;
}

// --- Demo data (PR #184, explicitly labelled) ---

const DEMO_DATA: PrData = {
  owner: "acme-data",
  repo: "analytics",
  prNumber: 184,
  prUrl: "#demo",
  prTitle: "Change discount values to decimal scale",
  prAuthor: "maya-chen",
  baseBranch: "main",
  headBranch: "discount-decimal",
  baseSha: "7f39a417f39a417f39a417f39a417f39a417f39a",
  headSha: "a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4",
  changedFiles: [{ path: "models/staging/stg_orders.sql", patch: "", additions: 1, deletions: 1 }],
  riskLevel: "critical",
  checkConclusion: "failure",
  checkTitle: "Unsafe data change blocked",
  checkSummary: "Merge blocked: critical data change risk",
  checkText: "",
  affectedAssets: 4,
  breachedChecks: 2,
  ownerRouting: "Data Platform, Finance Analytics, Ecommerce Ops, Risk ML",
  workflowRunUrl: "#demo",
  sources: { github: "demo", datahub: "demo", evidence: "demo" },
  consumers: [],
  replayMeasurements: [],
  resolvedUrns: [],
  lineageNodes: [],
  lineageEdges: [],
  evidenceNote: "",
  analysisTimestamp: "",
};

const demoPhases = [
  { id: "detect", label: "Change detected", detail: "Semantic scale changed", meta: "models/staging/stg_orders.sql" },
  { id: "resolve", label: "Entity resolved", detail: "Snowflake · PROD", meta: "acme.analytics.stg_orders" },
  { id: "trace", label: "Lineage traversed", detail: "5 downstream assets", meta: "2 tables · 1 metric · 1 dashboard · 1 model" },
  { id: "execute", label: "Shadow run complete", detail: "Before vs. proposed", meta: "12,440 rows replayed in DuckDB" },
  { id: "decide", label: "Merge decision", detail: "Breaking change", meta: "2 critical checks failed" },
];

const demoAssets = [
  { kind: "dbt", name: "fct_order_revenue", owner: "Data Platform", change: "net_revenue −24.75%", severity: "Critical" },
  { kind: "Metric", name: "monthly_net_revenue", owner: "Finance Analytics", change: "aggregate −$482.1k", severity: "Critical" },
  { kind: "Looker", name: "Executive Revenue", owner: "Ecommerce Ops", change: "3 tiles affected", severity: "High" },
  { kind: "ML feature", name: "order_discount_ratio", owner: "Risk ML", change: "distribution shift 0.31", severity: "High" },
];

const demoCode = [
  "select",
  "  order_id,",
  "  gross_amount,",
  "- discount_percentage / 100 as discount_rate,",
  "+ discount_percentage as discount_rate,",
  "  gross_amount * (1 - discount_rate) as net_revenue",
  "from {{ ref('raw_orders') }}",
];

// --- Helper ---

function sourceLabel(source: string) {
  switch (source) {
    case "live_github": return "LIVE GITHUB";
    case "live": return "LIVE DATAHUB";
    case "commit_scoped_evidence": return "COMMIT-SCOPED EVIDENCE";
    case "demo": return "DEMO DATA";
    case "unavailable": return "UNAVAILABLE";
    case "not_configured": return "NOT CONFIGURED";
    case "missing": return "MISSING";
    case "stale": return "STALE";
    default: return source.toUpperCase();
  }
}

function sourceColor(source: string) {
  if (source === "live_github" || source === "live" || source === "commit_scoped_evidence") return "live";
  if (source === "demo") return "demo";
  return "checking";
}

// --- Main component ---

export default function Home() {
  const [mode, setMode] = useState<Mode>("selector");
  const [runState, setRunState] = useState<RunState>("ready");
  const [ownerInput, setOwnerInput] = useState("naman833");
  const [repoInput, setRepoInput] = useState("shadowgraph");
  const [pullInput, setPullInput] = useState("1");
  const [prData, setPrData] = useState<PrData | null>(null);
  const [errorMsg, setErrorMsg] = useState("");
  const [datahubStatus, setDatahubStatus] = useState<"checking" | "live" | "unavailable" | "not_configured">("checking");
  const [liveTab, setLiveTab] = useState<LiveTab>("check");

  // Demo animation state
  const [demoRunning, setDemoRunning] = useState(false);
  const [demoPhase, setDemoPhase] = useState(-1);
  const [demoFinished, setDemoFinished] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/datahub/health", { signal: controller.signal })
      .then(async (response) => {
        const health = (await response.json()) as { source?: string; ok?: boolean };
        setDatahubStatus(response.ok && health.source === "live" ? "live" : "unavailable");
      })
      .catch(() => setDatahubStatus("unavailable"));
    return () => controller.abort();
  }, []);

  async function loadPR() {
    setRunState("loading");
    setErrorMsg("");
    setPrData(null);
    setLiveTab("check");
    try {
      const response = await fetch(
        `/api/shadowgraph/evidence?owner=${encodeURIComponent(ownerInput)}&repo=${encodeURIComponent(repoInput)}&pull=${encodeURIComponent(pullInput)}`,
      );
      const json = await response.json();
      if (!json.ok) {
        setRunState("error");
        setErrorMsg(json.message || "Failed to load PR");
        return;
      }
      const d = json.data;
      setPrData({
        owner: d.owner,
        repo: d.repo,
        prNumber: d.prNumber,
        prUrl: d.prUrl,
        prTitle: d.prTitle,
        prAuthor: d.prAuthor,
        baseBranch: d.baseBranch,
        headBranch: d.headBranch,
        baseSha: d.baseSha,
        headSha: d.headSha,
        changedFiles: d.changedFiles,
        riskLevel: d.riskLevel,
        checkConclusion: d.checkResult?.conclusion ?? "neutral",
        checkTitle: d.checkResult?.title ?? "",
        checkSummary: d.checkResult?.summary ?? "",
        checkText: d.checkResult?.text ?? "",
        affectedAssets: d.trueConsumers?.length ?? 0,
        breachedChecks: d.breachedChecks?.length ?? 0,
        ownerRouting: d.assetOwners?.map((o: { name: string }) => o.name).join(", ") ?? "",
        workflowRunUrl: d.workflowLinks?.runUrl ?? "",
        sources: d.sources ?? { github: "live_github", datahub: "unavailable", evidence: "missing" },
        consumers: d.trueConsumers ?? [],
        replayMeasurements: d.breachedChecks ?? [],
        resolvedUrns: d.resolvedUrns ?? [],
        lineageNodes: d.lineageNodes ?? [],
        lineageEdges: d.lineageEdges ?? [],
        evidenceNote: json.evidenceNote ?? "",
        analysisTimestamp: d.analysisTimestamp ?? "",
      });
      setRunState("loaded");
      setMode("live");
    } catch (e) {
      setRunState("error");
      setErrorMsg(e instanceof Error ? e.message : "Network error");
    }
  }

  function enterDemo() {
    setMode("demo");
    setPrData(DEMO_DATA);
    setDemoRunning(false);
    setDemoPhase(-1);
    setDemoFinished(false);
  }

  function backToSelector() {
    setMode("selector");
    setPrData(null);
    setRunState("ready");
    setErrorMsg("");
    setDemoRunning(false);
    setDemoPhase(-1);
    setDemoFinished(false);
  }

  async function runDemoAnalysis() {
    if (demoRunning) return;
    setDemoRunning(true);
    setDemoPhase(-1);
    setDemoFinished(false);
    for (let i = 0; i < demoPhases.length; i++) {
      await new Promise((resolve) => setTimeout(resolve, 430));
      setDemoPhase(i);
    }
    setDemoFinished(true);
    setDemoRunning(false);
  }

  // --- Render selector ---
  if (mode === "selector") {
    return (
      <main className="app-shell">
        <header className="topbar">
          <a className="brand" href="#" aria-label="ShadowGraph home">
            <span className="brand-mark" aria-hidden="true">SG</span>
            <span>ShadowGraph</span>
          </a>
          <div className="topbar-center">
            <span className="repo-dot" aria-hidden="true" />
            PR Evidence Viewer
          </div>
          <div className="topbar-actions">
            <span className={`connection ${datahubStatus === "live" ? "live" : "demo"}`}>
              <span className="connection-dot" aria-hidden="true" />
              {datahubStatus === "live" ? "DataHub connected" : datahubStatus === "checking" ? "Checking DataHub" : "DataHub unavailable"}
            </span>
          </div>
        </header>

        <section className="hero">
          <div className="hero-copy" style={{ width: "100%" }}>
            <div className="eyebrow">
              <span className="eyebrow-pr">LOAD</span>
              Load a real GitHub PR
            </div>
            <h1>ShadowGraph Evidence Viewer</h1>
            <p style={{ marginBottom: 24 }}>
              Enter a repository and pull request number to load real ShadowGraph analysis evidence from GitHub.
            </p>

            <div className="pr-selector">
              <div className="pr-selector-row">
                <label className="pr-label">
                  <span>Owner</span>
                  <input
                    type="text"
                    value={ownerInput}
                    onChange={(e) => setOwnerInput(e.target.value)}
                    placeholder="naman833"
                    className="pr-input"
                  />
                </label>
                <span className="pr-separator">/</span>
                <label className="pr-label">
                  <span>Repository</span>
                  <input
                    type="text"
                    value={repoInput}
                    onChange={(e) => setRepoInput(e.target.value)}
                    placeholder="shadowgraph"
                    className="pr-input"
                  />
                </label>
                <span className="pr-separator">#</span>
                <label className="pr-label pr-label-narrow">
                  <span>PR</span>
                  <input
                    type="text"
                    value={pullInput}
                    onChange={(e) => setPullInput(e.target.value)}
                    placeholder="1"
                    className="pr-input"
                  />
                </label>
              </div>
              <div className="pr-selector-actions">
                <button
                  className="run-button"
                  onClick={loadPR}
                  disabled={runState === "loading"}
                >
                  <span className="run-icon" aria-hidden="true">
                    {runState === "loading" ? "•••" : "▶"}
                  </span>
                  {runState === "loading" ? "Loading…" : "Load PR"}
                </button>
                <button className="demo-button" onClick={enterDemo}>
                  Use demo scenario
                </button>
              </div>
            </div>

            {runState === "error" && (
              <div className="error-banner" role="alert">
                <strong>Error:</strong> {errorMsg}
              </div>
            )}
          </div>
        </section>

        <footer>
          <span>ShadowGraph · Pre-merge safety for data changes</span>
          <span>Context → Counterfactual → Decision</span>
        </footer>
      </main>
    );
  }

  // --- Render demo mode ---
  if (mode === "demo") {
    const finished = demoFinished;
    return (
      <main className="app-shell">
        <header className="topbar">
          <a className="brand" href="#" aria-label="ShadowGraph home" onClick={(e) => { e.preventDefault(); backToSelector(); }}>
            <span className="brand-mark" aria-hidden="true">SG</span>
            <span>ShadowGraph</span>
          </a>
          <div className="topbar-center">
            <span className="repo-dot" aria-hidden="true" />
            acme-data / analytics
            <span className="branch">PR #184</span>
          </div>
          <div className="topbar-actions">
            <span className="source-badge demo-badge">DEMO DATA</span>
            <button className="demo-button" onClick={backToSelector}>← Back</button>
          </div>
        </header>

        <section className="hero">
          <div className="hero-copy">
            <div className="eyebrow">
              <span className="eyebrow-pr">PR #184</span>
              <span className="source-badge demo-badge">DEMO DATA</span>
              Proposed data change
            </div>
            <h1>Change discount values to decimal scale</h1>
            <p>
              Maya Chen wants to merge 1 commit into <strong>main</strong> from <strong>discount-decimal</strong>
            </p>
          </div>
          <button
            className={`run-button ${demoRunning ? "is-running" : ""}`}
            onClick={runDemoAnalysis}
            disabled={demoRunning}
          >
            <span className="run-icon" aria-hidden="true">{demoRunning ? "•••" : "▶"}</span>
            {demoRunning ? "Analyzing lineage" : finished ? "Run analysis again" : "Run Shadow Analysis"}
          </button>
        </section>

        <section className="workspace">
          <aside className="change-panel">
            <div className="panel-heading">
              <div>
                <span className="kicker">CHANGED FILE</span>
                <h2>stg_orders.sql</h2>
              </div>
              <span className="file-badge">SQL</span>
            </div>
            <div className="diff">
              <div className="diff-path">models/staging/stg_orders.sql</div>
              <pre>
                {demoCode.map((line, index) => (
                  <code className={line.startsWith("-") ? "removed" : line.startsWith("+") ? "added" : ""} key={`${line}-${index}`}>
                    <span className="line-number">{index + 14}</span>
                    {line}
                  </code>
                ))}
              </pre>
            </div>
            <div className="detected-change">
              <span className="change-icon" aria-hidden="true">↕</span>
              <div>
                <strong>Semantic scale change</strong>
                <p><code>discount_percentage</code> now expects 0–1 instead of 0–100.</p>
              </div>
            </div>
          </aside>

          <section className="analysis-panel">
            <div className="analysis-header">
              <div className="segmented" role="tablist" aria-label="Analysis view">
                <button role="tab" aria-selected={true} className="active">Impact graph</button>
                <button role="tab" aria-selected={false}>
                  Execution evidence
                  {finished && <span className="tab-alert">2</span>}
                </button>
              </div>
            </div>
            <div className="graph" aria-label="Downstream lineage impact graph">
              <div className="graph-caption">
                DataHub context graph
                <span>{finished ? "4 true consumers" : "Awaiting analysis"}</span>
              </div>
              {!finished && (
                <div className={`graph-overlay ${demoRunning ? "scanning" : ""}`}>
                  <span className="overlay-mark" aria-hidden="true">◇</span>
                  <strong>{demoRunning ? demoPhases[Math.max(demoPhase, 0)]?.label : "Ready to trace downstream impact"}</strong>
                  <p>{demoRunning ? demoPhases[Math.max(demoPhase, 0)]?.meta : "Run the analysis to resolve this change against DataHub."}</p>
                </div>
              )}
            </div>
          </section>

          <aside className="timeline-panel">
            <div className="panel-heading">
              <div>
                <span className="kicker">ANALYSIS RUN</span>
                <h2>Decision trace</h2>
              </div>
            </div>
            <ol className="timeline">
              {demoPhases.map((phase, index) => {
                const complete = demoPhase >= index;
                const current = demoRunning && demoPhase === index;
                return (
                  <li className={`${complete ? "complete" : ""} ${current ? "current" : ""}`} key={phase.id}>
                    <span className="timeline-mark">{complete ? (phase.id === "decide" ? "!" : "✓") : index + 1}</span>
                    <div>
                      <strong>{phase.label}</strong>
                      <span>{complete ? phase.detail : "Pending"}</span>
                      {complete && <small>{phase.meta}</small>}
                    </div>
                  </li>
                );
              })}
            </ol>
            <div className={`merge-card ${finished ? "blocked" : ""}`}>
              <span className="merge-icon" aria-hidden="true">{finished ? "×" : "—"}</span>
              <div>
                <small>MERGE CHECK</small>
                <strong>{finished ? "Blocked by ShadowGraph" : "Awaiting evidence"}</strong>
                <p>{finished ? "Breaking semantic behavior detected in critical downstream assets." : "No decision has been written to this pull request."}</p>
              </div>
            </div>
          </aside>
        </section>

        <section className="asset-section">
          <div className="asset-section-heading">
            <div>
              <span className="kicker">TRUE CONSUMERS</span>
              <h2>Downstream assets requiring review</h2>
            </div>
            <span className="asset-count">{finished ? "4 affected · 1 excluded" : "Run analysis to classify"}</span>
          </div>
          <div className={`asset-table ${finished ? "" : "muted"}`}>
            <div className="asset-row asset-table-head">
              <span>Asset</span><span>Owner</span><span>Observed change</span><span>Risk</span>
            </div>
            {demoAssets.map((asset) => (
              <div className="asset-row" key={asset.name}>
                <span className="asset-name"><b>{asset.kind}</b><span><strong>{asset.name}</strong><small>References discount_percentage</small></span></span>
                <span className="owner"><i>{asset.owner.slice(0, 2).toUpperCase()}</i>{asset.owner}</span>
                <span className="observed">{finished ? asset.change : "Pending replay"}</span>
                <span><b className={`severity ${asset.severity.toLowerCase()}`}>{finished ? asset.severity : "Pending"}</b></span>
              </div>
            ))}
          </div>
        </section>

        <footer>
          <span>ShadowGraph · Demo data (PR #184 acme-data/analytics)</span>
          <span>Context → Counterfactual → Decision</span>
        </footer>
      </main>
    );
  }

  // --- Render live PR mode ---
  const data = prData!;
  const isBlocked = data.checkConclusion === "failure";
  const sqlFiles = data.changedFiles.filter((f) => /\.sql$/i.test(f.path));
  const primaryFile = sqlFiles[0] ?? data.changedFiles[0];
  const patchLines = primaryFile?.patch ? primaryFile.patch.split("\n").slice(0, 20) : [];

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="ShadowGraph home" onClick={(e) => { e.preventDefault(); backToSelector(); }}>
          <span className="brand-mark" aria-hidden="true">SG</span>
          <span>ShadowGraph</span>
        </a>
        <div className="topbar-center">
          <span className="repo-dot" aria-hidden="true" />
          {data.owner} / {data.repo}
          <span className="branch">PR #{data.prNumber}</span>
        </div>
        <div className="topbar-actions">
          <span className={`source-badge ${sourceColor(data.sources.github)}-badge`}>
            {sourceLabel(data.sources.github)}
          </span>
          <span className={`connection ${data.sources.datahub === "live" ? "live" : "demo"}`}>
            <span className="connection-dot" aria-hidden="true" />
            {data.sources.datahub === "live" ? "DataHub connected" : data.sources.datahub === "not_configured" ? "DataHub not configured" : "DataHub unavailable"}
          </span>
          <button className="demo-button" onClick={backToSelector}>← Back</button>
        </div>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow">
            <span className="eyebrow-pr">PR #{data.prNumber}</span>
            <span className={`source-badge ${sourceColor(data.sources.github)}-badge`}>
              {sourceLabel(data.sources.github)}
            </span>
            {data.sources.evidence !== "missing" && (
              <span className={`source-badge ${sourceColor(data.sources.evidence)}-badge`}>
                {sourceLabel(data.sources.evidence)}
              </span>
            )}
          </div>
          <h1>{data.prTitle || "Pull Request"}</h1>
          <p>
            <strong>{data.prAuthor}</strong> wants to merge into <strong>{data.baseBranch}</strong> from{" "}
            <strong>{data.headBranch}</strong>
          </p>
          <p className="sha-line">
            Head: <code>{data.headSha.slice(0, 12)}</code>
            {data.workflowRunUrl && data.workflowRunUrl !== "#demo" && (
              <> · <a href={data.workflowRunUrl} target="_blank" rel="noopener noreferrer">Workflow run ↗</a></>
            )}
            {data.prUrl && data.prUrl !== "#demo" && (
              <> · <a href={data.prUrl} target="_blank" rel="noopener noreferrer">View PR ↗</a></>
            )}
          </p>
        </div>
        <button
          className="run-button"
          onClick={loadPR}
          disabled={runState === "loading"}
        >
          <span className="run-icon" aria-hidden="true">
            {runState === "loading" ? "•••" : "↻"}
          </span>
          Refresh analysis evidence
        </button>
      </section>

      <section className="workspace">
        <aside className="change-panel">
          <div className="panel-heading">
            <div>
              <span className="kicker">CHANGED FILES ({data.changedFiles.length})</span>
              <h2>{primaryFile?.path.split("/").pop() ?? "No files"}</h2>
            </div>
            {primaryFile && <span className="file-badge">{primaryFile.path.split(".").pop()?.toUpperCase()}</span>}
          </div>

          {primaryFile?.patch && (
            <div className="diff">
              <div className="diff-path">{primaryFile.path}</div>
              <pre>
                {patchLines.map((line, index) => (
                  <code
                    className={line.startsWith("-") ? "removed" : line.startsWith("+") ? "added" : ""}
                    key={`${index}-${line.slice(0, 20)}`}
                  >
                    <span className="line-number">{index + 1}</span>
                    {line}
                  </code>
                ))}
              </pre>
            </div>
          )}

          {data.changedFiles.length > 1 && (
            <div className="change-meta" style={{ marginTop: 14 }}>
              <strong>All changed files:</strong>
              <ul style={{ margin: "6px 0 0", paddingLeft: 16, fontSize: 11, color: "var(--muted)" }}>
                {data.changedFiles.map((f) => (
                  <li key={f.path}>{f.path} (+{f.additions}/−{f.deletions})</li>
                ))}
              </ul>
            </div>
          )}
        </aside>

        <section className="analysis-panel">
          <div className="analysis-header">
            <div className="segmented" role="tablist" aria-label="Analysis view">
              <button
                role="tab"
                aria-selected={liveTab === "check"}
                className={liveTab === "check" ? "active" : ""}
                onClick={() => setLiveTab("check")}
                onKeyDown={(e) => { if (e.key === "ArrowRight") setLiveTab("evidence"); }}
              >
                Check result
              </button>
              <button
                role="tab"
                aria-selected={liveTab === "evidence"}
                className={liveTab === "evidence" ? "active" : ""}
                onClick={() => setLiveTab("evidence")}
                onKeyDown={(e) => { if (e.key === "ArrowLeft") setLiveTab("check"); }}
              >
                Evidence details
                {data.breachedChecks > 0 && <span className="tab-alert">{data.breachedChecks}</span>}
              </button>
            </div>
            <span className="scope-note">
              {data.sources.evidence === "commit_scoped_evidence" ? "Workflow artifact" : "GitHub Check"}
            </span>
          </div>

          {liveTab === "check" ? (
            <div className="evidence-view" role="tabpanel" aria-label="Check result">
              <div className="evidence-summary">
                <div>
                  <span className="kicker">GITHUB CHECK</span>
                  <h3>{data.checkTitle || "No ShadowGraph check found"}</h3>
                  <p>{data.checkSummary}</p>
                </div>
                <span className={`decision-pill ${isBlocked ? "failed" : data.checkConclusion === "success" ? "passed" : ""}`}>
                  {data.checkConclusion.toUpperCase()}
                </span>
              </div>

              <div className="metric-grid">
                <MetricCard label="Risk level" value={data.riskLevel} failed={data.riskLevel === "critical" || data.riskLevel === "high"} />
                <MetricCard label="Affected assets" value={String(data.affectedAssets)} failed={data.affectedAssets > 0 && isBlocked} />
                <MetricCard label="Breached checks" value={String(data.breachedChecks)} failed={data.breachedChecks > 0} />
                <MetricCard label="Owner routing" value={data.ownerRouting || "None"} />
              </div>

              {data.checkText && (
                <div className="proof" style={{ flexDirection: "column", alignItems: "stretch" }}>
                  <span className="kicker">EVIDENCE TEXT</span>
                  <pre style={{ margin: 0, fontSize: 11, lineHeight: 1.5, whiteSpace: "pre-wrap", color: "var(--ink)" }}>
                    {data.checkText}
                  </pre>
                </div>
              )}

              <div className="evidence-links">
                {data.prUrl && data.prUrl !== "#demo" && (
                  <a href={data.prUrl} target="_blank" rel="noopener noreferrer">View PR ↗</a>
                )}
                {data.workflowRunUrl && data.workflowRunUrl !== "#demo" && (
                  <a href={data.workflowRunUrl} target="_blank" rel="noopener noreferrer">Workflow run ↗</a>
                )}
              </div>
            </div>
          ) : (
            <div className="evidence-view" role="tabpanel" aria-label="Evidence details">
              <div className="evidence-summary">
                <div>
                  <span className="kicker">STRUCTURED EVIDENCE</span>
                  <h3>
                    {data.sources.evidence === "commit_scoped_evidence"
                      ? "Workflow artifact evidence"
                      : "Evidence unavailable"}
                  </h3>
                  {data.evidenceNote && (
                    <p className="evidence-note">{data.evidenceNote}</p>
                  )}
                </div>
                <span className={`source-badge ${sourceColor(data.sources.evidence)}-badge`}>
                  {sourceLabel(data.sources.evidence)}
                </span>
              </div>

              {data.sources.evidence === "commit_scoped_evidence" ? (
                <>
                  {/* Immutable identities */}
                  <div className="evidence-section">
                    <span className="kicker">COMMIT IDENTITY</span>
                    <dl className="evidence-dl">
                      <div><dt>Base SHA</dt><dd><code>{data.baseSha}</code></dd></div>
                      <div><dt>Head SHA</dt><dd><code>{data.headSha}</code></dd></div>
                      <div><dt>Timestamp</dt><dd>{data.analysisTimestamp || "—"}</dd></div>
                    </dl>
                  </div>

                  {/* Resolved URNs */}
                  {data.resolvedUrns.length > 0 && (
                    <div className="evidence-section">
                      <span className="kicker">RESOLVED DATAHUB URNS</span>
                      <ul className="evidence-list">
                        {data.resolvedUrns.map((urn) => (
                          <li key={urn}><code>{urn}</code></li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {/* Lineage */}
                  {data.lineageNodes.length > 0 && (
                    <div className="evidence-section">
                      <span className="kicker">LINEAGE ({data.lineageNodes.length} nodes, {data.lineageEdges.length} edges)</span>
                      <ul className="evidence-list">
                        {data.lineageEdges.map((edge, i) => {
                          const fromNode = data.lineageNodes.find((n) => n.urn === edge.from);
                          const toNode = data.lineageNodes.find((n) => n.urn === edge.to);
                          return (
                            <li key={i}>
                              <strong>{fromNode?.name ?? "?"}</strong> → <strong>{toNode?.name ?? "?"}</strong>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}

                  {/* True consumers */}
                  {data.consumers.length > 0 && (
                    <div className="evidence-section">
                      <span className="kicker">TRUE CONSUMERS ({data.consumers.filter((c) => c.affected).length})</span>
                      <div className="evidence-consumers">
                        {data.consumers.filter((c) => c.affected).map((c) => (
                          <div key={c.urn} className="evidence-consumer-row">
                            <strong>{c.name}</strong>
                            <span className="evidence-meta">{c.type}</span>
                            {c.owners.length > 0 && (
                              <span className="evidence-meta">Owner: {c.owners.map((o) => o.name).join(", ")}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Replay measurements */}
                  {data.replayMeasurements.length > 0 && (
                    <div className="evidence-section">
                      <span className="kicker">BREACHED CHECKS ({data.replayMeasurements.length})</span>
                      <div className="replay-table">
                        <div className="replay-row replay-header">
                          <span>Model</span><span>Metric</span><span>Before</span><span>After</span>
                        </div>
                        {data.replayMeasurements.map((m, i) => (
                          <div key={i} className="replay-row breached">
                            <span>{m.model}</span>
                            <span>{m.category}/{m.metric}</span>
                            <span>{String(m.before)}</span>
                            <span className="bad-value">{String(m.after)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div className="evidence-section">
                  <p style={{ color: "var(--muted)", fontSize: 13 }}>
                    {data.evidenceNote || "Configure GITHUB_TOKEN to enable artifact download for structured evidence."}
                  </p>
                </div>
              )}
            </div>
          )}
        </section>

        <aside className="timeline-panel">
          <div className="panel-heading">
            <div>
              <span className="kicker">DATA SOURCES</span>
              <h2>Source status</h2>
            </div>
          </div>

          <div className="source-list">
            <SourceRow label="GitHub" status={data.sources.github} />
            <SourceRow label="DataHub" status={data.sources.datahub} />
            <SourceRow label="Evidence" status={data.sources.evidence} />
          </div>

          <div className={`merge-card ${isBlocked ? "blocked" : data.checkConclusion === "success" ? "safe" : ""}`}>
            <span className="merge-icon" aria-hidden="true">
              {isBlocked ? "×" : data.checkConclusion === "success" ? "✓" : "?"}
            </span>
            <div>
              <small>MERGE CHECK</small>
              <strong>{data.checkTitle || "Awaiting analysis"}</strong>
              <p>{data.checkSummary || "No decision has been written to this pull request."}</p>
            </div>
          </div>

          <div style={{ marginTop: 16 }}>
            <button className="demo-button" onClick={enterDemo} style={{ width: "100%" }}>
              Use demo scenario
            </button>
          </div>
        </aside>
      </section>

      <footer>
        <span>ShadowGraph · {data.owner}/{data.repo} PR #{data.prNumber}</span>
        <span>Context → Counterfactual → Decision</span>
      </footer>
    </main>
  );
}

function MetricCard({ label, value, failed = false }: { label: string; value: string; failed?: boolean }) {
  return (
    <div className={`metric-card ${failed ? "failed" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SourceRow({ label, status }: { label: string; status: string }) {
  const color = sourceColor(status);
  return (
    <div className="source-row">
      <span className={`source-dot ${color}`} />
      <span className="source-label">{label}</span>
      <span className={`source-badge ${color}-badge`}>{sourceLabel(status)}</span>
    </div>
  );
}
