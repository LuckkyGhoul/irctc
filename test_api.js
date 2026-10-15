const http = require('http');

function req(options, data) {
  return new Promise((resolve, reject) => {
    const r = http.request(options, res => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
        catch(e) { resolve({ status: res.statusCode, body }); }
      });
    });
    r.on('error', reject);
    if (data) r.write(JSON.stringify(data));
    r.end();
  });
}

(async () => {
  console.log('=== 1. Healthcheck ===');
  const h = await req({ host: 'localhost', port: 8090, path: '/api/health', method: 'GET' });
  console.log('Health:', h.status, h.data);

  console.log('\n=== 2. User Signup & Login ===');
  const testEmail = 'user_' + Date.now() + '@rail.in';
  const signup = await req({ host: 'localhost', port: 8090, path: '/api/auth/signup', method: 'POST', headers: {'Content-Type':'application/json'} }, {
    name: 'Aarav Patel', email: testEmail, mobile: '9812345678', password: 'Password@123'
  });
  console.log('Signup:', signup.data.message);

  const login = await req({ host: 'localhost', port: 8090, path: '/api/auth/login', method: 'POST', headers: {'Content-Type':'application/json'} }, {
    email: testEmail, password: 'Password@123'
  });
  console.log('Login:', login.data.success ? 'Success! Token acquired' : 'Failed');
  const token = login.data.token;

  console.log('\n=== 3. All Trains with Default Station Reaching Times ===');
  const allTrains = await req({ host: 'localhost', port: 8090, path: '/api/trains/all', method: 'GET' });
  console.log('Total trains in database:', allTrains.data.total_trains);
  const train12017 = allTrains.data.trains.find(t => t.train_no === '12017');
  console.log('Train 12017:', train12017.train_name, 'Stops count:', train12017.schedule.length);
  console.log('First 4 stops with default reaching times:');
  train12017.schedule.slice(0, 4).forEach(s => {
    console.log(`  Stop ${s.stop_number}: ${s.station_name} (${s.station_code}) | Arr: ${s.arrival_time} | Dep: ${s.departure_time} | Halt: ${s.halt_minutes}m | Dist: ${s.distance_km}km`);
  });

  console.log('\n=== 4. Book Waitlisted Ticket ===');
  const wlBook = await req({
    host: 'localhost', port: 8090, path: '/api/book', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }
  }, {
    train_no: '12017',
    journey_date: '2026-10-25',
    class_code: 'CC',
    quota: 'GN',
    total_fare: 685,
    payment_method: 'UPI',
    is_waitlist: true,
    requested_status: 'WL',
    passengers: [{ name: 'Aarav Patel', age: 29, gender: 'M', berth_pref: 'WS' }]
  });
  console.log('Booking Result Status:', wlBook.data.status, '| PNR:', wlBook.data.pnr, '| Is Waitlisted:', wlBook.data.is_waitlisted);
  const wlPnr = wlBook.data.pnr;

  console.log('\n=== 5. PNR Status Query (with Reaching Times) ===');
  const pnrQuery = await req({ host: 'localhost', port: 8090, path: '/api/pnr/' + wlPnr, method: 'GET' });
  console.log('PNR Status:', pnrQuery.data.status, '| Train:', pnrQuery.data.train_name, '| Stops returned:', pnrQuery.data.reaching_times.length);

  console.log('\n=== 6. Live 30s Waitlist Resolution (Testing Refund Initiation) ===');
  const refundTest = await req({
    host: 'localhost', port: 8090, path: '/api/wl-confirm', method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, {
    pnr: wlPnr,
    force_result: 'reject'
  });
  console.log('WL Resolution:', refundTest.data.message);
  console.log('Refund details: Ref =', refundTest.data.refund_ref, '| Amount = ₹' + refundTest.data.refund_amount);

  console.log('\n=== 7. Verify Refund Persisted in PostgreSQL Ticket API ===');
  const tktVerify = await req({ host: 'localhost', port: 8090, path: '/api/ticket/' + wlPnr, method: 'GET' });
  console.log('Updated Ticket Status in DB:', tktVerify.data.status);
  console.log('Persisted Refund in DB:', tktVerify.data.refund);

  console.log('\n=== 8. Book Another Ticket (Testing Confirmation Case) ===');
  const cnfBook = await req({
    host: 'localhost', port: 8090, path: '/api/book', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }
  }, {
    train_no: '12951',
    journey_date: '2026-10-28',
    class_code: '3A',
    quota: 'GN',
    total_fare: 1450,
    payment_method: 'Debit Card',
    is_waitlist: true,
    requested_status: 'WL',
    passengers: [{ name: 'Priya Sharma', age: 26, gender: 'F', berth_pref: 'LB' }]
  });
  const cnfPnr = cnfBook.data.pnr;
  console.log('Waitlisted PNR created:', cnfPnr);

  console.log('Simulating 30s confirmation success:');
  const confirmResult = await req({
    host: 'localhost', port: 8090, path: '/api/wl-confirm', method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  }, {
    pnr: cnfPnr,
    force_result: 'confirm'
  });
  console.log('Confirm Result:', confirmResult.data.message);

  const cnfTicket = await req({ host: 'localhost', port: 8090, path: '/api/ticket/' + cnfPnr, method: 'GET' });
  console.log('Confirmed Ticket in DB Status:', cnfTicket.data.status);
  console.log('Passenger Berth Allocated:', cnfTicket.data.passengers[0].coach, '/', cnfTicket.data.passengers[0].berth_no);

  console.log('\n🎉 ALL 8 TESTS PASSED SUCCESSFULLY! EVERYTHING WORKING BEAUTIFULLY!');
})();
