//check
const express = require("express");
const http = require("http");
const path = require("path");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

/* =========================
   STATIC FILES (REPO ROOT)
   (FIX: removed non-existent /public)
========================= */
app.use(express.static(__dirname));

/* ROOT → laptop (FIX: correct path) */
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "laptop.html"));
});

/* =========================
   SOCKET.IO (UNCHANGED)
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

  socket.on("disconnect", () => {
    socket.broadcast.emit("camera-left", { id: socket.id });
  });
});

/* =========================
   LISTEN (FIX: production safe)
========================= */
server.listen(3000, "0.0.0.0", () => {
  console.log("✅ Server running on port 3000");
});
