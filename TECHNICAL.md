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
| `sc_task` | Catalog Tasks (child tasks of RITMs) |
| `sys_email` | Email records / notifications sent |
| `sys_attachment` | File attachments on records |
| `wf_stage` | Workflow stage definitions |
| `sa_pattern` | Orchestration pattern (links activity definitions to steps) |
| `sa_step` | Orchestration step (PowerShell/SSH scripts for MID server) |

## Orchestration Script Extraction

The extractor now follows the chain from workflow activities to their underlying orchestration scripts:

```
wf_activity.activity_definition → wf_activity_definition
    ↓
sa_pattern.activity_definition → sa_pattern (orchestration pattern)
    ↓
sa_step.pattern → sa_step (individual script steps, ordered)
```

Each `sa_step` contains:
- **name** — step label
- **order** — execution order within the pattern
- **script_type** — PowerShell, SSH, JavaScript, etc.
- **script** — the full script content (e.g., PowerShell that runs on the MID Server)
- **inputs** / **outputs** — parameter definitions
- **condition** — step-level conditions

Additionally, `sa_pattern` and `wf_activity_definition` are queried for:
- **MID Server** — which MID server (or server selection criteria) the activity uses
- **Credential** — which credential alias is used to authenticate

## What the Workflow Extractor Does NOT Extract

| Data | Why | Workaround |
|------|-----|------------|
| Orchestration Post Processing / Pre Processing scripts | Stored on activity definition, not in sa_step | Open the activity → Post Processing tab → copy-paste |
| Orchestration Conditions tab (routing rules) | Stored on activity definition | Open the activity → Conditions tab → copy-paste |
| Flow Designer subflow details | Separate system | Export from Flow Designer |

**Note:** The extractor now captures orchestration execution scripts (PowerShell/SSH) from `sa_step` records. If an orchestration activity shows no steps, the script may be embedded differently in the activity definition — check the Execution Command tab manually.
