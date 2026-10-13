const axios = require('axios');

const API = 'http://localhost:4000';

async function main() {
  console.log('--- 1. LOGGING IN AS ADMIN ---');
  const loginRes = await axios.post(`${API}/auth/login`, {
    email: 'hardick@solarman.in',
    password: 'Hardick@1234'
  });
  const token = loginRes.data.token;
  console.log('✓ Admin login successful');

  const headers = { Authorization: `Bearer ${token}` };

  console.log('\n--- 2. TESTING WORKSPACE USER INVITE ---');
  const testEmail = `staff_${Date.now()}@testinvite.com`;
  const userInviteRes = await axios.post(
    `${API}/api/users/invites`,
    {
      email: testEmail,
      role: 'staff'
    },
    { headers }
  );
  console.log('✓ User invite response:', {
    email: userInviteRes.data.email,
    invite_link: userInviteRes.data.invite_link,
    email_sent: userInviteRes.data.email_sent,
    message: userInviteRes.data.message
  });

  const userToken = userInviteRes.data.token;
  console.log('Verifying user invite token via GET /auth/verify-invite...');
  const userVerifyRes = await axios.get(`${API}/auth/verify-invite?token=${userToken}`);
  console.log('✓ User verify info:', userVerifyRes.data);

  console.log('Accepting user invite via POST /auth/accept-invite...');
  const userAcceptRes = await axios.post(`${API}/auth/accept-invite`, {
    token: userToken,
    name: 'Test Staff User',
    password: 'Password@1234'
  });
  console.log('✓ User accepted invite successfully:', {
    user: userAcceptRes.data.user?.email,
    workspace: userAcceptRes.data.workspace?.name,
    tokenIssued: !!userAcceptRes.data.token
  });

  console.log('\n--- 3. TESTING VENDOR PORTAL INVITE ---');
  const vendorsRes = await axios.get(`${API}/api/vendors?limit=1`, { headers });
  const vendor = vendorsRes.data.vendors?.[0] || vendorsRes.data[0];
  if (!vendor) {
    console.log('No vendors found in company, skipping vendor invite');
  } else {
    console.log(`Found vendor: ${vendor.name} (${vendor.id})`);
    const vendorEmail = `vendor_${Date.now()}@testinvite.com`;
    const vInviteRes = await axios.post(
      `${API}/api/vendors/${vendor.id}/portal-invite`,
      {
        name: 'Vendor Contact Test',
        email: vendorEmail,
        force_reinvite: true
      },
      { headers }
    );
    console.log('✓ Vendor invite response:', {
      email: vInviteRes.data.email,
      invite_link: vInviteRes.data.invite_link,
      email_sent: vInviteRes.data.email_sent,
      message: vInviteRes.data.message
    });

    const vToken = vInviteRes.data.invite_token;
    console.log('Verifying vendor invite token via GET /portal/verify-invite...');
    const vVerifyRes = await axios.get(`${API}/portal/verify-invite?token=${vToken}`);
    console.log('✓ Vendor verify info:', vVerifyRes.data);

    console.log('Accepting vendor invite via POST /portal/accept-invite...');
    const vAcceptRes = await axios.post(`${API}/portal/accept-invite`, {
      token: vToken,
      company_id: vVerifyRes.data.company_id,
      password: 'VendorPassword@1234'
    });
    console.log('✓ Vendor accepted invite successfully:', {
      portal_type: vAcceptRes.data.portal_type,
      active_company: vAcceptRes.data.active_company?.name,
      tokenIssued: !!vAcceptRes.data.token
    });
  }

  console.log('\n--- 4. TESTING CUSTOMER PORTAL INVITE ---');
  const customersRes = await axios.get(`${API}/api/customers?limit=1`, { headers });
  const customer = customersRes.data.customers?.[0] || customersRes.data[0];
  if (!customer) {
    console.log('No customers found in company, skipping customer invite');
  } else {
    console.log(`Found customer: ${customer.name} (${customer.id})`);
    const custEmail = `cust_${Date.now()}@testinvite.com`;
    const cInviteRes = await axios.post(
      `${API}/api/customers/${customer.id}/portal-invite`,
      {
        name: 'Customer Contact Test',
        email: custEmail,
        force_reinvite: true
      },
      { headers }
    );
    console.log('✓ Customer invite response:', {
      email: cInviteRes.data.email,
      invite_link: cInviteRes.data.invite_link,
      email_sent: cInviteRes.data.email_sent,
      message: cInviteRes.data.message
    });

    const cToken = cInviteRes.data.invite_token;
    console.log('Verifying customer invite token via GET /portal/verify-invite...');
    const cVerifyRes = await axios.get(`${API}/portal/verify-invite?token=${cToken}`);
    console.log('✓ Customer verify info:', cVerifyRes.data);

    console.log('Accepting customer invite via POST /portal/accept-invite...');
    const cAcceptRes = await axios.post(`${API}/portal/accept-invite`, {
      token: cToken,
      company_id: cVerifyRes.data.company_id,
      password: 'CustomerPassword@1234'
    });
    console.log('✓ Customer accepted invite successfully:', {
      portal_type: cAcceptRes.data.portal_type,
      active_company: cAcceptRes.data.active_company?.name,
      tokenIssued: !!cAcceptRes.data.token
    });
  }

  console.log('\n==================================================');
  console.log('ALL INVITATION FLOWS & VERIFICATIONS PASSED 100%!');
  console.log('==================================================\n');
}

main().catch((err) => {
  console.error('Test error:', err.response?.data || err.message);
  process.exit(1);
});
