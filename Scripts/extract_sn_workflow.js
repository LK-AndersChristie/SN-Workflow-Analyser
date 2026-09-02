// ╔══════════════════════════════════════════════════════════╗
// ║  SET THIS TO YOUR SYS_ID or RITM NUMBER                  ║
// ║  (auto-detects the type)                                 ║
// ╚══════════════════════════════════════════════════════════╝
var SYS_ID = 'PUT_YOUR_SYS_ID_HERE';

/**
 * ServiceNow Workflow & Flow Designer Extractor — Background Script
 * ==================================================================
 * Extracts complete workflow/flow definitions into readable text.
 * Supports workflow DEFINITIONS, executed workflow CONTEXTS, and
 * Flow Designer flows (sys_hub_flow).
 * Auto-detects which type of sys_id you provide.
 *
 * HOW TO USE:
 *   1. Set SYS_ID below to any of:
 *      - a workflow_version sys_id  (from URL: workflow_ide.do?sysparm_wf_version=<THIS>)
 *      - a wf_context sys_id        (from URL: workflow_ide.do?sysparm_context=<THIS>)
 *      - a record sys_id            (from URL: context_workflow.do?sysparm_document=<THIS>)
 *      - a RITM number              (e.g. RITM0043257)
 *      - a RITM sys_id              (sc_req_item record)
 *      - an INC number              (e.g. INC0043257)
 *      - an Incident sys_id         (incident record)
 *      - a catalog item sys_id      (sc_cat_item record)
 *      - a Flow Designer flow sys_id (from sys_hub_flow)
 *      - a Flow Designer flow name   (e.g. "My Flow Name")
 *      The script will auto-detect which one it is.
 *   2. Paste this entire script into Scripts - Background (/sys.scripts.do)
 *   3. Click "Run script"
 *   4. Select All output → Copy → Save to a .txt file
 *
 * EXTRACTS: metadata, activities, transitions, scripts, conditions,
 *           Set Values mappings, orchestration inputs, timer config,
 *           Create Task config, and all other activity configuration.
 *           Orchestration scripts (PowerShell/SSH/etc from sa_step)
 *           that run on the MID Server are included per activity.
 *           For executed workflows: execution state, timing, activity
 *           results, faults, scratchpad, and the triggering record.
 *           Sub-workflows called by "Workflow" activities are extracted
 *           recursively (up to 10 levels deep).
 *           Flow Designer flows: trigger, actions, subflows, inputs,
 *           outputs, action steps, scripts, conditions, and transforms.
 *           When a traditional workflow calls a Flow Designer flow
 *           (via "Flow Logic" activity), the flow is extracted inline.
 *           For RITMs and Incidents: record details, variables, activity
 *           log / journal, approval history, all associated workflow
 *           contexts, business rules, inbound email actions, notification
 *           definitions, email scripts/templates, and email correlation
 *           analysis (showing which notifications/rules triggered emails).
 *           For catalog items (sc_cat_item): full item metadata, variables,
 *           variable sets, UI policies, client scripts, UI actions,
 *           record producer script, user criteria, execution plan tasks,
 *           and the associated workflow/flow definition.
 *
 * SOURCE: Activity config is stored in sys_variable_value (EAV pattern),
 *         not on wf_activity fields directly.
 *         Flow Designer config is in sys_hub_* tables.
 */



