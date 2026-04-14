const video = document.getElementById("video");
const renderCanvas = document.getElementById("renderCanvas");
const ctx = renderCanvas.getContext("2d");

const loader = document.getElementById("loader");
const loaderText = document.getElementById("loaderText");
const uploadPrompt = document.getElementById("uploadPrompt");
const settingsCard = document.getElementById("settingsCard");
const exportBtn = document.getElementById("exportBtn");
const videoUpload = document.getElementById("videoUpload");

// State
let detector = null;
let objectDetector = null;
let isModelsLoaded = false;
let isPlaying = false;
let isExporting = false;
let ballPositions = []; // Store past {x, y} for trail
let activeWaves = []; // Store active ripple animations
let renderingLoopId = null;
let mediaRecorder = null;
let exportChunks = [];

// Overlay Toggles
const toggleSkeleton = document.getElementById("toggleSkeleton");
const toggleAngles = document.getElementById("toggleAngles");
const toggleBall = document.getElementById("toggleBall");

async function initModels() {
    try {
        loader.style.display = "flex";
        loaderText.innerText = "Loading Pose Engine...";
        const detectorConfig = { modelType: poseDetection.movenet.modelType.SINGLEPOSE_THUNDER };
        detector = await poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, detectorConfig);

        loaderText.innerText = "Loading Ball Tracker...";
        objectDetector = await cocoSsd.load();

        isModelsLoaded = true;
        loader.style.display = "none";
        console.log("✅ Creator Hub Models Loaded");
    } catch (e) {
        console.error("Error loading models", e);
        loaderText.innerText = "Failed to load AI models.";
        loaderText.style.color = "#ef4444";
    }
}

initModels();

videoUpload.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;

    uploadPrompt.style.display = "none";
    settingsCard.style.opacity = "1";
    settingsCard.style.pointerEvents = "auto";
    exportBtn.style.opacity = "1";
    exportBtn.style.pointerEvents = "auto";
    
    renderCanvas.style.display = "block";
    video.style.opacity = "0.01"; // Hidden but playing
    
    const url = URL.createObjectURL(file);
    video.src = url;
    video.load();
    video.muted = true; // Required for autoplay without DOM exception if needed
    video.play();
});

video.addEventListener("loadedmetadata", () => {
    // Match Canvas to Video Aspect Ratio exactly for high quality stitch
    renderCanvas.width = video.videoWidth;
    renderCanvas.height = video.videoHeight;
});

video.addEventListener("play", () => {
    isPlaying = true;
    startRenderLoop();
});

video.addEventListener("pause", () => {
    isPlaying = false;
});

video.addEventListener("ended", () => {
    if (isExporting) {
        finishExport();
    } else {
        ballPositions = [];
        activeWaves = [];
        video.currentTime = 0;
        video.play();
    }
});

