# Session Lifecycle with Complete Event Flow

Here's a comprehensive session lifecycle diagram showing all events from startup through multi-turn conversation:

```mermaid
sequenceDiagram
    participant U as User
    participant S as AgentSession
    participant E as Extensions
    participant A as Agent (pi-agent-core)
    participant L as agentLoop
    participant P as LLM Provider (pi-ai)
    participant T as Tools
    participant SM as SessionManager

    Note over U,SM: === SESSION STARTUP ===
    U->>S: Start pi
    S->>E: project_trust (if user/global extension)
    E-->>S: trust decision
    S->>E: session_start { reason: "startup" }
    S->>E: resources_discover { reason: "startup" }
    S->>SM: Load/create session file

    Note over U,SM: === FIRST USER MESSAGE ===
    U->>S: Send first message
    S->>E: input (can intercept/transform)
    E-->>S: (optional) transformed message
    S->>E: before_agent_start (inject messages, modify system prompt)
    S->>A: prompt(userMessage)

    Note over U,SM: === AGENT LOOP START ===
    A->>L: agentLoop(prompts, context, config)
    L->>L: emit agent_start
    L->>A: emit agent_start
    A->>S: emit agent_start
    S->>E: agent_start

    Note over U,SM: === TURN 1: FIRST LLM CALL ===
    L->>L: emit turn_start
    L->>A: emit turn_start
    A->>S: emit turn_start
    S->>E: turn_start

    L->>L: emit message_start { userMessage }
    L->>A: emit message_start
    A->>S: emit message_start
    S->>E: message_start

    L->>L: emit message_end { userMessage }
    L->>A: emit message_end
    A->>S: emit message_end
    S->>E: message_end

    L->>E: context (modify messages before LLM call)
    E-->>L: (optional) modified messages

    L->>E: before_provider_headers (mutate headers)
    L->>E: before_provider_request (inspect/replace payload)

    L->>P: streamSimple(model, messages)

    Note over U,SM: === MODEL STREAMING RESPONSE ===
    P-->>L: start event
    P-->>L: text_start
    P-->>L: text_delta (streaming chunks)
    L->>L: emit message_update with text_delta
    L->>A: emit message_update
    A->>S: emit message_update
    S->>E: message_update

    P-->>L: text_end
    P-->>L: toolcall_start
    P-->>L: toolcall_delta (streaming args)
    P-->>L: toolcall_end (complete toolCall)
    P-->>L: done { reason: "toolUse" }

    Note over U,SM: === TOOL EXECUTION ===
    L->>L: emit message_start { assistantMessage with toolCall }
    L->>A: emit message_start
    A->>S: emit message_start
    S->>E: message_start

    L->>L: emit message_end { assistantMessage }
    L->>A: emit message_end
    A->>S: emit message_end
    S->>E: message_end

    L->>E: tool_execution_start { toolCallId, toolName, args }
    L->>E: tool_call (can block)
    L->>T: execute tool
    T-->>L: partial results (streaming)
    L->>L: emit tool_execution_update { partialResult }
    L->>A: emit tool_execution_update
    A->>S: emit tool_execution_update
    S->>E: tool_execution_update

    T-->>L: final result
    L->>E: tool_result (can modify)
    L->>L: emit tool_execution_end { result, isError }
    L->>A: emit tool_execution_end
    A->>S: emit tool_execution_end
    S->>E: tool_execution_end

    L->>L: emit message_start { toolResultMessage }
    L->>A: emit message_start
    A->>S: emit message_start
    S->>E: message_start

    L->>L: emit message_end { toolResultMessage }
    L->>A: emit message_end
    A->>S: emit message_end
    S->>E: message_end

    L->>SM: Persist message entries (save point)

    Note over U,SM: === TURN 1 END ===
    L->>L: emit turn_end { message, toolResults }
    L->>A: emit turn_end
    A->>S: emit turn_end
    S->>E: turn_end

    Note over U,SM: === TURN 2: RESPONSE TO TOOL RESULT ===
    L->>L: emit turn_start
    L->>A: emit turn_start
    A->>S: emit turn_start
    S->>E: turn_start

    L->>P: streamSimple (with tool result in context)
    P-->>L: text_start
    P-->>L: text_delta
    L->>L: emit message_update
    L->>A: emit message_update
    A->>S: emit message_update
    S->>E: message_update

    P-->>L: text_end
    P-->>L: done { reason: "stop" }

    L->>L: emit message_start { assistantMessage }
    L->>A: emit message_start
    A->>S: emit message_start
    S->->E: message_start

    L->>L: emit message_end { assistantMessage }
    L->>A: emit message_end
    A->>S: emit message_end
    S->>E: message_end

    L->>SM: Persist message entries

    L->>L: emit turn_end { message, toolResults: [] }
    L->>A: emit turn_end
    A->>S: emit turn_end
    S->>E: turn_end

    Note over U,SM: === AGENT LOOP END ===
    L->>L: emit agent_end { messages }
    L->>A: emit agent_end
    A->>S: emit agent_end
    S->>E: agent_end

    S->>E: agent_settled (no retry/compaction/follow-up left)

    Note over U,SM: === MULTI-TURN: USER SENDS ANOTHER MESSAGE ===
    U->>S: Send second message
    S->>E: input
    S->>E: before_agent_start
    S->>A: prompt(userMessage)

    A->>L: agentLoop (with accumulated context)
    L->>L: emit agent_start
    L->>A: emit agent_start
    A->>S: emit agent_start
    S->>E: agent_start

    Note over U,SM: === TURN 3: WITH COMPACTION ===
    L->>E: context (modify messages)
    L->>SM: Check context window
    SM-->>L: Context full, trigger compaction

    S->>E: session_before_compact (can cancel/customize)
    S->>SM: compact()
    SM->>SM: Generate summary
    SM->>SM: Replace old messages with CompactionEntry
    S->>E: session_compact
    S->>E: compaction_start
    S->>E: compaction_end

    L->>L: emit turn_start
    L->->A: emit turn_start
    A->>S: emit turn_start
    S->>E: turn_start

    L->>P: streamSimple (with compacted context)
    P-->>L: text_delta
    L->>L: emit message_update
    L->>A: emit message_update
    A->>S: emit message_update
    S->>E: message_update

    P-->>L: done
    L->>L: emit turn_end
    L->>A: emit turn_end
    A->>S: emit turn_end
    S->>E: turn_end

    L->>L: emit agent_end
    L->>A: emit agent_end
    A->>S: emit agent_end
    S->>E: agent_end
    S->>E: agent_settled

    Note over U,SM: === SESSION SHUTDOWN ===
    U->>S: Exit (Ctrl+C)
    S->>E: session_shutdown
    S->>SM: Flush pending writes
    S->>SM: Close session file
```

