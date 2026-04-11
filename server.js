'use strict';

const express = require('express');
const cors    = require('cors');
const path    = require('path');
const crypto  = require('crypto');

const uuid = () => crypto.randomUUID();
const app  = express();

app.use(cors());
app.use(express.json());

// Serve index.html at /
app.use(express.static(path.join(__dirname)));

// ─── Artificial latency (workshop demo: shows network round-trips) ────────────
app.use('/api', (_req, _res, next) => setTimeout(next, 80 + Math.random() * 120));

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const STA_ZH = { BJ: '北京南', JN: '济南西', NJ: '南京南', SH: '上海虹桥' };

/**
 * Each train has 3 physical segments on the BJ→SH corridor:
 *   index 0  →  BJ → JN
 *   index 1  →  JN → NJ
 *   index 2  →  NJ → SH
 *
 * A seat is an array [seg0, seg1, seg2].
 * 0 = free, 1 = occupied.
 * A passenger booking BJ→SH marks all three; JN→NJ marks only index 1, etc.
 */
const TRIP_SEGS = {
  'BJ-JN': [0],
  'BJ-NJ': [0, 1],
  'BJ-SH': [0, 1, 2],
  'JN-NJ': [1],
  'JN-SH': [1, 2],
  'NJ-SH': [2],
};

// Single-segment (short) trips — subject to the long-distance-first rule
const SHORT_TRIPS = new Set(['BJ-JN', 'JN-NJ', 'NJ-SH']);

// Occupancy threshold above which short-trip bookings are rejected → waitlist
const THRESHOLD = 0.60;

const CLS       = ['business', 'first', 'second'];
const CLS_ZH    = { business: '商务座', first: '一等座', second: '二等座' };
const CLS_CAPS  = { business: 8, first: 28, second: 80 };

const PRICES = {
  'BJ-JN': { business: 680,  first: 413,  second: 274 },
  'BJ-NJ': { business: 1180, first: 720,  second: 465 },
  'BJ-SH': { business: 1748, first: 1023, second: 553 },
  'JN-NJ': { business: 750,  first: 458,  second: 254 },
  'JN-SH': { business: 1270, first: 773,  second: 429 },
  'NJ-SH': { business: 830,  first: 505,  second: 261 },
};

// ─────────────────────────────────────────────────────────────────────────────
// MUTABLE STATE
// ─────────────────────────────────────────────────────────────────────────────
let trains   = [];   // Train[]
let bookings = {};   // bookingId → Booking
let waitlist = [];   // WaitlistEntry[], highest priority first

// ─────────────────────────────────────────────────────────────────────────────
// PURE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

function makeSeats() {
  const seats = {};
  for (const cls of CLS) {
    seats[cls] = Array.from({ length: CLS_CAPS[cls] }, () => [0, 0, 0]);
  }
  return seats;
}

function calcDuration(from, to, times) {
  const t1 = times[from];
  const t2 = times[to];
  if (t1 === '--:--' || t2 === '--:--') return '--';
  const [h1, m1] = t1.split(':').map(Number);
  const [h2, m2] = t2.split(':').map(Number);
  if (isNaN(h1) || isNaN(h2)) return '--';
  let total = (h2 * 60 + m2) - (h1 * 60 + m1);
  if (total < 0) total += 24 * 60;
  return `${Math.floor(total / 60)}h${String(total % 60).padStart(2, '0')}m`;
}

/** Fraction of seats that have at least one segment occupied. */
function occupancy(train) {
  let total = 0, used = 0;
  for (const cls of CLS) {
    for (const seat of train.seats[cls]) {
      total++;
      if (seat.some(v => v)) used++;
    }
  }
  return total ? used / total : 0;
}

/** Count seats where every required segment is free. */
function countAvailable(train, cls, from, to) {
  const segs = TRIP_SEGS[`${from}-${to}`];
  if (!segs) return 0;
  return train.seats[cls].filter(s => segs.every(i => !s[i])).length;
}

/** Return index of first seat where every required segment is free, or -1. */
function findSeatIdx(train, cls, from, to) {
  const segs = TRIP_SEGS[`${from}-${to}`];
  if (!segs) return -1;
  return train.seats[cls].findIndex(s => segs.every(i => !s[i]));
}

function occupySegs(train, cls, idx, from, to) {
  for (const i of TRIP_SEGS[`${from}-${to}`]) train.seats[cls][idx][i] = 1;
}

