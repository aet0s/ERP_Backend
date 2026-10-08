'use strict';

/**
 * roles.js — Canonical Single Source of Truth for ERP Roles & Resolution
 */

const INTERNAL_ROLES = [
  'owner',
  'admin',
  'manager',
  'accounts',
  'production_manager',
  'sales_manager',
  'staff'
];

const ASSIGNABLE_ROLES = [
  'owner',
  'admin',
  'manager',
  'accounts',
  'production_manager',
  'sales_manager',
  'staff'
];

const PORTAL_ROLES = [
  'vendor',
  'customer'
];

/**
 * Parse raw roles representation into an array of string role names.
 */
function parseRoles(rawRoles, fallbackRole = 'accounts') {
  if (Array.isArray(rawRoles)) {
    const list = rawRoles.map((r) => String(r).trim()).filter(Boolean);
    return list.length > 0 ? list : (fallbackRole ? [fallbackRole] : ['staff']);
  }
  if (!rawRoles) {
    return fallbackRole ? [fallbackRole] : ['staff'];
  }
  if (typeof rawRoles === 'string') {
    const trimmed = rawRoles.trim();
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) {
          const list = parsed.map((r) => String(r).trim()).filter(Boolean);
          return list.length > 0 ? list : (fallbackRole ? [fallbackRole] : ['staff']);
        }
      } catch (_) {}
    }
    const list = trimmed.split(',').map((r) => r.trim()).filter(Boolean);
    return list.length > 0 ? list : (fallbackRole ? [fallbackRole] : ['staff']);
  }
  return fallbackRole ? [fallbackRole] : ['staff'];
}

/**
 * Resolve effective roles for a user.
 * Rule: The primary `role` column is authoritative; if roles[0] !== role, return [role].
 */
function resolveUserRoles(role, rawRoles) {
  const primaryRole = role ? String(role).trim() : null;
  if (!primaryRole) {
    return parseRoles(rawRoles, 'staff');
  }

  const parsed = parseRoles(rawRoles, primaryRole);
  if (parsed.length === 0 || parsed[0] !== primaryRole) {
    return [primaryRole];
  }

  return Array.from(new Set(parsed));
}

/**
 * Normalise role and/or roles assignment into consistent { primaryRole, roles, assignedRoles, rolesString }.
 */
function normaliseAssignment(role, roles) {
  let list = [];
  if (Array.isArray(roles)) {
    list = roles.map((r) => String(r).trim()).filter(Boolean);
  } else if (typeof roles === 'string') {
    list = parseRoles(roles, null);
  }

  const primary = role ? String(role).trim() : (list[0] || 'staff');

  if (list.length === 0) {
    list = [primary];
  } else if (!list.includes(primary)) {
    list = [primary, ...list];
  } else if (list[0] !== primary) {
    list = [primary, ...list.filter((r) => r !== primary)];
  }

  const assignedRoles = Array.from(new Set(list));
  const primaryRole = assignedRoles[0] || primary;
  const rolesString = assignedRoles.join(',');

  return {
    primaryRole,
    roles: assignedRoles,
    assignedRoles,
    rolesString
  };
}

module.exports = {
  INTERNAL_ROLES,
  ASSIGNABLE_ROLES,
  PORTAL_ROLES,
  parseRoles,
  resolveUserRoles,
  normaliseAssignment
};
