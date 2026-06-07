const express = require('express');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Gemini AI SDK
// Ensure GEMINI_API_KEY is set in your Render Environment Variables
const aiKey = process.env.GEMINI_API_KEY;
const ai = aiKey ? new GoogleGenAI({ apiKey: aiKey }) : null;

// Middleware
app.use(cors());
app.use(express.json());

// Ensure uploads directory exists locally (Render will clear this on restart, which is expected for ephemeral setups)
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use('/uploads', express.static(uploadsDir));

// Database Setup
// Note: On Render's free tier, standard disk files reset on redeploy. 
// Using /opt/render/project/src/data/ or a persistent disk is ideal, but this fallback keeps it running safely.
const dbPath = process.env.NODE_ENV === 'production' ? '/tmp/classroom_tasks.db' : './classroom_tasks.db';
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error('Database connection error:', err.message);
    else console.log(`Connected to SQLite database at: ${dbPath}`);
});

// Initialize Tables
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS tasks (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            description TEXT,
            category TEXT DEFAULT 'General',
            imageUrl TEXT,
            geminiAnalysis TEXT,
            isDone INTEGER DEFAULT 0,
            createdAt TEXT
        )
    `);
});

// Multer Storage Configuration for File Streams
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// Helper function to convert a local file to a Generative Part object
function fileToGenerativePart(filePath, mimeType) {
    return {
        inlineData: {
            data: Buffer.from(fs.readFileSync(filePath)).toString("base64"),
            mimeType
        },
    };
}

// --- API Endpoints ---

// 1. GET ALL TASKS
app.get('/api/tasks', (req, res) => {
    db.all("SELECT * FROM tasks ORDER BY createdAt DESC", [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        // Map SQLite 1/0 to true/false for Flutter compatibility
        const formattedRows = rows.map(row => ({
            ...row,
            _id: row.id, // Match the key Flutter expects
            isDone: row.isDone === 1
        }));
        res.json(formattedRows);
    });
});

// 2. POST NEW TASK WITH OPTIONAL IMAGE & GEMINI AI ANALYSIS
app.post('/api/tasks', upload.single('image'), async (req, res) => {
    const { title, description, category } = req.body;
    const taskId = Date.now().toString();
    const createdAt = new Date().toISOString();
    
    let imageUrl = null;
    let geminiAnalysis = null;

    if (!title) {
        return res.status(400).json({ error: 'Title is required' });
    }

    try {
        if (req.file) {
            // Build absolute URL for the image based on how Render hosts it
            const host = req.get('host');
            const protocol = req.protocol;
            imageUrl = `${protocol}://${host}/uploads/${req.file.filename}`;

            // Trigger Gemini Vision Analysis if SDK is active
            if (ai) {
                try {
                    const imagePart = fileToGenerativePart(req.file.path, req.file.mimetype);
                    const prompt = "Analyze this classroom whiteboard photo or material. Extract text, summarize key assignments, tasks, or structural concepts clearly.";
                    
                    const response = await ai.models.generateContent({
                        model: 'gemini-2.5-flash', // Utilizing strong standard flash pipeline
                        contents: [prompt, imagePart],
                    });
                    
                    geminiAnalysis = response.text;
                } catch (aiErr) {
                    console.error("Gemini AI Processing failed:", aiErr.message);
                    geminiAnalysis = "AI processing was skipped due to an engine error.";
                }
            } else {
                geminiAnalysis = "AI features unavailable (Missing API Key configuration).";
            }
        }

        const stmt = db.prepare("INSERT INTO tasks (id, title, description, category, imageUrl, geminiAnalysis, isDone, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
        stmt.run(taskId, title, description || '', category || 'General', imageUrl, geminiAnalysis, 0, createdAt);
        stmt.finalize();

        res.status(201).json({ 
            id: taskId, 
            _id: taskId,
            title, 
            description, 
            category, 
            imageUrl, 
            geminiAnalysis, 
            isDone: false 
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// 3. PUT UPDATE STATUS (Toggle Checkbox)
app.put('/api/tasks/:id', (req, res) => {
    const { isDone } = req.body;
    const numericStatus = isDone ? 1 : 0;

    db.run("UPDATE tasks SET isDone = ? WHERE id = ?", [numericStatus, req.params.id], function(err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ updated: this.changes });
    });
});

// 4. DELETE A TASK
app.delete('/api/tasks/:id', (req, res) => {
    // Optional: First query row to delete the physical image file from 'uploads/' if it exists
    db.get("SELECT imageUrl FROM tasks WHERE id = ?", [req.params.id], (err, row) => {
        if (row && row.imageUrl) {
            const filename = row.imageUrl.split('/uploads/')[1];
            const fullPath = path.join(uploadsDir, filename);
            if (fs.existsSync(fullPath)) {
                fs.unlinkSync(fullPath); // Cleanup storage footprint
            }
        }
        
        db.run("DELETE FROM tasks WHERE id = ?", [req.params.id], function(err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            res.json({ deleted: this.changes });
        });
    });
});

app.listen(PORT, () => {
    console.log(`Server listening elegantly on port ${PORT}`);
});