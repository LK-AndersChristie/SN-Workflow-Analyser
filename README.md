# ServiceNow Workflow Extractor

A reusable toolkit for extracting **complete** ServiceNow workflow definitions and executions — including all scripts, conditions, Set Values mappings, transitions, orchestration inputs, and execution history — into a single text file that can be fed to an AI for analysis.

The script **auto-detects** what you give it and supports five input types:
- **RITM number** (e.g. `RITM0043257`) — extracts the RITM record details, variables, activity log, approval history, and all associated workflow executions
- **RITM sys_id** — same as above, using the `sc_req_item` sys_id
- **wf_context sys_id** — extracts an executed (or still-running) workflow from a "Show Workflow" link, including activity execution times, results, faults, and scratchpad state
- **wf_workflow_version sys_id** — extracts a workflow template/definition from the Workflow Editor
- **Record document sys_id** — looks up any `wf_context` records tied to the given record

Sub-workflows called by "Workflow" activities are **extracted recursively** (up to 10 levels deep), with loop detection.

---

## Quick Start

### Step 1 — Get your identifier

**Option A — RITM number** (easiest):
Just use the RITM number directly, e.g. `RITM0043257`

**Option B — Workflow definition** (from Workflow Editor):
1. Open the workflow in **Workflow Editor** (`workflow_ide.do`)
2. If the URL contains `sysparm_wf_version=`, copy that 32-character hex value
3. If not (URL has no sys_id): open **Workflow Properties** (hamburger menu top-left → Properties, or click the ⓘ icon top-right), then use the hamburger menu or right-click the header bar → **Copy sys_id**

**Option C — Executed workflow** (from "Show Workflow" on a RITM/task):
1. Open the record → **Related Links** → **Show Workflow**
2. From the URL, copy the `sysparm_context=XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX` value

### Step 2 — Run the extractor

1. Navigate to **Scripts - Background** (`/sys.scripts.do`)
2. Open `Scripts/extract_sn_workflow.js` from this repo
3. Replace `PUT_YOUR_SYS_ID_HERE` with your identifier (RITM number or sys_id)
4. Paste the entire script into the **Run script** text area
5. Click **Run script**
6. **Select All** the output text → **Copy** → **Save** to a `.txt` file

### Step 3 — Feed it to AI

Place the `.txt` file in your workspace and ask the AI to read and analyze it.

---

## What it extracts

| Data | Source | Details |
|------|--------|---------|
| **RITM record details** | `sc_req_item` | State, stage, approval, assigned to, opened by, cat item, description |
| **RITM variables** | `sc_item_option_mtom` → `sc_item_option` | All catalog variable name/value pairs |
| **Activity log / journal** | `sys_journal_field` | All journal entries (work notes, comments, orchestration messages) |
| **Approval history** | `sysapproval_approver` | Approver, state, comments, timestamps |
| Workflow metadata | `wf_workflow_version` + `wf_workflow` | Name, table, scope, description, published status |
| Activity index | `wf_activity` | All nodes sorted by canvas position (Y then X) |
| Transitions | `wf_transition` | All connections between nodes with condition labels |
| Scripts | `sys_variable_value` | Full script content from Run Script, If, Create Task, Timer, etc. |
| Conditions | `sys_variable_value` | If-node conditions, Wait for Condition filters |
| Set Values mappings | `sys_variable_value` | Field=value pairs for Set Values activities |
| Orchestration inputs | `wf_activity.input` | JSON input maps for PowerShell/Orchestration activities |
| All other config | `sys_variable_value` | Timer settings, Create Task fields, Log Message content, etc. |
| Sub-workflows | Recursive extraction | "Workflow" activities are followed and extracted recursively |
| Execution context | `wf_context` | State, start/end time, triggering record, scratchpad |
| Execution history | `wf_history` | Per-activity: state, result, timing, fault description |
| Currently executing | `wf_executing` | Activities still in-flight with current state |

### What it does NOT extract

| Data | Why | Workaround |
|------|-----|------------|
| Orchestration Execution Command (PowerShell/script) | Stored in `sa_*` activity definition tables, not per-instance | Open the activity → Execution Command tab → copy-paste |
| Orchestration Post Processing / Pre Processing scripts | Same as above | Open the activity → Post Processing tab → copy-paste |
| Orchestration Outputs tab | Same as above | Open the activity → Outputs tab → copy-paste |
| Orchestration Conditions tab | Stored on activity definition | Open the activity → Conditions tab → copy-paste |
| Flow Designer subflow details | Separate system | Export from Flow Designer |

**For orchestration activities** (PowerShell, AD operations, custom activities), the extractor captures the **input JSON** and the **activity name/type**, but the execution script itself lives on the activity definition template. You'll need to manually copy those tabs.

---

## How it works (technical details)

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

### Key SN tables involved

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

---

## Files in this repo

| File | Purpose |
|------|---------|
| `README.md` | This file |
| `AI_INSTRUCTIONS.md` | Instructions for AI agents consuming the extracted output |
| `Scripts/extract_sn_workflow.js` | Main Background Script — extracts workflows and RITMs |
| `Scripts/extract_sn_business_rules.js` | Background Script — extracts business rules by sys_id or table |

---

---

## Business Rule Extractor

A separate script (`Scripts/extract_sn_business_rules.js`) extracts business rules from ServiceNow. It supports two modes:

- **`sys_id`** — extract a single business rule by its sys_id
- **`table`** — extract all business rules on a specific table (e.g. `incident`, `sc_req_item`)

Set `MODE`, `SYS_ID` or `TABLE_NAME`, and optionally `ACTIVE_ONLY = true` at the top of the script, then run it in Scripts - Background the same way as the workflow extractor.

Extracts: name, table, when (before/after/async/display), order, operations (insert/update/delete/query), filter condition, condition script, full script body, description, scope, protection policy, and metadata.

---

## Compatibility

Tested on ServiceNow Washington DC (2024). Should work on any version that uses the legacy Workflow Editor (`workflow_ide.do`), including Orlando through Xanadu.

Does **not** apply to Flow Designer flows — those use a different storage model.

---

## Changelog

- **v9 (2026-06-04)**: Added RITM support — pass a RITM number (e.g. `RITM0043257`) or `sc_req_item` sys_id. Extracts record details, catalog variables, activity log / journal, approval history, and all associated workflow contexts.
- **v8 (2026-06-04)**: Added recursive sub-workflow extraction. "Workflow" activities are followed automatically (up to 10 levels deep, with loop detection). Also added `sc_req_item` auto-detection for sys_ids.
- **v7 (2026-04-09)**: Added context mode — extract executed/running workflows from "Show Workflow" (wf_context). Extracts execution state, timing, per-activity results, faults, scratchpad, and the triggering record. Auto-detects sys_id type (no need to set MODE manually).
- **v6 (2026-03-23)**: First working version. Discovered that scripts live in `sys_variable_value`, not on `wf_activity` child tables (there are none).
- **v1–v5**: Iterative discovery. Tried child table enumeration, field brute-force, browser console approaches. All failed because SN uses EAV storage for workflow activity config.
