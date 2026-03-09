# Agora vs Lexical Search Benchmark

- Generated at: `2026-03-09T23:24:50.860315+00:00`
- Repository: `.` (local)
- HEAD: `89346d8d5d5ff5212b501041a989c4b2af4612b1`
- Dirty worktree: `True`
- Iterations: `7`
- Top-K: `5`
- Transports: `agora_stdio, agora_http`

## Overall Aggregate

| Metric | Agora Stdio | Agora Http | Lexical (rg) |
| --- | ---: | ---: | ---: |
| Mean wall time | 12.883 ms | 13.608 ms | 9.116 ms |
| Mean backend time | 0.905 ms | 0.952 ms | n/a |
| Top-1 hits | 10/12 | 10/12 | 7/12 |
| Top-5 hits | 12/12 | 12/12 | 8/12 |

## Profile: Lexical (7 scenarios)

| Metric | Agora Stdio | Agora Http | Lexical (rg) |
| --- | ---: | ---: | ---: |
| Mean wall time | 12.977 ms | 14.190 ms | 9.738 ms |
| Mean backend time | 0.959 ms | 1.020 ms | n/a |
| Top-1 hits | 7/7 | 7/7 | 7/7 |
| Top-5 hits | 7/7 | 7/7 | 7/7 |

| Scenario | Stdio wall | Stdio rank | Http wall | Http rank | Lexical wall | Lexical rank | Expected |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Workflow runner dispatch | 12.584 ms | 1 | 13.719 ms | 1 | 9.051 ms | 1 | `backend/app/services/workflow_runner.py` |
| Project portability and OMK import/export | 12.115 ms | 1 | 13.781 ms | 1 | 8.913 ms | 1 | `backend/app/services/import_project_service.py, backend/app/services/project_file.py` |
| Ranking and feasibility | 13.996 ms | 1 | 15.998 ms | 1 | 8.726 ms | 1 | `backend/app/services/ranking.py` |
| Campaign lifecycle websocket and reruns | 13.348 ms | 1 | 13.575 ms | 1 | 9.141 ms | 1 | `backend/app/routers/campaigns.py` |
| Stress report compilation | 12.070 ms | 1 | 13.390 ms | 1 | 8.812 ms | 1 | `backend/app/services/stress_report.py` |
| Workflow canvas UI | 13.627 ms | 1 | 13.681 ms | 1 | 11.892 ms | 1 | `frontend/src/renderer/src/components/workflow/WorkflowCanvas.tsx` |
| Campaign manager UI | 13.098 ms | 1 | 15.186 ms | 1 | 11.629 ms | 1 | `frontend/src/renderer/src/components/analytics/CampaignManager.tsx` |

## Profile: Semantic (5 scenarios)

| Metric | Agora Stdio | Agora Http | Lexical (rg) |
| --- | ---: | ---: | ---: |
| Mean wall time | 12.753 ms | 12.794 ms | 8.246 ms |
| Mean backend time | 0.829 ms | 0.857 ms | n/a |
| Top-1 hits | 3/5 | 3/5 | 0/5 |
| Top-5 hits | 5/5 | 5/5 | 1/5 |

| Scenario | Stdio wall | Stdio rank | Http wall | Http rank | Lexical wall | Lexical rank | Expected |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Snapshot for resumption | 14.116 ms | 1 | 14.081 ms | 1 | 7.649 ms | - | `backend/app/services/checkpoint_service.py` |
| Skyline compromise outcomes | 11.902 ms | 1 | 11.561 ms | 1 | 7.687 ms | - | `backend/app/services/pareto.py` |
| Variable relationship matrix | 12.500 ms | 1 | 12.872 ms | 1 | 9.442 ms | - | `frontend/src/renderer/src/components/analytics/CorrelationHeatmap.tsx` |
| Reverse-engineer worst case | 12.313 ms | 5 | 12.144 ms | 5 | 8.476 ms | - | `backend/app/services/inverse_stress.py` |
| Stochastic sampling generation | 12.933 ms | 2 | 13.311 ms | 2 | 7.976 ms | 5 | `backend/app/services/montecarlo_generator.py` |

## Scenario details

### Workflow runner dispatch (lexical)

