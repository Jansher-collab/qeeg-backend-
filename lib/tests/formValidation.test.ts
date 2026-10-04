/**
 * MANDATORY-FIELD tests for the report request / profile validation.
 *
 * These cover the "every field is mandatory" requirement end to end at the
 * pure-function level: the browser refuses to submit an incomplete form, but
 * the browser is untrusted, so the server re-validates independently.
 *
 * Every clinical field is nullable in the database, so without this a crafted
 * request could persist a report with holes in it.
 *
 * These tests are pure - no Prisma, no PayPal, no network.
 */

import {
  validateProfileFields,
  validateReportRequestPayload,
  validateSignupFieldFormats,
  REQUIRED_PROFILE_FIELDS,
  type FieldError,
} from '../services/formValidation';
import { loadChecklistDefinition } from '../services/checklistDefinition';

let passed = 0;
let failed = 0;

function assert(condition: boolean, name: string): void {
  if (condition) {
    console.log(`  [PASS] ${name}`);
    passed += 1;
  } else {
    console.error(`  [FAIL] ${name}`);
    failed += 1;
  }
}

/** A complete, valid payload that individual tests then break one field at a time. */
function validChecklist(): Record<string, unknown> {
  const definition = loadChecklistDefinition();
  return {
    version: definition.version,
    domains: definition.domains.map((d) => ({ key: d.key, num: d.num, title: d.title, score: 2 })),
    severityScore: definition.domains.length * 2,
    recordingCondition: 'EC',
    recordingQuality: { quality_1: true, quality_2: true, quality_3: true, quality_4: true },
    additionalNotes: '',
    serviceAgreementAcknowledged: true,
    paymentAuthorisationAcknowledged: true,
    signature: 'Dr Jane Smith',
    dateSigned: '2026-10-04',
    // Profile-sourced fields that the definition also marks required.
    practitioner_full_name: 'Dr Jane Smith',
    practitioner_email: 'jane@clinic.com.au',
    professional_title: 'Senior Clinical Specialist',
    profession: 'Psychologist',
    provider_number: 'PSY000123',
    clinic_name: 'Riverside NeuroCare',
    phone: '+61 3 9820 1144',
    practice_address: 'Suite 4B, 120 Collins Street, Melbourne VIC 3000',
  };
}

function validPayload(): Record<string, unknown> {
  return {
    caseReference: 'CASE-TEST1',
    age: 34,
    gender: 'MALE',
    handedness: 'RIGHT',
    reliabilityScore: 0.94,
    tdtContent: '[PATIENT_INFO]\nAge=34\n',
    tovaData: { sessionLabel: 'Session 1', age: 34, adhdScore: 1.2 },
    checklistData: validChecklist(),
  };
}

/** Names of the fields reported missing for a given payload. */
function missingFields(payload: Record<string, unknown>): string[] {
  return validateReportRequestPayload(payload).errors.map((e: FieldError) => e.field);
}

console.log('\n=== PROFILE: every profile field is mandatory ===');
{
  const complete = {
    fullName: 'Dr Jane Smith',
    professionalTitle: 'Senior Clinical Specialist',
    profession: 'Psychologist',
    providerNumber: 'PSY000123',
    clinicName: 'Riverside NeuroCare',
    practiceAddress: 'Suite 4B, 120 Collins Street, Melbourne VIC 3000',
    phone: '+61 3 9820 1144',
  };
  assert(validateProfileFields(complete).passed, 'A fully populated profile passes');

  // Each required profile field, blanked in turn.
  let allCaught = true;
  for (const field of REQUIRED_PROFILE_FIELDS) {
    const partial = { ...complete, [field.key]: '   ' };
    const result = validateProfileFields(partial);
    if (result.passed || !result.errors.some((e) => e.field === field.key)) {
      allCaught = false;
      console.error(`      -> not caught: ${field.key}`);
    }
  }
  assert(allCaught, 'Every required profile field is rejected when blank or whitespace-only');

  // The specific historical trap: professional_title was optional at signup
  // but required by the checklist, permanently blocking a practitioner.
  const noTitle = { ...complete, professionalTitle: '' };
  const titleResult = validateProfileFields(noTitle);
  assert(
    !titleResult.passed &&
      titleResult.errors.some((e) => e.field === 'professionalTitle'),
    'A missing professional title is now rejected at signup (was a permanent block)'
  );

  assert(
    !validateProfileFields({ ...complete, phone: 'abc' }).passed,
    'A nonsense phone number is rejected'
  );
  assert(
    validateProfileFields({ ...complete, phone: '+61 3 9820 1144' }).passed,
    'A real phone number is accepted'
  );
}

