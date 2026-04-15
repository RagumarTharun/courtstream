const video = document.getElementById("video");
const renderCanvas = document.getElementById("renderCanvas");
const ctx = renderCanvas.getContext("2d");

const loader = document.getElementById("loader");
const loaderText = document.getElementById("loaderText");
const uploadPrompt = document.getElementById("uploadPrompt");
const settingsCard = document.getElementById("settingsCard");
const exportBtn = document.getElementById("exportBtn");
const videoUpload = document.getElementById("videoUpload");

const playbar = document.getElementById("playbar");
const playPauseBtn = document.getElementById("playPauseBtn");
const playIcon = document.getElementById("playIcon");
const pauseIcon = document.getElementById("pauseIcon");
const seekBar = document.getElementById("seekBar");
const timeDisplay = document.getElementById("timeDisplay");
const speedSelect = document.getElementById("speedSelect");

// State
let detector = null;
let objectDetector = null;
let isModelsLoaded = false;
let isPlaying = false;
let isExporting = false;
let isTrackingMode = false;
let selectedPoseCenter = null;
let ballPositions = []; // Store past {x, y} for trail
let activeWaves = []; // Store active ripple animations
let renderingLoopId = null;
let mediaRecorder = null;
let exportChunks = [];

// Overlay Toggles & Configs
const toggleSkeleton = document.getElementById("toggleSkeleton");
const skeletonColor = document.getElementById("skeletonColor");
const skeletonThickness = document.getElementById("skeletonThickness");

const toggleAngles = document.getElementById("toggleAngles");
const angleRightElbow = document.getElementById("angleRightElbow");
const angleLeftElbow = document.getElementById("angleLeftElbow");
const angleRightKnee = document.getElementById("angleRightKnee");
const angleLeftKnee = document.getElementById("angleLeftKnee");
const angleTextColor = document.getElementById("angleTextColor");
const angleTextSize = document.getElementById("angleTextSize");

const toggleBall = document.getElementById("toggleBall");
const ballTrailFrames = document.getElementById("ballTrailFrames");

// Keyframes
const keyframeCard = document.getElementById("keyframeCard");
const addKeyframeBtn = document.getElementById("addKeyframeBtn");
const keyframesList = document.getElementById("keyframesList");
let keyframes = []; // Array of { time, settings }

function getCurrentSettings() {
    return {
        skeleton: {
            enabled: toggleSkeleton.checked,
            color: skeletonColor.value,
            thickness: parseInt(skeletonThickness.value, 10)
        },
        angles: {
            enabled: toggleAngles.checked,
            rElbow: angleRightElbow.checked,
            lElbow: angleLeftElbow.checked,
            rKnee: angleRightKnee.checked,
            lKnee: angleLeftKnee.checked,
            color: angleTextColor.value,
            size: parseInt(angleTextSize.value, 10)
        },
        ball: {
            enabled: toggleBall.checked,
            trailFrames: parseInt(ballTrailFrames.value, 10)
        }
    };
}

function getActiveSettings() {
    if (keyframes.length === 0) return getCurrentSettings();
    
    const t = video.currentTime;
    let closest = null;
    
    // keyframes is sorted by time
    for (let i = 0; i < keyframes.length; i++) {
        if (keyframes[i].time <= t + 0.05) { // Small buffer
            closest = keyframes[i];
        } else {
            break;
        }
    }
    
    return closest ? closest.settings : getCurrentSettings();
}

function renderKeyframesUI() {
    keyframesList.innerHTML = "";
    keyframes.sort((a, b) => a.time - b.time);
    
    keyframes.forEach((kf, idx) => {
        const div = document.createElement("div");
        div.style.display = "flex";
        div.style.justifyContent = "space-between";
        div.style.alignItems = "center";
        div.style.background = "var(--border)";
        div.style.padding = "8px 12px";
        div.style.borderRadius = "6px";
        
        const timestamp = document.createElement("span");
        timestamp.style.fontSize = "13px";
        timestamp.style.fontWeight = "bold";
        timestamp.innerText = "Snap at " + kf.time.toFixed(2) + "s";
        
        const removeBtn = document.createElement("button");
        removeBtn.innerText = "X";
        removeBtn.style.padding = "2px 6px";
        removeBtn.style.background = "transparent";
        removeBtn.style.color = "#ef4444";
        removeBtn.style.border = "1px solid #ef4444";
        removeBtn.onclick = () => {
             keyframes.splice(idx, 1);
             renderKeyframesUI();
        };
        
        div.appendChild(timestamp);
        div.appendChild(removeBtn);
        keyframesList.appendChild(div);
    });
}

