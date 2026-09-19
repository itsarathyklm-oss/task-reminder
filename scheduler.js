require('dotenv').config();
const cron = require('node-cron');
const db = require('./db');
const webPush = require('web-push');

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

// Send push notification to a user
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

// This cron job runs every day at 8:00 AM
cron.schedule('0 8 * * *', async () => {
    console.log('Running daily reminder checks...');

    try {
        // 1. Fetch ALL software renewals due within the next 30 days
        const [renewals] = await db.query(`
            SELECT software_name, next_renewal_date, DATEDIFF(next_renewal_date, CURDATE()) as days_left, user_id
            FROM software_projects
            WHERE DATEDIFF(next_renewal_date, CURDATE()) BETWEEN 0 AND 30
              AND status = 'active'
            ORDER BY days_left ASC
        `);

        for (const project of renewals) {
            let title, body;
            if (project.days_left === 0) {
                title = '🔄 Subscription Due Today!';
                body = `${project.software_name} renews today. Don't forget to renew!`;
                console.log(`🟡 DUE TODAY: ${project.software_name} renews today!`);
            } else if (project.days_left <= 7) {
                title = '🔴 Urgent Renewal';
                body = `${project.software_name} renews in ${project.days_left} day(s). Act now!`;
                console.log(`🔴 RENEWAL URGENT: ${project.software_name} renews in ${project.days_left} day(s)`);
            } else if (project.days_left <= 15) {
                title = '🟠 Subscription Renewal Soon';
                body = `${project.software_name} renews in ${project.days_left} day(s).`;
                console.log(`🟠 RENEWAL SOON: ${project.software_name} renews in ${project.days_left} day(s)`);
            } else {
                title = '🔔 Renewal Reminder';
                body = `${project.software_name} renews in ${project.days_left} day(s).`;
                console.log(`🔔 RENEWAL REMINDER: ${project.software_name} renews in ${project.days_left} day(s)`);
            }
            await sendPushNotification(project.user_id, title, body, '/?view=renewals');
        }

        // 2. Fetch overdue daily tasks (pending tasks past their due date)
        const [overdueTasks] = await db.query(`
            SELECT title, due_date, user_id
            FROM daily_tasks
            WHERE status = 'pending' AND due_date < NOW()
            ORDER BY due_date ASC
        `);

        for (const task of overdueTasks) {
            await sendPushNotification(
                task.user_id,
                '🔴 Overdue Task',
                `"${task.title}" was due on ${new Date(task.due_date).toLocaleDateString()}. Please complete it!`,
                '/?view=tasks'
            );
            console.log(`🔴 OVERDUE TASK: "${task.title}" was due on ${task.due_date}`);
        }

        // 3. Fetch tasks due today
        const [todayTasks] = await db.query(`
            SELECT title, user_id
            FROM daily_tasks
            WHERE due_date = CURDATE() AND status = 'pending'
        `);

        for (const task of todayTasks) {
            await sendPushNotification(
                task.user_id,
                '📝 Task Due Today',
                `"${task.title}" is due today. Stay on track!`,
                '/?view=tasks'
            );
            console.log(`📝 TASK DUE TODAY: "${task.title}"`);
        }

        // 4. Fetch tasks due tomorrow (advance reminder)
        const [tomorrowTasks] = await db.query(`
            SELECT title, user_id
            FROM daily_tasks
            WHERE due_date = DATE_ADD(CURDATE(), INTERVAL 1 DAY) AND status = 'pending'
        `);

        for (const task of tomorrowTasks) {
            await sendPushNotification(
                task.user_id,
                '⏰ Task Due Tomorrow',
                `"${task.title}" is due tomorrow. Get prepared!`,
                '/?view=tasks'
            );
            console.log(`⏰ TASK DUE TOMORROW: "${task.title}"`);
        }

        // Summary
        const totalAlerts = renewals.length + overdueTasks.length + todayTasks.length + tomorrowTasks.length;
        if (totalAlerts === 0) {
            console.log('✅ No alerts. All clear!');
        } else {
            console.log(`📋 Summary: ${renewals.length} renewal(s), ${overdueTasks.length} overdue task(s), ${todayTasks.length} task(s) due today, ${tomorrowTasks.length} due tomorrow`);
        }

    } catch (error) {
        console.error('Error running scheduler:', error.message);
    }
});

console.log('Scheduler initialized. Checks run daily at 8:00 AM.');