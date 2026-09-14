const db = require('../config/db');
const slugify = require('slugify');
const QRCode = require('qrcode');
const whatsappService = require('../services/whatsapp.service');//whatsapp
// Import AWS S3 SDK for the QR Code Upload

const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

// Configure S3 for the QR Code upload
const s3 = new S3Client({
    region: process.env.AWS_REGION,
    credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    }
});

// 1. Create or Update Form & Fields (Draft/Builder Mode)
exports.saveFormDraft = async (req, res) => {
    const connection = await db.getConnection();
    try {
        const {
            organization_id, form_id, title, description,
            is_active, thank_you_message, whatsapp_template
        } = req.body;

        // Parse fields (arrives as string from FormData)
        let fields = [];
        try {
            fields = typeof req.body.fields === 'string' ? JSON.parse(req.body.fields) : req.body.fields;
        } catch (e) { console.error("Field parse error", e); }

        // Capture S3 Upload URL from middleware if a file was uploaded
        let picture_url = req.body.existing_picture_url || null; 
        if (req.file && req.file.location) {
            picture_url = req.file.location; 
        }

        const created_by = req.user ? (req.user.userId || req.user.id) : req.body.created_by;

        await connection.beginTransaction();

        let currentFormId = form_id;

        if (currentFormId && currentFormId !== 'null' && currentFormId !== '') {
            await connection.query(`
                UPDATE forms SET
                    title = ?, description = ?, picture_url = COALESCE(?, picture_url), is_active = ?,
                    thank_you_message = ?, whatsapp_template = ?
                WHERE form_id = ? AND organization_id = ?
            `, [title, description, picture_url, is_active ?? true, thank_you_message, whatsapp_template, currentFormId, organization_id]);

            await connection.query(`DELETE FROM form_fields WHERE form_id = ?`, [currentFormId]);
        } else {
            const [formResult] = await connection.query(`
                INSERT INTO forms (organization_id, title, description, picture_url, is_active, thank_you_message, whatsapp_template, created_by)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `, [organization_id, title, description, picture_url, is_active ?? true, thank_you_message, whatsapp_template, created_by]);
            currentFormId = formResult.insertId;
        }

        if (fields && Array.isArray(fields) && fields.length > 0) {
            const fieldValues = fields.map((f, index) => [
                currentFormId,
                f.label,
                f.field_type,
                JSON.stringify(f.options || []), // Store options safely
                Boolean(f.is_required),
                f.placeholder || '',
                f.sort_order !== undefined ? f.sort_order : index
            ]);

            await connection.query(`
                INSERT INTO form_fields (form_id, label, field_type, options, is_required, placeholder, sort_order)
                VALUES ?
            `, [fieldValues]);
        }

        await connection.commit();
        res.status(200).json({ success: true, form_id: currentFormId, picture_url, message: "Form draft saved." });

    } catch (error) {
        if (connection) await connection.rollback();
        console.error("Save Form Error:", error);
        res.status(500).json({ error: "Failed to save form." });
    } finally {
        if (connection) connection.release();
    }
};

// 2. Publish Form & Upload QR to S3
exports.publishForm = async (req, res) => {
    try {
        const { form_id, organization_id } = req.body;

        const [orgData] = await db.query(`
            SELECT o.slug, f.title 
            FROM forms f 
            JOIN organizations o ON f.organization_id = o.organization_id 
            WHERE f.form_id = ? AND f.organization_id = ?
        `, [form_id, organization_id]);

        if (orgData.length === 0) return res.status(404).json({ error: "Form not found." });

        const orgSlug = orgData[0].slug;
        const formTitle = orgData[0].title;
        const cleanTitle = slugify(formTitle, { lower: true, strict: true, trim: true });
        const publicSlug = `${orgSlug}-${cleanTitle}`;
        
        const frontendUrl = process.env.FRONTEND_URL || 'https://yourdomain.com';
        const publicUrl = `${frontendUrl}/form/${publicSlug}`;

        // Generate QR code buffer
        const qrBuffer = await QRCode.toBuffer(publicUrl, { type: 'png', margin: 2, width: 300 });

        // UPLOAD QR CODE TO AWS S3
        const qrKey = `forms/qrcodes/${publicSlug}-${Date.now()}.png`;
        await s3.send(new PutObjectCommand({
            Bucket: process.env.AWS_S3_BUCKET,
            Key: qrKey,
            Body: qrBuffer,
            ContentType: 'image/png'
        }));
        const qrCodeUrl = `https://${process.env.AWS_S3_BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${qrKey}`;

        // Update DB
        await db.query(`
            UPDATE forms 
            SET public_slug = ?, public_url = ?, qr_code_url = ?, is_published = TRUE, published_at = NOW()
            WHERE form_id = ?
        `, [publicSlug, publicUrl, qrCodeUrl, form_id]);

        res.status(200).json({ success: true, public_slug: publicSlug, public_url: publicUrl, qr_code_url: qrCodeUrl });

    } catch (error) {
        console.error("Publish Error:", error);
        res.status(500).json({ error: "Failed to publish form." });
    }
};