addKeyframeBtn.addEventListener("click", () => {
    const t = video.currentTime;
    // Remove if there's very close one
    keyframes = keyframes.filter(kf => Math.abs(kf.time - t) > 0.05);
    
    keyframes.push({ time: t, settings: getCurrentSettings() });
    renderKeyframesUI();
});

async function initModels() {
    try {
        loader.style.display = "flex";
        loaderText.innerText = "Loading Pose Engine...";
        const detectorConfig = { modelType: poseDetection.movenet.modelType.MULTIPOSE_LIGHTNING };
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

function formatTime(seconds) {
    if (isNaN(seconds)) return "00:00";
    const min = Math.floor(seconds / 60);
    const sec = Math.floor(seconds % 60);
    return min.toString().padStart(2, '0') + ':' + sec.toString().padStart(2, '0');
}

let isDraggingSeek = false;

speedSelect.addEventListener("change", (e) => {
    video.playbackRate = parseFloat(e.target.value);
});

document.addEventListener("keydown", (e) => {
    // Ignore inputs if user is typing in a text field
    if (e.target.tagName === 'INPUT' && e.target.type !== 'range') return;

    if (e.code === "Space") {
        e.preventDefault();
        if (video.paused) video.play(); else video.pause();
    } else if (e.code === "ArrowRight") {
        e.preventDefault();
        video.currentTime = Math.min(video.duration, video.currentTime + 5);
    } else if (e.code === "ArrowLeft") {
        e.preventDefault();
        video.currentTime = Math.max(0, video.currentTime - 5);
    }
});

renderCanvas.addEventListener("click", (e) => {
    // Calculate click position relative to canvas coordinate space
    const rect = renderCanvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * (renderCanvas.width / rect.width);
    const y = (e.clientY - rect.top) * (renderCanvas.height / rect.height);
    
    // Set target
    selectedPoseCenter = { x, y };
    isTrackingMode = true;
});

playPauseBtn.addEventListener("click", () => {
    if (video.paused) video.play();
    else video.pause();
});

seekBar.addEventListener("input", () => {
    isDraggingSeek = true;
    timeDisplay.innerText = formatTime(seekBar.value) + " / " + formatTime(video.duration);
});

seekBar.addEventListener("change", () => {
    isDraggingSeek = false;
    video.currentTime = seekBar.value;
});

video.addEventListener("timeupdate", () => {
    if (!isDraggingSeek) {
        seekBar.value = video.currentTime;
        timeDisplay.innerText = formatTime(video.currentTime) + " / " + formatTime(video.duration);
    }
});

video.addEventListener("seeked", () => {
    if (video.paused && video.readyState >= 2) {
        ctx.drawImage(video, 0, 0, renderCanvas.width, renderCanvas.height);
        drawBallTrail();
        drawWaves();
    }
});

videoUpload.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;

    uploadPrompt.style.display = "none";
    settingsCard.style.opacity = "1";
    settingsCard.style.pointerEvents = "auto";
    exportBtn.style.opacity = "1";
    exportBtn.style.pointerEvents = "auto";
    
    keyframeCard.style.opacity = "1";
    keyframeCard.style.pointerEvents = "auto";
    
    playbar.style.display = "flex";
    
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
    seekBar.max = video.duration;
    timeDisplay.innerText = "00:00 / " + formatTime(video.duration);
});

video.addEventListener("play", () => {
    isPlaying = true;
    playIcon.style.display = "none";
    pauseIcon.style.display = "block";
    startRenderLoop();
});

