import "@testing-library/jest-dom/vitest";

import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

import { resetAllApiCachesForTests } from "@/lib/api/read-cache";
import { DEFAULT_LOCALE } from "@/lib/i18n/locales";
import { registerPersistentTestNamespace } from "@/messages/loader";
import viAdminMessages from "@/messages/vi/admin.json";

registerPersistentTestNamespace(DEFAULT_LOCALE, "admin", viAdminMessages);

if (
  typeof Blob !== "undefined" &&
  typeof Blob.prototype.stream !== "function"
) {
  Object.defineProperty(Blob.prototype, "stream", {
    configurable: true,
    writable: true,
    value: function stream(this: Blob): ReadableStream<Uint8Array> {
      return new ReadableStream<Uint8Array>({
        start: async (controller) => {
          try {
            const buffer = await this.arrayBuffer();
            controller.enqueue(new Uint8Array(buffer));
            controller.close();
          } catch (error) {
            controller.error(error);
          }
        },
      });
    },
  });
}

vi.mock("next/link", async () => {
  const { createElement } = await import("react");
  return {
    default: ({
      href,
      children,
      prefetch: _prefetch,
      ...props
    }: Record<string, unknown>) => {
      void _prefetch;
      return createElement(
        "a",
        { ...props, href: String(href ?? "") },
        children as import("react").ReactNode,
      );
    },
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
