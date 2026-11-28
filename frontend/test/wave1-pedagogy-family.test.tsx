import { beforeEach, describe, expect, it } from "vitest";

import {
  clearChildModeLockForUser,
  isChildModeLockedForUser,
  isParentProtectedRoute,
  setChildModeLockedForUser,
} from "@/lib/security/child-mode-lock";

describe("Wave 1 Pedagogy & Child-Safe Family Companion", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("classifies parent-protected routes vs child-accessible learning routes", () => {
    expect(isParentProtectedRoute("/settings")).toBe(true);
    expect(isParentProtectedRoute("/my-books")).toBe(true);
    expect(isParentProtectedRoute("/reading-management")).toBe(true);
    expect(isParentProtectedRoute("/children/new")).toBe(true);
    expect(isParentProtectedRoute("/reports")).toBe(true);

    // Child learning & word-practice surfaces remain accessible!
    expect(isParentProtectedRoute("/dashboard")).toBe(false);
    expect(isParentProtectedRoute("/books")).toBe(false);
    expect(isParentProtectedRoute("/reading-preparation")).toBe(false);
    expect(isParentProtectedRoute("/reports/difficult-words")).toBe(false);
    expect(isParentProtectedRoute("/entertainment/sentence-shooter")).toBe(
      false,
    );
  });

  it("isolates Child-Safe Mode lock state per parent userId", () => {
    const parentA = "11111111-1111-1111-1111-111111111111";
    const parentB = "22222222-2222-2222-2222-222222222222";

    expect(isChildModeLockedForUser(parentA)).toBe(false);
    setChildModeLockedForUser(parentA, true);
    expect(isChildModeLockedForUser(parentA)).toBe(true);
    expect(isChildModeLockedForUser(parentB)).toBe(false);

    clearChildModeLockForUser(parentA);
    expect(isChildModeLockedForUser(parentA)).toBe(false);
  });
});
