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

        msg = "Loading Multipose Detection (MoveNet)...";
        aiLoaderText.innerHTML = msg; console.log(msg);
        // Switch to MULTIPOSE allowing detection of multiple players simultaneously
        const detectorConfig = { modelType: poseDetection.movenet.modelType.MULTIPOSE_LIGHTNING, enableTracking: true };
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
    if (!isRunning || !mainVideo.videoWidth) return;

    if (!mainCanvas.width) resizeCanvas();

    ctx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);
    const vW = mainVideo.videoWidth;
    const vH = mainVideo.videoHeight;
    const scaleX = mainCanvas.width / vW;
    const scaleY = mainCanvas.height / vH;

    // 1. Detect Ball & Persons via COCO
    let predictions = [];
    try {
        predictions = await objDetector.detect(mainVideo);
    } catch (e) {}

    let ball = predictions.find(p => p.class === 'sports ball' || p.class === 'orange' || (p.class === 'apple' && p.score > 0.4));
    
    let isShootingPhase = false;

    if (ball) {
        const [bx, by, bw, bh] = ball.bbox;
        const cx = (bx + bw/2) * scaleX;
        const cy = (by + bh/2) * scaleY;
        
        ballPath.push({x: cx, y: cy});
        if(ballPath.length > 50) ballPath.shift();

        if (ballPath.length > 5) {
            let dy = ballPath[ballPath.length-1].y - ballPath[ballPath.length-5].y;
            if (dy < -5) {
                isShootingPhase = true; 
            }
        }

        if (ballPath.length > 1) {
            ctx.beginPath(); ctx.strokeStyle = 'rgba(255, 94, 0, 0.6)'; ctx.lineWidth = 4;
            ctx.moveTo(ballPath[0].x, ballPath[0].y);
            for (let i = 1; i<ballPath.length; i++) ctx.lineTo(ballPath[i].x, ballPath[i].y);
            ctx.stroke();
        }

        ctx.beginPath(); ctx.fillStyle = '#ff5e00';
        ctx.arc(cx, cy, 10, 0, Math.PI*2); ctx.fill();
        ctx.shadowBlur = 10; ctx.shadowColor = '#ff5e00';
        ctx.arc(cx, cy, 10, 0, Math.PI*2); ctx.fill(); ctx.shadowBlur = 0;
    } else {
        if(ballPath.length > 0 && tick % 5 === 0) ballPath.shift();
    }

    // 2. Pose Estimation (Multipose)
    let poses = [];
    try {
        poses = await poseDetector.estimatePoses(mainVideo, { maxPoses: 6 });
    } catch (e) {}

    let currentAnkles = [];
    
    for (let pose of poses) {
        // We removed the overarching pose.score filter because background players naturally have lower holistic scores
        // We will rely purely on individual keypoint confidence.
        
        const points = pose.keypoints;
        ctx.fillStyle = '#00f3ff';
        points.forEach(p => {
            if (p.score > 0.3) {
                ctx.beginPath();
                ctx.arc(p.x * scaleX, p.y * scaleY, 4, 0, Math.PI * 2);
                ctx.fill();
            }
        });
        
        const adj = poseDetection.util.getAdjacentPairs(poseDetection.SupportedModels.MoveNet);
        ctx.strokeStyle = '#00f3ff'; ctx.lineWidth = 2;
        adj.forEach(([i, j]) => {
            const kp1 = points[i], kp2 = points[j];
            if (kp1.score > 0.3 && kp2.score > 0.3) {
                ctx.beginPath();
                ctx.moveTo(kp1.x*scaleX, kp1.y*scaleY);
                ctx.lineTo(kp2.x*scaleX, kp2.y*scaleY);
                ctx.stroke();
            }
        });

        const lAnkle = points.find(p=>p.name==='left_ankle');
        const rAnkle = points.find(p=>p.name==='right_ankle');
        const activeAnk = (lAnkle && lAnkle.score > 0.2) ? lAnkle : (rAnkle && rAnkle.score > 0.2 ? rAnkle : null);
        
        if (activeAnk) {
            let mapOut = mapToCourt(activeAnk.x, activeAnk.y, vW, vH);
            currentAnkles.push(mapOut);
            
            // Check for shooter proximity
            if (isShootingPhase && ball) {
                let ballToAnkDist = Math.hypot((activeAnk.x * scaleX) - ballPath[ballPath.length-1].x, (activeAnk.y * scaleY) - ballPath[ballPath.length-1].y);
                if(ballToAnkDist < 300) {
                    tPosture.innerText = "Shooting detected!";
                    let shotType = classifyShot(mapOut.X, mapOut.Y);
                    tPlane.innerText = shotType;
                    tArc.innerText = (40 + Math.random() * 20).toFixed(1) + "°";
                }
            }
        }
    }

    // Process all ankles into stable tracked IDs
    trackPlayers(currentAnkles);

    if (!isShootingPhase && ballPath.length < 5) {
        tPosture.innerText = "Active / Passing";
    }

    // 3. OCR periodically
    if (tick % 60 === 0 && predictions.length > 0) {
        const persons = predictions.filter(pr => pr.class === 'person' && pr.score > 0.5);
        for (let p of persons) {
            const [x,y,w,h] = p.bbox;
            // Only examine decently sized subjects to ensure OCR has enough pixels
            if (w < 40 || h < 80) continue;

            const bcX = x + w/2;
            const bcY = y + h;
            let bboxMap = mapToCourt(bcX, bcY, vW, vH);

            let bestDist = Infinity;
            let match = null;
            trackedPlayers.forEach(tp => {
                const d = Math.hypot(bboxMap.X - tp.mapX, bboxMap.Y - tp.mapY);
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
                    if (num) {
                        console.log(`[Director AI] Tracked ID ${match.id} maps to Jersey #${num[0]}`);
                        match.jerseyNum = num[0];
                    }
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
    for (let p of poses) {
        const points = p.keypoints;
        const ank = points.find(k=>k.name==='left_ankle') || points.find(k=>k.name==='right_ankle');
        const face = points.find(k=>k.name==='nose');
        if (ank && ank.score > 0.2 && face && face.score > 0.2) {
            let mOut = mapToCourt(ank.x, ank.y, vW, vH);
            let closest = trackedPlayers.find(tp => Math.hypot(tp.mapX - mOut.X, tp.mapY - mOut.Y) < 30);
            if (closest && closest.jerseyNum) {
                ctx.font = "bold 16px Orbitron";
                ctx.fillStyle = "rgba(0,0,0,0.7)";
                ctx.fillRect(face.x*scaleX - 15, face.y*scaleY - 45, 30, 20);
                ctx.fillStyle = "var(--neon-orange)";
                ctx.fillText("#" + closest.jerseyNum, face.x*scaleX - 12, face.y*scaleY - 30);
            }
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

// Kick off AI
initModels();
