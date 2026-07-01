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
 *
 * SOURCE: Activity config is stored in sys_variable_value (EAV pattern),
 *         not on wf_activity fields directly.
 *         Flow Designer config is in sys_hub_* tables.
 */

// ╔══════════════════════════════════════════════════════════╗
// ║  SET THIS TO YOUR SYS_ID or RITM NUMBER                 ║
// ║  (auto-detects the type)                                 ║
// ╚══════════════════════════════════════════════════════════╝
var SYS_ID = 'PUT_YOUR_SYS_ID_HERE';

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
        p('Assigned to: ' + (grRitm.getDisplayValue('assigned_to') || '(unassigned)'));
        p('Assignment group: ' + (grRitm.getDisplayValue('assignment_group') || ''));
        p('Opened by: ' + (grRitm.getDisplayValue('opened_by') || ''));
        p('Opened at: ' + (grRitm.getDisplayValue('opened_at') || ''));
        p('Request: ' + (grRitm.getDisplayValue('request') || ''));
        p('Cat item: ' + (grRitm.getDisplayValue('cat_item') || ''));
        if (grRitm.getValue('closed_at')) p('Closed at: ' + grRitm.getDisplayValue('closed_at'));
        if (grRitm.getValue('closed_by')) p('Closed by: ' + grRitm.getDisplayValue('closed_by'));
        if (grRitm.getValue('close_notes')) p('Close notes: ' + grRitm.getValue('close_notes'));
        if (grRitm.getValue('description')) {
            p('\nDESCRIPTION:');
            p(grRitm.getValue('description'));
        }
        if (grRitm.getValue('comments')) {
            p('\nADDITIONAL COMMENTS:');
            p(grRitm.getValue('comments'));
        }

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
                var itemOptName = grOptVal.getDisplayValue('item_option_new') || grOptVal.getValue('item_option_new') || '(unknown)';
                var itemOptVal = grOptVal.getValue('value') || '';
                p('  ' + itemOptName + ': ' + itemOptVal);
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

            // Catalog Task variables
            var grTaskOpt = new GlideRecord('sc_item_option_mtom');
            grTaskOpt.addQuery('request_item', ritmSysId);
            grTaskOpt.query();
            var taskVarFound = false;
            while (grTaskOpt.next()) {
                var taskOptRef = grTaskOpt.getValue('sc_item_option');
                if (!taskOptRef) continue;
                var grTaskOptVal = new GlideRecord('sc_item_option');
                if (grTaskOptVal.get(taskOptRef)) {
                    if (!taskVarFound) {
                        p('  Variables:');
                        taskVarFound = true;
                    }
                    var tOptName = grTaskOptVal.getDisplayValue('item_option_new') || grTaskOptVal.getValue('item_option_new') || '(unknown)';
                    var tOptVal = grTaskOptVal.getValue('value') || '';
                    p('    ' + tOptName + ': ' + tOptVal);
                }
            }
            p('');
            taskCount++;
        }
        if (taskCount === 0) p('  (no catalog tasks found)');

        // ── Emails / Notifications sent ──────────────────────────
        p(subsection('EMAILS / NOTIFICATIONS'));
        var grEmail = new GlideRecord('sys_email');
        grEmail.addQuery('instance', ritmSysId);
        grEmail.orderBy('sys_created_on');
        grEmail.query();
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
            grEmail2.query();
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
        if (ritmFlows.length === 0) {
            p('  (no Flow Designer runs found for this RITM)');
        }

        return { contexts: contexts, flows: ritmFlows };
    }

    // ── Helper: Extract Business Rules for a table ───────────
    function extractBusinessRules(tableName, recordSysId) {
        p(subsection('BUSINESS RULES FOR TABLE: ' + tableName));
        var grBr = new GlideRecord('sys_business_rule');
        grBr.addQuery('table', tableName);
        grBr.addQuery('active', true);
        grBr.orderBy('name');
        grBr.query();

        var brCount = 0;
        while (grBr.next()) {
            brCount++;
            var brName = grBr.getValue('name');
            var brWhen = grBr.getDisplayValue('when') || grBr.getValue('when') || '';
            var brCondition = grBr.getValue('condition') || '';
            var brPriority = grBr.getValue('priority') || '100';

            p('  ' + brCount + '. ' + brName);
            p('     When: ' + brWhen);
            p('     Priority: ' + brPriority);
            if (brCondition) p('     Condition: ' + brCondition);

            // Extract the script
            var brScript = grBr.getValue('script') || '';
            if (brScript) {
                p('     ---- SCRIPT START ----');
                p(brScript);
                p('     ---- SCRIPT END ----');
            }
            p('');
        }

        if (brCount === 0) p('  (no active business rules found for this table)');
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
    //    In ServiceNow, email notifications are stored in sysevent_email_action.
    //    The table they apply to is in the 'collection' field.
    function extractNotifications(tableName) {
        p(subsection('NOTIFICATION DEFINITIONS FOR TABLE: ' + tableName));
        var grNotif = new GlideRecord('sysevent_email_action');
        grNotif.addQuery('collection', tableName);
        grNotif.addQuery('active', true);
        grNotif.orderBy('name');
        grNotif.query();

        var notifCount = 0;
        while (grNotif.next()) {
            notifCount++;
            var notifName = grNotif.getValue('name');
            var notifEvent = grNotif.getValue('event_name') || '';
            var notifCondition = grNotif.getValue('condition') || '';
            var notifRecipients = grNotif.getValue('recipient_fields') || '';
            var notifSubject = grNotif.getValue('subject') || '';
            var notifWeight = grNotif.getValue('weight') || '';

            p('  ' + notifCount + '. ' + notifName);
            p('     sys_id: ' + grNotif.getUniqueValue());
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

        if (notifCount === 0) p('  (no notification definitions found for this table)');
        p('');
    }

    // ── Helper: Extract Email Scripts ────────────────────────
    //    sys_email_script records are not tied to a specific table;
    //    they are reusable template includes. We extract all active ones
    //    so the AI can cross-reference them with notification messages.
    function extractEmailScripts(tableName, recordSysId) {
        p(subsection('EMAIL SCRIPTS (sys_email_script)'));
        var grEmailScript = new GlideRecord('sys_email_script');
        grEmailScript.addQuery('active', true);
        grEmailScript.orderBy('name');
        grEmailScript.setLimit(50);  // Limit to avoid excessive output
        grEmailScript.query();

        var scriptCount = 0;
        while (grEmailScript.next()) {
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
        grEmail.query();

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
        p('Priority: ' + grInc.getDisplayValue('priority'));
        p('Urgency: ' + grInc.getDisplayValue('urgency'));
        p('Impact: ' + grInc.getDisplayValue('impact'));
        p('Caller: ' + (grInc.getDisplayValue('caller_id') || '(unknown)'));
        p('Assigned to: ' + (grInc.getDisplayValue('assigned_to') || '(unassigned)'));
        p('Assignment group: ' + (grInc.getDisplayValue('assignment_group') || ''));
        p('Category: ' + (grInc.getDisplayValue('category') || ''));
        p('Subcategory: ' + (grInc.getDisplayValue('subcategory') || ''));
        if (grInc.getValue('opened_at')) p('Opened: ' + grInc.getDisplayValue('opened_at'));
        if (grInc.getValue('resolved_at')) p('Resolved: ' + grInc.getDisplayValue('resolved_at'));
        if (grInc.getValue('closed_at')) p('Closed: ' + grInc.getDisplayValue('closed_at'));
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
        grChg.addQuery('problem.incident.number', incNumber);
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
    //    then Flow Designer flow, then wf_context, then
    //    wf_workflow_version, then document record.

    var mode;          // 'definition', 'context', 'ritm', 'incident', or 'flow'
    var wfv;           // workflow_version sys_id — used for the rest of the script
    var contextId;     // wf_context sys_id (only when mode=context)
    var contextData;   // execution metadata object (only when mode=context)
    var ritmContexts;  // array of {contextId, wfv} from RITM (only when mode=ritm)
    var incContexts;   // array of {contextId, wfv} from Incident (only when mode=incident)
    var incTable;      // the incident table name (usually 'incident')
    var flowSysId;     // sys_hub_flow sys_id (only when mode=flow)

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
            p(ln('=', 80));
            p('EXPORT COMPLETE — no workflow contexts or Flow Designer flows found for this RITM.');
            p(ln('=', 80));
            return;
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

    // For non-RITM, non-incident, non-flow modes, print the header here
    if (mode !== 'ritm' && mode !== 'incident' && mode !== 'flow') {
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

        // ── Flow Trigger ─────────────────────────────────────────
        p(subsection('TRIGGER'));
        var grTrigger = new GlideRecord('sys_hub_trigger_instance');
        grTrigger.addQuery('flow', targetFlowSysId);
        grTrigger.query();
        var triggerCount = 0;
        while (grTrigger.next()) {
            triggerCount++;
            p('  Trigger ' + triggerCount + ':');
            p('    Type: ' + (grTrigger.getDisplayValue('type') || grTrigger.getValue('type') || ''));
            p('    Name: ' + (grTrigger.getValue('name') || ''));
            p('    sys_id: ' + grTrigger.getUniqueValue());
            if (grTrigger.getValue('table')) p('    Table: ' + grTrigger.getDisplayValue('table'));
            if (grTrigger.getValue('condition')) p('    Condition: ' + grTrigger.getValue('condition'));
            if (grTrigger.getValue('when_to_run')) p('    When to run: ' + grTrigger.getDisplayValue('when_to_run'));
            if (grTrigger.getValue('schedule')) p('    Schedule: ' + grTrigger.getDisplayValue('schedule'));

            // Trigger inputs/configuration
            var grTrigInputs = new GlideRecord('sys_hub_trigger_instance_input');
            if (grTrigInputs.isValid()) {
                grTrigInputs.addQuery('trigger_instance', grTrigger.getUniqueValue());
                grTrigInputs.query();
                while (grTrigInputs.next()) {
                    p('    Input: ' + (grTrigInputs.getValue('name') || '') + ' = ' +
                      (grTrigInputs.getValue('value') || grTrigInputs.getDisplayValue('value') || ''));
                }
            }
            p('');
        }
        if (triggerCount === 0) p('  (no trigger found — may be a subflow or action)');

        // ── Flow Inputs ──────────────────────────────────────────
        p(subsection('FLOW INPUTS'));
        var grFlowInput = new GlideRecord('sys_hub_flow_input');
        if (grFlowInput.isValid()) {
            grFlowInput.addQuery('flow', targetFlowSysId);
            grFlowInput.orderBy('order');
            grFlowInput.query();
            var inputCount = 0;
            while (grFlowInput.next()) {
                inputCount++;
                p('  ' + inputCount + '. ' + (grFlowInput.getValue('name') || grFlowInput.getValue('label') || '(unnamed)'));
                if (grFlowInput.getValue('label')) p('     Label: ' + grFlowInput.getValue('label'));
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
            grFlowOutput.addQuery('flow', targetFlowSysId);
            grFlowOutput.orderBy('order');
            grFlowOutput.query();
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
        //    Actions/steps are stored in sys_hub_action_instance
        p(subsection('FLOW ACTIONS / STEPS'));
        var grActions = new GlideRecord('sys_hub_action_instance');
        grActions.addQuery('flow', targetFlowSysId);
        grActions.orderBy('order');
        grActions.query();

        var actionList = [];
        var subFlowRefs = [];  // collect sub-flow references for recursion
        var actionCount = 0;

        while (grActions.next()) {
            actionCount++;
            var actionSysId = grActions.getUniqueValue();
            var actionName = grActions.getValue('name') || '(unnamed)';
            var actionType = grActions.getDisplayValue('action_type') || grActions.getValue('action_type') || '';
            var actionTypeSysId = grActions.getValue('action_type') || '';
            var nesting = grActions.getValue('nesting_level') || '0';
            var parentAction = grActions.getValue('parent') || '';

            p('  ' + actionCount + '. [' + actionType + '] ' + actionName);
            p('     sys_id: ' + actionSysId);
            p('     Order: ' + (grActions.getValue('order') || ''));
            if (nesting !== '0') p('     Nesting level: ' + nesting);
            if (parentAction) p('     Parent: ' + grActions.getDisplayValue('parent'));

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
            grSubFlowInst.addQuery('flow', targetFlowSysId);
            grSubFlowInst.query();
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

        // ── Flow Logic / Conditions (sys_hub_flow_logic) ─────────
        var grLogic = new GlideRecord('sys_hub_flow_logic');
        if (grLogic.isValid()) {
            grLogic.addQuery('flow', targetFlowSysId);
            grLogic.orderBy('order');
            grLogic.query();
            var logicCount = 0;
            while (grLogic.next()) {
                if (logicCount === 0) p(subsection('FLOW LOGIC / CONDITIONS'));
                logicCount++;
                p('  ' + logicCount + '. Type: ' + (grLogic.getDisplayValue('type') || grLogic.getValue('type') || ''));
                p('     Name: ' + (grLogic.getValue('name') || ''));
                if (grLogic.getValue('condition')) p('     Condition: ' + grLogic.getValue('condition'));
                if (grLogic.getValue('script')) {
                    p('     SCRIPT:');
                    p('     ---- SCRIPT START ----');
                    p(grLogic.getValue('script'));
                    p('     ---- SCRIPT END ----');
                }
                p('');
            }
        }

        // ── Flow Variables (sys_hub_flow_variable) ───────────────
        var grFlowVar = new GlideRecord('sys_hub_flow_variable');
        if (grFlowVar.isValid()) {
            grFlowVar.addQuery('flow', targetFlowSysId);
            grFlowVar.query();
            var varCount = 0;
            while (grFlowVar.next()) {
                if (varCount === 0) p(subsection('FLOW VARIABLES'));
                varCount++;
                p('  ' + varCount + '. ' + (grFlowVar.getValue('name') || '(unnamed)'));
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

    p(section('ACTIVITY DETAILS' + depthLabel));

    var subWorkflows = [];  // collect sub-workflow references for recursive extraction
    var flowDesignerRefs = [];  // collect Flow Designer flow references from workflow activities

    for (var di = 0; di < actList.length; di++) {
        var info = actList[di];
        p(subsection(info.name + '  [' + info.type + ']'));
        p('sys_id: ' + info.sys_id);
        p('Position: x=' + info.x + ', y=' + info.y);
        if (info.stage) p('Stage: ' + info.stage);

        // Execution history (context mode only)
        var execEntries = execByActivity[info.sys_id];
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
        } else if (targetContextId) {
            p('\nEXECUTION: (not reached)');
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
        // Extract business rules, notifications, email actions, and emails for RITM
        var grRitmForEmail = new GlideRecord('sc_req_item');
        if (grRitmForEmail.get(grRitmRef.getUniqueValue())) {
            extractBusinessRules('sc_req_item', grRitmForEmail.getUniqueValue());
            extractInboundEmailActions('sc_req_item');
            extractNotifications('sc_req_item');
            extractEmailScripts('sc_req_item', grRitmForEmail.getUniqueValue());
            extractEmailAndNotificationAnalysis(grRitmForEmail.getUniqueValue(), 'sc_req_item', grRitmForEmail.getValue('number'));
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
    } else if (mode === 'incident') {
        // Extract business rules, notifications, email actions, and emails for Incident
        var grIncForEmail = new GlideRecord('incident');
        if (grIncForEmail.get(grIncRef.getUniqueValue())) {
            extractBusinessRules(incTable, grIncForEmail.getUniqueValue());
            extractInboundEmailActions(incTable);
            extractNotifications(incTable);
            extractEmailScripts(incTable, grIncForEmail.getUniqueValue());
            extractEmailAndNotificationAnalysis(grIncForEmail.getUniqueValue(), incTable, grIncForEmail.getValue('number'));
        }

        // Extract each workflow context found for the Incident
        for (var ic = 0; ic < incContexts.length; ic++) {
            var iCtx = incContexts[ic];
            p('\n' + ln('#', 80));
            p('WORKFLOW CONTEXT ' + (ic + 1) + ' OF ' + incContexts.length + ' FOR INCIDENT');
            p(ln('#', 80));
            extractWorkflow(iCtx.wfv, iCtx.contextId, 0);
        }
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
        p('Included analysis: Business Rules, Inbound Email Actions, Notifications, Email Scripts, Email Correlation');
    } else if (mode === 'incident') {
        p('Type: Incident with ' + incContexts.length + ' workflow context(s)');
        p('Included analysis: Business Rules, Inbound Email Actions, Notifications, Email Scripts, Email Correlation');
    } else {
        p('Type: ' + (mode === 'context' ? 'Executed workflow (wf_context)' : 'Workflow definition (wf_workflow_version)'));
    }
    if (mode !== 'flow') p('Total activities: ' + grandTotalActivities);
    if (mode !== 'flow') p('Total variable values extracted: ' + grandTotalVars);
    if (subWorkflowCount > 0) p('Sub-workflows/flows extracted: ' + subWorkflowCount);
    if (contextId || mode === 'ritm' || mode === 'incident') p('Total execution entries: ' + grandTotalExec);
    p(ln('=', 80));

})(SYS_ID);
