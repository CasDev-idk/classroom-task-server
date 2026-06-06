const express = require('express');
const multer = require('multer');
const sqlite3 = require('sqlite3').verbose();
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// Ensure the local uploads directory exists
const uploadDir = './uploads';
if (!fs.existsSync(uploadDir)){
    fs.mkdirSync(uploadDir);
}

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

const db = new sqlite3.Database('./tasks.db', (err) => {
    if (err) console.error('Database connection error:', err.message);
    else console.log('Successfully connected to SQLite database.');
});

// 📊 CORE MULTI-TABLE SCHEMA: Separates global tasks from individual progress statuses
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        image_url TEXT,
        description TEXT,
        uploaded_by TEXT, 
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS user_progress (
        user_name TEXT,
        task_id TEXT,
        is_completed INTEGER DEFAULT 0,
        PRIMARY KEY (user_name, task_id)
    )`);
});

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, 'uploads/'),
    filename: (req, file, cb) => cb(null, uuidv4() + path.extname(file.originalname))
});
const upload = multer({ storage: storage });

// 📤 SAFELY HANDLED POST ENDPOINT: Captures image streams and descriptions
app.post('/api/tasks', (req, res) => {
    // Run multer manually inside the route to handle and catch streaming issues gracefully
    upload.single('photo')(req, res, function (err) {
        if (err) {
            console.error('❌ Multer Framework Exception:', err.message);
            return res.status(400).json({ error: `File chunk upload error: ${err.message}` });
        }

        // Print debug status to Terminal 1
        console.log('📬 Fields caught:', req.body);
        console.log('📁 File object caught:', req.file);

        if (!req.file) {
            console.error('❌ Upload Blocked: Request did not include a valid image file container.');
            return res.status(400).json({ error: "Multipart parsing failed: Photo container is missing." });
        }

        const taskId = uuidv4();
        const { description, uploaded_by } = req.body;
        const imageUrl = `/uploads/${req.file.filename}`;
        
        const query = `INSERT INTO tasks (id, image_url, description, uploaded_by) VALUES (?, ?, ?, ?)`;
        
        db.run(query, [taskId, imageUrl, description, uploaded_by || 'Unknown'], function(dbErr) {
            if (dbErr) {
                console.error('❌ SQL Execution Error:', dbErr.message);
                return res.status(500).json({ error: dbErr.message });
            }
            console.log(`✅ New task successfully saved to SQLite: "${description}"`);
            res.json({ success: true, taskId, imageUrl, description, uploaded_by });
        });
    });
});

// 📥 FETCH ENDPOINT WITH DUAL-TABLE PROGRESS COALESCING
app.get('/api/tasks', (req, res) => {
    const currentUser = req.query.username || 'Unknown';
    const query = `
        SELECT t.*, COALESCE(p.is_completed, 0) as is_completed 
        FROM tasks t
        LEFT JOIN user_progress p ON t.id = p.task_id AND p.user_name = ?
        ORDER BY t.created_at DESC
    `;
    db.all(query, [currentUser], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ tasks: rows });
    });
});

// 🔄 INDIVIDUAL PROGRESS TOGGLE ENDPOINT (ON CONFLICT DO UPDATE)
app.put('/api/tasks/:id', (req, res) => {
    const { is_completed, username } = req.body;
    if (!username) return res.status(400).json({ error: "Username string field is required" });
    
    const query = `
        INSERT INTO user_progress (user_name, task_id, is_completed) 
        VALUES (?, ?, ?)
        ON CONFLICT(user_name, task_id) DO UPDATE SET is_completed = excluded.is_completed
    `;
    db.run(query, [username, req.params.id, is_completed], function(err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ success: true });
    });
});

app.listen(3000, "0.0.0.0", () => console.log('Upgraded system is listening on port 3000'));