// ╔══════════════════════════════════════════════════════════╗
// ║  SET THE TABLE (and optionally ONE RECORD) TO EXTRACT    ║
// ╚══════════════════════════════════════════════════════════╝
var TABLE  = 'pm_project_task';   // any table, e.g. pm_project_task, pm_project, task
var RECORD = '';                  // optional: sys_id or number (e.g. PRJTASK0010042) — '' = table config only

// ── Output toggles (turn sections off to shrink huge exports) ──
var OPT = {
    inherited:        true,   // include artifacts inherited from parent tables (task, etc.)
    scriptBodies:     true,   // print full script source (false = metadata only)
    inactive:         false,  // include inactive records
    dictionary:       true,
    dictOverrides:    true,
    choices:          true,
    businessRules:    true,
    clientScripts:    true,
    uiPolicies:       true,
    dataPolicies:     true,
    uiActions:        true,
    acls:             true,
    aclScripts:       true,   // ACLs are numerous — set false to skip their scripts/conditions
    notifications:    true,
    inboundEmail:     true,
    styles:           true,
    viewRules:        true,
    formLayout:       true,
    listLayout:       true,
    relatedLists:     true,
    relationships:    true,
    workflows:        true,
    flows:            true,
    slas:             true,
    metrics:          true,
    assignmentRules:  true,
    scheduledJobs:    true,
    events:           true,
    numbering:        true,
    transformMaps:    true,
    modules:          true,
    scriptIncludes:   true    // Script Includes referenced by the above scripts
};

/**
 * ServiceNow Table Configuration Extractor — Background Script
 * ===========================================================
 * Dumps EVERYTHING configured on a table (and its parent tables), so an
 * AI or a human can reason about the full behaviour of records on it.
 *
 * Built for task-derived tables such as pm_project_task, but works on any table.
 *
 * HOW TO USE:
 *   1. Set TABLE above (e.g. 'pm_project_task').
 *      Optionally set RECORD to a sys_id or number to also dump one record
 *      (fields, journal, audit history, approvals, children, attachments,
 *       emails, workflow contexts, flow runs).
 *   2. Paste into Scripts - Background (/sys.scripts.do) and Run script.
 *   3. Select All output → Copy → save as .txt
 *
 * EXTRACTS (per table in the inheritance chain):
 *   Table metadata & hierarchy, Dictionary Entries, Dictionary Entry Overrides,
 *   Choices, Business Rules, Client Scripts, UI Policies (+ actions),
 *   Data Policies (+ rules), UI Actions, Access Controls (+ roles),
 *   Notifications, Inbound Email Actions, Styles, View Rules,
 *   Form Layout (sections/elements), List Layout, Related Lists,
 *   Relationships, Workflows, Flow Designer flows, SLAs, Metrics,
 *   Assignment/Escalation rules, Scheduled Jobs, Registered Events,
 *   Number maintenance, Transform Maps, Modules, and referenced Script Includes.
 *
 * NOTE: getValue() on boolean fields returns '1'/'0' in some scopes and
 *       'true'/'false' in others — always compare via isTrue().
 */