console.log('\n=== REPORT: a complete payload passes ===');
{
  const result = validateReportRequestPayload(validPayload());
  assert(result.passed, 'A fully populated report request passes validation');
  if (!result.passed) console.error(`      unexpected: ${JSON.stringify(result.errors)}`);
}

console.log('\n=== REPORT: each top-level field is mandatory ===');
{
  const cases: [string, unknown][] = [
    ['caseReference', ''],
    ['age', ''],
    ['gender', ''],
    ['handedness', ''],
    ['reliabilityScore', ''],
    ['tdtContent', ''],
  ];

  let allCaught = true;
  for (const [field, blank] of cases) {
    const payload = validPayload();
    payload[field] = blank;
    if (!missingFields(payload).includes(field)) {
      allCaught = false;
      console.error(`      -> not caught: ${field}`);
    }
  }
  assert(allCaught, 'Every top-level field is rejected when blank');

  // Removed entirely (undefined), not just emptied.
  assert(
    missingFields({ ...validPayload(), age: undefined }).includes('age'),
    'A field omitted entirely is rejected, not treated as optional'
  );
  assert(
    missingFields({ ...validPayload(), handedness: undefined }).includes('handedness'),
    'An omitted handedness is rejected'
  );
}

console.log('\n=== REPORT: values are validated, not just present ===');
{
  const badAge = [0, -5, 999, Number.NaN, 'abc', {}];
  let allRejected = true;
  for (const age of badAge) {
    if (!missingFields({ ...validPayload(), age }).includes('age')) {
      allRejected = false;
      console.error(`      -> accepted bad age: ${JSON.stringify(age)}`);
    }
  }
  assert(allRejected, 'Absurd / NaN / non-numeric ages are all rejected');

  assert(
    !missingFields({ ...validPayload(), age: 34 }).includes('age'),
    'A valid age is accepted'
  );

  const badGenders = ['', 'M', 'unknown', 42, null];
  let gendersRejected = true;
  for (const gender of badGenders) {
    if (!missingFields({ ...validPayload(), gender }).includes('gender')) {
      gendersRejected = false;
      console.error(`      -> accepted bad gender: ${JSON.stringify(gender)}`);
    }
  }
  assert(gendersRejected, 'Gender values outside the MALE/FEMALE/OTHER enum are rejected');

  const badHandedness = ['', 'right-handed', 'MIDDLE', 7];
  let handednessRejected = true;
  for (const handedness of badHandedness) {
    if (!missingFields({ ...validPayload(), handedness }).includes('handedness')) {
      handednessRejected = false;
      console.error(`      -> accepted bad handedness: ${JSON.stringify(handedness)}`);
    }
  }
  assert(handednessRejected, 'Handedness values outside the enum are rejected');

  assert(
    missingFields({ ...validPayload(), reliabilityScore: 1.5 }).includes('reliabilityScore'),
    'A reliability score above 1.0 is rejected'
  );
}

console.log('\n=== REPORT: TOVA and checklist bodies are mandatory ===');
{
  const noTova = validPayload();
  delete noTova.tovaData;
  assert(missingFields(noTova).includes('tovaData'), 'A missing TOVA body is rejected');

  const stringTova = validPayload();
  stringTova.tovaData = 'not-an-object';
  assert(missingFields(stringTova).includes('tovaData'), 'A non-object TOVA body is rejected');

  for (const blank of [undefined, null, '', 'nope', []]) {
    const payload = validPayload();
    payload.checklistData = blank;
    assert(
      missingFields(payload).includes('checklistData'),
      `checklistData is rejected when set to ${JSON.stringify(blank) ?? 'undefined'}`
    );
  }
}

