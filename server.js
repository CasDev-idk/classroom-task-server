const express = require('express');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Gemini AI SDK securely using Render's environment vars
const aiKey = process.env.GEMINI_API_KEY;
const ai = aiKey ? new GoogleGenAI({ apiKey: aiKey }) : null;

// Middleware
app.use(cors());
app.use(express.json());

// Ensure physical uploads directory exists on disk
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use('/uploads', express.static(uploadsDir));

// Select ephemeral storage location if hosted on production Render
const dbPath = process.env.NODE_ENV === 'production' ? '/tmp/classroom_tasks.db' : './classroom_tasks.db';
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) console.error('Database connection error:', err.message);
    else console.log(`Connected to SQLite database at: ${dbPath}`);
});

// Structural initialization matching correct data parameters
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

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadsDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// --- Endpoints ---

// Main root route to stop browser tracking 404 response errors
app.get('/', (req, res) => {
    res.send('Classroom Task Tracker Backend is Live and Running!');
});

// Fetch tasks with safety data mapping parameters
app.get('/api/tasks', (req, res) => {
    db.all("SELECT * FROM tasks ORDER BY createdAt DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        
        const formattedRows = rows.map(row => ({
            ...row,
            _id: row.id, 
            isDone: row.isDone === 1 
        }));
        res.json(formattedRows);
    });
});

// Submission Route parsing raw multipart uploads directly into the AI Engine
app.post('/api/tasks', upload.single('image'), async (req, res) => {
    const { title, description, category } = req.body;
    const taskId = Date.now().toString();
    const createdAt = new Date().toISOString();
    
    let imageUrl = null;
    let geminiAnalysis = null;

    if (!title) return res.status(400).json({ error: 'Title is required' });

    try {
        if (req.file) {
            const host = req.get('host');
            const protocol = req.protocol;
            imageUrl = `${protocol}://${host}/uploads/${req.file.filename}`;

            if (ai) {
                try {
                    // Modern struct format explicitly for the newer genai framework requirements
                    const imagePart = {
                        inlineData: {
                            data: fs.readFileSync(req.file.path).toString("base64"),
                            mimeType: req.file.mimetype
                        }
                    };

                    const promptText = "Analyze this classroom whiteboard photo or material. Extract text, summarize key assignments, tasks, or structural concepts clearly.";
                    
                    const response = await ai.models.generateContent({
                        model: 'gemini-2.5-flash',
                        contents: [promptText, imagePart],
                    });
                    
                    geminiAnalysis = response.text;
                } catch (aiErr) {
                    console.error("Gemini AI Processing failed details:", aiErr);
                    geminiAnalysis = `AI processing skipped. Engine error: ${aiErr.message || aiErr}`;
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
        console.error("Route failure logs:", err);
        res.status(500).json({ error: err.message });
    }
});

// Status update handling
app.put('/api/tasks/:id', (req, res) => {
    const { isDone } = req.body;
    const numericStatus = isDone ? 1 : 0;

    db.run("UPDATE tasks SET isDone = ? WHERE id = ?", [numericStatus, req.params.id], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ updated: this.changes });
    });
});

// Task removal route
app.delete('/api/tasks/:id', (req, res) => {
    db.get("SELECT imageUrl FROM tasks WHERE id = ?", [req.params.id], (err, row) => {
        if (row && row.imageUrl) {
            const filename = row.imageUrl.split('/uploads/')[1];
            const fullPath = path.join(uploadsDir, filename);
            if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        }
        
        db.run("DELETE FROM tasks WHERE id = ?", [req.params.id], function(err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ deleted: this.changes });
        });
    });
});

app.listen(PORT, () => {
    console.log(`Server listening elegantly on port ${PORT}`);
});