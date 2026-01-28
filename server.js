// =========================
// CourtStream Server (FINAL)
// Tunnel-safe, PM2-safe
// =========================

const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

// 🔹 ADDED (SAFE)
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcrypt");
const cookieParser = require("cookie-parser");
const crypto = require("crypto");

const app = express();
const server = http.createServer(app);

/* =========================
   CONFIG
========================= */
const PORT = process.env.PORT || 3000;

/* =========================
   STATIC FILES (REPO ROOT)
========================= */
app.use(express.static(__dirname));
app.use(express.json());
app.use(cookieParser());

/* ROOT */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

/* =========================
   DATABASE (SAFE, FILE-BASED)
========================= */
const db = new sqlite3.Database(
  path.join(__dirname, "db.sqlite")
);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE,
      password TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS streams (
      id TEXT PRIMARY KEY,
      name TEXT,
      creator INTEGER,
      max_cameras INTEGER,
      resolution TEXT,
      camera_access TEXT,
      camera_pass TEXT,
      viewer_access TEXT,
      viewer_pass TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

/* =========================
   AUTH API (MINIMAL)
========================= */
app.post("/api/register", async (req, res) => {
  const hash = await bcrypt.hash(req.body.password, 10);
  db.run(
    "INSERT INTO users (email, password) VALUES (?,?)",
    [req.body.email, hash],
    err => err ? res.sendStatus(400) : res.sendStatus(200)
  );
});

app.post("/api/login", (req, res) => {
  db.get(
    "SELECT * FROM users WHERE email=?",
    [req.body.email],
    async (err, user) => {
      if (!user) return res.sendStatus(401);
      const ok = await bcrypt.compare(req.body.password, user.password);
      if (!ok) return res.sendStatus(401);
      res.cookie("uid", user.id, { httpOnly: true });
      res.sendStatus(200);
    }
  );
});

/* =========================
   STREAM API
========================= */
app.post("/api/streams", (req, res) => {
  if (!req.cookies.uid) return res.sendStatus(401);

  const id = crypto.randomUUID();

  db.run(
    `INSERT INTO streams
     (id,name,creator,max_cameras,resolution,
      camera_access,camera_pass,viewer_access,viewer_pass)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      id,
      req.body.name,
      req.cookies.uid,
      req.body.maxCameras,
      req.body.resolution,
      req.body.cameraAccess,
      req.body.cameraPass,
      req.body.viewerAccess,
      req.body.viewerPass
    ],
    () => res.json({ id })
  );
});

app.get("/api/streams/:id", (req, res) => {
  db.get(
    "SELECT * FROM streams WHERE id=?",
    [req.params.id],
    (err, row) => row ? res.json(row) : res.sendStatus(404)
  );
});

/* =========================
   SOCKET.IO (UNCHANGED)
========================= */
const io = new Server(server, {
  cors: { origin: "*" }
});

io.on("connection", socket => {

  socket.on("join", payload => {
    let room, role, position;

    if (typeof payload === "string") {
      room = payload;
      role = "camera";
    } else {
      room = payload.room;
      role = payload.role || "camera";
      position = payload.position || null;
    }

    socket.join(room);
    socket.room = room;
    socket.role = role;
    socket.position = position;

    const clients =
      io.sockets.adapter.rooms.get(room) || new Set();

    const others = [...clients]
      .filter(id => id !== socket.id)
      .map(id => ({ id }));

    socket.emit("existing-peers", others);

    socket.to(room).emit("peer-joined", {
      id: socket.id,
      role,
      position
    });
  });

  socket.on("signal", ({ to, data }) => {
    io.to(to).emit("signal", { from: socket.id, data });
  });

  socket.on("control", msg => {
    if (msg.to) io.to(msg.to).emit("control", msg);
  });

  socket.on("program", msg => {
    socket.broadcast.emit("program", msg);
  });

  socket.on("disconnect", () => {
    if (socket.room) {
      socket.to(socket.room).emit("camera-left", {
        id: socket.id,
        role: socket.role,
        position: socket.position
      });
    }
  });
});

/* =========================
   START SERVER (DO NOT TOUCH)
========================= */
server.listen(PORT, "127.0.0.1", () => {
  console.log(`✅ CourtStream listening on localhost:${PORT}`);
});
