const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { requireAuth, requireRole, requirePermission } = require('../middleware/auth');
const { queryMaster } = require('../db/masterDb');
const { getTenantPool } = require('../db/tenantManager');
const authRoute = require('./auth');
const { issueAccessToken, buildRefreshToken, persistRefreshToken, setAuthCookies, parseRoles } = authRoute;

const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '12', 10);
const VALID_ROLES = ['owner', 'admin', 'manager', 'accounts', 'production_manager', 'sales_manager', 'staff'];

// List users in company
router.get('/', requireAuth, requirePermission('users', 'view'), async (req, res) => {
  try {
    await req.tenantDb.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS roles TEXT NULL').catch(() => {});
    await req.tenantDb.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_primary_owner TINYINT(1) NOT NULL DEFAULT 0').catch(() => {});

    const companyId = req.user.company_id || req.user.workspace_id;
    let primaryOwnerId = null;
    let primaryOwnerEmail = null;
    try {
      const cRes = await queryMaster('SELECT primary_owner_id, primary_owner_email FROM companies WHERE id = ?', [companyId]);
      if (cRes.rows && cRes.rows[0]) {
        primaryOwnerId = cRes.rows[0].primary_owner_id;
        primaryOwnerEmail = cRes.rows[0].primary_owner_email;
      }
    } catch {}

    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit || req.query.page_size || '20', 10)));
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').trim().toLowerCase();
    const roleFilter = (req.query.role || '').trim().toLowerCase();
    const statusFilter = (req.query.status || '').trim();
    const startDate = (req.query.start_date || '').trim();
    const endDate = (req.query.end_date || '').trim();

    let whereConditions = ['deleted_at IS NULL'];
    const params = [];

    if (search) {
      whereConditions.push('(LOWER(name) LIKE ? OR LOWER(email) LIKE ? OR LOWER(role) LIKE ?)');
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }

    if (roleFilter) {
      whereConditions.push('(LOWER(role) = ? OR LOWER(roles) LIKE ? OR LOWER(roles) LIKE ?)');
      params.push(roleFilter, `%"${roleFilter}"%`, `%${roleFilter}%`);
    }

    if (statusFilter) {
      whereConditions.push('LOWER(status) = ?');
      params.push(statusFilter.toLowerCase());
    }

    if (startDate) {
      whereConditions.push('DATE(created_at) >= ?');
      params.push(startDate);
    }

    if (endDate) {
      whereConditions.push('DATE(created_at) <= ?');
      params.push(endDate);
    }

    const whereClause = whereConditions.join(' AND ');

    const countRes = await req.tenantDb.query(`SELECT COUNT(*) AS total FROM users WHERE ${whereClause}`, params);
    const total = countRes.rows && countRes.rows[0] ? Number(countRes.rows[0].total || countRes.rows[0]['COUNT(*)'] || 0) : 0;

    const allowedSortCols = ['name', 'email', 'role', 'status', 'created_at'];
    const sortCol = allowedSortCols.includes(req.query.sort_by) ? req.query.sort_by : 'created_at';
    const sortDir = req.query.sort_order?.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const listRes = await req.tenantDb.query(
      `SELECT id, name, email, role, roles, status, is_primary_owner, created_at, last_login_at
       FROM users
       WHERE ${whereClause}
       ORDER BY ${sortCol} ${sortDir}
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const users = listRes.rows.map((u) => {
      let roleList = [u.role || 'accounts'];
      if (u.roles) {
        try {
          roleList = typeof u.roles === 'string' && u.roles.startsWith('[') ? JSON.parse(u.roles) : String(u.roles).split(',').map(s=>s.trim()).filter(Boolean);
        } catch {
          roleList = String(u.roles).split(',').map(s=>s.trim()).filter(Boolean);
        }
      }
      const isPrimary = Boolean(
        u.is_primary_owner ||
        (primaryOwnerId && u.id === primaryOwnerId) ||
        (primaryOwnerEmail && u.email === primaryOwnerEmail)
      );
      return {
        ...u,
        roles: roleList.length > 0 ? roleList : [u.role || 'accounts'],
        is_primary_owner: isPrimary
      };
    });

    return res.json({
      items: users,
      users: users,
      total,
      page,
      limit,
      total_pages: Math.ceil(total / limit),
      meta: {
        page,
        page_size: limit,
        total,
        total_pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('list users error', err);
    return res.status(500).json({ error: 'Failed to list users' });
  }
});

// Directly create a user
router.post('/', requireAuth, requirePermission('users', 'create'), async (req, res) => {
  const { name, email, password, role, roles, vendor_id, customer_id } = req.body;
  const companyId = req.user.company_id || req.user.workspace_id;
  const userId = req.user.user_id || req.user.id;

  const assignedRoles = Array.isArray(roles) && roles.length > 0 ? roles : (role ? [role] : ['staff']);
  const primaryRole = assignedRoles[0] || 'staff';
  const rolesString = assignedRoles.join(',');

  const requesterRoles = req.user.roles && Array.isArray(req.user.roles) ? req.user.roles : [req.user.role];
  const isOwnerOrAdmin = requesterRoles.includes('owner') || requesterRoles.includes('admin') || req.user.role === 'owner' || req.user.role === 'admin';
  if (!isOwnerOrAdmin && (assignedRoles.includes('owner') || assignedRoles.includes('admin'))) {
    return res.status(403).json({ error: 'Only workspace owners and administrators can create owner or admin accounts.' });
  }

  if (!name || !email || !primaryRole) return res.status(400).json({ error: 'name, email, role required' });

  // Invariant enforcement
  if (assignedRoles.includes('vendor') && !vendor_id) {
    return res.status(400).json({ error: 'vendor_id is required when creating a vendor user' });
  }
  if (assignedRoles.includes('customer') && !customer_id) {
    return res.status(400).json({ error: 'customer_id is required when creating a customer user' });
  }

  const normalizedEmail = email.toLowerCase().trim();

  // Check Master DB to ensure email is not already mapped (active)
  const masterCheck = await queryMaster('SELECT id, status FROM company_users WHERE email = ? AND status != "deleted"', [normalizedEmail]);
  if (masterCheck.rowCount > 0) {
    return res.status(400).json({ error: 'User email is already registered' });
  }

  const tenantClient = await req.tenantDb.connect();

  try {
    await tenantClient.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS roles TEXT NULL').catch(() => {});
    const pw = password || '123456';
    const hash = await bcrypt.hash(pw, BCRYPT_ROUNDS);
    const newUserId = crypto.randomUUID();

    await tenantClient.query('START TRANSACTION');
    await tenantClient.query(
      'INSERT INTO users (id, name, email, password_hash, role, roles, status) VALUES (?, ?, ?, ?, ?, ?, "active")',
      [newUserId, name, normalizedEmail, hash, primaryRole, rolesString]
    );

    const newUser = { id: newUserId, name, email: normalizedEmail, role: primaryRole, roles: assignedRoles };

    const auditId = crypto.randomUUID();
    await tenantClient.query(
      `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, metadata)
       VALUES (?, ?, 'create', 'user', ?, ?)`,
      [auditId, userId, newUser.id, JSON.stringify({ email: normalizedEmail, role: primaryRole, roles: assignedRoles, vendor_id, customer_id })]
    );
    await tenantClient.query('COMMIT');

    // Register in Master DB company_users
    await queryMaster('ALTER TABLE company_users ADD COLUMN IF NOT EXISTS roles TEXT NULL').catch(() => {});
    const companyUserId = crypto.randomUUID();
    await queryMaster(
      `INSERT INTO company_users (id, company_id, email, user_id, role, roles, status)
       VALUES (?, ?, ?, ?, ?, ?, 'active')`,
      [companyUserId, companyId, normalizedEmail, newUser.id, primaryRole, rolesString]
    );

    return res.status(201).json({ user: newUser, temp_password: password ? undefined : pw });
  } catch (err) {
    await tenantClient.query('ROLLBACK').catch(() => {});
    console.error('create user error', err);
    return res.status(500).json({ error: 'Failed to create user' });
  } finally {
    tenantClient.release();
  }
});

// Update user roles
router.put('/:id/role', requireAuth, requirePermission('users', 'edit'), async (req, res) => {
  const { role, roles } = req.body;
  const assignedRoles = Array.isArray(roles) && roles.length > 0 ? roles : (role ? [role] : ['staff']);
  const primaryRole = assignedRoles[0] || 'staff';
  const rolesString = assignedRoles.join(',');
  const companyId = req.user.company_id || req.user.workspace_id;
  const targetId = req.params.id;

  const requesterRoles = req.user.roles && Array.isArray(req.user.roles) ? req.user.roles : [req.user.role];
  const isOwnerOrAdmin = requesterRoles.includes('owner') || requesterRoles.includes('admin') || req.user.role === 'owner' || req.user.role === 'admin';
  if (!isOwnerOrAdmin && (assignedRoles.includes('owner') || assignedRoles.includes('admin'))) {
    return res.status(403).json({ error: 'Only workspace owners and administrators can assign owner or admin roles.' });
  }

  try {
    await req.tenantDb.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS roles TEXT NULL').catch(() => {});
    await req.tenantDb.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_primary_owner TINYINT(1) NOT NULL DEFAULT 0').catch(() => {});
    await queryMaster('ALTER TABLE company_users ADD COLUMN IF NOT EXISTS roles TEXT NULL').catch(() => {});

    // Check if target is primary owner
    const targetRes = await req.tenantDb.query('SELECT id, email, role, roles, is_primary_owner FROM users WHERE id = ?', [targetId]);
    if (targetRes.rowCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    const targetUser = targetRes.rows[0];

    let primaryOwnerId = null;
    let primaryOwnerEmail = null;
    try {
      const cRes = await queryMaster('SELECT primary_owner_id, primary_owner_email FROM companies WHERE id = ?', [companyId]);
      if (cRes.rows && cRes.rows[0]) {
        primaryOwnerId = cRes.rows[0].primary_owner_id;
        primaryOwnerEmail = cRes.rows[0].primary_owner_email;
      }
    } catch {}

    const isPrimary = Boolean(
      targetUser.is_primary_owner ||
      (primaryOwnerId && targetUser.id === primaryOwnerId) ||
      (primaryOwnerEmail && targetUser.email === primaryOwnerEmail)
    );

    if (isPrimary && !assignedRoles.includes('owner')) {
      return res.status(400).json({ error: 'The primary workspace owner role cannot be demoted or removed.' });
    }

    await req.tenantDb.query('UPDATE users SET role = ?, roles = ? WHERE id = ?', [primaryRole, rolesString, targetId]);
    await queryMaster('UPDATE company_users SET role = ?, roles = ? WHERE user_id = ?', [primaryRole, rolesString, targetId]);

    return res.json({ ok: true, role: primaryRole, roles: assignedRoles });
  } catch (err) {
    console.error('update user role error', err);
    return res.status(500).json({ error: 'Failed to update user roles' });
  }
});

// Soft-delete user from workspace
router.delete('/:id', requireAuth, requirePermission('users', 'delete'), async (req, res) => {
  const currentUserId = req.user.user_id || req.user.id;
  const targetId = req.params.id;
  const companyId = req.user.company_id || req.user.workspace_id;

  if (targetId === currentUserId) {
    return res.status(400).json({ error: 'You cannot remove your own account from the workspace.' });
  }

  try {
    // Check if user exists in tenant DB
    const checkRes = await req.tenantDb.query('SELECT id, name, email, role, is_primary_owner FROM users WHERE id = ? AND deleted_at IS NULL', [targetId]);
    if (checkRes.rowCount === 0) {
      return res.status(404).json({ error: 'User not found or already removed' });
    }
    const targetUser = checkRes.rows[0];

    let primaryOwnerId = null;
    let primaryOwnerEmail = null;
    try {
      const cRes = await queryMaster('SELECT primary_owner_id, primary_owner_email FROM companies WHERE id = ?', [companyId]);
      if (cRes.rows && cRes.rows[0]) {
        primaryOwnerId = cRes.rows[0].primary_owner_id;
        primaryOwnerEmail = cRes.rows[0].primary_owner_email;
      }
    } catch {}

    const isPrimary = Boolean(
      targetUser.is_primary_owner ||
      (primaryOwnerId && targetUser.id === primaryOwnerId) ||
      (primaryOwnerEmail && targetUser.email === primaryOwnerEmail)
    );

    if (isPrimary) {
      return res.status(400).json({ error: 'The primary workspace owner cannot be removed from the workspace.' });
    }

    const requesterRoles = req.user.roles && Array.isArray(req.user.roles) ? req.user.roles : [req.user.role];
    const isOwnerOrAdmin = requesterRoles.includes('owner') || requesterRoles.includes('admin') || req.user.role === 'owner' || req.user.role === 'admin';
    if (!isOwnerOrAdmin && (targetUser.role === 'owner' || targetUser.role === 'admin')) {
      return res.status(403).json({ error: 'Only workspace owners and administrators can remove owners or admins.' });
    }

    // Mark deleted in tenant DB
    await req.tenantDb.query('UPDATE users SET deleted_at = NOW(), status = "deleted" WHERE id = ?', [targetId]);

    // Update status in Master DB company_users
    await queryMaster('UPDATE company_users SET status = "deleted" WHERE user_id = ? AND company_id = ?', [targetId, companyId]);

    // Log to audit log
    const auditId = crypto.randomUUID();
    await req.tenantDb.query(
      `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, metadata)
       VALUES (?, ?, 'delete', 'user', ?, ?)`,
      [auditId, currentUserId, targetId, JSON.stringify({ email: targetUser.email, name: targetUser.name, role: targetUser.role })]
    ).catch(() => {});

    return res.json({ ok: true, deleted: true, message: `User ${targetUser.name} removed successfully` });
  } catch (err) {
    console.error('delete user error', err);
    return res.status(500).json({ error: 'Failed to remove user' });
  }
});

// List pending invites (excludes already accepted member accounts)
router.get('/invites', requireAuth, requirePermission('users', 'view'), async (req, res) => {
  const companyId = req.user.company_id || req.user.workspace_id;
  try {
    const page = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit || req.query.page_size || '20', 10)));
    const offset = (page - 1) * limit;
    const search = (req.query.search || '').trim().toLowerCase();
    const roleFilter = (req.query.role || '').trim().toLowerCase();
    const startDate = (req.query.start_date || '').trim();
    const endDate = (req.query.end_date || '').trim();

    let whereConditions = ['company_id = ?', 'accepted_at IS NULL'];
    const params = [companyId];

    if (search) {
      whereConditions.push('(LOWER(email) LIKE ? OR LOWER(role) LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }

    if (roleFilter) {
      whereConditions.push('LOWER(role) = ?');
      params.push(roleFilter);
    }

    if (startDate) {
      whereConditions.push('DATE(created_at) >= ?');
      params.push(startDate);
    }

    if (endDate) {
      whereConditions.push('DATE(created_at) <= ?');
      params.push(endDate);
    }

    const whereClause = whereConditions.join(' AND ');

    const countRes = await queryMaster(`SELECT COUNT(*) AS total FROM company_invites WHERE ${whereClause}`, params);
    const total = countRes.rows && countRes.rows[0] ? Number(countRes.rows[0].total || 0) : 0;

    const allowedSortCols = ['email', 'role', 'created_at', 'expires_at'];
    const sortCol = allowedSortCols.includes(req.query.sort_by) ? req.query.sort_by : 'created_at';
    const sortDir = req.query.sort_order?.toLowerCase() === 'asc' ? 'ASC' : 'DESC';

    const listRes = await queryMaster(
      `SELECT id, email, role, token, accepted_at, expires_at, created_at
       FROM company_invites
       WHERE ${whereClause}
       ORDER BY ${sortCol} ${sortDir}
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return res.json({
      items: listRes.rows,
      invites: listRes.rows,
      total,
      page,
      limit,
      total_pages: Math.ceil(total / limit)
    });
  } catch (err) {
    console.error('list invites error', err);
    return res.status(500).json({ error: 'Failed to list invites' });
  }
});

