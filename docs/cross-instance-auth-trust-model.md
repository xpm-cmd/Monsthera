# Cross-Instance Authentication and Trust Model

Status: proposed v1 design for `TKT-d10c324a`

Related tickets:

- `TKT-93d9c6d2` resolved the operator model as one Monsthera instance per repository
- `TKT-d10c324a` defines the auth/trust prerequisite for any cross-instance work
- `TKT-f136ecb0` remains blocked on this design and its implementation

## Decision

Monsthera v1 cross-instance communication should use:

- one authenticated instance identity per repo-local Monsthera runtime
- explicit manual peer registration
- per-peer HMAC shared secrets configured out of band
- signed HTTP requests with timestamp and nonce
- remote capability allowlists that default to least privilege
- no remote session impersonation

This keeps the current local-first model intact while making federation possible later without inventing a global identity system.

## Goals

- authenticate one Monsthera instance to another
- keep trust bootstrap simple and operator-controlled
- preserve the existing local role and trust-tier model
- make failures auditable and fail closed
- bound the scope enough that `TKT-d10c324a` can move to implementation after review

## Non-Goals For v1

- automatic peer discovery
- transitive trust between instances
- propagating foreign agent sessions as local principals
- exposing mutating tools by default
- turning one Monsthera runtime into a multi-repo control plane

## Instance Identity

Each Monsthera instance gets a stable operator-assigned `instanceId`.

Requirements:

- unique within the peer set
- stable across restarts
- stored in config, not generated per session
- attached to every outbound cross-instance request

Recommended format:

- short slug such as `monsthera-repo-main`
- not derived from ephemeral process state

Each peer record must also store:

- `baseUrl`
- `enabled`
- `capabilityPolicy`
- `sharedSecret`
- optional `nextSharedSecret` during rotation

## Trust Bootstrap

Trust bootstrap is manual and config-driven in v1.

Operators add peers explicitly, including:

- remote `instanceId`
- remote `baseUrl`
- shared secret
- allowed capability classes

This means trust is bilateral only when both sides are configured. There is no discovery handshake and no trust-on-first-use behavior.

## Request Authentication

Every cross-instance HTTP request must include these headers:

- `X-Monsthera-Instance-Id`
- `X-Monsthera-Timestamp`
- `X-Monsthera-Nonce`
- `X-Monsthera-Signature`

Signature input should be:

- request method
- request path
- canonical query string
- timestamp
- nonce
- SHA-256 of the request body
- sender `instanceId`

Signature algorithm for v1:

- `HMAC-SHA256(sharedSecret, canonicalString)`

Verification rules:

- peer exists and is enabled
- `instanceId` matches configured peer
- timestamp is within allowed skew window
- nonce has not been seen recently for that peer
- signature matches current or rotating secret

Recommended skew window:

- `+/- 120 seconds`

Recommended nonce retention:

- `10 minutes` per peer

## Authorization Model

Authentication answers who the remote instance is. Authorization answers what it may do.

In v1, authorization is peer-scoped, not foreign-session-scoped.

That means:

- foreign `agentId` and `sessionId` are not treated as local authenticated principals
- the receiving instance executes the request as a remote system actor such as `system:peer-<instanceId>`
- optional origin metadata may be forwarded for audit only

Default capability policy:

- read-only, summary-oriented operations only
- equivalent to current least-privilege / Tier B behavior unless explicitly elevated

Allowed initial remote classes:

- search and retrieval
- bounded knowledge queries
- read-only ticket lookup if explicitly enabled

Disallowed by default:

- ticket mutation
- patch proposal
- agent registration
- coordination writes
- any action that mutates repo-local operational state

If mutating remote actions are ever enabled later, they must be opt-in per peer and come in a separate ticket after this v1 baseline ships.

## Identity Propagation

Raw local sessions do not cross instance boundaries in v1.

Instead:

- sender may include advisory origin metadata such as local `agentId`, local role, and request purpose
- receiver stores that metadata in audit logs
- receiver does not authorize based on that forwarded identity

This avoids a confused-deputy design where one instance can mint effective local authority on another.

## Failure Behavior

Cross-instance auth must fail closed.

Required behavior:

- unknown peer -> reject
- disabled peer -> reject
- missing or malformed auth headers -> reject
- expired timestamp -> reject
- replayed nonce -> reject
- bad signature -> reject
- capability not allowed for that peer -> reject

Recommended response classes:

- `401` for authentication failures
- `403` for capability-policy denials
- `409` for replay or nonce-conflict cases

Operational behavior:

- do not retry automatically on auth failures
- allow retry on transient transport errors only
- log the rejection reason with peer identity and endpoint

## Secret Rotation

v1 should support low-friction secret rotation.

Minimum design:

- one active secret
- one optional next secret
- verifier accepts either during a bounded rotation window
- operator can remove the old secret after rollout

This avoids requiring synchronized cutovers across instances.

## Audit Requirements

Every cross-instance request should record:

- remote `instanceId`
- endpoint
- capability class
- auth result
- denial reason when rejected
- forwarded origin metadata if present

This belongs in runtime audit logs, not only free-form ticket comments.

## Required Pre-Implementation Slices

`TKT-f136ecb0` should not start until these slices exist:

1. peer configuration schema for `instanceId`, `baseUrl`, secrets, and capability policy
2. request canonicalization and HMAC signing/verification
3. replay protection with peer-scoped nonce storage and timestamp skew checks
4. remote authorization policy that defaults to read-only capabilities
5. audit logging for accepted and rejected cross-instance requests

## Recommendation

Approve `TKT-d10c324a` once reviewers agree with this v1 shape:

- manual peer allowlist
- HMAC-signed requests
- no remote session impersonation
- least-privilege remote capability exposure
- fail-closed verification with replay protection

That is enough design closure to unblock implementation planning without overcommitting to a broader federation product.
