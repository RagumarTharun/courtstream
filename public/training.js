// Elements
const video = document.getElementById('video');
const canvas = document.getElementById('output');
const ctx = canvas.getContext('2d');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const loader = document.getElementById('loader');

const elbowAngleEl = document.getElementById('elbowAngle');
const kneeAngleEl = document.getElementById('kneeAngle');
const shotCountEl = document.getElementById('shotCount');
const feedbackMsg = document.getElementById('feedbackMsg');

let detector;
let rafId;
let isPlaying = false;
let shotCount = 0;

// Simple state machine for shot detection
let phase = 'idle'; // idle, shooting, cooldown
let maxElbowAngleDuringShot = 0;

async function init() {
    loader.style.display = 'block';
    startBtn.disabled = true;

    try {
        // Load the MoveNet model via MediaPipe in TFJS
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

async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        alert("Camera API not available in this browser.");
        return;
    }

    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'user', width: 640, height: 480 },
            audio: false
        });

        video.srcObject = stream;

        video.onloadedmetadata = () => {
            video.play();
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            isPlaying = true;
            startBtn.style.display = 'none';
            stopBtn.style.display = 'inline-block';
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

    if (video.srcObject) {
        video.srcObject.getTracks().forEach(track => track.stop());
        video.srcObject = null;
    }

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    startBtn.style.display = 'inline-block';
    stopBtn.style.display = 'none';

    elbowAngleEl.textContent = '--°';
    kneeAngleEl.textContent = '--°';
    feedbackMsg.textContent = 'Camera stopped.';
}

// Calculate angle between three 2D points: A, B, C (B is the vertex)
function calculateAngle(a, b, c) {
    const radians = Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(a.y - b.y, a.x - b.x);
    let angle = Math.abs(radians * 180.0 / Math.PI);
    if (angle > 180.0) angle = 360 - angle;
    return angle;
}

