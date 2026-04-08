# Task Packet Template

Standard format for Monsthera v3 implementation tasks.
Each task should be completable in a single agent implementation pass.

---

## Task: [Short descriptive title]

### Objective
One sentence describing what this task produces.

### Files to Create/Modify
- `src/...`
- `tests/...`

### Contracts
Schemas, interfaces, or types this task must satisfy.
Reference existing contracts by file path when available.

### Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2
- [ ] All new code follows docs/CODING-STANDARDS.md
- [ ] No `any` types
- [ ] Tests pass

### Test Command
`pnpm vitest run tests/unit/<domain>/<file>.test.ts`

### Constraints
- Dependencies or prerequisites
- Things NOT to do
- Edge cases to handle
- Maximum file size: 500 lines

### Review Checklist (Codex)
- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes  
- [ ] Task-specific tests pass
- [ ] No files exceed 500 lines
- [ ] No `any` type annotations
- [ ] No v2 concepts (tickets, council, verdicts)
