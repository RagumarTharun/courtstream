// audiodirector.js

let audioCtx = null;
const audioAnalyzers = {}; // id -> { analyser, dataArray, gainMultiplier, baseline, rollingAvg, calibrationSamples }
let autoAudioEnabled = false;
let isCalibrating = false;
let lastSwitchTime = 0;
const SWITCH_DEBOUNCE_MS = 1000;

function toggleAutoAudio() {
  autoAudioEnabled = !autoAudioEnabled;
  const btn = document.getElementById("autoAudioBtn");
  const txt = document.getElementById("autoAudioBtnText");
  if (autoAudioEnabled) {
    btn.classList.add("active");
    txt.innerText = "Auto: ON";
    if (!audioCtx) initAudioCtx();
  } else {
    btn.classList.remove("active");
    txt.innerText = "Auto: OFF";
  }
}

// Expose globally for HTML onclick
window.toggleAutoAudio = toggleAutoAudio;

function initAudioCtx() {
  if (!audioCtx) {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (AudioContext) {
      audioCtx = new AudioContext();
    }
  }
  if (audioCtx && audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

function calibrateMics() {
  if (!audioCtx) initAudioCtx();
  if (!audioCtx) {
    alert("Audio Context not supported or initialized.");
    return;
  }
  
  alert("Calibrating mics... Please remain quiet for 5 seconds.");
  isCalibrating = true;
  
  // Reset existing baseline data
  Object.keys(audioAnalyzers).forEach(id => {
    audioAnalyzers[id].calibrationSamples = [];
  });
  
  setTimeout(() => {
    isCalibrating = false;
    let report = "Calibration complete:\n";
    Object.keys(audioAnalyzers).forEach(id => {
      const a = audioAnalyzers[id];
      if (a.calibrationSamples && a.calibrationSamples.length > 0) {
        const sum = a.calibrationSamples.reduce((acc, val) => acc + val, 0);
        a.baseline = sum / a.calibrationSamples.length;
        // Normalize: target a baseline of 5.
        a.gainMultiplier = Math.min(5, Math.max(0.1, 5 / Math.max(1, a.baseline)));
        report += `${peers[id]?.name || id}: Base ${a.baseline.toFixed(1)}, Multiplier ${a.gainMultiplier.toFixed(2)}\n`;
      }
    });
    console.log(report);
    
    // Show temporary overlay for calibration results
    const badge = document.getElementById('streamBadge');
    if (badge) {
      const orig = badge.innerText;
      badge.innerText = "✅ Calibration Complete";
      setTimeout(() => badge.innerText = orig, 3000);
    }
  }, 5000);
}

window.calibrateMics = calibrateMics;

function ensureVuMeters() {
  if (typeof peers === 'undefined') return;
  Object.keys(peers).forEach(id => {
    const slot = peers[id].slot;
    if (slot && !slot.querySelector('.vu-meter')) {
      const vuContainer = document.createElement('div');
      vuContainer.className = 'vu-meter';
      vuContainer.style = 'position:absolute; right:10px; bottom:10px; width:10px; height:60px; background:rgba(0,0,0,0.5); border-radius:5px; overflow:hidden; z-index:5; pointer-events:none; border:1px solid rgba(255,255,255,0.2);';
      
      const vuFill = document.createElement('div');
      vuFill.className = 'vu-fill';
      vuFill.style = 'position:absolute; bottom:0; left:0; width:100%; height:0%; background:var(--green); transition:height 0.1s, background-color 0.2s;';
      
      vuContainer.appendChild(vuFill);
      slot.appendChild(vuContainer);
    }
  });
}

function analyzeAudioLoop() {
  requestAnimationFrame(analyzeAudioLoop);
  
  ensureVuMeters();
  
  // 1. Ensure all active peers have analyzers
  if (typeof peers !== 'undefined' && audioCtx) {
    Object.keys(peers).forEach(id => {
      const p = peers[id];
      if (p.stream && !audioAnalyzers[id]) {
        try {
          // In WebRTC, the MediaStream might only have video tracks initially. Check for audio.
          if (p.stream.getAudioTracks().length > 0) {
            const source = audioCtx.createMediaStreamSource(p.stream);
            const analyser = audioCtx.createAnalyser();
            analyser.fftSize = 256;
            analyser.smoothingTimeConstant = 0.5; // lower smoothing for faster transient detection
            source.connect(analyser);
            
            audioAnalyzers[id] = {
              analyser: analyser,
              dataArray: new Uint8Array(analyser.frequencyBinCount),
              baseline: 0,
              gainMultiplier: 1.0,
              rollingAvg: 0,
              calibrationSamples: []
            };
            console.log("🎤 Audio analyzer attached for", id);
          }
        } catch(e) {
          console.warn("Could not attach audio source for", id, e);
        }
      }
    });
  }
  
  // 2. Process audio levels
  let maxTransientLevel = 0;
  let loudestCameraId = null;
  const now = Date.now();
  
  Object.keys(audioAnalyzers).forEach(id => {
    // If peer was removed, cleanup
    if (typeof peers === 'undefined' || !peers[id] || !peers[id].stream) {
      delete audioAnalyzers[id];
      return;
    }
    
    const a = audioAnalyzers[id];
    a.analyser.getByteFrequencyData(a.dataArray);
    
    // Calculate energy in lower-mid frequencies (e.g. basketball dribble "thud")
    // For 48kHz sample rate, fftSize 256, each bin is ~187Hz. 
    // Bins 1 to 5 cover ~187Hz to ~900Hz.
    let energy = 0;
    for(let i = 1; i <= 5; i++) {
      energy += a.dataArray[i];
    }
    energy = energy / 5;
    
    if (isCalibrating) {
      a.calibrationSamples.push(energy);
    }
    
    // Apply calibration multiplier
    const adjustedEnergy = energy * a.gainMultiplier;
    
    // Update VU meter UI
    const slot = peers[id].slot;
    if (slot) {
      const fill = slot.querySelector('.vu-fill');
      if (fill) {
        const pct = Math.min(100, (adjustedEnergy / 150) * 100);
        fill.style.height = `${pct}%`;
        fill.style.background = pct > 80 ? 'var(--red)' : (pct > 50 ? '#eab308' : 'var(--green)');
      }
    }
    
    // Rolling average to detect transients (sudden spikes)
    a.rollingAvg = (a.rollingAvg * 0.9) + (adjustedEnergy * 0.1);
    
    // Transient threshold: spike is significantly higher than rolling average and absolute minimum
    if (autoAudioEnabled && !isCalibrating) {
      if (adjustedEnergy > a.rollingAvg + 30 && adjustedEnergy > 40) {
        if (adjustedEnergy > maxTransientLevel) {
          maxTransientLevel = adjustedEnergy;
          loudestCameraId = id;
        }
      }
    }
  });
  
  // 3. Auto Switch Logic
  if (autoAudioEnabled && !isCalibrating && loudestCameraId) {
    if (now - lastSwitchTime > SWITCH_DEBOUNCE_MS) {
      // Check if currentLiveId exists and differs
      if (typeof currentLiveId !== 'undefined' && currentLiveId !== loudestCameraId) {
        console.log(`🎤 Transient detected! Switching to ${loudestCameraId}. Level: ${maxTransientLevel.toFixed(1)}`);
        
        // Trigger the switch
        if (typeof setLiveCamera === 'function') {
          setLiveCamera(loudestCameraId);
        }
        lastSwitchTime = now;
        
        // Visual indicator
        const streamBadge = document.getElementById('streamBadge');
        if (streamBadge) {
          const originalHtml = streamBadge.innerHTML;
          streamBadge.innerHTML = `<span style="color:var(--red);">🎙️ SWITCHED TO ${peers[loudestCameraId]?.name || 'CAMERA'}</span>`;
          streamBadge.style.borderColor = "var(--red)";
          setTimeout(() => {
            streamBadge.innerHTML = originalHtml;
            streamBadge.style.borderColor = "";
          }, 1500);
        }
      }
    }
  }
}

// Start the loop
analyzeAudioLoop();

// Auto-initialize audio context on first user interaction
document.body.addEventListener('click', () => {
  if (!audioCtx) initAudioCtx();
}, { once: true });
