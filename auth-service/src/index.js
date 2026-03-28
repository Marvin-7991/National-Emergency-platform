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
    { projection: { password_hash: 0 }, sort: { created_at: -1 } }
  ).toArray();
  res.json(users);
});

// ── Start ─────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
initDB().then(() =>
  app.listen(PORT, () => console.log(`Auth service running on port ${PORT}`))
).catch(err => {
  console.error("Failed to initialize DB:", err);
  process.exit(1);
});
