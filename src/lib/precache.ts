// Serwist follows redirects while precaching, and behind the key gate every document
// redirects to /gate: caching what the redirect lands on would install the gate page as
// the offline app shell. Refusing keeps the install from ever completing — the worker
// hangs in `installing`, nothing is cached, and the previous worker with its good shell
// stays in charge until the device is let in again.
export function isCacheableShellResponse(response: {
  redirected: boolean;
  status: number;
}): boolean {
  return !response.redirected && response.status < 400;
}
