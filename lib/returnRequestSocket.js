'use strict';

const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const { queryMaster } = require('../db/masterDb');
const { getTenantPool } = require('../db/tenantManager');

const JWT_SECRET = process.env.JWT_SECRET;
const subscribers = new Map();

function tenantKey(tenantDb) {
  return tenantDb.databaseName || tenantDb.dbName || tenantDb;
}

function getToken(request, url) {
  const queryToken = url.searchParams.get('token') || url.searchParams.get('access_token');
  if (queryToken) return queryToken;

  const authorization = request.headers.authorization;
  if (authorization && authorization.startsWith('Bearer ')) return authorization.slice(7);

  const cookies = request.headers.cookie || '';
  for (const cookieName of ['erp_token', 'erp_access_token', 'erp_vendor_portal_token', 'erp_customer_portal_token']) {
    const cookie = cookies.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${cookieName}=`));
    if (cookie) return decodeURIComponent(cookie.slice(cookieName.length + 1));
  }
  return null;
}

async function resolveConnection(request, url) {
  const token = getToken(request, url);
  if (!token) throw new Error('Missing authentication token');

  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET, { ignoreExpiration: true });
  } catch {
    throw new Error('Invalid authentication token');
  }

  if (['vendor', 'customer', 'universal'].includes(payload.portal_type)) {
    const companyId = url.searchParams.get('company_id') || payload.company_id;
    const globalUserId = payload.global_user_id || payload.portal_user_id;
    if (!companyId || !globalUserId) throw new Error('Invalid portal token');
    const membership = await queryMaster(
      `SELECT gpm.*, c.database_name, c.status AS company_status
       FROM global_portal_memberships gpm
       JOIN companies c ON c.id = gpm.company_id
       WHERE gpm.global_user_id = ? AND gpm.company_id = ? AND gpm.status = 'Active'`,
      [globalUserId, companyId]
    );
    const activeMembership = membership.rows[0];
    const portalType = payload.portal_type === 'universal'
      ? activeMembership?.portal_type
      : payload.portal_type;
    if (!activeMembership || !['vendor', 'customer'].includes(portalType)) {
      throw new Error('Portal access denied');
    }
    if (['suspended', 'cancelled', 'paused', 'deleted'].includes(activeMembership.company_status)) {
      throw new Error('Workspace is not active');
    }

    return {
      tenantDb: getTenantPool(activeMembership.database_name),
      portalType,
      entityId: activeMembership.entity_id
    };
  }

  const companyId = payload.company_id || payload.workspace_id;
  if (!companyId) throw new Error('Invalid token payload');
  const company = await queryMaster(
    'SELECT database_name, status FROM companies WHERE id = ?',
    [companyId]
  );
  const activeCompany = company.rows[0];
  if (!activeCompany) throw new Error('Workspace not found');
  if (['suspended', 'cancelled', 'paused', 'deleted'].includes(activeCompany.status)) {
    throw new Error('Workspace is not active');
  }

  return {
    tenantDb: getTenantPool(activeCompany.database_name),
    portalType: 'erp_user'
  };
}

async function authorizeRequest(connection, returnRequestId) {
  const result = await connection.tenantDb.query(
    'SELECT id, vendor_id, customer_id FROM return_requests WHERE id = ?',
    [returnRequestId]
  );
  const request = result.rows[0];
  if (!request) throw new Error('Return request not found');

  if (connection.portalType === 'vendor' && request.vendor_id !== connection.entityId) {
    throw new Error('Access denied');
  }
  if (connection.portalType === 'customer' && request.customer_id !== connection.entityId) {
    throw new Error('Access denied');
  }
}

function subscribe(tenantDb, returnRequestId, socket) {
  const key = tenantKey(tenantDb);
  let tenantSubscribers = subscribers.get(key);
  if (!tenantSubscribers) {
    tenantSubscribers = new Map();
    subscribers.set(key, tenantSubscribers);
  }
  let requestSubscribers = tenantSubscribers.get(returnRequestId);
  if (!requestSubscribers) {
    requestSubscribers = new Set();
    tenantSubscribers.set(returnRequestId, requestSubscribers);
  }
  requestSubscribers.add(socket);
  socket.once('close', () => {
    requestSubscribers.delete(socket);
    if (requestSubscribers.size === 0) tenantSubscribers.delete(returnRequestId);
  });
}

function publishReturnRequestMessage(tenantDb, returnRequestId, message) {
  const requestSubscribers = subscribers.get(tenantKey(tenantDb))?.get(returnRequestId);
  if (!requestSubscribers) return;

  const event = JSON.stringify({ type: 'message', message });
  for (const socket of requestSubscribers) {
    if (socket.readyState === 1) socket.send(event);
  }
}

function publishTyping(tenantDb, returnRequestId, sender, isTyping, excludeSocket) {
  const requestSubscribers = subscribers.get(tenantKey(tenantDb))?.get(returnRequestId);
  if (!requestSubscribers) return;

  const event = JSON.stringify({ type: 'typing', sender, isTyping });
  for (const socket of requestSubscribers) {
    if (socket !== excludeSocket && socket.readyState === 1) socket.send(event);
  }
}

function attachReturnRequestSocket(server) {
  const socketServer = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (request, socket, head) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (!url.pathname.startsWith('/ws/return-requests/')) return;

    const returnRequestId = decodeURIComponent(url.pathname.slice('/ws/return-requests/'.length));
    try {
      const connection = await resolveConnection(request, url);
      await authorizeRequest(connection, returnRequestId);
      socketServer.handleUpgrade(request, socket, head, (webSocket) => {
        subscribe(connection.tenantDb, returnRequestId, webSocket);
        webSocket.on('message', (rawMessage) => {
          try {
            const event = JSON.parse(rawMessage.toString());
            if (event.type === 'typing') {
              publishTyping(connection.tenantDb, returnRequestId, connection.portalType, Boolean(event.isTyping), webSocket);
            }
          } catch {
            // Ignore malformed client events.
          }
        });
        webSocket.send(JSON.stringify({ type: 'connected', return_request_id: returnRequestId }));
      });
    } catch (err) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
    }
  });

  return socketServer;
}

module.exports = { attachReturnRequestSocket, publishReturnRequestMessage };