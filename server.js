const path = require('path');
const fs = require('fs');

// Resolve dependencies from extra_files/node_modules if moved
const extraModules = path.join(__dirname, '..', 'extra_files', 'node_modules');
if (fs.existsSync(extraModules) && !module.paths.includes(extraModules)) {
  module.paths.unshift(extraModules);
}

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { query, initDb, getDefaultTierSeats } = require('./db');

const app = express();
const PORT = process.env.PORT || 8090;
const JWT_SECRET = process.env.JWT_SECRET || 'irctc_super_secure_jwt_secret_key_2026';

// Middleware
app.use(cors());
app.use(express.json());

// Serve static frontend files from /public
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// Helper: JWT verification middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'Authentication required' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ success: false, message: 'Invalid or expired token' });
    req.user = user;
    next();
  });
}

// ----------------------------------------------------
// Helper: Get or Create Live Seat Inventory for (train, date, class, quota)
// ----------------------------------------------------
async function getOrCreateInventory(trainNo, journeyDate, classCode, quota = 'GN') {
  const dateStr = typeof journeyDate === 'string' ? journeyDate.slice(0, 10) : journeyDate.toISOString().slice(0, 10);
  
  const res = await query(`
    SELECT * FROM seat_inventory
    WHERE train_no = $1 AND journey_date = $2 AND class_code = $3 AND quota = $4
  `, [trainNo, dateStr, classCode, quota]);

  if (res.rows.length > 0) {
    return res.rows[0];
  }

  // Seed default seats (< 12 seats, green tiers available, yellow tiers in WL)
  const def = typeof getDefaultTierSeats === 'function' ? getDefaultTierSeats(classCode) : { available: 4, wl: 0 };
  const insertRes = await query(`
    INSERT INTO seat_inventory (train_no, journey_date, class_code, quota, total_seats, available_seats, booked_seats, wl_count)
    VALUES ($1, $2, $3, $4, 50, $5, 0, $6)
    ON CONFLICT (train_no, journey_date, class_code, quota) DO NOTHING
    RETURNING *
  `, [trainNo, dateStr, classCode, quota, def.available, def.wl]);

  if (insertRes.rows.length > 0) {
    return insertRes.rows[0];
  }

  // In case of conflict, re-fetch
  const refetch = await query(`
    SELECT * FROM seat_inventory
    WHERE train_no = $1 AND journey_date = $2 AND class_code = $3 AND quota = $4
  `, [trainNo, dateStr, classCode, quota]);
  return refetch.rows[0];
}

// ----------------------------------------------------
// 1. Healthcheck & Database Status
// ----------------------------------------------------
app.get('/api/health', async (req, res) => {
  try {
    const dbRes = await query('SELECT version()');
    res.json({
      status: 'UP',
      timestamp: new Date().toISOString(),
      database: 'PostgreSQL',
      version: dbRes.rows[0]?.version || 'PostgreSQL'
    });
  } catch (err) {
    res.status(500).json({ status: 'DOWN', error: err.message });
  }
});

