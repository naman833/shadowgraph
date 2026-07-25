/**
 * DataHub integration boundary for ShadowGraph.
 *
 * Keep DataHub's GraphQL response shapes in this file. The rest of the
 * application should depend on the normalized interfaces exported below.
 */

export type DataHubSource = "live" | "demo";

export interface DataHubConfig {
  /** GMS origin, for example http://localhost:8080. */
  baseUrl: string;
  /** DataHub GraphQL endpoint. Defaults to `${baseUrl}/api/graphql`. */
  graphqlUrl: string;
  /** Optional personal access token. Local quickstart does not require one. */
  token?: string;
  /** Per-request timeout. */
  timeoutMs: number;
  /**
   * Allow a deterministic, explicitly-labelled graph when DataHub is
   * unavailable. Intended for previews and the hosted hackathon demo.
   */
  demoFallback: boolean;
}

export interface DataHubHealth {
  ok: boolean;
  source: DataHubSource;
  baseUrl: string;
  version?: string;
  latencyMs: number;
  warning?: string;
}

export interface DataHubOwner {
  urn: string;
  name: string;
  type?: string;
}

export interface DataHubEntity {
  urn: string;
  type: string;
  name: string;
  platform?: string;
  description?: string;
  owners: DataHubOwner[];
  source: DataHubSource;
}

export interface DataHubLineageNode extends DataHubEntity {
  degree: number;
}

export interface DataHubLineageEdge {
  from: string;
  to: string;
  degree: number;
}

export interface DataHubLineage {
  rootUrn: string;
  direction: "UPSTREAM" | "DOWNSTREAM";
  nodes: DataHubLineageNode[];
  edges: DataHubLineageEdge[];
  source: DataHubSource;
  warning?: string;
}

export interface ResolveEntityResult {
  entity: DataHubEntity | null;
  source: DataHubSource;
  warning?: string;
}

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export class DataHubError extends Error {
  readonly code:
    | "CONFIG"
    | "NETWORK"
    | "TIMEOUT"
    | "HTTP"
    | "GRAPHQL"
    | "INVALID_RESPONSE";
  readonly status?: number;
  readonly details?: unknown;

  constructor(
    message: string,
    code: DataHubError["code"],
    options: { status?: number; details?: unknown; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "DataHubError";
    this.code = code;
    this.status = options.status;
    this.details = options.details;
  }
}

type Environment = Record<string, string | undefined>;

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  throw new DataHubError(
    `Expected a boolean but received "${value}"`,
    "CONFIG",
  );
}

function normalizeUrl(value: string, field: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("Only http and https are supported");
    }
    return url.toString().replace(/\/$/, "");
  } catch (cause) {
    throw new DataHubError(`Invalid ${field}: ${value}`, "CONFIG", { cause });
  }
}

/**
 * Reads configuration without mutating process.env.
 *
 * DATAHUB_GMS_URL is the GMS service (local quickstart: localhost:8080), not
 * the frontend at localhost:9002.
 */
export function loadDataHubConfig(
  env: Environment = typeof process === "undefined" ? {} : process.env,
): DataHubConfig {
  const baseUrl = normalizeUrl(
    env.DATAHUB_GMS_URL ?? env.DATAHUB_BASE_URL ?? "http://localhost:8080",
    "DATAHUB_GMS_URL",
  );
  const graphqlUrl = normalizeUrl(
    env.DATAHUB_GRAPHQL_URL ?? `${baseUrl}/api/graphql`,
    "DATAHUB_GRAPHQL_URL",
  );
  const timeoutMs = Number(env.DATAHUB_TIMEOUT_MS ?? 30000);

  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw new DataHubError(
      "DATAHUB_TIMEOUT_MS must be an integer between 100 and 120000",
      "CONFIG",
    );
  }

  return {
    baseUrl,
    graphqlUrl,
    token: env.DATAHUB_TOKEN || undefined,
    timeoutMs,
    demoFallback: parseBoolean(env.DATAHUB_DEMO_FALLBACK, false),
  };
}

interface GraphQLErrorPayload {
  message?: string;
  path?: Array<string | number>;
  extensions?: unknown;
}

interface GraphQLResponse<T> {
  data?: T;
  errors?: GraphQLErrorPayload[];
}

function requestHeaders(config: DataHubConfig): Record<string, string> {
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  if (config.token) headers.authorization = `Bearer ${config.token}`;
  return headers;
}

/**
 * Typed GraphQL transport with timeout, HTTP, response-shape, and GraphQL
 * error handling. Callers supply the response type: graphqlRequest<MyQuery>().
 */