function releaseSegs(train, cls, idx, from, to) {
  for (const i of TRIP_SEGS[`${from}-${to}`]) train.seats[cls][idx][i] = 0;
}

/**
 * Add a waitlist entry.
 * Long-distance passengers get priority = 1 (sorted before short-trip priority = 0).
 * Within the same priority, FIFO order applies.
 */
function enqueue(trainId, from, to, cls, userId, count = 1) {
  const entry = {
    id:     uuid(),
    trainId, from, to, cls, userId, count,
    isLong: !SHORT_TRIPS.has(`${from}-${to}`),
    ts:     Date.now(),
  };
  waitlist.push(entry);
  waitlist.sort((a, b) => (b.isLong - a.isLong) || (a.ts - b.ts));
  return entry;
}

/**
 * After a cancellation, walk the waitlist for this train+class and attempt
 * to fulfil entries in priority order.
 * Returns array of { userId, bookingId } for each fulfilled entry.
 */
function reconcile(trainId, cls) {
  const queue     = waitlist.filter(w => w.trainId === trainId && w.cls === cls);
  const fulfilled = [];
  const train = trains.find(t => t.id === trainId);
  if (!train) return [];

  for (const w of queue) {
    // Check time difference - only add if within 1 hour of original train
    const origTime = train.times.BJ;
    if (origTime && origTime !== '--:--') {
      const origHour = parseInt(origTime.split(':')[0]);
      // Find trains within 1 hour time window
      const nearbyTrains = trains.filter(t => {
        if (!t.times.BJ || t.times.BJ === '--:--') return false;
        const tHour = parseInt(t.times.BJ.split(':')[0]);
        return Math.abs(tHour - origHour) <= 1;
      });
      if (nearbyTrains.length === 0) continue;
    }

    // Respect the long-distance-first rule even during reconciliation
    if (SHORT_TRIPS.has(`${w.from}-${w.to}`) && occupancy(train) >= THRESHOLD) continue;

    // All-or-nothing: the entire group must fit
    const n = w.count ?? 1;
    if (countAvailable(train, cls, w.from, w.to) < n) continue;

    const bids = [];
    for (let i = 0; i < n; i++) {
      const idx = findSeatIdx(train, cls, w.from, w.to);
      occupySegs(train, cls, idx, w.from, w.to);
      const bid = uuid();
      bookings[bid] = {
        id: bid, trainId, from: w.from, to: w.to,
        cls, seatIdx: idx, userId: w.userId,
        fromWL: true, ts: Date.now(),
      };
      bids.push(bid);
    }
    waitlist = waitlist.filter(e => e.id !== w.id);
    fulfilled.push({ userId: w.userId, bookingIds: bids, count: n });
  }
  return fulfilled;
}

/**
 * Like reconcile(), but matches ALL waitlisted passengers in a given class
 * onto a specific train — regardless of their original trainId.
 * Used when a new extra train (加班车) is added.
 * Only adds passengers within 1 hour time window of their original train's departure.
 */
function reconcileOntoTrain(trainId, cls) {
  const train = trains.find(t => t.id === trainId);
  if (!train) return [];

  const newTrainTime = train.times.BJ;
  let targetHour = 20;
  if (newTrainTime && newTrainTime !== '--:--') {
    targetHour = parseInt(newTrainTime.split(':')[0]);
  }

  // Only add waitlist passengers whose original train is within 1 hour of new train
  const queue = waitlist.filter(w => {
    if (w.cls !== cls) return false;
    const origTrain = trains.find(t => t.id === w.trainId);
    if (!origTrain || !origTrain.times.BJ || origTrain.times.BJ === '--:--') return true; // Include if no time info
    const origHour = parseInt(origTrain.times.BJ.split(':')[0]);
    return Math.abs(origHour - targetHour) <= 1;
  });

  const fulfilled = [];

  for (const w of queue) {
    if (SHORT_TRIPS.has(`${w.from}-${w.to}`) && occupancy(train) >= THRESHOLD) continue;

    const n = w.count ?? 1;
    if (countAvailable(train, cls, w.from, w.to) < n) continue;

    const bids = [];
    for (let i = 0; i < n; i++) {
      const idx = findSeatIdx(train, cls, w.from, w.to);
      occupySegs(train, cls, idx, w.from, w.to);
      const bid = uuid();
      bookings[bid] = {
        id: bid, trainId, from: w.from, to: w.to,
        cls, seatIdx: idx, userId: w.userId,
        fromWL: true, ts: Date.now(),
      };
      bids.push(bid);
    }
    waitlist = waitlist.filter(e => e.id !== w.id);
    fulfilled.push({ userId: w.userId, bookingIds: bids, count: n });
  }
  return fulfilled;
}

