require('dotenv').config();
const express = require('express');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { VAPID_PUBLIC_KEY, sendPushNotification } = require('./lib/push');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const db = require('./db');

// Push notifications: shared VAPID setup + sendPushNotification live in ./lib/push.js

// Ensure push_subscriptions table exists
async function ensurePushSubscriptionsTable() {
    try {
        await db.query(`CREATE TABLE IF NOT EXISTS push_subscriptions (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            endpoint TEXT NOT NULL,
            push_keys TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);
        console.log('Push subscriptions table ready.');
    } catch (err) {
        console.warn('Could not ensure push_subscriptions table:', err.message);
    }
}

const app = express();

// SECURITY: Require JWT_SECRET — crash early if missing
if (!process.env.JWT_SECRET) {
    console.error('FATAL: JWT_SECRET environment variable is required. Set it in your .env file.');
    process.exit(1);
}
const JWT_SECRET = process.env.JWT_SECRET;

// 1. SECURITY MIDDLEWARE (Must be declared before any route handlers)
app.use(helmet({
    contentSecurityPolicy: false, // Disabled to allow inline scripts in current frontend
    crossOriginEmbedderPolicy: false
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cors({
    origin: process.env.ALLOWED_ORIGIN || '*',
    credentials: true
}));
app.use(express.static('public'));
// Authenticated file serving — replaces public static for uploads
// Accepts token via Authorization header OR ?token= query param (for browser <a> links)
app.get('/uploads/:filename', (req, res, next) => {
    // Try Authorization header first, then query param
    let token = null;
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
        token = authHeader.split(' ')[1];
    } else if (req.query.token) {
        token = req.query.token;
    }
    if (!token) return res.status(401).json({ error: 'Access denied. Please log in.' });
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid or expired token.' });
        req.user = user;
        next();
    });
}, async (req, res) => {
    const filename = req.params.filename;
    // Only allow safe filenames (no path traversal)
    if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
        return res.status(400).json({ error: 'Invalid filename.' });
    }
    try {
        // OWNERSHIP CHECK: the file must belong to the logged-in user
        const [ownProject] = await db.query(
            'SELECT id FROM software_projects WHERE (file_path = ? OR file_name = ?) AND user_id = ? LIMIT 1',
            [filename, filename, req.user.id]
        );
        const [ownPayment] = await db.query(
            `SELECT h.id FROM payment_history h
             JOIN software_projects p ON h.project_id = p.id
             WHERE (h.file_path = ? OR h.file_name = ?) AND p.user_id = ? LIMIT 1`,
            [filename, filename, req.user.id]
        );
        if (ownProject.length === 0 && ownPayment.length === 0) {
            return res.status(404).json({ error: 'File not found.' });
        }
        res.sendFile(path.join(__dirname, 'uploads', filename));
    } catch (error) {
        serverError(res, error, 'Upload file lookup failed');
    }
});

// Rate limiter for auth routes (login, signup, password change)
const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10, // 10 attempts per window
    message: { error: 'Too many attempts. Please try again in 15 minutes.' },
    standardHeaders: true,
    legacyHeaders: false
});

// General API rate limiter
const apiLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 100, // 100 requests per minute
    message: { error: 'Too many requests. Please slow down.' },
    standardHeaders: true,
    legacyHeaders: false
});

// 2. Database Connection Pool (imported from db.js)

// 3. Cloudinary Config (Production file storage)
if (process.env.CLOUDINARY_CLOUD_NAME) {
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET
    });
}

// File Upload Config — Use Cloudinary in production, local disk in development
let upload;
if (process.env.CLOUDINARY_CLOUD_NAME) {
    const cloudinaryStorage = new CloudinaryStorage({
        cloudinary: cloudinary,
        params: {
            folder: 'task-reminder',
            resource_type: 'auto'
        }
    });
    upload = multer({ storage: cloudinaryStorage });
    console.log('File uploads: Cloudinary (production)');
} else {
    const diskStorage = multer.diskStorage({
        destination: (req, file, cb) => cb(null, 'uploads/'),
        filename: (req, file, cb) => cb(null, Date.now() + path.extname(file.originalname))
    });
    upload = multer({ storage: diskStorage });
    console.log('File uploads: Local disk (development)');
}

// 4. Auth Verification Middleware
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ error: 'Access denied. Please log in.' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid or expired token.' });
        req.user = user;
        next();
    });
}

// 4b. Safe error responder — log full details server-side, send a generic message to the client
function serverError(res, error, context = 'API error') {
    console.error(`${context}:`, (error && error.stack) || error);
    if (!res.headersSent) {
        res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
}

// 5. CSV Converter Helper
function jsonToCSV(items, headers) {
    const headerRow = headers.join(',') + '\n';
    const rows = items.map(item => {
        return headers.map(header => {
            let val = item[header] !== undefined && item[header] !== null ? String(item[header]) : '';
            if (val.includes('T00:00:00')) val = val.split('T')[0];
            val = val.replace(/"/g, '""');
            return `"${val}"`;
        }).join(',');
    }).join('\n');
    return headerRow + rows;
}

// --- AUTHENTICATION ROUTES ---

// Input sanitization helper
function sanitize(str) {
    if (typeof str !== 'string') return str;
    return str.replace(/[<>"'&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;', '&': '&amp;' })[c]);
}

// Email validation helper
function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

app.post('/api/auth/register', authLimiter, async (req, res) => {
    try {
        let { name, email, password } = req.body;
        if (!name || !email || !password) {
            return res.status(400).json({ error: 'All fields are required.' });
        }
        if (!isValidEmail(email)) {
            return res.status(400).json({ error: 'Invalid email format.' });
        }
        if (password.length < 6) {
            return res.status(400).json({ error: 'Password must be at least 6 characters.' });
        }
        // Sanitize name
        name = sanitize(name.trim());
        email = email.trim().toLowerCase();

        const hashedPassword = await bcrypt.hash(password, 10);
        await db.query(
            'INSERT INTO users (name, email, password) VALUES (?, ?, ?)',
            [name, email, hashedPassword]
        );

        res.status(201).json({ message: 'User registered successfully!' });
    } catch (error) {
        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Email already exists.' });
        }
        serverError(res, error);
    }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
    try {
        const { email, password } = req.body;
        const [users] = await db.query('SELECT * FROM users WHERE email = ?', [email]);
        
        if (users.length === 0) return res.status(400).json({ error: 'Invalid email or password.' });

        const user = users[0];
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) return res.status(400).json({ error: 'Invalid email or password.' });

        const token = jwt.sign(
            { id: user.id, name: user.name, email: user.email }, 
            JWT_SECRET, 
            { expiresIn: '24h' }
        );

        res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
    } catch (error) {
        serverError(res, error);
    }
});

app.post('/api/auth/change-password', authenticateToken, authLimiter, async (req, res) => {
    try {
        const { currentPassword, newPassword } = req.body;
        if (!currentPassword || !newPassword) {
            return res.status(400).json({ error: 'Both current and new password are required.' });
        }
        if (newPassword.length < 6) {
            return res.status(400).json({ error: 'New password must be at least 6 characters.' });
        }

        const [users] = await db.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
        if (users.length === 0) return res.status(404).json({ error: 'User not found.' });

        const user = users[0];
        const validPassword = await bcrypt.compare(currentPassword, user.password);
        if (!validPassword) return res.status(400).json({ error: 'Current password is incorrect.' });

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await db.query('UPDATE users SET password = ? WHERE id = ?', [hashedPassword, req.user.id]);

        res.json({ message: 'Password updated successfully.' });
    } catch (error) {
        serverError(res, error);
    }
});

// --- PUSH NOTIFICATION ROUTES ---

app.get('/api/push/vapid-key', (req, res) => {
    res.json({ publicKey: VAPID_PUBLIC_KEY || null });
});

app.post('/api/push/subscribe', authenticateToken, async (req, res) => {
    try {
        const { subscription } = req.body;
        if (!subscription || !subscription.endpoint || !subscription.keys) {
            return res.status(400).json({ error: 'Invalid subscription data.' });
        }

        // Check if this endpoint already exists for this user
        const [existing] = await db.query(
            'SELECT id FROM push_subscriptions WHERE user_id = ? AND endpoint = ?',
            [req.user.id, subscription.endpoint]
        );

        if (existing.length === 0) {
            await db.query(
                'INSERT INTO push_subscriptions (user_id, endpoint, push_keys) VALUES (?, ?, ?)',
                [req.user.id, subscription.endpoint, JSON.stringify(subscription.keys)]
            );
        }

        res.json({ message: 'Push subscription saved.' });
    } catch (error) {
        serverError(res, error);
    }
});

app.delete('/api/push/unsubscribe', authenticateToken, async (req, res) => {
    try {
        const { endpoint } = req.body;
        if (endpoint) {
            await db.query(
                'DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?',
                [req.user.id, endpoint]
            );
        } else {
            await db.query('DELETE FROM push_subscriptions WHERE user_id = ?', [req.user.id]);
        }
        res.json({ message: 'Push subscription removed.' });
    } catch (error) {
        serverError(res, error);
    }
});

// --- PROTECTED TASK ROUTES ---

app.get('/api/tasks', authenticateToken, async (req, res) => {
    try {
        const [tasks] = await db.query(
            'SELECT * FROM daily_tasks WHERE user_id = ? ORDER BY due_date ASC',
            [req.user.id]
        );
        res.json(tasks);
    } catch (error) {
        serverError(res, error);
    }
});

app.post('/api/tasks', authenticateToken, apiLimiter, async (req, res) => {
    try {
        let { title, description, due_date, due_time } = req.body;
        title = sanitize(title);
        if (description) description = sanitize(description);
        // Combine date and time into a single DATETIME value
        const taskDateTime = due_time ? `${due_date} ${due_time}:00` : `${due_date} 09:00:00`;
        await db.query(
            'INSERT INTO daily_tasks (user_id, title, description, due_date) VALUES (?, ?, ?, ?)',
            [req.user.id, title, description, taskDateTime]
        );
        res.status(201).json({ message: 'Task created successfully' });
    } catch (error) {
        serverError(res, error);
    }
});

app.put('/api/tasks/:id/complete', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        await db.query("UPDATE daily_tasks SET status = 'completed', completed_at = NOW() WHERE id = ? AND user_id = ?", [id, req.user.id]);
        res.json({ message: 'Task marked as completed' });
    } catch (error) {
        serverError(res, error);
    }
});

app.delete('/api/tasks/:id', authenticateToken, apiLimiter, async (req, res) => {
    try {
        const { id } = req.params;
        await db.query('DELETE FROM daily_tasks WHERE id = ? AND user_id = ?', [id, req.user.id]);
        res.json({ message: 'Task deleted successfully' });
    } catch (error) {
        serverError(res, error);
    }
});

// --- PROTECTED SOFTWARE & RENEWAL ROUTES ---

app.get('/api/projects', authenticateToken, async (req, res) => {
    try {
        const [projects] = await db.query(
            'SELECT * FROM software_projects WHERE user_id = ? ORDER BY next_renewal_date ASC',
            [req.user.id]
        );
        res.json(projects);
    } catch (error) {
        serverError(res, error);
    }
});

app.post('/api/projects', authenticateToken, apiLimiter, upload.single('document'), async (req, res) => {
    try {
        let { software_name, launch_date, next_renewal_date, renewal_cycle, doc_type } = req.body;
        software_name = sanitize(software_name);
        const file_name = req.file ? req.file.originalname : null;
        const file_path = req.file ? (req.file.path || req.file.filename) : null;

        await db.query(`
            INSERT INTO software_projects (user_id, software_name, launch_date, next_renewal_date, renewal_cycle, doc_type, file_name, file_path, status)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active')
        `, [req.user.id, software_name, launch_date || null, next_renewal_date, renewal_cycle, doc_type || null, file_name, file_path]);

        res.status(201).json({ message: 'Software project added successfully' });
    } catch (error) {
        console.error('Error saving subscription:', error.stack || error.message);
        let userMessage = 'Something went wrong. Please try again.';
        if (error.message.includes('Unknown column')) {
            userMessage = 'Database is missing required columns. Please run migrate.sql to update your database schema.';
        }
        res.status(500).json({ error: userMessage });
    }
});

app.put('/api/projects/:id/renew', authenticateToken, apiLimiter, upload.single('document'), async (req, res) => {
    try {
        const { id } = req.params;
        const { amount_paid, next_renewal_date, payment_method, notes } = req.body;

        const [projects] = await db.query('SELECT * FROM software_projects WHERE id = ? AND user_id = ?', [id, req.user.id]);
        if (projects.length === 0) return res.status(404).json({ error: 'Project not found' });

        const project = projects[0];

        // Use user-provided next renewal date, or calculate as fallback
        let nextRenewalStr;
        if (next_renewal_date) {
            nextRenewalStr = next_renewal_date;
        } else {
            const currentRenewal = new Date(project.next_renewal_date);
            if (project.renewal_cycle === 'monthly') {
                currentRenewal.setMonth(currentRenewal.getMonth() + 1);
            } else {
                currentRenewal.setFullYear(currentRenewal.getFullYear() + 1);
            }
            nextRenewalStr = currentRenewal.toISOString().split('T')[0];
        }

        // Update renewal date and document on the project
        const new_file_name = req.file ? req.file.originalname : null;
        const new_file_path = req.file ? (req.file.path || req.file.filename) : null;

        // Use new file if uploaded, otherwise keep project's existing file
        const file_name = new_file_name || project.file_name || null;
        const file_path = new_file_path || project.file_path || null;
        const doc_type = req.body.doc_type || project.doc_type || null;

        if (new_file_path) {
            await db.query('UPDATE software_projects SET next_renewal_date = ?, file_name = ?, file_path = ? WHERE id = ? AND user_id = ?',
                [nextRenewalStr, new_file_name, new_file_path, id, req.user.id]);
        } else {
            await db.query('UPDATE software_projects SET next_renewal_date = ? WHERE id = ? AND user_id = ?',
                [nextRenewalStr, id, req.user.id]);
        }
        
        // Try inserting with all columns; if columns are missing, fall back to basic insert
        try {
            await db.query(
                'INSERT INTO payment_history (project_id, amount_paid, period_covered, payment_date, payment_method, notes, file_name, file_path, doc_type) VALUES (?, ?, ?, CURDATE(), ?, ?, ?, ?, ?)',
                [id, amount_paid || 0, project.renewal_cycle, payment_method || null, notes || null, file_name || null, file_path || null, doc_type]
            );
        } catch (insertErr) {
            console.warn('Falling back to basic payment_history insert:', insertErr.message);
            await db.query(
                'INSERT INTO payment_history (project_id, amount_paid, period_covered, payment_date) VALUES (?, ?, ?, CURDATE())',
                [id, amount_paid || 0, project.renewal_cycle]
            );
        }

        res.json({ message: 'Renewal updated', next_renewal_date: nextRenewalStr });
    } catch (error) {
        console.error('Error updating renewal:', error.stack || error.message);
        let userMessage = 'Something went wrong. Please try again.';
        if (error.message.includes('Unknown column')) {
            userMessage = 'Database is missing required columns. Please run migrate.sql to update your database schema.';
        }
        res.status(500).json({ error: userMessage });
    }
});

app.put('/api/projects/:id', authenticateToken, upload.single('document'), async (req, res) => {
    try {
        const { id } = req.params;
        const { software_name, launch_date, next_renewal_date, renewal_cycle, doc_type } = req.body;

        const [projects] = await db.query('SELECT * FROM software_projects WHERE id = ? AND user_id = ?', [id, req.user.id]);
        if (projects.length === 0) return res.status(404).json({ error: 'Project not found' });

        const project = projects[0];

        // Optional file replacement: keep the existing file unless a new one is uploaded
        const new_file_name = req.file ? req.file.originalname : null;
        // Local disk: store the bare filename (what the /uploads link builder expects);
        // Cloudinary: req.file.path is the full public URL — store that instead
        const new_file_path = req.file ? (req.file.path && req.file.path.startsWith('http') ? req.file.path : req.file.filename) : null;
        const file_name = new_file_name || project.file_name;
        const file_path = new_file_path || project.file_path;

        await db.query(
            'UPDATE software_projects SET software_name = ?, launch_date = ?, next_renewal_date = ?, renewal_cycle = ?, doc_type = ?, file_name = ?, file_path = ? WHERE id = ? AND user_id = ?',
            [software_name, launch_date || null, next_renewal_date, renewal_cycle, doc_type || null, file_name, file_path, id, req.user.id]
        );

        res.json({ message: 'Subscription updated successfully' });
    } catch (error) {
        console.error('Error updating subscription:', error.message);
        serverError(res, error);
    }
});

app.put('/api/projects/:id/status', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { status } = req.body;

        if (!['active', 'inactive'].includes(status)) {
            return res.status(400).json({ error: 'Invalid status. Must be active or inactive' });
        }

        const [projects] = await db.query('SELECT * FROM software_projects WHERE id = ? AND user_id = ?', [id, req.user.id]);
        if (projects.length === 0) return res.status(404).json({ error: 'Project not found' });

        await db.query('UPDATE software_projects SET status = ? WHERE id = ? AND user_id = ?', [status, id, req.user.id]);

        res.json({ message: `Subscription ${status === 'active' ? 'activated' : 'deactivated'}` });
    } catch (error) {
        console.error('Error updating subscription status:', error.message);
        serverError(res, error);
    }
});

app.get('/api/projects/:id/payments', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const [history] = await db.query(
            `SELECT h.* FROM payment_history h
             JOIN software_projects p ON h.project_id = p.id
             WHERE h.project_id = ? AND p.user_id = ?
             ORDER BY h.payment_date DESC`,
            [id, req.user.id]
        );
        res.json(history);
    } catch (error) {
        serverError(res, error);
    }
});

// --- METRICS & ALERTS ROUTES ---

app.get('/api/notifications', authenticateToken, async (req, res) => {
    try {
        const [alerts] = await db.query(`
            SELECT software_name, next_renewal_date, DATEDIFF(next_renewal_date, CURDATE()) as days_left
            FROM software_projects
            WHERE user_id = ? AND DATEDIFF(next_renewal_date, CURDATE()) <= 30 AND status = 'active'
            ORDER BY days_left ASC
        `, [req.user.id]);
        res.json(alerts);
    } catch (error) {
        serverError(res, error);
    }
});

app.get('/api/analytics', authenticateToken, async (req, res) => {
    try {
        const [[tasks]] = await db.query("SELECT COUNT(*) as pending_tasks FROM daily_tasks WHERE user_id = ? AND status = 'pending'", [req.user.id]);
        const [[completed]] = await db.query("SELECT COUNT(*) as completed_tasks FROM daily_tasks WHERE user_id = ? AND status = 'completed' AND completed_at >= DATE_FORMAT(NOW(), '%Y-%m-01')", [req.user.id]);
        const [[overdue]] = await db.query("SELECT COUNT(*) as overdue_tasks FROM daily_tasks WHERE user_id = ? AND status = 'pending' AND due_date < NOW()", [req.user.id]);
        const [[software]] = await db.query("SELECT COUNT(*) as active_software FROM software_projects WHERE user_id = ? AND status = 'active'", [req.user.id]);
        const [[payments]] = await db.query(`
            SELECT COALESCE(SUM(h.amount_paid), 0) as total_spend 
            FROM payment_history h
            JOIN software_projects p ON h.project_id = p.id
            WHERE p.user_id = ?
        `, [req.user.id]);

        res.json({
            pendingTasks: tasks.pending_tasks,
            completedTasks: completed.completed_tasks,
            overdueTasks: overdue.overdue_tasks,
            activeSoftware: software.active_software,
            totalSpend: payments.total_spend
        });
    } catch (error) {
        serverError(res, error);
    }
});

// --- REMINDERS ROUTES ---

app.get('/api/reminders', authenticateToken, async (req, res) => {
    try {
        const [reminders] = await db.query(
            'SELECT * FROM reminders WHERE user_id = ? ORDER BY reminder_date ASC',
            [req.user.id]
        );
        res.json(reminders);
    } catch (error) {
        // If table doesn't exist, return empty array
        if (error.message.includes('doesn\'t exist') || error.message.includes('does not exist')) {
            return res.json([]);
        }
        serverError(res, error);
    }
});

app.post('/api/reminders', authenticateToken, apiLimiter, async (req, res) => {
    try {
        let { title, description, reminder_date, reminder_time, priority } = req.body;
        title = sanitize(title);
        if (description) description = sanitize(description);
        if (!title || !reminder_date) {
            return res.status(400).json({ error: 'Title and date are required.' });
        }
        const reminderDateTime = reminder_time ? `${reminder_date} ${reminder_time}:00` : `${reminder_date} 09:00:00`;
        await db.query(
            'INSERT INTO reminders (user_id, title, description, reminder_date, priority) VALUES (?, ?, ?, ?, ?)',
            [req.user.id, title, description || null, reminderDateTime, priority || 'medium']
        );
        res.status(201).json({ message: 'Reminder added successfully.' });
    } catch (error) {
        if (error.message.includes("doesn't exist") || error.message.includes('does not exist')) {
            try {
                await ensureRemindersTable();
                const reminderDateTime = reminder_time ? `${reminder_date} ${reminder_time}:00` : `${reminder_date} 09:00:00`;
                await db.query(
                    'INSERT INTO reminders (user_id, title, description, reminder_date, priority) VALUES (?, ?, ?, ?, ?)',
                    [req.user.id, title, description || null, reminderDateTime, priority || 'medium']
                );
                return res.status(201).json({ message: 'Reminder added successfully.' });
            } catch (retryErr) {
                return serverError(res, retryErr, 'Failed to create reminders table');
            }
        }
        serverError(res, error);
    }
});

app.put('/api/reminders/:id/complete', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        await db.query("UPDATE reminders SET status = 'completed' WHERE id = ? AND user_id = ?", [id, req.user.id]);
        res.json({ message: 'Reminder marked as completed.' });
    } catch (error) {
        serverError(res, error);
    }
});

app.delete('/api/reminders/:id', authenticateToken, apiLimiter, async (req, res) => {
    try {
        const { id } = req.params;
        await db.query('DELETE FROM reminders WHERE id = ? AND user_id = ?', [id, req.user.id]);
        res.json({ message: 'Reminder deleted.' });
    } catch (error) {
        serverError(res, error);
    }
});
// --- EXPORT ROUTES ---

app.get('/api/export/renewals', authenticateToken, async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT software_name, launch_date, next_renewal_date, renewal_cycle, status
            FROM software_projects
            WHERE user_id = ?
            ORDER BY next_renewal_date ASC
        `, [req.user.id]);
        
        const headers = ['software_name', 'launch_date', 'next_renewal_date', 'renewal_cycle', 'status'];
        const csvData = jsonToCSV(rows, headers);

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="software_renewals.csv"');
        res.status(200).send(csvData);
    } catch (error) {
        serverError(res, error);
    }
});