- Query: `workflow runner dispatch node handlers pause resume`
- Scope: `backend/app/`
- Notes: Backend execution engine lookup with multiple handler methods.
- Expected: `backend/app/services/workflow_runner.py`
- agora_stdio paths: `backend/app/services/workflow_runner.py, backend/app/routers/workflows.py, backend/app/workers/orchestrator.py, backend/app/services/workflow_run_service.py, backend/app/routers/campaigns.py`
- agora_http paths: `backend/app/services/workflow_runner.py, backend/app/routers/workflows.py, backend/app/workers/orchestrator.py, backend/app/services/workflow_run_service.py, backend/app/routers/campaigns.py`
- Lexical paths: `backend/app/services/workflow_runner.py, backend/app/routers/workflows.py, backend/app/services/workflow_data_context.py, backend/app/services/workflow_run_service.py, backend/app/services/workflow_service.py`

### Project portability and OMK import/export (lexical)

- Query: `project portability omk import export package migration`
- Scope: `backend/app/`
- Notes: Import/export and packaging flow for portable project files.
- Expected: `backend/app/services/import_project_service.py, backend/app/services/project_file.py`
- agora_stdio paths: `backend/app/services/import_project_service.py, backend/app/routers/projects.py, backend/app/services/project_file.py, backend/app/services/project_service.py, backend/app/services/demo_project_service.py`
- agora_http paths: `backend/app/services/import_project_service.py, backend/app/routers/projects.py, backend/app/services/project_file.py, backend/app/services/project_service.py, backend/app/services/demo_project_service.py`
- Lexical paths: `backend/app/services/import_project_service.py, backend/app/services/project_file.py, backend/app/routers/projects.py, backend/app/services/demo_project_service.py, backend/app/services/project_service.py`

### Ranking and feasibility (lexical)

- Query: `ranking topsis vikor feasible scenarios analytics`
- Scope: `backend/app/`
- Notes: Multi-criteria decision logic for TOPSIS/VIKOR ranking.
- Expected: `backend/app/services/ranking.py`
- agora_stdio paths: `backend/app/services/ranking.py, backend/app/services/filter_service.py, backend/app/services/real_options.py, backend/app/services/scenario_sampler.py, backend/app/services/voi.py`
- agora_http paths: `backend/app/services/ranking.py, backend/app/services/filter_service.py, backend/app/services/real_options.py, backend/app/services/scenario_sampler.py, backend/app/services/voi.py`
- Lexical paths: `backend/app/services/ranking.py, backend/app/routers/analytics.py, backend/app/models/schemas.py, backend/app/routers/macro_scenarios.py, backend/app/services/analytics_data.py`

### Campaign lifecycle websocket and reruns (lexical)

- Query: `campaign websocket duplicate rerun failed scenarios progress`
- Scope: `backend/app/`
- Notes: Router layer for campaign status, reruns, duplication, and websocket updates.
- Expected: `backend/app/routers/campaigns.py`
- agora_stdio paths: `backend/app/routers/campaigns.py, backend/app/services/campaign_service.py, backend/app/workers/work_dir_manager.py, backend/app/services/analytics_data.py, backend/app/workers/ws_manager.py`
- agora_http paths: `backend/app/routers/campaigns.py, backend/app/services/campaign_service.py, backend/app/workers/work_dir_manager.py, backend/app/services/analytics_data.py, backend/app/workers/ws_manager.py`
- Lexical paths: `backend/app/routers/campaigns.py, backend/app/services/campaign_service.py, backend/app/routers/macro_scenarios.py, backend/app/workers/orchestrator.py, backend/app/models/schemas.py`

### Stress report compilation (lexical)

- Query: `stress report compile failure modes summary warnings`
- Scope: `backend/app/`
- Notes: Stress reporting logic rather than generic stress analytics.
- Expected: `backend/app/services/stress_report.py`
- agora_stdio paths: `backend/app/services/stress_report.py, backend/app/services/stress_analysis.py, backend/app/routers/stress.py, backend/app/services/inverse_stress.py, backend/app/services/report_generator.py`
- agora_http paths: `backend/app/services/stress_report.py, backend/app/services/stress_analysis.py, backend/app/routers/stress.py, backend/app/services/inverse_stress.py, backend/app/services/report_generator.py`
- Lexical paths: `backend/app/services/stress_report.py, backend/app/routers/stress.py, backend/app/services/stress_analysis.py, backend/app/services/inverse_stress.py, backend/app/models/schemas.py`

