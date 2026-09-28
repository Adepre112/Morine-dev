/**
 * MongoDB connection module — the SINGLE connection mechanism for Morine.
 *
 * server.js calls connectDB() once at startup. Nothing else in the codebase
 * calls mongoose.connect(), so there is exactly one pool and one set of
 * connection event handlers.
 *
 * Design goals
 *  - Fail fast and loudly if the FIRST connection cannot be made. A server
 *    that cannot reach its database must not start accepting traffic.
 *  - Survive everything that happens AFTER a successful connection. Atlas
 *    clusters pause, wifi drops, and deploy platforms recycle instances. None
 *    of those should require a restart.
 *  - Never destroy an idle-but-healthy connection. The previous
 *    `socketTimeoutMS: 15000` closed every socket that sat idle for 15s, and
 *    because the reconnect handlers lived in this file but were never wired up,
 *    the server had no way back: one idle period was enough to break it until
 *    the process was restarted. Dead-connection detection is left to the
 *    driver's own monitoring (heartbeat), which is what actually works.
 *  - Bound how long a request waits for a reconnect instead of hanging.
 */

const mongoose = require("mongoose");

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error("[MongoDB] MONGODB_URI is not set in environment variables.");
  process.exit(1);
}

/**
 * Driver / Mongoose options.
 *
 * socketTimeoutMS: 0 disables the TCP read timeout entirely. It is NOT the
 * same as the serverSelectionTimeoutMS below: server selection is "how long to
 * look for a suitable server in a healthy topology", which should stay bounded,
 * whereas the socket timeout fires on a perfectly healthy connection that has
 * simply had no traffic. The driver's heartbeat detects genuinely dead
 * sockets, and the handlers below recover from them.
 */
const OPTIONS = {
  // Bounded so a bad URI / paused cluster fails at startup instead of hanging.
  serverSelectionTimeoutMS: 10000,
  connectTimeoutMS: 10000,
  // Do not kill healthy idle connections.
  socketTimeoutMS: 0,
  // A modest pool: Morine is a single small service, and an oversized pool on a
  // free/shared Atlas tier is the usual cause of connection-limit errors.
  maxPoolSize: 10,
  // How long a query may sit in the buffer waiting for a reconnect. Bounded so
  // a request fails with a clear error instead of appearing to hang.
  bufferTimeoutMS: 8000,
  // Let the driver use its default server monitoring so a dead connection is
  // detected via heartbeat rather than by idling it out.
  serverMonitoringMode: "auto",
};

let isConnected = false;
let handlersRegistered = false;
let retryTimer = null;
let shuttingDown = false;

function registerConnectionHandlers() {
  if (handlersRegistered) return;
  handlersRegistered = true;

  mongoose.connection.on("error", (err) => {
    // A connection-level error is recoverable: the driver keeps the pool and
    // reconnects on its own. Log it and let the handlers below do their job
    // rather than exiting, which would turn a blip into an outage.
    console.error("[MongoDB] Connection error:", err.message);
    isConnected = false;
  });

  mongoose.connection.on("disconnected", () => {
    if (shuttingDown) return;
    isConnected = false;
    console.warn("[MongoDB] Disconnected. The driver will reconnect automatically.");
    scheduleReconnectCheck();
  });

  /* These two events can fire before `connection.db` is populated -- the
     'connected' event is emitted as part of establishing the connection, and on
     a driver reconnect the client can be re-established before the Db handle is
     reattached. Dereferencing `.databaseName` unconditionally therefore threw
     "Cannot read properties of undefined" inside the listener, and a throw in
     an event listener is an uncaught exception that takes the whole process
     down. Optional chaining keeps the log line useful without letting the
     logging itself become a crash. This hides nothing: connection failures are
     reported by the 'error' and 'disconnected' handlers and by connectDB(). */
  mongoose.connection.on("connected", () => {
    isConnected = true;
    console.log("[MongoDB] Connected. Database:", mongoose.connection.db?.databaseName ?? "unknown");
  });

  mongoose.connection.on("reconnected", () => {
    isConnected = true;
    console.log("[MongoDB] Reconnected. Database:", mongoose.connection.db?.databaseName ?? "unknown");
  });
}

/**
 * Deliberately conservative backstop. The driver reconnects on its own; this
 * only runs if the connection is still down a while later, and it nudges
 * mongoose to re-run server selection instead of just waiting.
 */
function scheduleReconnectCheck() {
  if (retryTimer || shuttingDown) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (shuttingDown) return;
    if (mongoose.connection.readyState === 1) {
      isConnected = true;
      return;
    }
    console.warn("[MongoDB] Still disconnected; nudging the driver to reselect a server...");
    // Ask the driver to re-check the topology. Errors are handled by the
    // "error" listener above.
    mongoose.connection.asPromise?.().catch?.(() => {});
  }, 5000);
  if (retryTimer.unref) retryTimer.unref();
}

/**
 * Connects once. Resolves when MongoDB is ready; exits the process if the
 * initial connection cannot be established, so the server never starts
 * listening against an unreachable database.
 */
async function connectDB() {
  if (isConnected && mongoose.connection.readyState === 1) {
    console.log("[MongoDB] Already connected.");
    return mongoose.connection;
  }

  registerConnectionHandlers();

  console.log("[MongoDB] Connecting to MongoDB Atlas...");
  try {
    await mongoose.connect(MONGODB_URI, OPTIONS);
    isConnected = true;
    console.log("[MongoDB] Connected successfully. Database:", mongoose.connection.db.databaseName);
    return mongoose.connection;
  } catch (error) {
    console.error("[MongoDB] Initial connection FAILED:", error.message);
    console.error("[MongoDB] Check that MONGODB_URI is correct, the cluster is not paused,");
    console.error("[MongoDB] your IP access list allows this host, and outbound 27017 is open.");
    process.exit(1);
  }
}

function isDbConnected() {
  return mongoose.connection.readyState === 1;
}

/** Graceful shutdown: stop the driver and let the process exit cleanly. */
async function disconnectDB() {
  shuttingDown = true;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  try {
    await mongoose.connection.close();
    console.log("[MongoDB] Connection closed cleanly.");
  } catch (err) {
    console.error("[MongoDB] Error while closing the connection:", err.message);
  }
}

module.exports = connectDB;
module.exports.connectDB = connectDB;
module.exports.disconnectDB = disconnectDB;
module.exports.isDbConnected = isDbConnected;
module.exports.OPTIONS = OPTIONS;