app.get('/api/export/payments', authenticateToken, async (req, res) => {
    try {
        const [rows] = await db.query(`
            SELECT p.software_name, h.payment_date, h.amount_paid, h.period_covered
            FROM payment_history h
            JOIN software_projects p ON h.project_id = p.id
            WHERE p.user_id = ?
            ORDER BY h.payment_date DESC
        `, [req.user.id]);

        const headers = ['software_name', 'payment_date', 'amount_paid', 'period_covered'];
        const csvData = jsonToCSV(rows, headers);

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename="payment_history.csv"');
        res.status(200).send(csvData);
    } catch (error) {
        serverError(res, error);
    }
});

// Auto-add file columns to payment_history if missing
async function ensurePaymentHistoryFileColumns() {
    const columns = [
        { name: 'file_name', def: 'VARCHAR(255) DEFAULT NULL' },
        { name: 'file_path', def: 'VARCHAR(255) DEFAULT NULL' },
        { name: 'doc_type', def: 'VARCHAR(50) DEFAULT NULL' }
    ];
    for (const col of columns) {
        try {
            await db.query(`ALTER TABLE payment_history ADD COLUMN ${col.name} ${col.def}`);
            console.log(`Added payment_history.${col.name} column.`);
        } catch (err) {
            // Column already exists — ignore
        }
    }
}

