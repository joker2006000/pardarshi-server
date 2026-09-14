const express = require('express');
const router = express.Router();
const paymentController = require('../controllers/payment.controller');

// Triggered by the user clicking "Pay" on the frontend
router.post('/initiate', paymentController.initiateFormPayment);

// Configured in Cashfree Dashboard to receive async updates
router.post('/webhook', express.json(), paymentController.cashfreeWebhook);

// NEW: Triggered by the frontend payment-status page to actively check the payment
router.get('/verify/:order_id', paymentController.verifyPayment);

module.exports = router;