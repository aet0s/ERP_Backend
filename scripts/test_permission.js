/**
 * ERP Permission Matrix — Automated API-level test
 * ----------------------------------------------------
 * What this does:
 *   1. Logs in as the OWNER and as the invited STAFF user.
 *   2. Reads the current `staff` row of the permission matrix (so it can restore it at the end).
 *   3. Zeroes every permission for `staff`.
 *   4. For every (module, action) pair in MODULE_ACTIONS, grants ONLY that one flag to `staff`
 *      (everything else stays 0), then — as the staff user — calls every mapped endpoint for
 *      EVERY module (not just the one just toggled), and records 403 (denied) vs anything-else
 *      (permission passed the middleware). This is what catches cross-module leakage bugs
 *      (e.g. shift_log/production OR-coupling) — a naive "toggle one, test one" loop would miss them.
 *   5. Restores the original `staff` permissions.
 *   6. Writes permission_matrix_report.csv and prints a summary of every mismatch.
 *
 * SAFETY NOTE — read before running:
 *   Create/Edit/Delete/Approve/Export checks are made against endpoints using a deliberately
 *   invalid/non-existent record id ("__perm_test__") or an empty/invalid body. Since the
 *   `requirePermission` middleware always runs BEFORE the route handler's business logic,
 *   a 403 unambiguously means "denied by permission", and any other status (400/404/422/500)
 *   unambiguously means "permission granted, then the handler rejected the fake payload/id".
 *   This means the script should not create or corrupt real records — but it is still hitting
 *   a real backend. Run this against a staging/test workspace, not a production tenant with
 *   real customer/financial data, in case any endpoint's validation order differs from what's
 *   documented here.
 *
 * Usage:
 *   npm install axios
 *   node test_permission_matrix.js
 */

const axios = require('axios');
const fs = require('fs');

// ---------- CONFIGURE THESE ----------
const BASE_URL = 'http://localhost:4000'; // your backend base URL
const OWNER_CREDENTIALS = { email: 'inf@apollo.com', password: 'Hardick@1907' };
const STAFF_CREDENTIALS = { email: 'hardick@apollo.com', password: 'Hardick@1234' };
const TARGET_ROLE = 'staff'; // the role assigned to the invited user you're testing
const FAKE_ID = '__perm_test__';
// --------------------------------------

const ALL_MODULES = [
    'dashboard', 'catalog', 'inventory', 'procurement', 'production', 'shift_log',
    'sales', 'parties', 'expenses', 'locations', 'reports', 'settings',
    'vendor_orders', 'customer_orders', 'returns', 'users', 'billing', 'stock_transfers'
];

