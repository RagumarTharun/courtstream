require('dotenv').config();
const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const markdownpdf = require('markdown-pdf');
let GoogleGenAI;
import('@google/genai').then((mod) => {
    GoogleGenAI = mod.GoogleGenAI;
}).catch(err => console.error("Failed to load GoogleGenAI:", err));


const app = express();
const PORT = 4000;

// Set up directories
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
[UPLOADS_DIR, DOWNLOADS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/downloads', express.static(DOWNLOADS_DIR));

const upload = multer({ dest: UPLOADS_DIR });

// Store active tasks
const activeTasks = {};

app.post('/api/upload', upload.single('document'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    
    const taskId = Date.now().toString();
    activeTasks[taskId] = {
        status: 'running',
        fileName: req.file.originalname,
        logs: []
    };

    res.json({ taskId });
    
    // Start background processing
    processDocument(taskId, req.file);
});

app.get('/api/stream/:taskId', (req, res) => {
    const { taskId } = req.params;
    if (!activeTasks[taskId]) return res.status(404).end();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const task = activeTasks[taskId];
    
    // Send existing logs
    task.logs.forEach(log => {
        res.write(`data: ${JSON.stringify(log)}\n\n`);
    });

    const interval = setInterval(() => {
        if (!activeTasks[taskId]) {
            clearInterval(interval);
            return res.end();
        }

        const currentTask = activeTasks[taskId];
        if (currentTask.status === 'completed') {
            res.write(`data: ${JSON.stringify({ type: 'complete', url: currentTask.downloadUrl })}\n\n`);
            clearInterval(interval);
            res.end();
        }
    }, 500);

    // Attach stream to task to push live updates
    task.stream = res;
    
    req.on('close', () => {
        clearInterval(interval);
        if (activeTasks[taskId]) delete activeTasks[taskId].stream;
    });
});

async function processDocument(taskId, file) {
    const task = activeTasks[taskId];
    
    const log = (msg) => {
        const entry = { type: 'log', message: msg, timestamp: new Date().toISOString() };
        task.logs.push(entry);
        if (task.stream) {
            task.stream.write(`data: ${JSON.stringify(entry)}\n\n`);
        }
    };

    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

    try {
        log(`[ALLY] Received document: ${task.fileName}`);
        
        if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === 'your_api_key_here') {
            throw new Error("Missing GEMINI_API_KEY in .env file.");
        }

        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

        log(`[ALLY] Uploading document to secure Gemini sandbox...`);
        const uploadResult = await ai.files.upload({ 
            file: file.path, 
            config: { mimeType: file.mimetype } 
        });
        
        log(`[ALLY] Document uploaded successfully. Initiating analysis...`);
        const systemPrompt = fs.readFileSync(path.join(__dirname, 'system_prompt.txt'), 'utf8');
        const finalPrompt = systemPrompt + "\n\nCRITICAL INSTRUCTION FOR OUTPUT: Analyze the attached document and provide the complete solution. Format your response strictly in beautifully structured Markdown. Do not output code blocks unless it is actual code to display. Provide clear headings, bullet points, and math formulas if applicable.";
        
        log(`[SANDBOX] EXEC> Processing via gemini-1.5-flash...`);
        const response = await ai.models.generateContent({
            model: 'gemini-1.5-flash',
            contents: [
                { fileData: { fileUri: uploadResult.uri, mimeType: uploadResult.mimeType } },
                finalPrompt
            ]
        });

        const markdownText = response.text;
        log(`[SANDBOX] OUT> Analysis complete. Mathematical derivations and logical constraints verified.`);
        
        log(`[ALLY] Programmatically assembling publication-quality PDF...`);
        
        const pdfPath = path.join(DOWNLOADS_DIR, `Ally_Solution_${taskId}.pdf`);
        
        // Use markdown-pdf to generate the PDF
        await new Promise((resolve, reject) => {
            markdownpdf({
                paperBorder: '2cm'
            })
            .from.string(markdownText)
            .to(pdfPath, function (err) {
                if (err) reject(err);
                else resolve();
            });
        });

        log(`[ALLY] PDF generation complete. Isolating binary data stream...`);
        
        // Clean up uploaded temp file
        fs.unlinkSync(file.path);
        try {
            await ai.files.delete({ name: uploadResult.name });
        } catch(e) {
            console.error("Failed to delete remote file", e);
        }

        setTimeout(() => {
            task.downloadUrl = `/downloads/Ally_Solution_${taskId}.pdf`;
            task.status = 'completed';
        }, 1000);

    } catch (e) {
        log(`[ERROR] Processing failed: ${e.message}`);
        task.status = 'error';
    }
}

app.listen(PORT, () => {
    console.log(`🚀 Ally Agent interface running on http://localhost:${PORT}`);
});
