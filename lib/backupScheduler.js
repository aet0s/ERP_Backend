'use strict';

/**
 * backupScheduler.js — Automated Cron Engine for Platform Master & Tenant Database Backups
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { queryMaster } = require('../db/masterDb');
const { dumpTenantDatabase, dumpMasterDatabase } = require('./backupEngine');
const { logMasterAudit } = require('./auditCrypto');

const BACKUP_DIR = path.join(__dirname, '..', 'backups');

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
  }
}

function isDue(lastBackupAt, frequency, scheduledTimeStr) {
  if (!lastBackupAt) return true; // Never backed up -> run immediately

  const lastDate = new Date(lastBackupAt).getTime();
  if (isNaN(lastDate)) return true;

  const now = Date.now();
  const diffMs = now - lastDate;

  switch (frequency) {
    case 'weekly':
      return diffMs >= 7 * 24 * 60 * 60 * 1000;
    case 'monthly':
      return diffMs >= 30 * 24 * 60 * 60 * 1000;
    case 'daily':
    default:
      return diffMs >= 24 * 60 * 60 * 1000;
  }
}

function cleanExpiredBackups(prefix, retentionDays) {
  try {
    ensureBackupDir();
    const days = Math.max(1, parseInt(retentionDays || '30', 10));
    const cutoffMs = Date.now() - (days * 24 * 60 * 60 * 1000);

    const files = fs.readdirSync(BACKUP_DIR).filter(f => f.startsWith(prefix) && f.endsWith('.sql'));
    for (const file of files) {
      const filePath = path.join(BACKUP_DIR, file);
      const stat = fs.statSync(filePath);
      if (stat.mtimeMs < cutoffMs) {
        fs.unlinkSync(filePath);
        console.log(`[Backup Scheduler] Purged expired backup: ${file} (> ${days} days)`);
      }
    }
  } catch (err) {
    console.warn(`[Backup Scheduler] Error cleaning expired backups for ${prefix}:`, err.message);
  }
}

let isRunning = false;

async function runBackupCron(forceRun = false) {
  if (isRunning) {
    console.log('[Backup Scheduler] Previous cron run still in progress. Skipping cycle.');
    return { skipped: true, reason: 'in_progress' };
  }

  isRunning = true;
  ensureBackupDir();
  const summary = { masterRun: false, workspacesRun: 0, errors: [] };

  try {
    // 1. Process Platform Master Database Scheduled Backup
    try {
      await queryMaster('ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS master_auto_backup_enabled TINYINT(1) DEFAULT 1').catch(() => {});
      await queryMaster('ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS master_auto_backup_frequency VARCHAR(20) DEFAULT "daily"').catch(() => {});
      await queryMaster('ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS master_auto_backup_retention_days INT DEFAULT 30').catch(() => {});
      await queryMaster('ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS master_auto_backup_time VARCHAR(10) DEFAULT "01:00"').catch(() => {});
      await queryMaster('ALTER TABLE platform_settings ADD COLUMN IF NOT EXISTS master_last_auto_backup_at DATETIME NULL').catch(() => {});

      const pRes = await queryMaster('SELECT master_auto_backup_enabled, master_auto_backup_frequency, master_auto_backup_retention_days, master_auto_backup_time, master_last_auto_backup_at FROM platform_settings LIMIT 1');
      const pSet = pRes.rows[0] || {};
      const masterEnabled = pSet.master_auto_backup_enabled !== undefined ? Boolean(pSet.master_auto_backup_enabled) : true;
      const masterFreq = pSet.master_auto_backup_frequency || 'daily';
      const masterRetention = parseInt(pSet.master_auto_backup_retention_days || '30', 10);
      const masterTime = pSet.master_auto_backup_time || '01:00';

      if (masterEnabled && (forceRun || isDue(pSet.master_last_auto_backup_at, masterFreq, masterTime))) {
        console.log('[Backup Scheduler] Triggering scheduled master database backup...');
        const filename = `backup_MASTER_${Date.now()}.sql`;
        const filePath = path.join(BACKUP_DIR, filename);
        await dumpMasterDatabase(filePath);
        const stats = fs.statSync(filePath);

        await queryMaster('UPDATE platform_settings SET master_last_auto_backup_at = NOW() WHERE id = 1 OR id IS NOT NULL');
        await logMasterAudit(queryMaster, {
          company_id: null,
          user_id: 'cron_scheduler',
          action: 'cron_auto_backup_master',
          metadata: { filename, size: stats.size, frequency: masterFreq }
        });

        cleanExpiredBackups('backup_MASTER_', masterRetention);
        summary.masterRun = true;
        console.log(`[Backup Scheduler] Master database automated backup generated: ${filename} (${stats.size} bytes)`);
      }
    } catch (masterErr) {
      console.error('[Backup Scheduler] Error executing master auto backup:', masterErr);
      summary.errors.push({ target: 'master', error: masterErr.message });
    }

    // 2. Process All Active Tenant Workspaces Scheduled Backups
    try {
      await queryMaster('ALTER TABLE companies ADD COLUMN IF NOT EXISTS auto_backup_enabled TINYINT(1) DEFAULT 1').catch(() => {});
      await queryMaster('ALTER TABLE companies ADD COLUMN IF NOT EXISTS auto_backup_frequency VARCHAR(20) DEFAULT "daily"').catch(() => {});
      await queryMaster('ALTER TABLE companies ADD COLUMN IF NOT EXISTS auto_backup_retention_days INT DEFAULT 30').catch(() => {});
      await queryMaster('ALTER TABLE companies ADD COLUMN IF NOT EXISTS auto_backup_time VARCHAR(10) DEFAULT "02:00"').catch(() => {});
      await queryMaster('ALTER TABLE companies ADD COLUMN IF NOT EXISTS last_auto_backup_at DATETIME NULL').catch(() => {});

      const compRes = await queryMaster(`
        SELECT id, company_name, company_code, database_name, status,
               COALESCE(auto_backup_enabled, 1) AS auto_backup_enabled,
               COALESCE(auto_backup_frequency, 'daily') AS auto_backup_frequency,
               COALESCE(auto_backup_retention_days, 30) AS auto_backup_retention_days,
               COALESCE(auto_backup_time, '02:00') AS auto_backup_time,
               last_auto_backup_at
        FROM companies
        WHERE status != 'deleted'
      `);

      for (const comp of compRes.rows) {
        if (!comp.auto_backup_enabled) continue;

        if (forceRun || isDue(comp.last_auto_backup_at, comp.auto_backup_frequency, comp.auto_backup_time)) {
          console.log(`[Backup Scheduler] Running scheduled backup for workspace: ${comp.company_name} (${comp.company_code})...`);
          const filename = `backup_${comp.company_code}_${Date.now()}.sql`;
          const filePath = path.join(BACKUP_DIR, filename);

          await dumpTenantDatabase(comp.database_name, filePath);
          const stats = fs.statSync(filePath);

          await queryMaster('UPDATE companies SET last_auto_backup_at = NOW() WHERE id = ?', [comp.id]);
          await logMasterAudit(queryMaster, {
            company_id: comp.id,
            user_id: 'cron_scheduler',
            action: 'cron_auto_backup_workspace',
            metadata: { filename, size: stats.size, company_name: comp.company_name, frequency: comp.auto_backup_frequency }
          });

          cleanExpiredBackups(`backup_${comp.company_code}_`, comp.auto_backup_retention_days);
          summary.workspacesRun++;
          console.log(`[Backup Scheduler] Workspace backup generated: ${filename} (${stats.size} bytes)`);
        }
      }
    } catch (wsErr) {
      console.error('[Backup Scheduler] Error executing tenant auto backups:', wsErr);
      summary.errors.push({ target: 'workspaces', error: wsErr.message });
    }
  } finally {
    isRunning = false;
  }

  return summary;
}

let schedulerTimer = null;

function startBackupScheduler(intervalMs = 300000) { // Check every 5 minutes by default
  if (schedulerTimer) clearInterval(schedulerTimer);

  console.log(`[Backup Scheduler] Automated database backup cron initialized (check interval: ${intervalMs / 1000}s).`);
  
  // Initial background check after short startup delay
  setTimeout(() => {
    runBackupCron(false).catch(err => console.warn('[Backup Scheduler] Startup cron check error:', err.message));
  }, 10000);

  schedulerTimer = setInterval(() => {
    runBackupCron(false).catch(err => console.warn('[Backup Scheduler] Periodic cron check error:', err.message));
  }, intervalMs);

  return schedulerTimer;
}

module.exports = {
  runBackupCron,
  startBackupScheduler
};
