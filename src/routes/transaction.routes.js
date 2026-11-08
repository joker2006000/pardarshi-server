const express = require('express');
const router = express.Router();
const transactionController = require('../controllers/transaction.controller');
const upload = require('../middlewares/upload.middleware'); // AWS S3 middleware

// 1. Fetch all transactions/totals
router.get('/:organization_id', transactionController.getTransactions);

// 2. Add an offline expense with up to 5 proof documents
router.post('/expense/offline', upload.array('proofs', 5), transactionController.addOfflineExpense);

// 3. Edit an existing expense (Text & Math only - no files processed here)
router.put('/expense/:expense_id', upload.none(), transactionController.editExpense);

// 4. Add an offline contribution
router.post('/contribution/offline', upload.array('proofs', 5), transactionController.addOfflineContribution);

// 5. Edit an existing contribution
router.put('/contribution/:contribution_id', upload.array('proofs', 5), transactionController.editContribution);

// 6. UNIFIED: Manage extra files (Upload multiple or Delete)
// Expects action, proof_type, and optional file_id in req.body
router.post('/expense/:expense_id/manage-file', upload.array('documents', 5), transactionController.manageExpenseFile);

// 7. Create an announcement
router.post('/:organization_id/announcements', transactionController.createAnnouncement);

// 8. Get all announcements for the org dashboard
router.get('/:organization_id/announcements', transactionController.getAnnouncements);

// 9. Delete an announcement
router.delete('/announcements/:announcement_id', transactionController.deleteAnnouncement);

module.exports = router;