// Speak feedback using Web Speech API
function speakFeedback(text) {
    if ('speechSynthesis' in window) {
        // Only speak if not currently speaking to avoid overlapping
        if (!window.speechSynthesis.speaking) {
            const msg = new SpeechSynthesisUtterance(text);
            msg.rate = 1.1; // Slightly faster
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

async function predictLoop() {
    if (!isPlaying) return;

    if (video.readyState >= 2) {
        // Detect poses
        const poses = await detector.estimatePoses(video, { maxPoses: 1, flipHorizontal: false }); // We mirrored via CSS, so we don't flip horizontally in TFJS unless coords don't match.

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        // Extremely fast custom ball tracking reading from video directly
        const ballCenter = trackOrangeBall(video, canvas.width, canvas.height);
        if (ballCenter) {
            ctx.beginPath();
            ctx.arc(ballCenter.x, ballCenter.y, 25, 0, 2 * Math.PI);
            ctx.strokeStyle = "#f97316";
            ctx.lineWidth = 4;
            ctx.stroke();
            ctx.fillStyle = "#f97316";
            ctx.fillText("Ball", ballCenter.x - 12, ballCenter.y - 30);
        }

        if (poses.length > 0) {
            const keypoints = poses[0].keypoints;
            drawSkeleton(keypoints);
            analyzePosture(keypoints, ballCenter);
        }
    }

    // Throttle requestAnimationFrame slightly if performance drops, but let's try 60fps first.
    rafId = requestAnimationFrame(predictLoop);
}

function drawSkeleton(keypoints) {
    // Filter out low confidence points
    const points = keypoints.filter(p => p.score > 0.3);

    // Draw points
    ctx.fillStyle = "#3b82f6";
    points.forEach(point => {
        ctx.beginPath();
        ctx.arc(point.x, point.y, 5, 0, 2 * Math.PI);
        ctx.fill();
    });

    // Define connections for skeleton
    const adjacentKeyPoints = poseDetection.util.getAdjacentPairs(poseDetection.SupportedModels.MoveNet);

    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 2;

    adjacentKeyPoints.forEach((pair) => {
        const i = pair[0];
        const j = pair[1];
        const kp1 = keypoints[i];
        const kp2 = keypoints[j];

        // If both points have a score > 0.3, draw a line between them
        if (kp1.score > 0.3 && kp2.score > 0.3) {
            ctx.beginPath();
            ctx.moveTo(kp1.x, kp1.y);
            ctx.lineTo(kp2.x, kp2.y);
            ctx.stroke();
        }
    });
}

let offscreenCanvas = null;
let offCtx = null;

function trackOrangeBall(videoEl, width, height) {
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
    
    for (let y = 0; y < height; y += 4) {
        for (let x = 0; x < width; x += 4) {
            const i = (y * width + x) * 4;
            const r = data[i], g = data[i+1], b = data[i+2];
            if (r > 100 && r > g * 1.1 && g > b * 1.1 && (r - g) > 20) {
                sumX += x;
                sumY += y;
                count++;
            }
        }
    }
    if (count > 20) {
        return { x: sumX / count, y: sumY / count };
    }
    return null;
}

function analyzePosture(keypoints, ballCenter) {
    // Identify key joints for BOTH arms to dynamically pick the shooting arm
    const rightShoulder = keypoints.find(k => k.name === 'right_shoulder');
    const rightElbow = keypoints.find(k => k.name === 'right_elbow');
    const rightWrist = keypoints.find(k => k.name === 'right_wrist');

    const leftShoulder = keypoints.find(k => k.name === 'left_shoulder');
    const leftElbow = keypoints.find(k => k.name === 'left_elbow');
    const leftWrist = keypoints.find(k => k.name === 'left_wrist');

    // Find the primary shooting arm (the one that is higher or more visible)
    let activeShoulder = rightShoulder;
    let activeElbow = rightElbow;
    let activeWrist = rightWrist;

    // Using a lower threshold (0.2) to not lose tracking during fast motion blur
    const thresh = 0.2;

    let hasRight = rightShoulder && rightElbow && rightWrist && rightShoulder.score > thresh && rightElbow.score > thresh && rightWrist.score > thresh;
    let hasLeft = leftShoulder && leftElbow && leftWrist && leftShoulder.score > thresh && leftElbow.score > thresh && leftWrist.score > thresh;

    if (hasLeft && hasRight) {
        // Both visible, pick the hand that is higher up (smaller y)
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

    // UI update for knees contextually, optional now
    const rightHip = keypoints.find(k => k.name === 'right_hip');
    const rightKnee = keypoints.find(k => k.name === 'right_knee');
    const rightAnkle = keypoints.find(k => k.name === 'right_ankle');
    let kneeAngle = 0;
    if (rightHip && rightKnee && rightAnkle && rightHip.score > 0.3 && rightKnee.score > 0.3 && rightAnkle.score > 0.3) {
        kneeAngle = calculateAngle(rightHip, rightKnee, rightAnkle);
        kneeAngleEl.textContent = Math.round(kneeAngle) + '°';
    }

    // Distance from wrist to ball (if tracked)
    let distBallWrist = null;
    if (ballCenter && activeWrist && activeWrist.score > thresh) {
        distBallWrist = Math.hypot(ballCenter.x - activeWrist.x, ballCenter.y - activeWrist.y);
    }

    // Basic Shot Detection Logic & Feedback combining Arm angle and Ball tracking
    if (activeShoulder && activeWrist && activeElbow && elbowAngle > 0) {
        if (phase === 'idle') {
            // Looser check: if wrist is above shoulder + 20px (accounting for chest shots)
            // AND they are loosely holding the ball or the ball tracking is temporarily lost overhead
            let holdingBall = distBallWrist === null || distBallWrist < 100;

            if (activeWrist.y < activeShoulder.y + 30 && holdingBall) {
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
            // if the ball suddenly spikes in distance from wrist (ball goes up, wrist stops)
            if (distBallWrist !== null && distBallWrist > 120 && ballCenter.y < activeWrist.y - 30) {
                ballReleased = true;
            }

            // Has the arm come back down OR ball clearly released?
            if (activeWrist.y > activeShoulder.y + 40 || ballReleased) {
                if (maxElbowAngleDuringShot > 120 || ballReleased) {
                    shotCount++;
                    shotCountEl.textContent = shotCount;

                    if (maxElbowAngleDuringShot > 145) {
                        updateFeedbackUI(`Shot ${shotCount}! Excellent Follow-Through!`, true);
                        speakFeedback(`Great shot. Excellent extension.`);
                    } else {
                        updateFeedbackUI(`Shot ${shotCount}. Extend your elbow more!`, false);
                        speakFeedback(`Shot ${shotCount}. Extend your elbow more.`);
                    }
                } else {
                    updateFeedbackUI('Shot aborted (elbow not fully extended)', false);
                    speakFeedback('Shot aborted.');
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

// Event Listeners
startBtn.addEventListener('click', startCamera);
stopBtn.addEventListener('click', stopCamera);

// Initialize models on load
init();
