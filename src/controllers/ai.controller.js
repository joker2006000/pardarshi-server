const WebSocket = require('ws');
const db = require('../config/db');
const aiService = require('../services/ai.service');

// Gemini Multimodal Live API model
// Gemini 3.8 Live (models/gemini-3.8-live) is the official default low-latency Live API model
const GEMINI_LIVE_MODEL = process.env.GEMINI_LIVE_MODEL || 'models/gemini-3.8-live';
const GEMINI_API_VERSION = process.env.GEMINI_API_VERSION || 'v1beta';

/**
 * Handles the bidirectional WebSocket connection between the frontend/mobile app and Gemini Live API.
 */
exports.handleAiWebSocketConnection = (clientWs, req) => {
    let geminiWs = null;
    let isGeminiReady = false;
    const pendingAudioQueue = [];

    console.log('🎙️ New PARDARSHI AI Voice client connected.');

    const cleanupGemini = () => {
        isGeminiReady = false;
        pendingAudioQueue.length = 0;
        if (geminiWs) {
            try {
                if (geminiWs.readyState === WebSocket.OPEN || geminiWs.readyState === WebSocket.CONNECTING) {
                    geminiWs.close();
                }
            } catch (err) {
                console.warn('Warning during Gemini WS cleanup:', err.message);
            }
            geminiWs = null;
        }
    };

    clientWs.on('message', async (rawMessage) => {
        try {
            let parsedMsg;
            try {
                parsedMsg = JSON.parse(rawMessage.toString());
            } catch (parseError) {
                console.warn('Received non-JSON message from client, ignoring.');
                return;
            }

            // ====================================================================
            // 1. INITIAL HANDSHAKE: RESOLVE SLUGS & CONNECT TO GEMINI LIVE
            // ====================================================================
            if (parsedMsg.type === 'auth_handshake') {
                const data = parsedMsg.data || {};

                // Parse from payload, or fallback to query parameters in req.url
                let urlParams = null;
                try {
                    urlParams = new URL(req.url, 'http://localhost').searchParams;
                } catch (e) {
                    urlParams = new URLSearchParams();
                }

                const orgSlug = data.orgSlug || data.org || data.slug || urlParams.get('org') || urlParams.get('orgSlug');
                const projectSlug = data.projectSlug || data.projSlug || data.proj || data.project || urlParams.get('proj') || urlParams.get('project');

                let orgId = data.orgId || null;
                let projId = data.projId || null;

                console.log(`🔍 AI Handshake request: orgSlug="${orgSlug}", projectSlug="${projectSlug || 'none'}"`);

                // Resolve Slugs to IDs using exact public.controller.js query logic
                if (!orgId && orgSlug) {
                    if (projectSlug) {
                        // Case A: Both Org Slug & Project Slug provided
                        const [projectRows] = await db.query(
                            `SELECT p.project_id, o.organization_id
                             FROM organization_projects p
                             JOIN organizations o ON p.organization_id = o.organization_id
                             WHERE o.slug = ? AND p.slug = ? AND o.status = 'active'`,
                            [orgSlug, projectSlug]
                        );

                        if (projectRows.length === 0) {
                            return clientWs.send(JSON.stringify({ 
                                type: 'error', 
                                message: 'Project or Organization not found.' 
                            }));
                        }

                        orgId = projectRows[0].organization_id;
                        projId = projectRows[0].project_id;
                    } else {
                        // Case B: Only Org Slug provided (Organization-wide)
                        const [orgRows] = await db.query(
                            `SELECT organization_id 
                             FROM organizations 
                             WHERE slug = ? AND status = 'active'`,
                            [orgSlug]
                        );

                        if (orgRows.length === 0) {
                            return clientWs.send(JSON.stringify({ 
                                type: 'error', 
                                message: 'Organization not found.' 
                            }));
                        }

                        orgId = orgRows[0].organization_id;
                    }
                }

                if (!orgId) {
                    return clientWs.send(JSON.stringify({ 
                        type: 'error', 
                        message: 'Organization identifier (slug or orgId) is required.' 
                    }));
                }

                // Generate the structured DB context payload using the resolved IDs
                const aiContextPayload = await aiService.generateAiContextPayload(orgId, projId);
                console.log(`📦 AI Context loaded: ${aiContextPayload.session_metadata.organization_name} (${aiContextPayload.session_metadata.active_view_scope})`);

                const apiKey = process.env.GEMINI_API_KEY;
                if (!apiKey) {
                    console.error('❌ GEMINI_API_KEY is missing in server environment variables.');
                    return clientWs.send(JSON.stringify({ 
                        type: 'error', 
                        message: 'GEMINI_API_KEY is missing in server environment variables.' 
                    }));
                }

                // Close any existing Gemini session for this client
                cleanupGemini();

                const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.${GEMINI_API_VERSION}.GenerativeService.BidiGenerateContent?key=${apiKey}`;
                console.log(`🌐 Connecting to Gemini Live API (${GEMINI_LIVE_MODEL}) at ${GEMINI_API_VERSION}...`);

                geminiWs = new WebSocket(GEMINI_WS_URL);

                geminiWs.on('open', () => {
                    console.log('✅ Gemini Live WebSocket connection opened. Sending BidiGenerateContent setup...');

                    const systemInstructionText = `You are the official PARDARSHI AI Voice Assistant (पारदर्शी AI आवाज सहाय्यक).

MANDATORY LANGUAGE RULE (कडक नियम):
- You MUST generate ALL your responses EXCLUSIVELY in MARATHI (मराठी).
- Every single spoken audio response AND every text transcription MUST BE in natural, respectful, conversational Marathi.
- Even if the user asks in English or Hindi, translate and respond 100% in Marathi.
- Citizens, contributors, and rural villagers (from Marathwada, Vidarbha, Western Maharashtra) will speak with you. Always use polite, clear, and easy-to-understand Marathi (उदा. "नमस्कार! पारदर्शी प्रणालीमध्ये आपले स्वागत आहे...").

PRESENTATION & FORMATTING RULE:
- Whenever the user asks for financial breakdowns, expense lists, donor contributions, balance inquiries, or anomaly details, format your text response using clean Markdown:
  * Markdown Tables (तक्ते) for listing multiple expenses or donations
  * Bold text for amounts and key status labels (उदा. **₹५,०००**, **मंजूर**, **संशयित**)
  * Bullet points for explanations
- In your spoken audio, provide a clear, warm, concise conversational Marathi summary of the key numbers and insights so the user can hear the summary while seeing details on screen.

FINANCIAL DATA CONTEXT:
Use ONLY the live database context JSON provided below for all financial totals, balances, expenses, donor contributions, and anomaly checks. Do NOT invent or hallucinate any financial data:

${JSON.stringify(aiContextPayload)}`;

                    const setupMessage = {
                        setup: {
                            model: GEMINI_LIVE_MODEL,
                            generationConfig: {
                                responseModalities: ["AUDIO"],
                                speechConfig: {
                                    voiceConfig: {
                                        prebuiltVoiceConfig: {
                                            voiceName: "Puck"
                                        }
                                    }
                                }
                            },
                            // Requests real-time text transcription alongside voice audio
                            outputAudioTranscription: {},
                            systemInstruction: {
                                parts: [
                                    {
                                        text: systemInstructionText
                                    }
                                ]
                            }
                        }
                    };

                    geminiWs.send(JSON.stringify(setupMessage));
                });

                geminiWs.on('message', (geminiRawData) => {
                    try {
                        const responseStr = geminiRawData.toString();
                        const geminiObj = JSON.parse(responseStr);

                        // 1. Handle Gemini API error frames
                        if (geminiObj.error) {
                            console.error('❌ Gemini Live API error frame:', geminiObj.error);
                            if (clientWs.readyState === WebSocket.OPEN) {
                                clientWs.send(JSON.stringify({ 
                                    type: 'error', 
                                    message: geminiObj.error.message || 'Gemini Live AI error occurred.' 
                                }));
                            }
                            return;
                        }

                        // 2. Handle initial setup completion acknowledgment
                        if (geminiObj.setupComplete) {
                            isGeminiReady = true;
                            console.log('🎉 Gemini Live setup completed! Session is ready for voice & text.');

                            if (clientWs.readyState === WebSocket.OPEN) {
                                clientWs.send(JSON.stringify({ 
                                    type: 'handshake_success',
                                    context: {
                                        organization: aiContextPayload.session_metadata.organization_name,
                                        scope: aiContextPayload.session_metadata.active_view_scope
                                    }
                                }));
                            }

                            // Flush any audio chunks that were buffered during setup
                            if (pendingAudioQueue.length > 0) {
                                console.log(`🚀 Flushing ${pendingAudioQueue.length} queued audio chunks to Gemini...`);
                                while (pendingAudioQueue.length > 0) {
                                    const chunk = pendingAudioQueue.shift();
                                    if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
                                        geminiWs.send(JSON.stringify({
                                            realtimeInput: {
                                                mediaChunks: [
                                                    {
                                                        mimeType: "audio/pcm;rate=16000",
                                                        data: chunk
                                                    }
                                                ]
                                            }
                                        }));
                                    }
                                }
                            }
                            return;
                        }

                        // 3. Forward Gemini's serverContent (Audio & Text Transcription) directly to frontend
                        if (clientWs.readyState === WebSocket.OPEN) {
                            clientWs.send(responseStr);
                        }
                    } catch (parseErr) {
                        console.error('Error parsing message from Gemini:', parseErr.message);
                    }
                });

                geminiWs.on('close', (code, reason) => {
                    const reasonStr = reason ? reason.toString() : 'Normal closure';
                    console.log(`🔌 Gemini Live WS closed: code=${code}, reason=${reasonStr}`);
                    isGeminiReady = false;
                    if (clientWs.readyState === WebSocket.OPEN) {
                        clientWs.send(JSON.stringify({ 
                            type: 'ai_disconnected',
                            code,
                            reason: reasonStr 
                        }));
                    }
                });

                geminiWs.on('error', (err) => {
                    console.error('❌ Gemini Live WS connection error:', err.message);
                    isGeminiReady = false;
                    if (clientWs.readyState === WebSocket.OPEN) {
                        clientWs.send(JSON.stringify({ 
                            type: 'error', 
                            message: `AI stream error: ${err.message}` 
                        }));
                    }
                });
            }

            // ====================================================================
            // 2. RELAY LIVE MICROPHONE PCM AUDIO (16kHz Base64) TO GEMINI
            // ====================================================================
            else if (parsedMsg.type === 'realtime_audio') {
                if (!parsedMsg.audioBase64) return;

                if (isGeminiReady && geminiWs?.readyState === WebSocket.OPEN) {
                    geminiWs.send(JSON.stringify({
                        realtimeInput: {
                            mediaChunks: [
                                {
                                    mimeType: "audio/pcm;rate=16000",
                                    data: parsedMsg.audioBase64
                                }
                            ]
                        }
                    }));
                } else if (!isGeminiReady && geminiWs && geminiWs.readyState === WebSocket.CONNECTING) {
                    // Buffer chunks while connection is establishing (keep last 50 chunks ~1.5s)
                    if (pendingAudioQueue.length > 50) {
                        pendingAudioQueue.shift();
                    }
                    pendingAudioQueue.push(parsedMsg.audioBase64);
                }
            }

            // ====================================================================
            // 3. RELAY DIRECT TEXT PROMPTS TO GEMINI
            // ====================================================================
            else if (parsedMsg.type === 'client_text') {
                if (isGeminiReady && geminiWs?.readyState === WebSocket.OPEN) {
                    geminiWs.send(JSON.stringify({
                        clientContent: {
                            turns: [
                                {
                                    role: "user",
                                    parts: [{ text: parsedMsg.text || '' }]
                                }
                            ],
                            turnComplete: true
                        }
                    }));
                }
            }

            // ====================================================================
            // 4. RELAY SPEECH-END / TURN-FINISH SIGNALS TO GEMINI
            // ====================================================================
            else if (
                parsedMsg.type === 'audio_stream_end' ||
                parsedMsg.type === 'finish_turn' ||
                parsedMsg.type === 'speech_end'
            ) {
                if (isGeminiReady && geminiWs?.readyState === WebSocket.OPEN) {
                    geminiWs.send(JSON.stringify({
                        realtimeInput: {
                            audioStreamEnd: true
                        }
                    }));
                }
            }

            // ====================================================================
            // 5. RELAY RAW PROTOCOL PASSTHROUGH (realtimeInput / clientContent)
            // ====================================================================
            else if (parsedMsg.realtimeInput && isGeminiReady && geminiWs?.readyState === WebSocket.OPEN) {
                geminiWs.send(JSON.stringify({ realtimeInput: parsedMsg.realtimeInput }));
            } else if (parsedMsg.clientContent && isGeminiReady && geminiWs?.readyState === WebSocket.OPEN) {
                geminiWs.send(JSON.stringify({ clientContent: parsedMsg.clientContent }));
            }

        } catch (err) {
            console.error('AI Controller Message Handler Error:', err);
            if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({ 
                    type: 'error', 
                    message: 'Failed to process request.' 
                }));
            }
        }
    });

    clientWs.on('close', (code, reason) => {
        console.log(`❌ PARDARSHI AI Voice client disconnected (code: ${code}).`);
        cleanupGemini();
    });

    clientWs.on('error', (err) => {
        console.error('Client WS Error:', err.message);
        cleanupGemini();
    });
};
