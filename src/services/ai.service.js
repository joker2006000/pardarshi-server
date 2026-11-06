const { GoogleGenAI } = require("@google/genai");
const axios = require('axios'); // 100% Free OpenStreetMap client

const ai = new GoogleGenAI({
    httpOptions: { apiVersion: "v1beta" }
});

exports.analyzeReceipt = async (imageBuffer, mimeType, expectedTitle, expectedDescription) => {

    const prompt = `
    You are a strict financial auditor for PARDARSHI.
    Analyze this receipt. Extract the vendor's name and break down their exact printed address into specific components (street/road, city/town/taluka, district, state, pincode). If a detail is missing, leave it empty.
    Evaluate if the physical items logically align with the project expense title: "${expectedTitle}" and description: "${expectedDescription}".
    `;

    const receiptJsonSchema = {
        type: "object",
        properties: {
            vendor_name: { type: "string", description: "Name of the shop or organization" },
            vendor_street: { type: "string", description: "Road, street, or local building name" },
            vendor_city: { type: "string", description: "City, town, or taluka" },
            vendor_district: { type: "string", description: "District" },
            vendor_state: { type: "string", description: "State" },
            vendor_pincode: { type: "string", description: "6-digit postal code" },
            receipt_date: { type: "string" },
            total_amount: { type: "number" },
            tax_amount: { type: "number" },
            line_items: { type: "array", items: { type: "string" } },
            context_match: { type: "boolean" },
            anomaly_reason: { type: "string" }
        },
        required: ["vendor_name", "vendor_street", "vendor_city", "vendor_district", "vendor_state", "vendor_pincode", "receipt_date", "total_amount", "tax_amount", "line_items", "context_match", "anomaly_reason"]
    };

    const mediaType = mimeType === 'application/pdf' ? 'document' : 'image';

    try {
        // 1. Let AI read the receipt and extract structured components (100% Free)
        const interaction = await ai.interactions.create({
            model: "gemini-3.5-flash-lite", 
            input: [
                { type: "text", text: prompt },
                { type: mediaType, data: imageBuffer.toString("base64"), mime_type: mimeType }
            ],
            response_format: { type: "text", mime_type: "application/json", schema: receiptJsonSchema }
        });

        const aiResult = JSON.parse(interaction.output_text);

        // 2. 100% FREE OPENSTREETMAP (NOMINATIM) VERIFICATION
        let maps_vendor_found = false;
        let maps_address_match = false;

        if (aiResult.vendor_name && aiResult.vendor_name.toLowerCase() !== "unknown") {
            const addressParts = [
                aiResult.vendor_name,
                aiResult.vendor_city,
                aiResult.vendor_pincode
            ].filter(part => part && part.trim() !== "");

            const searchString = addressParts.join(" ");
            
            try {
                const osmUrl = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(searchString)}&format=json&addressdetails=1&limit=1`;
                
                const osmResponse = await axios.get(osmUrl, {
                    headers: {
                        'User-Agent': 'Pardarshi-App/1.0 (student-project@pardarshi.local)'
                    }
                });

                const candidates = osmResponse.data;

                if (candidates && candidates.length > 0) {
                    const place = candidates[0];
                    maps_vendor_found = true; 
                    
                    const addressData = place.address || {};
                    const scrapedPincode = addressData.postcode || "";
                    const scrapedCity = (addressData.city || addressData.town || addressData.county || "").toLowerCase();
                    
                    const expectedPincode = aiResult.vendor_pincode || "";
                    const expectedCity = (aiResult.vendor_city || "").toLowerCase();

                    // Smart check focusing on reliable Pincode and City matches
                    if ((expectedPincode && scrapedPincode === expectedPincode) || 
                        (expectedCity && scrapedCity.includes(expectedCity))) {
                        maps_address_match = true;
                    }
                }
            } catch (osmError) {
                console.warn("OpenStreetMap Search warning:", osmError.message);
            }
        }

        return {
            ...aiResult,
            maps_vendor_found,
            maps_address_match
        };

    } catch (error) {
        console.error("Gemini API Error:", error);
        throw new Error("AI Processing Failed");
    }
};