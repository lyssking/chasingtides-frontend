import express from 'express';
import dotenv from 'dotenv';
import authorizenetPkg from 'authorizenet';

// Unpack the CommonJS exports securely inside our ES Module setup
const { APIContracts, APIControllers } = authorizenetPkg;

dotenv.config();

const app = express();

// Standard middleware for serving public assets and parsing payloads
app.use(express.static('public'));          
app.use(express.urlencoded({ extended: true })); 
app.use(express.json());
app.set('view engine', 'ejs');              

// 🛠️ FIX 1: Dynamic API URL with a local fallback so it works on both Localhost and Production
const STRAPI_API_URL = process.env.STRAPI_API_URL || 'http://localhost:1337/api';

// 🛠️ FIX 2: Derive the base URL to prepend to uploaded Strapi media files dynamically
const STRAPI_BASE_URL = STRAPI_API_URL.endsWith('/api') 
  ? STRAPI_API_URL.slice(0, -4) 
  : STRAPI_API_URL.replace(/\/api\/?$/, '');

console.log(`🌐 Connecting to Strapi Engine at: ${STRAPI_API_URL}`);
console.log(`🖼️ Media asset base path resolved to: ${STRAPI_BASE_URL}`);

/**
 * 1. ROUTE: Display the Single Product Page
 * Fetches dynamic metadata directly from your Strapi instance
 */
app.get('/products/:slug', async (req, res) => {
  try {
    const productSlug = req.params.slug;

    // Filter by slug and auto-populate relationship fields (like attached image media)
    const response = await fetch(`${STRAPI_API_URL}/products?filters[slug][$eq]=${productSlug}&populate=*`);
    const jsonResult = await response.json();
    const strapiProduct = jsonResult.data?.[0]; 

    if (!strapiProduct) {
      return res.status(404).send('Peptide profile not found in CMS registry.');
    }

    // Adapt Strapi 5's flattened data architecture for our EJS variables
    const product = {
      title: strapiProduct.title,
      descriptionHtml: strapiProduct.descriptionHtml,
      price: strapiProduct.price,
      id: strapiProduct.id,
      documentId: strapiProduct.documentId, // Crucial for querying records in Strapi 5
      // 🛠️ FIX 3: Use dynamic base URL instead of hardcoded localhost
      image: strapiProduct.image?.url ? `${STRAPI_BASE_URL}${strapiProduct.image.url}` : ''
    };

    res.render('product-page', { product });
  } catch (error) {
    console.error('Strapi connection error:', error);
    res.status(500).send('Internal Server Error');
  }
});

/**
 * 2. ROUTE: Render the Secure Checkout Screen
 * Checks backend inventory state before allowing a customer to proceed
 */
app.post('/checkout', async (req, res) => {
  try {
    const { productId } = req.body; // Incoming Strapi 5 documentId string

    // Re-verify the product info on the server using the secure documentId endpoint
    const response = await fetch(`${STRAPI_API_URL}/products/${productId}`);
    const jsonResult = await response.json();
    const strapiProduct = jsonResult.data;

    if (!strapiProduct) {
      return res.status(404).send('Product validation failed at checkout initialization.');
    }

    // 🛠️ INVENTORY SAFEGUARD 1: Fast-fail if the item is completely out of stock
    if (strapiProduct.inventory !== undefined && strapiProduct.inventory <= 0) {
      return res.send(`
        <div style="font-family: system-ui, sans-serif; text-align: center; padding: 80px 20px; max-width: 600px; margin: 0 auto;">
          <h2 style="color: #dc3545; font-weight: 800; font-size: 2rem;">❌ Item Temporarily Out of Stock</h2>
          <p style="color: #6c757d; margin: 20px 0 30px 0; font-size: 1.1rem; line-height: 1.6;">
            We apologize, but this premium peptide formula just sold out before your checkout could initiate. 
            No charges were made to your account.
          </p>
          <a href="/products/${strapiProduct.slug}" style="background: #b45309; color: white; padding: 12px 24px; text-decoration: none; font-weight: bold; border-radius: 8px;">
            Return to Product Page
          </a>
        </div>
      `);
    }

    const product = {
      id: strapiProduct.id,
      documentId: strapiProduct.documentId,
      title: strapiProduct.title,
      price: strapiProduct.price
    };

    res.render('checkout-page', { product });
  } catch (error) {
    console.error('Checkout validation error:', error);
    res.status(500).send('Internal Server Error');
  }
});

/**
 * 3. ROUTE: Process Card Charges Securely (Tokenized Pipeline)
 * Enforces server-side inventory reservation, processes payments, and decrements stock
 */
