// =========================
// CourtStream Server (STABLE + COMPATIBLE)
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

const PORT = process.env.PORT || 3000;

/* =========================
   TRUST PROXY (Cloudflare)
========================= */
app.set("trust proxy", 1);

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

  // 🔒 DO NOT ADD EXTRA COLUMNS UNTIL MIGRATION
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
   SESSION (SINGLE INSTANCE)
========================= */
const sessionMiddleware = session({
  name: "courtstream.sid",
  secret: "REPLACE_WITH_LONG_RANDOM_SECRET",
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: true,
    sameSite: "lax"
  }
});

/* =========================
   MIDDLEWARE
========================= */
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));
app.use(sessionMiddleware);

/* =========================
   AUTH
========================= */
function requireAuth(req, res, next) {
  if (!req.session.user) return res.sendStatus(401);
  next();
}

app.post("/api/register", async (req, res) => {
  const hash = await bcrypt.hash(req.body.password, 10);
  db.run(
    "INSERT INTO users (email, password) VALUES (?, ?)",
    [req.body.email, hash],
    err =>
      err
        ? res.status(409).json({ error: "User exists" })
        : res.sendStatus(200)
  );
});

app.post("/api/login", (req, res) => {
  db.get(
    "SELECT * FROM users WHERE email = ?",
    [req.body.email],
    async (_, user) => {
      if (!user) return res.sendStatus(401);
      const ok = await bcrypt.compare(req.body.password, user.password);
      if (!ok) return res.sendStatus(401);

      req.session.user = {
        id: user.id,
        email: user.email
      };
      res.sendStatus(200);
    }
  );
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.sendStatus(200));
});

app.get("/me", (req, res) => {
  if (!req.session.user) return res.sendStatus(401);
  res.json(req.session.user);
});

/* =========================
   STREAMS API (FIXED)
========================= */

// ✅ USED BY INDEX PAGE
app.get("/api/streams", (req, res) => {
  db.all(
    `
    SELECT id, name, creator_id
    FROM streams
    WHERE name IS NOT NULL AND TRIM(name) != ''
    ORDER BY created_at DESC
    `,
    [],
    (err, rows) => {
      if (err) {
        console.error("STREAM LIST ERROR:", err);
        return res.status(500).json([]);
      }
      res.json(rows);
    }
  );
});

// ✅ CREATE STREAM (MATCHES DB)
app.post("/api/streams", requireAuth, (req, res) => {
  const id = crypto.randomUUID();
  const { name } = req.body;

  if (!name || name.trim().length < 3) {
    return res.status(400).json({ error: "Invalid stream name" });
  }

  db.run(
    `
    INSERT INTO streams (id, name, creator_id)
    VALUES (?, ?, ?)
    `,
    [id, name.trim(), req.session.user.id],
    err => {
      if (err) {
        console.error("STREAM INSERT ERROR:", err);
        return res.status(409).json({ error: "Stream already exists" });
      }
      res.json({ id });
    }
  );
});

/* =========================
   SOCKET.IO (SESSION SHARED)
========================= */
io.use((socket, next) => {
  sessionMiddleware(socket.request, {}, next);
});

io.on("connection", socket => {
  socket.on("join", ({ room, role }) => {
    if (!room) return;

    db.get(
      "SELECT * FROM streams WHERE id = ?",
      [room],
      (_, stream) => {
        if (!stream) return;

        if (
          role === "director" &&
          stream.creator_id !== socket.request.session?.user?.id
        ) {
          socket.disconnect();
          return;
        }

        socket.join(room);
        socket.room = room;
        socket.role = role;

        socket.to(room).emit("peer-joined", {
          id: socket.id,
          role
        });
      }
    );
  });

  socket.on("signal", ({ to, data }) => {
    if (to) io.to(to).emit("signal", {
      from: socket.id,
      data
    });
  });

  socket.on("disconnect", () => {
    if (socket.room) {
      socket.to(socket.room).emit("peer-left", {
        id: socket.id
      });
    }
  });
});

/* =========================
   START
========================= */
server.listen(PORT, "127.0.0.1", () => {
  console.log("✅ CourtStream running on port", PORT);
});
