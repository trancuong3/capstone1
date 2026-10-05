import { describe, expect, it } from "vitest";

import {
  getProtectedRouteArea,
  getProtectedRouteRedirect,
} from "@/lib/auth/route-policy";

describe("protected route policy", () => {
  it.each([
    ["/dashboard", "parent"],
    ["/children/new", "parent"],
    ["/books/book-id", "parent"],
    ["/reading/session-id", "parent"],
    ["/reports/difficult-words", "parent"],
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
  });

  it("redirects guests and cross-role users to fixed safe destinations", () => {
    expect(getProtectedRouteRedirect("/dashboard", null)).toBe("/login");
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
