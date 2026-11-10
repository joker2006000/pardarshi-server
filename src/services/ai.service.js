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
// 2. LIVE VOICE & DATA ASSISTANT CONTEXT PAYLOAD GENERATOR
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
            // 1. Organization Details & Financial Totals
            connection.query(
                `SELECT organization_id, name, slug, description, category, type, city, district, state, established_year,
                        total_received, total_expenses, remaining_balance 
                 FROM organizations WHERE organization_id = ?`, 
                [organization_id]
            ),
            // 2. All Projects in this Organization (Full portfolio context)
            connection.query(
                `SELECT project_id, name, slug, description, total_received, total_expenses, remaining_balance, created_at
                 FROM organization_projects WHERE organization_id = ? ORDER BY created_at DESC`,
                [organization_id]
            ),
            // 3. Current Specific Project Details (if viewing a single project)
            project_id ? connection.query(
                `SELECT project_id, name, slug, description, total_received, total_expenses, remaining_balance, created_at 
                 FROM organization_projects WHERE project_id = ? AND organization_id = ?`, 
                [project_id, organization_id]
            ) : Promise.resolve([[null]]),
            // 4. Contributions / Public Donations
            connection.query(
                `SELECT contribution_id, project_id, contributor_name, amount, currency, 
                        payment_method, payment_status, notes, created_at 
                 FROM contributions WHERE organization_id = ? ${projectFilter} ORDER BY created_at DESC`, 
                queryParams
            ),
            // 5. Itemized Expenses + Uploaded Bill Metadata
            connection.query(
                `SELECT e.expense_id, e.project_id, e.title, e.description, e.amount, e.expense_date, 
                        e.category, e.is_online_payment, e.payment_mode, e.payment_method, 
                        e.payment_status, e.status AS overall_status, e.paid_at, e.created_at,
                        u.name AS created_by_member,
                        (SELECT JSON_ARRAYAGG(JSON_OBJECT('document_id', d.document_id, 'file_name', d.file_name, 'file_url', d.file_url)) 
                         FROM expense_documents d WHERE d.expense_id = e.expense_id) AS uploaded_proofs
                 FROM expenses e
                 LEFT JOIN users u ON e.created_by = u.user_id
                 WHERE e.organization_id = ? ${expProjectFilter} ORDER BY e.expense_date DESC, e.created_at DESC`, 
                queryParams
            ),
            // 6. Verified Proofs Data (Full AI Receipt OCR Analysis JSON)
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
            // 8. Anomaly Detections (Flags & Marathi Audit Explanations)
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
            // 10. Active Citizen Disputes / Reports
            connection.query(
                `SELECT report_id, project_id, expense_id AS related_expense_id, contribution_id AS related_contribution_id, 
                        subject, status, priority, resolved_at, created_at 
                 FROM reports WHERE organization_id = ? ${projectFilter} ORDER BY created_at DESC`, 
                queryParams
            )
        ]);

        const org = orgData[0] || {};
        const targetProj = targetProjData[0] || null;

        // Current Indian Standard Time (IST) Context
        const now = new Date();
        const istOffsetMs = 5.5 * 60 * 60 * 1000;
        const istDate = new Date(now.getTime() + istOffsetMs);
        const daysMarathi = ["रविवार", "सोमवार", "मंगळवार", "बुधवार", "गुरुवार", "शुक्रवार", "शनिवार"];
        const monthsMarathi = ["जानेवारी", "फेब्रुवारी", "मार्च", "एप्रिल", "मे", "जून", "जुलै", "ऑगस्ट", "सप्टेंबर", "ऑक्टोबर", "नोव्हेंबर", "डिसेंबर"];
        const dayMarathi = daysMarathi[istDate.getUTCDay()];
        const monthMarathi = monthsMarathi[istDate.getUTCMonth()];
        const dayNumber = istDate.getUTCDate();
        const yearNumber = istDate.getUTCFullYear();
        const istDateFormatted = `${dayNumber} ${monthMarathi} ${yearNumber}`;
        const istDateIso = istDate.toISOString().slice(0, 10);
        const istTimeStr = istDate.toISOString().slice(11, 16);

        // Precompute Aggregations & Categorizations for Instant AI Lookup
        const expensesByCategory = {};
        const expensesByMonth = {};
        let totalExpensesAmount = 0;

        const mappedExpenses = expenses.map(e => {
            const amt = parseFloat(e.amount || 0);
            totalExpensesAmount += amt;

            const categoryName = e.category || 'इतर (Other)';
            expensesByCategory[categoryName] = (expensesByCategory[categoryName] || 0) + amt;

            let expDateStr = null;
            if (e.expense_date) {
                try {
                    expDateStr = new Date(e.expense_date).toISOString().slice(0, 10);
                    const monthKey = expDateStr.slice(0, 7);
                    expensesByMonth[monthKey] = (expensesByMonth[monthKey] || 0) + amt;
                } catch (_) {}
            }

            return {
                expense_id: e.expense_id,
                project_id: e.project_id,
                title: e.title,
                description: e.description || '',
                amount: amt,
                formatted_amount: `₹${amt.toLocaleString('en-IN')}`,
                expense_date: expDateStr || e.expense_date,
                created_at: e.created_at ? new Date(e.created_at).toISOString() : null,
                paid_at: e.paid_at ? new Date(e.paid_at).toISOString() : null,
                category: categoryName,
                payment_mode: e.payment_mode || (e.is_online_payment ? 'Online' : 'Cash'),
                payment_status: e.payment_status || 'success',
                overall_status: e.overall_status || 'approved',
                created_by_member: e.created_by_member || 'Unknown',
                uploaded_proofs: safeJsonParse(e.uploaded_proofs)
            };
        });

        const contributionsByMethod = {};
        let totalContributionsAmount = 0;

        const mappedContributions = contributions.map(c => {
            const amt = parseFloat(c.amount || 0);
            totalContributionsAmount += amt;

            const method = c.payment_method || 'Online';
            contributionsByMethod[method] = (contributionsByMethod[method] || 0) + amt;

            let createdDateStr = null;
            if (c.created_at) {
                try {
                    createdDateStr = new Date(c.created_at).toISOString().slice(0, 10);
                } catch (_) {}
            }

            return {
                contribution_id: c.contribution_id,
                project_id: c.project_id,
                contributor_name: c.contributor_name || 'अनामिक देणगीदार (Anonymous)',
                amount: amt,
                formatted_amount: `₹${amt.toLocaleString('en-IN')}`,
                currency: c.currency || 'INR',
                payment_method: method,
                payment_status: c.payment_status || 'success',
                notes: c.notes || '',
                donation_date: createdDateStr,
                created_at: c.created_at ? new Date(c.created_at).toISOString() : null
            };
        });

        return {
            session_metadata: {
                platform_info: {
                    name: "PARDARSHI (पारदर्शी)",
                    description: "सार्वजनिक आर्थिक पारदर्शकता, सामाजिक निधी आणि खर्चाचा १००% हिशोब नागरिकांपर्यंत पोहोचवणारी डिजिटल प्रणाली.",
                    core_purpose: "भ्रष्टाचार रोखणे आणि जनतेच्या पैशांचा प्रत्येक रुपया कोठे खर्च झाला याचा पुरावा (पावत्या, दुकानदाराची तपासणी, डिलिव्हरीचे फोटो) उघड करणे."
                },
                temporal_context: {
                    current_date_ist: istDateIso,
                    current_time_ist: istTimeStr,
                    current_day_marathi: dayMarathi,
                    current_full_date_marathi: `${dayMarathi}, ${istDateFormatted}`,
                    note: "वापरकर्त्याने 'आजचे', 'कालचे', 'या आठवड्याचे' किंवा 'या महिन्याचे' खर्च/व्यवहार विचारल्यास या चालू तारखेशी तुलना करून अचूक माहिती द्या."
                },
                organization_info: {
                    organization_id: org.organization_id || organization_id,
                    name: org.name || "Unknown Organization",
                    slug: org.slug || "",
                    description: org.description || "",
                    category: org.category || "",
                    type: org.type || "",
                    location: `${org.city || ''}, ${org.district || ''}, ${org.state || ''}`.replace(/^, |, $/g, ''),
                    established_year: org.established_year || null
                },
                active_view_scope: {
                    scope_type: targetProj ? "PROJECT_SPECIFIC" : "ORGANIZATION_WIDE",
                    scope_name: targetProj ? `प्रकल्प: ${targetProj.name}` : "संपूर्ण संस्था (सर्व प्रकल्प एकत्र)",
                    project_id: targetProj ? targetProj.project_id : null,
                    project_name: targetProj ? targetProj.name : null
                },
                ai_behavior_rules: [
                    "You are the official PARDARSHI AI Voice Assistant (पारदर्शी AI आवाज व डेटा सहाय्यक).",
                    "LANGUAGE: ALL your spoken voice responses and text outputs MUST BE EXCLUSIVELY IN MARATHI (मराठी). Whether the user speaks in English, Hindi, or Marathi, you must reply 100% in natural, respectful, conversational Marathi.",
                    "FRIENDLY CONVERSATION (NOT ROBOTIC): Do NOT give rigid, repetitive, or canned responses! Be warm, polite, and conversational. When someone says 'नमस्कार' or 'कसे आहात?', greet them back warmly and ask how you can help. If they ask for a joke, tell a light clean Marathi joke. If they ask the time or date, answer using the temporal_context.",
                    "TARGETED ANSWERS: Answer ONLY what the user asks. If the user asks about today's expenses, look up expenses where expense_date == current_date_ist. If they ask about a category (उदा. 'साहित्याचा खर्च किती?'), answer specifically for that category.",
                    "ASSISTING CONFUSED USERS: If the user says 'मला समजत नाही' or is unsure what to ask, gently suggest options (उदा. 'तुम्ही मला एकूण शिल्लक निधी, नुकतेच झालेले खर्च, किंवा संशयित पावत्या यांबद्दल विचारू शकता. सांगा, काय माहिती हवी आहे?').",
                    "TEXT MARKDOWN & SPOKEN SUMMARY: When presenting lists, itemized expenses, or donor contributions, output clean Markdown tables, bold numbers (उदा. **₹५,०००**), and bullet points in text so the user can easily read on screen. In your spoken voice, provide a clear, concise conversational Marathi summary of the key numbers and insights.",
                    "ACCURACY: Use ONLY this JSON payload for numbers, balances, expenses, and donations. Never fabricate or hallucinate financial figures."
                ]
            },
            financial_summaries: {
                description: "संस्थेचा आणि चालू प्रकल्पाचा एकंदर जमा, खर्च आणि शिल्लक निधीचा अधिकृत हिशोब.",
                organization_totals: {
                    total_received: parseFloat(org.total_received || 0),
                    total_expenses: parseFloat(org.total_expenses || 0),
                    remaining_balance: parseFloat(org.remaining_balance || 0),
                    formatted: {
                        total_received: `₹${parseFloat(org.total_received || 0).toLocaleString('en-IN')}`,
                        total_expenses: `₹${parseFloat(org.total_expenses || 0).toLocaleString('en-IN')}`,
                        remaining_balance: `₹${parseFloat(org.remaining_balance || 0).toLocaleString('en-IN')}`
                    }
                },
                current_project_totals: targetProj ? {
                    project_id: targetProj.project_id,
                    project_name: targetProj.name,
                    total_received: parseFloat(targetProj.total_received || 0),
                    total_expenses: parseFloat(targetProj.total_expenses || 0),
                    remaining_balance: parseFloat(targetProj.remaining_balance || 0),
                    formatted: {
                        total_received: `₹${parseFloat(targetProj.total_received || 0).toLocaleString('en-IN')}`,
                        total_expenses: `₹${parseFloat(targetProj.total_expenses || 0).toLocaleString('en-IN')}`,
                        remaining_balance: `₹${parseFloat(targetProj.remaining_balance || 0).toLocaleString('en-IN')}`
                    }
                } : null,
                all_organization_projects: allOrgProjects.map(p => ({
                    project_id: p.project_id,
                    name: p.name,
                    slug: p.slug,
                    description: p.description || '',
                    total_received: parseFloat(p.total_received || 0),
                    total_expenses: parseFloat(p.total_expenses || 0),
                    remaining_balance: parseFloat(p.remaining_balance || 0)
                })),
                computed_aggregations: {
                    total_expenses_count: mappedExpenses.length,
                    total_contributions_count: mappedContributions.length,
                    expenses_by_category: expensesByCategory,
                    expenses_by_month: expensesByMonth,
                    contributions_by_method: contributionsByMethod
                }
            },
            transactions: {
                expenses_metadata: {
                    description: "खर्चांची यादी. 'expense_date' म्हणजे प्रत्यक्ष खरेदीची तारीख, 'created_at' म्हणजे सिस्टीममधील नोंद तारीख.",
                    field_guide: {
                        expense_date: "खरेदीची प्रत्यक्ष तारीख (YYYY-MM-DD)",
                        amount: "खर्च झालेली रक्कम (₹)",
                        category: "खर्चाचा प्रकार / कॅटेगरी",
                        payment_status: "पेमेंट गेटवे / बँक ट्रान्सफर स्थिती (उदा. success, pending, failed)",
                        overall_status: "अंतर्गत ऑडिट मंजुरी स्थिती (approved, pending, paid, rejected)",
                        payment_mode: "खर्चाचे माध्यम (Online, Cash, Bank Transfer)"
                    }
                },
                expenses: mappedExpenses,
                contributions_metadata: {
                    description: "देणगीदारांकडून जमा झालेली रक्कम व देणग्यांची यादी."
                },
                contributions: mappedContributions
            },
            anomaly_and_verification_data: {
                description: "AI पावती तपासणी (OCR), डिलिव्हरी फोटो पडताळणी, आणि संशयित व्यवहारांची (Anomalies) यादी.",
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