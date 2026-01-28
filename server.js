const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

/* =========================
   CONFIG
========================= */
const PORT = process.env.PORT || 3000;

/* =========================
   MIDDLEWARE
========================= */
app.use(express.json());

// 🔥 IMPORTANT: serve CURRENT DIRECTORY
app.use(express.static(__dirname));

/* =========================
   DATABASE
========================= */
const dbPath = path.join(__dirname, "db.sqlite");
const db = new sqlite3.Database(dbPath);

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
   API
========================= */
app.post("/api/create", (req, res) => {
  const { id, name, resolution, maxCameras } = req.body;

  if (!id || !name) {
    return res.status(400).json({ error: "Missing fields" });
  }

  db.run(
    `INSERT INTO courtstreams (id, name, resolution, max_cameras)
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
   SOCKET.IO
========================= */
io.on("connection", socket => {

  socket.on("join", ({ room, role, position }) => {
    socket.join(room);
    socket.role = role;
    socket.position = position;
    socket.room = room;

    socket.to(room).emit("peer-joined", {
      id: socket.id,
      role,
      position
    });
  });

  socket.on("signal", ({ to, data }) => {
    io.to(to).emit("signal", {
      from: socket.id,
      data
    });
  });

  socket.on("disconnect", () => {
    if (socket.room) {
      socket.to(socket.room).emit("peer-left", socket.id);
    }
  });
});

/* =========================
   START SERVER
========================= */
server.listen(PORT,"0.0.0.0" () => {
  console.log(`CourtStream running on port ${PORT}`);
});
