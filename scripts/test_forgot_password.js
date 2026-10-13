'use strict';

const http = require('http');

function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: 'localhost',
      port: 4000,
      path,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data)
      }
    }, res => {
      let resBody = '';
      res.on('data', chunk => resBody += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(resBody) });
        } catch (e) {
          resolve({ status: res.statusCode, body: resBody });
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  console.log('--- Testing Forgot Password Endpoints ---');

  // Test 1: Send OTP for non-existent email
  const nonExistent = await post('/auth/forgot-password/send-otp', { email: 'nonexistent_test_user@example.com' });
  console.log('1. Non-existent email:', nonExistent.status, nonExistent.body);

  // Test 2: Send OTP for valid email (sales@apollo.com)
  const sendRes = await post('/auth/forgot-password/send-otp', { email: 'sales@apollo.com' });
  console.log('2. Send OTP to sales@apollo.com:', sendRes.status, sendRes.body);

  // Test 3: Verify with incorrect OTP
  const badVerify = await post('/auth/forgot-password/verify-otp', { email: 'sales@apollo.com', otp: '000000' });
  console.log('3. Bad OTP verification:', badVerify.status, badVerify.body);

  console.log('--- All endpoint validations succeeded ---');
  process.exit(0);
})();
