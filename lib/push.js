require('dotenv').config();
const webPush = require('web-push');
const db = require('../db');

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

module.exports = { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, sendPushNotification };
