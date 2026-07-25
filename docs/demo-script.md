# Demo script — under three minutes

Target runtime: **2 minutes 45 seconds**.

## 0:00–0:20 — The silent failure

Open PR `#184` and show the one-line SQL diff.

> “This PR changes how `discount_percentage` is interpreted. The column name
> and type stay the same, so ordinary schema CI passes—but every value now has a
> different meaning.”

## 0:20–0:45 — Start ShadowGraph

Open ShadowGraph and select **Run Shadow Analysis**.

> “ShadowGraph resolves the changed field in DataHub and walks its column-level
> lineage. DataHub supplies the real schemas, downstream assets, and owners.”

Let the visible stages advance through detection, resolution, and lineage.

## 0:45–1:15 — Remove false positives

Point to the impact graph and its four true consumers.

> “Five assets were downstream, but one never references this field, so it is
> excluded. The remaining consumers include a revenue model, business metric,
> executive dashboard, and ML feature.”

## 1:15–1:50 — Show executable evidence

Open **Execution evidence**.

> “The shadow run compares the old and proposed transformations over 12,440
> rows. Net revenue falls 24.75 percent and the ML feature's drift score reaches
> 0.31. Both exceed policy.”

Pause on the measured values and thresholds.

## 1:50–2:15 — Block the merge

Show the red merge decision and affected owners.

> “Instead of a vague blast-radius warning, the PR gets a reproducible reason to
> block and the exact teams that need to review it.”

## 2:15–2:35 — Show organizational memory

Open `examples/change-evidence.md` or the corresponding DataHub evidence record
when live writeback is available.

> “The decision bundle records the commit, DataHub URN, lineage scope,
> measurements, thresholds, and owners so the next person or agent inherits the
> reasoning.”

## 2:35–2:45 — Close

> “DataHub tells ShadowGraph what is connected. ShadowGraph proves what will
> change before production is touched.”

## Recording notes

- Use a fresh browser window at 1440×900 or similar.
- Increase cursor size and avoid rapid panning.
- Keep terminal setup out of the final recording.
- Record the product interaction in one take, then add captions.
- If demonstrating the current vertical slice, say “reference replay” rather
  than implying that the DataHub and DuckDB adapters are already live.
