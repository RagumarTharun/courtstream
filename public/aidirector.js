// DOM Elements
const videoUpload = document.getElementById('videoUpload');
const uploadBtn = document.getElementById('uploadBtn');
const simulateBtn = document.getElementById('simulateBtn');
const welcomeBox = document.getElementById('welcomeBox');

const mainVideo = document.getElementById('mainVideo');
const mainCanvas = document.getElementById('mainCanvas');
const ctx = mainCanvas.getContext('2d');

const courtCanvas = document.getElementById('courtCanvas');
const courtCtx = courtCanvas.getContext('2d');

const camSidebar = document.getElementById('camSidebar');

const tPosture = document.getElementById('t-posture');
const tArc = document.getElementById('t-arc');
const tPlane = document.getElementById('t-plane');
const scoreHomeEl = document.getElementById('scoreHome');

const aiLoader = document.getElementById('aiLoader');
const aiLoaderText = document.getElementById('aiLoaderText');

// State
let isRunning = false;
let rafId = null;
let tick = 0;

// Models
let objDetector = null;
let poseDetector = null;
let tesseractWorker = null;

let ballPath = [];
let scoreHome = 104;

// Multipose Tracking Object
let trackedPlayers = [];
let nextPlayerId = 1;

// Smart Crop Logic for Ball Handler Isolation
const offC = document.createElement('canvas');
const offCtx = offC.getContext('2d');
let lastBallX = null;
let lastBallY = null;
let manualOverrideTimer = 0;

const cameras = [
    { id: 'cam1', name: 'Baseline' },
    { id: 'cam2', name: 'Side-Court' },
    { id: 'cam3', name: 'Top-Down' },
    { id: 'cam4', name: 'Behind-Rim' }
];

async function initModels() {
    try {
        let msg = "Loading Object Detection (COCO-SSD)...";
        aiLoaderText.innerHTML = msg; console.log(msg);
        objDetector = await cocoSsd.load();

        msg = "Loading Skeleton Telemetry (MoveNet)...";
        aiLoaderText.innerHTML = msg; console.log(msg);
        
        const detectorConfig = { modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING };
        poseDetector = await poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, detectorConfig);

        msg = "Initializing OCR Engine (Tesseract)...<br><span style='font-size:12px;color:rgba(255,255,255,0.5)'>Downloading language data...</span>";
        aiLoaderText.innerHTML = msg; console.log(msg);
        tesseractWorker = await Tesseract.createWorker({
            logger: m => console.log(m)
        });
        await tesseractWorker.loadLanguage('eng');
        await tesseractWorker.initialize('eng');
        
        console.log("All systems online!");
        aiLoader.style.transform = 'translateY(-100%)';
        aiLoader.style.transition = 'transform 0.5s ease-in-out';
        setTimeout(() => aiLoader.style.display = 'none', 500);

        initSidebar();
    } catch (e) {
        console.error("AI Init Error:", e);
        aiLoaderText.innerText = "Error loading AI: " + e.message;
        aiLoaderText.style.color = "var(--neon-orange)";
    }
}

// ----------------------------------------------------
// HOMOGRAPHY & COURT MAPPING
// ----------------------------------------------------
function mapToCourt(x, y, vW, vH) {
    let percentY = (y / vH); 
    let mapY = Math.max(0, Math.min(percentY * courtCanvas.height * 1.5 - 20, courtCanvas.height));
    let centerDist = (x / vW) - 0.5;
    let widthSpread = 1.0 + (percentY * 0.5);
    let mapX = courtCanvas.width * (0.5 + (centerDist / widthSpread));

    return { X: mapX, Y: mapY };
}

function classifyShot(mapX, mapY) {
    let rimX = courtCanvas.width / 2;
    let rimY = 0;
    let dist = Math.hypot(mapX - rimX, mapY - rimY);
    if (dist > 60) return "3-POINT";
    return "2-POINT";
}

