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

// Telemetry Elements
const tPosture = document.getElementById('t-posture');
const tArc = document.getElementById('t-arc');
const tPlane = document.getElementById('t-plane');

let isSimulating = false;
let rafId = null;

// Multi-cam setup
const cameras = [
    { id: 'cam1', name: 'Baseline', streamMode: 'Active' },
    { id: 'cam2', name: 'Side-Court', streamMode: 'Standby' },
    { id: 'cam3', name: 'Top-Down', streamMode: 'Tracking' },
    { id: 'cam4', name: 'Behind-Rim', streamMode: 'Standby' },
];
let activeCamIndex = 0;

function initSidebar() {
    camSidebar.innerHTML = '';
    cameras.forEach((cam, index) => {
        const feedDiv = document.createElement('div');
        feedDiv.className = `cam-feed ${index === activeCamIndex ? 'active' : ''}`;
        feedDiv.id = cam.id;
        
        feedDiv.innerHTML = `
            <video muted loop playsinline></video>
            <div class="cam-label">${cam.name} / ${cam.id.toUpperCase()}</div>
            <div class="active-label">LIVE</div>
            <div class="distributed-indicator">
                <div class="status-dot"></div>
                AI: Local
            </div>
        `;
        camSidebar.appendChild(feedDiv);
    });
}

function updateSidebarVideos(srcUrl) {
    const feeds = document.querySelectorAll('.cam-feed video');
    feeds.forEach(vid => {
        vid.src = srcUrl;
        vid.play().catch(e => console.log('Autoplay issue on sidebar:', e));
    });
}

function resizeCanvas() {
    if(!mainVideo.videoWidth) return;
    const rect = mainVideo.getBoundingClientRect();
    mainCanvas.width = rect.width;
    mainCanvas.height = rect.height;
}
window.addEventListener('resize', resizeCanvas);


// Fake Data Generation for the aesthetics
let fakeTick = 0;
let ballPos = { x: 100, y: 300 };
let currentArc = [];
const skeletonPoints = [];

function generateStickFigure() {
    // Generate a basic dynamic stick figure slightly bouncing in the middle
    let centerX = mainCanvas.width / 2;
    let centerY = mainCanvas.height / 2 + 50;
    let bounce = Math.sin(fakeTick * 0.1) * 10;
    
    // Head: 0, Shoulders: 1, LeftArm: 2, RightArm: 3, Spine: 4, LeftLeg: 5, RightLeg: 6
    return [
        { x: centerX, y: centerY - 80 + bounce }, // Head
        { x: centerX, y: centerY - 40 + bounce }, // Shoulders
        { x: centerX - 30, y: centerY - 10 + bounce }, // L Arm
        { x: centerX + 50, y: centerY - 50 + bounce }, // R Arm (raised to shoot)
        { x: centerX, y: centerY + 20 + bounce }, // Hip
        { x: centerX - 20, y: centerY + 80 },     // L Leg
        { x: centerX + 20, y: centerY + 80 + bounce * 0.5 } // R Leg
    ];
}