### Workflow canvas UI (lexical)

- Query: `workflow canvas reactflow drag drop edges node palette`
- Scope: `frontend/src/renderer/src/`
- Notes: Renderer-side graph editor and interaction surface.
- Expected: `frontend/src/renderer/src/components/workflow/WorkflowCanvas.tsx`
- agora_stdio paths: `frontend/src/renderer/src/components/workflow/WorkflowCanvas.tsx, frontend/src/renderer/src/components/workflow/nodeConstants.ts, frontend/src/renderer/src/components/workflow/NodePalette.tsx, frontend/src/renderer/src/components/workflow/CanvasContextMenu.tsx, frontend/src/renderer/src/components/workflow/nodes/StudyFrameNode.tsx`
- agora_http paths: `frontend/src/renderer/src/components/workflow/WorkflowCanvas.tsx, frontend/src/renderer/src/components/workflow/nodeConstants.ts, frontend/src/renderer/src/components/workflow/NodePalette.tsx, frontend/src/renderer/src/components/workflow/CanvasContextMenu.tsx, frontend/src/renderer/src/components/workflow/nodes/StudyFrameNode.tsx`
- Lexical paths: `frontend/src/renderer/src/components/workflow/WorkflowCanvas.tsx, frontend/src/renderer/src/components/workflow/NodePalette.tsx, frontend/src/renderer/src/components/workflow/WorkflowPanel.tsx, frontend/src/renderer/src/components/workflow/CanvasContextMenu.tsx, frontend/src/renderer/src/components/analytics/WorkflowCanvas.tsx`

### Campaign manager UI (lexical)

- Query: `campaign manager compare rerun duplicate tags load analytics`
- Scope: `frontend/src/renderer/src/`
- Notes: Analytics-side campaign control surface in the renderer.
- Expected: `frontend/src/renderer/src/components/analytics/CampaignManager.tsx`
- agora_stdio paths: `frontend/src/renderer/src/components/analytics/CampaignManager.tsx, frontend/src/renderer/src/components/analytics/CampaignComparison.tsx, frontend/src/renderer/src/components/analytics/CorrelationHeatmap.tsx, frontend/src/renderer/src/components/analytics/inverse-stress/InverseStressSection.tsx, frontend/src/renderer/src/lib/campaignQueries.ts`
- agora_http paths: `frontend/src/renderer/src/components/analytics/CampaignManager.tsx, frontend/src/renderer/src/components/analytics/CampaignComparison.tsx, frontend/src/renderer/src/components/analytics/CorrelationHeatmap.tsx, frontend/src/renderer/src/components/analytics/inverse-stress/InverseStressSection.tsx, frontend/src/renderer/src/lib/campaignQueries.ts`
- Lexical paths: `frontend/src/renderer/src/components/analytics/CampaignManager.tsx, frontend/src/renderer/src/components/analytics/CampaignComparison.tsx, frontend/src/renderer/src/components/analytics/CampaignSelector.tsx, frontend/src/renderer/src/lib/analyticsQueries.ts, frontend/src/renderer/src/components/analytics/AnalyticsPanel.tsx`

### Snapshot for resumption (semantic)

- Query: `snapshot halfway computation to allow resumption`
- Scope: `backend/app/`
- Notes: Semantic: 'snapshot'~'checkpoint', 'resumption'~'resume'. No term overlap.
- Expected: `backend/app/services/checkpoint_service.py`
- agora_stdio paths: `backend/app/services/checkpoint_service.py, backend/app/services/pareto.py, backend/app/services/workflow_runner.py, backend/app/services/voi.py, backend/app/services/srdi.py`
- agora_http paths: `backend/app/services/checkpoint_service.py, backend/app/services/pareto.py, backend/app/services/workflow_runner.py, backend/app/services/voi.py, backend/app/services/srdi.py`
- Lexical paths: `backend/app/routers/campaigns.py, backend/app/services/workflow_runner.py, backend/app/services/demo_project_service.py, backend/app/services/voi.py, backend/app/main.py`

### Skyline compromise outcomes (semantic)

