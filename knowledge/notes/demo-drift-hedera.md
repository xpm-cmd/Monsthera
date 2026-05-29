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

This article retains a sample of a wrong-form value so newcomers can see
what the anti-example registry guards against. It is tagged `drift-sample`
(one of the lint-exempt tags), so `monsthera lint` skips its content-drift
rules and the corpus lints clean — the pre-commit hook installed by
`monsthera install-hook` therefore passes on a healthy tree.

The matcher itself is exercised by unit tests (`tests/unit/work/lint.test.ts`),
not by this fixture, so the sample below is documentation, not a live
lint trigger. This file can be removed once it has outlived its
illustrative value.

## Sample anti-example

The Wave-2 recalibration prose once read "22.4% bars" as the measured
value. The canonical figure is "22.35 bars"; the older form is shown here
purely to illustrate the phrase the registry would flag in a non-exempt
article.
