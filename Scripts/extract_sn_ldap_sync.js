// ╔══════════════════════════════════════════════════════════╗
// ║  LDAP / Azure AD Sync Extractor                          ║
// ║  Extracts the full import pipeline configuration          ║
// ╚══════════════════════════════════════════════════════════╝

// From the URL: scheduled_import_set.do?sys_id=...
var SCHEDULED_IMPORT_SYS_ID = '63dba201db6c1c50469e65b3059619f5';

// From the URL: sys_data_source.do?sys_id=...
var DATA_SOURCE_SYS_ID = '07126a09db2c1c50469e65b3059619e7';

// A sample import set to inspect rows/results (sys_import_set.do?sys_id=...)
var SAMPLE_IMPORT_SET_SYS_ID = '740c2bb9c37a4b10927038977d013154';

/**
 * ServiceNow LDAP / Azure AD Sync Extractor — Background Script
 * ================================================================
 * Extracts the complete LDAP import pipeline so you can understand
 * how Azure AD data flows into ServiceNow.
 *
 * EXTRACTS:
 *   1. Scheduled Import definition (schedule, frequency, run-as)
 *   2. Data Source config (LDAP server, query, attributes, target table)
 *   3. LDAP Server config (host, port, login DN, SSL, MID server)
 *   4. LDAP OU definitions (base DN, filters, attribute maps)
 *   5. Transform Maps (which map import staging → target table)
 *   6. Field Maps within each Transform Map (source→target column mappings)
 *   7. Transform Scripts (onBefore, onAfter, onStart, onComplete, onForeignInsert)
 *   8. Sample Import Set run (state, row count, completion, errors)
 *   9. Sample Import Set Rows (first 20 rows with all staging columns)
 *  10. Import Set Run history (last 10 runs with status/counts)
 *  11. Coalesce/matching rules (how duplicates are detected)
 *  12. Related business rules on the target table
 *  13. All active LDAP data sources and scheduled imports (for context)
 *
 * HOW TO USE:
 *   1. Set the sys_ids above (or leave defaults for your AD Azure Resources import)
 *   2. Paste into Scripts - Background (/sys.scripts.do)
 *   3. Run script
 *   4. Select All → Copy → Save to a .txt file
 */

