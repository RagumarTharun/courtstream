// =========================
// CourtStream Server (FINAL, STABLE)
// =========================

const express = require("express");
const http = require("http");
const session = require("express-session");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

/* =========================
   SOCKET.IO
========================= */
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
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
      name TEXT UNIQUE
    )
  `);
});

/* =========================
   MIDDLEWARE
========================= */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

app.use(
  session({
    name: "courtstream.sid",
    secret: "courtstream-secret",
    resave: false,
    saveUninitialized: false
  })
);

/* =========================
   AUTH ROUTES (FIXED)
========================= */

/* REGISTER */
app.post("/api/register", async (req, res) => {
  let { email, password } = req.body;

  if (!email || !password || password.length < 6) {
    return res.status(400).json({ error: "invalid input" });
  }

  email = email.trim().toLowerCase();
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

/* LOGIN */
app.post("/api/login", async (req, res) => {
  let { email, password } = req.body;
  if (!email || !password) return res.sendStatus(401);

  email = email.trim().toLowerCase();

  db.get(
    "SELECT * FROM users WHERE email=?",
    [email],
    async (_, user) => {
      if (!user) return res.sendStatus(401);

      const ok = await bcrypt.compare(password, user.password);
      if (!ok) return res.sendStatus(401);

      req.session.user = {
        id: user.id,
        email: user.email
      };

      res.sendStatus(200);
    }
  );
});

/* LOGOUT */
app.post("/logout", (req, res) => {
  req.session.destroy(() => res.sendStatus(200));
});

/* CURRENT USER */
app.get("/me", (req, res) => {
  if (!req.session.user) return res.sendStatus(401);
  res.json(req.session.user);
});

/* =========================
   STREAM API
========================= */
app.get("/api/streams", (_, res) => {
  db.all("SELECT * FROM streams", [], (_, rows) => res.json(rows));
});

app.post("/api/streams", (req, res) => {
  if (!req.session.user) return res.sendStatus(401);

  const id = crypto.randomUUID();
  const { name } = req.body;

  if (!name || name.length < 3) {
    return res.status(400).json({ error: "invalid name" });
  }

  db.run(
    "INSERT INTO streams (id,name) VALUES (?,?)",
    [id, name],
    err => {
      if (err) return res.status(409).json({ error: "exists" });
      res.json({ id });
    }
  );
});

/* =========================
   SOCKET.IO — WEBRTC + FOCUS
========================= */
io.on("connection", socket => {
  console.log("🟢 Socket connected:", socket.id);

  socket.on("join", room => {
    socket.join(room);
    socket.room = room;

    const peers =
      [...(io.sockets.adapter.rooms.get(room) || [])]
        .filter(id => id !== socket.id);

    socket.emit("existing-peers", peers.map(id => ({ id })));
    socket.to(room).emit("peer-joined", { id: socket.id });
  });

  socket.on("signal", ({ to, data }) => {
    if (to && data) {
      io.to(to).emit("signal", { from: socket.id, data });
    }
  });

  /* 🔑 FOCUS DATA RELAY (WORKING) */
  socket.on("focus-update", data => {
    if (socket.room) {
      socket.to(socket.room).emit("focus-update", {
        from: socket.id,
        ...data
      });
    }
  });

  socket.on("disconnect", () => {
    if (socket.room) {
      socket.to(socket.room).emit("peer-left", { id: socket.id });
    }
  });
});

/* =========================
   START SERVER
========================= */
server.listen(PORT, "0.0.0.0", () => {
  console.log("✅ CourtStream running on port", PORT);
});
