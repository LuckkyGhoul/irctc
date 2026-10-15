# 🚆 IRCTC Train Ticket Booking System - Backend & Database

A complete, production-ready backend for the IRCTC train booking application with **PostgreSQL** database, JWT authentication, live 30-second waitlist confirmation, concurrency & race condition resolution with automatic partial/full refund processing, real-time dynamic seat inventory decrements, and comprehensive train route timetable lookups.

---

## 📍 Storage Location & Zip File

- **Project Root Directory**:
  ```
  C:\Users\userpc33\.gemini\antigravity\scratch\train_booking_system
  ```
- **Frontend Files also saved at**:
  ```
  C:\Users\userpc33\Downloads\index.html
  C:\Users\userpc33\Downloads\login.html
  C:\Users\userpc33\Downloads\ticket.html
  ```
- **Direct Zip Archive**:
  ```
  C:\Users\userpc33\Downloads\train_booking_system.zip
  C:\Users\userpc33\.gemini\antigravity\scratch\train_booking_system\train_booking_system.zip
  ```

---

## 🚀 Quick Start

### 1. Start the Backend Server
Double-click `run_server.bat` or run in terminal:
```powershell
cd C:\Users\userpc33\.gemini\antigravity\scratch\train_booking_system
node src/server.js
```
The server will start on **port 8090**:
- **Web App**: [http://localhost:8090/index.html](http://localhost:8090/index.html)
- **Login / Register**: [http://localhost:8090/login.html](http://localhost:8090/login.html)
- **E-Ticket**: [http://localhost:8090/ticket.html](http://localhost:8090/ticket.html)
- **API Base**: [http://localhost:8090/api](http://localhost:8090/api)

---

## 🌟 Key Features Implemented

### 1. 🏎️ Race Condition, Deadlock Simulation & 30-Second Live Timer
- **10–15 Passenger Demo**: On the passenger booking page, click:
  - `⚡ Quick Add 12 Passengers (Test Race Condition)`
  - `⚡ Quick Add 15 Passengers`
  These automatically add realistic passenger names, ages, genders, and berth preferences.
- **Concurrency Contention**: When booking with more passengers than available seats (seeded with **4** seats available on train 12017), the system flags a concurrency contention and enters the waitlist queue.
- **30-Second Contention Timer**: On ticket generation, a live 30-second timer runs with rotating status messages simulating contention resolution.
- **Berth Allocation & Refund Breakdown**:
  - The available 4 seats are allocated with green **`CNF`** status and assigned Coach and Berth numbers (e.g. `B2 / 24`).
  - The remaining 8 unallocated passengers receive a red **`REFUND INITIATED`** status badge.
  - An automated **Refund Reference** (e.g., `REF6312742122`) and proportional **Refund Amount** are generated and tracked in the PostgreSQL `refunds` table.

### 2. 📉 Real-Time Dynamic Seat Inventory Decrement
- The number of available seats per train/date/class decreases in PostgreSQL immediately when tickets are booked.
- If no ticket is booked, the inventory stays normal.

### 3. 🚆 All Trains List & Default Station Reaching Times
- Click **"Train Schedule"** or **"PNR Status"** to view all trains and their complete timetables.
- Quick filter chips for key regional hubs:
  - 🏔️ **Dehradun (`DDN`)** — *8 trains*
  - 🌊 **Haridwar (`HW`)** — *6 trains*
  - 🏛️ **Lucknow (`LKO`)** — *9 trains*
  - 🧘 **Rishikesh (`YNRK` / `RKSH`)** — *4 trains*
  - 🎓 **Roorkee (`RK`)** — *7 trains*
- Expand **"View Default Station Reaching Times"** on any train to see all scheduled intermediate halts, default arrival/departure times, halt durations, and distance.

### 4. 🔍 PNR Live Typing Lookup & Normal Train Path
- Enter a 10-digit PNR in the PNR Enquiry tab.
- Live autocomplete suggests matching bookings as you type.
- Displays:
  - Reservation status (`CNF`, `PARTIAL_CNF`, `WL`, `CANCELLED`).
  - Passenger breakdown with individual coach and berth allocations.
  - **Normal Train Path Table**: Sequential list of intermediate stations, arrival and departure times, halt duration, and **Travel Time from Start** (`travel_time_from_start`).
  - Active refund records with refund reference code and amount.

---

## 🗄️ PostgreSQL Database Schema

Embedded persistent PostgreSQL database stored in `./data/postgres_db` (or automatically connects via `DATABASE_URL` if configured).

### Tables:
1. `users` — User credentials with bcrypt password hashing
2. `stations` — Indian Railways stations with codes, cities, and states
3. `trains` — Trains with source, destination, timings, and available classes
4. `train_schedules` — Intermediate stations, halt durations, distance, and `travel_time_from_start`
5. `seat_inventory` — Available and booked seats per train, date, class, and quota
6. `bookings` — 10-digit PNR bookings with journey details, fare breakdowns, and status
7. `passengers` — Passenger profiles with assigned coach, berth, and status
8. `refunds` — Automated refunds with unique reference IDs and amounts

---

## 📡 REST API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Health check |
| `POST` | `/api/auth/signup` | Register new user account |
| `POST` | `/api/auth/login` | Login and receive JWT token |
| `GET` | `/api/stations` | All stations for autocomplete |
| `GET` | `/api/trains` | Search trains between stations with dynamic seat counts |
| `GET` | `/api/trains/all` | All trains list with default station reaching times |
| `GET` | `/api/trains/:trainNo/schedule` | Specific train schedule |
| `POST` | `/api/book` | Book ticket (supports 10-15 passengers, detects race condition) |
| `GET` | `/api/ticket/:pnr` | Get full e-ticket details from PostgreSQL |
| `GET` | `/api/pnr/:pnr` | PNR enquiry with passenger breakdown & reaching times |
| `GET` | `/api/pnr-search` | Live PNR typeahead autocomplete |
| `POST` | `/api/wl-confirm` | 30s contention resolution, allocation & refund initiation |
| `POST` | `/api/ticket/cancel` | Cancel existing ticket and process refund |
