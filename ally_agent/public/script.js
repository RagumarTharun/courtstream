const uploadZone = document.getElementById('uploadZone');
const fileInput = document.getElementById('fileInput');
const terminal = document.getElementById('terminal');
const outputSection = document.getElementById('outputSection');
const downloadBtn = document.getElementById('downloadBtn');
const agentStatus = document.getElementById('agentStatus');
const statusIndicator = document.querySelector('.status-indicator');

// Drag and drop handlers
uploadZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadZone.classList.add('dragover');
});

uploadZone.addEventListener('dragleave', () => {
    uploadZone.classList.remove('dragover');
});

uploadZone.addEventListener('drop', (e) => {
    e.preventDefault();
    uploadZone.classList.remove('dragover');
    if (e.dataTransfer.files.length) {
        handleUpload(e.dataTransfer.files[0]);
    }
});

fileInput.addEventListener('change', (e) => {
    if (e.target.files.length) {
        handleUpload(e.target.files[0]);
    }
});

function addLog(text, type = 'system') {
    const div = document.createElement('div');
    div.className = `log-line ${type}`;
    div.textContent = text;
    terminal.appendChild(div);
    terminal.scrollTop = terminal.scrollHeight;
}

function parseLogMessage(msg) {
    if (msg.startsWith('[ALLY]')) return { text: msg, type: 'ally' };
    if (msg.startsWith('[SANDBOX]')) return { text: msg, type: 'sandbox' };
    if (msg.startsWith('[ERROR]')) return { text: msg, type: 'error' };
    return { text: msg, type: 'system' };
}

async function handleUpload(file) {
    // Reset UI
    terminal.innerHTML = '';
    outputSection.style.display = 'none';
    uploadZone.style.opacity = '0.5';
    uploadZone.style.pointerEvents = 'none';
    
    agentStatus.textContent = 'Status: Processing Document...';
    statusIndicator.classList.add('working');

    addLog(`System: Uploading ${file.name}...`, 'system');

    const formData = new FormData();
    formData.append('document', file);

    try {
        const response = await fetch('/api/upload', {
            method: 'POST',
            body: formData
        });

        if (!response.ok) throw new Error('Upload failed');
        const data = await response.json();
        
        // Listen to server sent events for logs
        connectStream(data.taskId);

    } catch (err) {
        addLog(`Error: ${err.message}`, 'error');
        resetUI();
    }
}

function connectStream(taskId) {
    const eventSource = new EventSource(`/api/stream/${taskId}`);

    eventSource.onmessage = (event) => {
        const data = JSON.parse(event.data);
        
        if (data.type === 'log') {
            const parsed = parseLogMessage(data.message);
            addLog(parsed.text, parsed.type);
        } else if (data.type === 'complete') {
            eventSource.close();
            
            addLog('System: PDF stream ready for download.', 'system');
            
            outputSection.style.display = 'block';
            downloadBtn.onclick = () => {
                window.open(data.url, '_blank');
            };
            
            resetUI('Status: Idle (Task Complete)');
        }
    };

    eventSource.onerror = () => {
        eventSource.close();
        addLog('Error: Lost connection to Ally sandbox.', 'error');
        resetUI();
    };
}

function resetUI(statusText = 'Status: Idle') {
    uploadZone.style.opacity = '1';
    uploadZone.style.pointerEvents = 'auto';
    agentStatus.textContent = statusText;
    statusIndicator.classList.remove('working');
    fileInput.value = '';
}