// Create invite
router.post('/invites', requireAuth, requirePermission('users', 'create'), async (req, res) => {
  const { email, role } = req.body;
  const companyId = req.user.company_id || req.user.workspace_id;
  const userId = req.user.user_id || req.user.id;

  if (!email || !role || !VALID_ROLES.includes(role)) {
    return res.status(400).json({ error: 'Valid email and role are required' });
  }

  const requesterRoles = req.user.roles && Array.isArray(req.user.roles) ? req.user.roles : [req.user.role];
  const isOwnerOrAdmin = requesterRoles.includes('owner') || requesterRoles.includes('admin') || req.user.role === 'owner' || req.user.role === 'admin';
  if (!isOwnerOrAdmin && (role === 'owner' || role === 'admin')) {
    return res.status(403).json({ error: 'Only workspace owners and administrators can invite new owners or admins.' });
  }

  const normalizedEmail = email.toLowerCase().trim();

  // Check if active user already exists with this email in this company
  const activeCheck = await queryMaster(
    'SELECT id FROM company_users WHERE email = ? AND company_id = ? AND status != "deleted"',
    [normalizedEmail, companyId]
  );
  if (activeCheck.rowCount > 0) {
    return res.status(400).json({ error: 'A team member with this email is already active in this workspace' });
  }

  try {
    // Clean up any pending unaccepted invites for this email in this company
    await queryMaster(
      'DELETE FROM company_invites WHERE company_id = ? AND email = ? AND accepted_at IS NULL',
      [companyId, normalizedEmail]
    ).catch(() => {});

    const token = crypto.randomBytes(24).toString('hex');
    const inviteId = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

    await queryMaster(
      `INSERT INTO company_invites (id, company_id, email, role, token, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [inviteId, companyId, normalizedEmail, role, token, expiresAt]
    );

    const inviteRecord = {
      id: inviteId,
      company_id: companyId,
      email: normalizedEmail,
      role,
      token,
      expires_at: expiresAt,
      created_at: new Date()
    };

    if (req.tenantDb) {
      const auditId = crypto.randomUUID();
      await req.tenantDb.query(
        `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, metadata)
         VALUES (?, ?, 'invite', 'user', NULL, ?)`,
        [auditId, userId, JSON.stringify({ email: normalizedEmail, role })]
      ).catch(() => {});
    }

    const base = process.env.FRONTEND_URL || 'http://localhost:5173';
    return res.status(201).json({ ...inviteRecord, signup_link: `${base}/accept-invite?token=${token}` });
  } catch (err) {
    console.error('create invite error', err);
    return res.status(500).json({ error: 'Failed to create invite' });
  }
});

// Revoke invite
router.delete('/invites/:id', requireAuth, requirePermission('users', 'delete'), async (req, res) => {
  const companyId = req.user.company_id || req.user.workspace_id;
  const inviteId = req.params.id;
  const currentUserId = req.user.user_id || req.user.id;

  try {
    const inviteRes = await queryMaster('SELECT id, email, role FROM company_invites WHERE id = ? AND company_id = ?', [inviteId, companyId]);
    if (inviteRes.rowCount === 0) {
      return res.status(404).json({ error: 'Invitation not found' });
    }

    await queryMaster('DELETE FROM company_invites WHERE id = ? AND company_id = ?', [inviteId, companyId]);

    if (req.tenantDb) {
      const auditId = crypto.randomUUID();
      await req.tenantDb.query(
        `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, metadata)
         VALUES (?, ?, 'delete', 'invite', ?, ?)`,
        [auditId, currentUserId, inviteId, JSON.stringify({ email: inviteRes.rows[0].email, role: inviteRes.rows[0].role })]
      ).catch(() => {});
    }

    return res.json({ ok: true, revoked: true, message: 'Invitation revoked successfully' });
  } catch (err) {
    console.error('revoke invite error', err);
    return res.status(500).json({ error: 'Failed to revoke invitation' });
  }
});

// Get single invite details
router.get('/invites/:id', requireAuth, requirePermission('users', 'view'), async (req, res) => {
  const companyId = req.user.company_id || req.user.workspace_id;
  const inviteId = req.params.id;

  try {
    const inviteRes = await queryMaster(
      'SELECT id, company_id, email, role, token, created_at, expires_at FROM company_invites WHERE id = ? AND company_id = ?',
      [inviteId, companyId]
    );
    if (inviteRes.rowCount === 0) {
      return res.status(404).json({ error: 'Invitation not found' });
    }

    const invite = inviteRes.rows[0];
    const base = process.env.FRONTEND_URL || 'http://localhost:5173';
    return res.json({
      ...invite,
      invite_link: invite.token ? `${base}/accept-invite?token=${invite.token}` : ''
    });
  } catch (err) {
    console.error('get invite details error', err);
    return res.status(500).json({ error: 'Failed to fetch invitation details' });
  }
});

// Get single user details
router.get('/:id', requireAuth, requirePermission('users', 'view'), async (req, res) => {
  const targetId = req.params.id;
  const companyId = req.user.company_id || req.user.workspace_id;

  try {
    let primaryOwnerId = null;
    let primaryOwnerEmail = null;
    try {
      const cRes = await queryMaster('SELECT primary_owner_id, primary_owner_email FROM companies WHERE id = ?', [companyId]);
      if (cRes.rows && cRes.rows[0]) {
        primaryOwnerId = cRes.rows[0].primary_owner_id;
        primaryOwnerEmail = cRes.rows[0].primary_owner_email;
      }
    } catch {}

    await req.tenantDb.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50) NULL').catch(() => {});
    await req.tenantDb.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS roles TEXT NULL').catch(() => {});
    await req.tenantDb.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS is_primary_owner TINYINT(1) NOT NULL DEFAULT 0').catch(() => {});

    const uRes = await req.tenantDb.query(
      `SELECT id, name, email, phone, role, roles, status, is_primary_owner, created_at, last_login_at
       FROM users WHERE id = ? AND deleted_at IS NULL`,
      [targetId]
    );

    if (uRes.rowCount === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const u = uRes.rows[0];
    let roleList = [u.role || 'accounts'];
    if (u.roles) {
      try {
        roleList = typeof u.roles === 'string' && u.roles.startsWith('[')
          ? JSON.parse(u.roles)
          : String(u.roles).split(',').map(s => s.trim()).filter(Boolean);
      } catch {
        roleList = String(u.roles).split(',').map(s => s.trim()).filter(Boolean);
      }
    }

    const isPrimary = Boolean(
      u.is_primary_owner ||
      (primaryOwnerId && u.id === primaryOwnerId) ||
      (primaryOwnerEmail && u.email === primaryOwnerEmail)
    );

    return res.json({
      ...u,
      roles: roleList.length > 0 ? roleList : [u.role || 'accounts'],
      is_primary_owner: isPrimary
    });
  } catch (err) {
    console.error('get user details error', err);
    return res.status(500).json({ error: 'Failed to fetch user details' });
  }
});

function validateStrongPassword(password) {
  if (!password || typeof password !== 'string') return 'Password is required';
  if (password.length < 8) return 'Password must be at least 8 characters long';
  if (!/[A-Z]/.test(password)) return 'Password must contain at least one uppercase letter (A-Z)';
  if (!/[a-z]/.test(password)) return 'Password must contain at least one lowercase letter (a-z)';
  if (!/[0-9]/.test(password)) return 'Password must contain at least one number (0-9)';
  if (!/[!@#$%^&*()_+\-=\[\]{};':"\\|,.<>\/?~`]/.test(password)) return 'Password must contain at least one special character (like @, #, $, _)';
  if (/\s/.test(password)) return 'Password cannot contain spaces';
  return null;
}