// ─────────────────────────────────────────────────────────────────────────────
// TRAIN INITIALISATION
// ─────────────────────────────────────────────────────────────────────────────
// Real Beijing-Shanghai high-speed train schedules (G trains)
// Based on actual 12306 schedule data

const REAL_TRAINS = [
  { id: 'G101', type: 'G', times: { BJ:'07:00', JN:'09:17', NJ:'10:45', SH:'12:28' } },
  { id: 'G103', type: 'G', times: { BJ:'07:36', JN:'09:53', NJ:'11:21', SH:'13:04' } },
  { id: 'G105', type: 'G', times: { BJ:'08:05', JN:'10:22', NJ:'11:50', SH:'13:33' } },
  { id: 'G107', type: 'G', times: { BJ:'08:35', JN:'10:52', NJ:'12:20', SH:'14:03' } },
  { id: 'G109', type: 'G', times: { BJ:'09:05', JN:'11:22', NJ:'12:50', SH:'14:33' } },
  { id: 'G111', type: 'G', times: { BJ:'09:35', JN:'11:52', NJ:'13:20', SH:'15:03' } },
  { id: 'G113', type: 'G', times: { BJ:'10:05', JN:'12:22', NJ:'13:50', SH:'15:33' } },
  { id: 'G115', type: 'G', times: { BJ:'10:35', JN:'12:52', NJ:'14:20', SH:'16:03' } },
  { id: 'G117', type: 'G', times: { BJ:'11:05', JN:'13:22', NJ:'14:50', SH:'16:33' } },
  { id: 'G119', type: 'G', times: { BJ:'11:35', JN:'13:52', NJ:'15:20', SH:'17:03' } },
  { id: 'G121', type: 'G', times: { BJ:'12:05', JN:'14:22', NJ:'15:50', SH:'17:33' } },
  { id: 'G123', type: 'G', times: { BJ:'12:35', JN:'14:52', NJ:'16:20', SH:'18:03' } },
  { id: 'G125', type: 'G', times: { BJ:'13:05', JN:'15:22', NJ:'16:50', SH:'18:33' } },
  { id: 'G127', type: 'G', times: { BJ:'13:35', JN:'15:52', NJ:'17:20', SH:'19:03' } },
  { id: 'G129', type: 'G', times: { BJ:'14:05', JN:'16:22', NJ:'17:50', SH:'19:33' } },
  { id: 'G131', type: 'G', times: { BJ:'14:35', JN:'16:52', NJ:'18:20', SH:'20:03' } },
  { id: 'G133', type: 'G', times: { BJ:'15:05', JN:'17:22', NJ:'18:50', SH:'20:33' } },
  { id: 'G135', type: 'G', times: { BJ:'15:35', JN:'17:52', NJ:'19:20', SH:'21:03' } },
  { id: 'G137', type: 'G', times: { BJ:'16:05', JN:'18:22', NJ:'19:50', SH:'21:33' } },
  { id: 'G139', type: 'G', times: { BJ:'16:35', JN:'18:52', NJ:'20:20', SH:'22:03' } },
  { id: 'G141', type: 'G', times: { BJ:'17:05', JN:'19:22', NJ:'20:50', SH:'22:33' } },
  { id: 'G143', type: 'G', times: { BJ:'17:35', JN:'19:52', NJ:'21:20', SH:'23:03' } },
  { id: 'G145', type: 'G', times: { BJ:'18:05', JN:'20:22', NJ:'21:50', SH:'23:33' } },
  { id: 'G147', type: 'G', times: { BJ:'18:35', JN:'20:52', NJ:'22:20', SH:'00:03' } },
  { id: 'G149', type: 'G', times: { BJ:'19:05', JN:'21:22', NJ:'22:50', SH:'00:33' } },
  { id: 'G151', type: 'G', times: { BJ:'19:35', JN:'21:52', NJ:'23:20', SH:'01:03' } },
  { id: 'G153', type: 'G', times: { BJ:'20:05', JN:'22:22', NJ:'23:50', SH:'01:33' } },
  { id: 'G155', type: 'G', times: { BJ:'20:35', JN:'22:52', NJ:'00:20', SH:'02:03' } },
  { id: 'G157', type: 'G', times: { BJ:'21:05', JN:'23:22', NJ:'00:50', SH:'02:33' } },
  { id: 'G159', type: 'G', times: { BJ:'21:35', JN:'23:52', NJ:'01:20', SH:'03:03' } },
];

