require('dotenv').config();
const express = require('express');
const path = require('path');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const webPush = require('web-push');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cloudinary = require('cloudinary').v2;
const { CloudinaryStorage } = require('multer-storage-cloudinary');
const db = require('./db');

// Push Notification Configuration
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webPush.setVapidDetails(
        process.env.VAPID_EMAIL || 'mailto:admin@taskreminder.app',
        VAPID_PUBLIC_KEY,
        VAPID_PRIVATE_KEY
    );
}

// Helper to send push notification to a user
async function sendPushNotification(userId, title, body, url = '/') {
    if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
    try {
        const [subscriptions] = await db.query(
            'SELECT * FROM push_subscriptions WHERE user_id = ?',
            [userId]
        );
        for (const sub of subscriptions) {
            try {
                await webPush.sendNotification(
                    { endpoint: sub.endpoint, keys: JSON.parse(sub.push_keys) },
                    JSON.stringify({ title, body, url })
                );
            } catch (err) {
                // If subscription is expired or invalid, remove it
                if (err.statusCode === 404 || err.statusCode === 410) {
                    await db.query('DELETE FROM push_subscriptions WHERE id = ?', [sub.id]);
                } else {
                    console.error('Push notification error:', err.message);
                }
            }
        }
    } catch (err) {
        console.error('sendPushNotification error:', err.message);
    }
}

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
}, (req, res) => {
    const filename = req.params.filename;
    // Only allow safe filenames (no path traversal)
    if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
        return res.status(400).json({ error: 'Invalid filename.' });
    }
    res.sendFile(path.join(__dirname, 'uploads', filename));
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
        res.status(500).json({ error: error.message });
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
        res.status(500).json({ error: error.message });
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
        res.status(500).json({ error: error.message });
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
        res.status(500).json({ error: error.message });
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
        res.status(500).json({ error: error.message });
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
        res.status(500).json({ error: error.message });
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
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/tasks/:id/complete', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        await db.query('UPDATE daily_tasks SET status = "completed" WHERE id = ? AND user_id = ?', [id, req.user.id]);
        res.json({ message: 'Task marked as completed' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/tasks/:id', authenticateToken, apiLimiter, async (req, res) => {
    try {
        const { id } = req.params;
        await db.query('DELETE FROM daily_tasks WHERE id = ? AND user_id = ?', [id, req.user.id]);
        res.json({ message: 'Task deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: error.message });
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
        res.status(500).json({ error: error.message });
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
        console.error('Error saving subscription:', error.message);
        let userMessage = error.message;
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
        console.error('Error updating renewal:', error.message);
        let userMessage = error.message;
        if (error.message.includes('Unknown column')) {
            userMessage = 'Database is missing required columns. Please run migrate.sql to update your database schema.';
        }
        res.status(500).json({ error: userMessage });
    }
});

app.put('/api/projects/:id', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        const { software_name, launch_date, next_renewal_date, renewal_cycle, doc_type } = req.body;

        const [projects] = await db.query('SELECT * FROM software_projects WHERE id = ? AND user_id = ?', [id, req.user.id]);
        if (projects.length === 0) return res.status(404).json({ error: 'Project not found' });

        await db.query(
            'UPDATE software_projects SET software_name = ?, launch_date = ?, next_renewal_date = ?, renewal_cycle = ?, doc_type = ? WHERE id = ? AND user_id = ?',
            [software_name, launch_date || null, next_renewal_date, renewal_cycle, doc_type || null, id, req.user.id]
        );

        res.json({ message: 'Subscription updated successfully' });
    } catch (error) {
        console.error('Error updating subscription:', error.message);
        res.status(500).json({ error: error.message });
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
        res.status(500).json({ error: error.message });
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
        res.status(500).json({ error: error.message });
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
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/analytics', authenticateToken, async (req, res) => {
    try {
        const [[tasks]] = await db.query("SELECT COUNT(*) as pending_tasks FROM daily_tasks WHERE user_id = ? AND status = 'pending'", [req.user.id]);
        const [[completed]] = await db.query("SELECT COUNT(*) as completed_tasks FROM daily_tasks WHERE user_id = ? AND status = 'completed'", [req.user.id]);
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
        res.status(500).json({ error: error.message });
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
        res.status(500).json({ error: error.message });
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
                return res.status(500).json({ error: 'Failed to create reminders table. ' + retryErr.message });
            }
        }
        res.status(500).json({ error: error.message });
    }
});

app.put('/api/reminders/:id/complete', authenticateToken, async (req, res) => {
    try {
        const { id } = req.params;
        await db.query('UPDATE reminders SET status = "completed" WHERE id = ? AND user_id = ?', [id, req.user.id]);
        res.json({ message: 'Reminder marked as completed.' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.delete('/api/reminders/:id', authenticateToken, apiLimiter, async (req, res) => {
    try {
        const { id } = req.params;
        await db.query('DELETE FROM reminders WHERE id = ? AND user_id = ?', [id, req.user.id]);
        res.json({ message: 'Reminder deleted.' });
    } catch (error) {
        res.status(500).json({ error: error.message });
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
        res.status(500).json({ error: error.message });
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
        res.status(500).json({ error: error.message });
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

// Start Application Server
const PORT = process.env.PORT || 4000;
app.listen(PORT, async () => {
    console.log(`Server running on http://localhost:${PORT}`);
    await ensureRemindersTable();
    await ensurePushSubscriptionsTable();
    await ensurePaymentHistoryFileColumns();
    require('./scheduler'); // Start the cron scheduler
});