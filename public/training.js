// Elements
const video = document.getElementById('video');
const canvas = document.getElementById('output');
const ctx = canvas.getContext('2d');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const switchCamBtn = document.getElementById('switchCamBtn');
const loader = document.getElementById('loader');

const toggleBtn = document.getElementById('toggleDashboardBtn');
const dashboardPanel = document.getElementById('dashboardPanel');
const elbowAngleEl = document.getElementById('elbowAngle');
const kneeAngleEl = document.getElementById('kneeAngle');
const shotCountEl = document.getElementById('shotCount');
const feedbackMsg = document.getElementById('feedbackMsg');
const transcriptBox = document.getElementById('transcriptBox');

let detector;
let rafId;
let isPlaying = false;
let shotCount = 0;
let currentFacingMode = 'user';

// Session Recording
let mediaRecorder;
let recordedChunks = [];

// Ball tracking
let ballCenter = null;
let globalActiveWrist = null;

// Simple state machine for shot detection
let phase = 'idle'; // idle, shooting, cooldown
let maxElbowAngleDuringShot = 0;

async function init() {
    loader.style.display = 'block';
    startBtn.disabled = true;

    try {
        const detectorConfig = { modelType: poseDetection.movenet.modelType.SINGLEPOSE_LIGHTNING };
        detector = await poseDetection.createDetector(poseDetection.SupportedModels.MoveNet, detectorConfig);
        console.log("MoveNet loaded.");

        loader.style.display = 'none';
        startBtn.disabled = false;
    } catch (error) {
        console.error("Error loading models:", error);
        loader.textContent = "Error loading AI. Check console.";
        loader.style.background = "rgba(239, 68, 68, 0.9)";
    }
}

function logTranscript(msg, type = 'info') {
    const div = document.createElement('div');
    const time = new Date().toLocaleTimeString([], { hour12: false });
    div.innerHTML = `<span style="color:var(--muted)">[${time}]</span> ${msg}`;
    if (type === 'error') div.style.color = 'var(--red)';
    else if (type === 'success') div.style.color = 'var(--green)';
    
    // remove placeholder if exists
    if (transcriptBox.children.length === 1 && transcriptBox.children[0].textContent.includes('Waiting for session')) {
        transcriptBox.innerHTML = '';
    }
    
    transcriptBox.appendChild(div);
    transcriptBox.scrollTop = transcriptBox.scrollHeight;
}

function speakFeedback(text) {
    if ('speechSynthesis' in window) {
        if (!window.speechSynthesis.speaking) {
            const msg = new SpeechSynthesisUtterance(text);
            msg.rate = 1.1; 
            window.speechSynthesis.speak(msg);
        }
    }
}

function updateFeedbackUI(text, isGood = true) {
    feedbackMsg.textContent = text;
    if (isGood) {
        feedbackMsg.style.borderColor = "rgba(34, 197, 94, 0.5)";
        feedbackMsg.style.background = "rgba(34, 197, 94, 0.1)";
        feedbackMsg.style.color = "var(--green)";
    } else {
        feedbackMsg.style.borderColor = "rgba(249, 115, 22, 0.5)";
        feedbackMsg.style.background = "rgba(249, 115, 22, 0.1)";
        feedbackMsg.style.color = "var(--orange)";
    }
}

async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert("Camera API not available in this browser.");
        return;
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: currentFacingMode, width: 640, height: 480 },
            audio: false
        });

        video.srcObject = stream;

        video.onloadedmetadata = () => {
            video.play();
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            isPlaying = true;
            
            startBtn.style.display = 'none';
            stopBtn.style.display = 'flex'; // SVG icon is flex
            
            transcriptBox.innerHTML = '';
            logTranscript(`Session started (${currentFacingMode === 'user' ? 'Front' : 'Back'} camera).`, 'info');

            // Setup Recording
            const canvasStream = canvas.captureStream(30);
            recordedChunks = [];
            let mimeType = 'video/webm';
            let ext = 'webm';
            if (!MediaRecorder.isTypeSupported(mimeType)) {
                mimeType = 'video/mp4';
                ext = 'mp4';
            }
            mediaRecorder = new MediaRecorder(canvasStream, { mimeType: mimeType });
            
            mediaRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) recordedChunks.push(e.data);
            };
            
            mediaRecorder.onstop = () => {
                const blob = new Blob(recordedChunks, { type: mimeType });
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = `courtstream_session_${Date.now()}.${ext}`;
                a.click();
                URL.revokeObjectURL(url);
                logTranscript('Session video downloaded.', 'success');
            };

            mediaRecorder.start();
            logTranscript('Recording started...', 'success');

            // Show toggle button now that session has started
            toggleBtn.style.display = 'flex';

            predictLoop();
        };
    } catch (error) {
        console.error("Camera access denied or error:", error);
        alert("Could not access camera. Please grant permissions.");
    }
}