// ----------------------------------------------------
// 2. Authentication: Signup & Login
// ----------------------------------------------------
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, mobile, password } = req.body;
    if (!name || !email || !mobile || !password) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }

    const trimmedEmail = email.trim().toLowerCase();
    const existing = await query('SELECT id FROM users WHERE email = $1', [trimmedEmail]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ success: false, message: 'Email is already registered. Please login.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const insertRes = await query(`
      INSERT INTO users (name, email, mobile, password_hash)
      VALUES ($1, $2, $3, $4)
      RETURNING id, name, email, mobile
    `, [name.trim(), trimmedEmail, mobile.trim(), passwordHash]);

    const newUser = insertRes.rows[0];
    res.json({
      success: true,
      message: 'Account created successfully! You can now login.',
      user: newUser
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ success: false, message: 'Server error during signup: ' + err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }

    const trimmedEmail = email.trim().toLowerCase();
    const result = await query('SELECT * FROM users WHERE email = $1', [trimmedEmail]);
    if (result.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid email or password' });
    }

    const user = result.rows[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { id: user.id, name: user.name, email: user.email, mobile: user.mobile },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        mobile: user.mobile
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Server error during login: ' + err.message });
  }
});

app.get('/api/auth/me', authenticateToken, (req, res) => {
  res.json({ success: true, user: req.user });
});

// ----------------------------------------------------
// 3. Stations API
// ----------------------------------------------------
app.get('/api/stations', async (req, res) => {
  try {
    const result = await query('SELECT code, name, city, state FROM stations ORDER BY code ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// 4. Train Search API with Dynamic Seat Inventory
//    (Seat numbers decrease in real-time after bookings)
// ----------------------------------------------------
app.get('/api/trains', async (req, res) => {
  try {
    const { from, to, date, quota = 'GN' } = req.query;
    const journeyDate = date || new Date().toISOString().slice(0, 10);

    let sql = 'SELECT * FROM trains';
    let params = [];

    if (from && to) {
      // Find trains matching either direct source/dest or intermediate route halts
      sql = `
        SELECT DISTINCT t.* FROM trains t
        LEFT JOIN train_schedules s1 ON t.train_no = s1.train_no AND s1.station_code = $1
        LEFT JOIN train_schedules s2 ON t.train_no = s2.train_no AND s2.station_code = $2
        WHERE (t.source_code = $1 AND t.dest_code = $2)
           OR (s1.id IS NOT NULL AND s2.id IS NOT NULL AND s1.stop_number < s2.stop_number)
      `;
      params = [from, to];
    }

    let result = await query(sql, params);

    // Fallback: if no direct match, return all trains
    if (result.rows.length === 0) {
      result = await query('SELECT * FROM trains ORDER BY train_no ASC');
    }

    // Format trains with live dynamic seat inventory from PostgreSQL
    const trains = [];
    for (const t of result.rows) {
      const classList = typeof t.classes === 'string' ? t.classes.split(',') : t.classes;

      const availabilities = {};
      const seatCounts = {};
      const wlCounts = {};

      for (const cls of classList) {
        const inv = await getOrCreateInventory(t.train_no, journeyDate, cls, quota);
        if (inv.available_seats > 0) {
          availabilities[cls] = `AVAILABLE - ${inv.available_seats}`;
        } else {
          availabilities[cls] = `WL # ${inv.wl_count > 0 ? inv.wl_count : 1}`;
        }
        seatCounts[cls] = inv.available_seats;
        wlCounts[cls] = inv.wl_count > 0 ? inv.wl_count : 1;
      }

      trains.push({
        id: t.id,
        num: t.train_no,
        train_no: t.train_no,
        name: t.train_name,
        train_name: t.train_name,
        from: t.source_code,
        to: t.dest_code,
        from_station: t.source_code,
        to_station: t.dest_code,
        dep: t.departure_time,
        arr: t.arrival_time,
        departure: t.departure_time,
        arrival: t.arrival_time,
        dur: t.duration,
        duration: t.duration,
        runs: t.runs_on,
        sf: t.is_superfast,
        pantry: t.has_pantry,
        classes: classList,
        availability: availabilities,
        live_seat_counts: seatCounts,
        wl_counts: wlCounts
      });
    }

    res.json(trains);
  } catch (err) {
    console.error('Train search error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// 5. ALL TRAINS LIST WITH DEFAULT STATION REACHING TIMES
//    (Includes Dehradun, Haridwar, Lucknow, Rishikesh, Roorkee)
// ----------------------------------------------------
app.get('/api/trains/all', async (req, res) => {
  try {
    const trainsRes = await query(`
      SELECT t.*, s1.name as source_name, s2.name as dest_name
      FROM trains t
      LEFT JOIN stations s1 ON t.source_code = s1.code
      LEFT JOIN stations s2 ON t.dest_code = s2.code
      ORDER BY t.train_no ASC
    `);

    const schedulesRes = await query(`
      SELECT ts.*, s.city, s.state
      FROM train_schedules ts
      LEFT JOIN stations s ON ts.station_code = s.code
      ORDER BY ts.train_no ASC, ts.stop_number ASC
    `);

    const schedulesByTrain = {};
    for (const sc of schedulesRes.rows) {
      if (!schedulesByTrain[sc.train_no]) schedulesByTrain[sc.train_no] = [];
      schedulesByTrain[sc.train_no].push({
        stop_number: sc.stop_number,
        station_code: sc.station_code,
        station_name: sc.station_name,
        city: sc.city,
        state: sc.state,
        arrival_time: sc.arrival_time,
        departure_time: sc.departure_time,
        halt_minutes: sc.halt_minutes,
        distance_km: sc.distance_km,
        day_count: sc.day_count,
        travel_time_from_start: sc.travel_time_from_start || (sc.distance_km > 0 ? `${Math.round(sc.distance_km / 60)}h` : '0m')
      });
    }

    const trainsWithSchedules = trainsRes.rows.map(t => ({
      id: t.id,
      train_no: t.train_no,
      train_name: t.train_name,
      source_code: t.source_code,
      source_name: t.source_name || t.source_code,
      dest_code: t.dest_code,
      dest_name: t.dest_name || t.dest_code,
      departure_time: t.departure_time,
      arrival_time: t.arrival_time,
      duration: t.duration,
      runs_on: t.runs_on,
      is_superfast: t.is_superfast,
      has_pantry: t.has_pantry,
      classes: typeof t.classes === 'string' ? t.classes.split(',') : t.classes,
      total_stops: schedulesByTrain[t.train_no]?.length || 2,
      schedule: schedulesByTrain[t.train_no] || [
        { stop_number: 1, station_code: t.source_code, station_name: t.source_name || t.source_code, arrival_time: 'START', departure_time: t.departure_time, halt_minutes: 0, distance_km: 0, day_count: 1, travel_time_from_start: '0m' },
        { stop_number: 2, station_code: t.dest_code, station_name: t.dest_name || t.dest_code, arrival_time: t.arrival_time, departure_time: 'ENDS', halt_minutes: 0, distance_km: 800, day_count: 1, travel_time_from_start: t.duration }
      ]
    }));

    res.json({
      success: true,
      total_trains: trainsWithSchedules.length,
      trains: trainsWithSchedules
    });
  } catch (err) {
    console.error('All trains fetch error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Single train schedule
app.get('/api/trains/:trainNo/schedule', async (req, res) => {
  try {
    const { trainNo } = req.params;
    const trainRes = await query('SELECT * FROM trains WHERE train_no = $1', [trainNo]);
    if (trainRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Train not found' });
    }

    const scheduleRes = await query(`
      SELECT ts.*, s.city, s.state
      FROM train_schedules ts
      LEFT JOIN stations s ON ts.station_code = s.code
      WHERE ts.train_no = $1
      ORDER BY ts.stop_number ASC
    `, [trainNo]);

    res.json({
      success: true,
      train: trainRes.rows[0],
      stops: scheduleRes.rows
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------
// 6. BOOK TICKET API
//    Supports 10-15 Passengers, Race Condition Detection & Dynamic Inventory Decrement
// ----------------------------------------------------
app.post('/api/book', async (req, res) => {
  try {
    const {
      train_id, train_no, journey_date, class_code, quota = 'GN',
      passengers, contact_mobile, contact_email, total_fare,
      payment_method, is_waitlist, requested_status
    } = req.body;

    if (!train_no || !journey_date || !class_code || !passengers || passengers.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid booking data' });
    }

    // Lookup train
    const trainRes = await query('SELECT * FROM trains WHERE train_no = $1', [train_no]);
    const train = trainRes.rows[0] || {
      train_no,
      train_name: req.body.train_name || 'Express Special',
      source_code: req.body.from_station || 'NDLS',
      dest_code: req.body.to_station || 'DDN',
      departure_time: req.body.departure || '06:45',
      arrival_time: req.body.arrival || '12:55',
      duration: req.body.duration || '6h 10m'
    };

    const numPax = passengers.length;
    const inv = await getOrCreateInventory(train_no, journey_date, class_code, quota);

    // Concurrency / Race Condition check:
    // Only occurs when:
    // 1. Tier is in waiting list (inv.available_seats <= 0, or is_waitlist === true, or requested_status === 'WL')
    // 2. OR number of passengers requested is MORE than available seats (numPax > inv.available_seats)
    // If it is green (inv.available_seats > 0) AND numPax <= inv.available_seats:
    // Then it is NOT in waiting list -> NO race condition! Immediate CNF booking!
    let isRaceCondition = false;
    let initialStatus = 'CNF';

    if (inv.available_seats <= 0 || is_waitlist === true || requested_status === 'WL' || numPax > inv.available_seats) {
      isRaceCondition = true;
      initialStatus = 'WL';
    }

    // Generate unique 10-digit PNR
    let pnr = '';
    let isUnique = false;
    while (!isUnique) {
      pnr = Math.floor(1000000000 + Math.random() * 9000000000).toString();
      const check = await query('SELECT id FROM bookings WHERE pnr = $1', [pnr]);
      if (check.rows.length === 0) isUnique = true;
    }

    // Get logged in user if auth token present
    let userId = null;
    let userName = 'Guest Passenger';
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.split(' ')[1]) {
      try {
        const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
        userId = decoded.id;
        userName = decoded.name;
      } catch (e) {}
    }

    const s1 = await query('SELECT name FROM stations WHERE code = $1', [train.source_code]);
    const s2 = await query('SELECT name FROM stations WHERE code = $1', [train.dest_code]);
    const fromName = s1.rows[0]?.name || train.source_code;
    const toName = s2.rows[0]?.name || train.dest_code;

    // Fare breakdown
    const baseFare = Math.round(Number(total_fare) * 0.75);
    const fareBreakdown = JSON.stringify({
      base_fare: baseFare,
      tatkal: (quota === 'TQ' || quota === 'PT') ? 200 : 0,
      reservation: 40 * numPax,
      gst: Math.round(Number(total_fare) * 0.05),
      service_fee: 15 * numPax,
      total: Number(total_fare)
    });

    // Insert booking
    const bookingRes = await query(`
      INSERT INTO bookings (
        pnr, user_id, user_name, train_no, train_name,
        from_station, to_station, from_name, to_name,
        departure, arrival, duration, journey_date,
        class_code, quota, contact_mobile, contact_email,
        payment_method, total_fare, fare_breakdown, status
      ) VALUES (
        $1, $2, $3, $4, $5,
        $6, $7, $8, $9,
        $10, $11, $12, $13,
        $14, $15, $16, $17,
        $18, $19, $20, $21
      ) RETURNING *
    `, [
      pnr, userId, userName, train.train_no, train.train_name,
      train.source_code, train.dest_code, fromName, toName,
      train.departure_time, train.arrival_time, train.duration, journey_date,
      class_code, quota || 'GN', contact_mobile || '9876543210', contact_email || '',
      payment_method || 'UPI', Number(total_fare), fareBreakdown, initialStatus
    ]);

    const booking = bookingRes.rows[0];

    // Insert passengers
    const coaches = ['S1', 'S2', 'S3', 'B1', 'B2', 'B3', 'A1', 'C1', 'C2', 'E1'];
    const insertedPassengers = [];

    if (!isRaceCondition) {
      // Immediate full allocation: Decrement available seats in inventory
      await query(`
        UPDATE seat_inventory
        SET available_seats = GREATEST(0, available_seats - $1),
            booked_seats = booked_seats + $1
        WHERE id = $2
      `, [numPax, inv.id]);

      for (let i = 0; i < passengers.length; i++) {
        const p = passengers[i];
        const pCoach = coaches[Math.floor(Math.random() * coaches.length)];
        const pBerth = Math.floor(Math.random() * 72) + 1;

        const pRes = await query(`
          INSERT INTO passengers (
            booking_id, pnr, pax_name, age, gender, berth_pref, coach, berth_no, status
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'CNF')
          RETURNING *
        `, [
          booking.id, pnr, p.name || p.pax_name || `Passenger ${i + 1}`,
          parseInt(p.age) || 28, p.gender || 'M', p.berth_pref || p.berth || 'NP',
          pCoach, String(pBerth)
        ]);
        insertedPassengers.push(pRes.rows[0]);
      }
    } else {
      // Race condition queue: All passengers enter waiting list state contending for seats
      for (let i = 0; i < passengers.length; i++) {
        const p = passengers[i];
        const pRes = await query(`
          INSERT INTO passengers (
            booking_id, pnr, pax_name, age, gender, berth_pref, coach, berth_no, status
          ) VALUES ($1, $2, $3, $4, $5, $6, 'WL', $7, 'WL')
          RETURNING *
        `, [
          booking.id, pnr, p.name || p.pax_name || `Passenger ${i + 1}`,
          parseInt(p.age) || 28, p.gender || 'M', p.berth_pref || p.berth || 'NP',
          `WL #${i + 1}`
        ]);
        insertedPassengers.push(pRes.rows[0]);
      }
    }

    res.json({
      success: true,
      pnr,
      status: initialStatus,
      is_waitlisted: initialStatus === 'WL',
      is_race_condition: isRaceCondition,
      available_seats_before: inv.available_seats,
      requested_passengers: numPax,
      message: isRaceCondition
        ? `⚡ Racing condition detected: ${numPax} passengers requested with ${inv.available_seats} seats available. 30-second live contention verification running!`
        : `Booking Confirmed! All ${numPax} seats allocated. Status: CNF`,
      total_fare: booking.total_fare,
      train_no: booking.train_no,
      train_name: booking.train_name,
      from_station: booking.from_station,
      to_station: booking.to_station,
      from_name: booking.from_name,
      to_name: booking.to_name,
      departure: booking.departure,
      arrival: booking.arrival,
      duration: booking.duration,
      journey_date: booking.journey_date,
      class_code: booking.class_code,
      quota: booking.quota,
      payment_method: booking.payment_method,
      passengers: insertedPassengers
    });
  } catch (err) {
    console.error('Booking error:', err);
    res.status(500).json({ success: false, message: 'Booking failed: ' + err.message });
  }
});

// ----------------------------------------------------
// 7. GET TICKET API
// ----------------------------------------------------
app.get('/api/ticket/:pnr', async (req, res) => {
  try {
    const { pnr } = req.params;
    const bRes = await query('SELECT * FROM bookings WHERE pnr = $1', [pnr]);
    if (bRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Ticket not found for PNR: ' + pnr });
    }

    const booking = bRes.rows[0];
    const pRes = await query('SELECT * FROM passengers WHERE pnr = $1 ORDER BY id ASC', [pnr]);
    const rRes = await query('SELECT * FROM refunds WHERE pnr = $1 ORDER BY id DESC LIMIT 1', [pnr]);

    let fareBreakdown = {};
    try {
      fareBreakdown = typeof booking.fare_breakdown === 'string'
        ? JSON.parse(booking.fare_breakdown)
        : booking.fare_breakdown || {};
    } catch (e) {}

    res.json({
      success: true,
      pnr: booking.pnr,
      status: booking.status,
      total_fare: Number(booking.total_fare),
      train_no: booking.train_no,
      train_name: booking.train_name,
      from_station: booking.from_station,
      to_station: booking.to_station,
      from_name: booking.from_name,
      to_name: booking.to_name,
      departure: booking.departure,
      arrival: booking.arrival,
      duration: booking.duration,
      journey_date: booking.journey_date,
      class_code: booking.class_code,
      quota: booking.quota,
      contact_mobile: booking.contact_mobile,
      payment_method: booking.payment_method,
      booked_at: booking.booked_at,
      passengers: pRes.rows,
      fare_breakdown: fareBreakdown,
      refund: rRes.rows[0] || null
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ----------------------------------------------------
// 8. PNR STATUS LOOKUP API
//    Shows Train Normal Path, Travel Times & Passenger Status
// ----------------------------------------------------
app.get('/api/pnr/:pnr', async (req, res) => {
  try {
    const { pnr } = req.params;
    const bRes = await query('SELECT * FROM bookings WHERE pnr = $1', [pnr]);
    if (bRes.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No record found for PNR: ' + pnr + '. Please verify the 10-digit number.'
      });
    }

    const booking = bRes.rows[0];
    const pRes = await query('SELECT * FROM passengers WHERE pnr = $1 ORDER BY id ASC', [pnr]);
    
    // Train normal path with reaching times and travel time from origin
    const scheduleRes = await query(`
      SELECT ts.*, s.city, s.state
      FROM train_schedules ts
      LEFT JOIN stations s ON ts.station_code = s.code
      WHERE ts.train_no = $1
      ORDER BY ts.stop_number ASC
    `, [booking.train_no]);

    const rRes = await query('SELECT * FROM refunds WHERE pnr = $1 ORDER BY id DESC LIMIT 1', [pnr]);

    res.json({
      success: true,
      pnr: booking.pnr,
      status: booking.status,
      train_no: booking.train_no,
      train_name: booking.train_name,
      from_station: booking.from_station,
      to_station: booking.to_station,
      from_name: booking.from_name,
      to_name: booking.to_name,
      departure: booking.departure,
      arrival: booking.arrival,
      duration: booking.duration,
      journey_date: booking.journey_date,
      class_code: booking.class_code,
      quota: booking.quota,
      total_fare: Number(booking.total_fare),
      passengers: pRes.rows,
      chart_status: booking.status === 'CNF' ? 'CHART PREPARED' : (booking.status === 'PARTIAL_CNF' ? 'PARTIAL ALLOCATION' : 'WAITLISTED'),
      reaching_times: scheduleRes.rows,
      refund: rRes.rows[0] || null
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PNR Search / Typeahead endpoint
app.get('/api/pnr-search', async (req, res) => {
  try {
    const q = req.query.q || '';
    if (!q || q.length < 3) return res.json({ success: true, results: [] });

    const results = await query(`
      SELECT pnr, train_no, train_name, from_name, to_name, journey_date, status
      FROM bookings
      WHERE pnr LIKE $1
      ORDER BY id DESC LIMIT 5
    `, [`%${q}%`]);

    res.json({ success: true, results: results.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------
// 9. LIVE 30-SECOND WAITLIST & RACING CONDITION RESOLUTION
//    Resolves contention: Allocates available seats, initiates partial/full refund
//    and accurately decrements seat inventory
// ----------------------------------------------------
app.post('/api/wl-confirm', async (req, res) => {
  try {
    const { pnr, force_result } = req.body;
    if (!pnr) {
      return res.status(400).json({ success: false, message: 'PNR is required' });
    }

    const bRes = await query('SELECT * FROM bookings WHERE pnr = $1', [pnr]);
    if (bRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }

    const booking = bRes.rows[0];
    const pRes = await query('SELECT * FROM passengers WHERE pnr = $1 ORDER BY id ASC', [pnr]);
    const passengers = pRes.rows;
    const totalPax = passengers.length;

    // Check inventory
    const inv = await getOrCreateInventory(booking.train_no, booking.journey_date, booking.class_code, booking.quota);

    let seatsToConfirm = 0;
    if (force_result === 'confirm') {
      seatsToConfirm = totalPax;
    } else if (force_result === 'reject') {
      seatsToConfirm = 0;
    } else {
      // Natural racing condition allocation based on real available seats in database
      seatsToConfirm = Math.min(totalPax, Math.max(0, inv.available_seats));
      // If inventory had 0, but forced demo or random allocation
      if (seatsToConfirm === 0 && inv.available_seats <= 0) {
        seatsToConfirm = 0;
      } else if (inv.available_seats > 0 && totalPax > inv.available_seats) {
        // Partial allocation
        seatsToConfirm = inv.available_seats;
      }
    }

    const unallocatedCount = totalPax - seatsToConfirm;
    const coaches = ['B1', 'B2', 'B3', 'S2', 'S4', 'A1'];

    // 1. Update confirmed passengers
    for (let i = 0; i < seatsToConfirm; i++) {
      const p = passengers[i];
      const coach = coaches[Math.floor(Math.random() * coaches.length)];
      const berth = Math.floor(Math.random() * 64) + 1;
      await query(`
        UPDATE passengers
        SET status = 'CNF', coach = $1, berth_no = $2
        WHERE id = $3
      `, [coach, String(berth), p.id]);
    }

    // 2. Update unallocated passengers
    for (let i = seatsToConfirm; i < totalPax; i++) {
      const p = passengers[i];
      await query(`
        UPDATE passengers
        SET status = 'REFUND_INITIATED', coach = '—', berth_no = '—'
        WHERE id = $1
      `, [p.id]);
    }

    // 3. Update Seat Inventory (decrements available seats by confirmed count, increments wl_count)
    await query(`
      UPDATE seat_inventory
      SET available_seats = GREATEST(0, available_seats - $1),
          booked_seats = booked_seats + $1,
          wl_count = wl_count + $2
      WHERE id = $3
    `, [seatsToConfirm, unallocatedCount, inv.id]);

    // 4. Handle Refund and Booking Status
    let finalBookingStatus = 'CNF';
    let refundRef = null;
    let refundAmount = 0;

    if (unallocatedCount > 0) {
      // Calculate proportional partial or full refund
      const farePerPax = Number(booking.total_fare) / totalPax;
      refundAmount = Math.round(farePerPax * unallocatedCount);
      refundRef = 'REF' + Math.floor(1000000000 + Math.random() * 9000000000).toString();

      finalBookingStatus = seatsToConfirm > 0 ? 'PARTIAL_CNF' : 'CANCELLED';

      await query(`
        INSERT INTO refunds (pnr, refund_ref, amount, reason, status, payment_method, pax_count)
        VALUES ($1, $2, $3, $4, 'INITIATED', $5, $6)
      `, [
        pnr,
        refundRef,
        refundAmount,
        `Racing condition resolution: ${unallocatedCount} of ${totalPax} passengers unallocated due to seat contention`,
        booking.payment_method || 'Original Payment Source',
        unallocatedCount
      ]);
    }

    await query(`UPDATE bookings SET status = $1 WHERE pnr = $2`, [finalBookingStatus, pnr]);

    // Fetch refreshed passengers
    const updatedPassengers = await query('SELECT * FROM passengers WHERE pnr = $1 ORDER BY id ASC', [pnr]);

    res.json({
      success: true,
      pnr,
      status: finalBookingStatus,
      confirmed: seatsToConfirm > 0,
      total_passengers: totalPax,
      confirmed_count: seatsToConfirm,
      refunded_count: unallocatedCount,
      refund_amount: refundAmount,
      refund_ref: refundRef,
      passengers: updatedPassengers.rows,
      message: unallocatedCount > 0
        ? (seatsToConfirm > 0
            ? `⚡ Racing condition resolved! ${seatsToConfirm} passengers CONFIRMED. ${unallocatedCount} passengers unallocated — 100% refund of ₹${refundAmount} initiated (Ref: ${refundRef}).`
            : `❌ All seats contended. Berth unavailable. 100% refund of ₹${refundAmount} initiated (Ref: ${refundRef}) to original payment method.`)
        : `🎉 All ${seatsToConfirm} passengers have been successfully CONFIRMED! Berths allocated.`
    });
  } catch (err) {
    console.error('Waitlist confirmation error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ----------------------------------------------------
// 10. CANCEL TICKET API (Restores seat inventory)
// ----------------------------------------------------
app.post('/api/ticket/cancel', async (req, res) => {
  try {
    const { pnr, reason } = req.body;
    const bRes = await query('SELECT * FROM bookings WHERE pnr = $1', [pnr]);
    if (bRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }

    const booking = bRes.rows[0];
    if (booking.status === 'CANCELLED') {
      return res.status(400).json({ success: false, message: 'Ticket is already cancelled.' });
    }

    const pRes = await query('SELECT * FROM passengers WHERE pnr = $1', [pnr]);
    const numPax = pRes.rows.length;

    await query(`UPDATE bookings SET status = 'CANCELLED' WHERE pnr = $1`, [pnr]);
    await query(`UPDATE passengers SET status = 'CANCELLED' WHERE pnr = $1`, [pnr]);

    // Restore seats to inventory if ticket had confirmed seats
    if (booking.status === 'CNF' || booking.status === 'PARTIAL_CNF') {
      const inv = await getOrCreateInventory(booking.train_no, booking.journey_date, booking.class_code, booking.quota);
      await query(`
        UPDATE seat_inventory
        SET available_seats = available_seats + $1,
            booked_seats = GREATEST(0, booked_seats - $1)
        WHERE id = $2
      `, [numPax, inv.id]);
    }

    const refundRef = 'REF' + Math.floor(1000000000 + Math.random() * 9000000000);
    const refundAmount = Number(booking.total_fare) > 60 ? Number(booking.total_fare) - 60 : Number(booking.total_fare);

    await query(`
      INSERT INTO refunds (pnr, refund_ref, amount, reason, status, payment_method, pax_count)
      VALUES ($1, $2, $3, $4, 'INITIATED', $5, $6)
    `, [pnr, refundRef, refundAmount, reason || 'User requested cancellation', booking.payment_method, numPax]);

    res.json({
      success: true,
      message: 'Ticket cancelled successfully. Seats restored to inventory and refund initiated.',
      refund_ref: refundRef,
      refund_amount: refundAmount
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ----------------------------------------------------
// 11. TERMINAL DATABASE CLI QUERY ENDPOINT
// ----------------------------------------------------
app.post('/api/admin/query', async (req, res) => {
  try {
    const { sql } = req.body;
    if (!sql || typeof sql !== 'string') {
      return res.status(400).json({ success: false, error: 'SQL query string required' });
    }
    const result = await query(sql);
    res.json({
      success: true,
      command: result.command || 'SELECT',
      rowCount: result.rowCount !== undefined ? result.rowCount : (result.rows ? result.rows.length : 0),
      rows: result.rows || [],
      fields: result.fields ? result.fields.map(f => f.name) : (result.rows && result.rows[0] ? Object.keys(result.rows[0]) : [])
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});

// Start Server
async function startServer() {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`=======================================================`);
      console.log(`🚆 IRCTC Rail Backend Server running on port ${PORT}`);
      console.log(`📡 Base API URL: http://localhost:${PORT}/api`);
      console.log(`🌐 Web UI: http://localhost:${PORT}/index.html`);
      console.log(`=======================================================`);
    });
  } catch (err) {
    console.error('Fatal error starting server:', err);
    process.exit(1);
  }
}

startServer();
