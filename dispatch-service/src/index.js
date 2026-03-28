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
const corsOptions = {
  origin: [
    "https://national-emergency-platform.vercel.app",
    "http://localhost:3000",
    "http://localhost:3005",
  ],
  allowedHeaders: ["Content-Type", "Authorization"],
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
};
app.use(cors(corsOptions));
app.options("*", cors(corsOptions));
app.use(express.json());
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));
app.get("/health", (req, res) => res.json({ status: "ok", service: "dispatch" }));

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

// ── Ghana-wide vehicle seed data ─────────────────────────
// One vehicle per responder station — same coordinates so
// nearest-vehicle dispatch resolves to the correct region.
const SEED_VEHICLES = [
  // Greater Accra
  { vehicle_id:"ACC-POL-01", vehicle_name:"Accra Central Police Unit 1",  vehicle_type:"police",    latitude: 5.5560,  longitude: -0.2010 },
  { vehicle_id:"ACC-POL-02", vehicle_name:"Tema Police Unit 1",            vehicle_type:"police",    latitude: 5.6698,  longitude: -0.0166 },
  { vehicle_id:"ACC-POL-03", vehicle_name:"Madina Police Unit 1",          vehicle_type:"police",    latitude: 5.6800,  longitude: -0.1700 },
  { vehicle_id:"ACC-FIRE-01",vehicle_name:"Accra Fire Truck 1",            vehicle_type:"fire",      latitude: 5.5519,  longitude: -0.2190 },
  { vehicle_id:"ACC-FIRE-02",vehicle_name:"Tema Fire Truck 1",             vehicle_type:"fire",      latitude: 5.6700,  longitude: -0.0200 },
  { vehicle_id:"ACC-AMB-01", vehicle_name:"Accra Ambulance 1",             vehicle_type:"ambulance", latitude: 5.5481,  longitude: -0.2266 },
  { vehicle_id:"ACC-AMB-02", vehicle_name:"Tema Ambulance 1",              vehicle_type:"ambulance", latitude: 5.6698,  longitude: -0.0180 },
  // Ashanti — Kumasi
  { vehicle_id:"KUM-POL-01", vehicle_name:"Kumasi Central Police Unit 1",  vehicle_type:"police",    latitude: 6.6885,  longitude: -1.6244 },
  { vehicle_id:"KUM-POL-02", vehicle_name:"Asokwa Police Unit 1",          vehicle_type:"police",    latitude: 6.6750,  longitude: -1.6100 },
  { vehicle_id:"KUM-FIRE-01",vehicle_name:"Kumasi Fire Truck 1",           vehicle_type:"fire",      latitude: 6.6857,  longitude: -1.6239 },
  { vehicle_id:"KUM-FIRE-02",vehicle_name:"Bantama Fire Truck 1",          vehicle_type:"fire",      latitude: 6.7050,  longitude: -1.6400 },
  { vehicle_id:"KUM-AMB-01", vehicle_name:"Kumasi Ambulance 1",            vehicle_type:"ambulance", latitude: 6.6857,  longitude: -1.6239 },
  { vehicle_id:"KUM-AMB-02", vehicle_name:"Oforikrom Ambulance 1",         vehicle_type:"ambulance", latitude: 6.6600,  longitude: -1.5900 },
  // Western — Takoradi
  { vehicle_id:"TAK-POL-01", vehicle_name:"Takoradi Police Unit 1",        vehicle_type:"police",    latitude: 4.9016,  longitude: -1.7442 },
  { vehicle_id:"TAK-POL-02", vehicle_name:"Sekondi Police Unit 1",         vehicle_type:"police",    latitude: 4.9405,  longitude: -1.7068 },
  { vehicle_id:"TAK-FIRE-01",vehicle_name:"Takoradi Fire Truck 1",         vehicle_type:"fire",      latitude: 4.8950,  longitude: -1.7500 },
  { vehicle_id:"TAK-AMB-01", vehicle_name:"Takoradi Ambulance 1",          vehicle_type:"ambulance", latitude: 4.9008,  longitude: -1.7570 },
  // Central — Cape Coast
  { vehicle_id:"CC-POL-01",  vehicle_name:"Cape Coast Police Unit 1",      vehicle_type:"police",    latitude: 5.1053,  longitude: -1.2466 },
  { vehicle_id:"CC-FIRE-01", vehicle_name:"Cape Coast Fire Truck 1",       vehicle_type:"fire",      latitude: 5.1000,  longitude: -1.2500 },
  { vehicle_id:"CC-AMB-01",  vehicle_name:"Cape Coast Ambulance 1",        vehicle_type:"ambulance", latitude: 5.1033,  longitude: -1.2870 },
  // Eastern — Koforidua
  { vehicle_id:"KOF-POL-01", vehicle_name:"Koforidua Police Unit 1",       vehicle_type:"police",    latitude: 6.0940,  longitude: -0.2570 },
  { vehicle_id:"KOF-FIRE-01",vehicle_name:"Koforidua Fire Truck 1",        vehicle_type:"fire",      latitude: 6.0900,  longitude: -0.2600 },
  { vehicle_id:"KOF-AMB-01", vehicle_name:"Koforidua Ambulance 1",         vehicle_type:"ambulance", latitude: 6.0880,  longitude: -0.2626 },
  // Volta — Ho
  { vehicle_id:"HO-POL-01",  vehicle_name:"Ho Police Unit 1",              vehicle_type:"police",    latitude: 6.6012,  longitude:  0.4700 },
  { vehicle_id:"HO-FIRE-01", vehicle_name:"Ho Fire Truck 1",               vehicle_type:"fire",      latitude: 6.5980,  longitude:  0.4680 },
  { vehicle_id:"HO-AMB-01",  vehicle_name:"Ho Ambulance 1",                vehicle_type:"ambulance", latitude: 6.6008,  longitude:  0.4798 },
  // Oti — Dambai
  { vehicle_id:"OTI-POL-01", vehicle_name:"Dambai Police Unit 1",          vehicle_type:"police",    latitude: 8.0730,  longitude:  0.1780 },
  { vehicle_id:"OTI-FIRE-01",vehicle_name:"Dambai Fire Unit 1",            vehicle_type:"fire",      latitude: 8.0710,  longitude:  0.1760 },
  { vehicle_id:"OTI-AMB-01", vehicle_name:"Oti Ambulance 1",               vehicle_type:"ambulance", latitude: 8.0730,  longitude:  0.1780 },
  // Bono — Sunyani
  { vehicle_id:"SUN-POL-01", vehicle_name:"Sunyani Police Unit 1",         vehicle_type:"police",    latitude: 7.3349,  longitude: -2.3266 },
  { vehicle_id:"SUN-FIRE-01",vehicle_name:"Sunyani Fire Truck 1",          vehicle_type:"fire",      latitude: 7.3320,  longitude: -2.3280 },
  { vehicle_id:"SUN-AMB-01", vehicle_name:"Sunyani Ambulance 1",           vehicle_type:"ambulance", latitude: 7.3389,  longitude: -2.3271 },
  // Bono East — Techiman
  { vehicle_id:"TEC-POL-01", vehicle_name:"Techiman Police Unit 1",        vehicle_type:"police",    latitude: 7.5905,  longitude: -1.9380 },
  { vehicle_id:"TEC-FIRE-01",vehicle_name:"Techiman Fire Unit 1",          vehicle_type:"fire",      latitude: 7.5880,  longitude: -1.9400 },
  { vehicle_id:"TEC-AMB-01", vehicle_name:"Techiman Ambulance 1",          vehicle_type:"ambulance", latitude: 7.5905,  longitude: -1.9380 },
  // Ahafo — Goaso
  { vehicle_id:"AHA-POL-01", vehicle_name:"Goaso Police Unit 1",           vehicle_type:"police",    latitude: 6.8060,  longitude: -2.5160 },
  { vehicle_id:"AHA-FIRE-01",vehicle_name:"Goaso Fire Unit 1",             vehicle_type:"fire",      latitude: 6.8040,  longitude: -2.5180 },
  { vehicle_id:"AHA-AMB-01", vehicle_name:"Ahafo Ambulance 1",             vehicle_type:"ambulance", latitude: 6.8060,  longitude: -2.5160 },
  // Northern — Tamale
  { vehicle_id:"TAM-POL-01", vehicle_name:"Tamale Central Police Unit 1",  vehicle_type:"police",    latitude: 9.4034,  longitude: -0.8424 },
  { vehicle_id:"TAM-POL-02", vehicle_name:"Yendi Police Unit 1",           vehicle_type:"police",    latitude: 9.4426,  longitude: -0.0099 },
  { vehicle_id:"TAM-FIRE-01",vehicle_name:"Tamale Fire Truck 1",           vehicle_type:"fire",      latitude: 9.4000,  longitude: -0.8450 },
  { vehicle_id:"TAM-AMB-01", vehicle_name:"Tamale Ambulance 1",            vehicle_type:"ambulance", latitude: 9.4076,  longitude: -0.8419 },
  // Savannah — Damongo
  { vehicle_id:"SAV-POL-01", vehicle_name:"Damongo Police Unit 1",         vehicle_type:"police",    latitude: 9.0840,  longitude: -1.8220 },
  { vehicle_id:"SAV-FIRE-01",vehicle_name:"Damongo Fire Unit 1",           vehicle_type:"fire",      latitude: 9.0820,  longitude: -1.8240 },
  { vehicle_id:"SAV-AMB-01", vehicle_name:"Savannah Ambulance 1",          vehicle_type:"ambulance", latitude: 9.0840,  longitude: -1.8220 },
  // North East — Nalerigu
  { vehicle_id:"NE-POL-01",  vehicle_name:"Nalerigu Police Unit 1",        vehicle_type:"police",    latitude: 10.5200, longitude: -0.3640 },
  { vehicle_id:"NE-FIRE-01", vehicle_name:"Gambaga Fire Unit 1",           vehicle_type:"fire",      latitude: 10.5240, longitude: -0.3561 },
  { vehicle_id:"NE-AMB-01",  vehicle_name:"North East Ambulance 1",        vehicle_type:"ambulance", latitude: 10.5200, longitude: -0.3640 },
  // Upper East — Bolgatanga
  { vehicle_id:"UE-POL-01",  vehicle_name:"Bolgatanga Police Unit 1",      vehicle_type:"police",    latitude: 10.7854, longitude: -0.8514 },
  { vehicle_id:"UE-FIRE-01", vehicle_name:"Bolgatanga Fire Truck 1",       vehicle_type:"fire",      latitude: 10.7840, longitude: -0.8530 },
  { vehicle_id:"UE-AMB-01",  vehicle_name:"Bolgatanga Ambulance 1",        vehicle_type:"ambulance", latitude: 10.7869, longitude: -0.8524 },
  // Upper West — Wa
  { vehicle_id:"WA-POL-01",  vehicle_name:"Wa Police Unit 1",              vehicle_type:"police",    latitude: 10.0601, longitude: -2.5099 },
  { vehicle_id:"WA-FIRE-01", vehicle_name:"Wa Fire Truck 1",               vehicle_type:"fire",      latitude: 10.0580, longitude: -2.5120 },
  { vehicle_id:"WA-AMB-01",  vehicle_name:"Wa Ambulance 1",                vehicle_type:"ambulance", latitude: 10.0636, longitude: -2.5058 },
  // Western North — Sefwi Wiawso
  { vehicle_id:"WN-POL-01",  vehicle_name:"Sefwi Wiawso Police Unit 1",   vehicle_type:"police",    latitude: 6.2080,  longitude: -2.4860 },
  { vehicle_id:"WN-FIRE-01", vehicle_name:"Sefwi Fire Unit 1",             vehicle_type:"fire",      latitude: 6.2060,  longitude: -2.4880 },
  { vehicle_id:"WN-AMB-01",  vehicle_name:"Western North Ambulance 1",     vehicle_type:"ambulance", latitude: 6.2080,  longitude: -2.4860 },
];

async function seedVehiclesIfEmpty() {
  try {
    const db = getDB();
    const count = await db.collection("vehicle_locations").countDocuments();
    if (count === 0) {
      await db.collection("vehicle_locations").insertMany(
        SEED_VEHICLES.map(v => ({ ...v, status: "idle", updated_at: new Date() }))
      );
      console.log(`Seeded ${SEED_VEHICLES.length} vehicles across all 16 Ghana regions`);
    }
  } catch (err) {
    console.error("Vehicle seed error:", err.message);
  }
}

const PORT = process.env.PORT || 3003;

server.listen(PORT, () => console.log(`Dispatch service running on port ${PORT}`));
Promise.all([initDB(), connect()]).then(async () => {
  await subscribeToEvent(EVENTS.INCIDENT_ASSIGNED, handleIncidentAssigned, 'incidents');
  await seedVehiclesIfEmpty();
}).catch(err => console.error("Failed to initialize:", err));
