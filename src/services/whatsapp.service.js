const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const puppeteer = require('puppeteer'); // <-- Add this line to help find Chrome

const puppeteerConfig = {
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
    ]
};



if (process.env.NODE_ENV === 'production') {
    // Let Puppeteer dynamically find the exact Linux Chrome path on Render!
    puppeteerConfig.executablePath = puppeteer.executablePath();
} else {
    // Your Windows path for local testing
    puppeteerConfig.executablePath = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
}

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: puppeteerConfig
});


client.on('qr', (qr) => {
    console.log('📱 Scan this QR code with your WhatsApp to link the Pardarshi Bot:');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ WhatsApp Bot is successfully connected and ready!');
});

exports.initializeWhatsApp = () => {
    client.initialize();
};

exports.sendThankYouMessage = async (mobile, name, orgName, amount, orgSlug) => {
    try {
        if (!mobile) return false;
        
        // Format number for India (adds 91 and the required WhatsApp suffix)
        const formattedNumber = mobile.replace(/[^0-9]/g, ''); 
        // Assuming Indian numbers. If the number already has 91, this logic might need a small check, 
        // but for standard 10-digit inputs, this works perfectly.
        const finalNumber = formattedNumber.length === 10 ? `91${formattedNumber}` : formattedNumber;
        const chatId = `${finalNumber}@c.us`;
        
        // Construct the unique organization URL
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
        const orgLink = `${frontendUrl}/organization/${orgSlug}`; 
        
        // Exact template matching your design
        let text = `🙏 *Thank You for Your Contribution!*\n\nDear ${name || 'Contributor'},\n\nWe are pleased to inform you that your contribution of ₹${amount} to *${orgName}* has been successfully received. ✅\n\nYour support helps us continue our efforts for the community. We sincerely appreciate your valuable contribution. ❤️\n\n📄 *View Contribution Details:*\n${orgLink}\n\nThank you for supporting ${orgName}.\n\n— Team ${orgName}`;

        await client.sendMessage(chatId, text);
        return true;
    } catch (error) {
        console.error("Failed to send WhatsApp message:", error.message);
        return false;
    }
};