// Which item a key hands focus to inside a roving-tabindex group (SPEC §7): arrows walk
// the chain and wrap at the ends, Home and End jump to them, every other key is not the
// group's business. Pure so the wrap arithmetic is testable apart from the DOM.
export function rovingTarget(
  key: string,
  activeIndex: number,
  itemCount: number,
): number | null {
  if (itemCount <= 0) {
    return null;
  }
  if (key === "ArrowRight" || key === "ArrowDown") {
    return (activeIndex + 1) % itemCount;
  }
  if (key === "ArrowLeft" || key === "ArrowUp") {
    return (activeIndex - 1 + itemCount) % itemCount;
  }
  if (key === "Home") {
    return 0;
  }
  if (key === "End") {
    return itemCount - 1;
  }
  return null;
}