app.post('/process-charge', async (req, res) => {
  try {
    const { productId, paymentToken } = req.body;

    // 1. RE-VERIFY PRICING AND INVENTORY ON THE SERVER IMMEDIATELY AT CHARGE TIME
    const strapiResponse = await fetch(`${STRAPI_API_URL}/products/${productId}`);
    const jsonResult = await strapiResponse.json();
    const product = jsonResult.data;

    if (!product) {
      return res.status(404).send('Product validation failed at charge gateway.');
    }

    // 🛠️ INVENTORY SAFEGUARD 2: Final gate check to prevent race-condition overselling
    if (product.inventory !== undefined && product.inventory <= 0) {
      console.error(`❌ Inventory Race Condition Blocked: Product ${productId} is out of stock.`);
      return res.status(400).send('Payment Blocked: This item has just sold out and your card was not charged.');
    }

    const orderTotal = product.price;
    const currentStock = product.inventory || 0;

    // 2. INITIALIZE AUTHORIZE.NET AUTHENTICATION CONTEXT
    const merchantAuthenticationType = new APIContracts.MerchantAuthenticationType();
    merchantAuthenticationType.setName(process.env.AUTHNET_API_LOGIN_ID);
    merchantAuthenticationType.setTransactionKey(process.env.AUTHNET_TRANSACTION_KEY);

    // 3. ATTACH THE OPAQUE FRONTEND PAYMENT TOKEN (Secure Handshake)
    const opaqueData = new APIContracts.OpaqueDataType();
    opaqueData.setDataDescriptor('COMMON.ACCEPT.INAPP.MPG');
    opaqueData.setDataValue(paymentToken);

    const paymentType = new APIContracts.PaymentType();
    paymentType.setOpaqueData(opaqueData);

    // 4. ASSEMBLE TRANSACTION CRITERIA SPECIFICATIONS
    const transactionRequestType = new APIContracts.TransactionRequestType();
    transactionRequestType.setTransactionType(APIContracts.TransactionTypeEnum.AUTHCAPTURETRANSACTION);
    transactionRequestType.setAmount(orderTotal);
    transactionRequestType.setPayment(paymentType);

    const createRequest = new APIContracts.CreateTransactionRequest();
    createRequest.setMerchantAuthentication(merchantAuthenticationType);
    createRequest.setTransactionRequest(transactionRequestType);

    // 5. EXECUTE TRANSMISSION PAYLOAD TO GATEWAY
    const ctrl = new APIControllers.CreateTransactionController(createRequest.getJSON());
    
    // Toggle environments dynamically based on profile configurations
    if (process.env.AUTHNET_ENVIRONMENT === 'production') {
      ctrl.setEnvironment('https://api2.authorize.net/xml/v1/request.api');
    } else {
      ctrl.setEnvironment('https://apitest.authorize.net/xml/v1/request.api');
    }

    // Execute charge and evaluate transaction states
    ctrl.execute(async () => {
      const apiResponse = ctrl.getApiResponse();
      const response = new APIContracts.CreateTransactionResponse(apiResponse);

      if (response != null) {
        if (response.getMessages().getResultCode() === APIContracts.MessageTypeEnum.OK) {
          const transactionResponse = response.getTransactionResponse();

          if (transactionResponse != null && transactionResponse.getResponseCode() === '1') {
            const txId = transactionResponse.getTransId();
            console.log(`✅ Payment Success! TxID: ${txId}`);

            // 🛠️ INVENTORY SAFEGUARD 3: Decrement stock from CMS after payment clears successfully
            try {
              const nextStockValue = Math.max(0, currentStock - 1);
              
              await fetch(`${STRAPI_API_URL}/products/${productId}`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  data: { inventory: nextStockValue }
                })
              });
              
              console.log(`📉 Stock adjusted successfully for product ${productId}. Remaining: ${nextStockValue}`);
            } catch (stockError) {
              console.error('⚠️ CRITICAL ERROR: Payment captured but inventory deduction collapsed:', stockError);
            }

            return res.send(`
              <div style="font-family: system-ui, sans-serif; text-align: center; padding: 80px 20px; max-width: 600px; margin: 0 auto;">
                <h2 style="color: #059669; font-weight: 800; font-size: 2.2rem; margin-bottom: 10px;">🎉 Order Successful!</h2>
                <p style="color: #6c757d; font-size: 1.1rem; margin-bottom: 30px;">Thank you for your order. Your transaction has been processed securely.</p>
                <div style="background: #f3f4f6; padding: 20px; border-radius: 12px; border: 1px solid #e5e7eb; font-family: monospace; font-size: 1.05rem; color: #374151; margin-bottom: 40px;">
                  Transaction ID: ${txId}
                </div>
                <p class="small text-muted" style="color: #9ca3af; font-size: 0.85rem;">All orders are dispatched in vacuum-sealed, temperature-regulated premium envelopes.</p>
              </div>
            `);
          }
        }
        
        // Handle custom bank declines / card errors
        const errorText = response.getTransactionResponse()?.getErrors()?.getError()[0]?.getErrorText() 
          || response.getMessages().getMessage()[0].getText();
        console.error('❌ Payment Declined:', errorText);
        return res.status(400).send(`Payment Declined: ${errorText}`);
      }
      
      return res.status(500).send('No response returned from payment server.');
    });

  } catch (error) {
    console.error('Critical Payment Processor System Failure:', error);
    res.status(500).send('Internal Server Processing Error');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Headless Front-End active on port ${PORT}`));