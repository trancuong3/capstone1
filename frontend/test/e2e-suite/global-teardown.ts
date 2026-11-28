import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const frontendDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
);

function restoreSnapshot(filePath: string, envKey: string): void {
  const encoded = process.env[envKey];
  if (!encoded) return;
  const expected = Buffer.from(encoded, "base64").toString("utf8");
  try {
    const current = readFileSync(filePath, "utf8");
    if (current !== expected) {
      writeFileSync(filePath, expected, "utf8");
    }
  } catch {
    writeFileSync(filePath, expected, "utf8");
  }
}

export default async function globalTeardown(): Promise<void> {
  restoreSnapshot(
    path.join(frontendDir, "tsconfig.json"),
    "__E2E_SUITE_TSCONFIG_B64",
  );
  restoreSnapshot(
    path.join(frontendDir, "AGENTS.md"),
    "__E2E_SUITE_AGENTS_B64",
  );
  restoreSnapshot(
    path.join(frontendDir, "next-env.d.ts"),
    "__E2E_SUITE_NEXT_ENV_B64",
  );
}