console.log('\n=== REPORT: every symptom domain must be rated ===');
{
  const definition = loadChecklistDefinition();

  const unrated = validChecklist();
  unrated.domains = (unrated.domains as Record<string, unknown>[]).slice(1);
  const fields = missingFields({ ...validPayload(), checklistData: unrated });
  assert(
    fields.includes(`domain:${definition.domains[0].key}`),
    'A missing domain rating is reported against that domain'
  );

  const outOfRange = validChecklist();
  (outOfRange.domains as Record<string, unknown>[])[0] = {
    key: definition.domains[0].key,
    num: definition.domains[0].num,
    title: definition.domains[0].title,
    score: 9,
  };
  assert(
    missingFields({ ...validPayload(), checklistData: outOfRange }).includes(
      `domain:${definition.domains[0].key}`
    ),
    'A domain scored outside 0-4 is rejected'
  );

  const noDomains = validChecklist();
  noDomains.domains = [];
  const allMissing = missingFields({ ...validPayload(), checklistData: noDomains });
  assert(
    definition.domains.every((d) => allMissing.includes(`domain:${d.key}`)),
    'An empty ratings array reports EVERY domain as unrated'
  );
}

console.log('\n=== REPORT: statutory acknowledgements must be affirmative ===');
{
  const noAgreement = validChecklist();
  noAgreement.serviceAgreementAcknowledged = false;
  assert(
    missingFields({ ...validPayload(), checklistData: noAgreement }).includes(
      'service_agreement_ack'
    ),
    'An unchecked service agreement is rejected'
  );

  const noPayment = validChecklist();
  noPayment.paymentAuthorisationAcknowledged = false;
  assert(
    missingFields({ ...validPayload(), checklistData: noPayment }).includes('payment_auth_ack'),
    'An unchecked payment authorisation is rejected'
  );

  const stringy = validChecklist();
  stringy.paymentAuthorisationAcknowledged = 'true';
  assert(
    missingFields({ ...validPayload(), checklistData: stringy }).includes('payment_auth_ack'),
    'A string "true" is not accepted in place of a boolean acknowledgement'
  );
}

console.log('\n=== REPORT: sign-off fields are mandatory ===');
{
  for (const key of ['signature', 'date_signed']) {
    const blank = validChecklist();
    blank[key] = '   ';
    assert(
      missingFields({ ...validPayload(), checklistData: blank }).includes(key),
      `${key} is rejected when whitespace-only`
    );
  }

  const noCondition = validChecklist();
  noCondition.recordingCondition = '';
  assert(
    missingFields({ ...validPayload(), checklistData: noCondition }).includes('recording_condition'),
    'A missing QEEG recording condition is rejected'
  );
}

console.log('\n=== REPORT: errors are complete and actionable ===');
{
  // Break everything at once; the practitioner should see all of it at once.
  const wrecked = {
    caseReference: '',
    age: '',
    gender: '',
    handedness: '',
    reliabilityScore: '',
    tdtContent: '',
    tovaData: null,
    checklistData: null,
  };
  const result = validateReportRequestPayload(wrecked);
  assert(!result.passed, 'An entirely empty request fails');
  assert(result.errors.length >= 7, `Every missing field is reported at once (got ${result.errors.length})`);
  assert(
    result.errors.every((e) => typeof e.field === 'string' && e.field.length > 0),
    'Every error carries a machine-readable field key'
  );
  assert(
    result.errors.every((e) => typeof e.label === 'string' && e.label.length > 0),
    'Every error carries a human-readable label for the UI'
  );
  assert(
    result.errors.every((e) => typeof e.message === 'string' && e.message.length > 0),
    'Every error carries a human-readable message'
  );
}

