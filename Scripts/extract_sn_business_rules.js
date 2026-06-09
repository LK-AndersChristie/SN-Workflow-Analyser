/**
 * ServiceNow Business Rule Extractor — Background Script
 * =======================================================
 * Extracts business rule definitions into readable text.
 * Supports extracting by:
 *   - A single sys_id
 *   - All business rules on a specific table
 *
 * HOW TO USE:
 *   1. Set MODE below:
 *      - 'sys_id'  — extract a single business rule by sys_id
 *      - 'table'   — extract all business rules on a table (e.g. 'incident')
 *   2. Set the corresponding value (SYS_ID or TABLE_NAME)
 *   3. Optionally set ACTIVE_ONLY = true to skip inactive rules
 *   4. Paste this entire script into Scripts - Background (/sys.scripts.do)
 *   5. Click "Run script"
 *   6. Select All output → Copy → Save to a .txt file
 *
 * EXTRACTS: name, table, when (before/after/async/display), order,
 *           insert/update/delete/query operations, filter condition,
 *           condition script, full script body, description, scope,
 *           and protection policy.
 */

// ╔══════════════════════════════════════════════════════════╗
// ║  CONFIGURATION                                           ║
// ╚══════════════════════════════════════════════════════════╝

var MODE = 'table';                  // 'sys_id' or 'table'
var SYS_ID = 'PUT_YOUR_SYS_ID_HERE'; // used when MODE = 'sys_id'
var TABLE_NAME = 'incident';          // used when MODE = 'table'
var ACTIVE_ONLY = false;              // true = skip inactive rules

