# Monsthera Shared Context Benchmark

- Generated at: `2026-03-09T23:24:56.244968+00:00`
- Repository: `.` (local)
- HEAD: `89346d8d5d5ff5212b501041a989c4b2af4612b1`
- Dirty worktree: `True`
- Theme count: `4`
- Task count: `12`

## Aggregate

| Lane | Total wall time | Successes | Code searches | Coordination calls |
| --- | ---: | ---: | ---: | ---: |
| Without Monsthera | 108.733 ms | 12/12 | 12 | 0 |
| Monsthera no hub | 153.180 ms | 12/12 | 12 | 0 |
| Monsthera hub | 52.499 ms | 12/12 | 4 | 16 |

## Derived

- Hub mode reduced code-index lookups by `66.7%` versus independent Monsthera agents.
- Hub/Without-Monsthera total time ratio: `0.483`
- Hub/Monsthera-no-hub total time ratio: `0.343`

## Per theme

| Theme | Without Monsthera | Monsthera no hub | Monsthera hub | Hub code-search only | Hub top paths |
| --- | ---: | ---: | ---: | ---: | --- |
| Workflow execution backend | 28.283 ms | 42.304 ms | 15.131 ms | 13.340 ms | `backend/app/services/workflow_runner.py, backend/app/routers/workflows.py, backend/app/workers/orchestrator.py, backend/app/services/workflow_run_service.py, backend/app/routers/campaigns.py` |
| Project portability | 26.961 ms | 37.505 ms | 13.226 ms | 12.317 ms | `backend/app/services/import_project_service.py, backend/app/routers/projects.py, backend/app/services/project_file.py, backend/app/services/project_service.py, backend/app/services/demo_project_service.py` |
| Campaign lifecycle | 27.841 ms | 37.838 ms | 12.673 ms | 11.734 ms | `backend/app/routers/campaigns.py, backend/app/services/campaign_service.py, backend/app/workers/work_dir_manager.py, backend/app/services/analytics_data.py, backend/app/workers/ws_manager.py` |
| Stress reporting | 25.648 ms | 35.533 ms | 11.469 ms | 10.629 ms | `backend/app/services/stress_report.py, backend/app/services/stress_analysis.py, backend/app/routers/stress.py, backend/app/services/inverse_stress.py, backend/app/services/report_generator.py` |

## Details

### Workflow execution backend

- Seed query: `workflow runner dispatch node handlers pause resume`
- Scope: `backend/app/`
- Hub source: `monsthera_scoped`
- Hub seed wall time: `13.340 ms`
- Hub send wall time: `1.082 ms`
- Hub total poll wall time: `0.709 ms`

| Task | Without Monsthera | Monsthera no hub | Monsthera hub coverage | Expected |
| --- | ---: | ---: | ---: | --- |
| Node dispatch handlers | hit | hit | hit | `backend/app/services/workflow_runner.py` |
| Workflow run endpoints | hit | hit | hit | `backend/app/routers/workflows.py` |
| Workflow run persistence | hit | hit | hit | `backend/app/services/workflow_run_service.py` |

### Project portability

- Seed query: `project portability omk import export package migration`
- Scope: `backend/app/`
- Hub source: `monsthera_scoped`
- Hub seed wall time: `12.317 ms`
- Hub send wall time: `0.502 ms`
- Hub total poll wall time: `0.407 ms`

| Task | Without Monsthera | Monsthera no hub | Monsthera hub coverage | Expected |
| --- | ---: | ---: | ---: | --- |
| OMK import service | hit | hit | hit | `backend/app/services/import_project_service.py` |
| OMK archive helpers | hit | hit | hit | `backend/app/services/project_file.py` |
| Project import/export router | hit | hit | hit | `backend/app/routers/projects.py` |

### Campaign lifecycle

- Seed query: `campaign websocket duplicate rerun failed scenarios progress`
- Scope: `backend/app/`
- Hub source: `monsthera_scoped`
- Hub seed wall time: `11.734 ms`
- Hub send wall time: `0.458 ms`
- Hub total poll wall time: `0.481 ms`

| Task | Without Monsthera | Monsthera no hub | Monsthera hub coverage | Expected |
| --- | ---: | ---: | ---: | --- |
| Campaign router | hit | hit | hit | `backend/app/routers/campaigns.py` |
| Campaign progress service | hit | hit | hit | `backend/app/services/campaign_service.py` |
| Campaign websocket manager | hit | hit | hit | `backend/app/workers/ws_manager.py` |

### Stress reporting

- Seed query: `stress report compile failure modes summary warnings`
- Scope: `backend/app/`
- Hub source: `monsthera_scoped`
- Hub seed wall time: `10.629 ms`
- Hub send wall time: `0.408 ms`
- Hub total poll wall time: `0.432 ms`

| Task | Without Monsthera | Monsthera no hub | Monsthera hub coverage | Expected |
| --- | ---: | ---: | ---: | --- |
| Stress report compiler | hit | hit | hit | `backend/app/services/stress_report.py` |
| Stress summary analysis | hit | hit | hit | `backend/app/services/stress_analysis.py` |
| Stress analytics router | hit | hit | hit | `backend/app/routers/stress.py` |