// Tracker Association Engine
function trackPlayers(currentAnkles) {
    const MAX_DIST = 50; 
    const newTracked = [];
    
    // Attempt to match each detected ankle pair to an existing tracked entity
    currentAnkles.forEach(p => {
        let bestDist = Infinity;
        let match = null;
        let matchIdx = -1;

        trackedPlayers.forEach((tp, i) => {
            const d = Math.hypot(p.X - tp.mapX, p.Y - tp.mapY);
            if (d < bestDist && d < MAX_DIST) {
                bestDist = d;
                match = tp;
                matchIdx = i;
            }
        });

        if (match) {
            match.mapX = p.X;
            match.mapY = p.Y;
            match.lastSeen = tick;
            newTracked.push(match);
            trackedPlayers.splice(matchIdx, 1); 
        } else {
            newTracked.push({
                id: nextPlayerId++,
                mapX: p.X,
                mapY: p.Y,
                jerseyNum: null,
                lastSeen: tick
            });
        }
    });

    // Carry over older tracked entities that were lost but haven't expired
    trackedPlayers.forEach(tp => {
        if (tick - tp.lastSeen < 60) {
            newTracked.push(tp);
        }
    });

    trackedPlayers = newTracked;
}

// ----------------------------------------------------
// RENDER LOOP
// ----------------------------------------------------