export async function graphqlRequest<T>(
  config: DataHubConfig,
  query: string,
  variables: Record<string, unknown> = {},
  fetchImpl: FetchLike = fetch,
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetchImpl(config.graphqlUrl, {
        method: "POST",
        headers: requestHeaders(config),
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
    } catch (cause) {
      if (
        controller.signal.aborted ||
        (cause instanceof Error && cause.name === "AbortError")
      ) {
        throw new DataHubError(
          `DataHub request timed out after ${config.timeoutMs}ms`,
          "TIMEOUT",
          { cause },
        );
      }
      throw new DataHubError("Could not reach DataHub GraphQL", "NETWORK", {
        cause,
      });
    }

    const raw = await response.text();
    if (!response.ok) {
      throw new DataHubError(
        `DataHub GraphQL returned HTTP ${response.status}`,
        "HTTP",
        { status: response.status, details: raw.slice(0, 2000) },
      );
    }

    let payload: GraphQLResponse<T>;
    try {
      payload = JSON.parse(raw) as GraphQLResponse<T>;
    } catch (cause) {
      throw new DataHubError(
        "DataHub returned a non-JSON GraphQL response",
        "INVALID_RESPONSE",
        { details: raw.slice(0, 2000), cause },
      );
    }

    if (payload.errors?.length) {
      throw new DataHubError(
        payload.errors.map((error) => error.message ?? "GraphQL error").join("; "),
        "GRAPHQL",
        { details: payload.errors },
      );
    }
    if (payload.data === undefined) {
      throw new DataHubError(
        "DataHub GraphQL response did not contain data",
        "INVALID_RESPONSE",
        { details: payload },
      );
    }
    return payload.data;
  } finally {
    clearTimeout(timeout);
  }
}

const ENTITY_FRAGMENT = `
  urn
  type
  ... on Dataset {
    name
    properties { name description }
    platform { name }
    ownership {
      owners {
        owner {
          ... on CorpUser { urn username properties { displayName } }
          ... on CorpGroup { urn name properties { displayName } }
        }
      }
    }
  }
  ... on Dashboard {
    dashboardId
    properties { name description }
    platform { name }
  }
  ... on Chart {
    chartId
    properties { name description }
    platform { name }
  }
`;

const SEARCH_ENTITY_QUERY = `
  query ShadowGraphResolveEntity($input: SearchInput!) {
    search(input: $input) {
      searchResults { entity { ${ENTITY_FRAGMENT} } }
    }
  }
`;

const DOWNSTREAM_LINEAGE_QUERY = `
  query ShadowGraphOneHopDownstreamLineage($input: ScrollAcrossLineageInput!) {
    scrollAcrossLineage(input: $input) {
      searchResults {
        degree
        entity { urn type }
      }
    }
  }
`;

const ONE_HOP_RESULT_LIMIT = 25;
const LINEAGE_NODE_LIMIT = 100;

interface RawOwner {
  urn?: string;
  type?: string;
  username?: string;
  name?: string;
  properties?: { displayName?: string | null } | null;
}

interface RawEntity {
  urn?: string;
  type?: string;
  name?: string;
  dashboardId?: string;
  chartId?: string;
  description?: string | null;
  properties?: { name?: string; description?: string | null } | null;
  platform?: { name?: string } | null;
  ownership?: { owners?: Array<{ owner?: RawOwner | null }> } | null;
}

function decodeUrnPart(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

function datasetNameFromUrn(urn: string): string | undefined {
  const prefix = "urn:li:dataset:(";
  if (!urn.startsWith(prefix) || !urn.endsWith(")")) return undefined;

  const tuple = urn.slice(prefix.length, -1);
  const firstComma = tuple.indexOf(",");
  const lastComma = tuple.lastIndexOf(",");
  if (firstComma === -1 || lastComma === firstComma) return undefined;

  const qualifiedName = decodeUrnPart(
    tuple.slice(firstComma + 1, lastComma).trim(),
  );
  return qualifiedName.split(".").at(-1) || qualifiedName;
}

function lastUrnSegment(urn: string): string {
  const datasetName = datasetNameFromUrn(urn);
  if (datasetName) return datasetName;

  const withoutSuffix = urn.replace(/[)]$/, "");
  const part = withoutSuffix.split(/[,.]/).at(-1) ?? urn;
  return decodeUrnPart(part);
}

