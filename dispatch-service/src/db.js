const { MongoClient, ServerApiVersion } = require("mongodb");

let client;
let db;

const initDB = async () => {
  const uri = process.env.MONGODB_URL;
  if (!uri) {
    throw new Error("MONGODB_URL environment variable not set");
  }

  client = new MongoClient(uri, {
    serverApi: ServerApiVersion.v1,
    retryWrites: true,
    w: "majority"
  });

  try {
    await client.connect();
    db = client.db("dispatch_db");
    
    // Verify connection
    await db.admin().ping();
    console.log("Connected to MongoDB");
    
  } catch (err) {
    console.error("MongoDB connection failed:", err);
    throw err;
  }
};

const getDB = () => {
  if (!db) throw new Error("Database not initialized. Call initDB first.");
  return db;
};

const getClient = () => {
  if (!client) throw new Error("Database client not initialized. Call initDB first.");
  return client;
};

module.exports = { initDB, getDB, getClient };