(function (mode, sysId, tableName, activeOnly) {

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
    function yesNo(val) {
        return (val === 'true' || val === '1' || val === true) ? 'Yes' : 'No';
    }

    // ── Validate ─────────────────────────────────────────────

    if (mode === 'sys_id' && (!sysId || sysId.indexOf('PUT_YOUR') === 0)) {
        p('ERROR: Set SYS_ID at the top of the script before running.');
        return;
    }
    if (mode === 'table' && !tableName) {
        p('ERROR: Set TABLE_NAME at the top of the script before running.');
        return;
    }
    if (mode !== 'sys_id' && mode !== 'table') {
        p('ERROR: MODE must be "sys_id" or "table".');
        return;
    }

    // ── Query business rules ─────────────────────────────────

    var grBR = new GlideRecord('sys_script');

    if (mode === 'sys_id') {
        if (!grBR.get(sysId)) {
            p('ERROR: sys_id ' + sysId + ' not found in sys_script.');
            return;
        }
        // Single record — we'll handle it in the loop below by re-querying
        grBR = new GlideRecord('sys_script');
        grBR.addQuery('sys_id', sysId);
    } else {
        grBR.addQuery('collection', tableName);
        if (activeOnly) {
            grBR.addQuery('active', true);
        }
        grBR.orderBy('when');
        grBR.orderBy('order');
    }

    grBR.query();

    // Collect all rules
    var rules = [];
    while (grBR.next()) {
        var whenMap = {
            'before':  'Before',
            'after':   'After',
            'async':   'Async',
            'display': 'Display'
        };
        var rawWhen = grBR.getValue('when') || '';

        rules.push({
            sys_id:          grBR.getValue('sys_id'),
            name:            grBR.getValue('name') || '(unnamed)',
            table:           grBR.getValue('collection') || '',
            tableDisplay:    grBR.getDisplayValue('collection') || '',
            active:          grBR.getValue('active'),
            when:            whenMap[rawWhen] || grBR.getDisplayValue('when') || rawWhen,
            order:           grBR.getValue('order') || '',
            actionInsert:    grBR.getValue('action_insert'),
            actionUpdate:    grBR.getValue('action_update'),
            actionDelete:    grBR.getValue('action_delete'),
            actionQuery:     grBR.getValue('action_query'),
            filterCondition: grBR.getValue('filter_condition') || '',
            filterDisplay:   grBR.getDisplayValue('filter_condition') || '',
            condition:       grBR.getValue('condition') || '',
            script:          grBR.getValue('script') || '',
            description:     grBR.getValue('description') || '',
            scope:           grBR.getDisplayValue('sys_scope') || '',
            updatedBy:       grBR.getValue('sys_updated_by') || '',
            updatedOn:       grBR.getDisplayValue('sys_updated_on') || '',
            createdBy:       grBR.getValue('sys_created_by') || '',
            createdOn:       grBR.getDisplayValue('sys_created_on') || '',
            protectionPolicy: grBR.getDisplayValue('sys_policy') || '',
            restMethod:      grBR.getValue('rest_method') || '',
            restMethodAccess: grBR.getValue('rest_method_text') || '',
            abortAction:     grBR.getValue('abort_action'),
            addMessage:      grBR.getValue('add_message'),
            message:         grBR.getValue('message') || '',
            roleConds:       grBR.getValue('role_conditions') || '',
            roleCondsDisplay: grBR.getDisplayValue('role_conditions') || ''
        });
    }

    if (rules.length === 0) {
        if (mode === 'table') {
            p('No business rules found on table "' + tableName + '"' +
              (activeOnly ? ' (active only)' : '') + '.');
        }
        return;
    }

    // ── Header ───────────────────────────────────────────────

    var ts = new GlideDateTime().toString();
    p(ln('=', 80));
    p('SERVICENOW BUSINESS RULES EXPORT');
    p('Extracted: ' + ts);
    if (mode === 'sys_id') {
        p('Mode: Single business rule (sys_id: ' + sysId + ')');
    } else {
        p('Mode: All business rules on table "' + tableName + '"');
        p('Active only: ' + (activeOnly ? 'Yes' : 'No'));
    }
    p('Total rules found: ' + rules.length);

    // ── Index ────────────────────────────────────────────────

    p(section('BUSINESS RULE INDEX (' + rules.length + ' rules)'));
    for (var i = 0; i < rules.length; i++) {
        var r = rules[i];
        var ops = [];
        if (yesNo(r.actionInsert) === 'Yes') ops.push('Insert');
        if (yesNo(r.actionUpdate) === 'Yes') ops.push('Update');
        if (yesNo(r.actionDelete) === 'Yes') ops.push('Delete');
        if (yesNo(r.actionQuery) === 'Yes')  ops.push('Query');
        var opsStr = ops.length > 0 ? ops.join(', ') : 'None';
        var activeStr = yesNo(r.active) === 'Yes' ? '' : ' [INACTIVE]';
        p('  ' + (i + 1) + '. ' + r.name + '  [' + r.when + '] [' + opsStr + ']' +
          '  Order: ' + r.order + activeStr);
    }

    // ── Summary by When ──────────────────────────────────────

    p(section('SUMMARY BY TIMING'));
    var byWhen = {};
    for (var si = 0; si < rules.length; si++) {
        var w = rules[si].when;
        if (!byWhen[w]) byWhen[w] = 0;
        byWhen[w]++;
    }
    for (var wk in byWhen) {
        if (byWhen.hasOwnProperty(wk)) {
            p('  ' + wk + ': ' + byWhen[wk]);
        }
    }

    // ── Details ──────────────────────────────────────────────

    p(section('BUSINESS RULE DETAILS'));

    for (var di = 0; di < rules.length; di++) {
        var info = rules[di];
        p(subsection((di + 1) + '. ' + info.name + '  [' + info.when + ']'));
        p('sys_id: ' + info.sys_id);
        p('Table: ' + info.tableDisplay + ' (' + info.table + ')');
        p('Active: ' + yesNo(info.active));
        p('When: ' + info.when);
        p('Order: ' + info.order);

        // Operations
        var operations = [];
        if (yesNo(info.actionInsert) === 'Yes') operations.push('Insert');
        if (yesNo(info.actionUpdate) === 'Yes') operations.push('Update');
        if (yesNo(info.actionDelete) === 'Yes') operations.push('Delete');
        if (yesNo(info.actionQuery) === 'Yes')  operations.push('Query');
        p('Operations: ' + (operations.length > 0 ? operations.join(', ') : 'None'));

        if (info.scope) p('Scope: ' + info.scope);
        if (info.protectionPolicy) p('Protection policy: ' + info.protectionPolicy);

        // Description
        if (info.description) {
            p('\nDESCRIPTION:');
            p(info.description);
        }

        // Abort / Message
        if (yesNo(info.abortAction) === 'Yes') {
            p('\nABORT ACTION: Yes');
            if (info.message) {
                p('MESSAGE: ' + info.message);
            }
        }

        // Role conditions
        if (info.roleConds) {
            p('\nROLE CONDITIONS:');
            p(info.roleCondsDisplay || info.roleConds);
        }

        // Filter condition
        if (info.filterCondition) {
            p('\nFILTER CONDITION:');
            if (info.filterDisplay && info.filterDisplay !== info.filterCondition) {
                p('(Readable): ' + info.filterDisplay);
            }
            p('(Encoded):  ' + info.filterCondition);
        }

        // Condition (advanced condition script)
        if (info.condition) {
            p('\nCONDITION:');
            p(info.condition);
        }

        // Script
        if (info.script) {
            p('\nSCRIPT:');
            p(info.script);
        }

        // Metadata
        p('\nMETADATA:');
        if (info.createdBy) p('  Created by: ' + info.createdBy + ' on ' + info.createdOn);
        if (info.updatedBy) p('  Updated by: ' + info.updatedBy + ' on ' + info.updatedOn);

        p('');
    }

    // ── Footer ───────────────────────────────────────────────

    p(ln('=', 80));
    p('EXPORT COMPLETE');
    p('Total business rules: ' + rules.length);
    var activeCount = 0;
    var withScript = 0;
    for (var fi = 0; fi < rules.length; fi++) {
        if (yesNo(rules[fi].active) === 'Yes') activeCount++;
        if (rules[fi].script) withScript++;
    }
    p('Active: ' + activeCount + '  |  Inactive: ' + (rules.length - activeCount));
    p('With script: ' + withScript + '  |  Without script: ' + (rules.length - withScript));
    p(ln('=', 80));

})(MODE, SYS_ID, TABLE_NAME, ACTIVE_ONLY);