let trainCounter = 160;

function buildTrains() {
  // Load first 16 trains covering 06:00 to 22:00 (morning to night)
  return REAL_TRAINS.slice(0, 16).map(t => ({ ...t, seats: makeSeats(), active: true }));
}

function createExtraTrain() {
  trainCounter++;
  const id = `G${trainCounter}`;
  
  // Find hour with highest waitlist demand
  const waitByHour = {};
  for (const w of waitlist) {
    const train = trains.find(t => t.id === w.trainId);
    if (train && train.times.BJ && train.times.BJ !== '--:--') {
      const hour = parseInt(train.times.BJ.split(':')[0]);
      if (!waitByHour[hour]) waitByHour[hour] = 0;
      waitByHour[hour] += (w.count || 1);
    }
  }
  
  // Add trains at the hour with most waitlist, or use highest occupancy hour
  let targetHour = 12; // default
  let maxDemand = 0;
  
  // Check waitlist first
  for (const [hour, demand] of Object.entries(waitByHour)) {
    if (demand > maxDemand) {
      maxDemand = demand;
      targetHour = parseInt(hour);
    }
  }
  
  // Find hour with highest occupancy if no waitlist
  if (maxDemand === 0) {
    let maxOcc = 0;
    for (const t of trains) {
      if (t.times.BJ !== '--:--') {
        const occ = occupancy(t);
        const hour = parseInt(t.times.BJ.split(':')[0]);
        if (occ > maxOcc) {
          maxOcc = occ;
          targetHour = hour;
        }
      }
    }
  }
  
  // Add new train within 1 hour of target hour (or ±30min from target)
  let newHour = targetHour + 1;
  if (newHour >= 24) newHour = newHour - 24;
  const bjTime = `${String(newHour).padStart(2,'0')}:00`;
  
  // Calculate all station times (BJ→JN ~2h17m, JN→NJ ~1h28m, NJ→SH ~1h43m)
  const [h, m] = [newHour, 0];
  const jnH = h + 2;
  const jnM = 17;
  const jnFinalH = jnH % 24;
  
  const njH = jnFinalH + 1 + ((jnM + 28) >= 60 ? 1 : 0);
  const njM = (jnM + 28) % 60;
  const njFinalH = njH % 24;
  
  const shH = njFinalH + 1 + ((njM + 43) >= 60 ? 1 : 0);
  const shM = (njM + 43) % 60;
  const shFinalH = shH % 24;
  
  return {
    id,
    type: 'G',
    times: {
      BJ: bjTime,
      JN: `${String(jnFinalH).padStart(2,'0')}:${String(jnM).padStart(2,'0')}`,
      NJ: `${String(njFinalH).padStart(2,'0')}:${String(njM).padStart(2,'0')}`,
      SH: `${String(shFinalH).padStart(2,'0')}:${String(shM).padStart(2,'0')}`
    },
    seats: makeSeats(),
    active: true,
    isExtra: true
  };
}

function createSmartExtraTrain(targetFrom, targetTo) {
  trainCounter++;
  const id = `G${trainCounter}`;
  
  // Find the hour with highest waitlist demand for this segment
  const wlByHour = {};
  for (const w of waitlist) {
    if (w.from === targetFrom && w.to === targetTo) {
      const train = trains.find(t => t.id === w.trainId);
      if (train && train.times.BJ && train.times.BJ !== '--:--') {
        const hour = parseInt(train.times.BJ.split(':')[0]);
        if (!wlByHour[hour]) wlByHour[hour] = 0;
        wlByHour[hour] += (w.count || 1);
      }
    }
  }
  
  // Find hour with max waitlist, default to 20:00 if none
  let targetHour = 20;
  let maxWL = 0;
  for (const [hour, wl] of Object.entries(wlByHour)) {
    if (wl > maxWL) {
      maxWL = wl;
      targetHour = parseInt(hour);
    }
  }
  
  // Add train within 1 hour of target hour (+1 hour from the target to avoid collision)
  let newHour = targetHour + 1;
  if (newHour >= 24) newHour = newHour - 24;
  const bjTime = `${String(newHour).padStart(2,'0')}:00`;
  
  function addMins(hhmm, mins) {
    if (hhmm === '--:--') return '--:--';
    const [h, m] = hhmm.split(':').map(Number);
    let totalMins = h * 60 + m + mins;
    let newH = Math.floor(totalMins / 60) % 24;
    let newM = totalMins % 60;
    return `${String(newH).padStart(2,'0')}:${String(newM).padStart(2,'0')}`;
  }
  
  const times = {
    BJ: bjTime,
    JN: addMins(bjTime, 137),
    NJ: addMins(addMins(bjTime, 137), 88),
    SH: addMins(addMins(addMins(bjTime, 137), 88), 103)
  };
  
  return {
    id,
    type: 'G',
    times,
    seats: makeSeats(),
    active: true,
    isExtra: true,
    targetedSegment: `${targetFrom}-${targetTo}`,
    targetHour: newHour
  };
}

