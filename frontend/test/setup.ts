import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

import { resetAllApiCachesForTests } from "@/lib/api/read-cache";

vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({ href, children, ...props }: Record<string, unknown>) =>
      createElement(
        "a",
        { ...props, href: String(href ?? "") },
        children as import("react").ReactNode,
      ),
  };
});

vi.mock("next/image", async () => {
  const { createElement } = await import("react");
  return {
    default: ({
      src,
      alt,
      fill: _fill,
      priority: _priority,
      unoptimized: _unoptimized,
      ...props
    }: Record<string, unknown>) => {
      void _fill;
      void _priority;
      void _unoptimized;
      return createElement("img", {
        ...props,
        src: String(src ?? ""),
        alt: String(alt ?? ""),
      });
    },
  };
});

vi.mock("next/navigation", async () => {
  const { vi } = await import("vitest");
  return {
    useRouter: () => ({
      push: vi.fn(),
      replace: vi.fn(),
      refresh: vi.fn(),
      back: vi.fn(),
      prefetch: vi.fn(),
    }),
    usePathname: () => "/",
    useSearchParams: () => new URLSearchParams(),
    useParams: () => ({}),
    redirect: vi.fn(),
    notFound: vi.fn(),
  };
});

afterEach(() => {
  cleanup();
  resetAllApiCachesForTests();
});
