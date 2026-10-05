const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
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
const pushRoutes = require('./routes/push.routes'); // <-- Import here

const app = express();

// ==========================================
// SOCKET.IO BRIDGE MIDDLEWARE
// ==========================================
app.use((req, res, next) => {
    req.io = req.app.get('io');
    next();
});

// ==========================================
// MIDDLEWARES (Must come before routes!)
// ==========================================
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(morgan('dev'));

// ==========================================
// MOUNT ROUTES
// ==========================================
// Mount the new Push route HERE, after express.json()
app.use('/api/push', pushRoutes);

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
module.exports = app;