// Accept invite (O(1) Master DB lookup)
router.post('/accept-invite', async (req, res) => {
  const { token, name, password } = req.body;
  if (!token || !password) {
    return res.status(400).json({ error: 'Token and password are required' });
  }
  const passError = validateStrongPassword(password);
  if (passError) {
    return res.status(400).json({ error: passError });
  }

  // Single O(1) Master DB lookup
  const inviteRes = await queryMaster(
    `SELECT ci.id, ci.company_id, ci.email, ci.role, ci.accepted_at, ci.expires_at, c.database_name, c.status AS company_status
     FROM company_invites ci
     JOIN companies c ON c.id = ci.company_id
     WHERE ci.token = ?`,
    [token]
  );

  if (inviteRes.rowCount === 0) {
    return res.status(400).json({ error: 'Invalid or expired invitation token' });
  }

  const inviteRecord = inviteRes.rows[0];

  if (inviteRecord.accepted_at || new Date(inviteRecord.expires_at) <= new Date() || inviteRecord.company_status !== 'active') {
    return res.status(400).json({ error: 'Invalid or expired invitation token' });
  }

  const normalizedEmail = inviteRecord.email.toLowerCase().trim();
  const displayName = (name && name.trim()) ? name.trim() : normalizedEmail.split('@')[0];

  // Check if active user already exists in Master DB
  const existingMaster = await queryMaster('SELECT id, status FROM company_users WHERE email = ? AND company_id = ?', [normalizedEmail, inviteRecord.company_id]);
  if (existingMaster.rowCount > 0 && existingMaster.rows[0].status !== 'deleted') {
    return res.status(400).json({ error: 'An active user with this email is already registered in this workspace' });
  }

  const targetTenantPool = getTenantPool(inviteRecord.database_name);
  const tenantClient = await targetTenantPool.connect();

  try {
    await tenantClient.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS roles TEXT NULL').catch(() => {});
    await tenantClient.query('START TRANSACTION');
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const newUserId = crypto.randomUUID();

    // Check if soft-deleted user existed in tenant DB
    const existingTenantUser = await tenantClient.query('SELECT id FROM users WHERE email = ?', [normalizedEmail]);
    let resolvedUserId = newUserId;
    if (existingTenantUser.rowCount > 0) {
      resolvedUserId = existingTenantUser.rows[0].id;
      await tenantClient.query(
        `UPDATE users SET name = ?, password_hash = ?, role = ?, roles = ?, status = 'active', deleted_at = NULL, last_login_at = NOW() WHERE email = ?`,
        [displayName, hash, inviteRecord.role, inviteRecord.role, normalizedEmail]
      );
    } else {
      await tenantClient.query(
        `INSERT INTO users (id, name, email, password_hash, role, roles, status, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', NOW())`,
        [newUserId, displayName, normalizedEmail, hash, inviteRecord.role, inviteRecord.role]
      );
    }

    const auditId = crypto.randomUUID();
    await tenantClient.query(
      `INSERT INTO audit_log (id, user_id, action, entity_type, entity_id, metadata)
       VALUES (?, ?, 'accept_invite', 'user', ?, ?)`,
      [auditId, resolvedUserId, resolvedUserId, JSON.stringify({ email: normalizedEmail, role: inviteRecord.role, name: displayName })]
    );
    await tenantClient.query('COMMIT');

    // Mark accepted in Master DB company_invites
    await queryMaster('UPDATE company_invites SET accepted_at = NOW() WHERE id = ?', [inviteRecord.id]);

    // Register / reactivate in Master DB company_users
    await queryMaster('ALTER TABLE company_users ADD COLUMN IF NOT EXISTS roles TEXT NULL').catch(() => {});
    if (existingMaster.rowCount > 0) {
      await queryMaster(
        `UPDATE company_users SET status = 'active', role = ?, roles = ? WHERE id = ?`,
        [inviteRecord.role, inviteRecord.role, existingMaster.rows[0].id]
      );
    } else {
      const companyUserId = crypto.randomUUID();
      await queryMaster(
        `INSERT INTO company_users (id, company_id, email, user_id, role, roles, status)
         VALUES (?, ?, ?, ?, ?, ?, 'active')`,
        [companyUserId, inviteRecord.company_id, normalizedEmail, resolvedUserId, inviteRecord.role, inviteRecord.role]
      );
    }

    // Fetch user details for immediate login session
    await tenantClient.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS phone VARCHAR(50) NULL').catch(() => {});
    await tenantClient.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url LONGTEXT NULL').catch(() => {});
    await tenantClient.query('ALTER TABLE users ADD COLUMN IF NOT EXISTS bio TEXT NULL').catch(() => {});
    const userRes = await tenantClient.query(
      `SELECT id, name, email, phone, avatar_url, bio, role, roles, status, created_at, last_login_at
       FROM users WHERE id = ? AND deleted_at IS NULL`,
      [resolvedUserId]
    );

    const user = userRes.rows[0] || {
      id: resolvedUserId,
      name: displayName,
      email: normalizedEmail,
      role: inviteRecord.role,
      roles: [inviteRecord.role],
      status: 'active'
    };
    user.workspace_id = inviteRecord.company_id;
    user.company_id = inviteRecord.company_id;

    const userRoles = parseRoles(user.roles, user.role || inviteRecord.role);
    user.roles = userRoles;

    const token = issueAccessToken(user, inviteRecord.company_id);
    const refreshToken = buildRefreshToken();

    await persistRefreshToken(tenantClient, user, refreshToken);
    setAuthCookies(res, token, refreshToken);

    // Fetch live module permissions
    const placeholders = userRoles.map(() => '?').join(',');
    const permRes = await tenantClient.query(
      `SELECT module, MAX(can_view) AS can_view, MAX(can_create) AS can_create, MAX(can_edit) AS can_edit, MAX(can_delete) AS can_delete, MAX(can_approve) AS can_approve, MAX(can_export) AS can_export
       FROM role_permissions WHERE role IN (${placeholders}) GROUP BY module`,
      userRoles
    ).catch(() => ({ rows: [] }));
    user.permissions = permRes.rows || [];

    // Fetch company/workspace metadata
    const compRes = await queryMaster(
      'SELECT id, company_name, business_type, currency, status, number_system FROM companies WHERE id = ?',
      [inviteRecord.company_id]
    );
    const workspace = compRes.rows[0] ? {
      ...compRes.rows[0],
      name: compRes.rows[0].company_name
    } : {
      id: inviteRecord.company_id,
      name: 'Workspace'
    };

    return res.json({
      ok: true,
      token,
      refresh_token: refreshToken,
      workspace_id: inviteRecord.company_id,
      company_id: inviteRecord.company_id,
      permissions: user.permissions,
      user,
      workspace,
      message: 'Account activated successfully!'
    });
  } catch (err) {
    await tenantClient.query('ROLLBACK').catch(() => {});
    console.error('accept invite error', err);
    return res.status(500).json({ error: 'Failed to accept invitation' });
  } finally {
    tenantClient.release();
  }
});

module.exports = router;