function updateSimulation() {
    fakeTick++;
    if (!mainCanvas.width) resizeCanvas();

    // 1. Draw Main Overlays
    ctx.clearRect(0, 0, mainCanvas.width, mainCanvas.height);

    // Draw Skeletal Figure (Cyan)
    const points = generateStickFigure();
    ctx.strokeStyle = '#00f3ff';
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    
    // Body Lines
    ctx.beginPath();
    ctx.moveTo(points[1].x, points[1].y); ctx.lineTo(points[4].x, points[4].y); // Spine
    ctx.moveTo(points[1].x, points[1].y); ctx.lineTo(points[2].x, points[2].y); // L Arm
    ctx.moveTo(points[1].x, points[1].y); ctx.lineTo(points[3].x, points[3].y); // R Arm
    ctx.moveTo(points[4].x, points[4].y); ctx.lineTo(points[5].x, points[5].y); // L Leg
    ctx.moveTo(points[4].x, points[4].y); ctx.lineTo(points[6].x, points[6].y); // R Leg
    ctx.stroke();

    // Head
    ctx.beginPath();
    ctx.arc(points[0].x, points[0].y, 15, 0, Math.PI * 2);
    ctx.stroke();

    // Points glow
    ctx.fillStyle = '#fff';
    points.forEach(p => {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fill();
    });

    // 2. Parabolic Ball Arc (Neon Orange)
    let bX = mainCanvas.width / 2 + 50 + (fakeTick % 100) * 4;
    let bY = mainCanvas.height / 2 - 50 - Math.sin((fakeTick % 100) / 100 * Math.PI) * 150;
    
    currentArc.push({x: bX, y: bY});
    if (currentArc.length > 50) currentArc.shift();
    if (fakeTick % 100 === 0) currentArc = []; // reset arc

    if (currentArc.length > 1) {
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(255, 94, 0, 0.6)';
        ctx.lineWidth = 6;
        ctx.moveTo(currentArc[0].x, currentArc[0].y);
        for(let i = 1; i < currentArc.length; i++) {
            ctx.lineTo(currentArc[i].x, currentArc[i].y);
        }
        ctx.stroke();
    }

    // Ball
    ctx.beginPath();
    ctx.fillStyle = '#ff5e00';
    ctx.arc(bX, bY, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 15;
    ctx.shadowColor = '#ff5e00';
    ctx.arc(bX, bY, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;


    // 3. Update Court Map (Plane Fusion)
    updateCourtMap();

    // 4. Update Telemetry
    if (fakeTick % 30 === 0) {
        if (currentArc.length < 5) tPosture.innerText = 'Gathering...';
        else if (currentArc.length < 30) tPosture.innerText = 'Shooting Phase';
        else tPosture.innerText = 'Flight Time';

        tArc.innerText = (45 + Math.random() * 10).toFixed(1) + '°';
        tPlane.innerText = Math.random() > 0.5 ? '2-Point Range' : '3-Point Zone';
    }

    // 5. Automated Switcher (Switch Active Camera every 150 ticks)
    if (fakeTick % 150 === 0) {
        activeCamIndex = (activeCamIndex + 1) % cameras.length;
        document.querySelectorAll('.cam-feed').forEach((feed, idx) => {
            if (idx === activeCamIndex) feed.classList.add('active');
            else feed.classList.remove('active');
        });
    }

    rafId = requestAnimationFrame(updateSimulation);
}

function updateCourtMap() {
    const w = courtCanvas.width;
    const h = courtCanvas.height;
    courtCtx.clearRect(0, 0, w, h);

    // Draw simple half court lines
    courtCtx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
    courtCtx.lineWidth = 2;
    // Paint
    courtCtx.strokeRect(w/2 - 20, 0, 40, h/2);
    // 3PT Line Arch
    courtCtx.beginPath();
    courtCtx.arc(w/2, 0, 60, 0, Math.PI);
    courtCtx.stroke();

    // Player position
    let px = w/2 + Math.sin(fakeTick*0.05) * 40;
    let py = h/2 - Math.cos(fakeTick*0.05) * 20;

    courtCtx.fillStyle = '#00f3ff';
    courtCtx.beginPath();
    courtCtx.arc(px, py, 4, 0, Math.PI*2);
    courtCtx.fill();

    // Ball position (scaled mapping)
    if (currentArc.length > 0) {
        let lastB = currentArc[currentArc.length-1];
        let mapBx = (lastB.x / mainCanvas.width) * w;
        let mapBy = (lastB.y / mainCanvas.height) * h;
        
        courtCtx.fillStyle = '#ff5e00';
        courtCtx.beginPath();
        courtCtx.arc(mapBx, mapBy, 3, 0, Math.PI*2);
        courtCtx.fill();
    }
}


// Handlers
uploadBtn.addEventListener('click', () => {
    videoUpload.click();
});

videoUpload.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
        const url = URL.createObjectURL(file);
        mainVideo.src = url;
        welcomeBox.style.display = 'none';
        
        mainVideo.onloadedmetadata = () => {
            mainVideo.play();
            resizeCanvas();
            updateSidebarVideos(url);
            
            // Adjust court canvas internal resolution
            const cRect = courtCanvas.parentElement.getBoundingClientRect();
            courtCanvas.width = cRect.width;
            courtCanvas.height = cRect.height;
            
            if (!isSimulating) {
                isSimulating = true;
                updateSimulation();
            }
        };
    }
});

simulateBtn.addEventListener('click', () => {
    // If no video, auto pilot clicks upload. 
    // Or normally toggles simulation visuals
    if (!mainVideo.src) {
        alert("Please upload a test video first!");
        return;
    }
    if (isSimulating) {
        cancelAnimationFrame(rafId);
        isSimulating = false;
        simulateBtn.innerText = "▶ Start Auto-Pilot";
    } else {
        isSimulating = true;
        updateSimulation();
        simulateBtn.innerText = "⏸ Pause Auto-Pilot";
    }
});

// Init layout
initSidebar();
