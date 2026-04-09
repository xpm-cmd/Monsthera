export const onboardingSteps = [
  {
    id: "capture-context",
    title: "Capture or review knowledge",
    detail: "Start in Knowledge when the team needs context, source imports, architecture notes, or implementation references.",
    path: "/knowledge",
    cta: "Open Knowledge",
  },
  {
    id: "shape-work",
    title: "Create a work article",
    detail: "Use Work to define the objective, acceptance criteria, owners, references, and code paths before execution starts.",
    path: "/work",
    cta: "Open Work",
  },
  {
    id: "orchestrate-agents",
    title: "Assign agents and handoffs",
    detail: "Use Flow to see who owns each phase, where reviews are waiting, and what the next safe advance is.",
    path: "/flow",
    cta: "Open Flow",
  },
  {
    id: "run-wave",
    title: "Advance the ready wave",
    detail: "Use the ready wave to move articles whose guards already pass, while blocked articles stay visible and explain why.",
    path: "/flow",
    cta: "Run Ready Wave",
  },
];

export const benefitPillars = [
  {
    title: "Faster code generation",
    detail: "Agents start from ranked context, code refs, and a defined work contract instead of reading the repo blindly.",
    benefit: "Less setup time before implementation.",
  },
  {
    title: "Better investigations",
    detail: "Research mode favors fresh, source-linked, high-quality context so conclusions are grounded instead of recycled.",
    benefit: "Higher confidence in findings and recommendations.",
  },
  {
    title: "Reusable knowledge",
    detail: "Work output can be promoted into durable knowledge so the next agent does not repeat the same discovery work.",
    benefit: "Compounding memory across sessions and teams.",
  },
  {
    title: "Lower token waste",
    detail: "Search auto-sync, context packs, and better handoff contracts reduce redundant retrieval and re-explanation loops.",
    benefit: "Cheaper and more efficient agent execution.",
  },
];

export const operatorJourneys = [
  {
    title: "Generate code",
    detail: "Use this path when the goal is to ship a change with the least possible rediscovery.",
    steps: [
      "Search in code mode to assemble a ranked context pack.",
      "Open the top 2 to 4 items and turn them into a work article with objective, acceptance criteria, owners, references, and code refs.",
      "Implement from the work contract, then move through review and capture reusable lessons in Knowledge.",
    ],
    benefit: "Faster implementation with better handoffs and cleaner code context.",
    path: "/search",
    cta: "Start in Search",
  },
  {
    title: "Investigate or research",
    detail: "Use this path when you are validating an idea, debugging a system, or collecting evidence before implementation.",
    steps: [
      "Search in research mode and prefer fresh or source-linked items.",
      "Use Work for a spike when the investigation needs explicit scope, ownership, or follow-up tasks.",
      "Promote the conclusion into Knowledge so the result becomes reusable instead of staying trapped in chat history.",
    ],
    benefit: "Higher-quality findings with fresher evidence and clearer follow-through.",
    path: "/search",
    cta: "Open Research Mode",
  },
  {
    title: "Store durable context",
    detail: "Use this path when a decision, guide, pattern, or imported source should remain available for future agents and humans.",
    steps: [
      "Create or update a knowledge article with the reusable conclusion.",
      "Attach code refs and source links so future retrieval stays grounded.",
      "Reference that knowledge from work articles so later execution starts from the right baseline.",
    ],
    benefit: "Stronger long-term memory and less repeated explanation.",
    path: "/knowledge",
    cta: "Capture Knowledge",
  },
];

