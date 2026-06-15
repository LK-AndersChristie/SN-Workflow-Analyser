# Technical Details

## How the Workflow Extractor Works

ServiceNow's Workflow Editor stores activity configurations using a **generic EAV (Entity-Attribute-Value) pattern**:

```
Table: sys_variable_value
├── document = 'wf_activity'          (which table type)
├── document_key = <activity sys_id>  (which specific activity)
├── variable = <variable sys_id>      (which config field — e.g., "Script", "Condition")
└── value = <the actual content>      (the script text, condition string, etc.)
```

This is why `wf_activity` itself has almost no fields — just `name`, `activity_definition`, `input`, `stage`, `x`, `y`. Everything else is in `sys_variable_value`.

The extractor queries `sys_variable_value` in batches of 50 activity sys_ids using an `IN` clause, then maps the results back to each activity using `document_key`.

## Key ServiceNow Tables

| Table | Purpose |
|-------|---------|
| `wf_workflow` | Parent workflow record (name, scope) |
| `wf_workflow_version` | Specific version of the workflow |
| `wf_activity` | Activity nodes (position, name, type, orchestration input) |
| `wf_activity_definition` | Activity type templates (Run Script, If, Set Values, etc.) |
| `wf_transition` | Connections between activities with conditions |
| `sys_variable_value` | **Where the actual scripts/conditions/config live** |
| `wf_context` | Execution context — ties a workflow version to a specific record run |
| `wf_history` | Completed activity execution records (state, result, timing, faults) |
| `wf_executing` | Currently in-flight activity execution records |
| `sc_req_item` | Service Catalog Requested Item (RITM) |
| `sc_item_option_mtom` | M2M linking RITM to its catalog variable values |
| `sc_item_option` | Individual catalog variable value records |
| `sys_journal_field` | Activity log / journal entries (work notes, comments) |
| `sysapproval_approver` | Approval records |

## What the Workflow Extractor Does NOT Extract

| Data | Why | Workaround |
|------|-----|------------|
| Orchestration Execution Command (PowerShell/script) | Stored in `sa_*` activity definition tables, not per-instance | Open the activity → Execution Command tab → copy-paste |
| Orchestration Post Processing / Pre Processing scripts | Same as above | Open the activity → Post Processing tab → copy-paste |
| Orchestration Outputs tab | Same as above | Open the activity → Outputs tab → copy-paste |
| Orchestration Conditions tab | Stored on activity definition | Open the activity → Conditions tab → copy-paste |
| Flow Designer subflow details | Separate system | Export from Flow Designer |

**For orchestration activities** (PowerShell, AD operations, custom activities), the extractor captures the **input JSON** and the **activity name/type**, but the execution script itself lives on the activity definition template. You'll need to manually copy those tabs.
