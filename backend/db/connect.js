const mongoose = require("mongoose");

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error("[MongoDB] MONGODB_URI is not set in environment variables.");
  process.exit(1);
}

async function connectDB() {
  try {
    await mongoose.connect(MONGODB_URI, { serverSelectionTimeoutMS: 8000, socketTimeoutMS: 10000 });
    console.log("[MongoDB] Connected to MongoDB Atlas successfully.");
    console.log(`[MongoDB] Database: ${mongoose.connection.db.databaseName}`);
  } catch (error) {
    console.error("[MongoDB] Connection failed:", error.message);
    console.error("[MongoDB] Hint: Check MONGODB_URI, ensure cluster is not paused, IP whitelist includes your deployment IP, and network allows port 27017.");
    process.exit(1);
  }

  mongoose.connection.on("error", (err) => {
    console.error("[MongoDB] Runtime error:", err.message);
  });

  mongoose.connection.on("disconnected", () => {
    console.warn("[MongoDB] Disconnected from MongoDB Atlas.");
  });
}

module.exports = connectDB;
