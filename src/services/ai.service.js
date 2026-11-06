const { GoogleGenAI } = require("@google/genai");
const google = require('googlethis'); 

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
        // 1. Let AI extract the highly detailed address (Free)
        const interaction = await ai.interactions.create({
            model: "gemini-3.5-flash-lite", 
            input: [
                { type: "text", text: prompt },
                { type: mediaType, data: imageBuffer.toString("base64"), mime_type: mimeType }
            ],
            response_format: { type: "text", mime_type: "application/json", schema: receiptJsonSchema }
        });

        const aiResult = JSON.parse(interaction.output_text);

        // 2. SMARTER MANUAL SEARCH LOGIC
        let maps_vendor_found = false;
        let maps_address_match = false;

        if (aiResult.vendor_name && aiResult.vendor_name.toLowerCase() !== "unknown") {
            // Build a highly targeted query using only the pieces the AI found
            const addressParts = [
                aiResult.vendor_name,
                aiResult.vendor_street,
                aiResult.vendor_city,
                aiResult.vendor_district,
                aiResult.vendor_state,
                aiResult.vendor_pincode
            ].filter(part => part && part.trim() !== ""); // Remove empty parts

            const searchQuery = addressParts.join(" ");
            
            // Scrape Google
            const searchResults = await google.search(searchQuery, {
                page: 0, 
                safe: false, 
                parse_ads: false, 
                additional_params: { hl: 'en' }
            });

            // CHECK 1: Does Google trigger a Knowledge Panel (Maps Sidebar)?
            if (searchResults.knowledge_panel && searchResults.knowledge_panel.title) {
                maps_vendor_found = true;
                
                // CHECK 2: Validate the address using the detailed components
                const scrapedAddress = (searchResults.knowledge_panel.description || searchResults.knowledge_panel.type || "").toLowerCase();
                
                // If the scraped Maps data contains the City, District, or Pincode, we consider it a verified match
                const cityMatch = aiResult.vendor_city && scrapedAddress.includes(aiResult.vendor_city.toLowerCase());
                const districtMatch = aiResult.vendor_district && scrapedAddress.includes(aiResult.vendor_district.toLowerCase());
                const pincodeMatch = aiResult.vendor_pincode && scrapedAddress.includes(aiResult.vendor_pincode);

                if (cityMatch || districtMatch || pincodeMatch) {
                    maps_address_match = true;
                }
            } 
            // Fallback: If no panel, check if any of the top search results are actual Google Maps links for this business
            else {
                const hasMapsLink = searchResults.results.some(result => 
                    (result.url.includes("google.com/maps") || result.url.includes("maps.app.goo.gl")) && 
                    result.title.toLowerCase().includes(aiResult.vendor_name.toLowerCase())
                );

                if (hasMapsLink) {
                    maps_vendor_found = true;
                    maps_address_match = true;
                }
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