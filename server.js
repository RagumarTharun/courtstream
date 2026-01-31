// =========================
// CourtStream Server (FINAL)
// =========================
const express = require("express");
const http = require("http");
const session = require("express-session");
const sqlite3 = require("sqlite3").verbose();
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET","POST"] }
});

const PORT = 3000;

/* ===== DB ===== */
const db = new sqlite3.Database("db.sqlite");

/* ===== MIDDLEWARE ===== */
app.use(express.json());
app.use(express.static(__dirname));

app.use(session({
  secret: "courtstream-secret",
  resave: false,
  saveUninitialized: false
}));

/* ===== STREAM API ===== */
app.get("/api/streams", (_,res)=>{
  db.all("SELECT * FROM streams",[],(_,r)=>res.json(r));
});

/* ===== SOCKET.IO ===== */
io.on("connection", socket => {

  socket.on("join", room => {
    socket.join(room);
    socket.room = room;

    const peers = [...(io.sockets.adapter.rooms.get(room)||[])].filter(id=>id!==socket.id);
    socket.emit("existing-peers", peers.map(id=>({id})));
    socket.to(room).emit("peer-joined",{id:socket.id});
  });

  socket.on("signal", ({to,data})=>{
    if(to) io.to(to).emit("signal",{from:socket.id,data});
  });

  /* 🔑 FOCUS DATA RELAY */
  socket.on("focus-update", data=>{
    socket.to(socket.room).emit("focus-update", data, socket.id);
  });

  socket.on("disconnect", ()=>{
    if(socket.room){
      socket.to(socket.room).emit("camera-left",{id:socket.id});
    }
  });
});

server.listen(PORT, ()=>console.log("✅ Running on",PORT));
