import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EmptyState } from "@/components/common/empty-state";

describe("EmptyState", () => {
  it("allows a page-level empty state to expose the page heading", () => {
    render(
      <EmptyState
        description="The requested resource is unavailable."
        headingLevel={1}
        title="Resource not found"
      />,
    );

    expect(
      screen.getByRole("heading", { level: 1, name: "Resource not found" }),
    ).toBeInTheDocument();
  });
});