// Which actions are meaningful to test per module, and which real endpoint proves it.
// method/path/body describe the call made AS THE STAFF USER once staff has (or lacks) that flag.
// `expectDeadFor` documents modules we already know (from static audit) will NOT change behavior
// no matter what you toggle, so the script flags these as "known dead" instead of "unexpected".
const ENDPOINT_MAP = {
    dashboard: {
        view: { method: 'get', path: '/api/dashboard/overview' },
        export: { method: 'get', path: '/api/dashboard/snapshot' }
    },
    catalog: {
        view: { method: 'get', path: '/api/items' },
        create: { method: 'post', path: '/api/items', body: {} },
        edit: { method: 'put', path: `/api/items/${FAKE_ID}`, body: {} },
        delete: { method: 'delete', path: `/api/items/${FAKE_ID}` }
    },
    inventory: {
        view: { method: 'get', path: '/api/stock' },
        create: { method: 'post', path: '/api/inventory/adjustments', body: {} },
        edit: { method: 'patch', path: `/api/inventory/raw/${FAKE_ID}/reorder-level`, body: {} }
    },
    procurement: {
        view: { method: 'get', path: '/api/procurements' },
        create: { method: 'post', path: '/api/procurements', body: {} },
        edit: { method: 'put', path: `/api/procurements/${FAKE_ID}`, body: {} },
        delete: { method: 'delete', path: `/api/purchase-orders/${FAKE_ID}` },
        approve: { method: 'post', path: `/api/procurements/${FAKE_ID}/send-to-vendor`, body: {} }
    },
    production: {
        view: { method: 'get', path: '/api/production-runs' },
        create: { method: 'post', path: '/api/production-runs', body: {} },
        edit: { method: 'put', path: `/api/production-batches/${FAKE_ID}`, body: {} },
        delete: { method: 'delete', path: `/api/production-runs/${FAKE_ID}` }
    },
    shift_log: {
        // Known coupling (see audit Bug 1): these are OR'd with `production` server-side.
        // To see shift_log actually deny access you must ALSO zero `production` for the role.
        view: { method: 'get', path: '/api/production-shift-logs' },
        create: { method: 'post', path: `/api/production-orders/${FAKE_ID}/shift-logs`, body: {} },
        delete: { method: 'delete', path: `/api/production-shift-logs/${FAKE_ID}` }
    },
    sales: {
        view: { method: 'get', path: '/api/invoices' },
        create: { method: 'post', path: '/api/invoices', body: {} },
        edit: { method: 'put', path: `/api/sales/${FAKE_ID}`, body: {} },
        delete: { method: 'delete', path: `/api/sales/${FAKE_ID}` },
        approve: { method: 'post', path: `/api/invoices/${FAKE_ID}/dispatch`, body: {} },
        export: { method: 'get', path: `/api/invoices/${FAKE_ID}/pdf` }
    },
    parties: {
        view: { method: 'get', path: '/api/vendors' },
        create: { method: 'post', path: '/api/vendors', body: {} },
        edit: { method: 'put', path: `/api/vendors/${FAKE_ID}`, body: {} },
        delete: { method: 'delete', path: `/api/vendors/${FAKE_ID}` }
    },
    expenses: {
        view: { method: 'get', path: '/api/expenses' },
        create: { method: 'post', path: '/api/expenses', body: {} },
        edit: { method: 'put', path: `/api/expenses/${FAKE_ID}`, body: {} },
        delete: { method: 'delete', path: `/api/expenses/${FAKE_ID}` }
    },
    locations: {
        view: { method: 'get', path: '/api/locations' },
        create: { method: 'post', path: '/api/locations', body: {} },
        edit: { method: 'put', path: `/api/locations/${FAKE_ID}`, body: {} },
        delete: { method: 'delete', path: `/api/locations/${FAKE_ID}` }
    },
    reports: {
        view: { method: 'get', path: '/api/reorder-suggestions' }
    },
    settings: {
        view: { method: 'get', path: '/api/workspace' }
        // 'edit' (PUT /api/workspace) deliberately not exercised here — it mutates real workspace
        // config and there's no safe invalid-payload trick for it. Test this one manually.
    },
    vendor_orders: {
        // Known dead for internal roles (Bug 3) — only enforced on the external vendor portal role.
        view: { method: 'get', path: '/api/vendors', expectDeadFor: 'internal roles; only checked on vendor portal' }
    },
    customer_orders: {
        view: { method: 'get', path: '/api/customers', expectDeadFor: 'internal roles; only checked on customer portal' }
    },
    returns: {
        view: { method: 'get', path: '/api/return-requests' },
        create: { method: 'post', path: '/api/return-requests', body: {} },
        approve: { method: 'post', path: `/api/return-requests/${FAKE_ID}/approve`, body: {} }
    },
    users: {
        view: { method: 'get', path: '/api/users' },
        create: { method: 'post', path: '/api/users', body: {} },
        edit: { method: 'put', path: `/api/users/${FAKE_ID}/role`, body: {} },
        delete: { method: 'delete', path: `/api/users/${FAKE_ID}` }
    },
    billing: {
        view: { method: 'get', path: '/api/billing' },
        create: { method: 'post', path: '/api/billing/checkout', body: { plan: FAKE_ID } },
        edit: { method: 'post', path: '/api/billing/portal', body: {} }
    },
    stock_transfers: {
        view: { method: 'get', path: '/api/stock-transfers' },
        create: { method: 'post', path: '/api/stock-transfers', body: {} }
    }
};

const ALL_ACTIONS = ['can_view', 'can_create', 'can_edit', 'can_delete', 'can_approve', 'can_export'];
const ACTION_KEY = { can_view: 'view', can_create: 'create', can_edit: 'edit', can_delete: 'delete', can_approve: 'approve', can_export: 'export' };

async function login(client, creds) {
    const res = await client.post('/auth/login', creds);
    return res.data.token;
}

function authed(token) {
    return axios.create({ baseURL: BASE_URL, headers: { Authorization: `Bearer ${token}` }, validateStatus: () => true });
}

async function getPermissions(ownerClient) {
    const res = await ownerClient.get('/api/permissions');
    return res.data;
}

async function setStaffPermissions(ownerClient, fullMatrix, staffOverrides) {
    // staffOverrides: { module: { can_view, can_create, ... } } — only for TARGET_ROLE, all flags explicit 0/1
    const next = fullMatrix.map((row) => {
        if (row.role !== TARGET_ROLE) return row;
        const ov = staffOverrides[row.module] || {};
        const merged = { ...row };
        for (const a of ALL_ACTIONS) merged[a] = ov[a] !== undefined ? ov[a] : 0;
        return merged;
    });
    await ownerClient.put('/api/permissions', { permissions: next });
    return next;
}

async function callEndpoint(client, ep) {
    if (!ep) return { skipped: true };
    const { method, path, body } = ep;
    const res = await client[method](path, body !== undefined ? body : undefined);
    return { status: res.status };
}

