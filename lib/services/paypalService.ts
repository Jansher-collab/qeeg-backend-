import { prisma } from '../prisma';
import { fetchWithTimeout } from './timeout';

const DEFAULT_REPORT_FEE_AUD = 65.0;
const SETTING_KEY_FEE = 'REPORT_FEE_AUD';

const isProduction = process.env.NODE_ENV === 'production';

export type PayPalMode = 'live' | 'sandbox';

// Normalise the PAYPAL_MODE switch: 'live' or 'production' both mean the live
// REST endpoint; anything else (including unset) resolves to sandbox.
export function getPayPalMode(): PayPalMode {
  const mode = (process.env.PAYPAL_MODE || 'sandbox').toLowerCase();
  return mode === 'live' || mode === 'production' ? 'live' : 'sandbox';
}

/**
 * Resolves the PayPal credentials for the active mode without touching the
 * other mode's variables:
 *  - Live mode  — always the production PAYPAL_CLIENT_ID / PAYPAL_SECRET.
 *  - Sandbox    — prefers PAYPAL_SANDBOX_CLIENT_ID / PAYPAL_SANDBOX_SECRET,
 *                 falling back to the base PAYPAL_* pair when only one set
 *                 has been configured (safe: a live pair against the sandbox
 *                 endpoint is rejected by PayPal and never captures funds).
 */
export function getPayPalCredentials(): { clientId?: string; clientSecret?: string } {
  if (getPayPalMode() === 'live') {
    return {
      clientId: process.env.PAYPAL_CLIENT_ID,
      clientSecret: process.env.PAYPAL_SECRET,
    };
  }
  return {
    clientId: process.env.PAYPAL_SANDBOX_CLIENT_ID || process.env.PAYPAL_CLIENT_ID,
    clientSecret: process.env.PAYPAL_SANDBOX_SECRET || process.env.PAYPAL_SECRET,
  };
}

export function isPayPalConfigured(): boolean {
  const { clientId, clientSecret } = getPayPalCredentials();
  return Boolean(clientId && clientSecret);
}

function payPalBaseUrl(): string {
  return getPayPalMode() === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';
}

/**
 * In production, a missing PayPal configuration is a hard failure: mock
 * authorisations/captures/voids silently succeed and would report payments
 * that never happened. Guard every mock path with this check. Production must
 * run in live mode with the production credentials set.
 */
function assertPayPalConfigured(reason: string): void {
  if (!isProduction) return;
  if (getPayPalMode() !== 'live') {
    throw new Error(
      `PayPal is configured for sandbox mode in a production environment — ${reason}. Set PAYPAL_MODE=live and the production PAYPAL_CLIENT_ID/PAYPAL_SECRET before going live.`
    );
  }
  if (!process.env.PAYPAL_CLIENT_ID || !process.env.PAYPAL_SECRET) {
    throw new Error(
      `PayPal is not configured for production (PAYPAL_CLIENT_ID/PAYPAL_SECRET missing) — ${reason}. Set PAYPAL_MODE=live and both production credentials before going live.`
    );
  }
}

/**
 * Formats an amount as the strict two-decimal string PayPal's Orders v2 API
 * requires (e.g. 65 -> "65.00"). The `value` field must be a string, never a
 * bare number or scientific notation, or PayPal rejects it with a 422
 * BUSINESS_ERROR / value-not-valid validation error.
 */
function formatAmountToTwoDecimals(amount: number): string {
  return Number(amount).toFixed(2);
}

/**
 * Logs a failed PayPal API response in full — including the nested `details`
 * array and `debug_id` — so 422 business validation errors can be diagnosed.
 */
function logPayPalFailure(operation: string, status: number, payload: any): void {
  console.error(
    `[paypalService] ${operation} failed (HTTP ${status})`,
    JSON.stringify(
      {
        name: payload?.name ?? null,
        message: payload?.message ?? null,
        details: Array.isArray(payload?.details) ? payload.details : null,
        debug_id: payload?.debug_id ?? null,
        links: payload?.links ?? null,
      },
      null,
      2
    )
  );
}

