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
| `sys_script` | Business rules (the actual SN table backing `sys_business_rule`) |
| `sysevent_in_email_action` | Inbound email actions (scripts for processing incoming emails) |
| `sysevent_email_action` | Notification definitions (when, recipients, subject, message) |
| `sys_script_email` | Email scripts (reusable template includes for notifications) |
| `sys_watchers` / `sys_watch_2` | Email watchers/subscribers on records |
| `sys_script_include` | Script Includes (server-side reusable classes referenced in workflow scripts) |
| `incident` | Incident record |
| `incident_task` | Incident task (child of incident) |
| `question_answer` | Incident variables (form field answers) |
| `change_request` | Change request (may be related to incidents) |

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

**Note:** The extractor now captures orchestration execution scripts (PowerShell/SSH) from `sa_step` records. If an orchestration activity shows no steps, the script may be embedded differently in the activity definition — check the Execution Command tab manually.

## Email, Notification, and Business Rule Analysis (RITM/Incident Mode)

When a RITM number, INC number, or their sys_ids are provided, the extractor also analyzes:

### Business Rules (`sys_script`)
Extracted for the table (`sc_req_item` or `incident`).
Empty/no-op rules (those with only the default template boilerplate) are automatically filtered out:
- **When** — When the rule fires (before insert, after insert, before update, etc.)
- **Priority** — Execution order (lower numbers first)
- **Condition** — Filter condition (encoded query)
- **Script** — Full GlideScript body (has access to `current`, `previous`, `gs` objects)

### Inbound Email Actions (`sysevent_in_email_action`)
Extracted for the table:
- **Order** — Processing order (lower numbers run first)
- **Type** — Action type (Create, Update, etc.)
- **Stop processing** — Whether further actions are skipped after this one
- **Condition** — Filter condition (encoded query)
- **Template** — Template applied to the record
- **Script** — Processing script that runs when the action matches

### Notification Definitions (`sysevent_email_action`)
Extracted for the table (`sc_req_item` or `incident`):
- **Event** — Which event triggers the notification (if event-based)
- **Send when** — Insert, Update, Delete (which operations trigger it)
- **Condition** — Filter condition (encoded query)
- **Recipient fields** — Which record fields provide recipient addresses
- **Recipient groups/users** — Explicitly configured recipients
- **Subject** — Email subject (may contain variables like `${number}`)
- **Message** — Email body template
- **Advanced condition** — Script-based condition (if present)
- **Weight/Priority** — Notification priority ordering

### Email Scripts (`sys_script_email`)
Reusable template includes referenced via `${mail_script:scriptName}` in notification messages.
Only scripts actually referenced in fired notifications are extracted:
- **Description** — What the script does
- **Script** — Template content (Jelly/JavaScript for use in notification messages)
- Limited to 50 records to avoid excessive output

### Email & Notification Correlation (`sys_email` linked to `sysevent_email_action`)
For each record (RITM/Incident):
- **All emails sent** — extracted from `sys_email` table
- **Email → Notification linkage** — shows which notification triggered each email
- **Email watchers** — users subscribed to updates via `sys_watchers` / `sys_watch_2`

This correlation helps identify:
- Which notifications are actively firing for a record
- Email recipients and patterns
- Whether expected notifications are being sent

## Referenced Script Includes

The extractor scans all workflow activity scripts for `new ClassName()` patterns, filters out known built-in classes (GlideRecord, GlideDateTime, JSON, etc.), and looks up each referenced class in `sys_script_include`. The full source code of each matched Script Include is printed in a `REFERENCED SCRIPT INCLUDES` section.

This is extracted only at depth 0 (the top-level workflow) to avoid duplication.

## Custom Fields

For RITMs, Incidents, and Catalog Items, the extractor dynamically iterates all `u_*` (custom) fields on the record and prints any non-empty values with their labels.

## Flow Designer Tables

The Flow Designer extractor queries numerous `sys_hub_*` tables to build a complete picture:

