/**
 * Loads the TypeScript DataHub adapter from plain JavaScript callers.
 *
 * `src/datahub/index.ts` uses constructor parameter properties, which Node's
 * built-in type stripping rejects, so it is transpiled in memory instead. The
 * result is cached because transpiling on every call would dominate CLI startup.
 */
import { readFile } from "node:fs/promises";

let cached = null;

export async function loadDataHubAdapter() {
  if (cached) return cached;

  const ts = (await import("typescript")).default;
  const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ES2022,
    },
  });
  cached = await import(
    `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
  );
  return cached;
}