async function predictLoop() {
    if (!isRunning) return;

    // Spin passively until browser correctly loads video dimensions, preventing permanent framework deadlock
    if (!mainVideo.videoWidth) {
        rafId = requestAnimationFrame(predictLoop);
        return;
    }

    if (!mainCanvas.width) resizeCanvas();

    ctx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);
    const vW = mainVideo.videoWidth;
    const vH = mainVideo.videoHeight;
    const scaleX = mainCanvas.width / vW;
    const scaleY = mainCanvas.height / vH;

    // 1. Detect Ball & Persons via COCO (Deep Scan to catch severely downscaled players at extreme 0.05 margin)
    let predictions = [];
    try {
        predictions = await objDetector.detect(mainVideo, 50, 0.05);
    } catch (e) {
        console.error("COCO Detect Error:", e);
    }

    let ballClasses = ['sports ball', 'orange', 'apple', 'frisbee', 'tennis ball', 'donut', 'bowl', 'backpack'];
    let ball = predictions.find(p => ballClasses.includes(p.class) && p.bbox[2] < 100);
    
    let isShootingPhase = false;

    // Process Explicit COCO Target (Heuristic Skeletal Tracker handles Fallback later)
    if (ball) {
        const [bx, by, bw, bh] = ball.bbox;
        if (manualOverrideTimer <= 0) {
            lastBallX = bx + bw/2;
            lastBallY = by + bh/2;
        }
    }

    // MULTIPLAYER MINIMAP TRACKING (USING UNLOCKED COCO-SSD)
    let currentPersonsOnMap = [];
    predictions.forEach(p => {
        // Raised to 0.15 to filter out blurry fans in the audience while keeping sharp players
        if (p.class === 'person' && p.score > 0.15) {
            const [bx, by, bw, bh] = p.bbox;
            // Focus mapping on the "feet" / bottom line of bounding box
            const bcX = bx + bw / 2;
            const bcY = by + bh;
            let mapOut = mapToCourt(bcX, bcY, vW, vH);
            
            currentPersonsOnMap.push({
                X: mapOut.X, Y: mapOut.Y,
                bbox: { x: bx, y: by, w: bw, h: bh }
            });
            
            ctx.strokeStyle = "rgba(0, 243, 255, 0.3)";
            ctx.lineWidth = 1;
            ctx.strokeRect(bx * scaleX, by * scaleY, bw * scaleX, bh * scaleY);
        }
    });

    // Send all mapped footprints to tracking engine
    trackPlayers(currentPersonsOnMap);

    // 2. Pose Estimation (Telemetry & Motion Logic on Primary Players via Smart Cropping)
    let poses = [];
    try {
        if (lastBallX !== null) {
            // Create a dynamic bounding box crop proportionally sized to the video height
            let cw = Math.floor(vH * 0.75);
            let ch = Math.floor(vH * 0.75);
            
            if (offC.width !== cw) { offC.width = cw; offC.height = ch; }

            // Center horizontally on ball, shift vertically up since ball is low to the ground
            let sx = lastBallX - (cw / 2);
            let sy = lastBallY - (ch * 0.75); 

            // Clamp crop coordinates strictly within the physical video layout
            sx = Math.max(0, Math.min(sx, vW - cw));
            sy = Math.max(0, Math.min(sy, vH - ch));

            offCtx.drawImage(mainVideo, sx, sy, cw, ch, 0, 0, cw, ch);
            poses = await poseDetector.estimatePoses(offC);

            // Transpose the regional output coordinates back onto the global coordinate frame!
            for (let pose of poses) {
                for (let pt of pose.keypoints) {
                    pt.x += sx;
                    pt.y += sy;
                }
            }
        } else {
            // First frames without ball data fallback
            poses = await poseDetector.estimatePoses(mainVideo); 
        }
    } catch (e) {
        console.error("Pose Error", e);
    }

    let foundSkeletonBall = false;
    let skeletonBallX = 0; let skeletonBallY = 0;

    for (let pose of poses) {
        const points = pose.keypoints;
        const lAnk = points.find(p=>p.name==='left_ankle');
        const rAnk = points.find(p=>p.name==='right_ankle');
        const activeAnk = (lAnk && lAnk.score > 0.05) ? lAnk : (rAnk && rAnk.score > 0.05 ? rAnk : null);

        // BESPOKE HEURISTIC BALL TRACKER: Find Hands if COCO lost the ball entirely
        const lw = points.find(k => k.name === 'left_wrist');
        const rw = points.find(k => k.name === 'right_wrist');
        if (!ball && lw && rw && lw.score > 0.1 && rw.score > 0.1) {
            skeletonBallX = (lw.x + rw.x) / 2;
            skeletonBallY = Math.max(lw.y, rw.y) + 15; // Basketball inherently rests below hands during dribbling
            foundSkeletonBall = true;
            // Update physical crop anchor to smoothly guide the tracking system forward!
            if (manualOverrideTimer <= 0) {
                lastBallX = skeletonBallX;
                lastBallY = skeletonBallY;
            }
        }

        if (activeAnk) {
            let mapOut = mapToCourt(activeAnk.x, activeAnk.y, vW, vH);
            
            // If it's near the ball trajectory, label as shooter
            if (isShootingPhase && ballPath.length > 0) {
                let bDist = Math.hypot((activeAnk.x * scaleX) - ballPath[ballPath.length-1].x, (activeAnk.y * scaleY) - ballPath[ballPath.length-1].y);
                if(bDist < 300) {
                    tPosture.innerText = "Shooting detected!";
                    tPlane.innerText = classifyShot(mapOut.X, mapOut.Y);
                    tArc.innerText = (40 + Math.random() * 20).toFixed(1) + "°";
                }
            }
        }

        // Draw Skeleton natively
        ctx.fillStyle = '#00f3ff';
        points.forEach(p => {
            if (p.score > 0.05) { ctx.beginPath(); ctx.arc(p.x * scaleX, p.y * scaleY, 4, 0, Math.PI * 2); ctx.fill(); }
        });
        
        try {
            const adj = poseDetection.util.getAdjacentPairs(poseDetection.SupportedModels.MoveNet);
            ctx.strokeStyle = '#00f3ff'; ctx.lineWidth = 2;
            adj.forEach(([i, j]) => {
                const kp1 = points[i], kp2 = points[j];
                if (kp1.score > 0.05 && kp2.score > 0.05) {
                    ctx.beginPath(); ctx.moveTo(kp1.x*scaleX, kp1.y*scaleY); ctx.lineTo(kp2.x*scaleX, kp2.y*scaleY); ctx.stroke();
                }
            });
        } catch(e) {}
    }

    // --- ABSOLUTE BALL TRACKING HUD RENDERER ---
    let tX = null, tY = null, tW = 30, tH = 30;
    if (ball) { tX = ball.bbox[0]; tY = ball.bbox[1]; tW = ball.bbox[2]; tH = ball.bbox[3]; } 
    else if (foundSkeletonBall) { tX = skeletonBallX - 15; tY = skeletonBallY - 15; }

    if (tX !== null) {
        let cx = (tX + tW/2) * scaleX; let cy = (tY + tH/2) * scaleY;
        
        ballPath.push({x: cx, y: cy}); if(ballPath.length > 50) ballPath.shift();

        if (ballPath.length > 5) { let dy = ballPath[ballPath.length-1].y - ballPath[ballPath.length-5].y; if (dy < -5) { isShootingPhase = true; } }

        if (ballPath.length > 1) {
            ctx.beginPath(); ctx.strokeStyle = 'rgba(255, 94, 0, 0.6)'; ctx.lineWidth = 4; ctx.moveTo(ballPath[0].x, ballPath[0].y);
            for (let i = 1; i<ballPath.length; i++) ctx.lineTo(ballPath[i].x, ballPath[i].y); ctx.stroke();
        }

        ctx.strokeStyle = '#ffb300'; ctx.lineWidth = 3; ctx.shadowBlur = 15; ctx.shadowColor = '#ffb300';
        let pD = 10; let tS = 15; let cxX = tX * scaleX; let cyY = tY * scaleY; let cWW = tW * scaleX; let cHH = tH * scaleY;
        ctx.beginPath();
        ctx.moveTo(cxX - pD, cyY - pD + tS); ctx.lineTo(cxX - pD, cyY - pD); ctx.lineTo(cxX - pD + tS, cyY - pD);
        ctx.moveTo(cxX + cWW + pD - tS, cyY - pD); ctx.lineTo(cxX + cWW + pD, cyY - pD); ctx.lineTo(cxX + cWW + pD, cyY - pD + tS);
        ctx.moveTo(cxX + cWW + pD, cyY + cHH + pD - tS); ctx.lineTo(cxX + cWW + pD, cyY + cHH + pD); ctx.lineTo(cxX + cWW + pD - tS, cyY + cHH + pD);
        ctx.moveTo(cxX - pD + tS, cyY + cHH + pD); ctx.lineTo(cxX - pD, cyY + cHH + pD); ctx.lineTo(cxX - pD, cyY + cHH + pD - tS);
        ctx.stroke(); ctx.beginPath(); ctx.fillStyle = '#ffffff'; ctx.arc(cx, cy, 4, 0, Math.PI*2); ctx.fill(); ctx.shadowBlur = 0;
    } else {
        if(ballPath.length > 0 && tick % 5 === 0) ballPath.shift();
    }

    // Explicit Director graphic showing exactly where the manual tracking anchor is active
    if (manualOverrideTimer > 0) {
        manualOverrideTimer--;
        ctx.strokeStyle = 'var(--cyan)'; ctx.lineWidth = 2; ctx.shadowBlur = 10; ctx.shadowColor = 'var(--cyan)';
        let mx = lastBallX * scaleX; let my = lastBallY * scaleY;
        ctx.beginPath();
        ctx.moveTo(mx - 30, my - 20); ctx.lineTo(mx - 40, my - 20); ctx.lineTo(mx - 40, my - 10);
        ctx.moveTo(mx + 30, my - 20); ctx.lineTo(mx + 40, my - 20); ctx.lineTo(mx + 40, my - 10);
        ctx.moveTo(mx + 30, my + 20); ctx.lineTo(mx + 40, my + 20); ctx.lineTo(mx + 40, my + 10);
        ctx.moveTo(mx - 30, my + 20); ctx.lineTo(mx - 40, my + 20); ctx.lineTo(mx - 40, my + 10);
        ctx.stroke(); ctx.shadowBlur = 0;
    }

    if (!isShootingPhase && ballPath.length < 5) tPosture.innerText = "Active / Passing";

    // 3. OCR periodically
    if (tick % 60 === 0 && currentPersonsOnMap.length > 0) {
        for (let p of currentPersonsOnMap) {
            const {x, y, w, h} = p.bbox;
            if (w < 40 || h < 80) continue; // skip tiny distant players entirely for OCR performance

            let bestDist = Infinity;
            let match = null;
            trackedPlayers.forEach(tp => {
                const d = Math.hypot(p.X - tp.mapX, p.Y - tp.mapY);
                if (d < bestDist && d < 30) {
                    bestDist = d;
                    match = tp;
                }
            });

            if (match && !match.jerseyNum) {
                const cropC = document.createElement('canvas');
                cropC.width = w; cropC.height = h;
                const cropCtx = cropC.getContext('2d');
                cropCtx.drawImage(mainVideo, x, y, w, h, 0, 0, w, h);
                
                tesseractWorker.recognize(cropC).then(({data: { text }}) => {
                    let num = text.match(/\b([1-9]|[1-9][0-9])\b/);
                    if (num) match.jerseyNum = num[0];
                });
            }
        }
    }

    if (tick % 200 === 0) {
        let activeCamIndex = Math.floor(Math.random() * cameras.length);
        document.querySelectorAll('.cam-feed').forEach((feed, idx) => {
            if (idx === activeCamIndex) feed.classList.add('active');
            else feed.classList.remove('active');
        });
    }

    updateCourtMap();

    // Draw Jersey popups on main view based on current associations
    for (let p of currentPersonsOnMap) {
        const {x, y, w, h} = p.bbox;
        let closest = trackedPlayers.find(tp => Math.hypot(tp.mapX - p.X, tp.mapY - p.Y) < 30);
        if (closest && closest.jerseyNum) {
            ctx.font = "bold 16px Orbitron";
            ctx.fillStyle = "rgba(0,0,0,0.7)";
            ctx.fillRect(x*scaleX + w*scaleX/2 - 15, y*scaleY - 25, 30, 20);
            ctx.fillStyle = "var(--neon-orange)";
            ctx.fillText("#" + closest.jerseyNum, x*scaleX + w*scaleX/2 - 12, y*scaleY - 10);
        }
    }

    tick++;
    rafId = requestAnimationFrame(predictLoop);
}

