"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Study" },
  { href: "/list", label: "List" },
  { href: "/settings", label: "Settings" },
  { href: "/health", label: "Health" },
] as const;

export function SiteNav() {
  const pathname = usePathname();

  return (
    <nav className="sticky top-0 z-10 border-b border-black/10 bg-background/90 font-sans backdrop-blur dark:border-white/15">
      <ul className="mx-auto flex w-full max-w-3xl gap-1 px-2">
        {LINKS.map((link) => {
          const current = pathname === link.href;
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                aria-current={current ? "page" : undefined}
                className={`flex h-11 items-center rounded-md px-3 text-sm transition-colors hover:bg-black/[.04] dark:hover:bg-white/[.06] ${
                  current
                    ? "font-semibold"
                    : "text-zinc-600 dark:text-zinc-400"
                }`}
              >
                {link.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
