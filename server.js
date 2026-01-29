// =========================
// CourtStream Server (FINAL, STABLE)
// =========================

const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const sqlite3 = require("sqlite3").verbose();
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const PORT = process.env.PORT || 3000;

/* =========================
   DATABASE (SAFE)
========================= */
const db = new sqlite3.Database("courtstream.db");

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
      creator_id INTEGER,
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

app.use(
  session({
    secret: "courtstream-secret",
    resave: false,
    saveUninitialized: false
  })
);

/* =========================
   AUTH
========================= */
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.sendStatus(401);
  next();
}

app.post("/api/register", async (req, res) => {
  const { email, password } = req.body;
  const hash = await bcrypt.hash(password, 10);

  db.run(
    "INSERT INTO users (email, password) VALUES (?, ?)",
    [email, hash],
    err => {
      if (err) return res.status(409).json({ error: "User exists" });
      res.sendStatus(200);
    }
  );
});

app.post("/api/login", (req, res) => {
  const { email, password } = req.body;
  db.get(
    "SELECT * FROM users WHERE email = ?",
    [email],
    async (err, user) => {
      if (!user) return res.sendStatus(401);
      const ok = await bcrypt.compare(password, user.password);
      if (!ok) return res.sendStatus(401);
      req.session.userId = user.id;
      res.sendStatus(200);
    }
  );
});
// PUBLIC: list all valid stream names for homepage
app.get("/api/streams", (req, res) => {
  db.all(
    `
    SELECT name
    FROM streams
    WHERE name IS NOT NULL
      AND TRIM(name) != ''
    ORDER BY created_at DESC
    `,
    [],
    (err, rows) => {
      if (err) {
        console.error("api/streams error:", err);
        return res.status(500).json([]);
      }

      // IMPORTANT: return ONLY string names
      const names = rows
        .map(r => r.name)
        .filter(Boolean);

      res.json(names);
    }
  );
});

/* =========================
   STREAMS
========================= */
app.post("/api/streams", requireAuth, (req, res) => {
  const id = crypto.randomUUID();
  const { name } = req.body;

  db.run(
    "INSERT INTO streams (id, name, creator_id) VALUES (?, ?, ?)",
    [id, name, req.session.userId],
    err => {
      if (err) return res.status(409).json({ error: "Stream exists" });
      res.json({ id });
    }
  );
});

app.get("/api/streams/:id", (req, res) => {
  db.get(
    "SELECT * FROM streams WHERE id = ?",
    [req.params.id],
    (err, row) => {
      if (!row) return res.sendStatus(404);
      res.json(row);
    }
  );
});

/* =========================
   SOCKET.IO
========================= */
io.on("connection", socket => {
  socket.on("join", ({ room, role }) => {
    if (!room) return;

    db.get("SELECT * FROM streams WHERE id = ?", [room], (err, stream) => {
      if (!stream) return;

      if (role === "director" && stream.creator_id !== socket.request.session?.userId) {
        socket.disconnect();
        return;
      }

      socket.join(room);
      socket.room = room;
      socket.role = role;

      socket.to(room).emit("peer-joined", { id: socket.id, role });
    });
  });

  socket.on("signal", ({ to, data }) => {
    if (to) io.to(to).emit("signal", { from: socket.id, data });
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
server.listen(PORT, "127.0.0.1", () => {
  console.log("✅ CourtStream running on port", PORT);
});
