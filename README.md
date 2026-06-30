# SN Workflow Analyser

A toolkit of ServiceNow Background Scripts that extract workflows, business rules, and email diagnostics into plain text, ready to paste into an AI for analysis.

All scripts run in **Scripts - Background** (`/sys.scripts.do`).

---

## Scripts

### Workflow Extractor
**`Scripts/extract_sn_workflow.js`** — Extracts complete workflow definitions and executions into a single text output.

**Features:**
- Auto-detects input type — pass a RITM/INC number, any sys_id, or a workflow version and it figures out the rest
- Extracts all scripts, conditions, Set Values mappings, transitions, and orchestration inputs
- Includes execution history with per-activity timing, results, and faults
- Extracts orchestration scripts (PowerShell/SSH from `sa_step`) that run on the MID Server
- Shows MID Server and credential alias per orchestration activity
- Follows sub-workflows recursively (up to 10 levels deep)
- Supports Flow Designer flows (`sys_hub_flow`) — triggers, actions, subflows, inputs/outputs, scripts
- For RITMs & Incidents: extracts record details, variables, journal entries, approval history, tasks, attachments
- For RITMs & Incidents: email & notification analysis — all emails sent, which notifications triggered them, email watchers/subscribers
- For RITMs & Incidents: business rules — all active rules for the table with full scripts and conditions
- For RITMs & Incidents: inbound email actions — email processing scripts configured for the table

**Supported inputs:**

| Input | Example |
|-------|---------|
| RITM number | `RITM0043257` |
| RITM sys_id | 32-char hex from `sc_req_item` |
| INC number | `INC0043257` |
| Incident sys_id | 32-char hex from `incident` |
| Flow Designer flow sys_id | 32-char hex from `sys_hub_flow` |
| Flow Designer flow name | `"My Flow Name"` |
| Workflow context sys_id | From "Show Workflow" URL (`sysparm_context=...`) |
| Workflow version sys_id | From Workflow Editor URL (`sysparm_wf_version=...`) |
| Any record sys_id | Finds all workflow contexts tied to that record |

**How to use:**
1. Open `Scripts/extract_sn_workflow.js` and set `var SYS_ID = 'RITM0043257';` (or any sys_id / INC number)
2. Paste the script into **Scripts - Background** and run
3. Copy the output and save to a `.txt` file (or use [SN Utils](https://www.arnoudkooi.com/) to export)
4. Feed the file to your AI assistant for analysis

---

### Business Rule Extractor
**`Scripts/extract_sn_business_rules.js`** — Extracts business rules by sys_id or by table name.

**Features:**
- Extract a single business rule by sys_id
- Extract all business rules on a table (e.g. `incident`, `sc_req_item`)
- Optionally filter to active rules only
- Includes full script body, conditions, filter, operations, order, scope, and metadata

**How to use:**
1. Open the script and set `MODE = 'table'` or `MODE = 'sys_id'`
2. Set `TABLE_NAME = 'incident'` or `SYS_ID = '...'` accordingly
3. Paste into **Scripts - Background** and run
4. Copy output → save → feed to AI

---

## AI Integration

The output from these scripts is designed to be consumed by AI assistants. See [AI_INSTRUCTIONS.md](AI_INSTRUCTIONS.md) for guidance on how to prompt an AI to analyze the extracted data.

**Tip:** Place the output `.txt` file in your workspace and ask the AI to read it. The structured text format makes it easy for AI to parse workflow logic, find bottlenecks, identify duplicate notifications, or explain what a workflow does.

---

## Compatibility

Tested on ServiceNow Washington DC (2024). Should work on Orlando through Xanadu.

The workflow extractor supports both the legacy Workflow Editor (`workflow_ide.do`) and Flow Designer flows (`sys_hub_flow`).

---

## Technical Details

See [TECHNICAL.md](TECHNICAL.md) for details on ServiceNow's internal data model and how the extractors query it.

---

*This repo is 100% AI generated.*