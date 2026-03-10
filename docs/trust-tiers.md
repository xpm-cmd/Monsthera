# Trust Tiers

Agora currently uses two trust tiers:

- Tier `A`
- Tier `B`

There is no runtime Tier `C` today.

## Tier A

Tier `A` is the trusted local worker tier.

Typical roles:

- `developer`
- `reviewer`
- `admin`

Capabilities:

- full evidence bundles with bounded code spans
- patch proposal
- note proposal according to role policy
- ticket mutations according to role policy

## Tier B

Tier `B` is the restricted or observer tier.

Typical role:

- `observer`

Capabilities:

- read-only access to the safe search and inspection surface
- no patch proposal
- no note proposal
- no ticket mutation

Evidence bundles for Tier `B` are redacted: code spans are stripped and only safe metadata remains.

## What Tiers Actually Control

Trust tier is only one part of authorization.

The effective decision path is:

1. tool access policy: public / session / role
2. role permissions: allowed tools and role-specific capabilities
3. trust tier: whether code and sensitive surfaces are available

That means:

- some tools are public regardless of tier
- some tools require an active session
- some tools require both an allowed role and an appropriate tier

## Evidence Bundle Impact

The most visible trust-tier difference is in evidence bundles:

- Tier `A`: bounded code spans are returned
- Tier `B`: code spans are removed and only summaries, symbols, and other safe metadata remain

This keeps code search useful for observers without exposing raw source.

## Current Product Boundary

Tier semantics are stable, but the exact per-tool role matrix lives in code and should not be copied verbatim into this doc.

Use this file for the conceptual model:

- Tier `A` means trusted code-capable worker
- Tier `B` means restricted read-only worker

Use `schemas/agent.ts` and `src/trust/tool-policy.ts` as the canonical source for exact access behavior.
