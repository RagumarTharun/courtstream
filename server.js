// =========================
// CourtStream Server (FINAL, UNIFIED & SAFE)
// =========================

const express = require("express");
const http = require("http");
const crypto = require("crypto");
require("dotenv").config();
const session = require("express-session");
const bcrypt = require("bcryptjs");
const sqlite3 = require("sqlite3").verbose();
const { Server } = require("socket.io");
const helmet = require("helmet");

const app = express();
app.use(helmet({
  contentSecurityPolicy: false, // Disabled for demo simplicity (WebRTC/Socket.IO)
}));
const server = http.createServer(app);

/* =========================
   SOCKET.IO (IMPORTANT)
========================= */
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ["websocket", "polling"]
});

const PORT = process.env.PORT || 3000;

/* =========================
   DATABASE
========================= */
const db = new sqlite3.Database(process.env.DB_PATH || "db.sqlite");

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE,
      password TEXT,
      avatar TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS streams (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE,
      creator INTEGER,
      thumbnail TEXT,
      camera_access TEXT DEFAULT 'public',
      viewer_access TEXT DEFAULT 'public',
      password TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // SCHEMA UPGRADE (Add columns if they don't exist in old DB)
  db.run("ALTER TABLE streams ADD COLUMN thumbnail TEXT", err => { });
  db.run("ALTER TABLE streams ADD COLUMN camera_access TEXT DEFAULT 'public'", err => { });
  db.run("ALTER TABLE streams ADD COLUMN viewer_access TEXT DEFAULT 'public'", err => { });
  db.run("ALTER TABLE streams ADD COLUMN password TEXT", err => { });
  db.run("ALTER TABLE users ADD COLUMN avatar TEXT", err => { });
});

/* =========================
   MIDDLEWARE (LARGE PAYLOADS FOR IMAGES)
========================= */
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(express.static(__dirname));

// COOP/COEP for FFmpeg SharedArrayBuffer
app.use((req, res, next) => {
  res.header("Cross-Origin-Opener-Policy", "same-origin");
  res.header("Cross-Origin-Embedder-Policy", "require-corp");
  next();
});

app.use(
  session({
    name: "courtstream.sid",
    secret: process.env.SESSION_SECRET || "courtstream-secret",
    resave: false,
    saveUninitialized: false
  })
);

/* =========================
   AUTH ROUTES (USED BY LOGIN / REGISTER)
========================= */
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;

  db.get("SELECT * FROM users WHERE email=?", [email], async (_, user) => {
    if (!user) return res.sendStatus(401);

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.sendStatus(401);

    req.session.user = {
      id: user.id,
      email: user.email,
      avatar: user.avatar
    };

    res.sendStatus(200);
  });
});

app.post("/api/register", async (req, res) => {
  const { email, password } = req.body;
  const hash = await bcrypt.hash(password, 10);

  db.run(
    "INSERT INTO users (email,password) VALUES (?,?)",
    [email, hash],
    err => {
      if (err) return res.status(409).json({ error: "exists" });
      res.sendStatus(200);
    }
  );
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.sendStatus(200));
});

app.get("/me", (req, res) => {
  if (!req.session.user) return res.sendStatus(401);
  res.json(req.session.user);
});

/* =========================
   STREAM ROUTES (INDEX / CREATE)
========================= */
app.get("/api/streams", (req, res) => {
  db.all(
    "SELECT id, name, creator, camera_access, viewer_access, created_at FROM streams ORDER BY created_at DESC",
    [],
    (err, rows) => {
      if (err) {
        console.error("DB Error in /api/streams:", err);
        return res.status(500).json({ error: "DB error" });
      }
      if (!rows) return res.json([]);

      const enriched = rows.map(row => {
        const room = io.sockets.adapter.rooms.get(row.id);
        let isLive = false;
        if (room) {
          for (const socketId of room) {
            const s = io.sockets.sockets.get(socketId);
            if (s && s.data.role === 'director') {
              isLive = true;
              break;
            }
          }
        }
        return {
          ...row,
          isLive,
          camera_access: row.camera_access || 'public',
          viewer_access: row.viewer_access || 'public'
        };
      });
      res.json(enriched);
    }
  );
});

