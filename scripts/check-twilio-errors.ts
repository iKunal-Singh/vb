import twilio from 'twilio';
import dotenv from 'dotenv';

dotenv.config();

const {
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
} = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN) {
    console.error('Missing required environment variables in .env');
    process.exit(1);
}

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

async function checkDebugger() {
    console.log('🔍 Checking Twilio Debugger for recent errors...');
    try {
        const alerts = await client.monitor.v1.alerts.list({ limit: 5 });
        if (alerts.length === 0) {
            console.log('✅ No recent alerts found.');
        } else {
            alerts.forEach(alert => {
                console.log(`--- Alert ---`);
                console.log(`Date: ${alert.dateCreated}`);
                console.log(`Code: ${alert.errorCode}`);
                console.log(`Level: ${alert.logLevel}`);
                console.log(`Summary: ${alert.alertText}`);
                console.log(`URL: ${alert.resourceSid}`);
            });
        }
    } catch (error) {
        console.error('❌ Failed to fetch Twilio alerts:', error);
    }
}

void checkDebugger();