async function main() {
    console.log('Logging in as owner and staff...');
    const bare = axios.create({ baseURL: BASE_URL, validateStatus: () => true });
    const ownerToken = await login(bare, OWNER_CREDENTIALS);
    const staffToken = await login(bare, STAFF_CREDENTIALS);
    const ownerClient = authed(ownerToken);
    const staffClient = authed(staffToken);

    console.log('Fetching current permission matrix (to restore later)...');
    const originalMatrix = await getPermissions(ownerClient);
    const originalStaffRows = originalMatrix.filter((r) => r.role === TARGET_ROLE);

    const results = []; // { module, actionToggled, checkedModule, checkedAction, expected, actualStatus, note }

    try {
        console.log(`Zeroing all '${TARGET_ROLE}' permissions...`);
        let matrix = await setStaffPermissions(ownerClient, originalMatrix, {});

        for (const module of ALL_MODULES) {
            const actions = Object.keys(ENDPOINT_MAP[module] || {});
            for (const actionKey of actions) {
                const flagName = `can_${actionKey}`;

                // Grant ONLY this one (module, action) to staff; everything else stays 0.
                const overrides = { [module]: { [flagName]: 1 } };
                matrix = await setStaffPermissions(ownerClient, originalMatrix, overrides);
                // give the middleware's live DB read a beat (it's not cached, but be defensive)
                await new Promise((r) => setTimeout(r, 50));

                // Now check EVERY module's endpoints as staff, not just the one just toggled —
                // this is what catches cross-module leakage (e.g. Bug 1's shift_log/production OR).
                for (const checkModule of ALL_MODULES) {
                    const map = ENDPOINT_MAP[checkModule] || {};
                    for (const checkActionKey of Object.keys(map)) {
                        const ep = map[checkActionKey];
                        const shouldBeAllowed = checkModule === module && checkActionKey === actionKey;
                        let outcome;
                        try {
                            outcome = await callEndpoint(staffClient, ep);
                        } catch (err) {
                            outcome = { status: 'ERROR:' + err.message };
                        }
                        const denied = outcome.status === 403;
                        const passMatches = shouldBeAllowed ? !denied : denied;
                        results.push({
                            grantedModule: module,
                            grantedAction: actionKey,
                            checkedModule: checkModule,
                            checkedAction: checkActionKey,
                            expectedAllowed: shouldBeAllowed,
                            actualStatus: outcome.status,
                            matchesExpectation: passMatches,
                            knownIssue: ep && ep.expectDeadFor ? ep.expectDeadFor : ''
                        });
                    }
                }
                console.log(`Tested granting ${module}.${flagName} — checked ${ALL_MODULES.length} modules' endpoints.`);
            }
        }
    } finally {
        console.log('Restoring original staff permissions...');
        await setStaffPermissions(ownerClient, originalMatrix, Object.fromEntries(
            originalStaffRows.map((r) => [r.module, r])
        ));
    }

    // ---- write CSV ----
    const header = 'grantedModule,grantedAction,checkedModule,checkedAction,expectedAllowed,actualStatus,matchesExpectation,knownIssue\n';
    const csv = header + results.map((r) =>
        [r.grantedModule, r.grantedAction, r.checkedModule, r.checkedAction, r.expectedAllowed, r.actualStatus, r.matchesExpectation, `"${r.knownIssue}"`].join(',')
    ).join('\n');
    let reportFile = 'permission_matrix_report.csv';
    try {
        fs.writeFileSync(reportFile, csv);
    } catch (err) {
        reportFile = `permission_matrix_report_${Date.now()}.csv`;
        fs.writeFileSync(reportFile, csv);
    }

    // ---- console summary ----
    const mismatches = results.filter((r) => !r.matchesExpectation && !r.knownIssue);
    const knownIssuesHit = results.filter((r) => !r.matchesExpectation && r.knownIssue);

    console.log('\n================ SUMMARY ================');
    console.log(`Total checks: ${results.length}`);
    console.log(`Unexpected mismatches (new bugs, investigate): ${mismatches.length}`);
    console.log(`Matches to already-known static-audit issues: ${knownIssuesHit.length}`);
    console.log(`Full detail written to ${reportFile}\n`);

    if (mismatches.length) {
        console.log('--- UNEXPECTED MISMATCHES ---');
        for (const m of mismatches) {
            console.log(
                `Granted ${m.grantedModule}.can_${m.grantedAction} → checking ${m.checkedModule}.can_${m.checkedAction}: expected ${m.expectedAllowed ? 'ALLOWED' : 'DENIED'}, got status ${m.actualStatus}`
            );
        }
    }
}

main().catch((err) => {
    console.error('Test run failed:', err.response ? err.response.data : err.message);
    process.exit(1);
});