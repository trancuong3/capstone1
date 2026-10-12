import { vi } from "vitest";

// Fail closed for unconfigured requests: no test may fall through to the network.
export const apiFetchFixture = vi.fn<typeof fetch>();
export function installApiFetchFixture() {
  apiFetchFixture.mockReset();
  apiFetchFixture.mockRejectedValue(
    new Error("Unexpected isolated test request"),
  );
  vi.stubGlobal("fetch", apiFetchFixture);
}
export function requestedApiUrl(index = 0): URL {
  const call = apiFetchFixture.mock.calls[index];
  if (!call) throw new Error("Missing test request");
  const input = call[0];
  return new URL(input instanceof Request ? input.url : String(input));
}
