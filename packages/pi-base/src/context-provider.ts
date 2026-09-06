// Context provider registry for pi extensions.
//
// Extensions declare context data providers via `registerContextProvider()` during their
// factory function. The `/pi-context` command reads them via `getRegisteredContextProviders()`.

import { createRegistry } from "./registry.js";

export interface ContextProvider {
  /** Unique identifier — e.g. "lsp" */
  id: string;
  /** Human-readable label shown in the report */
  label: string;
  /** Return structured data for display, or null when unavailable. */
  getData: () => Record<string, string | number> | null;
}

const registry = createRegistry<ContextProvider>("context-provider-registry");

/**
 * Register a context data provider for an extension.
 * Duplicate ids replace the previous registration.
 */
export function registerContextProvider(provider: ContextProvider): void {
  registry.register(provider.id, provider);
}

/** Get all registered context providers in registration order. */
export function getRegisteredContextProviders(): ContextProvider[] {
  return registry.getAll();
}

/** Clear the registry — used by tests. */
export function clearRegisteredContextProviders(): void {
  registry.clear();
}
