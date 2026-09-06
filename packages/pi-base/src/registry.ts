// Shared Symbol.for-based registry pattern for pi extensions.
//
// Uses globalThis + Symbol.for so that all jiti module instances
// (resolved through different node_modules symlinks) share the same Map.
// Without this, each symlink path gets its own module copy and its own Map,
// so registrations from one instance are invisible to consumers in another.

import { resolve } from "node:path";

const SYMBOL_PREFIX = "@k0valik/pi-base/";

function getGlobalRegistryMap<T>(name: string): Map<string, T> {
  const key = Symbol.for(SYMBOL_PREFIX + name);
  let map = (globalThis as Record<symbol, unknown>)[key] as Map<string, T> | undefined;
  if (!map) {
    map = new Map<string, T>();
    (globalThis as Record<symbol, unknown>)[key] = map;
  }
  return map;
}

/**
 * Create a named registry backed by `globalThis` + `Symbol.for`.
 *
 * The registry is lazily initialized on first access and shared across all
 * jiti module instances via the global symbol namespace.
 */
export function createRegistry<T>(name: string) {
  const getMap = (): Map<string, T> => getGlobalRegistryMap<T>(name);

  return {
    register: (id: string, value: T): void => {
      getMap().set(id, value);
    },
    unregister: (id: string): void => {
      getMap().delete(id);
    },
    getAll: (): T[] => {
      return Array.from(getMap().values());
    },
    clear: (): void => {
      getMap().clear();
    },
  };
}

/**
 * Create a named session-state registry keyed by normalized cwd.
 */
export function createSessionStateRegistry<TState>(name: string) {
  const getMap = (): Map<string, TState> => getGlobalRegistryMap<TState>(name);

  return {
    get: (cwd: string): TState | undefined => {
      return getMap().get(resolve(cwd));
    },
    set: (cwd: string, state: TState): void => {
      getMap().set(resolve(cwd), state);
    },
    clear: (cwd: string): void => {
      getMap().delete(resolve(cwd));
    },
  };
}
