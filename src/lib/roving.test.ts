import { describe, expect, it } from "vitest";
import { rovingTarget } from "@/lib/roving";

describe("rovingTarget", () => {
  it("walks forward on ArrowRight and ArrowDown, wrapping past the end", () => {
    expect(rovingTarget("ArrowRight", 0, 4)).toBe(1);
    expect(rovingTarget("ArrowDown", 2, 4)).toBe(3);
    expect(rovingTarget("ArrowRight", 3, 4)).toBe(0);
  });

  it("walks backward on ArrowLeft and ArrowUp, wrapping past the start", () => {
    expect(rovingTarget("ArrowLeft", 3, 4)).toBe(2);
    expect(rovingTarget("ArrowUp", 1, 4)).toBe(0);
    expect(rovingTarget("ArrowLeft", 0, 4)).toBe(3);
  });

  it("jumps to the ends on Home and End", () => {
    expect(rovingTarget("Home", 2, 4)).toBe(0);
    expect(rovingTarget("End", 1, 4)).toBe(3);
  });

  it("owns no other key", () => {
    for (const key of [" ", "Enter", "Tab", "a", "1", "Escape", "PageDown"]) {
      expect(rovingTarget(key, 1, 4)).toBeNull();
    }
  });

  it("stays quiet for an empty group", () => {
    expect(rovingTarget("ArrowRight", 0, 0)).toBeNull();
    expect(rovingTarget("Home", 0, -1)).toBeNull();
  });

  it("keeps a lone item in place, whichever way the arrows point", () => {
    expect(rovingTarget("ArrowRight", 0, 1)).toBe(0);
    expect(rovingTarget("ArrowLeft", 0, 1)).toBe(0);
  });
});
