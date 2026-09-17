const db = require('../config/db'); 
const cashfreeService = require('../services/cashfree.service');

// ==========================================
// 1. CONTRIBUTIONS (Incoming Money)
// ==========================================
exports.initiateFormPayment = async (req, res) => {
    const connection = await db.getConnection();
    try {
        const { form_id, amount, contributor_name, contributor_email, contributor_mobile, answers } = req.body;

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
        `, [form_id, orgDetails.organization_id, contributor_name, contributor_email, contributor_mobile, JSON.stringify(answers), req.ip]);
        
        const submissionId = submissionResult.insertId;
        const cashfreeOrderId = `ORD_CONT_${submissionId}_${Date.now()}`;

        const orderResponse = await cashfreeService.createOrder({
            order_id: cashfreeOrderId,
            amount: amount,
            customer_id: `CUST_${Date.now()}`,
            customer_name: contributor_name,
            customer_email: contributor_email,
            customer_phone: contributor_mobile,
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

        // NEW FIX: Enforce project selection to ensure expenses are mapped properly
        if (!project_id) {
            return res.status(400).json({ error: "Project selection is mandatory for expenses." });
        }

        // 1. Auto-Create Vendor in Cashfree for the receiver
        const expenseVendorId = `VEND_${Date.now()}`;
        await cashfreeService.createVendor({
            vendor_id: expenseVendorId,
            name: vendor_name,
            email: "vendor@pardarshi.com", // Dummy email for third party
            phone: "9999999999", // Dummy phone
            bank_account: vendor_bank_account,
            ifsc: vendor_ifsc,
            upi_id: vendor_upi_id
        });

        await connection.beginTransaction();

        // 2. Save Pending Expense in DB
        const [expenseResult] = await connection.query(`
            INSERT INTO expenses (organization_id, project_id, title, description, amount, expense_date, is_online_payment, payment_status, created_by)
            VALUES (?, ?, ?, ?, ?, CURDATE(), TRUE, 'pending', ?)
        `, [organization_id, project_id, expense_title, description, amount, created_by]);
        
        const expenseId = expenseResult.insertId;
        const cashfreeOrderId = `ORD_EXP_${expenseId}_${Date.now()}`;

        // 3. Generate Cashfree Order where the Organization pays, and 100% goes to this new Vendor
        const orderResponse = await cashfreeService.createOrder({
            order_id: cashfreeOrderId,
            amount: amount,
            customer_id: `ORG_CUST_${organization_id}`,
            customer_name: "Organization Expense",
            customer_phone: "9999999999", // Can be updated to org's actual phone if desired
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
            const projectId = order.order_tags.project_id !== "0" ? order.order_tags.project_id : null;
            const actualAmountPaid = paymentData.payment_amount;
            const paymentMethod = paymentData.payment_group; 
            
            const extraDetails = JSON.stringify({
                cashfree_payment_id: paymentData.cf_payment_id,
                bank_reference: paymentData.bank_reference,
                payment_time: paymentData.payment_time
            });

            // Handle Contribution
            if (transactionType === "contribution") {
                const [existing] = await db.query(`SELECT contribution_id FROM contributions WHERE payment_id = ?`, [order.order_id]);
                if (existing.length > 0) return res.status(200).send("Already processed");

                await db.query(`
                    INSERT INTO contributions (
                        organization_id, project_id, form_id, submission_id, contributor_name, contributor_email, contributor_mobile, 
                        amount, payment_status, payment_gateway, payment_id, payment_method, notes
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'success', 'cashfree', ?, ?, ?)
                `, [orgId, projectId, order.order_tags.form_id, order.order_tags.submission_id, customer.customer_name, customer.customer_email, customer.customer_phone, actualAmountPaid, order.order_id, paymentMethod, extraDetails]);

                await db.query(`UPDATE organizations SET total_received = total_received + ?, remaining_balance = remaining_balance + ? WHERE organization_id = ?`, [actualAmountPaid, actualAmountPaid, orgId]);
                if (projectId) {
                    await db.query(`UPDATE organization_projects SET total_received = total_received + ?, remaining_balance = remaining_balance + ? WHERE project_id = ?`, [actualAmountPaid, actualAmountPaid, projectId]);
                }
            } 
            
            // Handle Expense
            else if (transactionType === "expense") {
                const expenseId = order.order_tags.expense_id;
                const [existing] = await db.query(`SELECT payment_status FROM expenses WHERE expense_id = ?`, [expenseId]);
                
                // NEW FIX: Changed from 'paid' to 'success' to match database ENUM
                if (existing.length > 0 && existing[0].payment_status === 'success') return res.status(200).send("Already processed");

                // NEW FIX: Set payment_status to 'success' instead of 'paid'
                await db.query(`
                    UPDATE expenses 
                    SET payment_status = 'success', status = 'paid', payment_gateway = 'cashfree', payment_id = ?, payment_method = ?, paid_at = NOW() 
                    WHERE expense_id = ?
                `, [order.order_id, paymentMethod, expenseId]);

                await db.query(`UPDATE organizations SET total_expenses = total_expenses + ?, remaining_balance = remaining_balance - ? WHERE organization_id = ?`, [actualAmountPaid, actualAmountPaid, orgId]);
                if (projectId) {
                    await db.query(`UPDATE organization_projects SET total_expenses = total_expenses + ?, remaining_balance = remaining_balance - ? WHERE project_id = ?`, [actualAmountPaid, actualAmountPaid, projectId]);
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
// 4. VERIFY RETURN (Handles Both Types)
// ==========================================
exports.verifyPayment = async (req, res) => {
    const { order_id } = req.params;
    const connection = await db.getConnection();

    try {
        const cashfreeResponse = await cashfreeService.cashfreeApi.get(`/orders/${order_id}`);
        const orderData = cashfreeResponse.data;

        if (orderData.order_status === 'PAID') {
            const tags = orderData.order_tags;
            const transactionType = tags.transaction_type || "contribution";
            const projectId = tags.project_id !== "0" ? tags.project_id : null;
            const paymentMethod = "online"; 

            await connection.beginTransaction();

            if (transactionType === "contribution") {
                const [existing] = await connection.query(`SELECT contribution_id FROM contributions WHERE payment_id = ?`, [order_id]);
                if (existing.length === 0) {
                    await connection.query(`
                        INSERT INTO contributions (
                            organization_id, project_id, form_id, submission_id, contributor_name, contributor_email, contributor_mobile, 
                            amount, payment_status, payment_gateway, payment_id, payment_method, notes
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'success', 'cashfree', ?, ?, ?)
                    `, [tags.org_id, projectId, tags.form_id, tags.submission_id, orderData.customer_details.customer_name, orderData.customer_details.customer_email, orderData.customer_details.customer_phone, orderData.order_amount, order_id, paymentMethod, "Verified via Return URL"]);

                    await connection.query(`UPDATE organizations SET total_received = total_received + ?, remaining_balance = remaining_balance + ? WHERE organization_id = ?`, [orderData.order_amount, orderData.order_amount, tags.org_id]);
                    if (projectId) {
                        await connection.query(`UPDATE organization_projects SET total_received = total_received + ?, remaining_balance = remaining_balance + ? WHERE project_id = ?`, [orderData.order_amount, orderData.order_amount, projectId]);
                    }
                }
            } 
            else if (transactionType === "expense") {
                const expenseId = tags.expense_id;
                const [existing] = await connection.query(`SELECT payment_status FROM expenses WHERE expense_id = ?`, [expenseId]);
                
                // NEW FIX: Check against 'success' instead of 'paid'
                if (existing.length > 0 && existing[0].payment_status !== 'success') {
                    
                    // NEW FIX: Set payment_status to 'success'
                    await connection.query(`
                        UPDATE expenses SET payment_status = 'success', status = 'paid', payment_gateway = 'cashfree', payment_id = ?, payment_method = ?, paid_at = NOW() 
                        WHERE expense_id = ?
                    `, [order_id, paymentMethod, expenseId]);

                    await connection.query(`UPDATE organizations SET total_expenses = total_expenses + ?, remaining_balance = remaining_balance - ? WHERE organization_id = ?`, [orderData.order_amount, orderData.order_amount, tags.org_id]);
                    if (projectId) {
                        await connection.query(`UPDATE organization_projects SET total_expenses = total_expenses + ?, remaining_balance = remaining_balance - ? WHERE project_id = ?`, [orderData.order_amount, orderData.order_amount, projectId]);
                    }
                }
            }

            await connection.commit();
            return res.status(200).json({ success: true, status: 'PAID', amount: orderData.order_amount });
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