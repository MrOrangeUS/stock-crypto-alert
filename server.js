// Minimal Stock/Crypto SMS Alert Server
//
// This server is intentionally lightweight and does not rely on any
// third‑party npm modules. It uses Node.js built‑in modules only so
// that it can run in environments without internet access or
// npm dependencies.  It implements a small subset of the project
// described in the prompt: users can register/login, verify their
// phone numbers via a one‑time code, add tickers to a watchlist,
// create price alerts and receive SMS notifications (simulated
// via console output) when alert conditions are triggered.  A
// background job checks alerts every 30 seconds and triggers
// notifications when appropriate.

const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const url = require('url');

// Paths for our simple JSON database files
const DATA_DIR = __dirname;
const USERS_FILE = DATA_DIR + '/users.json';
const WATCHLIST_FILE = DATA_DIR + '/watchlists.json';
const ALERTS_FILE = DATA_DIR + '/alerts.json';
// New file for storing user portfolios (holdings).
const PORTFOLIO_FILE = DATA_DIR + '/portfolios.json';

// Ensure JSON files exist
function ensureFile(path, defaultValue) {
  if (!fs.existsSync(path)) {
    fs.writeFileSync(path, JSON.stringify(defaultValue, null, 2));
  }
}

ensureFile(USERS_FILE, []);
ensureFile(WATCHLIST_FILE, {});
ensureFile(ALERTS_FILE, {});
ensureFile(PORTFOLIO_FILE, {});

// Read/Write helpers
function readJSON(path) {
  return JSON.parse(fs.readFileSync(path, 'utf8'));
}

function writeJSON(path, data) {
  fs.writeFileSync(path, JSON.stringify(data, null, 2));
}

// Generate a random verification code (6 digits)
function generateVerificationCode() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Hash a password using SHA‑256
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// Simple token generator (random 32 bytes base64)
function generateToken() {
  return crypto.randomBytes(32).toString('base64');
}

// Admin credentials. In a production system these would be stored
// securely (e.g. in environment variables or a database) and never
// hard‑coded.  For this prototype we keep them here for simplicity.
const ADMIN_EMAIL = 'admin@site.com';
const ADMIN_PASSWORD_HASH = hashPassword('admin123');

// In‑memory token store.  Maps token -> userId.  In a real
// application this would be persisted (e.g. Redis) and have an
// expiration.  Here it resets when the server restarts.
const sessions = {};

// Map admin tokens to a special id. When an admin logs in we
// associate the token with this constant. It is used to grant
// access to admin‑only endpoints.
const ADMIN_SESSION_ID = '__admin__';

// -----------------------------------------------------------------------------
// Additional helper functions for portfolios and predictions
//
// This section introduces two helper functions used for the optional
// portfolio management and AI prediction endpoints.  The simulatePrice
// function uses a deterministic pseudo‑random hash seeded with the ticker and
// time to generate a price in the range [10,100).  The predictNextPrice
// function uses the same approach but advances the time bucket forward one
// interval to produce a simple "next tick" prediction.  These functions
// deliberately avoid external dependencies and network calls.  In a real
// implementation you could integrate with market data APIs and AI models.

/**
 * Generate a pseudo‑random current price for a ticker.  The price is
 * deterministic within a 30‑second window and varies between $10 and $100.
 *
 * @param {string} ticker
 * @returns {number} simulated price
 */
function simulatePrice(ticker) {
  // The time bucket is the current timestamp divided by 30 seconds.  Using
  // bitwise or (| 0) floors the value.  This ensures that calls within the
  // same 30‑second window return the same price for a given ticker.
  const bucket = (Date.now() / 30000) | 0;
  const seed = crypto.createHash('sha256').update(`${ticker}-${bucket}`).digest('hex');
  const num = parseInt(seed.substring(0, 8), 16);
  return 10 + (num % 9000) / 100;
}

/**
 * Predict the next price for a ticker by looking one interval ahead.  This
 * naive implementation simply uses the next 30‑second bucket.  It does not
 * attempt to forecast trends or volatility; it merely illustrates how an
 * endpoint might produce AI‑driven insights in the future.
 *
 * @param {string} ticker
 * @returns {number} predicted price
 */
