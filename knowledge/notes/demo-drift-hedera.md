---
id: k-demo-drift-hedera
title: "Demo: Hedera v1 drift sample"
slug: demo-drift-hedera
category: context
tags: [demo, drift-sample]
codeRefs: []
references: []
createdAt: 2026-04-24T00:00:00.000Z
updatedAt: 2026-04-24T00:00:00.000Z
---

# Demo article — intentional anti-example

This article exists so `pnpm demo:local` (or `pnpm monsthera lint
--registry anti-examples`) surfaces at least one finding from the
anti-example registry. Without it, the registry is defined but there is
nothing in the corpus for the matcher to catch — and the demo does not
demonstrate much.

Remove this file when a real (non-demo) corpus is in place; it is
intended as a self-check for the drift-prevention tooling, not as
permanent reference material.

## Sample drift

The Wave-2 recalibration showed 22.4% bars as the measured value, which
was later corrected. This line is intentionally uncorrected so the lint
phrase matcher reports exactly one `phrase_anti_example` finding
against this article.