app.post("/api/streams", (req, res) => {
  if (!req.session.user) return res.sendStatus(401);

  const id = crypto.randomUUID();
  const { name, thumbnail, camera_access, viewer_access, password } = req.body;

  if (!name || name.length < 3) {
    return res.status(400).json({ error: "invalid name" });
  }

  db.run(
    "INSERT INTO streams (id,name,creator,camera_access,viewer_access,password) VALUES (?,?,?,?,?,?)",
    [id, name, req.session.user.id, camera_access || 'public', viewer_access || 'public', password || ''],
    err => {
      if (err) return res.status(409).json({ error: "exists" });
      res.json({ id });
    }
  );
});

/* =========================
   SOCKET.IO — WEBRTC (OLD WORKING LOGIC)
========================= */
io.on("connection", socket => {
  console.log("🟢 SOCKET CONNECTED:", socket.id);

  socket.on("join", payload => {
    let room = payload;
    let role = null;
    let password = null;

    if (payload && typeof payload === "object") {
      room = payload.room;
      role = payload.role || null;
      password = payload.password || null;
    }

    if (!room) return;

    // Fetch stream info to check access
    db.get("SELECT camera_access, viewer_access, password FROM streams WHERE id = ?", [room], (err, stream) => {
      if (!stream) return;

      const isDirector = role === "director";
      const isViewer = role === "viewer";
      const isCamera = role === "camera" || !role;

      const accessMode = isViewer ? stream.viewer_access : stream.camera_access;

      // EXEMPT DIRECTOR from passcode checks
      if (!isDirector && accessMode === "protected" && stream.password !== password) {
        console.log(`❌ Join Denied for ${socket.id} (role: ${role}) in room ${room}`);
        return socket.emit("join-error", "Invalid passcode");
      }

      socket.join(room);
      socket.room = room;
      socket.data.role = role; // Official Socket.IO way to store metadata

      console.log(`👤 ${socket.id} joined room ${room} as ${role}`);

      const clients = io.sockets.adapter.rooms.get(room) || new Set();
      const others = [...clients].filter(id => id !== socket.id);

      // Send existing peers to the new joiner
      socket.emit("existing-peers", others.map(id => {
        const s = io.sockets.sockets.get(id);
        return { id, role: s ? s.data.role : null };
      }));

      // Notify others in the room
      socket.to(room).emit("peer-joined", {
        id: socket.id,
        role: socket.data.role
      });

      // BINGO: If viewer, notify director immediately after join is consolidated
      if (isViewer) {
        console.log(`📡 Auto-notifying director in ${room} of viewer ${socket.id}`);
        socket.to(room).emit("viewer-ready", { id: socket.id });
      }
    });
  });

  socket.on("signal", ({ to, data }) => {
    console.log(`📡 Signal: ${socket.id} -> ${to} (${data && data.type ? data.type : (data && data.candidate ? 'candidate' : 'unknown')})`);
    io.to(to).emit("signal", { from: socket.id, data });
  });

  socket.on("control", ({ to, data }) => {
    io.to(to).emit("control", { from: socket.id, data });
  });

  socket.on("viewer-ready", ({ room }) => {
    console.log(`📡 Relaying viewer-ready for ${socket.id} in room ${room}`);
    socket.to(room).emit("viewer-ready", { id: socket.id });
  });

  socket.on("disconnect", () => {
    if (socket.room) {
      const payload = { id: socket.id };
      socket.to(socket.room).emit("peer-left", payload);
      socket.to(socket.room).emit("camera-left", payload);
    }
  });
});

/* =========================
   START
========================= */
server.listen(PORT, "0.0.0.0", () => {
  console.log("✅ CourtStream running on port", PORT);
});
