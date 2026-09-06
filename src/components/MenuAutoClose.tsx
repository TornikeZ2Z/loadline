"use client";

import { useEffect } from "react";

/**
 * Closes an open `<details data-menu>` when the pointer goes down outside it,
 * or when Escape is pressed.
 *
 * The More menu in AppShell is a `<details>` on purpose: it opens, closes,
 * takes focus and answers the keyboard with no JavaScript at all, which is
 * what the one interactive control in an otherwise server-rendered header
 * should cost. The single thing the element does not do is close when you
 * click past it, and a menu left hanging over the page is the kind of small
 * wrongness that makes a site feel unfinished.
 *
 * So this is an enhancement, not a rewrite. It renders nothing, AppShell stays
 * a server component, and with JavaScript off the menu behaves exactly as it
 * did before.
 */
export function MenuAutoClose() {
  useEffect(() => {
    const open = () =>
      Array.from(document.querySelectorAll<HTMLDetailsElement>("details[data-menu][open]"));

    // Capture phase, so a click that some other handler stops still closes the
    // menu. A pointerdown INSIDE an open menu is left alone: that is either
    // the summary about to toggle it, or a link about to navigate away.
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      for (const d of open()) if (!d.contains(target)) d.open = false;
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      for (const d of open()) {
        d.open = false;
        // Escape should leave the keyboard where it started, not at the top
        // of the document.
        d.querySelector("summary")?.focus();
      }
    };

    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  return null;
}
