---
id: k-koa51gtj
title: Wiki surfaces and wikilink semantics
slug: wiki-surfaces-and-wikilink-semantics
category: context
tags: [wiki, wikilinks, index, log, structure-graph, knowledge]
codeRefs: [src/knowledge/wiki-bookkeeper.ts, src/tools/wiki-tools.ts, src/structure/wikilink.ts, src/structure/service.ts, src/tools/structure-tools.ts]
references: [structureservice-code-reference-validation-and-graph-analysis, mcp-tool-catalog-complete-reference, knowledgeservice-crud-search-sync-and-wiki-integration]
createdAt: 2026-04-18T07:40:30.922Z
updatedAt: 2026-04-18T07:40:30.922Z
---

## Overview

Monsthera's wiki is more than a folder of Markdown files. It has three cooperating layers:

- authored knowledge articles in `knowledge/notes/`
- generated navigation files `knowledge/index.md` and `knowledge/log.md`
- graph semantics extracted from explicit `references` plus inline `[[wikilinks]]`

This article explains how those layers become a navigable system instead of an inert document dump.

## Generated wiki surfaces

`WikiBookkeeper` owns the two generated files:

- `index.md` is the catalog of all knowledge and work articles
- `log.md` is the append-only mutation trail

Both are rebuilt or appended through service-layer mutations. In other words: the authored corpus is the source, while `index.md` and `log.md` are mirrors built to make the corpus explorable.

## MCP wiki surface

`src/tools/wiki-tools.ts` exposes that generated layer through:

- `get_wiki_index`
- `get_wiki_log`

Those tools are deliberately read-only. They let agents orient themselves quickly without walking the filesystem, and they make the generated wiki part of the operational surface documented in [[mcp-tool-catalog-complete-reference]].

## Wikilink parsing rules

`src/structure/wikilink.ts` defines the semantics of `[[...]]` links:

- `[[slug]]`
- `[[slug|display]]`
- `[[slug#anchor]]`

Before extracting links, Monsthera strips HTML comments, fenced code blocks, and inline code. That is crucial because templates and examples often contain fake wikilinks that should not become graph edges or missing-reference warnings.

## How the structure graph uses links

`StructureService` merges two sources of article-to-article edges:

- explicit frontmatter `references`
- inline `[[wikilinks]]` found in article content

That means the best authoring pattern is:

- use `references` for strong structural relationships you want preserved in frontmatter
- use inline wikilinks in prose for navigability and reading flow
- use `codeRefs` for article-to-code traceability

Together, those three fields let a reader move article -> article -> code without leaving the knowledge graph.

## Mirror policy for index and log

If the wiki is healthy, `index.md` and `log.md` should mirror the current corpus rather than drift from it. In practice that means:

- create/update/delete through services whenever possible
- after bulk edits, run a reindex so the generated files reflect the corpus on disk
- document cross-article relationships with valid slugs so the graph stays resolvable

This is the operational contract that keeps [[structureservice-code-reference-validation-and-graph-analysis]] useful instead of noisy.