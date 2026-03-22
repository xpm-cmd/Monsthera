# Monsthera Multi-Agent Coordination

This repo uses Monsthera for multi-agent coordination. When working with other agents:

## Setup
- Register with `register_agent` at the start of each session
- Use your `agentId` and `sessionId` on all subsequent calls

## Before Editing
- Call `get_code_pack` to get current context (note the commit SHA)
- Call `claim_files` for files you plan to modify
- Check for conflicts in the response

## Submitting Changes
- Always include `baseCommit` (the HEAD when you read the code)
- Use `propose_patch` with a unified diff
- If rejected as stale, re-read context and re-propose

## Communication
- Use `propose_note` to document decisions, issues, and gotchas
- Use `send_coordination` to signal task claims/releases
- Poll `poll_coordination` for messages from other agents

## Dashboard
- Admin dashboard available at http://localhost:3141
