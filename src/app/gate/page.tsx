import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { decideGate, GATE_COOKIE_NAME } from "@/lib/gate";

export default async function GatePage({ searchParams }: PageProps<"/gate">) {
  const [{ error }, cookieStore] = await Promise.all([searchParams, cookies()]);
  // Asking about "/" rather than "/gate": the question is whether the rest of the app
  // would let this device in. An open door needs no gate page — with no key configured,
  // or the cookie already set, the form would only mislead.
  const decision = await decideGate({
    appKey: process.env.APP_KEY,
    cookieValue: cookieStore.get(GATE_COOKIE_NAME)?.value,
    pathname: "/",
  });
  if (decision === "allow" || decision === "renew") {
    redirect("/");
  }

  return (
    <main className="mx-auto flex w-full max-w-sm flex-1 flex-col justify-center gap-4 px-4 py-6 font-sans">
      <form method="post" action="/api/gate" className="flex flex-col gap-3">
        <input
          type="password"
          name="key"
          required
          aria-label="Access key"
          placeholder="Access key"
          autoComplete="current-password"
          className="h-12 w-full rounded-full border border-black/10 bg-black/[.03] px-5 text-base transition-colors placeholder:text-zinc-400 dark:border-white/10 dark:bg-white/[.04] dark:placeholder:text-zinc-500"
        />
        <button
          type="submit"
          className="flex h-12 items-center justify-center rounded-full bg-foreground px-6 text-base font-medium text-background transition-[opacity,transform] duration-150 hover:opacity-90 active:scale-[0.97]"
        >
          Unlock
        </button>
      </form>
      {error === undefined ? null : (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          That key did not match. Check it and try again.
        </p>
      )}
    </main>
  );
}
