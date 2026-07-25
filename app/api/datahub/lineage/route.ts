import { createDataHubClient, DataHubError } from "@/src/datahub";

export async function POST(request: Request): Promise<Response> {
  let body: { urn?: unknown; depth?: unknown };
  try {
    body = (await request.json()) as { urn?: unknown; depth?: unknown };
  } catch {
    return Response.json(
      { error: { code: "BAD_REQUEST", message: "Expected a JSON request body" } },
      { status: 400 },
    );
  }

  const urn = typeof body.urn === "string" ? body.urn.trim() : "";
  const depth = body.depth === undefined ? 3 : Number(body.depth);
  if (!urn) {
    return Response.json(
      { error: { code: "BAD_REQUEST", message: "urn is required" } },
      { status: 400 },
    );
  }

  try {
    const lineage = await createDataHubClient().downstreamLineage(urn, depth);
    return Response.json(lineage, {
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    const isInputError =
      error instanceof DataHubError && error.code === "CONFIG";
    const status =
      isInputError
        ? 400
        : error instanceof DataHubError && error.status
          ? error.status
          : 502;
    return Response.json(
      {
        error:
          error instanceof DataHubError
            ? { code: error.code, message: error.message }
            : { code: "UNKNOWN", message: "Lineage lookup failed" },
      },
      { status },
    );
  }
}
