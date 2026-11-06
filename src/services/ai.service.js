const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

exports.analyzeReceipt = async (imageBuffer, mimeType, expectedTitle, expectedDescription) => {
    const model = genAI.getGenerativeModel({ 
    model: "gemini-3.5-flash", // ✅ Updated active model string
    tools: [{ googleSearch: {} }], 
    generationConfig: { responseMimeType: "application/json" }
});

    const prompt = `
    You are a strict financial auditor for the PARDARSHI transparency platform.
    Analyze this receipt and return a JSON object with EXACTLY these keys:
    - "vendor_name": (string) The name of the business.
    - "maps_vendor_found": (boolean) Use your Google Search tool to search Google Maps for this vendor name and city. Return true ONLY if a physical shop or registered business exists on Google Maps.
    - "maps_address_match": (boolean) Return true if the address printed on the receipt matches the location data found on Google Maps.
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
        return JSON.parse(result.response.text());
    } catch (error) {
        console.error("Gemini API Error:", error);
        throw new Error("AI Processing Failed");
    }
};