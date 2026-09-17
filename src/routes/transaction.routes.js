const express = require('express');
const router = express.Router();
const transactionController = require('../controllers/transaction.controller');
const upload = require('../middlewares/upload.middleware'); // AWS S3 middleware

// 1. Fetch all transactions/totals
router.get('/:organization_id', transactionController.getTransactions);

// 2. Add an offline expense with up to 5 proof documents
router.post('/expense/offline', upload.array('proofs', 5), transactionController.addOfflineExpense);

// 3. Edit an existing expense
router.put('/expense/:expense_id', upload.array('proofs', 5), transactionController.editExpense);

// 4. Add an offline contribution
router.post('/contribution/offline', upload.array('proofs', 5), transactionController.addOfflineContribution);

// 5. Edit an existing contribution
router.put('/contribution/:contribution_id', upload.array('proofs', 5), transactionController.editContribution);

// 6. Fetch documents for the Gallery Modal
router.get('/expense/:expense_id/documents', transactionController.getExpenseDocuments);

module.exports = router;