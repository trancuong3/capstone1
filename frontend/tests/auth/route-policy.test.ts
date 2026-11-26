import { describe, expect, it } from "vitest";

import {
  buildLoginRedirectPath,
  getProtectedRouteArea,
  getProtectedRouteRedirect,
  isSafeRelativeNextCandidate,
  sanitizeNextPath,
} from "@/lib/auth/route-policy";

describe("protected route policy", () => {
  it.each([
    ["/dashboard", "parent"],
    ["/children/new", "parent"],
    ["/books/book-id", "parent"],
    ["/reading/session-id", "parent"],
    ["/reports/difficult-words", "parent"],
    ["/karaoke", "parent"],
    ["/karaoke/song-id", "parent"],
    ["/admin", "admin"],
    ["/admin/books/book-id", "admin"],
  ] as const)("classifies %s as %s", (pathname, area) => {
    expect(getProtectedRouteArea(pathname)).toBe(area);
  });

  it.each(["/login", "/register", "/reset-password", "/admin/login"])(
    "keeps %s public",
    (pathname) => {
      expect(getProtectedRouteArea(pathname)).toBeNull();
    },
  );

  it("uses exact route boundaries", () => {
    expect(getProtectedRouteArea("/dashboard-preview")).toBeNull();
    expect(getProtectedRouteArea("/administrator")).toBeNull();
    expect(getProtectedRouteArea("/karaoke-preview")).toBeNull();
  });

  it("redirects guests and cross-role users to fixed safe destinations", () => {
    expect(getProtectedRouteRedirect("/dashboard", null)).toBe("/login");
    expect(getProtectedRouteRedirect("/karaoke", null)).toBe("/login");
    expect(getProtectedRouteRedirect("/karaoke/song-id", "admin")).toBe(
      "/admin/books",
    );
    expect(getProtectedRouteRedirect("/karaoke/song-id", "parent")).toBeNull();
    expect(getProtectedRouteRedirect("/admin/books", null)).toBe(
      "/admin/login",
    );
    expect(getProtectedRouteRedirect("/admin/books", "parent")).toBe(
      "/dashboard",
    );
    expect(getProtectedRouteRedirect("/dashboard", "admin")).toBe(
      "/admin/books",
    );
    expect(getProtectedRouteRedirect("/dashboard", "parent")).toBeNull();
    expect(getProtectedRouteRedirect("/admin/books", "admin")).toBeNull();
  });
});

describe("sanitizeNextPath and deep-link helpers", () => {
  it("preserves safe same-origin deep links with query and hash for the matching role", () => {
    expect(
      sanitizeNextPath("/books/book-1?page=2&childId=child-9#top", "parent"),
    ).toBe("/books/book-1?page=2&childId=child-9#top");
    expect(sanitizeNextPath("/reading/session-1?childId=c1", "parent")).toBe(
      "/reading/session-1?childId=c1",
    );
    expect(sanitizeNextPath("/admin/parents?page=2&search=an", "admin")).toBe(
      "/admin/parents?page=2&search=an",
    );
    expect(sanitizeNextPath("/admin", "admin")).toBe("/admin");
  });

  it.each([
    null,
    undefined,
    "",
    "   ",
    "https://evil.example/dashboard",
    "http://evil.example/admin/books",
    "//evil.example/dashboard",
    "///evil.example/dashboard",
    "/\\evil.example/dashboard",
    "/books\\..\\admin",
    "/%5cevil.example",
    "/%2f/evil.example",
    "javascript:alert(1)",
    "/dashboard\nSet-Cookie:x=1",
    "/login",
    "/login?next=/dashboard",
    "/admin/login",
    "/register",
    "/forgot-password",
    "/reset-password",
    "/auth/callback",
    "/unknown-public-page",
  ])("rejects unsafe or loop target %s", (raw) => {
    expect(sanitizeNextPath(raw, "parent")).toBe("/dashboard");
    expect(sanitizeNextPath(raw, "admin")).toBe("/admin/books");
  });

  it("enforces role boundaries on cross-role deep links", () => {
    expect(sanitizeNextPath("/admin/parents?page=2", "parent")).toBe(
      "/dashboard",
    );
    expect(sanitizeNextPath("/admin/books", "parent")).toBe("/dashboard");
    expect(sanitizeNextPath("/dashboard", "admin")).toBe("/admin/books");
    expect(sanitizeNextPath("/books/book-1", "admin")).toBe("/admin/books");
  });

  it("validates relative candidates and builds encoded login redirects", () => {
    expect(isSafeRelativeNextCandidate("/books/b1?tab=preview")).toBe(
      "/books/b1?tab=preview",
    );
    expect(isSafeRelativeNextCandidate("//evil.example")).toBeNull();
    expect(isSafeRelativeNextCandidate("/login")).toBeNull();

    expect(buildLoginRedirectPath("/login", "/books/b1?tab=preview")).toBe(
      "/login?next=%2Fbooks%2Fb1%3Ftab%3Dpreview",
    );
    expect(
      buildLoginRedirectPath("/admin/login", "/admin/parents?page=2"),
    ).toBe("/admin/login?next=%2Fadmin%2Fparents%3Fpage%3D2");
    expect(buildLoginRedirectPath("/login", "https://evil.example")).toBe(
      "/login",
    );
  });
});
