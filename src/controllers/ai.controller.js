const WebSocket = require('ws');
const db = require('../config/db');
const aiService = require('../services/ai.service');

/**
 * Handles the bidirectional WebSocket connection between the mobile app and Gemini Live API.
 */
exports.handleAiWebSocketConnection = (clientWs, req) => {
    let geminiWs = null;
    let isGeminiReady = false;

    console.log('🎙️ New PARDARSHI AI Voice client connected.');

    clientWs.on('message', async (rawMessage) => {
        try {
            const parsedMsg = JSON.parse(rawMessage.toString());

            // ====================================================================
            // 1. INITIAL HANDSHAKE: RESOLVE SLUGS (MATCHING PUBLIC.CONTROLLER.JS)
            // ====================================================================
            if (parsedMsg.type === 'auth_handshake') {
                const data = parsedMsg.data || {};
                
                // Supports orgSlug, org, projectSlug, projSlug, or proj from frontend
                const orgSlug = data.orgSlug || data.org;
                const projectSlug = data.projectSlug || data.projSlug || data.proj;

                let orgId = data.orgId || null;
                let projId = data.projId || null;

                // Resolve Slugs to IDs using exact public.controller.js query logic
                if (!orgId && orgSlug) {
                    if (projectSlug) {
                        // Case A: Both Org Slug & Project Slug provided (Single JOIN query)
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
                        // Case B: Only Org Slug provided (Organization-wide page)
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
                        message: 'Organization slug is required.' 
                    }));
                }

                // Generate the structured DB context payload using the resolved IDs
                const aiContextPayload = await aiService.generateAiContextPayload(orgId, projId);

                const apiKey = process.env.GEMINI_API_KEY;
                if (!apiKey) {
                    return clientWs.send(JSON.stringify({ 
                        type: 'error', 
                        message: 'GEMINI_API_KEY is missing in server environment variables.' 
                    }));
                }

                const GEMINI_WS_URL = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent?key=${apiKey}`;
                geminiWs = new WebSocket(GEMINI_WS_URL);

                geminiWs.on('open', () => {
                    const setupMessage = {
                        setup: {
                            model: "models/gemini-2.0-flash-exp",
                            generationConfig: {
                                responseModalities: ["AUDIO"]
                            },
                            // Forces Gemini to always stream text/markdown alongside audio
                            outputAudioTranscription: {},
                            systemInstruction: {
                                parts: [
                                    {
                                        text: `You are the official PARDARSHI AI Voice Assistant. 
CRITICAL FORMATTING RULE: Whenever the user asks for financial breakdowns, expense lists, donor contributions, or anomaly details, format your response using clean Markdown (use Markdown Tables, bold text, and bullet points) so the user can read it clearly on their screen while listening to you.
Below is the complete, live database context for this session in JSON format:\n\n${JSON.stringify(aiContextPayload)}`
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

                        if (geminiObj.setupComplete) {
                            isGeminiReady = true;
                            if (clientWs.readyState === WebSocket.OPEN) {
                                clientWs.send(JSON.stringify({ 
                                    type: 'handshake_success',
                                    context: {
                                        organization: aiContextPayload.session_metadata.organization_name,
                                        scope: aiContextPayload.session_metadata.active_view_scope
                                    }
                                }));
                            }
                            return;
                        }

                        // Forward Gemini's serverContent (Audio & Text/Markdown) to the mobile client
                        if (clientWs.readyState === WebSocket.OPEN) {
                            clientWs.send(responseStr);
                        }
                    } catch (parseErr) {
                        console.error('Error parsing message from Gemini:', parseErr);
                    }
                });

                geminiWs.on('close', (code, reason) => {
                    console.log(`Gemini Live WS closed: ${code} - ${reason}`);
                    isGeminiReady = false;
                    if (clientWs.readyState === WebSocket.OPEN) {
                        clientWs.send(JSON.stringify({ type: 'ai_disconnected' }));
                    }
                });

                geminiWs.on('error', (err) => {
                    console.error('Gemini Live WS Error:', err.message);
                    if (clientWs.readyState === WebSocket.OPEN) {
                        clientWs.send(JSON.stringify({ type: 'error', message: 'AI stream error occurred.' }));
                    }
                });
            }

            // ====================================================================
            // 2. RELAY LIVE MICROPHONE PCM AUDIO (16kHz Base64) TO GEMINI
            // ====================================================================
            else if (parsedMsg.type === 'realtime_audio' && isGeminiReady && geminiWs?.readyState === WebSocket.OPEN) {
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
            }

            // ====================================================================
            // 3. RELAY DIRECT TEXT PROMPTS OR BARGE-IN INTERRUPTIONS TO GEMINI
            // ====================================================================
            else if (parsedMsg.type === 'client_text' && isGeminiReady && geminiWs?.readyState === WebSocket.OPEN) {
                geminiWs.send(JSON.stringify({
                    clientContent: {
                        turns: [
                            {
                                role: "user",
                                parts: [{ text: parsedMsg.text }]
                            }
                        ],
                        turnComplete: true
                    }
                }));
            }

        } catch (err) {
            console.error('AI Controller Message Handler Error:', err);
            if (clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({ type: 'error', message: 'Failed to process request.' }));
            }
        }
    });

    clientWs.on('close', () => {
        console.log('❌ PARDARSHI AI Voice client disconnected.');
        if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
            geminiWs.close();
        }
    });

    clientWs.on('error', (err) => {
        console.error('Client WS Error:', err.message);
        if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
            geminiWs.close();
        }
    });
};