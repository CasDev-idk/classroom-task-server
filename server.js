const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { GoogleGenAI } = require('@google/genai');

const app = express();
const PORT = process.env.PORT || 5000;

// 🔑 Initialize Gemini API Client (Looks for GEMINI_API_KEY environment variable)
const ai = new GoogleGenAI({});

// ⚙️ Middleware Setup
app.use(cors());
app.use(express.json());

// 📁 Ensure 'uploads' directory exists safely on the server
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}
app.use('/uploads', express.static(uploadsDir));

// 📦 Configure Multer Storage Engine for handling incoming images
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadsDir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage: storage });

// 🗄️ Initialize SQLite Database
const dbPath = path.join(__dirname, 'tasks.db');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error("Database initialization failed:", err.message);
    } else {
        console.log("Connected to SQLite cloud database.");
        
        // 🚨 CRITICAL DB REPAIR ROUTE: If you need to forcefully update the tables
        // uncomment the line below for ONE deploy, then put comments back on it!
        // db.run(`DROP TABLE IF EXISTS tasks;`);

        // Create core task schema with Gemini analysis and completion support
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

// 📥 GET: Fetch all classroom tasks
app.get('/api/tasks', (req, res) => {
    db.all("SELECT * FROM tasks ORDER BY id DESC", [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ tasks: rows });
    });
});

// 📤 POST: Submit new task + optional AI Whiteboard Analysis
app.post('/api/tasks', upload.single('image'), async (req, res) => {
    try {
        const { title, description, category } = req.body;
        let imageUrl = req.file ? `/uploads/${req.file.filename}` : null;
        let aiAnalysis = null;

        if (!title) {
            return res.status(400).json({ error: "Task title is required." });
        }

        // 🧠 AI ENGINE COUPLING: If a file was attached, pass it to Gemini
        if (req.file) {
            try {
                const imagePath = req.file.path;
                const imageBuffer = fs.readFileSync(imagePath);
                
                const response = await ai.models.generateContent({
                    model: 'gemini-2.5-flash',
                    contents: [
                        {
                            inlineData: {
                                mimeType: req.file.mimetype,
                                data: imageBuffer.toString('base64')
                            }
                        },
                        "You are a helpful classroom assistant AI. Analyze this image. If it contains a whiteboard, homework, a textbook, or an assignment, extract the text, transcribe any problems, give step-by-step explanations, or summarize the material clearly. Keep your response concise, clear, and highly organized."
                    ]
                });

                aiAnalysis = response.text || "Gemini could not extract text from this image.";
            } catch (aiErr) {
                console.error("Gemini Processing Exception: ", aiErr);
                aiAnalysis = `AI Processing Error: ${aiErr.message}`;
            }
        }

        // Write complete dataset directly to database
        const query = `INSERT INTO tasks (title, description, category, image_url, ai_analysis, is_completed) VALUES (?, ?, ?, ?, ?, 0)`;
        db.run(query, [title, description || '', category || 'General', imageUrl, aiAnalysis], function (err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            res.json({ 
                message: "Task synchronized successfully.", 
                taskId: this.lastID,
                ai_analysis: aiAnalysis
            });
        });

    } catch (globalErr) {
        console.error("Server Route Failure: ", globalErr);
        res.status(500).json({ error: "Internal server crash context." });
    }
});

// 🔄 PUT: Update completion toggle checkboxes
app.put('/api/tasks/:id', (express.json()), (req, res) => {
    const { is_completed } = req.body;
    const { id } = req.params;
    
    db.run(`UPDATE tasks SET is_completed = ? WHERE id = ?`, [is_completed, id], function(err) {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ message: "Task completion status modified." });
    });
});

// 🗑️ DELETE: Remove a classroom record and its linked file asset
app.delete('/api/tasks/:id', (req, res) => {
    const { id } = req.params;

    // First find the image file path so we don't leave junk on the server
    db.get("SELECT image_url FROM tasks WHERE id = ?", [id], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });

        if (row && row.image_url) {
            const absoluteFilePath = path.join(__dirname, row.image_url);
            if (fs.existsSync(absoluteFilePath)) {
                fs.unlinkSync(absoluteFilePath); // Delete actual image file
            }
        }

        // Wipe record from SQL database
        db.run("DELETE FROM tasks WHERE id = ?", [id], function (err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            res.json({ message: "Task and associated file assets dropped successfully." });
        });
    });
});

app.listen(PORT, () => {
    console.log(`Classroom sync server running actively on port ${PORT}`);
});