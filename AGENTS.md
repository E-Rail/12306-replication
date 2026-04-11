# 12306 Replication Workshop — Agent Guide

## Overview
A faithful workshop replica of 12306 ticketing for learning, built in the /12306-replication folder parallel to the main 12306-game.
Uses a lightweight Express API to demonstrate train booking, waitlists, cancellations, and admin actions similar to real-world ticketing.

## Workshop Goals
- Reproduce real-world 12306 booking flow (search, book, waitlist, cancel)
- Demonstrate waitlist reconciliation when seats free up
- Provide an admin interface to add trains and mass-cancel to simulate market dynamics
- Compare replication with the game to illustrate different design goals: realism vs. pedagogy

## Workshop Scenarios
1. Basic booking flow on a BJ→SH corridor with waitlist outcomes
2. Cancellation-driven reconciliation and waitlist fulfillment
3. Triggering an extra train (加班车) and observing automatic waitlist movements
4. Admin mass-cancel to illustrate churn and recovery
5. Compare with the main game's rules to highlight differences in policy emphasis

## Quick Start (local development)
- Install: `npm install`
- Run: `npm start` (or `npm run dev` for live-reload)
- Server port: 3001; Frontend served at http://localhost:3001/

## API Endpoints
- `GET /api/trains` - Get trains for a route
- `POST /api/book` - Book tickets
- `POST /api/cancel` - Cancel a booking
- `GET /api/waitlist` - View waitlist
- `POST /api/auto-cancel` - Trigger auto-cancellation
- `POST /api/admin/add-train` - Add extra train
- `POST /api/admin/mass-cancel` - Mass cancel bookings
- `POST /api/admin/reset` - Reset system

## Where to edit
- Main logic: `server.js`
- Frontend: `index.html`

## Agent Responsibilities
- Audit for realism vs. simplicity
- Propose small, safe feature additions (e.g., save state, admin dashboard)
- Ensure API responses are stable and well-documented in code comments
- Add lightweight unit/test stubs if evolving the replication

## Experiment Ideas
- Validate waitlist fulfillment with random cancellations
- Test "加班车" logic by triggering admin add-train and reconciling waitlists
- Compare admin snapshot with the main game's flow to highlight differences in design goals

## Notes
- Keep the replication folder as a faithful, testable proxy of the real system
- Document any assumptions and simplifications clearly
- The system simulates real-world scenarios: seat segmentation, long-distance priority, waitlists, cancellations, and admin actions