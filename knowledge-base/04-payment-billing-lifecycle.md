# Payment and Billing Lifecycle

QEEG.com.au integrates a PayPal REST API for payment holds, captures, and voids.

## Fee Hold on Submission

At submission, a $65.00 AUD authorisation hold is created via the PayPal Orders V2 capture flow. Funds are not moved from the practitioner's account at submission time; they are captured only once generation has succeeded and the report has been verified.

## Capture on Approval and Generation

Following admin approval and successful report generation, the authorisation is captured for the full fee amount. The report is marked COMPLETED and the practitioner receives an email notification containing a one-time collection link.

## Void on Rejection

If a submission fails the reliability gate or is declined by admin review, the authorisation hold is voided and no funds are collected. The report is marked RELIABILITY_REJECTED and the payment status is VOIDED.

## Background Processing

Capture and void operations run asynchronously via a durable job queue claimed with PostgreSQL row-level locking. Each job is retried up to five times; persistent failures are recorded on the ProcessingJob row for operational review.