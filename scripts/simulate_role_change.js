const axios = require('axios');
const jwt = require('jsonwebtoken');
require('dotenv').config({ path: __dirname + '/../.env' });

async function testRoleChange() {
  const companyId = '03867519-ebfd-4d79-8e8e-7f9c5308f664';
  const ownerId = '308bfdbb-050d-4d38-9130-e2321a9caddd';
  const targetUserId = '59aefe70-69f3-4549-b282-c73ca0303083'; // hardick@apollo.com

  // Generate owner JWT
  const ownerToken = jwt.sign(
    {
      id: ownerId,
      user_id: ownerId,
      company_id: companyId,
      workspace_id: companyId,
      email: 'inf@apollo.com',
      name: 'Hardick',
      role: 'owner',
      roles: ['owner']
    },
    process.env.JWT_SECRET,
    { expiresIn: '1d' }
  );

  console.log('Testing PUT /api/users/' + targetUserId + '/role with various payloads...');

  // Try changing to manager
  try {
    const res1 = await axios.put(
      `http://localhost:4000/api/users/${targetUserId}/role`,
      {
        role: 'manager',
        roles: ['manager']
      },
      {
        headers: { Authorization: `Bearer ${ownerToken}` }
      }
    );
    console.log('Result 1 (change to manager):', res1.status, res1.data);
  } catch (err) {
    console.log('Error 1:', err.response?.status, err.response?.data || err.message);
  }

  // Try changing to staff
  try {
    const res2 = await axios.put(
      `http://localhost:4000/api/users/${targetUserId}/role`,
      {
        role: 'staff',
        roles: ['staff']
      },
      {
        headers: { Authorization: `Bearer ${ownerToken}` }
      }
    );
    console.log('Result 2 (change to staff):', res2.status, res2.data);
  } catch (err) {
    console.log('Error 2:', err.response?.status, err.response?.data || err.message);
  }

  // Try changing role of owner themselves!
  try {
    const res3 = await axios.put(
      `http://localhost:4000/api/users/${ownerId}/role`,
      {
        role: 'manager',
        roles: ['manager']
      },
      {
        headers: { Authorization: `Bearer ${ownerToken}` }
      }
    );
    console.log('Result 3 (change owner role):', res3.status, res3.data);
  } catch (err) {
    console.log('Error 3 (change owner role):', err.response?.status, err.response?.data || err.message);
  }
}

testRoleChange().catch(console.error);