function predictNextPrice(ticker) {
  const nextBucket = ((Date.now() / 30000) | 0) + 1;
  const seed = crypto.createHash('sha256').update(`${ticker}-${nextBucket}`).digest('hex');
  const num = parseInt(seed.substring(0, 8), 16);
  return 10 + (num % 9000) / 100;
}

// Simulated SMS sending.  In a production system, integrate with
// Twilio or another provider.  Here we simply log the message to
// the console for demonstration purposes.
function sendSMS(toPhone, message) {
  console.log(`[SMS to ${toPhone}]: ${message}`);
}

// Helper to parse JSON body from request
function parseJSONBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      // Prevent excessive body sizes (2MB limit)
      if (body.length > 2 * 1024 * 1024) {
        reject(new Error('Body too large'));
        req.connection.destroy();
      }
    });
    req.on('end', () => {
      try {
        const data = body ? JSON.parse(body) : {};
        resolve(data);
      } catch (err) {
        reject(new Error('Invalid JSON'));
      }
    });
  });
}

// Authenticate user based on Authorization header
function authenticate(req) {
  const auth = req.headers['authorization'];
  if (!auth) return null;
  const parts = auth.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;
  const token = parts[1];
  const userId = sessions[token];
  return userId || null;
}

// Determine whether the provided request carries a valid admin token.
// Returns true if the bearer token corresponds to the special admin
// session id; otherwise false.
function isAdmin(req) {
  const auth = req.headers['authorization'];
  if (!auth) return false;
  const parts = auth.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return false;
  const token = parts[1];
  return sessions[token] === ADMIN_SESSION_ID;
}

