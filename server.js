// =========================
// CourtStream Server (FINAL)
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
    name: "courtstream.sid",
    secret: "REPLACE_WITH_LONG_RANDOM_SECRET",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      secure: true,
      sameSite: "lax"
    }
  })
);

/* =========================
   AUTH MIDDLEWARE
========================= */
function requireAuth(req, res, next) {
  if (!req.session.user) return res.sendStatus(401);
  next();
}

/* =========================
   AUTH ROUTES
========================= */
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

app.get("/api/streams", (req, res) => {
  db.all(
    `
    SELECT id, name, creator
    FROM streams
    WHERE name IS NOT NULL AND TRIM(name) != ''
    ORDER BY created_at DESC
    `,
    [],
    (err, rows) => {
      if (err) {
        console.error(err);
        return res.status(500).json([]);
      }
      res.json(rows);
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
   STREAMS
========================= */
app.get("/api/streams", (req, res) => {
  db.all(
    `
    SELECT name
    FROM streams
    WHERE name IS NOT NULL AND TRIM(name) != ''
    ORDER BY created_at DESC
    `,
    [],
    (err, rows) => {
      if (err) return res.status(500).json([]);
      res.json(rows.map(r => r.name));
    }
  );
});

app.post("/api/streams", requireAuth, (req, res) => {
  const id = crypto.randomUUID();

  const {
    name,
    max_cameras = 6,
    resolution = "720p",
    camera_access = "open",
    camera_pass = null,
    viewer_access = "public",
    viewer_pass = null
  } = req.body;

  if (!name || name.length < 3) {
    return res.status(400).json({ error: "Invalid stream name" });
  }

  db.run(
    `
    INSERT INTO streams (
      id,
      name,
      creator,
      max_cameras,
      resolution,
      camera_access,
      camera_pass,
      viewer_access,
      viewer_pass
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      id,
      name,
      req.session.user.id,
      max_cameras,
      resolution,
      camera_access,
      camera_pass,
      viewer_access,
      viewer_pass
    ],
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
   SOCKET.IO (SESSION AWARE)
========================= */
io.use((socket, next) => {
  session({
    name: "courtstream.sid",
    secret: "REPLACE_WITH_LONG_RANDOM_SECRET",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: true,
      sameSite: "lax"
    }
  })(socket.request, {}, next);
});

io.on("connection", socket => {
  socket.on("join", ({ room, role }) => {
    if (!room) return;

    db.get("SELECT * FROM streams WHERE id = ?", [room], (err, stream) => {
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