console.log('\n=== REPORT: source-bound fields are validated at the top level ===');
{
  // `professional_title` and friends carry a `source` binding of `profile.*`:
  // they are NOT copied into the checklist body. The validator must therefore
  // check them on the profile (signup/update) and NOT expect them here -
  // otherwise a perfectly valid request reports every bound field as missing.
  const bodyOnly = validChecklist();
  delete bodyOnly.professional_title;
  const fields = missingFields({ ...validPayload(), checklistData: bodyOnly });
  assert(
    !fields.includes('professional_title'),
    'A source-bound profile field is not demanded inside the checklist body'
  );
  assert(
    validateProfileFields({ professionalTitle: '' }).errors.some((e) => e.field === 'professionalTitle'),
    '...it is instead demanded on the profile, where it actually lives'
  );
}

console.log('\n=== SIGNUP ONLY: field-level format rules ===');

// These rules apply to the Signup / Register form ONLY. They must not leak
// into the portal profile form, so every case below also asserts that
// `validateProfileFields` - which backs PUT /api/practitioner/profile - stays
// permissive for the same input.
const signupFormatFields = (input: Record<string, unknown>): string[] =>
  validateSignupFieldFormats(input).errors.map((e) => e.field);

/**
 * A profile that passes `validateProfileFields` on its own. Isolation checks
 * overlay their offending values onto THIS, so the only reason a case can fail
 * is the format rule under test - not five unrelated blank mandatory fields.
 */
const COMPLETE_PROFILE = {
  fullName: 'Dr Jane Doe',
  professionalTitle: 'Psychologist MClinClinPsy',
  profession: 'Clinical Psychologist',
  providerNumber: 'PSY0001234567',
  clinicName: 'Mindful Health',
  practiceAddress: 'Suite 4B, 120 Collins Street, Melbourne VIC 3000',
  phone: '+61 3 9820 1144',
};

const profileAccepts = (overrides: Record<string, unknown>): boolean =>
  validateProfileFields({ ...COMPLETE_PROFILE, ...overrides }).passed;

// ---- Phone: digits / spaces / + / - / parentheses only; NO letters ----------

assert(
  validateSignupFieldFormats({ phone: '+61 3 9820 1144' }).passed,
  'Phone accepts an international AU format (+61 3 9820 1144)'
);
assert(
  validateSignupFieldFormats({ phone: '(03) 9820-1144' }).passed,
  'Phone accepts parentheses, hyphen and spaces'
);
assert(
  signupFormatFields({ phone: '9820abc1144' }).includes('phone'),
  'Phone rejects alphabetic letters'
);
assert(
  validateSignupFieldFormats({ phone: 'abc1234567' }).errors[0]?.message ===
    'Please enter a valid phone number without letters.',
  'Phone letter-rejection uses its own explicit message'
);
assert(
  signupFormatFields({ phone: '9820#1144' }).includes('phone'),
  'Phone rejects other symbols (#)'
);
assert(
  signupFormatFields({ phone: '9820@1144' }).includes('phone'),
  'Phone rejects @'
);
assert(
  signupFormatFields({ phone: '9820' }).includes('phone'),
  'Phone rejects fewer than 7 digits'
);
assert(
  validateSignupFieldFormats({ phone: '' }).passed,
  'Phone reports blankness as "required" (via validateProfileFields), not as a format error'
);

// ---- Provider number: alphanumeric ALLOWED ------------------------------

assert(
  validateSignupFieldFormats({ providerNumber: 'MED0001234567' }).passed,
  'Provider number accepts a letter-prefixed AHPRA number (MED0001234567)'
);
assert(
  validateSignupFieldFormats({ providerNumber: 'PSY000123' }).passed,
  'Provider number accepts an all-letter-prefixed number'
);
assert(
  validateSignupFieldFormats({ providerNumber: '1234567' }).passed,
  'Provider number accepts digits only'
);
assert(
  validateSignupFieldFormats({ providerNumber: 'PR-88921-VIC / PSY000123' }).passed,
  'Provider number accepts the documented "PR-88921-VIC / PSY000123" style'
);
assert(
  signupFormatFields({ providerNumber: 'MED#000123' }).includes('providerNumber'),
  'Provider number rejects stray symbols'
);
assert(
  signupFormatFields({ providerNumber: 'MED000$123' }).includes('providerNumber'),
  'Provider number rejects $'
);