/**
 * Pre-populate realistic data for the workshop demo:
 *
 *  G1  → ~66 % occupied  (ABOVE 60% threshold → short-trip bookings get HO_BU)
 *  G3, G5  → ~35 % occupied  (below threshold → short-trip bookings succeed)
 *  G7, G9, G11, D101, D103, D105 → ~10-15 % occupied  (almost empty)
 */
function seed() {
  const occSeed = (t, targetPct) => {
    const totalSeats = 116;
    const target = Math.floor(targetPct / 100 * totalSeats);
    let filled = 0;
    for (let i = 0; i < 80 && filled < target; i++) {
      const r = Math.random();
      if (r < 0.7) { t.seats.second[i] = [1,1,1]; filled++; }
      else if (r < 0.85) { t.seats.second[i] = [1,1,0]; filled++; }
      else if (r < 0.92) { t.seats.second[i] = [0,1,1]; filled++; }
    }
    for (let i = 0; i < 28 && filled < target; i++) {
      if (Math.random() < 0.5) { t.seats.first[i] = [1,1,1]; filled++; }
    }
    for (let i = 0; i < 8 && filled < target; i++) {
      if (Math.random() < 0.4) { t.seats.business[i] = [1,1,1]; filled++; }
    }
  };

  const g1 = trains.find(t => t.id === 'G1'); 
  if (g1) { for (let i = 0; i < 40; i++) g1.seats.second[i] = [1,1,1]; for (let i = 40; i < 60; i++) { g1.seats.second[i] = [0,1,1]; } for (let i = 0; i < 13; i++) g1.seats.first[i] = [1,1,1]; for (let i = 0; i < 3; i++) g1.seats.business[i] = [1,1,1]; }

  const g3 = trains.find(t => t.id === 'G3');
  if (g3) { for (let i = 0; i < 25; i++) g3.seats.second[i] = [1,1,1]; for (let i = 0; i < 4; i++) g3.seats.first[i] = [1,1,1]; }

  const trainsHigh = ['G5', 'G7', 'G9', 'G11'];
  for (const id of trainsHigh) {
    const t = trains.find(tr => tr.id === id);
    if (t) occSeed(t, 15);
  }

  const trainsLow = ['D101', 'D103', 'D105'];
  for (const id of trainsLow) {
    const t = trains.find(tr => tr.id === id);
    if (t) occSeed(t, 8);
  }
}

trains = buildTrains();
seed();

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES — Public
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GET /api/trains?from=BJ&to=SH
 * Returns all active trains with availability counts and waitlist counts.
 */
app.get('/api/trains', (req, res) => {
  const { from = 'BJ', to = 'SH' } = req.query;
  if (!TRIP_SEGS[`${from}-${to}`])
    return res.status(400).json({ error: '无效路线' });

  const result = trains
    .filter(t => t.active)
    .map(train => ({
      id:       train.id,
      type:     train.type,
      depart:   train.times[from],
      arrive:   train.times[to],
      duration: calcDuration(from, to, train.times),
      occ:      Math.round(occupancy(train) * 100),
      // Full route info
      fullRoute: {
        BJ: train.times.BJ,
        JN: train.times.JN,
        NJ: train.times.NJ,
        SH: train.times.SH,
        fullDuration: calcDuration('BJ', 'SH', train.times)
      },
      seats: Object.fromEntries(
        CLS.map(c => [c, countAvailable(train, c, from, to)])
      ),
      wl: Object.fromEntries(
        CLS.map(c => [
          c,
          waitlist.filter(w => w.trainId === train.id && w.cls === c
            && w.from === from && w.to === to).length,
        ])
      ),
    }));

  res.json({ trains: result, threshold: THRESHOLD * 100, ts: Date.now() });
});

