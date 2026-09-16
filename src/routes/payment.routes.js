const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/payment.controller');

// Triggered by the user clicking "Pay" on the frontend for a Contribution
router.post('/initiate', paymentController.initiateFormPayment);

// NEW: Triggered by the organization initiating an automated Expense payment
router.post('/expense/initiate', paymentController.initiateExpensePayment);

// Configured in Cashfree Dashboard to receive async updates for BOTH types
router.post('/webhook', express.json(), paymentController.cashfreeWebhook);

// Triggered by the frontend payment-status page to actively check the payment for BOTH types
router.get('/verify/:order_id', paymentController.verifyPayment);

module.exports = router;