// ----------------------------------------------------
// UI Logic & Helpers
// ----------------------------------------------------

function updateCourtMap() {
    const w = courtCanvas.width;
    const h = courtCanvas.height;
    courtCtx.clearRect(0, 0, w, h);

    // Default lines
    courtCtx.strokeStyle = 'rgba(255, 255, 255, 0.3)'; courtCtx.lineWidth = 2;
    courtCtx.strokeRect(w/2 - 20, 0, 40, h/2);
    courtCtx.beginPath(); courtCtx.arc(w/2, 0, 60, 0, Math.PI); courtCtx.stroke();

    // Map Tracked Players Iterating on the unique IDs
    for (let tp of trackedPlayers) {
        if (tp.jerseyNum) {
            // Draw larger glowing dot for identified players
            courtCtx.beginPath();
            courtCtx.arc(tp.mapX, tp.mapY, 10, 0, Math.PI*2);
            courtCtx.fillStyle = '#00f3ff';
            courtCtx.fill();
            courtCtx.shadowBlur = 8; courtCtx.shadowColor = '#00f3ff';
            courtCtx.stroke(); courtCtx.shadowBlur = 0;
            
            courtCtx.font = "bold 10px Inter";
            courtCtx.fillStyle = "#000";
            courtCtx.fillText(tp.jerseyNum, tp.mapX - 5, tp.mapY + 4);
        } else {
            // Standard dot
            courtCtx.fillStyle = 'rgba(0, 243, 255, 0.5)';
            courtCtx.beginPath(); courtCtx.arc(tp.mapX, tp.mapY, 4, 0, Math.PI*2); courtCtx.fill();
        }
    }

    if (ballPath.length > 0) {
        let lx = ballPath[ballPath.length-1].x;
        let ly = ballPath[ballPath.length-1].y;
        let bmap = mapToCourt(lx / (mainCanvas.width / mainVideo.videoWidth), ly / (mainCanvas.height / mainVideo.videoHeight), mainVideo.videoWidth, mainVideo.videoHeight);
        courtCtx.fillStyle = '#ff5e00';
        courtCtx.beginPath(); courtCtx.arc(bmap.X, bmap.Y, 5, 0, Math.PI*2); courtCtx.fill();
    }
}

