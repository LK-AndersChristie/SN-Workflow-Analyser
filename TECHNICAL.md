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
| `sys_business_rule` | Business rules (active/inactive, when to run, conditions, scripts) |
| `sysevent_in_email_action` | Inbound email actions (scripts for processing incoming emails) |
| `sysevent_email_action` | Notification definitions (when, recipients, subject, message) |
| `sys_email_script` | Email scripts (reusable template includes for notifications) |
| `sys_watchers` / `sys_watch_2` | Email watchers/subscribers on records |
| `incident` | Incident record |
| `incident_task` | Incident task (child of incident) |
| `change_request` | Change request (may be related to incidents) |
| `cmn_form_field_value` | Form field values (incident/RITM variables) |

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

### Business Rules (`sys_business_rule`)
Extracted for the table (`sc_req_item` or `incident`):
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

### Email Scripts (`sys_email_script`)
General-purpose reusable template includes (not tied to a specific table):
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
