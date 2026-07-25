"use client";

import { useEffect, useState } from "react";

type RunState = "ready" | "running" | "blocked";

const phases = [
  {
    id: "detect",
    label: "Change detected",
    detail: "Semantic scale changed",
    meta: "models/staging/stg_orders.sql",
  },
  {
    id: "resolve",
    label: "Entity resolved",
    detail: "Snowflake · PROD",
    meta: "acme.analytics.stg_orders",
  },
  {
    id: "trace",
    label: "Lineage traversed",
    detail: "5 downstream assets",
    meta: "2 tables · 1 metric · 1 dashboard · 1 model",
  },
  {
    id: "execute",
    label: "Shadow run complete",
    detail: "Before vs. proposed",
    meta: "12,440 rows replayed in DuckDB",
  },
  {
    id: "decide",
    label: "Merge decision",
    detail: "Breaking change",
    meta: "2 critical checks failed",
  },
];

const impactedAssets = [
  {
    kind: "dbt",
    name: "fct_order_revenue",
    owner: "Data Platform",
    change: "net_revenue −24.75%",
    severity: "Critical",
  },
  {
    kind: "Metric",
    name: "monthly_net_revenue",
    owner: "Finance Analytics",
    change: "aggregate −$482.1k",
    severity: "Critical",
  },
  {
    kind: "Looker",
    name: "Executive Revenue",
    owner: "Ecommerce Ops",
    change: "3 tiles affected",
    severity: "High",
  },
  {
    kind: "ML feature",
    name: "order_discount_ratio",
    owner: "Risk ML",
    change: "distribution shift 0.31",
    severity: "High",
  },
];

const codeBefore = [
  "select",
  "  order_id,",
  "  gross_amount,",
  "- discount_percentage / 100 as discount_rate,",
  "+ discount_percentage as discount_rate,",
  "  gross_amount * (1 - discount_rate) as net_revenue",
  "from {{ ref('raw_orders') }}",
];

