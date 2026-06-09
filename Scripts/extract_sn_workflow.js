/**
 * ServiceNow Workflow Extractor — Background Script
 * ===================================================
 * Extracts a complete workflow definition into readable text.
 * Supports both workflow DEFINITIONS and executed workflow CONTEXTS.
 * Auto-detects which type of sys_id you provide.
 *
 * HOW TO USE:
 *   1. Set SYS_ID below to any of:
 *      - a workflow_version sys_id  (from URL: workflow_ide.do?sysparm_wf_version=<THIS>)
 *      - a wf_context sys_id        (from URL: workflow_ide.do?sysparm_context=<THIS>)
 *      - a record sys_id            (from URL: context_workflow.do?sysparm_document=<THIS>)
 *      - a RITM number              (e.g. RITM0043257)
 *      - a RITM sys_id              (sc_req_item record)
 *      The script will auto-detect which one it is.
 *   2. Paste this entire script into Scripts - Background (/sys.scripts.do)
 *   3. Click "Run script"
 *   4. Select All output → Copy → Save to a .txt file
 *
 * EXTRACTS: metadata, activities, transitions, scripts, conditions,
 *           Set Values mappings, orchestration inputs, timer config,
 *           Create Task config, and all other activity configuration.
 *           For executed workflows: execution state, timing, activity
 *           results, faults, scratchpad, and the triggering record.
 *           Sub-workflows called by "Workflow" activities are extracted
 *           recursively (up to 10 levels deep).
 *           For RITMs: record details, variables, activity log / journal,
 *           approval history, and all associated workflow contexts.
 *
 * SOURCE: Activity config is stored in sys_variable_value (EAV pattern),
 *         not on wf_activity fields directly.
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

        return contexts;
    }

    // ── Auto-detect sys_id type ──────────────────────────────
    //    Try RITM number/sys_id first, then wf_context,
    //    then wf_workflow_version, then document record.

    var mode;          // 'definition', 'context', or 'ritm'
    var wfv;           // workflow_version sys_id — used for the rest of the script
    var contextId;     // wf_context sys_id (only when mode=context)
    var contextData;   // execution metadata object (only when mode=context)
    var ritmContexts;  // array of {contextId, wfv} from RITM (only when mode=ritm)

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

        ritmContexts = extractRITM(grRitmRef);

        if (ritmContexts.length === 0) {
            p(ln('=', 80));
            p('EXPORT COMPLETE — no workflow contexts found for this RITM.');
            p(ln('=', 80));
            return;
        }

        // Set up for multi-context extraction below
        // We'll iterate through all contexts after the function definition
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
                p('  or as a document record in wf_context.');
                p('  Also not found as a RITM number or sc_req_item sys_id.');
                p('  Make sure you copied the correct sys_id from the URL.');
                return;
            }
        }
    }
    }  // end if (!mode) — wf_context branch

    // For non-RITM modes, print the header here
    if (mode !== 'ritm') {
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

    // ── Recursive workflow extraction function ───────────────
    //    Extracts a single workflow version and recurses into
    //    any sub-workflows found in "Workflow" activities.

    var MAX_DEPTH = 10;
    var visitedWorkflows = {};  // track visited wfv sys_ids to prevent loops
    var grandTotalActivities = 0;
    var grandTotalVars = 0;
    var grandTotalExec = 0;
    var subWorkflowCount = 0;

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

    // ── 5. Activity details ──────────────────────────────────

    p(section('ACTIVITY DETAILS' + depthLabel));

    var subWorkflows = [];  // collect sub-workflow references for recursive extraction

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
            }
        } else {
            if (!info.input || info.input === '{}') {
                p('\n(no configuration found)');
            }
        }

        p('');
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

    }  // end extractWorkflow()

    // ── Run the extraction ────────────────────────────────────

    if (mode === 'ritm') {
        // Extract each workflow context found for the RITM
        for (var rc = 0; rc < ritmContexts.length; rc++) {
            var rCtx = ritmContexts[rc];
            p('\n' + ln('#', 80));
            p('WORKFLOW CONTEXT ' + (rc + 1) + ' OF ' + ritmContexts.length + ' FOR RITM');
            p(ln('#', 80));
            extractWorkflow(rCtx.wfv, rCtx.contextId, 0);
        }
    } else {
        // Single workflow extraction (definition or context mode)
        extractWorkflow(wfv, contextId, 0);
    }

    // ── Grand summary ────────────────────────────────────────

    p(ln('=', 80));
    p('EXPORT COMPLETE');
    if (mode === 'ritm') {
        p('Type: RITM (sc_req_item) with ' + ritmContexts.length + ' workflow context(s)');
    } else {
        p('Type: ' + (mode === 'context' ? 'Executed workflow (wf_context)' : 'Workflow definition (wf_workflow_version)'));
    }
    p('Total activities: ' + grandTotalActivities);
    p('Total variable values extracted: ' + grandTotalVars);
    if (subWorkflowCount > 0) p('Sub-workflows extracted: ' + subWorkflowCount);
    if (contextId || mode === 'ritm') p('Total execution entries: ' + grandTotalExec);
    p(ln('=', 80));

})(SYS_ID);
