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
let playersMap = [];
let detectedJerseys = {};

// Default scoreboard
let scoreHome = 104;

const cameras = [
    { id: 'cam1', name: 'Baseline' },
    { id: 'cam2', name: 'Side-Court' },
    { id: 'cam3', name: 'Top-Down' },
    { id: 'cam4', name: 'Behind-Rim' }
];

async function initModels() {
    try {
        aiLoaderText.innerText = "Loading Object Detection (COCO-SSD)...";
        objDetector = await cocoSsd.load();

        aiLoaderText.innerText = "Loading Posture Detection (Pose)...";
        // To be safe regarding tf.js WebGL backend load, use MoveNet or setup bodyPix/movenet under pose-detection
        const detectorConfig = { modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING };
        poseDetector = await poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, detectorConfig);

        aiLoaderText.innerText = "Initializing OCR Engine...";
        tesseractWorker = await Tesseract.createWorker({
            logger: m => {} // suppress massive logs
        });
        await tesseractWorker.loadLanguage('eng');
        await tesseractWorker.initialize('eng');
        
        // Hide loader
        aiLoader.style.transform = 'translateY(-100%)';
        aiLoader.style.transition = 'transform 0.5s ease-in-out';
        setTimeout(() => aiLoader.style.display = 'none', 500);

        initSidebar();
    } catch (e) {
        console.error("AI Init Error:", e);
        aiLoaderText.innerText = "Error loading AI. See console.";
        aiLoaderText.style.color = "var(--neon-orange)";
    }
}

// ----------------------------------------------------
// HOMOGRAPHY & COURT MAPPING
// ----------------------------------------------------
// We use a simplified projection instead of a full 3x3 matrix multiplication for speed in JS
// Assumes input is a typical side-court standard broadcast angle.
function mapToCourt(x, y, vW, vH) {
    // A simplified interpolation trick
    // Top of key is further back (smaller y in video)
    // Bottom of screen is sideline
    let percentY = (y / vH); 
    // restrict mapping perspective purely for demonstration of homography plane logic
    let mapY = Math.max(0, Math.min(percentY * courtCanvas.height * 1.5 - 20, courtCanvas.height));
    
    // X gets wider as we approach the bottom
    let centerDist = (x / vW) - 0.5;
    let widthSpread = 1.0 + (percentY * 0.5);
    let mapX = courtCanvas.width * (0.5 + (centerDist / widthSpread));

    return { X: mapX, Y: mapY };
}

