// =========================
// CourtStream Server (FINAL)
// Tunnel-safe, PM2-safe
// =========================

const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

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

/* ROOT */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

/* =========================
   SOCKET.IO
========================= */
const io = new Server(server, {
  cors: { origin: "*" }
});

io.on("connection", socket => {

  /**
   * join supports BOTH:
   *  - join("room")                     ← legacy
   *  - join({ room, role, position })   ← new
   */
  socket.on("join", payload => {
    let room, role, position;

    if (typeof payload === "string") {
      room = payload;
      role = "camera";
    } else {
      room = payload.room;
      role = payload.role || "camera";
      position = payload.position || null;
    }

    socket.join(room);
    socket.room = room;
    socket.role = role;
    socket.position = position;

    const clients =
      io.sockets.adapter.rooms.get(room) || new Set();

    const others = [...clients]
      .filter(id => id !== socket.id)
      .map(id => ({ id }));

    // Send existing peers to the new client
    socket.emit("existing-peers", others);

    // Notify others
    socket.to(room).emit("peer-joined", {
      id: socket.id,
      role,
      position
    });
  });

  /* WebRTC signaling */
  socket.on("signal", ({ to, data }) => {
    io.to(to).emit("signal", {
      from: socket.id,
      data
    });
  });

  /* Camera control messages */
  socket.on("control", msg => {
    if (msg.to) {
      io.to(msg.to).emit("control", msg);
    }
  });

  /* Program feed selection */
  socket.on("program", msg => {
    socket.broadcast.emit("program", msg);
  });

  /* Disconnect cleanup */
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
   START SERVER (TUNNEL SAFE)
========================= */
server.listen(PORT, "127.0.0.1", () => {
  console.log(`✅ CourtStream listening on localhost:${PORT}`);
});