function normalizeEntity(
  raw: RawEntity,
  source: DataHubSource = "live",
): DataHubEntity {
  if (!raw.urn) {
    throw new DataHubError(
      "DataHub entity response is missing a URN",
      "INVALID_RESPONSE",
      { details: raw },
    );
  }
  const owners =
    raw.ownership?.owners
      ?.map(({ owner }) => owner)
      .filter((owner): owner is RawOwner => Boolean(owner?.urn))
      .map((owner) => ({
        urn: owner.urn as string,
        name:
          owner.properties?.displayName ||
          owner.username ||
          owner.name ||
          lastUrnSegment(owner.urn as string),
        type: owner.type,
      })) ?? [];

  return {
    urn: raw.urn,
    type: raw.type ?? "UNKNOWN",
    name:
      raw.name ||
      raw.properties?.name ||
      raw.dashboardId ||
      raw.chartId ||
      lastUrnSegment(raw.urn),
    platform: raw.platform?.name,
    description: raw.description || raw.properties?.description || undefined,
    owners,
    source,
  };
}

const DEMO_ROOT: DataHubLineageNode = {
  urn: "urn:li:dataset:(urn:li:dataPlatform:snowflake,acme.ecommerce.orders,PROD)",
  type: "DATASET",
  name: "orders",
  platform: "Snowflake",
  owners: [
    {
      urn: "urn:li:corpgroup:data-platform",
      name: "Data Platform Team",
      type: "CORP_GROUP",
    },
  ],
  degree: 0,
  source: "demo",
};

const DEMO_NODES: DataHubLineageNode[] = [
  {
    urn: "urn:li:dataset:(urn:li:dataPlatform:dbt,acme.analytics.order_finance,PROD)",
    type: "DATASET",
    name: "order_finance",
    platform: "dbt",
    owners: [{ urn: "urn:li:corpgroup:analytics", name: "Analytics Engineering" }],
    degree: 1,
    source: "demo",
  },
  {
    urn: "urn:li:dashboard:(looker,executive_revenue)",
    type: "DASHBOARD",
    name: "Executive Revenue",
    platform: "Looker",
    owners: [{ urn: "urn:li:corpgroup:finance", name: "Finance Analytics" }],
    degree: 2,
    source: "demo",
  },
  {
    urn: "urn:li:dataset:(urn:li:dataPlatform:snowflake,acme.ml.fraud_features,PROD)",
    type: "DATASET",
    name: "fraud_features",
    platform: "Snowflake",
    owners: [{ urn: "urn:li:corpgroup:ml-platform", name: "ML Platform" }],
    degree: 2,
    source: "demo",
  },
];

