const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

let liveCameraId = null;

io.on("connection", socket => {

  socket.on("join", payload => {
    const room = typeof payload === "string" ? payload : payload.room;
    if (!room) return;

    socket.join(room);
    socket.to(room).emit("peer-joined", { id: socket.id });

    const peers =
      [...(io.sockets.adapter.rooms.get(room) || [])]
        .filter(id => id !== socket.id)
        .map(id => ({ id }));

    socket.emit("existing-peers", peers);

    if (liveCameraId) {
      socket.emit("program", { cameraId: liveCameraId });
    }
  });

  socket.on("signal", ({ to, data }) => {
    io.to(to).emit("signal", { from: socket.id, data });
  });

  socket.on("control", ({ to, type, value }) => {
    io.to(to).emit("control", { type, value });
  });

  socket.on("program", ({ cameraId }) => {
    liveCameraId = cameraId;
    io.emit("program", { cameraId });
  });

  socket.on("disconnect", () => {
    if (socket.id === liveCameraId) {
      liveCameraId = null;
      io.emit("program", { cameraId: null });
    }
    io.emit("peer-left", socket.id);
  });
});

server.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});
