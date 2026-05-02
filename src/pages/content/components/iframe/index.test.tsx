import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import IFrame from "./index";

describe("IFrame", () => {
  it("renders the commentarium URL with surface=extension appended", () => {
    const { container } = render(<IFrame url="https://example.com/page?x=1" />);
    const iframe = container.querySelector("iframe");
    expect(iframe).not.toBeNull();
    const src = iframe!.getAttribute("src");
    expect(src).toBe(
      "https://commentarium.app/comments?url=" +
        encodeURIComponent("https://example.com/page?x=1") +
        "&surface=extension",
    );
  });

  it("renders an empty-state placeholder when url is empty", () => {
    const { container } = render(<IFrame url="" />);
    expect(container.textContent).toContain("No URL");
    expect(container.querySelector("iframe")).toBeNull();
  });
});