function stopCamera() {
    isPlaying = false;
    if (rafId) cancelAnimationFrame(rafId);                 

    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    }

    if (video.srcObject) {
        video.srcObject.getTracks().forEach(track => track.stop());
        video.srcObject = null;
    }

    startBtn.style.display = 'flex';
    stopBtn.style.display = 'none';

    elbowAngleEl.textContent = '--°';
    kneeAngleEl.textContent = '--°';
    updateFeedbackUI('Session stopped.', true);
    logTranscript('Session ended.', 'info');
}

switchCamBtn.addEventListener('click', async () => {
    currentFacingMode = currentFacingMode === 'user' ? 'environment' : 'user';
    if (isPlaying) {
        if (video.srcObject) {
            video.srcObject.getTracks().forEach(track => track.stop());
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: currentFacingMode, width: 640, height: 480 },
                audio: false
            });
            video.srcObject = stream;
            video.onloadedmetadata = () => {
                video.play();
            };
            logTranscript(`Switched to ${currentFacingMode === 'user' ? 'Front' : 'Back'} Camera`, 'info');
        } catch (e) {
            console.error("Camera switch failed:", e);
            logTranscript("Camera switch blocked or failed.", 'error');
        }
    }
});

function calculateAngle(a, b, c) {
    const radians = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(a.y - b.y, a.x - b.x);
    let angle = Math.abs(radians * 180.0 / Math.PI);
    if (angle > 180.0) angle = 360 - angle;
    return angle;
}

function drawSkeleton(keypoints) {
    const points = keypoints.filter(p => p.score > 0.2);
    ctx.fillStyle = "#3b82f6";
    points.forEach(point => {
        ctx.beginPath();
        ctx.arc(point.x, point.y, 5, 0, 2 * Math.PI);
        ctx.fill();
    });

    const adjacentKeyPoints = poseDetection.util.getAdjacentPairs(poseDetection.SupportedModels.MoveNet);
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;
    adjacentKeyPoints.forEach((pair) => {
        const kp1 = keypoints[pair[0]];
        const kp2 = keypoints[pair[1]];
        if (kp1.score > 0.2 && kp2.score > 0.2) {
            ctx.beginPath();
            ctx.moveTo(kp1.x, kp1.y);
            ctx.lineTo(kp2.x, kp2.y);
            ctx.stroke();
        }
    });
}

let offscreenCanvas = null;
let offCtx = null;

