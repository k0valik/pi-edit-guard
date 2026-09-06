// Test utilities — pi ExtensionAPI mock for extension unit tests.
// Not intended for production use.

import { vi } from "vitest";

export interface PiMockOptions {
  sessionName?: string;
}

export interface PiMock {
  on: (event: string, handler: (...args: unknown[]) => unknown) => void;
  registerCommand: (name: string, spec: unknown) => void;
  registerTool: (tool: unknown) => void;
  registerMessageRenderer: (type: string, renderer: unknown) => void;
  registerShortcut: (key: string, opts: { handler: (ctx: unknown) => unknown }) => void;
  appendEntry: (type: string, data: unknown) => void;
  sendMessage: (message: Record<string, unknown>) => void;
  getSessionName: () => string | undefined;
  getActiveTools: () => string[];
  setActiveTools: (tools: string[]) => void;
  getAllTools: () => Array<unknown>;
  emit: (event: string, ...args: unknown[]) => Promise<unknown>;
  exec: (
    command: string,
    args: string[],
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  events: {
    on: (channel: string, handler: (data: unknown) => void) => () => void;
    emit: (channel: string, data: unknown) => void;
  };
  handlers: Map<string, Array<(...args: unknown[]) => unknown>>;
  commands: Map<string, unknown>;
  tools: Array<unknown>;
  renderers: Map<string, unknown>;
  entries: Array<{ type: string; data: unknown }>;
  messages: Array<Record<string, unknown>>;
  shortcuts: Map<string, Array<(ctx: unknown) => unknown>>;
  execCalls: Array<{ command: string; args: string[] }>;
  getHandlers: (event: string) => Array<(...args: unknown[]) => unknown>;
  getCommandHandler: (name: string) => unknown;
  getShortcutHandlers: (key: string) => Array<(ctx: unknown) => unknown>;
  getExecCalls: () => Array<{ command: string; args: string[] }>;
  ui: {
    setStatus: ReturnType<typeof vi.fn>;
  };
}

export function createPiMock(options: PiMockOptions = {}): PiMock {
  const handlers = new Map<string, Array<(...args: unknown[]) => unknown>>();
  const commands = new Map<string, unknown>();
  const tools: Array<unknown> = [];
  const renderers = new Map<string, unknown>();
  const entries: Array<{ type: string; data: unknown }> = [];
  const messages: Array<Record<string, unknown>> = [];
  const shortcuts = new Map<string, Array<(ctx: unknown) => unknown>>();
  const execCalls: Array<{ command: string; args: string[] }> = [];
  const eventBusHandlers = new Map<string, Array<(data: unknown) => void>>();
  let activeTools: string[] = [];

  return {
    on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    }),

    registerCommand: vi.fn((name: string, spec: unknown) => {
      commands.set(name, spec);
    }),

    registerTool: vi.fn((tool: unknown) => {
      tools.push(tool);
    }),

    registerMessageRenderer: vi.fn((type: string, renderer: unknown) => {
      renderers.set(type, renderer);
    }),

    registerShortcut: vi.fn((key: string, opts: { handler: (ctx: unknown) => unknown }) => {
      const list = shortcuts.get(key) ?? [];
      list.push(opts.handler);
      shortcuts.set(key, list);
    }),

    appendEntry: vi.fn((type: string, data: unknown) => {
      entries.push({ type, data });
    }),

    sendMessage: vi.fn((message: Record<string, unknown>) => {
      messages.push(message);
    }),

    getSessionName: vi.fn(() => options.sessionName),
    getActiveTools: vi.fn(() => activeTools),
    setActiveTools: vi.fn((tools: string[]) => {
      activeTools = tools;
    }),
    getAllTools: vi.fn(() => tools),

    exec: vi.fn(async (_command: string, _args: string[]) => {
      execCalls.push({ command: _command, args: _args });
      return { code: 0, stdout: "", stderr: "" };
    }),

    events: {
      on: vi.fn((channel: string, handler: (data: unknown) => void) => {
        const list = eventBusHandlers.get(channel) ?? [];
        list.push(handler);
        eventBusHandlers.set(channel, list);
        return () => {
          const idx = list.indexOf(handler);
          if (idx !== -1) list.splice(idx, 1);
        };
      }),
      emit: vi.fn((channel: string, data: unknown) => {
        for (const handler of eventBusHandlers.get(channel) ?? []) {
          handler(data);
        }
      }),
    },

    emit: async (event: string, ...args: unknown[]) => {
      const eventHandlers = handlers.get(event);
      if (!eventHandlers) return undefined;
      // First defined result wins — mirrors pi's chained-handler semantics
      // where the first handler to return a value (e.g. a block) decides.
      let result: unknown;
      for (const handler of eventHandlers) {
        const value = await handler(...args);
        if (value !== undefined && result === undefined) result = value;
      }
      return result;
    },

    handlers,
    commands,
    tools,
    renderers,
    entries,
    messages,
    shortcuts,
    execCalls,

    getHandlers: (event: string) => handlers.get(event) ?? [],
    getCommandHandler: (name: string) => {
      const spec = commands.get(name);
      return spec && typeof spec === "object" && "handler" in (spec as Record<string, unknown>)
        ? (spec as Record<string, unknown>).handler
        : spec;
    },
    getShortcutHandlers: (key: string) => shortcuts.get(key) ?? [],
    getExecCalls: () => execCalls,

    ui: {
      setStatus: vi.fn(),
    },
  } as unknown as PiMock;
}

export function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    cwd: "/project",
    model: { provider: "openai", id: "gpt-4", name: "GPT-4" },
    ui: {
      setStatus: vi.fn(),
      notify: vi.fn(),
      setTitle: vi.fn(),
      setWidget: vi.fn(),
      removeWidget: vi.fn(),
      getEditorText: vi.fn(() => ""),
      setEditorText: vi.fn(),
      input: vi.fn(async () => undefined as string | undefined),
      custom: vi.fn(async () => null as unknown),
      theme: {
        accent: "cyan",
        dim: "gray",
        error: "red",
        warning: "yellow",
        success: "green",
        fg: (_color: string, text: string) => text,
        bg: (_color: string, text: string) => text,
        bold: (text: string) => text,
      },
    },
    sessionManager: {
      getBranch: vi.fn(() => []),
      getSessionId: vi.fn(() => "mock-session-id"),
    },
    getContextUsage: vi.fn(
      () =>
        undefined as
          | {
              tokens: number | null;
              contextWindow: number;
              percent: number | null;
            }
          | undefined,
    ),
    getSystemPrompt: vi.fn(() => "System"),
    ...overrides,
  };
}

// ── Handler helpers ─────────────────────────────────────────────────────────

type Handler = (...args: unknown[]) => unknown;

/**
 * Returns the first handler for an event, or undefined if none registered.
 */
export function getHandler(pi: PiMock, event: string): Handler | undefined {
  return pi.getHandlers(event)[0];
}

/**
 * Returns the first handler for an event, or throws if none registered.
 */
export function getHandlerOrThrow(pi: PiMock, event: string): Handler {
  const handlers = pi.getHandlers(event);
  if (handlers.length === 0) {
    throw new Error(`Handler for "${event}" not registered`);
  }
  return handlers[0];
}
