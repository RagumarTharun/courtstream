/**
 * CourtStream - Iris Control Director Module
 * Real-time Gaze-Driven Camera Direction Engine using MediaPipe FaceMesh
 */

(function () {
  'use strict';

  /* ==========================================================================
     1. CENTRALIZED STATE MANAGEMENT
     ========================================================================== */
  const irisState = {
    directorMode: 'AUTO', // 'AUTO' | 'MANUAL'
    activeStream: 'CENTER', // 'LEFT' | 'CENTER' | 'RIGHT'
    gazeIntent: 'CENTER', // 'LEFT' | 'CENTER' | 'RIGHT'
    
    // Telemetry & Smoothing
    rawRatio: 0.50,
    smoothedRatio: 0.50,
    emaAlpha: 0.20,
    
    // Dwell Time & Hysteresis
    dwellTimeMs: 250,
    dwellStartTime: null,
    dwellTargetIntent: null,
    dwellProgress: 0,
    
    // Dynamic Calibration Thresholds
    leftCutoff: 0.38,
    rightCutoff: 0.62,
    
    // Manual Override Timeout
    manualOverrideTimer: null,
    manualOverrideUntil: 0,

    // Calibration Flow State
    calibrationActive: false
  };

  // Load saved calibration if present
  try {
    const savedLeft = localStorage.getItem('cs_iris_leftCutoff');
    const savedRight = localStorage.getItem('cs_iris_rightCutoff');
    if (savedLeft && savedRight) {
      irisState.leftCutoff = parseFloat(savedLeft);
      irisState.rightCutoff = parseFloat(savedRight);
      console.log(`👁️ Loaded calibration from storage: Left ${irisState.leftCutoff}, Right ${irisState.rightCutoff}`);
    }
  } catch (e) {
    console.warn('Storage read error:', e);
  }

  /* ==========================================================================
     2. DOM ELEMENTS
     ========================================================================== */
  const stageCanvas = document.getElementById('stageCanvas');
  const stageCtx = stageCanvas ? stageCanvas.getContext('2d') : null;
  const switchIndicator = document.getElementById('switchIndicator');
  const switchText = document.getElementById('switchText');
  const stageModePill = document.getElementById('stageModePill');
  const stageModeText = document.getElementById('stageModeText');
  const stageCamTitle = document.getElementById('stageCamTitle');

  const webcamVideo = document.getElementById('webcamVideo');
  const gazeMeshCanvas = document.getElementById('gazeMeshCanvas');
  const gazeMeshCtx = gazeMeshCanvas ? gazeMeshCanvas.getContext('2d') : null;
  const webcamPip = document.getElementById('webcamPip');
  const pipCollapseBtn = document.getElementById('pipCollapseBtn');
  const btnTogglePip = document.getElementById('btnTogglePip');
  const btnFullscreen = document.getElementById('btnFullscreen');

  // Mode Buttons
  const btnModeAuto = document.getElementById('btnModeAuto');
  const btnModeManual = document.getElementById('btnModeManual');

  // Feed Bars
  const feedBars = {
    LEFT: document.getElementById('barFeedLeft'),
    CENTER: document.getElementById('barFeedCenter'),
    RIGHT: document.getElementById('barFeedRight')
  };

  const dwellFills = {
    LEFT: document.getElementById('dwellProgressLeft'),
    CENTER: document.getElementById('dwellProgressCenter'),
    RIGHT: document.getElementById('dwellProgressRight')
  };

  const thumbCanvases = {
    LEFT: document.getElementById('thumbLeft'),
    CENTER: document.getElementById('thumbCenter'),
    RIGHT: document.getElementById('thumbRight')
  };

  // Metrics & Sliders
  const meterRatioVal = document.getElementById('meterRatioVal');
  const meterIntentText = document.getElementById('meterIntentText');
  const gazeNeedle = document.getElementById('gazeNeedle');
  const zoneLeftEl = document.getElementById('zoneLeftEl');
  const zoneCenterEl = document.getElementById('zoneCenterEl');
  const zoneRightEl = document.getElementById('zoneRightEl');

  const sliderDwellTime = document.getElementById('sliderDwellTime');
  const valDwellTime = document.getElementById('valDwellTime');
  const sliderEmaAlpha = document.getElementById('sliderEmaAlpha');
  const valEmaAlpha = document.getElementById('valEmaAlpha');
  const btnStartCalib = document.getElementById('btnStartCalib');

  // Calibration Overlay
  const calibrationOverlay = document.getElementById('calibrationOverlay');
  const calibTarget = document.getElementById('calibTarget');
  const calibTitle = document.getElementById('calibTitle');
  const calibSubtext = document.getElementById('calibSubtext');

  /* ==========================================================================
     3. SIMULATED COURT FEEDS & WEBRTC MANAGER
     ========================================================================== */
  const courtFeeds = {
    LEFT: { name: 'Cam 01 - Baseline Left', angle: -35, color: '#3b82f6', videoTrack: null },
    CENTER: { name: 'Cam 02 - Midcourt Main', angle: 0, color: '#ef4444', videoTrack: null },
    RIGHT: { name: 'Cam 03 - Baseline Right', angle: 35, color: '#22c55e', videoTrack: null }
  };

  let animFrameId = null;
  let simulatedBallX = 0;
  let simulatedBallSpeed = 1.8;

  // Initialize canvas resolutions
  function resizeCanvases() {
    if (stageCanvas) {
      stageCanvas.width = stageCanvas.parentElement.clientWidth || 1280;
      stageCanvas.height = stageCanvas.parentElement.clientHeight || 720;
    }
    Object.keys(thumbCanvases).forEach(key => {
      const cvs = thumbCanvases[key];
      if (cvs) {
        cvs.width = 300;
        cvs.height = 168;
      }
    });
    if (gazeMeshCanvas) {
      gazeMeshCanvas.width = gazeMeshCanvas.parentElement.clientWidth || 220;
      gazeMeshCanvas.height = gazeMeshCanvas.parentElement.clientHeight || 127;
    }
  }

  window.addEventListener('resize', resizeCanvases);
  resizeCanvases();

  // Render court graphics on canvas
  function renderCourtView(ctx, width, height, feedKey) {
    if (!ctx) return;
    const feed = courtFeeds[feedKey];
    
    // Dark court background
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, width, height);

    // Perspective transformation based on camera angle
    ctx.save();
    ctx.translate(width / 2, height / 2);

    // Dynamic camera angle tilt
    if (feedKey === 'LEFT') {
      ctx.transform(0.85, 0, -0.25, 0.9, -width * 0.15, 0);
    } else if (feedKey === 'RIGHT') {
      ctx.transform(0.85, 0, 0.25, 0.9, width * 0.15, 0);
    } else {
      ctx.transform(0.95, 0, 0, 0.95, 0, 0);
    }

    // Wood court floor
    const courtW = width * 0.75;
    const courtH = height * 0.65;
    ctx.fillStyle = '#1e293b';
    ctx.fillRect(-courtW / 2, -courtH / 2, courtW, courtH);

    // Court boundaries
    ctx.strokeStyle = feed.color;
    ctx.lineWidth = 4;
    ctx.strokeRect(-courtW / 2, -courtH / 2, courtW, courtH);

    // Center line & key circle
    ctx.beginPath();
    ctx.moveTo(0, -courtH / 2);
    ctx.lineTo(0, courtH / 2);
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(0, 0, courtH * 0.22, 0, Math.PI * 2);
    ctx.stroke();

    // Key paint areas (3-point arc & key)
    ctx.strokeRect(-courtW / 2, -courtH * 0.2, courtW * 0.2, courtH * 0.4);
    ctx.strokeRect(courtW / 2 - courtW * 0.2, -courtH * 0.2, courtW * 0.2, courtH * 0.4);

    // Animated Basketball motion
    const ballPos = (simulatedBallX / 100) * (courtW * 0.8) - (courtW * 0.4);
    ctx.fillStyle = '#f97316';
    ctx.beginPath();
    ctx.arc(ballPos, Math.sin(simulatedBallX * 0.1) * 20, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5;
    ctx.stroke();

    ctx.restore();

    // Camera Label Overlay
    ctx.fillStyle = 'rgba(15, 23, 42, 0.75)';
    ctx.fillRect(12, 12, 160, 28);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 12px Inter, sans-serif';
    ctx.fillText(feed.name, 22, 30);
  }

  // Animation Loop
  function mainRenderLoop() {
    simulatedBallX += simulatedBallSpeed;
    if (simulatedBallX > 100 || simulatedBallX < 0) {
      simulatedBallSpeed = -simulatedBallSpeed;
    }

    // Render active feed to main stage
    if (stageCtx && stageCanvas) {
      renderCourtView(stageCtx, stageCanvas.width, stageCanvas.height, irisState.activeStream);
    }

    // Render thumbnail previews
    Object.keys(thumbCanvases).forEach(key => {
      const cvs = thumbCanvases[key];
      if (cvs) {
        const cCtx = cvs.getContext('2d');
        renderCourtView(cCtx, cvs.width, cvs.height, key);
      }
    });

    animFrameId = requestAnimationFrame(mainRenderLoop);
  }

  mainRenderLoop();

  /* ==========================================================================
     4. MEDIAPIPE FACE MESH & GAZE TRACKING ENGINE
     ========================================================================== */
  let faceMeshInstance = null;
  let webcamCamera = null;
  let localMediaStream = null;

  // Helper Euclidean distance formula
  function euclideanDist(p1, p2) {
    if (!p1 || !p2) return 0;
    const dx = p1.x - p2.x;
    const dy = p1.y - p2.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // Process Landmarks Callback
  function onFaceMeshResults(results) {
    if (!results || !results.multiFaceLandmarks || results.multiFaceLandmarks.length === 0) {
      // Clear mesh canvas if face lost
      if (gazeMeshCtx && gazeMeshCanvas) {
        gazeMeshCtx.clearRect(0, 0, gazeMeshCanvas.width, gazeMeshCanvas.height);
      }
      return;
    }

    const landmarks = results.multiFaceLandmarks[0];

    // Landmark Indices:
    // Left Iris: 468 | Right Iris: 473
    // Left Eye Corners: Outer (33), Inner (133)
    // Right Eye Corners: Outer (362), Inner (263)
    const leftIris = landmarks[468];
    const rightIris = landmarks[473];
    const leftCornerOuter = landmarks[33];
    const leftCornerInner = landmarks[133];
    const rightCornerOuter = landmarks[362];
    const rightCornerInner = landmarks[263];

    if (!leftIris || !rightIris || !leftCornerOuter || !leftCornerInner || !rightCornerOuter || !rightCornerInner) {
      return;
    }

    // Calculate normalized horizontal ratio for left & right eye
    // Ratio = dist(Iris, OuterCorner) / dist(InnerCorner, OuterCorner)
    const leftDistIrisOuter = euclideanDist(leftIris, leftCornerOuter);
    const leftDistInnerOuter = euclideanDist(leftCornerInner, leftCornerOuter);
    const ratioLeft = leftDistInnerOuter > 0 ? (leftDistIrisOuter / leftDistInnerOuter) : 0.5;

    const rightDistIrisOuter = euclideanDist(rightIris, rightCornerOuter);
    const rightDistInnerOuter = euclideanDist(rightCornerInner, rightCornerOuter);
    const ratioRight = rightDistInnerOuter > 0 ? (rightDistIrisOuter / rightDistInnerOuter) : 0.5;

    // Average raw ratio across both eyes (normalized ~0.0 to 1.0)
    let rawRatio = (ratioLeft + ratioRight) / 2.0;

    // Normalizing clamp & scale to full range 0.0 - 1.0
    // Standard eye iris distance ratios usually fall between 0.30 and 0.70
    rawRatio = Math.max(0.0, Math.min(1.0, (rawRatio - 0.25) / 0.50));
    irisState.rawRatio = rawRatio;

    // Apply Exponential Moving Average (EMA) Filter
    // smoothedRatio = alpha * rawRatio + (1 - alpha) * prevSmoothed
    irisState.smoothedRatio = (irisState.emaAlpha * rawRatio) + ((1.0 - irisState.emaAlpha) * irisState.smoothedRatio);

    // Evaluate Gaze Intent with Hysteresis Zones
    let evaluatedIntent = 'CENTER';
    if (irisState.smoothedRatio < irisState.leftCutoff) {
      evaluatedIntent = 'LEFT';
    } else if (irisState.smoothedRatio > irisState.rightCutoff) {
      evaluatedIntent = 'RIGHT';
    } else {
      evaluatedIntent = 'CENTER';
    }

    irisState.gazeIntent = evaluatedIntent;

    // Dwell Time State Machine & Switch Execution
    const now = performance.now();
    if (irisState.dwellTargetIntent !== evaluatedIntent) {
      irisState.dwellTargetIntent = evaluatedIntent;
      irisState.dwellStartTime = now;
      irisState.dwellProgress = 0;
    } else {
      const elapsed = now - (irisState.dwellStartTime || now);
      irisState.dwellProgress = Math.min(1.0, elapsed / irisState.dwellTimeMs);

      // Firing Stream Switch when dwell threshold reached
      if (irisState.dwellProgress >= 1.0 && irisState.activeStream !== evaluatedIntent) {
        if (irisState.directorMode === 'AUTO') {
          // Check if temporary manual override is active
          if (now > irisState.manualOverrideUntil) {
            setActiveStream(evaluatedIntent);
          }
        }
      }
    }

    // Draw Face Mesh PiP Debug Overlay
    drawGazeOverlay(landmarks);

    // Update Telemetry & Metrics UI
    updateMetricsUI();
  }

  // Draw Gaze Mesh & Iris Vector on PiP Canvas
  function drawGazeOverlay(landmarks) {
    if (!gazeMeshCtx || !gazeMeshCanvas) return;
    const w = gazeMeshCanvas.width;
    const h = gazeMeshCanvas.height;

    gazeMeshCtx.clearRect(0, 0, w, h);

    // Eye Contour Points
    const leftEyeIndices = [33, 160, 158, 133, 153, 144];
    const rightEyeIndices = [362, 385, 387, 263, 373, 380];

    gazeMeshCtx.lineWidth = 1.5;

    // Draw Left Eye Outline
    gazeMeshCtx.strokeStyle = 'rgba(6, 182, 212, 0.7)';
    gazeMeshCtx.beginPath();
    leftEyeIndices.forEach((idx, i) => {
      const pt = landmarks[idx];
      if (i === 0) gazeMeshCtx.moveTo(pt.x * w, pt.y * h);
      else gazeMeshCtx.lineTo(pt.x * w, pt.y * h);
    });
    gazeMeshCtx.closePath();
    gazeMeshCtx.stroke();

    // Draw Right Eye Outline
    gazeMeshCtx.strokeStyle = 'rgba(6, 182, 212, 0.7)';
    gazeMeshCtx.beginPath();
    rightEyeIndices.forEach((idx, i) => {
      const pt = landmarks[idx];
      if (i === 0) gazeMeshCtx.moveTo(pt.x * w, pt.y * h);
      else gazeMeshCtx.lineTo(pt.x * w, pt.y * h);
    });
    gazeMeshCtx.closePath();
    gazeMeshCtx.stroke();

    // Draw Iris Points (468, 473)
    const leftIris = landmarks[468];
    const rightIris = landmarks[473];

    if (leftIris && rightIris) {
      gazeMeshCtx.fillStyle = '#06b6d4';
      gazeMeshCtx.beginPath();
      gazeMeshCtx.arc(leftIris.x * w, leftIris.y * h, 3, 0, Math.PI * 2);
      gazeMeshCtx.arc(rightIris.x * w, rightIris.y * h, 3, 0, Math.PI * 2);
      gazeMeshCtx.fill();

      // Gaze Vector Indicator Line
      const avgX = (leftIris.x + rightIris.x) / 2 * w;
      const avgY = (leftIris.y + rightIris.y) / 2 * h;

      // Vector direction based on smoothed ratio
      const vectorDx = (irisState.smoothedRatio - 0.5) * 60;

      gazeMeshCtx.strokeStyle = '#ef4444';
      gazeMeshCtx.lineWidth = 2;
      gazeMeshCtx.beginPath();
      gazeMeshCtx.moveTo(avgX, avgY);
      gazeMeshCtx.lineTo(avgX + vectorDx, avgY);
      gazeMeshCtx.stroke();
    }
  }

  // Initialize MediaPipe FaceMesh Engine
  async function initIrisTracking() {
    try {
      if (typeof window.FaceMesh === 'undefined') {
        console.warn('⚠️ MediaPipe FaceMesh SDK loading from CDN...');
      }

      faceMeshInstance = new window.FaceMesh({
        locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
      });

      faceMeshInstance.setOptions({
        maxNumFaces: 1,
        refineLandmarks: true,
        minDetectionConfidence: 0.5,
        minTrackingConfidence: 0.5
      });

      faceMeshInstance.onResults(onFaceMeshResults);

      // Acquire Webcam Access
      localMediaStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
        audio: false
      });

      if (webcamVideo) {
        webcamVideo.srcObject = localMediaStream;
        await webcamVideo.play();

        // Start Camera Utils Loop
        if (window.Camera) {
          webcamCamera = new window.Camera(webcamVideo, {
            onFrame: async () => {
              if (faceMeshInstance && webcamVideo && webcamVideo.readyState >= 2) {
                await faceMeshInstance.send({ image: webcamVideo });
              }
            },
            width: 640,
            height: 480
          });
          webcamCamera.start();
        } else {
          // Fallback animation frame sender
          const sendFrame = async () => {
            if (faceMeshInstance && webcamVideo && webcamVideo.readyState >= 2) {
              await faceMeshInstance.send({ image: webcamVideo });
            }
            requestAnimationFrame(sendFrame);
          };
          sendFrame();
        }
      }
      console.log('✅ Iris Gaze Tracking Engine initialized successfully!');
    } catch (err) {
      console.error('⚠️ Webcam / MediaPipe Init Error:', err);
      // Display graceful fallback note
      if (meterIntentText) {
        meterIntentText.innerText = 'WEBCAM OFFLINE (SIMULATING GAZE)';
      }
    }
  }

  /* ==========================================================================
     5. STREAM SWITCHING & UI UPDATES
     ========================================================================== */
  function setActiveStream(feedKey, isManual = false) {
    if (!courtFeeds[feedKey] || irisState.activeStream === feedKey) return;

    irisState.activeStream = feedKey;
    const feed = courtFeeds[feedKey];

    // Trigger visual switch indicator banner
    if (switchIndicator && switchText) {
      switchText.innerText = `SWITCHED TO ${feedKey} CAMERA`;
      switchIndicator.classList.add('active');
      setTimeout(() => switchIndicator.classList.remove('active'), 1200);
    }

    // Update Main Stage Header
    if (stageCamTitle) {
      stageCamTitle.innerText = feed.name;
    }

    // If manual switch triggered in AUTO mode, set 8-second temporary override
    if (isManual && irisState.directorMode === 'AUTO') {
      irisState.manualOverrideUntil = performance.now() + (irisState.manualOverrideTimeoutSec * 1000);
      showToast(`Manual override active for ${irisState.manualOverrideTimeoutSec}s`);
    }

    // Socket.IO signaling event if connected to server room
    if (typeof socket !== 'undefined' && socket && socket.emit) {
      socket.emit('control', {
        data: { type: 'switch-stream', feed: feedKey }
      });
    }

    updateFeedBarsUI();
  }

  function updateFeedBarsUI() {
    Object.keys(feedBars).forEach(key => {
      const bar = feedBars[key];
      if (!bar) return;

      const badge = bar.querySelector('.feed-state-badge');
      bar.classList.remove('state-active', 'state-gaze-focus');

      if (key === irisState.activeStream) {
        bar.classList.add('state-active');
        if (badge) badge.innerText = 'LIVE';
      } else if (key === irisState.gazeIntent && irisState.directorMode === 'AUTO') {
        bar.classList.add('state-gaze-focus');
        if (badge) badge.innerText = 'GAZE FOCUS';
      } else {
        if (badge) badge.innerText = 'INACTIVE';
      }
    });
  }

  function updateMetricsUI() {
    const ratio = irisState.smoothedRatio;

    // Needle position (0.0 to 1.0 -> 0% to 100%)
    if (gazeNeedle) {
      gazeNeedle.style.left = `${(ratio * 100).toFixed(1)}%`;
    }

    if (meterRatioVal) {
      meterRatioVal.innerText = ratio.toFixed(2);
    }

    if (meterIntentText) {
      meterIntentText.innerText = `INTENT: ${irisState.gazeIntent}`;
    }

    // Dwell Progress fills on sidebar option cards
    Object.keys(dwellFills).forEach(key => {
      const fill = dwellFills[key];
      if (!fill) return;

      if (key === irisState.dwellTargetIntent && irisState.directorMode === 'AUTO') {
        fill.style.width = `${(irisState.dwellProgress * 100).toFixed(0)}%`;
      } else {
        fill.style.width = '0%';
      }
    });

    updateFeedBarsUI();
  }

  /* ==========================================================================
     6. 3-POINT QUICK CALIBRATION SYSTEM
     ========================================================================== */
  async function runQuickCalibration() {
    if (irisState.calibrationActive) return;
    irisState.calibrationActive = true;

    if (calibrationOverlay) calibrationOverlay.classList.add('active');

    const calibPoints = [
      { key: 'LEFT', pos: '10%', title: 'LOOK AT LEFT TARGET', sub: 'Hold your gaze steady on the red dot' },
      { key: 'CENTER', pos: '50%', title: 'LOOK AT CENTER TARGET', sub: 'Hold your gaze steady on the red dot' },
      { key: 'RIGHT', pos: '90%', title: 'LOOK AT RIGHT TARGET', sub: 'Hold your gaze steady on the red dot' }
    ];

    const collectedRatios = { LEFT: [], CENTER: [], RIGHT: [] };

    for (const pt of calibPoints) {
      if (calibTarget) calibTarget.style.left = pt.pos;
      if (calibTitle) calibTitle.innerText = pt.title;
      if (calibSubtext) calibSubtext.innerText = pt.sub;

      // Sample gaze ratio over 1.5 seconds
      const startTime = performance.now();
      while (performance.now() - startTime < 1500) {
        collectedRatios[pt.key].push(irisState.rawRatio);
        await new Promise(r => setTimeout(r, 50));
      }
    }

    // Calculate averages for each target point
    const avgLeft = averageArray(collectedRatios.LEFT) || 0.25;
    const avgCenter = averageArray(collectedRatios.CENTER) || 0.50;
    const avgRight = averageArray(collectedRatios.RIGHT) || 0.75;

    // Derive new dynamic cutoffs
    irisState.leftCutoff = Math.max(0.20, Math.min(0.46, (avgLeft + avgCenter) / 2.0));
    irisState.rightCutoff = Math.min(0.80, Math.max(0.54, (avgCenter + avgRight) / 2.0));

    // Save to local storage
    try {
      localStorage.setItem('cs_iris_leftCutoff', irisState.leftCutoff.toFixed(3));
      localStorage.setItem('cs_iris_rightCutoff', irisState.rightCutoff.toFixed(3));
    } catch (e) {
      console.warn('Storage write error:', e);
    }

    // Update zone element widths
    if (zoneLeftEl) zoneLeftEl.style.width = `${(irisState.leftCutoff * 100).toFixed(1)}%`;
    if (zoneCenterEl) zoneCenterEl.style.width = `${((irisState.rightCutoff - irisState.leftCutoff) * 100).toFixed(1)}%`;
    if (zoneRightEl) zoneRightEl.style.width = `${((1 - irisState.rightCutoff) * 100).toFixed(1)}%`;

    if (calibrationOverlay) calibrationOverlay.classList.remove('active');
    irisState.calibrationActive = false;

    showToast(`Calibration Complete! Left: ${irisState.leftCutoff.toFixed(2)}, Right: ${irisState.rightCutoff.toFixed(2)}`);
  }

  function averageArray(arr) {
    if (!arr || arr.length === 0) return 0;
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  /* ==========================================================================
     7. EVENT LISTENERS & USER CONTROLS
     ========================================================================== */
  // Segmented Mode Control
  if (btnModeAuto) {
    btnModeAuto.addEventListener('click', () => {
      setDirectorMode('AUTO');
    });
  }

  if (btnModeManual) {
    btnModeManual.addEventListener('click', () => {
      setDirectorMode('MANUAL');
    });
  }

  function setDirectorMode(mode) {
    irisState.directorMode = mode;

    if (btnModeAuto) btnModeAuto.classList.toggle('active', mode === 'AUTO');
    if (btnModeManual) btnModeManual.classList.toggle('active', mode === 'MANUAL');

    if (stageModePill) {
      stageModePill.className = `status-pill ${mode === 'AUTO' ? 'mode-auto' : 'mode-manual'}`;
    }

    if (stageModeText) {
      stageModeText.innerText = mode === 'AUTO' ? 'AUTO (IRIS)' : 'MANUAL OVERRIDE';
    }

    updateFeedBarsUI();
    showToast(`Director Mode: ${mode}`);
  }

  // Feed Bar Option Card Clicks
  Object.keys(feedBars).forEach(key => {
    const bar = feedBars[key];
    if (bar) {
      bar.addEventListener('click', () => {
        setActiveStream(key, true);
      });
    }
  });

  // Slider Controls
  if (sliderDwellTime) {
    sliderDwellTime.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      irisState.dwellTimeMs = val;
      if (valDwellTime) valDwellTime.innerText = `${val} ms`;
    });
  }

  if (sliderEmaAlpha) {
    sliderEmaAlpha.addEventListener('input', (e) => {
      const val = parseFloat(e.target.value);
      irisState.emaAlpha = val;
      if (valEmaAlpha) valEmaAlpha.innerText = val.toFixed(2);
    });
  }

  if (btnStartCalib) {
    btnStartCalib.addEventListener('click', runQuickCalibration);
  }

  // PiP Collapse / Expand
  if (pipCollapseBtn) {
    pipCollapseBtn.addEventListener('click', () => {
      if (webcamPip) webcamPip.classList.toggle('minimized');
    });
  }

  if (btnTogglePip) {
    btnTogglePip.addEventListener('click', () => {
      if (webcamPip) {
        webcamPip.style.display = webcamPip.style.display === 'none' ? 'block' : 'none';
      }
    });
  }

  // Fullscreen toggle
  if (btnFullscreen) {
    btnFullscreen.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(err => console.error(err));
      } else {
        document.exitFullscreen();
      }
    });
  }

  // Keyboard Shortcuts
  window.addEventListener('keydown', (e) => {
    if (e.key === '1' || e.key === 'l' || e.key === 'L') {
      setActiveStream('LEFT', true);
    } else if (e.key === '2' || e.key === 'c' || e.key === 'C') {
      setActiveStream('CENTER', true);
    } else if (e.key === '3' || e.key === 'r' || e.key === 'R') {
      setActiveStream('RIGHT', true);
    } else if (e.key === 'a' || e.key === 'A') {
      setDirectorMode('AUTO');
    } else if (e.key === 'm' || e.key === 'M') {
      setDirectorMode('MANUAL');
    }
  });

  // Simple Toast Feedback
  function showToast(msg) {
    let toast = document.getElementById('csIrisToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'csIrisToast';
      toast.style.cssText = `
        position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%);
        background: rgba(15, 23, 42, 0.95); border: 1px solid #3b425b;
        color: #f1f5f9; padding: 10px 20px; border-radius: 10px; font-size: 12px;
        font-weight: 700; z-index: 200; box-shadow: 0 4px 20px rgba(0,0,0,0.5);
        pointer-events: none; transition: opacity 0.3s;
      `;
      document.body.appendChild(toast);
    }
    toast.innerText = msg;
    toast.style.opacity = '1';
    setTimeout(() => { toast.style.opacity = '0'; }, 2200);
  }

  /* ==========================================================================
     8. CLEAN TEARDOWN & LIFECYCLE MANAGEMENT
     ========================================================================== */
  function teardown() {
    console.log('🧹 Tearing down Iris Director Page resources...');

    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
    }

    if (webcamCamera && webcamCamera.stop) {
      try { webcamCamera.stop(); } catch (e) {}
    }

    if (localMediaStream) {
      localMediaStream.getTracks().forEach(track => track.stop());
    }

    if (faceMeshInstance && faceMeshInstance.close) {
      try { faceMeshInstance.close(); } catch (e) {}
    }
  }

  window.addEventListener('beforeunload', teardown);
  window.addEventListener('pagehide', teardown);

  // Initialize Tracking on Load
  initIrisTracking();

})();
