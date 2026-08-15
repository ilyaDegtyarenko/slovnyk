"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

// Registration is manual (`register: false` in next.config.ts) for one reason: a worker
// installed while the key gate is still shut would precache the gate's redirect as "/",
// and an installed app would keep opening on the gate page long after the key was
// entered. So the worker only registers once a gated-open page is actually on screen.
export function RegisterServiceWorker() {
  const pathname = usePathname();
  useEffect(() => {
    if (
      process.env.NODE_ENV !== "production" ||
      pathname === "/gate" ||
      !("serviceWorker" in navigator)
    ) {
      return;
    }
    void navigator.serviceWorker.register("/sw.js");
  }, [pathname]);
  return null;
}
