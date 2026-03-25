require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });
const express = require("express");
const cors = require("cors");
const http = require("http");
const WebSocket = require("ws");
const jwt = require("jsonwebtoken");
const { ObjectId } = require("mongodb");
const swaggerUi = require("swagger-ui-express");
const swaggerDocument = require("./swagger");
const { initDB, getDB } = require("./db");
const { connect, subscribeToEvent, EVENTS } = require("./eventBus");

const app = express();
app.use(cors());
app.use(express.json());
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const JWT_SECRET = process.env.JWT_SECRET;

// ── Connected WebSocket clients ───────────────────────────
const clients = new Set();

wss.on("connection", (ws) => {
  clients.add(ws);
  ws.on("close", () => clients.delete(ws));
});

const broadcast = (data) => {
  const msg = JSON.stringify(data);
  clients.forEach((c) => {
    if (c.readyState === WebSocket.OPEN) c.send(msg);
  });
};

// ── Auth middleware ───────────────────────────────────────
const authenticate = (req, res, next) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: "No token" });
  try {
    req.user = jwt.verify(auth.split(" ")[1], JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
};

// ── Handle incident assignment via event bus ──────────────
async function handleIncidentAssigned(data) {
  try {
    const db = getDB();
    const { incident_id, responder_id } = data;

    if (responder_id) {
      await db.collection("vehicle_locations").updateOne(
        { vehicle_id: responder_id },
        {
          $set: {
            incident_id: incident_id,
            status: "dispatched",
            updated_at: new Date()
          }
        },
        { upsert: true }
      );

      broadcast({ type: "vehicle_dispatched", vehicle_id: responder_id, incident_id });
    }
  } catch (error) {
    console.error("Error handling incident assigned event:", error.message);
  }
}

// ── POST /vehicles/register ───────────────────────────────
app.post("/vehicles/register", authenticate, async (req, res) => {
  const { vehicle_id, vehicle_name, vehicle_type, latitude, longitude } = req.body;
  if (!vehicle_id || !vehicle_name || !vehicle_type)
    return res.status(400).json({ error: "vehicle_id, vehicle_name, vehicle_type required" });

  try {
    const db = getDB();
    await db.collection("vehicle_locations").updateOne(
      { vehicle_id },
      {
        $set: {
          vehicle_id,
          vehicle_name,
          vehicle_type,
          latitude: parseFloat(latitude) || 0,
          longitude: parseFloat(longitude) || 0,
          status: "idle",
          updated_at: new Date()
        }
      },
      { upsert: true }
    );

    const vehicle = await db.collection("vehicle_locations").findOne({ vehicle_id });
    res.status(201).json(vehicle);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /vehicles/assign (called by incident service) ────
app.post("/vehicles/assign", async (req, res) => {
  const { vehicle_id, incident_id } = req.body;
  if (!vehicle_id || !incident_id)
    return res.status(400).json({ error: "vehicle_id and incident_id required" });

  try {
    const db = getDB();
    await db.collection("vehicle_locations").updateOne(
      { vehicle_id },
      {
        $set: {
          incident_id,
          status: "dispatched",
          updated_at: new Date()
        }
      },
      { upsert: true }
    );

    broadcast({ type: "vehicle_dispatched", vehicle_id, incident_id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /vehicles/:id/location (GPS update) ───────────────
app.put("/vehicles/:id/location", authenticate, async (req, res) => {
  const { latitude, longitude, status } = req.body;
  if (latitude === undefined || longitude === undefined)
    return res.status(400).json({ error: "latitude and longitude required" });

  try {
    const db = getDB();
    const updates = {
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      updated_at: new Date()
    };

    if (status) updates.status = status;

    // MongoDB driver v5: findOneAndUpdate returns the document directly (not result.value)
    const vehicle = await db.collection("vehicle_locations").findOneAndUpdate(
      { vehicle_id: req.params.id },
      { $set: updates },
      { returnDocument: "after" }
    );

    if (!vehicle)
      return res.status(404).json({ error: "Vehicle not found" });

    // Save to history
    await db.collection("location_history").insertOne({
      vehicle_id: req.params.id,
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      recorded_at: new Date()
    });

    // Broadcast to all connected dashboards
    broadcast({ type: "location_update", vehicle });

    res.json(vehicle);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /vehicles ─────────────────────────────────────────
app.get("/vehicles", authenticate, async (req, res) => {
  try {
    const db = getDB();
    const vehicles = await db.collection("vehicle_locations")
      .find()
      .sort({ updated_at: -1 })
      .toArray();
    res.json(vehicles);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /vehicles/:id/location ────────────────────────────
app.get("/vehicles/:id/location", authenticate, async (req, res) => {
  try {
    const db = getDB();
    const vehicle = await db.collection("vehicle_locations")
      .findOne({ vehicle_id: req.params.id });

    if (!vehicle) return res.status(404).json({ error: "Not found" });
    res.json(vehicle);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /vehicles/:id/history ─────────────────────────────
app.get("/vehicles/:id/history", authenticate, async (req, res) => {
  try {
    const db = getDB();
    const history = await db.collection("location_history")
      .find({ vehicle_id: req.params.id })
      .sort({ recorded_at: -1 })
      .limit(50)
      .toArray();
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3003;

Promise.all([
  initDB(),
  connect()
]).then(async () => {
  await subscribeToEvent(EVENTS.INCIDENT_ASSIGNED, handleIncidentAssigned, 'incidents');
  server.listen(PORT, () => console.log(`Dispatch service running on port ${PORT}`));
}).catch(err => {
  console.error("Failed to initialize:", err);
  process.exit(1);
});
