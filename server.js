// =========================
// CourtStream Server (UPDATED, SAFE, REFRESH-PROOF)
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

app.use(
  session({
    name: "courtstream.sid",
    secret: "courtstream-secret",
    resave: false,
    saveUninitialized: false
  })
);

/* =========================
   SOCKET.IO — WEBRTC (FIXED)
========================= */
io.on("connection", socket => {
  console.log("🟢 CONNECTED:", socket.id);

  socket.on("join", room => {
    socket.join(room);
    socket.room = room;

    const clients = io.sockets.adapter.rooms.get(room) || new Set();
    const others = [...clients].filter(id => id !== socket.id);

    // 🔑 critical for director refresh
    socket.emit(
      "existing-peers",
      others.map(id => ({ id }))
    );

    socket.to(room).emit("peer-joined", { id: socket.id });
  });

  socket.on("signal", ({ to, data }) => {
    if (!to || !data) return;
    io.to(to).emit("signal", { from: socket.id, data });
  });

  socket.on("disconnect", () => {
    if (socket.room) {
      socket.to(socket.room).emit("peer-left", {
        id: socket.id
      });
    }
    console.log("🔴 DISCONNECTED:", socket.id);
  });
});

/* =========================
   START
========================= */
server.listen(PORT, "0.0.0.0", () => {
  console.log("✅ CourtStream running on port", PORT);
});
