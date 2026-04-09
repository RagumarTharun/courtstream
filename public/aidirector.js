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

// Dynamic Safe Optical Flow Extractor
const motionCanvas = document.createElement('canvas');
const motionCtx = motionCanvas.getContext('2d', { willReadFrequently: true });
let prevImageData = null;

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
                jerseyNum: Math.floor(Math.random() * 99) + 1, // Auto-Generate Identity directly into proximity engine
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

    let ball = predictions.find(p => p.class === 'sports ball' && p.score > 0.15 && p.bbox[2] < 80);
    
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

    // Autonomous Hardware Kickstart: If track coordinate engine drops completely at stream genesis, natively force structural tracking grid to initialize on the first detected physical entity!
    if (lastBallX === null && currentPersonsOnMap.length > 0) {
        let rootAnchor = currentPersonsOnMap[0].bbox;
        lastBallX = rootAnchor.x + rootAnchor.w / 2;
        lastBallY = rootAnchor.y + rootAnchor.h / 2;
    }

    // 2. Pose Estimation (Telemetry & Motion Logic on Primary Players via Smart Cropping)
    let poses = [];
    try {
        if (lastBallX !== null) {
            let cw = Math.floor(vH * 0.75); let ch = Math.floor(vH * 0.75);
            if (offC.width !== cw) { offC.width = cw; offC.height = ch; }

            let sx = lastBallX - (cw / 2); let sy = lastBallY - (ch * 0.75); 
            sx = Math.max(0, Math.min(sx, vW - cw)); sy = Math.max(0, Math.min(sy, vH - ch));

            offCtx.drawImage(mainVideo, sx, sy, cw, ch, 0, 0, cw, ch);
            poses = await poseDetector.estimatePoses(offC);

            // Transpose the regional output coordinates back onto the global coordinate frame!
            for (let pose of poses) {
                for (let pt of pose.keypoints) {
                    pt.x += sx; pt.y += sy;
                }
            }
        } else {
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
        if (!ball && !foundOpticalBall && lw && rw && lw.score > 0.1 && rw.score > 0.1) {
            skeletonBallX = (lw.x + rw.x) / 2;
            skeletonBallY = Math.max(lw.y, rw.y) + 15; // Basketball inherently rests below hands during dribbling
            foundSkeletonBall = true;
            if (manualOverrideTimer <= 0) { lastBallX = skeletonBallX; lastBallY = skeletonBallY; }
        }

        if (activeAnk) {
            let mapOut = mapToCourt(activeAnk.x, activeAnk.y, vW, vH);
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
    let foundOpticalBall = false;

    // Execute Advanced Optical Pixel-Subtraction to detect high-speed passing natively if AI drops target!
    if (!ball && lastBallX !== null) {
        let activePlayer = currentPersonsOnMap.find(p => Math.abs((p.bbox.x + p.bbox.w/2) - lastBallX) < 100);
        let playerH = activePlayer ? activePlayer.bbox.h : 200; 
        
        // Measure and intuit precise physical limits based purely on Player/Camera orientation scale!
        let ballR = Math.max(10, playerH / 12); 
        let scanR = Math.floor(playerH * 1.5); 
        
        try {
            motionCanvas.width = scanR; motionCanvas.height = scanR;
            let drawX = lastBallX - scanR/2; let drawY = lastBallY - scanR/2;
            
            // Extract bounds cleanly without throwing generic off-screen rendering geometry errors
            motionCtx.drawImage(mainVideo, Math.max(0, drawX), Math.max(0, drawY), scanR, scanR, 0, 0, scanR, scanR);
            let frameImg = motionCtx.getImageData(0,0,scanR,scanR);
            
            if (prevImageData && prevImageData.width === scanR) {
                let maxMotionX = 0, maxMotionY = 0, maxDiff = 0;
                let data1 = frameImg.data; let data2 = prevImageData.data;
                
                for (let y = 0; y < scanR; y+=4) {
                    for (let x = 0; x < scanR; x+=4) {
                        let i = (y * scanR + x) * 4;
                        let r = data1[i], g = data1[i+1], b = data1[i+2];
                        let r2 = data2[i], g2 = data2[i+1], b2 = data2[i+2];
                        let diff = Math.abs(r-r2) + Math.abs(g-g2) + Math.abs(b-b2);
                        
                        // User Request: Find solid round colored objects moving rigorously (diff > 40 implies physical delta motion)
                        if (r > b + 15 && diff > 40) { 
                            if (diff > maxDiff) { maxDiff = diff; maxMotionX = x; maxMotionY = y; }
                        }
                    }
                }
                
                if (maxDiff > 40) {
                    tX = drawX + maxMotionX;
                    tY = drawY + maxMotionY;
                    tW = ballR * 2; tH = ballR * 2;
                    foundOpticalBall = true;
                }
            }
            prevImageData = frameImg;
        } catch(e) { } // Gracefully absorb external URL Chrome CORS Canvas Tainting restrictions unconditionally!
    }

    if (ball) { tX = ball.bbox[0]; tY = ball.bbox[1]; tW = ball.bbox[2]; tH = ball.bbox[3]; } 
    else if (!foundOpticalBall && foundSkeletonBall) { tX = skeletonBallX - 15; tY = skeletonBallY - 15; }
    else if (!foundOpticalBall && lastBallX !== null) { tX = lastBallX - 15; tY = lastBallY + 50; } // Ultimate Graphic Fallback relative to manual tracker!

    if (tX !== null) {
        let cx = (tX + tW/2) * scaleX; let cy = (tY + tH/2) * scaleY;
        
        ctx.beginPath();
        ctx.fillStyle = 'rgba(255, 94, 0, 0.6)';
        ctx.arc(cx, cy, (tW * scaleX) + 8, 0, Math.PI*2);
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = '#ffb300';
        ctx.stroke();
        
        ctx.beginPath(); ctx.fillStyle = '#ffffff'; ctx.arc(cx, cy, 4, 0, Math.PI*2); ctx.fill(); 
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

    // Clean generic readout
    tPosture.innerText = "Active Player Tracking";

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
const speedBtn = document.getElementById('speedBtn');
const timeDisplay = document.getElementById('timeDisplay');
const seekBar = document.getElementById('seekBar');
const seekFill = document.getElementById('seekFill');

let speedVals = [1.0, 0.5, 0.25];
let currSpeedIdx = 0;

speedBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if(!mainVideo.src) return;
    currSpeedIdx = (currSpeedIdx + 1) % speedVals.length;
    mainVideo.playbackRate = speedVals[currSpeedIdx];
    speedBtn.innerText = speedVals[currSpeedIdx] + 'x';
});

playPauseBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if(mainVideo.paused) { mainVideo.play(); playPauseBtn.innerText = '⏸'; }
    else { mainVideo.pause(); playPauseBtn.innerText = '▶'; }
});

document.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
        e.preventDefault(); // Stop page scrolling
        if(mainVideo.paused) { mainVideo.play(); playPauseBtn.innerText = '⏸'; }
        else { mainVideo.pause(); playPauseBtn.innerText = '▶'; }
    }
});

// Also bind strictly to the window DOM to prevent iframe sandbox key drops
window.addEventListener('keydown', (e) => {
    if (e.code === 'Space') {
        e.preventDefault(); 
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

seekBar.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if(!mainVideo.duration) return;
    const rect = seekBar.getBoundingClientRect();
    const pos = Math.max(0, Math.min((e.clientX - rect.left) / rect.width, 1));
    mainVideo.currentTime = pos * mainVideo.duration;
});

// Kick off AI
initModels();
