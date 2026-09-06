/**
 * Per-instance idempotency guard for extension activation.
 *
 * Pi rebuilds the extension runtime on /new, /resume, /fork, and /reload,
 * handing the factory a BRAND-NEW `pi`; that must re-register. But a meta-package
 * (e.g. pix-core) can also invoke the same factory, and standalone install makes
 * Pi invoke it again — sometimes against the SAME `pi`. We must dedupe that.
 *
 * Keying the registry on the `pi` instance satisfies both: same instance => skip,
 * new instance => run. The registry lives on globalThis because jiti
 * (moduleCache: false) re-evaluates modules on every load pass, so a module-scoped
 * WeakMap would not be shared between the aggregator pass and the standalone pass.
 *
 * @param pi  The extension API instance (used as WeakMap key)
 * @param key Unique identifier for this extension within the pi instance
 * @param fn  The factory function to call once per (pi, key) pair
 */
export function once(pi: object, key: string, fn: () => void): void {
  const g = globalThis as { __piUtilsOnce?: WeakMap<object, Set<string>> };
  if (!g.__piUtilsOnce) {
    g.__piUtilsOnce = new WeakMap<object, Set<string>>();
  }
  const registry = g.__piUtilsOnce;
  let loaded = registry.get(pi);
  if (!loaded) {
    loaded = new Set<string>();
    registry.set(pi, loaded);
  }
  if (loaded.has(key)) return;
  loaded.add(key);
  fn();
}