(function (sysId) {

    // ── Helpers ──────────────────────────────────────────────

    function ln(ch, len) {
        var s = '';
        for (var i = 0; i < len; i++) s += ch;
        return s;
    }
    function section(title) {
        return '\n' + ln('=', 80) + '\n' + title + '\n' + ln('=', 80);
    }
    function subsection(title) {
        return '\n' + ln('-', 60) + '\n' + title + '\n' + ln('-', 60);
    }
    function p(text) {
        gs.print(text);
    }

    // sys_email is a rotated/partitioned table in SN. Queries against it
    // produce slow-query SQL debug output that leaks into gs.print.
    // Suppress session debugging around those queries.
    var _savedDebug;
    function suppressDebug() {
        try { var s = GlideSession.get(); _savedDebug = s.isDebug(); s.setDebug(false); } catch(e) {}
    }
    function restoreDebug() {
        try { if (_savedDebug) GlideSession.get().setDebug(true); } catch(e) {}
    }

    // ── Validate ─────────────────────────────────────────────

    if (!sysId || sysId.indexOf('PUT_YOUR') === 0) {
        p('ERROR: Set SYS_ID at the top of the script before running.');
        p('  Use a sys_id from any of:');
        p('    workflow_ide.do?sysparm_wf_version=<sys_id>       (workflow definition)');
        p('    workflow_ide.do?sysparm_context=<sys_id>          (executed workflow)');
        p('    context_workflow.do?sysparm_document=<sys_id>     (record with workflow)');
        p('    RITM number (e.g. RITM0043257)                   (catalog item request)');
        p('    sc_req_item sys_id                                (catalog item request)');
        p('    INC number (e.g. INC0043257)                      (incident)');
        p('    incident sys_id                                   (incident)');
        p('    sys_hub_flow sys_id                               (Flow Designer flow)');
        p('    Flow name (e.g. "My Flow")                        (Flow Designer flow by name)');
        p('    sc_cat_item sys_id                                 (catalog item definition)');
        return;
    }

    // ── RITM extraction helper ────────────────────────────────
    //    Extracts full RITM record details, variables, activity
    //    log, approvals, and finds all workflow contexts.

    function extractRITM(grRitm) {
        var ritmSysId = grRitm.getUniqueValue();
        var ritmNumber = grRitm.getValue('number');

        p(section('RITM RECORD: ' + ritmNumber));
        p('sys_id: ' + ritmSysId);
        p('Number: ' + ritmNumber);
        p('Short description: ' + (grRitm.getValue('short_description') || ''));
        p('State: ' + grRitm.getDisplayValue('state'));
        p('Stage: ' + (grRitm.getDisplayValue('stage') || ''));
        p('Approval: ' + grRitm.getDisplayValue('approval'));
        if (grRitm.getValue('approval_set')) p('Approval set: ' + grRitm.getDisplayValue('approval_set'));
        p('Priority: ' + grRitm.getDisplayValue('priority'));
        p('Assigned to: ' + (grRitm.getDisplayValue('assigned_to') || '(unassigned)'));
        p('Assignment group: ' + (grRitm.getDisplayValue('assignment_group') || ''));
        p('Requested for: ' + (grRitm.getDisplayValue('requested_for') || ''));
        p('Opened by: ' + (grRitm.getDisplayValue('opened_by') || ''));
        p('Opened at: ' + (grRitm.getDisplayValue('opened_at') || ''));
        p('Request: ' + (grRitm.getDisplayValue('request') || ''));
        p('Cat item: ' + (grRitm.getDisplayValue('cat_item') || ''));
        if (grRitm.getValue('location')) p('Location: ' + grRitm.getDisplayValue('location'));
        if (grRitm.getValue('company')) p('Company: ' + grRitm.getDisplayValue('company'));
        if (grRitm.getValue('cmdb_ci')) p('Configuration item: ' + grRitm.getDisplayValue('cmdb_ci'));
        if (grRitm.getValue('configuration_item')) p('Configuration item (alt): ' + grRitm.getDisplayValue('configuration_item'));
        if (grRitm.getValue('business_service')) p('Business service: ' + grRitm.getDisplayValue('business_service'));
        if (grRitm.getValue('service_offering')) p('Service offering: ' + grRitm.getDisplayValue('service_offering'));
        if (grRitm.getValue('quantity') && grRitm.getValue('quantity') !== '1') p('Quantity: ' + grRitm.getValue('quantity'));
        if (grRitm.getValue('price') && grRitm.getValue('price') !== '0') p('Price: ' + grRitm.getValue('price'));
        if (grRitm.getValue('estimated_delivery')) p('Estimated delivery: ' + grRitm.getDisplayValue('estimated_delivery'));
        if (grRitm.getValue('due_date')) p('Due date: ' + grRitm.getDisplayValue('due_date'));
        if (grRitm.getValue('sla_due')) p('SLA due: ' + grRitm.getDisplayValue('sla_due'));
        p('Made SLA: ' + (grRitm.getValue('made_sla') || ''));
        if (grRitm.getValue('closed_at')) p('Closed at: ' + grRitm.getDisplayValue('closed_at'));
        if (grRitm.getValue('closed_by')) p('Closed by: ' + grRitm.getDisplayValue('closed_by'));
        if (grRitm.getValue('close_notes')) p('Close notes: ' + grRitm.getValue('close_notes'));
        if (grRitm.getValue('context')) p('Workflow context: ' + grRitm.getDisplayValue('context'));
        if (grRitm.getValue('flow_context')) p('Flow context: ' + grRitm.getDisplayValue('flow_context'));
        if (grRitm.getValue('reassignment_count') && grRitm.getValue('reassignment_count') !== '0') p('Reassignment count: ' + grRitm.getValue('reassignment_count'));
        if (grRitm.getValue('description')) {
            p('\nDESCRIPTION:');
            p(grRitm.getValue('description'));
        }
        if (grRitm.getValue('comments')) {
            p('\nADDITIONAL COMMENTS:');
            p(grRitm.getValue('comments'));
        }

        // ── Custom fields (u_*) ──────────────────────────────────
        p(subsection('CUSTOM FIELDS'));
        var ritmCustomCount = 0;
        var ritmFields = grRitm.getFields();
        for (var rfi = 0; rfi < ritmFields.size(); rfi++) {
            var rge = ritmFields.get(rfi);
            var rFieldName = rge.getName();
            if (rFieldName.indexOf('u_') === 0) {
                var rVal = grRitm.getValue(rFieldName) || '';
                var rDispVal = grRitm.getDisplayValue(rFieldName) || '';
                if (rVal || rDispVal) {
                    var rLabel = rge.getLabel() || rFieldName;
                    p('  ' + rLabel + ': ' + (rDispVal || rVal));
                    ritmCustomCount++;
                }
            }
        }
        if (ritmCustomCount === 0) p('  (no custom fields with values)');

        // ── RITM Variables (sc_item_option_mtom → sc_item_option) ─────
        p(subsection('RITM VARIABLES'));
        var grOpt = new GlideRecord('sc_item_option_mtom');
        grOpt.addQuery('request_item', ritmSysId);
        grOpt.query();
        var varCount = 0;
        while (grOpt.next()) {
            var optRef = grOpt.getValue('sc_item_option');
            if (!optRef) continue;
            var grOptVal = new GlideRecord('sc_item_option');
            if (grOptVal.get(optRef)) {
                var itemOptDefId = grOptVal.getValue('item_option_new') || '';
                var itemOptName = grOptVal.getDisplayValue('item_option_new') || itemOptDefId || '(unknown)';
                var itemOptVal = grOptVal.getValue('value') || '';
                var varType = '';
                var varInternalName = '';
                var varRefTable = '';
                var grVarDef = new GlideRecord('item_option_new');
                if (itemOptDefId && grVarDef.get(itemOptDefId)) {
                    varType = grVarDef.getDisplayValue('type') || '';
                    varInternalName = grVarDef.getValue('name') || '';
                    varRefTable = grVarDef.getValue('reference') || grVarDef.getValue('lookup_table') || '';
                    if (grVarDef.getValue('question_text')) itemOptName = grVarDef.getValue('question_text');
                }
                // Resolve reference/lookup sys_ids to something human-readable
                var resolved = '';
                if (varRefTable && itemOptVal && itemOptVal.length === 32) {
                    var grRefRec = new GlideRecord(varRefTable);
                    if (grRefRec.isValid() && grRefRec.get(itemOptVal)) {
                        resolved = grRefRec.getDisplayValue();
                    }
                }
                p('  ' + itemOptName + ': ' + itemOptVal + (resolved ? '  → ' + resolved : ''));
                var meta = [];
                if (varInternalName && varInternalName !== itemOptName) meta.push('name=' + varInternalName);
                if (varType) meta.push('type=' + varType);
                if (varRefTable) meta.push('ref=' + varRefTable);
                if (meta.length > 0) p('      [' + meta.join(', ') + ']');
                varCount++;
            }
        }
        if (varCount === 0) p('  (no variables found)');

        // ── Activity log / journal entries ────────────────────────
        p(subsection('ACTIVITY LOG / JOURNAL'));
        var grJournal = new GlideRecord('sys_journal_field');
        grJournal.addQuery('element_id', ritmSysId);
        grJournal.orderBy('sys_created_on');
        grJournal.query();
        var journalCount = 0;
        while (grJournal.next()) {
            var jType = grJournal.getValue('element') || '';
            var jCreated = grJournal.getValue('sys_created_on') || '';
            var jCreatedBy = grJournal.getValue('sys_created_by') || '';
            var jValue = grJournal.getValue('value') || '';
            p('  [' + jCreated + '] (' + jCreatedBy + ') [' + jType + ']');
            p('    ' + jValue);
            p('');
            journalCount++;
        }
        if (journalCount === 0) p('  (no journal entries found)');

        // ── Approval history ─────────────────────────────────────
        p(subsection('APPROVAL HISTORY'));
        var grAppr = new GlideRecord('sysapproval_approver');
        grAppr.addQuery('sysapproval', ritmSysId);
        grAppr.orderBy('sys_created_on');
        grAppr.query();
        var apprCount = 0;
        while (grAppr.next()) {
            p('  Approver: ' + grAppr.getDisplayValue('approver'));
            p('  State: ' + grAppr.getDisplayValue('state'));
            if (grAppr.getValue('comments')) p('  Comments: ' + grAppr.getValue('comments'));
            p('  Created: ' + grAppr.getDisplayValue('sys_created_on'));
            if (grAppr.getValue('sys_updated_on')) p('  Updated: ' + grAppr.getDisplayValue('sys_updated_on'));
            p('');
            apprCount++;
        }
        if (apprCount === 0) p('  (no approvals found)');

        // ── Catalog Tasks (sc_task) ──────────────────────────────
        p(subsection('CATALOG TASKS'));
        var grTask = new GlideRecord('sc_task');
        grTask.addQuery('request_item', ritmSysId);
        grTask.orderBy('sys_created_on');
        grTask.query();
        var taskCount = 0;
        while (grTask.next()) {
            var taskSysId = grTask.getUniqueValue();
            p('  Task: ' + grTask.getValue('number'));
            p('  Short description: ' + (grTask.getValue('short_description') || ''));
            p('  State: ' + grTask.getDisplayValue('state'));
            p('  Assigned to: ' + (grTask.getDisplayValue('assigned_to') || '(unassigned)'));
            p('  Assignment group: ' + (grTask.getDisplayValue('assignment_group') || ''));
            p('  Created: ' + grTask.getDisplayValue('sys_created_on'));
            if (grTask.getValue('closed_at')) p('  Closed: ' + grTask.getDisplayValue('closed_at'));
            if (grTask.getValue('work_notes')) p('  Work notes: ' + grTask.getValue('work_notes'));
            if (grTask.getValue('close_notes')) p('  Close notes: ' + grTask.getValue('close_notes'));

            // (RITM variables omitted per task — identical to RITM-level variables above)
            p('');
            taskCount++;
        }
        if (taskCount === 0) p('  (no catalog tasks found)');

        // ── Emails / Notifications sent ──────────────────────────
        p(subsection('EMAILS / NOTIFICATIONS'));
        var grEmail = new GlideRecord('sys_email');
        grEmail.addQuery('instance', ritmSysId);
        grEmail.orderBy('sys_created_on');
        suppressDebug();
        grEmail.query();
        restoreDebug();
        var emailCount = 0;
        while (grEmail.next()) {
            p('  Type: ' + grEmail.getDisplayValue('type'));
            p('  Subject: ' + (grEmail.getValue('subject') || ''));
            p('  Recipients: ' + (grEmail.getValue('recipients') || ''));
            if (grEmail.getValue('copied')) p('  CC: ' + grEmail.getValue('copied'));
            p('  Created: ' + grEmail.getDisplayValue('sys_created_on'));
            p('  Mailbox: ' + (grEmail.getDisplayValue('mailbox') || '(default)'));
            if (grEmail.getValue('notification')) p('  Notification: ' + grEmail.getDisplayValue('notification'));
            p('');
            emailCount++;
        }
        if (emailCount === 0) {
            // Also try target_table + instance as some versions use different linking
            var grEmail2 = new GlideRecord('sys_email');
            grEmail2.addQuery('target_table', 'sc_req_item');
            grEmail2.addQuery('instance', ritmSysId);
            grEmail2.orderBy('sys_created_on');
            suppressDebug();
            grEmail2.query();
            restoreDebug();
            while (grEmail2.next()) {
                p('  Type: ' + grEmail2.getDisplayValue('type'));
                p('  Subject: ' + (grEmail2.getValue('subject') || ''));
                p('  Recipients: ' + (grEmail2.getValue('recipients') || ''));
                if (grEmail2.getValue('copied')) p('  CC: ' + grEmail2.getValue('copied'));
                p('  Created: ' + grEmail2.getDisplayValue('sys_created_on'));
                p('  Mailbox: ' + (grEmail2.getDisplayValue('mailbox') || '(default)'));
                if (grEmail2.getValue('notification')) p('  Notification: ' + grEmail2.getDisplayValue('notification'));
                p('');
                emailCount++;
            }
            if (emailCount === 0) p('  (no emails found)');
        }

        // ── Attachments ──────────────────────────────────────────
        p(subsection('ATTACHMENTS'));
        var grAttach = new GlideRecord('sys_attachment');
        grAttach.addQuery('table_name', 'sc_req_item');
        grAttach.addQuery('table_sys_id', ritmSysId);
        grAttach.orderBy('sys_created_on');
        grAttach.query();
        var attachCount = 0;
        while (grAttach.next()) {
            p('  File: ' + grAttach.getValue('file_name'));
            p('  Size: ' + grAttach.getValue('size_bytes') + ' bytes');
            p('  Content type: ' + (grAttach.getValue('content_type') || ''));
            p('  Created: ' + grAttach.getDisplayValue('sys_created_on'));
            p('');
            attachCount++;
        }
        if (attachCount === 0) p('  (no attachments found)');

        // ── Find all wf_context records for this RITM ────────────
        p(subsection('WORKFLOW CONTEXTS FOR ' + ritmNumber));
        var grWfCtx = new GlideRecord('wf_context');
        grWfCtx.addQuery('id', ritmSysId);
        grWfCtx.orderBy('sys_created_on');
        grWfCtx.query();

        var contexts = [];
        while (grWfCtx.next()) {
            var ctxId = grWfCtx.getUniqueValue();
            var ctxWfv = grWfCtx.getValue('workflow_version');
            var ctxState = grWfCtx.getDisplayValue('state') || grWfCtx.getValue('state') || '';
            var ctxName = grWfCtx.getDisplayValue('workflow_version') || '';
            p('  Context: ' + ctxId + '  State: ' + ctxState + '  Workflow: ' + ctxName);
            if (ctxWfv) {
                contexts.push({ contextId: ctxId, wfv: ctxWfv });
            }
        }
        if (contexts.length === 0) {
            p('  (no workflow contexts found for this RITM)');
        }

        // ── Find Flow Designer flow runs for this RITM ───────────
        p(subsection('FLOW DESIGNER RUNS FOR ' + ritmNumber));
        var ritmFlows = [];
        var grFlowCtx = new GlideRecord('sys_hub_flow_context');
        if (grFlowCtx.isValid()) {
            grFlowCtx.addQuery('record', ritmSysId);
            grFlowCtx.orderBy('sys_created_on');
            grFlowCtx.query();
            while (grFlowCtx.next()) {
                var fCtxId = grFlowCtx.getUniqueValue();
                var fFlowId = grFlowCtx.getValue('flow') || '';
                var fFlowName = grFlowCtx.getDisplayValue('flow') || '';
                var fState = grFlowCtx.getDisplayValue('state') || grFlowCtx.getValue('state') || '';
                p('  Flow run: ' + fCtxId + '  State: ' + fState + '  Flow: ' + fFlowName);
                if (fFlowId) {
                    ritmFlows.push(fFlowId);
                }
            }
        }
        // Also check sys_hub_flow_run if sys_hub_flow_context didn't exist or had no results
        if (ritmFlows.length === 0) {
            var grFlowRun = new GlideRecord('sys_hub_flow_run');
            if (grFlowRun.isValid()) {
                grFlowRun.addQuery('record', ritmSysId);
                grFlowRun.orderBy('sys_created_on');
                grFlowRun.query();
                while (grFlowRun.next()) {
                    var fRunFlowId = grFlowRun.getValue('flow') || '';
                    var fRunFlowName = grFlowRun.getDisplayValue('flow') || '';
                    var fRunState = grFlowRun.getDisplayValue('state') || grFlowRun.getValue('state') || '';
                    p('  Flow run: ' + grFlowRun.getUniqueValue() + '  State: ' + fRunState + '  Flow: ' + fRunFlowName);
                    if (fRunFlowId) {
                        ritmFlows.push(fRunFlowId);
                    }
                }
            }
        }
        // Fall back to the RITM's own flow_context reference
        if (ritmFlows.length === 0 && grRitm.getValue('flow_context')) {
            var ritmFlowCtxId = grRitm.getValue('flow_context');
            var flowCtxTables = ['sys_flow_context', 'sys_hub_flow_context', 'sys_hub_flow_run'];
            for (var fcti = 0; fcti < flowCtxTables.length; fcti++) {
                var grFcRef = new GlideRecord(flowCtxTables[fcti]);
                if (!grFcRef.isValid()) continue;
                if (grFcRef.get(ritmFlowCtxId)) {
                    var fcFlowId = grFcRef.getValue('flow') || '';
                    p('  Flow run: ' + ritmFlowCtxId + '  State: ' +
                      (grFcRef.getDisplayValue('state') || grFcRef.getValue('state') || '') +
                      '  Flow: ' + (grFcRef.getDisplayValue('flow') || ''));
                    p('    (resolved via sc_req_item.flow_context in ' + flowCtxTables[fcti] + ')');
                    if (fcFlowId) ritmFlows.push(fcFlowId);
                    break;
                }
            }
            // Last resort: the flow_context display value is the flow name
            if (ritmFlows.length === 0) {
                var flowCtxName = grRitm.getDisplayValue('flow_context') || '';
                if (flowCtxName) {
                    var grFlowByName = new GlideRecord('sys_hub_flow');
                    if (grFlowByName.isValid()) {
                        grFlowByName.addQuery('name', flowCtxName);
                        grFlowByName.setLimit(1);
                        grFlowByName.query();
                        if (grFlowByName.next()) {
                            p('  Flow resolved by name from flow_context: ' + flowCtxName);
                            ritmFlows.push(grFlowByName.getUniqueValue());
                        }
                    }
                }
            }
        }
        if (ritmFlows.length === 0) {
            p('  (no Flow Designer runs found for this RITM)');
        }

        return { contexts: contexts, flows: ritmFlows };
    }

    // ── Helper: Extract Business Rules for a table ───────────
    //    Only includes business rules that are likely relevant:
    //    rules triggered by sys_updated_by values seen in the journal,
    //    or rules whose name matches patterns from orchestration notes.
    function extractBusinessRules(tableName, recordSysId) {
        p(subsection('BUSINESS RULES FOR TABLE: ' + tableName));

        // Collect sys_created_by values from journal to identify which actors
        // triggered business rules on this record
        var journalActors = {};
        var grJrnl = new GlideRecord('sys_journal_field');
        grJrnl.addQuery('element_id', recordSysId);
        grJrnl.query();
        while (grJrnl.next()) {
            journalActors[grJrnl.getValue('sys_created_by') || ''] = true;
        }
        // Also add the record's own sys_updated_by history
        var grRec = new GlideRecord(tableName);
        if (grRec.get(recordSysId)) {
            journalActors[grRec.getValue('sys_updated_by') || ''] = true;
            journalActors[grRec.getValue('sys_created_by') || ''] = true;
        }

        var grBr = new GlideRecord('sys_script');
        grBr.addQuery('collection', tableName);
        grBr.addQuery('active', true);
        grBr.orderBy('name');
        grBr.query();

        var brCount = 0;
        var brSkipped = 0;
        while (grBr.next()) {
            var brName = grBr.getValue('name');
            var brCondition = grBr.getValue('condition') || '';
            var brScript = grBr.getValue('script') || '';
            var brWhen = grBr.getDisplayValue('when') || grBr.getValue('when') || '';
            var brPriority = grBr.getValue('priority') || '100';

            // Heuristic: skip rules that have conditions referencing fields
            // clearly unrelated to this record type, or rules with empty scripts.
            // Include rules that: have no condition (always run), or reference
            // common fields, or whose scripts reference actors from the journal.
            var isLikelyRelevant = true;

            // Skip rules with totally empty scripts (no-ops)
            if (!brScript || brScript.trim() === '' ||
                brScript.trim() === '(function executeRule(current, previous /*null when async*/) {\n\n\t// Add your code here\n\n})(current, previous);') {
                isLikelyRelevant = false;
            }

            if (!isLikelyRelevant) {
                brSkipped++;
                continue;
            }

            brCount++;
            p('  ' + brCount + '. ' + brName);
            p('     When: ' + brWhen);
            p('     Priority: ' + brPriority);
            if (brCondition) p('     Condition: ' + brCondition);

            if (brScript) {
                p('     ---- SCRIPT START ----');
                p(brScript);
                p('     ---- SCRIPT END ----');
            }
            p('');
        }

        if (brCount === 0) p('  (no relevant active business rules found for this table)');
        if (brSkipped > 0) p('  (' + brSkipped + ' empty/no-op business rules omitted)');
        p('');
    }

    // ── Helper: Extract Inbound Email Actions ────────────────
    //    In ServiceNow, inbound email actions are in sysevent_in_email_action.
    function extractInboundEmailActions(tableName) {
        p(subsection('INBOUND EMAIL ACTIONS FOR TABLE: ' + tableName));
        var grIea = new GlideRecord('sysevent_in_email_action');
        grIea.addQuery('table', tableName);
        grIea.addQuery('active', true);
        grIea.orderBy('order');
        grIea.query();

        var ieaCount = 0;
        while (grIea.next()) {
            ieaCount++;
            var ieaName = grIea.getValue('name');
            var ieaScript = grIea.getValue('script') || '';
            var ieaOrder = grIea.getValue('order') || '';
            var ieaType = grIea.getDisplayValue('type') || grIea.getValue('type') || '';
            var ieaStop = grIea.getValue('stop_processing') || '';
            var ieaCondition = grIea.getValue('filter_condition') || '';

            p('  ' + ieaCount + '. ' + ieaName);
            p('     sys_id: ' + grIea.getUniqueValue());
            p('     Order: ' + ieaOrder);
            p('     Type: ' + ieaType);
            if (ieaStop == 'true' || ieaStop == '1') p('     Stop processing: Yes');
            if (ieaCondition) p('     Condition: ' + ieaCondition);
            if (grIea.getValue('template')) p('     Template: ' + grIea.getDisplayValue('template'));

            if (ieaScript) {
                p('     ---- SCRIPT START ----');
                p(ieaScript);
                p('     ---- SCRIPT END ----');
            }
            p('');
        }

        if (ieaCount === 0) p('  (no inbound email actions found for this table)');
        p('');
    }

    // ── Helper: Extract Notification Definitions ─────────────
    //    Only includes notifications that actually sent emails for this record,
    //    plus notifications referenced by events created in the workflow.
    function extractNotifications(tableName, recordSysId) {
        p(subsection('NOTIFICATION DEFINITIONS FOR TABLE: ' + tableName));

        // First, collect notification sys_ids that actually triggered emails
        var firedNotifIds = {};
        var grEmailNotif = new GlideRecord('sys_email');
        grEmailNotif.addQuery('instance', recordSysId);
        grEmailNotif.addNotNullQuery('notification');
        suppressDebug();
        grEmailNotif.query();
        restoreDebug();
        while (grEmailNotif.next()) {
            firedNotifIds[grEmailNotif.getValue('notification')] = true;
        }

        // Also collect event names from the workflow (Create Event activities
        // fire events that trigger notifications)
        var firedEventNames = {};
        var grEvents = new GlideRecord('sysevent');
        if (grEvents.isValid()) {
            grEvents.addQuery('instance', recordSysId);
            grEvents.query();
            while (grEvents.next()) {
                firedEventNames[grEvents.getValue('name') || ''] = true;
            }
        }

        var grNotif = new GlideRecord('sysevent_email_action');
        grNotif.addQuery('collection', tableName);
        grNotif.addQuery('active', true);
        grNotif.orderBy('name');
        grNotif.query();

        var notifCount = 0;
        var notifSkipped = 0;
        var mailScriptNames = [];  // collect referenced mail_script names for later

        while (grNotif.next()) {
            var notifSysId = grNotif.getUniqueValue();
            var notifEvent = grNotif.getValue('event_name') || '';

            // Only include if this notification actually fired for this record
            var fired = firedNotifIds[notifSysId] ||
                        (notifEvent && firedEventNames[notifEvent]);

            if (!fired) {
                notifSkipped++;
                continue;
            }

            notifCount++;
            var notifName = grNotif.getValue('name');
            var notifCondition = grNotif.getValue('condition') || '';
            var notifRecipients = grNotif.getValue('recipient_fields') || '';
            var notifSubject = grNotif.getValue('subject') || '';
            var notifWeight = grNotif.getValue('weight') || '';

            p('  ' + notifCount + '. ' + notifName);
            p('     sys_id: ' + notifSysId);
            if (notifEvent) p('     Event: ' + notifEvent);
            var sendWhen = '';
            if (grNotif.getValue('action_insert') == 'true' || grNotif.getValue('action_insert') == '1') sendWhen += 'Insert ';
            if (grNotif.getValue('action_update') == 'true' || grNotif.getValue('action_update') == '1') sendWhen += 'Update ';
            if (grNotif.getValue('action_delete') == 'true' || grNotif.getValue('action_delete') == '1') sendWhen += 'Delete ';
            if (sendWhen) p('     Send when: ' + sendWhen.trim());
            if (notifCondition) p('     Condition: ' + notifCondition);
            p('     Recipient fields: ' + notifRecipients);
            if (grNotif.getValue('recipient_groups')) p('     Recipient groups: ' + grNotif.getDisplayValue('recipient_groups'));
            if (grNotif.getValue('recipient_users')) p('     Recipient users: ' + grNotif.getDisplayValue('recipient_users'));
            p('     Subject: ' + notifSubject);
            if (notifWeight) p('     Weight/Priority: ' + notifWeight);

            var notifMsg = grNotif.getValue('message') || grNotif.getValue('message_html') || '';
            if (notifMsg) {
                p('     MESSAGE:');
                p(notifMsg);

                // Collect mail_script references
                var msMatch;
                var msPattern = /\$\{mail_script:([^}]+)\}/g;
                while ((msMatch = msPattern.exec(notifMsg)) !== null) {
                    mailScriptNames.push(msMatch[1]);
                }
            }

            // Check for advanced condition script
            if (grNotif.getValue('advanced_condition')) {
                p('     ADVANCED CONDITION SCRIPT:');
                p('     ---- SCRIPT START ----');
                p(grNotif.getValue('advanced_condition'));
                p('     ---- SCRIPT END ----');
            }
            p('');
        }

        if (notifCount === 0) p('  (no notifications fired for this record)');
        if (notifSkipped > 0) p('  (' + notifSkipped + ' notifications that did not fire were omitted)');
        p('');

        return mailScriptNames;
    }

    // ── Helper: Extract Email Scripts ────────────────────────
    //    sys_script_email records are reusable template includes
    //    referenced via ${mail_script:scriptName} in notifications.
    //    Only extracts scripts that are actually referenced.
    function extractEmailScripts(tableName, recordSysId, referencedNames) {
        if (!referencedNames || referencedNames.length === 0) {
            p(subsection('EMAIL SCRIPTS (sys_script_email)'));
            p('  (no mail_script references found in fired notifications)');
            p('');
            return;
        }

        // Deduplicate
        var uniqueNames = {};
        for (var rn = 0; rn < referencedNames.length; rn++) {
            uniqueNames[referencedNames[rn]] = true;
        }

        p(subsection('EMAIL SCRIPTS (sys_script_email)'));
        var scriptCount = 0;
        for (var msName in uniqueNames) {
            if (!uniqueNames.hasOwnProperty(msName)) continue;
            var grEmailScript = new GlideRecord('sys_script_email');
            grEmailScript.addQuery('name', msName);
            grEmailScript.setLimit(1);
            grEmailScript.query();

            if (grEmailScript.next()) {
                scriptCount++;
                var scriptName = grEmailScript.getValue('name');
                var scriptDesc = grEmailScript.getValue('description') || '';
                var scriptContent = grEmailScript.getValue('script') || '';

                p('  ' + scriptCount + '. ' + scriptName);
                if (scriptDesc) p('     Description: ' + scriptDesc);
                if (scriptContent) {
                    p('     ---- SCRIPT START ----');
                    p(scriptContent);
                    p('     ---- SCRIPT END ----');
                }
                p('');
            } else {
                scriptCount++;
                p('  ' + scriptCount + '. ' + msName + ' (not found in sys_script_email)');
                p('');
            }
        }

        if (scriptCount === 0) p('  (no email scripts found)');
        p('');
    }

    // ── Helper: Extract Email and Notification Correlations ──
    function extractEmailAndNotificationAnalysis(recordSysId, tableName, recordNumber) {
        p(subsection('EMAIL & NOTIFICATION ANALYSIS FOR ' + recordNumber));

        // Find all emails linked to this record
        p('\nEMAILS SENT:');
        var grEmail = new GlideRecord('sys_email');
        grEmail.addQuery('instance', recordSysId);
        grEmail.orderBy('sys_created_on');
        suppressDebug();
        grEmail.query();
        restoreDebug();

        var emailCount = 0;
        var notificationLinks = {};

        while (grEmail.next()) {
            emailCount++;
            var emailId = grEmail.getUniqueValue();
            var emailSubject = grEmail.getValue('subject') || '(no subject)';
            var emailRecipients = grEmail.getValue('recipients') || '';
            var emailCc = grEmail.getValue('copied') || '';
            var emailNotif = grEmail.getValue('notification');
            var emailCreated = grEmail.getDisplayValue('sys_created_on') || '';

            p('  ' + emailCount + '. Subject: ' + emailSubject);
            p('     Created: ' + emailCreated);
            p('     Recipients: ' + emailRecipients);
            if (emailCc) p('     CC: ' + emailCc);

            if (emailNotif) {
                p('     Triggered by notification: ' + grEmail.getDisplayValue('notification'));
                notificationLinks[emailNotif] = true;
                // Try to find the notification definition
                var grNotifDef = new GlideRecord('sysevent_email_action');
                if (grNotifDef.get(emailNotif)) {
                    p('       Notification name: ' + grNotifDef.getValue('name'));
                    p('       Condition: ' + (grNotifDef.getValue('condition') || '(none)'));
                }
            }

            var emailBody = grEmail.getValue('body');
            if (emailBody && emailBody.length > 500) {
                p('     Body: ' + emailBody.substring(0, 500) + '...');
            } else if (emailBody) {
                p('     Body: ' + emailBody);
            }
            p('');
        }

        if (emailCount === 0) {
            p('  (no emails found for this record)');
        } else {
            p('  Total emails sent: ' + emailCount);
        }

        // Find email watchers or subscribers
        p('\nEMAIL WATCHERS/SUBSCRIBERS:');
        var grWatcher = new GlideRecord('sys_watchers');
        if (grWatcher.isValid()) {
            grWatcher.addQuery('document_key', recordSysId);
            grWatcher.query();
            var watcherCount = 0;
            while (grWatcher.next()) {
                watcherCount++;
                p('  ' + watcherCount + '. ' + (grWatcher.getDisplayValue('user') || grWatcher.getValue('user') || ''));
            }
            if (watcherCount === 0) {
                p('  (no watchers found via sys_watchers)');
            }
        } else {
            // Fallback: try sys_watch_2 (newer SN versions)
            var grWatch2 = new GlideRecord('sys_watch_2');
            if (grWatch2.isValid()) {
                grWatch2.addQuery('document_key', recordSysId);
                grWatch2.addQuery('document_table', tableName);
                grWatch2.query();
                var w2Count = 0;
                while (grWatch2.next()) {
                    w2Count++;
                    p('  ' + w2Count + '. ' + (grWatch2.getDisplayValue('user') || grWatch2.getValue('user') || ''));
                }
                if (w2Count === 0) {
                    p('  (no watchers found)');
                }
            } else {
                p('  (watcher tables not available on this instance)');
            }
        }
    }

    // ── Catalog Item extraction helper ────────────────────────
    //    Extracts full catalog item definition including variables,
    //    variable sets, UI policies, client scripts, and UI actions.

    function extractCatalogItem(catItemSysId) {
        var grCat = new GlideRecord('sc_cat_item');
        if (!grCat.get(catItemSysId)) {
            p('  (catalog item ' + catItemSysId + ' not found)');
            return;
        }

        p(section('CATALOG ITEM: ' + grCat.getValue('name')));
        p('sys_id: ' + catItemSysId);
        p('Name: ' + grCat.getValue('name'));
        if (grCat.getValue('short_description')) p('Short description: ' + grCat.getValue('short_description'));
        p('Active: ' + grCat.getValue('active'));
        p('Category: ' + (grCat.getDisplayValue('category') || ''));
        p('Catalogs: ' + (grCat.getDisplayValue('sc_catalogs') || ''));
        if (grCat.getValue('delivery_plan')) p('Execution plan: ' + grCat.getDisplayValue('delivery_plan'));
        if (grCat.getValue('workflow')) p('Workflow: ' + grCat.getDisplayValue('workflow'));
        if (grCat.getValue('flow_designer_flow')) p('Flow Designer flow: ' + grCat.getDisplayValue('flow_designer_flow'));
        if (grCat.getValue('group')) p('Fulfillment group: ' + grCat.getDisplayValue('group'));
        if (grCat.getValue('fulfillment_automation_level')) p('Fulfillment automation: ' + grCat.getDisplayValue('fulfillment_automation_level'));
        if (grCat.getValue('template')) p('Template: ' + grCat.getDisplayValue('template'));
        if (grCat.getValue('roles')) p('Roles: ' + grCat.getValue('roles'));
        if (grCat.getValue('type')) p('Type: ' + grCat.getDisplayValue('type'));
        if (grCat.getValue('ordered_item_link')) p('Ordered item link: ' + grCat.getValue('ordered_item_link'));
        p('Scope: ' + (grCat.getDisplayValue('sys_scope') || 'Global'));
        if (grCat.getValue('availability')) p('Availability: ' + grCat.getDisplayValue('availability'));
        if (grCat.getValue('price') && grCat.getValue('price') !== '0') p('Price: ' + grCat.getValue('price'));
        if (grCat.getValue('recurring_price') && grCat.getValue('recurring_price') !== '0') p('Recurring price: ' + grCat.getValue('recurring_price'));
        if (grCat.getValue('recurring_frequency')) p('Recurring frequency: ' + grCat.getDisplayValue('recurring_frequency'));
        if (grCat.getValue('delivery_time')) p('Delivery time: ' + grCat.getDisplayValue('delivery_time'));
        if (grCat.getValue('sys_class_name') && grCat.getValue('sys_class_name') !== 'sc_cat_item') {
            p('Class: ' + grCat.getValue('sys_class_name'));
        }
        if (grCat.getValue('description')) {
            p('\nDESCRIPTION:');
            p(grCat.getValue('description'));
        }

        // ── Custom fields ────────────────────────────────────────
        var catCustomCount = 0;
        var catFields = grCat.getFields();
        for (var cfi = 0; cfi < catFields.size(); cfi++) {
            var cge = catFields.get(cfi);
            var cfName = cge.getName();
            if (cfName.indexOf('u_') === 0) {
                var cVal = grCat.getValue(cfName) || '';
                var cDispVal = grCat.getDisplayValue(cfName) || '';
                if (cVal || cDispVal) {
                    if (catCustomCount === 0) p(subsection('CUSTOM FIELDS'));
                    var cLabel = cge.getLabel() || cfName;
                    p('  ' + cLabel + ': ' + (cDispVal || cVal));
                    catCustomCount++;
                }
            }
        }
        if (catCustomCount === 0) {
            p(subsection('CUSTOM FIELDS'));
            p('  (no custom fields with values)');
        }

        // ── Variables (item_option_new) ──────────────────────────
        p(subsection('CATALOG ITEM VARIABLES'));
        var grItemOpt = new GlideRecord('item_option_new');
        grItemOpt.addQuery('cat_item', catItemSysId);
        grItemOpt.orderBy('order');
        grItemOpt.query();
        var catVarCount = 0;
        while (grItemOpt.next()) {
            catVarCount++;
            p('  ' + catVarCount + '. ' + (grItemOpt.getValue('question_text') || grItemOpt.getValue('name') || '(unnamed)'));
            p('     Name: ' + (grItemOpt.getValue('name') || ''));
            p('     Type: ' + grItemOpt.getDisplayValue('type'));
            p('     Order: ' + (grItemOpt.getValue('order') || ''));
            if (grItemOpt.getValue('mandatory') === 'true') p('     Mandatory: true');
            if (grItemOpt.getValue('read_only') === 'true') p('     Read only: true');
            if (grItemOpt.getValue('hidden') === 'true') p('     Hidden: true');
            if (grItemOpt.getValue('default_value')) p('     Default: ' + grItemOpt.getValue('default_value'));
            if (grItemOpt.getValue('reference')) p('     Reference: ' + grItemOpt.getValue('reference'));
            if (grItemOpt.getValue('reference_qual')) p('     Reference qual: ' + grItemOpt.getValue('reference_qual'));
            if (grItemOpt.getValue('lookup_label')) p('     Lookup label: ' + grItemOpt.getValue('lookup_label'));
            if (grItemOpt.getValue('lookup_value')) p('     Lookup value: ' + grItemOpt.getValue('lookup_value'));
            if (grItemOpt.getValue('choice_table')) p('     Choice table: ' + grItemOpt.getValue('choice_table'));
            if (grItemOpt.getValue('choice_field')) p('     Choice field: ' + grItemOpt.getValue('choice_field'));
            if (grItemOpt.getValue('dynamic_ref_qual')) {
                p('     Dynamic reference qual:');
                p('     ---- SCRIPT START ----');
                p(grItemOpt.getValue('dynamic_ref_qual'));
                p('     ---- SCRIPT END ----');
            }
            if (grItemOpt.getValue('dynamic_default_value')) {
                p('     Dynamic default value:');
                p('     ---- SCRIPT START ----');
                p(grItemOpt.getValue('dynamic_default_value'));
                p('     ---- SCRIPT END ----');
            }
            if (grItemOpt.getValue('variable_set')) p('     Variable set: ' + grItemOpt.getDisplayValue('variable_set'));
            p('');
        }
        if (catVarCount === 0) p('  (no variables found)');

        // ── Variable Sets ────────────────────────────────────────
        p(subsection('VARIABLE SETS'));
        var grSetItem = new GlideRecord('io_set_item');
        grSetItem.addQuery('sc_cat_item', catItemSysId);
        grSetItem.orderBy('order');
        grSetItem.query();
        var setCount = 0;
        while (grSetItem.next()) {
            var setId = grSetItem.getValue('variable_set');
            if (!setId) continue;
            var grSet = new GlideRecord('item_option_new_set');
            if (!grSet.get(setId)) continue;
            setCount++;
            p('  ' + setCount + '. ' + (grSet.getValue('title') || grSet.getValue('name') || '(unnamed)'));
            p('     sys_id: ' + setId);
            p('     Internal name: ' + (grSet.getValue('internal_name') || ''));
            p('     Type: ' + (grSet.getDisplayValue('type') || ''));
            if (grSet.getValue('description')) p('     Description: ' + grSet.getValue('description'));

            // Variables in this set
            var grSetVars = new GlideRecord('item_option_new');
            grSetVars.addQuery('variable_set', setId);
            grSetVars.orderBy('order');
            grSetVars.query();
            var setVarCount = 0;
            while (grSetVars.next()) {
                setVarCount++;
                p('     ' + setVarCount + '. ' + (grSetVars.getValue('question_text') || grSetVars.getValue('name') || ''));
                p('        Name: ' + (grSetVars.getValue('name') || ''));
                p('        Type: ' + grSetVars.getDisplayValue('type'));
                if (grSetVars.getValue('mandatory') === 'true') p('        Mandatory: true');
                if (grSetVars.getValue('read_only') === 'true') p('        Read only: true');
                if (grSetVars.getValue('default_value')) p('        Default: ' + grSetVars.getValue('default_value'));
                if (grSetVars.getValue('reference')) p('        Reference: ' + grSetVars.getValue('reference'));
            }
            if (setVarCount === 0) p('     (no variables in this set)');
            p('');
        }
        if (setCount === 0) p('  (no variable sets found)');

        // ── UI Policies (catalog_ui_policy) ──────────────────────
        p(subsection('UI POLICIES'));
        var grUip = new GlideRecord('catalog_ui_policy');
        grUip.addQuery('catalog_item', catItemSysId);
        grUip.orderBy('order');
        grUip.query();
        var uipCount = 0;
        while (grUip.next()) {
            uipCount++;
            var uipSysId = grUip.getUniqueValue();
            p('  ' + uipCount + '. ' + (grUip.getValue('short_description') || '(unnamed)'));
            p('     sys_id: ' + uipSysId);
            p('     Active: ' + grUip.getValue('active'));
            p('     Order: ' + (grUip.getValue('order') || ''));
            p('     Applies to: ' + (grUip.getDisplayValue('applies_to') || 'item'));
            if (grUip.getValue('on_load') === 'true') p('     On load: true');
            if (grUip.getValue('reverse_if_false') === 'true') p('     Reverse if false: true');
            if (grUip.getValue('global') === 'true') p('     Global: true');
            if (grUip.getValue('catalog_conditions')) p('     Conditions: ' + grUip.getValue('catalog_conditions'));
            if (grUip.getValue('applies_to_set')) p('     Variable set: ' + grUip.getDisplayValue('applies_to_set'));

            // Script (if run scripts is enabled)
            if (grUip.getValue('run_scripts') === 'true') {
                if (grUip.getValue('script_true')) {
                    p('     EXECUTE IF TRUE:');
                    p('     ---- SCRIPT START ----');
                    p(grUip.getValue('script_true'));
                    p('     ---- SCRIPT END ----');
                }
                if (grUip.getValue('script_false')) {
                    p('     EXECUTE IF FALSE:');
                    p('     ---- SCRIPT START ----');
                    p(grUip.getValue('script_false'));
                    p('     ---- SCRIPT END ----');
                }
            }

            // UI Policy Actions
            var grUipa = new GlideRecord('catalog_ui_policy_action');
            grUipa.addQuery('ui_policy', uipSysId);
            grUipa.query();
            var actionCount = 0;
            while (grUipa.next()) {
                actionCount++;
                var varName = grUipa.getDisplayValue('catalog_variable') || grUipa.getValue('catalog_variable') || '';
                p('     Action ' + actionCount + ': Variable: ' + varName);
                if (grUipa.getValue('mandatory') && grUipa.getValue('mandatory') !== 'leave_alone') {
                    p('       Mandatory: ' + grUipa.getValue('mandatory'));
                }
                if (grUipa.getValue('visible') && grUipa.getValue('visible') !== 'leave_alone') {
                    p('       Visible: ' + grUipa.getValue('visible'));
                }
                if (grUipa.getValue('read_only') && grUipa.getValue('read_only') !== 'leave_alone') {
                    p('       Read only: ' + grUipa.getValue('read_only'));
                }
                if (grUipa.getValue('disabled') && grUipa.getValue('disabled') !== 'leave_alone') {
                    p('       Disabled: ' + grUipa.getValue('disabled'));
                }
                if (grUipa.getValue('cleared') === 'true') p('       Cleared: true');
            }
            p('');
        }
        if (uipCount === 0) p('  (no UI policies found)');

        // ── Client Scripts (catalog_script_client) ───────────────
        p(subsection('CLIENT SCRIPTS'));
        var grCs = new GlideRecord('catalog_script_client');
        grCs.addQuery('cat_item', catItemSysId);
        grCs.orderBy('order');
        grCs.query();
        var csCount = 0;
        while (grCs.next()) {
            csCount++;
            p('  ' + csCount + '. ' + (grCs.getValue('name') || '(unnamed)'));
            p('     sys_id: ' + grCs.getUniqueValue());
            p('     Active: ' + grCs.getValue('active'));
            p('     Type: ' + (grCs.getDisplayValue('type') || grCs.getValue('type') || ''));
            p('     Applies to: ' + (grCs.getDisplayValue('applies_to') || ''));
            if (grCs.getValue('ui_type')) p('     UI type: ' + grCs.getDisplayValue('ui_type'));
            if (grCs.getValue('cat_variable')) p('     Variable: ' + grCs.getDisplayValue('cat_variable'));
            if (grCs.getValue('applies_to_set')) p('     Variable set: ' + grCs.getDisplayValue('applies_to_set'));
            if (grCs.getValue('condition')) p('     Condition: ' + grCs.getValue('condition'));

            var csScript = grCs.getValue('script') || '';
            if (csScript) {
                p('     ---- SCRIPT START ----');
                p(csScript);
                p('     ---- SCRIPT END ----');
            }
            p('');
        }
        if (csCount === 0) p('  (no client scripts found)');

        // ── Also check variable-set-level client scripts ─────────
        var grSetItem2 = new GlideRecord('io_set_item');
        grSetItem2.addQuery('sc_cat_item', catItemSysId);
        grSetItem2.query();
        var vsClientScriptCount = 0;
        while (grSetItem2.next()) {
            var vsId = grSetItem2.getValue('variable_set');
            if (!vsId) continue;
            var grVsCs = new GlideRecord('catalog_script_client');
            grVsCs.addQuery('variable_set', vsId);
            grVsCs.addQuery('active', true);
            grVsCs.orderBy('order');
            grVsCs.query();
            while (grVsCs.next()) {
                if (vsClientScriptCount === 0) {
                    p(subsection('CLIENT SCRIPTS (from Variable Sets)'));
                }
                vsClientScriptCount++;
                p('  ' + vsClientScriptCount + '. ' + (grVsCs.getValue('name') || '(unnamed)'));
                p('     Variable set: ' + grVsCs.getDisplayValue('variable_set'));
                p('     Type: ' + (grVsCs.getDisplayValue('type') || grVsCs.getValue('type') || ''));
                if (grVsCs.getValue('cat_variable')) p('     Variable: ' + grVsCs.getDisplayValue('cat_variable'));
                var vsScript = grVsCs.getValue('script') || '';
                if (vsScript) {
                    p('     ---- SCRIPT START ----');
                    p(vsScript);
                    p('     ---- SCRIPT END ----');
                }
                p('');
            }
        }
        if (vsClientScriptCount === 0) {
            p(subsection('CLIENT SCRIPTS (from Variable Sets)'));
            p('  (no variable-set client scripts found)');
        }

        // ── Also check variable-set-level UI policies ────────────
        var grSetItem3 = new GlideRecord('io_set_item');
        grSetItem3.addQuery('sc_cat_item', catItemSysId);
        grSetItem3.query();
        var vsUipCount = 0;
        while (grSetItem3.next()) {
            var vsId3 = grSetItem3.getValue('variable_set');
            if (!vsId3) continue;
            var grVsUip = new GlideRecord('catalog_ui_policy');
            grVsUip.addQuery('variable_set', vsId3);
            grVsUip.addQuery('active', true);
            grVsUip.orderBy('order');
            grVsUip.query();
            while (grVsUip.next()) {
                if (vsUipCount === 0) {
                    p(subsection('UI POLICIES (from Variable Sets)'));
                }
                vsUipCount++;
                var vsUipId = grVsUip.getUniqueValue();
                p('  ' + vsUipCount + '. ' + (grVsUip.getValue('short_description') || '(unnamed)'));
                p('     Variable set: ' + grVsUip.getDisplayValue('variable_set'));
                if (grVsUip.getValue('catalog_conditions')) p('     Conditions: ' + grVsUip.getValue('catalog_conditions'));
                if (grVsUip.getValue('on_load') === 'true') p('     On load: true');
                if (grVsUip.getValue('reverse_if_false') === 'true') p('     Reverse if false: true');
                if (grVsUip.getValue('run_scripts') === 'true') {
                    if (grVsUip.getValue('script_true')) {
                        p('     EXECUTE IF TRUE:');
                        p('     ---- SCRIPT START ----');
                        p(grVsUip.getValue('script_true'));
                        p('     ---- SCRIPT END ----');
                    }
                    if (grVsUip.getValue('script_false')) {
                        p('     EXECUTE IF FALSE:');
                        p('     ---- SCRIPT START ----');
                        p(grVsUip.getValue('script_false'));
                        p('     ---- SCRIPT END ----');
                    }
                }
                var grVsUipa = new GlideRecord('catalog_ui_policy_action');
                grVsUipa.addQuery('ui_policy', vsUipId);
                grVsUipa.query();
                var vsActionCount = 0;
                while (grVsUipa.next()) {
                    vsActionCount++;
                    var vsVarName = grVsUipa.getDisplayValue('catalog_variable') || grVsUipa.getValue('catalog_variable') || '';
                    p('     Action ' + vsActionCount + ': Variable: ' + vsVarName);
                    if (grVsUipa.getValue('mandatory') && grVsUipa.getValue('mandatory') !== 'leave_alone') p('       Mandatory: ' + grVsUipa.getValue('mandatory'));
                    if (grVsUipa.getValue('visible') && grVsUipa.getValue('visible') !== 'leave_alone') p('       Visible: ' + grVsUipa.getValue('visible'));
                    if (grVsUipa.getValue('read_only') && grVsUipa.getValue('read_only') !== 'leave_alone') p('       Read only: ' + grVsUipa.getValue('read_only'));
                }
                p('');
            }
        }
        if (vsUipCount === 0) {
            p(subsection('UI POLICIES (from Variable Sets)'));
            p('  (no variable-set UI policies found)');
        }

        // ── UI Actions ───────────────────────────────────────────
        p(subsection('UI ACTIONS'));
        var grUia = new GlideRecord('sys_ui_action');
        grUia.addQuery('table', 'sc_cat_item');
        grUia.addQuery('active', true);
        grUia.orderBy('order');
        grUia.query();
        var uiaCount = 0;
        while (grUia.next()) {
            // Only include UI actions that are relevant to this catalog item
            var uiaCondition = grUia.getValue('condition') || '';
            if (uiaCondition && uiaCondition.indexOf(catItemSysId) === -1 &&
                uiaCondition.indexOf('cat_item') === -1) continue;
            uiaCount++;
            p('  ' + uiaCount + '. ' + (grUia.getValue('name') || '(unnamed)'));
            p('     Active: ' + grUia.getValue('active'));
            if (grUia.getValue('action_name')) p('     Action name: ' + grUia.getValue('action_name'));
            if (grUia.getValue('form_button') === 'true') p('     Form button: true');
            if (grUia.getValue('form_context_menu') === 'true') p('     Context menu: true');
            if (grUia.getValue('form_link') === 'true') p('     Form link: true');
            if (uiaCondition) p('     Condition: ' + uiaCondition);
            var uiaScript = grUia.getValue('script') || '';
            if (uiaScript) {
                p('     ---- SCRIPT START ----');
                p(uiaScript);
                p('     ---- SCRIPT END ----');
            }
            p('');
        }
        if (uiaCount === 0) p('  (no relevant UI actions found)');

        // ── Record Producer script (sc_cat_item_producer) ────────
        if (grCat.getValue('sys_class_name') === 'sc_cat_item_producer') {
            p(subsection('RECORD PRODUCER'));
            var grProd = new GlideRecord('sc_cat_item_producer');
            if (grProd.isValid() && grProd.get(catItemSysId)) {
                p('  Target table: ' + (grProd.getDisplayValue('table_name') || grProd.getValue('table_name') || ''));
                if (grProd.getValue('view_id')) p('  View: ' + grProd.getDisplayValue('view_id'));
                if (grProd.getValue('redirect_to')) p('  Redirect to: ' + grProd.getDisplayValue('redirect_to'));
                var prodScript = grProd.getValue('script') || '';
                if (prodScript) {
                    p('  ---- SCRIPT START ----');
                    p(prodScript);
                    p('  ---- SCRIPT END ----');
                } else {
                    p('  (no producer script)');
                }
            } else {
                p('  (record producer record not readable)');
            }
        }

        // ── User Criteria (Available for / Not available for) ────
        p(subsection('USER CRITERIA'));
        var ucTables = [
            { table: 'sc_cat_item_user_criteria_mtom', label: 'Available for' },
            { table: 'sc_cat_item_user_criteria_no_mtom', label: 'Not available for' }
        ];
        var ucTotal = 0;
        for (var uci = 0; uci < ucTables.length; uci++) {
            var grUcm = new GlideRecord(ucTables[uci].table);
            if (!grUcm.isValid()) continue;
            grUcm.addQuery('sc_cat_item', catItemSysId);
            grUcm.query();
            while (grUcm.next()) {
                ucTotal++;
                var ucId = grUcm.getValue('user_criteria');
                p('  [' + ucTables[uci].label + '] ' + (grUcm.getDisplayValue('user_criteria') || ucId || ''));
                var grUc = new GlideRecord('user_criteria');
                if (ucId && grUc.isValid() && grUc.get(ucId)) {
                    if (grUc.getValue('roles')) p('     Roles: ' + grUc.getDisplayValue('roles'));
                    if (grUc.getValue('group')) p('     Groups: ' + grUc.getDisplayValue('group'));
                    if (grUc.getValue('user')) p('     Users: ' + grUc.getDisplayValue('user'));
                    if (grUc.getValue('company')) p('     Companies: ' + grUc.getDisplayValue('company'));
                    if (grUc.getValue('department')) p('     Departments: ' + grUc.getDisplayValue('department'));
                    if (grUc.getValue('location')) p('     Locations: ' + grUc.getDisplayValue('location'));
                    if (grUc.getValue('match_all') === 'true') p('     Match all: true');
                    if (grUc.getValue('advanced') === 'true' && grUc.getValue('script')) {
                        p('     ---- SCRIPT START ----');
                        p(grUc.getValue('script'));
                        p('     ---- SCRIPT END ----');
                    }
                }
            }
        }
        if (ucTotal === 0) p('  (no user criteria configured)');

        // ── Execution / Delivery Plan tasks ──────────────────────
        var catDeliveryPlanId = grCat.getValue('delivery_plan') || '';
        if (catDeliveryPlanId) {
            p(subsection('EXECUTION PLAN: ' + grCat.getDisplayValue('delivery_plan')));
            var grDt = new GlideRecord('sc_cat_item_delivery_task');
            if (grDt.isValid()) {
                grDt.addQuery('delivery_plan', catDeliveryPlanId);
                grDt.orderBy('order');
                grDt.query();
                var dtCount = 0;
                while (grDt.next()) {
                    dtCount++;
                    p('  ' + dtCount + '. ' + (grDt.getValue('name') || grDt.getValue('short_description') || '(unnamed)'));
                    p('     Order: ' + (grDt.getValue('order') || ''));
                    if (grDt.getValue('assignment_group')) p('     Assignment group: ' + grDt.getDisplayValue('assignment_group'));
                    if (grDt.getValue('assigned_to')) p('     Assigned to: ' + grDt.getDisplayValue('assigned_to'));
                    if (grDt.getValue('condition')) p('     Condition: ' + grDt.getValue('condition'));
                    if (grDt.getValue('instructions')) p('     Instructions: ' + grDt.getValue('instructions'));
                    if (grDt.getValue('work_notes')) p('     Work notes: ' + grDt.getValue('work_notes'));
                    p('');
                }
                if (dtCount === 0) p('  (no delivery tasks defined)');
            } else {
                p('  (sc_cat_item_delivery_task table not available)');
            }
        }

        // Return the workflow/flow references for further extraction
        var catWorkflowId = grCat.getValue('workflow') || '';
        var catFlowId = grCat.getValue('flow_designer_flow') || '';
        return { workflowId: catWorkflowId, flowId: catFlowId };
    }

    // ── INC (Incident) extraction helper ─────────────────────
    //    Similar to RITM but for incident records
    function extractIncident(grInc) {
        var incSysId = grInc.getUniqueValue();
        var incNumber = grInc.getValue('number');

        p(section('INCIDENT RECORD: ' + incNumber));
        p('sys_id: ' + incSysId);
        p('Number: ' + incNumber);
        p('Short description: ' + (grInc.getValue('short_description') || ''));
        p('Description: ' + (grInc.getValue('description') || ''));
        p('State: ' + grInc.getDisplayValue('state'));
        p('Incident state: ' + grInc.getDisplayValue('incident_state'));
        p('Priority: ' + grInc.getDisplayValue('priority'));
        p('Severity: ' + grInc.getDisplayValue('severity'));
        p('Urgency: ' + grInc.getDisplayValue('urgency'));
        p('Impact: ' + grInc.getDisplayValue('impact'));
        p('Escalation: ' + grInc.getDisplayValue('escalation'));
        p('Caller: ' + (grInc.getDisplayValue('caller_id') || '(unknown)'));
        p('Opened by: ' + (grInc.getDisplayValue('opened_by') || ''));
        p('Assigned to: ' + (grInc.getDisplayValue('assigned_to') || '(unassigned)'));
        p('Assignment group: ' + (grInc.getDisplayValue('assignment_group') || ''));
        p('Category: ' + (grInc.getDisplayValue('category') || ''));
        p('Subcategory: ' + (grInc.getDisplayValue('subcategory') || ''));
        p('Contact type: ' + (grInc.getDisplayValue('contact_type') || ''));
        p('Company: ' + (grInc.getDisplayValue('company') || ''));
        p('Location: ' + (grInc.getDisplayValue('location') || ''));
        if (grInc.getValue('cmdb_ci')) p('Configuration item: ' + grInc.getDisplayValue('cmdb_ci'));
        if (grInc.getValue('business_service')) p('Business service: ' + grInc.getDisplayValue('business_service'));
        if (grInc.getValue('service_offering')) p('Service offering: ' + grInc.getDisplayValue('service_offering'));
        if (grInc.getValue('caused_by')) p('Caused by: ' + grInc.getDisplayValue('caused_by'));
        if (grInc.getValue('cause')) p('Cause: ' + grInc.getValue('cause'));
        if (grInc.getValue('parent_incident')) p('Parent incident: ' + grInc.getDisplayValue('parent_incident'));
        if (grInc.getValue('child_incidents') && grInc.getValue('child_incidents') !== '0') p('Child incidents: ' + grInc.getValue('child_incidents'));
        if (grInc.getValue('problem_id')) p('Problem: ' + grInc.getDisplayValue('problem_id'));
        if (grInc.getValue('rfc')) p('Change request: ' + grInc.getDisplayValue('rfc'));
        if (grInc.getValue('correlation_id')) p('Correlation ID: ' + grInc.getValue('correlation_id'));
        p('Made SLA: ' + (grInc.getValue('made_sla') || ''));
        if (grInc.getValue('sla_due')) p('SLA due: ' + grInc.getDisplayValue('sla_due'));
        if (grInc.getValue('due_date')) p('Due date: ' + grInc.getDisplayValue('due_date'));
        if (grInc.getValue('opened_at')) p('Opened: ' + grInc.getDisplayValue('opened_at'));
        if (grInc.getValue('resolved_at')) p('Resolved: ' + grInc.getDisplayValue('resolved_at'));
        if (grInc.getValue('resolved_by')) p('Resolved by: ' + grInc.getDisplayValue('resolved_by'));
        if (grInc.getValue('closed_at')) p('Closed: ' + grInc.getDisplayValue('closed_at'));
        if (grInc.getValue('closed_by')) p('Closed by: ' + grInc.getDisplayValue('closed_by'));
        if (grInc.getValue('close_code')) p('Close code: ' + grInc.getDisplayValue('close_code'));
        if (grInc.getValue('close_notes')) p('Close notes: ' + grInc.getValue('close_notes'));
        if (grInc.getValue('reopen_count') && grInc.getValue('reopen_count') !== '0') {
            p('Reopen count: ' + grInc.getValue('reopen_count'));
            if (grInc.getValue('reopened_by')) p('Reopened by: ' + grInc.getDisplayValue('reopened_by'));
            if (grInc.getValue('reopened_time')) p('Reopened time: ' + grInc.getDisplayValue('reopened_time'));
        }
        if (grInc.getValue('knowledge') === 'true') p('Knowledge: true');
        if (grInc.getValue('reassignment_count') && grInc.getValue('reassignment_count') !== '0') p('Reassignment count: ' + grInc.getValue('reassignment_count'));
        if (grInc.getValue('approval') && grInc.getValue('approval') !== 'not requested') p('Approval: ' + grInc.getDisplayValue('approval'));
        if (grInc.getValue('business_impact')) p('Business impact: ' + grInc.getValue('business_impact'));
        if (grInc.getValue('follow_up')) p('Follow up: ' + grInc.getDisplayValue('follow_up'));
        if (grInc.getValue('work_start')) p('Actual start: ' + grInc.getDisplayValue('work_start'));
        if (grInc.getValue('work_end')) p('Actual end: ' + grInc.getDisplayValue('work_end'));
        if (grInc.getValue('time_worked')) p('Time worked: ' + grInc.getDisplayValue('time_worked'));
        if (grInc.getValue('business_duration')) p('Business duration: ' + grInc.getDisplayValue('business_duration'));
        if (grInc.getValue('calendar_duration')) p('Duration: ' + grInc.getDisplayValue('calendar_duration'));
        if (grInc.getValue('business_stc')) p('Business resolve time (s): ' + grInc.getValue('business_stc'));
        if (grInc.getValue('calendar_stc')) p('Resolve time (s): ' + grInc.getValue('calendar_stc'));
        if (grInc.getValue('contract')) p('Contract: ' + grInc.getDisplayValue('contract'));
        if (grInc.getValue('route_reason')) p('Route reason: ' + grInc.getDisplayValue('route_reason'));

        // ── Custom fields (u_*) ──────────────────────────────────
        //    Dynamically extract all custom fields present on the record
        p(subsection('CUSTOM FIELDS'));
        var customCount = 0;
        var fields = grInc.getFields();
        for (var fi = 0; fi < fields.size(); fi++) {
            var ge = fields.get(fi);
            var fieldName = ge.getName();
            if (fieldName.indexOf('u_') === 0) {
                var val = grInc.getValue(fieldName) || '';
                var dispVal = grInc.getDisplayValue(fieldName) || '';
                if (val || dispVal) {
                    var label = ge.getLabel() || fieldName;
                    p('  ' + label + ': ' + (dispVal || val));
                    customCount++;
                }
            }
        }
        if (customCount === 0) p('  (no custom fields with values)');

        if (grInc.getValue('work_notes')) {
            p('\nWORK NOTES:');
            p(grInc.getValue('work_notes'));
        }

        // ── Incident Variables ───────────────────────────────────
        p(subsection('INCIDENT VARIABLES'));
        var varCount = 0;
        try {
            var grVar = new GlideRecord('question_answer');
            if (grVar.isValid()) {
                grVar.addQuery('table_sys_id', incSysId);
                grVar.query();
                while (grVar.next()) {
                    var varName = grVar.getDisplayValue('question') || grVar.getValue('question') || '';
                    var varVal = grVar.getValue('value') || '';
                    p('  ' + varName + ': ' + varVal);
                    varCount++;
                }
            }
        } catch (e) {
            // table may not exist on this instance
        }
        if (varCount === 0) p('  (no variables found)');

        // ── Activity log / journal entries ────────────────────────
        p(subsection('ACTIVITY LOG / JOURNAL'));
        var grJournal = new GlideRecord('sys_journal_field');
        grJournal.addQuery('element_id', incSysId);
        grJournal.orderBy('sys_created_on');
        grJournal.query();
        var journalCount = 0;
        while (grJournal.next()) {
            var jType = grJournal.getValue('element') || '';
            var jCreated = grJournal.getValue('sys_created_on') || '';
            var jCreatedBy = grJournal.getValue('sys_created_by') || '';
            var jValue = grJournal.getValue('value') || '';
            p('  [' + jCreated + '] (' + jCreatedBy + ') [' + jType + ']');
            p('    ' + jValue);
            journalCount++;
        }
        if (journalCount === 0) p('  (no journal entries found)');

        // ── Approval history ─────────────────────────────────────
        p(subsection('APPROVAL HISTORY'));
        var grAppr = new GlideRecord('sysapproval_approver');
        grAppr.addQuery('sysapproval', incSysId);
        grAppr.orderBy('sys_created_on');
        grAppr.query();
        var apprCount = 0;
        while (grAppr.next()) {
            p('  Approver: ' + grAppr.getDisplayValue('approver'));
            p('  State: ' + grAppr.getDisplayValue('state'));
            if (grAppr.getValue('comments')) p('  Comments: ' + grAppr.getValue('comments'));
            p('  Created: ' + grAppr.getDisplayValue('sys_created_on'));
            if (grAppr.getValue('sys_updated_on')) p('  Updated: ' + grAppr.getDisplayValue('sys_updated_on'));
            p('');
            apprCount++;
        }
        if (apprCount === 0) p('  (no approvals found)');

        // ── Incident Tasks ───────────────────────────────────────
        p(subsection('INCIDENT TASKS'));
        var grTask = new GlideRecord('incident_task');
        grTask.addQuery('parent', incSysId);
        grTask.orderBy('sys_created_on');
        grTask.query();
        var taskCount = 0;
        while (grTask.next()) {
            p('  Task: ' + (grTask.getValue('short_description') || ''));
            p('  State: ' + grTask.getDisplayValue('state'));
            p('  Assigned to: ' + (grTask.getDisplayValue('assigned_to') || '(unassigned)'));
            if (grTask.getValue('work_notes')) p('  Work notes: ' + grTask.getValue('work_notes'));
            p('');
            taskCount++;
        }
        if (taskCount === 0) p('  (no tasks found)');

        // ── Related Changes (CHG) ────────────────────────────────
        p(subsection('RELATED CHANGES'));
        var grChg = new GlideRecord('change_request');
        grChg.addQuery('reason', 'CONTAINS', incNumber);
        grChg.addOrCondition('justification', 'CONTAINS', incNumber);
        grChg.addOrCondition('correlation_id', incSysId);
        grChg.orderBy('number');
        grChg.query();
        var chgCount = 0;
        while (grChg.next()) {
            p('  ' + grChg.getValue('number') + ' - ' + (grChg.getValue('short_description') || ''));
            p('  State: ' + grChg.getDisplayValue('state'));
            p('');
            chgCount++;
        }
        if (chgCount === 0) p('  (no related changes found)');

        // ── Find all wf_context records for this Incident ────────
        p(subsection('WORKFLOW CONTEXTS FOR ' + incNumber));
        var grWfCtx = new GlideRecord('wf_context');
        grWfCtx.addQuery('id', incSysId);
        grWfCtx.orderBy('sys_created_on');
        grWfCtx.query();

        var contexts = [];
        while (grWfCtx.next()) {
            var ctxId = grWfCtx.getUniqueValue();
            var ctxWfv = grWfCtx.getValue('workflow_version');
            var ctxState = grWfCtx.getDisplayValue('state') || grWfCtx.getValue('state') || '';
            var ctxName = grWfCtx.getDisplayValue('workflow_version') || '';
            p('  Context: ' + ctxId + '  State: ' + ctxState + '  Workflow: ' + ctxName);
            if (ctxWfv) {
                contexts.push({ contextId: ctxId, wfv: ctxWfv });
            }
        }
        if (contexts.length === 0) {
            p('  (no workflow contexts found for this incident)');
        }

        return { contexts: contexts, tableName: 'incident' };
    }

    // ── Auto-detect sys_id type ──────────────────────────────
    //    Try RITM number/sys_id first, then INC number/sys_id,
    //    then catalog item, then Flow Designer flow, then wf_context,
    //    then wf_workflow_version, then document record.

    var mode;          // 'definition', 'context', 'ritm', 'incident', 'catitem', or 'flow'
    var wfv;           // workflow_version sys_id — used for the rest of the script
    var contextId;     // wf_context sys_id (only when mode=context)
    var contextData;   // execution metadata object (only when mode=context)
    var ritmContexts;  // array of {contextId, wfv} from RITM (only when mode=ritm)
    var incContexts;   // array of {contextId, wfv} from Incident (only when mode=incident)
    var incTable;      // the incident table name (usually 'incident')
    var flowSysId;     // sys_hub_flow sys_id (only when mode=flow)
    var catItemSysId;  // sc_cat_item sys_id (only when mode=catitem)

    // Try RITM number first (e.g. RITM0043257)
    var isRitmNumber = /^RITM\d+$/i.test(sysId);
    if (isRitmNumber) {
        var grRitmByNum = new GlideRecord('sc_req_item');
        grRitmByNum.addQuery('number', sysId.toUpperCase());
        grRitmByNum.setLimit(1);
        grRitmByNum.query();
        if (grRitmByNum.next()) {
            mode = 'ritm';
            p('NOTE: Input matched RITM number — ' + grRitmByNum.getValue('number'));
        } else {
            p('ERROR: RITM number ' + sysId + ' not found in sc_req_item.');
            return;
        }
    }

    // Try sc_req_item sys_id (if not already matched by number)
    if (!mode) {
        var grRitmById = new GlideRecord('sc_req_item');
        if (grRitmById.get(sysId)) {
            mode = 'ritm';
            p('NOTE: Input matched sc_req_item sys_id — ' + grRitmById.getValue('number'));
        }
    }

    // Handle RITM mode — extract RITM details and find workflow contexts
    if (mode === 'ritm') {
        var grRitmRef = isRitmNumber ? grRitmByNum : grRitmById;
        var ts = new GlideDateTime().toString();
        p(ln('=', 80));
        p('SERVICENOW RITM + WORKFLOW EXPORT');
        p('Extracted: ' + ts);
        p('Detected type: RITM (sc_req_item)');
        p(ln('=', 80));

        var ritmResult = extractRITM(grRitmRef);
        ritmContexts = ritmResult.contexts;
        var ritmFlows = ritmResult.flows;

        if (ritmContexts.length === 0 && ritmFlows.length === 0) {
            p('\nNOTE: no workflow contexts or Flow Designer runs found for this RITM.');
            p('Continuing with catalog item, business rule, and notification analysis.');
        }

        // Set up for multi-context extraction below
        // We'll iterate through all contexts after the function definition
    }

    // Try INC number first (e.g. INC0043257)
    var isIncNumber = /^INC\d+$/i.test(sysId);
    if (!mode && isIncNumber) {
        var grIncByNum = new GlideRecord('incident');
        grIncByNum.addQuery('number', sysId.toUpperCase());
        grIncByNum.setLimit(1);
        grIncByNum.query();
        if (grIncByNum.next()) {
            mode = 'incident';
            incTable = 'incident';
            p('NOTE: Input matched Incident number — ' + grIncByNum.getValue('number'));
        } else {
            p('ERROR: Incident number ' + sysId + ' not found in incident table.');
            return;
        }
    }

    // Try incident sys_id (if not already matched by number)
    if (!mode) {
        var grIncById = new GlideRecord('incident');
        if (grIncById.get(sysId)) {
            mode = 'incident';
            incTable = 'incident';
            p('NOTE: Input matched incident sys_id — ' + grIncById.getValue('number'));
        }
    }

    // Handle Incident mode — extract Incident details and find workflow contexts
    if (mode === 'incident') {
        var grIncRef = isIncNumber ? grIncByNum : grIncById;
        var ts = new GlideDateTime().toString();
        p(ln('=', 80));
        p('SERVICENOW INCIDENT + WORKFLOW EXPORT');
        p('Extracted: ' + ts);
        p('Detected type: Incident');
        p(ln('=', 80));

        var incResult = extractIncident(grIncRef);
        incContexts = incResult.contexts;
        incTable = incResult.tableName;

        if (incContexts.length === 0) {
            p(ln('=', 80));
            p('INCIDENT EXPORT COMPLETE — no workflow contexts found for this incident.');
            p(ln('=', 80));
        }

        // Set up for multi-context extraction below
        // We'll iterate through all contexts after the function definition
    }

    // Try sc_cat_item sys_id
    if (!mode) {
        var grCatItemCheck = new GlideRecord('sc_cat_item');
        if (grCatItemCheck.get(sysId)) {
            mode = 'catitem';
            catItemSysId = sysId;
            p('NOTE: Input matched sc_cat_item sys_id — ' + grCatItemCheck.getValue('name'));
        }
    }

    // Handle catalog item mode
    if (mode === 'catitem') {
        var ts = new GlideDateTime().toString();
        p(ln('=', 80));
        p('SERVICENOW CATALOG ITEM EXPORT');
        p('Extracted: ' + ts);
        p('Detected type: Catalog Item (sc_cat_item)');
        p(ln('=', 80));

        var catResult = extractCatalogItem(catItemSysId);
    }

    // Try sys_hub_flow (Flow Designer) by sys_id or by name
    if (!mode) {
        var grFlow = new GlideRecord('sys_hub_flow');
        if (grFlow.isValid()) {
            if (grFlow.get(sysId)) {
                mode = 'flow';
                flowSysId = sysId;
                p('NOTE: Input matched sys_hub_flow sys_id — ' + grFlow.getValue('name'));
            } else {
                // Try by name (case-insensitive)
                var grFlowByName = new GlideRecord('sys_hub_flow');
                grFlowByName.addQuery('name', sysId);
                grFlowByName.setLimit(1);
                grFlowByName.query();
                if (grFlowByName.next()) {
                    mode = 'flow';
                    flowSysId = grFlowByName.getUniqueValue();
                    p('NOTE: Input matched Flow Designer flow by name — ' + grFlowByName.getValue('name'));
                }
            }
        }
    }

    // Try wf_context
    if (!mode) {
    var grCtx = new GlideRecord('wf_context');
    if (grCtx.get(sysId)) {
        mode = 'context';
        contextId = sysId;
        wfv = grCtx.getValue('workflow_version');
        if (!wfv) {
            p('ERROR: wf_context ' + sysId + ' has no workflow_version reference.');
            return;
        }

        // Map SN state values to readable labels
        var stateMap = {
            'executing': 'Executing',
            'finished':  'Finished',
            'cancelled': 'Cancelled',
            'waiting':   'Waiting'
        };
        var rawState = grCtx.getValue('state');

        contextData = {
            state:       stateMap[rawState] || grCtx.getDisplayValue('state') || rawState,
            started:     grCtx.getDisplayValue('started') || '',
            ended:       grCtx.getDisplayValue('ended') || '',
            result:      grCtx.getDisplayValue('result') || '',
            recordTable: grCtx.getValue('table') || '',
            recordId:    grCtx.getValue('id') || '',
            recordDisplay: grCtx.getDisplayValue('id') || '',
            scratchpad:  grCtx.getValue('scratchpad') || ''
        };
    } else {
        // Try wf_workflow_version
        var grWfvCheck = new GlideRecord('wf_workflow_version');
        if (grWfvCheck.get(sysId)) {
            mode = 'definition';
            wfv = sysId;
        } else {
            // Try looking up wf_context by document record sys_id
            // (handles context_workflow.do?sysparm_document=<record_sys_id> URLs)
            var grCtxByDoc = new GlideRecord('wf_context');
            grCtxByDoc.addQuery('id', sysId);
            grCtxByDoc.orderByDesc('sys_created_on');
            grCtxByDoc.setLimit(1);
            grCtxByDoc.query();
            if (grCtxByDoc.next()) {
                mode = 'context';
                contextId = grCtxByDoc.getUniqueValue();
                wfv = grCtxByDoc.getValue('workflow_version');
                if (!wfv) {
                    p('ERROR: wf_context ' + contextId + ' has no workflow_version reference.');
                    return;
                }
                var stateMap2 = {
                    'executing': 'Executing',
                    'finished':  'Finished',
                    'cancelled': 'Cancelled',
                    'waiting':   'Waiting'
                };
                var rawState2 = grCtxByDoc.getValue('state');
                contextData = {
                    state:       stateMap2[rawState2] || grCtxByDoc.getDisplayValue('state') || rawState2,
                    started:     grCtxByDoc.getDisplayValue('started') || '',
                    ended:       grCtxByDoc.getDisplayValue('ended') || '',
                    result:      grCtxByDoc.getDisplayValue('result') || '',
                    recordTable: grCtxByDoc.getValue('table') || '',
                    recordId:    grCtxByDoc.getValue('id') || '',
                    recordDisplay: grCtxByDoc.getDisplayValue('id') || '',
                    scratchpad:  grCtxByDoc.getValue('scratchpad') || ''
                };
                p('NOTE: sys_id matched a record document — found wf_context ' + contextId);
            } else {
                p('ERROR: sys_id ' + sysId + ' not found in wf_context, wf_workflow_version,');
                p('  sys_hub_flow, or as a document record in wf_context.');
                p('  Also not found as a RITM/INC number or sc_req_item/incident sys_id.');
                p('  Make sure you copied the correct sys_id from the URL.');
                return;
            }
        }
    }
    }  // end if (!mode) — wf_context branch

    // For non-RITM, non-incident, non-flow, non-catitem modes, print the header here
    if (mode !== 'ritm' && mode !== 'incident' && mode !== 'flow' && mode !== 'catitem') {
    var ts = new GlideDateTime().toString();
    p(ln('=', 80));
    if (mode === 'context') {
        p('SERVICENOW WORKFLOW EXECUTION EXPORT');
    } else {
        p('SERVICENOW WORKFLOW EXPORT');
    }
    p('Extracted: ' + ts);
    p('Detected type: ' + (mode === 'context' ? 'Executed workflow (wf_context)' : 'Workflow definition (wf_workflow_version)'));
    p('workflow_version sys_id: ' + wfv);
    if (contextId) p('wf_context sys_id: ' + contextId);
    }

    // ── 1. Execution context metadata (if applicable) ────────

    if (contextData) {
        p(section('EXECUTION CONTEXT'));
        p('State: ' + contextData.state);
        if (contextData.started) p('Started: ' + contextData.started);
        if (contextData.ended)   p('Ended: ' + contextData.ended);
        if (contextData.result)  p('Result: ' + contextData.result);
        if (contextData.recordTable) {
            p('Record: ' + contextData.recordTable + ' / ' +
              contextData.recordDisplay + ' (' + contextData.recordId + ')');
        }
        if (contextData.scratchpad) {
            p('\nSCRATCHPAD (final state):');
            p(contextData.scratchpad);
        }
    }

    // ── Flow Designer extraction function ──────────────────────
    //    Extracts a complete Flow Designer flow definition from
    //    sys_hub_flow and related tables.

    var MAX_DEPTH = 10;
    var visitedFlows = {};  // track visited flow sys_ids to prevent loops
    var subWorkflowCount = 0;

    // Helper: query a table filtering by flow sys_id.
    // Different SN versions use different field names ('flow', 'model', 'flow_object').
    // This function checks sys_dictionary to find valid fields before querying.
    var _flowFieldCache = {};  // cache: tableName -> fieldName
    function queryByFlow(tableName, flowSysId, orderByField) {
        // Check cache first
        if (_flowFieldCache[tableName]) {
            var grCached = new GlideRecord(tableName);
            grCached.addQuery(_flowFieldCache[tableName], flowSysId);
            if (orderByField) grCached.orderBy(orderByField);
            grCached.query();
            return grCached;
        }

        var candidates = ['flow', 'flow_object', 'model', 'parent', 'flow_logic'];

        // Strategy 1: Try each candidate field directly (more reliable than dictionary lookup
        // which can miss fields inherited from deep base tables)
        for (var ci = 0; ci < candidates.length; ci++) {
            var field = candidates[ci];
            try {
                var grTest = new GlideRecord(tableName);
                if (!grTest.isValid()) break;
                if (grTest.isValidField(field)) {
                    grTest.addQuery(field, flowSysId);
                    if (orderByField) grTest.orderBy(orderByField);
                    grTest.query();
                    if (grTest.hasNext()) {
                        _flowFieldCache[tableName] = field;
                        return grTest;
                    }
                }
            } catch (e) {
                // field doesn't exist or query failed, try next
            }
        }

        // Strategy 2: If no results yet, try fields that returned valid but had 0 results
        // (the flow reference field exists but maybe has no matching records — still cache it)
        for (var vi = 0; vi < candidates.length; vi++) {
            var vField = candidates[vi];
            try {
                var grValid = new GlideRecord(tableName);
                if (!grValid.isValid()) break;
                if (grValid.isValidField(vField)) {
                    _flowFieldCache[tableName] = vField;
                    grValid.addQuery(vField, flowSysId);
                    if (orderByField) grValid.orderBy(orderByField);
                    grValid.query();
                    return grValid;
                }
            } catch (e) {
                // skip
            }
        }

        // Strategy 3: Fall back to dictionary lookup with hierarchy traversal
        var tables = [];
        var currentTable = tableName;
        for (var hi = 0; hi < 10 && currentTable; hi++) {
            tables.push(currentTable);
            var objGr = new GlideRecord('sys_db_object');
            objGr.addQuery('name', currentTable);
            objGr.setLimit(1);
            objGr.query();
            if (objGr.next() && objGr.getValue('super_class')) {
                currentTable = objGr.super_class.name + '';
                if (!currentTable || currentTable === 'undefined' || currentTable === 'null') {
                    currentTable = '';
                }
            } else {
                currentTable = '';
            }
        }

        for (var di = 0; di < candidates.length; di++) {
            var dictField = candidates[di];
            var dictGr = new GlideRecord('sys_dictionary');
            dictGr.addQuery('name', 'IN', tables.join(','));
            dictGr.addQuery('element', dictField);
            dictGr.setLimit(1);
            dictGr.query();
            if (dictGr.hasNext()) {
                _flowFieldCache[tableName] = dictField;
                var gr = new GlideRecord(tableName);
                if (!gr.isValid()) return gr;
                gr.addQuery(dictField, flowSysId);
                if (orderByField) gr.orderBy(orderByField);
                gr.query();
                return gr;
            }
        }

        // No valid field found — return empty result set
        p('  (WARNING: No flow reference field found on ' + tableName + ' — checked fields: ' + candidates.join(', ') + ' — hierarchy: ' + tables.join(', ') + ')');
        var grEmpty = new GlideRecord(tableName);
        if (grEmpty.isValid()) {
            grEmpty.addQuery('sys_id', 'INVALID_NO_FLOW_FIELD');
            grEmpty.query();
        }
        return grEmpty;
    }

    function extractFlowDesigner(targetFlowSysId, depth) {
        if (visitedFlows[targetFlowSysId]) {
            p('\n(Flow ' + targetFlowSysId + ' already extracted above — skipping to avoid loop)');
            return;
        }
        if (depth > MAX_DEPTH) {
            p('\n(Maximum sub-flow depth ' + MAX_DEPTH + ' reached — skipping)');
            return;
        }
        visitedFlows[targetFlowSysId] = true;

        var depthLabel = depth > 0 ? ' [DEPTH ' + depth + ']' : '';

        // ── Flow metadata ────────────────────────────────────────
        var grFlow = new GlideRecord('sys_hub_flow');
        if (!grFlow.get(targetFlowSysId)) {
            p('ERROR: sys_hub_flow ' + targetFlowSysId + ' not found!');
            return;
        }

        p(section('FLOW DESIGNER FLOW' + depthLabel));
        if (depth > 0) p('(Sub-flow, depth: ' + depth + ')');
        p('Name: ' + grFlow.getValue('name'));
        p('sys_id: ' + targetFlowSysId);
        p('Internal name: ' + (grFlow.getValue('internal_name') || ''));
        p('Status: ' + (grFlow.getDisplayValue('status') || grFlow.getValue('status') || ''));
        p('Active: ' + (grFlow.getValue('active') || ''));
        p('Table/Record type: ' + (grFlow.getDisplayValue('table') || grFlow.getValue('table') || '(any)'));
        p('Scope: ' + (grFlow.getDisplayValue('sys_scope') || 'Global'));
        p('Run as: ' + (grFlow.getDisplayValue('run_as') || 'System'));
        if (grFlow.getValue('description')) p('Description: ' + grFlow.getValue('description'));
        if (grFlow.getValue('sys_created_on')) p('Created: ' + grFlow.getDisplayValue('sys_created_on'));
        if (grFlow.getValue('sys_updated_on')) p('Updated: ' + grFlow.getDisplayValue('sys_updated_on'));
        if (grFlow.getValue('sys_updated_by')) p('Updated by: ' + grFlow.getValue('sys_updated_by'));

        // ── Label Cache (contains human-readable data references) ──
        var labelCache = grFlow.getValue('label_cache') || '';
        var labelCacheArray = null; // keep reference for trigger extraction later
        if (labelCache) {
            try {
                var labels = JSON.parse(labelCache);
                labelCacheArray = labels;
                if (labels && labels.length > 0) {
                    p(subsection('FLOW DATA REFERENCES (from label_cache)'));
                    for (var lci = 0; lci < labels.length; lci++) {
                        var lbl = labels[lci];
                        p('  ' + (lci + 1) + '. ' + (lbl.label || lbl.name || ''));
                        if (lbl.reference) p('     Reference table: ' + lbl.reference);
                        if (lbl.parent_table_name) p('     Parent table: ' + lbl.parent_table_name);
                        if (lbl.column_name) p('     Column: ' + lbl.column_name);
                        if (lbl.type) p('     Type: ' + lbl.type);
                        p('');
                    }
                }
            } catch (lcErr) {
                // label_cache not parseable
            }
        }

        // ── Flow Trigger ─────────────────────────────────────────
        p(subsection('TRIGGER'));
        var triggerCount = 0;
        var triggerInputsCompressed = false; // track if we couldn't decode trigger_inputs

        var triggerTableCandidates = ['sys_hub_trigger_instance_v2', 'sys_hub_trigger_instance'];
        var savedTrigDefId = ''; // save trigger_definition for later lookup
        for (var tci = 0; tci < triggerTableCandidates.length && triggerCount === 0; tci++) {
            var trigTbl = triggerTableCandidates[tci];
            var grTrigger = new GlideRecord(trigTbl);
            if (!grTrigger.isValid()) continue;
            if (grTrigger.isValidField('flow')) {
                grTrigger.addQuery('flow', targetFlowSysId);
                grTrigger.query();
            } else {
                grTrigger = queryByFlow(trigTbl, targetFlowSysId, null);
            }
            while (grTrigger.next()) {
                triggerCount++;
                savedTrigDefId = grTrigger.getValue('trigger_definition') || '';
                p('  Trigger ' + triggerCount + ' (from ' + trigTbl + '):');
                // Print all non-empty fields for maximum information
                var trigFields = grTrigger.getFields();
                for (var tfi = 0; tfi < trigFields.size(); tfi++) {
                    var tge = trigFields.get(tfi);
                    var tfName = tge.getName();
                    var tfVal = tge.getValue() || '';
                    // Skip system/meta fields
                    if (tfName.indexOf('sys_') === 0 && tfName !== 'sys_id') continue;
                    if (!tfVal || tfVal === 'false') continue;
                    // Skip compressed blobs — just note them
                    if ((tfName === 'trigger_inputs' || tfName === 'values') && 
                        tfVal.length > 200 && /^[A-Za-z0-9+\/=\s]+$/.test(tfVal.substring(0, 50))) {
                        triggerInputsCompressed = true;
                        continue;
                    }
                    var tfDisplay = tge.getDisplayValue() || '';
                    if (tfDisplay && tfDisplay !== tfVal) {
                        p('    ' + tfName + ': ' + tfDisplay + ' [' + tfVal + ']');
                    } else {
                        p('    ' + tfName + ': ' + tfVal);
                    }
                }
                p('');
            }
        }

        // If trigger was found but config is compressed, try alternative approaches
        if (triggerCount > 0 && triggerInputsCompressed) {
            // Approach 1: Extract trigger table from label_cache (already parsed above)
            //   Label_cache entries starting with "Trigger - " contain the trigger's table info
            //   The base trigger record has NO column_name (it's the record itself, not a field)
            var trigTableFromCache = '';
            var trigTypeFromCache = '';
            if (labelCacheArray && labelCacheArray.length > 0) {
                for (var lci2 = 0; lci2 < labelCacheArray.length; lci2++) {
                    var lcEntry = labelCacheArray[lci2];
                    var lcLabel = lcEntry.label || lcEntry.name || '';
                    if (lcLabel.indexOf('Trigger - ') === 0 && lcEntry.reference && !lcEntry.column_name) {
                        trigTableFromCache = lcEntry.reference;
                        // Extract trigger type from label: "Trigger - Record Updated➛..."
                        var trigTypeMatch = lcLabel.match(/^Trigger - ([^➛]+)/);
                        if (trigTypeMatch) trigTypeFromCache = trigTypeMatch[1].trim();
                        break;
                    }
                }
            }

            // Approach 2: Gather trigger details from multiple sources
            var fdTriggerFound = false;

            // 2a: Check sys_flow_context for last execution (confirms source_table)
            try {
                var grCtx = new GlideRecord('sys_flow_context');
                if (grCtx.isValid()) {
                    grCtx.addQuery('flow', targetFlowSysId);
                    grCtx.orderByDesc('sys_created_on');
                    grCtx.setLimit(1);
                    grCtx.query();
                    if (grCtx.next()) {
                        var ctxTable = grCtx.getValue('source_table') || '';
                        if (ctxTable && !trigTableFromCache) trigTableFromCache = ctxTable;
                    }
                }
            } catch (ctxErr) {}

            // Approach 3: Look up the trigger_definition record for category info
            var trigCategory = '';
            if (savedTrigDefId) {
                var trigDefTables = ['sys_hub_trigger_type', 'sys_hub_trigger_definition', 
                                     'sys_hub_action_type_definition'];
                for (var tdti = 0; tdti < trigDefTables.length; tdti++) {
                    var grTrigDef = new GlideRecord(trigDefTables[tdti]);
                    if (!grTrigDef.isValid()) continue;
                    if (grTrigDef.get(savedTrigDefId)) {
                        trigCategory = grTrigDef.getValue('category') || '';
                        break;
                    }
                }
            }

            // Present consolidated trigger summary
            p('  ┌─ TRIGGER SUMMARY ─────────────────────────────────');
            p('  │ Type: ' + (trigTypeFromCache || 'Record Updated'));
            p('  │ Table: ' + (trigTableFromCache || '(unknown)'));
            if (trigCategory) p('  │ Category: ' + trigCategory);
            p('  │ Condition: (stored in compressed trigger_inputs)');
            p('  │ Run trigger: (stored in compressed trigger_inputs)');
            p('  │');
            p('  │ NOTE: Trigger condition and run-trigger settings are');
            p('  │ stored as gzip+base64 in the trigger_inputs field.');
            p('  │ All decompression methods are blocked by the Java');
            p('  │ security sandbox in background script scope.');
            p('  │ View in Flow Designer UI for full details.');
            p('  └───────────────────────────────────────────────────');
            p('');
        }

        // Method 2: Check trigger fields directly on the flow record
        if (triggerCount === 0) {
            var trigType = grFlow.getValue('trigger_type') || grFlow.getDisplayValue('trigger_type') || '';
            var trigTable = grFlow.getValue('trigger_table') || grFlow.getDisplayValue('trigger_table') || '';
            var trigCond = grFlow.getValue('trigger_condition') || '';
            var trigRun = grFlow.getValue('run_trigger') || grFlow.getDisplayValue('run_trigger') || '';
            if (trigType || trigTable) {
                triggerCount++;
                p('  Trigger (from flow record):');
                if (trigType) p('    Type: ' + trigType);
                if (trigTable) p('    Table: ' + trigTable);
                if (trigCond) p('    Condition: ' + trigCond);
                if (trigRun) p('    Run trigger: ' + trigRun);
                p('');
            }
        }

        // Method 3: Search sys_hub_trigger_instance by scanning all reference fields
        if (triggerCount === 0) {
            var trigTables = ['sys_hub_trigger_instance', 'sys_hub_trigger_definition'];
            for (var tti = 0; tti < trigTables.length; tti++) {
                var trigTableName = trigTables[tti];
                var grTrigScan = new GlideRecord(trigTableName);
                if (!grTrigScan.isValid()) continue;
                // Try encoded query approach — look for any reference to our flow sys_id
                grTrigScan.addEncodedQuery('123TEXTQUERY321=' + targetFlowSysId);
                grTrigScan.setLimit(0); // reset
                // Fallback: scan recent triggers and check manually
                grTrigScan = new GlideRecord(trigTableName);
                if (!grTrigScan.isValid()) continue;
                grTrigScan.addEncodedQuery('sys_idISNOTEMPTY');
                grTrigScan.setLimit(50);
                grTrigScan.query();
                while (grTrigScan.next()) {
                    // Check if any field on this record contains our flow sys_id
                    var trigFields = grTrigScan.getFields();
                    for (var tfi = 0; tfi < trigFields.size(); tfi++) {
                        var tge = trigFields.get(tfi);
                        var tfVal = tge.getValue() || '';
                        if (tfVal === targetFlowSysId) {
                            triggerCount++;
                            p('  Trigger ' + triggerCount + ' (found via field scan on ' + trigTableName + '):');
                            p('    Linked via field: ' + tge.getName());
                            p('    Type: ' + (grTrigScan.getDisplayValue('type') || grTrigScan.getValue('type') || ''));
                            p('    Name: ' + (grTrigScan.getValue('name') || ''));
                            p('    sys_id: ' + grTrigScan.getUniqueValue());
                            if (grTrigScan.getValue('table')) p('    Table: ' + grTrigScan.getDisplayValue('table'));
                            if (grTrigScan.getValue('condition')) p('    Condition: ' + grTrigScan.getValue('condition'));
                            if (grTrigScan.getValue('when_to_run')) p('    When to run: ' + grTrigScan.getDisplayValue('when_to_run'));
                            p('');
                            break;
                        }
                    }
                    if (triggerCount > 0) break;
                }
                if (triggerCount > 0) break;
            }
        }

        if (triggerCount === 0) p('  (no trigger found — may be a subflow or action)');

        // ── Flow Inputs ──────────────────────────────────────────
        p(subsection('FLOW INPUTS'));
        var grFlowInput = new GlideRecord('sys_hub_flow_input');
        if (grFlowInput.isValid()) {
            grFlowInput = queryByFlow('sys_hub_flow_input', targetFlowSysId, 'order');
            var inputCount = 0;
            while (grFlowInput.next()) {
                inputCount++;
                var inputLabel = grFlowInput.getValue('label') || grFlowInput.getDisplayValue('label') || '';
                var inputName = grFlowInput.getValue('name') || '';
                // Prefer label over internal name (which often has var__m_ prefix)
                var displayName = inputLabel || inputName || '(unnamed)';
                p('  ' + inputCount + '. ' + displayName);
                if (inputLabel && inputName && inputName !== inputLabel) p('     Internal name: ' + inputName);
                p('     Type: ' + (grFlowInput.getDisplayValue('type') || grFlowInput.getValue('type') || ''));
                if (grFlowInput.getValue('mandatory') === 'true') p('     Mandatory: true');
                if (grFlowInput.getValue('default_value')) p('     Default: ' + grFlowInput.getValue('default_value'));
                p('');
            }
            if (inputCount === 0) p('  (no inputs defined)');
        } else {
            // Alternative: try sys_hub_flow_base table for inputs
            p('  (sys_hub_flow_input table not available)');
        }

        // ── Flow Outputs ─────────────────────────────────────────
        p(subsection('FLOW OUTPUTS'));
        var grFlowOutput = new GlideRecord('sys_hub_flow_output');
        if (grFlowOutput.isValid()) {
            grFlowOutput = queryByFlow('sys_hub_flow_output', targetFlowSysId, 'order');
            var outputCount = 0;
            while (grFlowOutput.next()) {
                outputCount++;
                p('  ' + outputCount + '. ' + (grFlowOutput.getValue('name') || grFlowOutput.getValue('label') || '(unnamed)'));
                if (grFlowOutput.getValue('label')) p('     Label: ' + grFlowOutput.getValue('label'));
                p('     Type: ' + (grFlowOutput.getDisplayValue('type') || grFlowOutput.getValue('type') || ''));
                if (grFlowOutput.getValue('value')) p('     Value mapping: ' + grFlowOutput.getValue('value'));
                p('');
            }
            if (outputCount === 0) p('  (no outputs defined)');
        } else {
            p('  (sys_hub_flow_output table not available)');
        }

        // ── Flow Actions (steps) ─────────────────────────────────
        //    Actions/steps are stored in sys_hub_action_instance or sys_hub_action_instance_v2
        p(subsection('FLOW ACTIONS / STEPS'));

        var actionList = [];
        var subFlowRefs = [];  // collect sub-flow references for recursion
        var actionCount = 0;

        // Try v2 table first, then v1, then intermediary approaches
        var actionTableCandidates = ['sys_hub_action_instance_v2', 'sys_hub_action_instance'];
        var grActions = null;
        for (var atci = 0; atci < actionTableCandidates.length; atci++) {
            var actTbl = actionTableCandidates[atci];
            var grActTest = new GlideRecord(actTbl);
            if (!grActTest.isValid()) continue;
            if (grActTest.isValidField('flow')) {
                grActTest.addQuery('flow', targetFlowSysId);
                grActTest.orderBy('order');
                grActTest.query();
                if (grActTest.hasNext()) {
                    grActions = grActTest;
                    p('  (source: ' + actTbl + ')');
                    break;
                }
            }
            // Also try queryByFlow for other possible fields
            var grActAlt = queryByFlow(actTbl, targetFlowSysId, 'order');
            if (grActAlt.hasNext()) {
                grActions = grActAlt;
                p('  (source: ' + actTbl + ' via queryByFlow)');
                break;
            }
        }

        // Fallback: try sys_hub_flow_logic_instance_v2
        if (!grActions || !grActions.hasNext()) {
            var grLogicV2 = new GlideRecord('sys_hub_flow_logic_instance_v2');
            if (grLogicV2.isValid() && grLogicV2.isValidField('flow')) {
                grLogicV2.addQuery('flow', targetFlowSysId);
                grLogicV2.orderBy('order');
                grLogicV2.query();
                if (grLogicV2.hasNext()) {
                    grActions = grLogicV2;
                    p('  (source: sys_hub_flow_logic_instance_v2)');
                }
            }
        }

        while (grActions && grActions.next()) {
            actionCount++;
            var actionSysId = grActions.getUniqueValue();
            var actionName = grActions.getValue('name') || grActions.getDisplayValue('name') || '(unnamed)';
            var actionType = grActions.getDisplayValue('action_type') || grActions.getValue('action_type') || 
                             grActions.getDisplayValue('type') || grActions.getValue('type') || '';
            var actionTypeSysId = grActions.getValue('action_type') || grActions.getValue('type') || '';
            var nesting = grActions.getValue('nesting_level') || grActions.getValue('nesting') || '0';
            var parentAction = grActions.getValue('parent') || '';

            p('  ' + actionCount + '. [' + actionType + '] ' + actionName);
            p('     sys_id: ' + actionSysId);
            p('     Order: ' + (grActions.getValue('order') || grActions.getValue('position') || ''));
            if (nesting !== '0') p('     Nesting level: ' + nesting);
            if (parentAction) p('     Parent: ' + grActions.getDisplayValue('parent'));

            // Dump all meaningful fields for this action
            var actAllFields = grActions.getFields();
            for (var aafi = 0; aafi < actAllFields.size(); aafi++) {
                var aage = actAllFields.get(aafi);
                var aafName = aage.getName();
                var aafVal = aage.getValue() || '';
                // Skip already-printed and system fields
                if (!aafVal || aafVal === 'false' || aafVal === '0') continue;
                if (aafName === 'name' || aafName === 'action_type' || aafName === 'type' || 
                    aafName === 'order' || aafName === 'position' || aafName === 'nesting_level' || 
                    aafName === 'parent' || aafName === 'flow' || aafName === 'nesting') continue;
                if (aafName.indexOf('sys_') === 0) continue;
                var aafDisplay = aage.getDisplayValue() || '';
                if (aafVal.length > 500) {
                    // Check if it's a compressed blob (base64+gzip) — skip silently
                    if (/^[A-Za-z0-9+\/=\s]+$/.test(aafVal.substring(0, 100))) {
                        // Compressed config blob — can't decode from background script
                        continue;
                    }
                    // Other long value — likely a script
                    p('     ' + aafName + ':');
                    p('     ---- START ----');
                    p(aafVal);
                    p('     ---- END ----');
                } else if (aafDisplay && aafDisplay !== aafVal) {
                    p('     ' + aafName + ': ' + aafDisplay + ' [' + aafVal + ']');
                } else {
                    p('     ' + aafName + ': ' + aafVal);
                }
            }

            // Action condition
            if (grActions.getValue('condition')) {
                p('     Condition: ' + grActions.getValue('condition'));
            }

            // Detect sub-flow calls
            var lowerActionType = actionType.toLowerCase();
            if (lowerActionType.indexOf('subflow') !== -1 || lowerActionType.indexOf('sub-flow') !== -1 ||
                lowerActionType.indexOf('sub flow') !== -1) {
                // The referenced subflow sys_id is typically in the action inputs
                var subFlowRef = grActions.getValue('action_type') || '';
                subFlowRefs.push({
                    parentActionName: actionName,
                    actionSysId: actionSysId
                });
            }

            // Action inputs (sys_hub_action_instance_input or inline on the record)
            var grActInputs = new GlideRecord('sys_hub_action_instance_input');
            if (grActInputs.isValid()) {
                grActInputs.addQuery('action_instance', actionSysId);
                grActInputs.query();
                var hasInputs = false;
                while (grActInputs.next()) {
                    if (!hasInputs) {
                        p('     INPUTS:');
                        hasInputs = true;
                    }
                    var inputName = grActInputs.getValue('name') || grActInputs.getDisplayValue('name') || '';
                    var inputVal = grActInputs.getValue('value_static') || grActInputs.getValue('value') || '';
                    var inputRef = grActInputs.getValue('value_ref') || '';
                    if (inputVal) {
                        p('       ' + inputName + ' = ' + inputVal);
                    } else if (inputRef) {
                        p('       ' + inputName + ' = [ref] ' + inputRef);
                    } else {
                        p('       ' + inputName + ' = (empty)');
                    }
                }
            }

            // Action outputs
            var grActOutputs = new GlideRecord('sys_hub_action_instance_output');
            if (grActOutputs.isValid()) {
                grActOutputs.addQuery('action_instance', actionSysId);
                grActOutputs.query();
                var hasOutputs = false;
                while (grActOutputs.next()) {
                    if (!hasOutputs) {
                        p('     OUTPUTS:');
                        hasOutputs = true;
                    }
                    var outName = grActOutputs.getValue('name') || '';
                    var outLabel = grActOutputs.getValue('label') || '';
                    p('       ' + (outLabel || outName));
                }
            }

            // Inline script (some actions have a script field)
            if (grActions.getValue('script')) {
                p('     SCRIPT:');
                p('     ---- SCRIPT START ----');
                p(grActions.getValue('script'));
                p('     ---- SCRIPT END ----');
            }

            // Transform mapping / assignment (for Set Values type actions)
            if (grActions.getValue('transform_map')) {
                p('     Transform map: ' + grActions.getDisplayValue('transform_map'));
            }

            p('');
            actionList.push({
                sys_id: actionSysId,
                name: actionName,
                type: actionType,
                typeSysId: actionTypeSysId
            });
        }

        if (actionCount === 0) p('  (no actions/steps found)');

        // ── Flow Action Definitions (for script actions) ─────────
        //    Look up the underlying action definitions for custom script actions

        p(subsection('ACTION STEP DETAILS'));
        for (var fai = 0; fai < actionList.length; fai++) {
            var actInfo = actionList[fai];
            if (!actInfo.typeSysId) continue;

            // Check if this is a custom action (sys_hub_action_type_definition)
            var grActDef = new GlideRecord('sys_hub_action_type_definition');
            if (grActDef.isValid() && grActDef.get(actInfo.typeSysId)) {
                var defName = grActDef.getValue('name') || '';
                var defScript = grActDef.getValue('script') || '';
                if (defScript) {
                    p('  Action definition for: ' + actInfo.name);
                    p('  Definition name: ' + defName);
                    p('  ---- SCRIPT START ----');
                    p(defScript);
                    p('  ---- SCRIPT END ----');
                    p('');
                }
            }
        }

        // ── Subflow step configuration from sys_hub_sub_flow_instance ──
        var grSubFlowInst = new GlideRecord('sys_hub_sub_flow_instance');
        if (grSubFlowInst.isValid()) {
            grSubFlowInst = queryByFlow('sys_hub_sub_flow_instance', targetFlowSysId, null);
            while (grSubFlowInst.next()) {
                var sfRef = grSubFlowInst.getValue('sub_flow') || '';
                var sfName = grSubFlowInst.getDisplayValue('sub_flow') || '';
                if (sfRef) {
                    p('  Sub-flow call: ' + sfName + ' (sys_id: ' + sfRef + ')');
                    subFlowRefs.push({
                        parentActionName: grSubFlowInst.getValue('name') || sfName,
                        flowSysId: sfRef
                    });
                }
            }
        }

        // ── Flow Logic / Conditions ─────────────────────────────
        var logicTableCandidates = ['sys_hub_flow_logic_instance_v2', 'sys_hub_flow_logic'];
        var logicCount = 0;
        var logicUseful = 0; // count of nodes with actual readable data
        for (var ltci = 0; ltci < logicTableCandidates.length && logicCount === 0; ltci++) {
            var logicTbl = logicTableCandidates[ltci];
            var grLogic = new GlideRecord(logicTbl);
            if (!grLogic.isValid()) continue;
            if (grLogic.isValidField('flow')) {
                grLogic.addQuery('flow', targetFlowSysId);
                grLogic.orderBy('order');
                grLogic.query();
            } else {
                grLogic = queryByFlow(logicTbl, targetFlowSysId, 'order');
            }
            while (grLogic.next()) {
                logicCount++;
                var logicType = grLogic.getDisplayValue('type') || grLogic.getValue('type') || '';
                var logicName = grLogic.getValue('name') || '';
                var logicCondition = grLogic.getValue('condition') || '';
                var logicScript = grLogic.getValue('script') || '';
                // Only print nodes that have meaningful data beyond just a ui_id
                if (logicType || logicName || logicCondition || logicScript) {
                    if (logicUseful === 0) p(subsection('FLOW LOGIC / CONDITIONS (from ' + logicTbl + ')'));
                    logicUseful++;
                    p('  ' + logicUseful + '. Type: ' + logicType);
                    if (logicName) p('     Name: ' + logicName);
                    if (logicCondition) p('     Condition: ' + logicCondition);
                    if (logicScript) {
                        p('     SCRIPT:');
                        p('     ---- SCRIPT START ----');
                        p(logicScript);
                        p('     ---- SCRIPT END ----');
                    }
                    p('');
                }
            }
            if (logicCount > 0 && logicUseful === 0) {
                p(subsection('FLOW LOGIC'));
                p('  (' + logicCount + ' flow logic nodes found, no readable conditions/scripts — config stored in compressed format)');
            }
        }

        // ── Flow Variables (sys_hub_flow_variable) ───────────────
        var grFlowVar = new GlideRecord('sys_hub_flow_variable');
        if (grFlowVar.isValid()) {
            grFlowVar = queryByFlow('sys_hub_flow_variable', targetFlowSysId, null);
            var varCount = 0;
            while (grFlowVar.next()) {
                if (varCount === 0) p(subsection('FLOW VARIABLES'));
                varCount++;
                var fvLabel = grFlowVar.getValue('label') || grFlowVar.getDisplayValue('label') || '';
                var fvName = grFlowVar.getValue('name') || '';
                p('  ' + varCount + '. ' + (fvLabel || fvName || '(unnamed)'));
                if (fvLabel && fvName && fvName !== fvLabel) p('     Internal name: ' + fvName);
                p('     Type: ' + (grFlowVar.getDisplayValue('type') || grFlowVar.getValue('type') || ''));
                if (grFlowVar.getValue('value')) p('     Value: ' + grFlowVar.getValue('value'));
                p('');
            }
        }

        // ── Recurse into sub-flows ──────────────────────────────
        if (subFlowRefs.length > 0) {
            p(subsection('SUB-FLOWS REFERENCED: ' + subFlowRefs.length));
            for (var sfi = 0; sfi < subFlowRefs.length; sfi++) {
                var sfInfo = subFlowRefs[sfi];
                var sfId = sfInfo.flowSysId;

                // If we don't have a direct flow sys_id, try to find it from action inputs
                if (!sfId && sfInfo.actionSysId) {
                    var grSfInput = new GlideRecord('sys_hub_action_instance_input');
                    if (grSfInput.isValid()) {
                        grSfInput.addQuery('action_instance', sfInfo.actionSysId);
                        grSfInput.addQuery('name', 'CONTAINS', 'flow');
                        grSfInput.setLimit(1);
                        grSfInput.query();
                        if (grSfInput.next()) {
                            sfId = grSfInput.getValue('value_static') || grSfInput.getValue('value') || '';
                        }
                    }
                }

                p('  ' + (sfi + 1) + '. Called by: ' + sfInfo.parentActionName);
                if (sfId && sfId.length === 32) {
                    p('     Flow sys_id: ' + sfId);
                    subWorkflowCount++;
                    p('\n' + ln('#', 80));
                    p('EXTRACTING SUB-FLOW ' + subWorkflowCount + ': ' + sfInfo.parentActionName);
                    p(ln('#', 80));
                    extractFlowDesigner(sfId, depth + 1);
                } else {
                    p('     (could not resolve sub-flow sys_id)');
                }
            }
        }

        p('');
    }  // end extractFlowDesigner()

    // ── Recursive workflow extraction function ───────────────
    //    Extracts a single workflow version and recurses into
    //    any sub-workflows found in "Workflow" activities.

    var visitedWorkflows = {};  // track visited wfv sys_ids to prevent loops
    var grandTotalActivities = 0;
    var grandTotalVars = 0;
    var grandTotalExec = 0;

    function extractWorkflow(targetWfv, targetContextId, depth) {
        // Prevent infinite loops and excessive depth
        if (visitedWorkflows[targetWfv]) {
            p('\n(Sub-workflow ' + targetWfv + ' already extracted above — skipping to avoid loop)');
            return;
        }
        if (depth > MAX_DEPTH) {
            p('\n(Maximum sub-workflow depth ' + MAX_DEPTH + ' reached — skipping)');
            return;
        }
        visitedWorkflows[targetWfv] = true;

        var depthPrefix = '';
        for (var dp = 0; dp < depth; dp++) depthPrefix += '  ';
        var depthLabel = depth > 0 ? ' [DEPTH ' + depth + ']' : '';

    // ── 2. Workflow metadata ─────────────────────────────────

    var grWfv = new GlideRecord('wf_workflow_version');
    if (grWfv.get(targetWfv)) {
        p(section('WORKFLOW DEFINITION' + depthLabel));
        if (depth > 0) p('(Sub-workflow, depth: ' + depth + ')');
        p('Version name: ' + grWfv.getDisplayValue('name'));
        p('Published: ' + grWfv.getValue('published'));
        p('Table: ' + grWfv.getDisplayValue('table'));
        if (grWfv.getValue('condition')) p('Condition: ' + grWfv.getValue('condition'));
        if (grWfv.getValue('description')) p('Description: ' + grWfv.getValue('description'));
        var parentId = grWfv.getValue('workflow');
        if (parentId) {
            var grWf = new GlideRecord('wf_workflow');
            if (grWf.get(parentId)) {
                p('Workflow: ' + grWf.getDisplayValue('name'));
                p('Scope: ' + grWf.getDisplayValue('sys_scope'));
                if (grWf.getValue('description')) p('Workflow description: ' + grWf.getValue('description'));
            }
        }
    } else {
        p('ERROR: workflow_version ' + targetWfv + ' not found!');
        return;
    }
    p(ln('=', 80));

    // ── 2a. Workflow Stages ──────────────────────────────────
    var grStage = new GlideRecord('wf_stage');
    grStage.addQuery('workflow_version', targetWfv);
    grStage.orderBy('order');
    grStage.query();
    var stageCount = 0;
    if (grStage.hasNext()) {
        p(subsection('WORKFLOW STAGES'));
        while (grStage.next()) {
            stageCount++;
            p('  ' + stageCount + '. ' + grStage.getValue('name') +
              ' (value: ' + (grStage.getValue('value') || grStage.getValue('ov')) + ')');
        }
    }

    // ── 2b. Get all activities ───────────────────────────────

    var grAct = new GlideRecord('wf_activity');
    grAct.addQuery('workflow_version', targetWfv);
    grAct.orderBy('y');
    grAct.orderBy('x');
    grAct.query();

    var actList = [];
    var actSysIds = [];
    while (grAct.next()) {
        var sid = grAct.getValue('sys_id');
        actSysIds.push(sid);
        actList.push({
            sys_id: sid,
            name:   grAct.getValue('name'),
            type:   grAct.getDisplayValue('activity_definition'),
            actdef: grAct.getValue('activity_definition'),
            x:      grAct.getValue('x'),
            y:      grAct.getValue('y'),
            stage:  grAct.getDisplayValue('stage'),
            input:  grAct.getValue('input') || ''
        });
    }

    grandTotalActivities += actList.length;

    // Activity index
    p(section('ACTIVITY INDEX (' + actList.length + ' activities)' + depthLabel));
    for (var ai = 0; ai < actList.length; ai++) {
        p('  ' + (ai + 1) + '. [' + actList[ai].type + '] ' + actList[ai].name +
          '  (sys_id: ' + actList[ai].sys_id + ')');
    }

    // ── 3. Transitions ───────────────────────────────────────

    var grTr = new GlideRecord('wf_transition');
    grTr.addQuery('from.workflow_version', targetWfv);
    grTr.query();
    p(section('TRANSITIONS' + depthLabel));
    while (grTr.next()) {
        var fromName = grTr.getDisplayValue('from');
        var toName   = grTr.getDisplayValue('to');
        var condLabel = grTr.getDisplayValue('condition') || '';
        p('  ' + fromName + '  -->  ' + toName + (condLabel ? '  [' + condLabel + ']' : ''));
    }

    // ── 3b. Execution history (context mode only) ────────────
    //    wf_history and wf_executing store per-activity execution data

    var execByActivity = {};  // keyed by wf_activity sys_id

    if (targetContextId) {
        // Finished activities — wf_history
        var grHist = new GlideRecord('wf_history');
        grHist.addQuery('context', targetContextId);
        grHist.orderBy('started');
        grHist.query();
        while (grHist.next()) {
            var histActId = grHist.getValue('activity');
            if (!execByActivity[histActId]) execByActivity[histActId] = [];
            execByActivity[histActId].push({
                source:  'history',
                state:   grHist.getDisplayValue('state') || grHist.getValue('state') || '',
                result:  grHist.getDisplayValue('result') || grHist.getValue('result') || '',
                started: grHist.getDisplayValue('started') || '',
                ended:   grHist.getDisplayValue('ended') || '',
                fault:   grHist.getValue('fault_description') || '',
                output:  grHist.getValue('output') || ''
            });
        }

        // Currently executing activities — wf_executing
        var grExec = new GlideRecord('wf_executing');
        grExec.addQuery('context', targetContextId);
        grExec.orderBy('started');
        grExec.query();
        while (grExec.next()) {
            var execActId = grExec.getValue('activity');
            if (!execByActivity[execActId]) execByActivity[execActId] = [];
            execByActivity[execActId].push({
                source:  'executing',
                state:   grExec.getDisplayValue('state') || grExec.getValue('state') || '',
                result:  grExec.getDisplayValue('result') || grExec.getValue('result') || '',
                started: grExec.getDisplayValue('started') || '',
                ended:   grExec.getDisplayValue('ended') || '',
                fault:   grExec.getValue('fault_description') || '',
                output:  grExec.getValue('output') || ''
            });
        }
    }

    // ── 4. Get ALL variable values for activities ────────────
    //    Scripts, conditions, and config are stored in sys_variable_value
    //    with document='wf_activity' and document_key=<activity sys_id>

    var valuesByActivity = {};

    var batchSize = 50;
    for (var bi = 0; bi < actSysIds.length; bi += batchSize) {
        var batch = actSysIds.slice(bi, bi + batchSize);
        var grVal = new GlideRecord('sys_variable_value');
        grVal.addQuery('document', 'wf_activity');
        grVal.addQuery('document_key', 'IN', batch.join(','));
        grVal.query();

        while (grVal.next()) {
            var docKey = grVal.getValue('document_key');
            var varLabel = grVal.getDisplayValue('variable') || grVal.getValue('variable');
            var val = grVal.getValue('value') || '';

            if (!valuesByActivity[docKey]) valuesByActivity[docKey] = [];
            valuesByActivity[docKey].push({
                label: varLabel,
                value: val
            });
        }
    }

    // ── 4b. Get orchestration scripts (sa_step) for activities ──
    //    Orchestration activities reference an activity_definition which
    //    links to sa_pattern → sa_step containing the actual PowerShell/
    //    SSH/script content executed on the MID Server.

    var orchScriptsByActivity = {};  // keyed by wf_activity sys_id

    // Collect unique activity_definition sys_ids
    var actDefIds = [];
    var actDefToActivities = {};  // actdef sys_id → [activity sys_ids]
    for (var adi = 0; adi < actList.length; adi++) {
        var adef = actList[adi].actdef;
        if (adef) {
            if (!actDefToActivities[adef]) {
                actDefToActivities[adef] = [];
                actDefIds.push(adef);
            }
            actDefToActivities[adef].push(actList[adi].sys_id);
        }
    }

    // Look up sa_pattern records for these activity definitions
    if (actDefIds.length > 0) {
        var patternToActDef = {};  // pattern sys_id → actdef sys_id
        var orchMetaByActDef = {};  // actdef sys_id → {midServer, credential}

        // Check if sa_pattern table exists before querying
        var saPatternExists = new GlideRecord('sa_pattern').isValid();
        if (saPatternExists) {
            for (var pbi = 0; pbi < actDefIds.length; pbi += batchSize) {
                var pBatch = actDefIds.slice(pbi, pbi + batchSize);
                var grPat = new GlideRecord('sa_pattern');
                grPat.addQuery('activity_definition', 'IN', pBatch.join(','));
                grPat.query();
                while (grPat.next()) {
                    var patId = grPat.getUniqueValue();
                    var patActDef = grPat.getValue('activity_definition');
                    patternToActDef[patId] = patActDef;
                    // Capture MID server and credential info from the pattern
                    orchMetaByActDef[patActDef] = {
                        midServer:  grPat.getDisplayValue('mid_server') || grPat.getValue('mid_server') || '',
                        credential: grPat.getDisplayValue('credential') || grPat.getValue('credential') || ''
                    };
                }
            }
        }

        // Check wf_activity_definition for MID server / credential alias / category
        for (var adbi = 0; adbi < actDefIds.length; adbi += batchSize) {
            var adBatch = actDefIds.slice(adbi, adbi + batchSize);
            var grActDef = new GlideRecord('wf_activity_definition');
            grActDef.addQuery('sys_id', 'IN', adBatch.join(','));
            grActDef.query();
            while (grActDef.next()) {
                var adId = grActDef.getUniqueValue();
                if (!orchMetaByActDef[adId]) orchMetaByActDef[adId] = {};
                var existingMeta = orchMetaByActDef[adId];
                // Pick up MID server selector and credential fields if present
                if (!existingMeta.midServer) {
                    existingMeta.midServer = grActDef.getDisplayValue('mid_server') || grActDef.getValue('mid_server') || '';
                }
                if (!existingMeta.credential) {
                    existingMeta.credential = grActDef.getDisplayValue('credential') || grActDef.getValue('credential') || '';
                }
                existingMeta.category = grActDef.getDisplayValue('category') || '';
            }
        }

        // Get steps for all found patterns (only if sa_step table exists)
        var saStepExists = new GlideRecord('sa_step').isValid();
        var patternIds = [];
        for (var pk in patternToActDef) {
            if (patternToActDef.hasOwnProperty(pk)) patternIds.push(pk);
        }

        if (saStepExists && patternIds.length > 0) {
            for (var sbi = 0; sbi < patternIds.length; sbi += batchSize) {
                var sBatch = patternIds.slice(sbi, sbi + batchSize);
                var grStep = new GlideRecord('sa_step');
                grStep.addQuery('pattern', 'IN', sBatch.join(','));
                grStep.orderBy('order');
                grStep.query();
                while (grStep.next()) {
                    var stepPatId = grStep.getValue('pattern');
                    var stepActDef = patternToActDef[stepPatId];
                    var stepData = {
                        name:       grStep.getValue('name') || '',
                        order:      grStep.getValue('order') || '',
                        scriptType: grStep.getDisplayValue('script_type') || grStep.getValue('script_type') || '',
                        script:     grStep.getValue('script') || '',
                        inputs:     grStep.getValue('inputs') || '',
                        outputs:    grStep.getValue('outputs') || '',
                        condition:  grStep.getValue('condition') || ''
                    };
                    // Map to all activities using this activity_definition
                    var relatedActs = actDefToActivities[stepActDef] || [];
                    for (var ra = 0; ra < relatedActs.length; ra++) {
                        var raId = relatedActs[ra];
                        if (!orchScriptsByActivity[raId]) orchScriptsByActivity[raId] = [];
                        orchScriptsByActivity[raId].push(stepData);
                    }
                }
            }
        }

        if (!saPatternExists) {
            p('\nNOTE: sa_pattern table not found — orchestration scripts cannot be extracted.');
            p('  The Service Automation plugin may not be active, or scripts are stored differently.');
        }
    }

    // ── 5. Activity details ──────────────────────────────────
    //    When we have execution context, only show full details for
    //    activities that actually ran. Skipped activities get a one-liner.

    p(section('ACTIVITY DETAILS' + depthLabel));

    // If we're in context mode, list skipped activities first as a summary
    if (targetContextId) {
        var skippedActivities = [];
        for (var ski = 0; ski < actList.length; ski++) {
            if (!execByActivity[actList[ski].sys_id]) {
                skippedActivities.push(actList[ski]);
            }
        }
        if (skippedActivities.length > 0) {
            p('\nSKIPPED ACTIVITIES (' + skippedActivities.length + ' not reached):');
            for (var sai = 0; sai < skippedActivities.length; sai++) {
                p('  - [' + skippedActivities[sai].type + '] ' + skippedActivities[sai].name);
            }
            p('');
        }
    }

    var subWorkflows = [];  // collect sub-workflow references for recursive extraction
    var flowDesignerRefs = [];  // collect Flow Designer flow references from workflow activities

    for (var di = 0; di < actList.length; di++) {
        var info = actList[di];

        // Execution history (context mode only)
        var execEntries = execByActivity[info.sys_id];

        // In context mode, skip full details for activities that didn't execute
        if (targetContextId && !execEntries) {
            continue;  // already listed in SKIPPED ACTIVITIES summary above
        }

        p(subsection(info.name + '  [' + info.type + ']'));
        p('sys_id: ' + info.sys_id);
        p('Position: x=' + info.x + ', y=' + info.y);
        if (info.stage) p('Stage: ' + info.stage);

        if (execEntries && execEntries.length > 0) {
            p('\nEXECUTION:');
            for (var ei = 0; ei < execEntries.length; ei++) {
                var ex = execEntries[ei];
                var exLine = '  [' + (ex.source === 'executing' ? 'EXECUTING' : 'HISTORY') + ']';
                if (ex.state) exLine += '  State: ' + ex.state;
                if (ex.result) exLine += '  Result: ' + ex.result;
                p(exLine);
                if (ex.started) p('    Started: ' + ex.started);
                if (ex.ended)   p('    Ended:   ' + ex.ended);
                if (ex.fault)   p('    FAULT: ' + ex.fault);
                if (ex.output)  p('    Output: ' + ex.output);
            }
        }

        // INPUT from orchestration activities
        if (info.input && info.input !== '{}') {
            p('\nINPUT (orchestration):');
            p(info.input);
        }

        // Variable values from sys_variable_value
        var vars = valuesByActivity[info.sys_id];
        if (vars && vars.length > 0) {
            for (var vi = 0; vi < vars.length; vi++) {
                var v = vars[vi];
                if (!v.value && v.value !== '0') continue;

                p('\n' + v.label.toUpperCase() + ':');
                p(v.value);

                // Detect sub-workflow references:
                // "Workflow" activities store the child workflow's wf_workflow sys_id
                // in a variable typically labeled "workflow" or "Workflow"
                var lowerType = info.type.toLowerCase();
                var lowerLabel = v.label.toLowerCase();
                if ((lowerType === 'workflow' || lowerType.indexOf('sub') !== -1) &&
                    (lowerLabel === 'workflow' || lowerLabel === 'sub workflow' || lowerLabel === 'subflow') &&
                    v.value && v.value.length === 32) {
                    // v.value is the wf_workflow sys_id — we need to find
                    // the published wf_workflow_version for it
                    subWorkflows.push({
                        parentActivityName: info.name,
                        workflowSysId: v.value
                    });
                }

                // Detect Flow Designer flow references:
                // "Flow Logic" or "Run Flow" activities store the sys_hub_flow sys_id
                // in a variable labeled "flow", "subflow", or similar
                if ((lowerType.indexOf('flow') !== -1 || lowerType.indexOf('run flow') !== -1 ||
                     lowerType.indexOf('flow logic') !== -1) &&
                    (lowerLabel === 'flow' || lowerLabel === 'subflow' || lowerLabel === 'sub flow' ||
                     lowerLabel === 'flow_id' || lowerLabel === 'sub-flow') &&
                    v.value && v.value.length === 32) {
                    flowDesignerRefs.push({
                        parentActivityName: info.name,
                        flowSysId: v.value
                    });
                }
            }
        } else {
            if (!info.input || info.input === '{}') {
                p('\n(no configuration found)');
            }
        }

        // Orchestration metadata (MID server, credential, category)
        var orchMeta = orchMetaByActDef[info.actdef];
        if (orchMeta) {
            var hasMeta = orchMeta.midServer || orchMeta.credential || orchMeta.category;
            if (hasMeta) {
                p('\nORCHESTRATION CONFIG:');
                if (orchMeta.midServer) p('  MID Server: ' + orchMeta.midServer);
                if (orchMeta.credential) p('  Credential: ' + orchMeta.credential);
                if (orchMeta.category) p('  Category: ' + orchMeta.category);
            }
        }

        // Orchestration scripts (sa_step) for this activity
        var orchSteps = orchScriptsByActivity[info.sys_id];
        if (orchSteps && orchSteps.length > 0) {
            p('\nORCHESTRATION STEPS (' + orchSteps.length + '):');
            for (var osi = 0; osi < orchSteps.length; osi++) {
                var step = orchSteps[osi];
                p('  Step ' + (step.order || (osi + 1)) + ': ' + (step.name || '(unnamed)'));
                if (step.scriptType) p('  Script type: ' + step.scriptType);
                if (step.condition) {
                    p('  Condition: ' + step.condition);
                }
                if (step.inputs) {
                    p('  Inputs: ' + step.inputs);
                }
                if (step.script) {
                    p('  ---- SCRIPT START ----');
                    p(step.script);
                    p('  ---- SCRIPT END ----');
                }
                if (step.outputs) {
                    p('  Outputs: ' + step.outputs);
                }
                p('');
            }
        }

        p('');
    }

    // ── 5b. Extract referenced Script Includes ─────────────
    //    Scan all activity scripts for "new ClassName()" patterns
    //    and extract the full source from sys_script_include.

    var referencedScriptIncludes = {};  // name → true (dedup)

    // Collect all script text from activity variables
    for (var sci = 0; sci < actList.length; sci++) {
        var scVars = valuesByActivity[actList[sci].sys_id];
        if (!scVars) continue;
        for (var scv = 0; scv < scVars.length; scv++) {
            var scVal = scVars[scv].value || '';
            if (!scVal) continue;
            // Match "new ClassName(" patterns — captures the class name
            var newPattern = /new\s+([A-Z][A-Za-z0-9_]+)\s*\(/g;
            var match;
            while ((match = newPattern.exec(scVal)) !== null) {
                var className = match[1];
                // Skip standard ServiceNow/JS classes that aren't custom Script Includes
                if (className === 'GlideRecord' || className === 'GlideDateTime' ||
                    className === 'GlideAggregate' || className === 'GlideDuration' ||
                    className === 'GlideFilter' || className === 'GlideSysAttachment' ||
                    className === 'GlideElement' || className === 'GlideSession' ||
                    className === 'GlideSchedule' || className === 'GlideUser' ||
                    className === 'GlideUpdateManager' || className === 'GlideappCalculationHelper' ||
                    className === 'ArrayUtil' || className === 'JSON' || className === 'Array' ||
                    className === 'Date' || className === 'RegExp' || className === 'Error' ||
                    className === 'Object' || className === 'String' || className === 'Number') {
                    continue;
                }
                referencedScriptIncludes[className] = true;
            }
        }
    }

    // Look up and print each Script Include (only at depth 0 to avoid duplication)
    if (depth === 0) {
        var siNames = [];
        for (var siName in referencedScriptIncludes) {
            if (referencedScriptIncludes.hasOwnProperty(siName)) siNames.push(siName);
        }

        if (siNames.length > 0) {
            p(section('REFERENCED SCRIPT INCLUDES (' + siNames.length + ')'));
            for (var sii = 0; sii < siNames.length; sii++) {
                var siLookupName = siNames[sii];
                var grSI = new GlideRecord('sys_script_include');
                grSI.addQuery('name', siLookupName);
                grSI.setLimit(1);
                grSI.query();
                if (grSI.next()) {
                    p(subsection('Script Include: ' + siLookupName));
                    p('sys_id: ' + grSI.getUniqueValue());
                    p('API Name: ' + (grSI.getValue('api_name') || ''));
                    p('Scope: ' + (grSI.getDisplayValue('sys_scope') || 'Global'));
                    p('Active: ' + grSI.getValue('active'));
                    if (grSI.getValue('description')) p('Description: ' + grSI.getValue('description'));
                    p('\nSCRIPT:');
                    p(grSI.getValue('script'));
                    p('');
                } else {
                    p(subsection('Script Include: ' + siLookupName));
                    p('(not found in sys_script_include — may be a scoped app or platform class)');
                    p('');
                }
            }
        }
    }

    // ── Per-workflow summary ─────────────────────────────────

    var totalVars = 0;
    for (var k in valuesByActivity) {
        if (valuesByActivity.hasOwnProperty(k)) totalVars += valuesByActivity[k].length;
    }
    grandTotalVars += totalVars;

    var totalExec = 0;
    for (var ek in execByActivity) {
        if (execByActivity.hasOwnProperty(ek)) totalExec += execByActivity[ek].length;
    }
    grandTotalExec += totalExec;

    // ── 6. Recurse into sub-workflows ────────────────────────

    if (subWorkflows.length > 0) {
        p(section('SUB-WORKFLOWS FOUND: ' + subWorkflows.length + depthLabel));
        for (var si = 0; si < subWorkflows.length; si++) {
            var sub = subWorkflows[si];
            p('  ' + (si + 1) + '. Called by activity: ' + sub.parentActivityName);
            p('     wf_workflow sys_id: ' + sub.workflowSysId);

            // Find the published (or latest) wf_workflow_version for this wf_workflow
            var subWfvId = null;
            var grSubWfv = new GlideRecord('wf_workflow_version');
            grSubWfv.addQuery('workflow', sub.workflowSysId);
            grSubWfv.addQuery('published', true);
            grSubWfv.setLimit(1);
            grSubWfv.query();
            if (grSubWfv.next()) {
                subWfvId = grSubWfv.getUniqueValue();
            } else {
                // No published version — try latest checkout
                var grSubWfv2 = new GlideRecord('wf_workflow_version');
                grSubWfv2.addQuery('workflow', sub.workflowSysId);
                grSubWfv2.orderByDesc('sys_updated_on');
                grSubWfv2.setLimit(1);
                grSubWfv2.query();
                if (grSubWfv2.next()) {
                    subWfvId = grSubWfv2.getUniqueValue();
                    p('     (no published version found — using latest: ' + subWfvId + ')');
                }
            }

            if (subWfvId) {
                p('     workflow_version sys_id: ' + subWfvId);

                // In context mode, try to find a child wf_context for the sub-workflow
                var subContextId = null;
                if (targetContextId) {
                    var grSubCtx = new GlideRecord('wf_context');
                    grSubCtx.addQuery('workflow_version', subWfvId);
                    grSubCtx.addQuery('parent', targetContextId);
                    grSubCtx.orderByDesc('sys_created_on');
                    grSubCtx.setLimit(1);
                    grSubCtx.query();
                    if (grSubCtx.next()) {
                        subContextId = grSubCtx.getUniqueValue();
                        p('     wf_context (child): ' + subContextId);
                    }
                }

                subWorkflowCount++;
                p('\n' + ln('#', 80));
                p('EXTRACTING SUB-WORKFLOW ' + subWorkflowCount + ': ' + sub.parentActivityName);
                p(ln('#', 80));
                extractWorkflow(subWfvId, subContextId, depth + 1);
            } else {
                p('     WARNING: Could not find any wf_workflow_version for wf_workflow ' + sub.workflowSysId);
            }
        }
    }

    // ── 7. Extract Flow Designer flows called by this workflow ──

    if (flowDesignerRefs.length > 0) {
        p(section('FLOW DESIGNER FLOWS CALLED: ' + flowDesignerRefs.length + depthLabel));
        for (var fi = 0; fi < flowDesignerRefs.length; fi++) {
            var fRef = flowDesignerRefs[fi];
            p('  ' + (fi + 1) + '. Called by activity: ' + fRef.parentActivityName);
            p('     sys_hub_flow sys_id: ' + fRef.flowSysId);

            subWorkflowCount++;
            p('\n' + ln('#', 80));
            p('EXTRACTING FLOW DESIGNER FLOW ' + subWorkflowCount + ': ' + fRef.parentActivityName);
            p(ln('#', 80));
            extractFlowDesigner(fRef.flowSysId, depth + 1);
        }
    }

    }  // end extractWorkflow()

    // ── Extract the workflow / flow a catalog item is wired to ──
    //    Skipped automatically if the same workflow/flow was already
    //    extracted from an execution context (visited* guards).

    function extractCatalogItemAutomation(catRes) {
        if (!catRes) return;
        if (catRes.workflowId) {
            var catWfvId = '';
            var grCatWfv = new GlideRecord('wf_workflow_version');
            grCatWfv.addQuery('workflow', catRes.workflowId);
            grCatWfv.addQuery('published', true);
            grCatWfv.setLimit(1);
            grCatWfv.query();
            if (grCatWfv.next()) {
                catWfvId = grCatWfv.getUniqueValue();
            } else {
                var grCatWfv2 = new GlideRecord('wf_workflow_version');
                grCatWfv2.addQuery('workflow', catRes.workflowId);
                grCatWfv2.orderByDesc('sys_updated_on');
                grCatWfv2.setLimit(1);
                grCatWfv2.query();
                if (grCatWfv2.next()) catWfvId = grCatWfv2.getUniqueValue();
            }
            if (catWfvId && !visitedWorkflows[catWfvId]) {
                p('\n' + ln('#', 80));
                p('WORKFLOW DEFINITION FOR CATALOG ITEM');
                p(ln('#', 80));
                extractWorkflow(catWfvId, null, 0);
            }
        }
        if (catRes.flowId && !visitedFlows[catRes.flowId]) {
            p('\n' + ln('#', 80));
            p('FLOW DESIGNER FLOW FOR CATALOG ITEM');
            p(ln('#', 80));
            extractFlowDesigner(catRes.flowId, 0);
        }
        if (!catRes.workflowId && !catRes.flowId) {
            p('\n(No workflow or Flow Designer flow directly associated with this catalog item)');
            p('(The item may use an execution plan / delivery plan instead)');
        }
    }

    // ── Run the extraction ────────────────────────────────────

    if (mode === 'flow') {
        // Flow Designer flow extraction
        var ts = new GlideDateTime().toString();
        p(ln('=', 80));
        p('SERVICENOW FLOW DESIGNER EXPORT');
        p('Extracted: ' + ts);
        p('Detected type: Flow Designer flow (sys_hub_flow)');
        p('sys_hub_flow sys_id: ' + flowSysId);
        p(ln('=', 80));
        extractFlowDesigner(flowSysId, 0);
    } else if (mode === 'ritm') {
        // Extract catalog item definition for the RITM
        var ritmCatResult = null;
        var grRitmForCat = new GlideRecord('sc_req_item');
        if (grRitmForCat.get(grRitmRef.getUniqueValue())) {
            var ritmCatItemId = grRitmForCat.getValue('cat_item');
            if (ritmCatItemId) {
                ritmCatResult = extractCatalogItem(ritmCatItemId);
            }
        }

        // Extract business rules, notifications, email actions, and emails for RITM
        var grRitmForEmail = new GlideRecord('sc_req_item');
        if (grRitmForEmail.get(grRitmRef.getUniqueValue())) {
            var ritmSysIdForExtract = grRitmForEmail.getUniqueValue();
            extractBusinessRules('sc_req_item', ritmSysIdForExtract);
            extractInboundEmailActions('sc_req_item');
            var ritmMailScripts = extractNotifications('sc_req_item', ritmSysIdForExtract);
            extractEmailScripts('sc_req_item', ritmSysIdForExtract, ritmMailScripts);
            extractEmailAndNotificationAnalysis(ritmSysIdForExtract, 'sc_req_item', grRitmForEmail.getValue('number'));
        }

        // Extract each workflow context found for the RITM
        for (var rc = 0; rc < ritmContexts.length; rc++) {
            var rCtx = ritmContexts[rc];
            p('\n' + ln('#', 80));
            p('WORKFLOW CONTEXT ' + (rc + 1) + ' OF ' + ritmContexts.length + ' FOR RITM');
            p(ln('#', 80));
            extractWorkflow(rCtx.wfv, rCtx.contextId, 0);
        }
        // Extract Flow Designer flows triggered by this RITM
        if (ritmFlows && ritmFlows.length > 0) {
            // Deduplicate flow sys_ids
            var seenFlows = {};
            for (var rf = 0; rf < ritmFlows.length; rf++) {
                var rfId = ritmFlows[rf];
                if (seenFlows[rfId]) continue;
                seenFlows[rfId] = true;
                p('\n' + ln('#', 80));
                p('FLOW DESIGNER FLOW ' + (rf + 1) + ' OF ' + ritmFlows.length + ' FOR RITM');
                p(ln('#', 80));
                extractFlowDesigner(rfId, 0);
            }
        }
        // Catalog item's configured workflow/flow — covers items whose
        // automation never produced a runtime context for this RITM.
        extractCatalogItemAutomation(ritmCatResult);
    } else if (mode === 'incident') {
        // Extract business rules, notifications, email actions, and emails for Incident
        var grIncForEmail = new GlideRecord('incident');
        if (grIncForEmail.get(grIncRef.getUniqueValue())) {
            var incSysIdForExtract = grIncForEmail.getUniqueValue();
            extractBusinessRules(incTable, incSysIdForExtract);
            extractInboundEmailActions(incTable);
            var incMailScripts = extractNotifications(incTable, incSysIdForExtract);
            extractEmailScripts(incTable, incSysIdForExtract, incMailScripts);
            extractEmailAndNotificationAnalysis(incSysIdForExtract, incTable, grIncForEmail.getValue('number'));
        }

        // Extract each workflow context found for the Incident
        for (var ic = 0; ic < incContexts.length; ic++) {
            var iCtx = incContexts[ic];
            p('\n' + ln('#', 80));
            p('WORKFLOW CONTEXT ' + (ic + 1) + ' OF ' + incContexts.length + ' FOR INCIDENT');
            p(ln('#', 80));
            extractWorkflow(iCtx.wfv, iCtx.contextId, 0);
        }
    } else if (mode === 'catitem') {
        extractCatalogItemAutomation(catResult);
    } else {
        // Single workflow extraction (definition or context mode)
        extractWorkflow(wfv, contextId, 0);
    }

    // ── Grand summary ────────────────────────────────────────

    p(ln('=', 80));
    p('EXPORT COMPLETE');
    if (mode === 'flow') {
        p('Type: Flow Designer flow (sys_hub_flow)');
    } else if (mode === 'ritm') {
        var flowCount = (ritmFlows && ritmFlows.length) || 0;
        p('Type: RITM (sc_req_item) with ' + ritmContexts.length + ' workflow context(s)' +
          (flowCount > 0 ? ' and ' + flowCount + ' Flow Designer flow(s)' : ''));
        p('Included analysis: Catalog Item (variables, variable sets, UI policies, client scripts, user criteria, execution plan, workflow/flow), Business Rules, Inbound Email Actions, Notifications, Email Scripts, Email Correlation');
    } else if (mode === 'incident') {
        p('Type: Incident with ' + incContexts.length + ' workflow context(s)');
        p('Included analysis: Business Rules, Inbound Email Actions, Notifications, Email Scripts, Email Correlation');
    } else if (mode === 'catitem') {
        p('Type: Catalog Item (sc_cat_item)');
        p('Included analysis: Variables, Variable Sets, UI Policies, Client Scripts, UI Actions, Record Producer, User Criteria, Execution Plan, Workflow/Flow');
    } else {
        p('Type: ' + (mode === 'context' ? 'Executed workflow (wf_context)' : 'Workflow definition (wf_workflow_version)'));
    }
    if (mode !== 'flow') p('Total activities: ' + grandTotalActivities);
    if (mode !== 'flow') p('Total variable values extracted: ' + grandTotalVars);
    if (subWorkflowCount > 0) p('Sub-workflows/flows extracted: ' + subWorkflowCount);
    if (contextId || mode === 'ritm' || mode === 'incident') p('Total execution entries: ' + grandTotalExec);
    p(ln('=', 80));

})(SYS_ID);