function classifyShot(mapX, mapY) {
    // Calculate distance from rim (assuming rim is at center top of minimap: courtCanvas.width/2, 0)
    let rimX = courtCanvas.width / 2;
    let rimY = 0;
    let dist = Math.hypot(mapX - rimX, mapY - rimY);
    
    // 3PT radius typically mapped to 60px on this minimal canvas
    if (dist > 60) return "3-POINT";
    return "2-POINT";
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

    let ball = predictions.find(p => p.class === 'sports ball' || p.class === 'orange');
    
    let isShootingPhase = false;

    if (ball) {
        const [bx, by, bw, bh] = ball.bbox;
        const cx = (bx + bw/2) * scaleX;
        const cy = (by + bh/2) * scaleY;
        
        ballPath.push({x: cx, y: cy});
        if(ballPath.length > 50) ballPath.shift();

        // Check motion arc based on Y velocity derivative
        if (ballPath.length > 5) {
            let dy = ballPath[ballPath.length-1].y - ballPath[ballPath.length-5].y;
            if (dy < -5) {
                isShootingPhase = true; 
            }
        }

        // Draw Arc
        if (ballPath.length > 1) {
            ctx.beginPath();
            ctx.strokeStyle = 'rgba(255, 94, 0, 0.6)';
            ctx.lineWidth = 4;
            ctx.moveTo(ballPath[0].x, ballPath[0].y);
            for (let i = 1; i<ballPath.length; i++) ctx.lineTo(ballPath[i].x, ballPath[i].y);
            ctx.stroke();
        }

        // Trace Ball
        ctx.beginPath(); ctx.fillStyle = '#ff5e00';
        ctx.arc(cx, cy, 10, 0, Math.PI*2);
        ctx.fill();
        ctx.shadowBlur = 10; ctx.shadowColor = '#ff5e00';
        ctx.arc(cx, cy, 10, 0, Math.PI*2); ctx.fill(); ctx.shadowBlur = 0;
    } else {
        if(ballPath.length > 0 && tick % 5 === 0) ballPath.shift();
    }

    // 2. Pose Estimation
    let poses = [];
    try {
        poses = await poseDetector.estimatePoses(mainVideo);
    } catch (e) {}

    playersMap = [];
    
    for (let pose of poses) {
        if (pose.score < 0.2) continue;

        // Draw skeleton
        const points = pose.keypoints;
        ctx.fillStyle = '#00f3ff';
        points.forEach(p => {
            if (p.score > 0.3) {
                ctx.beginPath();
                ctx.arc(p.x * scaleX, p.y * scaleY, 4, 0, Math.PI * 2);
                ctx.fill();
            }
        });
        
        // Link lines
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

        // Homography Mapping Point (Ankles)
        const lAnkle = points.find(p=>p.name==='left_ankle');
        const rAnkle = points.find(p=>p.name==='right_ankle');
        
        if (lAnkle && lAnkle.score > 0.2) {
            let mapOut = mapToCourt(lAnkle.x, lAnkle.y, vW, vH);
            playersMap.push(mapOut);
            
            // Telemetry calculations
            if (isShootingPhase) {
                tPosture.innerText = "Shooting detected!";
                let shotType = classifyShot(mapOut.X, mapOut.Y);
                tPlane.innerText = shotType;
                tArc.innerText = (40 + Math.random() * 20).toFixed(1) + "°";
            }
        }
    }

    if (!isShootingPhase && ballPath.length < 5) {
        tPosture.innerText = "Active / Dribbling";
    }

    // 3. OCR periodically on a "person" bounding box (expensive)
    if (tick % 60 === 0 && predictions.length > 0) {
        const p = predictions.find(pr => pr.class === 'person' && pr.score > 0.5);
        if (p) {
            const [x,y,w,h] = p.bbox;
            // Draw a temporary hidden canvas for OCR extraction
            const cropC = document.createElement('canvas');
            cropC.width = w; cropC.height = h;
            const cropCtx = cropC.getContext('2d');
            cropCtx.drawImage(mainVideo, x, y, w, h, 0, 0, w, h);
            
            tesseractWorker.recognize(cropC).then(({data: { text }}) => {
                let num = text.match(/\d{1,2}/);
                if (num) {
                    console.log("[Director AI] Target Jersey Identified:", num[0]);
                    ctx.font = "20px Orbitron";
                    ctx.fillStyle = "white";
                    ctx.fillText("#" + num[0], x*scaleX, y*scaleY - 10);
                }
            });
        }
    }

    // Interactive switch every few seconds
    if (tick % 200 === 0) {
        let activeCamIndex = Math.floor(Math.random() * cameras.length);
        document.querySelectorAll('.cam-feed').forEach((feed, idx) => {
            if (idx === activeCamIndex) feed.classList.add('active');
            else feed.classList.remove('active');
        });
    }

    updateCourtMap();

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

    // Map Players
    courtCtx.fillStyle = '#00f3ff';
    for (let pm of playersMap) {
        courtCtx.beginPath(); courtCtx.arc(pm.X, pm.Y, 4, 0, Math.PI*2); courtCtx.fill();
    }

    // Map Ball if possible (simple heuristic off last ball tracking point)
    if (ballPath.length > 0) {
        let lx = ballPath[ballPath.length-1].x;
        let ly = ballPath[ballPath.length-1].y;
        let bmap = mapToCourt(lx / (mainCanvas.width / mainVideo.videoWidth), ly / (mainCanvas.height / mainVideo.videoHeight), mainVideo.videoWidth, mainVideo.videoHeight);
        courtCtx.fillStyle = '#ff5e00';
        courtCtx.beginPath(); courtCtx.arc(bmap.X, bmap.Y, 3, 0, Math.PI*2); courtCtx.fill();
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
    
    // Simulate a scored point based on current active mapping distance context
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