| Table | Purpose |
|-------|---------|
| `sys_hub_flow` | Flow definition (name, table, status, description) |
| `sys_hub_trigger_instance_v2` / `sys_hub_trigger_instance` | Trigger configuration |
| `sys_hub_action_instance_v2` / `sys_hub_action_instance` | Action/step instances |
| `sys_hub_flow_logic_instance_v2` / `sys_hub_flow_logic` | Flow logic nodes (conditions, branches) |
| `sys_hub_sub_flow_instance` | Sub-flow call references |
| `sys_hub_action_type_definition` | Custom action definitions (scripts) |
| `sys_hub_flow_input` | Flow input definitions |
| `sys_hub_flow_output` | Flow output definitions |
| `sys_hub_flow_variable` | Flow variable definitions |
| `sys_hub_action_instance_input` | Action instance input mappings |
| `sys_hub_action_instance_output` | Action instance output mappings |
| `sys_hub_flow_context` / `sys_hub_flow_run` | Flow execution runs (used to find flows for RITMs) |
| `sys_flow_context` | Flow execution context (used for trigger table resolution) |

Different ServiceNow versions use different field names to link these tables (`flow`, `flow_object`, `model`, `parent`). The `queryByFlow()` function handles this by trying multiple strategies:
1. Direct field check via `isValidField()`
2. Valid-but-empty field fallback
3. Dictionary hierarchy lookup via `sys_dictionary` and `sys_db_object`

### Compressed Trigger Config

Flow Designer trigger conditions are often stored as gzip+base64 in the `trigger_inputs` field, which cannot be decompressed from background script scope. When detected, the extractor falls back to:
- Parsing the flow's `label_cache` JSON for trigger table and type
- Checking `sys_flow_context` for the source table
- Looking up trigger definition records for category info

A `TRIGGER SUMMARY` box is printed explaining the limitation and directing the user to the Flow Designer UI.

## Catalog Item Extraction

When a RITM is provided, the extractor also pulls the full catalog item definition from `sc_cat_item`. This can also be triggered directly by providing a catalog item sys_id.

### Catalog Item Variables (`item_option_new`)
Variables defined on the catalog item form:
- **Question text** — the label shown to the user
- **Name** — internal variable name
- **Type** — variable type (String, Reference, Select Box, etc.)
- **Order** — display order
- **Mandatory/Read only/Hidden** — field behavior flags
- **Default value** — static or dynamic default
- **Reference/Reference qual** — for reference-type variables
- **Dynamic reference qual** — script-based reference qualifier
- **Dynamic default value** — script-based default value

### Variable Sets (`io_set_item` → `item_option_new_set`)
Reusable groups of variables attached to the catalog item:
- **Title/Internal name** — set identification
- **Type** — set type
- **Variables** — all `item_option_new` records belonging to the set

### UI Policies (`catalog_ui_policy`)
Client-side form behavior rules for the catalog item:
- **Conditions** — when the policy applies (encoded query on variables)
- **On load** — whether the policy runs when the form loads
- **Reverse if false** — whether to undo actions when conditions become false
- **Scripts** — execute-if-true and execute-if-false scripts (when run_scripts is enabled)
- **Actions** (`catalog_ui_policy_action`) — per-variable visibility, mandatory, read-only, and disabled settings
- Also extracts UI policies from attached variable sets

### Client Scripts (`catalog_script_client`)
Client-side JavaScript for the catalog item form:
- **Type** — onChange, onLoad, onSubmit
- **Variable** — which variable triggers the script (for onChange)
- **Applies to** — item or variable set scope
- **Script** — full client-side JavaScript
- Also extracts client scripts from attached variable sets

### Key Tables

| Table | Purpose |
|-------|---------|
| `sc_cat_item` | Catalog item definition |
| `item_option_new` | Variables on a catalog item or variable set |
| `io_set_item` | M2M linking variable sets to catalog items |
| `item_option_new_set` | Variable set definitions |
| `catalog_ui_policy` | UI policies for catalog items |
| `catalog_ui_policy_action` | Actions (visibility/mandatory/read-only) for UI policies |
| `catalog_script_client` | Client scripts for catalog items |
