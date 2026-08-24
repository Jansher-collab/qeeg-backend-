import 'dotenv/config';
import { sendWelcomeEmail } from './lib/services/emailService';

async function run() {
    console.log('Testing Resend Integration...');
    // Replace this with the user's verified email if they are running in a sandbox, but we will test it anyway.
    const toEmail = process.env.TEST_EMAIL || 'delivered@resend.dev'; 
    const result = await sendWelcomeEmail(toEmail, 'Test User');
    console.log('Result:', result);
}
run();