video.addEventListener("pause", () => {
    isPlaying = false;
    playIcon.style.display = "block";
    pauseIcon.style.display = "none";
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
        
        if (video.readyState >= 2) {
            // 1. Draw Video Base Layer
            ctx.drawImage(video, 0, 0, renderCanvas.width, renderCanvas.height);
            
            const activeSettings = getActiveSettings();

            // 2. Perform AI Inferences
            if (isModelsLoaded) {
            try {
                // Determine scale logic if we were scaling, but we matched width/height
                // So no bounding box scaling needed! Points are 1:1 with canvas.
                
                // POSTURE & ANGLES
                if (activeSettings.skeleton.enabled || activeSettings.angles.enabled) {
                    const poses = await detector.estimatePoses(video);
                    if (poses.length > 0) {
                        let targetPose = poses[0]; // fallback
                        
                        if (isTrackingMode && selectedPoseCenter) {
                            let minDistance = Infinity;
                            for (let i = 0; i < poses.length; i++) {
                                const p = poses[i];
                                let cx = 0, cy = 0;
                                if (p.box) {
                                    cx = p.box.xMin + p.box.width / 2;
                                    cy = p.box.yMin + p.box.height / 2;
                                } else if (p.keypoints && p.keypoints.length > 0) {
                                    cx = p.keypoints.reduce((s, k) => s + k.x, 0) / p.keypoints.length;
                                    cy = p.keypoints.reduce((s, k) => s + k.y, 0) / p.keypoints.length;
                                }
                                
                                const dist = Math.hypot(cx - selectedPoseCenter.x, cy - selectedPoseCenter.y);
                                if (dist < minDistance) {
                                    minDistance = dist;
                                    targetPose = p;
                                }
                            }
                            
                            // Update dynamic tracking center to follow them
                            if (targetPose.box) {
                                selectedPoseCenter.x = targetPose.box.xMin + targetPose.box.width / 2;
                                selectedPoseCenter.y = targetPose.box.yMin + targetPose.box.height / 2;
                            } else if (targetPose.keypoints && targetPose.keypoints.length > 0) {
                                selectedPoseCenter.x = targetPose.keypoints.reduce((s, k) => s + k.x, 0) / targetPose.keypoints.length;
                                selectedPoseCenter.y = targetPose.keypoints.reduce((s, k) => s + k.y, 0) / targetPose.keypoints.length;
                            }
                        }

                        const kp = targetPose.keypoints;
                        if (activeSettings.skeleton.enabled) drawSkeleton(kp, activeSettings.skeleton);
                        if (activeSettings.angles.enabled) drawAngles(kp, activeSettings.angles);
                    }
                }

                // BALL TRACKING
                if (activeSettings.ball.enabled) {
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

                        if (ballPositions.length > activeSettings.ball.trailFrames) {
                            ballPositions = ballPositions.slice(-activeSettings.ball.trailFrames);
                        }
                    }
                    drawBallTrail();
                    drawWaves();
                }

            } catch (err) {
                console.warn("Inference error:", err);
            }
        }
        } // Close if (video.readyState >= 2)

        renderingLoopId = requestAnimationFrame(loop);
    }
    loop();
}

/* --- DRAWING HELPERS --- */
function drawSkeleton(keypoints, settings) {
    const adjacentKeyPoints = poseDetection.util.getAdjacentPairs(poseDetection.SupportedModels.MoveNet);
    
    ctx.lineWidth = settings.thickness;
    ctx.strokeStyle = settings.color;
    
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
            ctx.arc(kp.x, kp.y, settings.thickness * 1.5, 0, 2 * Math.PI);
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

function drawAngles(keypoints, settings) {
    const getKeypoint = name => keypoints.find(k => k.name === name);
    const rShoulder = getKeypoint("right_shoulder");
    const rElbow = getKeypoint("right_elbow");
    const rWrist = getKeypoint("right_wrist");
    const lShoulder = getKeypoint("left_shoulder");
    const lElbow = getKeypoint("left_elbow");
    const lWrist = getKeypoint("left_wrist");
    const rHip = getKeypoint("right_hip");
    const rKnee = getKeypoint("right_knee");
    const rAnkle = getKeypoint("right_ankle");
    const lHip = getKeypoint("left_hip");
    const lKnee = getKeypoint("left_knee");
    const lAnkle = getKeypoint("left_ankle");

    ctx.font = `bold ${settings.size}px Arial`;
    ctx.fillStyle = settings.color;

    if (settings.rElbow && rShoulder && rElbow && rWrist && rShoulder.score > 0.3 && rElbow.score > 0.3 && rWrist.score > 0.3) {
        ctx.fillText(`${calculateAngle(rShoulder, rElbow, rWrist)}°`, rElbow.x + 15, rElbow.y);
    }
    
    if (settings.lElbow && lShoulder && lElbow && lWrist && lShoulder.score > 0.3 && lElbow.score > 0.3 && lWrist.score > 0.3) {
        ctx.fillText(`${calculateAngle(lShoulder, lElbow, lWrist)}°`, lElbow.x - 45, lElbow.y);
    }

    if (settings.rKnee && rHip && rKnee && rAnkle && rHip.score > 0.3 && rKnee.score > 0.3 && rAnkle.score > 0.3) {
        ctx.fillText(`${calculateAngle(rHip, rKnee, rAnkle)}°`, rKnee.x + 15, rKnee.y);
    }
    
    if (settings.lKnee && lHip && lKnee && lAnkle && lHip.score > 0.3 && lKnee.score > 0.3 && lAnkle.score > 0.3) {
        ctx.fillText(`${calculateAngle(lHip, lKnee, lAnkle)}°`, lKnee.x - 45, lKnee.y);
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
    
    playbar.style.pointerEvents = "none";
    playbar.style.opacity = "0.5";
    
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
    
    playbar.style.pointerEvents = "auto";
    playbar.style.opacity = "1";
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
