const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

/* =========================
   STATIC FILES
========================= */
app.use(express.static(path.join(__dirname, "public")));

/* ROOT → laptop */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "laptop.html"));
});

/* =========================
   SOCKET.IO
========================= */
const io = new Server(server, {
  cors: { origin: "*" }
});

io.on("connection", socket => {

  socket.on("join", room => {
    socket.join(room);

    const clients = io.sockets.adapter.rooms.get(room) || new Set();
    const others = [...clients].filter(id => id !== socket.id);

    socket.emit("existing-peers", others.map(id => ({ id })));
    socket.to(room).emit("peer-joined", { id: socket.id });
  });

  socket.on("signal", ({ to, data }) => {
    io.to(to).emit("signal", { from: socket.id, data });
  });

  socket.on("control", msg => {
    if (msg.to) io.to(msg.to).emit("control", msg);
  });

  socket.on("program", msg => {
    socket.broadcast.emit("program", msg);
  });

  /* 🔥 CAMERA DISCONNECT */
  socket.on("disconnect", () => {
    socket.broadcast.emit("camera-left", { id: socket.id });
  });
});

server.listen(3000, () => {
  console.log("✅ Server running on http://localhost:3000");
});
