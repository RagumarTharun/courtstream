// =========================
// CourtStream Server (FINAL, UNIFIED & SAFE)
// =========================

const express = require("express");
const http = require("http");
const crypto = require("crypto");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const sqlite3 = require("sqlite3").verbose();
const { Server } = require("socket.io");

const app = express();
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

const PORT = 3000;

/* =========================
   DATABASE
========================= */
const db = new sqlite3.Database("db.sqlite");

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
      name TEXT UNIQUE,
      creator INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

/* =========================
   MIDDLEWARE
========================= */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
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
    secret: "courtstream-secret",
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
      email: user.email
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
    "SELECT * FROM streams ORDER BY created_at DESC",
    [],
    (_, rows) => res.json(rows)
  );
});

app.post("/api/streams", (req, res) => {
  if (!req.session.user) return res.sendStatus(401);

  const id = crypto.randomUUID();
  const { name } = req.body;

  if (!name || name.length < 3) {
    return res.status(400).json({ error: "invalid name" });
  }

  db.run(
    "INSERT INTO streams (id,name,creator) VALUES (?,?,?)",
    [id, name, req.session.user.id],
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

    if (payload && typeof payload === "object") {
      room = payload.room;
      role = payload.role || null;
    }

    if (!room) return;

    socket.join(room);
    socket.room = room;
    socket.role = role;

    const clients =
      io.sockets.adapter.rooms.get(room) || new Set();

    const others = [...clients].filter(id => id !== socket.id);

    // ✅ Send existing peers (critical)
    socket.emit(
      "existing-peers",
      others.map(id => {
        const s = io.sockets.sockets.get(id);
        return { id, role: s && s.role ? s.role : null };
      })
    );

    socket.to(room).emit("peer-joined", {
      id: socket.id,
      role: socket.role || null
    });
  });

  socket.on("signal", ({ to, data }) => {
    if (!to || !data) return;
    io.to(to).emit("signal", {
      from: socket.id,
      data
    });
  });

  socket.on("control", ({ to, data }) => {
    if (!to || !data) return;
    io.to(to).emit("control", {
      from: socket.id,
      data
    });
  });

  socket.on("viewer-ready", ({ room }) => {
    if (!room) return;
    socket.to(room).emit("viewer-ready", { id: socket.id });
  });

  socket.on("disconnect", () => {
    if (socket.room) {
      const payload = { id: socket.id };
      socket.to(socket.room).emit("camera-left", payload);
      socket.to(socket.room).emit("peer-left", payload);
    }
  });
});

/* =========================
   START
========================= */
server.listen(PORT, "0.0.0.0", () => {
  console.log("✅ CourtStream running on port", PORT);
});
