import { prisma } from '../prisma';

const DEFAULT_REPORT_FEE_AUD = 65.0;
const SETTING_KEY_FEE = 'REPORT_FEE_AUD';

export interface PaymentAuthorisationResult {
  success: boolean;
  authorizationId?: string;
  orderId?: string;
  amount: number;
  currency: string;
  error?: string;
}

export interface PaymentCaptureResult {
  success: boolean;
  captureId?: string;
  amount: number;
  currency: string;
  error?: string;
}

/**
 * Gets current report fee from database settings (defaults to 65.00 AUD if not set).
 */
export async function getReportFeeAUD(): Promise<number> {
  try {
    const setting = await prisma.systemSettings.findUnique({
      where: { key: SETTING_KEY_FEE },
    });
    if (setting && !isNaN(parseFloat(setting.value))) {
      return parseFloat(setting.value);
    }
  } catch (error) {
    console.warn('Failed to read report fee from system settings, using default', error);
  }
  return DEFAULT_REPORT_FEE_AUD;
}

/**
 * Updates the admin configurable report fee in system settings.
 */
export async function setReportFeeAUD(amount: number): Promise<number> {
  await prisma.systemSettings.upsert({
    where: { key: SETTING_KEY_FEE },
    update: { value: amount.toFixed(2), updatedAt: new Date() },
    create: {
      key: SETTING_KEY_FEE,
      value: amount.toFixed(2),
      description: 'Default QEEG report analysis fee in AUD',
    },
  });
  return amount;
}

/**
 * Obtains an OAuth 2.0 Access Token from PayPal REST API.
 */
async function getPayPalAccessToken(): Promise<string> {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  const mode = process.env.PAYPAL_MODE || 'sandbox';
  const baseUrl = mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

  if (!clientId || !clientSecret) {
    // If credentials are not set, return mock token for local testing
    console.warn('PAYPAL_CLIENT_ID or PAYPAL_CLIENT_SECRET not configured. Using sandbox mock mode.');
    return 'MOCK_PAYPAL_ACCESS_TOKEN';
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetch(`${baseUrl}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!response.ok) {
    throw new Error(`PayPal OAuth failed: ${response.statusText}`);
  }

  const data: any = await response.json();
  return data.access_token;
}

/**
 * Authorises payment for a given case reference upon submission request.
 * Funds are NOT captured yet at this stage.
 */
export async function authorisePayment(
  caseReference: string,
  amountAUD?: number
): Promise<PaymentAuthorisationResult> {
  const fee = amountAUD ?? (await getReportFeeAUD());
  const clientId = process.env.PAYPAL_CLIENT_ID;

  if (!clientId) {
    // Mock authorization mode for testing environments
    const mockAuthId = `AUTH-MOCK-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    return {
      success: true,
      authorizationId: mockAuthId,
      orderId: `ORDER-MOCK-${caseReference}`,
      amount: fee,
      currency: 'AUD',
    };
  }

  try {
    const accessToken = await getPayPalAccessToken();
    const mode = process.env.PAYPAL_MODE || 'sandbox';
    const baseUrl = mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

    // Step 1: Create Order with AUTHORIZE intent
    const orderResponse = await fetch(`${baseUrl}/v2/checkout/orders`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        intent: 'AUTHORIZE',
        purchase_units: [
          {
            reference_id: caseReference,
            description: `QEEG Report Processing Fee - ${caseReference}`,
            amount: {
              currency_code: 'AUD',
              value: fee.toFixed(2),
            },
          },
        ],
      }),
    });

    const orderData: any = await orderResponse.json();

    if (!orderResponse.ok) {
      return {
        success: false,
        amount: fee,
        currency: 'AUD',
        error: orderData.message || 'PayPal order creation failed',
      };
    }

    // Step 2: Authorise Order
    const authResponse = await fetch(`${baseUrl}/v2/checkout/orders/${orderData.id}/authorize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    const authData: any = await authResponse.json();
    const authorizationId =
      authData.purchase_units?.[0]?.payments?.authorizations?.[0]?.id || `AUTH-${orderData.id}`;

    return {
      success: authResponse.ok,
      authorizationId,
      orderId: orderData.id,
      amount: fee,
      currency: 'AUD',
      error: authResponse.ok ? undefined : authData.message || 'PayPal authorisation failed',
    };
  } catch (error) {
    return {
      success: false,
      amount: fee,
      currency: 'AUD',
      error: error instanceof Error ? error.message : 'Unknown PayPal error',
    };
  }
}

/**
 * Captures an authorised payment AFTER the correlation engine successfully compiles the final report.
 */
export async function capturePayment(
  authorizationId: string,
  amountAUD: number
): Promise<PaymentCaptureResult> {
  const clientId = process.env.PAYPAL_CLIENT_ID;

  if (!clientId || authorizationId.startsWith('AUTH-MOCK-')) {
    // Mock capture mode for testing environments
    const mockCaptureId = `CAP-MOCK-${Date.now()}`;
    return {
      success: true,
      captureId: mockCaptureId,
      amount: amountAUD,
      currency: 'AUD',
    };
  }

  try {
    const accessToken = await getPayPalAccessToken();
    const mode = process.env.PAYPAL_MODE || 'sandbox';
    const baseUrl = mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

    const captureResponse = await fetch(`${baseUrl}/v2/payments/authorizations/${authorizationId}/capture`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: {
          currency_code: 'AUD',
          value: amountAUD.toFixed(2),
        },
        final_capture: true,
      }),
    });

    const captureData: any = await captureResponse.json();

    return {
      success: captureResponse.ok,
      captureId: captureData.id,
      amount: amountAUD,
      currency: 'AUD',
      error: captureResponse.ok ? undefined : captureData.message || 'PayPal capture failed',
    };
  } catch (error) {
    return {
      success: false,
      amount: amountAUD,
      currency: 'AUD',
      error: error instanceof Error ? error.message : 'Unknown capture error',
    };
  }
}

/**
 * Voids an authorised payment if report generation fails or is voided.
 */
export async function voidPayment(authorizationId: string): Promise<boolean> {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  if (!clientId || authorizationId.startsWith('AUTH-MOCK-')) {
    return true;
  }

  try {
    const accessToken = await getPayPalAccessToken();
    const mode = process.env.PAYPAL_MODE || 'sandbox';
    const baseUrl = mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

    const voidResponse = await fetch(`${baseUrl}/v2/payments/authorizations/${authorizationId}/void`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    return voidResponse.ok;
  } catch {
    return false;
  }
}