/**
 * Builds a readable, diagnosable error string from PayPal's error payload.
 * Surfaces the top-level `message`, every `details[].description`, and the
 * `debug_id` for tracing the exact business validation issue.
 */
function buildPayPalErrorText(payload: any, fallback: string): string {
  if (!payload || typeof payload !== 'object') return fallback;

  const detailText = Array.isArray(payload.details)
    ? payload.details
        .map((d: any) => {
          if (!d) return '';
          const issueLabel = d.issue ? `${d.issue}: ` : '';
          return d.description
            ? `${issueLabel}${d.description}`
            : JSON.stringify(d);
        })
        .filter(Boolean)
        .join('; ')
    : '';

  const debugText = payload.debug_id ? ` [debug_id=${payload.debug_id}]` : '';

  return [payload.message, detailText].filter(Boolean).join(' — ') + debugText || fallback;
}

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

export interface PayPalOrderCreateResult {
  success: boolean;
  orderId?: string;
  amount: number;
  currency: string;
  error?: string;
}

/**
 * Creates a BRAND-NEW PayPal order (intent AUTHORIZE) with NO authorize/capture
 * step. This is the server-side source of truth for order creation: every
 * payment attempt or retry must call this so a stale/expired order id is never
 * reused (a reused id fails at authorize time with PayPal INVALID_RESOURCE_ID).
 *
 * The returned order id is handed to the frontend PayPalButtons.createOrder so
 * the buyer approves THIS specific fresh order; /api/reports/submit then
 * authorizes the same order server-side.
 */
