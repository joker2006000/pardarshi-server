const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

exports.analyzeReceipt = async (imageBuffer, mimeType, expectedTitle, expectedDescription) => {
    // 1. Keep googleSearch, but REMOVE generationConfig to avoid API conflicts
    const model = genAI.getGenerativeModel({ 
        model: "gemini-1.5-flash",
        tools: [{ googleSearch: {} }] 
    });

    // 2. Instruct the AI to output raw JSON format explicitly
    const prompt = `
    You are a strict financial auditor for the PARDARSHI transparency platform.
    Analyze this receipt. Use your Google Search tool to verify the vendor name and address.
    
    You MUST return ONLY a raw JSON object. Do not include markdown formatting like \`\`\`json. 
    Return EXACTLY these keys:
    - "vendor_name": (string) The name of the business.
    - "maps_vendor_found": (boolean) True ONLY if a physical shop or registered business exists on Google Maps/Search.
    - "maps_address_match": (boolean) True if the address printed on the receipt matches the location data found on Google.
    - "receipt_date": (string) YYYY-MM-DD format.
    - "total_amount": (number) The final billed amount.
    - "tax_amount": (number) Total taxes, 0 if none.
    - "line_items": (array of strings) List of purchased items.
    - "context_match": (boolean) Evaluate if the physical items logically align with the project expense title: "${expectedTitle}" and description: "${expectedDescription}".
    - "anomaly_reason": (string or null) If context_match, maps_vendor_found, or maps_address_match is false, strictly explain why in one short English sentence.
    `;

    const imagePart = {
        inlineData: { data: imageBuffer.toString("base64"), mimeType: mimeType }
    };

    try {
        const result = await model.generateContent([prompt, imagePart]);
        let responseText = result.response.text();
        
        // 3. Clean up the response just in case the AI wraps it in markdown blocks
        responseText = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
        
        return JSON.parse(responseText);
    } catch (error) {
        console.error("Gemini API Error:", error);
        throw new Error("AI Processing Failed");
    }
};