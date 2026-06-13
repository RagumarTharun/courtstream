const preview = document.getElementById('preview');
const recordBtn = document.getElementById('recordBtn');
const goodViewBtn = document.getElementById('goodViewBtn');
const statusText = document.getElementById('statusText');
const statusDot = document.getElementById('statusDot');
const camIdDisplay = document.getElementById('camIdDisplay');

let stream = null;
let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;
let isGoodView = false;

// Metadata tracking
let metadata = {
    camId: '',
    startTimeAbs: 0, // Absolute time Date.now() when recording started
    events: [] // Array of { timestampMs: relative time, state: 'on'|'off' }
};

// Generate a random ID for this camera session
const generateId = () => Math.random().toString(36).substring(2, 6).toUpperCase();
metadata.camId = generateId();
camIdDisplay.textContent = `Cam ID: ${metadata.camId}`;

async function initCamera() {
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
            audio: true
        });
        preview.srcObject = stream;
    } catch (err) {
        console.error("Error accessing camera:", err);
        statusText.textContent = "Camera Error";
        alert("Could not access camera. Please allow permissions.");
    }
}

function toggleRecording() {
    if (!isRecording) {
        startRecording();
    } else {
        stopRecording();
    }
}

function startRecording() {
    if (!stream) return;

    recordedChunks = [];
    
    // Reset metadata
    metadata.startTimeAbs = Date.now();
    metadata.events = [];
    isGoodView = false;
    goodViewBtn.classList.remove('active');

    try {
        mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm; codecs=vp8,opus' });
    } catch (e) {
        // Fallback for Safari/iOS
        mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/mp4' });
    }

    mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
            recordedChunks.push(e.data);
        }
    };

    mediaRecorder.onstop = exportFiles;

    mediaRecorder.start(1000); // collect 1s chunks
    isRecording = true;

    // UI Updates
    recordBtn.classList.add('recording');
    recordBtn.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="6" width="12" height="12"/>
        </svg>
        Stop & Save
    `;
    
    statusText.textContent = "Recording";
    statusDot.classList.add('recording-dot');
    
    goodViewBtn.disabled = false;
}

function stopRecording() {
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
        mediaRecorder.stop();
    }
    
    isRecording = false;
    isGoodView = false;
    
    // UI Updates
    recordBtn.classList.remove('recording');
    recordBtn.innerHTML = `
        <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <circle cx="12" cy="12" r="10"/>
        </svg>
        Start Recording
    `;
    
    statusText.textContent = "Ready";
    statusDot.classList.remove('recording-dot');
    
    goodViewBtn.disabled = true;
    goodViewBtn.classList.remove('active');
}

function toggleGoodView() {
    if (!isRecording) return;
    
    isGoodView = !isGoodView;
    const relTime = Date.now() - metadata.startTimeAbs;
    
    metadata.events.push({
        timestampMs: relTime,
        state: isGoodView ? 'on' : 'off'
    });
    
    if (isGoodView) {
        goodViewBtn.classList.add('active');
        goodViewBtn.innerHTML = `
            <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
                <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
            </svg>
            GOOD VIEW ACTIVE
        `;
    } else {
        goodViewBtn.classList.remove('active');
        goodViewBtn.innerHTML = `
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            </svg>
            GOOD VIEW
        `;
    }
}

async function exportFiles() {
    // If recording ended while good view was still on, close the event
    if (isGoodView) {
        metadata.events.push({
            timestampMs: Date.now() - metadata.startTimeAbs,
            state: 'off'
        });
    }

    const timestampStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0,19);
    const baseFilename = `crowdcam_${metadata.camId}_${timestampStr}`;

    statusText.textContent = "Zipping...";

    // Create blobs
    const videoBlob = new Blob(recordedChunks, { type: mediaRecorder.mimeType });
    const videoExt = mediaRecorder.mimeType.includes('mp4') ? 'mp4' : 'webm';
    const jsonStr = JSON.stringify(metadata, null, 2);

    // Bundle into ZIP
    const zip = new JSZip();
    zip.file(`${baseFilename}.${videoExt}`, videoBlob);
    zip.file(`${baseFilename}.json`, jsonStr);

    try {
        const zipBlob = await zip.generateAsync({ type: "blob" });
        const zipUrl = URL.createObjectURL(zipBlob);
        
        const a = document.createElement('a');
        a.href = zipUrl;
        a.download = `${baseFilename}.zip`;
        a.click();

        setTimeout(() => URL.revokeObjectURL(zipUrl), 10000);
        statusText.textContent = "Saved!";
        setTimeout(() => { if(!isRecording) statusText.textContent = "Ready"; }, 2000);
    } catch (e) {
        console.error("Failed to create ZIP:", e);
        statusText.textContent = "Save Failed";
    }
}

// Event Listeners
recordBtn.addEventListener('click', toggleRecording);
goodViewBtn.addEventListener('click', toggleGoodView);

// Start
initCamera();
