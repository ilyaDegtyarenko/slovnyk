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
                className={`relative flex h-12 items-center px-3 text-sm transition-colors ${
                  current
                    ? "font-semibold text-foreground"
                    : "text-zinc-500 hover:text-foreground dark:text-zinc-400 dark:hover:text-foreground"
                }`}
              >
                {link.label}
                {current ? (
                  <span
                    aria-hidden
                    className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-foreground"
                  />
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