export const dashboardSections = [
  {
    title: "Overview",
    path: "/",
    purpose: "Run the workspace from one place.",
    detail: "Best for understanding what is ready, what is blocked, what needs review, and what a new user should do next.",
  },
  {
    title: "Guide",
    path: "/guide",
    purpose: "Learn the Monsthera operating model.",
    detail: "Explains how work flows, how to orchestrate agents, how to automate safely, and what each dashboard area is for.",
  },
  {
    title: "Flow",
    path: "/flow",
    purpose: "Coordinate phases, handoffs, and waves.",
    detail: "Use it to inspect active agents, phase ownership, wave readiness, and manual execution when you want supervised automation.",
  },
  {
    title: "Work",
    path: "/work",
    purpose: "Create and operate the canonical work artifact.",
    detail: "This is where objectives, owners, references, blockers, review state, and lifecycle transitions stay connected.",
  },
  {
    title: "Knowledge",
    path: "/knowledge",
    purpose: "Build the shared brain.",
    detail: "Store guides, context, imported notes, architecture articles, and code-linked knowledge for future agents and humans.",
  },
  {
    title: "Search",
    path: "/search",
    purpose: "Retrieve context fast.",
    detail: "Build ranked context packs for code generation or investigation, then open only the highest-signal items before planning or implementation.",
  },
  {
    title: "System",
    path: "/system",
    purpose: "Inspect runtime health and controls.",
    detail: "Check storage mode, model/runtime settings, integrations, indexing freshness, and operational posture.",
  },
];

export const operationModes = [
  {
    title: "Guided Manual",
    detail: "Best when the team is still learning. Humans decide each handoff, but the dashboard shows readiness, blockers, and the next recommended action.",
  },
  {
    title: "Coordinated Multi-Agent",
    detail: "Use when specialists own planning, enrichment, implementation, and review. Work articles become the shared contract between agents.",
  },
  {
    title: "Supervised Autonomous",
    detail: "Use ready waves and automation only after objectives, owners, references, and reviews are clear. Automation should accelerate, not guess.",
  },
];

export const phasePlaybooks = [
  {
    phase: "planning",
    intent: "Define the job before execution begins.",
    actions: [
      "Write the objective, context, scope, and acceptance criteria.",
      "Add lead, assignee, references, and code refs so future agents inherit context.",
      "Stop here if the work is still vague or too broad.",
    ],
  },
  {
    phase: "enrichment",
    intent: "Collect specialist perspective before implementation.",
    actions: [
      "Invite architecture, security, testing, UX, or domain roles when the change crosses those concerns.",
      "Use the work article as the place where concerns and recommendations accumulate.",
      "Advance only after the required enrichment is truly satisfied.",
    ],
  },
  {
    phase: "implementation",
    intent: "Turn the plan into concrete changes.",
    actions: [
      "Ensure the assignee is clear and implementation notes stay attached to the work article.",
      "Link the code refs touched by the change and keep blockers visible.",
      "Move to review only when implementation evidence is present.",
    ],
  },
  {
    phase: "review",
    intent: "Confirm the change is safe and complete.",
    actions: [
      "Assign real reviewers, not placeholder identities.",
      "Track pending approvals, requested changes, and the remaining gate explicitly.",
      "Done means approved, not merely finished coding.",
    ],
  },
  {
    phase: "done",
    intent: "Close the loop and preserve knowledge.",
    actions: [
      "Treat done work as long-term context, not disposable ticket history.",
      "Promote insights into knowledge articles when the work teaches something reusable.",
      "Use Search and Knowledge so the next agent starts smarter.",
    ],
  },
];

export const automationRules = [
  "Automate only when the objective and acceptance criteria are explicit.",
  "Use waves to batch safe advances, but keep blockers visible instead of hiding them.",
  "Prefer supervised automation first: review the ready wave, then execute it deliberately.",
  "When agents are orchestrated, the work article remains the contract of truth.",
  "If a step is ambiguous for a human, it is too ambiguous for autonomous execution.",
];