// ---- Email ---------------------------------------------------------------

assert(
  validateSignupFieldFormats({ email: 'practitioner@clinic.com.au' }).passed,
  'Email accepts a normal business address'
);
assert(validateSignupFieldFormats({ email: 'a@b.co' }).passed, 'Email accepts a short TLD');
assert(signupFormatFields({ email: 'practitioner' }).includes('email'), 'Email rejects a bare word');
assert(signupFormatFields({ email: 'practitioner@' }).includes('email'), 'Email rejects a missing domain');
assert(signupFormatFields({ email: 'practitioner@clinic' }).includes('email'), 'Email rejects a missing TLD');
assert(signupFormatFields({ email: 'a@b@c.com' }).includes('email'), 'Email rejects two @ signs');
assert(signupFormatFields({ email: '.practitioner@x.com' }).includes('email'), 'Email rejects a leading dot in the local part');
assert(signupFormatFields({ email: 'practitioner.@x.com' }).includes('email'), 'Email rejects a trailing dot in the local part');
assert(signupFormatFields({ email: 'practitioner..b@x.com' }).includes('email'), 'Email rejects a doubled dot in the local part');
assert(
  validateSignupFieldFormats({ email: 'practitioner@x.com ' }).passed,
  'Email tolerates surrounding whitespace'
);
assert(
  validateSignupFieldFormats({ email: '  practitioner@x.com  ' }).passed,
  'Email is trimmed before validation'
);
assert(validateSignupFieldFormats({ email: '' }).passed, 'Blank email reports "required", not a format error');

// ---- Password -------------------------------------------------------------

assert(
  validateSignupFieldFormats({ password: '12345678' }).passed,
  'Password accepts exactly 8 characters'
);
assert(signupFormatFields({ password: '1234567' }).includes('password'), 'Password rejects 7 characters');
assert(validateSignupFieldFormats({ password: '' }).passed, 'Blank password reports "required", not a format error');

// ---- Multiple problems are reported together ------------------------------

const multi = signupFormatFields({
  phone: 'abc',
  providerNumber: 'BAD#',
  email: 'nope',
  password: '1',
});
assert(
  multi.length === 4 && ['phone', 'providerNumber', 'email', 'password'].every((k) => multi.includes(k)),
  'All four format problems are reported in a single pass'
);

// ---- ISOLATION: these rules must not reach the profile-update form ---------

// Probe with a phone that SATISFIES the shared digit-count guard (11 digits)
// but still violates the signup-only character rule (it contains letters).
// Using 'abc' here would prove nothing: it has 0 digits, so BOTH validators
// reject it and the assertion would pass for the wrong reason.
const LETTERED_BUT_LONG_ENOUGH = '9820abc1144';

assert(
  validateSignupFieldFormats({ phone: LETTERED_BUT_LONG_ENOUGH }).errors.some((e) => e.field === 'phone'),
  'A lettered-but-digit-rich phone is rejected by the signup rules'
);
assert(
  profileAccepts({ phone: LETTERED_BUT_LONG_ENOUGH }),
  'ISOLATION: that same phone is still tolerated by the profile-update form'
);
assert(
  profileAccepts({
    phone: LETTERED_BUT_LONG_ENOUGH,
    providerNumber: 'BAD#',
    email: 'nope',
    password: '1',
  }),
  'ISOLATION: the portal profile form is NOT affected by any signup format rule'
);
// The shared digit-count rule still applies on BOTH paths.
assert(
  !profileAccepts({ phone: '9820' }),
  'The pre-existing 7-digit floor is preserved on the profile form'
);

console.log(`\nTEST RESULTS: ${passed} / ${passed + failed} tests passed.`);
if (failed > 0) {
  console.error(`FAILURE: ${failed} mandatory-field test(s) failed.`);
  process.exit(1);
}
console.log('SUCCESS: ALL MANDATORY FIELD TESTS PASSED CLEANLY!');
