'use strict';

/**
 * notifications.js — Centralized notification engine for ERP & Portals.
 */

const crypto = require('crypto');

async function createNotification(tenantDb, { user_type, user_id = null, vendor_id = null, customer_id = null, title, message, link = null }) {
  try {
    const id = crypto.randomUUID();
    await tenantDb.query(
      `INSERT INTO notifications (id, user_type, user_id, vendor_id, customer_id, title, message, link, is_read)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      [id, user_type, user_id, vendor_id, customer_id, title, message, link]
    );
    return id;
  } catch (err) {
    console.error('Error creating notification:', err);
    return null;
  }
}

async function getNotifications(tenantDb, { user_type, user_id = null, vendor_id = null, customer_id = null }) {
  try {
    let sql = 'SELECT * FROM notifications WHERE user_type = ?';
    const params = [user_type];

    if (user_type === 'user' && user_id) {
      sql += ' AND (user_id = ? OR user_id IS NULL)';
      params.push(user_id);
    } else if (user_type === 'vendor_portal' && vendor_id) {
      sql += ' AND vendor_id = ?';
      params.push(vendor_id);
    } else if (user_type === 'customer_portal' && customer_id) {
      sql += ' AND customer_id = ?';
      params.push(customer_id);
    }

    sql += ' ORDER BY created_at DESC LIMIT 50';
    const res = await tenantDb.query(sql, params);
    return res.rows;
  } catch (err) {
    console.error('Error fetching notifications:', err);
    return [];
  }
}

module.exports = { createNotification, getNotifications };
