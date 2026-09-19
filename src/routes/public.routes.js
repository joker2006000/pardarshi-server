const express = require('express');
const router = express.Router();
const publicController = require('../controllers/public.controller');
const reportController = require('../controllers/report.controller');
const { verifyGuestToken } = require('../middlewares/guest.middleware');
const upload = require('../middlewares/upload.middleware');

// ==========================================
// PUBLIC PAGES
// ==========================================
// 1. Organization Page (Domain + Org Slug)
router.get('/org/:orgSlug', publicController.getPublicOrganization);

// 2. Project Transactions Page (Domain + Org Slug + Project Slug)
router.get('/org/:orgSlug/project/:projectSlug', publicController.getPublicProjectTransactions);

// ==========================================
// PUBLIC REPORTING (Secured by Magic Link Token)
// ==========================================
// Initiate a new report
router.post('/report/create', verifyGuestToken, reportController.createReport);

// Get all reports tied to this specific contributor's token
router.get('/report/list', verifyGuestToken, reportController.getReportsList);

// Get the full chat history for a specific report
router.get('/report/:report_id', verifyGuestToken, reportController.getReportDetailsAndChat);

// Send a new message in the chat (Supports up to 5 file attachments)
router.post(
    '/report/:report_id/message', 
    verifyGuestToken, 
    upload.array('attachments', 5), 
    reportController.sendMessage
);

module.exports = router;