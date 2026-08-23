"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.generatePreFilledChecklistPDF = generatePreFilledChecklistPDF;
const pdf_lib_1 = require("pdf-lib");
/**
 * Generates a 4-page fillable AcroForm PDF (`QEEG_Symptom_Checklist.pdf`)
 * that precisely matches the layout, structure, and pre-fill specifications (Sections 3.1, 3.2, 4.3).
 */
async function generatePreFilledChecklistPDF(details) {
    const pdfDoc = await pdf_lib_1.PDFDocument.create();
    const form = pdfDoc.getForm();
    // Fonts
    const fontRegular = await pdfDoc.embedFont(pdf_lib_1.StandardFonts.Helvetica);
    const fontBold = await pdfDoc.embedFont(pdf_lib_1.StandardFonts.HelveticaBold);
    const fontOblique = await pdfDoc.embedFont(pdf_lib_1.StandardFonts.HelveticaOblique);
    // Modern UI Web Theme Palette (Dark Navy, Slate, Border Gray, Light Card Bg)
    const darkNavy = (0, pdf_lib_1.rgb)(0.086, 0.137, 0.231); // #16233B
    const slateText = (0, pdf_lib_1.rgb)(0.1, 0.15, 0.25); // #1E293B
    const slateLabel = (0, pdf_lib_1.rgb)(0.3, 0.38, 0.47); // #475569
    const borderGray = (0, pdf_lib_1.rgb)(0.886, 0.91, 0.941); // #E2E8F0
    const cardBg = (0, pdf_lib_1.rgb)(0.973, 0.98, 0.988); // #F8FAFC
    const inputBg = (0, pdf_lib_1.rgb)(1, 1, 1);
    const accentBlue = (0, pdf_lib_1.rgb)(0.145, 0.388, 0.921); // #2563EB
    const pageSize = [595.28, 841.89]; // Standard A4
    // Helper to draw standard Header Banner across all 4 pages
    const drawHeaderBanner = (page, pageNum, title, subtitle) => {
        const { width, height } = page.getSize();
        // Outer Header Box
        page.drawRectangle({
            x: 36,
            y: height - 85,
            width: width - 72,
            height: 52,
            color: darkNavy,
        });
        page.drawText('QEEG.COM.AU', {
            x: 48,
            y: height - 56,
            size: 13,
            font: fontBold,
            color: (0, pdf_lib_1.rgb)(1, 1, 1),
        });
        page.drawText(`  |  ${title.toUpperCase()}`, {
            x: 140,
            y: height - 56,
            size: 10,
            font: fontBold,
            color: (0, pdf_lib_1.rgb)(0.9, 0.94, 0.98),
        });
        page.drawText(subtitle, {
            x: 48,
            y: height - 72,
            size: 7.5,
            font: fontRegular,
            color: (0, pdf_lib_1.rgb)(0.75, 0.85, 0.95),
        });
        page.drawText(`Page ${pageNum} of 4`, {
            x: width - 96,
            y: height - 56,
            size: 8.5,
            font: fontBold,
            color: (0, pdf_lib_1.rgb)(1, 1, 1),
        });
    };
    // Helper to draw Footer across all 4 pages
    const drawFooter = (page, pageNum) => {
        const { width } = page.getSize();
        page.drawText(`QEEG.com.au Clinical Intake Payload  •  Page ${pageNum} of 4  •  Applied Neurosciences Pty Ltd  •  Sydney Sovereign Server (ap-southeast-2)`, {
            x: 36,
            y: 28,
            size: 7,
            font: fontRegular,
            color: slateLabel,
        });
    };
    // =========================================================================
    // PAGE 1 — REFERRING PRACTITIONER (PRE-FILLED) & DEMOGRAPHICS
    // =========================================================================
    const page1 = pdfDoc.addPage(pageSize);
    const { width, height } = page1.getSize();
    drawHeaderBanner(page1, 1, 'REFERRING PRACTITIONER & DEMOGRAPHICS', 'Section 3.1 & 3.2 Pre-Filled Referral Payload  •  Sydney Sovereign Infrastructure (ap-southeast-2)');
    // CARD 1: Practitioner Details (Pre-filled AcroForm TextFields)
    let yPos = height - 105;
    page1.drawRectangle({
        x: 36,
        y: yPos - 195,
        width: width - 72,
        height: 195,
        color: cardBg,
        borderColor: borderGray,
        borderWidth: 1,
    });
    page1.drawText('1. REFERRING PRACTITIONER DETAILS (AUTHENTICATED PRE-FILL)', {
        x: 48,
        y: yPos - 18,
        size: 9,
        font: fontBold,
        color: darkNavy,
    });
    // Fields inside Card 1:
    // Row 1: Name & Email
    page1.drawText('Practitioner Full Name *', { x: 48, y: yPos - 38, size: 8, font: fontBold, color: slateLabel });
    const fName = form.createTextField('practitioner_name');
    fName.setText(details.fullName || '');
    fName.addToPage(page1, { x: 48, y: yPos - 58, width: 240, height: 18 });
    fName.setFontSize(8.5);
    fName.enableRequired();
    page1.drawText('Login & Notification Email *', { x: 304, y: yPos - 38, size: 8, font: fontBold, color: slateLabel });
    const fEmail = form.createTextField('practitioner_email');
    fEmail.setText(details.email || details.practiceEmail || '');
    fEmail.addToPage(page1, { x: 304, y: yPos - 58, width: 236, height: 18 });
    fEmail.setFontSize(8.5);
    fEmail.enableRequired();
    // Row 2: Title & Profession
    page1.drawText('Professional Title / Credentials *', { x: 48, y: yPos - 80, size: 8, font: fontBold, color: slateLabel });
    const fCred = form.createTextField('practitioner_credentials');
    fCred.setText(details.professionalTitle || '');
    fCred.addToPage(page1, { x: 48, y: yPos - 100, width: 240, height: 18 });
    fCred.setFontSize(8.5);
    fCred.enableRequired();
    page1.drawText('Profession / Registration Type *', { x: 304, y: yPos - 80, size: 8, font: fontBold, color: slateLabel });
    const fProf = form.createTextField('practitioner_profession');
    fProf.setText(details.profession || '');
    fProf.addToPage(page1, { x: 304, y: yPos - 100, width: 236, height: 18 });
    fProf.setFontSize(8.5);
    fProf.enableRequired();
    // Row 3: Rego & Practice Name
    page1.drawText('Registration / Provider Number *', { x: 48, y: yPos - 122, size: 8, font: fontBold, color: slateLabel });
    const fRego = form.createTextField('practitioner_rego');
    fRego.setText(details.providerNumber || '');
    fRego.addToPage(page1, { x: 48, y: yPos - 142, width: 240, height: 18 });
    fRego.setFontSize(8.5);
    fRego.enableRequired();
    page1.drawText('Practice / Clinic Name *', { x: 304, y: yPos - 122, size: 8, font: fontBold, color: slateLabel });
    const fPracName = form.createTextField('practice_name');
    fPracName.setText(details.clinicName || '');
    fPracName.addToPage(page1, { x: 304, y: yPos - 142, width: 236, height: 18 });
    fPracName.setFontSize(8.5);
    fPracName.enableRequired();
    // Row 4: Phone & Address
    page1.drawText('Practice Contact Phone *', { x: 48, y: yPos - 164, size: 8, font: fontBold, color: slateLabel });
    const fPhone = form.createTextField('practice_phone');
    fPhone.setText(details.phone || '');
    fPhone.addToPage(page1, { x: 48, y: yPos - 184, width: 240, height: 18 });
    fPhone.setFontSize(8.5);
    fPhone.enableRequired();
    page1.drawText('Practice Address *', { x: 304, y: yPos - 164, size: 8, font: fontBold, color: slateLabel });
    const fPracAddr = form.createTextField('practice_address');
    fPracAddr.setText(details.practiceAddress || '');
    fPracAddr.addToPage(page1, { x: 304, y: yPos - 184, width: 236, height: 18 });
    fPracAddr.setFontSize(8.5);
    fPracAddr.enableRequired();
    // CARD 2: Case Reference & Client Demographics (Zero-PII Policy)
    yPos = yPos - 215;
    page1.drawRectangle({
        x: 36,
        y: yPos - 250,
        width: width - 72,
        height: 250,
        color: (0, pdf_lib_1.rgb)(0.99, 0.985, 0.96),
        borderColor: (0, pdf_lib_1.rgb)(0.92, 0.86, 0.75),
        borderWidth: 1,
    });
    page1.drawText('2. CASE REFERENCE & CLIENT DEMOGRAPHICS (ZERO-PII POLICY)', {
        x: 48,
        y: yPos - 20,
        size: 9,
        font: fontBold,
        color: (0, pdf_lib_1.rgb)(0.55, 0.28, 0.05),
    });
    page1.drawText('Do NOT enter patient full names or birthdates. Use Case Reference and Age/Gender metrics only.', {
        x: 48,
        y: yPos - 34,
        size: 7.5,
        font: fontRegular,
        color: (0, pdf_lib_1.rgb)(0.45, 0.22, 0.05),
    });
    // 2a. Case Reference
    page1.drawText('Case Reference (Populated at Submission) *', { x: 48, y: yPos - 56, size: 8, font: fontBold, color: darkNavy });
    const fCaseRef = form.createTextField('case_reference');
    fCaseRef.setText(''); // Left blank on generation
    fCaseRef.addToPage(page1, { x: 48, y: yPos - 76, width: 240, height: 18 });
    fCaseRef.setFontSize(8.5);
    // 2b. Client Age
    page1.drawText('Client Age (Years) *', { x: 304, y: yPos - 56, size: 8, font: fontBold, color: darkNavy });
    const fAge = form.createTextField('client_age');
    fAge.addToPage(page1, { x: 304, y: yPos - 76, width: 236, height: 18 });
    fAge.setFontSize(8.5);
    fAge.enableRequired();
    // 2c. Biological Gender Checkboxes
    page1.drawText('Biological Gender *', { x: 48, y: yPos - 106, size: 8, font: fontBold, color: darkNavy });
    const cbMale = form.createCheckBox('client_gender_male');
    cbMale.addToPage(page1, { x: 48, y: yPos - 124, width: 12, height: 12 });
    page1.drawText('Male', { x: 64, y: yPos - 122, size: 8, font: fontRegular, color: slateText });
    const cbFemale = form.createCheckBox('client_gender_female');
    cbFemale.addToPage(page1, { x: 120, y: yPos - 124, width: 12, height: 12 });
    page1.drawText('Female', { x: 136, y: yPos - 122, size: 8, font: fontRegular, color: slateText });
    const cbOtherGender = form.createCheckBox('client_gender_other');
    cbOtherGender.addToPage(page1, { x: 190, y: yPos - 124, width: 12, height: 12 });
    page1.drawText('Other / Intersex', { x: 206, y: yPos - 122, size: 8, font: fontRegular, color: slateText });
    // 2d. Handedness
    page1.drawText('Dominant Handedness', { x: 304, y: yPos - 106, size: 8, font: fontBold, color: darkNavy });
    const cbRight = form.createCheckBox('client_handedness_right');
    cbRight.addToPage(page1, { x: 304, y: yPos - 124, width: 12, height: 12 });
    page1.drawText('Right', { x: 320, y: yPos - 122, size: 8, font: fontRegular, color: slateText });
    const cbLeft = form.createCheckBox('client_handedness_left');
    cbLeft.addToPage(page1, { x: 370, y: yPos - 124, width: 12, height: 12 });
    page1.drawText('Left', { x: 386, y: yPos - 122, size: 8, font: fontRegular, color: slateText });
    const cbAmbi = form.createCheckBox('client_handedness_ambi');
    cbAmbi.addToPage(page1, { x: 430, y: yPos - 124, width: 12, height: 12 });
    page1.drawText('Ambidextrous', { x: 446, y: yPos - 122, size: 8, font: fontRegular, color: slateText });
    // 2e. Recording Condition State
    page1.drawText('QEEG Recording Condition *', { x: 48, y: yPos - 152, size: 8, font: fontBold, color: darkNavy });
    const cbEC = form.createCheckBox('recording_condition_ec');
    cbEC.addToPage(page1, { x: 48, y: yPos - 170, width: 12, height: 12 });
    page1.drawText('Eyes Closed (EC)', { x: 64, y: yPos - 168, size: 8, font: fontRegular, color: slateText });
    const cbEO = form.createCheckBox('recording_condition_eo');
    cbEO.addToPage(page1, { x: 180, y: yPos - 170, width: 12, height: 12 });
    page1.drawText('Eyes Open (EO)', { x: 196, y: yPos - 168, size: 8, font: fontRegular, color: slateText });
    const cbTask = form.createCheckBox('recording_condition_task');
    cbTask.addToPage(page1, { x: 304, y: yPos - 170, width: 12, height: 12 });
    page1.drawText('Continuous Task (TOVA)', { x: 320, y: yPos - 168, size: 8, font: fontRegular, color: slateText });
    // Instruction Notice Box
    page1.drawRectangle({
        x: 48,
        y: yPos - 235,
        width: 492,
        height: 50,
        color: (0, pdf_lib_1.rgb)(1, 1, 1),
        borderColor: borderGray,
        borderWidth: 1,
    });
    page1.drawText('CHECKLIST INSTRUCTIONS & COMPLIANCE RULES:', { x: 56, y: yPos - 198, size: 7.5, font: fontBold, color: darkNavy });
    page1.drawText('• Pages 2 & 3 contain 11 clinical domains with mandatory 0–4 Likert scale ratings (No blank domains accepted).', { x: 56, y: yPos - 210, size: 7, font: fontRegular, color: slateText });
    page1.drawText('• Page 4 requires Quality Verification, Statutory Service Agreement & PayPal $65.00 AUD Hold Authorisation.', { x: 56, y: yPos - 222, size: 7, font: fontRegular, color: slateText });
    drawFooter(page1, 1);
    // =========================================================================
    // PAGE 2 — QEEG RECORDING QUALITY DECLARATION & SYMPTOM DOMAINS (1 of 2)
    // =========================================================================
    const page2 = pdfDoc.addPage(pageSize);
    drawHeaderBanner(page2, 2, 'RECORDING QUALITY & SYMPTOM DOMAINS (1 OF 2)', 'Required Quality Verification & Forced Likert Scales 0–4  •  Domains 1 to 5');
    // CARD 1: QEEG Recording Quality Declaration
    let p2Y = height - 105;
    page2.drawRectangle({
        x: 36,
        y: p2Y - 140,
        width: width - 72,
        height: 140,
        color: cardBg,
        borderColor: borderGray,
        borderWidth: 1,
    });
    page2.drawText('3. QEEG RECORDING QUALITY & ARTIFACT DECLARATION', {
        x: 48,
        y: p2Y - 18,
        size: 9,
        font: fontBold,
        color: darkNavy,
    });
    // Quality Checkboxes quality_1 to quality_4
    const q1 = form.createCheckBox('quality_1');
    q1.addToPage(page2, { x: 48, y: p2Y - 42, width: 12, height: 12 });
    q1.enableRequired();
    page2.drawText('1. 10-20 System Placement Verification: Standard 19-channel electrode placement verified.', { x: 66, y: p2Y - 40, size: 7.5, font: fontBold, color: slateText });
    const q2 = form.createCheckBox('quality_2');
    q2.addToPage(page2, { x: 48, y: p2Y - 66, width: 12, height: 12 });
    q2.enableRequired();
    page2.drawText('2. Client Cooperation & Protocol Compliance: Client maintained quiet wakefulness during recording.', { x: 66, y: p2Y - 64, size: 7.5, font: fontBold, color: slateText });
    const q3 = form.createCheckBox('quality_3');
    q3.addToPage(page2, { x: 48, y: p2Y - 90, width: 12, height: 12 });
    q3.enableRequired();
    page2.drawText('3. Artifact Control & Filter: Ocular blinks, EMG muscle tension removed; Test/Retest reliability >= 0.80.', { x: 66, y: p2Y - 88, size: 7.5, font: fontBold, color: slateText });
    const q4 = form.createCheckBox('quality_4');
    q4.addToPage(page2, { x: 48, y: p2Y - 114, width: 12, height: 12 });
    q4.enableRequired();
    page2.drawText('4. Medication & Neuromodulator Status Disclosed: Psychoactive medications recorded in observations.', { x: 66, y: p2Y - 112, size: 7.5, font: fontBold, color: slateText });
    // CARD 2: Symptom Domains 1 to 5
    p2Y = p2Y - 155;
    page2.drawRectangle({
        x: 36,
        y: p2Y - 510,
        width: width - 72,
        height: 510,
        color: inputBg,
        borderColor: borderGray,
        borderWidth: 1,
    });
    page2.drawText('4. CLINICAL SYMPTOM DOMAINS (1 OF 2: DOMAINS 1 - 5)', {
        x: 48,
        y: p2Y - 18,
        size: 9,
        font: fontBold,
        color: darkNavy,
    });
    page2.drawText('Likert Scale: 0 = Not at all present   1 = Mild   2 = Moderate   3 = Marked   4 = Severe / Pervasive', {
        x: 48,
        y: p2Y - 32,
        size: 7.5,
        font: fontRegular,
        color: slateLabel,
    });
    const domainsPage2 = [
        {
            num: 1,
            key: 'domain_1',
            title: '1. Inattention',
            desc: 'Sustained focus deficit, distractibility, carelessness, task persistence failure',
        },
        {
            num: 2,
            key: 'domain_2',
            title: '2. Hyperactivity / Impulsivity',
            desc: 'Motor restlessness, impulse delay failure, verbal interruption, psychomotor agitation',
        },
        {
            num: 3,
            key: 'domain_3',
            title: '3. Anxiety',
            desc: 'Generalized worry, autonomic hyperarousal, panic episodes, somatic muscle tension',
        },
        {
            num: 4,
            key: 'domain_4',
            title: '4. Mood / Depression',
            desc: 'Persistent low mood, anhedonia, emotional lability, motivational withdrawal',
        },
        {
            num: 5,
            key: 'domain_5',
            title: '5. Rumination',
            desc: 'Repetitive negative thinking, cognitive hyper-fixation, perseveration, intrusive thoughts',
        },
    ];
    let domY = p2Y - 48;
    for (const d of domainsPage2) {
        page2.drawRectangle({
            x: 48,
            y: domY - 82,
            width: 492,
            height: 82,
            color: cardBg,
            borderColor: borderGray,
            borderWidth: 1,
        });
        page2.drawText(d.title, { x: 58, y: domY - 16, size: 8.5, font: fontBold, color: darkNavy });
        page2.drawText(d.desc, { x: 58, y: domY - 30, size: 7.5, font: fontRegular, color: slateLabel });
        page2.drawText('Selected Rating (0 - 4) *:', { x: 58, y: domY - 52, size: 7.5, font: fontBold, color: darkNavy });
        // Interactive AcroForm Likert options 0 to 4
        for (let rating = 0; rating <= 4; rating++) {
            const cbKey = `${d.key}_${rating}`;
            const cb = form.createCheckBox(cbKey);
            const xOffset = 180 + rating * 72;
            cb.addToPage(page2, { x: xOffset, y: domY - 56, width: 12, height: 12 });
            const labelText = `${rating} - ${['Absent', 'Mild', 'Mod', 'Marked', 'Severe'][rating]}`;
            page2.drawText(labelText, { x: xOffset + 16, y: domY - 54, size: 7.5, font: fontRegular, color: slateText });
        }
        // Text field fallback for domain numerical input
        const domTxt = form.createTextField(d.key);
        domTxt.addToPage(page2, { x: 485, y: domY - 74, width: 45, height: 16 });
        domTxt.setFontSize(8);
        page2.drawText('Rating Value:', { x: 430, y: domY - 71, size: 7, font: fontBold, color: slateLabel });
        domY -= 92;
    }
    drawFooter(page2, 2);
    // =========================================================================
    // PAGE 3 — SYMPTOM DOMAINS (2 of 2) & ADDITIONAL NOTES
    // =========================================================================
    const page3 = pdfDoc.addPage(pageSize);
    drawHeaderBanner(page3, 3, 'SYMPTOM DOMAINS (2 OF 2) & CLINICAL NOTES', 'Domains 6 to 11 (Forced Likert 0–4) & Additional Clinical Observations');
    let p3Y = height - 105;
    // CARD 1: Symptom Domains 6 to 11
    page3.drawRectangle({
        x: 36,
        y: p3Y - 560,
        width: width - 72,
        height: 560,
        color: inputBg,
        borderColor: borderGray,
        borderWidth: 1,
    });
    page3.drawText('5. CLINICAL SYMPTOM DOMAINS (2 OF 2: DOMAINS 6 - 11)', {
        x: 48,
        y: p3Y - 18,
        size: 9,
        font: fontBold,
        color: darkNavy,
    });
    page3.drawText('Likert Scale: 0 = Not at all present   1 = Mild   2 = Moderate   3 = Marked   4 = Severe / Pervasive', {
        x: 48,
        y: p3Y - 32,
        size: 7.5,
        font: fontRegular,
        color: slateLabel,
    });
    const domainsPage3 = [
        {
            num: 6,
            key: 'domain_6',
            title: '6. Emotional Regulation',
            desc: 'Affective volatility, low frustration tolerance, explosive dysregulation, mood reactivity',
        },
        {
            num: 7,
            key: 'domain_7',
            title: '7. Sleep Difficulties',
            desc: 'Sleep onset latency > 45m, frequent nocturnal waking, non-restorative sleep, diurnal fatigue',
        },
        {
            num: 8,
            key: 'domain_8',
            title: '8. Executive Function / Organisation',
            desc: 'Working memory deficit, mental flexibility, sequencing slowing, planning friction',
        },
        {
            num: 9,
            key: 'domain_9',
            title: '9. Oppositional / Behavioural Difficulties',
            desc: 'Defiance, rule-testing, reactivity, behavioral impulse control deficit, conduct friction',
        },
        {
            num: 10,
            key: 'domain_10',
            title: '10. Social Difficulties',
            desc: 'Pragmatic language friction, social cue interpretation delay, interpersonal withdrawal',
        },
        {
            num: 11,
            key: 'domain_11',
            title: '11. Sensory Processing',
            desc: 'Auditory / visual / tactile hypersensitivity, photophobia, sensory overload gating delay',
        },
    ];
    let domY3 = p3Y - 48;
    for (const d of domainsPage3) {
        page3.drawRectangle({
            x: 48,
            y: domY3 - 78,
            width: 492,
            height: 78,
            color: cardBg,
            borderColor: borderGray,
            borderWidth: 1,
        });
        page3.drawText(d.title, { x: 58, y: domY3 - 16, size: 8.5, font: fontBold, color: darkNavy });
        page3.drawText(d.desc, { x: 58, y: domY3 - 28, size: 7.5, font: fontRegular, color: slateLabel });
        page3.drawText('Selected Rating (0 - 4) *:', { x: 58, y: domY3 - 48, size: 7.5, font: fontBold, color: darkNavy });
        for (let rating = 0; rating <= 4; rating++) {
            const cbKey = `${d.key}_${rating}`;
            const cb = form.createCheckBox(cbKey);
            const xOffset = 180 + rating * 72;
            cb.addToPage(page3, { x: xOffset, y: domY3 - 52, width: 12, height: 12 });
            const labelText = `${rating} - ${['Absent', 'Mild', 'Mod', 'Marked', 'Severe'][rating]}`;
            page3.drawText(labelText, { x: xOffset + 16, y: domY3 - 50, size: 7.5, font: fontRegular, color: slateText });
        }
        const domTxt = form.createTextField(d.key);
        domTxt.addToPage(page3, { x: 485, y: domY3 - 70, width: 45, height: 16 });
        domTxt.setFontSize(8);
        page3.drawText('Rating Value:', { x: 430, y: domY3 - 67, size: 7, font: fontBold, color: slateLabel });
        domY3 -= 86;
    }
    // CARD 2: Additional Clinical Notes & Medications
    p3Y = p3Y - 575;
    page3.drawRectangle({
        x: 36,
        y: p3Y - 115,
        width: width - 72,
        height: 115,
        color: cardBg,
        borderColor: borderGray,
        borderWidth: 1,
    });
    page3.drawText('6. ADDITIONAL CLINICAL NOTES & MEDICATIONS (OPTIONAL)', {
        x: 48,
        y: p3Y - 18,
        size: 9,
        font: fontBold,
        color: darkNavy,
    });
    page3.drawText('Record psychoactive medications, previous neurofeedback protocols, or relevant clinical observations:', {
        x: 48,
        y: p3Y - 32,
        size: 7.5,
        font: fontRegular,
        color: slateLabel,
    });
    const fNotes = form.createTextField('additional_notes');
    fNotes.addToPage(page3, { x: 48, y: p3Y - 105, width: 492, height: 66 });
    fNotes.setFontSize(8.5);
    fNotes.enableMultiline();
    drawFooter(page3, 3);
    // =========================================================================
    // PAGE 4 — AI DISCLAIMER, SERVICE AGREEMENT, PAYMENT & SIGN-OFF
    // =========================================================================
    const page4 = pdfDoc.addPage(pageSize);
    drawHeaderBanner(page4, 4, 'SERVICE AGREEMENT, PAYMENT & SIGN-OFF', 'Statutory Compliance, PayPal $65.00 AUD Hold Authorisation & Practitioner Sign-Off');
    let p4Y = height - 105;
    // CARD 1: Clinical Decision Support & AI Generation Notice
    page4.drawRectangle({
        x: 36,
        y: p4Y - 145,
        width: width - 72,
        height: 145,
        color: (0, pdf_lib_1.rgb)(0.99, 0.985, 0.96),
        borderColor: (0, pdf_lib_1.rgb)(0.92, 0.86, 0.75),
        borderWidth: 1,
    });
    page4.drawText('7. CLINICAL DECISION SUPPORT & AUTOMATED SYNTHESIS NOTICE', {
        x: 48,
        y: p4Y - 18,
        size: 9,
        font: fontBold,
        color: (0, pdf_lib_1.rgb)(0.55, 0.28, 0.05),
    });
    const disclaimerLines = [
        'EXPLICIT MEDICAL & AI SYNTHESIS DISCLAIMER:',
        '• QEEG.com.au correlation reports are automated, evidence-linked literature synthesis documents',
        '  mapping QEEG spectral power deviations against peer-reviewed neuroimaging literature.',
        '• These reports DO NOT constitute human-reviewed medical advice, psychiatric diagnosis, or treatment',
        '  prescriptions.',
        '• The referring practitioner retains sole clinical responsibility for patient assessment, protocol selection,',
        '  and medical diagnostic decisions under Australian healthcare regulations.',
    ];
    let lineY = p4Y - 36;
    for (let i = 0; i < disclaimerLines.length; i++) {
        page4.drawText(disclaimerLines[i], {
            x: 48,
            y: lineY,
            size: i === 0 ? 8 : 7.5,
            font: i === 0 ? fontBold : fontRegular,
            color: i === 0 ? darkNavy : slateText,
        });
        lineY -= 14;
    }
    // CARD 2: Statutory Service Agreement & Payment Authorisation
    p4Y = p4Y - 160;
    page4.drawRectangle({
        x: 36,
        y: p4Y - 165,
        width: width - 72,
        height: 165,
        color: cardBg,
        borderColor: borderGray,
        borderWidth: 1,
    });
    page4.drawText('8. STATUTORY SERVICE AGREEMENT & PAYMENT AUTHORISATION', {
        x: 48,
        y: p4Y - 18,
        size: 9,
        font: fontBold,
        color: darkNavy,
    });
    // 2a. Service Agreement Ack Checkbox
    const cbService = form.createCheckBox('service_agreement_ack');
    cbService.addToPage(page4, { x: 48, y: p4Y - 44, width: 14, height: 14 });
    cbService.enableRequired();
    page4.drawText('STATUTORY SERVICE AGREEMENT ACKNOWLEDGEMENT *', { x: 68, y: p4Y - 40, size: 8, font: fontBold, color: darkNavy });
    page4.drawText('I confirm acceptance of QEEG.com.au Terms of Service, Zero-PII data retention policy, and Sydney sovereign server infrastructure compliance under the Australian Privacy Act 1988.', { x: 68, y: p4Y - 54, size: 7.5, font: fontRegular, color: slateText });
    // 2b. Payment Authorisation Checkbox
    const cbPayment = form.createCheckBox('payment_auth_ack');
    cbPayment.addToPage(page4, { x: 48, y: p4Y - 94, width: 14, height: 14 });
    cbPayment.enableRequired();
    page4.drawText('PAYPAL $65.00 AUD FEE AUTHORISATION HOLD *', { x: 68, y: p4Y - 90, size: 8, font: fontBold, color: darkNavy });
    page4.drawText('I authorize a $65.00 AUD fee hold per report submission via PayPal. Funds are captured strictly upon successful generation and verification.', { x: 68, y: p4Y - 104, size: 7.5, font: fontRegular, color: slateText });
    // CARD 3: Referring Practitioner Sign-off
    p4Y = p4Y - 180;
    page4.drawRectangle({
        x: 36,
        y: p4Y - 130,
        width: width - 72,
        height: 130,
        color: inputBg,
        borderColor: borderGray,
        borderWidth: 1,
    });
    page4.drawText('9. REFERRING PRACTITIONER SIGN-OFF', {
        x: 48,
        y: p4Y - 18,
        size: 9,
        font: fontBold,
        color: darkNavy,
    });
    page4.drawText('Typed practitioner signature and sign-off date are legally binding under Electronic Transactions Act 1999.', {
        x: 48,
        y: p4Y - 32,
        size: 7.5,
        font: fontRegular,
        color: slateLabel,
    });
    // Signature Field
    page4.drawText('Practitioner Digital Signature (Typed Name) *', { x: 48, y: p4Y - 54, size: 8, font: fontBold, color: darkNavy });
    const fSig = form.createTextField('signature');
    fSig.setText(details.fullName || '');
    fSig.addToPage(page4, { x: 48, y: p4Y - 76, width: 280, height: 18 });
    fSig.setFontSize(8.5);
    fSig.enableRequired();
    // Date Signed Field
    page4.drawText('Date Signed (DD/MM/YYYY) *', { x: 348, y: p4Y - 54, size: 8, font: fontBold, color: darkNavy });
    const fDate = form.createTextField('date_signed');
    const todayStr = new Date().toLocaleDateString('en-AU', { day: '2-digit', month: '2-digit', year: 'numeric' });
    fDate.setText(todayStr);
    fDate.addToPage(page4, { x: 348, y: p4Y - 76, width: 192, height: 18 });
    fDate.setFontSize(8.5);
    fDate.enableRequired();
    page4.drawText('Practitioner Verification: Authenticated digital submission from Sydney Sovereign Server.', {
        x: 48,
        y: p4Y - 108,
        size: 7.5,
        font: fontOblique,
        color: slateLabel,
    });
    drawFooter(page4, 4);
    const pdfBytes = await pdfDoc.save();
    return pdfBytes;
}
