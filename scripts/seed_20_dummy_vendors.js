const http = require('http');

const DUMMY_VENDORS = [
  { name: 'Tata Steel Processing Ltd', code: 'VEN-0011', contact: 'Amit Deshmukh', phone: '9820011231', email: 'sales@tatasteelproc.dummy', state: 'Maharashtra', city: 'Mumbai', pincode: '400001', street: 'Nariman Point, 14th Floor' },
  { name: 'Jindal Poly Films Co', code: 'VEN-0012', contact: 'Suresh Singhania', phone: '9820011232', email: 'orders@jindalpoly.dummy', state: 'Gujarat', city: 'Surat', pincode: '395003', street: 'GIDC Industrial Estate 4' },
  { name: 'Hindalco Extrusions Corp', code: 'VEN-0013', contact: 'Kavita Iyer', phone: '9820011233', email: 'kavita@hindalcoext.dummy', state: 'Karnataka', city: 'Bangalore', pincode: '560001', street: 'Peenya Industrial Area Phase 2' },
  { name: 'Mahindra Auto Components', code: 'VEN-0014', contact: 'Vikas Patil', phone: '9820011234', email: 'supply@mahindraauto.dummy', state: 'Maharashtra', city: 'Nashik', pincode: '422007', street: 'Ambad Industrial Area' },
  { name: 'L&T Heavy Engineering', code: 'VEN-0015', contact: 'Naveen Kumar', phone: '9820011235', email: 'naveen@ltheavy.dummy', state: 'Tamil Nadu', city: 'Chennai', pincode: '600001', street: 'Guindy Industrial Estate' },
  { name: 'Schneider Electric Components', code: 'VEN-0016', contact: 'Deepak Joshi', phone: '9820011236', email: 'deepak@schneidercomp.dummy', state: 'Haryana', city: 'Gurugram', pincode: '122001', street: 'Udyog Vihar Phase 4' },
  { name: 'BHEL Spares & Castings', code: 'VEN-0017', contact: 'Manoj Tiwari', phone: '9820011237', email: 'manoj@bhelspares.dummy', state: 'Madhya Pradesh', city: 'Bhopal', pincode: '462022', street: 'Govindpura Industrial Area' },
  { name: 'Siemens Precision Bearings', code: 'VEN-0018', contact: 'Anjali Nair', phone: '9820011238', email: 'anjali@siemensbearings.dummy', state: 'Kerala', city: 'Kochi', pincode: '682001', street: 'Kalamassery Industrial Belt' },
  { name: 'Godrej Tooling Guild', code: 'VEN-0019', contact: 'Rohan Mehta', phone: '9820011239', email: 'rohan@godrejtooling.dummy', state: 'Maharashtra', city: 'Thane', pincode: '400604', street: 'Wagle Industrial Estate' },
  { name: 'Bajaj Electrical Parts', code: 'VEN-0020', contact: 'Sunil Rane', phone: '9820011240', email: 'sunil@bajajparts.dummy', state: 'Maharashtra', city: 'Aurangabad', pincode: '431005', street: 'Waluj MIDC' },
  { name: 'Havells Wire Industries', code: 'VEN-0021', contact: 'Pooja Agarwal', phone: '9820011241', email: 'pooja@havellswire.dummy', state: 'Rajasthan', city: 'Jaipur', pincode: '302013', street: 'Vishwakarma Industrial Area' },
  { name: 'Polycab Cables & Fittings', code: 'VEN-0022', contact: 'Karthik Raja', phone: '9820011242', email: 'karthik@polycabfittings.dummy', state: 'Gujarat', city: 'Vadodara', pincode: '390010', street: 'Halol Industrial Road' },
  { name: 'Thermax Heat Systems', code: 'VEN-0023', contact: 'Preeti Deshpande', phone: '9820011243', email: 'preeti@thermaxsystems.dummy', state: 'Maharashtra', city: 'Pune', pincode: '411018', street: 'Chinchwad Station Road' },
  { name: 'Supreme Petrochem Supply', code: 'VEN-0024', contact: 'Alok Gupta', phone: '9820011244', email: 'alok@supremepetro.dummy', state: 'Maharashtra', city: 'Raigad', pincode: '402107', street: 'Nagothane Petrochem Complex' },
  { name: 'Finolex Polymer Guild', code: 'VEN-0025', contact: 'Gaurav Kulkarni', phone: '9820011245', email: 'gaurav@finolexpolymer.dummy', state: 'Goa', city: 'Panaji', pincode: '403001', street: 'Verna Industrial Estate' },
  { name: 'Bosch Motion Controls', code: 'VEN-0026', contact: 'Swati Shenoy', phone: '9820011246', email: 'swati@boschmotion.dummy', state: 'Karnataka', city: 'Bangalore', pincode: '560030', street: 'Adugodi Industrial Campus' },
  { name: 'SKF Bearings Distribution', code: 'VEN-0027', contact: 'Tarun Verma', phone: '9820011247', email: 'tarun@skfbearings.dummy', state: 'Delhi', city: 'New Delhi', pincode: '110020', street: 'Okhla Industrial Area Phase 1' },
  { name: 'Danfoss Thermal Controls', code: 'VEN-0028', contact: 'Balaji Natarajan', phone: '9820011248', email: 'balaji@danfossthermal.dummy', state: 'Tamil Nadu', city: 'Coimbatore', pincode: '641018', street: 'SIDCO Industrial Estate' },
  { name: 'Cummins Engine Logistics', code: 'VEN-0029', contact: 'Prakash Shinde', phone: '9820011249', email: 'prakash@cumminslog.dummy', state: 'Maharashtra', city: 'Pune', pincode: '411038', street: 'Kothrud Industrial Area' }
];

async function seed() {
  console.log('Logging in as inf@apollo.com...');
  const loginPayload = JSON.stringify({ email: 'inf@apollo.com', password: 'Hardick@1907' });
  const token = await new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost', port: 4000, path: '/auth/login', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(loginPayload) }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.token) resolve(parsed.token);
          else reject(new Error('Login failed: ' + data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.write(loginPayload);
    req.end();
  });

  console.log('Authenticated successfully. Creating 19 dummy vendors...');

  for (const v of DUMMY_VENDORS) {
    const payload = JSON.stringify({
      name: v.name,
      vendor_code: v.code,
      contact_person_name: v.contact,
      phone: v.phone,
      email: v.email,
      state: v.state,
      city: v.city,
      pincode: v.pincode,
      street: v.street,
      status: 'Active'
    });

    await new Promise((resolve) => {
      const req = http.request({
        hostname: 'localhost', port: 4000, path: '/api/vendors', method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token,
          'Content-Length': Buffer.byteLength(payload)
        }
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          if (res.statusCode === 201) {
            console.log(`[Created] ${v.name} (${v.code})`);
          } else {
            console.log(`[Error ${res.statusCode}] ${v.name}: ${data}`);
          }
          resolve();
        });
      });
      req.write(payload);
      req.end();
    });
  }

  // Fetch final total
  const count = await new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost', port: 4000, path: '/api/vendors?table=1&page_size=1', method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        const parsed = JSON.parse(data);
        resolve(parsed.total || 0);
      });
    });
    req.end();
  });

  console.log(`\nDone! Total vendors in database is now: ${count}`);
}

seed().catch(console.error);
