'use strict';

/**
 * locationBoundary.js — Middleware & helpers for enforcing user location boundaries.
 */

async function getUserAllowedLocationIds(req) {
  if (!req.user) return null;

  // Owner always has unrestricted access across all locations
  if (req.user.role === 'owner') {
    return null;
  }

  try {
    const res = await req.tenantDb.query(
      'SELECT location_id FROM user_location_assignments WHERE user_id = ?',
      [req.user.id]
    );

    if (res.rowCount === 0) {
      return null; // Unrestricted if no location assignment records exist
    }

    return res.rows.map(r => r.location_id);
  } catch (err) {
    console.error('Error fetching user location assignments:', err);
    return null;
  }
}

function enforceLocationBoundary(req, res, next) {
  getUserAllowedLocationIds(req).then(allowedIds => {
    if (!allowedIds || allowedIds.length === 0) {
      return next(); // Unrestricted
    }

    const requestedLocId = req.body?.location_id || req.query?.location_id || req.params?.location_id;
    if (requestedLocId && !allowedIds.includes(requestedLocId)) {
      return res.status(403).json({ error: `Forbidden: Access denied for location '${requestedLocId}'` });
    }

    req.allowedLocationIds = allowedIds;
    return next();
  }).catch(err => {
    console.error('Location boundary error:', err);
    return res.status(500).json({ error: 'Failed to verify location permissions' });
  });
}

module.exports = { getUserAllowedLocationIds, enforceLocationBoundary };
