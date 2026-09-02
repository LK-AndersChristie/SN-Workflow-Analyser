// ╔══════════════════════════════════════════════════════════╗
// ║  ServiceNow Group Extractor                              ║
// ║  Everything about a sys_user_group record + dictionary   ║
// ╚══════════════════════════════════════════════════════════╝

// Accepts ANY of:
//   - sys_user_group sys_id      ('97175482c3fe4b10927038977d01315d')
//   - Entra/AD GUID              ('58a57056-174f-4ffc-9127-deac25247f90')
//   - Group name (exact or partial, e.g. 'anders testgruppe vol. 3')
//   - Group email address
var GROUP_IDENTIFIER = 'PUT_YOUR_SYS_ID_HERE';

// ── Toggles (turn off the slow ones if the script times out) ──
var SCAN_REFERENCES = true;   // count records in every table referencing this group
var SCAN_HARDCODED = true;   // find scripts/flows with this sys_id hardcoded
var SHOW_DICTIONARY = true;   // full dictionary dump for sys_user_group
var MAX_MEMBERS = 500;
var MAX_AUDIT = 100;

/**
 * ServiceNow Group Extractor — Background Script
 * ================================================================
 * EXTRACTS:
 *   1.  Group record — every populated field, with display values
 *   2.  Duplicate detection (same name / same AAD GUID / same email)
 *   3.  Group hierarchy — parent chain upward, children downward
 *   4.  Members (sys_user_grmember) + ORPHAN detection (deleted users)
 *   5.  Roles (sys_group_has_role) incl. inherited/granted-by
 *   6.  Sync provenance — Entra vs LDAP vs manual, directory_* tables
 *   7.  LDAP staging rows (u_adgroups) if the group came from AD
 *   8.  Dictionary entries for sys_user_group (+ parents) with labels,
 *       types, references, choices, defaults, attributes and help text
 *   9.  Dictionary overrides
 *  10.  Reference scan — every table/column pointing at this group,
 *       with a record count per column
 *  11.  Business rules, client scripts, UI policies, ACLs on the table
 *  12.  Audit history (sys_audit) for this record
 *  13.  Update set entries (sys_update_xml) capturing this group
 *  14.  Hardcoded sys_id usage in scripts, flows and properties
 *
 * HOW TO USE:
 *   1. Set GROUP_IDENTIFIER above
 *   2. Paste into Scripts - Background (/sys.scripts.do), scope: global
 *   3. Run script
 *   4. Select All → Copy → save as .txt next to this repo's temp/ folders
 */

