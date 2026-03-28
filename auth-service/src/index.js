require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { ObjectId } = require("mongodb");
const swaggerUi = require("swagger-ui-express");
const swaggerDocument = require("./swagger");
const { initDB, getDB } = require("./db");

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
app.get("/health", (req, res) => res.json({ status: "ok", service: "auth" }));

const JWT_SECRET = process.env.JWT_SECRET;

// ── Middleware: verify token ──────────────────────────────
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

// ── POST /auth/register ───────────────────────────────────
app.post("/auth/register", async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password || !role)
    return res.status(400).json({ error: "All fields required" });

  const validRoles = [
    "system_admin","hospital_admin",
    "police_admin","fire_admin","ambulance_driver"
  ];
  if (!validRoles.includes(role))
    return res.status(400).json({ error: "Invalid role" });

  try {
    const db = getDB();
    const existingUser = await db.collection("users").findOne({ email });
    if (existingUser)
      return res.status(409).json({ error: "Email already exists" });

    const hash = await bcrypt.hash(password, 10);
    const result = await db.collection("users").insertOne({
      name,
      email,
      password_hash: hash,
      role,
      created_at: new Date()
    });
    
    res.status(201).json({
      _id: result.insertedId,
      name,
      email,
      role,
      created_at: new Date()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /auth/login ──────────────────────────────────────
app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;
  try {
    const db = getDB();
    const user = await db.collection("users").findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password_hash)))
      return res.status(401).json({ error: "Invalid credentials" });

    const token = jwt.sign(
      { id: user._id.toString(), email: user.email, role: user.role, name: user.name },
      JWT_SECRET,
      { expiresIn: "8h" }
    );
    const refresh = jwt.sign({ id: user._id.toString() }, JWT_SECRET, { expiresIn: "7d" });

    res.json({ token, refresh_token: refresh,
      user: { id: user._id.toString(), name: user.name, email: user.email, role: user.role }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /auth/refresh-token ──────────────────────────────
app.post("/auth/refresh-token", async (req, res) => {
  const { refresh_token } = req.body;
  try {
    const decoded = jwt.verify(refresh_token, JWT_SECRET);
    const db = getDB();
    const user = await db.collection("users").findOne({ _id: new ObjectId(decoded.id) });
    if (!user) return res.status(404).json({ error: "User not found" });

    const token = jwt.sign(
      { id: user._id.toString(), email: user.email, role: user.role, name: user.name },
      JWT_SECRET,
      { expiresIn: "8h" }
    );
    res.json({ token });
  } catch {
    res.status(401).json({ error: "Invalid refresh token" });
  }
});

// ── GET /auth/profile ─────────────────────────────────────
app.get("/auth/profile", authenticate, async (req, res) => {
  const db = getDB();
  const user = await db.collection("users").findOne(
    { _id: new ObjectId(req.user.id) },
    { projection: { password_hash: 0 } }
  );
  res.json(user);
});

// ── GET /auth/verify (used by other services) ─────────────
app.get("/auth/verify", authenticate, (req, res) => {
  res.json({ valid: true, user: req.user });
});

// ── GET /auth/users (system admin only) ───────────────────
app.get("/auth/users", authenticate, async (req, res) => {
  if (req.user.role !== "system_admin")
    return res.status(403).json({ error: "Forbidden" });
  const db = getDB();
  const users = await db.collection("users").find(
    {},
    { projection: { password_hash: 0 } }
  ).sort({ created_at: -1 }).toArray();
  res.json(users);
});

// ── PUT /auth/users/:id (system admin only) ───────────────
app.put("/auth/users/:id", authenticate, async (req, res) => {
  if (req.user.role !== "system_admin")
    return res.status(403).json({ error: "Forbidden" });

  const { name, email, role, password } = req.body;
  const validRoles = ["system_admin","hospital_admin","police_admin","fire_admin","ambulance_driver"];

  if (role && !validRoles.includes(role))
    return res.status(400).json({ error: "Invalid role" });

  try {
    const db = getDB();
    const updates = { updated_at: new Date() };
    if (name)     updates.name  = name;
    if (email)    updates.email = email;
    if (role)     updates.role  = role;
    if (password) updates.password_hash = await bcrypt.hash(password, 10);

    if (!Object.keys(updates).length)
      return res.status(400).json({ error: "No fields to update" });

    if (email) {
      const conflict = await db.collection("users").findOne({
        email, _id: { $ne: new ObjectId(req.params.id) }
      });
      if (conflict) return res.status(409).json({ error: "Email already in use" });
    }

    const result = await db.collection("users").findOneAndUpdate(
      { _id: new ObjectId(req.params.id) },
      { $set: updates },
      { returnDocument: "after", projection: { password_hash: 0 } }
    );
    if (!result) return res.status(404).json({ error: "User not found" });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /auth/users/:id (system admin only) ────────────
app.delete("/auth/users/:id", authenticate, async (req, res) => {
  if (req.user.role !== "system_admin")
    return res.status(403).json({ error: "Forbidden" });

  if (req.params.id === req.user.id)
    return res.status(400).json({ error: "Cannot delete your own account" });

  try {
    const db = getDB();
    const result = await db.collection("users").deleteOne({ _id: new ObjectId(req.params.id) });
    if (result.deletedCount === 0)
      return res.status(404).json({ error: "User not found" });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /auth/profile (own profile) ──────────────────────
app.put("/auth/profile", authenticate, async (req, res) => {
  const { name, email, current_password, new_password } = req.body;
  try {
    const db = getDB();
    const current = await db.collection("users").findOne({ _id: new ObjectId(req.user.id) });
    if (!current) return res.status(404).json({ error: "User not found" });

    const updates = { updated_at: new Date() };
    if (name)  updates.name  = name;
    if (email && email !== current.email) {
      const conflict = await db.collection("users").findOne({
        email, _id: { $ne: new ObjectId(req.user.id) }
      });
      if (conflict) return res.status(409).json({ error: "Email already in use" });
      updates.email = email;
    }

    if (new_password) {
      if (!current_password)
        return res.status(400).json({ error: "Current password required to set a new password" });
      const match = await bcrypt.compare(current_password, current.password_hash);
      if (!match) return res.status(401).json({ error: "Current password is incorrect" });
      updates.password_hash = await bcrypt.hash(new_password, 10);
    }

    const result = await db.collection("users").findOneAndUpdate(
      { _id: new ObjectId(req.user.id) },
      { $set: updates },
      { returnDocument: "after", projection: { password_hash: 0 } }
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Auth service running on port ${PORT}`));
initDB().catch(err => console.error("Failed to initialize DB:", err));
