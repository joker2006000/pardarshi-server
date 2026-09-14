const db = require('../config/db'); // Assuming standard mysql2/promise pool
const cashfreeService = require('../services/cashfree.service');


exports.initiateFormPayment = async (req, res) => {
    const connection = await db.getConnection();
    try {
        const { form_id, amount, contributor_name, contributor_email, contributor_mobile, answers } = req.body;

        // 1. Fetch Organization Details
        const [forms] = await connection.query(`
            SELECT f.organization_id, o.name as org_name, o.email as org_email, o.mobile_no as org_mobile,
                   o.upi_id, o.bank_account_number, o.bank_ifsc_code, o.cashfree_vendor_id
            FROM forms f
            JOIN organizations o ON f.organization_id = o.organization_id
            WHERE f.form_id = ?
        `, [form_id]);

        if (forms.length === 0) return res.status(404).json({ error: "Form not found" });
        const orgDetails = forms[0];

        // 2. Enforce Payout Validation
        if (!orgDetails.upi_id && !orgDetails.bank_account_number) {
            return res.status(400).json({ error: "This organization has not set up receiving bank or UPI details." });
        }

        // 3. Auto-Create Vendor
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

        // 4. Save Form Submission First
        const [submissionResult] = await connection.query(`
            INSERT INTO form_submissions (form_id, organization_id, contributor_name, contributor_email, contributor_mobile, answers, ip_address)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `, [form_id, orgDetails.organization_id, contributor_name, contributor_email, contributor_mobile, JSON.stringify(answers), req.ip]);
        
        const submissionId = submissionResult.insertId;
        const cashfreeOrderId = `ORD_${submissionId}_${Date.now()}`;

        // 5. Generate Cashfree Order (No contribution saved yet)
        const orderResponse = await cashfreeService.createOrder({
            order_id: cashfreeOrderId,
            amount: amount,
            customer_id: `CUST_${Date.now()}`,
            customer_name: contributor_name,
            customer_email: contributor_email,
            customer_phone: contributor_mobile,
            vendor_id: vendorId,
            tags: {
                org_id: orgDetails.organization_id.toString(),
                form_id: form_id.toString(),
                submission_id: submissionId.toString()
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

exports.cashfreeWebhook = async (req, res) => {
    try {
        const payload = req.body;
        
        if (payload.type === 'PAYMENT_SUCCESS_WEBHOOK') {
            const order = payload.data.order;
            const paymentData = payload.data.payment;
            const customer = payload.data.customer_details;
            
            const orgId = order.order_tags.org_id;
            const formId = order.order_tags.form_id;
            const submissionId = order.order_tags.submission_id;
            const actualAmountPaid = paymentData.payment_amount;
            const paymentMethod = paymentData.payment_group; 
            
            const extraDetails = JSON.stringify({
                cashfree_payment_id: paymentData.cf_payment_id,
                bank_reference: paymentData.bank_reference,
                payment_time: paymentData.payment_time
            });

            // Duplicate Check: Ensure we haven't already processed this order
            const [existing] = await db.query(`SELECT contribution_id FROM contributions WHERE payment_id = ?`, [order.order_id]);
            if (existing.length > 0) {
                return res.status(200).send("Already processed");
            }

            // 1. Save strictly after success
            await db.query(`
                INSERT INTO contributions (
                    organization_id, form_id, submission_id, 
                    contributor_name, contributor_email, contributor_mobile, 
                    amount, payment_status, payment_gateway, 
                    payment_id, payment_method, notes
                ) VALUES (?, ?, ?, ?, ?, ?, ?, 'success', 'cashfree', ?, ?, ?)
            `, [
                orgId, formId, submissionId, 
                customer.customer_name, customer.customer_email, customer.customer_phone, 
                actualAmountPaid, order.order_id, paymentMethod, extraDetails
            ]);

            // 2. Increment organization balances
            await db.query(`
                UPDATE organizations 
                SET total_received = total_received + ?,
                    remaining_balance = remaining_balance + ?
                WHERE organization_id = ?
            `, [actualAmountPaid, actualAmountPaid, orgId]);
        }

        res.status(200).send("Webhook processed successfully");
        
    } catch (error) {
        console.error("Webhook Processing Error:", error);
        res.status(500).send("Webhook processing failed");
    }
};


exports.verifyPayment = async (req, res) => {
    const { order_id } = req.params;
    const connection = await db.getConnection();

    try {
        const cashfreeResponse = await cashfreeService.cashfreeApi.get(`/orders/${order_id}`);
        const orderData = cashfreeResponse.data;

        if (orderData.order_status === 'PAID') {
            const [existing] = await connection.query(`SELECT contribution_id FROM contributions WHERE payment_id = ?`, [order_id]);
            
            if (existing.length === 0) {
                const tags = orderData.order_tags;
                const paymentMethod = "online"; 
                
                await connection.beginTransaction();

                await connection.query(`
                    INSERT INTO contributions (
                        organization_id, form_id, submission_id, 
                        contributor_name, contributor_email, contributor_mobile, 
                        amount, payment_status, payment_gateway, 
                        payment_id, payment_method, notes
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'success', 'cashfree', ?, ?, ?)
                `, [
                    tags.org_id, tags.form_id, tags.submission_id, 
                    orderData.customer_details.customer_name, 
                    orderData.customer_details.customer_email, 
                    orderData.customer_details.customer_phone, 
                    orderData.order_amount, order_id, paymentMethod, "Verified via Return URL"
                ]);

                await connection.query(`
                    UPDATE organizations 
                    SET total_received = total_received + ?,
                        remaining_balance = remaining_balance + ?
                    WHERE organization_id = ?
                `, [orderData.order_amount, orderData.order_amount, tags.org_id]);

                await connection.commit();

            }

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