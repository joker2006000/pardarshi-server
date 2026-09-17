const db = require('../config/db'); 
const cashfreeService = require('../services/cashfree.service');

// ==========================================
// HELPER: Convert Marathi/Hindi Digits to English
// ==========================================
const convertToEnglishDigits = (str) => {
    if (!str) return "";
    const devanagariDigits = {'०':'0','१':'1','२':'2','३':'3','४':'4','५':'5','६':'6','७':'7','८':'8','९':'9'};
    let englishStr = String(str).replace(/[०-९]/g, match => devanagariDigits[match]);
    return englishStr.replace(/\D/g, ''); 
};

//  ADDED: HELPER: Real WhatsApp Notification
// ==========================================
// ==========================================
//  ADDED: HELPER: Real WhatsApp Notification
// ==========================================
const sendWhatsAppNotification = async (name, phone, amount, orgId, projectId) => {
    try {
        const whatsappUrl = process.env.WHATSAPP_SERVER_URL;
        const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000'; // Uses your env variable
        
        if (!whatsappUrl) {
            console.log("WhatsApp server URL not configured in .env");
            return;
        }

        const connection = await db.getConnection();
        let orgName = "Organization";
        let orgSlug = ""; // Variable to hold the slug for the link
        let projectName = "General Fund";

        try {
            // Updated query: Fetch both name AND slug
            const [orgs] = await connection.query(`SELECT name, slug FROM organizations WHERE organization_id = ?`, [orgId]);
            if (orgs.length > 0) {
                orgName = orgs[0].name;
                orgSlug = orgs[0].slug;
            }

            if (projectId) {
                const [projs] = await connection.query(`SELECT name FROM organization_projects WHERE project_id = ?`, [projectId]);
                if (projs.length > 0) {
                    projectName = projs[0].name;
                }
            }
        } finally {
            connection.release();
        }

        // Construct the correct dynamic public link
        const profileLink = `${frontendUrl}/org.html?org=${orgSlug}`;

        // Send to the real contributor's mobile number
        await fetch(`${whatsappUrl}/api/send-message`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                phone: phone, 
                name: name || "Contributor",
                amount: amount,
                projectName: projectName,
                organizationName: orgName,
                link: profileLink // Send the dynamic profile link
            })
        });
    } catch (error) {
        console.error("WhatsApp Notification Error:", error);
    }
};
// ==========================================

