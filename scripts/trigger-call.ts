import twilio from 'twilio';
import dotenv from 'dotenv';
import path from 'path';

// Load .env
dotenv.config();

const {
    TWILIO_ACCOUNT_SID,
    TWILIO_AUTH_TOKEN,
    TWILIO_PHONE_NUMBER,
    PUBLIC_URL
} = process.env;

if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER || !PUBLIC_URL) {
    console.error('Missing required environment variables in .env');
    process.exit(1);
}

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

async function makeTestCall() {
    const to = '+918318874440'; // User's number
    const from = TWILIO_PHONE_NUMBER;
    const url = `${PUBLIC_URL}/twiml`;

    console.log(`🚀 Triggering outbound call...`);
    console.log(`   From: ${from}`);
    console.log(`   To:   ${to}`);
    console.log(`   URL:  ${url}`);

    try {
        const call = await client.calls.create({
            url,
            to,
            from,
        });

        console.log(`✅ Call triggered successfully! SID: ${call.sid}`);
        console.log(`📞 Your phone should ring shortly. Answer it to test the bot.`);
    } catch (error) {
        console.error('❌ Failed to trigger call:', error);
    }
}

void makeTestCall();