function startRenderLoop() {
    if (renderingLoopId) cancelAnimationFrame(renderingLoopId);
    async function loop() {
        if (!isPlaying && !isExporting) return;
        
        // 1. Draw Video Base Layer
        ctx.drawImage(video, 0, 0, renderCanvas.width, renderCanvas.height);

        // 2. Perform AI Inferences
        if (isModelsLoaded && video.readyState >= 2) {
            try {
                // Determine scale logic if we were scaling, but we matched width/height
                // So no bounding box scaling needed! Points are 1:1 with canvas.
                
                // POSTURE & ANGLES
                if (toggleSkeleton.checked || toggleAngles.checked) {
                    const poses = await detector.estimatePoses(video);
                    if (poses.length > 0) {
                        const kp = poses[0].keypoints;
                        if (toggleSkeleton.checked) drawSkeleton(kp);
                        if (toggleAngles.checked) drawAngles(kp);
                    }
                }

                // BALL TRACKING
                if (toggleBall.checked) {
                    const predictions = await objectDetector.detect(video);
                    const ball = predictions.find(p => p.class === "sports ball");
                    
                    if (ball) {
                        const [x, y, w, h] = ball.bbox;
                        const centerX = x + w / 2;
                        const centerY = y + h / 2;
                        ballPositions.push({ x: centerX, y: centerY, r: h / 2 });
                        
                        if (ballPositions.length >= 3) {
                            const p0 = ballPositions[ballPositions.length - 3];
                            const p1 = ballPositions[ballPositions.length - 2];
                            const p2 = ballPositions[ballPositions.length - 1];
                            
                            // Check if p1 is a local maximum in Y (lowest point on screen)
                            if (p1.y - p0.y > 5 && p1.y - p2.y > 5) {
                                const lastBounce = activeWaves.length > 0 ? activeWaves[activeWaves.length - 1].videoTime : -1;
                                if (video.currentTime - lastBounce > 0.3) {
                                    activeWaves.push({ x: p1.x, y: p1.y + p1.r, radius: 0, opacity: 1, videoTime: video.currentTime });
                                }
                            }
                        }

                        if (ballPositions.length > 30) ballPositions.shift(); // Trail length
                    }
                    drawBallTrail();
                    drawWaves();
                }

            } catch (err) {
                console.warn("Inference error:", err);
            }
        }

        renderingLoopId = requestAnimationFrame(loop);
    }
    loop();
}

/* --- DRAWING HELPERS --- */
function drawSkeleton(keypoints) {
    const adjacentKeyPoints = poseDetection.util.getAdjacentPairs(poseDetection.SupportedModels.MoveNet);
    
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(139, 92, 246, 0.8)"; // Purple
    
    adjacentKeyPoints.forEach(([i, j]) => {
        const kp1 = keypoints[i];
        const kp2 = keypoints[j];
        if (kp1.score > 0.3 && kp2.score > 0.3) {
            ctx.beginPath();
            ctx.moveTo(kp1.x, kp1.y);
            ctx.lineTo(kp2.x, kp2.y);
            ctx.stroke();
        }
    });

    ctx.fillStyle = "#fff";
    keypoints.forEach(kp => {
        if (kp.score > 0.3) {
            ctx.beginPath();
            ctx.arc(kp.x, kp.y, 6, 0, 2 * Math.PI);
            ctx.fill();
        }
    });
}

function calculateAngle(A, B, C) {
    let rad = Math.atan2(C.y - B.y, C.x - B.x) - Math.atan2(A.y - B.y, A.x - B.x);
    let angle = Math.abs(rad * 180 / Math.PI);
    if (angle > 180) angle = 360 - angle;
    return Math.round(angle);
}

function drawAngles(keypoints) {
    const getKeypoint = name => keypoints.find(k => k.name === name);
    const rShoulder = getKeypoint("right_shoulder");
    const rElbow = getKeypoint("right_elbow");
    const rWrist = getKeypoint("right_wrist");
    const rHip = getKeypoint("right_hip");
    const rKnee = getKeypoint("right_knee");
    const rAnkle = getKeypoint("right_ankle");

    ctx.font = "bold 24px Arial";
    ctx.fillStyle = "#22c55e"; // Green text for angles

    // Elbow Angle
    if (rShoulder && rElbow && rWrist && rShoulder.score > 0.3 && rElbow.score > 0.3 && rWrist.score > 0.3) {
        const angle = calculateAngle(rShoulder, rElbow, rWrist);
        ctx.fillText(`${angle}°`, rElbow.x + 15, rElbow.y);
    }

    // Knee Angle
    if (rHip && rKnee && rAnkle && rHip.score > 0.3 && rKnee.score > 0.3 && rAnkle.score > 0.3) {
        const angle = calculateAngle(rHip, rKnee, rAnkle);
        ctx.fillText(`${angle}°`, rKnee.x + 15, rKnee.y);
    }
}