// ==========================================
// 1. CONTRIBUTIONS (Incoming Money)
// ==========================================
exports.initiateFormPayment = async (req, res) => {
    const connection = await db.getConnection();
    try {
        let { form_id, amount, contributor_name, contributor_email, contributor_mobile, answers } = req.body;

        if (answers && typeof answers === 'object') {
            for (const [key, value] of Object.entries(answers)) {
                const lowerKey = key.toLowerCase();
                
                if (!contributor_mobile && (lowerKey.includes('मोबाईल') || lowerKey.includes('फोन') || lowerKey.includes('mobile') || lowerKey.includes('phone'))) {
                    contributor_mobile = value;
                }
                if (!contributor_name && (lowerKey.includes('नाव') || lowerKey.includes('name') || lowerKey.includes('पूर्ण नाव'))) {
                    contributor_name = value;
                }
                if (!contributor_email && (lowerKey.includes('ई-मेल') || lowerKey.includes('ईमेल') || lowerKey.includes('email'))) {
                    contributor_email = value;
                }
            }
        }

        const cleanMobile = convertToEnglishDigits(contributor_mobile);
        const finalPhone = (cleanMobile && cleanMobile.length >= 10) ? cleanMobile.substring(0, 10) : "9999999999";

        const finalName = contributor_name || "Guest Donor";
        const finalEmail = contributor_email || "noemail@example.com";

        const [forms] = await connection.query(`
            SELECT f.organization_id, o.name as org_name, o.email as org_email, o.mobile_no as org_mobile,
                   o.upi_id, o.bank_account_number, o.bank_ifsc_code, o.cashfree_vendor_id,
                   p.project_id
            FROM forms f
            JOIN organizations o ON f.organization_id = o.organization_id
            LEFT JOIN organization_projects p ON p.form_id = f.form_id
            WHERE f.form_id = ?
        `, [form_id]);

        if (forms.length === 0) return res.status(404).json({ error: "Form not found" });
        const orgDetails = forms[0];

        if (!orgDetails.upi_id && !orgDetails.bank_account_number) {
            return res.status(400).json({ error: "This organization has not set up receiving bank or UPI details." });
        }

        let vendorId = orgDetails.cashfree_vendor_id;
        if (!vendorId) {
            vendorId = `ORG_${orgDetails.organization_id}_${Date.now()}`;
            await cashfreeService.createVendor({
                vendor_id: vendorId,
                name: orgDetails.org_name,
                email: orgDetails.org_email || "default@pardarshi.com",
                phone: orgDetails.org_mobile || "9999999999",
                bank_account: orgDetails.bank_account_number,
                ifsc: orgDetails.bank_ifsc_code,
                upi_id: orgDetails.upi_id
            });
            await connection.query(
                `UPDATE organizations SET cashfree_vendor_id = ? WHERE organization_id = ?`,
                [vendorId, orgDetails.organization_id]
            );
        }

        await connection.beginTransaction();

        const [submissionResult] = await connection.query(`
            INSERT INTO form_submissions (form_id, organization_id, contributor_name, contributor_email, contributor_mobile, answers, ip_address)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [form_id, orgDetails.organization_id, finalName, finalEmail, finalPhone, JSON.stringify(answers), req.ip]);
        
        const submissionId = submissionResult.insertId;
        const cashfreeOrderId = `ORD_CONT_${submissionId}_${Date.now()}`;

        const orderResponse = await cashfreeService.createOrder({
            order_id: cashfreeOrderId,
            amount: parseFloat(amount),
            customer_id: `CUST_${Date.now()}`,
            customer_name: finalName,
            customer_email: finalEmail,
            customer_phone: finalPhone,
            vendor_id: vendorId,
            tags: {
                transaction_type: "contribution",
                org_id: orgDetails.organization_id.toString(),
                form_id: form_id.toString(),
                submission_id: submissionId.toString(),
                project_id: orgDetails.project_id ? orgDetails.project_id.toString() : "0"
            }
        });

        await connection.commit();

        res.status(200).json({
            success: true,
            payment_session_id: orderResponse.payment_session_id,
            order_id: cashfreeOrderId
        });

    } catch (error) {
        if (connection) await connection.rollback();
        console.error("Payment Initiation Error:", error);
        res.status(500).json({ error: "Failed to initiate payment." });
    } finally {
        if (connection) connection.release();
    }
};

// ==========================================
// 2. EXPENSES (Outgoing Money)
// ==========================================
exports.initiateExpensePayment = async (req, res) => {
    const connection = await db.getConnection();
    try {
        const { organization_id, project_id, amount, expense_title, description, vendor_name, vendor_upi_id, vendor_bank_account, vendor_ifsc, created_by } = req.body;

        if (!project_id || project_id === "" || project_id === "0" || project_id === 0) {
            return res.status(400).json({ error: "Project selection is mandatory for registering expenses." });
        }
        if (!amount || parseFloat(amount) <= 0) {
            return res.status(400).json({ error: "A valid positive amount is required." });
        }

        const [projectCheck] = await connection.query(
            `SELECT project_id, name FROM organization_projects WHERE project_id = ? AND organization_id = ?`,
            [project_id, organization_id]
        );
        if (projectCheck.length === 0) {
            return res.status(404).json({ error: "Selected project not found under this organization." });
        }

        const expenseVendorId = `VEND_${Date.now()}`;
        await cashfreeService.createVendor({
            vendor_id: expenseVendorId,
            name: vendor_name || "Vendor",
            email: "vendor@pardarshi.com",
            phone: "9999999999",
            bank_account: vendor_bank_account || null,
            ifsc: vendor_ifsc || null,
            upi_id: vendor_upi_id || null
        });

        await connection.beginTransaction();

        const [expenseResult] = await connection.query(`
            INSERT INTO expenses (
                organization_id, project_id, title, description, amount, 
                expense_date, is_online_payment, payment_mode, payment_status, status, created_by
            ) VALUES (?, ?, ?, ?, ?, CURDATE(), TRUE, 'online', 'pending', 'pending', ?)
        `, [organization_id, project_id, expense_title, description || null, parseFloat(amount), created_by || 1]);
        
        const expenseId = expenseResult.insertId;
        const cashfreeOrderId = `ORD_EXP_${expenseId}_${Date.now()}`;

        const orderResponse = await cashfreeService.createOrder({
            order_id: cashfreeOrderId,
            amount: parseFloat(amount),
            customer_id: `ORG_CUST_${organization_id}`,
            customer_name: "Organization Expense",
            customer_phone: "9999999999",
            vendor_id: expenseVendorId,
            tags: {
                transaction_type: "expense",
                org_id: organization_id.toString(),
                expense_id: expenseId.toString(),
                project_id: project_id.toString()
            }
        });

        await connection.commit();

        res.status(200).json({
            success: true,
            payment_session_id: orderResponse.payment_session_id,
            order_id: cashfreeOrderId
        });

    } catch (error) {
        if (connection) await connection.rollback();
        console.error("Expense Initiation Error:", error);
        res.status(500).json({ error: "Failed to initiate expense payment." });
    } finally {
        if (connection) connection.release();
    }
};

// ==========================================
// 3. WEBHOOK (Handles Both Types)
// ==========================================
exports.cashfreeWebhook = async (req, res) => {
    try {
        const payload = req.body;
        
        if (payload.type === 'PAYMENT_SUCCESS_WEBHOOK') {
            const order = payload.data.order;
            const paymentData = payload.data.payment;
            const customer = payload.data.customer_details;
            
            const transactionType = order.order_tags.transaction_type || "contribution";
            const orgId = order.order_tags.org_id;
            const actualAmountPaid = parseFloat(paymentData.payment_amount);
            const paymentMethod = paymentData.payment_group || "online"; 
            
            const extraDetails = JSON.stringify({
                cashfree_payment_id: paymentData.cf_payment_id,
                bank_reference: paymentData.bank_reference,
                payment_time: paymentData.payment_time
            });

            // Handle Contribution
            if (transactionType === "contribution") {
                const [existing] = await db.query(`SELECT contribution_id FROM contributions WHERE payment_id = ?`, [order.order_id]);
                if (existing.length > 0) return res.status(200).send("Already processed");

                let targetProjectId = order.order_tags.project_id !== "0" ? order.order_tags.project_id : null;
                if (!targetProjectId && order.order_tags.form_id) {
                    const [proj] = await db.query(`SELECT project_id FROM organization_projects WHERE form_id = ?`, [order.order_tags.form_id]);
                    if (proj.length > 0) targetProjectId = proj[0].project_id;
                }

                await db.query(`
                    INSERT INTO contributions (
                        organization_id, project_id, form_id, submission_id, contributor_name, contributor_email, contributor_mobile, 
                        amount, payment_status, payment_gateway, payment_id, payment_method, notes
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'success', 'cashfree', ?, ?, ?)
                `, [orgId, targetProjectId, order.order_tags.form_id, order.order_tags.submission_id, customer.customer_name, customer.customer_email, customer.customer_phone, actualAmountPaid, order.order_id, paymentMethod, extraDetails]);

                // Math Updates for Contributions
                await db.query(`
                    UPDATE organizations 
                    SET total_received = total_received + ?, remaining_balance = remaining_balance + ? 
                    WHERE organization_id = ?
                `, [actualAmountPaid, actualAmountPaid, orgId]);

                if (targetProjectId) {
                    await db.query(`
                        UPDATE organization_projects 
                        SET total_received = total_received + ?, remaining_balance = remaining_balance + ? 
                        WHERE project_id = ?
                    `, [actualAmountPaid, actualAmountPaid, targetProjectId]);
                }

                // ADDED: Trigger Real WhatsApp Notification
                await sendWhatsAppNotification(customer.customer_name, customer.customer_phone, actualAmountPaid, orgId, targetProjectId);
            } 
            
            // Handle Expense
            else if (transactionType === "expense") {
                const expenseId = order.order_tags.expense_id;
                const [existing] = await db.query(
                    `SELECT expense_id, organization_id, project_id, payment_status FROM expenses WHERE expense_id = ?`, 
                    [expenseId]
                );

                if (existing.length === 0) return res.status(200).send("Expense record not found");
                if (existing[0].payment_status === 'success') return res.status(200).send("Already processed");

                const targetOrgId = existing[0].organization_id || orgId;
                const targetProjectId = existing[0].project_id || (order.order_tags.project_id !== "0" ? order.order_tags.project_id : null);

                await db.query(`
                    UPDATE expenses 
                    SET payment_status = 'success', 
                        status = 'paid', 
                        payment_mode = 'online',
                        payment_gateway = 'cashfree', 
                        payment_id = ?, 
                        payment_method = ?, 
                        paid_at = NOW() 
                    WHERE expense_id = ?
                `, [order.order_id, paymentMethod, expenseId]);

                await db.query(`
                    UPDATE organizations 
                    SET total_expenses = total_expenses + ?, remaining_balance = remaining_balance - ? 
                    WHERE organization_id = ?
                `, [actualAmountPaid, actualAmountPaid, targetOrgId]);

                if (targetProjectId) {
                    await db.query(`
                        UPDATE organization_projects 
                        SET total_expenses = total_expenses + ?, remaining_balance = remaining_balance - ? 
                        WHERE project_id = ?
                    `, [actualAmountPaid, actualAmountPaid, targetProjectId]);
                }
            }
        }
        res.status(200).send("Webhook processed successfully");
    } catch (error) {
        console.error("Webhook Processing Error:", error);
        res.status(500).send("Webhook processing failed");
    }
};

// ==========================================
// 4. VERIFY RETURN (Active Verification)
// ==========================================
exports.verifyPayment = async (req, res) => {
    const { order_id } = req.params;
    const connection = await db.getConnection();

    try {
        const cashfreeResponse = await cashfreeService.cashfreeApi.get(`/orders/${order_id}`);
        const orderData = cashfreeResponse.data;

        if (orderData.order_status === 'PAID') {
            const tags = orderData.order_tags || {};
            const transactionType = tags.transaction_type || "contribution";
            const paymentMethod = "online"; 
            const paidAmount = parseFloat(orderData.order_amount);

            await connection.beginTransaction();

            if (transactionType === "contribution") {
                const [existing] = await connection.query(`SELECT contribution_id FROM contributions WHERE payment_id = ?`, [order_id]);
                if (existing.length === 0) {
                    let targetProjectId = tags.project_id && tags.project_id !== "0" ? tags.project_id : null;
                    if (!targetProjectId && tags.form_id) {
                        const [proj] = await connection.query(`SELECT project_id FROM organization_projects WHERE form_id = ?`, [tags.form_id]);
                        if (proj.length > 0) targetProjectId = proj[0].project_id;
                    }

                    await connection.query(`
                        INSERT INTO contributions (
                            organization_id, project_id, form_id, submission_id, contributor_name, contributor_email, contributor_mobile, 
                            amount, payment_status, payment_gateway, payment_id, payment_method, notes
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'success', 'cashfree', ?, ?, ?)
                    `, [tags.org_id, targetProjectId, tags.form_id, tags.submission_id, orderData.customer_details.customer_name, orderData.customer_details.customer_email, orderData.customer_details.customer_phone, paidAmount, order_id, paymentMethod, "Verified via Return URL"]);

                    await connection.query(`
                        UPDATE organizations 
                        SET total_received = total_received + ?, remaining_balance = remaining_balance + ? 
                        WHERE organization_id = ?
                    `, [paidAmount, paidAmount, tags.org_id]);

                    if (targetProjectId) {
                        await connection.query(`
                            UPDATE organization_projects 
                            SET total_received = total_received + ?, remaining_balance = remaining_balance + ? 
                            WHERE project_id = ?
                        `, [paidAmount, paidAmount, targetProjectId]);
                    }

                    //Trigger Real WhatsApp Notification
                    await sendWhatsAppNotification(orderData.customer_details.customer_name, orderData.customer_details.customer_phone, paidAmount, tags.org_id, targetProjectId);
                }
            } 
            else if (transactionType === "expense") {
                const expenseId = tags.expense_id;
                
                const [existing] = await connection.query(
                    `SELECT expense_id, organization_id, project_id, payment_status FROM expenses WHERE expense_id = ?`, 
                    [expenseId]
                );

                if (existing.length > 0 && existing[0].payment_status !== 'success') {
                    const targetOrgId = existing[0].organization_id || tags.org_id;
                    const targetProjectId = existing[0].project_id || (tags.project_id !== "0" ? tags.project_id : null);

                    await connection.query(`
                        UPDATE expenses 
                        SET payment_status = 'success', 
                            status = 'paid', 
                            payment_mode = 'online',
                            payment_gateway = 'cashfree', 
                            payment_id = ?, 
                            payment_method = ?, 
                            paid_at = NOW() 
                        WHERE expense_id = ?
                    `, [order_id, paymentMethod, expenseId]);

                    await connection.query(`
                        UPDATE organizations 
                        SET total_expenses = total_expenses + ?, 
                            remaining_balance = remaining_balance - ? 
                            WHERE organization_id = ?
                    `, [paidAmount, paidAmount, targetOrgId]);

                    if (targetProjectId) {
                        await connection.query(`
                            UPDATE organization_projects 
                            SET total_expenses = total_expenses + ?, 
                                remaining_balance = remaining_balance - ? 
                            WHERE project_id = ?
                        `, [paidAmount, paidAmount, targetProjectId]);
                    }
                }
            }

          await connection.commit();
            return res.status(200).json({ 
                success: true, 
                status: 'PAID', 
                amount: paidAmount,
                thank_you_message: transactionType === 'expense' 
                    ? "Expense payment successfully completed and recorded to the project." 
                    : null,
                transaction_type: transactionType, 
                org_id: tags.org_id                
            });
        } else {
            return res.status(200).json({ success: true, status: orderData.order_status });
        }
    } catch (error) {
        if (connection) await connection.rollback();
        console.error("Verification Error:", error.response?.data || error.message);
        res.status(500).json({ success: false, error: "Failed to verify payment." });
    } finally {
        if (connection) connection.release();
    }
};