(function (scheduledImportId, dataSourceId, sampleImportSetId) {

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

    // Print all non-empty fields on a GlideRecord
    function dumpFields(gr, skipFields) {
        var skip = {};
        if (skipFields) {
            for (var si = 0; si < skipFields.length; si++) skip[skipFields[si]] = true;
        }
        var fields = gr.getFields();
        for (var i = 0; i < fields.size(); i++) {
            var ge = fields.get(i);
            var fname = ge.getName();
            if (skip[fname]) continue;
            if (fname.indexOf('sys_') === 0 &&
                fname !== 'sys_id' && fname !== 'sys_scope' &&
                fname !== 'sys_created_on' && fname !== 'sys_updated_on' &&
                fname !== 'sys_created_by' && fname !== 'sys_updated_by' &&
                fname !== 'sys_class_name') continue;
            var val = ge.getValue() || '';
            if (!val) continue;
            var display = ge.getDisplayValue() || '';
            var label = ge.getLabel() || fname;
            if (display && display !== val && val.length === 32) {
                p('  ' + label + ': ' + display + '  [' + val + ']');
            } else if (val.length > 300) {
                p('  ' + label + ':');
                p(val);
            } else {
                p('  ' + label + ': ' + val);
            }
        }
    }

    var ts = new GlideDateTime().toString();
    p(ln('=', 80));
    p('SERVICENOW LDAP / AZURE AD SYNC PIPELINE EXPORT');
    p('Extracted: ' + ts);
    p(ln('=', 80));

    // ══════════════════════════════════════════════════════════
    // 1. SCHEDULED IMPORT
    // ══════════════════════════════════════════════════════════
    p(section('1. SCHEDULED IMPORT'));

    var grSched = new GlideRecord('scheduled_import_set');
    if (grSched.get(scheduledImportId)) {
        p('  Name: ' + (grSched.getValue('name') || ''));
        p('  sys_id: ' + scheduledImportId);
        p('  Active: ' + (grSched.getValue('active') || ''));
        p('  Run type: ' + (grSched.getDisplayValue('run_type') || grSched.getValue('run_type') || ''));
        p('  Run as: ' + (grSched.getDisplayValue('run_as') || ''));
        p('  Data source: ' + (grSched.getDisplayValue('data_source') || ''));
        if (grSched.getValue('run_start')) p('  Run start: ' + grSched.getDisplayValue('run_start'));
        if (grSched.getValue('run_period')) p('  Run period: ' + grSched.getDisplayValue('run_period'));
        if (grSched.getValue('run_time')) p('  Run time: ' + grSched.getDisplayValue('run_time'));
        if (grSched.getValue('run_dayofweek')) p('  Run day of week: ' + grSched.getDisplayValue('run_dayofweek'));
        if (grSched.getValue('run_dayofmonth')) p('  Run day of month: ' + grSched.getValue('run_dayofmonth'));

        p(subsection('ALL SCHEDULED IMPORT FIELDS'));
        dumpFields(grSched, []);

        // Derive data source if not explicitly provided
        if (!dataSourceId && grSched.getValue('data_source')) {
            dataSourceId = grSched.getValue('data_source');
            p('\n  (Data source sys_id derived from scheduled import: ' + dataSourceId + ')');
        }
    } else {
        p('  WARNING: Scheduled import ' + scheduledImportId + ' not found.');
    }

    // ══════════════════════════════════════════════════════════
    // 2. DATA SOURCE
    // ══════════════════════════════════════════════════════════
    p(section('2. DATA SOURCE'));

    var targetTable = '';
    var importSetTable = '';
    var ldapServerRef = '';

    var grDS = new GlideRecord('sys_data_source');
    if (grDS.get(dataSourceId)) {
        p('  Name: ' + (grDS.getValue('name') || ''));
        p('  sys_id: ' + dataSourceId);
        p('  Type: ' + (grDS.getDisplayValue('type') || grDS.getValue('type') || ''));
        p('  Active: ' + (grDS.getValue('active') || ''));
        p('  Import set table: ' + (grDS.getValue('import_set_table_name') || ''));
        p('  Target table: ' + (grDS.getDisplayValue('table') || grDS.getValue('table') || ''));

        targetTable = grDS.getValue('table') || '';
        importSetTable = grDS.getValue('import_set_table_name') || '';

        // LDAP-specific fields
        if (grDS.getValue('connection_url')) p('  Connection URL: ' + grDS.getValue('connection_url'));
        if (grDS.getValue('ldap_target')) {
            ldapServerRef = grDS.getValue('ldap_target');
            p('  LDAP server: ' + grDS.getDisplayValue('ldap_target') + '  [' + ldapServerRef + ']');
        }
        if (grDS.getValue('ldap_boolean')) p('  LDAP boolean: ' + grDS.getValue('ldap_boolean'));
        if (grDS.getValue('query')) p('  Query/Filter: ' + grDS.getValue('query'));
        if (grDS.getValue('properties')) {
            p('  Properties/Attributes:');
            p(grDS.getValue('properties'));
        }

        p(subsection('ALL DATA SOURCE FIELDS'));
        dumpFields(grDS, []);
    } else {
        p('  WARNING: Data source ' + dataSourceId + ' not found.');
    }

    // ══════════════════════════════════════════════════════════
    // 3. LDAP SERVER CONFIGURATION
    // ══════════════════════════════════════════════════════════
    p(section('3. LDAP SERVER CONFIGURATION'));

    if (ldapServerRef) {
        var grLdap = new GlideRecord('ldap_server_config');
        if (grLdap.get(ldapServerRef)) {
            p('  Name: ' + (grLdap.getValue('name') || ''));
            p('  sys_id: ' + ldapServerRef);
            p('  Server URL: ' + (grLdap.getValue('server_url') || ''));
            p('  Active: ' + (grLdap.getValue('active') || ''));
            if (grLdap.getValue('login_distinguished_name')) p('  Login DN: ' + grLdap.getValue('login_distinguished_name'));
            if (grLdap.getValue('connect_timeout')) p('  Connect timeout: ' + grLdap.getValue('connect_timeout'));
            if (grLdap.getValue('read_timeout')) p('  Read timeout: ' + grLdap.getValue('read_timeout'));
            if (grLdap.getValue('ssl')) p('  SSL: ' + grLdap.getValue('ssl'));
            if (grLdap.getValue('mid_server')) p('  MID Server: ' + grLdap.getDisplayValue('mid_server'));
            if (grLdap.getValue('vendor')) p('  Vendor: ' + grLdap.getDisplayValue('vendor'));
            if (grLdap.getValue('paging')) p('  Paging: ' + grLdap.getValue('paging'));
            if (grLdap.getValue('listening')) p('  Listener active: ' + grLdap.getValue('listening'));

            p(subsection('ALL LDAP SERVER FIELDS'));
            dumpFields(grLdap, ['login_password', 'password']);
        } else {
            p('  WARNING: LDAP server config ' + ldapServerRef + ' not found.');
        }

        // ── LDAP OU Definitions ──────────────────────────────
        p(subsection('LDAP OU DEFINITIONS'));
        var grOU = new GlideRecord('ldap_ou_config');
        grOU.addQuery('server', ldapServerRef);
        grOU.orderBy('name');
        grOU.query();
        var ouCount = 0;
        while (grOU.next()) {
            ouCount++;
            p('  ' + ouCount + '. ' + (grOU.getValue('name') || '(unnamed)'));
            p('     sys_id: ' + grOU.getUniqueValue());
            p('     Active: ' + (grOU.getValue('active') || ''));
            if (grOU.getValue('dn')) p('     Base DN: ' + grOU.getValue('dn'));
            if (grOU.getValue('filter')) p('     LDAP Filter: ' + grOU.getValue('filter'));
            if (grOU.getValue('query_field')) p('     Query field: ' + grOU.getValue('query_field'));
            if (grOU.getValue('table')) p('     Target table: ' + grOU.getDisplayValue('table'));
            if (grOU.getValue('default_values')) p('     Default values: ' + grOU.getValue('default_values'));
            if (grOU.getValue('attributes')) {
                p('     Attributes:');
                p(grOU.getValue('attributes'));
            }
            p('');
        }
        if (ouCount === 0) p('  (no OU definitions found for this LDAP server)');
    } else {
        p('  (no LDAP server reference found on data source — may use connection_url directly)');

        // Try to find LDAP server configs anyway
        var grLdapAll = new GlideRecord('ldap_server_config');
        grLdapAll.addQuery('active', true);
        grLdapAll.query();
        var ldapCount = 0;
        while (grLdapAll.next()) {
            if (ldapCount === 0) p('\n  Active LDAP server configs on instance:');
            ldapCount++;
            p('    ' + ldapCount + '. ' + grLdapAll.getValue('name') + '  [' + grLdapAll.getUniqueValue() + ']');
            p('       URL: ' + (grLdapAll.getValue('server_url') || ''));
        }
        if (ldapCount === 0) p('  (no active LDAP server configs found)');
    }

    // ══════════════════════════════════════════════════════════
    // 4. TRANSFORM MAPS
    // ══════════════════════════════════════════════════════════
    p(section('4. TRANSFORM MAPS'));

    // Find transform maps by import set table name (primary method)
    var transformMaps = [];
    if (importSetTable) {
        var grTM = new GlideRecord('sys_transform_map');
        grTM.addQuery('source_table', importSetTable);
        grTM.orderBy('order');
        grTM.query();
        while (grTM.next()) {
            transformMaps.push({
                sys_id: grTM.getUniqueValue(),
                name: grTM.getValue('name') || '',
                source: grTM.getValue('source_table') || '',
                target: grTM.getValue('target_table') || grTM.getDisplayValue('target_table') || '',
                active: grTM.getValue('active') || '',
                order: grTM.getValue('order') || '',
                runBR: grTM.getValue('run_business_rules') || '',
                enforceACL: grTM.getValue('enforce_mandatory') || ''
            });
        }
    }

    // Also search by data source reference
    if (transformMaps.length === 0) {
        var grTM2 = new GlideRecord('sys_transform_map');
        grTM2.addQuery('data_source', dataSourceId);
        grTM2.orderBy('order');
        grTM2.query();
        while (grTM2.next()) {
            transformMaps.push({
                sys_id: grTM2.getUniqueValue(),
                name: grTM2.getValue('name') || '',
                source: grTM2.getValue('source_table') || '',
                target: grTM2.getValue('target_table') || grTM2.getDisplayValue('target_table') || '',
                active: grTM2.getValue('active') || '',
                order: grTM2.getValue('order') || '',
                runBR: grTM2.getValue('run_business_rules') || '',
                enforceACL: grTM2.getValue('enforce_mandatory') || ''
            });
        }
    }

    p('  Found ' + transformMaps.length + ' transform map(s) for import set table: ' + importSetTable);
    p('');

    for (var tmi = 0; tmi < transformMaps.length; tmi++) {
        var tm = transformMaps[tmi];
        p(subsection('TRANSFORM MAP ' + (tmi + 1) + ': ' + tm.name));
        p('  sys_id: ' + tm.sys_id);
        p('  Active: ' + tm.active);
        p('  Order: ' + tm.order);
        p('  Source table: ' + tm.source);
        p('  Target table: ' + tm.target);
        p('  Run business rules: ' + tm.runBR);

        // Read full record for additional fields
        var grTMFull = new GlideRecord('sys_transform_map');
        if (grTMFull.get(tm.sys_id)) {
            if (grTMFull.getValue('copy_empty_fields') !== null) p('  Copy empty fields: ' + grTMFull.getValue('copy_empty_fields'));
            if (grTMFull.getValue('update_only')) p('  Update only (no insert): ' + grTMFull.getValue('update_only'));
            if (grTMFull.getValue('enforce_mandatory') !== null) p('  Enforce mandatory: ' + grTMFull.getValue('enforce_mandatory'));
            if (grTMFull.getValue('delete_source_record')) p('  Delete source after transform: ' + grTMFull.getValue('delete_source_record'));

            p(subsection('ALL TRANSFORM MAP FIELDS'));
            dumpFields(grTMFull, []);
        }

        // ── 4a. Field Maps (sys_transform_entry) ────────────
        p(subsection('FIELD MAPPINGS FOR: ' + tm.name));
        var grFM = new GlideRecord('sys_transform_entry');
        grFM.addQuery('map', tm.sys_id);
        grFM.orderBy('order');
        grFM.query();
        var fmCount = 0;
        while (grFM.next()) {
            fmCount++;
            var srcField = grFM.getValue('source_field') || grFM.getDisplayValue('source_field') || '';
            var tgtField = grFM.getValue('target_field') || grFM.getDisplayValue('target_field') || '';
            var coalesce = grFM.getValue('coalesce') || 'false';
            var useSource = grFM.getValue('use_source_script') || 'false';
            var script = grFM.getValue('source_script') || '';
            var refQual = grFM.getValue('reference_qualifier') || '';
            var choiceAction = grFM.getDisplayValue('choice_action') || grFM.getValue('choice_action') || '';
            var dateFormat = grFM.getValue('date_format') || '';

            var line = '  ' + fmCount + '. ';
            if (srcField) {
                line += srcField + '  →  ' + tgtField;
            } else {
                line += '(scripted)  →  ' + tgtField;
            }
            if (coalesce === 'true' || coalesce === '1') line += '  [COALESCE]';
            p(line);

            if (choiceAction) p('     Choice action: ' + choiceAction);
            if (dateFormat) p('     Date format: ' + dateFormat);
            if (refQual) p('     Reference qualifier: ' + refQual);

            if ((useSource === 'true' || useSource === '1') && script) {
                p('     ---- SOURCE SCRIPT START ----');
                p(script);
                p('     ---- SOURCE SCRIPT END ----');
            }
            p('');
        }
        if (fmCount === 0) p('  (no field mappings found — may use auto-mapping)');

        // ── 4b. Transform Scripts ────────────────────────────
        p(subsection('TRANSFORM SCRIPTS FOR: ' + tm.name));
        var grTS = new GlideRecord('sys_transform_script');
        grTS.addQuery('map', tm.sys_id);
        grTS.orderBy('order');
        grTS.query();
        var tsCount = 0;
        while (grTS.next()) {
            tsCount++;
            var tsWhen = grTS.getDisplayValue('when') || grTS.getValue('when') || '';
            var tsOrder = grTS.getValue('order') || '';
            var tsScript = grTS.getValue('script') || '';
            var tsActive = grTS.getValue('active') || '';

            p('  ' + tsCount + '. [' + tsWhen + '] Order: ' + tsOrder + '  Active: ' + tsActive);
            if (tsScript) {
                p('  ---- SCRIPT START ----');
                p(tsScript);
                p('  ---- SCRIPT END ----');
            }
            p('');
        }
        if (tsCount === 0) p('  (no transform scripts found)');
    }

    // ══════════════════════════════════════════════════════════
    // 5. SAMPLE IMPORT SET
    // ══════════════════════════════════════════════════════════
    p(section('5. SAMPLE IMPORT SET'));

    if (sampleImportSetId) {
        var grIS = new GlideRecord('sys_import_set');
        if (grIS.get(sampleImportSetId)) {
            p('  Number: ' + (grIS.getValue('number') || ''));
            p('  sys_id: ' + sampleImportSetId);
            p('  State: ' + (grIS.getDisplayValue('state') || grIS.getValue('state') || ''));
            p('  Table name: ' + (grIS.getValue('table_name') || ''));
            p('  Mode: ' + (grIS.getDisplayValue('mode') || grIS.getValue('mode') || ''));
            p('  Data source: ' + (grIS.getDisplayValue('data_source') || ''));
            if (grIS.getValue('row_count')) p('  Row count: ' + grIS.getValue('row_count'));
            if (grIS.getValue('completed')) p('  Completed: ' + grIS.getDisplayValue('completed'));
            if (grIS.getValue('sys_created_on')) p('  Created: ' + grIS.getDisplayValue('sys_created_on'));

            var isTableName = grIS.getValue('table_name') || importSetTable || '';

            p(subsection('ALL IMPORT SET FIELDS'));
            dumpFields(grIS, []);

            // ── 5a. Import Set Rows (first 20) ──────────────
            if (isTableName) {
                p(subsection('IMPORT SET ROWS (first 20) — table: ' + isTableName));
                var grRow = new GlideRecord(isTableName);
                if (grRow.isValid()) {
                    grRow.addQuery('sys_import_set', sampleImportSetId);
                    grRow.setLimit(20);
                    grRow.orderBy('sys_import_row');
                    grRow.query();
                    var rowCount = 0;
                    while (grRow.next()) {
                        rowCount++;
                        p('  ── ROW ' + rowCount + ' ──');
                        p('  sys_id: ' + grRow.getUniqueValue());
                        p('  Import state: ' + (grRow.getDisplayValue('sys_import_state') || grRow.getValue('sys_import_state') || ''));
                        if (grRow.getValue('sys_import_state_comment')) p('  State comment: ' + grRow.getValue('sys_import_state_comment'));
                        if (grRow.getValue('sys_target_sys_id')) {
                            p('  Target record: ' + (grRow.getValue('sys_target_sys_id') || ''));
                            if (grRow.getDisplayValue('sys_target_sys_id')) p('  Target display: ' + grRow.getDisplayValue('sys_target_sys_id'));
                        }

                        // Print all staging columns (non-sys fields)
                        var rowFields = grRow.getFields();
                        for (var rfi = 0; rfi < rowFields.size(); rfi++) {
                            var rge = rowFields.get(rfi);
                            var rfName = rge.getName();
                            if (rfName.indexOf('sys_') === 0) continue;
                            var rfVal = rge.getValue() || '';
                            if (rfVal) {
                                p('    ' + (rge.getLabel() || rfName) + ': ' + rfVal);
                            }
                        }
                        p('');
                    }
                    if (rowCount === 0) p('  (no rows found in this import set)');
                } else {
                    p('  WARNING: Import set table "' + isTableName + '" not accessible.');
                }
            }

            // ── 5b. Import Set Row Errors ────────────────────
            if (isTableName) {
                p(subsection('IMPORT SET ERRORS (rows with errors)'));
                var grErr = new GlideRecord(isTableName);
                if (grErr.isValid()) {
                    grErr.addQuery('sys_import_set', sampleImportSetId);
                    grErr.addQuery('sys_import_state', 'error');
                    grErr.setLimit(10);
                    grErr.query();
                    var errCount = 0;
                    while (grErr.next()) {
                        errCount++;
                        p('  ' + errCount + '. Row sys_id: ' + grErr.getUniqueValue());
                        p('     Error: ' + (grErr.getValue('sys_import_state_comment') || ''));
                        p('');
                    }
                    if (errCount === 0) p('  (no error rows found — good!)');
                }
            }
        } else {
            p('  WARNING: Import set ' + sampleImportSetId + ' not found.');
        }
    } else {
        p('  (no sample import set sys_id provided)');
    }

    // ══════════════════════════════════════════════════════════
    // 6. IMPORT SET RUN HISTORY (last 10)
    // ══════════════════════════════════════════════════════════
    p(section('6. IMPORT SET RUN HISTORY (last 10)'));

    // Find runs via sys_import_set for this data source
    var grRunHistory = new GlideRecord('sys_import_set');
    grRunHistory.addQuery('data_source', dataSourceId);
    grRunHistory.orderByDesc('sys_created_on');
    grRunHistory.setLimit(10);
    grRunHistory.query();
    var runCount = 0;
    while (grRunHistory.next()) {
        runCount++;
        p('  ' + runCount + '. ' + (grRunHistory.getValue('number') || grRunHistory.getUniqueValue()));
        p('     State: ' + (grRunHistory.getDisplayValue('state') || grRunHistory.getValue('state') || ''));
        p('     Mode: ' + (grRunHistory.getDisplayValue('mode') || ''));
        if (grRunHistory.getValue('row_count')) p('     Rows: ' + grRunHistory.getValue('row_count'));
        p('     Created: ' + grRunHistory.getDisplayValue('sys_created_on'));
        if (grRunHistory.getValue('completed')) p('     Completed: ' + grRunHistory.getDisplayValue('completed'));
        p('');
    }
    if (runCount === 0) p('  (no import set runs found for this data source)');

    // Also check sys_import_set_run if available
    var grISR = new GlideRecord('sys_import_set_run');
    if (grISR.isValid()) {
        p(subsection('IMPORT SET RUN TABLE (sys_import_set_run)'));
        grISR.addQuery('import_set_table', importSetTable);
        grISR.orderByDesc('sys_created_on');
        grISR.setLimit(10);
        grISR.query();
        var isrCount = 0;
        while (grISR.next()) {
            isrCount++;
            p('  ' + isrCount + '. sys_id: ' + grISR.getUniqueValue());
            p('     State: ' + (grISR.getDisplayValue('state') || grISR.getValue('state') || ''));
            p('     Created: ' + grISR.getDisplayValue('sys_created_on'));
            if (grISR.getValue('rows_inserted')) p('     Rows inserted: ' + grISR.getValue('rows_inserted'));
            if (grISR.getValue('rows_updated')) p('     Rows updated: ' + grISR.getValue('rows_updated'));
            if (grISR.getValue('rows_ignored')) p('     Rows ignored: ' + grISR.getValue('rows_ignored'));
            if (grISR.getValue('rows_error')) p('     Rows error: ' + grISR.getValue('rows_error'));
            p('');
        }
        if (isrCount === 0) p('  (no runs found in sys_import_set_run)');
    }

    // ══════════════════════════════════════════════════════════
    // 7. IMPORT SET TABLE SCHEMA (staging table columns)
    // ══════════════════════════════════════════════════════════
    if (importSetTable) {
        p(section('7. IMPORT SET TABLE SCHEMA: ' + importSetTable));
        var grDict = new GlideRecord('sys_dictionary');
        grDict.addQuery('name', importSetTable);
        grDict.addQuery('element', '!=', '');
        grDict.orderBy('element');
        grDict.query();
        var colCount = 0;
        while (grDict.next()) {
            var element = grDict.getValue('element') || '';
            if (element.indexOf('sys_') === 0) continue;
            colCount++;
            var colType = grDict.getValue('internal_type') || '';
            var colLabel = grDict.getValue('column_label') || '';
            var colMax = grDict.getValue('max_length') || '';
            p('  ' + colCount + '. ' + element + '  (' + colType + ', max: ' + colMax + ')' +
              (colLabel ? '  — ' + colLabel : ''));
        }
        if (colCount === 0) p('  (no columns found — table may not exist yet)');
    }

    // ══════════════════════════════════════════════════════════
    // 8. TARGET TABLE BUSINESS RULES
    // ══════════════════════════════════════════════════════════
    if (targetTable) {
        p(section('8. RELEVANT BUSINESS RULES ON TARGET TABLE: ' + targetTable));
        p('  (only showing rules triggered on insert/update that reference LDAP/import/source)');

        var grBR = new GlideRecord('sys_script');
        grBR.addQuery('collection', targetTable);
        grBR.addQuery('active', true);
        grBR.orderBy('order');
        grBR.query();
        var brCount = 0;
        var brSkipped = 0;
        while (grBR.next()) {
            var brScript = grBR.getValue('script') || '';
            var brName = grBR.getValue('name') || '';
            var brNameLower = brName.toLowerCase();
            var brScriptLower = brScript.toLowerCase();

            // Include rules that reference LDAP/import/sync concepts
            var isRelevant = (
                brNameLower.indexOf('ldap') !== -1 ||
                brNameLower.indexOf('import') !== -1 ||
                brNameLower.indexOf('sync') !== -1 ||
                brNameLower.indexOf('azure') !== -1 ||
                brNameLower.indexOf('active directory') !== -1 ||
                brScriptLower.indexOf('ldap') !== -1 ||
                brScriptLower.indexOf('import') !== -1 ||
                brScriptLower.indexOf('data_source') !== -1 ||
                brScriptLower.indexOf('transform') !== -1 ||
                brScriptLower.indexOf('source_') !== -1
            );

            if (!isRelevant) {
                brSkipped++;
                continue;
            }

            brCount++;
            p('  ' + brCount + '. ' + brName);
            p('     When: ' + (grBR.getDisplayValue('when') || grBR.getValue('when') || ''));
            p('     Order: ' + (grBR.getValue('order') || ''));
            if (grBR.getValue('condition')) p('     Condition: ' + grBR.getValue('condition'));
            if (brScript) {
                p('     ---- SCRIPT START ----');
                p(brScript);
                p('     ---- SCRIPT END ----');
            }
            p('');
        }
        if (brCount === 0) p('  (no LDAP/import-related business rules found)');
        if (brSkipped > 0) p('  (' + brSkipped + ' unrelated business rules omitted)');
    }

    // ══════════════════════════════════════════════════════════
    // 9. ALL ACTIVE LDAP DATA SOURCES (context)
    // ══════════════════════════════════════════════════════════
    p(section('9. ALL ACTIVE LDAP DATA SOURCES ON INSTANCE'));

    var grAllDS = new GlideRecord('sys_data_source');
    grAllDS.addQuery('type', 'LDAP');
    grAllDS.addQuery('active', true);
    grAllDS.orderBy('name');
    grAllDS.query();
    var allDsCount = 0;
    while (grAllDS.next()) {
        allDsCount++;
        var marker = (grAllDS.getUniqueValue() === dataSourceId) ? ' ◄◄ THIS ONE' : '';
        p('  ' + allDsCount + '. ' + grAllDS.getValue('name') + marker);
        p('     sys_id: ' + grAllDS.getUniqueValue());
        p('     Import set table: ' + (grAllDS.getValue('import_set_table_name') || ''));
        p('     Target table: ' + (grAllDS.getDisplayValue('table') || ''));
        p('     LDAP server: ' + (grAllDS.getDisplayValue('ldap_target') || ''));
        p('');
    }
    if (allDsCount === 0) p('  (no active LDAP data sources found)');

    // ══════════════════════════════════════════════════════════
    // 10. ALL ACTIVE LDAP SCHEDULED IMPORTS
    // ══════════════════════════════════════════════════════════
    p(section('10. ALL ACTIVE LDAP SCHEDULED IMPORTS'));

    var grAllSched = new GlideRecord('scheduled_import_set');
    grAllSched.addQuery('active', true);
    grAllSched.addQuery('data_source.type', 'LDAP');
    grAllSched.orderBy('name');
    grAllSched.query();
    var allSchedCount = 0;
    while (grAllSched.next()) {
        allSchedCount++;
        var schedMarker = (grAllSched.getUniqueValue() === scheduledImportId) ? ' ◄◄ THIS ONE' : '';
        p('  ' + allSchedCount + '. ' + grAllSched.getValue('name') + schedMarker);
        p('     sys_id: ' + grAllSched.getUniqueValue());
        p('     Data source: ' + grAllSched.getDisplayValue('data_source'));
        p('     Run type: ' + (grAllSched.getDisplayValue('run_type') || ''));
        p('     Active: ' + grAllSched.getValue('active'));
        p('');
    }
    if (allSchedCount === 0) p('  (no active LDAP scheduled imports found)');

    // ══════════════════════════════════════════════════════════
    // 11. LDAP ATTRIBUTE MAPS
    // ══════════════════════════════════════════════════════════
    p(section('11. LDAP ATTRIBUTE MAPS'));

    var grAttrMap = new GlideRecord('ldap_target_attributes');
    if (grAttrMap.isValid() && ldapServerRef) {
        grAttrMap.addQuery('server', ldapServerRef);
        grAttrMap.query();
        var attrCount = 0;
        while (grAttrMap.next()) {
            attrCount++;
            p('  ' + attrCount + '. LDAP attr: ' + (grAttrMap.getValue('attribute') || ''));
            p('     SN field: ' + (grAttrMap.getValue('target') || ''));
            p('     Table: ' + (grAttrMap.getDisplayValue('table') || ''));
            p('');
        }
        if (attrCount === 0) p('  (no LDAP attribute maps found — mappings may be in transform maps instead)');
    } else {
        p('  (ldap_target_attributes table not available or no LDAP server ref)');
    }

    // ══════════════════════════════════════════════════════════
    // SUMMARY
    // ══════════════════════════════════════════════════════════
    p(ln('=', 80));
    p('EXPORT COMPLETE');
    p('Data source: ' + dataSourceId);
    p('Scheduled import: ' + scheduledImportId);
    p('Import set table: ' + importSetTable);
    p('Target table: ' + targetTable);
    p('Transform maps found: ' + transformMaps.length);
    p('Import run history entries: ' + runCount);
    p(ln('=', 80));

})(SCHEDULED_IMPORT_SYS_ID, DATA_SOURCE_SYS_ID, SAMPLE_IMPORT_SET_SYS_ID);
