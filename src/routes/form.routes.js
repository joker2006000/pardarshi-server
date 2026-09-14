const express = require('express');
const router = express.Router();
const formController = require('../controllers/form.controller');
const { protect } = require('../middlewares/auth.middleware');

// IMPORT S3 UPLOAD MIDDLEWARE
const upload = require('../middlewares/upload.middleware');

// Form Builder (Admin routes)
// Apply the upload middleware looking for the 'picture' field
router.post('/save', protect, upload.single('picture'), formController.saveFormDraft);
router.post('/publish', protect, formController.publishForm);
router.get('/organization/:organization_id', protect, formController.getOrganizationForms);

// Submissions by Form ID (Submissions only)
router.get('/:form_id/submissions', protect, formController.getFormSubmissions);

// Contributor Public Link (No auth needed to view a public form)
router.get('/public/:public_slug', formController.getPublicForm);

// Submit Public Form (No auth needed for public contributors)
router.post('/submit', formController.submitPublicForm);

// Get a specific form by ID for editing
router.get('/:form_id', protect, formController.getFormById);

// Delete a specific form and all its data
router.delete('/:form_id', protect, formController.deleteForm);

module.exports = router;