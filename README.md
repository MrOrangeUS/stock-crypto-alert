# Stock/Crypto SMS Alert Website

This repository contains a self‑contained prototype for a stock/crypto
price alert service.  Users can register with an email address,
password and phone number, verify their phone via a one‑time code,
create a watchlist of tickers and set simple price‑based alerts.
When the simulated market price crosses a threshold, the server
notifies the user via SMS (printed to the console).

**Important:** this project uses **only Node.js built‑in modules** to
avoid any dependency on external npm packages.  It is intended as a
lightweight demonstration and should not be used in production
without significant enhancements (security, real market data, true
SMS integration, etc.).

## Getting started

1. Install [Node.js](https://nodejs.org).  This project was tested
   with Node v22.16.0 but should work with most recent versions.

2. Navigate to the `backend` directory and start the server:

   ```sh
   cd backend
   node server.js
   ```

   The server listens on port 3000 by default.  On first run it
   creates three JSON files (`users.json`, `watchlists.json` and
   `alerts.json`) to persist data.

3. Open a browser and navigate to `http://localhost:3000`.

4. Use the simple UI to:

   - **Register** with your email, password and phone number.  The
     server will generate a one‑time verification code and “send” it
     via SMS (printed to the server console).  In production you
     would integrate with Twilio or another SMS API here.

   - **Verify** your phone number by submitting the verification code.

   - **Login** to obtain a session token.  The browser stores this
     token in `localStorage` and includes it on subsequent API
     requests.

   - **Add tickers** (e.g. `AAPL`, `BTC-USD`) to your watchlist.

   - **Create alerts** for each ticker with a condition (price above
     or below a threshold).  When the simulated price meets the
     condition the alert is marked as triggered and an SMS is
     “sent”.

## How it works

* The server uses Node’s built‑in `http` module to implement a
  REST‑like API and serve static HTML/CSS/JS files from the `frontend`
  directory.

* User data, watchlists and alerts are stored as JSON files on disk.

* Authentication is handled via simple bearer tokens stored in
  memory.  A random 32‑byte string is generated on login and mapped
  to the user’s ID.  This mechanism is purely illustrative and has
  no expiry or revocation logic.

* Every 30 seconds a background job simulates current prices for
  tickers and checks each user’s alerts.  When an alert condition is
  met, the server logs an SMS message to the console and marks the
  alert as triggered.  Real‑world usage would replace this
  simulation with calls to a market data API and integrate with an
  SMS provider like Twilio.

## Limitations

- **No external dependencies:** the project intentionally avoids npm
  modules.  As a result several features are simplified; for
  example, password hashing uses SHA‑26 instead of a modern
  password hashing algorithm like bcrypt, and tokens have no
  expiration.

- **No database:** data persistence is provided via JSON files.

- **Mock SMS and prices:** SMS notifications are logged to the
  console; price data is generated pseudo‑randomly.  Integration
  with Twilio, Alpha Vantage or similar services is left as an
  exercise for the reader.

Despite these limitations, this prototype demonstrates the core
architecture of a price‑alert service and can serve as a starting
point for further development.