// Keep getPublicForm, getFormSubmissions, getOrganizationForms, and getFormById exactly the same...

// 3. Get Public Form Data for Contributor View
exports.getPublicForm = async (req, res) => {
    try {
        const { public_slug } = req.params;

        const [formData] = await db.query(`
            SELECT 
                o.name as org_name, o.profile_pic_url as org_profile_pic, o.category, o.type, o.established_year,
                f.form_id, f.title, f.description, f.picture_url, f.thank_you_message, f.is_active
            FROM forms f
            JOIN organizations o ON f.organization_id = o.organization_id
            WHERE f.public_slug = ? AND f.is_published = TRUE
        `, [public_slug]);

        if (formData.length === 0) {
            return res.status(404).json({ error: "Form not found or not published." });
        }

        if (!formData[0].is_active) {
            return res.status(403).json({ error: "This form is currently inactive." });
        }

        const [fields] = await db.query(`
            SELECT label, field_type, options, is_required, placeholder, sort_order
            FROM form_fields
            WHERE form_id = ?
            ORDER BY sort_order ASC
        `, [formData[0].form_id]);

        res.status(200).json({
            success: true,
            organization: {
                name: formData[0].org_name,
                profile_pic: formData[0].org_profile_pic,
                category: formData[0].category,
                type: formData[0].type,
                established_year: formData[0].established_year
            },
            form: {
                form_id: formData[0].form_id,
                title: formData[0].title,
                description: formData[0].description,
                picture_url: formData[0].picture_url,
                thank_you_message: formData[0].thank_you_message
            },
            fields: fields
        });

    } catch (error) {
        console.error("Get Public Form Error:", error);
        res.status(500).json({ error: "Failed to retrieve public form." });
    }
};

// 4. Get Submissions By Form ID (STRICTLY SUBMISSIONS ONLY, NO PAYMENT DATA)
exports.getFormSubmissions = async (req, res) => {
    try {
        const { form_id } = req.params;

        const [submissions] = await db.query(`
            SELECT 
                submission_id,
                form_id,
                contributor_name,
                contributor_email,
                contributor_mobile,
                answers,
                submitted_at
            FROM form_submissions
            WHERE form_id = ?
            ORDER BY submitted_at DESC
        `, [form_id]);

        res.status(200).json({
            success: true,
            total: submissions.length,
            submissions: submissions
        });

    } catch (error) {
        console.error("Get Form Submissions Error:", error);
        res.status(500).json({ error: "Failed to fetch form submissions." });
    }
};

// 5. Get All Forms for an Organization (Dashboard Management)
exports.getOrganizationForms = async (req, res) => {
    try {
        const { organization_id } = req.params;

        const [forms] = await db.query(`
            SELECT 
                form_id, organization_id, title, description, picture_url,
                public_slug, public_url, qr_code_url, is_published, is_active,
                published_at, created_at, updated_at
            FROM forms
            WHERE organization_id = ?
            ORDER BY created_at DESC
        `, [organization_id]);

        res.status(200).json({
            success: true,
            forms: forms
        });

    } catch (error) {
        console.error("Get Organization Forms Error:", error);
        res.status(500).json({ error: "Failed to fetch organization forms." });
    }
};