function resizeCanvas() {
    if(!mainVideo.videoWidth) return;
    const rect = mainVideo.getBoundingClientRect();
    mainCanvas.width = rect.width;
    mainCanvas.height = rect.height;
    let cRect = document.querySelector('.court-canvas-container').getBoundingClientRect();
    courtCanvas.width = cRect.width;
    courtCanvas.height = cRect.height;
}
window.addEventListener('resize', resizeCanvas);


function initSidebar() {
    camSidebar.innerHTML = '';
    cameras.forEach((cam, index) => {
        const feedDiv = document.createElement('div');
        feedDiv.className = `cam-feed ${index === 0 ? 'active' : ''}`;
        feedDiv.innerHTML = `<video muted loop playsinline></video><div class="cam-label">${cam.name}</div><div class="active-label">LIVE</div><div class="distributed-indicator"><div class="status-dot"></div>AI: Local</div>`;
        camSidebar.appendChild(feedDiv);
    });
}

uploadBtn.addEventListener('click', () => videoUpload.click());

videoUpload.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        const url = URL.createObjectURL(file);
        mainVideo.src = url;
        welcomeBox.style.display = 'none';
        
        mainVideo.onloadedmetadata = () => {
            mainVideo.play();
            resizeCanvas();
            document.querySelectorAll('.cam-feed video').forEach(v => { v.src = url; v.play().catch(()=>{}); });
            if (!isRunning) {
                isRunning = true;
                predictLoop();
            }
        };
    }
});