(function (identifier) {

    var TABLE = 'sys_user_group';

    // ── Helpers ──────────────────────────────────────────────
    function ln(ch, len) {
        var s = '';
        for (var i = 0; i < len; i++) s += ch;
        return s;
    }
    function p(text) {
        gs.print(text);
    }
    function section(title) {
        p('\n' + ln('=', 80));
        p(title);
        p(ln('=', 80));
    }
    function subsection(title) {
        p('\n' + ln('-', 60));
        p(title);
        p(ln('-', 60));
    }
    function pad(s, n) {
        s = (s === null || s === undefined) ? '' : '' + s;
        while (s.length < n) s += ' ';
        return s;
    }
    function tableExists(name) {
        if (!name) return false;
        try {
            return new GlideRecord(name).isValid();
        } catch (e) {
            return false;
        }
    }
    function isGuid(s) {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
    }
    function isSysId(s) {
        return /^[0-9a-f]{32}$/i.test(s);
    }
    // getValue() on a boolean returns '1'/'0' on some instances and 'true'/'false' on others
    function isTrue(v) {
        return v === 'true' || v === '1';
    }

    // Print all populated fields on a GlideRecord
    function dumpFields(gr) {
        var fields = gr.getFields();
        for (var i = 0; i < fields.size(); i++) {
            var ge = fields.get(i);
            var fname = ge.getName();
            var val = ge.getValue() || '';
            if (!val) continue;
            var display = ge.getDisplayValue() || '';
            var label = ge.getLabel() || fname;
            if (display && display !== val && val.length === 32) {
                p('  ' + pad(fname, 28) + ' ' + display + '  [' + val + ']');
            } else if (val.length > 300) {
                p('  ' + pad(fname, 28) + ' (' + label + ')');
                p(val);
            } else {
                p('  ' + pad(fname, 28) + ' ' + val + (display && display !== val ? '  (' + display + ')' : ''));
            }
        }
    }

    var ts = new GlideDateTime().toString();
    p(ln('=', 80));
    p('SERVICENOW GROUP EXPORT');
    p('Instance:  ' + gs.getProperty('instance_name'));
    p('Extracted: ' + ts + ' by ' + gs.getUserName());
    p('Lookup:    ' + identifier);
    p(ln('=', 80));

    // ══════════════════════════════════════════════════════════
    // 0. RESOLVE THE GROUP
    // ══════════════════════════════════════════════════════════
    var gr = new GlideRecord(TABLE);
    var resolvedBy = '';

    if (isSysId(identifier) && gr.get(identifier)) {
        resolvedBy = 'sys_id';
    } else {
        gr = new GlideRecord(TABLE);
        var q = gr.addQuery('name', identifier);
        if (isGuid(identifier)) {
            q.addOrCondition('u_aad_object_guid', identifier);
            q.addOrCondition('u_object_guid', identifier);
        }
        q.addOrCondition('email', identifier);
        q.addOrCondition('name', 'CONTAINS', identifier);
        gr.query();
        if (gr.getRowCount() > 1) {
            p('\n*** ' + gr.getRowCount() + ' groups matched "' + identifier + '" — using the first. Candidates:');
            while (gr.next()) {
                p('    ' + gr.getValue('sys_id') + '  ' + gr.getValue('name'));
            }
            gr.rewind();
        }
        if (!gr.next()) {
            p('\n*** NO GROUP FOUND for "' + identifier + '". Aborting.');
            return;
        }
        resolvedBy = 'name/guid/email search';
    }

    var GROUP_ID = gr.getValue('sys_id');
    var GROUP_NAME = gr.getValue('name') || '(no name)';
    var AAD_GUID = gr.getValue('u_aad_object_guid') || '';
    var AD_GUID = gr.getValue('u_object_guid') || '';

    section('1. GROUP RECORD  —  ' + GROUP_NAME);
    p('  Resolved by: ' + resolvedBy);
    p('  sys_id:      ' + GROUP_ID);
    p('  Class:       ' + (gr.getValue('sys_class_name') || TABLE));
    p('  Created:     ' + gr.getValue('sys_created_on') + ' by ' + gr.getValue('sys_created_by'));
    p('  Updated:     ' + gr.getValue('sys_updated_on') + ' by ' + gr.getValue('sys_updated_by') +
        '  (updates: ' + gr.getValue('sys_mod_count') + ')');

    subsection('ALL POPULATED FIELDS');
    dumpFields(gr);

    subsection('EMPTY FIELDS');
    var emptyList = [];
    var flds = gr.getFields();
    for (var fi = 0; fi < flds.size(); fi++) {
        var fe = flds.get(fi);
        if (!fe.getValue()) emptyList.push(fe.getName());
    }
    p('  ' + (emptyList.length ? emptyList.join(', ') : '(none)'));

    // ══════════════════════════════════════════════════════════
    // 2. DUPLICATES
    // ══════════════════════════════════════════════════════════
    section('2. POSSIBLE DUPLICATES');

    function findDupes(label, field, value) {
        if (!value) return;
        var d = new GlideRecord(TABLE);
        d.addQuery(field, value);
        d.addQuery('sys_id', '!=', GROUP_ID);
        d.query();
        if (!d.hasNext()) {
            p('  ' + label + ': none');
            return;
        }
        p('  ' + label + ' (' + d.getRowCount() + '):');
        while (d.next()) {
            p('    ' + d.getValue('sys_id') + '  active=' + d.getValue('active') +
                '  ' + d.getValue('name') + '  created ' + d.getValue('sys_created_on'));
        }
    }
    findDupes('Same name', 'name', GROUP_NAME);
    findDupes('Same AAD GUID', 'u_aad_object_guid', AAD_GUID);
    findDupes('Same AD objectGUID', 'u_object_guid', AD_GUID);
    findDupes('Same email', 'email', gr.getValue('email'));

    // ══════════════════════════════════════════════════════════
    // 3. HIERARCHY
    // ══════════════════════════════════════════════════════════
    section('3. GROUP HIERARCHY');

    subsection('PARENT CHAIN (upward)');
    var parentId = gr.getValue('parent');
    var depth = 0;
    var seen = {};
    seen[GROUP_ID] = true;
    if (!parentId) p('  (no parent — this is a root group)');
    while (parentId && depth < 20 && !seen[parentId]) {
        seen[parentId] = true;
        var pg = new GlideRecord(TABLE);
        if (!pg.get(parentId)) {
            p('  ' + ln(' ', depth * 2) + '└─ ORPHAN parent reference: ' + parentId);
            break;
        }
        p('  ' + ln(' ', depth * 2) + '└─ ' + pg.getValue('name') + '  [' + parentId + ']');
        parentId = pg.getValue('parent');
        depth++;
    }

    subsection('CHILD GROUPS (direct)');
    var cg = new GlideRecord(TABLE);
    cg.addQuery('parent', GROUP_ID);
    cg.orderBy('name');
    cg.query();
    if (!cg.hasNext()) p('  (none)');
    while (cg.next()) {
        p('  ' + pad(cg.getValue('name'), 50) + ' active=' + cg.getValue('active') + '  [' + cg.getValue('sys_id') + ']');
    }

    // Nested-group M2M used by the LDAP transform maps
    if (tableExists('u_memberof_slk')) {
        subsection('u_memberof_slk (LDAP nested-group M2M)');
        var moCols = [];
        var moDict = new GlideRecord('sys_dictionary');
        moDict.addQuery('name', 'u_memberof_slk');
        moDict.addQuery('reference', TABLE);
        moDict.addNotNullQuery('element');
        moDict.query();
        while (moDict.next()) moCols.push(moDict.getValue('element'));

        var moFound = 0;
        for (var mc = 0; mc < moCols.length; mc++) {
            var mo = new GlideRecord('u_memberof_slk');
            mo.addQuery(moCols[mc], GROUP_ID);
            mo.setLimit(200);
            mo.query();
            while (mo.next()) {
                moFound++;
                var parts = [];
                for (var mj = 0; mj < moCols.length; mj++) {
                    parts.push(moCols[mj] + '=' + mo.getDisplayValue(moCols[mj]));
                }
                p('  via ' + moCols[mc] + ':  ' + parts.join(' | '));
            }
        }
        if (!moCols.length) p('  (no columns on u_memberof_slk reference sys_user_group)');
        else if (!moFound) p('  (no rows reference this group)');
    }

    // ══════════════════════════════════════════════════════════
    // 4. MEMBERS
    // ══════════════════════════════════════════════════════════
    section('4. MEMBERS (sys_user_grmember)');

    var mem = new GlideRecord('sys_user_grmember');
    mem.addQuery('group', GROUP_ID);
    mem.orderBy('user');
    mem.query();
    var total = mem.getRowCount();
    p('  Total membership rows: ' + total);

    var orphans = [];
    var inactive = [];
    var shown = 0;
    p('');
    p('  ' + pad('USER SYS_ID', 34) + pad('USER NAME', 20) + pad('DISPLAY', 30) + pad('ACTIVE', 8) + 'CREATED BY');
    p('  ' + ln('-', 110));
    while (mem.next() && shown < MAX_MEMBERS) {
        shown++;
        var uid = mem.getValue('user');
        var u = new GlideRecord('sys_user');
        if (!u.get(uid)) {
            orphans.push({ grm: mem.getValue('sys_id'), user: uid, by: mem.getValue('sys_created_by'), on: mem.getValue('sys_created_on') });
            p('  ' + pad(uid, 34) + pad('*** DELETED USER ***', 50) + pad('', 8) + mem.getValue('sys_created_by'));
            continue;
        }
        if (!isTrue(u.getValue('active'))) inactive.push(u.getValue('user_name'));
        p('  ' + pad(uid, 34) + pad(u.getValue('user_name'), 20) + pad(u.getValue('name'), 30) +
            pad(u.getValue('active'), 8) + mem.getValue('sys_created_by'));
    }
    if (total > MAX_MEMBERS) p('  ... ' + (total - MAX_MEMBERS) + ' more (raise MAX_MEMBERS)');

    p('');
    p('  Orphan memberships (user record deleted): ' + orphans.length);
    for (var oi = 0; oi < orphans.length; oi++) {
        p('    grmember ' + orphans[oi].grm + ' → missing user ' + orphans[oi].user +
            '  created ' + orphans[oi].on + ' by ' + orphans[oi].by);
    }
    p('  Inactive members: ' + inactive.length + (inactive.length ? ' — ' + inactive.join(', ') : ''));

    // Who creates the memberships? (tells you Entra vs LDAP vs manual)
    subsection('MEMBERSHIP PROVENANCE (created_by breakdown)');
    var agg = new GlideAggregate('sys_user_grmember');
    agg.addQuery('group', GROUP_ID);
    agg.groupBy('sys_created_by');
    agg.addAggregate('COUNT');
    agg.query();
    while (agg.next()) {
        p('  ' + pad(agg.getValue('sys_created_by'), 25) + agg.getAggregate('COUNT'));
    }

    // ══════════════════════════════════════════════════════════
    // 5. ROLES
    // ══════════════════════════════════════════════════════════
    section('5. ROLES (sys_group_has_role)');
    var ro = new GlideRecord('sys_group_has_role');
    ro.addQuery('group', GROUP_ID);
    ro.orderBy('role');
    ro.query();
    if (!ro.hasNext()) p('  (none)');
    while (ro.next()) {
        p('  ' + pad(ro.getDisplayValue('role'), 40) +
            'inherited=' + ro.getValue('inherited') +
            '  granted_by=' + (ro.getDisplayValue('granted_by') || '-') +
            '  [' + ro.getValue('role') + ']');
    }

    // ══════════════════════════════════════════════════════════
    // 6. SYNC PROVENANCE
    // ══════════════════════════════════════════════════════════
    section('6. SYNC PROVENANCE');
    p('  u_aad_object_guid (Entra Object ID): ' + (AAD_GUID || '(empty)'));
    p('  u_object_guid (on-prem AD GUID):     ' + (AD_GUID || '(empty)'));
    p('  source:                              ' + (gr.getValue('source') || '(empty)'));
    p('  created by:                          ' + gr.getValue('sys_created_by'));
    p('');
    if (AAD_GUID && AD_GUID) p('  → HYBRID: exists in on-prem AD and Entra ID');
    else if (AAD_GUID) p('  → CLOUD-ONLY: Entra ID group (written by the Entra Provisioning Service)');
    else if (AD_GUID) p('  → ON-PREM: synced by the LDAP scheduled import');
    else p('  → LOCAL: created manually in ServiceNow, no directory GUID');

    // directory_* tables (Entra spoke cache)
    if (tableExists('directory_group')) {
        subsection('directory_group (Entra spoke cache)');
        var dg = new GlideRecord('directory_group');
        if (AAD_GUID) dg.addQuery('external_id', AAD_GUID);
        else dg.addQuery('name', GROUP_NAME);
        dg.query();
        if (!dg.hasNext()) p('  (no matching directory_group record)');
        while (dg.next()) {
            p('  sys_id: ' + dg.getValue('sys_id'));
            p('  name: ' + dg.getValue('name'));
            p('  external_id: ' + dg.getValue('external_id'));
            p('  integration: ' + dg.getDisplayValue('directory_integration'));
            p('  updated: ' + dg.getValue('sys_updated_on') + ' by ' + dg.getValue('sys_updated_by'));

            if (tableExists('m2m_directory_group_user')) {
                var m2 = new GlideAggregate('m2m_directory_group_user');
                m2.addQuery('directory_group', dg.getValue('sys_id'));
                m2.addAggregate('COUNT');
                m2.query();
                if (m2.next()) p('  m2m_directory_group_user rows: ' + m2.getAggregate('COUNT'));
            }
        }
    }

    // LDAP staging rows
    if (AD_GUID && tableExists('u_adgroups')) {
        subsection('u_adgroups (LDAP import staging)');
        var st = new GlideRecord('u_adgroups');
        st.addQuery('u_objectguid', AD_GUID);
        st.orderByDesc('sys_created_on');
        st.setLimit(5);
        st.query();
        if (!st.hasNext()) p('  (no staging rows for this objectGUID)');
        while (st.next()) {
            p('  --- import row ' + st.getValue('sys_id') + ' (' + st.getValue('sys_created_on') + ') ---');
            dumpFields(st);
        }
    }

    // ══════════════════════════════════════════════════════════
    // 7. DICTIONARY
    // ══════════════════════════════════════════════════════════
    if (SHOW_DICTIONARY) {
        section('7. DICTIONARY — sys_user_group and parents');

        var tables = [];
        try {
            var tu = new TableUtils(gr.getValue('sys_class_name') || TABLE);
            var jl = tu.getTables();
            for (var ti = 0; ti < jl.size(); ti++) tables.push('' + jl.get(ti));
        } catch (e) {
            tables = [TABLE];
        }
        p('  Table hierarchy: ' + tables.join(' → '));

        var dict = new GlideRecord('sys_dictionary');
        dict.addQuery('name', 'IN', tables.join(','));
        dict.addNotNullQuery('element');
        dict.orderBy('element');
        dict.query();

        p('');
        p('  ' + pad('COLUMN', 30) + pad('LABEL', 30) + pad('TYPE', 16) + pad('LEN', 7) +
            pad('MAND', 6) + pad('RO', 4) + 'REFERENCE / EXTRA');
        p('  ' + ln('-', 130));
        var customFields = [];
        var refCols = [];
        while (dict.next()) {
            var el = dict.getValue('element');
            var extra = [];
            if (dict.getValue('reference')) extra.push('→ ' + dict.getValue('reference'));
            if (dict.getValue('default_value')) extra.push('default=' + dict.getValue('default_value'));
            if (dict.getValue('choice') && dict.getValue('choice') !== '0') extra.push('choice=' + dict.getDisplayValue('choice'));
            if (isTrue(dict.getValue('display'))) extra.push('DISPLAY');
            if (isTrue(dict.getValue('unique'))) extra.push('UNIQUE');
            if (!isTrue(dict.getValue('active'))) extra.push('INACTIVE');
            if (isTrue(dict.getValue('virtual'))) extra.push('VIRTUAL');
            if (dict.getValue('dependent')) extra.push('dependent=' + dict.getValue('dependent'));
            if (dict.getValue('attributes')) extra.push('attr:' + dict.getValue('attributes'));
            if (dict.getValue('name') !== TABLE) extra.push('(from ' + dict.getValue('name') + ')');

            p('  ' + pad(el, 30) + pad(dict.getValue('column_label'), 30) +
                pad(dict.getDisplayValue('internal_type'), 16) +
                pad(dict.getValue('max_length'), 7) +
                pad(isTrue(dict.getValue('mandatory')) ? 'YES' : '', 6) +
                pad(isTrue(dict.getValue('read_only')) ? 'RO' : '', 4) +
                extra.join('  '));

            if (dict.getValue('comments')) p('  ' + pad('', 30) + 'comment: ' + dict.getValue('comments'));
            if (el.indexOf('u_') === 0) customFields.push(el);
            if (dict.getValue('internal_type') + '' === 'reference') refCols.push(el);
        }

        subsection('CUSTOM FIELDS ON THIS TABLE (u_*)');
        p('  ' + (customFields.length ? customFields.join(', ') : '(none)'));

        // Help / hint text
        subsection('FIELD HELP TEXT (sys_documentation)');
        var doc = new GlideRecord('sys_documentation');
        doc.addQuery('name', 'IN', tables.join(','));
        doc.addQuery('language', 'en');
        doc.query();
        var docCount = 0;
        while (doc.next()) {
            var hint = doc.getValue('hint');
            var help = doc.getValue('help');
            if (!hint && !help) continue;
            docCount++;
            p('  ' + pad(doc.getValue('element'), 30) + (hint || '') + (help ? ' | help: ' + help : ''));
        }
        if (!docCount) p('  (no hint/help text defined)');

        // Choice lists
        subsection('CHOICE LISTS (sys_choice)');
        var ch = new GlideRecord('sys_choice');
        ch.addQuery('name', 'IN', tables.join(','));
        ch.addQuery('language', 'en');
        ch.orderBy('element');
        ch.orderBy('sequence');
        ch.query();
        var lastEl = '';
        if (!ch.hasNext()) p('  (none)');
        while (ch.next()) {
            if (ch.getValue('element') !== lastEl) {
                lastEl = ch.getValue('element');
                p('  ' + lastEl + ':');
            }
            p('    ' + pad(ch.getValue('value'), 30) + ch.getValue('label') +
                (isTrue(ch.getValue('inactive')) ? '  [INACTIVE]' : ''));
        }

        // Dictionary overrides
        subsection('DICTIONARY OVERRIDES (sys_dictionary_override)');
        var ov = new GlideRecord('sys_dictionary_override');
        ov.addQuery('name', 'IN', tables.join(','));
        ov.query();
        if (!ov.hasNext()) p('  (none)');
        while (ov.next()) {
            p('  ' + pad(ov.getValue('element'), 30) + 'base=' + ov.getValue('base_table') +
                '  mandatory=' + ov.getValue('mandatory') + '  default=' + ov.getValue('default_value'));
        }
    }

    // ══════════════════════════════════════════════════════════
    // 8. REFERENCE SCAN — who points at this group?
    // ══════════════════════════════════════════════════════════
    if (SCAN_REFERENCES) {
        section('8. REFERENCE SCAN — tables/columns referencing this group');
        p('  (only columns with at least one matching record are shown)');
        p('');

        var refDict = new GlideRecord('sys_dictionary');
        refDict.addQuery('reference', TABLE);
        refDict.addQuery('active', true);
        refDict.addNotNullQuery('element');
        refDict.orderBy('name');
        refDict.query();

        var scanned = 0, hits = 0;
        while (refDict.next()) {
            var t = refDict.getValue('name');
            var c = refDict.getValue('element');
            if (!tableExists(t)) continue;
            scanned++;
            try {
                var ca = new GlideAggregate(t);
                ca.addQuery(c, GROUP_ID);
                ca.addAggregate('COUNT');
                ca.query();
                if (!ca.next()) continue;
                var n = parseInt(ca.getAggregate('COUNT'), 10);
                if (!n) continue;
                hits++;
                p('  ' + pad(t + '.' + c, 55) + pad(n, 8) + 'record(s)   [' + refDict.getValue('column_label') + ']');
            } catch (e2) {
                p('  ' + pad(t + '.' + c, 55) + 'ERROR: ' + e2);
            }
        }
        p('');
        p('  Columns scanned: ' + scanned + '   with references: ' + hits);
    }

    // ══════════════════════════════════════════════════════════
    // 9. TABLE LOGIC
    // ══════════════════════════════════════════════════════════
    section('9. LOGIC ATTACHED TO sys_user_group');

    subsection('BUSINESS RULES');
    var br = new GlideRecord('sys_script');
    br.addQuery('collection', TABLE);
    br.orderByDesc('active');
    br.orderBy('order');
    br.query();
    if (!br.hasNext()) p('  (none)');
    while (br.next()) {
        var when = [];
        if (isTrue(br.getValue('action_insert'))) when.push('insert');
        if (isTrue(br.getValue('action_update'))) when.push('update');
        if (isTrue(br.getValue('action_delete'))) when.push('delete');
        if (isTrue(br.getValue('action_query'))) when.push('query');
        p('  [' + (isTrue(br.getValue('active')) ? 'ACTIVE ' : 'inactive') + '] ' +
            pad(br.getValue('name'), 45) +
            'when=' + br.getValue('when') + ' order=' + br.getValue('order') +
            ' on=' + when.join(',') + '  [' + br.getValue('sys_id') + ']');
        if (br.getValue('condition')) p('      condition: ' + br.getValue('condition'));
        if (br.getValue('filter_condition')) p('      filter: ' + br.getValue('filter_condition'));
    }

    subsection('CLIENT SCRIPTS');
    var cs = new GlideRecord('sys_script_client');
    cs.addQuery('table', TABLE);
    cs.query();
    if (!cs.hasNext()) p('  (none)');
    while (cs.next()) {
        p('  [' + (isTrue(cs.getValue('active')) ? 'ACTIVE ' : 'inactive') + '] ' +
            pad(cs.getValue('name'), 45) + 'type=' + cs.getValue('type') +
            ' field=' + (cs.getValue('field') || '-'));
    }

    subsection('UI POLICIES');
    var up = new GlideRecord('sys_ui_policy');
    up.addQuery('table', TABLE);
    up.query();
    if (!up.hasNext()) p('  (none)');
    while (up.next()) {
        p('  [' + (isTrue(up.getValue('active')) ? 'ACTIVE ' : 'inactive') + '] ' +
            pad(up.getValue('short_description'), 60) + 'cond: ' + up.getValue('conditions'));
    }

    subsection('ACLs');
    var acl = new GlideRecord('sys_security_acl');
    acl.addQuery('name', 'STARTSWITH', TABLE);
    acl.orderBy('name');
    acl.query();
    if (!acl.hasNext()) p('  (none)');
    while (acl.next()) {
        var roles = [];
        var ar = new GlideRecord('sys_security_acl_role');
        ar.addQuery('sys_security_acl', acl.getValue('sys_id'));
        ar.query();
        while (ar.next()) roles.push(ar.getDisplayValue('sys_user_role'));
        p('  [' + (isTrue(acl.getValue('active')) ? 'ACTIVE ' : 'inactive') + '] ' +
            pad(acl.getValue('name'), 45) + pad(acl.getValue('operation'), 12) +
            'roles: ' + (roles.join(', ') || '-') +
            (acl.getValue('condition') ? '  cond: ' + acl.getValue('condition') : ''));
    }

    // ══════════════════════════════════════════════════════════
    // 10. AUDIT HISTORY
    // ══════════════════════════════════════════════════════════
    section('10. AUDIT HISTORY (sys_audit)');
    var au = new GlideRecord('sys_audit');
    au.addQuery('tablename', TABLE);
    au.addQuery('documentkey', GROUP_ID);
    au.orderByDesc('sys_created_on');
    au.setLimit(MAX_AUDIT);
    au.query();
    if (!au.hasNext()) p('  (no audit rows — auditing may be disabled on sys_user_group)');
    while (au.next()) {
        p('  ' + pad(au.getValue('sys_created_on'), 22) + pad(au.getValue('user'), 15) +
            pad(au.getValue('fieldname'), 25) +
            '"' + (au.getValue('oldvalue') || '') + '" → "' + (au.getValue('newvalue') || '') + '"');
    }

    // ══════════════════════════════════════════════════════════
    // 11. UPDATE SET ENTRIES
    // ══════════════════════════════════════════════════════════
    section('11. UPDATE SET ENTRIES (sys_update_xml)');
    var ux = new GlideRecord('sys_update_xml');
    ux.addQuery('name', TABLE + '_' + GROUP_ID);
    ux.orderByDesc('sys_created_on');
    ux.setLimit(20);
    ux.query();
    if (!ux.hasNext()) p('  (none — group is data, not usually captured in update sets)');
    while (ux.next()) {
        p('  ' + pad(ux.getValue('sys_created_on'), 22) + pad(ux.getValue('sys_created_by'), 15) +
            pad(ux.getValue('action'), 10) + 'set: ' + ux.getDisplayValue('update_set'));
    }

    // ══════════════════════════════════════════════════════════
    // 12. HARDCODED SYS_ID USAGE
    // ══════════════════════════════════════════════════════════
    if (SCAN_HARDCODED) {
        section('12. HARDCODED USAGE OF ' + GROUP_ID);

        var scanTargets = [
            ['sys_script', 'script', 'name'],
            ['sys_script_include', 'script', 'name'],
            ['sys_script_client', 'script', 'name'],
            ['sys_ui_action', 'script', 'name'],
            ['sysevent_script_action', 'script', 'name'],
            ['sysauto_script', 'script', 'name'],
            ['sys_processor', 'script', 'name'],
            ['sys_transform_script', 'script', 'map'],
            ['sys_ws_operation', 'operation_script', 'name'],
            ['sys_properties', 'value', 'name'],
            ['wf_activity', 'vars', 'name'],
            ['sys_variable_value', 'value', 'document_key']
        ];

        var anyHit = false;
        for (var si2 = 0; si2 < scanTargets.length; si2++) {
            var tn = scanTargets[si2][0], col = scanTargets[si2][1], lbl = scanTargets[si2][2];
            if (!tableExists(tn)) continue;
            try {
                var sc = new GlideRecord(tn);
                sc.addQuery(col, 'CONTAINS', GROUP_ID);
                sc.setLimit(25);
                sc.query();
                while (sc.next()) {
                    anyHit = true;
                    p('  ' + pad(tn, 25) + (sc.getDisplayValue(lbl) || sc.getValue('sys_id')) +
                        '  [' + sc.getValue('sys_id') + ']');
                }
            } catch (e3) {
                p('  ' + pad(tn, 25) + 'scan failed: ' + e3);
            }
        }
        if (!anyHit) p('  (sys_id not hardcoded anywhere scannable)');
    }

    // ══════════════════════════════════════════════════════════
    // SUMMARY
    // ══════════════════════════════════════════════════════════
    section('SUMMARY');
    p('  Group:              ' + GROUP_NAME);
    p('  sys_id:             ' + GROUP_ID);
    p('  Active:             ' + gr.getValue('active'));
    p('  Type:               ' + (gr.getDisplayValue('type') || '(none)'));
    p('  Manager:            ' + (gr.getDisplayValue('manager') || '(none)'));
    p('  Parent:             ' + (gr.getDisplayValue('parent') || '(none)'));
    p('  Members:            ' + total + '  (orphans: ' + orphans.length + ', inactive: ' + inactive.length + ')');
    p('  Entra GUID:         ' + (AAD_GUID || '-'));
    p('  On-prem AD GUID:    ' + (AD_GUID || '-'));
    p('  Created:            ' + gr.getValue('sys_created_on') + ' by ' + gr.getValue('sys_created_by'));
    p('');
    p('END OF EXPORT — ' + new GlideDateTime().toString());

})(GROUP_IDENTIFIER);
