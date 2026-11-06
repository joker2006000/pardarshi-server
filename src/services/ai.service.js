const { GoogleGenAI } = require("@google/genai");

// Set apiVersion to "v1beta" to enable multimodal support for both images and documents
const ai = new GoogleGenAI({
    httpOptions: { apiVersion: "v1beta" }
});

exports.analyzeReceipt = async (imageBuffer, mimeType, expectedTitle, expectedDescription) => {

    const prompt = `
    You are a strict financial auditor for the PARDARSHI transparency platform.
    Analyze this receipt. Use your Google Search tool to verify the vendor name and the address printed on the receipt.
    Evaluate if the physical items logically align with the project expense title: "${expectedTitle}" and description: "${expectedDescription}".
    `;

    const receiptJsonSchema = {
        type: "object",
        properties: {
            vendor_name: { type: "string", description: "The name of the business." },
            maps_vendor_found: { type: "boolean", description: "True ONLY if a physical shop or registered business exists on Google Maps/Search." },
            maps_address_match: { type: "boolean", description: "True if the address printed on the receipt matches the location data found on Google." },
            receipt_date: { type: "string", description: "YYYY-MM-DD format." },
            total_amount: { type: "number", description: "The final billed amount." },
            tax_amount: { type: "number", description: "Total taxes, 0 if none." },
            line_items: { type: "array", items: { type: "string" }, description: "List of purchased items." },
            context_match: { type: "boolean", description: "True if items align with the expected project expense." },
            anomaly_reason: { type: "string", description: "If any match is false, explain why in one short sentence. Otherwise leave empty." }
        },
        required: ["vendor_name", "maps_vendor_found", "maps_address_match", "receipt_date", "total_amount", "tax_amount", "line_items", "context_match", "anomaly_reason"]
    };

    // Dynamically switch the input type based on the uploaded file format
    const mediaType = mimeType === 'application/pdf' ? 'document' : 'image';

    try {
        const interaction = await ai.interactions.create({
            model: "gemini-2.5-flash-lite", // Switch this to 1.5-flash for 1,500 daily requests
            input: [
                { type: "text", text: prompt },
                { type: mediaType, data: imageBuffer.toString("base64"), mime_type: mimeType }
            ],
            tools: [{ type: "google_search" }],
            response_format: { type: "text", mime_type: "application/json", schema: receiptJsonSchema }
        });

        return JSON.parse(interaction.output_text);

    } catch (error) {
        console.error("Gemini API Error:", error);
        throw new Error("AI Processing Failed");
    }
};