// Custom fast-pixel color scanner explicitly for the basketball (with debug rendering enabled)
function trackOrangeBallNearWrist(videoEl, width, height, wrist) {
    if (!offscreenCanvas) {
        offscreenCanvas = document.createElement('canvas');
        offCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (offscreenCanvas.width !== width) {
        offscreenCanvas.width = width;
        offscreenCanvas.height = height;
    }

    offCtx.drawImage(videoEl, 0, 0, width, height);
    const imageData = offCtx.getImageData(0, 0, width, height);
    const data = imageData.data;
    let sumX = 0, sumY = 0, count = 0;
    
    // Draw thermal pixels representing matched color
    ctx.fillStyle = 'rgba(249, 115, 22, 0.4)';

    // Step size 4 for speed
    for (let y = 0; y < height; y += 4) {
        for (let x = 0; x < width; x += 4) {
            // ONLY look intimately close to the wrist (e.g. 200 pixels radius) to avoid ANY background noise
            if (wrist) {
                if (Math.abs(x - wrist.x) > 200 || Math.abs(y - wrist.y) > 200) {
                    continue;
                }
            }

            const i = (y * width + x) * 4;
            const r = data[i], g = data[i+1], b = data[i+2];
            
            // Forgiving Basketball Color Heuristic:
            // Needs to be reasonably bright and mostly Red/Orange (Red must be notably higher than Green/Blue)
            if (r > 60 && r > g + 15 && r > b + 15) {
                sumX += x;
                sumY += y;
                count++;
                
                // THERMAL DEBUG: Visibly paint what is being tracked onto the screen
                if (currentFacingMode === 'user') {
                    // Coordinates back into mirrored space for painting on ctx
                    ctx.save();
                    ctx.translate(canvas.width, 0);
                    ctx.scale(-1, 1);
                    ctx.fillRect(x, y, 4, 4);
                    ctx.restore();
                } else {
                    ctx.fillRect(x, y, 4, 4);
                }
            }
        }
    }
    if (count > 5) {
        return { x: sumX / count, y: sumY / count };
    }
    return null;
}

async function predictLoop() {
    if (!isPlaying) return;

    if (video.readyState >= 2) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (currentFacingMode === 'user') {
            ctx.save();
            ctx.translate(canvas.width, 0);
            ctx.scale(-1, 1);
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            ctx.restore();
        } else {
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        }

        const poses = await detector.estimatePoses(video, { maxPoses: 1, flipHorizontal: false });
        
        let activeWristRaw = null;
        if (poses.length > 0) {
            const keypoints = poses[0].keypoints;
            
            if (currentFacingMode === 'user') {
                 ctx.save();
                 ctx.translate(canvas.width, 0);
                 ctx.scale(-1, 1);
            }
            drawSkeleton(keypoints);
            if (currentFacingMode === 'user') {
                 ctx.restore();
            }

            const lw = keypoints.find(k => k.name === 'left_wrist');
            const rw = keypoints.find(k => k.name === 'right_wrist');
            if (lw && rw && lw.score > 0.2 && rw.score > 0.2) {
                activeWristRaw = lw.y < rw.y ? lw : rw;
            } else if (lw && lw.score > 0.2) {
                activeWristRaw = lw;
            } else if (rw && rw.score > 0.2) {
                activeWristRaw = rw;
            }
            
            if (activeWristRaw) {
                globalActiveWrist = activeWristRaw; // used in raw coordinates
            }
        }

        // Run the visual thermal tracker synchronously 
        ballCenter = trackOrangeBallNearWrist(video, canvas.width, canvas.height, globalActiveWrist);

        // Draw Tracking Reticle
        if (ballCenter) {
            if (currentFacingMode === 'user') {
                 ctx.save();
                 ctx.translate(canvas.width, 0);
                 ctx.scale(-1, 1);
            }
            ctx.beginPath();
            ctx.arc(ballCenter.x, ballCenter.y, 25, 0, 2 * Math.PI);
            ctx.strokeStyle = "#f97316";
            ctx.lineWidth = 4;
            ctx.stroke();
            if (currentFacingMode === 'user') {
                 ctx.restore();
            }
        }

        if (poses.length > 0) {
            analyzePosture(poses[0].keypoints, ballCenter);
        }
    }

    rafId = requestAnimationFrame(predictLoop);
}

