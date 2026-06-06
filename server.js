const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const PORT = process.env.PORT || 5000;

// 🌐 Middleware Configuration
app.use(cors());
app.use(express.json());
// Serve uploaded images statically so the Flutter frontend can access them
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// 📁 Ensure local uploads storage folder exists securely
if (!fs.existsSync('./uploads')) {
    fs.mkdirSync('./uploads');
}

// 🗄️ Core SQLite Database Engine Initialization
const db = new sqlite3.Database('./tasks.db', (err) => {
    if (err) {
        console.error("Failed to connect to local SQLite engine:", err.message);
    } else {
        console.log("Connected to SQLite database file container.");
        // Ensure table includes the 'is_completed' checklist property column
        db.run(`CREATE TABLE IF NOT EXISTS tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT,
            category TEXT DEFAULT 'General',
            image_url TEXT,
            ai_analysis TEXT,
            is_completed INTEGER DEFAULT 0
        )`);
    }
});

// 🖼️ Multer Disk Storage Infrastructure for Image Ingestion
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, 'uploads/');
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// 📥 GET: Pull all tasks down into the layout feed
app.get('/api/tasks', (req, res) => {
    db.all(`SELECT * FROM tasks ORDER BY id DESC`, [], (err, rows) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }
        res.json({ tasks: rows });
    });
});

// 📤 POST: Receive new task payload and execute Gemini AI processing pipelines
app.post('/api/tasks', upload.single('image'), async (req, res) => {
    const { title, description, category } = req.body;
    let imageUrl = null;
    let aiAnalysis = null;

    if (req.file) {
        imageUrl = `/uploads/${req.file.filename}`;
        const localImagePath = req.file.path;

        try {
            // Read binary photo file into a safe Base64 buffer string block
            const imageBuffer = fs.readFileSync(localImagePath);
            const base64Image = imageBuffer.toString("base64");

            // 🚨 Check for Render Dashboard Environment Variables configuration
            const apiKey = process.env.GEMINI_API_KEY;
            
            if (!apiKey) {
                console.warn("WARNING: GEMINI_API_KEY environment variable is not defined on Render configuration layer.");
                aiAnalysis = "AI Processing skipped: Backend server missing API key initialization.";
            } else {
                const genAI = new GoogleGenerativeAI(apiKey);
                const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

                const prompt = "Analyze this classroom image. Transcribe any readable text, school tasks, or assignments, and provide a clear step-by-step breakdown or context explanation and solve any given problems on visable text/images.";

                const result = await model.generateContent([
                    prompt,
                    {
                        inlineData: {
                            data: base64Image,
                            mimeType: req.file.mimetype
                        }
                    }
                ]);

                aiAnalysis = result.response.text();
            }
        } catch (aiError) {
            console.error("Gemini Engine Error Intercepted:", aiError.message);
            // Fallback text so it cleanly finishes the operation instead of throwing a 500 error
            aiAnalysis = `AI Processing paused: ${aiError.message}`;
        }
    }

    // Insert structural data safely into the database engine
    const sql = `INSERT INTO tasks (title, description, category, image_url, ai_analysis, is_completed) VALUES (?, ?, ?, ?, ?, 0)`;
    const params = [title, description, category || 'General', imageUrl, aiAnalysis];

    db.run(sql, params, function (err) {
        if (err) {
            console.error("Database write crash encountered:", err.message);
            return res.status(500).json({ error: err.message });
        }
        res.json({
            message: "Task successfully synchronized and stored.",
            taskId: this.lastID
        });
    });
});

// 🔄 PUT: Update task checklist completion state (Fixes Frontend Checkbox failures)
app.put('/api/tasks/:id', (req, res) => {
    const { id } = req.params;
    const { is_completed } = req.body;

    // Standardize incoming value safely into 0 or 1 integer profile for SQLite engine
    const completedVal = is_completed == 1 || is_completed === true ? 1 : 0;

    const sql = `UPDATE tasks SET is_completed = ? WHERE id = ?`;
    
    db.run(sql, [completedVal, id], function(err) {
        if (err) {
            console.error("Database failed to update status logic:", err.message);
            return res.status(500).json({ error: err.message });
        }
        res.json({ message: "Task status synchronized successfully", updated: this.changes });
    });
});

// 🗑️ DELETE: Purge task data row and unlink assets from disk storage
app.delete('/api/tasks/:id', (req, res) => {
    const { id } = req.params;

    // Look up the file path first to prevent file orphans on disk
    db.get(`SELECT image_url FROM tasks WHERE id = ?`, [id], (err, row) => {
        if (err) {
            return res.status(500).json({ error: err.message });
        }

        if (row && row.image_url) {
            const absoluteFilePath = path.join(__dirname, row.image_url);
            if (fs.existsSync(absoluteFilePath)) {
                try {
                    fs.unlinkSync(absoluteFilePath);
                    console.log(`Cleaned up asset from storage file tree: ${row.image_url}`);
                } catch (unlinkErr) {
                    console.error("Failed to delete local asset file:", unlinkErr.message);
                }
            }
        }

        // Delete the database profile row completely
        db.run(`DELETE FROM tasks WHERE id = ?`, [id], function (err) {
            if (err) {
                return res.status(500).json({ error: err.message });
            }
            res.json({ message: "Task permanently deleted from ecosystem.", changes: this.changes });
        });
    });
});

// ⚙️ Activate Application Execution Interface
app.listen(PORT, () => {
    console.log(`Ecosystem Server running securely on communication port: ${PORT}`);
});