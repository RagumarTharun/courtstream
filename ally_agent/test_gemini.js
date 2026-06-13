require('dotenv').config();
const fs = require('fs');

async function test() {
    const { GoogleGenAI } = await import('@google/genai');
    const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    
    fs.writeFileSync('dummy.txt', 'This is a test assignment. Solve 1+1.');
    console.log("Uploading...");
    const uploadResult = await ai.files.upload({ file: 'dummy.txt', config: { mimeType: 'text/plain' } });
    console.log("Upload Result: ", uploadResult);
    
    console.log("Generating with object wrapper...");
    try {
        const response = await ai.models.generateContent({
            model: 'gemini-1.5-flash-latest',
            contents: [
                { fileData: { fileUri: uploadResult.uri, mimeType: uploadResult.mimeType } },
                "Solve this."
            ]
        });
        console.log("Object wrapper success!", response.text);
    } catch(e) {
        console.error("Object wrapper failed:", e.message);
    }
}
test().catch(console.error);
