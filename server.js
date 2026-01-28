const express = require("express");
const http = require("http");
const path = require("path");
const bcrypt = require("bcrypt");
const cookieParser = require("cookie-parser");
const sqlite3 = require("sqlite3").verbose();
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

/* ===== MIDDLEWARE ===== */
app.use(express.json());
app.use(cookieParser());
app.use(express.static(__dirname));

/* ===== DB ===== */
const db = new sqlite3.Database("./db.sqlite");

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
      name TEXT,
      creator INTEGER,
      max_cameras INTEGER,
      resolution TEXT,
      camera_access TEXT,
      camera_pass TEXT,
      viewer_access TEXT,
      viewer_pass TEXT
    )
  `);
});

/* ===== AUTH ===== */
app.post("/api/register", async (req, res) => {
  const hash = await bcrypt.hash(req.body.password, 10);
  db.run(
    "INSERT INTO users (email,password) VALUES (?,?)",
    [req.body.email, hash],
    err => err ? res.sendStatus(400) : res.sendStatus(200)
  );
});

app.post("/api/login", (req, res) => {
  db.get(
    "SELECT * FROM users WHERE email=?",
    [req.body.email],
    async (err, user) => {
      if (!user) return res.sendStatus(401);
      const ok = await bcrypt.compare(req.body.password, user.password);
      if (!ok) return res.sendStatus(401);
      res.cookie("uid", user.id, { httpOnly: true });
      res.sendStatus(200);
    }
  );
});

/* ===== STREAMS ===== */
app.post("/api/streams", (req, res) => {
  const id = crypto.randomUUID();
  const uid = req.cookies.uid;
  if (!uid) return res.sendStatus(401);

  db.run(
    `INSERT INTO streams VALUES (?,?,?,?,?,?,?,?)`,
    [
      id,
      req.body.name,
      uid,
      req.body.maxCameras,
      req.body.resolution,
      req.body.cameraAccess,
      req.body.cameraPass,
      req.body.viewerAccess,
      req.body.viewerPass
    ],
    () => res.json({ id })
  );
});

app.get("/api/streams/:id", (req, res) => {
  db.get(
    "SELECT * FROM streams WHERE id=?",
    [req.params.id],
    (err, row) => row ? res.json(row) : res.sendStatus(404)
  );
});

/* ===== SOCKET.IO (UNCHANGED CORE) ===== */
io.on("connection", socket => {
  socket.on("join", ({ room, role, position }) => {
    socket.join(room);
    socket.to(room).emit("peer-joined", {
      id: socket.id,
      role,
      position
    });
  });

  socket.on("signal", ({ to, data }) => {
    io.to(to).emit("signal", { from: socket.id, data });
  });
});

/* ===== START ===== */
server.listen(PORT, "127.0.0.1", () =>
  console.log("✅ CourtStream running")
);