function drawBallTrail() {
    if (ballPositions.length < 2) return;
    
    ctx.lineWidth = 6;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    for (let i = 1; i < ballPositions.length; i++) {
        // Fade effect based on age
        const alpha = i / ballPositions.length;
        ctx.strokeStyle = `rgba(249, 115, 22, ${alpha})`; // Orange trail
        
        ctx.beginPath();
        ctx.moveTo(ballPositions[i - 1].x, ballPositions[i - 1].y);
        ctx.lineTo(ballPositions[i].x, ballPositions[i].y);
        ctx.stroke();
    }

    // Draw current ball highlight
    const last = ballPositions[ballPositions.length - 1];
    ctx.beginPath();
    ctx.arc(last.x, last.y, 12, 0, 2 * Math.PI);
    ctx.fillStyle = "rgba(249, 115, 22, 0.4)";
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = "rgba(249, 115, 22, 1)";
    ctx.stroke();
}

function drawWaves() {
    for (let i = activeWaves.length - 1; i >= 0; i--) {
        let wave = activeWaves[i];
        
        // Expand and fade
        wave.radius += 5; // adjust speed of wave
        wave.opacity -= 0.03; // adjust fade time
        
        if (wave.opacity <= 0) {
            activeWaves.splice(i, 1);
            continue;
        }
        
        ctx.beginPath();
        // Use an ellipse to simulate a 3D floor plane effect
        ctx.ellipse(wave.x, wave.y, wave.radius, wave.radius * 0.35, 0, 0, 2 * Math.PI);
        ctx.strokeStyle = `rgba(249, 115, 22, ${wave.opacity})`;
        ctx.lineWidth = 4;
        ctx.stroke();
    }
}

/* --- EXPORT LOGIC --- */
const exportProgressPanel = document.getElementById("exportProgressPanel");
const exportProgressFill = document.getElementById("exportProgressFill");
const exportStatusText = document.getElementById("exportStatusText");

exportBtn.addEventListener("click", () => {
    if (isExporting || video.readyState < 2) return;
    startExport();
});

function startExport() {
    isExporting = true;
    exportChunks = [];
    ballPositions = []; // Reset trail
    activeWaves = []; // Reset waves
    
    exportBtn.innerText = "Exporting...";
    exportBtn.style.opacity = "0.5";
    exportBtn.style.pointerEvents = "none";
    exportProgressPanel.style.display = "flex";
    exportProgressFill.style.width = "0%";
    
    // Create MediaRecorder from Canvas
    const stream = renderCanvas.captureStream(30); // 30 FPS
    mediaRecorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp9" });
    
    mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) exportChunks.push(e.data);
    };
    
    mediaRecorder.onstop = () => {
        const blob = new Blob(exportChunks, { type: "video/webm" });
        const url = URL.createObjectURL(blob);
        
        // Trigger Download
        const a = document.createElement("a");
        a.style.display = "none";
        a.href = url;
        a.download = `CourtStream_Creator_${Date.now()}.webm`;
        document.body.appendChild(a);
        a.click();
        window.URL.revokeObjectURL(url);
        
        resetExportUI();
    };

    // Prepare Video to play from Start
    video.pause();
    video.currentTime = 0;
    
    // Artificial update interval for UI progress
    const duration = video.duration;
    const progressInt = setInterval(() => {
        if (!isExporting) {
            clearInterval(progressInt);
            return;
        }
        const pct = Math.min(100, Math.round((video.currentTime / duration) * 100));
        exportProgressFill.style.width = `${pct}%`;
        exportStatusText.innerText = `Rendering Composite... ${pct}%`;
    }, 200);

    // Play video and start recording
    mediaRecorder.start();
    video.play();
}

function finishExport() {
    isExporting = false;
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
        mediaRecorder.stop();
    }
}

function resetExportUI() {
    isExporting = false;
    exportProgressPanel.style.display = "none";
    exportBtn.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg> Export to Editor (MP4)';
    exportBtn.style.opacity = "1";
    exportBtn.style.pointerEvents = "auto";
}

document.getElementById("cancelExportBtn").addEventListener("click", () => {
    if (isExporting && mediaRecorder) {
        mediaRecorder.stop();
        isExporting = false;
        video.pause();
        resetExportUI();
        alert("Export Cancelled");
    }
});
