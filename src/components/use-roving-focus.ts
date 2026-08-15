import { useState, type KeyboardEvent } from "react";
import { rovingTarget } from "@/lib/roving";

type RovingGroupProps = {
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
};

type RovingItemProps = {
  tabIndex: number;
  onFocus: () => void;
};

export type RovingFocus = {
  groupProps: RovingGroupProps;
  itemProps: (index: number) => RovingItemProps;
};

// One Tab stop for a whole group of buttons (SPEC §7): Tab lands on the last-visited
// one — `initialIndex` before any visit — the arrow keys walk the chain, and the next
// Tab leaves the group in a single step instead of crawling through every button.
// The group element must contain exactly the item buttons, in `itemProps` order.
export function useRovingFocus(
  itemCount: number,
  initialIndex = 0,
): RovingFocus {
  const [visitedIndex, setVisitedIndex] = useState(initialIndex);
  // The group can shrink under the remembered position, e.g. a tag filter losing tags.
  const activeIndex = Math.min(visitedIndex, Math.max(0, itemCount - 1));

  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    const targetIndex = rovingTarget(event.key, activeIndex, itemCount);
    if (targetIndex === null) {
      return;
    }

    // The arrows are spent on moving focus; left alone they would also scroll the page.
    event.preventDefault();
    event.currentTarget.querySelectorAll("button").item(targetIndex)?.focus();
    setVisitedIndex(targetIndex);
  };

  return {
    groupProps: { onKeyDown },
    itemProps: (index) => ({
      tabIndex: index === activeIndex ? 0 : -1,
      onFocus: () => setVisitedIndex(index),
    }),
  };
}