// 6. Submit Public Form (For Non-Payment / Free Forms)
exports.submitPublicForm = async (req, res) => {
    try {
        const { 
            form_id, 
            organization_id, 
            contributor_name, 
            contributor_email, 
            contributor_mobile, 
            answers 
        } = req.body;

        if (!form_id || !organization_id) {
            return res.status(400).json({ error: "Form ID and Organization ID are required." });
        }

        const [result] = await db.query(`
            INSERT INTO form_submissions (
                form_id, organization_id, contributor_name, contributor_email, 
                contributor_mobile, answers, ip_address
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [
            form_id, organization_id, contributor_name || null, 
            contributor_email || null, contributor_mobile || null, 
            JSON.stringify(answers || {}), req.ip
        ]);

        // --- WHATSAPP NOTIFICATION LOGIC (FREE FORM) ---
        if (contributor_mobile) {
            try {
                const [orgData] = await db.query(
                    `SELECT name, slug FROM organizations WHERE organization_id = ?`, 
                    [organization_id]
                );
                if (orgData.length > 0) {
                    await whatsappService.sendThankYouMessage(
                        contributor_mobile, 
                        contributor_name, 
                        orgData[0].name, 
                        0, // 0 Amount for free forms
                        orgData[0].slug
                    );
                }
            } catch (waError) {
                console.error("WhatsApp Free Form Error:", waError);
            }
        }

        res.status(200).json({
            success: true,
            submission_id: result.insertId,
            message: "Form submitted successfully."
        });

    } catch (error) {
        console.error("Submit Public Form Error:", error);
        res.status(500).json({ error: "An error occurred while saving your submission." });
    }
};

// Get Form by ID (For Editor/Builder Mode)
exports.getFormById = async (req, res) => {
    try {
        const { form_id } = req.params;

        // Fetch basic form details
        const [formData] = await db.query(`
            SELECT form_id, title, description, thank_you_message, is_published 
            FROM forms 
            WHERE form_id = ?
        `, [form_id]);

        if (formData.length === 0) {
            return res.status(404).json({ error: "Form not found." });
        }

        // Fetch associated fields
        const [fields] = await db.query(`
            SELECT label, field_type, is_required, placeholder, options 
            FROM form_fields 
            WHERE form_id = ? 
            ORDER BY sort_order ASC
        `, [form_id]);

        res.status(200).json({
            success: true,
            form: formData[0],
            fields: fields
        });

    } catch (error) {
        console.error("Get Form By ID Error:", error);
        res.status(500).json({ error: "Failed to fetch form details." });
    }
};



// 8. Delete Form and all associated data/files
exports.deleteForm = async (req, res) => {
    const connection = await db.getConnection();
    try {
        const { form_id } = req.params;

        // 1. Fetch form to get AWS S3 URLs before deleting
        const [forms] = await connection.query(`SELECT picture_url, qr_code_url FROM forms WHERE form_id = ?`, [form_id]);
        
        if (forms.length === 0) {
            return res.status(404).json({ error: "Form not found." });
        }
        const form = forms[0];

        // 2. Helper function to delete files from AWS S3
        const deleteFromS3 = async (fileUrl) => {
            if (fileUrl && fileUrl.includes('amazonaws.com')) {
                try {
                    const urlParts = new URL(fileUrl);
                    const key = urlParts.pathname.substring(1); // Remove leading slash to get the S3 Key
                    await s3.send(new DeleteObjectCommand({
                        Bucket: process.env.AWS_S3_BUCKET,
                        Key: key
                    }));
                } catch (s3Err) {
                    console.error("S3 Delete Error for key:", key, s3Err);
                }
            }
        };

        // Execute S3 deletions
        await deleteFromS3(form.picture_url);
        await deleteFromS3(form.qr_code_url);

        // 3. Delete from Database
        // Note: Due to your ON DELETE CASCADE setup, form_fields and form_submissions will be automatically erased.
        await connection.query(`DELETE FROM forms WHERE form_id = ?`, [form_id]);

        res.status(200).json({ success: true, message: "Form and all associated data permanently deleted." });

    } catch (error) {
        console.error("Delete Form Error:", error);
        res.status(500).json({ error: "Failed to delete form." });
    } finally {
        if (connection) connection.release();
    }
};

