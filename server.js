const express = require('express');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Gemini SDK 
// (Render will pull this securely from your environment variables configuration)
const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// Middleware Setup
app.use(cors());
app.use(express.json());

// Create an uploads folder dynamically if it doesn't exist yet
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}
app.use('/uploads', express.static(uploadDir));

// Initialize SQLite Database
const dbPath = path.join(__dirname, 'tasks.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error("Database initialization failed:", err.message);
    } else {
        console.log("Connected to SQLite cloud database.");
        
        // 🚨 ADD THIS LINE BELOW TO RESET THE FIX:
        db.run(`DROP TABLE IF EXISTS tasks;`); 

        // Now create the fresh production schema cleanly
        db.run(`CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT,
            category TEXT,
            image_url TEXT,
            ai_analysis TEXT,
            is_completed INTEGER DEFAULT 0
        )`);
    }
});

// Configure Multer Storage Engine for handling incoming uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// ----------------------------------------------------
// 🚀 API ROUTES / ENDPOINTS
// ----------------------------------------------------

// 1. GET ALL TASKS
app.get('/api/tasks', (req, res) => {
    db.all("SELECT * FROM tasks ORDER BY id DESC", [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ tasks: rows });
    });
});

// 2. CREATE TASK (With Automatic Gemini Whiteboard Analysis)
app.post('/api/tasks', upload.single('image'), async (req, res) => {
    const { title, description, category } = req.body;
    let imageUrl = req.file ? `/uploads/${req.file.filename}` : null;
    let aiAnalysis = null;

    // Trigger AI pipeline immediately if a file attachment exists
    if (req.file) {
        try {
            const imageBuffer = fs.readFileSync(req.file.path);
            
            const aiResponse = await ai.models.generateContent({
                model: 'gemini-2.5-flash',
                contents: [
                    {
                        inlineData: {
                            data: imageBuffer.toString("base64"),
                            mimeType: req.file.mimetype
                        }
                    },
                    "You are an advanced classroom helper app. Analyze this uploaded picture. If it is a whiteboard, workbook, or digital assignment containing handwritten or typed school notes, math problems, or text data, cleanly transcribe it and provide a logical step-by-step complete solution. Keep formatting straightforward and clean for a student."
                ],
            });
            
            aiAnalysis = aiResponse.text;
        } catch (aiError) {
            console.error("Gemini context resolution error:", aiError);
            aiAnalysis = "Error: System could not resolve image attachments using Gemini API.";
        }
    }

    const query = `INSERT INTO tasks (title, description, category, image_url, ai_analysis) VALUES (?, ?, ?, ?, ?)`;
    db.run(query, [title, description, category, imageUrl, aiAnalysis], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({
            success: true,
            taskId: this.lastID,
            message: "Task stored and processed successfully."
        });
    });
});

// 3. DELETE TASK (Clears SQLite Data & Unlinks Files from Disk)
app.delete('/api/tasks/:id', (req, res) => {
    const taskId = req.params.id;

    // Look up file records to remove corresponding storage files
    db.get(`SELECT image_url FROM tasks WHERE id = ?`, [taskId], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });

        if (row && row.image_url) {
            // Reconstruct structural disk paths safely
            const physicalPath = path.join(__dirname, row.image_url);
            if (fs.existsSync(physicalPath)) {
                try {
                    fs.unlinkSync(physicalPath);
                    console.log(`Deleted file resource asset: ${row.image_url}`);
                } catch (unlinkErr) {
                    console.error("Storage disk cleanup failure:", unlinkErr);
                }
            }
        }

        // Clean relational tracking table rows
        db.run(`DELETE FROM tasks WHERE id = ?`, [taskId], (dbErr) => {
            if (dbErr) return res.status(500).json({ error: dbErr.message });
            res.json({ success: true, message: "Task dropped from relational cluster cleanly." });
        });
    });
});

// Start listening for incoming production traffic
app.listen(PORT, () => {
    console.log(`Upgraded system layout listening cleanly on port ${PORT}`);
});