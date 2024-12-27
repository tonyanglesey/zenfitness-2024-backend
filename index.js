import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';


dotenv.config();

const PORT = process.env.PORT || 4000;
const stripe = Stripe(process.env.STRIPE_SK);
// Initialize Supabase client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

const app = express();
app.use(cors());

//add stripe webhook here
// This is your Stripe CLI webhook secret for testing your endpoint locally.
const endpointSecret = process.env.WEBHOOK_SECRET;

app.post('/webhook', express.raw({ type: 'application/json' }), async (request, response) => {
    const sig = request.headers['stripe-signature'];

    let event;

    try {
        event = stripe.webhooks.constructEvent(request.body, sig, endpointSecret);
    } catch (err) {
        console.error(`Webhook Error: ${err.message}`);
        response.status(400).send(`Webhook Error: ${err.message}`);
        return;
    }

    // Handle the event
    switch (event.type) {
        case 'invoice.payment_succeeded': {
            const invoicePaymentSucceeded = event.data.object;

            // Extract necessary data
            const customerEmail = invoicePaymentSucceeded.customer_email;
            const userId = invoicePaymentSucceeded.subscription_details?.metadata?.userId;

            if (!customerEmail || !userId) {
                console.error('Missing required metadata or customer email.');
                response.status(400).send('Bad Request: Missing data');
                return;
            }

            try {
                // Check if member already exists
                const { data: existingMember, error } = await supabase
                    .from('members')
                    .select('*')
                    .eq('email', customerEmail)
                    .single();

                if (error && error.code !== 'PGRST116') { // If error is not "No rows found"
                    throw error;
                }

                if (existingMember) {
                    // Update existing member
                    const { error: updateError } = await supabase
                        .from('members')
                        .update({
                            firebase_id: userId,
                            premium: 2,
                            customerId:invoicePaymentSucceeded.customer,
                        })
                        .eq('email', customerEmail);

                    if (updateError) {
                        throw updateError;
                    }

                    console.log(`Member updated: ${customerEmail}`);
                } else {
                    // Create a new member
                    const { error: insertError } = await supabase
                        .from('members')
                        .insert({
                            id: userId,
                            firebase_id: userId,
                            email: customerEmail,
                            premium: 2,
                            customerId: invoicePaymentSucceeded.customer,
                        });

                    if (insertError) {
                        throw insertError;
                    }

                    console.log(`New member created: ${customerEmail}`);
                }

                response.status(200).send('Member updated or created successfully.');
            } catch (dbError) {
                console.error('Database error:', dbError);
                response.status(500).send('Internal Server Error');
            }
            break;
        }

        case 'customer.subscription.deleted': {
            const subscriptionDeleted = event.data.object;
            const invoice = await stripe.invoices.retrieve(subscriptionDeleted.latest_invoice);
            // Extract necessary data
            const customerEmail = invoice.customer_email;
            const userId = subscriptionDeleted.metadata?.userId;

            if (!customerEmail || !userId) {
                console.error('Missing required metadata or customer email.');
                response.status(400).send('Bad Request: Missing data');
                return;
            }

            try {
                const { error: updateError } = await supabase
                    .from('members')
                    .update({
                        premium: 0,
                        customerId: subscriptionDeleted.customer,

                    })
                    .eq('email', customerEmail);

                if (updateError) {
                    throw updateError;
                }

                console.log(`Subscription canceled: ${customerEmail}. Premium reverted to 0.`);
                response.status(200).send('Subscription canceled and member updated.');
            } catch (dbError) {
                console.error('Database error:', dbError);
                response.status(500).send('Internal Server Error');
            }
            break;
        }

        case 'invoice.payment_failed': {
            const paymentFailed = event.data.object;

            // Extract necessary data
            const customerEmail = paymentFailed.customer_email;
            const userId = paymentFailed.metadata?.userId;

            if (!customerEmail || !userId) {
                console.error('Missing required metadata or customer email.');
                response.status(400).send('Bad Request: Missing data');
                return;
            }

            try {
                const { error: updateError } = await supabase
                    .from('members')
                    .update({
                        premium: 0,
                        customerId:paymentFailed.customer,
                    })
                    .eq('email', customerEmail);

                if (updateError) {
                    throw updateError;
                }

                console.log(`Payment failed: ${customerEmail}. Premium reverted to 0.`);
                response.status(200).send('Payment failed and member updated.');
            } catch (dbError) {
                console.error('Database error:', dbError);
                response.status(500).send('Internal Server Error');
            }
            break;
        }

        default: {
            console.log(`Unhandled event type ${event.type}`);
            response.status(200).send();
            break;
        }
    }
});


app.use(express.json());

app.post('/create-checkout-session', async (req, res) => {
    const { firebase_id,
        email,
        selectedPack } = req.body;
        let priceId;
        switch (selectedPack){
            case 'price_premium_monthly':
            case 'price_studio_premium_monthly':    
            {
                priceId = process.env.PRO_MONTHLY;
                break;
            }
            case 'price_premium_annual':
            case 'price_studio_premium_annual':
            {
                priceId = process.env.PRO_ANNUAL;
                break;
            }
            default:{
                priceId = process.env.PRO_MONTHLY;
                break;
            }

        }
        console.log(priceId);
    try {
        const session = await stripe.checkout.sessions.create({
            mode: 'subscription',
            payment_method_types: ['card'],
            line_items: [{ price: priceId, quantity: 1 }],
            success_url: `${process.env.FRONTEND_URL}/success`,
            cancel_url: `${process.env.FRONTEND_URL}/account/dashboard`,
            customer_email: email,
            subscription_data: {
                metadata: {
                    userId: firebase_id,
                    tier: selectedPack,
                }
            },
            metadata: {
                userId: firebase_id,
                tier: selectedPack,
            },
        });

        res.status(200).json({ url: session.url });
    } catch (err) {
        console.error('Error creating checkout session:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/create-billing-portal', async(req, res) => {
    try {
        const {customerId}=req.body;
        const session = await stripe.billingPortal.sessions.create({
            customer: customerId,
            return_url: `${process.env.FRONTEND_URL}/account/dashboard`, // Replace with your desired return URL
        });

        res.json({ url: session.url });
    } catch (error) {
        console.error('Error creating billing portal session:', error);
        res.status(500).json({ error: 'Unable to create billing portal session' });
    }
});

app.get('/', async (req, res) => {
    res.json({
        message:'server is running'
    })
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