export async function createPayPalOrder(
  caseReference: string,
  amountAUD?: number
): Promise<PayPalOrderCreateResult> {
  const fee = amountAUD ?? (await getReportFeeAUD());

  if (!isPayPalConfigured()) {
    assertPayPalConfigured('payment order creation');
    // Mock order mode — development only.
    return {
      success: true,
      orderId: `ORDER-MOCK-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      amount: fee,
      currency: 'AUD',
    };
  }

  try {
    const accessToken = await getPayPalAccessToken();
    const baseUrl = payPalBaseUrl();

    const orderResponse = await fetchWithTimeout(`${baseUrl}/v2/checkout/orders`, {
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
              // Must be a string with exactly two decimals, e.g. "65.00".
              value: formatAmountToTwoDecimals(fee),
            },
          },
        ],
        // Mirrors the application context that used to be supplied by the
        // client-side creation. Without shipping_preference NO_SHIPPING the
        // sandbox popup can push an address-verification step that derails the
        // approval flow for server-created orders.
        application_context: {
          brand_name: 'QEEG.com.au',
          shipping_preference: 'NO_SHIPPING',
          user_action: 'CONTINUE',
        },
      }),
    });

    const orderData: any = await orderResponse.json().catch(() => ({}));

    if (!orderResponse.ok) {
      logPayPalFailure('Create order (server-side)', orderResponse.status, orderData);
      return {
        success: false,
        amount: fee,
        currency: 'AUD',
        error: buildPayPalErrorText(orderData, 'PayPal order creation failed'),
      };
    }

    if (!orderData.id) {
      return {
        success: false,
        amount: fee,
        currency: 'AUD',
        error: 'PayPal order creation completed without a valid order id.',
      };
    }

    console.info(
      `[paypalService] Created fresh PayPal order ${orderData.id} for case ${caseReference} ` +
        `(${formatAmountToTwoDecimals(fee)} AUD, ${getPayPalMode()} mode, sandboxId=${Boolean(process.env.PAYPAL_SANDBOX_CLIENT_ID)}).`
    );

    return {
      success: true,
      orderId: orderData.id,
      amount: fee,
      currency: 'AUD',
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

export interface PayPalOrderSnapshot {
  exists: boolean;
  status?: string;
  referenceId?: string;
  authorizationId?: string;
  error?: string;
}

/**
 * Looks up an existing order under this account's access token. Used before
 * authorising to distinguish the classic INVALID_RESOURCE_ID cases:
 *  - order was created under a different app/credentials → not found here;
 *  - order was already authorised (status COMPLETED) → idempotent retry;
 *  - order is still APPROVED → safe to authorise.
 */
export async function getPayPalOrder(
  orderId: string
): Promise<PayPalOrderSnapshot> {
  if (!orderId || typeof orderId !== 'string' || !orderId.trim()) {
    return { exists: false, error: 'No PayPal order id supplied.' };
  }

  if (!isPayPalConfigured()) {
    // Mock-mode development: report the mock order as existing so the
    // authorised flow proceeds exactly as it would in a real sandbox.
    const orderIdTrimmed = orderId.trim();
    return {
      exists: orderIdTrimmed.startsWith('ORDER-MOCK-') || orderIdTrimmed.startsWith('AUTH-MOCK-'),
      status: 'CREATED',
    };
  }

  try {
    const accessToken = await getPayPalAccessToken();
    const res = await fetchWithTimeout(
      `${payPalBaseUrl()}/v2/checkout/orders/${encodeURIComponent(orderId.trim())}`,
      {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
      }
    );

    if (!res.ok) {
      const data: any = await res.json().catch(() => ({}));
      logPayPalFailure(`Lookup order ${orderId}`, res.status, data);
      return {
        exists: false,
        error: buildPayPalErrorText(
          data,
          `PayPal order ${orderId} could not be looked up (HTTP ${res.status}).`
        ),
      };
    }

    const data: any = await res.json();
    return {
      exists: true,
      status: typeof data?.status === 'string' ? data.status : undefined,
      referenceId:
        typeof data?.purchase_units?.[0]?.reference_id === 'string'
          ? data.purchase_units[0].reference_id
          : undefined,
      authorizationId:
        typeof data?.purchase_units?.[0]?.payments?.authorizations?.[0]?.id === 'string'
          ? data.purchase_units[0].payments.authorizations[0].id
          : undefined,
    };
  } catch (error) {
    return {
      exists: false,
      error: error instanceof Error ? error.message : 'PayPal order lookup failed',
    };
  }
}

export interface AuthorizeOrderExpectations {
  /** Case the order must have been created for (its purchase unit reference_id). */
  caseReference?: string;
}

export interface AuthorizeOrderResult {
  success: boolean;
  authorizationId?: string;
  idempotent?: boolean;
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
  const { clientId, clientSecret } = getPayPalCredentials();
  const baseUrl = payPalBaseUrl();

  if (!clientId || !clientSecret) {
    assertPayPalConfigured('unable to obtain an access token');
    // Development fallback only — never reached in production.
    console.warn(`PayPal credentials not configured for ${getPayPalMode()} mode. Using mock token.`);
    return 'MOCK_PAYPAL_ACCESS_TOKEN';
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetchWithTimeout(`${baseUrl}/v1/oauth2/token`, {
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

  if (!isPayPalConfigured()) {
    assertPayPalConfigured('payment authorisation');
    // Mock authorization mode — development only.
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
    const baseUrl = payPalBaseUrl();

    // Step 1: Create Order with AUTHORIZE intent
    const orderResponse = await fetchWithTimeout(`${baseUrl}/v2/checkout/orders`, {
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
              // Must be a string with exactly two decimals, e.g. "65.00".
              value: formatAmountToTwoDecimals(fee),
            },
          },
        ],
      }),
    });

    const orderData: any = await orderResponse.json().catch(() => ({}));

    if (!orderResponse.ok) {
      logPayPalFailure('Create order', orderResponse.status, orderData);
      return {
        success: false,
        amount: fee,
        currency: 'AUD',
        error: buildPayPalErrorText(orderData, 'PayPal order creation failed'),
      };
    }

    // Step 2: Authorise Order
    const authResponse = await fetchWithTimeout(`${baseUrl}/v2/checkout/orders/${orderData.id}/authorize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    const authData: any = await authResponse.json().catch(() => ({}));

    if (!authResponse.ok) {
      logPayPalFailure('Authorise order', authResponse.status, authData);
      return {
        success: false,
        amount: fee,
        currency: 'AUD',
        error: buildPayPalErrorText(authData, 'PayPal authorisation failed'),
      };
    }

    const authorizationId =
      authData.purchase_units?.[0]?.payments?.authorizations?.[0]?.id;

    if (!authorizationId) {
      return {
        success: false,
        amount: fee,
        currency: 'AUD',
        error: 'PayPal authorisation completed without a valid authorization id.',
      };
    }

    return {
      success: true,
      authorizationId,
      orderId: orderData.id,
      amount: fee,
      currency: 'AUD',
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
 * Authorises an order that was created by the buyer through the PayPal JS SDK
 * (intent AUTHORIZE). This must run server-side: the frontend must not keep the
 * SDK popup's postrobot bridge open across a slow backend round-trip, otherwise
 * PayPal throws "Window closed for postrobot_method before response" when the
 * popup closes while the address-verification handshake is still pending.
 *
 * Operates on the approved order id: `POST /v2/checkout/orders/{id}/authorize`.
 *
 * INVALID_RESOURCE_ID hardening — before authorising we verify the order still
 * exists under this account's token, is linked to the expected case, and is in
 * the authorised state:
 *  - a fresh/successful retry that re-uses a now-used order would otherwise
 *    fail with "Specified resource ID does not exist" at PayPal; if the order
 *    shows an existing authorisation we recover idempotently instead;
 *  - an order created under a different app/credentials fails fast here with a
 *    clear "fresh order required" message instead of an opaque PayPal error.
 */
export async function authorizePayPalOrder(
  orderId: string,
  expected?: AuthorizeOrderExpectations
): Promise<AuthorizeOrderResult> {
  if (!orderId || typeof orderId !== 'string' || !orderId.trim()) {
    return { success: false, error: 'A valid PayPal order id is required to authorise payment.' };
  }

  if (!isPayPalConfigured()) {
    assertPayPalConfigured('payment authorisation');
    const mockAuthId = `AUTH-MOCK-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    return { success: true, authorizationId: mockAuthId, error: undefined };
  }

  try {
    const accessToken = await getPayPalAccessToken();
    const baseUrl = payPalBaseUrl();
    const targetOrderId = orderId.trim();

    // Step 1 — verify the order still exists and belongs to this checkout.
    const snapshot = await getPayPalOrder(targetOrderId);
    if (!snapshot.exists) {
      console.error(
        `[paypalService] Order ${targetOrderId} does not exist for authorisation` +
          (snapshot.error ? ` (${snapshot.error}).` : ' — verifying against current account.' )
      );
      return {
        success: false,
        error: `PayPal order ${targetOrderId} could not be found for authorisation on this account. ` +
          'The order may already have been used or was created under another client. ' +
          'Please retry the payment — a fresh order will be issued automatically.',
      };
    }

    if (expected?.caseReference && snapshot.referenceId && snapshot.referenceId !== expected.caseReference) {
      console.error(
        `[paypalService] Order ${targetOrderId} was created for case ${snapshot.referenceId}, not ${expected.caseReference} — refusing to authorise mismatched order.`
      );
      return {
        success: false,
        error: `PayPal order ${targetOrderId} belongs to case ${snapshot.referenceId}, not ${expected.caseReference}. ` +
          'Please retry the payment so a fresh order is issued for this case.',
      };
    }

    // Step 2 — idempotent recovery. If this order was ALREADY authorised (a
    // prior submit reached PayPal but its HTTP response was lost/never
    // delivered), re-authorising would return INVALID_RESOURCE_ID. Reuse the
    // existing authorisation so a retry succeeds instead of dead-ending.
    if (snapshot.status === 'COMPLETED' && snapshot.authorizationId) {
      console.info(
        `[paypalService] Order ${targetOrderId} is already authorised (${snapshot.authorizationId}); treating as an idempotent success (case=${snapshot.referenceId ?? 'unknown'}).`
      );
      return { success: true, authorizationId: snapshot.authorizationId, idempotent: true, error: undefined };
    }

    if (snapshot.status !== 'APPROVED') {
      console.error(
        `[paypalService] Order ${targetOrderId} is not authorisable (status=${snapshot.status ?? 'unknown'}).`
      );
      return {
        success: false,
        error: `PayPal order ${targetOrderId} is not in an authorisable state (status=${snapshot.status ?? 'unknown'}). ` +
          'Please retry the payment — a fresh order will be issued automatically.',
      };
    }

    console.info(
      `[paypalService] Authorising approved order ${targetOrderId} (case=${snapshot.referenceId ?? 'unknown'}).`
    );

    // Step 3 — authorise the verified, APPROVED order.
    const authResponse = await fetchWithTimeout(`${baseUrl}/v2/checkout/orders/${encodeURIComponent(targetOrderId)}/authorize`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    const authData: any = await authResponse.json().catch(() => ({}));

    if (!authResponse.ok) {
      logPayPalFailure('Authorise approved order', authResponse.status, authData);
      // Second-chance diagnosis: re-fetch the order to capture its true state
      // (used? expired? created under another app?) so the INVALID_RESOURCE_ID
      // family is fully explained in the logs.
      const recheck = await getPayPalOrder(targetOrderId).catch(
        () => ({ exists: false, status: undefined as string | undefined })
      );
      console.error(
        `[paypalService] Authorise failed for ${targetOrderId} (HTTP ${authResponse.status}); order recheck:`,
        JSON.stringify({ exists: recheck?.exists, status: recheck?.status ?? null })
      );
      return {
        success: false,
        error: buildPayPalErrorText(
          authData,
          `PayPal authorisation failed (${authResponse.status} ${authResponse.statusText}).`
        ),
      };
    }

    const authorizationId = authData.purchase_units?.[0]?.payments?.authorizations?.[0]?.id;

    if (!authorizationId) {
      return {
        success: false,
        error: 'PayPal authorisation completed without a valid authorization id.',
      };
    }

    console.info(
      `[paypalService] Order ${targetOrderId} authorised successfully → authorizationId=${authorizationId}.`
    );
    return { success: true, authorizationId, error: undefined };
  } catch (error) {
    return {
      success: false,
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
  if (!isPayPalConfigured() || authorizationId.startsWith('AUTH-MOCK-')) {
    assertPayPalConfigured('payment capture');
    // Mock capture mode for testing environments.
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
    const baseUrl = payPalBaseUrl();

    const captureResponse = await fetchWithTimeout(`${baseUrl}/v2/payments/authorizations/${authorizationId}/capture`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: {
          currency_code: 'AUD',
          value: formatAmountToTwoDecimals(amountAUD),
        },
        final_capture: true,
      }),
    });

    const captureData: any = await captureResponse.json().catch(() => ({}));

    if (!captureResponse.ok) {
      logPayPalFailure('Capture payment', captureResponse.status, captureData);
    }

    return {
      success: captureResponse.ok,
      captureId: captureData.id,
      amount: amountAUD,
      currency: 'AUD',
      error: captureResponse.ok
        ? undefined
        : buildPayPalErrorText(captureData, 'PayPal capture failed'),
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
  if (!isPayPalConfigured() || authorizationId.startsWith('AUTH-MOCK-')) {
    assertPayPalConfigured('payment void');
    return true;
  }

  try {
    const accessToken = await getPayPalAccessToken();
    const baseUrl = payPalBaseUrl();

    const voidResponse = await fetchWithTimeout(`${baseUrl}/v2/payments/authorizations/${authorizationId}/void`, {
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
