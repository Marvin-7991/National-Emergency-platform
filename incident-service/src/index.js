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
app.use(cors());
app.use(express.json());
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(swaggerDocument));

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

    // Auto-assign hospital for medical emergencies
    if (responderType === "ambulance") {
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
        const matching = vehicles.filter(v =>
          v.vehicle_type === typeMap[responderType] && (v.status === "idle" || !v.status)
        );
        if (matching.length > 0) {
          const nearestVehicle = matching.reduce((best, v) => {
            const d = getDistance(
              parseFloat(latitude), parseFloat(longitude),
              parseFloat(v.latitude) || 0, parseFloat(v.longitude) || 0
            );
            const bd = best
              ? getDistance(parseFloat(latitude), parseFloat(longitude),
                  parseFloat(best.latitude) || 0, parseFloat(best.longitude) || 0)
              : Infinity;
            return d < bd ? v : best;
          }, null);
          if (nearestVehicle) {
            await axios.post(`${DISPATCH_URL}/vehicles/assign`, {
              vehicle_id: nearestVehicle.vehicle_id,
              incident_id: incident._id.toString()
            });
            incident.assigned_vehicle_id = nearestVehicle.vehicle_id;
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
  const validStatuses = ["created", "dispatched", "in_progress", "resolved"];
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

    // Free up responder and hospital bed when resolved
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
  if (capacity !== undefined) updates.capacity = parseInt(capacity);
  if (available_beds !== undefined) updates.available_beds = parseInt(available_beds);

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

const PORT = process.env.PORT || 3002;

Promise.all([
  initDB(),
  connect()
]).then(() => {
  app.listen(PORT, () => console.log(`Incident service running on port ${PORT}`));
}).catch(err => {
  console.error("Failed to initialize:", err);
  process.exit(1);
});
