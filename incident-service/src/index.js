require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });
const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const axios = require("axios");
const { ObjectId } = require("mongodb");
const swaggerUi = require("swagger-ui-express");
const swaggerDocument = require("./swagger");
const { initDB, getDB } = require("./db");
const { connect, publishEvent, EVENTS } = require("./eventBus");

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
app.get("/health", (req, res) => res.json({ status: "ok", service: "incident" }));

const JWT_SECRET = process.env.JWT_SECRET;
const DISPATCH_URL = process.env.DISPATCH_SERVICE_URL || "http://dispatch-service:3003";

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

// ── Haversine distance formula (returns km) ───────────────
const getDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
    Math.cos((lat2 * Math.PI) / 180) *
    Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

// ── Map incident type → responder type ───────────────────
const incidentTypeToResponder = (type) => {
  const t = type.toLowerCase();
  if (t.includes("fire") || t.includes("explosion")) return "fire";
  if (t.includes("medical") || t.includes("accident") ||
      t.includes("injury") || t.includes("heart")) return "ambulance";
  return "police";
};

// ── Find nearest available responder ─────────────────────
const findNearestResponder = async (incidentLat, incidentLon, responderType) => {
  const db = getDB();
  const responders = await db.collection("responders")
    .find({ type: responderType, is_available: true })
    .toArray();

  if (responders.length === 0) return null;

  return responders.reduce((nearest, r) => {
    const dist = getDistance(incidentLat, incidentLon, r.latitude, r.longitude);
    return !nearest || dist < nearest.dist ? { ...r, dist } : nearest;
  }, null);
};

// ── Find nearest hospital with available beds ─────────────
const findNearestHospital = async (incidentLat, incidentLon) => {
  const db = getDB();
  const hospitals = await db.collection("hospitals")
    .find({ available_beds: { $gt: 0 } })
    .toArray();

  if (hospitals.length === 0) return null;

  return hospitals.reduce((nearest, h) => {
    const dist = getDistance(incidentLat, incidentLon, h.latitude, h.longitude);
    return !nearest || dist < nearest.dist ? { ...h, dist } : nearest;
  }, null);
};