- Query: `skyline query for best compromise outcomes`
- Scope: `backend/app/`
- Notes: Semantic: 'skyline'~'pareto front', 'compromise'~'trade-off'. Zero rg match.
- Expected: `backend/app/services/pareto.py`
- agora_stdio paths: `backend/app/services/pareto.py, backend/app/services/compare_service.py, backend/app/services/filter_service.py`
- agora_http paths: `backend/app/services/pareto.py, backend/app/services/compare_service.py, backend/app/services/filter_service.py`
- Lexical paths: `backend/app/services/ranking.py, backend/app/routers/campaigns.py, backend/app/services/optimization_engine.py, backend/app/services/stress_report.py, backend/app/services/db_helper.py`

### Variable relationship matrix (semantic)

- Query: `matrix visualization of variable relationships`
- Scope: `frontend/src/renderer/src/`
- Notes: Semantic: 'matrix'~'heatmap', 'relationships'~'correlation'. rg rank ~8.
- Expected: `frontend/src/renderer/src/components/analytics/CorrelationHeatmap.tsx`
- agora_stdio paths: `frontend/src/renderer/src/components/analytics/CorrelationHeatmap.tsx, frontend/src/renderer/src/components/analytics/voi/InvestmentMatrix.tsx, frontend/src/renderer/src/components/analytics/srdi/ScenarioOverlay.tsx, frontend/src/renderer/src/components/analytics/srdi/TailRiskPanel.tsx, frontend/src/renderer/src/components/analytics/srdi/ScenarioWaterfall.tsx`
- agora_http paths: `frontend/src/renderer/src/components/analytics/CorrelationHeatmap.tsx, frontend/src/renderer/src/components/analytics/voi/InvestmentMatrix.tsx, frontend/src/renderer/src/components/analytics/srdi/ScenarioOverlay.tsx, frontend/src/renderer/src/components/analytics/srdi/TailRiskPanel.tsx, frontend/src/renderer/src/components/analytics/srdi/ScenarioWaterfall.tsx`
- Lexical paths: `frontend/src/renderer/src/__tests__/scatterMatrix.test.tsx, frontend/src/renderer/src/lib/guidanceContent.ts, frontend/src/renderer/src/components/analytics/ScatterMatrix.tsx, frontend/src/renderer/src/components/analytics/voi/InvestmentMatrix.tsx, frontend/src/renderer/src/components/analytics/som/SOMSection.tsx`

### Reverse-engineer worst case (semantic)

- Query: `reverse engineer worst case parameter combinations`
- Scope: `backend/app/`
- Notes: Semantic: 'reverse engineer'~'inverse', 'worst case'~'stress'. rg rank ~23.
- Expected: `backend/app/services/inverse_stress.py`
- agora_stdio paths: `backend/app/services/parameter_service.py, backend/app/services/voi.py, backend/app/services/scenario_sampler.py, backend/app/routers/parameters.py, backend/app/services/inverse_stress.py`
- agora_http paths: `backend/app/services/parameter_service.py, backend/app/services/voi.py, backend/app/services/scenario_sampler.py, backend/app/routers/parameters.py, backend/app/services/inverse_stress.py`
- Lexical paths: `backend/app/routers/parameters.py, backend/app/services/parameter_service.py, backend/app/services/stress_analysis.py, backend/app/models/schemas.py, backend/app/services/voi.py`

### Stochastic sampling generation (semantic)

- Query: `randomized sample generation probability distributions`
- Scope: `backend/app/`
- Notes: Semantic: 'randomized'~'montecarlo', 'sample generation' is concept.
- Expected: `backend/app/services/montecarlo_generator.py`
- agora_stdio paths: `backend/app/services/scenario_analysis.py, backend/app/services/montecarlo_generator.py, backend/app/services/doe_generator.py, backend/app/services/scenario_sampler.py, backend/app/services/stress_generator.py`
- agora_http paths: `backend/app/services/scenario_analysis.py, backend/app/services/montecarlo_generator.py, backend/app/services/doe_generator.py, backend/app/services/scenario_sampler.py, backend/app/services/stress_generator.py`
- Lexical paths: `backend/app/services/scenario_sampler.py, backend/app/models/schemas.py, backend/app/routers/campaigns.py, backend/app/services/stress_generator.py, backend/app/services/montecarlo_generator.py`