// Monthly completed counter: add completed_at column and stamp legacy rows once
async function ensureTaskCompletedAtColumn() {
    try {
        await db.query(`ALTER TABLE daily_tasks ADD COLUMN completed_at TIMESTAMP NULL DEFAULT NULL`);
        console.log('Added daily_tasks.completed_at column.');
    } catch (err) {
        if (!err.message.includes('Duplicate column name')) {
            console.warn('Could not add daily_tasks.completed_at:', err.message);
            return; // column missing for another reason — skip backfill
        }
    }
    try {
        // One-time backfill: only touches rows with no timestamp, so it never re-stamps
        const [result] = await db.query(`UPDATE daily_tasks SET completed_at = NOW() WHERE status = 'completed' AND completed_at IS NULL`);
        if (result.affectedRows > 0) console.log(`Stamped completed_at on ${result.affectedRows} legacy completed task(s).`);
    } catch (err) {
        console.warn('Could not backfill completed_at:', err.message);
    }
}

// Auto-create reminders table if it doesn't exist
async function ensureRemindersTable() {
    try {
        await db.query(`CREATE TABLE IF NOT EXISTS reminders (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_id INT NOT NULL,
            title VARCHAR(255) NOT NULL,
            description TEXT DEFAULT NULL,
            reminder_date DATETIME NOT NULL,
            priority VARCHAR(20) DEFAULT 'medium',
            status VARCHAR(20) DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
        )`);
        console.log('Reminders table ready.');
    } catch (err) {
        console.warn('Could not auto-create reminders table:', err.message);
    }
}

// --- GLOBAL ERROR HANDLING (must stay after all routes) ---
app.use((err, req, res, next) => {
    console.error(`Unhandled error on ${req.method} ${req.originalUrl}:`, (err && err.stack) || err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

// Process-level safety net: never die silently
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection:', (reason && reason.stack) || reason);
});
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', (err && err.stack) || err);
    process.exit(1); // exit so the platform (Render/systemd) restarts us cleanly
});

// Start Application Server
const PORT = process.env.PORT || 4000;
app.listen(PORT, async () => {
    console.log(`Server running on http://localhost:${PORT}`);
    await ensureRemindersTable();
    await ensurePushSubscriptionsTable();
    await ensurePaymentHistoryFileColumns();
    await ensureTaskCompletedAtColumn();
    require('./scheduler'); // Start the cron scheduler
});