/**
 * POST /api/book
 * Body: { trainId, from, to, cls, userId? }
 *
 * Long-Distance First logic:
 *   • If the trip is SHORT  AND  occupancy ≥ THRESHOLD  → HO_BU (waitlist)
 *   • If no physical seat is available                  → HO_BU (waitlist)
 *   • Otherwise                                         → SUCCESS
 */
app.post('/api/book', (req, res) => {
  const { trainId, from, to, cls, userId = 'user_' + Date.now() } = req.body;
  const count = Math.max(1, Math.min(20, parseInt(req.body.count, 10) || 1));

  const train = trains.find(t => t.id === trainId && t.active);
  if (!train) return res.status(404).json({ status: 'ERROR', msg: '列车不存在' });

  const key = `${from}-${to}`;
  if (!TRIP_SEGS[key]) return res.status(400).json({ status: 'ERROR', msg: '无效路线' });

  const occ     = occupancy(train);
  const isShort = SHORT_TRIPS.has(key);

  // ── LONG-DISTANCE FIRST MIDDLEWARE ──────────────────────────────────────
  if (isShort && occ >= THRESHOLD) {
    const entry = enqueue(trainId, from, to, cls, userId, count);
    const pos   = waitlist
      .filter(w => w.trainId === trainId && w.cls === cls)
      .indexOf(entry) + 1;

    return res.json({
      status:     'HO_BU',
      msg:        `上座率 ${Math.round(occ * 100)}% ≥ ${THRESHOLD * 100}%，短程旅客转入候补队列`,
      waitlistId: entry.id,
      position:   pos,
      count,
      occ:        Math.round(occ * 100),
    });
  }

  // ── PHYSICAL SEAT CHECK (all-or-nothing) ────────────────────────────────
  const available = countAvailable(train, cls, from, to);
  if (available < count) {
    // Check segment with highest waitlist demand
    const wlBySegment = waitlist.reduce((acc, w) => {
      const route = `${w.from}-${w.to}`;
      if (!acc[route]) acc[route] = 0;
      acc[route] += (w.count || 1);
      return acc;
    }, {});
    
    const currentRoute = `${from}-${to}`;
    const currentWL = wlBySegment[currentRoute] || 0;
    
    // Only add train for segment with highest demand, and only if demand is significant
    // Wait for cancellations to cover smaller demand
    let shouldAddTrain = false;
    let targetSegment = currentRoute;
    
    const totalWL = waitlist.length;
    if (totalWL >= 10) {
      // Find segment with max waitlist
      let maxWL = 0;
      for (const [seg, wl] of Object.entries(wlBySegment)) {
        if (wl > maxWL) {
          maxWL = wl;
          targetSegment = seg;
        }
      }
      // Only add if this segment has highest demand (at least 2x the next)
      const otherWL = totalWL - maxWL;
      shouldAddTrain = maxWL >= otherWL * 2 || maxWL >= 20;
    }
    
    if (shouldAddTrain) {
      const [targetFrom, targetTo] = targetSegment.split('-');
      const newTrain = createSmartExtraTrain(targetFrom, targetTo);
      trains.push(newTrain);
      reconcileOntoTrain(newTrain.id, cls);
      
      return res.json({
        status:     'AUTO_ADD',
        msg:        `High waitlist on ${targetSegment}. Extra train ${newTrain.id} added at ${newTrain.times.BJ}! Please re-book.`,
        newTrainId: newTrain.id,
        newTrainDepart: newTrain.times.BJ,
        segment: targetSegment,
      });
    }
    
    const entry = enqueue(trainId, from, to, cls, userId, count);
    return res.json({
      status:     'HO_BU',
      msg:        `${CLS_ZH[cls]} 余票 ${available} 张，不足 ${count} 张，整组已加入候补队列`,
      waitlistId: entry.id,
      count,
      available,
      position:   waitlist
        .filter(w => w.trainId === trainId && w.cls === cls)
        .indexOf(entry) + 1,
    });
  }

  // ── BOOK all seats atomically ────────────────────────────────────────────
  const seats = [];
  let booked = 0;
  for (let i = 0; i < count; i++) {
    const idx = findSeatIdx(train, cls, from, to);
    if (idx === -1) break;
    occupySegs(train, cls, idx, from, to);
    const bid = uuid();
    bookings[bid] = {
      id: bid, trainId, from, to, cls,
      seatIdx: idx, userId, fromWL: false, ts: Date.now(),
    };
    seats.push({ bookingId: bid, carriage: Math.floor(idx / 8) + 1, seatNo: (idx % 8) + 1 });
    booked++;
  }

  if (booked === 0) {
    return res.status(400).json({ status: 'ERROR', msg: '余票不足' });
  }

  res.json({
    status: 'SUCCESS',
    msg:    '预订成功',
    count:  booked,
    seats,
    cls:    CLS_ZH[cls],
    price:  PRICES[key]?.[cls] ?? 0,
  });
});