(function (tableName, recordKey, opt) {

    // ── Helpers ──────────────────────────────────────────────

    function ln(ch, len) {
        var s = '';
        for (var i = 0; i < len; i++) s += ch;
        return s;
    }
    function p(text) { gs.print(text); }
    function section(title) {
        return '\n' + ln('=', 80) + '\n' + title + '\n' + ln('=', 80);
    }
    function subsection(title) {
        return '\n' + ln('-', 60) + '\n' + title + '\n' + ln('-', 60);
    }
    function isTrue(gr, field) {
        var v = gr.getValue(field);
        return v === 'true' || v === '1';
    }
    function val(gr, field) {
        return gr.getValue(field) || '';
    }
    function disp(gr, field) {
        return gr.getDisplayValue(field) || '';
    }
    function line(label, value) {
        if (value !== '' && value !== null && value !== undefined) p('     ' + label + ': ' + value);
    }
    function script(label, body, indent) {
        if (!body) return;
        var pad = indent || '     ';
        if (!opt.scriptBodies) {
            p(pad + label + ': (' + body.length + ' chars — scriptBodies=false)');
            return;
        }
        p(pad + label + ':');
        p(pad + '---- SCRIPT START ----');
        p(body);
        p(pad + '---- SCRIPT END ----');
    }
    // sys_email is partitioned; queries leak slow-query SQL into gs.print
    var _savedDebug;
    function suppressDebug() {
        try { var s = GlideSession.get(); _savedDebug = s.isDebug(); s.setDebug(false); } catch (e) {}
    }
    function restoreDebug() {
        try { if (_savedDebug) GlideSession.get().setDebug(true); } catch (e) {}
    }

    var scriptCorpus = [];   // every script body seen, for Script Include discovery
    function collect(body) {
        if (body) scriptCorpus.push(body);
    }

    // Query helper: returns a queried GlideRecord, or null when the table
    // or the field does not exist on this instance.
    function q(tbl, field, values, orderBy) {
        var gr = new GlideRecord(tbl);
        if (!gr.isValid()) return null;
        if (field) {
            try {
                if (!gr.isValidField(field)) return null;
            } catch (e) { return null; }
            if (values instanceof Array) {
                gr.addQuery(field, 'IN', values.join(','));
            } else {
                gr.addQuery(field, values);
            }
        }
        if (!opt.inactive && gr.isValidField('active')) gr.addQuery('active', true);
        if (orderBy) gr.orderBy(orderBy);
        gr.query();
        return gr;
    }
    function missing(tbl) {
        p('  (table ' + tbl + ' not available on this instance)');
    }

    // ── Validate & build the table hierarchy ─────────────────

    if (!tableName) {
        p('ERROR: Set TABLE at the top of the script.');
        return;
    }
    var grProbe = new GlideRecord(tableName);
    if (!grProbe.isValid()) {
        p('ERROR: table "' + tableName + '" does not exist (or is not readable).');
        return;
    }

    // Walk sys_db_object.super_class upwards
    var hierarchy = [];          // [pm_project_task, planned_task, task, ...]
    var tableMeta = {};          // name -> {label, super, extensible, ...}
    (function () {
        var cur = tableName;
        for (var i = 0; i < 15 && cur; i++) {
            hierarchy.push(cur);
            var grObj = new GlideRecord('sys_db_object');
            grObj.addQuery('name', cur);
            grObj.setLimit(1);
            grObj.query();
            if (!grObj.next()) break;
            tableMeta[cur] = {
                label:      val(grObj, 'label'),
                sysId:      grObj.getUniqueValue(),
                extensible: isTrue(grObj, 'is_extendable'),
                scope:      disp(grObj, 'sys_scope'),
                superLabel: disp(grObj, 'super_class'),
                createAccess: val(grObj, 'create_access'),
                accessible: val(grObj, 'access')
            };
            var sup = grObj.super_class.name + '';
            cur = (!sup || sup === 'undefined' || sup === 'null') ? '' : sup;
            if (!opt.inherited) break;
        }
    })();

    // Child tables (things that extend this table)
    var childTables = [];
    (function () {
        if (!tableMeta[tableName] || !tableMeta[tableName].sysId) return;
        var grChild = new GlideRecord('sys_db_object');
        grChild.addQuery('super_class', tableMeta[tableName].sysId);
        grChild.orderBy('name');
        grChild.query();
        while (grChild.next()) childTables.push(val(grChild, 'name') + ' (' + val(grChild, 'label') + ')');
    })();

    // ── Header ───────────────────────────────────────────────

    p(ln('=', 80));
    p('SERVICENOW TABLE CONFIGURATION EXPORT');
    p('Extracted: ' + new GlideDateTime().toString());
    p('Table: ' + tableName + (tableMeta[tableName] ? ' (' + tableMeta[tableName].label + ')' : ''));
    p('Instance: ' + gs.getProperty('instance_name'));
    p('Include inherited artifacts: ' + opt.inherited);
    p('Include inactive records: ' + opt.inactive);
    p('Script bodies: ' + opt.scriptBodies);
    p(ln('=', 80));

    p(section('TABLE HIERARCHY'));
    for (var hi = 0; hi < hierarchy.length; hi++) {
        var t = hierarchy[hi];
        var m = tableMeta[t] || {};
        p('  ' + ln(' ', hi * 2) + (hi === 0 ? '> ' : '^ ') + t + '  [' + (m.label || '') + ']');
        if (m.scope) p('  ' + ln(' ', hi * 2) + '  scope: ' + m.scope + ', extensible: ' + m.extensible);
    }
    if (childTables.length > 0) {
        p('\n  Tables extending ' + tableName + ':');
        for (var ci = 0; ci < childTables.length; ci++) p('    - ' + childTables[ci]);
    }

    // ── 1. Dictionary Entries ────────────────────────────────

    if (opt.dictionary) {
        p(section('DICTIONARY ENTRIES'));
        var dictCount = 0;
        for (var dti = 0; dti < hierarchy.length; dti++) {
            var dTable = hierarchy[dti];
            var grDict = new GlideRecord('sys_dictionary');
            grDict.addQuery('name', dTable);
            grDict.addNotNullQuery('element');
            grDict.orderBy('element');
            grDict.query();
            var tableFieldCount = 0;
            while (grDict.next()) {
                if (tableFieldCount === 0) p(subsection('FIELDS DEFINED ON: ' + dTable));
                tableFieldCount++;
                dictCount++;
                var el = val(grDict, 'element');
                p('  ' + tableFieldCount + '. ' + el + '  [' + val(grDict, 'internal_type') + ']');
                line('Label', val(grDict, 'column_label'));
                line('Max length', val(grDict, 'max_length'));
                if (val(grDict, 'reference')) line('Reference', val(grDict, 'reference'));
                if (val(grDict, 'reference_qual')) line('Reference qualifier', val(grDict, 'reference_qual'));
                if (val(grDict, 'reference_qual_condition')) line('Reference qual condition', val(grDict, 'reference_qual_condition'));
                if (isTrue(grDict, 'mandatory')) line('Mandatory', 'true');
                if (isTrue(grDict, 'read_only')) line('Read only', 'true');
                if (isTrue(grDict, 'display')) line('Display field', 'true');
                if (isTrue(grDict, 'unique')) line('Unique', 'true');
                if (isTrue(grDict, 'audit')) line('Audit', 'true');
                if (isTrue(grDict, 'text_index')) line('Text index', 'true');
                if (isTrue(grDict, 'active') === false) line('Active', 'false');
                if (val(grDict, 'default_value')) line('Default', val(grDict, 'default_value'));
                if (val(grDict, 'dependent')) line('Dependent on', val(grDict, 'dependent'));
                if (val(grDict, 'dependent_on_field')) line('Dependent on field', val(grDict, 'dependent_on_field'));
                if (val(grDict, 'choice')) line('Choice', disp(grDict, 'choice'));
                if (val(grDict, 'choice_field')) line('Choice field', val(grDict, 'choice_field'));
                if (val(grDict, 'choice_table')) line('Choice table', val(grDict, 'choice_table'));
                if (val(grDict, 'attributes')) line('Attributes', val(grDict, 'attributes'));
                if (val(grDict, 'dynamic_default_value')) line('Dynamic default', disp(grDict, 'dynamic_default_value'));
                if (val(grDict, 'dynamic_ref_qual')) line('Dynamic ref qual', disp(grDict, 'dynamic_ref_qual'));
                if (isTrue(grDict, 'virtual')) line('Virtual/calculated', 'true');
                if (val(grDict, 'calculation')) {
                    collect(val(grDict, 'calculation'));
                    script('Calculation', val(grDict, 'calculation'));
                }
                if (val(grDict, 'function_definition')) line('Function definition', val(grDict, 'function_definition'));
                if (val(grDict, 'sys_scope')) line('Scope', disp(grDict, 'sys_scope'));
            }
        }
        p('\n  TOTAL DICTIONARY ENTRIES: ' + dictCount);
    }

    // ── 2. Dictionary Entry Overrides ────────────────────────

    if (opt.dictOverrides) {
        p(section('DICTIONARY ENTRY OVERRIDES'));
        var grOvr = new GlideRecord('sys_dictionary_override');
        if (!grOvr.isValid()) {
            missing('sys_dictionary_override');
        } else {
            grOvr.addQuery('name', 'IN', hierarchy.join(','));
            grOvr.orderBy('name');
            grOvr.orderBy('element');
            grOvr.query();
            var ovrCount = 0;
            while (grOvr.next()) {
                ovrCount++;
                p('  ' + ovrCount + '. ' + val(grOvr, 'name') + '.' + disp(grOvr, 'element'));
                line('Base table', disp(grOvr, 'base_table'));
                if (isTrue(grOvr, 'override_mandatory')) line('Overrides mandatory', val(grOvr, 'mandatory'));
                if (isTrue(grOvr, 'override_read_only')) line('Overrides read only', val(grOvr, 'read_only'));
                if (isTrue(grOvr, 'override_default_value')) line('Overrides default', val(grOvr, 'default_value'));
                if (isTrue(grOvr, 'override_reference_qual')) line('Overrides ref qual', val(grOvr, 'reference_qual'));
                if (isTrue(grOvr, 'override_attributes')) line('Overrides attributes', val(grOvr, 'attributes'));
                if (isTrue(grOvr, 'override_calculation')) {
                    collect(val(grOvr, 'calculation'));
                    script('Overrides calculation', val(grOvr, 'calculation'));
                }
                if (isTrue(grOvr, 'override_display')) line('Overrides display', val(grOvr, 'display'));
                if (isTrue(grOvr, 'override_dynamic_creation')) line('Overrides dynamic creation', val(grOvr, 'dynamic_creation'));
            }
            if (ovrCount === 0) p('  (none)');
            else p('\n  TOTAL: ' + ovrCount);
        }
    }

    // ── 3. Choices ───────────────────────────────────────────

    if (opt.choices) {
        p(section('CHOICE LISTS (sys_choice)'));
        var grChoice = new GlideRecord('sys_choice');
        if (!grChoice.isValid()) {
            missing('sys_choice');
        } else {
            grChoice.addQuery('name', 'IN', hierarchy.join(','));
            if (!opt.inactive) grChoice.addQuery('inactive', false);
            grChoice.orderBy('name');
            grChoice.orderBy('element');
            grChoice.orderBy('sequence');
            grChoice.query();
            var lastKey = '';
            var choiceCount = 0;
            while (grChoice.next()) {
                var key = val(grChoice, 'name') + '.' + val(grChoice, 'element');
                if (key !== lastKey) {
                    p(subsection('CHOICES: ' + key));
                    lastKey = key;
                }
                choiceCount++;
                p('  ' + val(grChoice, 'value') + ' = ' + val(grChoice, 'label') +
                  (val(grChoice, 'sequence') ? '  (seq ' + val(grChoice, 'sequence') + ')' : '') +
                  (isTrue(grChoice, 'inactive') ? '  [INACTIVE]' : '') +
                  (val(grChoice, 'dependent_value') ? '  [dependent: ' + val(grChoice, 'dependent_value') + ']' : ''));
                if (val(grChoice, 'hint')) p('      hint: ' + val(grChoice, 'hint'));
            }
            if (choiceCount === 0) p('  (none)');
            else p('\n  TOTAL CHOICES: ' + choiceCount);
        }
    }

    // ── 4. Business Rules ────────────────────────────────────

    if (opt.businessRules) {
        p(section('BUSINESS RULES (sys_script)'));
        var grBr = q('sys_script', 'collection', hierarchy, 'order');
        var brCount = 0;
        while (grBr && grBr.next()) {
            brCount++;
            p(subsection(brCount + '. ' + val(grBr, 'name') + '   [' + val(grBr, 'collection') + ']'));
            line('sys_id', grBr.getUniqueValue());
            line('Active', val(grBr, 'active'));
            line('Order', val(grBr, 'order'));
            line('When', disp(grBr, 'when'));
            var ops = [];
            if (isTrue(grBr, 'action_insert')) ops.push('insert');
            if (isTrue(grBr, 'action_update')) ops.push('update');
            if (isTrue(grBr, 'action_delete')) ops.push('delete');
            if (isTrue(grBr, 'action_query')) ops.push('query');
            line('Operations', ops.join(', '));
            if (isTrue(grBr, 'advanced')) line('Advanced', 'true');
            if (isTrue(grBr, 'abort_action')) line('Abort action', 'true');
            if (isTrue(grBr, 'add_message')) line('Add message', val(grBr, 'message'));
            if (val(grBr, 'filter_condition')) line('Filter condition', val(grBr, 'filter_condition'));
            if (val(grBr, 'condition')) line('Condition', val(grBr, 'condition'));
            if (val(grBr, 'role_conditions')) line('Role conditions', disp(grBr, 'role_conditions'));
            if (val(grBr, 'template')) line('Template', val(grBr, 'template'));
            line('Scope', disp(grBr, 'sys_scope'));
            line('Updated', disp(grBr, 'sys_updated_on') + ' by ' + val(grBr, 'sys_updated_by'));
            if (val(grBr, 'description')) line('Description', val(grBr, 'description'));
            collect(val(grBr, 'script'));
            script('Script', val(grBr, 'script'));
        }
        if (brCount === 0) p('  (none)');
        else p('\n  TOTAL BUSINESS RULES: ' + brCount);
    }

    // ── 5. Client Scripts ────────────────────────────────────

    if (opt.clientScripts) {
        p(section('CLIENT SCRIPTS (sys_script_client)'));
        var grCs = q('sys_script_client', 'table', hierarchy, 'order');
        var csCount = 0;
        while (grCs && grCs.next()) {
            csCount++;
            p(subsection(csCount + '. ' + val(grCs, 'name') + '   [' + val(grCs, 'table') + ']'));
            line('sys_id', grCs.getUniqueValue());
            line('Active', val(grCs, 'active'));
            line('Type', disp(grCs, 'type'));
            line('UI type', disp(grCs, 'ui_type'));
            line('Order', val(grCs, 'order'));
            if (val(grCs, 'field')) line('Field', val(grCs, 'field'));
            if (val(grCs, 'view')) line('View', disp(grCs, 'view'));
            if (isTrue(grCs, 'global')) line('Global (all views/tables)', 'true');
            if (isTrue(grCs, 'isolate_script')) line('Isolate script', 'true');
            if (val(grCs, 'condition')) line('Condition', val(grCs, 'condition'));
            if (val(grCs, 'messages')) line('Messages', val(grCs, 'messages'));
            line('Scope', disp(grCs, 'sys_scope'));
            if (val(grCs, 'description')) line('Description', val(grCs, 'description'));
            collect(val(grCs, 'script'));
            script('Script', val(grCs, 'script'));
        }
        if (csCount === 0) p('  (none)');
        else p('\n  TOTAL CLIENT SCRIPTS: ' + csCount);
    }

    // ── 6. UI Policies (+ actions) ───────────────────────────

    if (opt.uiPolicies) {
        p(section('UI POLICIES (sys_ui_policy)'));
        var grUip = q('sys_ui_policy', 'table', hierarchy, 'order');
        var uipCount = 0;
        while (grUip && grUip.next()) {
            uipCount++;
            var uipId = grUip.getUniqueValue();
            p(subsection(uipCount + '. ' + val(grUip, 'short_description') + '   [' + val(grUip, 'table') + ']'));
            line('sys_id', uipId);
            line('Active', val(grUip, 'active'));
            line('Order', val(grUip, 'order'));
            if (val(grUip, 'view')) line('View', disp(grUip, 'view'));
            if (isTrue(grUip, 'global')) line('Global (all views)', 'true');
            if (isTrue(grUip, 'on_load')) line('On load', 'true');
            if (isTrue(grUip, 'reverse_if_false')) line('Reverse if false', 'true');
            if (isTrue(grUip, 'inherit')) line('Inherited by child tables', 'true');
            line('Condition', val(grUip, 'conditions') || val(grUip, 'condition_script') || '(always)');
            if (isTrue(grUip, 'run_scripts')) {
                collect(val(grUip, 'script_true'));
                collect(val(grUip, 'script_false'));
                script('Execute if true', val(grUip, 'script_true'));
                script('Execute if false', val(grUip, 'script_false'));
            }
            var grUipa = new GlideRecord('sys_ui_policy_action');
            if (grUipa.isValid()) {
                grUipa.addQuery('ui_policy', uipId);
                grUipa.query();
                var uipaCount = 0;
                while (grUipa.next()) {
                    uipaCount++;
                    var acts = [];
                    if (val(grUipa, 'mandatory') && val(grUipa, 'mandatory') !== 'ignore') acts.push('mandatory=' + val(grUipa, 'mandatory'));
                    if (val(grUipa, 'visible') && val(grUipa, 'visible') !== 'ignore') acts.push('visible=' + val(grUipa, 'visible'));
                    if (val(grUipa, 'disabled') && val(grUipa, 'disabled') !== 'ignore') acts.push('readonly=' + val(grUipa, 'disabled'));
                    p('     Action ' + uipaCount + ': ' + val(grUipa, 'field') + '  ' + acts.join(', '));
                }
                if (uipaCount === 0) p('     (no field actions — script only)');
            }
        }
        if (uipCount === 0) p('  (none)');
        else p('\n  TOTAL UI POLICIES: ' + uipCount);
    }

    // ── 7. Data Policies (+ rules) ───────────────────────────

    if (opt.dataPolicies) {
        p(section('DATA POLICIES (sys_data_policy2)'));
        var grDp = q('sys_data_policy2', 'model_table', hierarchy, null);
        var dpCount = 0;
        while (grDp && grDp.next()) {
            dpCount++;
            var dpId = grDp.getUniqueValue();
            p(subsection(dpCount + '. ' + val(grDp, 'short_description') + '   [' + val(grDp, 'model_table') + ']'));
            line('sys_id', dpId);
            line('Active', val(grDp, 'active'));
            if (isTrue(grDp, 'enforce_ui')) line('Use as UI policy on client', 'true');
            if (isTrue(grDp, 'apply_import_set')) line('Apply to import sets', 'true');
            if (isTrue(grDp, 'apply_soap')) line('Apply to SOAP/inbound API', 'true');
            if (isTrue(grDp, 'inherit')) line('Inherited by child tables', 'true');
            if (isTrue(grDp, 'reverse_if_false')) line('Reverse if false', 'true');
            line('Condition', val(grDp, 'conditions') || '(always)');
            var grDpr = new GlideRecord('sys_data_policy_rule');
            if (grDpr.isValid()) {
                grDpr.addQuery('model_id', dpId);
                grDpr.query();
                var dprCount = 0;
                while (grDpr.next()) {
                    dprCount++;
                    p('     Rule ' + dprCount + ': ' + val(grDpr, 'field') +
                      '  mandatory=' + val(grDpr, 'mandatory') +
                      ', readonly=' + val(grDpr, 'disabled'));
                }
                if (dprCount === 0) p('     (no field rules)');
            }
        }
        if (dpCount === 0) p('  (none)');
        else p('\n  TOTAL DATA POLICIES: ' + dpCount);
    }

    // ── 8. UI Actions ────────────────────────────────────────

    if (opt.uiActions) {
        p(section('UI ACTIONS (sys_ui_action)'));
        var grUia = q('sys_ui_action', 'table', hierarchy, 'order');
        var uiaCount = 0;
        while (grUia && grUia.next()) {
            uiaCount++;
            p(subsection(uiaCount + '. ' + val(grUia, 'name') + '   [' + val(grUia, 'table') + ']'));
            line('sys_id', grUia.getUniqueValue());
            line('Active', val(grUia, 'active'));
            line('Action name', val(grUia, 'action_name'));
            line('Order', val(grUia, 'order'));
            var where = [];
            if (isTrue(grUia, 'form_button')) where.push('form button');
            if (isTrue(grUia, 'form_context_menu')) where.push('form context menu');
            if (isTrue(grUia, 'form_link')) where.push('form link');
            if (isTrue(grUia, 'form_menu_button_v2')) where.push('form menu button');
            if (isTrue(grUia, 'list_banner_button')) where.push('list banner button');
            if (isTrue(grUia, 'list_button')) where.push('list button');
            if (isTrue(grUia, 'list_context_menu')) where.push('list context menu');
            if (isTrue(grUia, 'list_choice')) where.push('list choice (bulk)');
            if (isTrue(grUia, 'list_link')) where.push('list link');
            if (isTrue(grUia, 'list_save_button')) where.push('list save button');
            line('Shows as', where.join(', '));
            if (isTrue(grUia, 'client')) line('Client-side', 'true (onclick: ' + val(grUia, 'onclick') + ')');
            if (isTrue(grUia, 'isolate_script')) line('Isolate script', 'true');
            if (val(grUia, 'condition')) line('Condition', val(grUia, 'condition'));
            if (val(grUia, 'hint')) line('Hint', val(grUia, 'hint'));
            line('Scope', disp(grUia, 'sys_scope'));
            collect(val(grUia, 'script'));
            script('Script', val(grUia, 'script'));
        }
        if (uiaCount === 0) p('  (none)');
        else p('\n  TOTAL UI ACTIONS: ' + uiaCount);
    }

    // ── 9. Access Controls (ACLs) ────────────────────────────

    if (opt.acls) {
        p(section('ACCESS CONTROLS (sys_security_acl)'));
        var aclTotal = 0;
        for (var ati = 0; ati < hierarchy.length; ati++) {
            var aTable = hierarchy[ati];
            var grAcl = new GlideRecord('sys_security_acl');
            if (!grAcl.isValid()) { missing('sys_security_acl'); break; }
            grAcl.addQuery('name', 'STARTSWITH', aTable);
            if (!opt.inactive) grAcl.addQuery('active', true);
            grAcl.orderBy('name');
            grAcl.orderBy('operation');
            grAcl.query();
            var tableAclCount = 0;
            while (grAcl.next()) {
                var aclName = val(grAcl, 'name');
                // STARTSWITH also matches sibling tables (pm_project_task_foo) — filter
                if (aclName !== aTable && aclName.indexOf(aTable + '.') !== 0) continue;
                if (tableAclCount === 0) p(subsection('ACLs ON: ' + aTable));
                tableAclCount++;
                aclTotal++;
                p('  ' + tableAclCount + '. ' + aclName + '  [' + disp(grAcl, 'operation') + ']  type=' + val(grAcl, 'type'));
                line('sys_id', grAcl.getUniqueValue());
                if (isTrue(grAcl, 'admin_overrides')) line('Admin overrides', 'true');
                if (isTrue(grAcl, 'active') === false) line('Active', 'false');
                if (val(grAcl, 'description')) line('Description', val(grAcl, 'description'));
                // Roles (m2m)
                var roles = [];
                var grAclRole = new GlideRecord('sys_security_acl_role');
                if (grAclRole.isValid()) {
                    grAclRole.addQuery('sys_security_acl', grAcl.getUniqueValue());
                    grAclRole.query();
                    while (grAclRole.next()) roles.push(grAclRole.getDisplayValue('sys_user_role'));
                }
                line('Roles', roles.length ? roles.join(', ') : '(none — condition/script only)');
                if (opt.aclScripts) {
                    if (val(grAcl, 'condition')) line('Condition', val(grAcl, 'condition'));
                    collect(val(grAcl, 'script'));
                    script('Script', val(grAcl, 'script'));
                }
            }
        }
        if (aclTotal === 0) p('  (none)');
        else p('\n  TOTAL ACCESS CONTROLS: ' + aclTotal);
    }

    // ── 10. Notifications ────────────────────────────────────

    if (opt.notifications) {
        p(section('NOTIFICATIONS (sysevent_email_action)'));
        var grNotif = q('sysevent_email_action', 'collection', hierarchy, 'name');
        var notifCount = 0;
        while (grNotif && grNotif.next()) {
            notifCount++;
            p(subsection(notifCount + '. ' + val(grNotif, 'name') + '   [' + val(grNotif, 'collection') + ']'));
            line('sys_id', grNotif.getUniqueValue());
            line('Active', val(grNotif, 'active'));
            line('Type', disp(grNotif, 'type'));
            if (val(grNotif, 'event_name')) line('Event', val(grNotif, 'event_name'));
            var sendWhen = [];
            if (isTrue(grNotif, 'action_insert')) sendWhen.push('insert');
            if (isTrue(grNotif, 'action_update')) sendWhen.push('update');
            if (isTrue(grNotif, 'action_delete')) sendWhen.push('delete');
            if (sendWhen.length) line('Send on', sendWhen.join(', '));
            if (val(grNotif, 'condition')) line('Condition', val(grNotif, 'condition'));
            if (val(grNotif, 'recipient_fields')) line('Recipient fields', val(grNotif, 'recipient_fields'));
            if (val(grNotif, 'recipient_users')) line('Recipient users', disp(grNotif, 'recipient_users'));
            if (val(grNotif, 'recipient_groups')) line('Recipient groups', disp(grNotif, 'recipient_groups'));
            if (val(grNotif, 'exclude_delegates')) line('Exclude delegates', val(grNotif, 'exclude_delegates'));
            if (isTrue(grNotif, 'force_delivery')) line('Send to event creator', 'true');
            if (val(grNotif, 'weight')) line('Weight', val(grNotif, 'weight'));
            if (val(grNotif, 'template')) line('Template', disp(grNotif, 'template'));
            line('Subject', val(grNotif, 'subject'));
            var msg = val(grNotif, 'message') || val(grNotif, 'message_html');
            if (msg) {
                p('     MESSAGE:');
                p(msg);
                // Referenced mail scripts
                var msMatch, msPattern = /\$\{mail_script:([^}]+)\}/g;
                while ((msMatch = msPattern.exec(msg)) !== null) {
                    var grMs = new GlideRecord('sys_script_email');
                    grMs.addQuery('name', msMatch[1]);
                    grMs.setLimit(1);
                    grMs.query();
                    if (grMs.next()) {
                        collect(val(grMs, 'script'));
                        script('Mail script "' + msMatch[1] + '"', val(grMs, 'script'), '       ');
                    } else {
                        p('       Mail script "' + msMatch[1] + '" (not found)');
                    }
                }
            }
            if (val(grNotif, 'advanced_condition')) {
                collect(val(grNotif, 'advanced_condition'));
                script('Advanced condition', val(grNotif, 'advanced_condition'));
            }
        }
        if (notifCount === 0) p('  (none)');
        else p('\n  TOTAL NOTIFICATIONS: ' + notifCount);
    }

    // ── 11. Inbound Email Actions ────────────────────────────

    if (opt.inboundEmail) {
        p(section('INBOUND EMAIL ACTIONS (sysevent_in_email_action)'));
        var grIea = q('sysevent_in_email_action', 'table', hierarchy, 'order');
        var ieaCount = 0;
        while (grIea && grIea.next()) {
            ieaCount++;
            p(subsection(ieaCount + '. ' + val(grIea, 'name') + '   [' + val(grIea, 'table') + ']'));
            line('sys_id', grIea.getUniqueValue());
            line('Active', val(grIea, 'active'));
            line('Type', disp(grIea, 'type'));
            line('Order', val(grIea, 'order'));
            if (isTrue(grIea, 'stop_processing')) line('Stop processing', 'true');
            if (val(grIea, 'condition')) line('Condition', val(grIea, 'condition'));
            if (val(grIea, 'filter_condition')) line('Filter condition', val(grIea, 'filter_condition'));
            if (val(grIea, 'template')) line('Template', disp(grIea, 'template'));
            collect(val(grIea, 'script'));
            script('Script', val(grIea, 'script'));
        }
        if (ieaCount === 0) p('  (none)');
        else p('\n  TOTAL INBOUND EMAIL ACTIONS: ' + ieaCount);
    }

    // ── 12. Styles ───────────────────────────────────────────

    if (opt.styles) {
        p(section('FIELD STYLES (sys_ui_style)'));
        var grStyle = new GlideRecord('sys_ui_style');
        if (!grStyle.isValid()) {
            missing('sys_ui_style');
        } else {
            grStyle.addQuery('name', 'IN', hierarchy.join(','));
            grStyle.orderBy('name');
            grStyle.orderBy('element');
            grStyle.query();
            var styleCount = 0;
            while (grStyle.next()) {
                styleCount++;
                p('  ' + styleCount + '. ' + val(grStyle, 'name') + '.' + val(grStyle, 'element'));
                line('Value/condition', val(grStyle, 'value'));
                line('Style', val(grStyle, 'style'));
                if (val(grStyle, 'view')) line('View', disp(grStyle, 'view'));
                if (isTrue(grStyle, 'inactive')) line('Inactive', 'true');
            }
            if (styleCount === 0) p('  (none)');
            else p('\n  TOTAL STYLES: ' + styleCount);
        }
    }

    // ── 13. View Rules ───────────────────────────────────────

    if (opt.viewRules) {
        p(section('VIEW RULES (sys_ui_view_rule)'));
        var grVr = q('sys_ui_view_rule', 'table', hierarchy, 'order');
        var vrCount = 0;
        while (grVr && grVr.next()) {
            vrCount++;
            p('  ' + vrCount + '. ' + val(grVr, 'name') + '  → view: ' + disp(grVr, 'view'));
            line('Active', val(grVr, 'active'));
            line('Order', val(grVr, 'order'));
            if (val(grVr, 'device_type')) line('Device type', disp(grVr, 'device_type'));
            if (val(grVr, 'conditions')) line('Conditions', val(grVr, 'conditions'));
            if (val(grVr, 'script')) {
                collect(val(grVr, 'script'));
                script('Script', val(grVr, 'script'));
            }
        }
        if (vrCount === 0) p('  (none)');
        else p('\n  TOTAL VIEW RULES: ' + vrCount);
    }

    // ── 14. Form layout ──────────────────────────────────────

    if (opt.formLayout) {
        p(section('FORM LAYOUT (sys_ui_section / sys_ui_element)'));
        var grSec = new GlideRecord('sys_ui_section');
        if (!grSec.isValid()) {
            missing('sys_ui_section');
        } else {
            grSec.addQuery('name', 'IN', hierarchy.join(','));
            grSec.orderBy('name');
            grSec.orderBy('view');
            grSec.query();
            var secCount = 0;
            while (grSec.next()) {
                secCount++;
                p(subsection('Section ' + secCount + ': ' + val(grSec, 'name') +
                    '  view=' + (disp(grSec, 'view') || 'Default') +
                    (val(grSec, 'caption') ? '  caption=' + val(grSec, 'caption') : '')));
                var grEl = new GlideRecord('sys_ui_element');
                grEl.addQuery('sys_ui_section', grSec.getUniqueValue());
                grEl.orderBy('position');
                grEl.query();
                while (grEl.next()) {
                    p('     ' + val(grEl, 'position') + '. ' + val(grEl, 'element') +
                      (val(grEl, 'type') ? '  [' + val(grEl, 'type') + ']' : ''));
                }
            }
            if (secCount === 0) p('  (none)');
        }

        p(subsection('FORMATTERS / RELATED SECTIONS (sys_ui_form_section)'));
        var grFs = new GlideRecord('sys_ui_form_section');
        var fsCount = 0;
        if (grFs.isValid()) {
            var grForm = new GlideRecord('sys_ui_form');
            grForm.addQuery('name', 'IN', hierarchy.join(','));
            grForm.query();
            while (grForm.next()) {
                var grFs2 = new GlideRecord('sys_ui_form_section');
                grFs2.addQuery('sys_ui_form', grForm.getUniqueValue());
                grFs2.orderBy('position');
                grFs2.query();
                while (grFs2.next()) {
                    fsCount++;
                    p('  ' + val(grForm, 'name') + ' / view=' + (disp(grForm, 'view') || 'Default') +
                      '  → ' + grFs2.getDisplayValue('sys_ui_section'));
                }
            }
        }
        if (fsCount === 0) p('  (none)');
    }

    // ── 15. List layout ──────────────────────────────────────

    if (opt.listLayout) {
        p(section('LIST LAYOUT (sys_ui_list / sys_ui_list_element)'));
        var grList = new GlideRecord('sys_ui_list');
        if (!grList.isValid()) {
            missing('sys_ui_list');
        } else {
            grList.addQuery('name', 'IN', hierarchy.join(','));
            grList.query();
            var listCount = 0;
            while (grList.next()) {
                listCount++;
                p('  List ' + listCount + ': ' + val(grList, 'name') +
                  '  view=' + (disp(grList, 'view') || 'Default') +
                  (val(grList, 'parent') ? '  parent=' + val(grList, 'parent') : '') +
                  (val(grList, 'relationship') ? '  relationship=' + disp(grList, 'relationship') : ''));
                var grLe = new GlideRecord('sys_ui_list_element');
                grLe.addQuery('list_id', grList.getUniqueValue());
                grLe.orderBy('position');
                grLe.query();
                var cols = [];
                while (grLe.next()) cols.push(val(grLe, 'element'));
                p('     Columns: ' + cols.join(', '));
            }
            if (listCount === 0) p('  (none)');
        }
    }

    // ── 16. Related lists ────────────────────────────────────

    if (opt.relatedLists) {
        p(section('RELATED LISTS (sys_ui_related_list)'));
        var grRl = new GlideRecord('sys_ui_related_list');
        if (!grRl.isValid()) {
            missing('sys_ui_related_list');
        } else {
            grRl.addQuery('name', 'IN', hierarchy.join(','));
            grRl.query();
            var rlCount = 0;
            while (grRl.next()) {
                rlCount++;
                p('  ' + rlCount + '. ' + val(grRl, 'name') + '  view=' + (disp(grRl, 'view') || 'Default'));
                var grRle = new GlideRecord('sys_ui_related_list_entry');
                if (grRle.isValid()) {
                    grRle.addQuery('list_id', grRl.getUniqueValue());
                    grRle.orderBy('position');
                    grRle.query();
                    while (grRle.next()) {
                        p('       - ' + val(grRle, 'related_list'));
                    }
                }
            }
            if (rlCount === 0) p('  (none)');
        }
    }

    // ── 17. Relationships ────────────────────────────────────

    if (opt.relationships) {
        p(section('DEFINED RELATIONSHIPS (sys_relationship)'));
        var grRel = new GlideRecord('sys_relationship');
        if (!grRel.isValid()) {
            missing('sys_relationship');
        } else {
            grRel.addQuery('applies_to', 'IN', hierarchy.join(','));
            grRel.addOrCondition('queries_from', 'IN', hierarchy.join(','));
            grRel.orderBy('name');
            grRel.query();
            var relCount = 0;
            while (grRel.next()) {
                relCount++;
                p('  ' + relCount + '. ' + val(grRel, 'name'));
                line('Applies to', val(grRel, 'applies_to'));
                line('Queries from', val(grRel, 'queries_from'));
                collect(val(grRel, 'query_with'));
                script('Query with', val(grRel, 'query_with'));
            }
            if (relCount === 0) p('  (none)');
        }
    }

    // ── 18. Workflows ────────────────────────────────────────

    if (opt.workflows) {
        p(section('WORKFLOWS (wf_workflow_version)'));
        var grWfv = new GlideRecord('wf_workflow_version');
        if (!grWfv.isValid()) {
            missing('wf_workflow_version');
        } else {
            grWfv.addQuery('table', 'IN', hierarchy.join(','));
            grWfv.orderBy('name');
            grWfv.query();
            var wfCount = 0;
            while (grWfv.next()) {
                wfCount++;
                p('  ' + wfCount + '. ' + val(grWfv, 'name') +
                  '  [' + val(grWfv, 'table') + ']  published=' + val(grWfv, 'published'));
                line('workflow_version sys_id', grWfv.getUniqueValue());
                line('wf_workflow sys_id', val(grWfv, 'workflow'));
                if (val(grWfv, 'condition')) line('Condition', val(grWfv, 'condition'));
                if (val(grWfv, 'description')) line('Description', val(grWfv, 'description'));
                p('     → Run Scripts/extract_sn_workflow.js with this sys_id for the full definition');
            }
            if (wfCount === 0) p('  (none)');
            else p('\n  TOTAL WORKFLOW VERSIONS: ' + wfCount);
        }
    }

    // ── 19. Flow Designer flows ──────────────────────────────

    if (opt.flows) {
        p(section('FLOW DESIGNER FLOWS'));
        var foundFlows = {};

        // (a) Flows whose trigger instance points at one of our tables
        var trigTables = ['sys_hub_trigger_instance_v2', 'sys_hub_trigger_instance'];
        for (var tti = 0; tti < trigTables.length; tti++) {
            var grTrig = new GlideRecord(trigTables[tti]);
            if (!grTrig.isValid()) continue;
            var tblField = grTrig.isValidField('table') ? 'table' :
                           (grTrig.isValidField('source_table') ? 'source_table' : '');
            if (!tblField) continue;
            grTrig.addQuery(tblField, 'IN', hierarchy.join(','));
            grTrig.query();
            while (grTrig.next()) {
                var fId = val(grTrig, 'flow');
                if (fId) foundFlows[fId] = 'trigger (' + trigTables[tti] + ')';
            }
        }

        // (b) Flows that actually ran against records on these tables
        var ctxTables = ['sys_flow_context', 'sys_hub_flow_context'];
        for (var cti = 0; cti < ctxTables.length; cti++) {
            var grFc = new GlideRecord(ctxTables[cti]);
            if (!grFc.isValid() || !grFc.isValidField('source_table')) continue;
            grFc.addQuery('source_table', 'IN', hierarchy.join(','));
            grFc.orderByDesc('sys_created_on');
            grFc.setLimit(500);
            grFc.query();
            while (grFc.next()) {
                var fcFlow = val(grFc, 'flow');
                if (fcFlow && !foundFlows[fcFlow]) foundFlows[fcFlow] = 'execution history (' + ctxTables[cti] + ')';
            }
        }

        // (c) label_cache scan — trigger config is gzip'd on v2 tables
        var grFlowAll = new GlideRecord('sys_hub_flow');
        if (grFlowAll.isValid()) {
            grFlowAll.addQuery('active', true);
            grFlowAll.query();
            while (grFlowAll.next()) {
                var lc = val(grFlowAll, 'label_cache');
                if (!lc) continue;
                for (var lhi = 0; lhi < hierarchy.length; lhi++) {
                    if (lc.indexOf('"' + hierarchy[lhi] + '"') !== -1) {
                        var lcId = grFlowAll.getUniqueValue();
                        if (!foundFlows[lcId]) foundFlows[lcId] = 'label_cache reference';
                        break;
                    }
                }
            }
        }

        var flowCount = 0;
        for (var flowId in foundFlows) {
            if (!foundFlows.hasOwnProperty(flowId)) continue;
            var grF = new GlideRecord('sys_hub_flow');
            if (!grF.get(flowId)) continue;
            flowCount++;
            p('  ' + flowCount + '. ' + val(grF, 'name') + '  [' + disp(grF, 'sys_class_name') + ']');
            line('sys_id', flowId);
            line('Found via', foundFlows[flowId]);
            line('Status', disp(grF, 'status') || val(grF, 'status'));
            line('Active', val(grF, 'active'));
            line('Scope', disp(grF, 'sys_scope'));
            line('Run as', disp(grF, 'run_as'));
            if (val(grF, 'description')) line('Description', val(grF, 'description'));
            p('     → Run Scripts/extract_sn_workflow.js with this sys_id for the full flow');
        }
        if (flowCount === 0) p('  (none found — trigger config may be compressed; check Flow Designer UI)');
        else p('\n  TOTAL FLOWS: ' + flowCount);
    }

    // ── 20. SLAs ─────────────────────────────────────────────

    if (opt.slas) {
        p(section('SLA DEFINITIONS (contract_sla)'));
        var grSla = q('contract_sla', 'collection', hierarchy, 'name');
        var slaCount = 0;
        while (grSla && grSla.next()) {
            slaCount++;
            p('  ' + slaCount + '. ' + val(grSla, 'name') + '  [' + val(grSla, 'collection') + ']');
            line('sys_id', grSla.getUniqueValue());
            line('Type', disp(grSla, 'type'));
            line('Duration', disp(grSla, 'duration') || val(grSla, 'duration_type'));
            line('Schedule', disp(grSla, 'schedule'));
            line('Timezone', disp(grSla, 'timezone'));
            if (val(grSla, 'start_condition')) line('Start condition', val(grSla, 'start_condition'));
            if (val(grSla, 'pause_condition')) line('Pause condition', val(grSla, 'pause_condition'));
            if (val(grSla, 'stop_condition')) line('Stop condition', val(grSla, 'stop_condition'));
            if (val(grSla, 'reset_condition')) line('Reset condition', val(grSla, 'reset_condition'));
            if (val(grSla, 'when_to_cancel')) line('Cancel condition', val(grSla, 'when_to_cancel'));
        }
        if (slaCount === 0) p('  (none)');
    }

    // ── 21. Metrics ──────────────────────────────────────────

    if (opt.metrics) {
        p(section('METRIC DEFINITIONS (metric_definition)'));
        var grMd = q('metric_definition', 'table', hierarchy, 'name');
        var mdCount = 0;
        while (grMd && grMd.next()) {
            mdCount++;
            p('  ' + mdCount + '. ' + val(grMd, 'name') + '  [' + val(grMd, 'table') + ']');
            line('Type', disp(grMd, 'type'));
            line('Field', val(grMd, 'field'));
            if (val(grMd, 'timeline')) line('Timeline', val(grMd, 'timeline'));
            collect(val(grMd, 'script'));
            script('Script', val(grMd, 'script'));
        }
        if (mdCount === 0) p('  (none)');
    }

    // ── 22. Assignment / Escalation rules ────────────────────

    if (opt.assignmentRules) {
        p(section('ASSIGNMENT & ESCALATION RULES'));
        var ruleTables = ['sysrule_assignment', 'sysrule_escalate', 'sysrule_view', 'sysrule'];
        var ruleTotal = 0;
        for (var rti = 0; rti < ruleTables.length; rti++) {
            var grRule = new GlideRecord(ruleTables[rti]);
            if (!grRule.isValid()) continue;
            var rField = grRule.isValidField('table') ? 'table' :
                         (grRule.isValidField('collection') ? 'collection' : '');
            if (!rField) continue;
            var grR = q(ruleTables[rti], rField, hierarchy, 'order');
            var rCount = 0;
            while (grR && grR.next()) {
                if (rCount === 0) p(subsection(ruleTables[rti]));
                rCount++;
                ruleTotal++;
                p('  ' + rCount + '. ' + val(grR, 'name'));
                line('Active', val(grR, 'active'));
                line('Order', val(grR, 'order'));
                if (val(grR, 'condition')) line('Condition', val(grR, 'condition'));
                if (val(grR, 'assign_to')) line('Assign to', disp(grR, 'assign_to'));
                if (val(grR, 'assignment_group')) line('Assignment group', disp(grR, 'assignment_group'));
                if (val(grR, 'script')) {
                    collect(val(grR, 'script'));
                    script('Script', val(grR, 'script'));
                }
            }
        }
        if (ruleTotal === 0) p('  (none)');
    }

    // ── 23. Scheduled jobs referencing the table ─────────────

    if (opt.scheduledJobs) {
        p(section('SCHEDULED JOBS REFERENCING THE TABLE'));
        var sjCount = 0;
        var grSj = new GlideRecord('sysauto_script');
        if (!grSj.isValid()) {
            missing('sysauto_script');
        } else {
            grSj.addQuery('script', 'CONTAINS', tableName);
            grSj.query();
            while (grSj.next()) {
                sjCount++;
                p('  ' + sjCount + '. ' + val(grSj, 'name'));
                line('sys_id', grSj.getUniqueValue());
                line('Active', val(grSj, 'active'));
                line('Run', disp(grSj, 'run_type') + ' ' + (disp(grSj, 'run_time') || ''));
                line('Condition', val(grSj, 'condition'));
                collect(val(grSj, 'script'));
                script('Script', val(grSj, 'script'));
            }
            if (sjCount === 0) p('  (none)');
        }
    }

    // ── 24. Registered events ────────────────────────────────

    if (opt.events) {
        p(section('REGISTERED EVENTS (sysevent_register)'));
        var grEv = new GlideRecord('sysevent_register');
        if (!grEv.isValid()) {
            missing('sysevent_register');
        } else {
            grEv.addQuery('table', 'IN', hierarchy.join(','));
            grEv.orderBy('event_name');
            grEv.query();
            var evCount = 0;
            while (grEv.next()) {
                evCount++;
                p('  ' + evCount + '. ' + val(grEv, 'event_name') + '  [' + val(grEv, 'table') + ']');
                if (val(grEv, 'description')) line('Description', val(grEv, 'description'));
                if (val(grEv, 'fired_by')) line('Fired by', val(grEv, 'fired_by'));
            }
            if (evCount === 0) p('  (none)');
        }
    }

    // ── 25. Number maintenance ───────────────────────────────

    if (opt.numbering) {
        p(section('NUMBER MAINTENANCE (sys_number)'));
        var grNum = new GlideRecord('sys_number');
        if (!grNum.isValid()) {
            missing('sys_number');
        } else {
            grNum.addQuery('category', 'IN', hierarchy.join(','));
            grNum.query();
            var numCount = 0;
            while (grNum.next()) {
                numCount++;
                p('  ' + numCount + '. table=' + val(grNum, 'category') +
                  '  prefix=' + val(grNum, 'prefix') +
                  '  next=' + val(grNum, 'number') +
                  '  digits=' + val(grNum, 'maximum_digits'));
            }
            if (numCount === 0) p('  (none)');
        }
    }

    // ── 26. Transform maps ───────────────────────────────────

    if (opt.transformMaps) {
        p(section('TRANSFORM MAPS (sys_transform_map)'));
        var grTm = q('sys_transform_map', 'target_table', hierarchy, 'name');
        var tmCount = 0;
        while (grTm && grTm.next()) {
            tmCount++;
            p('  ' + tmCount + '. ' + val(grTm, 'name') +
              '  ' + val(grTm, 'source_table') + ' → ' + val(grTm, 'target_table'));
            line('Active', val(grTm, 'active'));
            line('Run business rules', val(grTm, 'run_business_rules'));
            line('Coalesce/order', val(grTm, 'order'));
            var grEnt = new GlideRecord('sys_transform_entry');
            if (grEnt.isValid()) {
                grEnt.addQuery('map', grTm.getUniqueValue());
                grEnt.orderBy('order');
                grEnt.query();
                while (grEnt.next()) {
                    p('       ' + val(grEnt, 'source_field') + ' → ' + val(grEnt, 'target_field') +
                      (isTrue(grEnt, 'coalesce') ? '  [COALESCE]' : ''));
                    if (val(grEnt, 'source_script')) {
                        collect(val(grEnt, 'source_script'));
                        script('Source script', val(grEnt, 'source_script'), '         ');
                    }
                }
            }
        }
        if (tmCount === 0) p('  (none)');
    }

    // ── 27. Modules / menu entries ───────────────────────────

    if (opt.modules) {
        p(section('APPLICATION MENU MODULES (sys_app_module)'));
        var modCount = 0;
        // sys_app_module.name holds the TABLE, title holds the menu label
        var grM2 = new GlideRecord('sys_app_module');
        if (!grM2.isValid()) {
            missing('sys_app_module');
        } else {
            grM2.addQuery('name', 'IN', hierarchy.join(','));
            grM2.orderBy('title');
            grM2.query();
            while (grM2.next()) {
                modCount++;
                p('  ' + modCount + '. ' + val(grM2, 'title') + '  (' + grM2.getDisplayValue('application') + ')');
                line('Table', val(grM2, 'name'));
                line('Link type', disp(grM2, 'link_type'));
                if (val(grM2, 'filter')) line('Filter', val(grM2, 'filter'));
                if (val(grM2, 'query')) line('Query', val(grM2, 'query'));
                if (val(grM2, 'roles')) line('Roles', disp(grM2, 'roles'));
                line('Active', val(grM2, 'active'));
            }
            if (modCount === 0) p('  (none)');
        }
    }

    // ── 28. Referenced Script Includes ───────────────────────

    if (opt.scriptIncludes) {
        p(section('REFERENCED SCRIPT INCLUDES'));
        var seen = {};
        var builtins = {
            GlideRecord: 1, GlideRecordSecure: 1, GlideDateTime: 1, GlideDate: 1,
            GlideAggregate: 1, GlideDuration: 1, GlideFilter: 1, GlideSysAttachment: 1,
            GlideElement: 1, GlideSession: 1, GlideSchedule: 1, GlideUser: 1,
            GlideUpdateManager: 1, GlideTime: 1, GlideQueryCondition: 1, GlideEmailOutbound: 1,
            GlideStringUtil: 1, GlideTableHierarchy: 1, GlideScriptedExtensionPoint: 1,
            ArrayUtil: 1, JSON: 1, Array: 1, Date: 1, RegExp: 1, Error: 1,
            Object: 1, String: 1, Number: 1, Boolean: 1, Function: 1, Packages: 1
        };
        for (var sci = 0; sci < scriptCorpus.length; sci++) {
            var body = scriptCorpus[sci];
            var m, re = /new\s+([A-Z][A-Za-z0-9_]*)\s*\(/g;
            while ((m = re.exec(body)) !== null) {
                if (!builtins[m[1]]) seen[m[1]] = true;
            }
            var m2, re2 = /\b([A-Z][A-Za-z0-9_]*)\s*\.\s*[a-z][A-Za-z0-9_]*\s*\(/g;
            while ((m2 = re2.exec(body)) !== null) {
                if (!builtins[m2[1]]) seen[m2[1]] = true;
            }
        }
        var siCount = 0, siMissing = 0;
        for (var siName in seen) {
            if (!seen.hasOwnProperty(siName)) continue;
            var grSi = new GlideRecord('sys_script_include');
            grSi.addQuery('name', siName);
            grSi.setLimit(1);
            grSi.query();
            if (!grSi.next()) { siMissing++; continue; }
            siCount++;
            p(subsection('Script Include: ' + siName));
            line('sys_id', grSi.getUniqueValue());
            line('API name', val(grSi, 'api_name'));
            line('Scope', disp(grSi, 'sys_scope'));
            line('Active', val(grSi, 'active'));
            line('Client callable', val(grSi, 'client_callable'));
            if (val(grSi, 'description')) line('Description', val(grSi, 'description'));
            script('Script', val(grSi, 'script'));
        }
        if (siCount === 0) p('  (none resolved)');
        else p('\n  TOTAL SCRIPT INCLUDES: ' + siCount + '  (' + siMissing + ' identifiers not found in sys_script_include)');
    }

    // ── 29. Record extraction (optional) ─────────────────────

    if (recordKey) {
        var grRec = new GlideRecord(tableName);
        var found = false;
        if (recordKey.length === 32) found = grRec.get(recordKey);
        if (!found && grRec.isValidField('number')) {
            var grByNum = new GlideRecord(tableName);
            grByNum.addQuery('number', recordKey.toUpperCase());
            grByNum.setLimit(1);
            grByNum.query();
            if (grByNum.next()) { grRec = grByNum; found = true; }
        }

        if (!found) {
            p(section('RECORD: ' + recordKey));
            p('  ERROR: no record found in ' + tableName + ' with sys_id/number "' + recordKey + '"');
        } else {
            var recId = grRec.getUniqueValue();
            var recLabel = (grRec.isValidField('number') ? val(grRec, 'number') : recId);

            p(section('RECORD: ' + recLabel + '  (' + tableName + ')'));
            p('sys_id: ' + recId);

            // All non-empty fields, using the dictionary walk (getFields() is unreliable in bg scripts)
            p(subsection('FIELD VALUES (non-empty)'));
            var printed = {};
            for (var hti = 0; hti < hierarchy.length; hti++) {
                var grFd = new GlideRecord('sys_dictionary');
                grFd.addQuery('name', hierarchy[hti]);
                grFd.addNotNullQuery('element');
                grFd.orderBy('element');
                grFd.query();
                while (grFd.next()) {
                    var fName = val(grFd, 'element');
                    if (printed[fName]) continue;
                    printed[fName] = true;
                    if (!grRec.isValidField(fName)) continue;
                    var raw = grRec.getValue(fName);
                    if (raw === null || raw === '' || raw === undefined) continue;
                    var dv = grRec.getDisplayValue(fName);
                    var lbl = val(grFd, 'column_label') || fName;
                    if (dv && dv !== raw) p('  ' + fName + ' (' + lbl + '): ' + dv + '  [' + raw + ']');
                    else p('  ' + fName + ' (' + lbl + '): ' + raw);
                }
            }

            // Journal
            p(subsection('ACTIVITY LOG / JOURNAL'));
            var grJ = new GlideRecord('sys_journal_field');
            grJ.addQuery('element_id', recId);
            grJ.orderBy('sys_created_on');
            grJ.query();
            var jCount = 0;
            while (grJ.next()) {
                jCount++;
                p('  [' + val(grJ, 'sys_created_on') + '] (' + val(grJ, 'sys_created_by') + ') [' + val(grJ, 'element') + ']');
                p('    ' + val(grJ, 'value'));
            }
            if (jCount === 0) p('  (none)');

            // Audit history
            p(subsection('FIELD CHANGE HISTORY (sys_audit)'));
            var grAudit = new GlideRecord('sys_audit');
            if (grAudit.isValid()) {
                grAudit.addQuery('documentkey', recId);
                grAudit.orderBy('sys_created_on');
                grAudit.setLimit(500);
                grAudit.query();
                var auditCount = 0;
                while (grAudit.next()) {
                    auditCount++;
                    p('  [' + val(grAudit, 'sys_created_on') + '] (' + val(grAudit, 'user') + ') ' +
                      val(grAudit, 'fieldname') + ': "' + val(grAudit, 'oldvalue') + '" → "' + val(grAudit, 'newvalue') + '"');
                }
                if (auditCount === 0) p('  (none — field auditing may be off for this table)');
            } else {
                missing('sys_audit');
            }

            // Approvals
            p(subsection('APPROVALS'));
            var grAp = new GlideRecord('sysapproval_approver');
            grAp.addQuery('sysapproval', recId);
            grAp.orderBy('sys_created_on');
            grAp.query();
            var apCount = 0;
            while (grAp.next()) {
                apCount++;
                p('  ' + apCount + '. ' + grAp.getDisplayValue('approver') + '  state=' + disp(grAp, 'state') +
                  '  created=' + disp(grAp, 'sys_created_on'));
                if (val(grAp, 'comments')) p('     Comments: ' + val(grAp, 'comments'));
            }
            if (apCount === 0) p('  (none)');

            // Child tasks
            p(subsection('CHILD / RELATED TASKS'));
            var childCount = 0;
            var parentFields = ['parent', 'top_task', 'project'];
            for (var pfi = 0; pfi < parentFields.length; pfi++) {
                var grChildTask = new GlideRecord(tableName);
                if (!grChildTask.isValidField(parentFields[pfi])) continue;
                grChildTask.addQuery(parentFields[pfi], recId);
                grChildTask.orderBy('number');
                grChildTask.query();
                while (grChildTask.next()) {
                    childCount++;
                    p('  [' + parentFields[pfi] + '] ' + grChildTask.getDisplayValue() +
                      '  state=' + grChildTask.getDisplayValue('state') +
                      '  assigned_to=' + (grChildTask.getDisplayValue('assigned_to') || '(none)'));
                }
            }
            if (childCount === 0) p('  (none)');

            // Attachments
            p(subsection('ATTACHMENTS'));
            var grAt = new GlideRecord('sys_attachment');
            grAt.addQuery('table_name', tableName);
            grAt.addQuery('table_sys_id', recId);
            grAt.orderBy('sys_created_on');
            grAt.query();
            var atCount = 0;
            while (grAt.next()) {
                atCount++;
                p('  ' + atCount + '. ' + val(grAt, 'file_name') + '  ' + val(grAt, 'size_bytes') +
                  ' bytes  ' + val(grAt, 'content_type') + '  ' + disp(grAt, 'sys_created_on'));
            }
            if (atCount === 0) p('  (none)');

            // Emails
            p(subsection('EMAILS'));
            var grEm = new GlideRecord('sys_email');
            grEm.addQuery('instance', recId);
            grEm.orderBy('sys_created_on');
            suppressDebug();
            grEm.query();
            restoreDebug();
            var emCount = 0;
            while (grEm.next()) {
                emCount++;
                p('  ' + emCount + '. [' + disp(grEm, 'type') + '] ' + val(grEm, 'subject'));
                line('Created', disp(grEm, 'sys_created_on'));
                line('Recipients', val(grEm, 'recipients'));
                if (val(grEm, 'notification')) line('Notification', disp(grEm, 'notification'));
            }
            if (emCount === 0) p('  (none)');

            // Workflow contexts
            p(subsection('WORKFLOW CONTEXTS'));
            var grWc = new GlideRecord('wf_context');
            grWc.addQuery('id', recId);
            grWc.orderBy('sys_created_on');
            grWc.query();
            var wcCount = 0;
            while (grWc.next()) {
                wcCount++;
                p('  ' + wcCount + '. context=' + grWc.getUniqueValue() +
                  '  state=' + (disp(grWc, 'state') || val(grWc, 'state')) +
                  '  workflow=' + disp(grWc, 'workflow_version'));
            }
            if (wcCount === 0) p('  (none)');

            // Flow runs
            p(subsection('FLOW DESIGNER RUNS'));
            var frCount = 0;
            var runTables = ['sys_flow_context', 'sys_hub_flow_context', 'sys_hub_flow_run'];
            for (var rti2 = 0; rti2 < runTables.length; rti2++) {
                var grFr = new GlideRecord(runTables[rti2]);
                if (!grFr.isValid()) continue;
                var recField = grFr.isValidField('record') ? 'record' :
                               (grFr.isValidField('source_record') ? 'source_record' : '');
                if (!recField) continue;
                grFr.addQuery(recField, recId);
                grFr.orderBy('sys_created_on');
                grFr.query();
                while (grFr.next()) {
                    frCount++;
                    p('  ' + frCount + '. [' + runTables[rti2] + '] ' + grFr.getUniqueValue() +
                      '  state=' + (grFr.getDisplayValue('state') || grFr.getValue('state')) +
                      '  flow=' + grFr.getDisplayValue('flow'));
                }
            }
            if (frCount === 0) p('  (none)');
        }
    }

    // ── Summary ──────────────────────────────────────────────

    p(ln('=', 80));
    p('EXPORT COMPLETE');
    p('Table: ' + tableName);
    p('Hierarchy covered: ' + hierarchy.join(' → '));
    if (recordKey) p('Record: ' + recordKey);
    p(ln('=', 80));

})(TABLE, RECORD, OPT);
