# Using Agora with OpenCode

This guide explains how to connect [OpenCode](https://opencode.ai) to Agora so that any LLM provider supported by OpenCode (including local models via Ollama) can use Agora's 23 MCP tools.

## Prerequisites

- Agora initialized in your repository (`agora init && agora index`)
- OpenCode installed (`brew install opencode` or see [opencode.ai](https://opencode.ai))
- (Optional) Ollama installed if you want to use a local model

## Quick Start

### 1. Add Agora as an MCP server

Add the following to your project's `opencode.json`:

```json
{
  "mcp": {
    "agora": {
      "type": "local",
      "command": ["npx", "-y", "agora-mcp@latest", "serve", "--repo-path", "."],
      "enabled": true
    }
  }
}
```

That's it. OpenCode will start the Agora MCP server automatically and expose all tools to the LLM.

### 2. Verify the connection

Open OpenCode and ask:

```
What is the Agora index status?
```

The LLM should call the `status` tool and return the current index state, file count, and connected agents.

## Using a Local Model (Ollama)

### Install and pull a model

```bash
ollama pull openai-community/gpt2
# or any model that supports tool calling:
ollama pull llama3.1
ollama pull qwen2.5-coder
```

### Configure OpenCode to use Ollama

In your `opencode.json`:

```json
{
  "provider": {
    "ollama": {}
  },
  "model": "ollama/llama3.1",
  "mcp": {
    "agora": {
      "type": "local",
      "command": ["npx", "-y", "agora-mcp@latest", "serve", "--repo-path", "."],
      "enabled": true
    }
  }
}
```

> **Note:** Not all local models handle tool calling well. Models with explicit tool-calling support (Llama 3.1+, Qwen 2.5+, Mistral) work best. Smaller models may hallucinate tool names or produce malformed arguments.

## With Registration Auth

If your Agora instance has `registrationAuth` enabled, pass the token via environment variables in the MCP config:

```json
{
  "mcp": {
    "agora": {
      "type": "local",
      "command": ["npx", "-y", "agora-mcp@latest", "serve", "--repo-path", "."],
      "enabled": true,
      "environment": {
        "AGORA_ROLE_TOKEN_DEVELOPER": "your-dev-token"
      }
    }
  }
}
```

## Using Agora HTTP Transport (Remote)

If Agora is already running as an HTTP server (e.g. `agora serve --transport http --http-port 3000`), you can connect OpenCode to it as a remote MCP server:

```json
{
  "mcp": {
    "agora": {
      "type": "remote",
      "url": "http://localhost:3000",
      "enabled": true
    }
  }
}
```

This is useful when multiple agents need to share the same Agora instance.

Recommendation: prefer the local `type: "local"` stdio setup first. Use HTTP only when multiple local agents or tools need to share one Agora runtime. A separate thin proxy is not recommended at this stage; see `docs/local-llm-proxy-recommendation.md`.

## Available Tools

Once connected, OpenCode has access to all 23 Agora MCP tools:

| Category | Tools |
|----------|-------|
| **Read** | `status`, `capabilities`, `schema`, `get_code_pack`, `get_change_pack`, `get_issue_pack` |
| **Agents** | `register_agent`, `agent_status`, `broadcast`, `claim_files`, `end_session` |
| **Coordination** | `send_coordination`, `poll_coordination` |
| **Patches** | `propose_patch`, `list_patches` |
| **Notes** | `propose_note`, `list_notes` |
| **Knowledge** | `store_knowledge`, `search_knowledge`, `query_knowledge`, `archive_knowledge`, `delete_knowledge` |
| **Tickets** | `create_ticket`, `assign_ticket`, `update_ticket_status`, `update_ticket`, `list_tickets`, `get_ticket`, `comment_ticket` |
| **Index** | `request_reindex` |

Knowledge scope notes:
- `search_knowledge` supports `scope: repo | global | all` and defaults to `all`
- `query_knowledge` supports the same scope options for structured listing

## Context Window Considerations

Agora exposes 23 tools. Each tool schema consumes prompt tokens. If your model has a small context window:

1. **Disable tools you don't need** in `opencode.json`:

```json
{
  "tools": {
    "agora": {
      "propose_patch": false,
      "propose_note": false,
      "claim_files": false,
      "send_coordination": false,
      "poll_coordination": false
    }
  }
}
```

2. **Or limit to read-only** by using an agent config:

```json
{
  "agent": {
    "agora-reader": {
      "description": "Read-only Agora agent for code search and tickets",
      "tools": {
        "agora": {
          "propose_patch": false,
          "propose_note": false,
          "claim_files": false,
          "broadcast": false
        }
      }
    }
  }
}
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Tools not appearing | Check that `enabled: true` is set and the command path is correct |
| "Agent not registered" errors | Ensure the LLM calls `register_agent` before other tools |
| Stale index results | Ask the LLM to call `request_reindex` or run `agora index` manually |
| Tool calls failing with local models | Try a larger model with better tool-calling support (Llama 3.1 70B, Qwen 2.5 32B) |
| Permission denied | Check role tokens if `registrationAuth` is enabled |
