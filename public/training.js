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

        if (poses.length > 0) {
            const keypoints = poses[0].keypoints;
            drawSkeleton(keypoints);
            analyzePosture(keypoints);
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

function analyzePosture(keypoints) {
    // Identify key joints. We assume right-handed shooter for now (can be made dynamic).
    const rightShoulder = keypoints.find(k => k.name === 'right_shoulder');
    const rightElbow = keypoints.find(k => k.name === 'right_elbow');
    const rightWrist = keypoints.find(k => k.name === 'right_wrist');

    const rightHip = keypoints.find(k => k.name === 'right_hip');
    const rightKnee = keypoints.find(k => k.name === 'right_knee');
    const rightAnkle = keypoints.find(k => k.name === 'right_ankle');

    let elbowAngle = 0;
    let kneeAngle = 0;

    if (rightShoulder && rightElbow && rightWrist &&
        rightShoulder.score > 0.3 && rightElbow.score > 0.3 && rightWrist.score > 0.3) {
        elbowAngle = calculateAngle(rightShoulder, rightElbow, rightWrist);
        elbowAngleEl.textContent = Math.round(elbowAngle) + '°';
    }

    if (rightHip && rightKnee && rightAnkle &&
        rightHip.score > 0.3 && rightKnee.score > 0.3 && rightAnkle.score > 0.3) {
        kneeAngle = calculateAngle(rightHip, rightKnee, rightAnkle);
        kneeAngleEl.textContent = Math.round(kneeAngle) + '°';
    }

    // Basic Shot Detection Logic & Feedback (Max Extension Tracking)
    // A shot starts when wrist goes above shoulder.
    // We track the maximum elbow angle while the arm is up.
    // Once arm comes back down, we evaluate the shot based on max extension.

    if (rightShoulder && rightWrist && rightElbow && kneeAngle && elbowAngle) {
        if (phase === 'idle') {
            if (rightWrist.y < rightShoulder.y) {
                // Arm raised above shoulder -> Started shooting phase
                phase = 'shooting';
                maxElbowAngleDuringShot = elbowAngle;
                updateFeedbackUI('Going up...', true);
                // Verbal command disabled intentionally to not interrupt the actual shot, but we can do a subtle one
                speakFeedback('Shooting');
            } else if (kneeAngle < 160) {
                // Bending knees (UI feedback only)
                updateFeedbackUI('Good, bending knees...', true);
            } else {
                updateFeedbackUI('Waiting for shot...', true);
            }
        } else if (phase === 'shooting') {
            // Track max extension while arm is up
            if (elbowAngle > maxElbowAngleDuringShot) {
                maxElbowAngleDuringShot = elbowAngle;
            }

            // Has the arm come back down?
            if (rightWrist.y > rightShoulder.y) {
                // Evaluate the shot
                if (maxElbowAngleDuringShot > 130) {
                    // Count as a shot
                    shotCount++;
                    shotCountEl.textContent = shotCount;

                    if (maxElbowAngleDuringShot > 150) {
                        updateFeedbackUI(`Shot ${shotCount}! Excellent Follow-Through!`, true);
                        speakFeedback(`Great shot. Excellent extension.`);
                    } else {
                        updateFeedbackUI(`Shot ${shotCount}. Extend your elbow more!`, false);
                        speakFeedback(`Shot ${shotCount}. Extend your elbow more.`);
                    }
                } else {
                    // Arm went up and down without extending clearly -> Aborted or fake out
                    updateFeedbackUI('Shot aborted (elbow not fully extended)', false);
                    speakFeedback('Shot aborted.');
                }

                // Cooldown to prevent double counting right away
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
