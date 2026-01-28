// =========================
// CourtStream Server
// (Based on LAST WORKING VERSION)
// =========================

const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");
const sqlite3 = require("sqlite3").verbose();

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

/* ROOT → director (or change later) */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

/* =========================
   DATABASE (SAFE ADD)
========================= */
const db = new sqlite3.Database(
  path.join(__dirname, "db.sqlite"),
  err => err && console.error("DB error:", err)
);

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS courtstreams (
      id TEXT PRIMARY KEY,
      name TEXT,
      resolution TEXT,
      max_cameras INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

/* =========================
   API (NON-BREAKING)
========================= */
app.post("/api/create", (req, res) => {
  const { id, name, resolution, maxCameras } = req.body;

  if (!id || !name) {
    return res.status(400).json({ error: "Missing fields" });
  }

  db.run(
    `INSERT OR REPLACE INTO courtstreams
     (id, name, resolution, max_cameras)
     VALUES (?, ?, ?, ?)`,
    [id, name, resolution, maxCameras],
    err => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: "DB error" });
      }
      res.json({ ok: true });
    }
  );
});

app.get("/api/courtstream/:id", (req, res) => {
  db.get(
    `SELECT * FROM courtstreams WHERE id = ?`,
    [req.params.id],
    (err, row) => {
      if (err) {
        console.error(err);
        return res.status(500).json({ error: "DB error" });
      }
      if (!row) return res.status(404).json({ error: "Not found" });
      res.json(row);
    }
  );
});

/* =========================
   SOCKET.IO (EXTENDED, SAFE)
========================= */
const io = new Server(server, {
  cors: { origin: "*" }
});

io.on("connection", socket => {

  /*
    join payload supports:
    - string room (BACKWARD COMPATIBLE)
    - { room, role, position }
  */
  socket.on("join", payload => {
    let room, role, position;

    if (typeof payload === "string") {
      room = payload;
      role = "camera"; // default (old behavior)
    } else {
      ({ room, role, position } = payload);
    }

    socket.join(room);
    socket.room = room;
    socket.role = role || "camera";
    socket.position = position || null;

    const clients = io.sockets.adapter.rooms.get(room) || new Set();
    const others = [...clients].filter(id => id !== socket.id);

    // unchanged behavior
    socket.emit(
      "existing-peers",
      others.map(id => ({ id }))
    );

    // extended metadata (safe)
    socket.to(room).emit("peer-joined", {
      id: socket.id,
      role: socket.role,
      position: socket.position
    });
  });

  socket.on("signal", ({ to, data }) => {
    io.to(to).emit("signal", {
      from: socket.id,
      data
    });
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
   LISTEN (PRODUCTION SAFE)
========================= */
server.listen(PORT, "0.0.0.0", () => {
  console.log(`✅ CourtStream server running on port ${PORT}`);
});