// ── POST /incidents ───────────────────────────────────────
app.post("/incidents", authenticate, async (req, res) => {
  const { citizen_name, incident_type, latitude, longitude, notes } = req.body;
  if (!citizen_name || !incident_type || !latitude || !longitude)
    return res.status(400).json({ error: "Required fields missing" });

  try {
    const db = getDB();
    const incident = {
      citizen_name,
      incident_type,
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      notes: notes || "",
      created_by: new ObjectId(req.user.id),
      status: "created",
      created_at: new Date(),
      updated_at: new Date()
    };

    const result = await db.collection("incidents").insertOne(incident);
    incident._id = result.insertedId;

    // Auto-assign nearest responder
    const responderType = incidentTypeToResponder(incident_type);
    const nearest = await findNearestResponder(latitude, longitude, responderType);

    // Auto-assign nearest hospital for all incident types and decrease available capacity
    const hospital = await findNearestHospital(latitude, longitude);
    if (hospital) {
      await db.collection("hospitals").updateOne(
        { _id: hospital._id },
        { $inc: { available_beds: -1 } }
      );
      await db.collection("incidents").updateOne(
        { _id: incident._id },
        { $set: { hospital_id: hospital._id } }
      );
      incident.hospital_id = hospital._id;
      incident.hospital = hospital;
    }

    if (nearest) {
      await db.collection("incidents").updateOne(
        { _id: incident._id },
        { $set: { assigned_unit: nearest._id, status: "dispatched", updated_at: new Date() } }
      );
      await db.collection("responders").updateOne(
        { _id: nearest._id },
        { $set: { is_available: false } }
      );
      incident.assigned_unit = nearest._id;
      incident.status = "dispatched";
      incident.responder = nearest;

      // Link nearest dispatch vehicle so frontend tracking map can route it
      try {
        const vehiclesRes = await axios.get(`${DISPATCH_URL}/vehicles`, {
          headers: { Authorization: req.headers.authorization }
        });
        const vehicles = vehiclesRes.data;
        const typeMap = { police: "police", fire: "fire", ambulance: "ambulance" };
        // Prefer idle vehicles of the correct type; fall back to any if none idle.
        // Use home_latitude/home_longitude for distance so the vehicle whose base
        // is nearest to the incident is dispatched (the name-based location feature).
        const allMatchingType = vehicles.filter(v => v.vehicle_type === typeMap[responderType]);
        const idleMatching    = allMatchingType.filter(v => v.status === "idle");
        const matching        = idleMatching.length > 0 ? idleMatching : allMatchingType;
        if (matching.length > 0) {
          const nearestVehicle = matching.reduce((best, v) => {
            // Use home position when available so nearest-base logic is consistent
            const vLat = parseFloat(v.home_latitude  || v.latitude)  || 0;
            const vLng = parseFloat(v.home_longitude || v.longitude) || 0;
            const d = getDistance(parseFloat(latitude), parseFloat(longitude), vLat, vLng);
            const bLat = best ? parseFloat(best.home_latitude  || best.latitude)  || 0 : 0;
            const bLng = best ? parseFloat(best.home_longitude || best.longitude) || 0 : 0;
            const bd = best
              ? getDistance(parseFloat(latitude), parseFloat(longitude), bLat, bLng)
              : Infinity;
            return d < bd ? v : best;
          }, null);
          if (nearestVehicle) {
            await axios.post(`${DISPATCH_URL}/vehicles/assign`, {
              vehicle_id: nearestVehicle.vehicle_id,
              incident_id: incident._id.toString()
            });
            // Persist vehicle ID so the resolve handler can reset it to idle
            await db.collection("incidents").updateOne(
              { _id: incident._id },
              { $set: { assigned_vehicle_id: nearestVehicle.vehicle_id } }
            );
            incident.assigned_vehicle_id   = nearestVehicle.vehicle_id;
            incident.assigned_vehicle_name = nearestVehicle.vehicle_name;
            incident.assigned_vehicle_lat  = nearestVehicle.latitude;
            incident.assigned_vehicle_lng  = nearestVehicle.longitude;
          }
        }
      } catch (vehicleErr) {
        console.warn("⚠ Could not link dispatch vehicle:", vehicleErr.message);
      }
    }

    // Publish event to message queue
    await publishEvent(EVENTS.INCIDENT_CREATED, {
      incident_id: incident._id.toString(),
      citizen_name,
      incident_type,
      latitude,
      longitude,
      assigned_unit: incident.assigned_unit?.toString() || null,
      hospital_id: incident.hospital_id?.toString() || null
    }, 'incidents');

    res.status(201).json(incident);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /incidents/open ───────────────────────────────────
app.get("/incidents/open", authenticate, async (req, res) => {
  try {
    const db = getDB();
    const incidents = await db.collection("incidents")
      .aggregate([
        { $match: { status: { $ne: "resolved" } } },
        {
          $lookup: {
            from: "responders",
            localField: "assigned_unit",
            foreignField: "_id",
            as: "responder"
          }
        },
        {
          $lookup: {
            from: "hospitals",
            localField: "hospital_id",
            foreignField: "_id",
            as: "hospital"
          }
        },
        { $sort: { created_at: -1 } }
      ])
      .toArray();

    res.json(incidents);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /incidents/all ────────────────────────────────────
app.get("/incidents/all", authenticate, async (req, res) => {
  try {
    const db = getDB();
    const incidents = await db.collection("incidents")
      .aggregate([
        {
          $lookup: {
            from: "responders",
            localField: "assigned_unit",
            foreignField: "_id",
            as: "responder"
          }
        },
        {
          $lookup: {
            from: "hospitals",
            localField: "hospital_id",
            foreignField: "_id",
            as: "hospital"
          }
        },
        { $sort: { created_at: -1 } }
      ])
      .toArray();

    res.json(incidents);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /incidents/stats/summary (for analytics) ─────────
// NOTE: This route must be declared BEFORE /incidents/:id
app.get("/incidents/stats/summary", async (req, res) => {
  try {
    const db = getDB();
    const total = await db.collection("incidents").countDocuments();

    const byStatus = await db.collection("incidents")
      .aggregate([
        { $group: { _id: "$status", count: { $sum: 1 } } }
      ])
      .toArray();

    const byType = await db.collection("incidents")
      .aggregate([
        { $group: { _id: "$incident_type", count: { $sum: 1 } } }
      ])
      .toArray();

    const avgResponse = await db.collection("incidents")
      .aggregate([
        { $match: { status: "resolved" } },
        {
          $group: {
            _id: null,
            avg_minutes: {
              $avg: {
                $divide: [
                  { $subtract: ["$updated_at", "$created_at"] },
                  60000
                ]
              }
            }
          }
        }
      ])
      .toArray();

    res.json({
      total,
      by_status: byStatus,
      by_type: byType,
      avg_response_minutes: avgResponse[0]?.avg_minutes?.toFixed(1) || "0"
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /incidents/:id ────────────────────────────────────
app.get("/incidents/:id", authenticate, async (req, res) => {
  try {
    const db = getDB();
    const incident = await db.collection("incidents")
      .aggregate([
        { $match: { _id: new ObjectId(req.params.id) } },
        {
          $lookup: {
            from: "responders",
            localField: "assigned_unit",
            foreignField: "_id",
            as: "responder"
          }
        },
        {
          $lookup: {
            from: "hospitals",
            localField: "hospital_id",
            foreignField: "_id",
            as: "hospital"
          }
        }
      ])
      .toArray();

    if (!incident[0]) return res.status(404).json({ error: "Not found" });
    res.json(incident[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /incidents/:id/status ─────────────────────────────
app.put("/incidents/:id/status", authenticate, async (req, res) => {
  const { status } = req.body;
  const validStatuses = ["created", "dispatched", "in_progress", "on_scene", "resolved"];
  if (!validStatuses.includes(status))
    return res.status(400).json({ error: "Invalid status" });

  try {
    const db = getDB();
    const incident = await db.collection("incidents").findOne({ _id: new ObjectId(req.params.id) });
    if (!incident) return res.status(404).json({ error: "Not found" });

    await db.collection("incidents").updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { status, updated_at: new Date() } }
    );

    // Free up responder, hospital bed, and vehicle when resolved
    if (status === "resolved") {
      if (incident.assigned_unit) {
        await db.collection("responders").updateOne(
          { _id: incident.assigned_unit },
          { $set: { is_available: true } }
        );
      }
      if (incident.hospital_id) {
        await db.collection("hospitals").updateOne(
          { _id: incident.hospital_id },
          { $inc: { available_beds: 1 } }
        );
      }
      // Reset dispatched vehicle back to idle so it can be reassigned
      if (incident.assigned_vehicle_id) {
        try {
          await axios.patch(
            `${DISPATCH_URL}/vehicles/${incident.assigned_vehicle_id}/status`,
            { status: "idle" }
          );
        } catch (e) {
          console.warn("Could not reset vehicle status:", e.message);
        }
      }
    }

    const updated = await db.collection("incidents").findOne({ _id: new ObjectId(req.params.id) });

    await publishEvent(EVENTS.INCIDENT_UPDATED, {
      incident_id: updated._id.toString(),
      status: updated.status,
      assigned_unit: updated.assigned_unit?.toString() || null
    }, 'incidents');

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /incidents/:id/assign ─────────────────────────────
app.put("/incidents/:id/assign", authenticate, async (req, res) => {
  const { responder_id } = req.body;
  if (!responder_id)
    return res.status(400).json({ error: "responder_id required" });

  try {
    const db = getDB();
    const responder = await db.collection("responders").findOne({ _id: new ObjectId(responder_id) });
    if (!responder) return res.status(404).json({ error: "Responder not found" });

    await db.collection("incidents").updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { assigned_unit: new ObjectId(responder_id), status: "dispatched", updated_at: new Date() } }
    );
    await db.collection("responders").updateOne(
      { _id: new ObjectId(responder_id) },
      { $set: { is_available: false } }
    );

    const incident = await db.collection("incidents").findOne({ _id: new ObjectId(req.params.id) });
    if (!incident) return res.status(404).json({ error: "Incident not found" });

    // Auto-assign nearest hospital and decrease its capacity by 1
    if (!incident.hospital_id) {
      const hospital = await findNearestHospital(incident.latitude, incident.longitude);
      if (hospital) {
        await db.collection("hospitals").updateOne(
          { _id: hospital._id },
          { $inc: { available_beds: -1 } }
        );
        await db.collection("incidents").updateOne(
          { _id: incident._id },
          { $set: { hospital_id: hospital._id } }
        );
      }
    }

    await publishEvent(EVENTS.INCIDENT_ASSIGNED, {
      incident_id: incident._id.toString(),
      responder_id,
      responder_name: responder.name
    }, 'incidents');

    res.json(incident);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /incidents/:id/hospital ──────────────────────────
app.put("/incidents/:id/hospital", authenticate, async (req, res) => {
  const { hospital_id } = req.body;
  if (!hospital_id)
    return res.status(400).json({ error: "hospital_id required" });

  try {
    const db = getDB();
    const incident = await db.collection("incidents").findOne({ _id: new ObjectId(req.params.id) });
    if (!incident) return res.status(404).json({ error: "Incident not found" });

    const hospital = await db.collection("hospitals").findOne({ _id: new ObjectId(hospital_id) });
    if (!hospital) return res.status(404).json({ error: "Hospital not found" });
    if (hospital.available_beds <= 0)
      return res.status(400).json({ error: "Hospital has no available capacity" });

    // If already assigned to a different hospital, restore its bed
    if (incident.hospital_id && incident.hospital_id.toString() !== hospital_id) {
      await db.collection("hospitals").updateOne(
        { _id: incident.hospital_id },
        { $inc: { available_beds: 1 } }
      );
    }

    // Assign hospital and decrement capacity only if not already assigned to this hospital
    if (!incident.hospital_id || incident.hospital_id.toString() !== hospital_id) {
      await db.collection("hospitals").updateOne(
        { _id: new ObjectId(hospital_id) },
        { $inc: { available_beds: -1 } }
      );
    }

    await db.collection("incidents").updateOne(
      { _id: new ObjectId(req.params.id) },
      { $set: { hospital_id: new ObjectId(hospital_id), updated_at: new Date() } }
    );

    const updated = await db.collection("incidents").findOne({ _id: new ObjectId(req.params.id) });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /incidents/:id ─────────────────────────────────
app.delete("/incidents/:id", authenticate, async (req, res) => {
  try {
    const db = getDB();
    const incident = await db.collection("incidents").findOne({ _id: new ObjectId(req.params.id) });
    if (!incident) return res.status(404).json({ error: "Incident not found" });

    // Free up responder if assigned
    if (incident.assigned_unit) {
      await db.collection("responders").updateOne(
        { _id: incident.assigned_unit },
        { $set: { is_available: true } }
      );
    }

    // Free up hospital bed if assigned
    if (incident.hospital_id) {
      await db.collection("hospitals").updateOne(
        { _id: incident.hospital_id },
        { $inc: { available_beds: 1 } }
      );
    }

    // Delete the incident
    const result = await db.collection("incidents").deleteOne({ _id: new ObjectId(req.params.id) });
    
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Failed to delete incident" });
    }

    // Publish event
    await publishEvent(EVENTS.INCIDENT_DELETED, {
      incident_id: req.params.id,
      incident_type: incident.incident_type
    }, 'incidents');

    res.json({ message: "Incident deleted successfully", incident_id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /responders ───────────────────────────────────────
app.get("/responders", authenticate, async (req, res) => {
  try {
    const db = getDB();
    const responders = await db.collection("responders")
      .find()
      .sort({ type: 1 })
      .toArray();
    res.json(responders);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /responders ──────────────────────────────────────
app.post("/responders", authenticate, async (req, res) => {
  const { name, type, latitude, longitude } = req.body;
  const validTypes = ["police", "fire", "ambulance"];
  if (!name || !type || !latitude || !longitude)
    return res.status(400).json({ error: "Missing required fields" });
  if (!validTypes.includes(type))
    return res.status(400).json({ error: "type must be police, fire, or ambulance" });

  try {
    const db = getDB();
    const result = await db.collection("responders").insertOne({
      name,
      type,
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      is_available: true,
      created_at: new Date()
    });
    const responder = await db.collection("responders").findOne({ _id: result.insertedId });
    res.status(201).json(responder);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /hospitals ────────────────────────────────────────
app.get("/hospitals", authenticate, async (req, res) => {
  try {
    const db = getDB();
    const hospitals = await db.collection("hospitals")
      .find()
      .sort({ name: 1 })
      .toArray();
    res.json(hospitals);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /hospitals ───────────────────────────────────────
app.post("/hospitals", authenticate, async (req, res) => {
  const { name, latitude, longitude, capacity, available_beds } = req.body;
  if (!name || !latitude || !longitude)
    return res.status(400).json({ error: "Missing required fields" });

  try {
    const db = getDB();
    const cap = parseInt(capacity) || 0;
    const result = await db.collection("hospitals").insertOne({
      name,
      latitude: parseFloat(latitude),
      longitude: parseFloat(longitude),
      capacity: cap,
      available_beds: parseInt(available_beds) ?? cap,
      created_at: new Date()
    });
    const hospital = await db.collection("hospitals").findOne({ _id: result.insertedId });
    res.status(201).json(hospital);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /hospitals/:id ────────────────────────────────────
app.put("/hospitals/:id", authenticate, async (req, res) => {
  const { name, latitude, longitude, capacity, available_beds } = req.body;
  const updates = {};

  if (name) updates.name = name;
  if (latitude) updates.latitude = parseFloat(latitude);
  if (longitude) updates.longitude = parseFloat(longitude);
  // capacity and available_beds are managed automatically — not editable via this endpoint

  if (Object.keys(updates).length === 0)
    return res.status(400).json({ error: "No fields to update" });

  try {
    const db = getDB();
    const result = await db.collection("hospitals").findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: updates },
      { returnDocument: "after" }
    );
    if (!result) return res.status(404).json({ error: "Not found" });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Ghana-wide seed data ──────────────────────────────────
const SEED_RESPONDERS = [
  // Greater Accra
  { name: "POL-1",  type: "police",    latitude: 5.5560,  longitude: -0.2010 },
  { name: "POL-2",  type: "police",    latitude: 5.6698,  longitude: -0.0166 },
  { name: "POL-3",  type: "police",    latitude: 5.6800,  longitude: -0.1700 },
  { name: "FIRE-1", type: "fire",      latitude: 5.5519,  longitude: -0.2190 },
  { name: "FIRE-2", type: "fire",      latitude: 5.6700,  longitude: -0.0200 },
  { name: "AMB-1",  type: "ambulance", latitude: 5.5481,  longitude: -0.2266 },
  { name: "AMB-2",  type: "ambulance", latitude: 5.6698,  longitude: -0.0180 },
  // Ashanti — Kumasi
  { name: "POL-4",  type: "police",    latitude: 6.6885,  longitude: -1.6244 },
  { name: "POL-5",  type: "police",    latitude: 6.6750,  longitude: -1.6100 },
  { name: "FIRE-3", type: "fire",      latitude: 6.6857,  longitude: -1.6239 },
  { name: "FIRE-4", type: "fire",      latitude: 6.7050,  longitude: -1.6400 },
  { name: "AMB-3",  type: "ambulance", latitude: 6.6857,  longitude: -1.6239 },
  { name: "AMB-4",  type: "ambulance", latitude: 6.6600,  longitude: -1.5900 },
  // Western — Takoradi / Sekondi
  { name: "POL-6",  type: "police",    latitude: 4.9016,  longitude: -1.7442 },
  { name: "POL-7",  type: "police",    latitude: 4.9405,  longitude: -1.7068 },
  { name: "FIRE-5", type: "fire",      latitude: 4.8950,  longitude: -1.7500 },
  { name: "AMB-5",  type: "ambulance", latitude: 4.9008,  longitude: -1.7570 },
  // Central — Cape Coast
  { name: "POL-8",  type: "police",    latitude: 5.1053,  longitude: -1.2466 },
  { name: "FIRE-6", type: "fire",      latitude: 5.1000,  longitude: -1.2500 },
  { name: "AMB-6",  type: "ambulance", latitude: 5.1033,  longitude: -1.2870 },
  // Eastern — Koforidua
  { name: "POL-9",  type: "police",    latitude: 6.0940,  longitude: -0.2570 },
  { name: "FIRE-7", type: "fire",      latitude: 6.0900,  longitude: -0.2600 },
  { name: "AMB-7",  type: "ambulance", latitude: 6.0880,  longitude: -0.2626 },
  // Volta — Ho
  { name: "POL-10", type: "police",    latitude: 6.6012,  longitude:  0.4700 },
  { name: "FIRE-8", type: "fire",      latitude: 6.5980,  longitude:  0.4680 },
  { name: "AMB-8",  type: "ambulance", latitude: 6.6008,  longitude:  0.4798 },
  // Oti — Dambai
  { name: "POL-11", type: "police",    latitude: 8.0730,  longitude:  0.1780 },
  { name: "FIRE-9", type: "fire",      latitude: 8.0710,  longitude:  0.1760 },
  { name: "AMB-9",  type: "ambulance", latitude: 8.0730,  longitude:  0.1780 },
  // Bono — Sunyani
  { name: "POL-12",  type: "police",    latitude: 7.3349,  longitude: -2.3266 },
  { name: "FIRE-10", type: "fire",      latitude: 7.3320,  longitude: -2.3280 },
  { name: "AMB-10",  type: "ambulance", latitude: 7.3389,  longitude: -2.3271 },
  // Bono East — Techiman
  { name: "POL-13",  type: "police",    latitude: 7.5905,  longitude: -1.9380 },
  { name: "FIRE-11", type: "fire",      latitude: 7.5880,  longitude: -1.9400 },
  { name: "AMB-11",  type: "ambulance", latitude: 7.5905,  longitude: -1.9380 },
  // Ahafo — Goaso
  { name: "POL-14",  type: "police",    latitude: 6.8060,  longitude: -2.5160 },
  { name: "FIRE-12", type: "fire",      latitude: 6.8040,  longitude: -2.5180 },
  { name: "AMB-12",  type: "ambulance", latitude: 6.8060,  longitude: -2.5160 },
  // Northern — Tamale
  { name: "POL-15",  type: "police",    latitude: 9.4034,  longitude: -0.8424 },
  { name: "POL-16",  type: "police",    latitude: 9.4426,  longitude: -0.0099 },
  { name: "FIRE-13", type: "fire",      latitude: 9.4000,  longitude: -0.8450 },
  { name: "AMB-13",  type: "ambulance", latitude: 9.4076,  longitude: -0.8419 },
  // Savannah — Damongo
  { name: "POL-17",  type: "police",    latitude: 9.0840,  longitude: -1.8220 },
  { name: "FIRE-14", type: "fire",      latitude: 9.0820,  longitude: -1.8240 },
  { name: "AMB-14",  type: "ambulance", latitude: 9.0840,  longitude: -1.8220 },
  // North East — Nalerigu
  { name: "POL-18",  type: "police",    latitude: 10.5200, longitude: -0.3640 },
  { name: "FIRE-15", type: "fire",      latitude: 10.5240, longitude: -0.3561 },
  { name: "AMB-15",  type: "ambulance", latitude: 10.5200, longitude: -0.3640 },
  // Upper East — Bolgatanga
  { name: "POL-19",  type: "police",    latitude: 10.7854, longitude: -0.8514 },
  { name: "FIRE-16", type: "fire",      latitude: 10.7840, longitude: -0.8530 },
  { name: "AMB-16",  type: "ambulance", latitude: 10.7869, longitude: -0.8524 },
  // Upper West — Wa
  { name: "POL-20",  type: "police",    latitude: 10.0601, longitude: -2.5099 },
  { name: "FIRE-17", type: "fire",      latitude: 10.0580, longitude: -2.5120 },
  { name: "AMB-17",  type: "ambulance", latitude: 10.0636, longitude: -2.5058 },
  // Western North — Sefwi Wiawso
  { name: "POL-21",  type: "police",    latitude: 6.2080,  longitude: -2.4860 },
  { name: "FIRE-18", type: "fire",      latitude: 6.2060,  longitude: -2.4880 },
  { name: "AMB-18",  type: "ambulance", latitude: 6.2080,  longitude: -2.4860 },
];

const SEED_HOSPITALS = [
  { name: "Korle-Bu Teaching Hospital",          latitude: 5.5481,  longitude: -0.2266, capacity: 1800, available_beds: 1200 },
  { name: "Ridge Hospital Accra",                latitude: 5.5720,  longitude: -0.1980, capacity: 350,  available_beds: 180  },
  { name: "37 Military Hospital",                latitude: 5.5755,  longitude: -0.1885, capacity: 400,  available_beds: 200  },
  { name: "Komfo Anokye Teaching Hospital",      latitude: 6.6857,  longitude: -1.6239, capacity: 1000, available_beds: 650  },
  { name: "Cape Coast Teaching Hospital",        latitude: 5.1033,  longitude: -1.2870, capacity: 480,  available_beds: 300  },
  { name: "Tamale Teaching Hospital",            latitude: 9.4076,  longitude: -0.8419, capacity: 450,  available_beds: 280  },
  { name: "Bolgatanga Regional Hospital",        latitude: 10.7869, longitude: -0.8524, capacity: 300,  available_beds: 190  },
  { name: "Wa Regional Hospital",                latitude: 10.0636, longitude: -2.5058, capacity: 250,  available_beds: 150  },
  { name: "Ho Teaching Hospital",                latitude: 6.6008,  longitude:  0.4798, capacity: 380,  available_beds: 230  },
  { name: "Takoradi Hospital",                   latitude: 4.9008,  longitude: -1.7570, capacity: 320,  available_beds: 200  },
  { name: "Koforidua Regional Hospital",         latitude: 6.0880,  longitude: -0.2626, capacity: 280,  available_beds: 170  },
  { name: "Sunyani Regional Hospital",           latitude: 7.3389,  longitude: -2.3271, capacity: 260,  available_beds: 160  },
  { name: "Techiman Holy Family Hospital",       latitude: 7.5905,  longitude: -1.9380, capacity: 200,  available_beds: 130  },
  { name: "Navrongo War Memorial Hospital",      latitude: 10.8941, longitude: -1.0930, capacity: 160,  available_beds: 100  },
  { name: "Damongo District Hospital",           latitude: 9.0840,  longitude: -1.8220, capacity: 120,  available_beds: 80   },
  { name: "Dambai Government Hospital",          latitude: 8.0730,  longitude:  0.1780, capacity: 100,  available_beds: 65   },
  { name: "Goaso Government Hospital",           latitude: 6.8060,  longitude: -2.5160, capacity: 140,  available_beds: 90   },
  { name: "Sefwi Wiawso Government Hospital",    latitude: 6.2080,  longitude: -2.4860, capacity: 110,  available_beds: 70   },
];

async function seedIfEmpty() {
  try {
    const db = getDB();
    const responderCount = await db.collection("responders").countDocuments();
    if (responderCount === 0) {
      await db.collection("responders").insertMany(
        SEED_RESPONDERS.map(r => ({ ...r, is_available: true, created_at: new Date() }))
      );
      console.log(`Seeded ${SEED_RESPONDERS.length} responders across all 16 Ghana regions`);
    }
    const hospitalCount = await db.collection("hospitals").countDocuments();
    if (hospitalCount === 0) {
      await db.collection("hospitals").insertMany(
        SEED_HOSPITALS.map(h => ({ ...h, created_at: new Date() }))
      );
      console.log(`Seeded ${SEED_HOSPITALS.length} hospitals`);
    }
  } catch (err) {
    console.error("Seed error:", err.message);
  }
}

async function migrateResponderNames() {
  try {
    const db = getDB();
    const prefixMap = { police: "POL", fire: "FIRE", ambulance: "AMB" };
    for (const [type, prefix] of Object.entries(prefixMap)) {
      const responders = await db.collection("responders")
        .find({ type })
        .sort({ _id: 1 })
        .toArray();
      for (let i = 0; i < responders.length; i++) {
        const expectedName = `${prefix}-${i + 1}`;
        if (responders[i].name !== expectedName) {
          await db.collection("responders").updateOne(
            { _id: responders[i]._id },
            { $set: { name: expectedName } }
          );
        }
      }
    }
    console.log("Responder name migration complete");
  } catch (err) {
    console.error("Responder name migration error:", err.message);
  }
}

const PORT = process.env.PORT || 3002;

app.listen(PORT, () => console.log(`Incident service running on port ${PORT}`));
Promise.all([initDB(), connect()])
  .then(seedIfEmpty)
  .then(migrateResponderNames)
  .catch(err => console.error("Failed to initialize:", err));
