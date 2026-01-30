// =========================
// CourtStream Server (FINAL WORKING)
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
const io = new Server(server);

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
   AUTH
========================= */
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;
  db.get("SELECT * FROM users WHERE email=?", [email], async (_, u) => {
    if (!u || !(await bcrypt.compare(password, u.password)))
      return res.sendStatus(401);
    req.session.user = { id: u.id, email: u.email };
    res.sendStatus(200);
  });
});

app.get("/me", (req, res) => {
  if (!req.session.user) return res.sendStatus(401);
  res.json(req.session.user);
});

/* =========================
   STREAMS
========================= */
app.get("/api/streams", (_, res) => {
  db.all("SELECT * FROM streams ORDER BY created_at DESC", [], (_, rows) => {
    res.json(rows);
  });
});

app.post("/api/streams", (req, res) => {
  if (!req.session.user) return res.sendStatus(401);
  const id = crypto.randomUUID();
  db.run(
    "INSERT INTO streams (id,name,creator) VALUES (?,?,?)",
    [id, req.body.name, req.session.user.id],
    err => {
      if (err) return res.status(409).json({ error: "exists" });
      res.json({ id });
    }
  );
});

/* =========================
   SOCKET.IO
========================= */
io.on("connection", socket => {

  socket.on("join", ({ room, role }) => {
    socket.join(room);
    socket.room = room;
    socket.role = role;

    socket.to(room).emit("peer-joined", {
      id: socket.id,
      role
    });
  });

  socket.on("signal", ({ to, data }) => {
    io.to(to).emit("signal", { from: socket.id, data });
  });

  socket.on("disconnect", () => {
    if (socket.room) {
      socket.to(socket.room).emit("peer-left", { id: socket.id });
    }
  });
});

/* =========================
   START
========================= */
server.listen(PORT, () => {
  console.log("✅ CourtStream running on", PORT);
});
