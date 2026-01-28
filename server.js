const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const sqlite3 = require("sqlite3").verbose();
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));
app.use(express.json());

/* =========================
   DATABASE
========================= */
const db = new sqlite3.Database("./db.sqlite");

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
   CREATE COURTSTREAM
========================= */
app.post("/api/create", (req, res) => {
  const { id, name, resolution, maxCameras } = req.body;
  db.run(
    `INSERT INTO courtstreams (id,name,resolution,max_cameras)
     VALUES (?,?,?,?)`,
    [id, name, resolution, maxCameras],
    () => res.json({ ok: true })
  );
});

app.get("/api/courtstream/:id", (req, res) => {
  db.get(
    `SELECT * FROM courtstreams WHERE id=?`,
    [req.params.id],
    (err, row) => res.json(row)
  );
});

/* =========================
   SOCKETS
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

  socket.on("signal", data => {
    io.to(data.to).emit("signal", {
      from: socket.id,
      data: data.data
    });
  });

  socket.on("disconnect", () => {
    socket.to(socket.room).emit("peer-left", socket.id);
  });
});

server.listen(3000, () =>
  console.log("CourtStream running on http://localhost:3000")
);
