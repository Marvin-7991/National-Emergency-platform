require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const swaggerUi = require("swagger-ui-express");
const swaggerDocument = require("./swagger");

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
app.get("/health", (req, res) => res.json({ status: "ok", service: "analytics" }));

const JWT_SECRET = process.env.JWT_SECRET;
const INCIDENT_URL = process.env.INCIDENT_SERVICE_URL || "http://incident-service:3002";
const DISPATCH_URL  = process.env.DISPATCH_SERVICE_URL  || "http://dispatch-service:3003";

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

// ── Shared data-fetching functions ────────────────────────
async function fetchResponseTimes(authHeader) {
  const summary = await axios.get(
    `${INCIDENT_URL}/incidents/stats/summary`,
    { headers: { Authorization: authHeader } }
  );
  // MongoDB $group returns _id, not status
  const resolved = summary.data.by_status?.find(s => s._id === "resolved");
  return {
    average_response_minutes: summary.data.avg_response_minutes,
    total_resolved: resolved?.count || 0
  };
}

async function fetchIncidentsByRegion(authHeader) {
  const all = await axios.get(
    `${INCIDENT_URL}/incidents/all`,
    { headers: { Authorization: authHeader } }
  );
  const incidents = all.data;

  const byType = incidents.reduce((acc, inc) => {
    acc[inc.incident_type] = (acc[inc.incident_type] || 0) + 1;
    return acc;
  }, {});

  const byStatus = incidents.reduce((acc, inc) => {
    acc[inc.status] = (acc[inc.status] || 0) + 1;
    return acc;
  }, {});

  return { by_type: byType, by_status: byStatus, total: incidents.length };
}

async function fetchResourceUtilization(authHeader) {
  const [incidentRes, vehicleRes] = await Promise.all([
    axios.get(`${INCIDENT_URL}/responders`,
      { headers: { Authorization: authHeader } }),
    axios.get(`${DISPATCH_URL}/vehicles`,
      { headers: { Authorization: authHeader } })
  ]);

  const responders = incidentRes.data;
  const vehicles   = vehicleRes.data;

  const totalResponders = responders.length;
  const available = responders.filter(r => r.is_available).length;
  const deployed  = totalResponders - available;

  const byType = responders.reduce((acc, r) => {
    if (!acc[r.type]) acc[r.type] = { total: 0, available: 0 };
    acc[r.type].total++;
    if (r.is_available) acc[r.type].available++;
    return acc;
  }, {});

  return {
    total_responders: totalResponders,
    available,
    deployed,
    utilization_pct: totalResponders
      ? ((deployed / totalResponders) * 100).toFixed(1)
      : "0",
    by_type: byType,
    active_vehicles: vehicles.filter(v => v.status !== "idle").length,
    total_vehicles: vehicles.length
  };
}

// ── GET /analytics/response-times ────────────────────────
app.get("/analytics/response-times", authenticate, async (req, res) => {
  try {
    res.json(await fetchResponseTimes(req.headers.authorization));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /analytics/incidents-by-region ───────────────────
app.get("/analytics/incidents-by-region", authenticate, async (req, res) => {
  try {
    res.json(await fetchIncidentsByRegion(req.headers.authorization));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /analytics/resource-utilization ──────────────────
app.get("/analytics/resource-utilization", authenticate, async (req, res) => {
  try {
    res.json(await fetchResourceUtilization(req.headers.authorization));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /analytics/dashboard (combined summary) ──────────
app.get("/analytics/dashboard", authenticate, async (req, res) => {
  try {
    const [responseTimes, incidents, resources] = await Promise.all([
      fetchResponseTimes(req.headers.authorization),
      fetchIncidentsByRegion(req.headers.authorization),
      fetchResourceUtilization(req.headers.authorization)
    ]);
    res.json({ response_times: responseTimes, incidents, resources });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3004;
app.listen(PORT, () =>
  console.log(`Analytics service running on port ${PORT}`)
);
