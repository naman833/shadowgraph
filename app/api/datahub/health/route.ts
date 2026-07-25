import { createDataHubClient, DataHubError } from "@/src/datahub";

export async function GET(): Promise<Response> {
  try {
    const health = await createDataHubClient().health();
    return Response.json(health, {
      status: health.ok ? 200 : 503,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    const status =
      error instanceof DataHubError && error.status ? error.status : 500;
    return Response.json(
      {
        ok: false,
        error:
          error instanceof DataHubError
            ? { code: error.code, message: error.message }
            : { code: "UNKNOWN", message: "DataHub health check failed" },
      },
      { status, headers: { "cache-control": "no-store" } },
    );
  }
}
