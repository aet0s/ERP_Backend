const axios = require('axios');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: __dirname + '/../.env' });

async function testMemberReflection() {
  const companyId = '03867519-ebfd-4d79-8e8e-7f9c5308f664';
  const ownerId = '308bfdbb-050d-4d38-9130-e2321a9caddd';
  const memberId = '713b0b16-15f5-47bc-8423-1fac9648dcf6'; // staff@apollo.com

  const ownerToken = jwt.sign(
    {
      id: ownerId, user_id: ownerId, company_id: companyId, workspace_id: companyId,
      email: 'inf@apollo.com', name: 'Hardick', role: 'owner', roles: ['owner']
    },
    process.env.JWT_SECRET, { expiresIn: '1d' }
  );

  const memberToken = jwt.sign(
    {
      id: memberId, user_id: memberId, company_id: companyId, workspace_id: companyId,
      email: 'staff@apollo.com', name: 'Apollo Staff', role: 'staff', roles: ['staff']
    },
    process.env.JWT_SECRET, { expiresIn: '1d' }
  );

  console.log('--- Step 1: Member calls /auth/me initially ---');
  const me1 = await axios.get('http://localhost:4000/auth/me', {
    headers: { Authorization: `Bearer ${memberToken}` }
  });
  const staffSalesPerm1 = me1.data.permissions.find(p => p.module === 'sales');
  console.log('Staff sales permission before toggle:', staffSalesPerm1);

  console.log('--- Step 2: Member calls GET /api/sales ---');
  try {
    const salesRes1 = await axios.get('http://localhost:4000/api/sales', {
      headers: { Authorization: `Bearer ${memberToken}` }
    });
    console.log('Member access to /api/sales before:', salesRes1.status);
  } catch (err) {
    console.log('Member access to /api/sales before error:', err.response?.status, err.response?.data);
  }

  console.log('--- Step 3: Owner toggles staff sales permission: set can_view = 0 ---');
  // Fetch existing permissions
  const permMatrixRes = await axios.get('http://localhost:4000/api/permissions', {
    headers: { Authorization: `Bearer ${ownerToken}` }
  });
  const permissions = permMatrixRes.data;
  const staffSales = permissions.find(p => p.role === 'staff' && p.module === 'sales');
  staffSales.can_view = 0;
  staffSales.can_create = 0;

  const updateRes = await axios.put('http://localhost:4000/api/permissions', { permissions }, {
    headers: { Authorization: `Bearer ${ownerToken}` }
  });
  console.log('Owner update result:', updateRes.data.ok, 'applied:', updateRes.data.applied);

  console.log('--- Step 4: Member calls /auth/me after toggle ---');
  const me2 = await axios.get('http://localhost:4000/auth/me', {
    headers: { Authorization: `Bearer ${memberToken}` }
  });
  const staffSalesPerm2 = me2.data.permissions.find(p => p.module === 'sales');
  console.log('Staff sales permission after toggle:', staffSalesPerm2);

  console.log('--- Step 5: Member calls GET /api/sales after toggle ---');
  try {
    const salesRes2 = await axios.get('http://localhost:4000/api/sales', {
      headers: { Authorization: `Bearer ${memberToken}` }
    });
    console.log('Member access to /api/sales after:', salesRes2.status);
  } catch (err) {
    console.log('Member access to /api/sales after error:', err.response?.status, err.response?.data);
  }

  console.log('--- Step 6: Restore staff sales permission ---');
  staffSales.can_view = 1;
  staffSales.can_create = 1;
  await axios.put('http://localhost:4000/api/permissions', { permissions }, {
    headers: { Authorization: `Bearer ${ownerToken}` }
  });
  console.log('Restored permissions.');
}

testMemberReflection().catch(console.error);
