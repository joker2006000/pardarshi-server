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
    let pendingAudioStreamEnd = false;
    const pendingAudioQueue = [];

    console.log('🎙️ New PARDARSHI AI Voice client connected.');

    const cleanupGemini = () => {
        isGeminiReady = false;
        pendingAudioStreamEnd = false;
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
                const orgName = aiContextPayload.session_metadata.organization_info.name;
                const scopeName = aiContextPayload.session_metadata.active_view_scope.scope_name;
                const fullDateMarathi = aiContextPayload.session_metadata.temporal_context.current_full_date_marathi;
                const dateIso = aiContextPayload.session_metadata.temporal_context.current_date_ist;
                const timeIst = aiContextPayload.session_metadata.temporal_context.current_time_ist;

                console.log(`📦 AI Context loaded: ${orgName} (${scopeName})`);

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

                    const systemInstructionText = `तुम्ही 'पारदर्शी' (PARDARSHI) चे अधिकृत, बोलके, मैत्रीपूर्ण आणि हुशार AI आवाज व डेटा सहाय्यक आहात (PARDARSHI Friendly Live AI Assistant).

खाली दिलेल्या डेटाबेस संदर्भामध्ये (Database Context JSON) चालू तारीख व वेळ (IST: ${fullDateMarathi}, वेळ: ${timeIst}), संस्थेचे सर्व तपशील, सर्व प्रकल्प, जमा झालेल्या देणग्या, झालेले सर्व खर्च (तारखा व कॅटेगरीसह), पावत्यांची AI पडताळणी, आणि संशयित व्यवहारांची (Anomalies) सविस्तर माहिती दिली आहे.

महत्त्वाचे नियम व व्यक्तिमत्त्व (CORE PERSONALITY & BEHAVIOR):

१. भाषा व बोलका मैत्रीपूर्ण स्वभाव (Language & Conversational Freedom):
- तुमचे सर्व संभाषण (आवाज आणि स्क्रीनवरील टेक्स्ट) संपूर्णपणे आणि केवळ शुद्ध, आदरातिथ्यपूर्ण **मराठी (मराठी)** मध्येच असावे.
- **कधीही रोबोटसारखे किंवा एकाच साचेबद्ध वाक्यात उत्तर देऊ नका!** तुम्ही एक हुशार, जिवंत माणसाप्रमाणे बोलणारे मदतगार मित्र आहात.
- जर वापरकर्त्याने "नमस्कार", "शुभ सकाळ", "कसे आहात?", "काय चाललंय?" असे अभिवादन केले, तर त्यांना खूप प्रेमाने आणि आपलेपणाने मराठीत उत्तर द्या (उदा. "नमस्कार! मी खूप छान आहे, तुम्ही कसे आहात? पारदर्शीमध्ये आपले मनापासून स्वागत! आज मी तुम्हाला काय मदत करू?"). अशा वेळी न विचारता लगेच खर्चाचा तक्ता फेकू नका! आधी त्यांना काय हवे आहे ते विचारा.
- जर वापरकर्त्याने विनोद किंवा गंमत विचारली ("काहीतरी जोक सांगा", "हसवा"), तर त्यांना एक छान, स्वच्छ, कौटुंबिक मराठी विनोद किंवा हसवणारी गोष्ट सांगा.
- जर वापरकर्त्याने चालू वेळ किंवा तारीख विचारली, तर अचूक तारीख आणि वेळ सांगा (उदा. "आज ${fullDateMarathi} आहे आणि वेळ साधारण ${timeIst} झाली आहे.").
- जर वापरकर्त्याने 'पारदर्शी' बद्दल विचारले ("पारदर्शी काय आहे?", "हे कसे काम करते?"), तर त्यांना सांगा: "पारदर्शी ही संस्था आणि सामाजिक प्रकल्पांमधील प्रत्येक रुपयाचा हिशोब जनतेसमोर १००% उघड ठेवणारी डिजिटल प्रणाली आहे. इथे प्रत्येक खर्चाची पावती AI द्वारे स्कॅन केली जाते, दुकानदाराचे अस्तित्व नकाशावर तपासले जाते, आणि डिलिव्हरीचे फोटो तपासूनच खर्च मंजूर केला जातो, ज्यामुळे गैरव्यवहाराला जागा राहत नाही."
- जर वापरकर्ता गोंधळलेला असेल ("मला समजत नाही", "काय विचारू?"), तर त्याला प्रेमाने मदत करा आणि उदाहरणे द्या (उदा. "काही काळजी करू नका! तुम्ही मला एकूण शिल्लक निधी, आज किंवा या महिन्यात झालेले खर्च, सर्वात मोठे देणगीदार, किंवा संशयित पावत्या यांबद्दल विचारू शकता. सांगा, यातील काय जाणून घ्यायला आवडेल?").

२. डेटाचे विश्लेषण व अचूक उत्तरे (Data Analysis & Dynamic Targeting):
- वापरकर्त्याचा प्रश्न नीट समजून घ्या आणि डेटाबेसमधून फक्त त्यासंबंधी अचूक डेटा शोधा.
- **तारीख विश्लेषण (Date Analysis)**:
  * वापरकर्त्याने "आजचे खर्च" विचारल्यास: 'expense_date' == '${dateIso}' असलेले खर्च शोधा. जर आज कोणताही खर्च झालेला नसेल, तर सांगा: "आजच्या तारखेत कोणताही खर्च झालेला नाही, पण नुकताच झालेला खर्च खालीलप्रमाणे आहे..."
  * वापरकर्त्याने "या महिन्याचे" विचारल्यास चालू महिन्यातील खर्च एकत्र करून सांगा.
- **कॅटेगरी व प्रकार विश्लेषण (Category & Type Analysis)**:
  * वापरकर्त्याने विशिष्ट बाब विचारल्यास (उदा. 'साहित्याचा खर्च किती झाला?', 'बांधकामावर किती खर्च झाला?'), फक्त त्या कॅटेगरीचा खर्च शोधा आणि अचूक सांगा.
- **देणगीदार व जमा रक्कम**:
  * देणग्यांबद्दल विचारल्यास देणगीदारांची नावे, तारखा आणि रकमा स्पष्ट सांगा.
- **आकडेवारीची १००% सत्यता**: सर्व आकडे केवळ दिलेल्या JSON डेटाबेसमधूनच घ्या. कोणताही आकडा स्वतःच्या मनाने तयार करू नका.

३. टेक्स्ट फॉरमॅटिंग व आवाज सादरीकरण (Markdown Tables & Voice Summary):
- **स्क्रीनवरील टेक्स्ट (Markdown Output)**: जेव्हा वापरकर्ता खर्चाची यादी, देणग्यांचा हिशोब किंवा संशयित पावत्यांची माहिती मागेल, तेव्हा स्क्रीनवर सुंदर **Markdown Tables** (| तारीख | तपशील | रक्कम | स्थिती |), ठळक अक्षरे (उदा. **₹५,०००**), आणि बुलेट पॉईंट्स वापरा.
- **बोलका आवाज (Spoken Audio)**: बोलताना मात्र तक्त्यातील सर्व आकडे एका सुरात वाचून वापरकर्त्याला कंटाळवाणे करू नका; त्याऐवजी मुख्य निष्कर्ष, एकूण रक्कम आणि महत्त्वाचे मुद्दे नैसर्गिक, गोड मराठी आवाजात संभाषणाच्या रूपात सांगा.

डेटाबेस संदर्भ JSON (Live Database Context):
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
                                        organization: orgName,
                                        scope: scopeName
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

                            // Flush pending turn-completion signal if user finished speaking during handshake
                            if (pendingAudioStreamEnd) {
                                console.log('🚀 Flushing buffered audio_stream_end to Gemini...');
                                pendingAudioStreamEnd = false;
                                if (geminiWs && geminiWs.readyState === WebSocket.OPEN) {
                                    geminiWs.send(JSON.stringify({
                                        realtimeInput: {
                                            audioStreamEnd: true
                                        }
                                    }));
                                }
                            }
                            return;
                        }

                        // 3. Forward Gemini's serverContent (Audio & Text Transcription) directly to frontend
                        // Zero delay, zero collisions: streamed straight to clientWs
                        if (clientWs.readyState === WebSocket.OPEN) {
                            if (geminiObj.serverContent) {
                                const sc = geminiObj.serverContent;

                                // Normalize real-time transcription so frontend is guaranteed to find it
                                const trans = sc.outputTranscription || sc.outputAudioTranscription || sc.output_audio_transcription || sc.output_transcription;
                                if (trans) {
                                    const transObj = (typeof trans === 'string') ? { text: trans } : trans;
                                    sc.outputTranscription = transObj;
                                    sc.outputAudioTranscription = transObj;
                                }

                                // Normalize audio inline data across parts
                                if (Array.isArray(sc.modelTurn?.parts)) {
                                    for (const part of sc.modelTurn.parts) {
                                        const audio = part.inlineData || part.inline_data;
                                        if (audio) {
                                            part.inlineData = audio;
                                            part.inline_data = audio;
                                        }
                                    }
                                }

                                clientWs.send(JSON.stringify(geminiObj));
                            } else {
                                clientWs.send(responseStr);
                            }
                        }
                    } catch (parseErr) {
                        console.error('Error parsing message from Gemini:', parseErr.message);
                    }
                });

                geminiWs.on('close', (code, reason) => {
                    const reasonStr = reason ? reason.toString() : 'Normal closure';
                    console.log(`🔌 Gemini Live WS closed: code=${code}, reason=${reasonStr}`);
                    isGeminiReady = false;
                    pendingAudioStreamEnd = false;
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
                    pendingAudioStreamEnd = false;
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
                pendingAudioStreamEnd = false; // New incoming speech cancels any previous turn completion

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
                    // Buffer chunks while connection is establishing (keep last 60 chunks ~1.5s)
                    if (pendingAudioQueue.length > 60) {
                        pendingAudioQueue.shift();
                    }
                    pendingAudioQueue.push(parsedMsg.audioBase64);
                }
            }

            // ====================================================================
            // 3. RELAY DIRECT TEXT PROMPTS TO GEMINI
            // ====================================================================
            else if (
                parsedMsg.type === 'client_text' ||
                parsedMsg.type === 'text_query' ||
                parsedMsg.type === 'user_text' ||
                parsedMsg.type === 'text'
            ) {
                const promptText = parsedMsg.text || parsedMsg.query || parsedMsg.message || '';
                if (promptText && isGeminiReady && geminiWs?.readyState === WebSocket.OPEN) {
                    geminiWs.send(JSON.stringify({
                        clientContent: {
                            turns: [
                                {
                                    role: "user",
                                    parts: [{ text: promptText }]
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
                } else {
                    // If Gemini connection is still establishing, queue turn completion
                    pendingAudioStreamEnd = true;
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
