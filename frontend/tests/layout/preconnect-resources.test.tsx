import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { preconnectMock, prefetchDnsMock } = vi.hoisted(() => ({
  preconnectMock: vi.fn(),
  prefetchDnsMock: vi.fn(),
}));

vi.mock("react-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-dom")>();
  return {
    ...actual,
    preconnect: preconnectMock,
    prefetchDNS: prefetchDnsMock,
  };
});

import { PreconnectResources } from "@/components/common/preconnect-resources";
import { resolvePreconnectOrigins } from "@/lib/utils/origin";

describe("resolvePreconnectOrigins and PreconnectResources", () => {
  beforeEach(() => {
    preconnectMock.mockReset();
    prefetchDnsMock.mockReset();
  });

  it("extracts deduplicated http/https origins and safely ignores missing or invalid values", () => {
    expect(
      resolvePreconnectOrigins([
        undefined,
        null,
        "",
        "   ",
        "/api",
        "not-a-url",
        "ftp://files.example.com/book.pdf",
        "https://capstone1-ssd8.onrender.com/api/v1",
        "https://capstone1-ssd8.onrender.com/health",
        " https://abc.supabase.co/storage/v1/ ",
        "http://127.0.0.1:8000/api",
      ]),
    ).toEqual([
      "https://capstone1-ssd8.onrender.com",
      "https://abc.supabase.co",
      "http://127.0.0.1:8000",
    ]);
  });

  it("invokes ReactDOM.preconnect and prefetchDNS for each origin and renders null", () => {
    const origins = [
      "https://capstone1-ssd8.onrender.com",
      "https://abc.supabase.co",
    ];
    const { container } = render(<PreconnectResources origins={origins} />);

    expect(container.firstChild).toBeNull();
    expect(preconnectMock).toHaveBeenCalledTimes(2);
    expect(preconnectMock).toHaveBeenNthCalledWith(
      1,
      "https://capstone1-ssd8.onrender.com",
      { crossOrigin: "anonymous" },
    );
    expect(preconnectMock).toHaveBeenNthCalledWith(
      2,
      "https://abc.supabase.co",
      { crossOrigin: "anonymous" },
    );
    expect(prefetchDnsMock).toHaveBeenCalledTimes(2);
    expect(prefetchDnsMock).toHaveBeenNthCalledWith(
      1,
      "https://capstone1-ssd8.onrender.com",
    );
    expect(prefetchDnsMock).toHaveBeenNthCalledWith(
      2,
      "https://abc.supabase.co",
    );
  });
});