// HTTP server
const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const method = req.method;

  // CORS headers to allow requests from the front‑end (browser)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    // User registration
    if (method === 'POST' && pathname === '/register') {
      const body = await parseJSONBody(req);
      const { email, password, phone } = body;
      if (!email || !password || !phone) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'email, password and phone are required' }));
        return;
      }
      const users = readJSON(USERS_FILE);
      if (users.find(u => u.email === email)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'User already exists' }));
        return;
      }
      const userId = crypto.randomUUID();
      const verificationCode = generateVerificationCode();
      const newUser = {
        id: userId,
        email,
        passwordHash: hashPassword(password),
        phone,
        verified: false,
        verificationCode,
        // By default all newly registered users are regular users.  The
        // role property can later be elevated by an admin through a
        // dedicated API endpoint.
        role: 'user'
      };
      users.push(newUser);
      writeJSON(USERS_FILE, users);
      // Initialize watchlist and alerts
      const watchlists = readJSON(WATCHLIST_FILE);
      watchlists[userId] = [];
      writeJSON(WATCHLIST_FILE, watchlists);
      const alerts = readJSON(ALERTS_FILE);
      alerts[userId] = [];
      writeJSON(ALERTS_FILE, alerts);
      // Send verification SMS
      sendSMS(phone, `Your verification code is ${verificationCode}`);
      res.writeHead(201);
      res.end(JSON.stringify({ message: 'User registered. Verification code sent via SMS.' }));
      return;
    }
    // User phone verification
    if (method === 'POST' && pathname === '/verify') {
      const body = await parseJSONBody(req);
      const { email, code } = body;
      if (!email || !code) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'email and code are required' }));
        return;
      }
      const users = readJSON(USERS_FILE);
      const user = users.find(u => u.email === email);
      if (!user) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'User not found' }));
        return;
      }
      if (user.verified) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'User already verified' }));
        return;
      }
      if (user.verificationCode !== code) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid verification code' }));
        return;
      }
      user.verified = true;
      writeJSON(USERS_FILE, users);
      res.writeHead(200);
      res.end(JSON.stringify({ message: 'Phone number verified. You may now login.' }));
      return;
    }
    // User login
    if (method === 'POST' && pathname === '/login') {
      const body = await parseJSONBody(req);
      const { email, password } = body;
      if (!email || !password) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'email and password are required' }));
        return;
      }
      const users = readJSON(USERS_FILE);
      const user = users.find(u => u.email === email);
      if (!user || user.passwordHash !== hashPassword(password)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Invalid credentials' }));
        return;
      }
      if (!user.verified) {
        res.writeHead(403);
        res.end(JSON.stringify({ error: 'Phone not verified' }));
        return;
      }
      const token = generateToken();
      sessions[token] = user.id;
      res.writeHead(200);
      res.end(JSON.stringify({ token }));
      return;
    }

    // Admin login. Requires the preconfigured admin email and
    // password. Returns a token that grants access to admin
    // endpoints.  The admin account does not correspond to a user in
    // the users.json file.  Instead, it is handled separately.
    if (method === 'POST' && pathname === '/admin-login') {
      const body = await parseJSONBody(req);
      const { email, password } = body;
      if (email !== ADMIN_EMAIL || hashPassword(password) !== ADMIN_PASSWORD_HASH) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Invalid admin credentials' }));
        return;
      }
      const token = generateToken();
      sessions[token] = ADMIN_SESSION_ID;
      res.writeHead(200);
      res.end(JSON.stringify({ token, admin: true }));
      return;
    }
    // Get current user info
    if (method === 'GET' && pathname === '/me') {
      const userId = authenticate(req);
      if (!userId) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      const users = readJSON(USERS_FILE);
      const user = users.find(u => u.id === userId);
      if (!user) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'User not found' }));
        return;
      }
      // Return public user info (omit password & verification code)
      res.writeHead(200);
      res.end(JSON.stringify({ id: user.id, email: user.email, phone: user.phone, verified: user.verified }));
      return;
    }
    // Add ticker to watchlist
    if (method === 'POST' && pathname === '/tickers') {
      const userId = authenticate(req);
      if (!userId) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      const body = await parseJSONBody(req);
      const { ticker } = body;
      if (!ticker) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'ticker is required' }));
        return;
      }
      const watchlists = readJSON(WATCHLIST_FILE);
      if (!watchlists[userId]) watchlists[userId] = [];
      const symbol = ticker.toUpperCase();
      if (!watchlists[userId].includes(symbol)) {
        watchlists[userId].push(symbol);
        writeJSON(WATCHLIST_FILE, watchlists);
      }
      res.writeHead(201);
      res.end(JSON.stringify({ message: 'Ticker added', watchlist: watchlists[userId] }));
      return;
    }
    // Get user's watchlist
    if (method === 'GET' && pathname === '/tickers') {
      const userId = authenticate(req);
      if (!userId) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      const watchlists = readJSON(WATCHLIST_FILE);
      const list = watchlists[userId] || [];
      res.writeHead(200);
      res.end(JSON.stringify({ watchlist: list }));
      return;
    }
    // Remove ticker from watchlist
    if (method === 'DELETE' && pathname.startsWith('/tickers/')) {
      const userId = authenticate(req);
      if (!userId) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      const parts = pathname.split('/');
      const symbol = parts[2] ? parts[2].toUpperCase() : null;
      if (!symbol) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Ticker symbol required' }));
        return;
      }
      const watchlists = readJSON(WATCHLIST_FILE);
      if (!watchlists[userId]) watchlists[userId] = [];
      watchlists[userId] = watchlists[userId].filter(s => s !== symbol);
      writeJSON(WATCHLIST_FILE, watchlists);
      res.writeHead(200);
      res.end(JSON.stringify({ message: 'Ticker removed', watchlist: watchlists[userId] }));
      return;
    }
    // Create an alert
    if (method === 'POST' && pathname === '/alerts') {
      const userId = authenticate(req);
      if (!userId) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      const body = await parseJSONBody(req);
      const { ticker, condition, target } = body;
      // condition: 'above' or 'below'; target: numeric threshold
      if (!ticker || !condition || typeof target !== 'number') {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'ticker, condition (above/below) and numeric target are required' }));
        return;
      }
      const alerts = readJSON(ALERTS_FILE);
      if (!alerts[userId]) alerts[userId] = [];
      const alertId = crypto.randomUUID();
      alerts[userId].push({ id: alertId, ticker: ticker.toUpperCase(), condition, target, triggered: false });
      writeJSON(ALERTS_FILE, alerts);
      res.writeHead(201);
      res.end(JSON.stringify({ message: 'Alert created', alertId }));
      return;
    }
    // List alerts
    if (method === 'GET' && pathname === '/alerts') {
      const userId = authenticate(req);
      if (!userId) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      const alerts = readJSON(ALERTS_FILE);
      res.writeHead(200);
      res.end(JSON.stringify({ alerts: alerts[userId] || [] }));
      return;
    }

    // -------------------------------------------------------------------------
    // Portfolio management
    //
    // A portfolio is a list of holdings for each user.  Each holding consists
    // of a ticker symbol and a quantity.  These endpoints allow users to
    // view, add and remove holdings from their portfolio.  Data is persisted
    // in the portfolios.json file.  A real application would include
    // transaction history and cost basis; here we keep it simple.

    // Get the current user's portfolio
    if (method === 'GET' && pathname === '/portfolio') {
      const userId = authenticate(req);
      if (!userId) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      const portfolios = readJSON(PORTFOLIO_FILE);
      res.writeHead(200);
      res.end(JSON.stringify({ portfolio: portfolios[userId] || [] }));
      return;
    }
    // Add or update a holding in the portfolio
    if (method === 'POST' && pathname === '/portfolio') {
      const userId = authenticate(req);
      if (!userId) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      const body = await parseJSONBody(req);
      const { ticker, quantity } = body;
      if (!ticker || typeof quantity !== 'number' || !Number.isFinite(quantity)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'ticker and numeric quantity are required' }));
        return;
      }
      const symbol = ticker.toUpperCase();
      const portfolios = readJSON(PORTFOLIO_FILE);
      if (!portfolios[userId]) portfolios[userId] = [];
      const holdingIndex = portfolios[userId].findIndex(h => h.ticker === symbol);
      if (holdingIndex >= 0) {
        // Update existing quantity
        portfolios[userId][holdingIndex].quantity = quantity;
      } else {
        // Add new holding
        portfolios[userId].push({ ticker: symbol, quantity });
      }
      writeJSON(PORTFOLIO_FILE, portfolios);
      res.writeHead(201);
      res.end(JSON.stringify({ message: 'Holding saved', portfolio: portfolios[userId] }));
      return;
    }
    // Remove a holding by ticker symbol
    if (method === 'DELETE' && pathname.startsWith('/portfolio/')) {
      const userId = authenticate(req);
      if (!userId) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      const parts = pathname.split('/');
      const symbol = parts[2] ? parts[2].toUpperCase() : null;
      if (!symbol) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Ticker symbol required' }));
        return;
      }
      const portfolios = readJSON(PORTFOLIO_FILE);
      if (!portfolios[userId]) portfolios[userId] = [];
      portfolios[userId] = portfolios[userId].filter(h => h.ticker !== symbol);
      writeJSON(PORTFOLIO_FILE, portfolios);
      res.writeHead(200);
      res.end(JSON.stringify({ message: 'Holding removed', portfolio: portfolios[userId] }));
      return;
    }

    // -------------------------------------------------------------------------
    // AI prediction endpoint
    //
    // The /predict endpoint returns a naive price prediction for a given
    // ticker.  It uses the helper functions simulatePrice and
    // predictNextPrice defined above.  Only authenticated users may access
    // predictions.  In the future this could integrate with ML models.
    if (method === 'GET' && (pathname === '/predict' || pathname.startsWith('/predict/'))) {
      const userId = authenticate(req);
      if (!userId) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      // Determine ticker from query string or path
      let ticker = null;
      if (pathname === '/predict') {
        ticker = parsedUrl.query.ticker;
      } else {
        const parts = pathname.split('/');
        ticker = parts[2];
      }
      if (!ticker) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'ticker parameter is required' }));
        return;
      }
      const symbol = ticker.toUpperCase();
      const current = simulatePrice(symbol);
      const predicted = predictNextPrice(symbol);
      res.writeHead(200);
      res.end(JSON.stringify({ ticker: symbol, currentPrice: current, predictedPrice: predicted }));
      return;
    }

    // Admin endpoint: list all users. Requires an admin token.
    if (method === 'GET' && pathname === '/admin/users') {
      if (!isAdmin(req)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      const users = readJSON(USERS_FILE).map(u => ({ id: u.id, email: u.email, phone: u.phone, verified: u.verified, role: u.role }));
      res.writeHead(200);
      res.end(JSON.stringify({ users }));
      return;
    }

    // Admin endpoint: list all watchlists. Requires admin token.
    if (method === 'GET' && pathname === '/admin/watchlists') {
      if (!isAdmin(req)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      const watchlists = readJSON(WATCHLIST_FILE);
      res.writeHead(200);
      res.end(JSON.stringify({ watchlists }));
      return;
    }

    // Admin endpoint: list all alerts. Requires admin token.
    if (method === 'GET' && pathname === '/admin/alerts') {
      if (!isAdmin(req)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      const alerts = readJSON(ALERTS_FILE);
      res.writeHead(200);
      res.end(JSON.stringify({ alerts }));
      return;
    }

    // Admin endpoint: update a user's role. Expects JSON body
    // { userId: string, role: string } and requires admin token.
    if (method === 'POST' && pathname === '/admin/set-role') {
      if (!isAdmin(req)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      const body = await parseJSONBody(req);
      const { userId: targetId, role } = body;
      if (!targetId || !role) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'userId and role are required' }));
        return;
      }
      const users = readJSON(USERS_FILE);
      const user = users.find(u => u.id === targetId);
      if (!user) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'User not found' }));
        return;
      }
      user.role = role;
      writeJSON(USERS_FILE, users);
      res.writeHead(200);
      res.end(JSON.stringify({ message: 'User role updated' }));
      return;
    }

    // Admin endpoint: list all portfolios. Requires admin token.
    if (method === 'GET' && pathname === '/admin/portfolios') {
      if (!isAdmin(req)) {
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      const portfolios = readJSON(PORTFOLIO_FILE);
      res.writeHead(200);
      res.end(JSON.stringify({ portfolios }));
      return;
    }
    // Default: not found
    res.writeHead(404);
    // If GET request, attempt to serve static front‑end files
    if (method === 'GET') {
      return serveStaticFile(req, res);
    }
    res.end(JSON.stringify({ error: 'Not found' }));
  } catch (err) {
    console.error(err);
    res.writeHead(500);
    res.end(JSON.stringify({ error: err.message || 'Server error' }));
  }
});