function analyzePosture(keypoints, currentBallCenter) {
    const rightShoulder = keypoints.find(k => k.name === 'right_shoulder');
    const rightElbow = keypoints.find(k => k.name === 'right_elbow');
    const rightWrist = keypoints.find(k => k.name === 'right_wrist');
    const leftShoulder = keypoints.find(k => k.name === 'left_shoulder');
    const leftElbow = keypoints.find(k => k.name === 'left_elbow');
    const leftWrist = keypoints.find(k => k.name === 'left_wrist');

    let activeShoulder = rightShoulder;
    let activeElbow = rightElbow;
    let activeWrist = rightWrist;
    const thresh = 0.2;

    let hasRight = rightShoulder && rightElbow && rightWrist && rightShoulder.score > thresh && rightElbow.score > thresh && rightWrist.score > thresh;
    let hasLeft = leftShoulder && leftElbow && leftWrist && leftShoulder.score > thresh && leftElbow.score > thresh && leftWrist.score > thresh;

    if (hasLeft && hasRight) {
        if (leftWrist.y < rightWrist.y) {
            activeShoulder = leftShoulder; activeElbow = leftElbow; activeWrist = leftWrist;
        }
    } else if (hasLeft) {
        activeShoulder = leftShoulder; activeElbow = leftElbow; activeWrist = leftWrist;
    }

    let elbowAngle = 0;
    if (activeShoulder && activeElbow && activeWrist && activeShoulder.score > thresh && activeElbow.score > thresh && activeWrist.score > thresh) {
        elbowAngle = calculateAngle(activeShoulder, activeElbow, activeWrist);
        elbowAngleEl.textContent = Math.round(elbowAngle) + '°';
    }

    const rightHip = keypoints.find(k => k.name === 'right_hip');
    const rightKnee = keypoints.find(k => k.name === 'right_knee');
    const rightAnkle = keypoints.find(k => k.name === 'right_ankle');
    let kneeAngle = 0;
    if (rightHip && rightKnee && rightAnkle && rightHip.score > 0.3 && rightKnee.score > 0.3 && rightAnkle.score > 0.3) {
        kneeAngle = calculateAngle(rightHip, rightKnee, rightAnkle);
        kneeAngleEl.textContent = Math.round(kneeAngle) + '°';
    }

    let distBallWrist = null;
    if (currentBallCenter && activeWrist && activeWrist.score > thresh) {
        // currentBallCenter is in raw unmirrored coordinates, just like activeWrist
        distBallWrist = Math.hypot(currentBallCenter.x - activeWrist.x, currentBallCenter.y - activeWrist.y);
    }

    if (activeShoulder && activeWrist && activeElbow && elbowAngle > 0) {
        if (phase === 'idle') {
            let holdingBall = distBallWrist !== null && distBallWrist < 150;
            let isGathering = elbowAngle < 130 && activeWrist.y < activeShoulder.y + 40;
            if (isGathering && holdingBall) {
                phase = 'shooting';
                maxElbowAngleDuringShot = elbowAngle;
                updateFeedbackUI('Going up...', true);
                speakFeedback('Shooting');
            } else if (kneeAngle && kneeAngle > 0 && kneeAngle < 160) {
                updateFeedbackUI('Good, bending knees...', true);
            } else {
                updateFeedbackUI('Waiting for shot...', true);
            }
        } else if (phase === 'shooting') {
            if (elbowAngle > maxElbowAngleDuringShot) {
                maxElbowAngleDuringShot = elbowAngle;
            }

            let ballReleased = false;
            // Strict distance spike between ball and hand triggers release
            if (distBallWrist !== null && distBallWrist > 150 && currentBallCenter.y < activeWrist.y - 30) {
                ballReleased = true;
            }

            if (activeWrist.y > activeShoulder.y + 60 || ballReleased) {
                if (maxElbowAngleDuringShot > 115 || ballReleased) {
                    shotCount++;
                    shotCountEl.textContent = shotCount;

                    if (maxElbowAngleDuringShot > 140) {
                        updateFeedbackUI(`Shot ${shotCount}! Excellent Follow-Through!`, true);
                        speakFeedback(`Great shot.`);
                        logTranscript(`Shot ${shotCount}: Score! Excellent arm extension (${Math.round(maxElbowAngleDuringShot)}°).`, 'success');
                    } else {
                        updateFeedbackUI(`Shot ${shotCount}. Extend your elbow more!`, false);
                        speakFeedback(`Shot ${shotCount}. Extend your elbow more.`);
                        logTranscript(`Shot ${shotCount}: Missed. Poor extension (${Math.round(maxElbowAngleDuringShot)}°). Extend elbow fully!`, 'error');
                    }
                } else {
                    updateFeedbackUI('Shot aborted (elbow not fully extended)', false);
                    logTranscript('Shot aborted. Bailed out before extension.', 'error');
                }

                phase = 'cooldown';
                setTimeout(() => { 
                    if (phase === 'cooldown') {
                        phase = 'idle';
                        updateFeedbackUI('Waiting for next shot...', true);
                    }
                }, 1000);
            }
        }
    }
}

startBtn.addEventListener('click', startCamera);
stopBtn.addEventListener('click', stopCamera);

toggleBtn.addEventListener('click', () => {
    // We just toggle the visibility of dashboardPanel
    if (dashboardPanel.style.display === 'none') {
        dashboardPanel.style.display = 'flex';
        // Swap to 'Cross' icon
        toggleBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6L6 18M6 6l12 12"/></svg>`;
    } else {
        dashboardPanel.style.display = 'none';
        // Swap to 'Eye' icon
        toggleBtn.innerHTML = `<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
    }
});

init();
