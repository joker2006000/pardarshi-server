const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const path = require('path');
const rateLimit = require('express-rate-limit'); 

// Route Imports
const authRoutes = require('./routes/auth.routes');
const organizationRoutes = require('./routes/organization.routes');
const memberRoutes = require('./routes/member.routes');
const projectRoutes = require('./routes/project.routes');
const paymentRoutes = require('./routes/payment.routes');
const formRoutes = require('./routes/form.routes');
const transactionRoutes = require('./routes/transaction.routes');
const publicRoutes = require('./routes/public.routes'); 

const app = express();

// ==========================================
// NEW: SOCKET.IO BRIDGE MIDDLEWARE
// ==========================================
// This grabs the 'io' instance from server.js and attaches it to 'req'.
// Your report.controller.js will use req.io to emit live messages.
app.use((req, res, next) => {
    req.io = req.app.get('io');
    next();
});

// Middlewares
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(morgan('dev'));

// Static files 
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Mount Protected Admin Routes
app.use('/api/auth', authRoutes);
app.use('/api/organization', organizationRoutes);
app.use('/api/member', memberRoutes);
app.use('/api/project', projectRoutes);
app.use('/api/payment', paymentRoutes);
app.use('/api/forms', formRoutes);
app.use('/api/transactions', transactionRoutes);

// Configure Rate Limiter for public endpoints
const publicLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, 
    max: 60, 
    message: { success: false, message: "Too many requests. Please try again in a minute." }
});

// Mount Public Routes with the Limiter
app.use('/api/public', publicLimiter, publicRoutes);

// Health Check
app.get('/', (req, res) => {
    res.send('PARDARSHI API is running...');
});

// Serve the dynamic form HTML file
app.get('/form/:public_slug', (req, res) => {
    res.sendFile(path.join(__dirname, '../../front end/public-form.html')); 
});

// Serve the payment status page
app.get('/payment-status', (req, res) => {
    res.sendFile(path.join(__dirname, '../../front end/payment-status.html'));
});

module.exports = app;