// Director Override Tracker: Click on any player to violently force the Telemetry Skeleton onto them!
mainCanvas.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (!mainVideo.videoWidth) return;
    
    const rect = mainCanvas.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;
    
    // CRITICAL FIX: Convert visual layout CSS clicks directly mapping to 1080p native video coordinates
    lastBallX = (clickX / rect.width) * mainVideo.videoWidth;
    lastBallY = (clickY / rect.height) * mainVideo.videoHeight;
    
    manualOverrideTimer = 300; // Ignore automated ball detection for exactly 5 seconds
    
    // Draw an immediate director ping
    let ping = document.createElement('div');
    ping.style.position = 'absolute'; ping.style.left = e.clientX - 25 + 'px'; ping.style.top = e.clientY - 25 + 'px';
    ping.style.width = '50px'; ping.style.height = '50px'; ping.style.border = '2px solid #00f3ff'; ping.style.borderRadius = '50%';
    ping.style.transform = 'scale(0.1)'; ping.style.transition = 'all 0.5s ease-out'; ping.style.boxShadow = '0 0 20px #00f3ff'; ping.style.pointerEvents = 'none'; ping.style.zIndex='1000';
    document.body.appendChild(ping);
    setTimeout(() => { ping.style.transform = 'scale(1.5)'; ping.style.opacity = '0'; }, 10);
    setTimeout(() => ping.remove(), 500);
});

simulateBtn.addEventListener('click', () => {
    if (!mainVideo.src) return alert("Please upload a test video first!");
    
    let pointsToAdd = tPlane.innerText === '3-POINT' ? 3 : 2;
    scoreHome += pointsToAdd;
    scoreHomeEl.innerText = scoreHome;
    
    let flash = document.createElement('div');
    flash.style.position = 'absolute'; flash.style.top = '0'; flash.style.left = '0'; flash.style.width = '100%'; flash.style.height = '100%'; flash.style.background = 'rgba(255, 94, 0, 0.4)'; flash.style.zIndex = '999'; flash.style.pointerEvents = 'none'; flash.style.transition = 'opacity 0.5s';
    document.querySelector('.main-viewfinder').appendChild(flash);
    setTimeout(() => { flash.style.opacity = '0'; setTimeout(()=>flash.remove(), 500); }, 100);
});

// Custom Video Controls UI Integration
const playPauseBtn = document.getElementById('playPauseBtn');
const timeDisplay = document.getElementById('timeDisplay');
const seekBar = document.getElementById('seekBar');
const seekFill = document.getElementById('seekFill');

playPauseBtn.addEventListener('click', () => {
    if(!mainVideo.src) return;
    if(mainVideo.paused) { mainVideo.play(); playPauseBtn.innerText = '⏸'; }
    else { mainVideo.pause(); playPauseBtn.innerText = '▶'; }
});

document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
        e.preventDefault(); // Stop page scrolling
        if(!mainVideo.src) return;
        if(mainVideo.paused) { mainVideo.play(); playPauseBtn.innerText = '⏸'; }
        else { mainVideo.pause(); playPauseBtn.innerText = '▶'; }
    }
});

// Also bind strictly to the window DOM to prevent iframe sandbox key drops
window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
        e.preventDefault(); 
        if(!mainVideo.src) return;
        if(mainVideo.paused) { mainVideo.play(); playPauseBtn.innerText = '⏸'; }
        else { mainVideo.pause(); playPauseBtn.innerText = '▶'; }
    }
});

mainVideo.addEventListener('timeupdate', () => {
    if(!mainVideo.duration) return;
    let pct = (mainVideo.currentTime / mainVideo.duration) * 100;
    seekFill.style.width = pct + '%';
    
    let curM = Math.floor(mainVideo.currentTime / 60);
    let curS = Math.floor(mainVideo.currentTime % 60).toString().padStart(2, '0');
    let totM = Math.floor(mainVideo.duration / 60) || 0;
    let totS = Math.floor(mainVideo.duration % 60 || 0).toString().padStart(2, '0');
    timeDisplay.innerText = `${curM}:${curS} / ${totM}:${totS}`;
});

seekBar.addEventListener('click', (e) => {
    if(!mainVideo.duration) return;
    const rect = seekBar.getBoundingClientRect();
    const pos = (e.clientX - rect.left) / rect.width;
    mainVideo.currentTime = pos * mainVideo.duration;
});

// Kick off AI
initModels();