## Event Categories

### Session Lifecycle Events

- `project_trust` - Fired before project trust decision (user/global extensions only)
- `session_start` - Fired when session starts/loads/reloads with reason
- `resources_discover` - Fired during startup for resource discovery
- `session_shutdown` - Fired on exit or session switch
- `session_before_compact` / `session_compact` - Fired before/after compaction

### Agent Lifecycle Events

- `agent_start` - Agent begins processing a prompt
- `agent_end` - One low-level agent run completes
- `agent_settled` - Agent run is fully settled (no automatic retry/compaction/follow-up)

### Turn Lifecycle Events

- `turn_start` - New turn begins (one LLM call + tool executions)
- `turn_end` - Turn completes with assistant message and tool results

### Message Lifecycle Events

- `message_start` - Any message begins (user, assistant, toolResult)
- `message_update` - Assistant streaming updates with `assistantMessageEvent`
- `message_end` - Message completes

### Tool Execution Events

- `tool_execution_start` - Tool begins execution
- `tool_execution_update` - Tool execution progress (streaming output)
- `tool_execution_end` - Tool completes

### Provider Streaming Events (pi-ai)

- `start` - Message generation started
- `text_start` / `text_delta` / `text_end` - Text content streaming
- `thinking_start` / `thinking_delta` / `thinking_end` - Thinking content streaming
- `toolcall_start` / `toolcall_delta` / `toolcall_end` - Tool call streaming
- `done` - Message complete with reason

### Extension Hook Events

- `input` - Can intercept, transform, or handle user input
- `before_agent_start` - Can inject messages, modify system prompt
- `context` - Modify messages non-destructively before each LLM call
- `before_provider_headers` - Mutate HTTP headers
- `before_provider_request` - Inspect or replace provider payload
- `tool_call` - Can block tool execution
- `tool_result` - Can modify tool results

## Notes

- The diagram shows a complete lifecycle including session startup, first message, tool execution, multi-turn conversation, and compaction
- Events flow from low-level agent loop through Agent class to AgentSession and finally to extensions
- Provider events (text_delta, toolcall_delta, etc.) are wrapped in `message_update` events from the agent
- Tool execution in parallel mode emits `tool_execution_end` in completion order, but toolResult messages are appended in assistant source order
