# Editable Pencil Source

## Current (v2)

The v2 redesigned screens live in:

- `filePath: "/pencil-new.pen"`
- Screen ids: `zs47R` (Overview), `PE1fZ` (Flow), `byCV9` (Knowledge), `JssNL` (Knowledge Graph), `x79BN` (Security)

## Legacy (v1)

The original v1 Pencil source (`/pencil-halo.pen`) was overwritten during the v2 design session and is no longer available. The v1 webp exports in `../assets/` are the only surviving v1 artifacts.

## How To Review

1. Read `../README.md` for the full review surface overview
2. Read `../screen-manifest.json` for the machine-friendly screen inventory
3. **Review the exported webp files directly** — these are the stable artifacts
4. If deeper inspection of v2 screens is needed, query the v2 screen ids above in `/pencil-new.pen` via Pencil MCP

## Important Note

The exported assets inside `../assets/` and `../assets/v2/` are the stable review artifacts in the repo.
The v2 editable `.pen` source remains available through the Pencil tool context even though it is not mirrored here as a normal filesystem file.
