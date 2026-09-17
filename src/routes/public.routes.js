const express = require('express');
const router = express.Router();
const publicController = require('../controllers/public.controller');

// 1. Organization Page (Domain + Org Slug)
router.get('/org/:orgSlug', publicController.getPublicOrganization);

// 2. Project Transactions Page (Domain + Org Slug + Project Slug)
router.get('/org/:orgSlug/project/:projectSlug', publicController.getPublicProjectTransactions);

module.exports = router;