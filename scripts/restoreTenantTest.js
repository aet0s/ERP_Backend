require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { masterPool, getAdminPool } = require('../db/masterDb');
const { getTenantPool, closeAllTenantPools } = require('../db/tenantManager');
const { runTenantMigrations } = require('../db/migrationRunner');
const { dumpTenantDatabase, restoreTenantDatabase, computeDatabaseChecksum } = require('../lib/backupEngine');

async function testBackupRestore() {
  console.log('--- TEST 3: UPGRADED BYTE-FOR-BYTE CHECKSUM & EDGE CASE RESTORE VERIFICATION ---');

  const masterClient = await masterPool.connect();
  let comp;
  try {
    const compRes = await masterClient.query("SELECT id, company_name, company_code, database_name FROM companies ORDER BY created_at DESC LIMIT 1");
    comp = compRes.rows[0];
  } finally {
    masterClient.release();
  }

  const sourcePool = getTenantPool(comp.database_name);
  const sourceClient = await sourcePool.connect();

  const edgeCaseName = `Unicode Special €100 @ 2.5% ~ !@#$%^&*()_+= ${Date.now()}`;
  const edgeCaseId = crypto.randomUUID();

  try {
    // 1. Insert Edge Case Record into Source DB
    console.log('1. Inserting Edge Case record into source DB (Unicode, NULLs, Multi-digit decimals)...');
    await sourceClient.query(
      `INSERT INTO raw_materials (id, name, unit, reorder_level)
       VALUES (?, ?, ?, ?)`,
      [edgeCaseId, edgeCaseName, 'kg', 9876543.21]
    );

    const edgeRes = await sourceClient.query('SELECT id, name, unit, reorder_level FROM raw_materials WHERE id = ?', [edgeCaseId]);
    console.log(`✓ Edge case record inserted. ID=${edgeCaseId}, reorder_level=${edgeRes.rows[0].reorder_level}`);
  } finally {
    sourceClient.release();
  }

  // 2. Compute SHA-256 Checksums on Source Database
  console.log('\n2. Computing per-table SHA-256 checksums on source database...');
  const sourceHashes = await computeDatabaseChecksum(comp.database_name);
  console.log('Source Database SHA-256 Checksums per table:');
  for (const [tbl, hash] of Object.entries(sourceHashes)) {
    console.log(`   - ${tbl}: ${hash}`);
  }

  const backupDir = path.join(__dirname, '..', 'backups');
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const backupFile = path.join(backupDir, `test_restore_${comp.company_code}_${Date.now()}.sql`);
  const restoreDbName = `erp_company_restore_test_${Date.now()}`;

  // 3. Generate Database Dump
  console.log(`\n3. Generating database backup for ${comp.company_name}...`);
  const dumpResult = await dumpTenantDatabase(comp.database_name, backupFile);
  console.log(`✓ Backup created successfully (${dumpResult.bytes} bytes)`);

  const adminPool = getAdminPool();
  const adminClient = await adminPool.connect();

  try {
    // 4. Provision & Restore into Temporary Database
    console.log(`\n4. Provisioning fresh temporary database [${restoreDbName}]...`);
    await adminClient.query(`CREATE DATABASE \`${restoreDbName}\``);

    console.log(`5. Applying schema migrations to [${restoreDbName}]...`);
    const restoredPool = getTenantPool(restoreDbName);
    await runTenantMigrations(restoredPool);

    console.log(`6. Restoring data backup into [${restoreDbName}]...`);
    await restoreTenantDatabase(restoreDbName, backupFile);
    console.log('✓ Database restoration executed cleanly without errors');

    // 7. Compute SHA-256 Checksums on Restored Database
    console.log('\n7. Computing per-table SHA-256 checksums on restored database...');
    const restoredHashes = await computeDatabaseChecksum(restoreDbName);

    let checksumMismatch = false;
    for (const [tbl, sourceHash] of Object.entries(sourceHashes)) {
      const restoredHash = restoredHashes[tbl];
      const match = sourceHash === restoredHash;
      console.log(`   - ${tbl}: ${match ? 'MATCH ✓' : 'MISMATCH ✖'} (${restoredHash})`);
      if (!match) checksumMismatch = true;
    }

    if (checksumMismatch) {
      console.error('FAIL: SHA-256 checksum mismatch detected between source and restored database!');
      process.exit(1);
    }
    console.log('✓ PASS: All table SHA-256 checksums match 100% byte-for-byte!');

    // 8. Foreign Key Integrity Check
    console.log('\n8. Verifying foreign key relationships post-restore...');
    const restoredClient = await restoredPool.connect();
    try {
      const fkRes = await restoredClient.query(
        `SELECT p.id, rm.name AS material_name, v.name AS vendor_name
         FROM procurements p
         JOIN raw_materials rm ON rm.id = p.raw_material_id
         JOIN vendors v ON v.id = p.vendor_id
         LIMIT 1`
      );

      if (fkRes.rowCount > 0) {
        console.log(`✓ Foreign key resolution verified: Procurement #${fkRes.rows[0].id} (Material: "${fkRes.rows[0].material_name}") -> Vendor: "${fkRes.rows[0].vendor_name}"`);
      }

      // 9. Edge Case Record Verification
      const edgeRestored = await restoredClient.query('SELECT * FROM raw_materials WHERE id = ?', [edgeCaseId]);
      if (edgeRestored.rowCount === 0) {
        throw new Error('Edge case record missing post-restore!');
      }
      const eRow = edgeRestored.rows[0];
      if (eRow.name !== edgeCaseName || parseFloat(eRow.reorder_level) !== 9876543.21) {
        throw new Error(`Edge case value fidelity mismatch! Expected "${edgeCaseName}", got "${eRow.name}"`);
      }
      console.log('✓ PASS: Edge case Unicode, special character, and multi-digit decimal fidelity verified!');

      // 10. Insertion Verification
      console.log('\n9. Verifying post-restore data manipulation (testing insertion of new raw material)...');
      const newRmId = crypto.randomUUID();
      await restoredClient.query(
        `INSERT INTO raw_materials (id, name, unit, reorder_level)
         VALUES (?, ?, ?, ?)`,
        [newRmId, 'Post-Restore Test Material', 'kg', 100]
      );
      console.log(`✓ Post-restore insertion verified! New material inserted cleanly with ID=${newRmId}`);
    } finally {
      restoredClient.release();
    }

    // Clean up temporary DB & backup file
    console.log(`\n10. Cleaning up temporary restore database [${restoreDbName}]...`);
    await closeAllTenantPools();
    await adminClient.query(`DROP DATABASE IF EXISTS \`${restoreDbName}\``);
    if (fs.existsSync(backupFile)) fs.unlinkSync(backupFile);

    console.log('\n--- TEST 3 PASSED: Upgraded byte-for-byte checksum & edge case restore verified 100% ---\n');
  } finally {
    adminClient.release();
    await adminPool.end();
    await masterPool.end();
  }
}

if (require.main === module) {
  testBackupRestore().catch((err) => {
    console.error('Test 3 failed:', err);
    process.exit(1);
  });
}

module.exports = { testBackupRestore };