export const agentUsagePrinciples = [
  {
    title: "Start from retrieval, not memory",
    detail: "Agents should search or open the relevant knowledge/work article first, then plan from grounded context instead of re-deriving the problem every time.",
    benefit: "Cuts token waste and reduces planning drift.",
  },
  {
    title: "Assemble a context pack before deep work",
    detail: "Use Search in code or research mode to rank the best context by freshness, quality, and code linkage before opening large files.",
    benefit: "Narrows the reading set and speeds up execution.",
  },
  {
    title: "Use work articles as handoff contracts",
    detail: "Objective, acceptance criteria, owners, references, code refs, blockers, and reviewers should live in the work article so every next agent inherits the same contract.",
    benefit: "Makes multi-agent orchestration faster and safer.",
  },
  {
    title: "Treat Knowledge as the reusable layer",
    detail: "If a work item teaches a reusable pattern, promote it into Knowledge so future agents can retrieve it directly instead of rediscovering it.",
    benefit: "Creates compound efficiency over time.",
  },
  {
    title: "Rely on auto-sync search",
    detail: "Normal create, update, and delete flows already sync search. Full reindex should be reserved for migrations, bulk imports, or recovery events.",
    benefit: "Avoids redundant tool calls and unnecessary latency.",
  },
];

export const agentToolingPlaybook = [
  {
    stage: "Discover",
    tools: ["search", "build_context_pack"],
    detail: "Use search for quick discovery. Before deep coding or investigation, build a context pack so the next reads are ranked by relevance, freshness, quality, and code linkage.",
    benefit: "Cuts blind reading and narrows the working set fast.",
    avoid: "Do not jump straight into raw files when the same context already exists in Monsthera.",
  },
  {
    stage: "Ground",
    tools: ["get_article", "get_work"],
    detail: "Open the specific knowledge and work items selected from the context pack or references. Work from grounded artifacts, not from memory alone.",
    benefit: "Keeps the plan aligned with current repository context.",
    avoid: "Do not re-summarize large history if the relevant article already captures it.",
  },
  {
    stage: "Shape the contract",
    tools: ["create_work", "update_work"],
    detail: "Make the work article explicit before execution: objective, acceptance criteria, owners, references, code refs, blockers, and review expectations.",
    benefit: "Makes multi-agent handoffs safer and faster.",
    avoid: "Do not rely on chat-only instructions for anything another agent may need to continue later.",
  },
  {
    stage: "Run the flow",
    tools: ["advance_phase", "contribute_enrichment", "assign_reviewer", "submit_review", "add_dependency"],
    detail: "Use the lifecycle tools to keep ownership, blockers, specialist input, and review gates visible as the work moves forward.",
    benefit: "Improves throughput without hiding risk.",
    avoid: "Do not automate unclear steps; ambiguity should be resolved in the work article first.",
  },
  {
    stage: "Promote reuse",
    tools: ["create_article", "update_article"],
    detail: "When a work item teaches a reusable lesson, save it into Knowledge with code refs and durable wording so future agents can retrieve it directly.",
    benefit: "Builds compound efficiency over time.",
    avoid: "Do not leave valuable conclusions only inside a completed work article if they will matter again.",
  },
];

export const continuousImprovementLoop = [
  {
    title: "Observe friction",
    detail: "Inspect missing sections, weak ownership, missing refs, and blocked work to see where agents are forced to improvise.",
    path: "/guide",
    cta: "Review diagnostics",
  },
  {
    title: "Standardize the contract",
    detail: "Fix the work article itself before adding more automation. Better contracts improve both human and agent execution.",
    path: "/work",
    cta: "Tighten work",
  },
  {
    title: "Promote learning into knowledge",
    detail: "Convert repeated solutions, architectural decisions, and playbooks into knowledge articles that future agents can retrieve immediately.",
    path: "/knowledge",
    cta: "Capture knowledge",
  },
  {
    title: "Automate the proven path",
    detail: "Once the contract is stable and guards are clear, use waves and autonomous loops to accelerate the safe path instead of guessing the unclear path.",
    path: "/flow",
    cta: "Run flow",
  },
];