function fallbackWarning(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Live DataHub was unavailable. Showing labelled demo metadata. ${message}`;
}

function canFallback(config: DataHubConfig, error: unknown): boolean {
  if (!config.demoFallback) return false;
  // Authentication, authorization, malformed queries, and server failures must
  // remain visible. Demo mode is only a connectivity/timeout escape hatch.
  return (
    error instanceof DataHubError &&
    (error.code === "NETWORK" || error.code === "TIMEOUT")
  );
}

export class DataHubClient {
  constructor(
    readonly config: DataHubConfig = loadDataHubConfig(),
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  async health(): Promise<DataHubHealth> {
    const started = Date.now();
    const url = `${this.config.baseUrl}/health`;
    try {
      const response = await this.fetchImpl(url, {
        headers: this.config.token
          ? { authorization: `Bearer ${this.config.token}` }
          : undefined,
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
      const body = (await response.text()).trim();
      if (!response.ok) {
        throw new DataHubError(`DataHub health returned HTTP ${response.status}`, "HTTP", {
          status: response.status,
          details: body.slice(0, 500),
        });
      }
      return {
        ok: true,
        source: "live",
        baseUrl: this.config.baseUrl,
        version:
          response.headers.get("x-datahub-version") ?? (body || undefined),
        latencyMs: Date.now() - started,
      };
    } catch (error) {
      if (canFallback(this.config, error)) {
        return {
          ok: false,
          source: "demo",
          baseUrl: this.config.baseUrl,
          latencyMs: Date.now() - started,
          warning: fallbackWarning(error),
        };
      }
      // Fetch errors in health() have not passed through graphqlRequest.
      if (
        this.config.demoFallback &&
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError" || error instanceof TypeError)
      ) {
        return {
          ok: false,
          source: "demo",
          baseUrl: this.config.baseUrl,
          latencyMs: Date.now() - started,
          warning: fallbackWarning(error),
        };
      }
      throw error;
    }
  }

  async resolveEntity(query: string): Promise<ResolveEntityResult> {
    const trimmed = query.trim();
    if (!trimmed) {
      throw new DataHubError("Entity query cannot be empty", "CONFIG");
    }

    try {
      const data = await graphqlRequest<{
        search?: { searchResults?: Array<{ entity?: RawEntity | null }> };
      }>(
        this.config,
        SEARCH_ENTITY_QUERY,
        {
          input: {
            type: "DATASET",
            query: trimmed,
            start: 0,
            count: 10,
          },
        },
        this.fetchImpl,
      );
      const result = data.search?.searchResults?.find(
        (item) => item.entity?.urn,
      );
      return {
        entity: result?.entity ? normalizeEntity(result.entity) : null,
        source: "live",
      };
    } catch (error) {
      if (!canFallback(this.config, error)) throw error;
      const normalizedQuery = trimmed.toLowerCase();
      const candidates = [DEMO_ROOT, ...DEMO_NODES];
      const match =
        candidates.find(
          (entity) =>
            entity.urn.toLowerCase() === normalizedQuery ||
            entity.name.toLowerCase() === normalizedQuery,
        ) ??
        candidates.find(
          (entity) =>
            entity.urn.toLowerCase().includes(normalizedQuery) ||
            entity.name.toLowerCase().includes(normalizedQuery),
        ) ??
        null;
      return {
        entity: match ? { ...match } : null,
        source: "demo",
        warning: fallbackWarning(error),
      };
    }
  }

  async downstreamLineage(
    rootUrn: string,
    depth = 3,
  ): Promise<DataHubLineage> {
    if (!rootUrn.startsWith("urn:li:")) {
      throw new DataHubError("Lineage root must be a DataHub URN", "CONFIG");
    }
    if (!Number.isInteger(depth) || depth < 1 || depth > 20) {
      throw new DataHubError("Lineage depth must be between 1 and 20", "CONFIG");
    }

    try {
      const queue: Array<{ urn: string; degree: number }> = [
        { urn: rootUrn, degree: 0 },
      ];
      const visited = new Set([rootUrn]);
      const nodes: DataHubLineageNode[] = [];
      const edges: DataHubLineageEdge[] = [];
      const edgeKeys = new Set<string>();
      let nodeLimitReached = false;

      for (let cursor = 0; cursor < queue.length; cursor += 1) {
        const parent = queue[cursor];
        if (parent.degree >= depth) continue;

        const data = await graphqlRequest<{
          scrollAcrossLineage?: {
            searchResults?: Array<{
              degree?: number;
              entity?: RawEntity | null;
            }>;
          };
        }>(
          this.config,
          DOWNSTREAM_LINEAGE_QUERY,
          {
            input: {
              urn: parent.urn,
              direction: "DOWNSTREAM",
              query: "*",
              count: ONE_HOP_RESULT_LIMIT,
              orFilters: [
                {
                  and: [
                    {
                      field: "degree",
                      condition: "EQUAL",
                      negated: false,
                      values: ["1"],
                    },
                  ],
                },
              ],
            },
          },
          this.fetchImpl,
        );

        const children =
          data.scrollAcrossLineage?.searchResults?.filter(
            (
              result,
            ): result is { degree?: number; entity: RawEntity } =>
              Boolean(result.entity?.urn),
          ) ?? [];

        for (const result of children) {
          const childUrn = result.entity.urn as string;
          if (childUrn === rootUrn) continue;

          const childDegree = parent.degree + 1;
          if (!visited.has(childUrn)) {
            if (nodes.length >= LINEAGE_NODE_LIMIT) {
              nodeLimitReached = true;
              continue;
            }
            visited.add(childUrn);
            nodes.push({
              ...normalizeEntity(result.entity),
              degree: childDegree,
            });
            if (childDegree < depth) {
              queue.push({ urn: childUrn, degree: childDegree });
            }
          }

          const edgeKey = `${parent.urn}\0${childUrn}`;
          if (!edgeKeys.has(edgeKey)) {
            edgeKeys.add(edgeKey);
            edges.push({
              from: parent.urn,
              to: childUrn,
              degree: childDegree,
            });
          }
        }
      }

      return {
        rootUrn,
        direction: "DOWNSTREAM",
        nodes,
        edges,
        source: "live",
        warning: nodeLimitReached
          ? `Lineage traversal stopped at the ${LINEAGE_NODE_LIMIT}-node safety limit.`
          : undefined,
      };
    } catch (error) {
      if (!canFallback(this.config, error)) throw error;
      const nodes = DEMO_NODES.filter((node) => node.degree <= depth).map(
        (node) => ({ ...node, owners: node.owners.map((owner) => ({ ...owner })) }),
      );
      return {
        rootUrn,
        direction: "DOWNSTREAM",
        nodes,
        edges: nodes.map((node) => ({
          from: rootUrn,
          to: node.urn,
          degree: node.degree,
        })),
        source: "demo",
        warning: fallbackWarning(error),
      };
    }
  }
}

export function createDataHubClient(
  config = loadDataHubConfig(),
  fetchImpl: FetchLike = fetch,
): DataHubClient {
  return new DataHubClient(config, fetchImpl);
}
