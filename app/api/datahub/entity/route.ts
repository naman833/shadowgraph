import { createDataHubClient, DataHubError } from "@/src/datahub";

export async function GET(request: Request): Promise<Response> {
  const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (!query) {
    return Response.json(
      { error: { code: "BAD_REQUEST", message: "Query parameter q is required" } },
      { status: 400 },
    );
  }

  try {
    const result = await createDataHubClient().resolveEntity(query);
    return Response.json(result, {
      status: result.entity ? 200 : 404,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    const status =
      error instanceof DataHubError && error.status ? error.status : 502;
    return Response.json(
      {
        error:
          error instanceof DataHubError
            ? { code: error.code, message: error.message }
            : { code: "UNKNOWN", message: "Entity resolution failed" },
      },
      { status },
    );
  }
}