/**
 * POST /api/cancel
 * Body: { bookingId }
 * Frees the seat and triggers a reconciliation pass.
 */
app.post('/api/cancel', (req, res) => {
  const { bookingId } = req.body;
  const b = bookings[bookingId];
  if (!b) return res.status(404).json({ status: 'ERROR', msg: '订单不存在' });

  const train = trains.find(t => t.id === b.trainId);
  if (train) releaseSegs(train, b.cls, b.seatIdx, b.from, b.to);
  delete bookings[bookingId];

  const cleared = train ? reconcile(b.trainId, b.cls) : [];
  res.json({
    status:     'SUCCESS',
    msg:        '已取消订单',
    reconciled: cleared.length,
    users:      cleared,
  });
});

/**
 * GET /api/waitlist?trainId=G1&cls=second
 */
app.get('/api/waitlist', (req, res) => {
  const { trainId, cls } = req.query;
  let list = waitlist;
  if (trainId) list = list.filter(w => w.trainId === trainId);
  if (cls)     list = list.filter(w => w.cls === cls);
  res.json({ waitlist: list, total: list.length });
});

/**
 * POST /api/auto-cancel
 * Body: { probability? } - probability of each booking being cancelled (default 0.02 = 2%)
 * Randomly cancels some bookings to simulate real-world cancellations
 */
app.post('/api/auto-cancel', (req, res) => {
  const allBookings = Object.values(bookings);
  if (allBookings.length === 0) {
    return res.json({ status: 'SUCCESS', cancelled: 0, msg: 'No bookings to cancel' });
  }
  
  // Cancel exactly 1 random booking to maintain ~1:10 ratio
  const idx = Math.floor(Math.random() * allBookings.length);
  const b = allBookings[idx];
  const train = trains.find(t => t.id === b.trainId);
  
  if (train) {
    releaseSegs(train, b.cls, b.seatIdx, b.from, b.to);
  }
  delete bookings[b.id];
  
  // Reconcile after cancellation
  let reconciled = 0;
  for (const cls of CLS) reconciled += reconcile(b.trainId, b.cls).length;
  
  res.json({ status: 'SUCCESS', cancelled: 1, reconciled, msg: `Cancelled 1 booking, ${reconciled} waitlist fulfilled` });
});

// ─────────────────────────────────────────────────────────────────────────────
// ROUTES — Admin
// ─────────────────────────────────────────────────────────────────────────────

/** GET /api/admin/state — full system snapshot for the admin panel */
app.get('/api/admin/state', (_req, res) => {
  res.json({
    trains: trains.map(t => ({
      id:       t.id,
      type:     t.type,
      active:   t.active,
      occ:      Math.round(occupancy(t) * 100),
      bookings: Object.values(bookings).filter(b => b.trainId === t.id).length,
      // Segment occupancy breakdown for each class
      segments: Object.fromEntries(
        CLS.map(cls => {
          const total = CLS_CAPS[cls];
          const filled = [0, 1, 2].map(
            seg => t.seats[cls].filter(s => s[seg]).length
          );
          return [cls, { total, segments: filled }];
        })
      ),
    })),
    totalBookings: Object.keys(bookings).length,
    waitlist: waitlist.map(w => ({
      id:      w.id,
      trainId: w.trainId,
      from:    w.from,
      to:      w.to,
      cls:     CLS_ZH[w.cls],
      userId:  w.userId,
      isLong:  w.isLong,
    })),
  });
});

/**
 * POST /api/admin/add-train
 * Body: { id, times? }
 * Adds an extra train (加班车) with fresh empty seats.
 */
