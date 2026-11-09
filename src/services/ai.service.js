const { GoogleGenAI } = require("@google/genai");
const axios = require('axios'); // 100% Free OpenStreetMap client
const db = require('../config/db');

const ai = new GoogleGenAI({
    httpOptions: { apiVersion: "v1beta" }
});

/**
 * Safely parses MySQL JSON columns (handles both auto-parsed objects and raw strings)
 */
const safeJsonParse = (data) => {
    if (!data) return {};
    if (typeof data === 'object') return data;
    try {
        return JSON.parse(data);
    } catch (e) {
        return {};
    }
};

// ============================================================================
// 1. EXISTING RECEIPT OCR & OSM VERIFICATION FUNCTION
// ============================================================================
exports.analyzeReceipt = async (imageBuffer, mimeType, expectedTitle, expectedDescription) => {
    const prompt = `
    You are a strict financial auditor for PARDARSHI.
    Analyze this receipt. Extract the vendor's name and break down their exact printed address into specific components (street/road, city/town/taluka, district, state, pincode). If a detail is missing, leave it empty.
    Evaluate if the physical items logically align with the project expense title: "${expectedTitle}" and description: "${expectedDescription}".
    CRITICAL REQUIREMENT: You must provide a detailed analysis ('marathi_analysis') EXCLUSIVELY IN MARATHI. This Marathi text should thoroughly explain whether the receipt perfectly matches the expense, OR detail all the reasons and anomalies if the document is suspicious, invalid, or mismatched.
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
            anomaly_reason: { type: "string", description: "Short English reason if any anomaly is found" },
            marathi_analysis: { type: "string", description: "Detailed comprehensive analysis and feedback in Marathi about the document's validity and any anomalies." },
            anomaly_flags: { type: "array", items: { type: "string" }, description: "List of all possible anomaly reasons detected by the AI." }
        },
        required: [
            "vendor_name", "vendor_street", "vendor_city", "vendor_district", "vendor_state", 
            "vendor_pincode", "receipt_date", "total_amount", "tax_amount", "line_items", 
            "context_match", "anomaly_reason", "marathi_analysis", "anomaly_flags"
        ]
    };

    const mediaType = mimeType === 'application/pdf' ? 'document' : 'image';

    try {
        const interaction = await ai.interactions.create({
            model: "gemini-3.5-flash-lite", 
            input: [
                { type: "text", text: prompt },
                { type: mediaType, data: imageBuffer.toString("base64"), mime_type: mimeType }
            ],
            response_format: { type: "text", mime_type: "application/json", schema: receiptJsonSchema }
        });

        const aiResult = JSON.parse(interaction.output_text);

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

// ============================================================================
// 2. NEW LIVE VOICE ASSISTANT CONTEXT PAYLOAD GENERATOR
// ============================================================================
exports.generateAiContextPayload = async (organization_id, project_id = null) => {
    const connection = await db.getConnection();
    try {
        const queryParams = project_id ? [organization_id, project_id] : [organization_id];
        const projectFilter = project_id ? `AND project_id = ?` : ``;
        const expProjectFilter = project_id ? `AND e.project_id = ?` : ``;
        const annProjectFilter = project_id ? `AND a.project_id = ?` : ``;

        const [
            [orgData],
            [allOrgProjects],
            [targetProjData],
            [contributions],
            [expenses],
            [verifiedProofs],
            [verifiedDeliveries],
            [anomalies],
            [announcements],
            [reports]
        ] = await Promise.all([
            // 1. Organization Details & Totals
            connection.query(
                `SELECT name, slug, description, category, type, city, district, state, established_year,
                        total_received, total_expenses, remaining_balance 
                 FROM organizations WHERE organization_id = ?`, 
                [organization_id]
            ),
            // 2. All Projects in this Organization (So AI understands overall org fund distribution)
            connection.query(
                `SELECT project_id, name, slug, total_received, total_expenses, remaining_balance, created_at
                 FROM organization_projects WHERE organization_id = ? ORDER BY created_at DESC`,
                [organization_id]
            ),
            // 3. Current Specific Project Details (if user is inside a specific project)
            project_id ? connection.query(
                `SELECT project_id, name, slug, description, total_received, total_expenses, remaining_balance 
                 FROM organization_projects WHERE project_id = ? AND organization_id = ?`, 
                [project_id, organization_id]
            ) : Promise.resolve([[null]]),
            // 4. Contributions (Excludes sensitive payment_id, access_token, mobile, email)
            connection.query(
                `SELECT contribution_id, project_id, contributor_name, amount, currency, 
                        payment_method, payment_status, notes, created_at 
                 FROM contributions WHERE organization_id = ? ${projectFilter} ORDER BY created_at DESC`, 
                queryParams
            ),
            // 5. Expenses + Uploaded Proof Document Metadata (Excludes payment_id)
            connection.query(
                `SELECT e.expense_id, e.project_id, e.title, e.description, e.amount, e.expense_date, 
                        e.category, e.is_online_payment, e.payment_mode, e.payment_method, 
                        e.payment_status, e.status AS overall_status, e.paid_at, e.created_at,
                        u.name AS created_by_member,
                        (SELECT JSON_ARRAYAGG(JSON_OBJECT('document_id', d.document_id, 'file_name', d.file_name, 'file_url', d.file_url)) 
                         FROM expense_documents d WHERE d.expense_id = e.expense_id) AS uploaded_proofs
                 FROM expenses e
                 LEFT JOIN users u ON e.created_by = u.user_id
                 WHERE e.organization_id = ? ${expProjectFilter} ORDER BY e.expense_date DESC`, 
                queryParams
            ),
            // 6. Verified Proofs Data (Full AI Receipt Analysis JSON)
            connection.query(
                `SELECT verified_proof_id, project_id, expense_id, document_id, information, created_at 
                 FROM verified_proofs_data WHERE organization_id = ? ${projectFilter}`, 
                queryParams
            ),
            // 7. Verified Delivery Data (Full AI Delivery Photo Analysis JSON)
            connection.query(
                `SELECT verified_delivery_id, project_id, expense_id, delivery_id, ai_analysis, created_at 
                 FROM verified_delivery_data WHERE organization_id = ? ${projectFilter}`, 
                queryParams
            ),
            // 8. Anomaly Detections (Full Flags & Marathi Analysis JSON)
            connection.query(
                `SELECT anomaly_id, project_id, expense_id, proof_url, anomaly_text, 
                        proof_details, verification_status, alert_message_status, created_at 
                 FROM anomaly_detections WHERE organization_id = ? ${projectFilter} ORDER BY created_at DESC`, 
                queryParams
            ),
            // 9. Public Announcements
            connection.query(
                `SELECT a.announcement_id, a.project_id, a.expense_id, a.text_information, a.created_at
                 FROM announcements a WHERE a.organization_id = ? AND a.status = 'show' ${annProjectFilter} ORDER BY a.created_at DESC`,
                queryParams
            ),
            // 10. Active Disputes / Reports (Excludes guest_email, access_token)
            connection.query(
                `SELECT report_id, project_id, expense_id AS related_expense_id, contribution_id AS related_contribution_id, 
                        subject, status, priority, resolved_at, created_at 
                 FROM reports WHERE organization_id = ? ${projectFilter} ORDER BY created_at DESC`, 
                queryParams
            )
        ]);

        const org = orgData[0] || {};
        const targetProj = targetProjData[0] || null;

        return {
            session_metadata: {
                platform: "PARDARSHI Financial Transparency System",
                organization_name: org.name || "Unknown Organization",
                organization_location: `${org.city || ''}, ${org.district || ''}, ${org.state || ''}`.replace(/^, |, $/g, ''),
                active_view_scope: targetProj ? `Project Level: ${targetProj.name}` : "Organization-Wide Overview",
                ai_behavior_rules: [
                    "You are the official PARDARSHI AI Voice Assistant.",
                    "If the user speaks in Marathi (including rural/village dialects like Marathwada/Varhadi/Puneri), you MUST reply naturally in clear, polite, conversational Marathi.",
                    "If the user asks for a table, breakdown, or structured list, output clean Markdown tables in your text transcript while summarizing the key numbers in your spoken voice.",
                    "Use ONLY this JSON payload for all mathematical calculations, balances, contributions, expenses, and anomaly checks.",
                    "Explain the difference between 'payment_status' (gateway transfer status: pending/success/failed) and 'overall_status' (audit status: pending/approved/paid/rejected) clearly when asked.",
                    "When asked about suspicious expenses, errors, or flags, cross-reference 'anomaly_detections' and read the 'marathi_analysis' inside 'proof_details' to explain the exact issue."
                ]
            },
            financial_summaries: {
                organization_totals: {
                    total_received: parseFloat(org.total_received || 0),
                    total_expenses: parseFloat(org.total_expenses || 0),
                    remaining_balance: parseFloat(org.remaining_balance || 0)
                },
                current_project_totals: targetProj ? {
                    project_id: targetProj.project_id,
                    project_name: targetProj.name,
                    total_received: parseFloat(targetProj.total_received || 0),
                    total_expenses: parseFloat(targetProj.total_expenses || 0),
                    remaining_balance: parseFloat(targetProj.remaining_balance || 0)
                } : null,
                all_organization_projects: allOrgProjects.map(p => ({
                    project_id: p.project_id,
                    name: p.name,
                    slug: p.slug,
                    total_received: parseFloat(p.total_received || 0),
                    total_expenses: parseFloat(p.total_expenses || 0),
                    remaining_balance: parseFloat(p.remaining_balance || 0)
                }))
            },
            transactions: {
                contributions: contributions.map(c => ({
                    ...c,
                    amount: parseFloat(c.amount || 0)
                })),
                expenses: expenses.map(e => ({
                    ...e,
                    amount: parseFloat(e.amount || 0),
                    uploaded_proofs: safeJsonParse(e.uploaded_proofs)
                }))
            },
            anomaly_and_verification_data: {
                verified_proofs_data: verifiedProofs.map(vp => ({
                    ...vp,
                    information: safeJsonParse(vp.information)
                })),
                verified_delivery_data: verifiedDeliveries.map(vd => ({
                    ...vd,
                    ai_analysis: safeJsonParse(vd.ai_analysis)
                })),
                anomaly_detections: anomalies.map(an => ({
                    ...an,
                    proof_details: safeJsonParse(an.proof_details)
                }))
            },
            public_announcements: announcements,
            active_disputes: reports
        };
    } finally {
        connection.release();
    }
};