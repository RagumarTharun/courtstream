// =========================
// CourtStream Server (FINAL)
// =========================
const crypto = require("crypto");
const express = require("express");
const http = require("http");
const path = require("path");
const session = require("express-session");
const SQLiteStore = require("better-sqlite3-session-store")(session);
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

/* =========================
   CONFIG
========================= */
const PORT = process.env.PORT || 3000;

/* =========================
   DATABASE
========================= */
const db = new Database("courtstream.db");

// Users
db.prepare(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL
  )
`).run();

// Streams
db.prepare(`
  CREATE TABLE IF NOT EXISTS streams (
    id TEXT PRIMARY KEY,
    name TEXT UNIQUE NOT NULL,
    creator_id INTEGER NOT NULL,
    max_cameras INTEGER,
    resolution TEXT,
    camera_access TEXT,
    camera_pass TEXT,
    viewer_access TEXT,
    viewer_pass TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (creator_id) REFERENCES users(id)
  )
`).run();

/* =========================
   MIDDLEWARE
========================= */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

app.use(
  session({
    secret: "courtstream-secret",
    resave: false,
    saveUninitialized: false,
    store: new SQLiteStore({ client: db }),
    cookie: { secure: false }
  })
);

/* =========================
   AUTH HELPERS
========================= */
function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

/* =========================
   ROUTES
========================= */

// Root
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

// Register
app.post("/api/register", async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.sendStatus(400);

  const hash = await bcrypt.hash(password, 10);

  try {
    db.prepare(
      "INSERT INTO users (email, password) VALUES (?, ?)"
    ).run(email, hash);
    res.sendStatus(200);
  } catch {
    res.status(409).json({ error: "User already exists" });
  }
});

// Login
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare(
    "SELECT * FROM users WHERE email = ?"
  ).get(email);

  if (!user) return res.sendStatus(401);

  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.sendStatus(401);

  req.session.userId = user.id;
  res.sendStatus(200);
});

// Create stream (AUTH REQUIRED)
app.post("/api/streams", requireAuth, (req, res) => {
  const {
    name,
    maxCameras,
    resolution,
    cameraAccess,
    cameraPass,
    viewerAccess,
    viewerPass
  } = req.body;

  if (!name) return res.sendStatus(400);

  const id = crypto.randomUUID();

  try {
    db.prepare(`
      INSERT INTO streams
      (id, name, creator_id, max_cameras, resolution,
       camera_access, camera_pass, viewer_access, viewer_pass)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      name,
      req.session.userId,
      maxCameras,
      resolution,
      cameraAccess,
      cameraPass || null,
      viewerAccess,
      viewerPass || null
    );

    res.json({ id });
  } catch {
    res.status(409).json({ error: "Stream name already exists" });
  }
});

// Validate stream
app.get("/api/streams/:id", (req, res) => {
  const stream = db.prepare(
    "SELECT id, name, creator_id FROM streams WHERE id = ?"
  ).get(req.params.id);

  if (!stream) return res.sendStatus(404);
  res.json(stream);
});

/* =========================
   SOCKET.IO
========================= */
io.on("connection", socket => {
  socket.on("join", payload => {
    const { room, role, position } = payload || {};
    if (!room) return;

    const stream = db.prepare(
      "SELECT * FROM streams WHERE id = ?"
    ).get(room);

    if (!stream) return;

    socket.join(room);
    socket.room = room;
    socket.role = role;
    socket.position = position;

    // Director enforcement
    if (role === "director" && stream.creator_id !== socket.request.session?.userId) {
      socket.disconnect(true);
      return;
    }

    socket.to(room).emit("peer-joined", {
      id: socket.id,
      role,
      position
    });
  });

  socket.on("signal", ({ to, data }) => {
    if (to) io.to(to).emit("signal", { from: socket.id, data });
  });

  socket.on("disconnect", () => {
    if (socket.room) {
      socket.to(socket.room).emit("peer-left", {
        id: socket.id,
        role: socket.role,
        position: socket.position
      });
    }
  });
});

/* =========================
   START
========================= */
server.listen(PORT, "127.0.0.1", () => {
  console.log(`✅ CourtStream running on ${PORT}`);
});