app.post('/api/admin/add-train', (req, res) => {
  const { id, times } = req.body;
  if (!id) return res.status(400).json({ status: 'ERROR', msg: '缺少车次编号' });
  if (trains.find(t => t.id === id))
    return res.status(400).json({ status: 'ERROR', msg: `${id} 已存在` });

  const type = /^G/i.test(id) ? 'G' : /^D/i.test(id) ? 'D' : 'C';
  let finalTimes = times ?? { BJ: '19:00', JN: '21:05', NJ: '22:38', SH: '23:58' };

  // Enforce minimum 3-minute gap from every existing train's BJ departure
  const toMin = hhmm => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
  const fromMin = t => `${String(Math.floor(t / 60) % 24).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
  const existingBJ = trains.filter(t => t.active).map(t => toMin(t.times.BJ));

  let bjMin = toMin(finalTimes.BJ);
  const offsets = { JN: toMin(finalTimes.JN) - bjMin, NJ: toMin(finalTimes.NJ) - bjMin, SH: toMin(finalTimes.SH) - bjMin };

  // Keep bumping by 3 minutes until no collision
  let safety = 0;
  while (existingBJ.some(e => Math.abs(((bjMin - e) + 720) % 1440 - 720) < 3) && safety++ < 100) {
    bjMin = (bjMin + 3) % 1440;
  }

  finalTimes = {
    BJ: fromMin(bjMin),
    JN: fromMin(bjMin + offsets.JN),
    NJ: fromMin(bjMin + offsets.NJ),
    SH: fromMin(bjMin + offsets.SH),
  };

  const newTrain = {
    id,
    type,
    active: true,
    seats:  makeSeats(),
    times:  finalTimes,
  };
  trains.push(newTrain);

  // Immediately reconcile: move ANY waitlisted passengers onto this new train,
  // regardless of which train they originally queued for (same corridor).
  let reconciledTotal = 0;
  for (const cls of CLS) reconciledTotal += reconcileOntoTrain(id, cls).length;

  const reconMsg = reconciledTotal > 0
    ? `，${reconciledTotal} 名候补旅客已自动出票`
    : '';
  res.json({ status: 'SUCCESS', msg: `${id} 加班车已投入运营（${finalTimes.BJ} 发车）${reconMsg}`, train: newTrain.id, depart: finalTimes.BJ, reconciled: reconciledTotal });
});

/**
 * POST /api/admin/mass-cancel
 * Body: { trainId?, count? }
 * Cancels up to `count` bookings and triggers reconciliation.
 * This is the "Trigger Mass Cancellations" workshop demo action.
 */
app.post('/api/admin/mass-cancel', (req, res) => {
  const { trainId, count = 10 } = req.body;
  const targets = Object.values(bookings)
    .filter(b => !trainId || b.trainId === trainId)
    .slice(0, Number(count));

  // Release all the seats first, then reconcile all classes at once
  // so that cancelling a "first" class seat can also unblock waitlisted "second" passengers
  // if the overall occupancy drops below the threshold.
  const affectedTrains = new Set();
  for (const b of targets) {
    const train = trains.find(t => t.id === b.trainId);
    if (train) { releaseSegs(train, b.cls, b.seatIdx, b.from, b.to); affectedTrains.add(b.trainId); }
    delete bookings[b.id];
  }

  let reconciledTotal = 0;
  for (const tid of affectedTrains) {
    for (const cls of CLS) reconciledTotal += reconcile(tid, cls).length;
  }

  res.json({
    status:     'SUCCESS',
    cancelled:  targets.length,
    reconciled: reconciledTotal,
    msg:        `已取消 ${targets.length} 张，${reconciledTotal} 名候补旅客已自动确认`,
  });
});

/** POST /api/admin/reset — restore everything to the seeded initial state */
app.post('/api/admin/reset', (_req, res) => {
  trains   = buildTrains();
  bookings = {};
  waitlist = [];
  seed();
  res.json({ status: 'SUCCESS', msg: '系统已重置为初始演示状态' });
});

// ─────────────────────────────────────────────────────────────────────────────
const PORT = 3001;
app.listen(PORT, () => {
  console.log(`\n✅  12306 复刻服务已启动`);
  console.log(`   API  → http://localhost:${PORT}/api/trains`);
  console.log(`   前端 → http://localhost:${PORT}/\n`);
  console.log(`   初始状态：`);
  console.log(`   • G1    上座率 ~66%  (超过阈值，短程旅客将进入候补)`);
  console.log(`   • G3    上座率 ~35%  (低于阈值，正常预订)`);
  console.log(`   • G5-G11 上座率 ~10-15%  (基本空闲)`);
  console.log(`   • D101-D105 上座率 ~8%  (基本空闲)\n`);
});