export default function Home() {
  const [runState, setRunState] = useState<RunState>("ready");
  const [activePhase, setActivePhase] = useState(-1);
  const [view, setView] = useState<"impact" | "evidence">("impact");
  const [contextSource, setContextSource] = useState<
    "checking" | "live" | "demo"
  >("checking");

  useEffect(() => {
    const controller = new AbortController();

    fetch("/api/datahub/health", { signal: controller.signal })
      .then(async (response) => {
        const health = (await response.json()) as { source?: string };
        setContextSource(
          response.ok && health.source === "live" ? "live" : "demo",
        );
      })
      .catch(() => setContextSource("demo"));

    return () => controller.abort();
  }, []);

  async function runAnalysis() {
    if (runState === "running") return;
    setRunState("running");
    setActivePhase(-1);
    setView("impact");

    for (let index = 0; index < phases.length; index += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 430));
      setActivePhase(index);
    }

    setRunState("blocked");
  }

  const finished = runState === "blocked";

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" aria-label="ShadowGraph home">
          <span className="brand-mark" aria-hidden="true">
            SG
          </span>
          <span>ShadowGraph</span>
        </a>
        <div className="topbar-center">
          <span className="repo-dot" aria-hidden="true" />
          acme-data / analytics
          <span className="branch">PR #184</span>
        </div>
        <div className="topbar-actions">
          <span className={`connection ${contextSource}`}>
            <span className="connection-dot" aria-hidden="true" />
            {contextSource === "live"
              ? "DataHub connected"
              : contextSource === "demo"
                ? "Demo context"
                : "Checking DataHub"}
          </span>
          <button className="icon-button" aria-label="Open settings">
            ···
          </button>
        </div>
      </header>

      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow">
            <span className="eyebrow-pr">PR #184</span>
            Proposed data change
          </div>
          <h1>Change discount values to decimal scale</h1>
          <p>
            Maya Chen wants to merge 1 commit into <strong>main</strong> from{" "}
            <strong>discount-decimal</strong>
          </p>
        </div>
        <button
          className={`run-button ${runState === "running" ? "is-running" : ""}`}
          onClick={runAnalysis}
          disabled={runState === "running"}
        >
          <span className="run-icon" aria-hidden="true">
            {runState === "running" ? "•••" : "▶"}
          </span>
          {runState === "running"
            ? "Analyzing lineage"
            : finished
              ? "Run analysis again"
              : "Run Shadow Analysis"}
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
              {codeBefore.map((line, index) => (
                <code
                  className={
                    line.startsWith("-")
                      ? "removed"
                      : line.startsWith("+")
                        ? "added"
                        : ""
                  }
                  key={`${line}-${index}`}
                >
                  <span className="line-number">{index + 14}</span>
                  {line}
                </code>
              ))}
            </pre>
          </div>

          <div className="detected-change">
            <span className="change-icon" aria-hidden="true">
              ↕
            </span>
            <div>
              <strong>Semantic scale change</strong>
              <p>
                <code>discount_percentage</code> now expects 0–1 instead of
                0–100.
              </p>
            </div>
          </div>

          <dl className="change-meta">
            <div>
              <dt>Source asset</dt>
              <dd>acme.raw.orders</dd>
            </div>
            <div>
              <dt>Changed column</dt>
              <dd>discount_percentage</dd>
            </div>
            <div>
              <dt>DataHub URN</dt>
              <dd className="truncate">urn:li:dataset:(snowflake,orders,PROD)</dd>
            </div>
          </dl>
        </aside>

        <section className="analysis-panel">
          <div className="analysis-header">
            <div className="segmented" role="tablist" aria-label="Analysis view">
              <button
                role="tab"
                aria-selected={view === "impact"}
                className={view === "impact" ? "active" : ""}
                onClick={() => setView("impact")}
              >
                Impact graph
              </button>
              <button
                role="tab"
                aria-selected={view === "evidence"}
                className={view === "evidence" ? "active" : ""}
                onClick={() => setView("evidence")}
              >
                Execution evidence
                {finished && <span className="tab-alert">2</span>}
              </button>
            </div>
            <span className="scope-note">Column-level lineage · 3 hops</span>
          </div>

          {view === "impact" ? (
            <div className="graph" aria-label="Downstream lineage impact graph">
              <div className="graph-caption">
                DataHub context graph
                <span>{finished ? "4 true consumers" : "Awaiting analysis"}</span>
              </div>
              <div className="graph-lines" aria-hidden="true">
                <span className="line line-one" />
                <span className="line line-two" />
                <span className="line line-three" />
                <span className="line line-four" />
              </div>

              <article className="graph-node source-node">
                <span className="node-type snowflake">SN</span>
                <div>
                  <small>SNOWFLAKE</small>
                  <strong>raw.orders</strong>
                  <span>discount_percentage</span>
                </div>
              </article>

              <article className={`graph-node model-node ${finished ? "risk" : ""}`}>
                <span className="node-type dbt">dbt</span>
                <div>
                  <small>DBT MODEL</small>
                  <strong>fct_order_revenue</strong>
                  <span>net_revenue</span>
                </div>
                {finished && <b className="risk-mark">!</b>}
              </article>

              <article className={`graph-node metric-node ${finished ? "risk" : ""}`}>
                <span className="node-type metric">M</span>
                <div>
                  <small>METRIC</small>
                  <strong>monthly_net_revenue</strong>
                  <span>Finance Analytics</span>
                </div>
                {finished && <b className="risk-mark">!</b>}
              </article>

              <article className={`graph-node dashboard-node ${finished ? "warn" : ""}`}>
                <span className="node-type looker">L</span>
                <div>
                  <small>LOOKER DASHBOARD</small>
                  <strong>Executive Revenue</strong>
                  <span>3 tiles reference field</span>
                </div>
              </article>

              <article className={`graph-node ml-node ${finished ? "warn" : ""}`}>
                <span className="node-type ml">ML</span>
                <div>
                  <small>FEATURE TABLE</small>
                  <strong>order_discount_ratio</strong>
                  <span>Fraud propensity v4</span>
                </div>
              </article>

              {!finished && (
                <div className={`graph-overlay ${runState === "running" ? "scanning" : ""}`}>
                  <span className="overlay-mark" aria-hidden="true">
                    ◇
                  </span>
                  <strong>
                    {runState === "running"
                      ? phases[Math.max(activePhase, 0)]?.label
                      : "Ready to trace downstream impact"}
                  </strong>
                  <p>
                    {runState === "running"
                      ? phases[Math.max(activePhase, 0)]?.meta
                      : "Run the analysis to resolve this change against DataHub."}
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="evidence-view">
              <div className="evidence-summary">
                <div>
                  <span className="kicker">COUNTERFACTUAL RUN</span>
                  <h3>Proposed behavior diverges from baseline</h3>
                  <p>
                    ShadowGraph replayed only the affected lineage subgraph
                    against a deterministic sample.
                  </p>
                </div>
                <span className={`decision-pill ${finished ? "failed" : ""}`}>
                  {finished ? "FAILED" : "NOT RUN"}
                </span>
              </div>
              <div className="metric-grid">
                <Metric label="Rows replayed" value={finished ? "12,440" : "—"} note="0.0% delta" />
                <Metric label="Net revenue" value={finished ? "−24.75%" : "—"} note="threshold ±1%" failed={finished} />
                <Metric label="Null rate" value={finished ? "0.02%" : "—"} note="+0.00%" />
                <Metric label="ML drift score" value={finished ? "0.31" : "—"} note="threshold 0.10" failed={finished} />
              </div>
              <div className="proof">
                <div>
                  <span>Baseline</span>
                  <strong>$1,947,220.84</strong>
                </div>
                <span className="proof-arrow">→</span>
                <div>
                  <span>Proposed</span>
                  <strong className={finished ? "bad-value" : ""}>
                    {finished ? "$1,465,291.12" : "Not evaluated"}
                  </strong>
                </div>
                <div className="proof-runtime">
                  <span>Runtime</span>
                  <strong>{finished ? "1.84s" : "—"}</strong>
                </div>
              </div>
            </div>
          )}
        </section>

        <aside className="timeline-panel">
          <div className="panel-heading">
            <div>
              <span className="kicker">ANALYSIS RUN</span>
              <h2>Decision trace</h2>
            </div>
            <span className={`status-dot ${runState}`} />
          </div>

          <ol className="timeline">
            {phases.map((phase, index) => {
              const complete = activePhase >= index;
              const current = runState === "running" && activePhase === index;
              return (
                <li
                  className={`${complete ? "complete" : ""} ${current ? "current" : ""}`}
                  key={phase.id}
                >
                  <span className="timeline-mark">
                    {complete ? (phase.id === "decide" ? "!" : "✓") : index + 1}
                  </span>
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
            <span className="merge-icon" aria-hidden="true">
              {finished ? "×" : "—"}
            </span>
            <div>
              <small>MERGE CHECK</small>
              <strong>{finished ? "Blocked by ShadowGraph" : "Awaiting evidence"}</strong>
              <p>
                {finished
                  ? "Breaking semantic behavior detected in critical downstream assets."
                  : "No decision has been written to this pull request."}
              </p>
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
            <span>Asset</span>
            <span>Owner</span>
            <span>Observed change</span>
            <span>Risk</span>
          </div>
          {impactedAssets.map((asset) => (
            <div className="asset-row" key={asset.name}>
              <span className="asset-name">
                <b>{asset.kind}</b>
                <span>
                  <strong>{asset.name}</strong>
                  <small>References discount_percentage</small>
                </span>
              </span>
              <span className="owner">
                <i>{asset.owner.slice(0, 2).toUpperCase()}</i>
                {asset.owner}
              </span>
              <span className="observed">{finished ? asset.change : "Pending replay"}</span>
              <span>
                <b className={`severity ${asset.severity.toLowerCase()}`}>
                  {finished ? asset.severity : "Pending"}
                </b>
              </span>
            </div>
          ))}
        </div>
      </section>

      <footer>
        <span>ShadowGraph preview · DataHub Agent Hackathon</span>
        <span>Context → Counterfactual → Decision</span>
      </footer>
    </main>
  );
}

function Metric({
  label,
  value,
  note,
  failed = false,
}: {
  label: string;
  value: string;
  note: string;
  failed?: boolean;
}) {
  return (
    <div className={`metric-card ${failed ? "failed" : ""}`}>
      <span>{label}</span>
      <strong>{value}</strong>
      <small>{note}</small>
    </div>
  );
}
