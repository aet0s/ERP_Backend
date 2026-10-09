const axios = require('axios');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: __dirname + '/../.env' });

async function testAllRoles() {
  const companyId = '03867519-ebfd-4d79-8e8e-7f9c5308f664';
  const ownerId = '308bfdbb-050d-4d38-9130-e2321a9caddd';
  const demoUserId = '713b0b16-15f5-47bc-8423-1fac9648dcf6'; // staff@apollo.com

  const ownerToken = jwt.sign(
    {
      id: ownerId, user_id: ownerId, company_id: companyId, workspace_id: companyId,
      email: 'inf@apollo.com', name: 'Hardick', role: 'owner', roles: ['owner']
    },
    process.env.JWT_SECRET, { expiresIn: '1d' }
  );

  const rolesToTest = ['manager', 'accounts', 'production_manager', 'sales_manager', 'staff', 'owner', 'admin'];

  console.log('=== Testing Role Changes for Demo User ===');
  for (const targetRole of rolesToTest) {
    console.log(`\n--- Changing role to: ${targetRole} ---`);
    try {
      const res = await axios.put(
        `http://localhost:4000/api/users/${demoUserId}/role`,
        { role: targetRole, roles: [targetRole] },
        { headers: { Authorization: `Bearer ${ownerToken}` } }
      );
      console.log(`✅ Success: Updated to ${targetRole}:`, res.data);

      // Now issue token for demo user and check /auth/me
      const demoToken = jwt.sign(
        {
          id: demoUserId, user_id: demoUserId, company_id: companyId, workspace_id: companyId,
          email: 'staff@apollo.com', name: 'Apollo Staff', role: targetRole, roles: [targetRole]
        },
        process.env.JWT_SECRET, { expiresIn: '1d' }
      );

      const me = await axios.get('http://localhost:4000/auth/me', {
        headers: { Authorization: `Bearer ${demoToken}` }
      });
      console.log(`  /auth/me verified: role=${me.data.user.role}, roles=${JSON.stringify(me.data.user.roles)}, permCount=${me.data.permissions?.length}`);
    } catch (err) {
      console.log(`❌ Error changing to ${targetRole}:`, err.response?.status, err.response?.data || err.message);
    }
  }

  // Restore back to staff
  await axios.put(
    `http://localhost:4000/api/users/${demoUserId}/role`,
    { role: 'staff', roles: ['staff'] },
    { headers: { Authorization: `Bearer ${ownerToken}` } }
  );
  console.log('\nRestored demo user to staff.');
}

testAllRoles().catch(console.error);
