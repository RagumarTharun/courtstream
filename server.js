// =========================
// CourtStream Server (FINAL, UNIFIED & SAFE)
// =========================

const express = require("express");
const http = require("http");
const crypto = require("crypto");
require("dotenv").config();
const session = require("express-session");
const bcrypt = require("bcryptjs");
const sqlite3 = require("sqlite3").verbose();
const { Server } = require("socket.io");
const helmet = require("helmet");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg");

// Ensure upload directories exist
const UPLOADS_BASE = path.join(__dirname, "public", "uploads");
const UPLOADS_ISO = path.join(UPLOADS_BASE, "iso");
[UPLOADS_BASE, UPLOADS_ISO].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log("📁 Created directory:", dir);
  }
});

const app = express();
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginOpenerPolicy: { policy: "same-origin" },
  crossOriginEmbedderPolicy: { policy: "require-corp" }
}));
app.set("trust proxy", 1); // For Oracle/Nginx reverse proxy
const server = http.createServer(app);

/* =========================
   SOCKET.IO (IMPORTANT)
========================= */
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ["websocket", "polling"]
});

const PORT = process.env.PORT || 3000;

/* =========================
   DATABASE
========================= */
const db = new sqlite3.Database(process.env.DB_PATH || "db.sqlite");

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE,
      password TEXT,
      avatar TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS streams (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE,
      creator INTEGER,
      thumbnail TEXT,
      camera_access TEXT DEFAULT 'public',
      viewer_access TEXT DEFAULT 'public',
      password TEXT,
      views INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // SCHEMA UPGRADE (Add columns if they don't exist in old DB)
  db.run("ALTER TABLE streams ADD COLUMN thumbnail TEXT", err => { });
  db.run("ALTER TABLE streams ADD COLUMN camera_access TEXT DEFAULT 'public'", err => { });
  db.run("ALTER TABLE streams ADD COLUMN viewer_access TEXT DEFAULT 'public'", err => { });
  db.run("ALTER TABLE streams ADD COLUMN password TEXT", err => { });
  db.run("ALTER TABLE streams ADD COLUMN views INTEGER DEFAULT 0", err => { });
  db.run("ALTER TABLE streams ADD COLUMN views INTEGER DEFAULT 0", err => { });
  db.run("ALTER TABLE users ADD COLUMN avatar TEXT", err => { });

  // FEEDBACK & ANALYTICS
  db.run(`
    CREATE TABLE IF NOT EXISTS user_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      page_url TEXT,
      category TEXT,
      description TEXT,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS page_analytics (
      path TEXT PRIMARY KEY,
      visit_count INTEGER DEFAULT 1,
      last_visited_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

/* =========================
   MIDDLEWARE (LARGE PAYLOADS FOR IMAGES)
========================= */
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));
app.use(express.static(__dirname + "/public"));

// COOP/COEP for FFmpeg SharedArrayBuffer
app.use((req, res, next) => {
  res.header("Cross-Origin-Opener-Policy", "same-origin");
  res.header("Cross-Origin-Embedder-Policy", "require-corp");
  next();
});

// ANALYTICS MIDDLEWARE
app.use((req, res, next) => {
  if (req.method === "GET" && req.path.endsWith(".html")) {
    const path = req.path === "/" ? "/index.html" : req.path;
    db.run(
      `INSERT INTO page_analytics (path, visit_count, last_visited_at) 
       VALUES (?, 1, CURRENT_TIMESTAMP) 
       ON CONFLICT(path) DO UPDATE SET 
       visit_count = visit_count + 1, 
       last_visited_at = CURRENT_TIMESTAMP`,
      [path],
      (err) => { if (err) console.error("Analytics Error:", err.message); }
    );
  }
  next();
});

app.use(
  session({
    name: "courtstream.sid",
    secret: process.env.SESSION_SECRET || "courtstream-secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      maxAge: 1000 * 60 * 60 * 24 * 7, // 1 week
      sameSite: process.env.NODE_ENV === "production" ? "lax" : "lax"
    }
  })
);

/* =========================
   AUTH ROUTES (USED BY LOGIN / REGISTER)
========================= */
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;

  db.get("SELECT * FROM users WHERE email=?", [email], async (_, user) => {
    if (!user) return res.sendStatus(401);

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.sendStatus(401);

    req.session.user = {
      id: user.id,
      email: user.email,
      avatar: user.avatar
    };

    res.sendStatus(200);
  });
});

app.post("/api/register", async (req, res) => {
  const { email, password } = req.body;
  const hash = await bcrypt.hash(password, 10);

  db.run(
    "INSERT INTO users (email,password) VALUES (?,?)",
    [email, hash],
    err => {
      if (err) return res.status(409).json({ error: "exists" });
      res.sendStatus(200);
    }
  );
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.sendStatus(200));
});

app.get("/me", (req, res) => {
  if (!req.session.user) return res.sendStatus(401);
  res.json(req.session.user);
});

// Multer storage configuration (assuming 'uploads' directory exists)
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    // ISO uploads go to a specific subfolder for better organization
    const dest = file.fieldname === "video" ? "./public/uploads/iso/" : "./public/uploads/";
    cb(null, dest);
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + file.originalname);
  }
});
const upload = multer({ storage: storage });

/* =========================
   ISO STATE MANAGEMENT
========================= */
const sessionUploads = {}; // { sessionId: { camId: filePath } }

/* =========================
   API ROUTES
========================= */
app.get("/api/turn-credentials", (req, res) => {
  // Return TURN credentials from environment variables for frontend security
  res.json({
    iceServers: [
      {
        urls: ["stun:stun.cloudflare.com:3478", "stun:stun.cloudflare.com:53"]
      },
      {
        urls: [
          "turn:turn.cloudflare.com:3478?transport=udp",
          "turn:turn.cloudflare.com:3478?transport=tcp",
          "turns:turn.cloudflare.com:5349?transport=tcp",
          "turn:turn.cloudflare.com:53?transport=udp",
          "turn:turn.cloudflare.com:80?transport=tcp",
          "turns:turn.cloudflare.com:443?transport=tcp"
        ],
        username: process.env.TURN_USERNAME || "g07ef1b745ad2a747da14d563e4bfbd538f21945297c2fad25578fb243c68286",
        credential: process.env.TURN_PASSWORD || "3882b29cc1772be95d469efdb14ccd45ed1b79ec8c52d9e0d8070720e093b43d"
      }
    ]
  });
});



/* =========================
   STREAM ROUTES (INDEX / CREATE)
========================= */
app.get("/api/streams", (req, res) => {
  db.all(
    "SELECT id, name, creator, camera_access, viewer_access, created_at FROM streams ORDER BY created_at DESC",
    [],
    (err, rows) => {
      if (err) {
        console.error("DB Error in /api/streams:", err);
        return res.status(500).json({ error: "DB error" });
      }
      if (!rows) return res.json([]);

      const enriched = rows.map(row => {
        const room = io.sockets.adapter.rooms.get(row.id);
        let isLive = false;
        if (room) {
          for (const socketId of room) {
            const s = io.sockets.sockets.get(socketId);
            if (s && s.data.role === 'director') {
              isLive = true;
              break;
            }
          }
        }
        return {
          ...row,
          isLive,
          camera_access: row.camera_access || 'public',
          viewer_access: row.viewer_access || 'public'
        };
      });
      res.json(enriched);
    }
  );
});

// ISO Upload Endpoint
app.post("/api/upload-iso", upload.single("video"), (req, res) => {
  if (!req.file) return res.status(400).send("No file uploaded");

  const { sessionId, camId } = req.body; // Sent by client via FormData

  if (sessionId && camId) {
    if (!sessionUploads[sessionId]) sessionUploads[sessionId] = {};
    sessionUploads[sessionId][camId] = req.file.path;
    console.log(`💾 ISO Upload Logged: Session ${sessionId} | Cam ${camId} -> ${req.file.filename}`);
  }

  res.json({
    success: true,
    filename: req.file.filename,
    path: `/uploads/iso/${req.file.filename}`
  });
});

// ISO Render Endpoint
app.post("/api/render-iso", async (req, res) => {
  const { sessionId, edl, room } = req.body; // room added for progress broadcast

  if (!sessionId || !edl || !Array.isArray(edl) || edl.length === 0) {
    return res.status(400).json({ error: "Invalid data" });
  }

  const uploads = sessionUploads[sessionId];
  if (!uploads) {
    return res.status(404).json({ error: `No recordings found for session ${sessionId}. Wait for uploads to finish.` });
  }

  const outputFilename = `render_${sessionId}.mp4`;
  const outputPath = path.join(__dirname, "public", "uploads", "iso", outputFilename);

  // VERIFY ALL SOURCE FILES EXIST
  const missingFiles = [];
  const uniqueCams = [...new Set(edl.map(cut => cut.camId))];
  uniqueCams.forEach(camId => {
    const filePath = uploads[camId];
    if (!filePath || !fs.existsSync(filePath)) {
      missingFiles.push(camId);
    }
  });

  if (missingFiles.length > 0) {
    console.error(`❌ Render Aborted: Missing files for cameras: ${missingFiles.join(", ")}`);
    return res.status(400).json({
      error: `Missing recording files for cameras: ${missingFiles.join(", ")}. Please ensure uploads are complete.`,
      missingCams: missingFiles
    });
  }

  console.log(`🎬 Starting Render for Session ${sessionId} (${edl.length} clips)...`);

  const broadcastProgress = (progress, status) => {
    if (room) {
      // console.log(`📢 Broadcasting progress to ${room}: ${progress}% - ${status}`);
      io.to(room).emit("render-progress", { sessionId, progress, status });
    } else {
      console.warn("⚠️ No room provided for progress broadcast");
    }
  };

  // Create temp dir for segments
  const tempDir = path.join(__dirname, "public", "uploads", "iso", "temp_" + sessionId);
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

  try {
    const listPath = path.join(tempDir, "list.txt");
    const segments = [];

    // PROCESS CLIPS
    for (let i = 0; i < edl.length; i++) {
      const cut = edl[i];
      const nextCut = edl[i + 1];

      let duration = null;
      if (nextCut) {
        duration = (nextCut.timestamp - cut.timestamp) / 1000;
      }

      // Start time relative to recording start (ms -> s)
      const startTime = cut.timestamp / 1000;
      const camId = cut.camId;
      const inputPath = uploads[camId];

      if (!inputPath) {
        console.warn(`⚠️ Skipped Clip ${i}: No file for Cam '${camId}'`);
        console.log(`Debug Mapping - Session: ${sessionId}, Expected CamId: '${camId}', Available:`, Object.keys(uploads));
        continue;
      }

      console.log(`🎬 Clip ${i}: Using Cam '${camId}' [${inputPath}]`);

      broadcastProgress(Math.round((i / edl.length) * 80), `Processing clip ${i + 1}/${edl.length}`);

      const segmentPath = path.join(tempDir, `seg_${i}.mp4`);
      segments.push(segmentPath);

      console.log(`✂️ Processing Clip ${i}: Cam ${camId} @ ${startTime}s (${duration ? duration + 's' : 'end'})`);

      await new Promise((resolve, reject) => {
        let cmd = ffmpeg(inputPath).setStartTime(startTime);
        if (duration) cmd.setDuration(duration);

        cmd
          .videoFilters([
            "scale=1280:720:force_original_aspect_ratio=decrease",
            "pad=1280:720:(ow-iw)/2:(oh-ih)/2",
            "setsar=1",
            "format=yuv420p"
          ])
          .outputOptions([
            "-c:v libx264",
            "-preset ultrafast",
            "-crf 23",
            "-r 30",
            "-c:a aac",
            "-ar 44100",
            "-force_key_frames expr:gte(t,n_forced*2)" // Force keyframes for smoother concat
          ])
          .on("start", (cmdLine) => {
            console.log(`🎬 FFmpeg Started Clip ${i}: ${cmdLine}`);
          })
          .on("progress", (p) => {
            // Optional: more granular progress logging if needed
          })
          .save(segmentPath)
          .on("end", () => {
            console.log(`✅ Clip ${i} processed`);
            resolve();
          })
          .on("error", (err) => {
            console.error(`❌ Error processing clip ${i} (Cam ${camId}):`, err.message);
            reject(new Error(`Clip ${i} (Cam ${camId}) failed: ${err.message}`));
          });
      });
    }

    // CONCAT
    broadcastProgress(85, "Concatenating segments...");
    console.log("🔗 Concatenating segments...");
    const fileListContent = segments.map(p => `file '${p}'`).join("\n");
    fs.writeFileSync(listPath, fileListContent);

    await new Promise((resolve, reject) => {
      ffmpeg()
        .input(listPath)
        .inputOptions(["-f concat", "-safe 0"])
        .outputOptions("-c copy")
        .save(outputPath)
        .on("end", resolve)
        .on("error", (err) => {
          console.error("Concat Error:", err.message);
          reject(new Error("Final concat failed: " + err.message));
        });
    });

    // Cleanup segments
    fs.rmSync(tempDir, { recursive: true, force: true });

    // --- NEW: Convert Source Files to MP4 for Download ---
    broadcastProgress(90, "Converting source files to MP4...");
    const sourceFilesInfo = [];
    const uniqueCamIds = Object.keys(uploads);

    for (let i = 0; i < uniqueCamIds.length; i++) {
      const camId = uniqueCamIds[i];
      const inputPath = uploads[camId];

      // Skip if already MP4 (unlikely given current upload logic, but good for safety)
      if (inputPath.endsWith(".mp4")) {
        sourceFilesInfo.push({
          camId,
          url: `/uploads/iso/${path.basename(inputPath)}`,
          filename: path.basename(inputPath)
        });
        continue;
      }

      const mp4Filename = path.basename(inputPath, path.extname(inputPath)) + ".mp4";
      const mp4Path = path.join(__dirname, "public", "uploads", "iso", mp4Filename);

      // Convert if doesn't exist
      if (!fs.existsSync(mp4Path)) {
        console.log(`🔄 Converting Source ${camId} to MP4...`);
        broadcastProgress(90 + Math.floor((i / uniqueCamIds.length) * 9), `Converting Camera ${camId}... (H-Quality)`);

        await new Promise((resolve) => {
          const timeout = setTimeout(() => {
            console.warn(`⏳ Timeout converting ${camId}, falling back to WebM`);
            resolve();
          }, 60000); // 60s max per file for high-quality conversion

          ffmpeg(inputPath)
            .outputOptions([
              "-c:v libx264",
              "-preset ultrafast",
              "-crf 23",
              "-c:a aac"
            ])
            .save(mp4Path)
            .on("end", () => {
              clearTimeout(timeout);
              console.log(`✅ Converted ${camId} to MP4`);
              resolve();
            })
            .on("error", (err) => {
              clearTimeout(timeout);
              console.error(`❌ Failed to convert ${camId}:`, err.message);
              // Fallback to original if conversion fails
              resolve();
            });
        });
      }

      // Add MP4 if exists, else fallback to original
      if (fs.existsSync(mp4Path)) {
        sourceFilesInfo.push({
          camId,
          url: `/uploads/iso/${mp4Filename}`,
          filename: mp4Filename
        });
      } else {
        sourceFilesInfo.push({
          camId,
          url: `/uploads/iso/${path.basename(inputPath)}`,
          filename: path.basename(inputPath)
        });
      }
    }

    broadcastProgress(100, "Render Complete");
    console.log(`✅ Render Success: ${outputFilename}`);

    res.json({
      success: true,
      url: `/uploads/iso/${outputFilename}`,
      sourceFiles: sourceFilesInfo
    });

  } catch (e) {
    console.error("❌ Render Failed:", e.message);
    broadcastProgress(-1, `Render Failed: ${e.message}`);
    // Cleanup on error
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/streams", (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "Unauthorized" });

  const id = crypto.randomUUID();
  const { name, thumbnail, camera_access, viewer_access, password } = req.body;

  if (!name || name.length < 3) {
    return res.status(400).json({ error: "invalid name" });
  }

  db.run(
    "INSERT INTO streams (id,name,creator,camera_access,viewer_access,password) VALUES (?,?,?,?,?,?)",
    [id, name, req.session.user.id, camera_access || 'public', viewer_access || 'public', password || ''],
    err => {
      if (err) return res.status(409).json({ error: "exists" });
      res.json({ id });
    }
  );
});

app.delete("/api/streams/:id", (req, res) => {
  if (!req.session.user) return res.status(401).json({ error: "Unauthorized" });
  const { id } = req.params;
  db.run("DELETE FROM streams WHERE id = ? AND creator = ?", [id, req.session.user.id], function (err) {
    if (err) return res.status(500).json({ error: err.message });
    if (this.changes === 0) return res.status(404).json({ error: "Stream not found or unauthorized" });
    res.json({ success: true });
  });
});

/* =========================
   FEEDBACK & ADMIN API
========================= */
app.post("/api/feedback", (req, res) => {
  const { page_url, category, description, metadata } = req.body;
  if (!description) return res.status(400).json({ error: "Description required" });

  db.run(
    "INSERT INTO user_feedback (page_url, category, description, metadata) VALUES (?, ?, ?, ?)",
    [page_url, category, description, JSON.stringify(metadata)],
    function (err) {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, id: this.lastID });
    }
  );
});

app.get("/api/admin/stats", (req, res) => {
  const secret = req.headers["x-admin-secret"];
  const ADMIN_SECRET = process.env.ADMIN_SECRET || "8008";

  if (secret !== ADMIN_SECRET) {
    return res.status(403).json({ error: "Forbidden" });
  }

  db.all("SELECT * FROM user_feedback ORDER BY created_at DESC", [], (err, feedback) => {
    if (err) return res.status(500).json({ error: err.message });

    db.all("SELECT * FROM page_analytics ORDER BY visit_count DESC", [], (err, analytics) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ feedback, analytics });
    });
  });
});

/* =========================
   SOCKET.IO — WEBRTC (OLD WORKING LOGIC)
========================= */
const roomViewers = {}; // room -> Set(socketId)

io.on("connection", socket => {
  // console.log("🟢 SOCKET CONNECTED:", socket.id);

  socket.on("join", payload => {
    let room = payload;
    let role = null;
    let password = null;

    if (payload && typeof payload === "object") {
      room = payload.room;
      role = payload.role || null;
      password = payload.password || null;
    }

    if (!room) return;

    // Fetch stream info to check access
    db.get("SELECT camera_access, viewer_access, password FROM streams WHERE id = ?", [room], (err, stream) => {
      if (!stream) return;

      const isDirector = role === "director";
      const isViewer = role === "viewer";
      const isCamera = role === "camera" || !role;

      const accessMode = isViewer ? stream.viewer_access : stream.camera_access;

      // EXEMPT DIRECTOR from passcode checks
      if (!isDirector && accessMode === "protected" && stream.password !== password) {
        console.log(`❌ Join Denied for ${socket.id} (role: ${role}) in room ${room}`);
        return socket.emit("join-error", "Invalid passcode");
      }

      // Increment views if viewer successfully joins
      if (isViewer) {
        db.run("UPDATE streams SET views = views + 1 WHERE id = ?", [room]);
      }

      socket.join(room);
      socket.room = room;
      socket.data.role = role; // Official Socket.IO way to store metadata
      socket.data.clientId = payload.clientId || null; // Persistent client ID
      socket.emit("join-success");

      console.log(`👤 ${socket.id} joined room ${room} as ${role} (Client: ${socket.data.clientId})`);

      const clients = io.sockets.adapter.rooms.get(room) || new Set();
      const others = [...clients].filter(id => id !== socket.id);

      if (isViewer) {
        if (!roomViewers[room]) roomViewers[room] = new Set();
        roomViewers[room].add(socket.id);
        io.to(room).emit("viewer-count", roomViewers[room].size);
      }

      // Send existing peers to the new joiner
      socket.emit("existing-peers", others.map(id => {
        const s = io.sockets.sockets.get(id);
        return {
          id,
          role: s ? s.data.role : null,
          clientId: s ? s.data.clientId : null
        };
      }));

      // Notify others in the room
      socket.to(room).emit("peer-joined", {
        id: socket.id,
        role: socket.data.role,
        clientId: socket.data.clientId
      });

      // DISCOVERY IMPROVEMENT: If Director joins, tell others to re-announce
      if (isDirector) {
        console.log(`🎬 Director discovery request for room ${room}`);
        socket.to(room).emit("discovery-request");
      }

      // BINGO: If viewer, notify director immediately after join is consolidated
      if (isViewer) {
        console.log(`📡 Auto-notifying director in ${room} of viewer ${socket.id}`);
        socket.to(room).emit("viewer-ready", { id: socket.id });
      }
    });
  });

  socket.on("signal", ({ to, data }) => {
    console.log(`📡 Signal: ${socket.id} -> ${to} (${data && data.type ? data.type : (data && data.candidate ? 'candidate' : 'unknown')})`);
    io.to(to).emit("signal", { from: socket.id, data });
  });

  socket.on("control", ({ to, data }) => {
    io.to(to).emit("control", { from: socket.id, data });
  });

  socket.on("viewer-ready", ({ room }) => {
    // console.log(`📡 Relaying viewer-ready for ${socket.id} in room ${room}`);
    socket.to(room).emit("viewer-ready", { id: socket.id });
  });

  /* ===== ENGAGEMENT FEATURES ===== */
  socket.on("chat-message", ({ room, name, text }) => {
    io.to(room).emit("chat-message", { name, text, time: Date.now() });
  });

  socket.on("reaction", ({ room, type }) => {
    io.to(room).emit("reaction", { type });
  });

  /* ===== ISO RECORDING EVENTS ===== */
  socket.on("start-iso", ({ room, sessionId }) => {
    // Relay to all cameras in the room
    console.log(`🎥 Starting ISO Recording for Session ${sessionId} in Room ${room}`);
    socket.to(room).emit("start-iso", { sessionId });
  });

  socket.on("stop-iso", ({ room, options }) => {
    console.log(`🛑 Stopping ISO Recording for Room ${room}`, options);
    socket.to(room).emit("stop-iso", options);
  });

  socket.on("iso-upload-complete", ({ room, filename }) => {
    // Notify director that a camera has finished uploading
    console.log(`✅ ISO Upload Complete: ${filename}`);
    socket.to(room).emit("iso-upload-complete", { filename, from: socket.id });
  });

  socket.on("iso-upload-progress", ({ room, progress }) => {
    // Relay upload progress to director
    socket.to(room).emit("iso-upload-progress", { from: socket.id, progress });
  });

  socket.on("disconnect", () => {
    if (socket.room) {
      if (socket.data.role === 'viewer' && roomViewers[socket.room]) {
        roomViewers[socket.room].delete(socket.id);
        io.to(socket.room).emit("viewer-count", roomViewers[socket.room].size);
      }

      const payload = { id: socket.id };
      socket.to(socket.room).emit("peer-left", payload);
      socket.to(socket.room).emit("camera-left", payload);
    }
  });
});

/* =========================
   START
========================= */
server.listen(PORT, "0.0.0.0", () => {
  console.log("✅ CourtStream running on port", PORT);
});

// 404 Handler (MUST BE LAST)
app.use((req, res) => {
  res.status(404).send("Page not found");
});
