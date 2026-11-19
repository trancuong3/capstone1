import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EntertainmentScreen } from "@/components/entertainment/entertainment-screen";

describe("EntertainmentScreen", () => {
  it("keeps karaoke inside the entertainment hub", () => {
    render(<EntertainmentScreen />);

    expect(
      screen.getByRole("heading", { name: "Hát vui cùng bé" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "Mở thư viện bài hát" }),
    ).toHaveAttribute("href", "/karaoke");
  });
});