// Background job to check alerts every 30 seconds.
// This simple implementation generates a pseudo‑random price for each
// ticker on each cycle.  A real implementation would query a market
// data API such as Alpha Vantage, Finnhub or Polygon.  When a
// condition is met (price above/below target) and the alert has not
// been triggered yet, the server sends an SMS (logged to console)
// and marks the alert as triggered.
function startAlertChecker(intervalMs = 30000) {
  setInterval(() => {
    const alerts = readJSON(ALERTS_FILE);
    const users = readJSON(USERS_FILE);
    // For each user
    for (const userId in alerts) {
      const userAlerts = alerts[userId];
      if (!Array.isArray(userAlerts)) continue;
      userAlerts.forEach(alert => {
        if (alert.triggered) return;
        const { ticker, condition, target } = alert;
        // Simulate current price with deterministic pseudo‑random function
        const seed = crypto.createHash('sha256').update(`${ticker}-${Date.now() / intervalMs | 0}`).digest('hex');
        // Convert first 8 hex digits to an integer and scale to price range 10–100
        const num = parseInt(seed.substring(0, 8), 16);
        const price = 10 + (num % 9000) / 100;
        let trigger = false;
        if (condition === 'above' && price > target) trigger = true;
        if (condition === 'below' && price < target) trigger = true;
        if (trigger) {
          // Send SMS and mark as triggered
          const user = users.find(u => u.id === userId);
          if (user) {
            sendSMS(user.phone, `Alert for ${ticker}: current price ${price.toFixed(2)} is ${condition} ${target}`);
          }
          alert.triggered = true;
          console.log(`Alert ${alert.id} triggered for user ${userId}`);
        }
      });
    }
    // Persist updated alerts
    writeJSON(ALERTS_FILE, alerts);
  }, intervalMs);
}

// Serve static files from the frontend directory (index.html and assets)
function serveStaticFile(req, res) {
  const parsedUrl = url.parse(req.url);
  let pathname = `frontend${parsedUrl.pathname}`;
  // Default to index.html
  if (pathname === 'frontend/') pathname = 'frontend/index.html';
  const ext = pathname.split('.').pop();
  const mimeTypes = {
    'html': 'text/html',
    'js': 'text/javascript',
    'css': 'text/css',
    'json': 'application/json'
  };
  fs.readFile(`${__dirname}/../${pathname}`, function(err, data) {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
    } else {
      const mime = mimeTypes[ext] || 'text/plain';
      res.writeHead(200, { 'Content-Type': mime });
      res.end(data);
    }
  });
}

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Kick off the background alert checker
startAlertChecker();